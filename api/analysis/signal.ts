import { analyzePriceAction } from '../../src/analysis/priceAction.ts';
import { TIMEFRAMES, getInstrumentBySymbol } from '../../src/config/instruments.ts';
import { generatePriceActionSignal } from '../../src/server/aiAnalysis.ts';
import { getMarketCandles } from '../../src/server/marketData.ts';
import type { OHLCVCandle, Timeframe } from '../../src/types/market.ts';

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
      candles?: unknown;
    };

    const symbol = typeof body.symbol === 'string' ? body.symbol : 'XAU/USD';
    const activeTimeframe = parseTimeframe(body.timeframe);
    const instrument = getInstrumentBySymbol(symbol);

    const clientCandles: OHLCVCandle[] = Array.isArray(body.candles)
      ? (body.candles as OHLCVCandle[])
      : [];

    const orderedTfs: Timeframe[] = ['4H', '1H', '15M', '5M', '1M'];
    const timeframesData = await Promise.all(
      orderedTfs.map(async (tf) => {
        const targetLimit = tf === '5M' ? 240 : 200;
        const serverData = await getMarketCandles(
          instrument.symbol,
          tf,
          targetLimit
        );
        const candles =
          serverData.candles.length >= 40
            ? serverData.candles
            : tf === activeTimeframe && clientCandles.length >= 40
            ? clientCandles
            : serverData.candles;
        return {
          timeframe: tf,
          candles,
          analysis: analyzePriceAction(candles, instrument.decimals, {
            timeframe: tf,
          }),
        };
      })
    );

    const activeEntry =
      timeframesData.find((t) => t.timeframe === activeTimeframe) ??
      timeframesData[0];

    const signal = await generatePriceActionSignal({
      symbol: instrument.symbol,
      activeTimeframe,
      timeframesData,
    });

    res.status(200).json({ priceAction: activeEntry.analysis, signal });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to generate AI price-action signal.';
    const errStatus = (error as { statusCode?: number }).statusCode;
    const status =
      errStatus ?? (message.includes('GEMINI_API_KEY') ? 400 : 500);
    res.status(status).json({ error: message });
  }
}
