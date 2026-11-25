import {
  MARKET_INSTRUMENTS,
  TIMEFRAME_SECONDS,
  getInstrumentBySymbol,
} from '../config/instruments.ts';
import type {
  FeedOrigin,
  MarketCandlesResponse,
  MarketInstrument,
  MarketTickEvent,
  OHLCVCandle,
  Timeframe,
  WatchlistQuote,
} from '../types/market.ts';

interface SeriesState {
  symbol: string;
  timeframe: Timeframe;
  candles: OHLCVCandle[];
  source: FeedOrigin;
  sourceLabel: string;
  lastUpdatedAt: number;
  anchorOpen24h: number;
  trendBias: number;
}

const seriesCache = new Map<string, SeriesState>();

function roundPrice(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function getBucketTime(unixSec: number, tfSeconds: number): number {
  return Math.floor(unixSec / tfSeconds) * tfSeconds;
}

function hashSeed(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function createPrng(seed: number): () => number {
  let s = seed % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function mapTimeframeToBinance(tf: Timeframe): string {
  switch (tf) {
    case '1M':
      return '1m';
    case '5M':
      return '5m';
    case '15M':
      return '15m';
    case '1H':
      return '1h';
    case '4H':
      return '4h';
  }
}

function mapTimeframeToYahoo(tf: Timeframe): { interval: string; range: string } {
  switch (tf) {
    case '1M':
      return { interval: '1m', range: '1d' };
    case '5M':
      return { interval: '5m', range: '5d' };
    case '15M':
      return { interval: '15m', range: '5d' };
    case '1H':
      return { interval: '60m', range: '1mo' };
    case '4H':
      return { interval: '60m', range: '3mo' };
  }
}

async function fetchBinanceKlines(
  binanceSymbol: string,
  timeframe: Timeframe,
  limit: number,
  decimals: number
): Promise<OHLCVCandle[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3200);
  try {
    const interval = mapTimeframeToBinance(timeframe);
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(
      binanceSymbol
    )}&interval=${interval}&limit=${limit}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const raw = (await res.json()) as unknown[];
    if (!Array.isArray(raw) || raw.length < 30) return null;

    const candles: OHLCVCandle[] = [];
    for (const row of raw) {
      if (!Array.isArray(row) || row.length < 6) continue;
      candles.push({
        time: Math.floor(Number(row[0]) / 1000),
        open: roundPrice(Number(row[1]), decimals),
        high: roundPrice(Number(row[2]), decimals),
        low: roundPrice(Number(row[3]), decimals),
        close: roundPrice(Number(row[4]), decimals),
        volume: Math.round(Number(row[5]) * 100) / 100,
      });
    }
    return candles.length >= 30 ? candles : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchYahooChart(
  yahooSymbol: string,
  timeframe: Timeframe,
  limit: number,
  decimals: number
): Promise<OHLCVCandle[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3200);
  try {
    const { interval, range } = mapTimeframeToYahoo(timeframe);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol
    )}?interval=${interval}&range=${range}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      chart?: {
        result?: Array<{
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: Array<number | null>;
              high?: Array<number | null>;
              low?: Array<number | null>;
              close?: Array<number | null>;
              volume?: Array<number | null>;
            }>;
          };
        }>;
      };
    };

    const result = json.chart?.result?.[0];
    const timestamps = result?.timestamp;
    const quote = result?.indicators?.quote?.[0];
    if (!timestamps || !quote) return null;

    const rawCandles: OHLCVCandle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i] ?? 0;
      if (o == null || h == null || l == null || c == null) continue;
      rawCandles.push({
        time: timestamps[i],
        open: roundPrice(o, decimals),
        high: roundPrice(h, decimals),
        low: roundPrice(l, decimals),
        close: roundPrice(c, decimals),
        volume: Math.max(100, Math.round(v)),
      });
    }

    if (rawCandles.length < 30) return null;
    if (timeframe === '4H') {
      // Aggregate 1H Yahoo bars into 4H bars
      const aggregated: OHLCVCandle[] = [];
      for (const bar of rawCandles) {
        const bucket = getBucketTime(bar.time, 14400);
        const last = aggregated[aggregated.length - 1];
        if (last && last.time === bucket) {
          last.high = Math.max(last.high, bar.high);
          last.low = Math.min(last.low, bar.low);
          last.close = bar.close;
          last.volume += bar.volume;
        } else {
          aggregated.push({ ...bar, time: bucket });
        }
      }
      return aggregated.slice(-limit);
    }

    return rawCandles.slice(-limit);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function generateStructuredCandles(
  instrument: MarketInstrument,
  timeframe: Timeframe,
  count: number
): OHLCVCandle[] {
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const nowSec = Math.floor(Date.now() / 1000);
  const currentBucket = getBucketTime(nowSec, tfSec);
  const startBucket = currentBucket - (count - 1) * tfSec;

  const rand = createPrng(hashSeed(`${instrument.symbol}-${timeframe}`));
  const tfScale = Math.sqrt(tfSec / 300);
  const stepVol = (instrument.volatilityBps / 10000) * tfScale;

  let price = instrument.basePrice * (0.988 + rand() * 0.024);
  let regimeDrift = (rand() - 0.48) * stepVol * 0.35;

  const candles: OHLCVCandle[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 24 === 0) {
      // Shift trend regime periodically so charts show realistic swings & S/R tests
      regimeDrift = (rand() - 0.48) * stepVol * 0.45;
    }
    const open = roundPrice(price, instrument.decimals);
    const wave = Math.sin(i / 9) * stepVol * 0.28;
    const shock = (rand() - 0.5) * 2.1 * stepVol;
    const closeRaw = open * (1 + regimeDrift + wave + shock);
    const close = roundPrice(Math.max(closeRaw, instrument.basePrice * 0.5), instrument.decimals);

    const upperWick = open * stepVol * (0.15 + rand() * 0.75);
    const lowerWick = open * stepVol * (0.15 + rand() * 0.75);
    const high = roundPrice(Math.max(open, close) + upperWick, instrument.decimals);
    const low = roundPrice(Math.min(open, close) - lowerWick, instrument.decimals);

    const bodyRatio = Math.abs(close - open) / Math.max(open * stepVol, 1e-9);
    const baseVolume = instrument.category === 'Forex' ? 4200 : 1250;
    const volume = Math.round(baseVolume * (0.65 + rand() * 0.9 + bodyRatio * 0.7));

    candles.push({
      time: startBucket + i * tfSec,
      open,
      high,
      low,
      close,
      volume,
    });

    price = close;
  }

  return candles;
}

const YAHOO_FX_TICKERS: Record<string, string> = {
  'EUR/USD': 'EURUSD=X',
  'GBP/USD': 'GBPUSD=X',
  'USD/JPY': 'USDJPY=X',
  'USD/CHF': 'USDCHF=X',
  'AUD/USD': 'AUDUSD=X',
  'USD/CAD': 'USDCAD=X',
  'NZD/USD': 'NZDUSD=X',
  'EUR/JPY': 'EURJPY=X',
  'GBP/JPY': 'GBPJPY=X',
  'EUR/GBP': 'EURGBP=X',
};

async function loadUpstreamCandles(
  instrument: MarketInstrument,
  timeframe: Timeframe,
  limit: number
): Promise<{ candles: OHLCVCandle[]; source: FeedOrigin; sourceLabel: string }> {
  if (instrument.symbol === 'BTC/USD') {
    const binance = await fetchBinanceKlines(
      'BTCUSDT',
      timeframe,
      limit,
      instrument.decimals
    );
    if (binance) {
      return {
        candles: binance,
        source: 'live-api',
        sourceLabel: 'Binance Spot Klines',
      };
    }
  }

  if (instrument.symbol === 'XAU/USD') {
    const binanceGold = await fetchBinanceKlines(
      'PAXGUSDT',
      timeframe,
      limit,
      instrument.decimals
    );
    if (binanceGold) {
      return {
        candles: binanceGold,
        source: 'live-api',
        sourceLabel: 'Spot Gold Proxy (PAXG)',
      };
    }
    const yahooGold = await fetchYahooChart(
      'GC=F',
      timeframe,
      limit,
      instrument.decimals
    );
    if (yahooGold) {
      return {
        candles: yahooGold,
        source: 'live-api',
        sourceLabel: 'Yahoo Finance Gold Futures',
      };
    }
  }

  const yahooFxTicker = YAHOO_FX_TICKERS[instrument.symbol];
  if (yahooFxTicker) {
    const yahooFx = await fetchYahooChart(
      yahooFxTicker,
      timeframe,
      limit,
      instrument.decimals
    );
    if (yahooFx) {
      return {
        candles: yahooFx,
        source: 'live-api',
        sourceLabel: 'Yahoo Finance FX Feed',
      };
    }
  }

  return {
    candles: generateStructuredCandles(instrument, timeframe, limit),
    source: 'simulated-live',
    sourceLabel:
      instrument.category === 'Synthetic'
        ? 'Synthetic Volatility Engine'
        : 'Demo Market Feed',
  };
}

export async function getMarketCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 180
): Promise<MarketCandlesResponse> {
  const instrument = getInstrumentBySymbol(symbol);
  const cacheKey = `${instrument.symbol}:${timeframe}`;
  const existing = seriesCache.get(cacheKey);

  // Reuse cached series for 45 seconds so live ticks remain continuous with history
  if (existing && Date.now() - existing.lastUpdatedAt < 45000 && existing.candles.length >= limit) {
    return {
      symbol: instrument.symbol,
      timeframe,
      decimals: instrument.decimals,
      source: existing.source,
      sourceLabel: existing.sourceLabel,
      candles: existing.candles.slice(-limit),
    };
  }

  const fetched = await loadUpstreamCandles(instrument, timeframe, limit);
  const candles = fetched.candles;
  const anchorIdx = Math.max(0, candles.length - 48);

  seriesCache.set(cacheKey, {
    symbol: instrument.symbol,
    timeframe,
    candles,
    source: fetched.source,
    sourceLabel: fetched.sourceLabel,
    lastUpdatedAt: Date.now(),
    anchorOpen24h: candles[anchorIdx]?.open ?? candles[0].open,
    trendBias: (Math.random() - 0.48) * 0.00015,
  });

  return {
    symbol: instrument.symbol,
    timeframe,
    decimals: instrument.decimals,
    source: fetched.source,
    sourceLabel: fetched.sourceLabel,
    candles,
  };
}

async function fetchLatestSpotPrice(symbol: string): Promise<number | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    if (symbol === 'BTC/USD' || symbol === 'XAU/USD') {
      const pair = symbol === 'BTC/USD' ? 'BTCUSDT' : 'PAXGUSDT';
      const res = await fetch(
        `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
        { signal: controller.signal }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as { price?: string };
      return data.price ? Number(data.price) : null;
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export interface TickHint {
  lastClose?: number;
  lastTime?: number;
  lastOpen?: number;
  lastHigh?: number;
  lastLow?: number;
  lastVolume?: number;
  anchorOpen?: number;
}

export async function advanceMarketTick(
  symbol: string,
  timeframe: Timeframe,
  hint?: TickHint
): Promise<MarketTickEvent> {
  const instrument = getInstrumentBySymbol(symbol);
  const cacheKey = `${instrument.symbol}:${timeframe}`;

  if (!seriesCache.has(cacheKey) && !hint?.lastClose) {
    await getMarketCandles(instrument.symbol, timeframe, 180);
  }

  const state = seriesCache.get(cacheKey);
  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const nowSec = Math.floor(Date.now() / 1000);
  const bucketTime = getBucketTime(nowSec, tfSec);

  const cachedLast = state?.candles[state.candles.length - 1];
  const baseCandle: OHLCVCandle = cachedLast ?? {
    time: hint?.lastTime ?? bucketTime,
    open: hint?.lastOpen ?? hint?.lastClose ?? instrument.basePrice,
    high: hint?.lastHigh ?? hint?.lastClose ?? instrument.basePrice,
    low: hint?.lastLow ?? hint?.lastClose ?? instrument.basePrice,
    close: hint?.lastClose ?? instrument.basePrice,
    volume: hint?.lastVolume ?? 250,
  };

  let nextPrice = baseCandle.close;
  const effectiveSource: FeedOrigin = state?.source ?? 'simulated-live';

  if (effectiveSource === 'live-api' || instrument.symbol === 'BTC/USD' || instrument.symbol === 'XAU/USD') {
    const liveSpot = await fetchLatestSpotPrice(instrument.symbol);
    if (liveSpot && Number.isFinite(liveSpot)) {
      nextPrice = roundPrice(liveSpot, instrument.decimals);
    } else {
      const microVol = (instrument.volatilityBps / 10000) * 0.16;
      nextPrice = roundPrice(
        baseCandle.close * (1 + (Math.random() - 0.5) * microVol),
        instrument.decimals
      );
    }
  } else {
    const bias = state ? state.trendBias : (Math.random() - 0.49) * 0.00018;
    if (state && Math.random() < 0.04) {
      state.trendBias = (Math.random() - 0.49) * 0.00025;
    }
    const tickVol = (instrument.volatilityBps / 10000) * 0.22;
    const delta = bias + (Math.random() - 0.5) * tickVol;
    nextPrice = roundPrice(baseCandle.close * (1 + delta), instrument.decimals);
  }

  let activeCandle: OHLCVCandle;
  if (bucketTime > baseCandle.time) {
    activeCandle = {
      time: bucketTime,
      open: baseCandle.close,
      high: Math.max(baseCandle.close, nextPrice),
      low: Math.min(baseCandle.close, nextPrice),
      close: nextPrice,
      volume: Math.round(120 + Math.random() * 240),
    };
    if (state) {
      state.candles.push(activeCandle);
      if (state.candles.length > 260) {
        state.candles.shift();
      }
    }
  } else {
    activeCandle = {
      time: baseCandle.time,
      open: baseCandle.open,
      close: nextPrice,
      high: roundPrice(
        Math.max(baseCandle.high, nextPrice),
        instrument.decimals
      ),
      low: roundPrice(
        Math.min(baseCandle.low, nextPrice),
        instrument.decimals
      ),
      volume: Math.round(baseCandle.volume + 12 + Math.random() * 38),
    };
    if (cachedLast) {
      Object.assign(cachedLast, activeCandle);
    }
  }

  if (state) {
    state.lastUpdatedAt = Date.now();
  }

  const anchorOpen =
    state?.anchorOpen24h ?? hint?.anchorOpen ?? baseCandle.open;
  const spread = nextPrice * (instrument.category === 'Forex' ? 0.00012 : 0.00025);
  const changePct =
    ((nextPrice - anchorOpen) / Math.max(anchorOpen, 1e-9)) * 100;

  return {
    symbol: instrument.symbol,
    timeframe,
    price: nextPrice,
    bid: roundPrice(nextPrice - spread / 2, instrument.decimals),
    ask: roundPrice(nextPrice + spread / 2, instrument.decimals),
    changePct: Math.round(changePct * 100) / 100,
    source: effectiveSource,
    candle: activeCandle,
    timestamp: Date.now(),
  };
}

export async function getWatchlistQuotes(): Promise<WatchlistQuote[]> {
  return Promise.all(
    MARKET_INSTRUMENTS.map(async (instrument) => {
      const cacheKey = `${instrument.symbol}:5M`;
      let state = seriesCache.get(cacheKey);
      if (!state) {
        await getMarketCandles(instrument.symbol, '5M', 120);
        state = seriesCache.get(cacheKey);
      }
      const candles = state?.candles ?? [];
      const last = candles[candles.length - 1];
      const recent = candles.slice(-48);
      const price = last?.close ?? instrument.basePrice;
      const anchor = state?.anchorOpen24h ?? recent[0]?.open ?? price;
      const changePct = ((price - anchor) / Math.max(anchor, 1e-9)) * 100;
      const high24h =
        recent.length > 0 ? Math.max(...recent.map((c) => c.high)) : price;
      const low24h =
        recent.length > 0 ? Math.min(...recent.map((c) => c.low)) : price;

      return {
        symbol: instrument.symbol,
        name: instrument.name,
        category: instrument.category,
        decimals: instrument.decimals,
        price: roundPrice(price, instrument.decimals),
        changePct: Math.round(changePct * 100) / 100,
        high24h: roundPrice(high24h, instrument.decimals),
        low24h: roundPrice(low24h, instrument.decimals),
      };
    })
  );
}
