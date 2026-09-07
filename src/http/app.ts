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
import { medRedovisningssession } from './vy/session.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Servern binds till 127.0.0.1 (server.ts) och står inte bakom någon proxy i
  // Etapp 1 — req.ip är alltså klientens riktiga adress.
  app.set('trust proxy', false);
  // K-1: CSP:n var helmets default, alltsa `script-src 'self'` — trots att
  // vylagret pastod `script-src 'none'` i sina kommentarer. Pastaendet var en
  // proxy for en installning som inte fanns. Nu ar den satt, och den ar den
  // yttre spärren under HTML-escapingen: brister esc() nagonstans kan en
  // inskjuten <script> anda inte kora.
  //
  // referrerPolicy: helmets default 'no-referrer' far webblasaren att skicka
  // `Origin: null` pa formular-POST — da nekar CSRF-kontrollen VARA EGNA
  // formular. 'strict-origin-when-cross-origin' skickar en riktig Origin for
  // samma ursprung och aldrig mer an ursprunget till frammande vardar. Samma
  // slutsats som /opt/redovisning drog i drift. Utgaende lankar bar dessutom
  // redan rel="noreferrer" (src/http/vy/markdown.ts).
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'none'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
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

  // Etapp 2a KRAV-8: läsvyn monteras FÖRE nyckelkravet — LÄSNING kräver ingen
  // API-nyckel. Gränsen är att servern binder 127.0.0.1 (tailnet-modellen från
  // ytor_server), precis som för /health. /api är oförändrat skyddat med bearer
  // nedan.
  //
  // K-1 (beslut #64): vyn är inte längre ren läsyta. SKRIVNING från vyn kräver
  // en session, och en session kan bara födas ur en giltig API-nyckel
  // (src/http/vy/session.ts) — aktören härleds alltså ur en nyckel även i
  // webbläsaren, precis som på /api. Nyckelkravet på GET är oförändrat borta.
  // Davids EGEN inloggning, gjord i redovisningen, galler har ocksa.
  // Mellanlagret slar upp den EN gang per foragan och lagger svaret pa
  // req, sa att den synkrona sessionsAktor() slipper vanta pa ett
  // natverksanrop tjugo ganger per renderad sida.
  //
  // Bara framfor /vy. /api ar orort: agenterna bar nyckel, aldrig kaka.
  app.use('/vy', medRedovisningssession);
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
