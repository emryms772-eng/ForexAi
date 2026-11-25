import {
  generateLocalBacktestReview,
  generateLocalMtfSignal,
} from '../analysis/localSignalEngine';
import { analyzePriceAction } from '../analysis/priceAction';
import { getInstrumentBySymbol } from '../config/instruments';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  BacktestResult,
  MarketCandlesResponse,
  MarketScanResponse,
  MarketTickEvent,
  NtfyConfigStatus,
  OHLCVCandle,
  PriceActionAnalysisSummary,
  SmsConfigStatus,
  Timeframe,
  WatchlistQuote,
} from '../types/market';

export interface CandlesPayload extends MarketCandlesResponse {
  priceAction: PriceActionAnalysisSummary;
}

export interface SignalResponse {
  priceAction: PriceActionAnalysisSummary;
  signal: AIPriceActionSignal;
}

export interface BacktestResponse {
  backtest: BacktestResult;
  aiReview: AIBacktestReview | null;
  aiError: string | null;
}

export interface StreamCandleHint {
  lastCandle?: OHLCVCandle;
  anchorOpen?: number;
}

async function parseJsonSafe<T>(res: Response, fallbackError: string): Promise<T> {
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!res.ok) {
      throw new Error(`${fallbackError} (HTTP ${res.status})`);
    }
    throw new Error(fallbackError);
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || fallbackError);
  }
  return data as T;
}

export async function fetchWatchlistQuotes(): Promise<WatchlistQuote[]> {
  const res = await fetch('/api/market/watchlist');
  const data = await parseJsonSafe<{ quotes: WatchlistQuote[] }>(
    res,
    'Failed to load watchlist quotes'
  );
  return data.quotes;
}

export async function fetchMarketCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 180
): Promise<CandlesPayload> {
  const params = new URLSearchParams({
    symbol,
    timeframe,
    limit: String(limit),
  });
  const res = await fetch(`/api/market/candles?${params.toString()}`);
  return parseJsonSafe<CandlesPayload>(res, 'Failed to load market candles');
}

export async function fetchMarketTick(
  symbol: string,
  timeframe: Timeframe,
  hint?: StreamCandleHint
): Promise<MarketTickEvent> {
  const params = new URLSearchParams({ symbol, timeframe });
  if (hint?.lastCandle) {
    params.set('lastClose', String(hint.lastCandle.close));
    params.set('lastTime', String(hint.lastCandle.time));
    params.set('lastOpen', String(hint.lastCandle.open));
    params.set('lastHigh', String(hint.lastCandle.high));
    params.set('lastLow', String(hint.lastCandle.low));
    params.set('lastVolume', String(hint.lastCandle.volume));
  }
  if (hint?.anchorOpen !== undefined) {
    params.set('anchorOpen', String(hint.anchorOpen));
  }
  const res = await fetch(`/api/market/tick?${params.toString()}`);
  return parseJsonSafe<MarketTickEvent>(res, 'Failed to fetch live market tick');
}

export function subscribeMarketStream(
  symbol: string,
  timeframe: Timeframe,
  onTick: (tick: MarketTickEvent) => void,
  onConnectionChange: (connected: boolean) => void,
  getHint?: () => StreamCandleHint
): () => void {
  let stopped = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let sseReceivedMessage = false;

  const startPollingFallback = () => {
    if (stopped || pollTimer !== null) return;

    const pollOnce = async () => {
      if (stopped) return;
      try {
        const tick = await fetchMarketTick(symbol, timeframe, getHint?.());
        if (!stopped) {
          onConnectionChange(true);
          onTick(tick);
        }
      } catch {
        if (!stopped) {
          onConnectionChange(false);
        }
      }
    };

    void pollOnce();
    pollTimer = setInterval(pollOnce, 1400);
  };

  const params = new URLSearchParams({ symbol, timeframe });
  const source = new EventSource(`/api/market/stream?${params.toString()}`);

  source.onopen = () => {
    if (!stopped) onConnectionChange(true);
  };

  source.onmessage = (event) => {
    if (stopped) return;
    try {
      const tick = JSON.parse(event.data) as MarketTickEvent;
      sseReceivedMessage = true;
      onConnectionChange(true);
      onTick(tick);
    } catch {
      // Ignore malformed frame
    }
  };

  source.onerror = () => {
    if (stopped) return;
    if (!sseReceivedMessage) {
      // Serverless hosts (e.g. Vercel) do not expose /api/market/stream SSE; switch cleanly to /api/market/tick polling
      source.close();
      startPollingFallback();
    } else {
      onConnectionChange(false);
    }
  };

  return () => {
    stopped = true;
    onConnectionChange(false);
    source.close();
    if (pollTimer !== null) {
      clearInterval(pollTimer);
    }
  };
}

export async function requestPriceActionSignal(params: {
  symbol: string;
  timeframe: Timeframe;
  candles: OHLCVCandle[];
}): Promise<SignalResponse> {
  try {
    const res = await fetch('/api/analysis/signal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    return await parseJsonSafe<SignalResponse>(
      res,
      'Failed to generate AI price-action signal'
    );
  } catch (serverErr) {
    const serverMessage =
      serverErr instanceof Error
        ? serverErr.message
        : 'Server AI signal generation failed.';

    try {
      const instrument = getInstrumentBySymbol(params.symbol);
      const orderedTfs: Timeframe[] = ['4H', '1H', '15M', '5M', '1M'];
      const timeframesData = await Promise.all(
        orderedTfs.map(async (tf) => {
          if (tf === params.timeframe && params.candles.length >= 180) {
            return {
              timeframe: tf,
              candles: params.candles,
              analysis: analyzePriceAction(params.candles, instrument.decimals, {
                timeframe: tf,
              }),
            };
          }
          const loaded = await fetchMarketCandles(
            instrument.symbol,
            tf,
            tf === '5M' ? 240 : 200
          );
          return {
            timeframe: tf,
            candles: loaded.candles,
            analysis: loaded.priceAction,
          };
        })
      );

      const activeEntry =
        timeframesData.find((t) => t.timeframe === params.timeframe) ??
        timeframesData[0];

      const signal = generateLocalMtfSignal({
        symbol: instrument.symbol,
        activeTimeframe: params.timeframe,
        timeframesData,
      });

      return {
        priceAction: activeEntry.analysis,
        signal,
      };
    } catch (localErr) {
      const localMessage =
        localErr instanceof Error ? localErr.message : String(localErr);
      throw new Error(`${serverMessage} Local MTF fallback failed: ${localMessage}`);
    }
  }
}

export async function requestMarketSniperScan(): Promise<MarketScanResponse> {
  const res = await fetch('/api/analysis/scan-market', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return parseJsonSafe<MarketScanResponse>(
    res,
    'Failed to run AI market sniper scan'
  );
}

export async function requestPriceActionBacktest(params: {
  symbol: string;
  timeframe: Timeframe;
  riskPercentPerTrade?: number;
  includeAiReview?: boolean;
  candles?: OHLCVCandle[];
}): Promise<BacktestResponse> {
  const res = await fetch('/api/analysis/backtest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const data = await parseJsonSafe<BacktestResponse>(
    res,
    'Failed to run causal price-action backtest'
  );

  if (params.includeAiReview && !data.aiReview) {
    return {
      ...data,
      aiReview: generateLocalBacktestReview(data.backtest),
      aiError: null,
    };
  }

  return data;
}

export async function fetchSmsStatus(): Promise<SmsConfigStatus> {
  const res = await fetch('/api/notifications/sms');
  return parseJsonSafe<SmsConfigStatus>(
    res,
    'Failed to check SMS alert status'
  );
}

export async function sendSmsSignalAlert(
  signal: AIPriceActionSignal
): Promise<{ ok: boolean; sent?: boolean; deduplicated?: boolean; provider?: string }> {
  const res = await fetch('/api/notifications/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ signal }),
  });
  return parseJsonSafe<{
    ok: boolean;
    sent?: boolean;
    deduplicated?: boolean;
    provider?: string;
  }>(res, 'Failed to send SMS signal alert');
}

export async function sendSmsTestAlert(): Promise<{
  ok: boolean;
  sent?: boolean;
  provider?: string;
}> {
  const res = await fetch('/api/notifications/sms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'test' }),
  });
  return parseJsonSafe<{ ok: boolean; sent?: boolean; provider?: string }>(
    res,
    'Failed to send test SMS message'
  );
}

export async function fetchNtfyStatus(): Promise<NtfyConfigStatus> {
  const res = await fetch('/api/notifications/ntfy');
  return parseJsonSafe<NtfyConfigStatus>(
    res,
    'Failed to check ntfy alert status'
  );
}

export async function sendNtfySignalAlert(
  signal: AIPriceActionSignal,
  topic?: string
): Promise<{ ok: boolean; sent?: boolean; deduplicated?: boolean; topic?: string }> {
  const res = await fetch('/api/notifications/ntfy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signal,
      ...(topic?.trim() ? { topic: topic.trim() } : {}),
    }),
  });
  return parseJsonSafe<{
    ok: boolean;
    sent?: boolean;
    deduplicated?: boolean;
    topic?: string;
  }>(res, 'Failed to send ntfy alert');
}

export async function sendNtfyTestAlert(topic?: string): Promise<{
  ok: boolean;
  sent?: boolean;
  topic?: string;
  serverUrl?: string;
}> {
  const res = await fetch('/api/notifications/ntfy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'test',
      ...(topic?.trim() ? { topic: topic.trim() } : {}),
    }),
  });
  return parseJsonSafe<{
    ok: boolean;
    sent?: boolean;
    topic?: string;
    serverUrl?: string;
  }>(res, 'Failed to send test ntfy push');
}

export async function sendNtfyScanDigest(
  scan: MarketScanResponse,
  topic?: string
): Promise<{ ok: boolean; sent?: boolean; deduplicated?: boolean; topic?: string }> {
  const res = await fetch('/api/notifications/ntfy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'digest',
      scan,
      ...(topic?.trim() ? { topic: topic.trim() } : {}),
    }),
  });
  return parseJsonSafe<{
    ok: boolean;
    sent?: boolean;
    deduplicated?: boolean;
    topic?: string;
  }>(res, 'Failed to send ntfy scan digest');
}

export async function syncNtfySubscription(
  topic: string,
  enabled: boolean,
  notifyWait = true
): Promise<void> {
  try {
    await fetch('/api/notifications/ntfy/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: topic.trim(), enabled, notifyWait }),
    });
  } catch {
    // Non-blocking subscription sync
  }
}
