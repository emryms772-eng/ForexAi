import { TIMEFRAMES } from '../../src/config/instruments.ts';
import { advanceMarketTick } from '../../src/server/marketData.ts';
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

function parseNumberParam(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
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

    const tick = await advanceMarketTick(symbol, timeframe, {
      lastClose: parseNumberParam(getQueryParam(req.query, 'lastClose')),
      lastTime: parseNumberParam(getQueryParam(req.query, 'lastTime')),
      lastOpen: parseNumberParam(getQueryParam(req.query, 'lastOpen')),
      lastHigh: parseNumberParam(getQueryParam(req.query, 'lastHigh')),
      lastLow: parseNumberParam(getQueryParam(req.query, 'lastLow')),
      lastVolume: parseNumberParam(getQueryParam(req.query, 'lastVolume')),
      anchorOpen: parseNumberParam(getQueryParam(req.query, 'anchorOpen')),
    });

    res.status(200).json(tick);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Tick update failed.';
    res.status(500).json({ error: message });
  }
}
