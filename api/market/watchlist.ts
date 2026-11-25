import { analyzePriceAction } from '../../src/analysis/priceAction.ts';
import { getMarketCandles, getWatchlistQuotes } from '../../src/server/marketData.ts';

interface ServerlessRequest {
  method?: string;
}

interface ServerlessResponse {
  status: (code: number) => ServerlessResponse;
  json: (body: unknown) => void;
  setHeader: (name: string, value: string) => void;
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
    const quotes = await getWatchlistQuotes();
    const enriched = await Promise.all(
      quotes.map(async (q) => {
        const data = await getMarketCandles(q.symbol, '5M', 120);
        const pa = analyzePriceAction(data.candles, q.decimals);
        return {
          ...q,
          structureHint: pa.snapshot.latestStructureEvent,
          recentPattern: pa.snapshot.latestPattern?.name ?? pa.snapshot.rangeZone,
        };
      })
    );
    res.status(200).json({ quotes: enriched });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to fetch watchlist quotes.';
    res.status(500).json({ error: message });
  }
}
