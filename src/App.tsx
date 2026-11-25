import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { analyzePriceAction } from './analysis/priceAction';
import { AIAnalysisCard } from './components/AIAnalysisCard';
import { BacktestPanel } from './components/BacktestPanel';
import { CandlestickChart } from './components/CandlestickChart';
import { DemoTradingPanel } from './components/DemoTradingPanel';
import { LivePriceHeader } from './components/LivePriceHeader';
import { PriceActionStructureStrip } from './components/PriceActionStructureStrip';
import { PriceActionZonesPanel } from './components/PriceActionZonesPanel';
import { RiskDisclaimerBanner } from './components/RiskDisclaimerBanner';
import { TopNavBar, type NavSectionId } from './components/TopNavBar';
import { WatchlistSidebar } from './components/WatchlistSidebar';
import { MARKET_INSTRUMENTS, getInstrumentBySymbol } from './config/instruments';
import {
  closeDemoPositionManually,
  createInitialDemoState,
  evaluateLiveTickOnPositions,
  executeSignalInDemoAccount,
  loadDemoAccountState,
  moveStopToBreakeven,
  saveDemoAccountState,
} from './engine/demoBroker';
import {
  fetchMarketCandles,
  fetchWatchlistQuotes,
  requestPriceActionBacktest,
  requestPriceActionSignal,
  subscribeMarketStream,
} from './services/marketClient';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  AutoTradeConfig,
  BacktestResult,
  DemoAccountState,
  FeedOrigin,
  OHLCVCandle,
  Timeframe,
  WatchlistQuote,
} from './types/market';

export default function App() {
  const [selectedSymbol, setSelectedSymbol] = useState<string>('XAU/USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('5M');
  const [activeSection, setActiveSection] = useState<NavSectionId>('workspace');

  const [watchlist, setWatchlist] = useState<WatchlistQuote[]>([]);
  const [watchlistLoading, setWatchlistLoading] = useState<boolean>(true);

  const [candles, setCandles] = useState<OHLCVCandle[]>([]);
  const [candlesLoading, setCandlesLoading] = useState<boolean>(true);
  const [feedError, setFeedError] = useState<string | null>(null);
  const [source, setSource] = useState<FeedOrigin>('simulated-live');
  const [sourceLabel, setSourceLabel] = useState<string>('Market Feed');

  const [livePrice, setLivePrice] = useState<number>(0);
  const [bid, setBid] = useState<number>(0);
  const [ask, setAsk] = useState<number>(0);
  const [changePct, setChangePct] = useState<number>(0);
  const [isStreamConnected, setIsStreamConnected] = useState<boolean>(false);

  const [activeSignal, setActiveSignal] = useState<AIPriceActionSignal | null>(
    null
  );
  const [signalHistory, setSignalHistory] = useState<AIPriceActionSignal[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState<boolean>(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const [demoAccount, setDemoAccount] = useState<DemoAccountState>(() =>
    loadDemoAccountState()
  );
  const [lastExecutionNote, setLastExecutionNote] = useState<string | null>(
    null
  );
  const [nextScanSecondsLeft, setNextScanSecondsLeft] = useState<number | null>(
    null
  );

  const [backtestResult, setBacktestResult] = useState<BacktestResult | null>(
    null
  );
  const [aiBacktestReview, setAiBacktestReview] =
    useState<AIBacktestReview | null>(null);
  const [backtestAiError, setBacktestAiError] = useState<string | null>(null);
  const [backtestError, setBacktestError] = useState<string | null>(null);
  const [isBacktesting, setIsBacktesting] = useState<boolean>(false);

  const candlesRef = useRef<OHLCVCandle[]>([]);
  candlesRef.current = candles;
  const watchlistRef = useRef<WatchlistQuote[]>([]);
  watchlistRef.current = watchlist;
  const livePriceRef = useRef<number>(0);
  livePriceRef.current = livePrice;
  const isAnalyzingRef = useRef<boolean>(false);
  isAnalyzingRef.current = isAnalyzing;
  const scanCursorRef = useRef<number>(0);

  // Persist demo account updates
  useEffect(() => {
    saveDemoAccountState(demoAccount);
  }, [demoAccount]);

  const instrument = useMemo(
    () => getInstrumentBySymbol(selectedSymbol),
    [selectedSymbol]
  );

  const priceAction = useMemo(
    () => analyzePriceAction(candles, instrument.decimals),
    [candles, instrument.decimals]
  );

  const openPositionForSymbol = useMemo(
    () =>
      demoAccount.openPositions.find((p) => p.symbol === selectedSymbol) ?? null,
    [demoAccount.openPositions, selectedSymbol]
  );

  const sessionStats = useMemo(() => {
    const recent = candles.slice(-48);
    if (recent.length === 0) {
      return { high: instrument.basePrice, low: instrument.basePrice };
    }
    return {
      high: Math.max(...recent.map((c) => c.high)),
      low: Math.min(...recent.map((c) => c.low)),
    };
  }, [candles, instrument.basePrice]);

  // Initial & periodic watchlist fetch + evaluate open positions on non-selected pairs
  useEffect(() => {
    let active = true;
    const loadWatchlist = async () => {
      try {
        const quotes = await fetchWatchlistQuotes();
        if (!active) return;
        setWatchlist(quotes);
        setWatchlistLoading(false);

        setDemoAccount((prev) => {
          let updated = prev;
          let note: string | null = null;
          for (const q of quotes) {
            if (q.symbol === selectedSymbol) continue;
            const res = evaluateLiveTickOnPositions(updated, q.symbol, q.price);
            updated = res.nextState;
            if (res.eventMessage) note = res.eventMessage;
          }
          if (note) setLastExecutionNote(note);
          return updated;
        });
      } catch {
        if (active) setWatchlistLoading(false);
      }
    };
    loadWatchlist();
    const timer = setInterval(loadWatchlist, 12000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selectedSymbol]);

  // Load historical candles & connect live tick stream on symbol/timeframe change
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;

    setCandlesLoading(true);
    setFeedError(null);
    setBacktestResult(null);
    setAiBacktestReview(null);
    setBacktestAiError(null);
    setBacktestError(null);

    fetchMarketCandles(selectedSymbol, timeframe, 180)
      .then((payload) => {
        if (cancelled) return;
        setCandles(payload.candles);
        setSource(payload.source);
        setSourceLabel(payload.sourceLabel);
        setCandlesLoading(false);

        const last = payload.candles[payload.candles.length - 1];
        const anchor = payload.candles[Math.max(0, payload.candles.length - 48)];
        if (last) {
          setLivePrice(last.close);
          const spread =
            last.close * (instrument.category === 'Forex' ? 0.00012 : 0.00025);
          setBid(last.close - spread / 2);
          setAsk(last.close + spread / 2);
          if (anchor) {
            setChangePct(
              ((last.close - anchor.open) / Math.max(anchor.open, 1e-9)) * 100
            );
          }
        }

        unsubscribe = subscribeMarketStream(
          selectedSymbol,
          timeframe,
          (tick) => {
            if (cancelled) return;
            setLivePrice(tick.price);
            setBid(tick.bid);
            setAsk(tick.ask);
            setChangePct(tick.changePct);
            setSource(tick.source);

            setCandles((prev) => {
              if (prev.length === 0) return [tick.candle];
              const lastBar = prev[prev.length - 1];
              if (tick.candle.time === lastBar.time) {
                const next = prev.slice();
                next[next.length - 1] = tick.candle;
                return next;
              }
              if (tick.candle.time > lastBar.time) {
                const next = [...prev, tick.candle];
                if (next.length > 260) next.shift();
                return next;
              }
              return prev;
            });

            setWatchlist((prev) =>
              prev.map((q) =>
                q.symbol === tick.symbol
                  ? { ...q, price: tick.price, changePct: tick.changePct }
                  : q
              )
            );

            // Evaluate Demo Account SL, TP1+Breakeven, TP2, and live floating P&L on every tick
            setDemoAccount((prev) => {
              const res = evaluateLiveTickOnPositions(
                prev,
                tick.symbol,
                tick.price
              );
              if (res.eventMessage) {
                setLastExecutionNote(res.eventMessage);
              }
              return res.nextState;
            });
          },
          (connected) => {
            if (!cancelled) setIsStreamConnected(connected);
          },
          () => {
            const list = candlesRef.current;
            const anchorBar = list[Math.max(0, list.length - 48)];
            return {
              lastCandle: list[list.length - 1],
              anchorOpen: anchorBar?.open,
            };
          }
        );
      })
      .catch((err) => {
        if (cancelled) return;
        setCandlesLoading(false);
        setFeedError(
          err instanceof Error ? err.message : 'Unable to load chart candles.'
        );
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [selectedSymbol, timeframe, instrument.category]);

  const handleExecuteSignalOnDemo = useCallback(
    (signal: AIPriceActionSignal, spotOverride?: number) => {
      const spot =
        spotOverride ??
        (signal.symbol === selectedSymbol
          ? livePriceRef.current || signal.spotPriceAtSignal
          : watchlistRef.current.find((q) => q.symbol === signal.symbol)?.price ??
            signal.spotPriceAtSignal);

      setDemoAccount((prev) => {
        const res = executeSignalInDemoAccount(prev, signal, spot);
        setLastExecutionNote(res.actionSummary);
        return res.nextState;
      });
    },
    [selectedSymbol]
  );

  const runSignalScan = useCallback(
    async (targetSymbol: string, targetTimeframe: Timeframe) => {
      if (isAnalyzingRef.current) return;
      setIsAnalyzing(true);
      setAiError(null);

      try {
        let scanCandles: OHLCVCandle[] = [];
        let spotForSymbol = livePriceRef.current;

        if (
          targetSymbol === selectedSymbol &&
          targetTimeframe === timeframe &&
          candlesRef.current.length >= 30
        ) {
          scanCandles = candlesRef.current;
        } else {
          const loaded = await fetchMarketCandles(
            targetSymbol,
            targetTimeframe,
            180
          );
          scanCandles = loaded.candles;
          spotForSymbol =
            scanCandles[scanCandles.length - 1]?.close ?? spotForSymbol;
        }

        const result = await requestPriceActionSignal({
          symbol: targetSymbol,
          timeframe: targetTimeframe,
          candles: scanCandles,
        });

        setActiveSignal(result.signal);
        setSignalHistory((prev) => [result.signal, ...prev].slice(0, 15));

        setDemoAccount((prev) => {
          if (!prev.config.autoTradeEnabled) return prev;
          const res = executeSignalInDemoAccount(
            prev,
            result.signal,
            spotForSymbol || result.signal.spotPriceAtSignal
          );
          setLastExecutionNote(res.actionSummary);
          return res.nextState;
        });
      } catch (err) {
        setAiError(
          err instanceof Error
            ? err.message
            : 'Failed to generate AI price-action signal.'
        );
      } finally {
        setIsAnalyzing(false);
      }
    },
    [selectedSymbol, timeframe]
  );

  const handleGenerateSignal = useCallback(() => {
    void runSignalScan(selectedSymbol, timeframe);
  }, [runSignalScan, selectedSymbol, timeframe]);

  // Autonomous Auto-Scan Timer Loop
  useEffect(() => {
    const intervalSec = demoAccount.config.autoScanIntervalSec;
    if (intervalSec <= 0) {
      setNextScanSecondsLeft(null);
      return;
    }

    let remaining = intervalSec;
    setNextScanSecondsLeft(remaining);

    const tickTimer = setInterval(() => {
      remaining -= 1;
      if (remaining <= 0) {
        remaining = intervalSec;
        if (!isAnalyzingRef.current) {
          let targetSym = selectedSymbol;
          if (demoAccount.config.scanScope === 'watchlist') {
            const idx = scanCursorRef.current % MARKET_INSTRUMENTS.length;
            targetSym = MARKET_INSTRUMENTS[idx].symbol;
            scanCursorRef.current += 1;
          }
          void runSignalScan(targetSym, timeframe);
        }
      }
      setNextScanSecondsLeft(remaining);
    }, 1000);

    return () => clearInterval(tickTimer);
  }, [
    demoAccount.config.autoScanIntervalSec,
    demoAccount.config.scanScope,
    selectedSymbol,
    timeframe,
    runSignalScan,
  ]);

  const handleUpdateConfig = useCallback((patch: Partial<AutoTradeConfig>) => {
    setDemoAccount((prev) => ({
      ...prev,
      config: { ...prev.config, ...patch },
    }));
  }, []);

  const handleClosePosition = useCallback((positionId: string) => {
    setDemoAccount((prev) => closeDemoPositionManually(prev, positionId));
    setLastExecutionNote('Closed demo position manually at market.');
  }, []);

  const handleMoveToBreakeven = useCallback((positionId: string) => {
    setDemoAccount((prev) => moveStopToBreakeven(prev, positionId));
    setLastExecutionNote('Moved demo position Stop Loss to Entry (Breakeven).');
  }, []);

  const handleResetDemoAccount = useCallback(() => {
    setDemoAccount((prev) => ({
      ...createInitialDemoState(),
      config: prev.config,
    }));
    setLastExecutionNote('Demo account balance reset to $10,000.00.');
  }, []);

  const handleNavigate = (section: NavSectionId) => {
    setActiveSection(section);
    const target = document.getElementById(section);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const handleRunBacktest = useCallback(
    async (includeAiReview: boolean) => {
      if (isBacktesting) return;
      setIsBacktesting(true);
      setBacktestError(null);
      setBacktestAiError(null);

      try {
        const res = await requestPriceActionBacktest({
          symbol: selectedSymbol,
          timeframe,
          riskPercentPerTrade: demoAccount.config.riskPercentPerTrade,
          includeAiReview,
          candles: candlesRef.current.length >= 260 ? candlesRef.current : undefined,
        });
        setBacktestResult(res.backtest);
        setAiBacktestReview(res.aiReview);
        setBacktestAiError(res.aiError);
      } catch (err) {
        setBacktestError(
          err instanceof Error
            ? err.message
            : 'Unable to execute price-action backtest.'
        );
      } finally {
        setIsBacktesting(false);
      }
    },
    [
      isBacktesting,
      selectedSymbol,
      timeframe,
      demoAccount.config.riskPercentPerTrade,
    ]
  );

  const displayPrice = livePrice || instrument.basePrice;
  const displayBid = bid || displayPrice;
  const displayAsk = ask || displayPrice;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      <TopNavBar
        activeSection={activeSection}
        onNavigate={handleNavigate}
        onGenerateSignal={handleGenerateSignal}
        isAnalyzing={isAnalyzing}
      />

      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col lg:flex-row">
        <WatchlistSidebar
          quotes={watchlist}
          selectedSymbol={selectedSymbol}
          onSelectSymbol={(sym) => {
            setSelectedSymbol(sym);
            setAiError(null);
          }}
          isLoading={watchlistLoading}
        />

        <main id="workspace" className="flex-1 min-w-0 flex flex-col">
          <LivePriceHeader
            instrument={instrument}
            timeframe={timeframe}
            price={displayPrice}
            bid={displayBid}
            ask={displayAsk}
            changePct={changePct}
            sessionHigh={sessionStats.high}
            sessionLow={sessionStats.low}
            avgCandleRange={priceAction.snapshot.avgCandleRange}
            isConnected={isStreamConnected}
            source={source}
            sourceLabel={sourceLabel}
          />

          <div className="flex-1 space-y-5 p-4 sm:p-6">
            {feedError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
                {feedError}
              </div>
            )}

            {/* Primary Workspace Grid: Pure Price Action Chart Left, AI Signal Card Right */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-12 items-start">
              <div className="space-y-4 xl:col-span-8">
                <CandlestickChart
                  symbol={selectedSymbol}
                  timeframe={timeframe}
                  decimals={instrument.decimals}
                  candles={candles}
                  priceAction={priceAction}
                  activeSignal={activeSignal}
                  openPosition={openPositionForSymbol}
                  isLoading={candlesLoading}
                  onTimeframeChange={setTimeframe}
                />

                <PriceActionStructureStrip
                  snapshot={priceAction.snapshot}
                  decimals={instrument.decimals}
                />
              </div>

              <div className="xl:col-span-4">
                <AIAnalysisCard
                  symbol={selectedSymbol}
                  timeframe={timeframe}
                  decimals={instrument.decimals}
                  signal={activeSignal}
                  isAnalyzing={isAnalyzing}
                  error={aiError}
                  onGenerateSignal={handleGenerateSignal}
                  onSelectTimeframe={setTimeframe}
                  onExecuteOnDemo={(sig) => handleExecuteSignalOnDemo(sig)}
                />
              </div>
            </div>

            <DemoTradingPanel
              demoAccount={demoAccount}
              activeSignal={activeSignal}
              selectedSymbol={selectedSymbol}
              nextScanSecondsLeft={nextScanSecondsLeft}
              lastExecutionNote={lastExecutionNote}
              onUpdateConfig={handleUpdateConfig}
              onExecuteSignal={(sig) => handleExecuteSignalOnDemo(sig)}
              onClosePosition={handleClosePosition}
              onMoveToBreakeven={handleMoveToBreakeven}
              onResetAccount={handleResetDemoAccount}
              onSelectSymbol={(sym) => {
                setSelectedSymbol(sym);
                setAiError(null);
              }}
            />

            <BacktestPanel
              symbol={selectedSymbol}
              timeframe={timeframe}
              riskPercentPerTrade={demoAccount.config.riskPercentPerTrade}
              backtest={backtestResult}
              aiReview={aiBacktestReview}
              aiError={backtestAiError}
              backtestError={backtestError}
              isRunning={isBacktesting}
              onRunBacktest={handleRunBacktest}
            />

            <PriceActionZonesPanel
              symbol={selectedSymbol}
              decimals={instrument.decimals}
              levels={priceAction.levels}
              zones={priceAction.zones}
              signalHistory={signalHistory}
              onSelectSignal={(sig) => setActiveSignal(sig)}
              onSelectSymbolTimeframe={(sym, tf) => {
                setSelectedSymbol(sym);
                setTimeframe(tf);
                setAiError(null);
              }}
            />

            <RiskDisclaimerBanner />
          </div>
        </main>
      </div>
    </div>
  );
}
