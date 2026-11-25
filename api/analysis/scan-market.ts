import { scanMarketSniperSetups } from '../../src/server/aiAnalysis.ts';

interface ServerlessRequest {
  method?: string;
}

interface ServerlessResponse {
  status: (code: number) => ServerlessResponse;
  json: (body: unknown) => void;
}

export default async function handler(
  req: ServerlessRequest,
  res: ServerlessResponse
) {
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const scan = await scanMarketSniperSetups();
    res.status(200).json(scan);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to complete market sniper scan.';
    res.status(500).json({ error: message });
  }
}
