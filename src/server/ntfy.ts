import fs from 'fs';
import os from 'os';
import path from 'path';
import { formatSmsSignalText } from '../analysis/mtfPrompt.ts';
import { getInstrumentBySymbol } from '../config/instruments.ts';
import type {
  AIPriceActionSignal,
  MarketScanResponse,
  NtfyConfigStatus,
} from '../types/market.ts';

const TOPIC_REGEX = /^[A-Za-z0-9_-]{4,80}$/;
const REQUEST_TIMEOUT_MS = 6000;
const DEDUPE_COOLDOWN_MS = 60_000;
const SUBSCRIPTIONS_FILE = path.join(os.tmpdir(), 'stratadesk-ntfy-topics.json');
const MAX_SUBSCRIPTION_AGE_MS = 14 * 24 * 60 * 60 * 1000;

interface StoredSubscription {
  topic: string;
  enabled: boolean;
  notifyWait: boolean;
  updatedAt: number;
}

const subscriptions = new Map<string, StoredSubscription>();
let subscriptionsLoaded = false;

function loadSubscriptionsOnce(): void {
  if (subscriptionsLoaded) return;
  subscriptionsLoaded = true;
  try {
    if (!fs.existsSync(SUBSCRIPTIONS_FILE)) return;
    const raw = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StoredSubscription[];
    if (!Array.isArray(parsed)) return;
    const now = Date.now();
    for (const item of parsed) {
      if (
        item &&
        typeof item.topic === 'string' &&
        TOPIC_REGEX.test(item.topic) &&
        typeof item.updatedAt === 'number' &&
        now - item.updatedAt < MAX_SUBSCRIPTION_AGE_MS
      ) {
        subscriptions.set(item.topic, {
          topic: item.topic,
          enabled: Boolean(item.enabled),
          notifyWait: item.notifyWait !== false,
          updatedAt: item.updatedAt,
        });
      }
    }
  } catch {
    // Non-fatal if temp file unreadable
  }
}

function saveSubscriptions(): void {
  try {
    const list = Array.from(subscriptions.values());
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(list), 'utf8');
  } catch {
    // Non-fatal if temp file unwritable
  }
}

const sentNtfySignalIds = new Set<string>();
const recentNtfyFingerprints = new Map<string, number>();

function getConfiguredServerUrl(): string {
  const raw = process.env.NTFY_SERVER_URL?.trim();
  if (!raw) return 'https://ntfy.sh';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch {
    // Fall back to official ntfy.sh on invalid env URL
  }
  return 'https://ntfy.sh';
}

function cleanTopic(raw: unknown): string {
  return String(raw ?? '').trim();
}

function maskTopic(topic: string): string {
  if (topic.length <= 8) return topic;
  return `${topic.slice(0, 4)}***${topic.slice(-4)}`;
}

export function resolveNtfyTopic(overrideTopic?: unknown): string {
  const override = cleanTopic(overrideTopic);
  if (override) return override;
  return cleanTopic(process.env.NTFY_TOPIC);
}

export function validateNtfyTopic(topic: string): string {
  const cleaned = cleanTopic(topic);
  if (!TOPIC_REGEX.test(cleaned)) {
    throw new Error(
      'Invalid ntfy topic name. Use 4-80 letters, numbers, dashes, or underscores (no spaces).'
    );
  }
  return cleaned;
}

export function registerNtfySubscription(params: {
  topic: unknown;
  enabled: boolean;
  notifyWait?: boolean;
}): {
  ok: true;
  topic: string | null;
  enabled: boolean;
  notifyWait: boolean;
  activeCount: number;
} {
  loadSubscriptionsOnce();
  const cleaned = cleanTopic(params.topic);
  const notifyWait = params.notifyWait !== false;
  if (!cleaned) {
    return {
      ok: true,
      topic: null,
      enabled: false,
      notifyWait,
      activeCount: getActiveNtfyTopics().length,
    };
  }

  const valid = validateNtfyTopic(cleaned);
  if (params.enabled) {
    subscriptions.set(valid, {
      topic: valid,
      enabled: true,
      notifyWait,
      updatedAt: Date.now(),
    });
  } else {
    subscriptions.delete(valid);
  }
  saveSubscriptions();

  return {
    ok: true,
    topic: valid,
    enabled: params.enabled,
    notifyWait,
    activeCount: getActiveNtfyTopics().length,
  };
}

export function getActiveNtfySubscriptions(): Array<{
  topic: string;
  notifyWait: boolean;
}> {
  loadSubscriptionsOnce();
  const map = new Map<string, boolean>();
  const envTopic = cleanTopic(process.env.NTFY_TOPIC);
  if (TOPIC_REGEX.test(envTopic)) {
    map.set(envTopic, true);
  }
  const now = Date.now();
  for (const [topic, entry] of subscriptions.entries()) {
    if (entry.enabled && now - entry.updatedAt < MAX_SUBSCRIPTION_AGE_MS) {
      map.set(topic, entry.notifyWait !== false);
    }
  }
  return Array.from(map.entries()).map(([topic, notifyWait]) => ({
    topic,
    notifyWait,
  }));
}

export function getActiveNtfyTopics(): string[] {
  return getActiveNtfySubscriptions().map((s) => s.topic);
}

export function getNtfyConfigStatus(): NtfyConfigStatus {
  const envTopic = cleanTopic(process.env.NTFY_TOPIC);
  const configured = TOPIC_REGEX.test(envTopic);
  return {
    configured,
    serverUrl: getConfiguredServerUrl(),
    topicMasked: configured ? maskTopic(envTopic) : null,
  };
}

function pruneNtfyCache(now: number): void {
  for (const [key, ts] of recentNtfyFingerprints.entries()) {
    if (now - ts > DEDUPE_COOLDOWN_MS) {
      recentNtfyFingerprints.delete(key);
    }
  }
  if (sentNtfySignalIds.size > 500) {
    sentNtfySignalIds.clear();
  }
}

export async function publishNtfyNotification(params: {
  topic?: unknown;
  title: string;
  message: string;
  priority?: 'urgent' | 'high' | 'default' | 'low';
  tags?: string[];
}): Promise<{ ok: true; topic: string; serverUrl: string }> {
  const rawTopic = resolveNtfyTopic(params.topic);
  if (!rawTopic) {
    throw new Error(
      'No ntfy topic set. Enter or generate a topic name in StrataDesk, or set NTFY_TOPIC in Secrets.'
    );
  }

  const validTopic = validateNtfyTopic(rawTopic);
  const serverUrl = getConfiguredServerUrl();
  const endpoint = `${serverUrl}/${encodeURIComponent(validTopic)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: params.title.slice(0, 120),
        Priority: params.priority ?? 'high',
        ...(params.tags && params.tags.length > 0
          ? { Tags: params.tags.join(',') }
          : {}),
      },
      body: params.message.slice(0, 3500),
    });

    if (!res.ok) {
      throw new Error(`ntfy delivery failed (HTTP ${res.status}).`);
    }

    return { ok: true, topic: validTopic, serverUrl };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('ntfy request timed out.');
    }
    throw err instanceof Error
      ? err
      : new Error('Unable to reach ntfy notification server.');
  } finally {
    clearTimeout(timer);
  }
}

export async function sendNtfySignalAlert(
  signal: AIPriceActionSignal,
  overrideTopic?: unknown
): Promise<{ sent: boolean; deduplicated?: boolean; topic: string }> {
  const rawTopic = resolveNtfyTopic(overrideTopic);
  if (!rawTopic) {
    throw new Error(
      'No ntfy topic set. Enter or generate a topic name in StrataDesk first.'
    );
  }
  const validTopic = validateNtfyTopic(rawTopic);

  const now = Date.now();
  pruneNtfyCache(now);

  const dedupeId = `${validTopic}:${signal.id}`;
  if (sentNtfySignalIds.has(dedupeId)) {
    return { sent: false, deduplicated: true, topic: validTopic };
  }

  const fingerprint = `${validTopic}:${signal.symbol}:${signal.plan.signal}:${signal.plan.entryPrice}:${signal.plan.stopLoss}`;
  const lastSentAt = recentNtfyFingerprints.get(fingerprint);
  if (lastSentAt !== undefined && now - lastSentAt < DEDUPE_COOLDOWN_MS) {
    return { sent: false, deduplicated: true, topic: validTopic };
  }

  const isBuy = signal.plan.signal === 'BUY';
  const isSell = signal.plan.signal === 'SELL';
  const title = isBuy || isSell
    ? `${signal.plan.signal} SNIPER: ${signal.symbol} (${signal.plan.riskRewardRatio})`
    : `WATCH ${signal.symbol} (5M Closed Bar)`;

  const tags = isBuy
    ? ['chart_with_upwards_trend', 'dart']
    : isSell
    ? ['chart_with_downwards_trend', 'dart']
    : ['hourglass_flowing_sand'];

  const message = formatSmsSignalText(signal);

  await publishNtfyNotification({
    topic: validTopic,
    title,
    message,
    priority: isBuy || isSell ? 'high' : 'default',
    tags,
  });

  sentNtfySignalIds.add(dedupeId);
  recentNtfyFingerprints.set(fingerprint, now);

  return { sent: true, topic: validTopic };
}

export async function sendNtfyMarketScanDigest(
  scan: MarketScanResponse,
  overrideTopic?: unknown
): Promise<{ sent: boolean; deduplicated?: boolean; topic: string }> {
  const rawTopic = resolveNtfyTopic(overrideTopic);
  if (!rawTopic) {
    throw new Error(
      'No ntfy topic set. Enter or generate a topic name in StrataDesk first.'
    );
  }
  const validTopic = validateNtfyTopic(rawTopic);

  const now = Date.now();
  pruneNtfyCache(now);

  const barKey = scan.confirmedBarTime || Math.floor(now / 300_000) * 300;
  const dedupeId = `${validTopic}:digest:${barKey}`;
  if (sentNtfySignalIds.has(dedupeId)) {
    return { sent: false, deduplicated: true, topic: validTopic };
  }

  const barUtc =
    barKey > 0 ? new Date(barKey * 1000).toISOString().slice(11, 16) + ' UTC' : '5M Close';
  const topWatches = (scan.watchSignals ?? []).slice(0, 3);

  const watchLines = topWatches.map((w) => {
    const d = getInstrumentBySymbol(w.symbol).decimals;
    const entry = w.plan.entryPrice > 0 ? w.plan.entryPrice.toFixed(d) : w.spotPriceAtSignal.toFixed(d);
    const sl = w.plan.stopLoss > 0 ? w.plan.stopLoss.toFixed(d) : '—';
    const tp1 = w.plan.takeProfit1 > 0 ? w.plan.takeProfit1.toFixed(d) : '—';
    return `• ${w.symbol} (${w.bias}) | Watch @ ${entry} | SL ${sl} | TP1 ${tp1}`;
  });

  const message = [
    `Closed ${barUtc} bar scanned across ${scan.totalScanned} markets.`,
    scan.sniperSignals.length === 0
      ? '0 A+ Sniper Entries right now — Stay Flat.'
      : `${scan.sniperSignals.length} A+ Sniper Entries active.`,
    ...(watchLines.length > 0 ? ['', 'Closest Watch Zones:', ...watchLines] : []),
  ].join('\n');

  await publishNtfyNotification({
    topic: validTopic,
    title: `5M Scan (${barUtc}): Stay Flat · Closest Watch`,
    message,
    priority: 'default',
    tags: ['mag', 'hourglass_flowing_sand'],
  });

  sentNtfySignalIds.add(dedupeId);
  return { sent: true, topic: validTopic };
}

export async function sendNtfyTestMessage(overrideTopic?: unknown): Promise<{
  ok: true;
  topic: string;
  serverUrl: string;
}> {
  const message = [
    'StrataDesk Sniper Alerts Connected ($0 Free Forever)',
    'You will receive instant push notifications here whenever a closed 5M A+ sniper BUY/SELL triggers.',
    `Time: ${new Date().toISOString()}`,
  ].join('\n');

  return publishNtfyNotification({
    topic: overrideTopic,
    title: 'StrataDesk ntfy Alert Test',
    message,
    priority: 'high',
    tags: ['white_check_mark', 'dart'],
  });
}
