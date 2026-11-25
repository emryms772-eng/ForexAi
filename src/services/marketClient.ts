import type {
  AIBacktestReview,
  AIPriceActionSignal,
  BacktestResult,
  MarketCandlesResponse,
  MarketTickEvent,
  OHLCVCandle,
  PriceActionAnalysisSummary,
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
  const res = await fetch('/api/analysis/signal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return parseJsonSafe<SignalResponse>(
    res,
    'Failed to generate AI price-action signal'
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
  return parseJsonSafe<BacktestResponse>(
    res,
    'Failed to run causal price-action backtest'
  );
}
