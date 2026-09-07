// K-1: aktörsidentitet för SKRIVNINGAR från läsvyn, och CSRF-skyddet runt dem.
//
// PROBLEMET. Etapp 2a KRAV-8 säger två saker som drar åt olika håll:
//   * `/vy` är undantaget från nyckelkravet — tailnet/loopback är gränsen.
//   * `/api` är det inte — aktören tas ALLTID ur nyckeln, aldrig ur indata
//     (KRAV-10), och det är hela boten mot "agentkommentarer stämplas David".
//
// När vyn får POST-rutter måste båda fortsätta gälla. Tre vägar fanns:
//
//   (a) En konfigurerad "vy-aktör" som alla vyskrivningar tillskrivs.
//       Förkastad: då bär varje skrivning samma namn oavsett vem som satt vid
//       tangentbordet, och namnet i loggen blir en gissning.
//   (b) Låta formuläret innehålla ett aktörsfält.
//       Förkastad direkt: det ÄR självdeklarerad proveniens — exakt det
//       KRAV-10 finns för att omöjliggöra.
//   (c) Den här: LÄSNING kräver fortfarande ingen nyckel (KRAV-8 orört).
//       SKRIVNING kräver en session, och en session kan bara födas ur en
//       giltig API-nyckel via `POST /vy/logga-in`. Aktören härleds alltså ur
//       en nyckel även i webbläsaren — samma invariant som på /api, samma
//       uppslagning (`slaUppAktor`), bara en annan bärare av beviset.
//
// Sessionen lever i processens minne. En omstart loggar ut — det är avsiktligt:
// alternativet är en tabell med giltiga bärarbevis på disk, och den kostar mer
// än den ger för en yta som en människa öppnar på sin egen maskin.
import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { Aktor } from '../../lib/aktor.js';
import { ForbiddenError, UnauthenticatedError } from '../../lib/errors.js';

export const SESSIONSKAKA = 'arenden_vy';

/** Sessionen dör efter 12 timmars stillhet. */
const TTL_MS = 12 * 60 * 60 * 1000;

interface Session {
  aktor: Aktor;
  senast: number;
}

const SESSIONER = new Map<string, Session>();

function stada(nu: number): void {
  for (const [token, session] of SESSIONER) {
    if (nu - session.senast > TTL_MS) SESSIONER.delete(token);
  }
}

export function startaSession(aktor: Aktor): string {
  const nu = Date.now();
  stada(nu);
  // 32 slumpade bytes. Token är ett bärarbevis och jämförs som kartnyckel —
  // den är inte härledbar ur något och behöver därför ingen signatur.
  const token = randomBytes(32).toString('base64url');
  SESSIONER.set(token, { aktor, senast: nu });
  return token;
}

export function avslutaSession(token: string | undefined): void {
  if (token) SESSIONER.delete(token);
}

/** Endast för testerna: nollställ processens sessionstillstånd. */
export function glomAllaSessioner(): void {
  SESSIONER.clear();
}

/**
 * Läser EN kaka ur `Cookie:`-huvudet. Egen parsning i sju rader i stället för
 * `cookie-parser` — kravspecen tillåter inga nya beroenden, och det här är hela
 * behovet.
 */
export function lasKaka(req: Request, namn: string): string | undefined {
  const rubrik = req.headers.cookie;
  if (typeof rubrik !== 'string') return undefined;
  for (const del of rubrik.split(';')) {
    const likhetstecken = del.indexOf('=');
    if (likhetstecken === -1) continue;
    if (del.slice(0, likhetstecken).trim() !== namn) continue;
    return decodeURIComponent(del.slice(likhetstecken + 1).trim());
  }
  return undefined;
}

/** Aktören bakom sessionen, eller null. Rör aldrig något — säker i GET-rutter. */
/**
 * Redovisningens session, om den finns. Davids ENDA inloggning.
 *
 * Modulerna kor pa olika portar men samma vardnamn, och kakor ignorerar
 * portnummer - sa `session`-kakan ar redan har. Det vi saknar ar ratten att
 * TOLKA den, och den fragar vi om i stallet for att dela JWT_SECRET: en delad
 * symmetrisk hemlighet i tre tjanster betyder att ett lack faller alla tre.
 *
 * Fel har ar ALDRIG "inloggad". Svarar redovisningen inte far David
 * inloggningssidan - inte tyst atkomst, och inte heller ett pastaende om att
 * han saknar behorighet.
 */
export const REDOVISNINGEN =
  process.env['REDOVISNING_URL'] ?? 'http://127.0.0.1:3001';

export async function redovisningsAktor(req: Request): Promise<Aktor | null> {
  const kakor = req.headers.cookie;
  if (!kakor || !kakor.includes('session=')) return null;
  try {
    const svar = await fetch(REDOVISNINGEN + '/api/session/vem', {
      headers: { cookie: kakor },
      signal: AbortSignal.timeout(2000),
    });
    if (!svar.ok) return null;
    const d = (await svar.json()) as { namn?: unknown };
    const namn = typeof d.namn === 'string' && d.namn.trim() ? d.namn.trim() : null;
    if (!namn) return null;
    // Redovisningens /vem svarar bara for MANNISKOR: agent-token och
    // pending-2FA avvisas dar. Vi behover inte lita pa det pa hedersord -
    // vagen dit gar genom viewAuths egna avvisningar.
    return { typ: 'manniska', namn };
  } catch {
    return null;
  }
}

/** Satt av mellanlagret nedan. Sparas pa foragan sa att den synkrona
 *  sessionsAktor() slipper vanta pa ett natverksanrop tjugo ganger per sida. */
declare module 'express-serve-static-core' {
  interface Request {
    redovisningsaktor?: Aktor | null;
  }
}

/**
 * Mellanlager: slar upp redovisningssessionen EN gang per foragan.
 * Monteras fore vyns rutter. Ror inte /api - agenterna gar aldrig hit.
 */
export async function medRedovisningssession(
  req: Request,
  _res: Response,
  next: (fel?: unknown) => void,
): Promise<void> {
  if (req.redovisningsaktor === undefined) {
    req.redovisningsaktor = await redovisningsAktor(req);
  }
  next();
}

export function sessionsAktor(req: Request): Aktor | null {
  // Davids egen inloggning gar fore nyckelsessionen. Har han bada ar det han
  // sjalv i bada, och den har ar den han faktiskt loggade in med.
  if (req.redovisningsaktor) return req.redovisningsaktor;
  const token = lasKaka(req, SESSIONSKAKA);
  if (!token) return null;
  const session = SESSIONER.get(token);
  if (!session) return null;
  const nu = Date.now();
  if (nu - session.senast > TTL_MS) {
    SESSIONER.delete(token);
    return null;
  }
  session.senast = nu;
  return session.aktor;
}

/** Skrivvägens krav: utan session finns ingen aktör, och då sker ingen skrivning. */
export function kravSessionsAktor(req: Request): Aktor {
  const aktor = sessionsAktor(req);
  if (!aktor) throw new UnauthenticatedError();
  return aktor;
}

export function sattSessionskaka(res: Response, token: string): void {
  res.cookie(SESSIONSKAKA, token, {
    httpOnly: true,
    // SameSite=Strict är CSRF-skyddets FÖRSTA lager: en POST som kommer från en
    // annan sajt bär ingen kaka alls, alltså ingen aktör, alltså ingen skrivning.
    sameSite: 'strict',
    path: '/vy',
    maxAge: TTL_MS,
    // Secure sätts INTE: servern binder 127.0.0.1 över http (KRAV-8, Etapp 2a),
    // och en Secure-kaka hade aldrig skickats dit. Transporten är loopback eller
    // tailnet (WireGuard) — inte ett öppet nät. Exponeras vyn någon gång via
    // `tailscale serve` (https) hör `secure: true` hit samma dag.
  });
}

export function rensaSessionskaka(res: Response): void {
  res.clearCookie(SESSIONSKAKA, { httpOnly: true, sameSite: 'strict', path: '/vy' });
}

// ---- CSRF ------------------------------------------------------------------

/**
 * Motsvarigheten till `assertSameOrigin` i /opt/redovisning/server (samma
 * ursprungsjämförelse, samma tystnad när huvudet saknas) — plus ett lager till.
 *
 * Lager 1: `Sec-Fetch-Site`. Varje webbläsare som kan nå den här ytan skickar
 *   huvudet på alla requests. Är det satt till något annat än `same-origin` kom
 *   requesten inte från vyns egna sidor, och då skriver vi ingenting. curl och
 *   supertest skickar det inte alls — därför "om satt".
 * Lager 2: `Origin`, exakt som redovisningen: saknas huvudet gör vi ingen
 *   invändning (icke-webbläsarklienter), finns det måste värden matcha.
 *   Att detta fungerar hänger på Referrer-Policy: med helmets default
 *   `no-referrer` skickar webbläsaren `Origin: null` på formulär-POST och
 *   nekar VÅRA EGNA formulär. `src/http/app.ts` sätter därför
 *   `strict-origin-when-cross-origin`, samma slutsats som redovisningen drog i
 *   drift.
 * Lager 3: SameSite=Strict på sessionskakan (ovan) — den korsande requesten
 *   har ingen aktör att skriva som.
 */
export function kravSammaUrsprung(req: Request): void {
  const site = req.get('sec-fetch-site');
  if (site !== undefined && site !== 'same-origin') {
    throw new ForbiddenError('cross_origin', 'korsande ursprung nekas');
  }
  const origin = req.get('origin');
  if (!origin) return;
  let ursprungsvard: string;
  try {
    ursprungsvard = new URL(origin).host;
  } catch {
    throw new ForbiddenError('cross_origin', 'ogiltig origin');
  }
  if (ursprungsvard !== req.get('host')) {
    throw new ForbiddenError('cross_origin', 'korsande ursprung nekas');
  }
}
