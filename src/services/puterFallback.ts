import {
  BACKTEST_JSON_SCHEMA_HINT,
  type RawBacktestReviewJSON,
  type RawSignalJSON,
  SIGNAL_JSON_SCHEMA_HINT,
  type TimeframePriceActionInput,
  buildBacktestReviewPrompt,
  buildMtfSignalPrompt,
  normalizeBacktestReviewResult,
  normalizeSignalResult,
  parseJsonFromModelText,
} from '../analysis/mtfPrompt';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  BacktestResult,
  Timeframe,
} from '../types/market';

interface PuterAIMessageContentBlock {
  text?: string;
}

interface PuterAIChatResponse {
  text?: string;
  message?: {
    content?: string | PuterAIMessageContentBlock[];
  };
}

interface PuterGlobal {
  ai?: {
    chat: (
      prompt:
        | string
        | Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
      options?: { model?: string }
    ) => Promise<PuterAIChatResponse | string>;
  };
}

declare global {
  interface Window {
    puter?: PuterGlobal;
  }
}

const PUTER_SDK_URL = 'https://js.puter.com/v2/';
const PUTER_FALLBACK_MODELS: Array<string | undefined> = [
  'gpt-4.1-mini',
  'gpt-4o-mini',
  'gemini-2.5-flash',
  'claude-3-5-sonnet',
  undefined,
];

let puterLoadPromise: Promise<PuterGlobal> | null = null;

function ensurePuterLoaded(): Promise<PuterGlobal> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Puter.js can only run in the browser.'));
  }

  if (window.puter?.ai?.chat) {
    return Promise.resolve(window.puter);
  }

  if (puterLoadPromise) {
    return puterLoadPromise;
  }

  puterLoadPromise = new Promise<PuterGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PUTER_SDK_URL}"]`
    );

    const onReady = () => {
      if (window.puter?.ai?.chat) {
        resolve(window.puter);
      } else {
        puterLoadPromise = null;
        reject(new Error('Puter.js loaded, but puter.ai.chat is unavailable.'));
      }
    };

    const onFail = () => {
      puterLoadPromise = null;
      reject(
        new Error(
          'Unable to load Puter.js SDK (https://js.puter.com/v2/). Check network or ad-blocker settings.'
        )
      );
    };

    if (existing) {
      if (window.puter?.ai?.chat) {
        resolve(window.puter);
        return;
      }
      existing.addEventListener('load', onReady, { once: true });
      existing.addEventListener('error', onFail, { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = PUTER_SDK_URL;
    script.async = true;
    const timeoutId = window.setTimeout(() => {
      puterLoadPromise = null;
      reject(new Error('Timed out loading Puter.js fallback SDK.'));
    }, 10_000);

    script.onload = () => {
      window.clearTimeout(timeoutId);
      onReady();
    };
    script.onerror = () => {
      window.clearTimeout(timeoutId);
      onFail();
    };
    document.head.appendChild(script);
  });

  return puterLoadPromise;
}

function extractPuterResponseText(raw: PuterAIChatResponse | string): string {
  if (typeof raw === 'string') return raw.trim();
  const content = raw?.message?.content;
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((block) => (typeof block?.text === 'string' ? block.text : ''))
      .join('\n')
      .trim();
  }
  if (typeof raw?.text === 'string') return raw.text.trim();
  return '';
}

async function runPuterChatJson<T>(
  systemContent: string,
  userContent: string
): Promise<{ data: T; model: string }> {
  const puter = await ensurePuterLoaded();
  if (!puter.ai?.chat) {
    throw new Error('Puter AI client is unavailable.');
  }

  let lastError: unknown = null;

  for (const model of PUTER_FALLBACK_MODELS) {
    try {
      const response = await puter.ai.chat(
        [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
        model ? { model } : undefined
      );

      const text = extractPuterResponseText(response);
      if (!text) {
        lastError = new Error(
          `Puter model ${model ?? 'default'} returned an empty response.`
        );
        continue;
      }

      const parsed = parseJsonFromModelText<T>(text);
      return {
        data: parsed,
        model: `puter/${model ?? 'default'}`,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Puter.js browser AI request failed.');
}

export async function generateSignalViaPuter(params: {
  symbol: string;
  activeTimeframe: Timeframe;
  timeframesData: TimeframePriceActionInput[];
}): Promise<AIPriceActionSignal> {
  const { currentPrice, systemInstruction, userPrompt } =
    buildMtfSignalPrompt(params);

  const { data, model } = await runPuterChatJson<RawSignalJSON>(
    `${systemInstruction}\n\n${SIGNAL_JSON_SCHEMA_HINT}`,
    userPrompt
  );

  return normalizeSignalResult({
    parsed: data,
    symbol: params.symbol,
    activeTimeframe: params.activeTimeframe,
    currentPrice,
    model,
  });
}

export async function generateBacktestReviewViaPuter(
  backtest: BacktestResult
): Promise<AIBacktestReview> {
  const { payloadJson, systemInstruction } = buildBacktestReviewPrompt(backtest);

  const { data, model } = await runPuterChatJson<RawBacktestReviewJSON>(
    `${systemInstruction}\n\n${BACKTEST_JSON_SCHEMA_HINT}`,
    `Audit this causal pure price-action backtest:\n${payloadJson}`
  );

  return normalizeBacktestReviewResult({
    parsed: data,
    backtest,
    model,
  });
}
