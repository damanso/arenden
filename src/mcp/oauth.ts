// FR-24 (d), B-19 punkt 2, Story 4.3: gatewayens egen OAuth 2.1-server, som knyter Claude-sessionen till
// Davids människonyckel.
//
// FEM invarianter, som granskaren kan läsa av rakt här:
//  1. Klienten och adresserna är SLUTNA: ett klient-id och en hemlighet ur klientfilen (0600), och bara
//     adresserna i OAUTHKONFIG.REDIRECT_VITLISTA, jämförda exakt. Ingen klientregistrering.
//  2. Bara en människonyckel, prövad med vem_ar_jag genom API:t (fragaVemArJag() i verktyg.ts), ger en kod.
//     Gatewayen avgör aldrig själv vem en nyckel tillhör, och aktören tar API:t ur nyckeln (FR-4).
//  3. Koder och tokens lagras BARA som sha256, i processens minne. En omstart kräver ny auktorisering.
//  4. Nyckeln står bara i kodens och sessionens post och skickas bara som bearer till API:t; aldrig i en
//     sida, en adress, ett huvud, ett svar eller en logg (FR-14, docs/project-context.md rad 141).
//  5. Filen läser bara klientfilen och skriver aldrig till disk eller logg.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import express from 'express';
import type { Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { Nyckellager } from './server.js';
import { fragaVemArJag } from './verktyg.js';

/**
 * OAuth-delens konfiguration, som konstanter. Klientfilens sökväg står här och inte i appens konfiguration,
 * eftersom gatewayen inte laddar appens konfiguration (B-19 punkt 1 och 3, Story 4.2 AK 6); samma katalog
 * som Python-klientens nyckelfil. Koden läser ingen miljövariabel, men sökvägen byggs av os.homedir(), som
 * Node på POSIX tar ur miljövariabeln HOME: HOME avgör alltså vilken klientfil som läses, och därmed
 * utgivaren och hemligheten. Vitlistan är Claudes två återkomstadresser. Livslängderna: access token en
 * timme (B-19), refresh token 30 dygn, koden fem minuter.
 */
export const OAUTHKONFIG = Object.freeze({
  KLIENTFIL: path.join(homedir(), '.hermes', 'arenden-mcp-klient.json'),
  REDIRECT_VITLISTA: Object.freeze([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
  ] as const),
  ACCESS_SEKUNDER: 3600,
  REFRESH_SEKUNDER: 2_592_000,
  KOD_SEKUNDER: 300,
  GRANS_PER_MINUT: 30,
});

// ---- Klientfilen (Uppgift 2) ----------------------------------------------------------------------------

/**
 * Utgivaren är gatewayens offentliga https-adress och exakt sitt eget ursprung: ingen sökväg, inget
 * snedstreck sist, ingen fråga, inget ankare och inget användarnamn.
 */
function arUtgivare(varde: string): boolean {
  try {
    const adress = new URL(varde);
    return adress.protocol === 'https:' && adress.origin === varde;
  } catch {
    return false;
  }
}

/**
 * Klientfilens form, strikt. Hemligheten har bara tecken ur base64url, så att varken ett kolon eller ett
 * procenttecken kan göra huvudet `Authorization: Basic` tvetydigt.
 */
const KlientSchema = z
  .object({
    client_id: z.string().regex(/^[A-Za-z0-9._-]{1,100}$/),
    client_secret: z.string().regex(/^[A-Za-z0-9_-]{32,200}$/),
    utgivare: z.string().refine(arUtgivare),
  })
  .strict();

export type Klient = z.infer<typeof KlientSchema>;

/** Varje fel med klientfilen. Texten är fast: inget ur filen eller ur det fångade felet förs vidare. */
export class KlientfilFel extends Error {
  constructor() {
    super('klientfilen går inte att använda');
    this.name = 'KlientfilFel';
  }
}

/**
 * AK 5: klienten ur filen på `sokvag`. Filen läses genom en fildeskriptor, så att det är samma fil som
 * prövades: en vanlig fil med rättigheterna exakt 0600, och innehållet med det strikta schemat. Allt
 * annat kastar KlientfilFel.
 */
export function lasKlientfil(sokvag: string): Klient {
  let fd: number | undefined;
  try {
    fd = openSync(sokvag, 'r');
    const info = fstatSync(fd);
    if (!info.isFile() || (info.mode & 0o777) !== 0o600) throw new KlientfilFel();
    const tolkat = KlientSchema.safeParse(JSON.parse(readFileSync(fd, 'utf8')));
    if (!tolkat.success) throw new KlientfilFel();
    return tolkat.data;
  } catch {
    throw new KlientfilFel();
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

// ---- Sidorna (Uppgift 4) --------------------------------------------------------------------------------

const ERSATTNING: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Husets escape-kontrakt (FR-34, docs/project-context.md rad 142): de fem tecknen, och null och undefined
 * blir tom sträng. En egen kopia, eftersom gatewayen är en egen process utanför vyn och aldrig importerar ur
 * vylagret (Story 4.2 AK 4); test/mcp-oauth.test.ts O7 jämför den med husets esc().
 */
export function esc(varde: unknown): string {
  if (varde === null || varde === undefined) return '';
  return String(varde).replace(/[&<>"']/g, (tecken) => ERSATTNING[tecken] ?? tecken);
}

/** UX-specifikationen, Auktoriseringssidan för Claude-kopplingen; testerna matchar texterna ordagrant. */
const TEXT = Object.freeze({
  RUBRIK: 'Godkänn Claude-kopplingen',
  INLEDNING: 'Claude får läsa och ändra ärenden som du. Valvet, dokumenten och redovisningen nås inte den vägen.',
  ETIKETT: 'Människonyckel',
  KNAPP: 'Godkänn',
  METARAD: 'Varje handling bokförs som människa, med nyckelns namn. Kopplingen stängs när nyckeln återkallas.',
  AGENT: 'Nyckeln tillhör en agent eller ett system. Vägen tar bara emot människonycklar.',
  NYCKEL: 'Nyckeln gick inte att känna igen, eller är återkallad.',
  SVARADE_INTE: 'Ärende-API:t svarade inte. Försök igen senare.',
  KAN_INTE_GODKANNAS: 'Kopplingen kan inte godkännas',
  OKAND_KLIENT: 'Kopplingen är inte känd.',
  FEL_ADRESS: 'Adressen som Claude ville skicka tillbaka till är inte godkänd.',
  AVVISAD: 'Begäran avvisades',
  FEL_URSPRUNG: 'Begäran kom inte från auktoriseringssidan och avvisades. Ingen kod utfärdades.',
});

/**
 * CSP:n på sidorna: inget skript, ingen stil, ingen bild och ingen inramning. `form-action` bär vitlistans
 * ursprung, eftersom webbläsare prövar den också mot omdirigeringen efter formuläret (303 till Claude).
 */
const VITLISTANS_URSPRUNG = [...new Set(OAUTHKONFIG.REDIRECT_VITLISTA.map((adress) => new URL(adress).origin))];
const CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'none'",
  "img-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  ["form-action 'self'", ...VITLISTANS_URSPRUNG].join(' '),
].join('; ');

/** Lösenordsfältet, alltid utan value: nyckeln står aldrig i en sida (invariant 4). */
const LOSENORDSFALT =
  '<input type=password id=nyckel name=nyckel required autocomplete=off spellcheck=false autocapitalize=off>';

/**
 * Den enda byggfunktionen för gatewayens sidor: ramen med titeln och innehållet i main. Varje insatt värde
 * går genom esc(). Inget stilmallsblock: husets tokenblock ligger i vylagret, som gatewayen inte når.
 */
function ram(titel: string, innehall: string): string {
  return (
    '<!doctype html><html lang=sv><meta charset=utf-8>' +
    '<meta name=viewport content="width=device-width,initial-scale=1">' +
    `<title>${esc(titel)}</title><main>${innehall}</main></html>`
  );
}

/** Felsidan: rubriken och meningen, inget formulär. */
function felsida(rubrik: string, mening: string): string {
  return ram(rubrik, `<h1>${esc(rubrik)}</h1><p>${esc(mening)}</p>`);
}

/** Frågan efter provaFragan(): bara de värden som prövats. */
interface Fragan {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string | undefined;
}

/**
 * Auktoriseringssidan för en prövad fråga, med en notis vid fel. Funktionen har ingen parameter för nyckeln,
 * så den kan aldrig skriva den (AK 3).
 */
function auktoriseringssida(fragan: Fragan, notis?: string): string {
  const dolda: [string, string | undefined][] = [
    ['response_type', 'code'],
    ['client_id', fragan.client_id],
    ['redirect_uri', fragan.redirect_uri],
    ['code_challenge', fragan.code_challenge],
    ['code_challenge_method', 'S256'],
    ['state', fragan.state],
  ];
  return ram(
    TEXT.RUBRIK,
    `<h1>${esc(TEXT.RUBRIK)}</h1><p>${esc(TEXT.INLEDNING)}</p>` +
      (notis !== undefined ? `<p class=notis>${esc(notis)}</p>` : '') +
      '<form method=post action="/authorize">' +
      dolda
        .filter(([, varde]) => varde !== undefined)
        .map(([namn, varde]) => `<input type=hidden name=${esc(namn)} value="${esc(varde)}">`)
        .join('') +
      `<label for=nyckel>${esc(TEXT.ETIKETT)}</label>${LOSENORDSFALT}` +
      `<div class=skrivrad><button type=submit>${esc(TEXT.KNAPP)}</button>` +
      `<span class=meta>${esc(TEXT.METARAD)}</span></div></form>`,
  );
}

/**
 * Skickar en sida med husets huvuden. Referrer-Policy är strict-origin-when-cross-origin: en strängare
 * policy ger webbläsaren `Origin: null` på formuläret, som ursprungskontrollen då avvisar.
 */
function skickaSida(res: Response, status: number, html: string): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CSP,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    })
    .send(html);
}

/** 303 till `adress`, också efter GET, så att webbläsaren alltid hämtar adressen med GET. */
function omdirigera(res: Response, adress: string): void {
  res.status(303).set({ Location: adress, 'Cache-Control': 'no-store' }).end();
}

/** Adressen ur vitlistan med parametrarna, byggd med URL och searchParams; ett undefined-värde utelämnas. */
function adressMed(bas: string, parametrar: [string, string | undefined][]): string {
  const adress = new URL(bas);
  for (const [namn, varde] of parametrar) if (varde !== undefined) adress.searchParams.set(namn, varde);
  return adress.href;
}

const arObjekt = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parametern som det står, eller undefined när den saknas. En upprepad parameter är en lista, inte en sträng. */
const parameter = (kalla: Record<string, unknown>, namn: string): unknown =>
  Object.hasOwn(kalla, namn) ? kalla[namn] : undefined;

/** Parametern när den är en enda sträng, annars undefined. */
function ensam(kalla: Record<string, unknown>, namn: string): string | undefined {
  const varde = parameter(kalla, namn);
  return typeof varde === 'string' ? varde : undefined;
}

const UTMANING = /^[A-Za-z0-9_-]{43}$/;
/** Nyckelns form: 1–200 tecken ur koderna 33 till 126. Annat frågas aldrig om. */
const NYCKELFORM = /^[\x21-\x7e]{1,200}$/;

const VITLISTA: readonly string[] = OAUTHKONFIG.REDIRECT_VITLISTA;

/**
 * Utfallet av provaFragan(): den prövade frågan, en felsida (klienten eller adressen är fel, så ingen
 * omdirigering, RFC 6749 avsnitt 4.1.2.1) eller adressen tillbaka till Claude med `error`.
 */
type Provning =
  | { slag: 'ok'; fragan: Fragan }
  | { slag: 'sida'; status: number; html: string }
  | { slag: 'tillbaka'; adress: string };

function svaraPaFel(res: Response, provning: Exclude<Provning, { slag: 'ok' }>): void {
  if (provning.slag === 'sida') skickaSida(res, provning.status, provning.html);
  else omdirigera(res, provning.adress);
}

/** En ny kod eller token: 32 slumpbytes i base64url, 43 tecken. Den enda generatorn (invariant 3). */
const nyttVarde = (): string => randomBytes(32).toString('base64url');

/**
 * Formulärtolken, bara på /authorize och /token (RFC 6749 avsnitt 4.1.3 kräver formulärkodning på /token,
 * och auktoriseringssidan är ett HTML-formulär). /mcp tar fortfarande bara JSON.
 */
const formular = express.urlencoded({ extended: false, limit: '16kb' });

/** PKCE-verifieraren (RFC 7636): 43–128 tecken ur A–Z, a–z, 0–9, punkt, understreck, tilde och bindestreck. */
const VERIFIERARE = /^[A-Za-z0-9._~-]{43,128}$/;

/** Två hemligheter jämförda som sha256 med timingSafeEqual, så att längden och innehållet inte kan tidsmätas. */
function likaHemlighet(a: string, b: string): boolean {
  const sha = (varde: string) => createHash('sha256').update(varde, 'utf8').digest();
  return timingSafeEqual(sha(a), sha(b));
}

/** Verifieraren mot kodens utmaning: sha256 i base64url, jämfört med timingSafeEqual. */
function verifierarenStammer(verifierare: string, utmaning: string): boolean {
  const beraknad = Buffer.from(createHash('sha256').update(verifierare, 'ascii').digest('base64url'));
  const vantad = Buffer.from(utmaning);
  return beraknad.length === vantad.length && timingSafeEqual(beraknad, vantad);
}

/**
 * Värdet efter schemanamnet i huvudet Authorization, eller undefined när huvudet saknas, har ett annat
 * schema eller inget värde. Schemanamnet jämförs utan skiftläge (RFC 7235 avsnitt 2.1), och ett eller flera
 * blanksteg skiljer det från värdet. Gatewayen läser huvudet bara härigenom: /token med Basic och /mcp
 * (server.ts) med Bearer.
 */
export function legitimation(huvud: string | undefined, schema: 'Basic' | 'Bearer'): string | undefined {
  const traff = huvud === undefined ? null : /^([^ ]+) +(.*)$/.exec(huvud);
  if (traff === null || traff[1]?.toLowerCase() !== schema.toLowerCase()) return undefined;
  const varde = traff[2]?.trim() ?? '';
  return varde === '' ? undefined : varde;
}

/**
 * Klienten som begäran autentiserar sig som: huvudet Authorization med schemat Basic först (id och
 * hemlighet avkodade med decodeURIComponent, RFC 6749 avsnitt 2.3.1), annars client_id och client_secret i
 * kroppen. Ett avkodningsfel eller en form som inte går att läsa ger undefined, som fel klient.
 */
function klientFran(
  req: Request,
  kropp: Record<string, unknown>,
): { id: string; hemlighet: string } | undefined {
  const basic = legitimation(req.headers.authorization, 'Basic');
  if (basic !== undefined) {
    const avkodat = Buffer.from(basic, 'base64').toString('utf8');
    const kolon = avkodat.indexOf(':');
    if (kolon < 0) return undefined;
    try {
      return {
        id: decodeURIComponent(avkodat.slice(0, kolon)),
        hemlighet: decodeURIComponent(avkodat.slice(kolon + 1)),
      };
    } catch {
      return undefined;
    }
  }
  const id = ensam(kropp, 'client_id');
  const hemlighet = ensam(kropp, 'client_secret');
  return id !== undefined && hemlighet !== undefined ? { id, hemlighet } : undefined;
}

/** Svaren från /token lagras aldrig av en mellanhand (RFC 6749 avsnitt 5.1). */
const INGEN_CACHE = Object.freeze({ 'Cache-Control': 'no-store', Pragma: 'no-cache' });

function tokenfel(res: Response, status: number, fel: string): void {
  res.status(status).set(INGEN_CACHE).json({ error: fel });
}

// ---- OAuth-delen (Uppgift 3–6) --------------------------------------------------------------------------

/** Det gatewayen och proven når av OAuth-delen. */
export interface OAuth {
  /** Klientfilens utgivare: gatewayens offentliga adress, som metadata och ursprungskontrollen bär. */
  utgivare: string;
  /** Metadata-vägarna, /authorize och /token, var och en bakom sin egen gräns. */
  vagar: express.Router;
  /**
   * Sessionen i /mcp: bearer-token → nyckeln och sessionens id, och glom(session) när API:t avvisar
   * sessionens nyckel.
   */
  nyckellager: Nyckellager;
  /** Lagrets nycklar, för proven: bara hashar, aldrig poster, och antalet sessioner. */
  hashar(): { koder: string[]; access: string[]; refresh: string[]; sessioner: number };
}

/** En kods post: allt som växlingen prövar, och nyckeln som sessionen får. */
interface Kodpost {
  nyckel: string;
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  utgar: number;
}

/** En access- eller refresh-tokens post: sessionen den hör till och när den slutar gälla (ms). */
interface Tokenpost {
  session: string;
  utgar: number;
}

/** Sessionens post: den ENDA platsen där nyckeln står efter växlingen (invariant 4). Ingen aktör. */
interface Sessionspost {
  nyckel: string;
  client_id: string;
}

/** sha256 i hex: den enda form som en kod eller en token lagras i (invariant 3). */
const hasha = (varde: string): string => createHash('sha256').update(varde, 'utf8').digest('hex');

/** Tar bort tabellens poster vars tid gått vid `tid` (ms). */
function taBortUtgangna(tabell: Map<string, { utgar: number }>, tid: number): void {
  for (const [hash, post] of tabell) if (post.utgar <= tid) tabell.delete(hash);
}

/**
 * OAuth-delen för klienten ur klientfilen. `apiUrl` är plattformens adress (i drift alltid gatewayens
 * API_URL), `grans` gränsen per minut och adress för var och en av OAuth-vägarna, och `nu` klockan i
 * millisekunder (proven flyttar den). Lagret lever i funktionens slutning, så att en ny instans (en
 * omstart) inte känner någon gammal kod eller token.
 */
export function skapaOAuth({
  klient,
  apiUrl,
  grans = OAUTHKONFIG.GRANS_PER_MINUT,
  nu = Date.now,
}: {
  klient: Klient;
  apiUrl: string;
  grans?: number;
  nu?: () => number;
}): OAuth {
  const utgivare = klient.utgivare;

  // Lagret: fyra tabeller i processens minne. Koder, access och refresh har sha256 som nyckel, sessionerna
  // ett randomUUID().
  const koder = new Map<string, Kodpost>();
  const access = new Map<string, Tokenpost>();
  const refresh = new Map<string, Tokenpost>();
  const sessioner = new Map<string, Sessionspost>();

  /**
   * Poster vars tid gått, och sessioner utan någon access- eller refresh-post kvar, tas bort. Körs före
   * varje utfärdande, så att lagret inte växer utan gräns.
   */
  function rensa(): void {
    const tid = nu();
    taBortUtgangna(koder, tid);
    taBortUtgangna(access, tid);
    taBortUtgangna(refresh, tid);
    const levande = new Set([...access.values(), ...refresh.values()].map((post) => post.session));
    for (const session of sessioner.keys()) if (!levande.has(session)) sessioner.delete(session);
  }

  const nyckellager: Nyckellager = {
    // Tokens sha256 slås upp i access-tabellen; en post vars tid gått tas bort och ger ingen session. Svaret
    // bär sessionens id, så att glom() tar just den sessionen, också när access-posten hinner försvinna
    // medan API-anropet pågår (tiden går ut, och en annan begäran eller rensa() tar bort posten).
    nyckelFor(token) {
      const hash = hasha(token);
      const post = access.get(hash);
      if (post === undefined) return undefined;
      if (post.utgar <= nu()) {
        access.delete(hash);
        return undefined;
      }
      const sessionen = sessioner.get(post.session);
      return sessionen === undefined ? undefined : { nyckel: sessionen.nyckel, session: post.session };
    },
    // AK 4: sessionen ur uppslaget tas bort, med varje access- och refresh-post som pekar på den, också en
    // som en samtidig förnyelse just utfärdat. Token slås aldrig upp på nytt här.
    glom(session) {
      sessioner.delete(session);
      for (const tabell of [access, refresh]) {
        for (const [hash, tokenpost] of tabell) if (tokenpost.session === session) tabell.delete(hash);
      }
    },
  };

  // Gränsen: en egen räknare för varje OAuth-väg, skild från /mcp:s och från de andra vägarnas. Räkningen
  // är per adress, och bakom funneln (Story 4.4) kan all trafik komma från samma adress; med en räknare per
  // väg äter anonym trafik mot metadata eller sidan ändå aldrig /token, där Claude förnyar, eller
  // POST /authorize, där David godkänner. Svaret följer API:ts felkuvert, som på /mcp (beslut #24 KRAV-2).
  const nyGrans = () =>
    rateLimit({
      windowMs: 60_000,
      limit: grans,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'rate_limited' },
    });

  const vagar = express.Router();

  // Metadata (RFC 9728 och RFC 8414) ur klientfilens utgivare. Ingen registration_endpoint: registreringen
  // är sluten (B-19 punkt 2), och /register och OpenID-vägen ger gatewayens 404.
  const skyddsresurs = Object.freeze({
    resource: `${utgivare}/mcp`,
    authorization_servers: [utgivare],
    bearer_methods_supported: ['header'],
  });
  const auktoriseringsserver = Object.freeze({
    issuer: utgivare,
    authorization_endpoint: `${utgivare}/authorize`,
    token_endpoint: `${utgivare}/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
  });
  for (const vag of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
    vagar.get(vag, nyGrans(), (_req: Request, res: Response) => {
      res.json(skyddsresurs);
    });
  }
  vagar.get('/.well-known/oauth-authorization-server', nyGrans(), (_req: Request, res: Response) => {
    res.json(auktoriseringsserver);
  });

  // ---- /authorize (Uppgift 4) ----

  /**
   * Frågan i ordning: klienten och adressen först (fel ger en felsida och aldrig en omdirigering), därefter
   * state, response_type och PKCE (fel går tillbaka till den vitlistade adressen med error). Varje parameter
   * godtas bara som en enda sträng; andra parametrar läses aldrig.
   */
  function provaFragan(kalla: Record<string, unknown>): Provning {
    const clientId = ensam(kalla, 'client_id');
    if (clientId === undefined || clientId !== klient.client_id) {
      return { slag: 'sida', status: 400, html: felsida(TEXT.KAN_INTE_GODKANNAS, TEXT.OKAND_KLIENT) };
    }
    const redirectUri = ensam(kalla, 'redirect_uri');
    if (redirectUri === undefined || !VITLISTA.includes(redirectUri)) {
      return { slag: 'sida', status: 400, html: felsida(TEXT.KAN_INTE_GODKANNAS, TEXT.FEL_ADRESS) };
    }
    const state = parameter(kalla, 'state');
    if (state !== undefined && (typeof state !== 'string' || state.length < 1 || state.length > 500)) {
      return { slag: 'tillbaka', adress: adressMed(redirectUri, [['error', 'invalid_request']]) };
    }
    const giltigtState = typeof state === 'string' ? state : undefined;
    const tillbaka = (fel: string): Provning => ({
      slag: 'tillbaka',
      adress: adressMed(redirectUri, [
        ['error', fel],
        ['state', giltigtState],
      ]),
    });
    if (ensam(kalla, 'response_type') !== 'code') return tillbaka('unsupported_response_type');
    const utmaning = ensam(kalla, 'code_challenge');
    if (utmaning === undefined || !UTMANING.test(utmaning) || ensam(kalla, 'code_challenge_method') !== 'S256') {
      return tillbaka('invalid_request');
    }
    return {
      slag: 'ok',
      fragan: { client_id: clientId, redirect_uri: redirectUri, code_challenge: utmaning, state: giltigtState },
    };
  }

  /**
   * AK 6: husets regel ur vyns kravSammaUrsprung(), men mot hela ursprunget (protokoll, värd och port):
   * Sec-Fetch-Site ska vara same-origin om det finns, och Origin exakt utgivarens om det finns (null
   * inräknat). En begäran utan båda släpps, som i vyn.
   */
  const ursprung = new URL(utgivare).origin;
  function ursprungOk(req: Request): boolean {
    const site = req.get('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin') return false;
    const origin = req.get('origin');
    return origin === undefined || origin === ursprung;
  }

  vagar.get('/authorize', nyGrans(), (req: Request, res: Response) => {
    const kalla: Record<string, unknown> = arObjekt(req.query) ? req.query : {};
    const provning = provaFragan(kalla);
    if (provning.slag !== 'ok') {
      svaraPaFel(res, provning);
      return;
    }
    skickaSida(res, 200, auktoriseringssida(provning.fragan));
  });

  // AK 3: ursprunget, frågan och nyckelns form prövas innan API:t frågas. Nyckelfältet läses en gång här och
  // går bara till fragaVemArJag() och, för en människonyckel, till kodens post. Felsvaren är sidor med
  // status, aldrig en omdirigering med fältet i adressen.
  vagar.post('/authorize', nyGrans(), formular, async (req: Request, res: Response) => {
    if (!ursprungOk(req)) {
      skickaSida(res, 403, felsida(TEXT.AVVISAD, TEXT.FEL_URSPRUNG));
      return;
    }
    const kropp: Record<string, unknown> = arObjekt(req.body) ? req.body : {};
    const provning = provaFragan(kropp);
    if (provning.slag !== 'ok') {
      svaraPaFel(res, provning);
      return;
    }
    const { fragan } = provning;
    const nyckel = ensam(kropp, 'nyckel');
    if (nyckel === undefined || !NYCKELFORM.test(nyckel)) {
      skickaSida(res, 401, auktoriseringssida(fragan, TEXT.NYCKEL));
      return;
    }
    const aktor = await fragaVemArJag(apiUrl, nyckel);
    if (aktor === 'svarade_inte') {
      skickaSida(res, 503, auktoriseringssida(fragan, TEXT.SVARADE_INTE));
      return;
    }
    if (aktor === 'okand') {
      skickaSida(res, 401, auktoriseringssida(fragan, TEXT.NYCKEL));
      return;
    }
    if (aktor.aktor_typ !== 'manniska') {
      skickaSida(res, 403, auktoriseringssida(fragan, TEXT.AGENT));
      return;
    }
    // Bara en människonyckel ger en kod (invariant 2). Koden lagras som sha256 och går bara till Location.
    rensa();
    const kod = nyttVarde();
    koder.set(hasha(kod), {
      nyckel,
      client_id: fragan.client_id,
      redirect_uri: fragan.redirect_uri,
      code_challenge: fragan.code_challenge,
      utgar: nu() + OAUTHKONFIG.KOD_SEKUNDER * 1000,
    });
    omdirigera(
      res,
      adressMed(fragan.redirect_uri, [
        ['code', kod],
        ['state', fragan.state],
      ]),
    );
  });

  // ---- /token (Uppgift 5) ----

  /**
   * Ett nytt tokenpar för sessionen. Bara sha256 av tokens blir nycklar i lagret; de råa värdena går bara
   * till svarets kropp.
   */
  function utfardaPar(res: Response, session: string): void {
    const accessToken = nyttVarde();
    const refreshToken = nyttVarde();
    const tid = nu();
    access.set(hasha(accessToken), { session, utgar: tid + OAUTHKONFIG.ACCESS_SEKUNDER * 1000 });
    refresh.set(hasha(refreshToken), { session, utgar: tid + OAUTHKONFIG.REFRESH_SEKUNDER * 1000 });
    res.status(200).set(INGEN_CACHE).json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: OAUTHKONFIG.ACCESS_SEKUNDER,
      refresh_token: refreshToken,
    });
  }

  // AK 2: två utfärdande grenar. Klienten prövas först, så att en okänd klient varken förbrukar eller får
  // en kod; koden och refresh-token tas bort i samma steg som de slås upp, så att de bara kan användas en
  // gång. Andra fält än de uppräknade läses aldrig, och inget fält kan ange aktören (AK 4).
  vagar.post('/token', nyGrans(), formular, (req: Request, res: Response) => {
    const kropp: Record<string, unknown> = arObjekt(req.body) ? req.body : {};
    const fran = klientFran(req, kropp);
    const kandKlient =
      fran !== undefined && fran.id === klient.client_id && likaHemlighet(fran.hemlighet, klient.client_secret);
    if (fran === undefined || !kandKlient) {
      res.set('WWW-Authenticate', 'Basic realm="arenden-mcp"');
      tokenfel(res, 401, 'invalid_client');
      return;
    }
    rensa();

    const grantType = parameter(kropp, 'grant_type');
    if (grantType === 'authorization_code') {
      const kod = ensam(kropp, 'code');
      const adress = ensam(kropp, 'redirect_uri');
      const verifierare = ensam(kropp, 'code_verifier');
      if (kod === undefined || adress === undefined || verifierare === undefined) {
        tokenfel(res, 400, 'invalid_request');
        return;
      }
      const hash = hasha(kod);
      const post = koder.get(hash);
      koder.delete(hash);
      if (
        post === undefined ||
        post.utgar <= nu() ||
        post.client_id !== fran.id ||
        post.redirect_uri !== adress ||
        !VERIFIERARE.test(verifierare) ||
        !verifierarenStammer(verifierare, post.code_challenge)
      ) {
        tokenfel(res, 400, 'invalid_grant');
        return;
      }
      // Sessionens post bär bara nyckeln och klienten; aktören tar API:t ur nyckeln (invariant 4).
      const session = randomUUID();
      sessioner.set(session, { nyckel: post.nyckel, client_id: post.client_id });
      utfardaPar(res, session);
      return;
    }

    if (grantType === 'refresh_token') {
      const token = ensam(kropp, 'refresh_token');
      if (token === undefined) {
        tokenfel(res, 400, 'invalid_request');
        return;
      }
      // Rotation: den gamla refresh-token tas bort när den slås upp.
      const hash = hasha(token);
      const post = refresh.get(hash);
      refresh.delete(hash);
      const session = post === undefined ? undefined : sessioner.get(post.session);
      if (post === undefined || post.utgar <= nu() || session === undefined || session.client_id !== fran.id) {
        tokenfel(res, 400, 'invalid_grant');
        return;
      }
      utfardaPar(res, post.session);
      return;
    }

    // En annan grant_type stöds inte; ingen, eller en upprepad, är en ogiltig begäran.
    tokenfel(res, 400, typeof grantType === 'string' ? 'unsupported_grant_type' : 'invalid_request');
  });

  return {
    utgivare,
    vagar,
    nyckellager,
    hashar: () => ({
      koder: [...koder.keys()],
      access: [...access.keys()],
      refresh: [...refresh.keys()],
      sessioner: sessioner.size,
    }),
  };
}
