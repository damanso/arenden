// D-2, B-21 (Story 11.2): varje ärende har en stabil adress som alltid svarar. Adressen byggs i en modul,
// rutten svarar 308 eller 404 som HTML och aldrig 500, och varje ärendelänk i text pekar på något som finns.
// Fallistorna: D1–D5 adressen och modulen och D16 strängen i varje fil under src/ (AK 1); D6–D8 åtta
// actioner, fem fältlistor och två klienter (AK 3); D11 fem skrivsätt (AK 4); D9 sex tjänsteanrop med
// räknare, D10 fyra plus ett API-anrop och två vyadresser och D12 sju adresser (AK 5); D13 0, 1 och 50
// kandidater, D14–D15 sex referenser och två Linear-adresser på två sidtyper, D14 också fem formateringar
// runt numret och två bilageadresser som URL-tolken normaliserar, D17 renderarna utan databas och D20
// sexton former på tre renderare, där varje nummer som renderaren slår upp ska vara en kandidat (AK 6).
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { createIssue, listIssues } from '../src/adapter/index.js';
import { config } from '../src/config.js';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { nollstallIndex, type Dokumentindex } from '../src/http/vy/dokument.js';
import {
  arendekandidater,
  autolanka,
  renderaArendetext,
  renderaMarkdown,
  type Uppslag,
} from '../src/http/vy/markdown.js';
import { ARENDEPREFIX, arendeLank, arendeSokvag, nummeruppslagSokvag } from '../src/lib/arendelank.js';
import { kanoniskIdentifier } from '../src/lib/validation.js';
import { befintligaArenden, hamtaArende, hamtaArendeForAndring, sattSekvens } from '../src/services/arenden.js';
import { TEST_VAULT, TEST_VY_PUBLIK_URL } from './env.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

const ROT = fileURLToPath(new URL('../', import.meta.url));
const korProcess = promisify(execFile);

interface Kallfil {
  fil: string; // relativt repots rot, med '/': 'src/lib/arendelank.ts'
  text: string;
}

/** Varje .ts-fil under `katalog`, sorterad (som kallfiler() i test/mcp.test.ts). */
function kallfiler(katalog: string): Kallfil[] {
  return readdirSync(path.join(ROT, katalog), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.posix.join(katalog, f.split(path.sep).join('/')))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(ROT, fil), 'utf8') }));
}

const KANONISKA: [string, string][] = [
  ['LOC-503', 'LOC-503'], ['loc-503', 'LOC-503'], ['Loc-503', 'LOC-503'], ['LOC-0503', 'LOC-503'],
  ['abc1-07', 'ABC1-7'], ['LOC-0', 'LOC-0'], ['LOC-99999999999', 'LOC-99999999999'],
];
const INTE_IDENTIFIERARE = ['LOC', 'LOC-', 'LOC 503', '503', 'LOC-5o3', 'inte-ett-nummer', ''];

interface Rutt {
  service: string;
  method: string;
  router_pattern: string;
  public_pattern: string;
}

/** Ärendesidans post i adresskontraktet jämförd med modulens prefix; tom lista när de stämmer. */
function kontraktsfel(rutter: Rutt[]): string[] {
  const poster = rutter.filter((r) =>
    r.service === 'arenden' && r.method === 'GET' && r.router_pattern === '/arende/:identifier');
  if (poster.length !== 1) return [`${poster.length} poster för ärendesidan`];
  const monster = poster[0]!.public_pattern;
  return monster === ARENDEPREFIX + ':identifier' ? [] : [`public_pattern ${monster}`];
}

/** Filerna vars text, kommentarer också, innehåller ärendeadressens prefix (D16). */
function prefixfiler(filer: Kallfil[]): string[] {
  return filer.filter((f) => f.text.includes('/vy/arende/')).map((f) => f.fil);
}

/** Renderarens importer och frågor: tom lista när markdown.ts saknar databasåtkomst (D17). */
function renderarfel(text: string): string[] {
  const fel: string[] = [];
  for (const sats of text.match(/^import\b[^;]+;/gm) ?? []) {
    const spec = /['"]([^'"]+)['"];$/.exec(sats)?.[1] ?? '';
    if (spec === 'pg') fel.push('importerar pg');
    if (spec.includes('/services/')) fel.push(`importerar ${spec}`);
  }
  if (text.includes('.query(')) fel.push('anropar .query(');
  return fel;
}

/** Setteren anropas bara av konfigurationen, och adressmodulen importerar bara grannfilen validation. */
function setterfel(filer: Kallfil[]): string[] {
  const fel: string[] = [];
  for (const { fil, text } of filer) {
    const anrop = text.split('sattVyPublikUrl(').length - 1;
    if (fil === 'src/lib/arendelank.ts') {
      const importer = text.match(/^import\b[^;]+;/gm) ?? [];
      if (importer.length !== 1 || !/ from '\.\/validation\.js';$/.test(importer[0]!)) {
        fel.push(`${fil}: importerna ${JSON.stringify(importer)}`);
      }
    } else if (fil === 'src/config.ts') {
      if (anrop !== 1) fel.push(`${fil}: ${anrop} anrop av setteren`);
    } else if (anrop > 0) {
      fel.push(`${fil}: anropar setteren`);
    }
  }
  return fel;
}

describe('D-2/Story 11.2 AK 1: en adress och en funktion', () => {
  it('D1 (AK 1): den kanoniska adressen har teamnyckeln i versaler och numret utan inledande nollor', () => {
    const obs = KANONISKA.map(([s]) => ({ in: s, sokvag: arendeSokvag(s), kanonisk: kanoniskIdentifier(s) }));
    expect(obs).toEqual(KANONISKA.map(([s, ut]) => ({ in: s, sokvag: `/vy/arende/${ut}`, kanonisk: ut })));
    const fel = INTE_IDENTIFIERARE.map((s) => {
      let kastar = false;
      try {
        arendeSokvag(s);
      } catch {
        kastar = true;
      }
      return { in: s, kastar, kanonisk: kanoniskIdentifier(s) };
    });
    expect(fel).toEqual(INTE_IDENTIFIERARE.map((s) => ({ in: s, kastar: true, kanonisk: null })));
  });

  it('D2 (AK 1 och AK 6): nummeruppslaget är sökningen på den kanoniska formen', () => {
    expect(nummeruppslagSokvag('loc-099999')).toBe('/vy/sok?q=LOC-99999');
  });

  it('D3 (AK 1): den absoluta adressen är VY_PUBLIK_URL följd av sökvägen', () => {
    expect(arendeLank('loc-503')).toBe(config.VY_PUBLIK_URL + '/vy/arende/LOC-503');
    expect(arendeLank('loc-503')).toBe(TEST_VY_PUBLIK_URL + '/vy/arende/LOC-503');
  });

  it('D4 (AK 1): modulens prefix är adresskontraktets mönster för ärendesidan', () => {
    const kontrakt = JSON.parse(readFileSync(path.join(ROT, 'kontrakt/navigation.v1.json'), 'utf8')) as {
      routes: Rutt[];
    };
    expect(kontraktsfel(kontrakt.routes)).toEqual([]);
    expect(arendeSokvag('LOC-1').startsWith(ARENDEPREFIX)).toBe(true);
    // Kontroll: samma jämförelse fäller en post med ett annat mönster.
    const klon = kontrakt.routes.map((r) =>
      r.service === 'arenden' && r.method === 'GET' && r.router_pattern === '/arende/:identifier'
        ? { ...r, public_pattern: '/vy/arenden/:identifier' }
        : r);
    expect(kontraktsfel(klon)).toEqual(['public_pattern /vy/arenden/:identifier']);
  });

  it('D5 (AK 1): bara konfigurationen lämnar värdet, och modulen importerar bara validation', () => {
    const filer = kallfiler('src');
    expect(filer.map((f) => f.fil)).toEqual(expect.arrayContaining(['src/config.ts', 'src/lib/arendelank.ts']));
    expect(filer.filter((f) => f.text.includes('sattVyPublikUrl(')).map((f) => f.fil))
      .toEqual(['src/config.ts', 'src/lib/arendelank.ts']);
    expect(setterfel(filer)).toEqual([]);
    // Kontroll: en påhittad tjänstefil som anropar setteren, och en adressmodul som också importerar
    // konfigurationen, fälls var för sig.
    const tjanst = {
      fil: 'src/services/pahittad.ts',
      text: "import { sattVyPublikUrl } from '../lib/arendelank.js';\nsattVyPublikUrl('https://x.invalid');\n",
    };
    const modul = {
      fil: 'src/lib/arendelank.ts',
      text: "import { kanoniskIdentifier } from './validation.js';\nimport { config } from '../config.js';\n",
    };
    expect(setterfel([tjanst])).toEqual(['src/services/pahittad.ts: anropar setteren']);
    expect(setterfel([modul])).toHaveLength(1);
    expect(setterfel([modul])[0]).toContain('src/lib/arendelank.ts: importerna');
  });

  it('D16 (AK 1): ingen fil under src/ utom adressmodulen skriver ärendeadressens prefix', () => {
    const filer = kallfiler('src');
    expect(filer.map((f) => f.fil)).toEqual(expect.arrayContaining([
      'src/http/routes/vy.ts', 'src/http/vy/markdown.ts', 'src/http/vy/skrivning.ts', 'src/lib/arendelank.ts',
    ]));
    expect(prefixfiler(filer)).toEqual(['src/lib/arendelank.ts']);
    // Kontroll: en påhittad fil i vylagret som bygger adressen med en egen mallsträng fälls.
    expect(prefixfiler([{ fil: 'src/http/vy/pahittad.ts', text: 'const vag = `/vy/arende/${nummer}`;\n' }]))
      .toEqual(['src/http/vy/pahittad.ts']);
  });
});

// ---- Genom hela stacken ---------------------------------------------------------------------------------

const TEXTEN = 'Se LOC-503 och loc-503, men inte LOC-99999, ABC-1 eller UTF-8. Kod: `LOC-503`.';
const KOMMENTAREN = 'Kommentaren nämner LOC-503 och LOC-99999.';
// Granskningen (Review Follow-ups): LOC-504 nämns på LOC-503:s sida BARA formaterat och i bilageadresser
// som URL-tolken normaliserar. En kandidatlista som inte ser det renderaren ser gör då ett ärende som
// finns till «(finns inte)». _LOC-503_ är granskarens eget exempel.
const KOMMENTAREN_FORMATERAD =
  'Formaterat: _LOC-504_, _se LOC-504_, _LOC-504 först_ och **_LOC-504_**, och _LOC-503_.';
const LANK_504 = '<a href="/vy/arende/LOC-504">LOC-504</a>';
const FORMATERAT_HTML =
  `<p>Formaterat: <em>${LANK_504}</em>, <em>se ${LANK_504}</em>, <em>${LANK_504} först</em> och ` +
  `<strong><em>${LANK_504}</em></strong>, och <em><a href="/vy/arende/LOC-503">LOC-503</a></em>.</p>`;
// Tabb och radbrytning inne i numret: URL-tolken tar bort dem, så sökvägen bär LOC-504 men texten gör det inte.
const NORMALISERADE_BILAGOR = [
  { titel: 'Linear-länk med tabb', url: 'https://linear.app/locollabs/issue/LO\tC-504/flik' },
  { titel: 'Linear-länk med radbrytning', url: 'https://linear.app/locollabs/issue/LOC-5\n04/ny-rad' },
];
const DOKUMENTET = TEXTEN + '\n\n' +
  '[ärendet](https://linear.app/locollabs/issue/LOC-503/arendet) och [gamla](https://linear.app/locollabs/issue/LOC-99999/gamla)';
// Testvalvets fil, i en vitlistad katalog (src/http/vy/dokument.ts) — aldrig valvet.
const VALVFILEN = '01-Projekt/djuplank-11-2.md';
const NIOR_400 = 'LOC-' + '9'.repeat(400);
// Alltid i framtiden, räknat från klockan när provet körs (som SEN i test/insats.test.ts).
const UPPFOLJNING = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const GRUND = { typ: 'beslut', id: '153', version: '1' };

const ARENDEFALT = [
  'antal_barn', 'atagande_lage', 'claimad_av', 'description', 'due_date', 'foralder_id', 'foralder_identifier',
  'foralder_titel', 'id', 'identifier', 'kund_id', 'labels', 'milstolpe', 'priority', 'projekt', 'skapad',
  'source_ref', 'state_namn', 'state_typ', 'team_key', 'title', 'uppdaterad',
];
const TRAFFALT = ['id', 'identifier', 'rang', 'state_typ', 'title', 'traff_i'];
const ATAGANDEFALT = [
  'data', 'foljs_upp', 'identifier', 'issue_id', 'lage', 'overtaget_nar', 'revision', 'tillhor', 'utfall',
  'utforare_namn', 'utforare_typ',
];
const INSATSFALT = [
  'begard_handling', 'belagg', 'blockeringsgrund', 'fortsattning', 'frist', 'handlingskontrakt', 'id', 'issue_id',
  'kallor', 'lage', 'skapad', 'stopp_id', 'svar_aktor', 'svar_nar', 'svar_text', 'tillhor', 'typ', 'utfall',
  'vackningstid', 'version',
];

let app: Express;
let hermes: string;
let skapat: { id: string; identifier: string; arende: { lank?: unknown } };
let insatsMedArende: string;
let insatsUtanArende: string;

/** Ett anrop som MÅSTE lyckas (som i test/atagande-handelser.test.ts rad 60–64, bundet till filens app och nyckel). */
async function steg(action: string, input: Record<string, unknown>) {
  const svar = await kor(app, hermes, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

/** registrera_insats som grund() i test/insats.test.ts rad 21–33, med egen källa. */
function insats(stopp: string, objektId: string, extra: Record<string, unknown> = {}) {
  return {
    stopp_id: stopp,
    typ: 'agarbeslut',
    tillhor: 'agare',
    utfall: 'Riktningen är vald och arbetet kan fortsätta',
    begard_handling: 'Välj mellan A och B',
    blockeringsgrund: 'Tidigare besked avgör inte valet',
    handlingskontrakt: { system: 'hermes', kommando: 'beslutskoe --besvara', objekt: '#153' },
    kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: objektId }],
    ...extra,
  };
}

/** Instrumentering (som i test/sok-nummer.test.ts rad 103–119): varje räknad fråga går vidare till riktig Postgres. */
function raknandeKlient(client: PoolClient): { klient: PoolClient; antal: () => number } {
  let antal = 0;
  const klient = new Proxy(client, {
    get(mal, namn) {
      const varde: unknown = Reflect.get(mal, namn, mal);
      if (namn === 'query' && typeof varde === 'function') {
        return (...args: unknown[]) => {
          antal += 1;
          return (varde as (...a: unknown[]) => unknown).apply(mal, args);
        };
      }
      return typeof varde === 'function' ? (varde as (...a: unknown[]) => unknown).bind(mal) : varde;
    },
  });
  return { klient, antal: () => antal };
}

/**
 * Ett tjänsteanrop i en egen transaktion, så att ett databasfel i ett anrop inte avbryter nästa. Svaret
 * är felets namn (för ett databasfel också dess kod), eller 'inget', och antalet frågor anropet gjorde.
 */
async function tjanstanrop(anrop: (klient: PoolClient) => Promise<unknown>): Promise<{ fel: string; fragor: number }> {
  let fragor = 0;
  try {
    await withTransaction(async (client) => {
      const raknare = raknandeKlient(client);
      try {
        await anrop(raknare.klient);
      } finally {
        fragor = raknare.antal();
      }
    });
    return { fel: 'inget', fragor };
  } catch (err) {
    const namn = err instanceof Error ? err.name : String(err);
    const kod = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
    return { fel: namn === 'NotFoundError' ? namn : `${namn} ${kod}`.trim(), fragor };
  }
}

/** Ett svar från vyn: HTML-sida och inte API:ts JSON. */
function arHtml(svar: { headers: Record<string, string>; text: string }): boolean {
  return (svar.headers['content-type'] ?? '').includes('text/html') && !svar.text.startsWith('{');
}

// Python-klientens drivrutin, som i test/pythonklient.test.ts rad 37–58: bara ArendeFel fångas, och
// utdata är exakt en rad JSON.
const DRIVER = [
  'import json',
  'import sys',
  '',
  'sys.path.insert(0, sys.argv[1])',
  'import arenden_klient as klient',
  '',
  'operation = sys.argv[2]',
  'try:',
  '    if operation == "list_issues":',
  '        resultat = klient.list_issues()',
  '    elif operation == "create_issue":',
  '        resultat = klient.create_issue("D8 Pythonklienten", "LOC")',
  '    else:',
  '        sys.exit(2)',
  '    print(json.dumps({"ok": True, "resultat": resultat}))',
  'except klient.ArendeFel as fel:',
  '    print(json.dumps({"ok": False, "status": fel.status, "kod": fel.kod}))',
].join('\n');

/** Klientkopian mot testservern, med en tillfällig hemkatalog (som test/statusharledning.test.ts rad 64–75). */
async function korKlienten(hem: string, bas: string, operation: 'list_issues' | 'create_issue') {
  const { stdout } = await korProcess('python3', ['-I', '-B', '-c', DRIVER, path.join(ROT, 'adapter'), operation], {
    cwd: ROT,
    env: { PATH: process.env.PATH, HOME: hem, ARENDEN_API_URL: bas, ARENDEN_API_KEY: hermes },
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim()) as { ok: boolean; resultat?: Record<string, unknown>; status?: number; kod?: string };
}

describe('D-2/Story 11.2: genom hela stacken', () => {
  beforeAll(async () => {
    app = createApp();
    const team = await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    await withTransaction((client) => sattSekvens(client, team.sekvensnamn, 502));
    skapat = await steg('create_issue', { title: 'Djuplänksprovet huvudärende', team_key: 'LOC', description: TEXTEN });
    expect(skapat.identifier).toBe('LOC-503');
    expect((await steg('create_issue', { title: 'Djuplänksprovet delärende', team_key: 'LOC' })).identifier)
      .toBe('LOC-504');
    await steg('update_issue', { identifier: 'LOC-504', parent: 'LOC-503' });
    await steg('add_comment', { identifier: 'LOC-503', body: KOMMENTAREN });
    await steg('add_attachment', {
      identifier: 'LOC-503', titel: 'Gammal Linear-länk', url: 'https://linear.app/locollabs/issue/LOC-503/arendet',
    });
    await steg('add_attachment', {
      identifier: 'LOC-503', titel: 'Borttaget Linear-ärende', url: 'https://linear.app/locollabs/issue/LOC-99999/gamla',
    });
    await steg('add_comment', { identifier: 'LOC-503', body: KOMMENTAREN_FORMATERAD });
    for (const { titel, url } of NORMALISERADE_BILAGOR) await steg('add_attachment', { identifier: 'LOC-503', titel, url });
    await steg('registrera_atagande', {
      identifier: 'LOC-503',
      grund: [GRUND],
      nasta: { handling: 'Bygg klart', slag: 'internt', grund: GRUND },
      foljs_upp: UPPFOLJNING,
    });
    insatsMedArende = (await steg('registrera_insats', insats('djuplank-stopp-1', 'djuplank-1', { identifier: 'LOC-503' })))
      .insats.id;
    insatsUtanArende = (await steg('registrera_insats', insats('djuplank-stopp-2', 'djuplank-2'))).insats.id;

    await mkdir(path.join(TEST_VAULT, '01-Projekt'), { recursive: true });
    await writeFile(path.join(TEST_VAULT, VALVFILEN), DOKUMENTET, 'utf8');
    nollstallIndex();
  });

  afterAll(async () => {
    await rm(path.join(TEST_VAULT, VALVFILEN), { force: true });
  });

  describe('D-2/Story 11.2 AK 3: läsmodellerna bär adressen', () => {
    it('D6 (AK 3): åtta actioner bär lank för varje ärende, sökträff, åtagande och insats', async () => {
      const obs: { action: string; falt: string; lank: unknown }[] = [];
      const vantat: { action: string; falt: string; lank: unknown }[] = [];
      const notera = (action: string, falt: string, post: { lank?: unknown }, lank: string | null) => {
        obs.push({ action, falt, lank: post.lank });
        vantat.push({ action, falt, lank });
      };

      const huvud = await steg('get_issue', { identifier: 'LOC-503' });
      const del = await steg('get_issue', { identifier: 'LOC-504' });
      notera('get_issue', 'arende', huvud.arende, arendeLank(huvud.arende.identifier));
      for (const b of huvud.barn) notera('get_issue', `barn ${b.identifier}`, b, arendeLank(b.identifier));

      for (const a of (await steg('list_issues', {})).arenden) {
        notera('list_issues', `arenden ${a.identifier}`, a, arendeLank(a.identifier));
      }
      const traffar = await steg('search_issues', { fraga: 'Djuplänksprovet' });
      for (const t of traffar) notera('search_issues', `träff ${t.identifier}`, t, arendeLank(t.identifier));
      notera('create_issue', 'arende', skapat.arende, arendeLank('LOC-503'));

      const atagande = await steg('get_atagande', { identifier: 'LOC-503' });
      notera('get_atagande', 'åtagandet', atagande, arendeLank(atagande.identifier));
      for (const a of await steg('list_ataganden', {})) {
        notera('list_ataganden', `åtagandet ${a.identifier}`, a, arendeLank(a.identifier));
      }

      notera('get_insats', 'med ärende', await steg('get_insats', { id: insatsMedArende }), arendeLank('LOC-503'));
      notera('get_insats', 'utan ärende', await steg('get_insats', { id: insatsUtanArende }), null);
      const identifierFor = new Map<string, string>([
        [huvud.arende.id, 'LOC-503'], [del.arende.id, 'LOC-504'],
      ]);
      for (const i of await steg('list_insatser', {})) {
        const identifier = i.issue_id === null ? null : identifierFor.get(i.issue_id) ?? 'okänt ärende';
        notera('list_insatser', `insatsen ${i.stopp_id}`, i,
          identifier === null || identifier === 'okänt ärende' ? identifier : arendeLank(identifier));
      }

      expect(obs).toEqual(vantat);
      // Fallistan är hel: varje action gav sina poster, och den absoluta adressen står ordagrant.
      expect(huvud.barn.map((b: { identifier: string }) => b.identifier)).toEqual(['LOC-504']);
      expect(traffar.length).toBeGreaterThanOrEqual(1);
      expect(obs.filter((o) => o.action === 'list_issues').length).toBeGreaterThanOrEqual(2);
      expect(obs.filter((o) => o.action === 'list_ataganden').length).toBeGreaterThanOrEqual(1);
      expect(obs.filter((o) => o.action === 'list_insatser').map((o) => o.falt).sort())
        .toEqual(['insatsen djuplank-stopp-1', 'insatsen djuplank-stopp-2']);
      expect(huvud.arende.lank).toBe(TEST_VY_PUBLIK_URL + '/vy/arende/LOC-503');
    });

    it('D7 (AK 3): inget fält tas bort, och lank har tillkommit i varje läsmodell', async () => {
      const bild = (modell: string, post: Record<string, unknown>) => {
        const nycklar = Object.keys(post);
        return { modell, lank: nycklar.includes('lank'), ovriga: nycklar.filter((n) => n !== 'lank').sort() };
      };
      const arende = (await steg('get_issue', { identifier: 'LOC-503' })).arende;
      const traff = ((await steg('search_issues', { fraga: 'Djuplänksprovet' })) as { identifier: string }[])
        .find((t) => t.identifier === 'LOC-503');
      const atagande = await steg('get_atagande', { identifier: 'LOC-503' });
      const listat = ((await steg('list_ataganden', {})) as { identifier: string }[])
        .find((a) => a.identifier === 'LOC-503');
      const insatsen = await steg('get_insats', { id: insatsMedArende });
      expect([
        bild('get_issue', arende),
        bild('search_issues', traff ?? {}),
        bild('get_atagande', atagande),
        bild('list_ataganden', listat ?? {}),
        bild('get_insats', insatsen),
      ]).toEqual([
        { modell: 'get_issue', lank: true, ovriga: [...ARENDEFALT].sort() },
        { modell: 'search_issues', lank: true, ovriga: [...TRAFFALT].sort() },
        { modell: 'get_atagande', lank: true, ovriga: [...ATAGANDEFALT].sort() },
        { modell: 'list_ataganden', lank: true, ovriga: [...ATAGANDEFALT, 'forfallen_uppfoljning'].sort() },
        { modell: 'get_insats', lank: true, ovriga: [...INSATSFALT].sort() },
      ]);
      expect([arende.identifier, traff?.identifier, atagande.identifier]).toEqual(['LOC-503', 'LOC-503', 'LOC-503']);
    });

    it('D8 (AK 3): TS-adaptern och klientkopian fungerar oförändrat mot de ändrade svaren', async () => {
      let server: Server | undefined;
      let hem: string | undefined;
      try {
        hem = await mkdtemp(path.join(tmpdir(), 'arenden-djuplank-klient-'));
        server = await new Promise<Server>((klar, fel) => {
          const s = app.listen(0, '127.0.0.1', () => klar(s));
          s.once('error', fel);
        });
        const bas = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const options = { basUrl: bas, nyckel: hermes };

        const sida = await listIssues({}, options);
        const noder = sida.noder as unknown as { identifier: string; lank?: unknown }[];
        expect(noder.length).toBeGreaterThanOrEqual(2);
        expect(noder.map((n) => ({ identifier: n.identifier, lank: n.lank })))
          .toEqual(noder.map((n) => ({ identifier: n.identifier, lank: arendeLank(n.identifier) })));
        const ny = await createIssue({ titel: 'D8 adaptern', teamKey: 'LOC' }, options);
        expect(Object.keys(ny).sort()).toEqual(['id', 'identifier']);

        const lista = await korKlienten(hem, bas, 'list_issues');
        expect(lista.ok, JSON.stringify(lista)).toBe(true);
        const pyNoder = (lista.resultat as { noder: { identifier: string; lank?: unknown }[] }).noder;
        expect(pyNoder.length).toBeGreaterThanOrEqual(2);
        expect(pyNoder.map((n) => ({ identifier: n.identifier, lank: n.lank })))
          .toEqual(pyNoder.map((n) => ({ identifier: n.identifier, lank: arendeLank(n.identifier) })));
        const pyNy = await korKlienten(hem, bas, 'create_issue');
        expect(pyNy.ok, JSON.stringify(pyNy)).toBe(true);
        expect(Object.keys(pyNy.resultat ?? {}).sort()).toEqual(['id', 'identifier']);
      } finally {
        try {
          if (server) await new Promise<void>((klar, fel) => server!.close((e) => (e ? fel(e) : klar())));
        } finally {
          if (hem) await rm(hem, { recursive: true, force: true });
        }
      }
    });
  });

  describe('D-2/Story 11.2 AK 4: skrivsätt i adressen', () => {
    it('D11 (AK 4 och AK 9): varje skrivsätt av ett befintligt nummer ger 308 till den kanoniska adressen', async () => {
      const fore = await raknaRader('events');
      const RUBRIK = '<h1>LOC-503 — Djuplänksprovet huvudärende</h1>';
      // Motkontroll först: den kanoniska formen svarar 200 direkt, före och efter koden.
      const kanonisk = await request(app).get('/vy/arende/LOC-503');
      expect({ status: kanonisk.status, location: kanonisk.headers['location'] ?? null }).toEqual({
        status: 200, location: null,
      });
      expect(kanonisk.text).toContain(RUBRIK);

      const ADRESSER = ['loc-503', 'Loc-503', 'LOC-0503', 'loc-503?notis=inloggad', 'LOC-503/'];
      const obs = [];
      for (const adress of ADRESSER) {
        const svar = await request(app).get(`/vy/arende/${adress}`);
        obs.push({ adress, status: svar.status, location: svar.headers['location'] ?? null });
      }
      expect(obs).toEqual(ADRESSER.map((adress) => ({
        adress,
        status: 308,
        location: adress.includes('?notis=inloggad') ? '/vy/arende/LOC-503?notis=inloggad' : '/vy/arende/LOC-503',
      })));
      for (const { adress, location } of obs) {
        const sida = await request(app).get(location!);
        expect(sida.status, adress).toBe(200);
        expect(sida.text, adress).toContain(RUBRIK);
      }
      expect(await raknaRader('events')).toBe(fore);
    });
  });

  describe('D-2/Story 11.2 AK 5: ett ärende som inte finns ger ärligt 404, aldrig 500', () => {
    it('D9 (AK 5): tjänstelagrets gräns står före frågan i de två uppslagen på en identifierare', async () => {
      const fall = [
        ['LOC-99999999999', 0],
        [NIOR_400, 0],
        ['LOC-2147483647', 1],
      ] as const;
      const obs = [];
      const vantat = [];
      for (const [funktion, slaUpp] of [
        ['hamtaArende', hamtaArende],
        ['den låsande läsningen', hamtaArendeForAndring],
      ] as const) {
        for (const [identifier, fragor] of fall) {
          const utfall = await tjanstanrop((klient) => slaUpp(klient, TENANT_ID, identifier));
          obs.push({ funktion, identifier: identifier.slice(0, 20), ...utfall });
          vantat.push({ funktion, identifier: identifier.slice(0, 20), fel: 'NotFoundError', fragor });
        }
      }
      expect(obs).toEqual(vantat);
    });

    it('D10 (AK 5 och AK 9): API:t svarar not_found och vyn HTML för nummer över gränsen, utan rader', async () => {
      const fore = await raknaRader('events');
      // Motkontroll först: ärendet som finns svarar 200 i båda vägarna, före och efter koden.
      expect((await kor(app, hermes, 'get_issue', { identifier: 'LOC-503' })).status).toBe(200);
      expect((await request(app).get('/vy/arende/LOC-503')).status).toBe(200);

      const obs = [];
      for (const identifier of ['LOC-99999', 'LOC-99999999999', NIOR_400, 'XYZ-1']) {
        const svar = await kor(app, hermes, 'get_issue', { identifier });
        obs.push({ vag: `get_issue ${identifier.slice(0, 20)}`, status: svar.status, html: false, error: svar.body.error });
      }
      const byte = await kor(app, hermes, 'update_issue_state', { identifier: 'LOC-99999999999', state_typ: 'started' });
      obs.push({ vag: 'update_issue_state LOC-99999999999', status: byte.status, html: false, error: byte.body.error });
      // Motprovets byggdel (AK 9): före Uppgift 2 nådde båda numren databasen.
      for (const identifier of ['LOC-99999999999', NIOR_400]) {
        const svar = await request(app).get(`/vy/arende/${identifier}`);
        obs.push({ vag: `/vy/arende/${identifier.slice(0, 20)}`, status: svar.status, html: arHtml(svar), error: null });
      }
      expect(obs).toEqual([
        ...['LOC-99999', 'LOC-99999999999', NIOR_400, 'XYZ-1'].map((identifier) => ({
          vag: `get_issue ${identifier.slice(0, 20)}`, status: 404, html: false, error: 'not_found',
        })),
        { vag: 'update_issue_state LOC-99999999999', status: 404, html: false, error: 'not_found' },
        ...['LOC-99999999999', NIOR_400].map((identifier) => ({
          vag: `/vy/arende/${identifier.slice(0, 20)}`, status: 404, html: true, error: null,
        })),
      ]);
      expect(await raknaRader('events')).toBe(fore);
    });

    it('D12 (AK 5 och AK 9): ett nummer som inte finns och en sökväg som inte är ett nummer ger 404 som HTML med sökformuläret', async () => {
      const fore = await raknaRader('events');
      // Motkontroll först: ärendet som finns svarar 200, före och efter koden.
      expect((await request(app).get('/vy/arende/LOC-503')).status).toBe(200);

      const notisOchForm = (text: string) => {
        const kropp = text.slice(Math.max(text.indexOf('<h1>Hittades inte</h1>'), 0));
        return {
          notis: /<p class=notis>.*?<\/p>/.exec(kropp)?.[0] ?? null,
          form: /<form class=sok method=get action="\/vy\/sok">.*?<input type=search id=q name=q value="([^"]*)"/
            .exec(kropp)?.[1] ?? null,
        };
      };
      const FINNS_INTE = ['LOC-99999', 'LOC-99999999999', NIOR_400, 'XYZ-1'];
      const INTE_NUMMER = ['inte-ett-nummer', 'LOC-5o3', 'LOC'];
      const obs = [];
      for (const adress of [...FINNS_INTE, ...INTE_NUMMER]) {
        const svar = await request(app).get(`/vy/arende/${adress}`);
        obs.push({
          adress: adress.slice(0, 20),
          status: svar.status,
          html: (svar.headers['content-type'] ?? '').includes('text/html'),
          ...notisOchForm(svar.text),
          json: svar.text.startsWith('{'),
        });
      }
      expect(obs).toEqual([
        ...FINNS_INTE.map((text) => ({
          adress: text.slice(0, 20), status: 404, html: true,
          notis: `<p class=notis>Ärendet ${text} finns inte.</p>`, form: text, json: false,
        })),
        ...INTE_NUMMER.map((sokvag) => ({
          adress: sokvag, status: 404, html: true,
          notis: `<p class=notis>&quot;${sokvag}&quot; är inte ett ärendenummer (de ser ut som LOC-316).</p>`,
          form: '', json: false,
        })),
      ]);
      // Formuläret är sökningens, byte för byte (Dev Notes → Markup), mellan notisen och länken till överblicken.
      expect((await request(app).get('/vy/arende/LOC-99999')).text).toContain(
        '<h1>Hittades inte</h1><p class=notis>Ärendet LOC-99999 finns inte.</p>' +
          '<form class=sok method=get action="/vy/sok"><label class=dold for=q>Sök i titlar, beskrivningar och kommentarer</label>' +
          '<input type=search id=q name=q value="LOC-99999" placeholder="Sök i titlar, beskrivningar och kommentarer">' +
          '<button type=submit>Sök</button></form><p><a href="/vy">Till överblicken</a></p>',
      );
      expect(await raknaRader('events')).toBe(fore);
    });
  });

  describe('D-2/Story 11.2 AK 6: varje LOC-N blir en intern länk, och ingen länk ger 404', () => {
    it('D13 (AK 6): de befintliga numren slås upp i exakt en fråga för 0, 1 och 50 kandidater', async () => {
      const femtio = [
        'LOC-503', 'LOC-504', ...Array.from({ length: 47 }, (_, n) => `LOC-${n + 1}`), 'LOC-99999999999',
      ];
      expect(femtio).toHaveLength(50);
      const obs: unknown[] = [];
      await withTransaction(async (client) => {
        for (const [fall, kandidater] of [['0', []], ['1', ['LOC-503']], ['50', femtio]] as const) {
          const raknare = raknandeKlient(client);
          const svar = await befintligaArenden(raknare.klient, TENANT_ID, kandidater);
          obs.push({
            fall,
            loc: svar.team.has('LOC'),
            abc: svar.team.has('ABC'),
            arenden: [...svar.arenden].sort(),
            fragor: raknare.antal(),
          });
        }
      });
      expect(obs).toEqual([
        { fall: '0', loc: true, abc: false, arenden: [], fragor: 1 },
        { fall: '1', loc: true, abc: false, arenden: ['LOC-503'], fragor: 1 },
        { fall: '50', loc: true, abc: false, arenden: ['LOC-503', 'LOC-504'], fragor: 1 },
      ]);
    });

    it('D14 (AK 6 och AK 9): ärendesidan länkar det som finns, nummeruppslaget för det som inte finns', async () => {
      const fore = await raknaRader('events');
      const sida = await request(app).get('/vy/arende/LOC-503');
      expect(sida.status).toBe(200);
      // Motkontroll först: versalerna länkades redan före koden.
      expect(sida.text).toContain('<a href="/vy/arende/LOC-503">LOC-503</a>');

      const avsnitt = (fran: string, till: string) => {
        const start = sida.text.indexOf(fran);
        return start === -1 ? '' : sida.text.slice(start, sida.text.indexOf(till, start + fran.length));
      };
      const beskrivning = avsnitt('<h2>Beskrivning</h2>', '<h2>');
      const kommentarer = avsnitt('<h2>Kommentarer (', '<h2>Historik');
      const finnsInte = '<a href="/vy/sok?q=LOC-99999">LOC-99999</a> (finns inte)';
      expect({
        gemener: beskrivning.includes('<a href="/vy/arende/LOC-503">loc-503</a>'),
        kodInline: beskrivning.includes('<code><a href="/vy/arende/LOC-503">LOC-503</a></code>'),
        finnsInteIBeskrivningen: beskrivning.includes(finnsInte),
        finnsInteIKommentaren: kommentarer.includes(finnsInte),
        abcSomText: beskrivning.includes('ABC-1') && !sida.text.includes('>ABC-1</a>'),
        utfSomText: beskrivning.includes('UTF-8') && !sida.text.includes('>UTF-8</a>'),
        ingenLankTillSaknat: !sida.text.includes('href="/vy/arende/LOC-99999"'),
        bilagaSomFinns: sida.text.includes(
          '<li class=rad><div class=huvud><a href="/vy/arende/LOC-503">LOC-503</a><span>tidigare Linear-länk</span>' +
            '</div><div class=text>Gammal Linear-länk</div></li>',
        ),
        bilagaSomInteFinns: sida.text.includes(
          '<div class=huvud><a href="/vy/sok?q=LOC-99999">LOC-99999</a> (finns inte)<span>tidigare Linear-länk</span></div>',
        ),
      }).toEqual({
        gemener: true,
        kodInline: true,
        finnsInteIBeskrivningen: true,
        finnsInteIKommentaren: true,
        abcSomText: true,
        utfSomText: true,
        ingenLankTillSaknat: true,
        bilagaSomFinns: true,
        bilagaSomInteFinns: true,
      });

      // Granskningen: ett ärende som finns länkas till sin adress hur numret än är formaterat eller
      // normaliserat, och inget ärende som finns får en länk till nummeruppslaget.
      const bilagerad = (titel: string) =>
        `<li class=rad><div class=huvud>${LANK_504}<span>tidigare Linear-länk</span></div>` +
        `<div class=text>${titel}</div></li>`;
      expect({
        formateratIKommentaren: kommentarer.includes(FORMATERAT_HTML),
        ...Object.fromEntries(NORMALISERADE_BILAGOR.map(({ titel }) => [titel, sida.text.includes(bilagerad(titel))])),
        uppslagFor504: sida.text.includes('/vy/sok?q=LOC-504'),
        uppslagFor503: sida.text.includes('/vy/sok?q=LOC-503'),
      }).toEqual({
        formateratIKommentaren: true,
        ...Object.fromEntries(NORMALISERADE_BILAGOR.map(({ titel }) => [titel, true])),
        uppslagFor504: false,
        uppslagFor503: false,
      });
      expect(await raknaRader('events')).toBe(fore);
    });

    it('D15 (AK 6): dokumentsidan länkar på samma sätt, och nummeruppslaget svarar', async () => {
      const fore = await raknaRader('events');
      const sida = await request(app).get(`/vy/dok/${VALVFILEN}`);
      expect(sida.status).toBe(200);
      expect({
        versaler: sida.text.includes('<a href="/vy/arende/LOC-503">LOC-503</a>'),
        gemener: sida.text.includes('<a href="/vy/arende/LOC-503">loc-503</a>'),
        kodInline: sida.text.includes('<code><a href="/vy/arende/LOC-503">LOC-503</a></code>'),
        finnsInte: sida.text.includes('<a href="/vy/sok?q=LOC-99999">LOC-99999</a> (finns inte)'),
        abcSomText: sida.text.includes('ABC-1') && !sida.text.includes('>ABC-1</a>'),
        utfSomText: sida.text.includes('UTF-8') && !sida.text.includes('>UTF-8</a>'),
        ingenLankTillSaknat: !sida.text.includes('href="/vy/arende/LOC-99999"'),
        linearSomFinns: sida.text.includes('ärendet (<a href="/vy/arende/LOC-503">LOC-503</a>, tidigare Linear-länk)'),
        linearSomInteFinns: sida.text.includes(
          'gamla (<a href="/vy/sok?q=LOC-99999">LOC-99999</a> (finns inte), tidigare Linear-länk)',
        ),
      }).toEqual({
        versaler: true,
        gemener: true,
        kodInline: true,
        finnsInte: true,
        abcSomText: true,
        utfSomText: true,
        ingenLankTillSaknat: true,
        linearSomFinns: true,
        linearSomInteFinns: true,
      });
      // Länken till nummeruppslaget följs: sökningen säger att numret saknas (Story 11.1 AK 4).
      const uppslag = await request(app).get('/vy/sok?q=LOC-99999');
      expect(uppslag.status).toBe(200);
      expect(uppslag.text).toContain('<p class=notis>Inget ärende har numret LOC-99999.</p>');
      expect(await raknaRader('events')).toBe(fore);
    });

    it('D17 (AK 6): renderarna har ingen databasåtkomst, och vyn slår upp numren en gång per sidtyp', () => {
      const markdown = readFileSync(path.join(ROT, 'src/http/vy/markdown.ts'), 'utf8');
      const vy = readFileSync(path.join(ROT, 'src/http/routes/vy.ts'), 'utf8');
      expect(renderarfel(markdown)).toEqual([]);
      expect(vy.split('befintligaArenden(').length - 1).toBe(2);
      // Kontroll: en påhittad renderare som importerar uppslaget ur tjänstelagret fälls.
      expect(renderarfel("import { befintligaArenden } from '../../services/arenden.js';\n"))
        .toEqual(['importerar ../../services/arenden.js']);
    });

    it('D20 (AK 6 och AK 7): varje nummer som renderaren slår upp är en kandidat, hur texten än är formaterad', () => {
      const INDEX: Dokumentindex = { filnamn: new Map() };
      const RENDERARE: [string, (text: string, uppslag: Uppslag) => string][] = [
        ['ärendetexten', (text, uppslag) => renderaArendetext(text, INDEX, uppslag)],
        ['dokumentet', (text, uppslag) => renderaMarkdown(text, INDEX, uppslag)],
        ['autolänkaren', (text, uppslag) => autolanka(text, INDEX, uppslag)],
      ];
      // Numret ensamt, i varje formatering som renderarna känner (understrecken är granskningens fynd),
      // i en Linear-adress och med gemener och inledande nolla.
      const FORMER = [
        'LOC-504', '_LOC-504_', '_se LOC-504_', '_LOC-504 först_', '**_LOC-504_**', '*_LOC-504_*',
        '*LOC-504*', '**LOC-504**', '`LOC-504`', '`` LOC-504 ``', '## LOC-504', '> LOC-504', '- LOC-504',
        '1. LOC-504', '[gammal](https://linear.app/locollabs/issue/LOC-504/x)', 'loc-0504',
      ];
      // Varje kandidat räknas som befintlig: en länk till nummeruppslaget betyder då att renderaren slog
      // upp ett nummer som inte var en kandidat.
      const obs = RENDERARE.flatMap(([renderare, rendera]) => FORMER.map((form) => {
        const kandidater = arendekandidater((uppslag) => rendera(form, uppslag));
        const html = rendera(form, { team: new Set(['LOC']), arenden: new Set(kandidater) });
        return { renderare, form, uppslag: html.includes('/vy/sok?q='), lankad: html.includes('href="/vy/arende/LOC-504"') };
      }));
      expect(obs).toHaveLength(RENDERARE.length * FORMER.length);
      expect(obs.filter((o) => o.uppslag)).toEqual([]);
      // Fallen är inte tomma: ärendetexten länkar numret i varje form, dokumentet åtminstone ensamt och i
      // Linear-adressen.
      expect(obs.filter((o) => o.renderare === 'ärendetexten' && !o.lankad)).toEqual([]);
      expect(obs.filter((o) => o.renderare === 'dokumentet' && o.lankad).map((o) => o.form))
        .toEqual(expect.arrayContaining(['LOC-504', '[gammal](https://linear.app/locollabs/issue/LOC-504/x)']));

      // Kontroll: kandidater ur ett eget mönsterpass över hela texten (mekanismen före granskningen) fälls
      // för kursiv med understreck, så mätningen kan slå ut.
      const monsterpass = (text: string) =>
        [...text.matchAll(/\b([A-Za-z][A-Za-z0-9]{0,9}-\d+)\b/g)].flatMap((m) => kanoniskIdentifier(m[1]!) ?? []);
      expect(monsterpass('_LOC-504_')).toEqual([]);
      expect(renderaArendetext('_LOC-504_', INDEX, { team: new Set(['LOC']), arenden: new Set(monsterpass('_LOC-504_')) }))
        .toContain('<a href="/vy/sok?q=LOC-504">LOC-504</a> (finns inte)');
    });
  });
});

// ---- AK 8 och dokumentationen ----------------------------------------------------------------------------

// AK 8:s sex former. Vylagret är src/http/routes/vy.ts och varje fil under src/http/vy/; hälsokontrollens
// SQL i src/http/app.ts hör inte dit (Dev Notes → Tolkningar, punkt 7). Kommentarer räknas.
const SQL_FORMER: { namn: string; monster: RegExp }[] = [
  { namn: '.query(', monster: /\.query\(/ },
  { namn: 'SELECT', monster: /\bSELECT\b/ },
  { namn: 'INSERT INTO', monster: /\bINSERT\s+INTO\b/ },
  { namn: 'DELETE FROM', monster: /\bDELETE\s+FROM\b/ },
  { namn: 'UPDATE … SET', monster: /\bUPDATE\s+\w+\s+SET\b/ },
  { namn: 'värdeimport av pg', monster: /^import\s+(?!type\b)[^;]*\bfrom\s+['"]pg['"]/m },
];

function sqlfel(filer: Kallfil[]): string[] {
  return filer.flatMap(({ fil, text }) => SQL_FORMER.filter((f) => f.monster.test(text)).map((f) => `${fil}: ${f.namn}`));
}

const D1_RUBRIK = '### D-1 — sökningen öppnar ärendet på sitt nummer (Story 11.1)';
const D2_RUBRIK = '### D-2 — varje ärende har en stabil adress som alltid svarar (Story 11.2)';
const D2_REGELNS_BORJAN = '- Ärendets adress (D-2, B-21, Story 11.2):';
/** Ordagrant som i regelkällan (Dev Notes → Dokumentationen). */
const D2_REGELN =
  '- Ärendets adress (D-2, B-21, Story 11.2): en ärendelänk byggs bara med `arendeSokvag()` (inom huset) eller ' +
  '`arendeLank()` (absolut) i `src/lib/arendelank.ts`, och ingen annan fil under `src/` skriver ärendeadressens ' +
  'prefix. `src/config.ts` lämnar `VY_PUBLIK_URL` till modulen med `sattVyPublikUrl()`, och tjänstelagret ' +
  'importerar aldrig konfigurationen. En länk till ett ärende renderas bara när ärendet finns: `arendereferens()` ' +
  'länkar ett nummer som inte finns till nummeruppslaget i `/vy/sok` med «(finns inte)», och ett okänt team blir ' +
  'vanlig text. Mängden befintliga nummer hämtas en gång per sida med `befintligaArenden()`, och renderarna får ' +
  'den som parameter.';

/** Avsnittets gränser: från rubriken till nästa rad som börjar med '## ' eller '### '. */
function d2Avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(D2_RUBRIK);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/** Fynden för D19: rubriken en gång och på sin plats, regelns rad ordagrant en gång och tre tabellrader. */
function d2Readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = d2Avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const fel: string[] = [];
  if (rader.filter((r) => r === D2_RUBRIK).length !== 1) fel.push('rubriken står inte exakt en gång');
  const d1 = rader.indexOf(D1_RUBRIK);
  if (d1 === -1 || d1 > granser.start) fel.push('rubriken står inte efter avsnittet för D-1');
  const granserna = rader.indexOf('## Gränser för Etapp 2a');
  if (granserna === -1 || granserna < granser.start) fel.push('rubriken står inte före gränserna för Etapp 2a');
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const regler = avsnitt.filter((r) => r.startsWith(D2_REGELNS_BORJAN));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== D2_REGELN) fel.push('regeln avviker');
  const tabell = avsnitt.filter((r) => r.startsWith('| D-2'));
  if (tabell.length !== 3) fel.push(`${tabell.length} rader börjar med | D-2`);
  for (const r of tabell) if (!r.includes('test/djuplank.test.ts')) fel.push(`rad utan provfilen: ${r}`);
  return fel;
}

describe('D-2/Story 11.2 AK 8: läsningen skriver ingenting, och vylagret har ingen SQL', () => {
  it('D18 (AK 8) (R): ingen fil i vylagret innehåller någon av AK 8:s sex former', () => {
    const vylagret = [
      { fil: 'src/http/routes/vy.ts', text: readFileSync(path.join(ROT, 'src/http/routes/vy.ts'), 'utf8') },
      ...kallfiler('src/http/vy'),
    ];
    expect(vylagret.map((f) => f.fil)).toEqual(expect.arrayContaining([
      'src/http/routes/vy.ts', 'src/http/vy/markdown.ts', 'src/http/vy/skrivning.ts',
    ]));
    expect(sqlfel(vylagret)).toEqual([]);
    // Kontroll: sex påhittade texter, en per form, fälls var för sig.
    const pahittade = [
      'const svar = await client.query(fraga);',
      "const fraga = 'SELECT id FROM issues';",
      "const fraga = 'INSERT INTO events (verb) VALUES ($1)';",
      "const fraga = 'DELETE FROM comments WHERE id = $1';",
      "const fraga = 'UPDATE issues SET title = $1';",
      "import pg from 'pg';",
    ];
    expect(pahittade.map((text) => sqlfel([{ fil: 'src/http/vy/pahittad.ts', text }])))
      .toEqual(SQL_FORMER.map((f) => [`src/http/vy/pahittad.ts: ${f.namn}`]));
  });
});

describe('D-2/Story 11.2: README bär regeln (krav → kod → test)', () => {
  it('D19 (dokumentationen): avsnittet bär regeln och tre rader krav → kod → test', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect(d2Readmefel(readme)).toEqual([]);
    // Kontroll: samma prövning på texten utan avsnittet fälls.
    const rader = readme.split('\n');
    const granser = d2Avsnittet(rader.map((r) => r.replace(/\r$/, '')));
    const utan = granser === null ? readme : [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
    expect(d2Readmefel(utan)).toEqual(['rubriken saknas']);
  });
});
