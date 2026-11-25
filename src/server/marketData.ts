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
  lastUpstreamFetchAt: number;
  anchorOpen24h: number;
  dailyChangePct?: number;
  dailyHigh24h?: number;
  dailyLow24h?: number;
  trendBias: number;
}

interface LiveBrokerQuote {
  price: number;
  bid?: number;
  ask?: number;
  changePct?: number;
  dailyOpen?: number;
  high24h?: number;
  low24h?: number;
  fetchedAt: number;
}

const seriesCache = new Map<string, SeriesState>();
const brokerQuoteCache = new Map<string, LiveBrokerQuote>();
let lastScannerBatchAt = 0;
let scannerInflight: Promise<void> | null = null;

const OANDA_FX_TICKERS: Record<string, string> = {
  'EUR/USD': 'OANDA:EURUSD',
  'GBP/USD': 'OANDA:GBPUSD',
  'USD/JPY': 'OANDA:USDJPY',
  'USD/CHF': 'OANDA:USDCHF',
  'AUD/USD': 'OANDA:AUDUSD',
  'USD/CAD': 'OANDA:USDCAD',
  'NZD/USD': 'OANDA:NZDUSD',
  'EUR/JPY': 'OANDA:EURJPY',
  'GBP/JPY': 'OANDA:GBPJPY',
  'EUR/GBP': 'OANDA:EURGBP',
};

const OANDA_ALL_TICKERS: Record<string, string> = {
  'XAU/USD': 'OANDA:XAUUSD',
  ...OANDA_FX_TICKERS,
};

const REVERSE_OANDA_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(OANDA_ALL_TICKERS).map(([sym, tv]) => [tv, sym])
);

const KRAKEN_FX_PAIRS: Record<string, string> = {
  'EUR/USD': 'EURUSD',
  'GBP/USD': 'GBPUSD',
  'USD/JPY': 'USDJPY',
  'USD/CHF': 'USDCHF',
  'AUD/USD': 'AUDUSD',
  'USD/CAD': 'USDCAD',
  'EUR/JPY': 'EURJPY',
  'EUR/GBP': 'EURGBP',
};

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

function roundPrice(value: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function getBucketTime(unixSec: number, tfSeconds: number): number {
  return Math.floor(unixSec / tfSeconds) * tfSeconds;
}

function normalizeAscendingCandles(rawCandles: OHLCVCandle[]): OHLCVCandle[] {
  const valid = rawCandles.filter(
    (c) =>
      Number.isFinite(c.time) &&
      Number.isFinite(c.open) &&
      Number.isFinite(c.high) &&
      Number.isFinite(c.low) &&
      Number.isFinite(c.close)
  );
  if (valid.length <= 1) return valid;

  valid.sort((a, b) => a.time - b.time);

  const deduped: OHLCVCandle[] = [];
  for (const bar of valid) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.time === bar.time) {
      deduped[deduped.length - 1] = {
        time: bar.time,
        open: prev.open,
        high: Math.max(prev.high, bar.high),
        low: Math.min(prev.low, bar.low),
        close: bar.close,
        volume: Math.max(prev.volume, bar.volume),
      };
    } else {
      deduped.push(bar);
    }
  }
  return deduped;
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

function mapTimeframeToTvResolution(tf: Timeframe): string {
  switch (tf) {
    case '1M':
      return '1';
    case '5M':
      return '5';
    case '15M':
      return '15';
    case '1H':
      return '60';
    case '4H':
      return '240';
  }
}

function mapTimeframeToTwelveData(tf: Timeframe): string {
  switch (tf) {
    case '1M':
      return '1min';
    case '5M':
      return '5min';
    case '15M':
      return '15min';
    case '1H':
      return '1h';
    case '4H':
      return '4h';
  }
}

function mapTimeframeToKraken(tf: Timeframe): number {
  switch (tf) {
    case '1M':
      return 1;
    case '5M':
      return 5;
    case '15M':
      return 15;
    case '1H':
      return 60;
    case '4H':
      return 240;
  }
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

/**
 * Optional institutional OHLC feed via Twelve Data (when TWELVEDATA_API_KEY is set).
 */
async function fetchTwelveDataCandles(
  symbol: string,
  timeframe: Timeframe,
  limit: number,
  decimals: number
): Promise<OHLCVCandle[] | null> {
  const apiKey = process.env.TWELVEDATA_API_KEY?.trim();
  if (!apiKey) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const interval = mapTimeframeToTwelveData(timeframe);
    const url = new URL('https://api.twelvedata.com/time_series');
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('outputsize', String(Math.min(limit, 350)));
    url.searchParams.set('timezone', 'UTC');
    url.searchParams.set('apikey', apiKey);

    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      status?: string;
      values?: Array<{
        datetime?: string;
        open?: string;
        high?: string;
        low?: string;
        close?: string;
        volume?: string;
      }>;
    };
    if (json.status === 'error' || !Array.isArray(json.values) || json.values.length < 30) {
      return null;
    }

    const candles: OHLCVCandle[] = [];
    for (const row of json.values) {
      if (!row.datetime) continue;
      const ms = Date.parse(row.datetime.replace(' ', 'T') + 'Z');
      if (!Number.isFinite(ms)) continue;
      candles.push({
        time: Math.floor(ms / 1000),
        open: roundPrice(Number(row.open), decimals),
        high: roundPrice(Number(row.high), decimals),
        low: roundPrice(Number(row.low), decimals),
        close: roundPrice(Number(row.close), decimals),
        volume: Math.max(100, Math.round(Number(row.volume) || 250)),
      });
    }
    const normalized = normalizeAscendingCandles(candles);
    return normalized.length >= 30 ? normalized.slice(-limit) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Primary zero-key real OANDA broker OHLCV bars via TradingView public chart stream.
 * Matches TradingView / OANDA candles and precision exactly.
 */
async function fetchOandaTvCandles(
  tvSymbol: string,
  timeframe: Timeframe,
  limit: number,
  decimals: number
): Promise<OHLCVCandle[] | null> {
  if (typeof WebSocket === 'undefined') return null;

  const WebSocketWithHeaders = WebSocket as unknown as new (
    url: string,
    options?: { headers?: Record<string, string> }
  ) => WebSocket;

  const resolution = mapTimeframeToTvResolution(timeframe);
  const tfSec = TIMEFRAME_SECONDS[timeframe];

  return new Promise<OHLCVCandle[] | null>((resolve) => {
    let settled = false;
    const finish = (result: OHLCVCandle[] | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        // Ignore close errors
      }
      resolve(result);
    };

    let ws: WebSocket;
    try {
      ws = new WebSocketWithHeaders('wss://data.tradingview.com/socket.io/websocket', {
        headers: { Origin: 'https://www.tradingview.com' },
      });
    } catch {
      resolve(null);
      return;
    }

    const session = `cs_${Math.random().toString(36).slice(2, 10)}`;
    const sendMsg = (m: string, p: unknown[]) => {
      const body = JSON.stringify({ m, p });
      ws.send(`~m~${body.length}~m~${body}`);
    };

    const timer = setTimeout(() => finish(null), 4200);

    ws.onopen = () => {
      try {
        sendMsg('chart_create_session', [session, '']);
        sendMsg('resolve_symbol', [
          session,
          'sds_sym_1',
          `={"symbol":"${tvSymbol}","adjustment":"splits"}`,
        ]);
        sendMsg('create_series', [
          session,
          'sds_1',
          's1',
          'sds_sym_1',
          resolution,
          Math.min(Math.max(limit, 60), 320),
        ]);
      } catch {
        finish(null);
      }
    };

    ws.onmessage = (evt) => {
      const raw = String(evt.data);
      if (raw.includes('~h~')) {
        const match = raw.match(/~m~\d+~m~(~h~\d+)/);
        if (match) {
          try {
            ws.send(`~m~${match[1].length}~m~${match[1]}`);
          } catch {
            // Ignore heartbeat write error
          }
        }
      }

      if (raw.includes('timescale_update')) {
        const regex = /~m~(\d+)~m~/g;
        let m: RegExpExecArray | null;
        while ((m = regex.exec(raw)) !== null) {
          const len = Number(m[1]);
          const start = m.index + m[0].length;
          const chunk = raw.slice(start, start + len);
          if (!chunk.startsWith('{')) continue;
          try {
            const parsed = JSON.parse(chunk) as {
              m?: string;
              p?: [string, { sds_1?: { s?: Array<{ v?: number[] }> } }];
            };
            if (parsed.m === 'timescale_update') {
              const items = parsed.p?.[1]?.sds_1?.s;
              if (Array.isArray(items) && items.length >= 20) {
                const candles: OHLCVCandle[] = [];
                for (const item of items) {
                  const v = item.v;
                  if (!Array.isArray(v) || v.length < 5) continue;
                  candles.push({
                    time: getBucketTime(Math.floor(Number(v[0])), tfSec),
                    open: roundPrice(Number(v[1]), decimals),
                    high: roundPrice(Number(v[2]), decimals),
                    low: roundPrice(Number(v[3]), decimals),
                    close: roundPrice(Number(v[4]), decimals),
                    volume: Math.max(50, Math.round(Number(v[5]) || 150)),
                  });
                }
                const normalized = normalizeAscendingCandles(candles);
                finish(normalized.length >= 20 ? normalized.slice(-limit) : null);
                return;
              }
            }
          } catch {
            // Ignore malformed chunk
          }
        }
      }

      if (raw.includes('series_error') || raw.includes('symbol_error')) {
        finish(null);
      }
    };

    ws.onerror = () => finish(null);
  });
}

async function fetchKrakenFxCandles(
  krakenPair: string,
  timeframe: Timeframe,
  limit: number,
  decimals: number
): Promise<OHLCVCandle[] | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3200);
  try {
    const interval = mapTimeframeToKraken(timeframe);
    const url = `https://api.kraken.com/0/public/OHLC?pair=${encodeURIComponent(
      krakenPair
    )}&interval=${interval}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      error?: string[];
      result?: Record<string, unknown>;
    };
    if (json.error && json.error.length > 0) return null;
    const entries = Object.entries(json.result ?? {}).find(
      ([k, v]) => k !== 'last' && Array.isArray(v)
    );
    const rows = entries?.[1];
    if (!Array.isArray(rows) || rows.length < 30) return null;

    const tfSec = TIMEFRAME_SECONDS[timeframe];
    const candles: OHLCVCandle[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 7) continue;
      candles.push({
        time: getBucketTime(Number(row[0]), tfSec),
        open: roundPrice(Number(row[1]), decimals),
        high: roundPrice(Number(row[2]), decimals),
        low: roundPrice(Number(row[3]), decimals),
        close: roundPrice(Number(row[4]), decimals),
        volume: Math.max(10, Math.round(Number(row[6]))),
      });
    }
    const normalized = normalizeAscendingCandles(candles);
    return normalized.length >= 30 ? normalized.slice(-limit) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
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
    const normalized = normalizeAscendingCandles(candles);
    return normalized.length >= 30 ? normalized : null;
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

    const tfSec = TIMEFRAME_SECONDS[timeframe];
    const rawCandles: OHLCVCandle[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i] ?? 0;
      if (o == null || h == null || l == null || c == null) continue;
      rawCandles.push({
        time: getBucketTime(timestamps[i], tfSec),
        open: roundPrice(o, decimals),
        high: roundPrice(h, decimals),
        low: roundPrice(l, decimals),
        close: roundPrice(c, decimals),
        volume: Math.max(100, Math.round(v)),
      });
    }

    const ordered = normalizeAscendingCandles(rawCandles);
    if (ordered.length < 30) return null;
    return ordered.slice(-limit);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Batch-fetches real-time OANDA prices, 24h % change, and daily High/Low
 * across all 10 Forex pairs + Spot Gold XAU/USD in 1 fast roundtrip (~120ms).
 */
async function refreshOandaScannerBatch(): Promise<void> {
  const now = Date.now();
  if (now - lastScannerBatchAt < 1050) return;
  if (scannerInflight) return scannerInflight;

  scannerInflight = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2400);
    try {
      const fxTickers = Object.values(OANDA_FX_TICKERS);
      const columns = ['close', 'change', 'open', 'high', 'low'];

      const [fxRes, cfdRes] = await Promise.all([
        fetch('https://scanner.tradingview.com/forex/scan', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbols: { tickers: fxTickers },
            columns,
          }),
        }),
        fetch('https://scanner.tradingview.com/cfd/scan', {
          method: 'POST',
          signal: controller.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbols: { tickers: ['OANDA:XAUUSD'] },
            columns,
          }),
        }),
      ]);

      const ingest = (
        payload: { data?: Array<{ s?: string; d?: Array<number | null> }> } | null
      ) => {
        for (const item of payload?.data ?? []) {
          const sym = item.s ? REVERSE_OANDA_MAP[item.s] : undefined;
          const d = item.d;
          if (!sym || !Array.isArray(d)) continue;
          const close = Number(d[0]);
          if (!Number.isFinite(close) || close <= 0) continue;
          const changePct = Number(d[1]);
          const dailyOpen = Number(d[2]);
          const high24h = Number(d[3]);
          const low24h = Number(d[4]);
          const prev = brokerQuoteCache.get(sym);
          brokerQuoteCache.set(sym, {
            price: close,
            bid: prev?.bid,
            ask: prev?.ask,
            changePct: Number.isFinite(changePct) ? changePct : prev?.changePct,
            dailyOpen:
              Number.isFinite(dailyOpen) && dailyOpen > 0
                ? dailyOpen
                : prev?.dailyOpen,
            high24h:
              Number.isFinite(high24h) && high24h > 0 ? high24h : prev?.high24h,
            low24h:
              Number.isFinite(low24h) && low24h > 0 ? low24h : prev?.low24h,
            fetchedAt: Date.now(),
          });
        }
      };

      if (fxRes.ok) ingest(await fxRes.json());
      if (cfdRes.ok) ingest(await cfdRes.json());
      lastScannerBatchAt = Date.now();
    } catch {
      // Fall back cleanly to Swissquote BBO if scanner is unreachable
    } finally {
      clearTimeout(timeout);
      scannerInflight = null;
    }
  })();

  return scannerInflight;
}

async function fetchSwissquoteBbo(
  symbol: string
): Promise<{ price: number; bid: number; ask: number } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(
      `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${symbol}`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as Array<{
      spreadProfilePrices?: Array<{ bid?: number; ask?: number }>;
    }>;
    const bbo = json?.[0]?.spreadProfilePrices?.[0];
    if (
      bbo &&
      Number.isFinite(bbo.bid) &&
      Number.isFinite(bbo.ask) &&
      Number(bbo.bid) > 0 &&
      Number(bbo.ask) > 0
    ) {
      const bid = Number(bbo.bid);
      const ask = Number(bbo.ask);
      return { price: (bid + ask) / 2, bid, ask };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchRealTimeBrokerQuote(
  symbol: string
): Promise<LiveBrokerQuote | null> {
  if (symbol === 'BTC/USD') {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const res = await fetch(
        'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT',
        { signal: controller.signal }
      );
      if (!res.ok) return null;
      const data = (await res.json()) as {
        lastPrice?: string;
        bidPrice?: string;
        askPrice?: string;
        priceChangePercent?: string;
        openPrice?: string;
        highPrice?: string;
        lowPrice?: string;
      };
      const price = Number(data.lastPrice);
      if (!Number.isFinite(price) || price <= 0) return null;
      return {
        price,
        bid: Number(data.bidPrice) || undefined,
        ask: Number(data.askPrice) || undefined,
        changePct: Number.isFinite(Number(data.priceChangePercent))
          ? Number(data.priceChangePercent)
          : undefined,
        dailyOpen: Number(data.openPrice) || undefined,
        high24h: Number(data.highPrice) || undefined,
        low24h: Number(data.lowPrice) || undefined,
        fetchedAt: Date.now(),
      };
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (OANDA_ALL_TICKERS[symbol]) {
    await refreshOandaScannerBatch();
    const cached = brokerQuoteCache.get(symbol);
    if (cached && Date.now() - cached.fetchedAt < 8000) {
      return cached;
    }

    const sq = await fetchSwissquoteBbo(symbol);
    if (sq) {
      const quote: LiveBrokerQuote = {
        price: sq.price,
        bid: sq.bid,
        ask: sq.ask,
        changePct: cached?.changePct,
        dailyOpen: cached?.dailyOpen,
        high24h: cached?.high24h,
        low24h: cached?.low24h,
        fetchedAt: Date.now(),
      };
      brokerQuoteCache.set(symbol, quote);
      return quote;
    }
    return cached ?? null;
  }

  return null;
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
      regimeDrift = (rand() - 0.48) * stepVol * 0.45;
    }
    const open = roundPrice(price, instrument.decimals);
    const wave = Math.sin(i / 9) * stepVol * 0.28;
    const shock = (rand() - 0.5) * 2.1 * stepVol;
    const closeRaw = open * (1 + regimeDrift + wave + shock);
    const close = roundPrice(
      Math.max(closeRaw, instrument.basePrice * 0.5),
      instrument.decimals
    );

    const upperWick = open * stepVol * (0.15 + rand() * 0.75);
    const lowerWick = open * stepVol * (0.15 + rand() * 0.75);
    const high = roundPrice(
      Math.max(open, close) + upperWick,
      instrument.decimals
    );
    const low = roundPrice(
      Math.min(open, close) - lowerWick,
      instrument.decimals
    );

    const bodyRatio = Math.abs(close - open) / Math.max(open * stepVol, 1e-9);
    const baseVolume = instrument.category === 'Forex' ? 4200 : 1250;
    const volume = Math.round(
      baseVolume * (0.65 + rand() * 0.9 + bodyRatio * 0.7)
    );

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

  if (instrument.category === 'Forex' || instrument.symbol === 'XAU/USD') {
    // Tier 1: Optional Twelve Data institutional REST API (if configured)
    const td = await fetchTwelveDataCandles(
      instrument.symbol,
      timeframe,
      limit,
      instrument.decimals
    );
    if (td) {
      return {
        candles: td,
        source: 'live-api',
        sourceLabel: 'Twelve Data Institutional Feed',
      };
    }

    // Tier 2: Real-time OANDA broker OHLCV bars (matches TradingView OANDA charts)
    const oandaTicker = OANDA_ALL_TICKERS[instrument.symbol];
    if (oandaTicker) {
      const oandaBars = await fetchOandaTvCandles(
        oandaTicker,
        timeframe,
        limit,
        instrument.decimals
      );
      if (oandaBars) {
        return {
          candles: oandaBars,
          source: 'live-api',
          sourceLabel:
            instrument.symbol === 'XAU/USD'
              ? 'OANDA Spot Gold Feed'
              : 'OANDA Live FX Feed',
        };
      }
    }

    // Tier 3: Kraken Spot FX OHLCV (5-decimal precision fallback)
    const krakenPair = KRAKEN_FX_PAIRS[instrument.symbol];
    if (krakenPair) {
      const krakenBars = await fetchKrakenFxCandles(
        krakenPair,
        timeframe,
        limit,
        instrument.decimals
      );
      if (krakenBars) {
        return {
          candles: krakenBars,
          source: 'live-api',
          sourceLabel: 'Kraken Spot FX Feed',
        };
      }
    }

    // Tier 4: Bucket-aligned Yahoo Finance fallback
    if (instrument.symbol === 'XAU/USD') {
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
          sourceLabel: 'Yahoo Finance Gold Feed',
        };
      }
    } else {
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

  const tfSec = TIMEFRAME_SECONDS[timeframe];
  const nowMs = Date.now();
  const nowBucket = getBucketTime(Math.floor(nowMs / 1000), tfSec);
  const cachedBucket = existing
    ? getBucketTime(Math.floor(existing.lastUpstreamFetchAt / 1000), tfSec)
    : 0;

  // Reuse cached series for 25s within the same candle bucket; immediately refresh when a new candle closes
  if (
    existing &&
    nowMs - existing.lastUpstreamFetchAt < 25000 &&
    cachedBucket === nowBucket &&
    existing.candles.length >= limit
  ) {
    const slice = existing.candles.slice(-limit);
    return {
      symbol: instrument.symbol,
      timeframe,
      decimals: instrument.decimals,
      source: existing.source,
      sourceLabel: existing.sourceLabel,
      candles: slice,
    };
  }

  const [fetched, liveQuote] = await Promise.all([
    loadUpstreamCandles(instrument, timeframe, limit),
    fetchRealTimeBrokerQuote(instrument.symbol),
  ]);

  const candles = normalizeAscendingCandles(fetched.candles);

  // Sync forming candle tip with the live broker price so header & chart match immediately
  if (
    liveQuote &&
    Number.isFinite(liveQuote.price) &&
    liveQuote.price > 0 &&
    candles.length > 0 &&
    fetched.source === 'live-api'
  ) {
    const tfSec = TIMEFRAME_SECONDS[timeframe];
    const nowBucket = getBucketTime(Math.floor(Date.now() / 1000), tfSec);
    const liveRounded = roundPrice(liveQuote.price, instrument.decimals);
    const lastBar = candles[candles.length - 1];

    if (nowBucket > lastBar.time) {
      candles.push({
        time: nowBucket,
        open: lastBar.close,
        high: Math.max(lastBar.close, liveRounded),
        low: Math.min(lastBar.close, liveRounded),
        close: liveRounded,
        volume: 100,
      });
    } else if (nowBucket === lastBar.time) {
      lastBar.close = liveRounded;
      lastBar.high = roundPrice(Math.max(lastBar.high, liveRounded), instrument.decimals);
      lastBar.low = roundPrice(Math.min(lastBar.low, liveRounded), instrument.decimals);
    }
  }

  const anchorIdx = Math.max(0, candles.length - 48);
  const anchorOpen24h =
    liveQuote?.dailyOpen ?? candles[anchorIdx]?.open ?? candles[0].open;

  seriesCache.set(cacheKey, {
    symbol: instrument.symbol,
    timeframe,
    candles,
    source: fetched.source,
    sourceLabel: fetched.sourceLabel,
    lastUpdatedAt: Date.now(),
    lastUpstreamFetchAt: Date.now(),
    anchorOpen24h,
    dailyChangePct: liveQuote?.changePct,
    dailyHigh24h: liveQuote?.high24h,
    dailyLow24h: liveQuote?.low24h,
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
  let liveQuote: LiveBrokerQuote | null = null;
  const effectiveSource: FeedOrigin = state?.source ?? 'simulated-live';

  if (
    effectiveSource === 'live-api' ||
    instrument.category === 'Forex' ||
    instrument.symbol === 'XAU/USD' ||
    instrument.symbol === 'BTC/USD'
  ) {
    liveQuote = await fetchRealTimeBrokerQuote(instrument.symbol);
    if (liveQuote && Number.isFinite(liveQuote.price)) {
      nextPrice = roundPrice(liveQuote.price, instrument.decimals);
      if (state) {
        if (liveQuote.dailyOpen) state.anchorOpen24h = liveQuote.dailyOpen;
        if (liveQuote.changePct !== undefined) state.dailyChangePct = liveQuote.changePct;
        if (liveQuote.high24h) state.dailyHigh24h = liveQuote.high24h;
        if (liveQuote.low24h) state.dailyLow24h = liveQuote.low24h;
      }
    } else if (instrument.category === 'Synthetic') {
      const microVol = (instrument.volatilityBps / 10000) * 0.16;
      nextPrice = roundPrice(
        baseCandle.close * (1 + (Math.random() - 0.5) * microVol),
        instrument.decimals
      );
    } else {
      // Hold exact last real broker price rather than inventing fake random FX ticks
      nextPrice = baseCandle.close;
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
      volume:
        liveQuote || instrument.category !== 'Synthetic'
          ? 120
          : Math.round(120 + Math.random() * 240),
    };
    if (state) {
      state.candles.push(activeCandle);
      if (state.candles.length > 260) {
        state.candles.shift();
      }
    }
  } else {
    const priceChanged = nextPrice !== baseCandle.close;
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
      volume: priceChanged
        ? Math.round(baseCandle.volume + 5)
        : baseCandle.volume,
    };
    if (cachedLast) {
      Object.assign(cachedLast, activeCandle);
    }
  }

  if (state) {
    state.lastUpdatedAt = Date.now();
  }

  const anchorOpen =
    liveQuote?.dailyOpen ?? state?.anchorOpen24h ?? hint?.anchorOpen ?? baseCandle.open;
  const fallbackSpread =
    nextPrice * (instrument.category === 'Forex' ? 0.00012 : 0.00025);
  const bid = roundPrice(
    liveQuote?.bid ?? nextPrice - fallbackSpread / 2,
    instrument.decimals
  );
  const ask = roundPrice(
    liveQuote?.ask ?? nextPrice + fallbackSpread / 2,
    instrument.decimals
  );
  const changePct =
    liveQuote?.changePct !== undefined
      ? liveQuote.changePct
      : state?.dailyChangePct !== undefined
      ? state.dailyChangePct
      : ((nextPrice - anchorOpen) / Math.max(anchorOpen, 1e-9)) * 100;

  return {
    symbol: instrument.symbol,
    timeframe,
    price: nextPrice,
    bid,
    ask,
    changePct: Math.round(changePct * 100) / 100,
    source: effectiveSource,
    candle: activeCandle,
    timestamp: Date.now(),
  };
}

export async function getWatchlistQuotes(): Promise<WatchlistQuote[]> {
  await refreshOandaScannerBatch();

  return Promise.all(
    MARKET_INSTRUMENTS.map(async (instrument) => {
      const cacheKey = `${instrument.symbol}:5M`;
      let state = seriesCache.get(cacheKey);
      if (!state) {
        await getMarketCandles(instrument.symbol, '5M', 120);
        state = seriesCache.get(cacheKey);
      }

      const live =
        instrument.symbol === 'BTC/USD'
          ? await fetchRealTimeBrokerQuote('BTC/USD')
          : brokerQuoteCache.get(instrument.symbol);

      const candles = state?.candles ?? [];
      const last = candles[candles.length - 1];
      const recent = candles.slice(-48);
      const price = live?.price ?? last?.close ?? instrument.basePrice;
      const anchor =
        live?.dailyOpen ?? state?.anchorOpen24h ?? recent[0]?.open ?? price;
      const changePct =
        live?.changePct !== undefined
          ? live.changePct
          : ((price - anchor) / Math.max(anchor, 1e-9)) * 100;
      const high24h =
        live?.high24h ??
        (recent.length > 0 ? Math.max(...recent.map((c) => c.high)) : price);
      const low24h =
        live?.low24h ??
        (recent.length > 0 ? Math.min(...recent.map((c) => c.low)) : price);

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
