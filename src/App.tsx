import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { detectCausalSignalArrows } from './analysis/backtester';
import {
  analyzePriceAction,
  getCandleProgress,
  getClosedCandlesForTimeframe,
} from './analysis/priceAction';
import { AIAnalysisCard } from './components/AIAnalysisCard';
import { BacktestPanel } from './components/BacktestPanel';
import { CandlestickChart } from './components/CandlestickChart';
import { DemoTradingPanel } from './components/DemoTradingPanel';
import { LivePriceHeader } from './components/LivePriceHeader';
import { MarketSniperScanner } from './components/MarketSniperScanner';
import { MobileBottomNav } from './components/MobileBottomNav';
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
  fetchNtfyStatus,
  fetchSmsStatus,
  fetchWatchlistQuotes,
  requestMarketSniperScan,
  requestPriceActionBacktest,
  requestPriceActionSignal,
  sendNtfyScanDigest,
  sendNtfySignalAlert,
  sendNtfyTestAlert,
  sendSmsSignalAlert,
  sendSmsTestAlert,
  subscribeMarketStream,
  syncNtfySubscription,
} from './services/marketClient';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  AutoTradeConfig,
  BacktestResult,
  DemoAccountState,
  FeedOrigin,
  MarketScanResponse,
  NtfyConfigStatus,
  OHLCVCandle,
  SmsConfigStatus,
  Timeframe,
  WatchlistQuote,
} from './types/market';

export default function App() {
  const [selectedSymbol, setSelectedSymbol] = useState<string>('XAU/USD');
  const [timeframe, setTimeframe] = useState<Timeframe>('5M');
  const [activeSection, setActiveSection] = useState<NavSectionId>('workspace');
  const [isMobileMarketsOpen, setIsMobileMarketsOpen] = useState<boolean>(false);

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

  const [smsStatus, setSmsStatus] = useState<SmsConfigStatus | null>(null);
  const [smsSending, setSmsSending] = useState<boolean>(false);

  const [ntfyStatus, setNtfyStatus] = useState<NtfyConfigStatus | null>(null);
  const [ntfySending, setNtfySending] = useState<boolean>(false);
  const [ntfyFeedback, setNtfyFeedback] = useState<string | null>(null);

  const [marketScan, setMarketScan] = useState<MarketScanResponse | null>(null);
  const [isMarketScanning, setIsMarketScanning] = useState<boolean>(false);
  const [marketScanError, setMarketScanError] = useState<string | null>(null);

  const candlesRef = useRef<OHLCVCandle[]>([]);
  candlesRef.current = candles;
  const watchlistRef = useRef<WatchlistQuote[]>([]);
  watchlistRef.current = watchlist;
  const livePriceRef = useRef<number>(0);
  livePriceRef.current = livePrice;
  const isAnalyzingRef = useRef<boolean>(false);
  isAnalyzingRef.current = isAnalyzing;
  const isMarketScanningRef = useRef<boolean>(false);
  isMarketScanningRef.current = isMarketScanning;
  const lastMarketScanBarRef = useRef<number>(0);
  const smsAlertedIdsRef = useRef<Set<string>>(new Set());
  const ntfyAlertedIdsRef = useRef<Set<string>>(new Set());
  const selectedSymbolRef = useRef<string>(selectedSymbol);
  selectedSymbolRef.current = selectedSymbol;
  const demoConfigRef = useRef<AutoTradeConfig>(demoAccount.config);
  demoConfigRef.current = demoAccount.config;
  const smsStatusRef = useRef<SmsConfigStatus | null>(null);
  smsStatusRef.current = smsStatus;
  const ntfyStatusRef = useRef<NtfyConfigStatus | null>(null);
  ntfyStatusRef.current = ntfyStatus;
  const scanCursorRef = useRef<number>(0);

  // Persist demo account updates
  useEffect(() => {
    saveDemoAccountState(demoAccount);
  }, [demoAccount]);

  // Load server-side SMS and ntfy notification status on mount
  useEffect(() => {
    let active = true;
    fetchSmsStatus()
      .then((status) => {
        if (active) setSmsStatus(status);
      })
      .catch(() => {
        if (active) {
          setSmsStatus({
            configured: false,
            provider: 'none',
            recipientMasked: null,
          });
        }
      });

    fetchNtfyStatus()
      .then((status) => {
        if (active) setNtfyStatus(status);
      })
      .catch(() => {
        if (active) {
          setNtfyStatus({
            configured: false,
            serverUrl: 'https://ntfy.sh',
            topicMasked: null,
          });
        }
      });

    return () => {
      active = false;
    };
  }, []);

  // Keep server-side 5M background watcher synced with user's active ntfy topic & filter
  useEffect(() => {
    const cleanTopic = demoAccount.config.ntfyTopic.trim();
    const valid = /^[A-Za-z0-9_-]{4,80}$/.test(cleanTopic);
    if (!cleanTopic) return;
    if (demoAccount.config.ntfyAlertsEnabled && !valid) return;

    const timer = setTimeout(() => {
      void syncNtfySubscription(
        cleanTopic,
        demoAccount.config.ntfyAlertsEnabled,
        demoAccount.config.ntfyNotifyWait
      );
    }, 350);
    return () => clearTimeout(timer);
  }, [
    demoAccount.config.ntfyTopic,
    demoAccount.config.ntfyAlertsEnabled,
    demoAccount.config.ntfyNotifyWait,
  ]);

  const instrument = useMemo(
    () => getInstrumentBySymbol(selectedSymbol),
    [selectedSymbol]
  );

  const lastClosedScanKeyRef = useRef<string>('');
  const stableClosedRef = useRef<{
    key: string;
    candles: OHLCVCandle[];
  }>({ key: '', candles: [] });

  const closedCandles = useMemo(() => {
    const closed = getClosedCandlesForTimeframe(candles, timeframe);
    const last = closed[closed.length - 1];
    const key = `${selectedSymbol}:${timeframe}:${closed.length}:${last?.time ?? 0}:${last?.close ?? 0}`;
    if (stableClosedRef.current.key === key) {
      return stableClosedRef.current.candles;
    }
    stableClosedRef.current = { key, candles: closed };
    return closed;
  }, [candles, selectedSymbol, timeframe]);

  const formingCandle = useMemo(() => {
    if (candles.length === 0) return null;
    const { bucketStartSec } = getCandleProgress(timeframe);
    const last = candles[candles.length - 1];
    return last && last.time >= bucketStartSec ? last : null;
  }, [candles, timeframe]);

  const priceAction = useMemo(
    () =>
      analyzePriceAction(closedCandles, instrument.decimals, {
        excludeFormingBar: false,
      }),
    [closedCandles, instrument.decimals]
  );

  const causalArrows = useMemo(
    () =>
      detectCausalSignalArrows({
        candles: closedCandles,
        timeframe,
        decimals: instrument.decimals,
      }),
    [closedCandles, timeframe, instrument.decimals]
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
    async (
      targetSymbol: string,
      targetTimeframe: Timeframe,
      isAutoScan = false
    ) => {
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
        setSignalHistory((prev) =>
          [
            result.signal,
            ...prev.filter((item) => item.id !== result.signal.id),
          ].slice(0, 15)
        );

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

        // Automatically send every Auto-Scan signal via SMS or ntfy when enabled & configured
        const cfg = demoConfigRef.current;
        const ntfyTopicClean = cfg.ntfyTopic.trim();
        const hasNtfy =
          /^[A-Za-z0-9_-]{4,80}$/.test(ntfyTopicClean) ||
          Boolean(ntfyStatusRef.current?.configured);

        if (isAutoScan && cfg.ntfyAlertsEnabled && hasNtfy) {
          const shouldPushNtfy =
            cfg.ntfyNotifyWait || result.signal.plan.signal !== 'WAIT';
          if (shouldPushNtfy && !ntfyAlertedIdsRef.current.has(result.signal.id)) {
            ntfyAlertedIdsRef.current.add(result.signal.id);
            try {
              const pushRes = await sendNtfySignalAlert(
                result.signal,
                ntfyTopicClean || undefined
              );
              if (pushRes.sent) {
                setNtfyFeedback(
                  `Pushed ${result.signal.symbol} ${result.signal.plan.signal} to ntfy`
                );
              }
            } catch {
              // Non-blocking ntfy alert failure
            }
          }
        }

        if (isAutoScan && cfg.smsAlertsEnabled) {
          const shouldSend =
            cfg.smsNotifyWait || result.signal.plan.signal !== 'WAIT';
          if (shouldSend) {
            if (smsStatusRef.current?.configured) {
              try {
                const smsRes = await sendSmsSignalAlert(result.signal);
                if (smsRes.sent) {
                  setLastExecutionNote(
                    `SMS alert sent for ${result.signal.symbol} (${result.signal.plan.signal} 5M).`
                  );
                }
              } catch (smsErr) {
                const msg =
                  smsErr instanceof Error
                    ? smsErr.message
                    : 'SMS delivery failed.';
                setLastExecutionNote(`Auto-Scan SMS alert error: ${msg}`);
              }
            } else {
              setLastExecutionNote(
                `Auto-Scan complete (${result.signal.symbol} ${result.signal.plan.signal}) — add SMS Secrets to receive alerts.`
              );
            }
          }
        }
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
    void runSignalScan(selectedSymbol, timeframe, false);
  }, [runSignalScan, selectedSymbol, timeframe]);

  const runMarketSniperScan = useCallback(async (isAutoTrigger = false) => {
    if (isMarketScanningRef.current) return;
    setIsMarketScanning(true);
    setMarketScanError(null);

    try {
      const scan = await requestMarketSniperScan();
      setMarketScan(scan);
      if (scan.confirmedBarTime > 0) {
        lastMarketScanBarRef.current = scan.confirmedBarTime;
      }

      if (scan.sniperSignals.length > 0) {
        setSignalHistory((prev) => {
          const merged = [...scan.sniperSignals, ...prev];
          const seen = new Set<string>();
          return merged
            .filter((item) => {
              if (seen.has(item.id)) return false;
              seen.add(item.id);
              return true;
            })
            .slice(0, 20);
        });
      }

      const allFromScan = [...scan.sniperSignals, ...scan.watchSignals];
      const currentSym = selectedSymbolRef.current;
      const matchingSelected = allFromScan.find((s) => s.symbol === currentSym);
      if (matchingSelected) {
        setActiveSignal((prev) => {
          if (
            prev &&
            prev.symbol === currentSym &&
            prev.confirmedBarTime >= matchingSelected.confirmedBarTime &&
            !prev.model.startsWith('Local')
          ) {
            return prev;
          }
          return matchingSelected;
        });
      }

      if (demoConfigRef.current.autoTradeEnabled && scan.sniperSignals.length > 0) {
        setDemoAccount((prev) => {
          if (!prev.config.autoTradeEnabled) return prev;
          let nextState = prev;
          let note: string | null = null;
          for (const sniperSig of scan.sniperSignals) {
            const spot =
              sniperSig.symbol === currentSym
                ? livePriceRef.current || sniperSig.spotPriceAtSignal
                : watchlistRef.current.find((q) => q.symbol === sniperSig.symbol)
                    ?.price ?? sniperSig.spotPriceAtSignal;
            const res = executeSignalInDemoAccount(nextState, sniperSig, spot);
            if (res.nextState !== nextState) {
              note = res.actionSummary;
            }
            nextState = res.nextState;
          }
          if (note) setLastExecutionNote(note);
          return nextState;
        });
      }

      if (
        isAutoTrigger &&
        demoConfigRef.current.smsAlertsEnabled &&
        smsStatusRef.current?.configured &&
        scan.sniperSignals.length > 0
      ) {
        for (const sniperSig of scan.sniperSignals) {
          if (smsAlertedIdsRef.current.has(sniperSig.id)) continue;
          smsAlertedIdsRef.current.add(sniperSig.id);
          try {
            const smsRes = await sendSmsSignalAlert(sniperSig);
            if (smsRes.sent) {
              setLastExecutionNote(
                `Sniper SMS sent: ${sniperSig.symbol} (${sniperSig.plan.signal} 5M).`
              );
            }
          } catch {
            // Non-blocking SMS alert failure
          }
        }
      }

      const ntfyTopicClean = demoConfigRef.current.ntfyTopic.trim();
      const canAutoNtfy =
        /^[A-Za-z0-9_-]{4,80}$/.test(ntfyTopicClean) ||
        Boolean(ntfyStatusRef.current?.configured);
      if (demoConfigRef.current.ntfyAlertsEnabled && canAutoNtfy) {
        const topicKey = ntfyTopicClean || 'env-default';
        if (scan.sniperSignals.length > 0) {
          for (const sniperSig of scan.sniperSignals) {
            const dedupeKey = `${topicKey}:${sniperSig.id}`;
            if (ntfyAlertedIdsRef.current.has(dedupeKey)) continue;
            ntfyAlertedIdsRef.current.add(dedupeKey);
            try {
              const pushRes = await sendNtfySignalAlert(
                sniperSig,
                ntfyTopicClean || undefined
              );
              if (pushRes.sent) {
                setNtfyFeedback(
                  `Auto-pushed ${sniperSig.symbol} ${sniperSig.plan.signal} to ntfy`
                );
                setLastExecutionNote(
                  `Sniper ntfy push sent: ${sniperSig.symbol} (${sniperSig.plan.signal} 5M).`
                );
              }
            } catch {
              ntfyAlertedIdsRef.current.delete(dedupeKey);
            }
          }
        } else if (demoConfigRef.current.ntfyNotifyWait) {
          const digestKey = `${topicKey}:digest:${scan.confirmedBarTime}`;
          if (!ntfyAlertedIdsRef.current.has(digestKey)) {
            ntfyAlertedIdsRef.current.add(digestKey);
            try {
              const digestRes = await sendNtfyScanDigest(
                scan,
                ntfyTopicClean || undefined
              );
              if (digestRes.sent) {
                setNtfyFeedback('Pushed 5M Market Scan & Closest Watch to ntfy');
              }
            } catch {
              ntfyAlertedIdsRef.current.delete(digestKey);
            }
          }
        }
      }
    } catch (err) {
      setMarketScanError(
        err instanceof Error ? err.message : 'Unable to scan markets.'
      );
    } finally {
      setIsMarketScanning(false);
    }
  }, []);

  // If user enables Auto-Push, All Scans, or sets a new topic after a scan already completed, push immediately
  useEffect(() => {
    if (!marketScan) return;
    if (!demoAccount.config.ntfyAlertsEnabled) return;
    const topicClean = demoAccount.config.ntfyTopic.trim();
    const canPush =
      /^[A-Za-z0-9_-]{4,80}$/.test(topicClean) ||
      Boolean(ntfyStatus?.configured);
    if (!canPush) return;

    const topicKey = topicClean || 'env-default';
    void (async () => {
      if (marketScan.sniperSignals.length > 0) {
        for (const sig of marketScan.sniperSignals) {
          const dedupeKey = `${topicKey}:${sig.id}`;
          if (ntfyAlertedIdsRef.current.has(dedupeKey)) continue;
          ntfyAlertedIdsRef.current.add(dedupeKey);
          try {
            const pushRes = await sendNtfySignalAlert(
              sig,
              topicClean || undefined
            );
            if (pushRes.sent) {
              setNtfyFeedback(`Auto-pushed ${sig.symbol} ${sig.plan.signal} to ntfy`);
            }
          } catch {
            ntfyAlertedIdsRef.current.delete(dedupeKey);
          }
        }
      } else if (demoAccount.config.ntfyNotifyWait) {
        const digestKey = `${topicKey}:digest:${marketScan.confirmedBarTime}`;
        if (!ntfyAlertedIdsRef.current.has(digestKey)) {
          ntfyAlertedIdsRef.current.add(digestKey);
          try {
            const digestRes = await sendNtfyScanDigest(
              marketScan,
              topicClean || undefined
            );
            if (digestRes.sent) {
              setNtfyFeedback('Pushed 5M Market Scan & Closest Watch to ntfy');
            }
          } catch {
            ntfyAlertedIdsRef.current.delete(digestKey);
          }
        }
      }
    })();
  }, [
    marketScan,
    demoAccount.config.ntfyTopic,
    demoAccount.config.ntfyAlertsEnabled,
    demoAccount.config.ntfyNotifyWait,
    ntfyStatus,
  ]);

  // Automatically scan all 14 markets on initial load, whenever a new 5M bar closes, and on tab resume
  useEffect(() => {
    void runMarketSniperScan(false);

    const checkAndScanClosedBar = () => {
      if (isMarketScanningRef.current) return;
      const nowSec = Math.floor(Date.now() / 1000);
      const { bucketStartSec } = getCandleProgress('5M', nowSec);
      const latestClosed5m = bucketStartSec - 300;
      const elapsedInBar = nowSec - bucketStartSec;
      if (
        elapsedInBar >= 6 &&
        lastMarketScanBarRef.current > 0 &&
        latestClosed5m > lastMarketScanBarRef.current
      ) {
        void runMarketSniperScan(true);
      }
    };

    const closeWatcher = setInterval(checkAndScanClosedBar, 2500);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        checkAndScanClosedBar();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(closeWatcher);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [runMarketSniperScan]);

  const handleSendSignalToSms = useCallback(
    async (sig: AIPriceActionSignal) => {
      if (smsSending) return;
      setSmsSending(true);
      try {
        const res = await sendSmsSignalAlert(sig);
        setLastExecutionNote(
          res.deduplicated
            ? `SMS alert already sent recently for ${sig.symbol}.`
            : `Sent ${sig.symbol} (${sig.plan.signal} 5M) signal via SMS.`
        );
      } catch (err) {
        setLastExecutionNote(
          err instanceof Error ? err.message : 'Failed to send SMS alert.'
        );
      } finally {
        setSmsSending(false);
      }
    },
    [smsSending]
  );

  const handleTestSms = useCallback(async () => {
    if (smsSending) return;
    setSmsSending(true);
    try {
      const res = await sendSmsTestAlert();
      setLastExecutionNote(
        `Test SMS sent via ${res.provider ?? 'configured provider'}.`
      );
    } catch (err) {
      setLastExecutionNote(
        err instanceof Error ? err.message : 'Failed to send test SMS message.'
      );
    } finally {
      setSmsSending(false);
    }
  }, [smsSending]);

  const handleGenerateNtfyTopic = useCallback(() => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const topic = `stratadesk-sniper-${suffix}`;
    setDemoAccount((prev) => ({
      ...prev,
      config: {
        ...prev.config,
        ntfyTopic: topic,
        ntfyAlertsEnabled: true,
      },
    }));
    setNtfyFeedback(`Topic set: ${topic}`);
  }, []);

  const handleSendSignalToNtfy = useCallback(
    async (sig: AIPriceActionSignal) => {
      if (ntfySending) return;
      setNtfySending(true);
      setNtfyFeedback(null);
      try {
        const topic = demoConfigRef.current.ntfyTopic.trim() || undefined;
        const res = await sendNtfySignalAlert(sig, topic);
        const msg = res.deduplicated
          ? `Already pushed ${sig.symbol} recently`
          : `Pushed ${sig.symbol} ${sig.plan.signal} to ${res.topic ?? 'ntfy'}`;
        setNtfyFeedback(msg);
        setLastExecutionNote(msg);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : 'Failed to push ntfy alert.';
        setNtfyFeedback(msg);
        setLastExecutionNote(msg);
      } finally {
        setNtfySending(false);
      }
    },
    [ntfySending]
  );

  const handleTestNtfy = useCallback(async () => {
    if (ntfySending) return;
    setNtfySending(true);
    setNtfyFeedback(null);
    try {
      const topic = demoConfigRef.current.ntfyTopic.trim() || undefined;
      const res = await sendNtfyTestAlert(topic);
      const msg = `Test push sent to ${res.topic ?? 'ntfy'}`;
      setNtfyFeedback(msg);
      setLastExecutionNote(`${msg}. Check the ntfy app on your phone.`);
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : 'Failed to send test ntfy push.';
      setNtfyFeedback(msg);
      setLastExecutionNote(msg);
    } finally {
      setNtfySending(false);
    }
  }, [ntfySending]);

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
          void runSignalScan(targetSym, timeframe, true);
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

  // Automatically re-evaluate once when the active 5M candle closes (never mid-candle)
  useEffect(() => {
    if (!activeSignal || activeSignal.symbol !== selectedSymbol) return;

    const checkCandleClose = () => {
      if (isAnalyzingRef.current) return;
      const { bucketStartSec } = getCandleProgress('5M');
      const latestClosed5mBarTime = bucketStartSec - 300;
      const scanKey = `${selectedSymbol}:${latestClosed5mBarTime}`;
      if (
        activeSignal.confirmedBarTime > 0 &&
        latestClosed5mBarTime > activeSignal.confirmedBarTime &&
        lastClosedScanKeyRef.current !== scanKey
      ) {
        lastClosedScanKeyRef.current = scanKey;
        void runSignalScan(selectedSymbol, timeframe, false);
      }
    };

    const timer = setInterval(checkCandleClose, 2000);
    return () => clearInterval(timer);
  }, [activeSignal, selectedSymbol, timeframe, runSignalScan]);

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
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
          candles: candlesRef.current.length >= 2000 ? candlesRef.current : undefined,
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

  const ntfyReady = useMemo(
    () =>
      /^[A-Za-z0-9_-]{4,80}$/.test(demoAccount.config.ntfyTopic.trim()) ||
      Boolean(ntfyStatus?.configured),
    [demoAccount.config.ntfyTopic, ntfyStatus]
  );

  const sniperBySymbol = useMemo(() => {
    const map: Record<string, 'BUY' | 'SELL'> = {};
    for (const sig of marketScan?.sniperSignals ?? []) {
      if (sig.plan.signal === 'BUY' || sig.plan.signal === 'SELL') {
        map[sig.symbol] = sig.plan.signal;
      }
    }
    return map;
  }, [marketScan]);

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      <TopNavBar
        activeSection={activeSection}
        openPositionCount={demoAccount.openPositions.length}
        onNavigate={handleNavigate}
        onGenerateSignal={() => void runMarketSniperScan(false)}
        isAnalyzing={isAnalyzing || isMarketScanning}
      />

      <div className="mx-auto flex w-full max-w-[1600px] flex-1 flex-col lg:flex-row">
        <WatchlistSidebar
          quotes={watchlist}
          selectedSymbol={selectedSymbol}
          sniperBySymbol={sniperBySymbol}
          onSelectSymbol={(sym) => {
            setSelectedSymbol(sym);
            setAiError(null);
            const fromScan = [
              ...(marketScan?.sniperSignals ?? []),
              ...(marketScan?.watchSignals ?? []),
            ].find((s) => s.symbol === sym);
            if (fromScan) {
              setActiveSignal(fromScan);
            }
          }}
          isLoading={watchlistLoading}
          isMobileOpen={isMobileMarketsOpen}
          onCloseMobile={() => setIsMobileMarketsOpen(false)}
        />

        <main id="workspace" className="flex-1 min-w-0 flex flex-col">
          <LivePriceHeader
            instrument={instrument}
            timeframe={timeframe}
            price={displayPrice}
            changePct={changePct}
            sessionHigh={sessionStats.high}
            sessionLow={sessionStats.low}
            isConnected={isStreamConnected}
            sourceLabel={sourceLabel}
            onOpenMarkets={() => setIsMobileMarketsOpen(true)}
          />

          <div className="flex-1 space-y-5 p-3.5 sm:p-6 pb-20 md:pb-6">
            {feedError && (
              <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
                {feedError}
              </div>
            )}

            {activeSection === 'workspace' && (
              <>
                <MarketSniperScanner
                  scan={marketScan}
                  isScanning={isMarketScanning}
                  error={marketScanError}
                  selectedSymbol={selectedSymbol}
                  watchlist={watchlist}
                  smsConfigured={Boolean(smsStatus?.configured)}
                  smsSending={smsSending}
                  ntfyTopic={demoAccount.config.ntfyTopic}
                  ntfyAlertsEnabled={demoAccount.config.ntfyAlertsEnabled}
                  ntfyNotifyWait={demoAccount.config.ntfyNotifyWait}
                  ntfyReady={ntfyReady}
                  ntfySending={ntfySending}
                  ntfyFeedback={ntfyFeedback}
                  onUpdateNtfyTopic={(topic) =>
                    handleUpdateConfig({ ntfyTopic: topic })
                  }
                  onGenerateNtfyTopic={handleGenerateNtfyTopic}
                  onToggleNtfyAlerts={() =>
                    handleUpdateConfig({
                      ntfyAlertsEnabled: !demoAccount.config.ntfyAlertsEnabled,
                    })
                  }
                  onToggleNtfyNotifyWait={() =>
                    handleUpdateConfig({
                      ntfyNotifyWait: !demoAccount.config.ntfyNotifyWait,
                    })
                  }
                  onTestNtfy={handleTestNtfy}
                  onSendNtfy={handleSendSignalToNtfy}
                  onScanMarket={() => void runMarketSniperScan(false)}
                  onSelectSignal={(sig) => {
                    setSelectedSymbol(sig.symbol);
                    setTimeframe('5M');
                    setActiveSignal(sig);
                    setAiError(null);
                  }}
                  onExecuteOnDemo={(sig, spotOverride) =>
                    handleExecuteSignalOnDemo(sig, spotOverride)
                  }
                  onSendSms={handleSendSignalToSms}
                />

                <div className="grid grid-cols-1 gap-4 sm:gap-5 xl:grid-cols-12 items-start">
                <div className="space-y-4 xl:col-span-8">
                  <CandlestickChart
                    symbol={selectedSymbol}
                    timeframe={timeframe}
                    decimals={instrument.decimals}
                    candles={candles}
                    priceAction={priceAction}
                    activeSignal={activeSignal}
                    signalHistory={signalHistory}
                    causalArrows={causalArrows}
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
                    livePrice={displayPrice}
                    formingCandle={formingCandle}
                    signal={activeSignal}
                    isAnalyzing={isAnalyzing}
                    error={aiError}
                    smsConfigured={Boolean(smsStatus?.configured)}
                    smsSending={smsSending}
                    ntfyReady={ntfyReady}
                    ntfySending={ntfySending}
                    onGenerateSignal={handleGenerateSignal}
                    onSelectTimeframe={setTimeframe}
                    onExecuteOnDemo={(sig) => handleExecuteSignalOnDemo(sig)}
                    onSendSms={handleSendSignalToSms}
                    onSendNtfy={handleSendSignalToNtfy}
                  />
                </div>
              </div>
              </>
            )}

            {activeSection === 'demo' && (
              <DemoTradingPanel
                demoAccount={demoAccount}
                activeSignal={activeSignal}
                selectedSymbol={selectedSymbol}
                nextScanSecondsLeft={nextScanSecondsLeft}
                lastExecutionNote={lastExecutionNote}
                smsStatus={smsStatus}
                smsSending={smsSending}
                ntfyReady={ntfyReady}
                ntfySending={ntfySending}
                ntfyFeedback={ntfyFeedback}
                onGenerateNtfyTopic={handleGenerateNtfyTopic}
                onTestNtfy={handleTestNtfy}
                onTestSms={handleTestSms}
                onUpdateConfig={handleUpdateConfig}
                onExecuteSignal={(sig) => handleExecuteSignalOnDemo(sig)}
                onClosePosition={handleClosePosition}
                onMoveToBreakeven={handleMoveToBreakeven}
                onResetAccount={handleResetDemoAccount}
                onSelectSymbol={(sym) => {
                  setSelectedSymbol(sym);
                  setAiError(null);
                  setActiveSection('workspace');
                }}
              />
            )}

            {activeSection === 'backtest' && (
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
            )}

            {activeSection === 'levels' && (
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
                  setActiveSection('workspace');
                }}
              />
            )}

            <RiskDisclaimerBanner />
          </div>
        </main>
      </div>

      <MobileBottomNav
        activeSection={activeSection}
        openPositionCount={demoAccount.openPositions.length}
        onNavigate={handleNavigate}
      />
    </div>
  );
}
