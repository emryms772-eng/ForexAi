import { runNonRepaintingBacktest } from '../../src/analysis/backtester.ts';
import { TIMEFRAMES, getInstrumentBySymbol } from '../../src/config/instruments.ts';
import { generateBacktestReview } from '../../src/server/aiAnalysis.ts';
import { getMarketCandles } from '../../src/server/marketData.ts';
import type {
  AIBacktestReview,
  OHLCVCandle,
  Timeframe,
} from '../../src/types/market.ts';

interface ServerlessRequest {
  method?: string;
  body?: unknown;
}

interface ServerlessResponse {
  status: (code: number) => ServerlessResponse;
  json: (body: unknown) => void;
}

function parseTimeframe(raw: unknown): Timeframe {
  if (typeof raw === 'string' && TIMEFRAMES.includes(raw as Timeframe)) {
    return raw as Timeframe;
  }
  return '5M';
}

export default async function handler(
  req: ServerlessRequest,
  res: ServerlessResponse
) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = (
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}
    ) as {
      symbol?: unknown;
      timeframe?: unknown;
      riskPercentPerTrade?: unknown;
      includeAiReview?: unknown;
      candles?: unknown;
    };

    const symbol = typeof body.symbol === 'string' ? body.symbol : 'XAU/USD';
    const timeframe = parseTimeframe(body.timeframe);
    const instrument = getInstrumentBySymbol(symbol);
    const riskRaw = Number(body.riskPercentPerTrade);
    const riskPercentPerTrade =
      Number.isFinite(riskRaw) && riskRaw >= 0.25 && riskRaw <= 5 ? riskRaw : 1;
    const includeAiReview = Boolean(body.includeAiReview);

    const clientCandles: OHLCVCandle[] = Array.isArray(body.candles)
      ? (body.candles as OHLCVCandle[])
      : [];

    const candles =
      clientCandles.length >= 260
        ? clientCandles
        : (await getMarketCandles(instrument.symbol, timeframe, 280)).candles;

    const backtest = runNonRepaintingBacktest({
      symbol: instrument.symbol,
      timeframe,
      candles,
      initialCapital: 10000,
      riskPercentPerTrade,
    });

    let aiReview: AIBacktestReview | null = null;
    let aiError: string | null = null;

    if (includeAiReview) {
      try {
        aiReview = await generateBacktestReview(backtest);
      } catch (err) {
        aiError =
          err instanceof Error
            ? err.message
            : 'Unable to generate AI backtest audit.';
      }
    }

    res.status(200).json({ backtest, aiReview, aiError });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to execute causal price-action backtest.';
    res.status(500).json({ error: message });
  }
}
