import { formatWhatsAppSignalText } from '../analysis/mtfPrompt.ts';
import type { AIPriceActionSignal, WhatsAppConfigStatus } from '../types/market.ts';

const PHONE_E164_REGEX = /^\+?[1-9]\d{6,14}$/;
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{5,64}$/;
const REQUEST_TIMEOUT_MS = 6000;
const DEDUPE_COOLDOWN_MS = 60_000;

const sentSignalIds = new Set<string>();
const recentFingerprints = new Map<string, number>();

type WhatsAppProvider = WhatsAppConfigStatus['provider'];

interface ResolvedWhatsAppConfig {
  provider: WhatsAppProvider;
  toPhone: string;
  callmebotApiKey?: string;
  metaAccessToken?: string;
  metaPhoneNumberId?: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFrom?: string;
}

function cleanPhone(raw: string | undefined): string {
  return String(raw ?? '')
    .trim()
    .replace(/[\s()-]/g, '');
}

function maskPhone(phone: string): string {
  const normalized = phone.startsWith('+') ? phone : `+${phone}`;
  if (normalized.length <= 6) return '***';
  const prefix = normalized.slice(0, 3);
  const suffix = normalized.slice(-4);
  return `${prefix}***${suffix}`;
}

function resolveWhatsAppConfig(overridePhone?: string): ResolvedWhatsAppConfig {
  const toPhone = cleanPhone(overridePhone || process.env.WHATSAPP_TO_PHONE);
  const callmebotApiKey = process.env.CALLMEBOT_API_KEY?.trim();
  const metaAccessToken = process.env.WHATSAPP_ACCESS_TOKEN?.trim();
  const metaPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID?.trim();
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const twilioFrom = cleanPhone(process.env.TWILIO_WHATSAPP_FROM);

  if (toPhone && metaAccessToken && metaPhoneNumberId) {
    return {
      provider: 'meta-cloud',
      toPhone,
      metaAccessToken,
      metaPhoneNumberId,
    };
  }

  if (toPhone && twilioAccountSid && twilioAuthToken && twilioFrom) {
    return {
      provider: 'twilio',
      toPhone,
      twilioAccountSid,
      twilioAuthToken,
      twilioFrom,
    };
  }

  if (toPhone && callmebotApiKey) {
    return {
      provider: 'callmebot',
      toPhone,
      callmebotApiKey,
    };
  }

  return {
    provider: 'none',
    toPhone,
  };
}

export function getWhatsAppConfigStatus(): WhatsAppConfigStatus {
  const cfg = resolveWhatsAppConfig();
  const isPhoneValid = PHONE_E164_REGEX.test(cfg.toPhone);
  const configured = cfg.provider !== 'none' && isPhoneValid;

  return {
    configured,
    provider: configured ? cfg.provider : 'none',
    recipientMasked: isPhoneValid ? maskPhone(cfg.toPhone) : null,
  };
}

function validatePhoneOrThrow(phone: string): string {
  const normalized = cleanPhone(phone);
  if (!PHONE_E164_REGEX.test(normalized)) {
    throw new Error(
      'Invalid WHATSAPP_TO_PHONE format. Use international E.164 digits (e.g. +14155552671).'
    );
  }
  return normalized.startsWith('+') ? normalized : `+${normalized}`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('WhatsApp provider request timed out.');
    }
    throw new Error('Unable to reach WhatsApp notification provider.');
  } finally {
    clearTimeout(timer);
  }
}

export async function sendWhatsAppMessage(
  text: string,
  overridePhone?: string
): Promise<{ ok: true; provider: WhatsAppProvider }> {
  const cleanText = String(text ?? '').trim();
  if (!cleanText || cleanText.length > 3500) {
    throw new Error('WhatsApp message text must be between 1 and 3500 characters.');
  }

  const cfg = resolveWhatsAppConfig(overridePhone);
  if (cfg.provider === 'none') {
    throw new Error(
      'WhatsApp alerts are not configured on the server. Add WHATSAPP_TO_PHONE and provider credentials in Settings > Secrets.'
    );
  }

  const normalizedTo = validatePhoneOrThrow(cfg.toPhone);

  if (cfg.provider === 'callmebot') {
    const url = new URL('https://api.callmebot.com/whatsapp.php');
    url.searchParams.set('phone', normalizedTo);
    url.searchParams.set('text', cleanText);
    url.searchParams.set('apikey', cfg.callmebotApiKey ?? '');

    const res = await fetchWithTimeout(url.toString(), { method: 'GET' });
    if (!res.ok) {
      throw new Error(`CallMeBot delivery failed (HTTP ${res.status}).`);
    }
    return { ok: true, provider: 'callmebot' };
  }

  if (cfg.provider === 'meta-cloud') {
    const phoneId = cfg.metaPhoneNumberId ?? '';
    if (!SAFE_ID_REGEX.test(phoneId)) {
      throw new Error('Invalid WHATSAPP_PHONE_NUMBER_ID format.');
    }
    const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.metaAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: normalizedTo.replace(/^\+/, ''),
        type: 'text',
        text: {
          preview_url: false,
          body: cleanText,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Meta WhatsApp API failed (HTTP ${res.status}).`);
    }
    return { ok: true, provider: 'meta-cloud' };
  }

  if (cfg.provider === 'twilio') {
    const sid = cfg.twilioAccountSid ?? '';
    if (!SAFE_ID_REGEX.test(sid)) {
      throw new Error('Invalid TWILIO_ACCOUNT_SID format.');
    }
    const normalizedFrom = validatePhoneOrThrow(cfg.twilioFrom ?? '');
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${cfg.twilioAuthToken ?? ''}`).toString(
      'base64'
    );
    const form = new URLSearchParams({
      From: `whatsapp:${normalizedFrom}`,
      To: `whatsapp:${normalizedTo}`,
      Body: cleanText,
    });

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new Error(`Twilio WhatsApp API failed (HTTP ${res.status}).`);
    }
    return { ok: true, provider: 'twilio' };
  }

  throw new Error('No supported WhatsApp provider configured.');
}

function pruneOldFingerprints(now: number): void {
  for (const [key, ts] of recentFingerprints.entries()) {
    if (now - ts > DEDUPE_COOLDOWN_MS) {
      recentFingerprints.delete(key);
    }
  }
  if (sentSignalIds.size > 500) {
    sentSignalIds.clear();
  }
}

export async function sendWhatsAppSignalAlert(
  signal: AIPriceActionSignal
): Promise<{ sent: boolean; deduplicated?: boolean; provider: WhatsAppProvider }> {
  const status = getWhatsAppConfigStatus();
  if (!status.configured) {
    throw new Error(
      'WhatsApp alerts are not configured on the server. Add WHATSAPP_TO_PHONE and provider credentials in Settings > Secrets.'
    );
  }

  const now = Date.now();
  pruneOldFingerprints(now);

  if (sentSignalIds.has(signal.id)) {
    return { sent: false, deduplicated: true, provider: status.provider };
  }

  const fingerprint = `${signal.symbol}:${signal.plan.signal}:${signal.plan.entryPrice}:${signal.plan.stopLoss}`;
  const lastSentAt = recentFingerprints.get(fingerprint);
  if (lastSentAt !== undefined && now - lastSentAt < DEDUPE_COOLDOWN_MS) {
    return { sent: false, deduplicated: true, provider: status.provider };
  }

  const messageText = formatWhatsAppSignalText(signal);
  const result = await sendWhatsAppMessage(messageText);

  sentSignalIds.add(signal.id);
  recentFingerprints.set(fingerprint, now);

  return { sent: true, provider: result.provider };
}

export async function sendWhatsAppTestMessage(): Promise<{
  ok: true;
  provider: WhatsAppProvider;
}> {
  const text = [
    '*StrataDesk WhatsApp Test*',
    'Auto-Scan closed-bar 5M price-action alerts are connected and ready.',
    `Time: ${new Date().toISOString()}`,
  ].join('\n');
  return sendWhatsAppMessage(text);
}
