// FR-24 (d), B-19, Story 4.2 och 4.3: MCP-gatewayen, en egen process som är klient till ärendenas
// actions-API.
//
// FEM invarianter, som granskaren kan läsa av rakt här:
//  1. Bara /mcp och OAuth-delens vägar: metadata, /authorize och /token (oauth.ts). Allt annat svarar 404,
//     och /mcp tar bara POST (405 annars) (B-19 punkt 1).
//  2. Konfigurationen är konstanter (GATEWAYKONFIG, OAUTHKONFIG), och koden läser ingen miljövariabel.
//     Värden, portarna och API-adressen flyttas aldrig av miljön. Klientfilens sökväg byggs däremot av
//     os.homedir(), som Node på POSIX tar ur miljövariabeln HOME, så HOME avgör vilken klientfil som läses
//     (OAUTHKONFIG i oauth.ts). Klientfilen är den enda fil gatewayen läser; den laddar inte appens
//     konfiguration och har ingen databasanslutning (Story 4.2 AK 2 och AK 6, Story 4.3 AK 5).
//  3. Sessionen avgörs av OAuth-delens lager: bearer-token → nyckeln och sessionens id, annars 401 innan
//     kroppen ens tolkas, med WWW-Authenticate som pekar på skyddsresursens metadata (Story 4.3 AK 1).
//     Nyckeln förs som argument till besvara() och sparas aldrig på begäran, i en logg eller i ett svar.
//     När API:t svarar 401 för sessionens nyckel glöms sessionen ur uppslaget, och svaret är 401 (Story 4.3
//     AK 4).
//  4. Varje verktyg går till /api med sessionens nyckel (anropaApi() i verktyg.ts), så att API:ts regler
//     (gränsen, B-02, människospärrarna, aktören ur nyckeln) gäller här utan att upprepas.
//  5. Startdelen körs bara när filen är processens ingång, så att proven kan importera appen utan att
//     något lyssnar.
//
// Protokollet är MCP:s Streamable HTTP i de revisioner som börjar med initialize (2025-11-25, 2025-06-18
// och 2025-03-26). Gatewayen är tillståndslös: den skapar aldrig något Mcp-Session-Id, och varje svar är
// ett JSON-objekt, aldrig en SSE-ström.
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { OAUTHKONFIG, lasKlientfil, legitimation, skapaOAuth } from './oauth.js';
import type { OAuth } from './oauth.js';
import { VERKTYG, anropaApi, hittaVerktyg, otillatnaFalt } from './verktyg.js';

/**
 * Gatewayens hela konfiguration, som konstanter. Gatewayen ska bara binda loopback och bara skicka Davids
 * nyckel till appen på samma värd (B-19, FR-39), och portarna är fasta (docs/project-context.md rad 33).
 * Därför läses ingen av dem ur miljön, och gatewayen laddar inte appens konfiguration: den kan aldrig bära
 * en databasadress, ett valv eller en CRM-konfiguration, och ingen variabel kan flytta bindningen (FR-24
 * (d), Story 4.2 AK 2 och AK 6; correct-course 2026-10-21).
 */
export const GATEWAYKONFIG = Object.freeze({
  HOST: '127.0.0.1',
  PORT: 3003,
  API_URL: 'http://127.0.0.1:3002',
  GRANS_PER_MINUT: 120,
});

/** Det som en bearer-token gav vid uppslaget: sessionens nyckel och sessionens id. */
export interface Sessionen {
  nyckel: string;
  session: string;
}

/**
 * Sessionen: bearer-token → nyckeln och sessionens id, och glom() som tar bort sessionen med det id:t. Id:t
 * kommer ur uppslaget och sparas med begäran, så att glom() når sessionen också när token hunnit sluta
 * gälla under API-anropet. I drift är det OAuth-delens lager (skapaOAuth() i oauth.ts), där bara sha256
 * av koder och tokens lagras.
 */
export interface Nyckellager {
  nyckelFor(token: string): Sessionen | undefined;
  glom(session: string): void;
}

/** Revisionerna med initialize, nyaste först. */
const VERSIONER = ['2025-11-25', '2025-06-18', '2025-03-26'] as const;

const arVersion = (v: unknown): v is (typeof VERSIONER)[number] =>
  typeof v === 'string' && (VERSIONER as readonly string[]).includes(v);

/**
 * Kuvertet. Strikt, som varje objektschema för indata (docs/project-context.md rad 44). `params` tolkas
 * med flit inte här: varje metod läser bara sina egna fält, och MCP låter klienten lägga `_meta` i
 * `params`, som en strikt tolkning hade fällt.
 */
const BegaranSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();

/** Felet för fält utanför verktygets lista nämner högst tio namn, vart och ett kapat vid 60 tecken. */
const MAX_NAMN = 10;
const MAX_NAMNLANGD = 60;

type JsonRpcId = string | number | null;

interface Utfall {
  status: number;
  kropp?: Record<string, unknown>; // saknas: 202 utan kropp
  /** Story 4.3 AK 4: API:t avvisade sessionens nyckel; sessionen glöms, och svaret är 401. */
  sessionSlut?: true;
}

const arObjekt = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Begärans id när det är en sträng eller ett tal, annars null (JSON-RPC 2.0 för ett ogiltigt kuvert). */
function idUr(meddelande: unknown): JsonRpcId {
  const id = arObjekt(meddelande) ? meddelande['id'] : undefined;
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

function rpcFel(status: number, id: JsonRpcId, code: number, message: string, data?: unknown): Utfall {
  const error = { code, message, ...(data !== undefined ? { data } : {}) };
  return { status, kropp: { jsonrpc: '2.0', id, error } };
}

function rpcResultat(id: JsonRpcId, result: unknown): Utfall {
  return { status: 200, kropp: { jsonrpc: '2.0', id, result } };
}

/**
 * Svaret på ett meddelande, i ordningen ur Dev Notes → Protokollet: (1) versionshuvudet, (2) klientens
 * svar, (3) kuvertet, (4) notifieringen, (5) metoden. Ren funktion så när som på API-anropet.
 */
async function besvara(
  meddelande: unknown,
  sammanhang: { apiUrl: string; nyckel: string; version: string | undefined },
): Promise<Utfall> {
  // Med flit inte den moderna felkoden: 400 med −32600 får en klient av båda sorterna att falla tillbaka
  // på initialize. Saknas huvudet godtas begäran.
  if (sammanhang.version !== undefined && !arVersion(sammanhang.version)) {
    return rpcFel(400, idUr(meddelande), -32600, 'Protokollversionen stöds inte.', {
      supported: [...VERSIONER],
    });
  }
  if (
    arObjekt(meddelande) &&
    meddelande['jsonrpc'] === '2.0' &&
    !Object.hasOwn(meddelande, 'method') &&
    (Object.hasOwn(meddelande, 'result') || Object.hasOwn(meddelande, 'error'))
  ) {
    return { status: 202 };
  }
  // En lista (en JSON-RPC-batch) avvisas här för alla tre revisionerna: 2025-06-18 tog bort dem.
  const tolkat = BegaranSchema.safeParse(meddelande);
  if (!tolkat.success) return rpcFel(400, idUr(meddelande), -32600, 'Ogiltig JSON-RPC-begäran.');
  const begaran = tolkat.data;
  if (begaran.id === undefined) return { status: 202 };
  const id = begaran.id;

  switch (begaran.method) {
    case 'initialize': {
      const begard = arObjekt(begaran.params) ? begaran.params['protocolVersion'] : undefined;
      return rpcResultat(id, {
        protocolVersion: arVersion(begard) ? begard : VERSIONER[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'arenden', title: 'Ärendena', version: '0.1.0' },
      });
    }
    case 'ping':
      return rpcResultat(id, {});
    case 'tools/list':
      return rpcResultat(id, { tools: VERKTYG });
    case 'tools/call': {
      // AK 4: en enda väg in. Namnet slås upp bland de sju, och API:t får den funna postens namn, aldrig
      // strängen i begäran. Bara name och arguments läses; andra nycklar i params (som _meta) lämnas.
      const params = begaran.params;
      if (!arObjekt(params)) return rpcFel(200, id, -32602, 'Verktyget finns inte i listan.');
      const verktyg = hittaVerktyg(params['name']);
      if (verktyg === undefined) return rpcFel(200, id, -32602, 'Verktyget finns inte i listan.');
      const indata = params['arguments'] === undefined ? {} : params['arguments'];
      if (!arObjekt(indata)) return rpcFel(200, id, -32602, 'Indata ska vara ett objekt.');
      // AK 3: tillåtelselistan prövas innan något anrop görs, så att ett aktörsfält aldrig når API:t.
      const otillatna = otillatnaFalt(verktyg, indata);
      if (otillatna.length > 0) {
        const namn = otillatna.slice(0, MAX_NAMN).map((n) => n.slice(0, MAX_NAMNLANGD));
        return rpcFel(200, id, -32602, `Fält som verktyget inte tar emot: ${namn.join(', ')}.`);
      }
      // Grenen fångar inga fel: ett oväntat fel når den sista felhanteraren.
      const utfall = await anropaApi({
        apiUrl: sammanhang.apiUrl,
        nyckel: sammanhang.nyckel,
        namn: verktyg.name,
        indata,
      });
      // Story 4.3 AK 4: en återkallad nyckel är sessionens slut, inget verktygsresultat.
      if (utfall === 'nyckeln_avvisad') return { status: 401, sessionSlut: true };
      return rpcResultat(id, utfall);
    }
    default:
      return rpcFel(200, id, -32601, 'Metoden finns inte.');
  }
}

/**
 * Felet ur express egen JSON-tolk: 'json' när kroppen inte är JSON, statusen för ett annat klientfel ur
 * tolken (till exempel 413 för en kropp över 1 mb), annars null.
 */
function tolkensFel(fel: unknown): 'json' | number | null {
  if (typeof fel !== 'object' || fel === null) return null;
  const { type, status } = fel as { type?: unknown; status?: unknown };
  if (type === 'entity.parse.failed') return 'json';
  if (typeof type !== 'string' || typeof status !== 'number') return null;
  return status >= 400 && status < 500 ? status : null;
}

/**
 * Gatewayens Express-app. `apiUrl` är plattformens adress; i drift alltid GATEWAYKONFIG.API_URL. `oauth` ger
 * utgivaren, som 401-svaret pekar på, och OAuth-vägarna (Story 4.3).
 */
export function skapaMcpApp(alternativ: {
  apiUrl: string;
  nyckellager: Nyckellager;
  grans: number;
  oauth: Pick<OAuth, 'utgivare' | 'vagar'>;
}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Gatewayen binder 127.0.0.1 och litar inte på någon proxy: req.ip är den anslutande adressen, som bakom
  // funneln (Story 4.4) kan vara densamma för all trafik.
  app.set('trust proxy', false);

  // Sessionens nyckel och id ur uppslaget, per begäran, bara i den här appens minne (invariant 3).
  const sessionerna = new WeakMap<Request, Sessionen>();

  // Story 4.3 AK 1: 401-svaret pekar på skyddsresursens metadata (RFC 9728), med felkoden invalid_token när
  // en bearer-token fanns men inte gav någon nyckel (okänd, utgången eller glömd).
  const metadata = `${alternativ.oauth.utgivare}/.well-known/oauth-protected-resource`;
  const utanToken = `Bearer resource_metadata="${metadata}"`;
  const ogiltigToken = `Bearer error="invalid_token", resource_metadata="${metadata}"`;
  const nekad = (res: Response, huvud: string): void => {
    res.status(401).set('WWW-Authenticate', huvud).json({ error: 'unauthenticated' });
  };

  app.all(
    '/mcp',
    // Gränsen står framför allt annat, före sessionen, som på /api. Svaret följer API:ts felkuvert,
    // {"error":"rate_limited"} med RateLimit-* och Retry-After (beslut #24 KRAV-2). Alternativet message
    // ger kroppen utan en egen svarsfunktion.
    rateLimit({
      windowMs: 60_000,
      limit: alternativ.grans,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    }),
    (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'POST') {
        res.status(405).set('Allow', 'POST').json({ error: 'method_not_allowed' });
        return;
      }
      next();
    },
    (req: Request, res: Response, next: NextFunction) => {
      // Schemanamnet jämförs utan skiftläge (RFC 7235 avsnitt 2.1), som på /token.
      const token = legitimation(req.headers.authorization, 'Bearer');
      if (token === undefined) {
        nekad(res, utanToken);
        return;
      }
      const sessionen = alternativ.nyckellager.nyckelFor(token);
      if (sessionen === undefined) {
        nekad(res, ogiltigToken);
        return;
      }
      sessionerna.set(req, sessionen);
      next();
    },
    express.json({ limit: '1mb' }),
    async (req: Request, res: Response) => {
      const sessionen = sessionerna.get(req);
      if (sessionen === undefined) throw new Error('sessionen saknas');
      const utfall = await besvara(req.body, {
        apiUrl: alternativ.apiUrl,
        nyckel: sessionen.nyckel,
        version: req.get('MCP-Protocol-Version'),
      });
      // Story 4.3 AK 4: API:ts 401 dödar sessionen ur uppslaget, med dess access- och refresh-token.
      if (utfall.sessionSlut === true) {
        alternativ.nyckellager.glom(sessionen.session);
        nekad(res, ogiltigToken);
        return;
      }
      if (utfall.kropp === undefined) res.status(utfall.status).end();
      else res.status(utfall.status).json(utfall.kropp);
    },
  );

  // Story 4.3: OAuth-delens vägar efter /mcp och före 404. Varje väg har sin egen gräns i routern.
  app.use(alternativ.oauth.vagar);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Den sista felhanteraren: klienten får en fast kropp, aldrig text ur felet, och loggen får bara felets
  // namn, aldrig dess text eller begäran (docs/project-context.md rad 45 och 146).
  app.use((fel: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const tolken = tolkensFel(fel);
    if (tolken !== null) {
      const utfall =
        tolken === 'json'
          ? rpcFel(400, null, -32700, 'Kroppen är inte JSON.')
          : rpcFel(tolken, null, -32600, 'Ogiltig JSON-RPC-begäran.');
      res.status(utfall.status).json(utfall.kropp);
      return;
    }
    console.error(`MCP-gatewayen: oväntat fel (${fel instanceof Error ? fel.name : typeof fel})`);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

// ---- Processen (Uppgift 5) ------------------------------------------------------------------------------

/**
 * Story 4.2 AK 6 och Story 4.3 AK 5: startar gatewayen på `port` och värden GATEWAYKONFIG.HOST, med klienten
 * ur klientfilen på `klientfil`. Funktionen tar porten och klientfilens sökväg; ingen parameter bär värden,
 * så att varken en parameter eller en miljövariabel kan flytta bindningen. OAuth-delens lager är tomt vid
 * varje start, så en omstart kräver ny auktorisering. Löftet uppfylls när servern lyssnar och avvisas med
 * felet ur lasKlientfil() när klientfilen inte går att använda.
 */
export function startaGateway(port: number, klientfil: string = OAUTHKONFIG.KLIENTFIL): Promise<Server> {
  return new Promise<Server>((klar, avvisa) => {
    const klient = lasKlientfil(klientfil);
    const oauth = skapaOAuth({ klient, apiUrl: GATEWAYKONFIG.API_URL });
    const app = skapaMcpApp({
      apiUrl: GATEWAYKONFIG.API_URL,
      nyckellager: oauth.nyckellager,
      grans: GATEWAYKONFIG.GRANS_PER_MINUT,
      oauth,
    });
    const server = app.listen(port, GATEWAYKONFIG.HOST);
    server.once('listening', () => klar(server));
    server.once('error', avvisa);
  });
}

// Startdelen körs bara när filen är processens ingång («node dist/mcp/server.js»), som CLI-delen i
// src/db/migrate.ts. Vakten mot undefined krävs av noUncheckedIndexedAccess.
const arIngang =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (arIngang) {
  // Utan en användbar klientfil startar gatewayen inte. Raden bär bara felets namn, aldrig dess text.
  let server: Server;
  try {
    server = await startaGateway(GATEWAYKONFIG.PORT);
  } catch (fel) {
    console.error(`MCP-gatewayen startar inte (${fel instanceof Error ? fel.name : typeof fel})`);
    process.exit(1);
  }
  const adress = server.address();
  const plats =
    adress !== null && typeof adress === 'object' ? `${adress.address}:${adress.port}` : String(adress);
  console.log(`MCP-gatewayen lyssnar på ${plats}`);

  const shutdown = (signal: string): void => {
    console.log(`${signal} mottagen — stänger ner`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
