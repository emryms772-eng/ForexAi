import {
  getNtfyConfigStatus,
  sendNtfyMarketScanDigest,
  sendNtfySignalAlert,
  sendNtfyTestMessage,
} from '../../src/server/ntfy.ts';
import type {
  AIPriceActionSignal,
  MarketScanResponse,
} from '../../src/types/market.ts';

interface ServerlessRequest {
  method?: string;
  body?: unknown;
}

interface ServerlessResponse {
  status: (code: number) => ServerlessResponse;
  json: (body: unknown) => void;
}

export default async function handler(
  req: ServerlessRequest,
  res: ServerlessResponse
) {
  if (req.method === 'GET') {
    res.status(200).json(getNtfyConfigStatus());
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = (
      typeof req.body === 'string' ? JSON.parse(req.body) : req.body ?? {}
    ) as {
      action?: unknown;
      topic?: unknown;
      signal?: unknown;
    };

    if (body.action === 'test') {
      const result = await sendNtfyTestMessage(body.topic);
      res.status(200).json({ sent: true, ...result });
      return;
    }

    if (body.action === 'subscribe') {
      res.status(200).json({ ok: true, subscribed: true });
      return;
    }

    if (body.action === 'digest') {
      const scan = (body as { scan?: unknown }).scan as Partial<MarketScanResponse> | undefined;
      if (!scan || typeof scan !== 'object' || !Array.isArray(scan.watchSignals)) {
        res.status(400).json({ error: 'Invalid scan payload for ntfy digest.' });
        return;
      }
      const result = await sendNtfyMarketScanDigest(
        scan as MarketScanResponse,
        body.topic
      );
      res.status(200).json({ ok: true, ...result });
      return;
    }

    const sig = body.signal as Partial<AIPriceActionSignal> | undefined;
    if (
      !sig ||
      typeof sig !== 'object' ||
      typeof sig.id !== 'string' ||
      !sig.id ||
      typeof sig.symbol !== 'string' ||
      !sig.symbol ||
      typeof sig.spotPriceAtSignal !== 'number' ||
      !Number.isFinite(sig.spotPriceAtSignal) ||
      !sig.plan ||
      typeof sig.plan !== 'object' ||
      typeof sig.plan.signal !== 'string'
    ) {
      res.status(400).json({ error: 'Invalid signal payload for ntfy alert.' });
      return;
    }

    const result = await sendNtfySignalAlert(
      sig as AIPriceActionSignal,
      body.topic
    );
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to send ntfy push notification.';
    const status =
      message.includes('Invalid ntfy') || message.includes('No ntfy') ? 400 : 500;
    res.status(status).json({ error: message });
  }
}
