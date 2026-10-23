// FR-24 (d), Story 4.3: OAuth knyter Claude-sessionen till Davids människonyckel.
//
// Filen prövar gatewayens OAuth-del (src/mcp/oauth.ts), read-actionen vem_ar_jag och sessionen i /mcp.
// Kriterierna, som granskaren kan läsa av här:
//   AK 1  POST /mcp utan giltig token ger 401 med WWW-Authenticate mot skyddsresursens metadata och noll
//         rader (O5, O13);
//   AK 2  metadata, /authorize med PKCE (S256) och /token; en kod utan rätt verifierare, en återanvänd kod,
//         en okänd klient och en adress utanför vitlistan avvisas utan token (O4, O6, O8, O11, O12);
//   AK 3  bara en människonyckel, prövad med vem_ar_jag genom API:t, ger en kod, och det inskrivna värdet
//         upprepas aldrig (O1, O2, O9, O11);
//   AK 4  en återkallad nyckel ger 401 vid nästa verktygsanrop och dödar sessionen, och ingen väg låter
//         sessionen ange aktören (O11, O15);
//   AK 5  bara sha256 av koder och tokens i minnet, klientfilen 0600, inget i loggen, en omstart kräver ny
//         auktorisering (O3, O14);
//   AK 6  auktoriseringssidan: svensk, JS-fri under CSP, esc() på varje värde, främmande ursprung avvisas
//         (O7, O10).
//
// Ingen vi.mock och ingen attrapp av API:t: testservern är den riktiga appen, createApp() framför
// testdatabasen, på loopback med en port som systemet väljer. Den stängda porten är den enda felvägen för
// nätet (docs/project-context.md, Testregler). Klientfilerna skrivs i en tillfällig katalog under tmpdir(),
// aldrig i hemkatalogen.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { actionManifest } from '../src/actions/registry.js';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { esc as husetsEsc } from '../src/http/vy/mall.js';
import { KlientfilFel, OAUTHKONFIG, esc, lasKlientfil, skapaOAuth } from '../src/mcp/oauth.js';
import { skapaMcpApp } from '../src/mcp/server.js';
import { VERKTYGSNAMN, fragaVemArJag, hittaVerktyg } from '../src/mcp/verktyg.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

// ---- Fixturen: testservern med räknaren, nycklarna och fixturärendet ----------------------------------

/** Varje anrop som testservern fått genom `bas`. Fixturens egna anrop går direkt mot `api` och räknas inte. */
const anrop: { metod: string; vag: string; auth: string | null }[] = [];
const rakna = (): number => anrop.length;

/**
 * Ett ingrepp som testservern kör en gång, när nästa anrop har nått den och innan appen svarar: det som
 * händer i gatewayen medan API-anropet pågår (O15). Det tas bort innan det körs.
 */
let underAnropet: (() => Promise<void>) | undefined;

/** En stängd port, som i test/crm.test.ts: den enda felvägen för nätet. */
const STANGD_PORT = 'http://127.0.0.1:1';

/** Provklienten: klientfilens form med 40 tecken hemlighet ur base64url och provets utgivare. */
const PROVKLIENT = Object.freeze({
  client_id: 'claude-prov',
  client_secret: `prov-hemlighet-${'x'.repeat(25)}`,
  utgivare: 'https://prov.example',
});

/** Dev Notes → Metadata, med provklientens utgivare. */
const U = PROVKLIENT.utgivare;
const SKYDDSRESURS = { resource: `${U}/mcp`, authorization_servers: [U], bearer_methods_supported: ['header'] };
const AUKTORISERINGSSERVER = {
  issuer: U,
  authorization_endpoint: `${U}/authorize`,
  token_endpoint: `${U}/token`,
  response_types_supported: ['code'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
};

/** Dev Notes → Texterna: WWW-Authenticate utan bearer-token och med en token som inte ger någon nyckel. */
const UTAN_TOKEN = `Bearer resource_metadata="${U}/.well-known/oauth-protected-resource"`;
const OGILTIG_TOKEN = `Bearer error="invalid_token", resource_metadata="${U}/.well-known/oauth-protected-resource"`;

/** Klockan som OAuth-delen läser. Den flyttas bara framåt i filen, aldrig tillbaka. */
let klocka = Date.now();
const nu = (): number => klocka;

/** De tillfälliga katalogerna under tmpdir(), borttagna i afterAll. */
const tillfalliga: string[] = [];

function tillfalligKatalog(): string {
  const katalog = mkdtempSync(path.join(tmpdir(), 'arenden-mcp-oauth-'));
  tillfalliga.push(katalog);
  return katalog;
}

/** Skriver `innehall` i `katalog` och sätter rättigheterna efteråt, så att umask inte påverkar dem. */
function klientfil(katalog: string, namn: string, innehall: string, rattigheter: number): string {
  const fil = path.join(katalog, namn);
  writeFileSync(fil, innehall);
  chmodSync(fil, rattigheter);
  return fil;
}

let api: express.Express;
let server: Server;
let apiUrl: string;
let david: string;
let agent: string;
let system: string;
let fixtur: string;
let oauth: ReturnType<typeof skapaOAuth>;
let gateway: express.Express;

beforeAll(async () => {
  await seedaTeam();
  david = await nyNyckel({ typ: 'manniska', namn: 'oauth david' });
  agent = await nyNyckel({ typ: 'agent', namn: 'oauth agent' });
  system = await nyNyckel({ typ: 'system', namn: 'oauth system' });

  api = createApp();
  const skapat = await kor(api, agent, 'create_issue', { title: 'OAuth provärende', team_key: 'LOC' });
  expect(skapat.status).toBe(200);
  fixtur = skapat.body.result.identifier;

  // Testservern: den riktiga appen bakom en räknare, på loopback med en port som systemet väljer.
  const bas = express();
  bas.use(async (req, _res, next) => {
    anrop.push({ metod: req.method, vag: req.originalUrl, auth: req.headers.authorization ?? null });
    const ingrepp = underAnropet;
    underAnropet = undefined;
    if (ingrepp !== undefined) await ingrepp();
    next();
  });
  bas.use(api);
  server = bas.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // OAuth-delen med provklienten och klockan, och gatewayen med den. Gränserna är höga: O6 prövar gränsen
  // med en egen OAuth-del.
  oauth = skapaOAuth({ klient: PROVKLIENT, apiUrl, grans: 100_000, nu });
  gateway = skapaMcpApp({ apiUrl, nyckellager: oauth.nyckellager, grans: 100_000, oauth });
});

afterAll(async () => {
  await new Promise<void>((klar) => {
    server.close(() => klar());
    server.closeAllConnections();
  });
  for (const katalog of tillfalliga) rmSync(katalog, { recursive: true, force: true });
});

/** Nyckelns id, läst med pool som i test/manniska-yta.test.ts. */
async function nyckelId(namn: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM api_keys WHERE aktor_namn = $1', [namn]);
  expect(rows, namn).toHaveLength(1);
  return rows[0]!.id;
}

/** Återkallar nyckeln med `namn` direkt mot appen (räknas inte), med Davids nyckel. */
async function aterkalla(namn: string): Promise<void> {
  const svar = await kor(api, david, 'revoke_api_key', { nyckel_id: await nyckelId(namn) });
  expect(svar.status, svar.text).toBe(200);
}

/** Raderna som inte får röras av ett avvisat anrop. */
async function radbild(): Promise<{ events: number; comments: number }> {
  return { events: await raknaRader('events'), comments: await raknaRader('comments') };
}

/** En JSON-RPC-begäran mot `app` på /mcp, med huvudet Authorization som det står (null: utan huvudet). */
function rpc(app: express.Express, authorization: string | null, metod: string, params?: unknown) {
  let anropet = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream');
  if (authorization !== null) anropet = anropet.set('Authorization', authorization);
  return anropet.send({ jsonrpc: '2.0', id: 1, method: metod, params });
}

// ---- Auktoriseringssidan: texterna och hjälparna (Uppgift 4) -------------------------------------------

/** Dev Notes → Texterna, ordagrant. */
const RUBRIK = 'Godkänn Claude-kopplingen';
const INLEDNING = 'Claude får läsa och ändra ärenden som du. Valvet, dokumenten och redovisningen nås inte den vägen.';
const METARAD = 'Varje handling bokförs som människa, med nyckelns namn. Kopplingen stängs när nyckeln återkallas.';
const AGENTMENING = 'Nyckeln tillhör en agent eller ett system. Vägen tar bara emot människonycklar.';
const NYCKELMENING = 'Nyckeln gick inte att känna igen, eller är återkallad.';
const SVARADE_INTE = 'Ärende-API:t svarade inte. Försök igen senare.';
const KAN_INTE_GODKANNAS = 'Kopplingen kan inte godkännas';
const OKAND_KLIENT = 'Kopplingen är inte känd.';
const FEL_ADRESS = 'Adressen som Claude ville skicka tillbaka till är inte godkänd.';
const AVVISAD = 'Begäran avvisades';
const FEL_URSPRUNG = 'Begäran kom inte från auktoriseringssidan och avvisades. Ingen kod utfärdades.';
const CSP =
  "default-src 'none'; script-src 'none'; style-src 'none'; img-src 'none'; base-uri 'none'; " +
  "frame-ancestors 'none'; form-action 'self' https://claude.ai https://claude.com";
const LOSENORDSFALT =
  '<input type=password id=nyckel name=nyckel required autocomplete=off spellcheck=false autocapitalize=off>';

const VITLISTA = OAUTHKONFIG.REDIRECT_VITLISTA;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

/** Sidans ram (Dev Notes → Auktoriseringssidan, punkt 1), med `innehall` i main. */
const ram = (titel: string, innehall: string): string =>
  '<!doctype html><html lang=sv><meta charset=utf-8>' +
  '<meta name=viewport content="width=device-width,initial-scale=1">' +
  `<title>${titel}</title><main>${innehall}</main></html>`;

/** Felsidan: rubriken och meningen, inget formulär. */
const felsidan = (rubrik: string, mening: string): string => ram(rubrik, `<h1>${rubrik}</h1><p>${mening}</p>`);

/** De dolda fälten i ordning, med värdena genom husets esc(). `state` bara när det finns. */
const dolda = (falt: Record<string, string>): string =>
  ['response_type', 'client_id', 'redirect_uri', 'code_challenge', 'code_challenge_method', 'state']
    .filter((namn) => falt[namn] !== undefined)
    .map((namn) => `<input type=hidden name=${namn} value="${husetsEsc(falt[namn])}">`)
    .join('');

/** Auktoriseringssidan för de giltiga fälten `falt`, med en notis vid fel. */
const sidan = (falt: Record<string, string>, notis?: string): string =>
  ram(
    RUBRIK,
    `<h1>${RUBRIK}</h1><p>${INLEDNING}</p>` +
      (notis !== undefined ? `<p class=notis>${notis}</p>` : '') +
      `<form method=post action="/authorize">${dolda(falt)}<label for=nyckel>Människonyckel</label>${LOSENORDSFALT}` +
      `<div class=skrivrad><button type=submit>Godkänn</button><span class=meta>${METARAD}</span></div></form>`,
  );

/** PKCE: verifieraren ur 32 slumpbytes i base64url och utmaningen som sha256 i base64url. */
function pkce(): { verifierare: string; utmaning: string } {
  const verifierare = randomBytes(32).toString('base64url');
  return { verifierare, utmaning: createHash('sha256').update(verifierare).digest('base64url') };
}

/**
 * Giltiga parametrar för /authorize med den första adressen i vitlistan och ett state; `over` byter ut
 * eller (med undefined) tar bort en parameter.
 */
function fragor(over: Record<string, string | undefined> = {}): Record<string, string> {
  const alla: Record<string, string | undefined> = {
    response_type: 'code',
    client_id: PROVKLIENT.client_id,
    redirect_uri: VITLISTA[0],
    code_challenge: pkce().utmaning,
    code_challenge_method: 'S256',
    state: 'prov-state',
    ...over,
  };
  const ut: Record<string, string> = {};
  for (const [namn, varde] of Object.entries(alla)) if (varde !== undefined) ut[namn] = varde;
  return ut;
}

/** GET /authorize med frågan, en lista med en upprepad parameter eller ett objekt. */
function hamtaSidan(fragan: URLSearchParams | Record<string, string>, app: express.Express = gateway) {
  return request(app).get(`/authorize?${new URLSearchParams(fragan).toString()}`);
}

/** POST /authorize som formulär, med Origin lika med utgivaren om inga andra huvuden ges. */
function godkann(
  nyckel: string,
  over: Record<string, string | undefined> = {},
  huvuden: Record<string, string> = { Origin: U },
  app: express.Express = gateway,
) {
  let anropet = request(app).post('/authorize').type('form');
  for (const [namn, varde] of Object.entries(huvuden)) anropet = anropet.set(namn, varde);
  return anropet.send(new URLSearchParams({ ...fragor(over), nyckel }).toString());
}

// ---- /token och sessionen: hjälparna (Uppgift 5) ---------------------------------------------------------

/**
 * Klientautentiseringen: i huvudet (client_secret_basic), i kroppen (client_secret_post) eller ingen.
 * `schema` är schemanamnet i huvudet, Basic om inget annat ges.
 */
type Klientauth = { satt: 'basic' | 'post'; id: string; hemlighet: string; schema?: string } | null;
const BASIC: Klientauth = { satt: 'basic', id: PROVKLIENT.client_id, hemlighet: PROVKLIENT.client_secret };
const I_KROPPEN: Klientauth = { satt: 'post', id: PROVKLIENT.client_id, hemlighet: PROVKLIENT.client_secret };

/** POST /token som formulär med fälten (undefined utelämnas) och klientautentiseringen. */
function tokenbegaran(
  falt: Record<string, string | undefined>,
  klientauth: Klientauth = BASIC,
  app: express.Express = gateway,
) {
  const kropp: Record<string, string> = {};
  for (const [namn, varde] of Object.entries(falt)) if (varde !== undefined) kropp[namn] = varde;
  let anropet = request(app).post('/token').type('form');
  if (klientauth?.satt === 'basic') {
    const par = `${encodeURIComponent(klientauth.id)}:${encodeURIComponent(klientauth.hemlighet)}`;
    anropet = anropet.set('Authorization', `${klientauth.schema ?? 'Basic'} ${Buffer.from(par).toString('base64')}`);
  }
  if (klientauth?.satt === 'post') {
    kropp['client_id'] = klientauth.id;
    kropp['client_secret'] = klientauth.hemlighet;
  }
  return anropet.send(new URLSearchParams(kropp).toString());
}

/** Växlar en kod vid /token; `over` byter ut eller lägger till fält. */
function vaxla(
  kod: string,
  verifierare: string,
  klientauth: Klientauth = BASIC,
  over: Record<string, string | undefined> = {},
  app: express.Express = gateway,
) {
  return tokenbegaran(
    { grant_type: 'authorization_code', code: kod, redirect_uri: VITLISTA[0], code_verifier: verifierare, ...over },
    klientauth,
    app,
  );
}

/** Förnyar med en refresh-token vid /token; `over` byter ut eller lägger till fält. */
function fornya(
  refresh: string,
  klientauth: Klientauth = BASIC,
  app: express.Express = gateway,
  over: Record<string, string | undefined> = {},
) {
  return tokenbegaran({ grant_type: 'refresh_token', refresh_token: refresh, ...over }, klientauth, app);
}

/** Flödets första halva: en kod för nyckeln med en ny PKCE-verifierare. */
async function kodFor(nyckel: string): Promise<{ kod: string; verifierare: string }> {
  const { verifierare, utmaning } = pkce();
  const svar = await godkann(nyckel, { code_challenge: utmaning });
  expect(svar.status, svar.text).toBe(303);
  const kod = new URL(svar.headers['location']!).searchParams.get('code') ?? '';
  expect(kod).toMatch(BASE64URL_43);
  return { kod, verifierare };
}

/** Hela flödet till ett tokenpar. */
async function flode(nyckel: string): Promise<{ access: string; refresh: string }> {
  const { kod, verifierare } = await kodFor(nyckel);
  const svar = await vaxla(kod, verifierare);
  expect(svar.status, svar.text).toBe(200);
  return { access: svar.body.access_token, refresh: svar.body.refresh_token };
}

/** En JSON-RPC-begäran genom gatewayen med token som bearer. */
function mcp(token: string, metod: string, params?: unknown, app: express.Express = gateway) {
  return rpc(app, `Bearer ${token}`, metod, params);
}

/** Svaret som text: kroppen, Location och alla huvuden. */
function samla(svar: { text?: string; headers: Record<string, unknown> }): string {
  return [svar.text ?? '', String(svar.headers['location'] ?? ''), JSON.stringify(svar.headers)].join('\n');
}

const sha256 = (varde: string): string => createHash('sha256').update(varde, 'utf8').digest('hex');

/** Den senaste händelseraden för ärendet. */
async function senasteHandelse(identifier: string) {
  const { rows } = await pool.query<{ verb: string; aktor_typ: string; aktor_namn: string }>(
    `SELECT e.verb, e.aktor_typ, e.aktor_namn
       FROM events e
       JOIN issues i ON i.id = e.issue_id
       JOIN teams t ON t.id = i.team_id
      WHERE t.key || '-' || i.sequence_number = $1
      ORDER BY e.id DESC
      LIMIT 1`,
    [identifier],
  );
  return rows[0];
}

/** En kopia av konsolspionen i test/manniska-yta.test.ts (en provfil importerar inte ur en annan). */
function konsolspion() {
  const spioner = (['log', 'info', 'warn', 'error', 'debug'] as const).map((metod) =>
    vi.spyOn(console, metod).mockImplementation(() => {}),
  );
  return {
    fynd: (varde: string) =>
      spioner.flatMap((s) => s.mock.calls).filter((args) => args.map(String).join(' ').includes(varde)),
    aterstall: () => spioner.forEach((s) => s.mockRestore()),
  };
}

// ---- Uppgift 1: vem_ar_jag och gatewayens fråga --------------------------------------------------------

describe('FR-24 (d)/Story 4.3 AK 3: nyckelns aktör genom API:t', () => {
  it('O1 (AK 3): vem_ar_jag ger nyckelns typ och namn och inget annat, och skriver ingen rad', async () => {
    const aterkallad = await nyNyckel({ typ: 'manniska', namn: 'oauth o1 återkallad' });
    const foreHandelser = await raknaRader('events');

    const fall: [string, { aktor_typ: string; aktor_namn: string }][] = [
      [david, { aktor_typ: 'manniska', aktor_namn: 'oauth david' }],
      [agent, { aktor_typ: 'agent', aktor_namn: 'oauth agent' }],
      [system, { aktor_typ: 'system', aktor_namn: 'oauth system' }],
    ];
    for (const [nyckel, vantat] of fall) {
      const svar = await kor(api, nyckel, 'vem_ar_jag');
      expect(svar.status, vantat.aktor_namn).toBe(200);
      expect(svar.body.result, vantat.aktor_namn).toEqual(vantat);
    }

    // En återkallad människonyckel: API:t svarar 401 före actionen.
    await aterkalla('oauth o1 återkallad');
    const nekad = await kor(api, aterkallad, 'vem_ar_jag');
    expect(nekad.status).toBe(401);

    // Schemat är strikt: inget fält, och inget aktörsfält, godtas.
    for (const indata of [{ extra: 1 }, { aktor_typ: 'manniska' }]) {
      const svar = await kor(api, david, 'vem_ar_jag', indata);
      expect(svar.status, JSON.stringify(indata)).toBe(400);
      expect(svar.body.error, JSON.stringify(indata)).toBe('validation_error');
    }

    // Actionen står i registret som read, men inte bland verktygen: listan är oförändrat sju namn.
    expect(actionManifest().filter((a) => a.name === 'vem_ar_jag').map((a) => a.sensitivity)).toEqual(['read']);
    expect([...VERKTYGSNAMN]).toEqual([
      'get_issue',
      'list_issues',
      'search_issues',
      'create_issue',
      'add_comment',
      'update_issue',
      'update_issue_state',
    ]);
    expect(hittaVerktyg('vem_ar_jag')).toBeUndefined();

    // Bara återkallelsen skrev en rad.
    expect(await raknaRader('events')).toBe(foreHandelser + 1);
  });

  it('O2 (AK 3): fragaVemArJag() frågar API:t med nyckeln som bearer och ger aktören, okand eller svarade_inte', async () => {
    const fore = rakna();
    expect(await fragaVemArJag(apiUrl, david)).toEqual({ aktor_typ: 'manniska', aktor_namn: 'oauth david' });
    expect(await fragaVemArJag(apiUrl, agent)).toEqual({ aktor_typ: 'agent', aktor_namn: 'oauth agent' });
    const pahittad = 'oauth-o2-pahittad-nyckel';
    expect(await fragaVemArJag(apiUrl, pahittad)).toBe('okand');
    expect(await fragaVemArJag(STANGD_PORT, david)).toBe('svarade_inte');

    // Tre anrop mot testservern, vart och ett ett POST mot vem_ar_jag med nyckeln som bearer.
    expect(anrop.slice(fore)).toEqual(
      [david, agent, pahittad].map((nyckel) => ({
        metod: 'POST',
        vag: '/api/actions/vem_ar_jag',
        auth: `Bearer ${nyckel}`,
      })),
    );
  });
});

// ---- Uppgift 2: klientfilen ------------------------------------------------------------------------------

describe('FR-24 (d)/Story 4.3 AK 5: klientfilen', () => {
  it('O3 (AK 5): OAUTHKONFIG är fryst, och lasKlientfil() godtar bara en vanlig fil med 0600 och rätt form', () => {
    expect(Object.isFrozen(OAUTHKONFIG)).toBe(true);
    expect(Object.keys(OAUTHKONFIG).sort()).toEqual([
      'ACCESS_SEKUNDER',
      'GRANS_PER_MINUT',
      'KLIENTFIL',
      'KOD_SEKUNDER',
      'REDIRECT_VITLISTA',
      'REFRESH_SEKUNDER',
    ]);
    expect(OAUTHKONFIG.KLIENTFIL.endsWith('/.hermes/arenden-mcp-klient.json')).toBe(true);
    expect([...OAUTHKONFIG.REDIRECT_VITLISTA]).toEqual([
      'https://claude.ai/api/mcp/auth_callback',
      'https://claude.com/api/mcp/auth_callback',
    ]);
    expect(OAUTHKONFIG.ACCESS_SEKUNDER).toBe(3600);
    expect(OAUTHKONFIG.REFRESH_SEKUNDER).toBe(2_592_000);
    expect(OAUTHKONFIG.KOD_SEKUNDER).toBe(300);
    expect(OAUTHKONFIG.GRANS_PER_MINUT).toBe(30);

    const katalog = tillfalligKatalog();
    const json = JSON.stringify(PROVKLIENT);
    const ratt = klientfil(katalog, 'ratt.json', json, 0o600);
    expect(lasKlientfil(ratt)).toEqual(PROVKLIENT);

    const enKatalog = path.join(katalog, 'en-katalog');
    mkdirSync(enKatalog);
    chmodSync(enKatalog, 0o600);
    const avvisade: [string, string][] = [
      ['0644', klientfil(katalog, 'r0644.json', json, 0o644)],
      ['0640', klientfil(katalog, 'r0640.json', json, 0o640)],
      ['0400', klientfil(katalog, 'r0400.json', json, 0o400)],
      ['saknas', path.join(katalog, 'finns-inte.json')],
      ['en katalog', enKatalog],
      ['inte json', klientfil(katalog, 'text.json', 'inte json', 0o600)],
      ['en extra nyckel', klientfil(katalog, 'extra.json', JSON.stringify({ ...PROVKLIENT, extra: 1 }), 0o600)],
      [
        'utgivare med http',
        klientfil(katalog, 'http.json', JSON.stringify({ ...PROVKLIENT, utgivare: 'http://prov.example' }), 0o600),
      ],
      [
        'utgivare med sökväg',
        klientfil(katalog, 'vag.json', JSON.stringify({ ...PROVKLIENT, utgivare: 'https://prov.example/mcp' }), 0o600),
      ],
      [
        'hemlighet på 31 tecken',
        klientfil(katalog, 'kort.json', JSON.stringify({ ...PROVKLIENT, client_secret: 'k'.repeat(31) }), 0o600),
      ],
    ];
    for (const [namn, sokvag] of avvisade) {
      let fangat: unknown;
      try {
        lasKlientfil(sokvag);
      } catch (fel) {
        fangat = fel;
      }
      expect(fangat, namn).toBeInstanceOf(KlientfilFel);
      const fel = fangat as Error;
      expect(fel.name, namn).toBe('KlientfilFel');
      expect(fel.message, namn).toBe('klientfilen går inte att använda');
      expect(`${fel.message}\n${fel.stack ?? ''}`, namn).not.toContain(PROVKLIENT.client_secret);
    }
    // Katalogen får tillbaka sökrätten, så att afterAll kan ta bort den.
    chmodSync(enKatalog, 0o700);
  });
});

// ---- Uppgift 3: metadata, 401 med WWW-Authenticate och gränsen ------------------------------------------

describe('FR-24 (d)/Story 4.3 AK 2: metadata', () => {
  it('O4 (AK 2): skyddsresursens och auktoriseringsserverns metadata, och ingen registrering', async () => {
    const fore = rakna();
    for (const vag of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const svar = await request(gateway).get(vag);
      expect(svar.status, vag).toBe(200);
      expect(svar.body, vag).toEqual(SKYDDSRESURS);
    }
    const auktorisering = await request(gateway).get('/.well-known/oauth-authorization-server');
    expect(auktorisering.status).toBe(200);
    expect(auktorisering.body).toEqual(AUKTORISERINGSSERVER);

    // Klientregistreringen är sluten, och gatewayen är ingen OpenID-leverantör.
    const vagar = [
      ['get', '/.well-known/openid-configuration'],
      ['get', '/register'],
      ['post', '/register'],
    ] as const;
    for (const [metod, vag] of vagar) {
      const svar = await request(gateway)[metod](vag);
      expect(svar.status, `${metod} ${vag}`).toBe(404);
      expect(svar.body, `${metod} ${vag}`).toEqual({ error: 'not_found' });
    }
    expect(rakna()).toBe(fore);
  });
});

describe('FR-24 (d)/Story 4.3 AK 1: utan giltig token', () => {
  it('O5 (AK 1): utan token, med en påhittad token och med ett annat schema ger /mcp 401 med WWW-Authenticate och noll rader', async () => {
    const fore = { rader: await radbild(), anrop: rakna() };
    const params = { name: 'add_comment', arguments: { identifier: fixtur, body: 'O5 utan giltig token' } };
    // Schemanamnet jämförs utan skiftläge (RFC 7235 avsnitt 2.1): bearer och BEARER bär en token, som här
    // är påhittad. Ett schema som bara börjar med Bearer, och Bearer utan token, bär ingen.
    const fall: [string, string | null, string][] = [
      ['utan huvudet', null, UTAN_TOKEN],
      ['en påhittad token', 'Bearer oauth-o5-pahittad-token', OGILTIG_TOKEN],
      ['en påhittad token med bearer i gemener', 'bearer oauth-o5-pahittad-token', OGILTIG_TOKEN],
      ['en påhittad token med BEARER i versaler', 'BEARER oauth-o5-pahittad-token', OGILTIG_TOKEN],
      ['ett Basic-huvud', 'Basic eA==', UTAN_TOKEN],
      ['ett schema som bara börjar med Bearer', 'Bearerx oauth-o5-pahittad-token', UTAN_TOKEN],
      ['Bearer utan token', 'Bearer', UTAN_TOKEN],
    ];
    for (const [namn, authorization, huvud] of fall) {
      const svar = await rpc(gateway, authorization, 'tools/call', params);
      expect(svar.status, namn).toBe(401);
      expect(svar.body, namn).toEqual({ error: 'unauthenticated' });
      expect(svar.headers['www-authenticate'], namn).toBe(huvud);
    }
    expect({ rader: await radbild(), anrop: rakna() }).toEqual(fore);
  });
});

describe('FR-24 (d)/Story 4.3 AK 2: OAuth-vägarnas gräns', () => {
  it('O6 (AK 2): varje OAuth-väg har en egen gräns, ingen väg äter en annans, och /mcp räknas för sig', async () => {
    // Varje väg med en begäran som varken når API:t eller utfärdar något: metadata ger 200, sidan utan fråga
    // felsidan, POST /authorize från ett främmande ursprung 403 och /token utan klient 401.
    type Svar = { status: number; body: unknown; headers: Record<string, string> };
    const vagar: [string, (app: express.Express) => PromiseLike<Svar>, number][] = [
      ['GET skyddsresursen', (app) => request(app).get('/.well-known/oauth-protected-resource'), 200],
      ['GET skyddsresursen för /mcp', (app) => request(app).get('/.well-known/oauth-protected-resource/mcp'), 200],
      ['GET auktoriseringsservern', (app) => request(app).get('/.well-known/oauth-authorization-server'), 200],
      ['GET /authorize', (app) => request(app).get('/authorize'), 400],
      [
        'POST /authorize',
        (app) => request(app).post('/authorize').set('Origin', 'https://evil.example').type('form').send(''),
        403,
      ],
      ['POST /token', (app) => request(app).post('/token').type('form').send('grant_type=refresh_token'), 401],
    ];
    const fore = rakna();
    for (const [namn, begar, status] of vagar) {
      // En egen OAuth-del med gränsen 2 för varje väg som prövas, och /mcp med en hög gräns.
      const smal = skapaOAuth({ klient: PROVKLIENT, apiUrl, grans: 2, nu });
      const app = skapaMcpApp({ apiUrl, nyckellager: smal.nyckellager, grans: 100_000, oauth: smal });
      for (let i = 1; i <= 2; i += 1) expect((await begar(app)).status, `${namn}, anrop ${i}`).toBe(status);
      const over = await begar(app);
      expect(over.status, namn).toBe(429);
      expect(over.body, namn).toEqual({ error: 'rate_limited' });
      expect(over.headers['retry-after'], namn).toMatch(/^\d+$/);

      // Varje annan OAuth-väg svarar som förut: anonym trafik mot en väg stänger aldrig en annan, som
      // Claudes förnyelse på /token eller Davids godkännande på /authorize.
      for (const [annan, begarAnnan, statusAnnan] of vagar) {
        if (annan !== namn) expect((await begarAnnan(app)).status, `${annan} efter ${namn}`).toBe(statusAnnan);
      }

      // /mcp har sin egen gräns: utan token fortfarande 401, inte 429.
      const mcpSvar = await rpc(app, null, 'tools/list');
      expect(mcpSvar.status, namn).toBe(401);
      expect(mcpSvar.body, namn).toEqual({ error: 'unauthenticated' });
    }
    expect(rakna()).toBe(fore);
  });
});

// ---- Uppgift 4: /authorize --------------------------------------------------------------------------------

describe('FR-24 (d)/Story 4.3 AK 6: auktoriseringssidan', () => {
  it('O7 (AK 6): sidan har rubrik, fält, knapp och metarad, är svensk och JS-fri, och varje värde går genom esc()', async () => {
    const fore = rakna();
    const falt = fragor({ state: 's7"><script>alert(1)</script>' });
    const svar = await hamtaSidan(falt);
    expect(svar.status).toBe(200);
    expect(svar.headers['content-type']).toMatch(/^text\/html/);
    expect(svar.text).toBe(sidan(falt));
    expect(svar.text).toContain('<input type=hidden name=state value="s7&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">');
    expect(svar.text).not.toContain('<script');
    expect(svar.text).not.toContain('p class=notis');
    expect(svar.text.match(/<form\b/g)).toHaveLength(1);

    expect(svar.headers['content-security-policy']).toBe(CSP);
    expect(svar.headers['cache-control']).toBe('no-store');
    expect(svar.headers['x-content-type-options']).toBe('nosniff');
    expect(svar.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');

    // Gatewayens esc() har husets kontrakt.
    for (const varde of [`&<>"'`, null, undefined, 'Människonyckel', 42]) {
      expect(esc(varde), String(varde)).toBe(husetsEsc(varde));
    }

    // Sidan anropar inte API:t.
    expect(rakna()).toBe(fore);
  });

  it('O10 (AK 6): POST /authorize från ett främmande ursprung avvisas med 403, utan anrop och utan kod', async () => {
    const fore = { anrop: rakna(), koder: oauth.hashar().koder };
    const fall: [string, Record<string, string>][] = [
      ['ett främmande ursprung', { Origin: 'https://evil.example' }],
      ['utgivarens värd med en annan port', { Origin: [U, '8443'].join(':') }],
      ['utgivarens värd med http', { Origin: 'http://prov.example' }],
      ['Origin null', { Origin: 'null' }],
      ['rätt Origin med Sec-Fetch-Site cross-site', { Origin: U, 'Sec-Fetch-Site': 'cross-site' }],
    ];
    for (const [namn, huvuden] of fall) {
      const svar = await godkann(david, {}, huvuden);
      expect(svar.status, namn).toBe(403);
      expect(svar.text, namn).toBe(felsidan(AVVISAD, FEL_URSPRUNG));
      expect(svar.headers['location'], namn).toBeUndefined();
    }
    expect(rakna()).toBe(fore.anrop);
    expect(oauth.hashar().koder).toEqual(fore.koder);

    // Kontroll sist: utan Origin och Sec-Fetch-Site, och med rätt Origin och same-origin, ger var sitt 303
    // med en kod (husets regel i kravSammaUrsprung()).
    for (const huvuden of [{}, { Origin: U, 'Sec-Fetch-Site': 'same-origin' }]) {
      const svar = await godkann(david, {}, huvuden);
      expect(svar.status, JSON.stringify(huvuden)).toBe(303);
      expect(new URL(svar.headers['location']!).searchParams.get('code'), JSON.stringify(huvuden)).toMatch(BASE64URL_43);
    }
  });
});

describe('FR-24 (d)/Story 4.3 AK 2: /authorize prövar klienten och adressen', () => {
  it('O8 (AK 2): en okänd klient och en adress utanför vitlistan ger en felsida; övriga fel går tillbaka till Claude', async () => {
    const fore = { anrop: rakna(), koder: oauth.hashar().koder };

    // Klienten: ett okänt id och ett id som står två gånger. Felsidan, ingen omdirigering.
    const tvaGanger = new URLSearchParams(fragor());
    tvaGanger.append('client_id', PROVKLIENT.client_id);
    for (const [namn, fragan] of [
      ['okänt klient-id', new URLSearchParams(fragor({ client_id: 'okand-klient' }))],
      ['klient-id två gånger', tvaGanger],
    ] as const) {
      const svar = await hamtaSidan(fragan);
      expect(svar.status, namn).toBe(400);
      expect(svar.text, namn).toBe(felsidan(KAN_INTE_GODKANNAS, OKAND_KLIENT));
      expect(svar.headers['location'], namn).toBeUndefined();
    }

    // Adressen: utanför vitlistan, med http, med en fråga och ingen alls. Felsidan, ingen omdirigering.
    for (const adress of [
      'https://evil.example/cb',
      'http://claude.ai/api/mcp/auth_callback',
      `${VITLISTA[0]}?x=1`,
      undefined,
    ]) {
      const svar = await hamtaSidan(fragor({ redirect_uri: adress }));
      expect(svar.status, String(adress)).toBe(400);
      expect(svar.text, String(adress)).toBe(felsidan(KAN_INTE_GODKANNAS, FEL_ADRESS));
      expect(svar.headers['location'], String(adress)).toBeUndefined();
    }

    // Övriga fel i frågan: 303 tillbaka till den vitlistade adressen med error och, när det är giltigt, state.
    const state = 'o8-state';
    const tillbaka = (fel: string, medState: boolean): string =>
      `${VITLISTA[0]}?${new URLSearchParams(medState ? { error: fel, state } : { error: fel }).toString()}`;

    const token = await hamtaSidan(fragor({ response_type: 'token', state }));
    expect(token.status).toBe(303);
    expect(token.headers['location']).toBe(tillbaka('unsupported_response_type', true));

    for (const over of [
      { code_challenge: undefined },
      { code_challenge_method: 'plain' },
      { code_challenge: 'a'.repeat(42) },
    ]) {
      const svar = await hamtaSidan(fragor({ ...over, state }));
      expect(svar.status, JSON.stringify(over)).toBe(303);
      expect(svar.headers['location'], JSON.stringify(over)).toBe(tillbaka('invalid_request', true));
    }

    const langtState = await hamtaSidan(fragor({ state: 's'.repeat(501) }));
    expect(langtState.status).toBe(303);
    expect(langtState.headers['location']).toBe(tillbaka('invalid_request', false));

    // Samma prövning på POST, före nyckeln: inget anrop till API:t.
    const post = await godkann(david, { response_type: 'token', state });
    expect(post.status).toBe(303);
    expect(post.headers['location']).toBe(tillbaka('unsupported_response_type', true));

    expect(rakna()).toBe(fore.anrop);
    expect(oauth.hashar().koder).toEqual(fore.koder);
  });
});

describe('FR-24 (d)/Story 4.3 AK 3: människonyckeln på /authorize', () => {
  it('O9 (AK 3): bara en människonyckel ger en kod, och det inskrivna värdet upprepas aldrig', async () => {
    const aterkallad = await nyNyckel({ typ: 'manniska', namn: 'oauth o9 återkallad' });
    const foreRader = await radbild();
    await aterkalla('oauth o9 återkallad');
    const foreKoder = oauth.hashar().koder.length;

    // En gateway vars OAuth-del frågar ett API som inte svarar.
    const stangdOAuth = skapaOAuth({ klient: PROVKLIENT, apiUrl: STANGD_PORT, grans: 100_000, nu });
    const stangd = skapaMcpApp({ apiUrl: STANGD_PORT, nyckellager: stangdOAuth.nyckellager, grans: 100_000, oauth: stangdOAuth });

    const falt = fragor({ state: 'o9-state' });
    const spion = konsolspion();
    try {
      /** Sidan och Location innehåller inte värdet, och inget anrop till konsolen gör det. */
      const inteUpprepat = (varde: string, svar: Awaited<ReturnType<typeof godkann>>, namn: string): void => {
        expect(svar.text.includes(varde), `${namn}: sidan`).toBe(false);
        expect((svar.headers['location'] ?? '').includes(varde), `${namn}: Location`).toBe(false);
        expect(spion.fynd(varde), `${namn}: konsolen`).toEqual([]);
      };

      // Människonyckeln: en kod, efter exakt ett anrop till vem_ar_jag med nyckeln som bearer.
      const fore = rakna();
      const manniska = await godkann(david, falt);
      expect(manniska.status).toBe(303);
      const adress = new URL(manniska.headers['location']!);
      expect(`${adress.origin}${adress.pathname}`).toBe(VITLISTA[0]);
      expect([...adress.searchParams.keys()]).toEqual(['code', 'state']);
      expect(adress.searchParams.get('code')).toMatch(BASE64URL_43);
      expect(adress.searchParams.get('state')).toBe('o9-state');
      expect(anrop.slice(fore)).toEqual([{ metod: 'POST', vag: '/api/actions/vem_ar_jag', auth: `Bearer ${david}` }]);
      expect(oauth.hashar().koder).toHaveLength(foreKoder + 1);
      inteUpprepat(david, manniska, 'människonyckeln');

      // Agent- och systemnyckeln: 403 och agentmeningen, formuläret igen utan nyckeln.
      for (const [namn, nyckel] of [
        ['agentnyckeln', agent],
        ['systemnyckeln', system],
      ] as const) {
        const svar = await godkann(nyckel, falt);
        expect(svar.status, namn).toBe(403);
        expect(svar.text, namn).toBe(sidan(falt, AGENTMENING));
        expect(svar.text, namn).not.toContain(NYCKELMENING);
        expect(svar.headers['location'], namn).toBeUndefined();
        inteUpprepat(nyckel, svar, namn);
      }

      // En påhittad och en återkallad nyckel: 401 och nyckelmeningen.
      for (const [namn, nyckel] of [
        ['en påhittad nyckel', 'oauth-o9-pahittad-nyckel'],
        ['en återkallad nyckel', aterkallad],
      ] as const) {
        const svar = await godkann(nyckel, falt);
        expect(svar.status, namn).toBe(401);
        expect(svar.text, namn).toBe(sidan(falt, NYCKELMENING));
        expect(svar.headers['location'], namn).toBeUndefined();
        inteUpprepat(nyckel, svar, namn);
      }

      // Nycklar utan nyckelns form: 401 och nyckelmeningen, utan något anrop till API:t.
      const foreForm = rakna();
      for (const [namn, nyckel] of [
        ['den tomma strängen', ''],
        ['ett blanksteg', 'ab cd'],
        ['201 tecken', 'n'.repeat(201)],
      ] as const) {
        const svar = await godkann(nyckel, falt);
        expect(svar.status, namn).toBe(401);
        expect(svar.text, namn).toBe(sidan(falt, NYCKELMENING));
        expect(svar.headers['location'], namn).toBeUndefined();
        // Den tomma strängen finns i varje text; för den prövas lösenordsfältet utan value.
        if (nyckel === '') expect(svar.text, namn).not.toMatch(/<input type=password[^>]*\bvalue=/);
        else inteUpprepat(nyckel, svar, namn);
      }
      expect(rakna()).toBe(foreForm);

      // Ett API som inte svarar: 503 och meningen för det.
      const ingetApi = await godkann(david, falt, { Origin: U }, stangd);
      expect(ingetApi.status).toBe(503);
      expect(ingetApi.text).toBe(sidan(falt, SVARADE_INTE));
      expect(ingetApi.headers['location']).toBeUndefined();
      inteUpprepat(david, ingetApi, 'ett API som inte svarar');
      expect(stangdOAuth.hashar().koder).toEqual([]);
    } finally {
      spion.aterstall();
    }

    // Bara människonyckeln gav en kod, och bara återkallelsen skrev en rad.
    expect(oauth.hashar().koder).toHaveLength(foreKoder + 1);
    expect(await radbild()).toEqual({ events: foreRader.events + 1, comments: foreRader.comments });
  });
});

// ---- Uppgift 5: /token, sessionen och hemligheterna ------------------------------------------------------

describe('FR-24 (d)/Story 4.3 AK 2, AK 3 och AK 4: hela flödet', () => {
  it('O11 (AK 2, AK 3 och AK 4): människonyckeln ger ett tokenpar, och sessionens add_comment bär nyckelns aktör', async () => {
    expect((await request(gateway).get('/.well-known/oauth-protected-resource')).body).toEqual(SKYDDSRESURS);
    expect((await request(gateway).get('/.well-known/oauth-authorization-server')).body).toEqual(AUKTORISERINGSSERVER);

    const { verifierare, utmaning } = pkce();
    const falt = fragor({ code_challenge: utmaning, state: 'o11-state' });
    expect((await hamtaSidan(falt)).status).toBe(200);

    // Aktörsfält i formuläret och vid växlingen läses aldrig (AK 4).
    const godkant = await godkann(david, { ...falt, aktor_typ: 'agent', aktor_namn: 'Någon annan' });
    expect(godkant.status).toBe(303);
    const kod = new URL(godkant.headers['location']!).searchParams.get('code') ?? '';
    expect(kod).toMatch(BASE64URL_43);

    const aktorsfalt = { aktor_typ: 'agent', aktor_namn: 'Någon annan' };
    const vaxlat = await vaxla(kod, verifierare, BASIC, aktorsfalt);
    expect(vaxlat.status, vaxlat.text).toBe(200);
    expect(Object.keys(vaxlat.body).sort()).toEqual(['access_token', 'expires_in', 'refresh_token', 'token_type']);
    expect(vaxlat.body.token_type).toBe('Bearer');
    expect(vaxlat.body.expires_in).toBe(3600);
    expect(vaxlat.body.access_token).toMatch(BASE64URL_43);
    expect(vaxlat.body.refresh_token).toMatch(BASE64URL_43);
    expect(vaxlat.body.access_token).not.toBe(vaxlat.body.refresh_token);
    expect(vaxlat.headers['cache-control']).toBe('no-store');
    expect(vaxlat.headers['pragma']).toBe('no-cache');
    const access: string = vaxlat.body.access_token;
    const refresh: string = vaxlat.body.refresh_token;

    const initiera = await mcp(access, 'initialize', { protocolVersion: '2025-06-18' });
    expect(initiera.status).toBe(200);
    expect(initiera.body.result.serverInfo.name).toBe('arenden');

    const kommentar = await mcp(access, 'tools/call', {
      name: 'add_comment',
      arguments: { identifier: fixtur, body: 'O11 genom OAuth' },
    });
    expect(kommentar.status).toBe(200);
    expect(kommentar.body.result.isError).toBe(false);
    expect(await senasteHandelse(fixtur)).toEqual({
      verb: 'kommenterade',
      aktor_typ: 'manniska',
      aktor_namn: 'oauth david',
    });
    const kommentarsrad = await pool.query<{ aktor_typ: string; aktor_namn: string }>(
      'SELECT aktor_typ, aktor_namn FROM comments WHERE body = $1',
      ['O11 genom OAuth'],
    );
    expect(kommentarsrad.rows).toEqual([{ aktor_typ: 'manniska', aktor_namn: 'oauth david' }]);

    // Förnyelse med klientautentiseringen i kroppen: ett nytt par, och den gamla refresh-token är förbrukad.
    // Aktörsfälten står med också här och läses lika lite (AK 4).
    const fornyat = await fornya(refresh, I_KROPPEN, gateway, aktorsfalt);
    expect(fornyat.status, fornyat.text).toBe(200);
    expect(fornyat.body.access_token).toMatch(BASE64URL_43);
    expect(fornyat.body.access_token).not.toBe(access);
    expect(fornyat.body.refresh_token).not.toBe(refresh);
    const igen = await fornya(refresh, I_KROPPEN);
    expect(igen.status).toBe(400);
    expect(igen.body).toEqual({ error: 'invalid_grant' });

    // Den nya access-token gäller, och den gamla gäller till sin tid.
    expect((await mcp(fornyat.body.access_token, 'tools/list')).status).toBe(200);
    expect((await mcp(access, 'tools/list')).status).toBe(200);

    // Den förnyade sessionen bär samma aktör: händelseraden är fortfarande människans.
    const efterFornyelsen = await mcp(fornyat.body.access_token, 'tools/call', {
      name: 'add_comment',
      arguments: { identifier: fixtur, body: 'O11 efter förnyelsen' },
    });
    expect(efterFornyelsen.body.result.isError).toBe(false);
    expect(await senasteHandelse(fixtur)).toEqual({
      verb: 'kommenterade',
      aktor_typ: 'manniska',
      aktor_namn: 'oauth david',
    });

    // Schemanamnen i Authorization jämförs utan skiftläge (RFC 7235 avsnitt 2.1), på /token och på /mcp.
    for (const schema of ['basic', 'BASIC', 'bAsIc']) {
      const k = await kodFor(david);
      const svar = await vaxla(k.kod, k.verifierare, {
        satt: 'basic',
        id: PROVKLIENT.client_id,
        hemlighet: PROVKLIENT.client_secret,
        schema,
      });
      expect(svar.status, `${schema}: ${svar.text}`).toBe(200);
      for (const bearer of ['bearer', 'BEARER', 'bEaReR']) {
        const lista = await rpc(gateway, `${bearer} ${svar.body.access_token}`, 'tools/list');
        expect(lista.status, `${schema} och ${bearer}`).toBe(200);
      }
    }
  });
});

describe('FR-24 (d)/Story 4.3 AK 2: /token avvisar utan token', () => {
  it('O12 (AK 2): fel verifierare, en använd kod, fel klient, fel adress, en gammal kod och fel grant_type ger ingen token', async () => {
    const avvisade: { text: string; body: Record<string, unknown> }[] = [];
    const avvisad = (svar: { status: number; text: string; body: Record<string, unknown> }, status: number, fel: string, namn: string) => {
      expect(svar.status, namn).toBe(status);
      expect(svar.body, namn).toEqual({ error: fel });
      avvisade.push(svar);
    };

    // Fel verifierare förbrukar koden: därefter avvisas också rätt verifierare.
    const a = await kodFor(david);
    avvisad(await vaxla(a.kod, pkce().verifierare), 400, 'invalid_grant', 'fel verifierare');
    avvisad(await vaxla(a.kod, a.verifierare), 400, 'invalid_grant', 'rätt verifierare efter fel');

    // En kod som redan växlats.
    const b = await kodFor(david);
    expect((await vaxla(b.kod, b.verifierare)).status).toBe(200);
    avvisad(await vaxla(b.kod, b.verifierare), 400, 'invalid_grant', 'en växlad kod');

    // Klienten prövas före koden: fel klient-id, fel hemlighet och ingen autentisering förbrukar inte koden.
    // Ett schema som bara börjar med Basic är ingen klientautentisering.
    const c = await kodFor(david);
    const felKlient: [string, Klientauth][] = [
      ['fel klient-id', { satt: 'basic', id: 'okand-klient', hemlighet: PROVKLIENT.client_secret }],
      ['fel hemlighet', { satt: 'basic', id: PROVKLIENT.client_id, hemlighet: `fel-hemlighet-${'y'.repeat(26)}` }],
      ['fel hemlighet i kroppen', { satt: 'post', id: PROVKLIENT.client_id, hemlighet: 'fel' }],
      ['ingen klientautentisering', null],
      [
        'ett schema som bara börjar med Basic',
        { satt: 'basic', id: PROVKLIENT.client_id, hemlighet: PROVKLIENT.client_secret, schema: 'Basicx' },
      ],
    ];
    for (const [namn, klientauth] of felKlient) {
      const svar = await vaxla(c.kod, c.verifierare, klientauth);
      avvisad(svar, 401, 'invalid_client', namn);
      expect(svar.headers['www-authenticate'], namn).toMatch(/^Basic/);
    }
    expect((await vaxla(c.kod, c.verifierare)).status).toBe(200);

    // Växlingen med den andra adressen ur vitlistan.
    const d = await kodFor(david);
    avvisad(await vaxla(d.kod, d.verifierare, BASIC, { redirect_uri: VITLISTA[1] }), 400, 'invalid_grant', 'en annan adress');

    // En kod vars tid gått.
    const e = await kodFor(david);
    klocka += 301_000;
    avvisad(await vaxla(e.kod, e.verifierare), 400, 'invalid_grant', 'en kod vars tid gått');

    // grant_type och en påhittad refresh-token.
    avvisad(await tokenbegaran({ grant_type: 'password' }), 400, 'unsupported_grant_type', 'password');
    avvisad(await tokenbegaran({ code: e.kod }), 400, 'invalid_request', 'utan grant_type');
    avvisad(await fornya('oauth-o12-pahittad-refresh'), 400, 'invalid_grant', 'en påhittad refresh-token');

    for (const svar of avvisade) {
      expect(svar.body).not.toHaveProperty('access_token');
      expect(svar.body).not.toHaveProperty('refresh_token');
      expect(svar.text).not.toContain('access_token');
    }
  });
});

describe('FR-24 (d)/Story 4.3 AK 1: en utgången token', () => {
  it('O13 (AK 1): en access-token vars timme gått ger 401 och noll rader, och refresh ger ett nytt par', async () => {
    const par = await flode(david);
    klocka += 3_601_000;

    const fore = { rader: await radbild(), anrop: rakna() };
    const anropen: [string, unknown][] = [
      ['initialize', { protocolVersion: '2025-06-18' }],
      ['tools/call', { name: 'add_comment', arguments: { identifier: fixtur, body: 'O13 med en utgången token' } }],
    ];
    for (const [metod, params] of anropen) {
      const svar = await mcp(par.access, metod, params);
      expect(svar.status, metod).toBe(401);
      expect(svar.body, metod).toEqual({ error: 'unauthenticated' });
      expect(svar.headers['www-authenticate'], metod).toBe(OGILTIG_TOKEN);
    }
    expect({ rader: await radbild(), anrop: rakna() }).toEqual(fore);

    const fornyat = await fornya(par.refresh);
    expect(fornyat.status, fornyat.text).toBe(200);
    expect((await mcp(fornyat.body.access_token, 'tools/list')).status).toBe(200);
  });
});

describe('FR-24 (d)/Story 4.3 AK 5: hemligheterna stannar på värden', () => {
  it('O14 (AK 5): bara sha256 i lagret, varken nyckeln eller hemligheten i ett svar eller i loggen, och en omstart kräver ny auktorisering', async () => {
    const spion = konsolspion();
    try {
      const svaren: { text?: string; headers: Record<string, unknown> }[] = [];
      svaren.push(await request(gateway).get('/.well-known/oauth-protected-resource'));
      svaren.push(await request(gateway).get('/.well-known/oauth-authorization-server'));
      const { verifierare, utmaning } = pkce();
      const falt = fragor({ code_challenge: utmaning });
      svaren.push(await hamtaSidan(falt));
      const godkant = await godkann(david, falt);
      svaren.push(godkant);
      const kod = new URL(godkant.headers['location']!).searchParams.get('code') ?? '';
      expect(kod).toMatch(BASE64URL_43);
      const vaxlat = await vaxla(kod, verifierare);
      expect(vaxlat.status).toBe(200);
      svaren.push(vaxlat);
      const access: string = vaxlat.body.access_token;
      const refresh: string = vaxlat.body.refresh_token;
      const kommentar = await mcp(access, 'tools/call', {
        name: 'add_comment',
        arguments: { identifier: fixtur, body: 'O14 genom sessionen' },
      });
      expect(kommentar.body.result.isError).toBe(false);
      svaren.push(kommentar);
      // Förnyelsen hör till flödet: dess svar och dess tokens prövas som de första.
      const fornyat = await fornya(refresh);
      expect(fornyat.status).toBe(200);
      svaren.push(fornyat);
      const nyAccess: string = fornyat.body.access_token;
      const nyRefresh: string = fornyat.body.refresh_token;

      // Lagret: bara sha256 i hex, aldrig koden eller tokens själva; den växlade kodens hash och den
      // roterade refresh-tokens hash är borta.
      const hashar = oauth.hashar();
      const alla = [...hashar.koder, ...hashar.access, ...hashar.refresh];
      expect(alla.filter((h) => !/^[0-9a-f]{64}$/.test(h))).toEqual([]);
      expect(hashar.access).toContain(sha256(access));
      expect(hashar.access).toContain(sha256(nyAccess));
      expect(hashar.refresh).toContain(sha256(nyRefresh));
      expect(hashar.refresh).not.toContain(sha256(refresh));
      expect(hashar.koder).not.toContain(sha256(kod));
      for (const varde of [access, refresh, kod, nyAccess, nyRefresh]) expect(alla).not.toContain(varde);

      // Inget svar bär nyckeln eller hemligheten, och inget anrop till konsolen bär någon av hemligheterna.
      for (const svar of svaren) {
        expect(samla(svar)).not.toContain(david);
        expect(samla(svar)).not.toContain(PROVKLIENT.client_secret);
      }
      for (const varde of [david, access, refresh, kod, nyAccess, nyRefresh, PROVKLIENT.client_secret]) {
        expect(spion.fynd(varde)).toEqual([]);
      }

      // En omstart: en ny OAuth-del känner varken access-token eller den gällande refresh-token.
      const omstartad = skapaOAuth({ klient: PROVKLIENT, apiUrl, grans: 100_000, nu });
      const ny = skapaMcpApp({ apiUrl, nyckellager: omstartad.nyckellager, grans: 100_000, oauth: omstartad });
      const gammal = await mcp(nyAccess, 'tools/list', undefined, ny);
      expect(gammal.status).toBe(401);
      expect(gammal.headers['www-authenticate']).toBe(OGILTIG_TOKEN);
      const gammalRefresh = await fornya(nyRefresh, BASIC, ny);
      expect(gammalRefresh.status).toBe(400);
      expect(gammalRefresh.body).toEqual({ error: 'invalid_grant' });

      // Kontroll: samma tokens gäller i den gamla instansen, så avvisningen ovan kom av omstarten.
      expect((await mcp(nyAccess, 'tools/list')).status).toBe(200);
      expect((await fornya(nyRefresh)).status).toBe(200);
    } finally {
      spion.aterstall();
    }

    // Statiskt: OAuth-delen har ingen loggrad.
    const text = readFileSync(path.join(fileURLToPath(new URL('../', import.meta.url)), 'src/mcp/oauth.ts'), 'utf8');
    expect(text).not.toContain('console.');
  });
});

// ---- Uppgift 6: återkallelsen -----------------------------------------------------------------------------

describe('FR-24 (d)/Story 4.3 AK 4: återkallelse biter', () => {
  /** get_issue på fixturärendet; en funktion, eftersom fixturen sätts först i beforeAll. */
  const las = () => ({ name: 'get_issue', arguments: { identifier: fixtur } });

  it('O15 (AK 4): när nyckeln återkallas ger nästa verktygsanrop 401 och noll rader, och sessionen är död', async () => {
    const nyckel = await nyNyckel({ typ: 'manniska', namn: 'oauth o15' });
    const par = await flode(nyckel);
    // Den andra sessionen finns FÖRE återkallelsen, så att en glom() som tog bort mer än sessionen fälls.
    const annan = await flode(david);

    // Kontroll först: båda sessionerna fungerar.
    for (const [namn, access] of [
      ['sessionen', par.access],
      ['den andra sessionen', annan.access],
    ] as const) {
      const kontroll = await mcp(access, 'tools/call', las());
      expect(kontroll.status, namn).toBe(200);
      expect(kontroll.body.result.isError, namn).toBe(false);
    }

    // Återkallelsen går direkt mot appen och räknas inte.
    await aterkalla('oauth o15');
    const fore = { rader: await radbild(), anrop: rakna() };

    const skriv = { name: 'add_comment', arguments: { identifier: fixtur, body: 'O15 efter återkallelsen' } };
    const svar = await mcp(par.access, 'tools/call', skriv);
    expect(svar.status).toBe(401);
    expect(svar.body).toEqual({ error: 'unauthenticated' });
    expect(svar.headers['www-authenticate']).toBe(OGILTIG_TOKEN);
    // Exakt ett anrop nådde API:t (och fick 401), och ingen rad skrevs.
    expect(anrop.slice(fore.anrop)).toEqual([
      { metod: 'POST', vag: '/api/actions/add_comment', auth: `Bearer ${nyckel}` },
    ]);
    expect(await radbild()).toEqual(fore.rader);

    // Samma token igen: 401 utan nytt anrop. Sessionens refresh-token är död.
    const igen = await mcp(par.access, 'tools/call', skriv);
    expect(igen.status).toBe(401);
    expect(igen.headers['www-authenticate']).toBe(OGILTIG_TOKEN);
    expect(rakna()).toBe(fore.anrop + 1);
    const fornyat = await fornya(par.refresh);
    expect(fornyat.status).toBe(400);
    expect(fornyat.body).toEqual({ error: 'invalid_grant' });

    // Lagret har ingen hash kvar för sessionen, men den andra sessionens hashar står kvar.
    const hashar = oauth.hashar();
    expect(hashar.access).not.toContain(sha256(par.access));
    expect(hashar.refresh).not.toContain(sha256(par.refresh));
    expect(hashar.access).toContain(sha256(annan.access));
    expect(hashar.refresh).toContain(sha256(annan.refresh));
    expect(await radbild()).toEqual(fore.rader);

    // Kontroll sist: den andra sessionen, som fanns före återkallelsen, fungerar som förut, och dess
    // refresh-token går att förnya.
    expect((await mcp(annan.access, 'tools/list')).status).toBe(200);
    const annanLaser = await mcp(annan.access, 'tools/call', las());
    expect(annanLaser.status).toBe(200);
    expect(annanLaser.body.result.isError).toBe(false);
    const annanFornyad = await fornya(annan.refresh);
    expect(annanFornyad.status, annanFornyad.text).toBe(200);
    const annanEfter = await mcp(annanFornyad.body.access_token, 'tools/call', las());
    expect(annanEfter.status).toBe(200);
    expect(annanEfter.body.result.isError).toBe(false);
  });

  it('O15 (AK 4): sessionen glöms också när access-posten försvinner medan API-anropet pågår', async () => {
    // glom() tar sessionen som uppslaget gav, inte en ny uppslagning av token. Två vägar tar bort en
    // access-post vars tid gått medan API:t svarar: en annan begäran med samma token (nyckelFor()) och en
    // samtidig begäran till /token (rensa()).
    const ingreppen: [string, (access: string) => Promise<unknown>][] = [
      ['en annan begäran med samma token', async (access) => mcp(access, 'ping')],
      ['en samtidig begäran till /token', async () => tokenbegaran({ grant_type: 'password' })],
    ];
    for (const [i, [namn, ingrepp]] of ingreppen.entries()) {
      const nyckelnsNamn = `oauth o15 under anropet ${i + 1}`;
      const nyckel = await nyNyckel({ typ: 'manniska', namn: nyckelnsNamn });
      const par = await flode(nyckel);
      const annan = await flode(david);
      await aterkalla(nyckelnsNamn);
      const fore = await radbild();

      // Medan API:t tar emot add_comment går access-tokens timme ut, och ingreppet tar bort posten.
      let postenBorta = false;
      underAnropet = async () => {
        klocka += 3_601_000;
        await ingrepp(par.access);
        postenBorta = !oauth.hashar().access.includes(sha256(par.access));
      };
      const svar = await mcp(par.access, 'tools/call', {
        name: 'add_comment',
        arguments: { identifier: fixtur, body: `O15 under anropet ${i + 1}` },
      });
      expect(underAnropet, namn).toBeUndefined();
      expect(postenBorta, `${namn}: access-posten var borta före svaret`).toBe(true);
      expect(svar.status, namn).toBe(401);
      expect(svar.body, namn).toEqual({ error: 'unauthenticated' });
      expect(svar.headers['www-authenticate'], namn).toBe(OGILTIG_TOKEN);
      expect(await radbild(), namn).toEqual(fore);

      // Sessionens refresh-token dog med sessionen, fast access-posten redan var borta.
      expect(oauth.hashar().refresh, namn).not.toContain(sha256(par.refresh));
      const fornyat = await fornya(par.refresh);
      expect(fornyat.status, namn).toBe(400);
      expect(fornyat.body, namn).toEqual({ error: 'invalid_grant' });

      // Kontroll: den andra sessionen, som fanns före, lever. Dess access-token har gått ut med klockan,
      // men dess refresh-token ger ett nytt par.
      const annanFornyad = await fornya(annan.refresh);
      expect(annanFornyad.status, `${namn}: ${annanFornyad.text}`).toBe(200);
      const annanLaser = await mcp(annanFornyad.body.access_token, 'tools/call', las());
      expect(annanLaser.body.result.isError, namn).toBe(false);
    }
  });
});
