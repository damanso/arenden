import express from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import { AppError } from '../lib/errors.js';
import { autentisera } from './middleware/autentisera.js';
import { errorHandler } from './middleware/errorHandler.js';
import { actionsRouter } from './routes/actions.js';
import { vyRouter } from './routes/vy.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Servern binds till 127.0.0.1 (server.ts) och står inte bakom någon proxy i
  // Etapp 1 — req.ip är alltså klientens riktiga adress.
  app.set('trust proxy', false);
  app.use(helmet());
  app.use(express.json({ limit: '1mb' }));

  // KRAV-13: /health kräver ingen nyckel (den ska kunna pollas av drift).
  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch {
      res.status(503).json({ status: 'db_unavailable' });
    }
  });

  // Etapp 2a KRAV-8: läsvyn monteras FÖRE nyckelkravet — den kräver ingen
  // API-nyckel. Gränsen är att servern binder 127.0.0.1 (tailnet-modellen från
  // ytor_server), precis som för /health. Vyn är ren läsyta: bara GET-rutter,
  // inga mutationer. /api är oförändrat skyddat med bearer nedan.
  app.use('/vy', vyRouter);

  app.use(
    '/api',
    rateLimit({
      windowMs: 60_000,
      limit: config.RATE_LIMIT_PER_MINUTE,
      standardHeaders: true,
      legacyHeaders: false,
      // Beslut #24 KRAV-2: standardhandlern svarar med bibliotekets egen
      // textkropp, som klienten inte kan tolka (den blev `okant_fel`). Vi
      // lämnar i stället över till errorHandler — då är felkuvertet exakt
      // detsamma som för alla andra fel: {"error":"rate_limited"}.
      // RateLimit-*/Retry-After är redan satta när handlern kallas.
      handler: (_req, _res, next) => next(new AppError(429, 'rate_limited')),
    }),
    autentisera,
    actionsRouter,
  );

  app.use((_req, res) => {
    res.status(404).json({ error: 'not_found' });
  });
  app.use(errorHandler);

  return app;
}
