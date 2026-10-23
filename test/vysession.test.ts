// FR-14 och FR-4, B-03/Story 3.4: vyns session föds bara ur människonyckeln.
// AK 1 (V1–V2): redovisningskakan ger läsläge och 401 utan skrivning; ingen annan sessionskälla.
// AK 2 (V3–V4): adressen saknas i konfiguration och källträd; README bär samma regel.
// AK 3 (V5): människonyckeln fungerar, agent/system och påhittad token avvisas.
// Slutna fallistor och kontroller i varje fall visar att mätningarna kan slå ut.
// Adressnamnet byggs av delar för nollträffskravet i AK 2. Stubben är husets riktiga
// räknarserver i provprocessen, med det namnsvar som AK 1 kräver; appen ersätts aldrig.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const ROT = fileURLToPath(new URL('../', import.meta.url));
const ADRESSNAMN = ['REDOVISNING', 'URL'].join('_');
const REDOVISNINGSKAKA = 'session=f34-redovisningskaka';
const INLOGGNINGSHORN = '<a class=jag href="/vy/logga-in">Logga in</a>';
let stubben: Server;
let stubbbas: string;
let stubbanrop = 0;
let app: Express;
let session: typeof import('../src/http/vy/session.js');
let EnvSchema: typeof import('../src/config.js')['EnvSchema'];
let config: typeof import('../src/config.js')['config'];
let kor: typeof import('./helpers.js')['kor'];
let raknaRader: typeof import('./helpers.js')['raknaRader'];
let pool: typeof import('../src/db/pool.js')['pool'];
let manniskonyckel: string;
let agentnyckel: string;
let systemnyckel: string;
let identifier: string;
let arendesida: string;

beforeAll(async () => {
  stubben = createServer((req, res) => {
    stubbanrop += 1;
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url === '/api/session/vem') {
      res.writeHead(200).end(JSON.stringify({ namn: 'f34 redovisningsmänniska' }));
    } else {
      res.writeHead(500).end(JSON.stringify({ error: 'raknaren' }));
    }
  });
  await new Promise<void>((klar) => stubben.listen(0, '127.0.0.1', klar));
  stubbbas = `http://127.0.0.1:${(stubben.address() as AddressInfo).port}`;
  process.env[ADRESSNAMN] = stubbbas;
  vi.resetModules();
  const { createApp } = await import('../src/http/app.js');
  session = await import('../src/http/vy/session.js');
  ({ EnvSchema, config } = await import('../src/config.js'));
  const hjalpare = await import('./helpers.js');
  ({ kor, raknaRader } = hjalpare);
  ({ pool } = await import('../src/db/pool.js'));
  app = createApp();
  session.glomAllaSessioner();
  await hjalpare.seedaTeam();
  manniskonyckel = await hjalpare.nyNyckel({ typ: 'manniska', namn: 'f34 människa' });
  agentnyckel = await hjalpare.nyNyckel({ typ: 'agent', namn: 'f34 agent' });
  systemnyckel = await hjalpare.nyNyckel({ typ: 'system', namn: 'f34 system' });
  const skapat = await kor(app, agentnyckel, 'create_issue', {
    title: 'F34 ärende', team_key: 'LOC', description: 'F34 beskrivning',
  });
  expect(skapat.status, skapat.text).toBe(200);
  identifier = skapat.body.result.identifier;
  arendesida = `/vy/arende/${identifier}`;
});

afterAll(async () => {
  if (stubben) await new Promise<void>((klar, fel) => stubben.close((err) => err ? fel(err) : klar()));
  delete process.env[ADRESSNAMN];
});

function hornet(html: string): string | null {
  return html.match(/<div class=hornet>([\s\S]*?)<span class=tid>/)?.[1] ?? null;
}

function kakaUr(svar: request.Response): string | undefined {
  return [svar.headers['set-cookie'] ?? []].flat().map(String)
    .find((kaka) => kaka.startsWith('arenden_vy='))?.split(';')[0];
}

interface Kallfil { fil: string; text: string }
const REDOVISNINGSVAGENS_TEXTER = [
  'medRedovisningssession', 'redovisningsAktor', 'redovisningsaktor',
  'REDOVISNINGEN', '/api/session/vem', 'express-serve-static-core',
];

function redovisningsvagensFynd(filer: Kallfil[]): string[] {
  return filer.flatMap(({ fil, text }) => {
    const ord = [...REDOVISNINGSVAGENS_TEXTER, ...(fil === 'src/http/vy/session.ts' ? ['fetch('] : [])];
    return ord.filter((sokt) => text.includes(sokt)).map((sokt) => `${fil}: ${sokt}`);
  });
}

describe('FR-14/Story 3.4 AK 1: sessionen föds bara ur människonyckeln', () => {
  it('V1 (AK 1): redovisningskakan ger läsläge, 401 och noll skrivningar utan att stubben nås', async () => {
    for (const vag of ['/vy', arendesida, '/vy/rattelser']) {
      const svar = await request(app).get(vag).set('Cookie', REDOVISNINGSKAKA);
      expect(svar.status).toBe(200);
      expect(hornet(svar.text)).toBe(INLOGGNINGSHORN);
      if (vag !== '/vy') expect(svar.text).not.toContain('method=post');
      if (vag === arendesida) expect(svar.text).toContain('Läsläge.');
    }
    const login = await request(app).get('/vy/logga-in').set('Cookie', REDOVISNINGSKAKA);
    expect(login.status).toBe(200);
    expect(login.text).toContain('<h1>Logga in</h1>');
    expect(login.text.match(/<form\b/g)).toHaveLength(1);
    expect(login.text).toContain('action="/vy/logga-in"');
    expect(login.text).toContain('name=nyckel');
    expect(login.text).not.toContain('<h1>Inloggad</h1>');
    const fore = await Promise.all(['events', 'comments'].map(raknaRader));
    for (const [vag, body] of [
      ['/kommentar', { body: 'F34 via redovisningen' }],
      ['/ratta', { titel: 'F34 ny titel', beskrivning: 'F34 beskrivning' }],
    ] as const) {
      const svar = await request(app).post(arendesida + vag).set('Cookie', REDOVISNINGSKAKA)
        .type('form').send(body);
      expect(svar.status).toBe(401);
      expect(svar.text).toContain('<h1>Inloggning krävs</h1>');
    }
    expect(await Promise.all(['events', 'comments'].map(raknaRader))).toEqual(fore);
    const arende = await kor(app, agentnyckel, 'get_issue', { identifier });
    expect(arende.status).toBe(200);
    expect(arende.body.result.arende.title).toBe('F34 ärende');
    expect(stubbanrop).toBe(0);
    // Samma stubbe är nåbar: nollan beror på att vyn inte använder den.
    const kontroll = await fetch(stubbbas + '/api/session/vem');
    expect(kontroll.status).toBe(200);
    expect(await kontroll.json()).toEqual({ namn: 'f34 redovisningsmänniska' });
    expect(stubbanrop).toBe(1);
  });

  it('V2 (AK 1): sessionskartan är enda källan och den gamla vägens kod och exporter saknas', () => {
    for (const text of [...REDOVISNINGSVAGENS_TEXTER, 'fetch(']) {
      const fil = text === 'fetch(' ? 'src/http/vy/session.ts' : 'src/http/app.ts';
      expect(redovisningsvagensFynd([{ fil, text }])).toEqual([`${fil}: ${text}`]);
    }
    expect(redovisningsvagensFynd([{ fil: 'src/http/app.ts', text: 'fetch(' }])).toEqual([]);
    expect(redovisningsvagensFynd([{ fil: 'src/http/vy/session.ts', text: 'export const x = 1;' }]))
      .toEqual([]);
    const filer = ['src/http/app.ts', 'src/http/vy/session.ts']
      .map((fil) => ({ fil, text: readFileSync(path.join(ROT, fil), 'utf8') }));
    expect(redovisningsvagensFynd(filer)).toEqual([]);
    for (const namn of ['medRedovisningssession', 'redovisningsAktor', 'REDOVISNINGEN']) {
      expect(session).not.toHaveProperty(namn);
    }
    expect(session).toHaveProperty('sessionsAktor');
    expect(session).toHaveProperty('startaSession');
  });
});

function traffar(filer: Kallfil[], ord: string): string[] {
  return filer.filter(({ text }) => text.includes(ord)).map(({ fil }) => fil).sort();
}

function allaFilerUnder(katalog: string): Kallfil[] {
  return readdirSync(path.join(ROT, katalog), { withFileTypes: true }).flatMap((post) => {
    const fil = `${katalog}/${post.name}`;
    if (post.isDirectory()) return allaFilerUnder(fil);
    return post.isFile() ? [{ fil, text: readFileSync(path.join(ROT, fil), 'utf8') }] : [];
  });
}

const FR14_RUBRIK = '### FR-14 — Davids vysession föds bara ur en människonyckel (Story 3.1 och 3.4)';
const FR14_REGEL = '- Vyns session (FR-14, B-03, Story 3.1 och 3.4): en session i vyn föds bara ur en människonyckel. `POST /vy/logga-in` är den enda vägen in: rutten slår upp nyckeln med `slaUppAktor()`, avvisar en agent- eller systemnyckel med `303` till `/vy/logga-in?fel=agent` utan session och utan att värdet upprepas, och är det enda ställe som anropar `startaSession()`. `sessionsAktor()` i `src/http/vy/session.ts` läser bara kakan `arenden_vy` och processens sessioner; vyn slår aldrig upp en session i en annan tjänst, och inget mellanlager före vyns rutter sätter en aktör. `skrivrutt()` kräver dessutom `aktor.typ === \'manniska\'` genom `kravManniska()` (403 `kraver_manniska`) som andra linje, och skrivformulären renderas bara när `kanSkriva(aktor)` är sant. `test/manniska-yta.test.ts` och `test/vysession.test.ts` prövar vägen.';
const README_FORBJUDNA = [
  'redovisningsaktor', 'redovisningssession', '/api/session/vem', 'redovisningens inloggning',
  'redovisningens session', 'session ur api-nyckel', 'födas ur en giltig api-nyckel',
];

function fr14Avsnitt(text: string): string {
  const start = text.indexOf(FR14_RUBRIK);
  if (start === -1) return '';
  const resten = text.slice(start + FR14_RUBRIK.length);
  const slut = resten.search(/\n#{2,3} /);
  return FR14_RUBRIK + (slut === -1 ? resten : resten.slice(0, slut));
}

function readmeFynd(text: string): string[] {
  const fynd: string[] = [];
  const antal = text.split('\n').filter((rad) => rad === FR14_RUBRIK).length;
  if (antal === 0) {
    fynd.push('rubriken saknas');
  } else {
    if (antal !== 1) fynd.push('rubriken står inte exakt en gång');
    if (text.indexOf(FR14_RUBRIK) > text.indexOf('## Gränser för Etapp 2a')) {
      fynd.push('avsnittet står efter gränserna');
    }
    const avsnitt = fr14Avsnitt(text);
    if (avsnitt.split('\n').filter((rad) => rad === FR14_REGEL).length !== 1) {
      fynd.push('regelns rad avviker');
    }
    const rader = avsnitt.split('\n').filter((rad) => rad.startsWith('| FR-14'));
    const provfiler = ['test/vysession.test.ts', 'test/manniska-yta.test.ts'];
    if (rader.length !== 3 || rader.some((rad) => !provfiler.some((fil) => rad.includes(fil)))
      || provfiler.some((fil) => !rader.some((rad) => rad.includes(fil)))) {
      fynd.push('tabellraderna avviker');
    }
  }
  const hopslagen = text.replace(/\s+/g, ' ').toLowerCase();
  for (const ord of README_FORBJUDNA) {
    if (hopslagen.includes(ord)) fynd.push(`förbjuden text: ${ord}`);
  }
  return fynd;
}

describe('FR-14/Story 3.4 AK 2: dokumentationen säger samma sak', () => {
  it('V3 (AK 2): schemat och hela källträdet saknar den borttagna adressen', () => {
    expect(Object.keys(EnvSchema.shape)).not.toContain(ADRESSNAMN);
    expect(Object.keys(EnvSchema.shape)).toContain('CRM_KONF_PATH');
    expect(EnvSchema.parse({ DATABASE_URL: 'postgres://f34@prov/prov' })).not.toHaveProperty(ADRESSNAMN);
    expect(process.env[ADRESSNAMN]).toBe(stubbbas);
    expect(config).not.toHaveProperty(ADRESSNAMN);
    const filer = [...allaFilerUnder('src'), ...allaFilerUnder('test'),
      ...['README.md', '.env.example'].map((fil) => ({ fil, text: readFileSync(path.join(ROT, fil), 'utf8') }))];
    expect(filer.map(({ fil }) => fil)).toEqual(expect.arrayContaining([
      'src/config.ts', 'src/http/vy/session.ts', 'test/env.ts', 'test/mcp.test.ts',
      'test/manniska-yta.test.ts', 'README.md', '.env.example',
    ]));
    expect(traffar([{ fil: 'kontroll.ts', text: 'x = ' + ADRESSNAMN }], ADRESSNAMN)).toEqual(['kontroll.ts']);
    expect(traffar(filer, ADRESSNAMN)).toEqual([]);
  });

  it('V4 (AK 2): README bär regeln och tre provkopplingar, utan den gamla inloggningsvägen', () => {
    const text = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect(readmeFynd(text)).toEqual([]);
    const avsnitt = fr14Avsnitt(text);
    expect(readmeFynd(text.replace(avsnitt, ''))).toEqual(['rubriken saknas']);
    const utan = text.replace(avsnitt, '');
    expect(readmeFynd(utan + '\n' + avsnitt)).toEqual(['avsnittet står efter gränserna']);
    expect(readmeFynd(text.replace(FR14_REGEL, FR14_REGEL.replace('föds', 'skapas'))))
      .toEqual(['regelns rad avviker']);
    const tabellrad = avsnitt.split('\n').find((rad) => rad.startsWith('| FR-14'))!;
    expect(readmeFynd(text.replace(tabellrad, ''))).toEqual(['tabellraderna avviker']);
    for (const ord of README_FORBJUDNA) {
      expect(readmeFynd(text + '\n' + ord)).toEqual([`förbjuden text: ${ord}`]);
    }
    expect(readmeFynd(text + '\n' + FR14_RUBRIK)).toEqual(['rubriken står inte exakt en gång']);
  });
});

describe('FR-14/Story 3.4 AK 3: människonyckeln fungerar', () => {
  it('V5 (AK 3): människans session bär nyckelns aktör, andra nyckeltyper och påhittad token nekas', async () => {
    const anropFore = stubbanrop;
    const login = await request(app).post('/vy/logga-in').type('form')
      .send({ nyckel: manniskonyckel, fran: arendesida });
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe(arendesida + '?notis=inloggad');
    const kaka = kakaUr(login);
    expect(kaka).toMatch(/^arenden_vy=.+$/);
    const kakor = `${kaka}; ${REDOVISNINGSKAKA}`;
    const arende = await request(app).get(arendesida).set('Cookie', kakor);
    expect(arende.status).toBe(200);
    expect(arende.text).toContain('method=post');
    expect(hornet(arende.text)).toContain('människa · f34 människa');
    expect(hornet(arende.text)).not.toContain('f34 redovisningsmänniska');
    const kommentar = await request(app).post(arendesida + '/kommentar').set('Cookie', kakor)
      .type('form').send({ body: 'F34 med nyckeln' });
    expect(kommentar.status).toBe(303);
    expect(kommentar.headers.location).toContain('notis=kommenterad');
    const proveniens = [{ aktor_typ: 'manniska', aktor_namn: 'f34 människa' }];
    const sparad = await pool.query('SELECT aktor_typ, aktor_namn FROM comments WHERE body = $1',
      ['F34 med nyckeln']);
    expect(sparad.rows).toEqual(proveniens);
    const handelse = await pool.query(
      "SELECT aktor_typ, aktor_namn FROM events WHERE verb = 'kommenterade' AND payload->>'identifier' = $1 ORDER BY id DESC LIMIT 1",
      [identifier],
    );
    expect(handelse.rows).toEqual(proveniens);

    for (const nyckel of [agentnyckel, systemnyckel]) {
      const nekad = await request(app).post('/vy/logga-in').type('form').send({ nyckel, fran: arendesida });
      expect(nekad.status).toBe(303);
      expect(nekad.headers.location).toBe('/vy/logga-in?fel=agent&fran=' + encodeURIComponent(arendesida));
      expect(kakaUr(nekad)).toBeUndefined();
    }
    // Kontroll mot människans session ovan: endast vysessionens token skiljer.
    const pahittadeKakor = `arenden_vy=f34-pahittad-token; ${REDOVISNINGSKAKA}`;
    const utan = await request(app).get(arendesida).set('Cookie', pahittadeKakor);
    expect(utan.status).toBe(200);
    expect(hornet(utan.text)).toBe(INLOGGNINGSHORN);
    const fore = await Promise.all(['events', 'comments'].map(raknaRader));
    const nekad = await request(app).post(arendesida + '/kommentar').set('Cookie', pahittadeKakor)
      .type('form').send({ body: 'F34 med nyckeln' });
    expect(nekad.status).toBe(401);
    expect(nekad.text).toContain('<h1>Inloggning krävs</h1>');
    expect(await Promise.all(['events', 'comments'].map(raknaRader))).toEqual(fore);

    const filer = allaFilerUnder('src').filter(({ fil }) => fil.endsWith('.ts'));
    const rakna = (kallfiler: Kallfil[]) => kallfiler.flatMap(({ fil, text }) =>
      [...text.matchAll(/startaSession\(/g)].map(() => fil)).sort();
    expect(rakna(filer)).toEqual(['src/http/vy/session.ts', 'src/http/vy/skrivning.ts']);
    expect(filer.find(({ fil }) => fil === 'src/http/vy/session.ts')?.text)
      .toContain('export function startaSession(');
    expect(rakna([...filer, { fil: 'kontroll.ts', text: 'startaSession(' }])).toHaveLength(3);
    expect(stubbanrop).toBe(anropFore);
  });
});
