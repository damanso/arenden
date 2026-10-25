// FR-41, FR-6 och FR-4, Story 8.1: David lägger till ett eget ärende från en Claude-session.
//
// Filen prövar hela vägen för ett nytt ärende: Davids människonyckel genom OAuth till MCP-gatewayen,
// verktyget create_issue till API:t, händelseraden och kortet i /vy/mitt.
// Kriterierna, som granskaren kan läsa av här:
//   AK 1  människonyckeln skapar ett ärende med nästa LOC-nummer och en skapade_arende-rad med människan
//         (E1);
//   AK 2  utan token, med en påhittad och med en utgången token ger gatewayen 401 och noll rader (E2);
//   AK 3  ett befintligt projekt kopplas, och ett okänt avvisas med API:ts felkod projektet_finns_inte
//         utan projekt, ärende, händelserad eller förbrukat nummer (E4, E5);
//   AK 4  ärendet från gatewayen står under Du skrev sist i /vy/mitt med människa · <namn> (E6);
//   AK 5  OAuth-sessionens create_issue bär Davids människo-aktör, och vyn får inget formulär (E3, E7).
//
// Mekanismerna, och fallistorna som prövas här, är hela listan:
//   - Aktören har en enda väg in: API:t tar den ur den autentiserade nyckeln, create_issue har ett strikt
//     schema utan aktörsfält, gatewayens indata är en tillåtelselista utan aktörsfält, och /authorize ger
//     bara en kod för en människonyckel. Fallen: E1, E3 och test/mcp-oauth.test.ts O9.
//   - Bearerkontrollen i skapaMcpApp() står före kroppens tolkning och före varje API-anrop. Fallen: E2,
//     med de tre formerna i AK 2 och inga fler.
//   - skapaArende() slår upp projektet med sokProjekt(), som aldrig skapar, före numret och före varje
//     skrivning. Fallen: E4 (genom gatewayen) och E5 (direkt mot API:t).
//   - Rutterna är en sluten mängd, som test/adresskontrakt.test.ts jämför med kontraktet. Fallen: E7.
//
// Ingen vi.mock och ingen attrapp av API:t: testservern är den riktiga appen, createApp() framför
// testdatabasen, på loopback med en port som systemet väljer. Hjälparna ur test/mcp-oauth.test.ts är
// kopierade, eftersom en provfil inte importerar ur en annan.
import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { OAUTHKONFIG, skapaOAuth } from '../src/mcp/oauth.js';
import { skapaMcpApp } from '../src/mcp/server.js';
import { hamtaEllerSkapaProjekt } from '../src/services/arenden.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

// ---- Fixturen: testservern med räknaren, nycklarna och gatewayen ---------------------------------------

const DAVID = 'David Mancilla';
const AGENT = 'eget agent';

/** Varje anrop som testservern fått genom `bas`. Provets egna anrop går direkt mot `api` och räknas inte. */
const anrop: { metod: string; vag: string; auth: string | null }[] = [];

/** Provklienten: klientfilens form med 40 tecken hemlighet ur base64url och provets utgivare. */
const PROVKLIENT = Object.freeze({
  client_id: 'claude-prov',
  client_secret: `prov-hemlighet-${'x'.repeat(25)}`,
  utgivare: 'https://prov.example',
});

const U = PROVKLIENT.utgivare;
const VITLISTA = OAUTHKONFIG.REDIRECT_VITLISTA;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

/** Klockan som OAuth-delen läser. Den flyttas bara framåt i filen, aldrig tillbaka. */
let klocka = Date.now();
const nu = (): number => klocka;

let api: express.Express;
let server: Server;
let apiUrl: string;
let david: string;
let agent: string;
let oauth: ReturnType<typeof skapaOAuth>;
let gateway: express.Express;

beforeAll(async () => {
  await seedaTeam();
  david = await nyNyckel({ typ: 'manniska', namn: DAVID });
  agent = await nyNyckel({ typ: 'agent', namn: AGENT });
  // Projektet som E4 kopplar. Bara fixturen skapar projekt; create_issue slår bara upp (FR-6, beslut #27).
  await withTransaction((client) => hamtaEllerSkapaProjekt(client, TENANT_ID, 'NVR-001'));

  // Testservern: den riktiga appen bakom en räknare, på loopback med en port som systemet väljer.
  api = createApp();
  const bas = express();
  bas.use((req, _res, next) => {
    anrop.push({ metod: req.method, vag: req.originalUrl, auth: req.headers.authorization ?? null });
    next();
  });
  bas.use(api);
  server = bas.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  // OAuth-delen med provklienten och klockan, och gatewayen med den. Gränserna är höga: ingen räknas här.
  oauth = skapaOAuth({ klient: PROVKLIENT, apiUrl, grans: 100_000, nu });
  gateway = skapaMcpApp({ apiUrl, nyckellager: oauth.nyckellager, grans: 100_000, oauth });
});

afterAll(async () => {
  await new Promise<void>((klar) => {
    server.close(() => klar());
    server.closeAllConnections();
  });
});

// ---- OAuth-hjälparna, kopierade ur test/mcp-oauth.test.ts ------------------------------------------------

/** En JSON-RPC-begäran mot `app` på /mcp, med huvudet Authorization som det står (null: utan huvudet). */
function rpc(app: express.Express, authorization: string | null, metod: string, params?: unknown) {
  let anropet = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream');
  if (authorization !== null) anropet = anropet.set('Authorization', authorization);
  return anropet.send({ jsonrpc: '2.0', id: 1, method: metod, params });
}

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

/** Klientautentiseringen i huvudet (client_secret_basic), den enda som provet använder. */
const BASIC = { id: PROVKLIENT.client_id, hemlighet: PROVKLIENT.client_secret };

/** POST /token som formulär med fälten (undefined utelämnas) och klientautentiseringen i huvudet. */
function tokenbegaran(falt: Record<string, string | undefined>, app: express.Express = gateway) {
  const kropp: Record<string, string> = {};
  for (const [namn, varde] of Object.entries(falt)) if (varde !== undefined) kropp[namn] = varde;
  const par = `${encodeURIComponent(BASIC.id)}:${encodeURIComponent(BASIC.hemlighet)}`;
  return request(app)
    .post('/token')
    .type('form')
    .set('Authorization', `Basic ${Buffer.from(par).toString('base64')}`)
    .send(new URLSearchParams(kropp).toString());
}

/** Växlar en kod vid /token med klientautentiseringen i huvudet. */
function vaxla(kod: string, verifierare: string) {
  return tokenbegaran({
    grant_type: 'authorization_code',
    code: kod,
    redirect_uri: VITLISTA[0],
    code_verifier: verifierare,
  });
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

// ---- Provets egna hjälpare -------------------------------------------------------------------------------

/** Verktyget create_issue genom gatewayen, med sessionens token som bearer. */
function skapaGenomGatewayen(token: string, argument: Record<string, unknown>) {
  return mcp(token, 'tools/call', { name: 'create_issue', arguments: argument });
}

/** Identifieraren ur verktygsresultatet: texten är API:ts `result` som JSON (tolkaSvar() i verktyg.ts). */
function identifierUr(svar: { body: { result: { content: { text: string }[] } } }): string {
  return JSON.parse(svar.body.result.content[0]!.text).identifier;
}

/** Raderna som ett avvisat anrop inte får röra. */
async function radbild(): Promise<{ issues: number; events: number; projects: number }> {
  return {
    issues: await raknaRader('issues'),
    events: await raknaRader('events'),
    projects: await raknaRader('projects'),
  };
}

/**
 * Ärendets händelserader med verbet skapade_arende, i ordning, som aktörstyp och aktörsnamn. Ärendet slås
 * upp ur teamets nyckel och numret, som senasteHandelse() i test/mcp-oauth.test.ts.
 */
async function skapadeHandelser(identifier: string): Promise<{ aktor_typ: string; aktor_namn: string }[]> {
  const { rows } = await pool.query<{ aktor_typ: string; aktor_namn: string }>(
    `SELECT e.aktor_typ, e.aktor_namn
       FROM events e
       JOIN issues i ON i.id = e.issue_id
       JOIN teams t ON t.id = i.team_id
      WHERE t.key || '-' || i.sequence_number = $1
        AND e.verb = 'skapade_arende'
      ORDER BY e.id`,
    [identifier],
  );
  return rows;
}

/** Det högsta numret i teamet LOC, 0 när teamet saknar ärenden. */
async function hogstaNummer(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT coalesce(max(i.sequence_number), 0)::text AS n
       FROM issues i
       JOIN teams t ON t.id = i.team_id
      WHERE t.key = 'LOC'`,
  );
  return Number(rows[0]!.n);
}

/** Avsnittet Du skrev sist i /vy/mitt: texten efter rubriken fram till nästa h2, '' om rubriken saknas. */
function avsnittDuSkrevSist(html: string): string {
  const delar = html.split('Du skrev sist');
  if (delar.length < 2) return '';
  return delar[1]!.split('<h2>')[0]!;
}

/**
 * Ärendets kort i avsnittet, från `<a class=kort` till och med `</a>`, '' om avsnittet saknar det. Kortets
 * rubrik är `<b>` följt av identifieraren och « — », så att LOC-1 aldrig träffar kortet för LOC-10.
 */
function kortFor(avsnitt: string, identifier: string): string {
  const MARKE = '<a class=kort';
  const del = avsnitt.split(MARKE).slice(1).find((d) => d.includes(`<b>${identifier} — `));
  if (del === undefined) return '';
  const slut = del.indexOf('</a>');
  return MARKE + (slut === -1 ? del : del.slice(0, slut + '</a>'.length));
}

/** Antalet formulär i sidan: `<form` följt av ett blanktecken eller `>`. */
function antalFormular(html: string): number {
  return (html.match(/<form[\s>]/g) ?? []).length;
}

// ---- Uppgift 1: människonyckeln, tokenkontrollen och Claude-vägen ---------------------------------------

describe('FR-41/FR-4/Story 8.1 AK 1: människonyckeln skapar ett människoärende', () => {
  it('E1 (AK 1): create_issue med Davids nyckel får nästa LOC-nummer och en skapade_arende-rad med människan', async () => {
    const hogsta = await hogstaNummer();
    const svar = await kor(api, david, 'create_issue', { title: 'E1 eget ärende', team_key: 'LOC' });
    expect(svar.status, svar.text).toBe(200);
    const identifier: string = svar.body.result.identifier;
    expect(identifier).toBe(`LOC-${hogsta + 1}`);
    expect(await skapadeHandelser(identifier)).toEqual([{ aktor_typ: 'manniska', aktor_namn: DAVID }]);

    // Kontrollen: en agentnyckel ger en agentrad, så mätningen skiljer aktörerna åt.
    const kontroll = await kor(api, agent, 'create_issue', { title: 'E1 kontroll', team_key: 'LOC' });
    expect(kontroll.status, kontroll.text).toBe(200);
    expect(await skapadeHandelser(kontroll.body.result.identifier)).toEqual([
      { aktor_typ: 'agent', aktor_namn: AGENT },
    ]);
  });
});

describe('FR-41/Story 8.1 AK 2: utan giltig token skapas inget ärende', () => {
  it('E2 (AK 2): utan token, med en påhittad och med en utgången token ger create_issue 401 och noll rader', async () => {
    const gammal = await flode(david);
    klocka += 3_601_000;

    const fore = { rader: await radbild(), anrop: anrop.length };
    const params = { name: 'create_issue', arguments: { title: 'E2 nej', team_key: 'LOC' } };
    const fall: [string, string | null][] = [
      ['utan huvudet', null],
      ['en påhittad token', 'Bearer e2-pahittad-token'],
      ['en utgången token', `Bearer ${gammal.access}`],
    ];
    for (const [namn, authorization] of fall) {
      const svar = await rpc(gateway, authorization, 'tools/call', params);
      expect(svar.status, namn).toBe(401);
      expect(svar.body, namn).toEqual({ error: 'unauthenticated' });
    }
    expect({ rader: await radbild(), anrop: anrop.length }).toEqual(fore);

    // Kontrollen: samma anrop med en giltig token skapar exakt ett ärende och en händelserad, så räkningen
    // kan se ett skapande.
    const ny = await flode(david);
    const kontroll = await skapaGenomGatewayen(ny.access, { title: 'E2 kontroll', team_key: 'LOC' });
    expect(kontroll.status, kontroll.text).toBe(200);
    expect(kontroll.body.result.isError).toBe(false);
    expect(await radbild()).toEqual({
      issues: fore.rader.issues + 1,
      events: fore.rader.events + 1,
      projects: fore.rader.projects,
    });
  });
});

describe('FR-41/Story 8.1 AK 5: Claude-sessionen bär Davids människo-aktör', () => {
  it('E3 (AK 5): OAuth-sessionens create_issue bokförs på människan, och aktörsfält avvisas utan anrop', async () => {
    const { access } = await flode(david);
    const initiera = await mcp(access, 'initialize', { protocolVersion: '2025-06-18' });
    expect(initiera.status).toBe(200);
    expect(initiera.body.result.serverInfo.name).toBe('arenden');

    const fore = anrop.length;
    const svar = await skapaGenomGatewayen(access, { title: 'E3 genom Claude-kopplingen', team_key: 'LOC' });
    expect(svar.status, svar.text).toBe(200);
    expect(svar.body.result.isError).toBe(false);
    const identifier = identifierUr(svar);
    expect(await skapadeHandelser(identifier)).toEqual([{ aktor_typ: 'manniska', aktor_namn: DAVID }]);
    expect(anrop.slice(fore)).toEqual([
      { metod: 'POST', vag: '/api/actions/create_issue', auth: `Bearer ${david}` },
    ]);

    // Aktörsfälten står inte i verktygets tillåtelselista: JSON-RPC-felet −32602, inget anrop och noll rader.
    const foreAvvisat = { rader: await radbild(), anrop: anrop.length };
    const avvisat = await skapaGenomGatewayen(access, {
      title: 'E3 genom Claude-kopplingen',
      team_key: 'LOC',
      aktor_typ: 'agent',
      aktor_namn: 'hermes',
    });
    expect(avvisat.status).toBe(200);
    expect(avvisat.body).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'Fält som verktyget inte tar emot: aktor_typ, aktor_namn.' },
    });
    expect({ rader: await radbild(), anrop: anrop.length }).toEqual(foreAvvisat);
  });
});

// ---- Uppgift 2: projektet valideras, skapas aldrig ------------------------------------------------------

describe('FR-6/FR-41/Story 8.1 AK 3: projektet valideras genom gatewayen', () => {
  it('E4 (AK 3): ett befintligt projekt kopplas, och ett okänt ger verktygsfelet med API:ts felkod och noll rader', async () => {
    const { access } = await flode(david);
    const med = await skapaGenomGatewayen(access, { title: 'E4 med projekt', team_key: 'LOC', projekt: 'NVR-001' });
    expect(med.status, med.text).toBe(200);
    expect(med.body.result.isError).toBe(false);
    const hamtat = await mcp(access, 'tools/call', { name: 'get_issue', arguments: { identifier: identifierUr(med) } });
    expect(hamtat.status, hamtat.text).toBe(200);
    expect(hamtat.body.result.isError).toBe(false);
    expect(JSON.parse(hamtat.body.result.content[0].text).arende.projekt).toBe('NVR-001');

    const fore = await radbild();
    const okant = await skapaGenomGatewayen(access, {
      title: 'E4 okänt projekt',
      team_key: 'LOC',
      projekt: 'E4-finns-inte',
    });
    expect(okant.status, okant.text).toBe(200);
    expect(okant.body.result.isError).toBe(true);
    expect(okant.body.result.content).toEqual([
      { type: 'text', text: 'Ärende-API:t svarade 400 med felkoden projektet_finns_inte.' },
    ]);
    expect(await radbild()).toEqual(fore);
  });
});

describe('FR-6/Story 8.1 AK 3: projektet valideras direkt mot API:t', () => {
  it('E5 (AK 3): ett okänt projekt ger 400 projektet_finns_inte, noll rader och inget förbrukat nummer', async () => {
    const hogsta = await hogstaNummer();
    const fore = await radbild();
    const okant = await kor(api, david, 'create_issue', {
      title: 'E5 okänt projekt',
      team_key: 'LOC',
      projekt: 'E5-finns-inte',
    });
    expect(okant.status, okant.text).toBe(400);
    expect(okant.body).toEqual({ error: 'projektet_finns_inte' });
    expect(await radbild()).toEqual(fore);

    // Nästa ärende får numret efter det högsta före det avvisade anropet: inget nummer förbrukades.
    const nasta = await kor(api, david, 'create_issue', { title: 'E5 nästa', team_key: 'LOC' });
    expect(nasta.status, nasta.text).toBe(200);
    expect(nasta.body.result.identifier).toBe(`LOC-${hogsta + 1}`);
  });
});

// ---- Uppgift 3: kortet i /vy/mitt och vyn utan formulär --------------------------------------------------

describe('FR-41/Story 8.1 AK 4: ärendet syns där David tittar', () => {
  it('E6 (AK 4): ärendet från gatewayen står under Du skrev sist med människa · David Mancilla', async () => {
    const { access } = await flode(david);
    const skapat = await skapaGenomGatewayen(access, { title: 'E6 syns i Vad ligger på mig', team_key: 'LOC' });
    expect(skapat.status, skapat.text).toBe(200);
    expect(skapat.body.result.isError).toBe(false);
    const davids = identifierUr(skapat);

    // Kontrollen: ett ärende som agenten skapat.
    const kontroll = await kor(api, agent, 'create_issue', { title: 'E6 kontroll', team_key: 'LOC' });
    expect(kontroll.status, kontroll.text).toBe(200);
    const agentens: string = kontroll.body.result.identifier;

    // ?aktor= väljer aktören som sessionen annars hade valt (src/http/routes/vy.ts, /mitt).
    const davidsSida = await request(api).get('/vy/mitt?aktor=David%20Mancilla');
    const agentensSida = await request(api).get('/vy/mitt?aktor=eget%20agent');
    expect(davidsSida.status).toBe(200);
    expect(agentensSida.status).toBe(200);

    // Kortet läses för sig: sidans hörn kan bära den inloggades proveniens.
    const davidsAvsnitt = avsnittDuSkrevSist(davidsSida.text);
    const kortet = kortFor(davidsAvsnitt, davids);
    expect(kortet).toContain(`${davids} — E6 syns i Vad ligger på mig`);
    expect(kortet).toContain('människa · David Mancilla');
    expect(kortFor(davidsAvsnitt, agentens)).toBe('');

    const agentkortet = kortFor(avsnittDuSkrevSist(agentensSida.text), agentens);
    expect(agentkortet).toContain(`${agentens} — E6 kontroll`);
    expect(agentkortet).toContain('agent · eget agent');
  });
});

describe('FR-41/Story 8.1 AK 5: vyn får inget formulär', () => {
  it('E7 (AK 5): /vy/mitt utan och med Davids namn har inget formulär, och inloggningssidan har ett', async () => {
    for (const adress of ['/vy/mitt', '/vy/mitt?aktor=David%20Mancilla']) {
      const svar = await request(api).get(adress);
      expect(svar.status, adress).toBe(200);
      expect(antalFormular(svar.text), adress).toBe(0);
    }

    // Kontrollen: inloggningssidan har ett formulär, så räkningen ser ett när det finns.
    const inloggning = await request(api).get('/vy/logga-in');
    expect(inloggning.status).toBe(200);
    expect(antalFormular(inloggning.text)).toBeGreaterThanOrEqual(1);
  });
});
