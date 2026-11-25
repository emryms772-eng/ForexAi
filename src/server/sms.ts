import { formatSmsSignalText } from '../analysis/mtfPrompt.ts';
import type { AIPriceActionSignal, SmsConfigStatus } from '../types/market.ts';

const PHONE_E164_REGEX = /^\+?[1-9]\d{6,14}$/;
const SAFE_ID_REGEX = /^[A-Za-z0-9_-]{5,64}$/;
const SENDER_ALPHA_REGEX = /^[A-Za-z0-9 _-]{2,11}$/;
const REQUEST_TIMEOUT_MS = 6000;
const DEDUPE_COOLDOWN_MS = 60_000;

const sentSignalIds = new Set<string>();
const recentFingerprints = new Map<string, number>();

type SmsProvider = SmsConfigStatus['provider'];

interface ResolvedSmsConfig {
  provider: SmsProvider;
  toPhone: string;
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFrom?: string;
  textbeltApiKey?: string;
  vonageApiKey?: string;
  vonageApiSecret?: string;
  vonageFrom?: string;
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

function resolveSmsConfig(overridePhone?: string): ResolvedSmsConfig {
  const toPhone = cleanPhone(
    overridePhone || process.env.SMS_TO_PHONE || process.env.WHATSAPP_TO_PHONE
  );
  const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const twilioAuthToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const twilioFrom = (
    process.env.TWILIO_SMS_FROM ?? process.env.TWILIO_FROM_NUMBER
  )?.trim();

  const textbeltApiKey = process.env.TEXTBELT_API_KEY?.trim();

  const vonageApiKey = process.env.VONAGE_API_KEY?.trim();
  const vonageApiSecret = process.env.VONAGE_API_SECRET?.trim();
  const vonageFrom = (process.env.VONAGE_SMS_FROM ?? 'StrataDesk').trim();

  if (toPhone && twilioAccountSid && twilioAuthToken && twilioFrom) {
    return {
      provider: 'twilio',
      toPhone,
      twilioAccountSid,
      twilioAuthToken,
      twilioFrom,
    };
  }

  if (toPhone && vonageApiKey && vonageApiSecret) {
    return {
      provider: 'vonage',
      toPhone,
      vonageApiKey,
      vonageApiSecret,
      vonageFrom,
    };
  }

  if (toPhone && textbeltApiKey) {
    return {
      provider: 'textbelt',
      toPhone,
      textbeltApiKey,
    };
  }

  return {
    provider: 'none',
    toPhone,
  };
}

export function getSmsConfigStatus(): SmsConfigStatus {
  const cfg = resolveSmsConfig();
  const isPhoneValid = PHONE_E164_REGEX.test(cfg.toPhone);
  const configured = cfg.provider !== 'none' && isPhoneValid;

  return {
    configured,
    provider: configured ? cfg.provider : 'none',
    recipientMasked: isPhoneValid ? maskPhone(cfg.toPhone) : null,
  };
}

function validatePhoneOrThrow(phone: string, fieldName = 'SMS_TO_PHONE'): string {
  const normalized = cleanPhone(phone);
  if (!PHONE_E164_REGEX.test(normalized)) {
    throw new Error(
      `Invalid ${fieldName} format. Use international E.164 digits (e.g. +14155552671).`
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
      throw new Error('SMS provider request timed out.');
    }
    throw new Error('Unable to reach SMS notification provider.');
  } finally {
    clearTimeout(timer);
  }
}

export async function sendSmsMessage(
  text: string,
  overridePhone?: string
): Promise<{ ok: true; provider: SmsProvider }> {
  const cleanText = String(text ?? '').trim();
  if (!cleanText || cleanText.length > 1500) {
    throw new Error('SMS message text must be between 1 and 1500 characters.');
  }

  const cfg = resolveSmsConfig(overridePhone);
  if (cfg.provider === 'none') {
    throw new Error(
      'SMS alerts are not configured on the server. Add SMS_TO_PHONE and Twilio, Textbelt, or Vonage credentials in Settings > Secrets.'
    );
  }

  const normalizedTo = validatePhoneOrThrow(cfg.toPhone);

  if (cfg.provider === 'twilio') {
    const sid = cfg.twilioAccountSid ?? '';
    if (!SAFE_ID_REGEX.test(sid)) {
      throw new Error('Invalid TWILIO_ACCOUNT_SID format.');
    }

    const rawFrom = cfg.twilioFrom ?? '';
    const isMsgService = /^MG[a-fA-F0-9]{32}$/.test(rawFrom);
    const form = new URLSearchParams({
      To: normalizedTo,
      Body: cleanText,
    });

    if (isMsgService) {
      form.set('MessagingServiceSid', rawFrom);
    } else if (PHONE_E164_REGEX.test(cleanPhone(rawFrom))) {
      form.set('From', validatePhoneOrThrow(rawFrom, 'TWILIO_SMS_FROM'));
    } else if (SENDER_ALPHA_REGEX.test(rawFrom)) {
      form.set('From', rawFrom);
    } else {
      throw new Error(
        'Invalid TWILIO_SMS_FROM format. Use an E.164 Twilio number or MG... Messaging Service SID.'
      );
    }

    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${cfg.twilioAuthToken ?? ''}`).toString(
      'base64'
    );

    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new Error(`Twilio SMS API failed (HTTP ${res.status}).`);
    }
    return { ok: true, provider: 'twilio' };
  }

  if (cfg.provider === 'vonage') {
    const fromVal = cfg.vonageFrom ?? 'StrataDesk';
    const res = await fetchWithTimeout('https://rest.nexmo.com/sms/json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: cfg.vonageApiKey,
        api_secret: cfg.vonageApiSecret,
        to: normalizedTo.replace(/^\+/, ''),
        from: fromVal,
        text: cleanText,
      }),
    });
    if (!res.ok) {
      throw new Error(`Vonage SMS API failed (HTTP ${res.status}).`);
    }
    const payload = (await res.json()) as {
      messages?: Array<{ status?: string; 'error-text'?: string }>;
    };
    const first = payload.messages?.[0];
    if (first && first.status !== '0') {
      throw new Error(
        first['error-text'] || `Vonage SMS rejected (status ${first.status}).`
      );
    }
    return { ok: true, provider: 'vonage' };
  }

  if (cfg.provider === 'textbelt') {
    const res = await fetchWithTimeout('https://textbelt.com/text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: normalizedTo,
        message: cleanText,
        key: cfg.textbeltApiKey,
      }),
    });
    if (!res.ok) {
      throw new Error(`Textbelt SMS API failed (HTTP ${res.status}).`);
    }
    const payload = (await res.json()) as { success?: boolean; error?: string };
    if (!payload.success) {
      throw new Error(payload.error || 'Textbelt SMS delivery failed.');
    }
    return { ok: true, provider: 'textbelt' };
  }

  throw new Error('No supported SMS provider configured.');
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

export async function sendSmsSignalAlert(
  signal: AIPriceActionSignal
): Promise<{ sent: boolean; deduplicated?: boolean; provider: SmsProvider }> {
  const status = getSmsConfigStatus();
  if (!status.configured) {
    throw new Error(
      'SMS alerts are not configured on the server. Add SMS_TO_PHONE and Twilio, Textbelt, or Vonage credentials in Settings > Secrets.'
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

  const messageText = formatSmsSignalText(signal);
  const result = await sendSmsMessage(messageText);

  sentSignalIds.add(signal.id);
  recentFingerprints.set(fingerprint, now);

  return { sent: true, provider: result.provider };
}

export async function sendSmsTestMessage(): Promise<{
  ok: true;
  provider: SmsProvider;
}> {
  const text = [
    'StrataDesk SMS Test',
    'Auto-Scan closed-bar 5M price-action alerts are connected and ready.',
    `Time: ${new Date().toISOString()}`,
  ].join('\n');
  return sendSmsMessage(text);
}
