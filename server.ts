import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runNonRepaintingBacktest } from './src/analysis/backtester.ts';
import { analyzePriceAction, getCandleProgress } from './src/analysis/priceAction.ts';
import { TIMEFRAMES, getInstrumentBySymbol } from './src/config/instruments.ts';
import {
  generateBacktestReview,
  generatePriceActionSignal,
  scanMarketSniperSetups,
} from './src/server/aiAnalysis.ts';
import {
  advanceMarketTick,
  getMarketCandles,
  getWatchlistQuotes,
} from './src/server/marketData.ts';
import {
  getActiveNtfySubscriptions,
  getNtfyConfigStatus,
  registerNtfySubscription,
  sendNtfyMarketScanDigest,
  sendNtfySignalAlert,
  sendNtfyTestMessage,
} from './src/server/ntfy.ts';
import {
  getSmsConfigStatus,
  sendSmsSignalAlert,
  sendSmsTestMessage,
} from './src/server/sms.ts';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
  MarketScanResponse,
  OHLCVCandle,
  Timeframe,
} from './src/types/market.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseTimeframe(raw: unknown): Timeframe {
  if (typeof raw === 'string' && TIMEFRAMES.includes(raw as Timeframe)) {
    return raw as Timeframe;
  }
  return '5M';
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  app.get('/api/market/watchlist', async (_req, res) => {
    try {
      const quotes = await getWatchlistQuotes();
      // Enrich watchlist items with lightweight pure price-action structure status
      const enriched = await Promise.all(
        quotes.map(async (q) => {
          const data = await getMarketCandles(q.symbol, '5M', 120);
          const pa = analyzePriceAction(data.candles, q.decimals, {
            timeframe: '5M',
          });
          return {
            ...q,
            structureHint: pa.snapshot.latestStructureEvent,
            recentPattern: pa.snapshot.latestPattern?.name ?? pa.snapshot.rangeZone,
          };
        })
      );
      res.json({ quotes: enriched });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch watchlist quotes.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/market/candles', async (req, res) => {
    try {
      const symbol =
        typeof req.query.symbol === 'string' ? req.query.symbol : 'XAU/USD';
      const timeframe = parseTimeframe(req.query.timeframe);
      const limit = Math.min(Math.max(Number(req.query.limit) || 180, 40), 300);

      const data = await getMarketCandles(symbol, timeframe, limit);
      const priceAction = analyzePriceAction(data.candles, data.decimals, {
        timeframe,
      });
      res.json({ ...data, priceAction });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to load market candles.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/market/tick', async (req, res) => {
    try {
      const symbol =
        typeof req.query.symbol === 'string' ? req.query.symbol : 'XAU/USD';
      const timeframe = parseTimeframe(req.query.timeframe);
      const parseNum = (val: unknown) =>
        typeof val === 'string' && val !== '' && Number.isFinite(Number(val))
          ? Number(val)
          : undefined;

      const tick = await advanceMarketTick(symbol, timeframe, {
        lastClose: parseNum(req.query.lastClose),
        lastTime: parseNum(req.query.lastTime),
        lastOpen: parseNum(req.query.lastOpen),
        lastHigh: parseNum(req.query.lastHigh),
        lastLow: parseNum(req.query.lastLow),
        lastVolume: parseNum(req.query.lastVolume),
        anchorOpen: parseNum(req.query.anchorOpen),
      });
      res.json(tick);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Tick update failed.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/market/stream', async (req, res) => {
    const symbol =
      typeof req.query.symbol === 'string' ? req.query.symbol : 'XAU/USD';
    const timeframe = parseTimeframe(req.query.timeframe);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let closed = false;

    const pushTick = async () => {
      if (closed) return;
      try {
        const tick = await advanceMarketTick(symbol, timeframe);
        if (!closed) {
          res.write(`data: ${JSON.stringify(tick)}\n\n`);
        }
      } catch (error) {
        if (!closed) {
          const message =
            error instanceof Error ? error.message : 'Stream tick failed.';
          res.write(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`);
        }
      }
    };

    await pushTick();
    const timer = setInterval(pushTick, 1200);

    req.on('close', () => {
      closed = true;
      clearInterval(timer);
    });
  });

  app.post('/api/analysis/signal', async (req, res) => {
    try {
      const symbol =
        typeof req.body?.symbol === 'string' ? req.body.symbol : 'XAU/USD';
      const activeTimeframe = parseTimeframe(req.body?.timeframe);
      const instrument = getInstrumentBySymbol(symbol);

      const clientCandles: OHLCVCandle[] = Array.isArray(req.body?.candles)
        ? req.body.candles
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

      res.json({ priceAction: activeEntry.analysis, signal });
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
  });

  app.all('/api/analysis/scan-market', async (req, res) => {
    if (req.method !== 'POST' && req.method !== 'GET') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const scan = await scanMarketSniperSetups();
      res.json(scan);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to complete market sniper scan.';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/analysis/backtest', async (req, res) => {
    try {
      const symbol =
        typeof req.body?.symbol === 'string' ? req.body.symbol : 'XAU/USD';
      const timeframe = parseTimeframe(req.body?.timeframe);
      const instrument = getInstrumentBySymbol(symbol);
      const riskRaw = Number(req.body?.riskPercentPerTrade);
      const riskPercentPerTrade =
        Number.isFinite(riskRaw) && riskRaw >= 0.25 && riskRaw <= 5
          ? riskRaw
          : 1;
      const includeAiReview = Boolean(req.body?.includeAiReview);

      const clientCandles: OHLCVCandle[] = Array.isArray(req.body?.candles)
        ? (req.body.candles as OHLCVCandle[])
        : [];

      const [ltfData, h1Data, h4Data] = await Promise.all([
        clientCandles.length >= 260
          ? Promise.resolve(null)
          : getMarketCandles(instrument.symbol, timeframe, 420),
        getMarketCandles(instrument.symbol, '1H', 220),
        getMarketCandles(instrument.symbol, '4H', 160),
      ]);

      const candles =
        clientCandles.length >= 260 ? clientCandles : ltfData!.candles;
      const htfAligned =
        h1Data.source === 'live-api' &&
        h4Data.source === 'live-api' &&
        (ltfData ? ltfData.source === 'live-api' : true);

      const backtest = runNonRepaintingBacktest({
        symbol: instrument.symbol,
        timeframe,
        candles,
        htf1hCandles: h1Data.candles,
        htf4hCandles: h4Data.candles,
        htfAligned,
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

      res.json({ backtest, aiReview, aiError });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to execute causal price-action backtest.';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/notifications/sms', (_req, res) => {
    res.json(getSmsConfigStatus());
  });

  app.get('/api/notifications/sms/status', (_req, res) => {
    res.json(getSmsConfigStatus());
  });

  app.post('/api/notifications/sms/test', async (_req, res) => {
    try {
      const result = await sendSmsTestMessage();
      res.json({ ok: true, sent: true, provider: result.provider });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to send test SMS alert.';
      const status = message.includes('not configured') ? 400 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/notifications/sms', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        action?: unknown;
        signal?: unknown;
      };

      if (body.action === 'test') {
        const result = await sendSmsTestMessage();
        res.json({ ok: true, sent: true, provider: result.provider });
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
        res.status(400).json({ error: 'Invalid signal payload for SMS alert.' });
        return;
      }

      const result = await sendSmsSignalAlert(sig as AIPriceActionSignal);
      res.json({ ok: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to send SMS notification.';
      const status = message.includes('not configured') ? 400 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.get('/api/notifications/ntfy', (_req, res) => {
    res.json(getNtfyConfigStatus());
  });

  app.post('/api/notifications/ntfy/test', async (req, res) => {
    try {
      const topic = (req.body as { topic?: unknown } | undefined)?.topic;
      const result = await sendNtfyTestMessage(topic);
      res.json({ sent: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to send test ntfy notification.';
      const status =
        message.includes('Invalid ntfy') || message.includes('No ntfy')
          ? 400
          : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/notifications/ntfy/subscribe', (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        topic?: unknown;
        enabled?: unknown;
        notifyWait?: unknown;
      };
      const result = registerNtfySubscription({
        topic: body.topic,
        enabled: body.enabled !== false,
        notifyWait: body.notifyWait !== false,
      });
      res.json(result);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to update ntfy subscription.';
      res.status(400).json({ error: message });
    }
  });

  app.post('/api/notifications/ntfy', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        action?: unknown;
        topic?: unknown;
        signal?: unknown;
        scan?: unknown;
        notifyWait?: unknown;
      };

      if (body.action === 'test') {
        const result = await sendNtfyTestMessage(body.topic);
        res.json({ sent: true, ...result });
        return;
      }

      if (body.action === 'subscribe') {
        const result = registerNtfySubscription({
          topic: body.topic,
          enabled: true,
          notifyWait: body.notifyWait !== false,
        });
        res.json(result);
        return;
      }

      if (body.action === 'digest') {
        const scan = body.scan as Partial<MarketScanResponse> | undefined;
        if (!scan || typeof scan !== 'object' || !Array.isArray(scan.watchSignals)) {
          res.status(400).json({ error: 'Invalid scan payload for ntfy digest.' });
          return;
        }
        const result = await sendNtfyMarketScanDigest(
          scan as MarketScanResponse,
          body.topic
        );
        res.json({ ok: true, ...result });
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
      res.json({ ok: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to send ntfy notification.';
      const status =
        message.includes('Invalid ntfy') || message.includes('No ntfy')
          ? 400
          : 500;
      res.status(status).json({ error: message });
    }
  });

  const distPath = path.resolve(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const disableHmr = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      plugins: disableHmr
        ? [
            {
              name: 'disable-vite-client-hmr-ws',
              transform(code, id) {
                if (
                  id.includes('vite/dist/client/client.mjs') ||
                  id.includes('@vite/client')
                ) {
                  return code
                    .replace(
                      'ws.send(JSON.stringify(data));',
                      'if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));'
                    )
                    .replace(
                      'transport.connect(createHMRHandler(handleMessage));',
                      '/* WebSocket HMR disabled via DISABLE_HMR=true */'
                    );
                }
                return null;
              },
            },
          ]
        : [],
      server: {
        middlewareMode: true,
        hmr: !disableHmr,
        ws: disableHmr ? false : undefined,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else if (fs.existsSync(distPath)) {
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`StrataDesk server listening on http://0.0.0.0:${port}`);

    // Background 5M closed-bar sniper watcher so ntfy alerts fire reliably even when browser tabs sleep
    let lastAutoPushBarBucket = 0;
    let backgroundScanBusy = false;

    const runServerAutoPushTick = async () => {
      if (backgroundScanBusy) return;
      const subs = getActiveNtfySubscriptions();
      if (subs.length === 0) return;

      const nowSec = Math.floor(Date.now() / 1000);
      const { bucketStartSec } = getCandleProgress('5M', nowSec);
      const elapsedInBar = nowSec - bucketStartSec;
      // Wait 6s after each 5M close so broker feeds publish the finalized bar
      if (elapsedInBar < 6 || bucketStartSec <= lastAutoPushBarBucket) {
        return;
      }

      backgroundScanBusy = true;
      lastAutoPushBarBucket = bucketStartSec;
      try {
        const scan = await scanMarketSniperSetups();
        for (const sub of subs) {
          if (scan.sniperSignals.length > 0) {
            for (const sig of scan.sniperSignals) {
              try {
                await sendNtfySignalAlert(sig, sub.topic);
              } catch {
                // Non-blocking ntfy push error
              }
            }
          } else if (sub.notifyWait) {
            try {
              await sendNtfyMarketScanDigest(scan, sub.topic);
            } catch {
              // Non-blocking ntfy digest error
            }
          }
        }
      } catch {
        // Retry cleanly on next interval if transient feed error occurred
        lastAutoPushBarBucket = 0;
      } finally {
        backgroundScanBusy = false;
      }
    };

    setInterval(() => {
      void runServerAutoPushTick();
    }, 10_000);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
