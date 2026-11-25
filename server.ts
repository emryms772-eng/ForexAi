import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { runNonRepaintingBacktest } from './src/analysis/backtester.ts';
import { analyzePriceAction } from './src/analysis/priceAction.ts';
import { TIMEFRAMES, getInstrumentBySymbol } from './src/config/instruments.ts';
import {
  generateBacktestReview,
  generatePriceActionSignal,
} from './src/server/aiAnalysis.ts';
import {
  advanceMarketTick,
  getMarketCandles,
  getWatchlistQuotes,
} from './src/server/marketData.ts';
import {
  getWhatsAppConfigStatus,
  sendWhatsAppSignalAlert,
  sendWhatsAppTestMessage,
} from './src/server/whatsapp.ts';
import type {
  AIBacktestReview,
  AIPriceActionSignal,
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
          const pa = analyzePriceAction(data.candles, q.decimals);
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
      const priceAction = analyzePriceAction(data.candles, data.decimals);
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
          const candles =
            tf === activeTimeframe && clientCandles.length >= 180
              ? clientCandles
              : (await getMarketCandles(instrument.symbol, tf, targetLimit))
                  .candles;
          return {
            timeframe: tf,
            candles,
            analysis: analyzePriceAction(candles, instrument.decimals),
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

  app.get('/api/notifications/whatsapp', (_req, res) => {
    res.json(getWhatsAppConfigStatus());
  });

  app.get('/api/notifications/whatsapp/status', (_req, res) => {
    res.json(getWhatsAppConfigStatus());
  });

  app.post('/api/notifications/whatsapp/test', async (_req, res) => {
    try {
      const result = await sendWhatsAppTestMessage();
      res.json({ ok: true, sent: true, provider: result.provider });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to send test WhatsApp alert.';
      const status = message.includes('not configured') ? 400 : 500;
      res.status(status).json({ error: message });
    }
  });

  app.post('/api/notifications/whatsapp', async (req, res) => {
    try {
      const body = (req.body ?? {}) as {
        action?: unknown;
        signal?: unknown;
      };

      if (body.action === 'test') {
        const result = await sendWhatsAppTestMessage();
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
        res.status(400).json({ error: 'Invalid signal payload for WhatsApp alert.' });
        return;
      }

      const result = await sendWhatsAppSignalAlert(sig as AIPriceActionSignal);
      res.json({ ok: true, ...result });
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to send WhatsApp notification.';
      const status = message.includes('not configured') ? 400 : 500;
      res.status(status).json({ error: message });
    }
  });

  const distPath = path.resolve(__dirname, 'dist');
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
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
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
