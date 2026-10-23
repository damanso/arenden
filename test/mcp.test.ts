// FR-24 (d), Story 4.2: Claude-sessionen når ärendenas actions och inget annat.
//
// Filen prövar MCP-gatewayen under src/mcp/, och den är berättelsens enda provfil. Kriterierna, som
// granskaren kan läsa av här:
//   AK 1  protokollet (initialize, ping, notifieringar, tools/list, tools/call) och den slutna listan med
//         sju verktyg, namn och titel ur actionManifest(); inga nya beroenden (F1–F4, F12, F16);
//   AK 2  get_issue går som POST /api/actions/get_issue med bearer, och gatewayen har ingen databas (F5–F7);
//   AK 3  aktören tas ur nyckeln, och aktörsfält avvisas före anropet (F1, F3, F8, F9);
//   AK 4  inget namn utanför listan når API:t, och det statiska provet fäller förbjudna importer och
//         texter i src/mcp/ (F1, F6, F10);
//   AK 5  API:ts fel blir verktygsfel med felkoden, aldrig ett stackspår, och gatewayens egen gräns (F4,
//         F11, F13, F14);
//   AK 6  gatewayen binder bara 127.0.0.1, vad miljön och anroparen än säger (F5, F6, F15).
//
// Ingen vi.mock och ingen attrapp av API:t: testservern är den riktiga appen, createApp() framför
// testdatabasen, på loopback med en port som systemet väljer. Den stängda porten är den enda felvägen för
// nätet, och API:ts 429 prövas på funktionsnivå med tolkaSvar() (docs/project-context.md, Testregler).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actionManifest } from '../src/actions/registry.js';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { proveniens } from '../src/http/vy/mall.js';
import { GATEWAYKONFIG, INGA_SESSIONER, skapaMcpApp, startaGateway } from '../src/mcp/server.js';
import { VERKTYG, VERKTYGSNAMN, byggVerktyg, hittaVerktyg, tolkaSvar } from '../src/mcp/verktyg.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

/** Dev Notes → Verktygen och deras indata: egenskaperna i ordning och kolumnen Krävs. */
const TABELL: Record<string, { egenskaper: string[]; kravs: string[] }> = {
  get_issue: { egenskaper: ['identifier'], kravs: ['identifier'] },
  list_issues: {
    egenskaper: ['state_typer', 'team_key', 'label', 'projekt', 'kund_id', 'cursor', 'limit'],
    kravs: [],
  },
  search_issues: { egenskaper: ['fraga', 'limit'], kravs: ['fraga'] },
  create_issue: {
    egenskaper: ['title', 'description', 'team_key', 'labels', 'priority', 'due', 'projekt'],
    kravs: ['title', 'team_key'],
  },
  add_comment: { egenskaper: ['identifier', 'body'], kravs: ['identifier', 'body'] },
  update_issue: {
    egenskaper: [
      'identifier',
      'priority',
      'due',
      'milstolpe',
      'parent',
      'projekt',
      'title',
      'description',
      'skal',
      'bara_om_osatt',
    ],
    kravs: ['identifier'],
  },
  update_issue_state: { egenskaper: ['identifier', 'state_typ', 'state_id'], kravs: ['identifier'] },
};

/** B-19:s slutna lista, i B-19:s ordning. */
const SJU = [
  'get_issue',
  'list_issues',
  'search_issues',
  'create_issue',
  'add_comment',
  'update_issue',
  'update_issue_state',
];

const LASANDE = ['get_issue', 'list_issues', 'search_issues'];

/** AK 4:s fallista: fyra actions utanför listan, ett okänt namn och elva former som inte är ett av de sju. */
const UTANFOR: unknown[] = [
  'besvara_insats',
  'revoke_api_key',
  'registrera_atagande',
  'set_project_customer',
  'finns_inte',
  '__proto__',
  'toString',
  'GET_ISSUE',
  'get_issue ',
  '../revoke_api_key',
  'get_issue/../revoke_api_key',
  '',
  42,
];

describe('FR-24 (d)/Story 4.2 AK 1, AK 3 och AK 4: verktygslistan', () => {
  it('F1 (AK 1, AK 3 och AK 4): sju verktyg med namn och titel ur registret och indata som tillåtelselista', () => {
    expect([...VERKTYGSNAMN]).toEqual(SJU);
    expect(VERKTYG.map((v) => v.name)).toEqual(SJU);

    const manifest = new Map(actionManifest().map((a) => [a.name, a]));
    for (const v of VERKTYG) {
      const iRegistret = manifest.get(v.name);
      const rad = TABELL[v.name];
      expect(iRegistret, `${v.name} i registret`).toBeDefined();
      expect(rad, `${v.name} i tabellen`).toBeDefined();
      expect(typeof iRegistret!.title, v.name).toBe('string');
      expect(v.title, v.name).toBe(iRegistret!.title);
      expect(v.description, v.name).toBe(iRegistret!.title);
      expect(v.annotations.readOnlyHint, v.name).toBe(LASANDE.includes(v.name));
      expect(v.annotations.readOnlyHint, v.name).toBe(iRegistret!.sensitivity === 'read');
      expect(v.inputSchema.type, v.name).toBe('object');
      expect(v.inputSchema.additionalProperties, v.name).toBe(false);
      expect(Object.keys(v.inputSchema.properties), v.name).toEqual(rad!.egenskaper);
      expect([...v.inputSchema.required], v.name).toEqual(rad!.kravs);
      // AK 3: inget schema har ett aktörsfält.
      expect(Object.keys(v.inputSchema.properties).filter((e) => e.startsWith('aktor')), v.name).toEqual([]);
    }
    expect(Object.isFrozen(VERKTYG)).toBe(true);

    // Listan kan inte bli kortare i tysthet: saknas ett namn i registret kastar byggVerktyg().
    expect(() => byggVerktyg(actionManifest().filter((a) => a.name !== 'get_issue'))).toThrow(/get_issue/);

    for (const namn of SJU) expect(hittaVerktyg(namn)?.name, namn).toBe(namn);
    for (const namn of UTANFOR) expect(hittaVerktyg(namn), String(namn)).toBeUndefined();
  });
});

// ---- Fixturen (Uppgift 2): testservern med räknaren, nyckellagret och gatewayen ----------------------

/** Varje anrop som testservern fått genom `bas`. Fixturens egna anrop går direkt mot `api` och räknas inte. */
const anrop: { metod: string; vag: string; auth: string | null }[] = [];
const rakna = (): number => anrop.length;

/**
 * Provets nyckellager, AK 1:s hjälpare: en token kopplas till en nyckel. OAuth-flödet som fyller lagret i
 * drift är Story 4.3; lagret finns bara här.
 */
const sessioner = new Map<string, string>();
const nyckellager = { nyckelFor: (token: string): string | undefined => sessioner.get(token) };

function koppla(nyckel: string): string {
  const token = `mcp-prov-${randomUUID()}`;
  sessioner.set(token, nyckel);
  return token;
}

let api: express.Express;
let server: Server;
let apiUrl: string;
let gateway: express.Express;
let david: string;
let agent: string;
let tokenDavid: string;
let tokenAgent: string;
let fixtur: string;

beforeAll(async () => {
  await seedaTeam();
  david = await nyNyckel({ typ: 'manniska', namn: 'mcp david' });
  agent = await nyNyckel({ typ: 'agent', namn: 'mcp agent' });

  api = createApp();
  const skapat = await kor(api, agent, 'create_issue', { title: 'MCP provärende', team_key: 'LOC' });
  expect(skapat.status).toBe(200);
  fixtur = skapat.body.result.identifier;
  for (const body of ['Första kommentaren', 'Andra kommentaren']) {
    expect((await kor(api, agent, 'add_comment', { identifier: fixtur, body })).status).toBe(200);
  }

  // Testservern: den riktiga appen bakom en räknare, på loopback med en port som systemet väljer.
  const bas = express();
  bas.use((req, _res, next) => {
    anrop.push({ metod: req.method, vag: req.originalUrl, auth: req.headers.authorization ?? null });
    next();
  });
  bas.use(api);
  server = bas.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  gateway = skapaMcpApp({ apiUrl, nyckellager, grans: 100_000 });
  tokenDavid = koppla(david);
  tokenAgent = koppla(agent);
});

afterAll(async () => {
  await new Promise<void>((klar) => {
    server.close(() => klar());
    server.closeAllConnections();
  });
});

/** POST /mcp mot `app` med token som bearer (null: utan huvudet) och kroppen som JSON. */
function post(app: express.Express, token: string | null, kropp: unknown, huvuden: Record<string, string> = {}) {
  let anropet = request(app).post('/mcp').set('Accept', 'application/json, text/event-stream');
  if (token !== null) anropet = anropet.set('Authorization', `Bearer ${token}`);
  for (const [namn, varde] of Object.entries(huvuden)) anropet = anropet.set(namn, varde);
  return anropet.send(kropp as object);
}

/** En JSON-RPC-begäran mot provets gateway. */
function rpc(token: string | null, metod: string, params?: unknown, id: unknown = 1, huvuden: Record<string, string> = {}) {
  return post(gateway, token, { jsonrpc: '2.0', id, method: metod, params }, huvuden);
}

type Svar = Awaited<ReturnType<typeof post>>;

// ---- Det statiska provet (F6) ---------------------------------------------------------------------------

const ROT = fileURLToPath(new URL('../', import.meta.url));

interface Kallfil {
  fil: string; // relativt repots rot, med '/': 'src/mcp/server.ts'
  text: string;
}

/** Varje .ts-fil under `katalog`, sorterad. */
function kallfiler(katalog: string): Kallfil[] {
  return readdirSync(path.join(ROT, katalog), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.posix.join(katalog, f.split(path.sep).join('/')))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(ROT, fil), 'utf8') }));
}

/** Tecknen i `s` utbytta mot blanksteg. Radbrytningarna står kvar, så att radindelningen gäller. */
const blanka = (s: string): string => s.replace(/[^\n]/g, ' ');

/**
 * Källtexten med varje kommentar utbytt mot blanksteg: en egen kopia av samma teknik som utanKommentarer()
 * i test/skrivvagar.test.ts (en provfil importerar inte ur en annan). Strängar, mallsträngar och
 * regex-literaler läses förbi, så att '//' i en adress inte tas för en kommentar.
 */
function utanKommentarer(text: string): string {
  let ut = '';
  let forra = ''; // senaste tecknet i koden som inte är blanksteg: avgör om '/' inleder ett regex
  const mallar: number[] = []; // klammerdjupet inne i varje öppen ${…} i en mallsträng
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const nasta = text[i + 1];
    let j = i + 1;
    if (c === '/' && (nasta === '/' || nasta === '*')) {
      const slut = nasta === '/' ? text.indexOf('\n', i) : text.indexOf('*/', i + 2);
      j = slut === -1 ? text.length : nasta === '/' ? slut : slut + 2;
      ut += blanka(text.slice(i, j));
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, text.length);
    } else if (c === '`' || (c === '}' && mallar[mallar.length - 1] === 0)) {
      if (c === '}') mallar.pop();
      while (j < text.length && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) {
        j += text[j] === '\\' ? 2 : 1;
      }
      if (text[j] === '$') {
        mallar.push(0);
        j += 2;
      } else {
        j = Math.min(j + 1, text.length);
      }
    } else if (
      c === '/' &&
      (forra === '' ||
        '([{,;:=!&|?+-*%<>~^}'.includes(forra) ||
        /\b(?:return|typeof|case|void|await|yield|in|of)\s*$/.test(ut.slice(-12)))
    ) {
      let klass = false;
      while (j < text.length && text[j] !== '\n' && (klass || text[j] !== '/')) {
        if (text[j] === '\\') j += 1;
        else if (text[j] === '[') klass = true;
        else if (text[j] === ']') klass = false;
        j += 1;
      }
      j = Math.min(j + 1, text.length);
    } else if (mallar.length > 0 && (c === '{' || c === '}')) {
      mallar[mallar.length - 1] = mallar[mallar.length - 1]! + (c === '{' ? 1 : -1);
    }
    const bit = text.slice(i, j);
    ut += bit;
    if (/\S/.test(bit)) forra = bit.trimEnd().slice(-1);
    i = j;
  }
  return ut;
}

interface Importbindning {
  importerat: string; // 'default' = standardexporten, '*' = hela modulen
  typ: boolean;
}

interface Importsats {
  spec: string;
  bindningar: Importbindning[];
}

/**
 * En import- eller återexportsats med sökväg, också över flera rader (registrets importer på rad 4–15 slutar
 * med `from` på sista raden): `import x, { a, type B } from '…'`, `import type { … } from '…'`,
 * `import * as h from '…'`, `export { a } from '…'`, `export * from '…'`. Klausulen kan bara bestå av namn,
 * klamrar, kommatecken och stjärnor, så att satsen aldrig sträcker sig in i kod.
 */
const SATS = /\b(?:import|export)\s+(type\s+)?([\w$\s{},*]*?)\s*\bfrom\s*(['"])([^'"\n]+)\3/g;
/** En import utan bindningar, bara för sidoeffekten: `import 'dotenv/config'`. */
const BAR_IMPORT = /\bimport\s*(['"])([^'"\n]+)\1/g;
/** En dynamisk import med fast sökväg. Den når allt modulen exporterar. */
const DYNAMISK_IMPORT = /\bimport\s*\(\s*(['"`])([^'"`\n]+)\1/g;

/** Bindningarna i en importklausul; `helaTyp` när satsen själv är `import type` eller `export type`. */
function bindningar(klausul: string, helaTyp: boolean): Importbindning[] {
  const ut: Importbindning[] = [];
  if (klausul.includes('*')) ut.push({ importerat: '*', typ: helaTyp });
  for (const del of /\{([^}]*)\}/.exec(klausul)?.[1]?.split(',') ?? []) {
    const m = /^\s*(type\s+)?([\w$]+)(?:\s+as\s+[\w$]+)?\s*$/.exec(del);
    if (m) ut.push({ importerat: m[2]!, typ: helaTyp || m[1] !== undefined });
  }
  if (/^\s*[\w$]/.test(klausul)) ut.push({ importerat: 'default', typ: helaTyp });
  return ut;
}

/** Varje import i texten utan kommentarer. */
function importsatser(text: string): Importsats[] {
  const kod = utanKommentarer(text);
  return [
    ...[...kod.matchAll(SATS)].map((m) => ({ spec: m[4]!, bindningar: bindningar(m[2]!, m[1] !== undefined) })),
    ...[...kod.matchAll(BAR_IMPORT)].map((m) => ({ spec: m[2]!, bindningar: [] })),
    ...[...kod.matchAll(DYNAMISK_IMPORT)].map((m) => ({ spec: m[2]!, bindningar: [{ importerat: '*', typ: false }] })),
  ];
}

/** Specifikationen löst mot filens katalog och utan ändelse ('src/actions/registry'); ett paket som det står. */
function malFor(fil: string, spec: string): string {
  return spec.startsWith('.')
    ? path.posix.normalize(path.posix.join(path.posix.dirname(fil), spec)).replace(/\.[jt]s$/, '')
    : spec;
}

/** En sats som bara binder typer försvinner ur utdatat; en sats utan bindningar laddar modulen. */
const baraTyper = (b: Importbindning[]): boolean => b.length > 0 && b.every((x) => x.typ);

/**
 * Dev Notes → Importlistan för src/mcp/: vad varje specifikation får binda. En fil under src/mcp/ får
 * binda allt. Allt annat fälls, också pg, dotenv, helmet, src/config.ts och varje fil under src/db/,
 * src/http/, src/services/, src/lib/ och de övriga katalogerna.
 */
const IMPORTLISTA: Record<string, { varden: readonly string[]; typer: boolean }> = {
  express: { varden: ['default'], typer: true },
  'express-rate-limit': { varden: ['default'], typer: false },
  zod: { varden: ['z'], typer: false },
  'node:http': { varden: [], typer: true },
  'node:net': { varden: [], typer: true },
  'node:path': { varden: ['default'], typer: false },
  'node:url': { varden: ['pathToFileURL'], typer: false },
  'src/actions/registry': { varden: ['actionManifest'], typer: false },
};

/** Avvikelserna från importlistan, var och en med filens namn. Tom = filerna importerar bara det tillåtna. */
function importfel(filer: Kallfil[]): string[] {
  const fel: string[] = [];
  for (const { fil, text } of filer) {
    for (const { spec, bindningar: bundna } of importsatser(text)) {
      const relativ = spec.startsWith('.');
      const mal = malFor(fil, spec);
      if (relativ && mal.startsWith('src/mcp/')) continue;
      // En relativ sökväg ska landa under src/, och ett paket får inte heta som en fil där.
      const regel = relativ === mal.startsWith('src/') && Object.hasOwn(IMPORTLISTA, mal) ? IMPORTLISTA[mal] : undefined;
      if (regel === undefined) {
        fel.push(`${fil}: ${spec}`);
        continue;
      }
      for (const b of bundna) {
        if (!regel.varden.includes(b.importerat) && !(b.typ && regel.typer)) {
          fel.push(`${fil}: ${b.typ ? 'typen ' : ''}${b.importerat} ur ${spec}`);
        }
      }
    }
  }
  return fel;
}

// Story 3.4: namnet byggs av delar för nollträffskravet i test/; förbudet i src/mcp/ gäller oförändrat.
const BORTTAGEN_ADRESSVARIABEL = ['REDOVISNING', 'URL'].join('_');

/** Dev Notes → Det statiska provet: orden som aldrig får stå i en fil under src/mcp/, kommentarer också. */
const FORBJUDNA_TEXTER = [
  'VAULT_PATH',
  'CRM_KONF_PATH',
  BORTTAGEN_ADRESSVARIABEL,
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'process.env',
  '/vy',
];

function forbjudnaTexter(filer: Kallfil[]): string[] {
  return filer.flatMap(({ fil, text }) => FORBJUDNA_TEXTER.filter((ord) => text.includes(ord)).map((ord) => `${fil}: ${ord}`));
}

/** Filens text, eller tom när filen inte finns (en påhittad sökväg). */
function lasKalla(fil: string): string {
  try {
    return readFileSync(path.join(ROT, fil), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Filerna som nås från `start` genom relativa värdeimporter, rekursivt över hela src/, och de filer i
 * grafen som har en värdeimport av pg. `import type` och `export type` räknas inte; en sats som blandar
 * värden och typer är en värdeimport.
 */
function importgraf(start: Kallfil[]): { filer: string[]; medPg: string[] } {
  const texter = new Map<string, string>();
  const ko = [...start];
  for (let k = ko.shift(); k !== undefined; k = ko.shift()) {
    if (texter.has(k.fil)) continue;
    texter.set(k.fil, k.text);
    for (const { spec, bindningar: bundna } of importsatser(k.text)) {
      if (!spec.startsWith('.') || baraTyper(bundna)) continue;
      const fil = `${malFor(k.fil, spec)}.ts`;
      if (!texter.has(fil)) ko.push({ fil, text: lasKalla(fil) });
    }
  }
  const medPg = [...texter]
    .filter(([, text]) => importsatser(text).some((s) => s.spec === 'pg' && !baraTyper(s.bindningar)))
    .map(([fil]) => fil);
  return { filer: [...texter.keys()].sort(), medPg: medPg.sort() };
}

type Fyndslag = 'importfel' | 'importgraf' | 'forbjudnaTexter';

/** Åtta påhittade filer under src/mcp/ och var de ska fällas. Proven visar att mätningen kan slå ut. */
const PAHITTADE: (Kallfil & { fynd: Fyndslag[] })[] = [
  {
    fil: 'src/mcp/pahittadPool.ts',
    text: "import { pool } from '../db/pool.js';\nexport const antal = () => pool.totalCount;\n",
    fynd: ['importfel', 'importgraf'],
  },
  {
    fil: 'src/mcp/pahittadPg.ts',
    text: "import pg from 'pg';\nexport const klient = new pg.Client();\n",
    fynd: ['importfel'],
  },
  {
    fil: 'src/mcp/pahittadConfig.ts',
    text: "import { config } from '../config.js';\nexport const port = config.PORT;\n",
    fynd: ['importfel', 'importgraf'],
  },
  {
    fil: 'src/mcp/pahittadTx.ts',
    text: "import { withTransaction } from '../db/tx.js';\nexport const tx = withTransaction;\n",
    fynd: ['importfel', 'importgraf'],
  },
  {
    fil: 'src/mcp/pahittadValv.ts',
    text: 'export const valv = (config: { VAULT_PATH: string }) => config.VAULT_PATH;\n',
    fynd: ['forbjudnaTexter'],
  },
  {
    fil: 'src/mcp/pahittadCrm.ts',
    text: 'export const crm = () => process.env.CRM_KONF_PATH;\n',
    fynd: ['forbjudnaTexter'],
  },
  {
    fil: 'src/mcp/pahittadRedovisning.ts',
    text: `export const nyckel = '${BORTTAGEN_ADRESSVARIABEL}';\n`,
    fynd: ['forbjudnaTexter'],
  },
  {
    fil: 'src/mcp/pahittadDok.ts',
    text: "export const dok = () => fetch('/vy/dok/exempel.md');\n",
    fynd: ['forbjudnaTexter'],
  },
];

describe('FR-24 (d)/Story 4.2 AK 1: protokollet', () => {
  it('F2 (AK 1): initialize, ping, notifieringar, versionshuvudet och kuvertets fel', async () => {
    const alla: Svar[] = [];
    const spara = (s: Svar): Svar => {
      alla.push(s);
      return s;
    };

    const init = spara(
      await rpc(tokenDavid, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'prov', version: '1' } }, 11),
    );
    expect(init.status).toBe(200);
    expect(init.headers['content-type']).toMatch(/^application\/json/);
    expect(init.body.jsonrpc).toBe('2.0');
    expect(init.body.id).toBe(11);
    expect(init.body.result.protocolVersion).toBe('2025-06-18');
    expect(typeof init.body.result.capabilities.tools).toBe('object');
    expect(init.body.result.capabilities.tools).not.toBeNull();
    expect(init.body.result.serverInfo.name).toBe('arenden');

    const framtida = spara(await rpc(tokenDavid, 'initialize', { protocolVersion: '2099-01-01' }));
    expect(framtida.status).toBe(200);
    expect(framtida.body.result.protocolVersion).toBe('2025-11-25');

    const ping = spara(await rpc(tokenDavid, 'ping'));
    expect(ping.status).toBe(200);
    expect(ping.body.result).toEqual({});

    // En notifiering och ett svar från klienten får 202 utan kropp.
    const notis = spara(await post(gateway, tokenDavid, { jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(notis.status).toBe(202);
    expect(notis.text).toBe('');
    const klientsvar = spara(await post(gateway, tokenDavid, { jsonrpc: '2.0', id: 7, result: {} }));
    expect(klientsvar.status).toBe(202);
    expect(klientsvar.text).toBe('');

    // Versionshuvudet: en version utanför de tre ger 400 med −32600, så att en klient av båda sorterna
    // faller tillbaka på initialize.
    const nyVersion = spara(await rpc(tokenDavid, 'tools/list', undefined, 1, { 'MCP-Protocol-Version': '2026-07-28' }));
    expect(nyVersion.status).toBe(400);
    expect(nyVersion.body.error.code).toBe(-32600);
    expect(nyVersion.body.error.data.supported).toEqual(['2025-11-25', '2025-06-18', '2025-03-26']);
    const kandVersion = spara(await rpc(tokenDavid, 'tools/list', undefined, 1, { 'MCP-Protocol-Version': '2025-11-25' }));
    expect(kandVersion.status).toBe(200);

    for (const metod of ['resources/list', 'server/discover']) {
      const okand = spara(await rpc(tokenDavid, metod));
      expect(okand.status, metod).toBe(200);
      expect(okand.body.error.code, metod).toBe(-32601);
    }

    const trasig = spara(
      await request(gateway)
        .post('/mcp')
        .set('Authorization', `Bearer ${tokenDavid}`)
        .set('Content-Type', 'application/json')
        .send('{"jsonrpc":'),
    );
    expect(trasig.status).toBe(400);
    expect(trasig.body.error.code).toBe(-32700);
    expect(trasig.body.id).toBeNull();

    const ogiltiga: { namn: string; svar: Svar; id?: unknown }[] = [
      {
        namn: 'en lista',
        svar: await post(gateway, tokenDavid, [
          { jsonrpc: '2.0', id: 1, method: 'ping' },
          { jsonrpc: '2.0', id: 2, method: 'ping' },
        ]),
      },
      { namn: 'jsonrpc 1.0', svar: await post(gateway, tokenDavid, { jsonrpc: '1.0', id: 3, method: 'ping' }) },
      { namn: 'utan method, result och error', svar: await post(gateway, tokenDavid, { jsonrpc: '2.0', id: 1 }), id: 1 },
      {
        namn: 'okänd nyckel på toppnivå',
        svar: await post(gateway, tokenDavid, { jsonrpc: '2.0', id: 4, method: 'ping', extra: true }),
      },
      {
        namn: 'id som objekt',
        svar: await post(gateway, tokenDavid, { jsonrpc: '2.0', id: { a: 1 }, method: 'ping' }),
        id: null,
      },
      {
        namn: 'text/plain',
        svar: await request(gateway)
          .post('/mcp')
          .set('Authorization', `Bearer ${tokenDavid}`)
          .set('Content-Type', 'text/plain')
          .send(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'ping' })),
      },
    ];
    for (const { namn, svar, id } of ogiltiga) {
      spara(svar);
      expect(svar.status, namn).toBe(400);
      expect(svar.body.error.code, namn).toBe(-32600);
      if (id !== undefined) expect(svar.body.id, namn).toBe(id);
    }

    // Gatewayen är tillståndslös: den skapar aldrig någon protokollsession.
    expect(alla.filter((s) => s.headers['mcp-session-id'] !== undefined)).toEqual([]);
  });
});

describe('FR-24 (d)/Story 4.2 AK 1, AK 3 och AK 5: verktygslistan, sessionen och vägarna', () => {
  it('F3 (AK 1 och AK 3): tools/list genom gatewayen ger exakt listan', async () => {
    const svar = await rpc(tokenDavid, 'tools/list');
    expect(svar.status).toBe(200);
    expect(svar.body.result.tools).toEqual(VERKTYG);
    expect(svar.body.result).not.toHaveProperty('nextCursor');
  });

  it('F4 (AK 1 och AK 5): sessionen, metoderna, vägarna och den sista felhanteraren', async () => {
    const fore = rakna();
    const initiera = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

    // Utan huvudet, med en token som lagret inte känner och med människonyckeln själv som bearer.
    for (const token of [null, `mcp-prov-${randomUUID()}`, david]) {
      const svar = await post(gateway, token, initiera);
      expect(svar.status, String(token)).toBe(401);
      expect(svar.body, String(token)).toEqual({ error: 'unauthenticated' });
    }

    for (const metod of ['get', 'delete'] as const) {
      const svar = await request(gateway)[metod]('/mcp').set('Authorization', `Bearer ${tokenDavid}`);
      expect(svar.status, metod).toBe(405);
      expect(svar.headers['allow'], metod).toBe('POST');
      expect(svar.body, metod).toEqual({ error: 'method_not_allowed' });
    }

    const vagar = [
      ['get', '/'],
      ['get', '/vy'],
      ['get', '/health'],
      ['post', '/api/actions/get_issue'],
    ] as const;
    for (const [metod, vag] of vagar) {
      const svar = await request(gateway)[metod](vag).set('Authorization', `Bearer ${tokenDavid}`);
      expect(svar.status, vag).toBe(404);
      expect(svar.body, vag).toEqual({ error: 'not_found' });
    }

    // Ett lager som kastar: den sista felhanteraren svarar utan text ur felet.
    const kastande = skapaMcpApp({
      apiUrl,
      nyckellager: {
        nyckelFor: () => {
          throw new Error('hemlig-text-F4');
        },
      },
      grans: 100_000,
    });
    const fel = await post(kastande, `mcp-prov-${randomUUID()}`, initiera);
    expect(fel.status).toBe(500);
    expect(fel.body).toEqual({ error: 'internal_error' });
    expect(fel.text).not.toContain('hemlig-text-F4');

    // Kontroll: inget av anropen nådde testservern.
    expect(rakna()).toBe(fore);
  });
});

describe('FR-24 (d)/Story 4.2 AK 2 och AK 6: gatewayens konfiguration', () => {
  it('F5 (AK 2 och AK 6): fyra konstanter, ingen av dem en databas', () => {
    expect(Object.keys(GATEWAYKONFIG).sort()).toEqual(['API_URL', 'GRANS_PER_MINUT', 'HOST', 'PORT']);
    expect(Object.keys(GATEWAYKONFIG).filter((k) => /DATABASE|VAULT|CRM|REDOVISNING/.test(k))).toEqual([]);
    expect(Object.isFrozen(GATEWAYKONFIG)).toBe(true);
    expect(GATEWAYKONFIG.HOST).toBe('127.0.0.1');
    expect(GATEWAYKONFIG.PORT).toBe(3003);
    expect(GATEWAYKONFIG.GRANS_PER_MINUT).toBe(120);
    const adress = new URL(GATEWAYKONFIG.API_URL);
    expect(adress.protocol).toBe('http:');
    expect(adress.hostname).toBe('127.0.0.1');
    expect(adress.port).toBe('3002');
  });
});

describe('FR-24 (d)/Story 4.2 AK 4, AK 2 och AK 6: inget utanför listan i src/mcp/', () => {
  it('F6 (AK 4, AK 2 och AK 6): importlistan, de förbjudna texterna och importgrafen, med åtta påhittade', () => {
    const katalogen = readdirSync(path.join(ROT, 'src/mcp'), { recursive: true }).map(String).sort();
    expect(katalogen).toEqual(['server.ts', 'verktyg.ts']);
    const mcp = kallfiler('src/mcp');
    expect(mcp.map((f) => f.fil)).toEqual(['src/mcp/server.ts', 'src/mcp/verktyg.ts']);

    expect(importfel(mcp)).toEqual([]);
    expect(forbjudnaTexter(mcp)).toEqual([]);

    const graf = importgraf(mcp);
    expect(graf.filer).toContain('src/actions/registry.ts');
    expect(graf.filer).not.toContain('src/config.ts');
    expect(graf.filer.filter((f) => f.startsWith('src/db/') || f.startsWith('src/http/'))).toEqual([]);
    expect(graf.medPg).toEqual([]);
    // Kontroll: grafen når tjänstelagret, alltså läses satserna över flera rader.
    expect(graf.filer).toContain('src/services/arenden.ts');

    for (const p of PAHITTADE) {
      for (const slag of p.fynd) {
        if (slag === 'importfel') expect(importfel([p]).join('\n'), p.fil).toContain(p.fil);
        if (slag === 'forbjudnaTexter') expect(forbjudnaTexter([p]).join('\n'), p.fil).toContain(p.fil);
        if (slag === 'importgraf') {
          const fran = importgraf([p]);
          expect(fran.filer, p.fil).toContain(p.fil);
          expect(fran.filer.some((f) => f === 'src/config.ts' || f.startsWith('src/db/')), p.fil).toBe(true);
        }
      }
    }
  });
});

// ---- Verktygsanropet (Uppgift 3) ------------------------------------------------------------------------

/** tools/call med verktygets namn och indata. */
function verktyg(token: string, namn: unknown, args: unknown) {
  return rpc(token, 'tools/call', { name: namn, arguments: args });
}

/** Verktygsresultatets första text. */
const text = (svar: Svar): string => svar.body.result.content[0].text;

/** De senaste `antal` händelseraderna för ärendet, i id-ordning. */
async function senasteHandelser(
  identifier: string,
  antal: number,
): Promise<{ verb: string; aktor_typ: string; aktor_namn: string }[]> {
  const { rows } = await pool.query<{ verb: string; aktor_typ: string; aktor_namn: string }>(
    `SELECT e.verb, e.aktor_typ, e.aktor_namn
       FROM events e
       JOIN issues i ON i.id = e.issue_id
       JOIN teams t ON t.id = i.team_id
      WHERE t.key || '-' || i.sequence_number = $1
      ORDER BY e.id DESC
      LIMIT $2`,
    [identifier, antal],
  );
  return rows.reverse();
}

/** Raderna som AK 4 säger ska stå still. */
async function radbild(): Promise<Record<string, number>> {
  const aktiva = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM api_keys WHERE aktiv');
  return {
    events: await raknaRader('events'),
    issues: await raknaRader('issues'),
    comments: await raknaRader('comments'),
    insatser: await raknaRader('insatser'),
    aktiva_nycklar: Number(aktiva.rows[0]!.n),
  };
}

describe('FR-24 (d)/Story 4.2 AK 2: läsa ett ärende via API:t', () => {
  it('F7 (AK 2): get_issue ger ärendet med kommentarer och historik, som POST /api/actions/get_issue med bearer', async () => {
    const fore = rakna();
    const svar = await verktyg(tokenDavid, 'get_issue', { identifier: fixtur });
    expect(svar.status).toBe(200);
    expect(svar.body.error).toBeUndefined();
    expect(svar.body.result.isError).toBe(false);
    expect(svar.body.result.content).toHaveLength(1);
    expect(svar.body.result.content[0].type).toBe('text');

    const data = JSON.parse(text(svar));
    expect(data.arende.identifier).toBe(fixtur);
    expect(data.kommentarer.map((k: { body: string }) => k.body)).toEqual(['Första kommentaren', 'Andra kommentaren']);
    expect(data.handelser.map((h: { verb: string }) => h.verb)).toEqual(['skapade_arende', 'kommenterade', 'kommenterade']);

    expect(rakna()).toBe(fore + 1);
    expect(anrop.at(-1)).toEqual({ metod: 'POST', vag: '/api/actions/get_issue', auth: `Bearer ${david}` });
  });
});

describe('FR-24 (d)/Story 4.2 AK 3: agera med nyckelns aktör', () => {
  it('F8 (AK 3): add_comment bär nyckelns aktör, människa och agent, också på ärendesidan', async () => {
    const manniskan = await verktyg(tokenDavid, 'add_comment', { identifier: fixtur, body: 'F8 från människan' });
    const agenten = await verktyg(tokenAgent, 'add_comment', { identifier: fixtur, body: 'F8 från agenten' });
    expect(manniskan.body.result.isError).toBe(false);
    expect(agenten.body.result.isError).toBe(false);

    expect(await senasteHandelser(fixtur, 2)).toEqual([
      { verb: 'kommenterade', aktor_typ: 'manniska', aktor_namn: 'mcp david' },
      { verb: 'kommenterade', aktor_typ: 'agent', aktor_namn: 'mcp agent' },
    ]);
    const kommentarer = await pool.query<{ body: string; aktor_typ: string; aktor_namn: string }>(
      'SELECT body, aktor_typ, aktor_namn FROM comments WHERE body = ANY($1::text[]) ORDER BY body',
      [['F8 från människan', 'F8 från agenten']],
    );
    expect(kommentarer.rows).toEqual([
      { body: 'F8 från agenten', aktor_typ: 'agent', aktor_namn: 'mcp agent' },
      { body: 'F8 från människan', aktor_typ: 'manniska', aktor_namn: 'mcp david' },
    ]);

    // Direkt mot api, inte genom bas: räknaren ska bara se gatewayens anrop.
    const sida = await request(api).get(`/vy/arende/${fixtur}`);
    expect(sida.status).toBe(200);
    expect(sida.text).toContain(proveniens('manniska', 'mcp david'));
    expect(sida.text).toContain(proveniens('agent', 'mcp agent'));
  });

  it('F9 (AK 3): aktörsfält och andra okända fält avvisas före anropet, med noll rader', async () => {
    const fore = { rader: await radbild(), anrop: rakna() };

    const aktorsfalt: [string, Record<string, unknown>, string[]][] = [
      ['add_comment', { identifier: fixtur, body: 'F9', aktor_typ: 'manniska' }, ['aktor_typ']],
      ['add_comment', { identifier: fixtur, body: 'F9', aktor_namn: 'David' }, ['aktor_namn']],
      ['add_comment', { identifier: fixtur, body: 'F9', aktor_typ: 'manniska', aktor_namn: 'David' }, ['aktor_typ', 'aktor_namn']],
      ['create_issue', { title: 'F9', team_key: 'LOC', aktor_namn: 'David' }, ['aktor_namn']],
    ];
    for (const [namn, args, falt] of aktorsfalt) {
      const svar = await verktyg(tokenDavid, namn, args);
      expect(svar.status, namn).toBe(200);
      expect(svar.body.error.code, namn).toBe(-32602);
      for (const f of falt) expect(svar.body.error.message, namn).toContain(f);
      expect(svar.body, namn).not.toHaveProperty('result');
    }

    // Tolv okända nycklar: högst tio namn, vart och ett kapat vid 60 tecken.
    const lang = 'a'.repeat(80);
    const manga: Record<string, unknown> = { identifier: fixtur, [lang]: 1 };
    for (let i = 1; i <= 11; i += 1) manga[`x${String(i).padStart(2, '0')}`] = i;
    const forManga = await verktyg(tokenDavid, 'get_issue', manga);
    expect(forManga.body.error.code).toBe(-32602);
    const meddelande: string = forManga.body.error.message;
    const borjan = 'Fält som verktyget inte tar emot: ';
    expect(meddelande.startsWith(borjan)).toBe(true);
    expect(meddelande.endsWith('.')).toBe(true);
    const namnen = meddelande.slice(borjan.length, -1).split(', ');
    expect(namnen).toHaveLength(10);
    expect(namnen[0]).toBe('a'.repeat(60));
    expect(meddelande).not.toContain('a'.repeat(61));

    for (const args of [[], 'en sträng', null]) {
      const svar = await verktyg(tokenDavid, 'get_issue', args);
      expect(svar.body.error.code, JSON.stringify(args)).toBe(-32602);
      expect(svar.body.error.message, JSON.stringify(args)).toBe('Indata ska vara ett objekt.');
    }

    expect({ rader: await radbild(), anrop: rakna() }).toEqual(fore);
  });
});

describe('FR-24 (d)/Story 4.2 AK 4: inget utanför listan', () => {
  it('F10 (AK 4): namn utanför listan avvisas med −32602 och når aldrig API:t', async () => {
    const fore = { rader: await radbild(), anrop: rakna() };

    const avvisade: { namn: string; svar: Svar }[] = [];
    for (const namn of UTANFOR) {
      avvisade.push({ namn: JSON.stringify(namn), svar: await verktyg(tokenDavid, namn, {}) });
    }
    avvisade.push({ namn: 'params utan name', svar: await rpc(tokenDavid, 'tools/call', { arguments: {} }) });
    avvisade.push({ namn: 'params som lista', svar: await rpc(tokenDavid, 'tools/call', ['get_issue', {}]) });
    for (const { namn, svar } of avvisade) {
      expect(svar.status, namn).toBe(200);
      expect(svar.body.error.code, namn).toBe(-32602);
      expect(svar.body.error.message, namn).toBe('Verktyget finns inte i listan.');
      expect(svar.body, namn).not.toHaveProperty('result');
    }
    expect({ rader: await radbild(), anrop: rakna() }).toEqual(fore);

    // Kontroll: ett tillåtet anrop slår ut i samma räknare.
    const tillatet = await verktyg(tokenDavid, 'get_issue', { identifier: fixtur });
    expect(tillatet.body.result.isError).toBe(false);
    expect(rakna()).toBe(fore.anrop + 1);
  });
});

describe('FR-24 (d)/Story 4.2 AK 5: fel ur API:t', () => {
  it('F11 (AK 5): API:ts fel blir verktygsfel med status och felkod, aldrig ett stackspår', async () => {
    const foreHandelser = await raknaRader('events');
    const texter: string[] = [];
    const genomGatewayen: Svar[] = [];

    const trasig = await verktyg(tokenDavid, 'get_issue', { identifier: 'trasigt' });
    genomGatewayen.push(trasig);
    expect(trasig.body.result.isError).toBe(true);
    expect(text(trasig).startsWith('Ärende-API:t svarade 400 med felkoden validation_error.')).toBe(true);
    expect(text(trasig)).toContain('identifier');
    texter.push(text(trasig));

    const saknas = await verktyg(tokenDavid, 'get_issue', { identifier: 'LOC-999999' });
    genomGatewayen.push(saknas);
    expect(saknas.body.result.isError).toBe(true);
    expect(text(saknas)).toBe('Ärende-API:t svarade 404 med felkoden not_found.');
    texter.push(text(saknas));

    // En gateway mot en stängd port (som test/crm.test.ts), samma lager.
    const stangd = skapaMcpApp({ apiUrl: 'http://127.0.0.1:1', nyckellager, grans: 100_000 });
    const ingetApi = await post(stangd, tokenDavid, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_issue', arguments: { identifier: fixtur } },
    });
    genomGatewayen.push(ingetApi);
    expect(ingetApi.body.result.isError).toBe(true);
    expect(text(ingetApi)).toBe('Ärende-API:t svarade inte. Försök igen senare.');
    texter.push(text(ingetApi));

    // På funktionsnivå: en felkod utan felkodens form, en kropp som inte är JSON och för många och för
    // långa details.
    const utanKropp = tolkaSvar(502, null, undefined);
    expect(utanKropp.isError).toBe(true);
    expect(utanKropp.content[0]!.text).toBe('Ärende-API:t svarade 502 med felkoden okant_fel.');
    const utanForm = tolkaSvar(400, null, { error: 'Inte En Kod' });
    expect(utanForm.isError).toBe(true);
    expect(utanForm.content[0]!.text).toBe('Ärende-API:t svarade 400 med felkoden okant_fel.');
    const details = Array.from({ length: 25 }, (_, i) => ({
      path: i === 0 ? '' : `falt${i}`,
      message: i === 1 ? 'm'.repeat(400) : `fel ${i}`,
    }));
    const manga = tolkaSvar(400, null, { error: 'validation_error', details });
    expect(manga.isError).toBe(true);
    const rader = manga.content[0]!.text.split('\n');
    expect(rader[0]).toBe('Ärende-API:t svarade 400 med felkoden validation_error.');
    expect(rader[1]).toBe('Fält som inte godtogs:');
    expect(rader.slice(2)).toHaveLength(20);
    expect(rader.slice(2).filter((r) => !r.startsWith('- '))).toEqual([]);
    expect(rader[2]).toBe('- (indata): fel 0');
    expect(rader[3]).toBe(`- falt1: ${'m'.repeat(300)}`);
    expect(rader[21]).toBe('- falt19: fel 19');
    texter.push(utanKropp.content[0]!.text, utanForm.content[0]!.text, manga.content[0]!.text);

    for (const t of texter) {
      expect(t).not.toContain('Error');
      expect(t).not.toMatch(/^\s+at /m);
      expect(t).not.toContain('stack');
      expect(t).not.toContain('ECONNREFUSED');
      expect(t).not.toContain(david);
    }
    for (const svar of genomGatewayen) expect(svar.body).not.toHaveProperty('error');
    expect(await raknaRader('events')).toBe(foreHandelser);
  });
});

describe('FR-24 (d)/Story 4.2 AK 1: alla sju verktygen', () => {
  it('F12 (AK 1): list_issues, search_issues, create_issue, update_issue och update_issue_state mot testservern', async () => {
    const lista = await verktyg(tokenDavid, 'list_issues', { limit: 5 });
    expect(lista.body.result.isError).toBe(false);
    expect(Array.isArray(JSON.parse(text(lista)).arenden)).toBe(true);

    const sok = await verktyg(tokenDavid, 'search_issues', { fraga: 'MCP provärende' });
    expect(sok.body.result.isError).toBe(false);
    const traffar = JSON.parse(text(sok));
    expect(Array.isArray(traffar)).toBe(true);
    expect(traffar).toHaveLength(1);
    expect(traffar[0].identifier).toBe(fixtur);

    const skapat = await verktyg(tokenDavid, 'create_issue', { title: 'F12 skapat genom MCP', team_key: 'LOC' });
    expect(skapat.body.result.isError).toBe(false);
    const nytt: string = JSON.parse(text(skapat)).identifier;
    expect(nytt).toMatch(/^LOC-\d+$/);
    expect(nytt).not.toBe(fixtur);
    expect(await senasteHandelser(nytt, 1)).toEqual([
      { verb: 'skapade_arende', aktor_typ: 'manniska', aktor_namn: 'mcp david' },
    ]);

    const prioritet = await verktyg(tokenDavid, 'update_issue', { identifier: nytt, priority: 2 });
    expect(prioritet.body.result.isError).toBe(false);
    expect((await senasteHandelser(nytt, 1))[0]!.verb).toBe('andrade_prioritet');

    const status = await verktyg(tokenDavid, 'update_issue_state', { identifier: nytt, state_typ: 'started' });
    expect(status.body.result.isError).toBe(false);
    expect((await senasteHandelser(nytt, 1))[0]!.verb).toBe('andrade_status');

    // MCP låter klienten lägga _meta i params; tools/call läser bara name och arguments.
    const medMeta = await rpc(tokenDavid, 'tools/call', {
      name: 'list_issues',
      arguments: { limit: 1 },
      _meta: { progressToken: 1 },
    });
    expect(medMeta.body.error).toBeUndefined();
    expect(medMeta.body.result.isError).toBe(false);

    // Kontroll sist: varje anrop som testservern fått sedan filens början är ett POST mot ett av de sju,
    // med en av de två nycklarna som bearer.
    const vagar = new Set(VERKTYGSNAMN.map((n) => `/api/actions/${n}`));
    const bearers = new Set([`Bearer ${david}`, `Bearer ${agent}`]);
    expect(anrop.length).toBeGreaterThan(0);
    expect(anrop.filter((a) => a.metod !== 'POST' || !vagar.has(a.vag) || !bearers.has(a.auth ?? ''))).toEqual([]);
  });
});

// ---- Gränsen (Uppgift 4) --------------------------------------------------------------------------------

describe('FR-24 (d)/Story 4.2 AK 5: gränsen', () => {
  it('F13 (AK 5): över gatewayens egen gräns svarar /mcp 429 med Retry-After, före sessionen', async () => {
    const fore = rakna();
    const smal = skapaMcpApp({ apiUrl, nyckellager, grans: 3 });
    const lista = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    for (let i = 0; i < 3; i += 1) expect((await post(smal, tokenDavid, lista)).status, `anrop ${i + 1}`).toBe(200);

    const over = await post(smal, tokenDavid, lista);
    expect(over.status).toBe(429);
    expect(over.body).toEqual({ error: 'rate_limited' });
    expect(over.headers['retry-after']).toMatch(/^\d+$/);
    expect(over.headers['ratelimit-limit']).toBe('3');

    // Kontroll sist: inget nådde API:t, och gränsen står före sessionen.
    expect(rakna()).toBe(fore);
    expect((await post(smal, null, lista)).status).toBe(429);
  });

  it('F14 (AK 5): API:ts 429 ger felkoden och antalet sekunder ur Retry-After', () => {
    // Samma svar som test/ratelimit.test.ts visar att API:ts gräns ger: {"error":"rate_limited"} och
    // Retry-After med bara siffror.
    const medSiffror = tolkaSvar(429, '17', { error: 'rate_limited' });
    expect(medSiffror.isError).toBe(true);
    expect(medSiffror.content[0]!.text).toBe(
      'Ärende-API:t svarade 429 med felkoden rate_limited. Försök igen om 17 sekunder.',
    );
    for (const retryAfter of ['Wed, 21 Oct 2026 07.00 GMT', null]) {
      const utan = tolkaSvar(429, retryAfter, { error: 'rate_limited' });
      expect(utan.isError, String(retryAfter)).toBe(true);
      expect(utan.content[0]!.text, String(retryAfter)).toBe('Ärende-API:t svarade 429 med felkoden rate_limited.');
    }
  });
});

// ---- Processen och beroendena (Uppgift 5) ---------------------------------------------------------------

/** Stänger servern med close(); löftet avvisas om close() ger ett fel. */
function stang(s: Server): Promise<void> {
  return new Promise<void>((klar, fel) => {
    s.close((e) => (e ? fel(e) : klar()));
    s.closeAllConnections();
  });
}

describe('FR-24 (d)/Story 4.2 AK 6: gatewayen binder bara loopback', () => {
  it('F15 (AK 6): processens server lyssnar bara på 127.0.0.1, vad miljön och anroparen än säger', async () => {
    const initiera = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });

    for (const varde of ['0.0.0.0', 'localhost', '::']) {
      const fore = { HOST: process.env.HOST, MCP_HOST: process.env.MCP_HOST };
      let s: Server;
      try {
        process.env.HOST = varde;
        process.env.MCP_HOST = varde;
        s = await startaGateway(0);
      } finally {
        for (const [namn, gammalt] of Object.entries(fore)) {
          if (gammalt === undefined) delete process.env[namn];
          else process.env[namn] = gammalt;
        }
      }
      const adress = s.address() as AddressInfo;
      expect(adress.address, varde).toBe('127.0.0.1');
      expect(adress.family, varde).toBe('IPv4');
      expect(adress.port, varde).toBeGreaterThan(0);

      // Det tomma lagret: 401 utan session och med en nyckel som bearer.
      for (const auth of [undefined, `Bearer ${david}`]) {
        const svar = await fetch(`http://127.0.0.1:${adress.port}/mcp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(auth !== undefined ? { Authorization: auth } : {}) },
          body: initiera,
        });
        expect(svar.status, `${varde} ${auth === undefined ? 'utan' : 'med'} bearer`).toBe(401);
        expect(await svar.json()).toEqual({ error: 'unauthenticated' });
      }
      await expect(stang(s)).resolves.toBeUndefined();
    }

    // Funktionen tar bara porten. Ett andra argument (proven typkontrolleras inte) används aldrig.
    expect(startaGateway.length).toBe(1);
    const medVard = await (startaGateway as (...args: unknown[]) => Promise<Server>)(0, '0.0.0.0');
    const adress = medVard.address() as AddressInfo;
    expect(adress.address).toBe('127.0.0.1');
    expect(adress.family).toBe('IPv4');
    await expect(stang(medVard)).resolves.toBeUndefined();

    expect(INGA_SESSIONER.nyckelFor('vad-som-helst')).toBeUndefined();
  });
});

/** Dev Notes → Stack och bibliotek: package.json i dag, namn och versioner. */
const BEROENDEN = {
  dependencies: {
    dotenv: '^17.2.0',
    express: '^5.1.0',
    'express-rate-limit': '^8.0.1',
    helmet: '^8.1.0',
    pg: '^8.16.0',
    zod: '^3.25.0',
  },
  devDependencies: {
    '@types/express': '^5.0.0',
    '@types/node': '^22.10.0',
    '@types/pg': '^8.15.0',
    '@types/supertest': '^6.0.2',
    supertest: '^7.1.0',
    tsx: '^4.19.0',
    typescript: '^5.7.0',
    vitest: '^3.2.0',
  },
};

describe('FR-24 (d)/Story 4.2 AK 1: inga nya beroenden', () => {
  it('F16 (R, AK 1): package.json har exakt dagens beroenden', () => {
    const beroenden = (p: { dependencies?: unknown; devDependencies?: unknown }) => ({
      dependencies: p.dependencies,
      devDependencies: p.devDependencies,
    });
    const paket = JSON.parse(readFileSync(path.join(ROT, 'package.json'), 'utf8'));
    expect(beroenden(paket)).toEqual(BEROENDEN);

    // Kontroll sist: en kopia med ett paket till fälls av samma jämförelse.
    const medEttTill = { ...paket, dependencies: { ...paket.dependencies, 'ett-paket-till': '^1.0.0' } };
    expect(beroenden(medEttTill)).not.toEqual(BEROENDEN);
  });
});
