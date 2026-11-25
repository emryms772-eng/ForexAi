import {
  getWhatsAppConfigStatus,
  sendWhatsAppSignalAlert,
  sendWhatsAppTestMessage,
} from '../../src/server/whatsapp.ts';
import type { AIPriceActionSignal } from '../../src/types/market.ts';

interface ServerlessRequest {
  method?: string;
  body?: unknown;
}

interface ServerlessResponse {
  status: (code: number) => ServerlessResponse;
  json: (body: unknown) => void;
}

function isValidSignalPayload(raw: unknown): raw is AIPriceActionSignal {
  if (!raw || typeof raw !== 'object') return false;
  const s = raw as Partial<AIPriceActionSignal>;
  return (
    typeof s.id === 'string' &&
    s.id.length > 0 &&
    typeof s.symbol === 'string' &&
    s.symbol.length > 0 &&
    typeof s.spotPriceAtSignal === 'number' &&
    Number.isFinite(s.spotPriceAtSignal) &&
    Boolean(s.plan && typeof s.plan === 'object' && typeof s.plan.signal === 'string')
  );
}

export default async function handler(
  req: ServerlessRequest,
  res: ServerlessResponse
) {
  if (req.method === 'GET') {
    res.status(200).json(getWhatsAppConfigStatus());
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
      signal?: unknown;
    };

    if (body.action === 'test') {
      const result = await sendWhatsAppTestMessage();
      res.status(200).json({ ok: true, sent: true, provider: result.provider });
      return;
    }

    if (!isValidSignalPayload(body.signal)) {
      res.status(400).json({ error: 'Invalid signal payload for WhatsApp alert.' });
      return;
    }

    const result = await sendWhatsAppSignalAlert(body.signal);
    res.status(200).json({ ok: true, ...result });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : 'Unable to send WhatsApp notification.';
    const status = message.includes('not configured') ? 400 : 500;
    res.status(status).json({ error: message });
  }
}
