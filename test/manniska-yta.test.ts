// FR-14/Story 3.1, AK 1–10: bara människor loggar in och skriver i vyn.
// F2–F3: hela källträdet och testmiljön. F1 togs bort med redovisningens adress i Story 3.4.
// F4–F8: nyckeltyper, feltexter, nio skrivrutter och alla formulärbyggare.
// F9–F13: tjänstespärr, fem CSRF-varianter, tailnet, utan session och /api.
// Varje mätning har en kontroll som visar att den kan slå ut. Databasen är riktig.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { EnvSchema } from '../src/config.js';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { glomAllaSessioner, startaSession, SESSIONSKAKA } from '../src/http/vy/session.js';
import type { Aktor } from '../src/lib/aktor.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

const ROT = fileURLToPath(new URL('../', import.meta.url));
const AGENTFEL = 'Nyckeln tillhör en agent eller ett system. Vyn tar bara emot människonycklar.';
const NYCKELFEL = 'Nyckeln gick inte att känna igen, eller är återkallad.';
let app: Express;
let server: Server;
let bas: string;
let manniskonyckel: string;
let agentnyckel: string;
let systemnyckel: string;
let identifier: string;
let arendesida: string;

beforeAll(async () => {
  app = createApp();
  glomAllaSessioner();
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  bas = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await seedaTeam();
  manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'f31 människa' });
  agentnyckel = await nyNyckel({ typ: 'agent', namn: 'f31 agent' });
  systemnyckel = await nyNyckel({ typ: 'system', namn: 'f31 system' });
  const skapat = await kor(app, agentnyckel, 'create_issue', {
    title: 'F31 ärende', team_key: 'LOC', description: 'F31 beskrivning',
  });
  expect(skapat.status, skapat.text).toBe(200);
  identifier = skapat.body.result.identifier;
  arendesida = `/vy/arende/${identifier}`;
});

afterAll(async () => {
  if (server) await new Promise<void>((klar) => server.close(() => klar()));
});

async function loggaIn(nyckel: string, fran: string, huvuden: Record<string, string> = {}) {
  const svar = await request(bas).post('/vy/logga-in').set(huvuden).type('form').send({ nyckel, fran });
  const kaka = [svar.headers['set-cookie'] ?? []].flat().map(String)
    .find((k) => k.startsWith('arenden_vy='))?.split(';')[0];
  return { svar, kaka };
}

async function manniskosession(): Promise<string> {
  const { svar, kaka } = await loggaIn(manniskonyckel, arendesida);
  if (svar.status !== 303 || svar.headers['location'] !== `${arendesida}?notis=inloggad` || !kaka) {
    throw new Error(`inloggningen misslyckades: ${svar.status} ${svar.headers['location']}`);
  }
  return kaka;
}

function konsolspion() {
  const spioner = (['log', 'info', 'warn', 'error', 'debug'] as const)
    .map((metod) => vi.spyOn(console, metod).mockImplementation(() => {}));
  return {
    fynd: (varde: string) => spioner.flatMap((s) => s.mock.calls)
      .filter((args) => args.map(String).join(' ').includes(varde)),
    aterstall: () => spioner.forEach((s) => s.mockRestore()),
  };
}

function inloggningssidansFel(html: string): string[] {
  const fel: string[] = [];
  for (const text of [
    '<details class=rattelse open><summary>Logga in med människonyckel</summary>',
    '<p class=summering>För dig som har en egen människonyckel. Agenterna bär nyckel mot API:t och loggar aldrig in här.</p>',
  ]) if (!html.includes(text)) fel.push(`saknas: ${text}`);
  const formular = html.match(/<form\b[^>]*>/g) ?? [];
  if (formular.length !== 1) fel.push('ska ha exakt ett formulär');
  if (!formular[0]?.includes('method=post action="/vy/logga-in"')) fel.push('fel inloggningsformulär');
  const falt = (html.match(/<input\b[^>]*>/g) ?? []).find((f) => /\bname=nyckel\b/.test(f));
  for (const text of ['name=nyckel', 'type=password', 'autocomplete=off']) {
    if (!falt?.includes(text)) fel.push(`nyckelfältet saknar ${text}`);
  }
  for (const text of ['Locollabs-konto', 'Till inloggningen', '/app/login',
    'API-nyckel — för agenter', 'Som människa behöver du ingen']) {
    if (html.includes(text)) fel.push(`otillåten text: ${text}`);
  }
  return fel;
}

function sessionskakaFor(aktor: Aktor): string {
  return `${SESSIONSKAKA}=${startaSession(aktor)}`;
}

async function skrivfixtur(prefix: string) {
  const skapat = await kor(app, agentnyckel, 'create_issue', {
    title: `${prefix} ärende`, team_key: 'LOC', description: `${prefix} beskrivning`,
  });
  expect(skapat.status, skapat.text).toBe(200);
  const identifier = skapat.body.result.identifier as string;
  const kommentar = await kor(app, manniskonyckel, 'add_comment', { identifier, body: `${prefix} levande` });
  const borttagen = await kor(app, manniskonyckel, 'add_comment', { identifier, body: `${prefix} borttagen` });
  expect(kommentar.status, kommentar.text).toBe(200);
  expect(borttagen.status, borttagen.text).toBe(200);
  expect((await kor(app, manniskonyckel, 'delete_comment', { kommentar_id: borttagen.body.result.id })).status).toBe(200);
  for (const label of [`${prefix}-etikett`, `${prefix}-namn`]) {
    expect((await kor(app, agentnyckel, 'add_label', { identifier, label })).status).toBe(200);
  }
  const projekt = await pool.query('INSERT INTO projects (tenant_id, namn) VALUES ($1, $2) RETURNING id',
    [TENANT_ID, `${prefix} projekt`]);
  await nyNyckel({ typ: 'agent', namn: `${prefix} återkallas` });
  const nyckel = await pool.query('SELECT id FROM api_keys WHERE aktor_namn = $1', [`${prefix} återkallas`]);
  expect(nyckel.rows).toHaveLength(1);
  return { prefix, identifier, sida: `/vy/arende/${identifier}`,
    levande: kommentar.body.result.id as string, borttagen: borttagen.body.result.id as string,
    projektId: projekt.rows[0].id as string, nyckelId: nyckel.rows[0].id as string };
}

type Skrivfixtur = Awaited<ReturnType<typeof skrivfixtur>>;

async function fixturensTillstand(f: Skrivfixtur) {
  const arende = await kor(app, agentnyckel, 'get_issue', { identifier: f.identifier });
  expect(arende.status).toBe(200);
  return {
    titel: arende.body.result.arende.title,
    beskrivning: arende.body.result.arende.description,
    etiketter: arende.body.result.arende.labels,
    kommentarer: (await pool.query(
      'SELECT id, body, borttagen IS NULL AS levande FROM comments WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[f.levande, f.borttagen]],
    )).rows,
    projekt: (await pool.query('SELECT namn FROM projects WHERE id = $1', [f.projektId])).rows,
    etikettnamn: (await pool.query('SELECT namn FROM labels WHERE tenant_id = $1 AND namn LIKE $2 ORDER BY namn',
      [TENANT_ID, `${f.prefix}%`])).rows,
    nyckel: (await pool.query('SELECT aktiv FROM api_keys WHERE id = $1', [f.nyckelId])).rows,
  };
}

function nioSkrivningar(f: Skrivfixtur): { vag: string; falt: Record<string, string>; notis: string }[] {
  return [
    { vag: `${f.sida}/kommentar`, falt: { body: `${f.prefix} ny kommentar` }, notis: 'kommenterad' },
    { vag: `${f.sida}/ratta`, falt: { titel: `${f.prefix} ny titel`, beskrivning: `${f.prefix} beskrivning` }, notis: 'arendet_rattat' },
    { vag: `/vy/kommentar/${f.levande}/ratta`, falt: { body: `${f.prefix} rättad`, fran: f.sida }, notis: 'rattad' },
    { vag: `/vy/kommentar/${f.levande}/tabort`, falt: { fran: f.sida }, notis: 'borttagen' },
    { vag: `/vy/kommentar/${f.borttagen}/aterstall`, falt: { fran: f.sida }, notis: 'aterstalld' },
    { vag: `${f.sida}/etikett/tabort`, falt: { etikett: `${f.prefix}-etikett` }, notis: 'etikett_borttagen' },
    { vag: '/vy/namn/projekt', falt: { fran: `${f.prefix} projekt`, till: `${f.prefix} projekt nytt` }, notis: 'namn_andrat' },
    { vag: '/vy/namn/etikett', falt: { fran: `${f.prefix}-namn`, till: `${f.prefix}-namn-nytt` }, notis: 'namn_andrat' },
    { vag: `/vy/nyckel/${f.nyckelId}/aterkalla`, falt: {}, notis: 'nyckel_aterkallad' },
  ];
}

const FORMULARSPAR = {
  arende: ['Kommentera', 'Rätta titel eller beskrivning', 'Rätta eller ta bort', 'Återställ', '/etikett/tabort'],
  rattelser: ['name=till', 'Återkalla'],
};

async function radrakning() {
  return { events: await raknaRader('events'), comments: await raknaRader('comments') };
}

async function provaManniskansSkrivningar(f: Skrivfixtur) {
  const kaka = await manniskosession();
  for (const { vag, falt, notis } of nioSkrivningar(f)) {
    const fore = await raknaRader('events');
    const svar = await request(bas).post(vag).set('Cookie', kaka).type('form').send(falt);
    expect(svar.status, `${vag}: ${svar.text}`).toBe(303);
    expect(svar.headers['location']).toContain(`notis=${notis}`);
    expect(await raknaRader('events'), vag).toBeGreaterThan(fore);
  }
}

function miljofynd(filer: { fil: string; text: string }[]): string[] {
  return filer.filter(({ text }) =>
    /\bprocess\s*\.\s*env\b|\bprocess\s*\[\s*(['"`])env\1\s*\]|\b(?:from\s*|import\s*(?:\(\s*)?)(['"])(?:node:)?process\2/.test(text),
  ).map(({ fil }) => fil).sort();
}

function testmiljonsFel(text: string, nycklar: string[]): string[] {
  const fel = nycklar.filter((nyckel) =>
    [...text.matchAll(new RegExp(`^\\s*process\\.env\\.${nyckel} = `, 'gm'))].length !== 1,
  ).map((nyckel) => `saknad eller dubblerad tilldelning: ${nyckel}`);
  if (/^\s*process\.env\.\w+\s*\?\?=/m.test(text)) fel.push('tilldelning med ??=');
  return fel;
}

describe('FR-14/Story 3.1 AK 9: konfigurationen läses på ett ställe', () => {
  it('F2 (AK 9): bara config och de två CLI-undantagen läser miljön', () => {
    const former = [
      'process.env.X', "process['env']", 'process["env"]', 'process[`env`]',
      "import p from 'node:process';", "import p from 'process';",
      "export const BAS =\n  process.env['BAS_URL'] ?? 'x';",
    ];
    for (const text of former) expect(miljofynd([{ fil: 'kontroll.ts', text }])).toEqual(['kontroll.ts']);
    expect(miljofynd([{ fil: 'ren.ts', text: 'export const x = config.PORT;' }])).toEqual([]);
    const filer = readdirSync(path.join(ROT, 'src'), { recursive: true })
      .filter((fil) => String(fil).endsWith('.ts'))
      .map((fil) => ({ fil: 'src/' + String(fil).split(path.sep).join('/'),
        text: readFileSync(path.join(ROT, 'src', String(fil)), 'utf8') }));
    expect(filer.map(({ fil }) => fil)).toEqual(expect.arrayContaining([
      'src/http/vy/session.ts', 'src/mcp/server.ts',
    ]));
    expect(miljofynd(filer)).toEqual(['src/config.ts', 'src/db/migrate.ts', 'src/scripts/skapaNyckel.ts']);
  });

  it('F3 (AK 9): varje schemanyckel sätts exakt en gång med = i testmiljön', () => {
    const text = readFileSync(path.join(ROT, 'test/env.ts'), 'utf8');
    const nycklar = Object.keys(EnvSchema.shape);
    expect(nycklar).toContain('CRM_KONF_PATH');
    expect(testmiljonsFel(text, nycklar)).toEqual([]);
    expect(testmiljonsFel(text.replace('process.env.CRM_KONF_PATH = ', 'process.env.CRM_KONF_PATH ??= '), nycklar))
      .toHaveLength(2);
    expect(testmiljonsFel(text.replace(/^\s*process\.env\.HOST = .*$/m, ''), nycklar)).toHaveLength(1);
  });
});

describe('FR-14/Story 3.1 AK 1 och AK 2: inloggningen', () => {
  it('F4 (AK 1): agent- och systemnycklar avvisas utan session eller läckt värde', async () => {
    const spion = konsolspion();
    try {
      for (const nyckel of [agentnyckel, systemnyckel]) {
        const { svar, kaka } = await loggaIn(nyckel, arendesida);
        expect(svar.status).toBe(303);
        expect(svar.headers['location']).toBe('/vy/logga-in?fel=agent&fran=' + encodeURIComponent(arendesida));
        expect(kaka).toBeUndefined();
        const sida = await request(bas).get(svar.headers['location']!);
        expect(sida.status).toBe(200);
        expect(sida.text).toContain(`<p class=notis>${AGENTFEL}</p>`);
        expect(sida.text).not.toContain(NYCKELFEL);
        for (const text of [svar.headers['location'], svar.text, sida.text]) expect(text).not.toContain(nyckel);
        expect(spion.fynd(nyckel)).toEqual([]);
        const utan = await request(bas).post(`${arendesida}/kommentar`).type('form').send({ body: 'F31 nekad' });
        expect(utan.status).toBe(401);
      }
      console.info('f31 kontroll ' + agentnyckel);
      expect(spion.fynd(agentnyckel)).toHaveLength(1);
    } finally {
      spion.aterstall();
    }
    const text = readFileSync(path.join(ROT, 'src/http/vy/skrivning.ts'), 'utf8');
    expect(text.match(/\bstartaSession\(/g)).toHaveLength(1);
    const rutt = text.indexOf("router.post('/logga-in'");
    const typkrav = text.indexOf("if (aktor.typ !== 'manniska')", rutt);
    expect(typkrav).toBeGreaterThan(rutt);
    expect(typkrav).toBeLessThan(text.indexOf('startaSession(', rutt));
  });

  it('F5 (AK 2): människa får session, okänd och återkallad nyckel nekas', async () => {
    const { svar, kaka } = await loggaIn(manniskonyckel, arendesida);
    expect(svar.status).toBe(303);
    expect(svar.headers['location']).toBe(`${arendesida}?notis=inloggad`);
    expect(kaka).toBeDefined();
    const sida = await request(bas).get(arendesida).set('Cookie', kaka!);
    expect(sida.status).toBe(200);
    expect(sida.text).toContain('method=post');
    const aterkallad = await nyNyckel({ typ: 'manniska', namn: 'f31 återkallad' });
    expect((await loggaIn(aterkallad, arendesida)).kaka).toBeDefined();
    const { rows } = await pool.query('SELECT id FROM api_keys WHERE aktor_namn = $1', ['f31 återkallad']);
    expect(rows).toHaveLength(1);
    expect((await kor(app, manniskonyckel, 'revoke_api_key', { nyckel_id: rows[0].id })).status).toBe(200);
    for (const nyckel of ['f31-pahittad-nyckel-som-inte-finns', aterkallad]) {
      const nekad = await loggaIn(nyckel, arendesida);
      expect(nekad.svar.status).toBe(303);
      expect(nekad.svar.headers['location']).toBe('/vy/logga-in?fel=1&fran=' + encodeURIComponent(arendesida));
      expect(nekad.kaka).toBeUndefined();
      const sida = await request(bas).get(nekad.svar.headers['location']!);
      expect(sida.status).toBe(200);
      expect(sida.text).toContain(NYCKELFEL);
      expect(sida.text).not.toContain(AGENTFEL);
      for (const text of [nekad.svar.headers['location'], nekad.svar.text, sida.text]) expect(text).not.toContain(nyckel);
    }
  });
});

describe('FR-14/Story 3.1 AK 4: inloggningssidan', () => {
  it('F6 (AK 4): enda inloggningen är människonyckeln och felraden är sluten', async () => {
    expect(inloggningssidansFel('<h2>Logga in med ditt Locollabs-konto</h2>' +
      '<a href="/app/login">Till inloggningen</a><summary>API-nyckel — för agenter</summary>').length)
      .toBeGreaterThanOrEqual(3);
    const sida = await request(bas).get('/vy/logga-in');
    expect(sida.status).toBe(200);
    expect(inloggningssidansFel(sida.text)).toEqual([]);
    for (const kod of ['agent', '1', 'nagot', '<script>']) {
      const fel = await request(bas).get('/vy/logga-in?fel=' + encodeURIComponent(kod));
      expect(fel.status).toBe(200);
      expect(fel.text).toContain(`<p class=notis>${kod === 'agent' ? AGENTFEL : NYCKELFEL}</p>`);
      expect(fel.text).not.toContain(kod === 'agent' ? NYCKELFEL : AGENTFEL);
      expect(fel.text).not.toContain('<script');
    }
  });
});

describe('FR-14/Story 3.1 AK 3: skrivvägen kräver människa', () => {
  it('F7 (AK 3): agent och system nekas på alla nio skrivrutter utan någon ändring', async () => {
    const f = await skrivfixtur('f31-7');
    const fore = await radrakning();
    const tillstand = await fixturensTillstand(f);
    for (const typ of ['agent', 'system'] as const) {
      const kaka = sessionskakaFor({ typ, namn: `f31 ${typ}session` });
      for (const { vag, falt } of nioSkrivningar(f)) {
        const svar = await request(bas).post(vag).set('Cookie', kaka).type('form').send(falt);
        expect(svar.status, `${typ} ${vag}`).toBe(403);
        expect(svar.text).toContain('<h1>Det här kräver en människa</h1>');
        expect(svar.text).toContain('<p class=notis>Handgreppet bokförs alltid som människa. Logga in med din människonyckel.</p>');
        expect(svar.text).toContain('<p>Felkod: <code>kraver_manniska</code></p>');
      }
    }
    expect(await radrakning()).toEqual(fore);
    expect(await fixturensTillstand(f)).toEqual(tillstand);
    await provaManniskansSkrivningar(f);
  });

  it('F8 (AK 3): endast människan ser formulären ur alla byggare', async () => {
    const f = await skrivfixtur('f31-8');
    for (const typ of ['agent', 'system'] as const) {
      const kaka = sessionskakaFor({ typ, namn: `f31 ${typ}session` });
      for (const [vag, notis] of [[f.sida, 'Läsläge.'], ['/vy/rattelser', 'Läsläge — namnen visas men går inte att ändra.']]) {
        const sida = await request(bas).get(vag!).set('Cookie', kaka);
        expect(sida.status).toBe(200);
        expect(sida.text).not.toContain('method=post');
        expect(sida.text).not.toContain('<textarea');
        expect(sida.text).toContain(notis);
      }
    }
    const kaka = await manniskosession();
    const arende = await request(bas).get(f.sida).set('Cookie', kaka);
    const rattelser = await request(bas).get('/vy/rattelser').set('Cookie', kaka);
    expect(arende.status).toBe(200);
    expect(rattelser.status).toBe(200);
    for (const spar of FORMULARSPAR.arende) expect(arende.text).toContain(spar);
    expect(arende.text).not.toContain('Läsläge.');
    for (const spar of FORMULARSPAR.rattelser) expect(rattelser.text).toContain(spar);
  });
});

describe('FR-14/Story 3.1 AK 5: tjänstelagrets människospärr', () => {
  it('F9 (AK 5): agenten nekas svar och uppskjutning, människans två handlingar bär hennes identitet', async () => {
    const reg = await kor(app, agentnyckel, 'registrera_insats', {
      stopp_id: 'f31:svar', typ: 'agarbeslut', tillhor: 'agare',
      utfall: 'Riktningen är vald och arbetet kan fortsätta', begard_handling: 'Välj mellan A och B',
      blockeringsgrund: 'Tidigare besked avgör inte valet',
      handlingskontrakt: { system: 'hermes', kommando: 'besvara_beslut', objekt: '#153' },
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: 'f31-1' }],
    });
    expect(reg.status, reg.text).toBe(200);
    const id = reg.body.result.insats.id as string;
    const till = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const fore = { events: await raknaRader('events'), insatser: await raknaRader('insatser') };
    const tillstand = await pool.query('SELECT lage, version, svar_aktor, vackningstid FROM insatser WHERE id = $1', [id]);
    for (const [action, input] of [
      ['besvara_insats', { id, svar: 'F31 ja' }],
      ['skjut_upp_insats', { id, till, skal: 'F31 senare' }],
    ] as const) {
      const svar = await kor(app, agentnyckel, action, input);
      expect([svar.status, svar.body.error]).toEqual([403, 'kraver_manniska']);
    }
    expect({ events: await raknaRader('events'), insatser: await raknaRader('insatser') }).toEqual(fore);
    expect((await pool.query('SELECT lage, version, svar_aktor, vackningstid FROM insatser WHERE id = $1', [id])).rows)
      .toEqual(tillstand.rows);
    expect((await kor(app, manniskonyckel, 'skjut_upp_insats', { id, till, skal: 'F31 senare' })).status).toBe(200);
    const svar = await kor(app, manniskonyckel, 'besvara_insats', { id, svar: 'F31 ja' });
    expect(svar.status).toBe(200);
    expect(svar.body.result.svar_aktor).toBe('f31 människa');
    expect(await raknaRader('events')).toBe(fore.events + 2);
    const handelser = await pool.query(
      "SELECT verb, aktor_typ, aktor_namn FROM events WHERE payload->>'insats_id' = $1 ORDER BY id", [id],
    );
    expect(handelser.rows).toEqual([
      { verb: 'registrerade_insats', aktor_typ: 'agent', aktor_namn: 'f31 agent' },
      { verb: 'skot_upp_insats', aktor_typ: 'manniska', aktor_namn: 'f31 människa' },
      { verb: 'besvarade_insats', aktor_typ: 'manniska', aktor_namn: 'f31 människa' },
    ]);
  });
});

describe('FR-14/Story 3.1 AK 6: CSRF', () => {
  it('F10 (AK 6): fem främmande varianter nekas, egen origin och tailnet-schema släpps igenom', async () => {
    const kaka = await manniskosession();
    const fore = await radrakning();
    const annatSchema = bas.replace('http://', 'https://');
    const varianter = [
      { Origin: 'https://elak.example' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'none' },
      { Origin: annatSchema, 'Sec-Fetch-Site': 'same-site' },
    ];
    for (const huvuden of varianter) {
      const svar = await request(bas).post(`${arendesida}/kommentar`).set('Cookie', kaka)
        .set(huvuden).type('form').send({ body: 'F31 CSRF-kommentar' });
      expect(svar.status, JSON.stringify(huvuden)).toBe(403);
      expect(svar.text).toContain('<h1>Gick inte att utföra</h1>');
    }
    expect(await radrakning()).toEqual(fore);
    const egen = await request(bas).post(`${arendesida}/kommentar`).set('Cookie', kaka)
      .set('Origin', bas).type('form').send({ body: 'F31 CSRF-kommentar' });
    expect(egen.status).toBe(303);
    expect((await request(bas).get(arendesida).set('Cookie', kaka)).text).toContain('F31 CSRF-kommentar');
    const schema = await request(bas).post(`${arendesida}/kommentar`).set('Cookie', kaka)
      .set({ Origin: annatSchema, 'Sec-Fetch-Site': 'same-origin' })
      .type('form').send({ body: 'F31 CSRF-kommentar' });
    expect(schema.status).toBe(303);
    expect(await radrakning()).toEqual({ events: fore.events + 2, comments: fore.comments + 2 });
  });
});

function tailnetHuvuden(): Record<string, string> {
  const vard = ['vy.tailnet-prov.example', '8446'].join(':');
  return { Host: vard, Origin: 'https://' + vard, 'Sec-Fetch-Site': 'same-origin' };
}

describe('FR-14/Story 3.1 AK 7: skrivning genom tailnet-adressen', () => {
  it('F11 (AK 7): renderat titelformulär fungerar med tailnet-huvuden och bokför människan', async () => {
    const huvuden = tailnetHuvuden();
    for (const vag of ['/vy', arendesida]) expect((await request(bas).get(vag).set(huvuden)).status).toBe(200);
    const { svar, kaka } = await loggaIn(manniskonyckel, arendesida, huvuden);
    expect(svar.status).toBe(303);
    expect(svar.headers['location']).toBe(`${arendesida}?notis=inloggad`);
    expect(kaka).toBeDefined();
    const sida = await request(bas).get(arendesida).set(huvuden).set('Cookie', kaka!);
    expect(sida.status).toBe(200);
    const formular = (sida.text.match(/<form\b[^>]*>[\s\S]*?<\/form>/g) ?? [])
      .filter((form) => /\bname=titel\b/.test(form));
    expect(formular).toHaveLength(1);
    const form = formular[0]!;
    const action = /\baction="([^"]+)"/.exec(form)![1]!;
    const titelfalt = /\bname=(titel)\b/.exec(form)![1]!;
    const beskrivningsfalt = /\bname=(beskrivning)\b/.exec(form)![1]!;
    expect(action).toBe(`${arendesida}/ratta`);
    const falt = { [titelfalt]: 'F31 titel genom tailnet', [beskrivningsfalt]: 'F31 beskrivning' };
    const rattat = await request(bas).post(action).set(huvuden).set('Cookie', kaka!).type('form').send(falt);
    expect(rattat.status).toBe(303);
    expect(rattat.headers['location']).toContain('notis=arendet_rattat');
    const handelse = await pool.query(
      "SELECT aktor_typ, aktor_namn FROM events WHERE verb = 'andrade_titel' AND payload->>'identifier' = $1 ORDER BY id DESC LIMIT 1",
      [identifier],
    );
    expect(handelse.rows).toEqual([{ aktor_typ: 'manniska', aktor_namn: 'f31 människa' }]);
    const efter = await request(bas).get(arendesida).set(huvuden).set('Cookie', kaka!);
    expect(efter.status).toBe(200);
    const rader = efter.text.split('<li class=rad>').filter((rad) => rad.includes('<span>rättade titeln'));
    expect(rader).toHaveLength(1);
    expect(rader[0]).toContain('människa · f31 människa');
    const fore = await raknaRader('events');
    const nekad = await request(bas).post(action).set({ ...huvuden, Origin: 'https://annan.example:8446' })
      .set('Cookie', kaka!).type('form').send(falt);
    expect(nekad.status).toBe(403);
    expect(await raknaRader('events')).toBe(fore);
  });
});

describe('FR-14/Story 3.1 AK 8: utan session', () => {
  it('F12 (AK 8): alla nio skrivrutter kräver session och skriver ingenting utan den', async () => {
    const f = await skrivfixtur('f31-12');
    const fore = await radrakning();
    const tillstand = await fixturensTillstand(f);
    for (const { vag, falt } of nioSkrivningar(f)) {
      const svar = await request(bas).post(vag).type('form').send(falt);
      expect(svar.status, vag).toBe(401);
      expect(svar.text).toContain('<h1>Inloggning krävs</h1>');
      expect(svar.text).toContain('<a href="/vy/logga-in?fran=');
    }
    expect(await radrakning()).toEqual(fore);
    expect(await fixturensTillstand(f)).toEqual(tillstand);
    await provaManniskansSkrivningar(f);
  });
});

describe('FR-14/Story 3.1 AK 10: agenternas API-väg', () => {
  it('F13 (AK 10): agentens kommentar bär agenten, samma anrop utan nyckel skriver ingenting', async () => {
    const input = { identifier, body: 'F31 agent via api' };
    const fore = await radrakning();
    const svar = await kor(app, agentnyckel, 'add_comment', input);
    expect(svar.status, svar.text).toBe(200);
    expect(await radrakning()).toEqual({ events: fore.events + 1, comments: fore.comments + 1 });
    const kommentar = await pool.query('SELECT aktor_typ, aktor_namn FROM comments WHERE id = $1', [svar.body.result.id]);
    expect(kommentar.rows).toEqual([{ aktor_typ: 'agent', aktor_namn: 'f31 agent' }]);
    const handelse = await pool.query(
      "SELECT aktor_typ, aktor_namn FROM events WHERE verb = 'kommenterade' AND payload->>'identifier' = $1 ORDER BY id DESC LIMIT 1", [identifier],
    );
    expect(handelse.rows).toEqual([{ aktor_typ: 'agent', aktor_namn: 'f31 agent' }]);
    const efter = await radrakning();
    const utan = await request(app).post('/api/actions/add_comment').send(input);
    expect(utan.status).toBe(401);
    expect(await radrakning()).toEqual(efter);
  });
});
