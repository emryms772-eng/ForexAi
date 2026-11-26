import {
  CandlestickSeries,
  ColorType,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import { Eye, EyeOff, RotateCcw } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { CausalSignalArrow } from '../analysis/backtester';
import { formatCountdown } from '../analysis/entryTiming';
import { getGoldPsychologicalLevels } from '../analysis/goldProtocol';
import { getCandleProgress } from '../analysis/priceAction';
import { TIMEFRAMES, TIMEFRAME_SECONDS } from '../config/instruments';
import type {
  AIPriceActionSignal,
  DemoPosition,
  KeyLevel,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  PriceActionZone,
  Timeframe,
} from '../types/market';

interface CandlestickChartProps {
  symbol: string;
  timeframe: Timeframe;
  decimals: number;
  candles: OHLCVCandle[];
  priceAction: PriceActionAnalysisSummary;
  activeSignal: AIPriceActionSignal | null;
  signalHistory?: AIPriceActionSignal[];
  causalArrows?: CausalSignalArrow[];
  openPosition?: DemoPosition | null;
  isLoading: boolean;
  onTimeframeChange: (tf: Timeframe) => void;
}

function mapConfirmedTimeToChartBar(
  orderedCandles: OHLCVCandle[],
  targetSec: number,
  timeframe: Timeframe
): number | null {
  if (orderedCandles.length === 0 || !Number.isFinite(targetSec) || targetSec <= 0) {
    return null;
  }
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const bucketed = Math.floor(targetSec / tfSec) * tfSec;

  const exact = orderedCandles.find((c) => c.time === bucketed);
  if (exact) return exact.time;

  // Find enclosing bar or nearest prior bar within chart window
  const firstTime = orderedCandles[0].time;
  const lastTime = orderedCandles[orderedCandles.length - 1].time;
  if (targetSec < firstTime) return null;
  if (targetSec >= lastTime) return lastTime;

  for (let i = orderedCandles.length - 1; i >= 0; i--) {
    if (orderedCandles[i].time <= targetSec) {
      return orderedCandles[i].time;
    }
  }
  return null;
}

export function CandlestickChart({
  symbol,
  timeframe,
  decimals,
  candles,
  priceAction,
  activeSignal,
  signalHistory = [],
  causalArrows = [],
  openPosition,
  isLoading,
  onTimeframeChange,
}: CandlestickChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const markersPluginRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const lastDatasetKeyRef = useRef<string>('');
  const lastBarTimeRef = useRef<number>(0);

  const [showSR, setShowSR] = useState(true);
  const [showZones, setShowZones] = useState(true);
  const [showMarkers, setShowMarkers] = useState(true);
  const [showArrows, setShowArrows] = useState(true);
  const [showSignalLines, setShowSignalLines] = useState(true);
  const [hoveredBar, setHoveredBar] = useState<OHLCVCandle | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  useEffect(() => {
    const timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const candleCountdown = useMemo(
    () => formatCountdown(getCandleProgress(timeframe, nowSec).secondsRemaining),
    [timeframe, nowSec]
  );

  const orderedCandles = useMemo(() => {
    const valid = candles.filter(
      (c) =>
        Number.isFinite(c.time) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close)
    );
    if (valid.length <= 1) return valid;

    const sorted = valid.slice().sort((a, b) => a.time - b.time);
    const deduped: OHLCVCandle[] = [];
    for (const bar of sorted) {
      const prev = deduped[deduped.length - 1];
      if (prev && prev.time === bar.time) {
        deduped[deduped.length - 1] = bar;
      } else {
        deduped.push(bar);
      }
    }
    return deduped;
  }, [candles]);

  const displayBar = useMemo(() => {
    if (hoveredBar) return hoveredBar;
    return orderedCandles.length > 0
      ? orderedCandles[orderedCandles.length - 1]
      : null;
  }, [hoveredBar, orderedCandles]);

  // Initialize pure price-action Candlestick chart
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      layout: {
        background: { type: ColorType.Solid, color: '#0B0F17' },
        textColor: '#94A3B8',
        fontFamily: '"IBM Plex Mono", monospace',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(30, 41, 59, 0.4)' },
        horzLines: { color: 'rgba(30, 41, 59, 0.4)' },
      },
      crosshair: {
        vertLine: {
          color: 'rgba(148, 163, 184, 0.45)',
          width: 1,
          style: LineStyle.Dashed,
        },
        horzLine: {
          color: 'rgba(148, 163, 184, 0.45)',
          width: 1,
          style: LineStyle.Dashed,
        },
      },
      rightPriceScale: {
        borderColor: '#1E293B',
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#1E293B',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
      handleScale: true,
    });

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#EF4444',
      borderUpColor: '#10B981',
      borderDownColor: '#EF4444',
      wickUpColor: '#10B981',
      wickDownColor: '#EF4444',
    });

    const markersPlugin = createSeriesMarkers(candleSeries, []);

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    markersPluginRef.current = markersPlugin;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          chart.applyOptions({ width, height });
        }
      }
    });
    resizeObserver.observe(el);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      markersPluginRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // Crosshair OHLC hover readout
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;

    const handler = (param: { time?: unknown }) => {
      if (!param.time || typeof param.time !== 'number') {
        setHoveredBar(null);
        return;
      }
      const match = orderedCandles.find((c) => c.time === param.time);
      setHoveredBar(match ?? null);
    };

    chart.subscribeCrosshairMove(handler);
    return () => {
      chart.unsubscribeCrosshairMove(handler);
    };
  }, [orderedCandles]);

  // Apply instrument price precision
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;
    const minMove = Number(Math.pow(10, -decimals).toFixed(decimals));
    candleSeries.applyOptions({
      priceFormat: {
        type: 'price',
        precision: decimals,
        minMove,
      },
    });
  }, [decimals]);

  // Sync raw OHLC candlesticks
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleSeriesRef.current;
    if (!chart || !candleSeries || orderedCandles.length === 0) {
      return;
    }

    const datasetKey = `${symbol}:${timeframe}:${orderedCandles[0].time}`;
    const lastBar = orderedCandles[orderedCandles.length - 1];
    const isFullReset =
      lastDatasetKeyRef.current !== datasetKey ||
      lastBarTimeRef.current === 0 ||
      lastBar.time < lastBarTimeRef.current;

    if (isFullReset) {
      candleSeries.setData(
        orderedCandles.map((c) => ({
          time: c.time as UTCTimestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
        }))
      );
      chart.timeScale().fitContent();
      lastDatasetKeyRef.current = datasetKey;
      lastBarTimeRef.current = lastBar.time;
    } else {
      candleSeries.update({
        time: lastBar.time as UTCTimestamp,
        open: lastBar.open,
        high: lastBar.high,
        low: lastBar.low,
        close: lastBar.close,
      });
      lastBarTimeRef.current = lastBar.time;
    }
  }, [symbol, timeframe, orderedCandles]);

  // Plot Pure Price Action Markers (BOS, CHoCH, Sweep, ENG, PIN) + Confirmed Signal Arrows
  useEffect(() => {
    const plugin = markersPluginRef.current;
    if (!plugin) return;

    const merged: SeriesMarker<Time>[] = [];
    const seenKeys = new Set<string>();

    const pushUnique = (marker: SeriesMarker<Time>) => {
      const key = `${String(marker.time)}:${marker.text ?? ''}:${marker.shape}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      merged.push(marker);
    };

    if (showMarkers && priceAction.markers.length > 0) {
      for (const m of priceAction.markers) {
        if (!Number.isFinite(m.time)) continue;
        pushUnique({
          time: m.time as UTCTimestamp,
          position: m.position,
          color: m.color,
          shape: m.shape,
          text: m.text,
        });
      }
    }

    if (showArrows) {
      const liveSignals = [activeSignal, ...signalHistory].filter(
        (s): s is AIPriceActionSignal => Boolean(s && s.symbol === symbol)
      );

      const blockedWaitBar =
        activeSignal &&
        activeSignal.symbol === symbol &&
        activeSignal.plan.signal === 'WAIT' &&
        activeSignal.confirmedBarTime > 0
          ? mapConfirmedTimeToChartBar(
              orderedCandles,
              activeSignal.confirmedBarTime,
              timeframe
            )
          : null;

      // 1. Confirmed BUY / SELL signal arrows from locked closed-bar scans
      const liveSignalBars = new Set<number>();
      for (const sig of liveSignals) {
        if (sig.plan.signal !== 'BUY' && sig.plan.signal !== 'SELL') continue;
        const barTime = mapConfirmedTimeToChartBar(
          orderedCandles,
          sig.confirmedBarTime || Math.floor(Date.parse(sig.analyzedAt) / 1000),
          timeframe
        );
        if (barTime === null) continue;
        liveSignalBars.add(barTime);
        const isBuy = sig.plan.signal === 'BUY';
        pushUnique({
          time: barTime as UTCTimestamp,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: isBuy ? '#22C55E' : '#EF4444',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          size: 2,
          text: isBuy ? 'BUY ✓' : 'SELL ✓',
        });
      }

      // 2. Active Demo position entry arrow if not already shown by liveSignals
      if (openPosition && openPosition.symbol === symbol) {
        const openSec = Math.floor(Date.parse(openPosition.openedAt) / 1000);
        const openBar = mapConfirmedTimeToChartBar(
          orderedCandles,
          openSec,
          timeframe
        );
        if (openBar !== null && !liveSignalBars.has(openBar)) {
          const isBuy = openPosition.side === 'BUY';
          pushUnique({
            time: openBar as UTCTimestamp,
            position: isBuy ? 'belowBar' : 'aboveBar',
            color: isBuy ? '#22C55E' : '#EF4444',
            shape: isBuy ? 'arrowUp' : 'arrowDown',
            size: 2,
            text: isBuy ? 'BUY' : 'SELL',
          });
        }
      }

      // 3. Causal closed-bar historical confirmation arrows across visible bars
      for (const arrow of causalArrows) {
        if (blockedWaitBar !== null && arrow.time === blockedWaitBar) continue;
        if (liveSignalBars.has(arrow.time)) continue;
        const isBuy = arrow.side === 'BUY';
        pushUnique({
          time: arrow.time as UTCTimestamp,
          position: isBuy ? 'belowBar' : 'aboveBar',
          color: isBuy ? '#10B981' : '#F43F5E',
          shape: isBuy ? 'arrowUp' : 'arrowDown',
          size: 2,
          text: isBuy ? 'BUY' : 'SELL',
        });
      }
    }

    merged.sort((a, b) => Number(a.time) - Number(b.time));
    plugin.setMarkers(merged);
  }, [
    showMarkers,
    showArrows,
    priceAction.markers,
    activeSignal,
    signalHistory,
    causalArrows,
    openPosition,
    orderedCandles,
    symbol,
    timeframe,
  ]);

  // Plot S/R Levels, Equilibrium, OB/FVG Zones, and AI Signal Entry/SL/TP Lines
  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    for (const line of priceLinesRef.current) {
      try {
        candleSeries.removePriceLine(line);
      } catch {
        // Ignore stale line removal
      }
    }
    priceLinesRef.current = [];

    if (showSR) {
      priceAction.levels.forEach((lvl: KeyLevel) => {
        const line = candleSeries.createPriceLine({
          price: lvl.price,
          color:
            lvl.type === 'Support'
              ? 'rgba(16, 185, 129, 0.5)'
              : 'rgba(245, 158, 11, 0.5)',
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `${lvl.type === 'Support' ? 'S' : 'R'} (${lvl.strength})`,
        });
        priceLinesRef.current.push(line);
      });

      if (priceAction.snapshot.equilibriumPrice > 0) {
        const eqLine = candleSeries.createPriceLine({
          price: priceAction.snapshot.equilibriumPrice,
          color: 'rgba(148, 163, 184, 0.45)',
          lineWidth: 1,
          lineStyle: LineStyle.Dotted,
          axisLabelVisible: true,
          title: '50% EQ',
        });
        priceLinesRef.current.push(eqLine);
      }

      // XAU/USD Phase 1 Key Levels: 50-pt (500-pip) Psychological Levels + UTC Session Open
      if (symbol === 'XAU/USD' && orderedCandles.length > 0) {
        const lastCandle = orderedCandles[orderedCandles.length - 1];
        const psych = getGoldPsychologicalLevels(lastCandle.close);
        const psychTargets = [
          psych.nearestBelow,
          psych.nearestAbove,
        ];
        for (const pLvl of psychTargets) {
          const psychLine = candleSeries.createPriceLine({
            price: pLvl.price,
            color: 'rgba(251, 191, 36, 0.65)',
            lineWidth: 1,
            lineStyle: LineStyle.LargeDashed,
            axisLabelVisible: true,
            title: `${pLvl.price} Psych (${pLvl.relation === 'Above' ? '+' : '-'}${pLvl.distancePips}p)`,
          });
          priceLinesRef.current.push(psychLine);
        }

        const todayPrefix = new Date(lastCandle.time * 1000)
          .toISOString()
          .slice(0, 10);
        const dayOpenBar = orderedCandles.find(
          (c) => new Date(c.time * 1000).toISOString().slice(0, 10) === todayPrefix
        );
        if (dayOpenBar) {
          const dayOpenLine = candleSeries.createPriceLine({
            price: dayOpenBar.open,
            color: 'rgba(167, 139, 250, 0.55)',
            lineWidth: 1,
            lineStyle: LineStyle.Dotted,
            axisLabelVisible: true,
            title: 'Session Open',
          });
          priceLinesRef.current.push(dayOpenLine);
        }
      }
    }

    if (showZones) {
      priceAction.zones.slice(0, 4).forEach((z: PriceActionZone) => {
        const isBull = z.kind === 'Demand OB' || z.kind === 'Bullish FVG';
        const line = candleSeries.createPriceLine({
          price: z.midpoint,
          color: isBull
            ? 'rgba(56, 189, 248, 0.55)'
            : 'rgba(244, 63, 94, 0.55)',
          lineWidth: 1,
          lineStyle: LineStyle.LargeDashed,
          axisLabelVisible: true,
          title: z.kind,
        });
        priceLinesRef.current.push(line);
      });
    }

    if (
      showSignalLines &&
      openPosition &&
      openPosition.symbol === symbol
    ) {
      const posLines: Array<{
        price: number;
        color: string;
        title: string;
        style: LineStyle;
      }> = [
        {
          price: openPosition.entryPrice,
          color: '#3B82F6',
          title: `Demo ${openPosition.side} Entry`,
          style: LineStyle.Solid,
        },
        {
          price: openPosition.stopLoss,
          color: '#EF4444',
          title: openPosition.breakevenActive ? 'Demo BE Stop' : 'Demo SL',
          style: LineStyle.Solid,
        },
        {
          price: openPosition.takeProfit1,
          color: '#10B981',
          title: openPosition.tp1Hit ? 'TP1 (Hit)' : 'Demo TP1',
          style: LineStyle.Dotted,
        },
        {
          price: openPosition.takeProfit2,
          color: '#34D399',
          title: 'Demo TP2',
          style: LineStyle.Dotted,
        },
      ];

      for (const item of posLines) {
        if (Number.isFinite(item.price) && item.price > 0) {
          const line = candleSeries.createPriceLine({
            price: item.price,
            color: item.color,
            lineWidth: 2,
            lineStyle: item.style,
            axisLabelVisible: true,
            title: item.title,
          });
          priceLinesRef.current.push(line);
        }
      }
    } else if (
      showSignalLines &&
      activeSignal &&
      activeSignal.symbol === symbol &&
      activeSignal.plan.entryPrice > 0
    ) {
      const { plan } = activeSignal;
      const lines: Array<{
        price: number;
        color: string;
        title: string;
        style: LineStyle;
      }> = [
        {
          price: plan.entryPrice,
          color: '#3B82F6',
          title: `${plan.signal} Entry`,
          style: LineStyle.Solid,
        },
        {
          price: plan.stopLoss,
          color: '#EF4444',
          title: 'Stop Loss',
          style: LineStyle.Solid,
        },
        {
          price: plan.takeProfit1,
          color: '#10B981',
          title: 'TP 1',
          style: LineStyle.Dotted,
        },
        {
          price: plan.takeProfit2,
          color: '#34D399',
          title: 'TP 2',
          style: LineStyle.Dotted,
        },
      ];

      for (const item of lines) {
        if (Number.isFinite(item.price) && item.price > 0) {
          const line = candleSeries.createPriceLine({
            price: item.price,
            color: item.color,
            lineWidth: 2,
            lineStyle: item.style,
            axisLabelVisible: true,
            title: item.title,
          });
          priceLinesRef.current.push(line);
        }
      }
    }
  }, [
    showSR,
    showZones,
    showSignalLines,
    priceAction.levels,
    priceAction.zones,
    priceAction.snapshot.equilibriumPrice,
    orderedCandles,
    activeSignal,
    openPosition,
    symbol,
  ]);

  const handleResetView = () => {
    chartRef.current?.timeScale().fitContent();
  };

  return (
    <div className="rounded-lg border border-slate-800/90 bg-[#0B0F17] overflow-hidden">
      {/* Pure Price Action Chart Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-[#111722] px-3 py-2 sm:px-4">
        <div
          role="group"
          aria-label="Chart timeframe"
          className="flex items-center gap-1 rounded-md bg-[#0B0F17] p-1 border border-slate-800/80"
        >
          {TIMEFRAMES.map((tf) => {
            const active = tf === timeframe;
            return (
              <button
                key={tf}
                type="button"
                onClick={() => onTimeframeChange(tf)}
                className={`min-h-[34px] sm:min-h-0 rounded px-2.5 py-1 text-xs font-mono font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-100'
                }`}
              >
                {tf}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar max-w-full">
          <button
            type="button"
            onClick={() => setShowSR((v) => !v)}
            className={`inline-flex min-h-[34px] sm:min-h-0 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showSR
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-slate-800 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
            }`}
          >
            {showSR ? (
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>S/R</span>
          </button>

          <button
            type="button"
            onClick={() => setShowZones((v) => !v)}
            className={`inline-flex min-h-[34px] sm:min-h-0 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showZones
                ? 'border-sky-500/40 bg-sky-500/10 text-sky-300'
                : 'border-slate-800 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
            }`}
          >
            {showZones ? (
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>OB/FVG</span>
          </button>

          <button
            type="button"
            onClick={() => setShowMarkers((v) => !v)}
            className={`inline-flex min-h-[34px] sm:min-h-0 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showMarkers
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                : 'border-slate-800 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
            }`}
          >
            {showMarkers ? (
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>BOS</span>
          </button>

          <button
            type="button"
            onClick={() => setShowArrows((v) => !v)}
            className={`inline-flex min-h-[34px] sm:min-h-0 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              showArrows
                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                : 'border-slate-800 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
            }`}
          >
            {showArrows ? (
              <Eye className="h-3.5 w-3.5" aria-hidden="true" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            <span>Arrows</span>
          </button>

          {((activeSignal && activeSignal.symbol === symbol) ||
            (openPosition && openPosition.symbol === symbol)) && (
            <button
              type="button"
              onClick={() => setShowSignalLines((v) => !v)}
              className={`inline-flex min-h-[34px] sm:min-h-0 items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                showSignalLines
                  ? 'border-blue-500/40 bg-blue-500/15 text-blue-300'
                  : 'border-slate-800 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
              }`}
            >
              {showSignalLines ? (
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
              ) : (
                <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              )}
              <span>Lines</span>
            </button>
          )}

          <button
            type="button"
            onClick={handleResetView}
            title="Fit candles to viewport"
            className="inline-flex min-h-[34px] sm:min-h-0 items-center gap-1 rounded-md border border-slate-800 bg-[#0B0F17] px-2.5 py-1 text-xs font-medium text-slate-300 transition-colors hover:border-slate-700 hover:text-white whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Fit</span>
          </button>
        </div>
      </div>

      {/* Compact OHLC Readout Row */}
      {displayBar && (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-slate-800/70 bg-[#0D121C] px-3 py-1.5 sm:px-4 text-[11px] font-mono tabular-nums">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            <span className="text-slate-400">
              O <span className="text-slate-100">{displayBar.open.toFixed(decimals)}</span>
            </span>
            <span className="text-slate-400">
              H <span className="text-emerald-400">{displayBar.high.toFixed(decimals)}</span>
            </span>
            <span className="text-slate-400">
              L <span className="text-rose-400">{displayBar.low.toFixed(decimals)}</span>
            </span>
            <span className="text-slate-400">
              C <span className="text-slate-100">{displayBar.close.toFixed(decimals)}</span>
            </span>
          </div>
          <div className="flex items-center gap-3 whitespace-nowrap">
            <span className="text-slate-400">
              {timeframe} close{' '}
              <span className="text-slate-200">{candleCountdown}</span>
            </span>
            <span className="text-sky-400">
              {priceAction.snapshot.latestStructureEvent}
            </span>
          </div>
        </div>
      )}

      {/* Pure OHLC Candlestick Viewport */}
      <div className="relative h-[320px] sm:h-[430px] xl:h-[480px] w-full bg-[#0B0F17]">
        {isLoading && orderedCandles.length === 0 && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0B0F17]/80">
            <div className="text-xs font-mono text-slate-400">
              Loading {symbol} {timeframe}...
            </div>
          </div>
        )}

        <div ref={containerRef} className="h-full w-full" />
      </div>
    </div>
  );
}
