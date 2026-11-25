import { analyzePriceAction } from '../../src/analysis/priceAction.ts';
import { TIMEFRAMES } from '../../src/config/instruments.ts';
import { getMarketCandles } from '../../src/server/marketData.ts';
import type { Timeframe } from '../../src/types/market.ts';

interface ServerlessRequest {
  method?: string;
  query?: Record<string, string | string[] | undefined>;
}

interface ServerlessResponse {
  status: (code: number) => ServerlessResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
}

function getQueryParam(
  query: Record<string, string | string[] | undefined> | undefined,
  key: string
): string | undefined {
  const val = query?.[key];
  return Array.isArray(val) ? val[0] : val;
}

function parseTimeframe(raw: string | undefined): Timeframe {
  if (raw && TIMEFRAMES.includes(raw as Timeframe)) {
    return raw as Timeframe;
  }
  return '5M';
}

export default async function handler(
  req: ServerlessRequest,
  res: ServerlessResponse
) {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    res.setHeader('Cache-Control', 'no-store');
    const symbol = getQueryParam(req.query, 'symbol') ?? 'XAU/USD';
    const timeframe = parseTimeframe(getQueryParam(req.query, 'timeframe'));
    const rawLimit = Number(getQueryParam(req.query, 'limit'));
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 180, 40), 300);

    const data = await getMarketCandles(symbol, timeframe, limit);
    const priceAction = analyzePriceAction(data.candles, data.decimals);
    res.status(200).json({ ...data, priceAction });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load market candles.';
    res.status(500).json({ error: message });
  }
}
