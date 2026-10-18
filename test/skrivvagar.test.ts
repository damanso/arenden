// FR-4 (Story 1.3 och 1.4): varje mutation via /api och vyn bär nyckelns aktör och sin händelserad.
//
// Filen visar kravets sex kriterier för transportlagrets två vägar in, som granskaren kan läsa av här:
//   AK 1  ingen skrivning utan giltig nyckel: 401 och noll rader i NÅGON tabell (F1, F2);
//   AK 2  aktören tas ur nyckeln, aldrig ur indata: .strict() i hela registret, på /api och i vyn (F5–F7, F12);
//   AK 3  en write-action utan händelserad rullas tillbaka, körd genom executeAction (F8, F9);
//   AK 4  events går inte att ändra, varken som app (42501) eller som ägare (P0001) (F3, F4);
//   AK 5  varje rad via /api och vyn bär en aktör ur api_keys (F12–F14); sessionsAktor tar först
//         req.redovisningsaktor: redovisningsundantaget ägs av Story 3.4 och står utanför provet;
//   AK 6  ingen SQL-skrivsats i src/http/, och README:s FR-4-rad pekar hit (F10, F11, F15).
//
// F14 är den SLUTNA listan över de filer som når executeAction, startaSession, skrivHandelse och
// laggTillKommentar, och över INSERT-satserna mot events och comments. Story 1.4 lade till verktygens
// fasta aktörer (F20). Story 9.4 (onboardingen) utökar just den listan. Listan håller
// för de former provet läser i källtexten, med kommentarerna bortlästa:
//   - varje statisk import och återexport av modulen: namngiven, med alias, hela modulen (* as);
//   - varje dynamisk import med en fast sökväg;
//   - i en fil som binder namnet: ett alias, eller en förekomst som inte är ett direkt anrop;
//   - anrop också på en definitionsrad och efter en blockkommentar;
//   - i vyn: varje kor() tar skrivruttens aktör, och den kommer ur kravSessionsAktor(req).
// En importsökväg som byggs först vid körning ser provet inte. Den står under lagerregeln och
// granskningen, liksom en rutt som anropar en skrivande tjänstefunktion direkt (Dev Notes).
// Story 1.4:
//   AK 1  de fyra verktygen, fasta aktörer och samma transaktion (F16–F20);
//   AK 2  README:s slutna lista med beslut och regel (F23);
//   AK 3  invarianten över alla fem vägar, med negativ kontroll (F21, F22).
// Story 1.4:s block står först eftersom AK 3 läser alla rader. Importens kommentarer bär arkivets
// författare (FR-12) och godtas genom importens händelserad som namnger dem.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { z, ZodError } from 'zod';
import { executeAction } from '../src/actions/execute.js';
import { ACTIONS, type RegistreradAction } from '../src/actions/registry.js';
import { migrate } from '../src/db/migrate.js';
import { withTransaction } from '../src/db/tx.js';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { glomAllaSessioner, SESSIONSKAKA } from '../src/http/vy/session.js';
import { aterlasLinear } from '../src/import/aterlasLinear.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { skrivHandelse } from '../src/services/handelser.js';
import { laggTillKommentar } from '../src/services/kommentarer.js';
import { TEST_DB_NAME } from './env.js';
import type { Aktor } from '../src/lib/aktor.js';
import { kor, nyNyckel, seedaTeam, TENANT_ID } from './helpers.js';

type Svar = Awaited<ReturnType<typeof kor>>;

const ROT = fileURLToPath(new URL('../', import.meta.url));

async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

interface Tabelltillstand {
  n: number;
  avtryck: string;
}

/**
 * Radantal och innehållsavtryck för VARJE tabell i public — "noll rader i någon tabell" (FR-4, AK 1).
 * Avtrycket är md5 över tabellens rader i textform. Radantalet ensamt hade inte sett en UPDATE
 * (api_keys.aktiv, issues.claimad_av), eller en INSERT följd av en DELETE. Läst som ägaren.
 */
async function raknaAllaTabeller(): Promise<Record<string, Tabelltillstand>> {
  const c = await adminKlient();
  try {
    const { rows } = await c.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const ut: Record<string, Tabelltillstand> = {};
    for (const { tablename } of rows) {
      const r = await c.query<Tabelltillstand>(
        `SELECT count(*)::int AS n,
                coalesce(md5(string_agg(t::text, chr(10) ORDER BY t::text)), '') AS avtryck
           FROM public."${tablename}" t`,
      );
      ut[tablename] = r.rows[0]!;
    }
    return ut;
  } finally {
    await c.end();
  }
}

/** Tabellerna vars radantal ändrats, med förändringen. `{}` = inga nya eller borttagna rader. */
function skillnad(
  fore: Record<string, Tabelltillstand>,
  efter: Record<string, Tabelltillstand>,
): Record<string, number> {
  const ut: Record<string, number> = {};
  for (const [tabell, { n }] of Object.entries(efter)) {
    const d = n - (fore[tabell]?.n ?? 0);
    if (d !== 0) ut[tabell] = d;
  }
  return ut;
}

/** Tabellerna vars innehåll ändrats på något sätt, också där radantalet står still. Sorterade. */
function andradeTabeller(
  fore: Record<string, Tabelltillstand>,
  efter: Record<string, Tabelltillstand>,
): string[] {
  return Object.keys({ ...fore, ...efter })
    .filter((t) => fore[t]?.avtryck !== efter[t]?.avtryck)
    .sort();
}

async function lyssna(app: Express): Promise<{ server: Server; bas: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  return { server, bas: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/** Loggar in en supertest-agent med en riktig nyckel — samma väg David går. */
async function inloggad(bas: string, nyckel: string): Promise<ReturnType<typeof request.agent>> {
  const agent = request.agent(bas);
  const svar = await agent.post('/vy/logga-in').type('form').send({ nyckel, fran: '/vy' });
  // En misslyckad inloggning svarar också 303 (till /vy/logga-in?fel=1…). Först notisen och
  // sessionskakan visar att en session föddes; annars hade felet synts som en vilseledande 401 senare.
  expect(svar.status).toBe(303);
  expect(svar.headers['location'], 'inloggningen misslyckades').toContain('notis=inloggad');
  expect(String(svar.headers['set-cookie'] ?? ''), 'ingen sessionskaka').toContain(`${SESSIONSKAKA}=`);
  return agent;
}

/** Nyckelns id ur api_keys. Bara id — nyckelhash läses aldrig. */
async function nyckelId(aktorNamn: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM api_keys WHERE aktor_namn = $1', [
    aktorNamn,
  ]);
  expect(rows, `nyckeln ${aktorNamn}`).toHaveLength(1);
  return rows[0]!.id;
}

/** Hela events, ordnad på id — det AK 4 kräver ska vara oförändrat. */
async function handelsebild(): Promise<Record<string, unknown>[]> {
  const { rows } = await pool.query<Record<string, unknown>>(
    'SELECT id, verb, aktor_typ, aktor_namn, payload::text AS payload, tidpunkt FROM events ORDER BY id',
  );
  return rows;
}

async function storstaEventId(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT coalesce(max(id), 0)::text AS n FROM events');
  return Number(rows[0]!.n);
}

/** Aktörerna på varje events-rad med id större än `sedan`, i id-ordning. */
async function aktorerSedan(sedan: number): Promise<{ aktor_typ: string; aktor_namn: string }[]> {
  const { rows } = await pool.query<{ aktor_typ: string; aktor_namn: string }>(
    'SELECT aktor_typ, aktor_namn FROM events WHERE id > $1 ORDER BY id',
    [sedan],
  );
  return rows;
}

// ---- AK 2 -----------------------------------------------------------------

/** Sant om schemat kastar ett ZodError som namnger BÅDA aktörsfälten som okända nycklar. */
function avvisarAktorsfalt(parse: (x: unknown) => unknown): boolean {
  try {
    parse({ aktor_typ: 'manniska', aktor_namn: 'david' });
    return false;
  } catch (err) {
    return (
      err instanceof ZodError &&
      err.issues.some(
        (i) => i.code === 'unrecognized_keys' && i.keys.includes('aktor_typ') && i.keys.includes('aktor_namn'),
      )
    );
  }
}

// ---- AK 3 -----------------------------------------------------------------

/**
 * AK 3:s Given: en write-action vars hanterare inte skriver någon händelserad. Registret har ingen
 * sådan, så provet lånar en registrerad write-action och byter dess handler under körningen.
 * Uppslaget, parse, transaktionen och räknaren är produktionskoden i executeAction. Bytet är inget
 * vi.mock: handlern är en vanlig egenskap på objektet i ACTIONS, som getAction slår upp.
 */
async function medUtbyttHandler<T>(
  actionName: string,
  handler: RegistreradAction['handler'],
  korning: () => Promise<T>, // inte "kor" — det skuggar hjälparen ur ./helpers.js
): Promise<T> {
  const action = ACTIONS.find((a) => a.name === actionName);
  if (!action || action.sensitivity !== 'write') throw new Error(`${actionName} är ingen write-action`);
  const ordinarie = action.handler;
  action.handler = handler;
  try {
    return await korning();
  } finally {
    action.handler = ordinarie;
  }
}

const finnsEtikett = async (namn: string): Promise<boolean> =>
  (await pool.query('SELECT 1 FROM labels WHERE namn = $1', [namn])).rowCount === 1;

// ---- Källtexten (AK 3, AK 5, AK 6) ------------------------------------------

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Varje .ts-fil under src/<under>, med sökvägen relativt src/ och '/' som avskiljare ('http/app.ts'). */
function kallfiler(under = ''): { fil: string; text: string }[] {
  return readdirSync(path.join(SRC, under), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.posix.join(under, f.split(path.sep).join('/')))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(SRC, fil), 'utf8') }));
}

/** Tecknen i `s` utbytta mot blanksteg. Radbrytningarna står kvar, så att radindelningen gäller. */
const blanka = (s: string): string => s.replace(/[^\n]/g, ' ');

/**
 * Källtexten med varje kommentar utbytt mot blanksteg. Strängar, mallsträngar och regex-literaler
 * läses förbi, så att '//' i en adress eller '/*' i ett filmönster inte tas för en kommentar. Kod
 * efter en blockkommentar på samma rad står kvar: en rad som börjar med en kommentar kan bära ett anrop.
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

/** En funktionsdefinition: `function x(`, `export async function x(`, `function def<I>(`. */
const DEFINITION = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/;

/**
 * Träffar på `monster` rad för rad, i texten utan kommentarer. Avsnittet är närmast föregående
 * funktionsdefinition, '(filhuvud)' före den första. På en definitionsrad räknas resten av raden efter
 * namnet, så att definitionen själv inte räknas men ett anrop i samma rad gör det.
 */
function anropsstallen(filer: { fil: string; text: string }[], monster: RegExp): { fil: string; avsnitt: string }[] {
  const ut: { fil: string; avsnitt: string }[] = [];
  for (const { fil, text } of filer) {
    let avsnitt = '(filhuvud)';
    for (const rad of utanKommentarer(text).split('\n')) {
      const def = DEFINITION.exec(rad);
      if (def) avsnitt = def[1]!;
      const kod = def ? rad.slice(def[0].length) : rad;
      const antal = kod.match(new RegExp(monster.source, 'g'))?.length ?? 0;
      for (let i = 0; i < antal; i += 1) ut.push({ fil, avsnitt });
    }
  }
  return ut.sort((a, b) => a.fil.localeCompare(b.fil) || a.avsnitt.localeCompare(b.avsnitt));
}

/** Felmeddelandet: varje anropsställe som fil · avsnitt, så att en avvikelse namnger sig själv. */
function beskriv(stallen: { fil: string; avsnitt: string }[]): string {
  return `anropsställen: ${stallen.map((s) => `${s.fil} · ${s.avsnitt}`).join('; ') || 'inga'}`;
}

/** Avsnittet `namn` utan kommentarer: från dess definitionsrad fram till nästa definition. */
function avsnittet(text: string, namn: string): string {
  const rader = utanKommentarer(text).split('\n');
  const start = rader.findIndex((r) => DEFINITION.exec(r)?.[1] === namn);
  if (start === -1) return '';
  const slut = rader.findIndex((r, i) => i > start && DEFINITION.test(r));
  return rader.slice(start, slut === -1 ? undefined : slut).join('\n');
}

/** Argumenten till varje anrop som `monster` (som slutar på '\(') hittar, med blankstegen hopslagna. */
function argumenten(text: string, monster: RegExp): string[] {
  const kod = utanKommentarer(text);
  const ut: string[] = [];
  for (const m of kod.matchAll(new RegExp(monster.source, 'g'))) {
    const start = m.index! + m[0].length;
    let djup = 0;
    let j = start;
    for (; j < kod.length; j += 1) {
      if (kod[j] === '(') djup += 1;
      else if (kod[j] === ')' && djup-- === 0) break;
    }
    ut.push(kod.slice(start, j).replace(/\s+/g, ' ').trim());
  }
  return ut;
}

// ---- AK 6 -----------------------------------------------------------------

/** AK 6:s fyra mönster, ordagrant ur kriteriet — fallistan, inte skyddet. Skyddet är lagerregeln. */
const SKRIVSATSER: RegExp[] = [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+[\w."]+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i];

function skrivsatser(text: string): string[] {
  return SKRIVSATSER.filter((m) => m.test(text)).map(String);
}

// ---- AK 5 -----------------------------------------------------------------

/**
 * En import- eller återexportsats, också över flera rader: `import x, { a as b } from '…'`,
 * `import * as h from '…'`, `export { a } from '…'`, `export * from '…'`.
 */
const IMPORTSATS =
  /\b(?:import|export)\s+(?:type\s+)?(\*(?:\s*as\s+[\w$]+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s*as\s+[\w$]+))?)\s*from\s*(['"])([^'"]+)\2/g;

/** En dynamisk import eller require med fast sökväg. Den når allt modulen exporterar. */
const DYNAMISK_IMPORT = /\b(?:import|require)\s*\(\s*(['"`])([^'"`]+)\1/g;

interface Bindning {
  fil: string;
  importerat: string; // '*' = hela modulen
  lokalt: string;
}

/** Namnen som en importklausul binder: `{ a, b as c, type d }`, `* as h`, `standard`. */
function bindningar(klausul: string): { importerat: string; lokalt: string }[] {
  const ut: { importerat: string; lokalt: string }[] = [];
  const stjarna = /\*(?:\s*as\s+([\w$]+))?/.exec(klausul);
  if (stjarna) ut.push({ importerat: '*', lokalt: stjarna[1] ?? '*' });
  for (const del of /\{([^}]*)\}/.exec(klausul)?.[1]?.split(',') ?? []) {
    const m = /^\s*(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(del);
    if (m) ut.push({ importerat: m[1]!, lokalt: m[2] ?? m[1]! });
  }
  const standard = /^\s*([\w$]+)/.exec(klausul);
  if (standard) ut.push({ importerat: 'default', lokalt: standard[1]! });
  return ut;
}

/** Varje bindning ur modulen `modul` (sökvägen relativt src/, utan ändelse), i vilken importform som helst. */
function bindningarUr(filer: { fil: string; text: string }[], modul: string): Bindning[] {
  const ut: Bindning[] = [];
  for (const { fil, text } of filer) {
    const kod = utanKommentarer(text);
    const satser = [
      ...[...kod.matchAll(IMPORTSATS)].map((m) => ({ spec: m[3]!, namn: bindningar(m[1]!) })),
      ...[...kod.matchAll(DYNAMISK_IMPORT)].map((m) => ({ spec: m[2]!, namn: [{ importerat: '*', lokalt: '*' }] })),
    ];
    for (const { spec, namn } of satser) {
      if (!spec.startsWith('.')) continue;
      const mal = path.posix.normalize(path.posix.join(path.posix.dirname(fil), spec)).replace(/\.[jt]s$/, '');
      if (mal === modul) ut.push(...namn.map((b) => ({ fil, ...b })));
    }
  }
  return ut;
}

/** Når bindningen funktionen `namn`: en namngiven bindning av just den, hela modulen, eller standardexporten. */
const nar = (b: Bindning, namn: string): boolean => [namn, '*', 'default'].includes(b.importerat);

/** Filerna som binder `namn` ur `modul`, i vilken importform som helst. Sorterade. */
function filerSomBinder(filer: { fil: string; text: string }[], modul: string, namn: string): string[] {
  return [...new Set(bindningarUr(filer, modul).filter((b) => nar(b, namn)).map((b) => b.fil))].sort();
}

/**
 * Omvägarna till `namn` i de filer som binder det: ett alias, hela modulen, eller en förekomst som
 * inte är ett direkt anrop `namn(`. Är listan tom ser räkningen av `namn(` varje väg till funktionen.
 */
function omvagar(filer: { fil: string; text: string }[], modul: string, namn: string): string[] {
  const fel: string[] = [];
  for (const f of filer) {
    const egna = bindningarUr([f], modul).filter((b) => nar(b, namn));
    if (egna.length === 0) continue;
    for (const b of egna) {
      if (b.importerat !== namn || b.lokalt !== namn) fel.push(`${f.fil}: ${b.importerat} som ${b.lokalt}`);
    }
    const kod = utanKommentarer(f.text).replace(IMPORTSATS, blanka);
    for (const m of kod.matchAll(new RegExp(`\\b${namn}\\b(?!\\()`, 'g'))) {
      fel.push(`${f.fil}: ${namn} utan direkt anrop på rad ${kod.slice(0, m.index).split('\n').length}`);
    }
  }
  return fel;
}

/**
 * AK 5 mekanism (1) på /api: anropet av executeAction i routes/actions.ts tar aktören ur
 * kravAktor(req), och kravAktor är autentisera-mellanlagrets. Returnerar avvikelserna.
 */
function apiaktorFel(text: string): string[] {
  const fel: string[] = [];
  const fil = { fil: 'http/routes/actions.ts', text };
  const anrop = argumenten(text, /\bexecuteAction\(/);
  if (anrop.length === 0) fel.push('inget anrop av executeAction');
  for (const a of anrop) {
    if (!a.startsWith('{ aktor: kravAktor(req),') || (a.match(/\baktor\b/g) ?? []).length !== 1) {
      fel.push(`executeAction(${a})`);
    }
  }
  const binder = bindningarUr([fil], 'http/middleware/autentisera');
  if (!binder.some((b) => b.importerat === 'kravAktor' && b.lokalt === 'kravAktor')) {
    fel.push('kravAktor importeras inte ur autentisera');
  }
  if (/\b(?:const|let|var|function|class)\s+kravAktor\b/.test(utanKommentarer(text))) {
    fel.push('kravAktor definieras i filen');
  }
  return fel;
}

/** Högerleden som namnet `aktor` får bindas till i vyn: sessionen (född ur en nyckel) eller nyckeluppslaget. */
const VYAKTORENS_KALLOR = [
  '= kravSessionsAktor(req)',
  '= sessionsAktor(req)',
  '= nyckel === undefined ? null : await slaUppAktor(pool, nyckel)',
];

/**
 * AK 5 mekanism (1) i vyn: varje kor() tar skrivruttens aktör, och skrivrutt() tar den ur
 * kravSessionsAktor(req). Returnerar avvikelserna. Inget antal låses, så att en ny skrivrutt
 * (Story 2.2) kan läggas till utan att provet ändras — så länge den går genom skrivrutt() och kor().
 */
function vyvagensFel(text: string): string[] {
  const fel: string[] = [];
  const fil = [{ fil: 'http/vy/skrivning.ts', text }];
  const kod = utanKommentarer(text);

  // skrivrutt() tar aktören ur sessionen och ger hanteraren just den.
  const ram = avsnittet(text, 'skrivrutt').replace(/\s+/g, ' ');
  if (!ram.includes('const aktor = kravSessionsAktor(req);')) fel.push('skrivrutt: aktören kommer inte ur kravSessionsAktor(req)');
  if (!ram.includes('await hanterare(req, res, aktor);')) fel.push('skrivrutt: hanteraren får inte sessionens aktör');
  if (!bindningarUr(fil, 'http/vy/session').some((b) => b.importerat === 'kravSessionsAktor' && b.lokalt === 'kravSessionsAktor')) {
    fel.push('kravSessionsAktor importeras inte ur session.ts');
  }
  if (/\b(?:const|let|var|function|class)\s+kravSessionsAktor\b/.test(kod)) fel.push('kravSessionsAktor definieras i filen');

  // kor() för vidare sin egen parameter till executeAction, och inget annat.
  const omslag = avsnittet(text, 'kor').replace(/\s+/g, ' ').trim();
  if (!/^(?:export )?(?:async )?function kor\(aktor: Aktor,/.test(omslag)) fel.push(`kor: ${omslag.slice(0, 80)}`);
  const vidare = argumenten(omslag, /\bexecuteAction\(/);
  if (vidare.length !== 1 || vidare[0] !== '{ aktor, actionName, input }') fel.push(`kor: executeAction(${vidare.join(' | ')})`);

  // Varje anrop av kor står bland rutterna och tar `aktor` först; kor förekommer bara som anrop.
  const anrop = anropsstallen(fil, /\bkor\(/);
  if (anrop.length === 0) fel.push('inget anrop av kor');
  for (const s of anrop) if (s.avsnitt !== 'monteraSkrivrutter') fel.push(`kor() i ${s.avsnitt}`);
  for (const _ of anropsstallen(fil, /\bkor\((?!aktor\s*,)/)) fel.push('kor() med en annan aktör än aktor');
  for (const _ of anropsstallen(fil, /\bkor\b(?!\()/)) fel.push('kor utan direkt anrop');

  // Namnet aktor binds bara till sessionen eller nyckeluppslaget, och tilldelas aldrig om.
  for (const m of kod.matchAll(/\b(?:const|let|var)\s+aktor\b([^;]*);/g)) {
    const hogerled = m[1]!.replace(/\s+/g, ' ').trim();
    if (!VYAKTORENS_KALLOR.includes(hogerled)) fel.push(`aktor ${hogerled}`);
  }
  for (const m of kod.matchAll(/\baktor\s*(?:\|\||&&|\?\?)?=(?![=>])/g)) {
    if (!/\b(?:const|let|var)\s+$/.test(kod.slice(0, m.index))) fel.push(`tilldelning: ${m[0]}`);
  }
  for (const m of kod.matchAll(/\{[^{}]*\baktor\b[^{}]*\}\s*(?::[^=;{}]*)?=(?![=>])/g)) {
    fel.push(`destrukturering: ${m[0].replace(/\s+/g, ' ')}`);
  }

  // Bland rutterna är skrivruttens hanterare den enda funktion som tar en parameter som heter aktor.
  const rutter = avsnittet(text, 'monteraSkrivrutter');
  for (const m of rutter.matchAll(/(skrivrutt\(\s*async\s*)?\(([^()]*)\)\s*(?::[^=()]*)?=>/g)) {
    if (!/\baktor\b/.test(m[2]!)) continue;
    const namn = m[2]!.split(',').map((p) => p.split(':')[0]!.trim()).join(',');
    if (!m[1] || namn !== 'req,res,aktor') fel.push(`parameter aktor: (${m[2]!.replace(/\s+/g, ' ')})`);
  }
  if (/\baktor\s*=>/.test(rutter)) fel.push('parameter aktor utan parentes');
  for (const m of rutter.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) {
    if (/\baktor\b/.test(m[1]!)) fel.push(`function-parameter aktor: (${m[1]})`);
  }
  return fel;
}

/** Antal träffar per fil, räknat över hela texten. Filer utan träff står inte med. */
function traffar(filer: { fil: string; text: string }[], monster: RegExp): Record<string, number> {
  const ut: Record<string, number> = {};
  for (const { fil, text } of filer) {
    const antal = text.match(new RegExp(monster.source, 'gi'))?.length ?? 0;
    if (antal > 0) ut[fil] = antal;
  }
  return ut;
}

interface Baslinje {
  eventId: number;
  kommentarer: string[];
}

async function baslinje(): Promise<Baslinje> {
  const k = await pool.query<{ id: string }>('SELECT id FROM comments');
  return { eventId: await storstaEventId(), kommentarer: k.rows.map((r) => r.id) };
}

/** Rader skrivna efter baslinjen vars aktör inte finns i api_keys. */
async function ogiltigaAktorer(b: Baslinje): Promise<{ tabell: string; id: string }[]> {
  const { rows } = await pool.query<{ tabell: string; id: string }>(
    `SELECT 'events' AS tabell, e.id::text AS id FROM events e
      WHERE e.id > $1 AND NOT EXISTS (SELECT 1 FROM api_keys k
        WHERE k.tenant_id = e.tenant_id AND k.aktor_typ = e.aktor_typ AND k.aktor_namn = e.aktor_namn)
     UNION ALL
     SELECT 'comments', c.id::text FROM comments c
      WHERE NOT (c.id = ANY($2::uuid[])) AND NOT EXISTS (SELECT 1 FROM api_keys k
        WHERE k.tenant_id = c.tenant_id AND k.aktor_typ = c.aktor_typ AND k.aktor_namn = c.aktor_namn)
     ORDER BY 1, 2`,
    [b.eventId, b.kommentarer],
  );
  return rows;
}

/** Mängden aktörer ('typ·namn') bland raderna i events och comments sedan baslinjen, sorterad. */
async function nyaAktorer(b: Baslinje): Promise<string[]> {
  const { rows } = await pool.query<{ aktor: string }>(
    `SELECT aktor_typ || '·' || aktor_namn AS aktor FROM events WHERE id > $1
     UNION
     SELECT aktor_typ || '·' || aktor_namn FROM comments WHERE NOT (id = ANY($2::uuid[]))`,
    [b.eventId, b.kommentarer],
  );
  return rows.map((r) => r.aktor).sort();
}

// ---- Story 1.4: de slutna undantagen -----------------------------------------

/**
 * De tre fasta systemaktörerna i den slutna listan (Davids beslut 2026-10-16 11:00). Migrationerna är det
 * fjärde undantaget men bär ingen aktör. Samma lista prövas mot koden (F20), datan (F21) och README (F23).
 */
const FASTA_SYSTEMAKTORER: readonly Aktor[] = [
  { typ: 'system', namn: 'skapa-nyckel' },
  { typ: 'system', namn: 'linear-import' },
  { typ: 'system', namn: 'linear-aterlasning' },
];

/** Aktören som den står i källtexten: `{ typ: 'system', namn: 'linear-import' }`. */
const aktorslitteral = (a: Aktor): string => `{ typ: '${a.typ}', namn: '${a.namn}' }`;

const ARKIVFIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));
const LINEARFIXTUR = fileURLToPath(new URL('./fixtures/linear/linear-prov.json', import.meta.url));

/** De fasta aktörerna som två parallella textlistor, för unnest($1, $2) i SQL. */
const fastaParametrar = (): [string[], string[]] => [
  FASTA_SYSTEMAKTORER.map((a) => a.typ),
  FASTA_SYSTEMAKTORER.map((a) => a.namn),
];

/**
 * AK 3: raderna i HELA events och comments vars aktör varken finns i api_keys eller är en fast
 * systemaktör. En kommentar som importen förde in bär arkivets författare (PRD FR-12); den godtas bara
 * när den har en källreferens (bara importen sätter comments.source_ref) och importens egen händelserad
 * (system · linear-import, importerade_kommentar) namnger just den kommentaren, just den källreferensen
 * och just den aktören — K-10.3:s bindning, skärpt med aktör, verb, källreferens och författare.
 */
async function ogiltigaAktorerAllaVagar(): Promise<{ tabell: string; id: string }[]> {
  const { rows } = await pool.query<{ tabell: string; id: string }>(
    `WITH fasta AS (SELECT * FROM unnest($1::text[], $2::text[]) AS f(aktor_typ, aktor_namn))
     SELECT 'events' AS tabell, e.id::text AS id FROM events e
      WHERE NOT EXISTS (SELECT 1 FROM api_keys k
              WHERE k.tenant_id = e.tenant_id AND k.aktor_typ = e.aktor_typ AND k.aktor_namn = e.aktor_namn)
        AND NOT EXISTS (SELECT 1 FROM fasta f WHERE f.aktor_typ = e.aktor_typ AND f.aktor_namn = e.aktor_namn)
     UNION ALL
     SELECT 'comments', c.id::text FROM comments c
      WHERE NOT EXISTS (SELECT 1 FROM api_keys k
              WHERE k.tenant_id = c.tenant_id AND k.aktor_typ = c.aktor_typ AND k.aktor_namn = c.aktor_namn)
        AND NOT EXISTS (SELECT 1 FROM fasta f WHERE f.aktor_typ = c.aktor_typ AND f.aktor_namn = c.aktor_namn)
        AND NOT (c.source_ref IS NOT NULL AND EXISTS (SELECT 1 FROM events e
              WHERE e.tenant_id = c.tenant_id AND e.issue_id = c.issue_id
                AND e.aktor_typ = 'system' AND e.aktor_namn = 'linear-import'
                AND e.verb = 'importerade_kommentar'
                AND e.payload->>'kommentar_id' = c.id::text
                AND e.payload->>'source_ref' = c.source_ref
                AND e.payload->>'kommentarens_aktor_typ' = c.aktor_typ
                AND e.payload->>'kommentarens_aktor_namn' = c.aktor_namn))`,
    fastaParametrar(),
  );
  return rows;
}

/** Raderna som 'tabell:id', sorterade i kodpunktsordning — oberoende av databasens kollation. */
const radnycklar = (rader: { tabell: string; id: string }[]): string[] =>
  rader.map((r) => `${r.tabell}:${r.id}`).sort();

/** Mängden aktörer ('typ·namn') i hela tabellen, sorterad. */
async function aktorerITabell(tabell: 'events' | 'comments'): Promise<string[]> {
  const { rows } = await pool.query<{ aktor: string }>(
    `SELECT DISTINCT aktor_typ || '·' || aktor_namn AS aktor FROM ${tabell}`,
  );
  return rows.map((r) => r.aktor).sort();
}

/** Kommentarerna vars aktör varken finns i api_keys eller är en fast aktör — de som bara bindningen kan bära. */
async function kommentarerUtanforNycklarna(): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `WITH fasta AS (SELECT * FROM unnest($1::text[], $2::text[]) AS f(aktor_typ, aktor_namn))
     SELECT c.id::text AS id FROM comments c
      WHERE NOT EXISTS (SELECT 1 FROM api_keys k
              WHERE k.tenant_id = c.tenant_id AND k.aktor_typ = c.aktor_typ AND k.aktor_namn = c.aktor_namn)
        AND NOT EXISTS (SELECT 1 FROM fasta f WHERE f.aktor_typ = c.aktor_typ AND f.aktor_namn = c.aktor_namn)`,
    fastaParametrar(),
  );
  return rows.map((r) => r.id).sort();
}

/**
 * Raderna med de här id:na i `tabell` som INTE delar xmin med en händelserad som bär återläsningens
 * aktör — alltså rader som inte skrevs i samma transaktion som återläsningens händelserad.
 */
async function utanAterlasningensHandelse(
  tabell: 'issue_relations' | 'issue_attachments',
  ids: string[],
): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `SELECT r.id::text AS id FROM ${tabell} r
      WHERE r.id = ANY($1::uuid[])
        AND NOT EXISTS (SELECT 1 FROM events e
              WHERE e.xmin = r.xmin AND e.aktor_typ = 'system' AND e.aktor_namn = 'linear-aterlasning')`,
    [ids],
  );
  return rows.map((r) => r.id).sort();
}

const korProcess = promisify(execFile);

/**
 * `npm run nyckel -- <typ> <namn> --fil <tmp>`: samma kommando som package.json:s skript (F18 läser det),
 * som barnprocess mot TESTdatabasen. DOTENV_CONFIG_PATH pekar på en fil som inte finns, så att ingen .env
 * kan rikta skriptet mot en annan databas (samma skydd som test/rattelser.test.ts).
 */
async function korNyckelskriptet(typ: string, namn: string): Promise<{ nyckel: string; stdout: string }> {
  const fil = path.join(tmpdir(), `skrivvagar-f18-${process.pid}-${Date.now()}.nyckel`);
  try {
    const { stdout } = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'tsx'),
      [path.join(ROT, 'src', 'scripts', 'skapaNyckel.ts'), typ, namn, '--fil', fil],
      { cwd: ROT, env: { ...process.env, DOTENV_CONFIG_PATH: path.join(tmpdir(), 'skrivvagar-finns-inte.env') } },
    );
    return { nyckel: (await readFile(fil, 'utf8')).trim(), stdout };
  } finally {
    await rm(fil, { force: true });
  }
}

/**
 * Hela migrationskedjan mot en NY, tom databas i testklustret: vad kedjan själv skriver. events är
 * append-only, så en rad som någon migration lagt där hade stått kvar.
 */
async function migreradTomDatabas(): Promise<{
  applied: number; ledger: number; events: number; comments: number; tenants: number;
}> {
  const namn = `${TEST_DB_NAME}_f19_migrering`;
  const underhall = new pg.Client({ connectionString: process.env.MAINTENANCE_DATABASE_URL });
  await underhall.connect();
  try {
    await underhall.query(`DROP DATABASE IF EXISTS ${namn} WITH (FORCE)`);
    await underhall.query(`CREATE DATABASE ${namn}`);
    const url = new URL(process.env.DATABASE_ADMIN_URL!);
    url.pathname = `/${namn}`;
    const resultat = await migrate(url.toString());
    const c = new pg.Client({ connectionString: url.toString() });
    await c.connect();
    try {
      const { rows } = await c.query<{ ledger: number; events: number; comments: number; tenants: number }>(
        `SELECT (SELECT count(*)::int FROM schema_migrations) AS ledger,
                (SELECT count(*)::int FROM events) AS events,
                (SELECT count(*)::int FROM comments) AS comments,
                (SELECT count(*)::int FROM tenants) AS tenants`,
      );
      return { applied: resultat.applied.length, ...rows[0]! };
    } finally {
      await c.end();
    }
  } finally {
    try {
      await underhall.query(`DROP DATABASE IF EXISTS ${namn} WITH (FORCE)`);
    } finally {
      await underhall.end();
    }
  }
}

/** Argumenten delade på kommatecken på djup 0: 'a, { b, c }, f(d, e)' → ['a', '{ b, c }', 'f(d, e)']. */
function argumentlista(args: string): string[] {
  const ut: string[] = [];
  let djup = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i]!;
    if ('([{'.includes(c)) djup += 1;
    else if (')]}'.includes(c)) djup -= 1;
    else if (c === ',' && djup === 0) {
      ut.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const sista = args.slice(start).trim();
  if (sista) ut.push(sista); // ett avslutande kommatecken ger ingen tom post
  return ut;
}

interface Verktyg {
  fil: string;
  aktor: Aktor;
  modul: string;
  namn: 'skrivHandelse' | 'executeAction';
  konstant: string | null;
}

/** De tre skrivande verktygen i den slutna listan, med sin fasta aktör och sin enda väg till loggen. */
const VERKTYGEN: readonly Verktyg[] = [
  { fil: 'import/importeraArkiv.ts', aktor: FASTA_SYSTEMAKTORER[1]!, modul: 'services/handelser', namn: 'skrivHandelse', konstant: 'IMPORTAKTOR' },
  { fil: 'import/aterlasLinear.ts', aktor: FASTA_SYSTEMAKTORER[2]!, modul: 'actions/execute', namn: 'executeAction', konstant: 'ATERLASAKTOR' },
  { fil: 'scripts/skapaNyckel.ts', aktor: FASTA_SYSTEMAKTORER[0]!, modul: 'services/handelser', namn: 'skrivHandelse', konstant: null },
];

/**
 * Story 1.4, AK 1: varje anrop i verktygen bär verktygets fasta aktör — skrivHandelse som tredje argument
 * (konstanten eller literalen), executeAction som egenskapen aktor — och konstanten är den fasta aktören.
 * omvagar() först: utan alias och referenser ser argumenten() varje anrop.
 */
function verktygensAktorFel(filer: { fil: string; text: string }[]): string[] {
  const fel: string[] = [];
  for (const v of VERKTYGEN) {
    const f = filer.find((x) => x.fil === v.fil);
    if (!f) {
      fel.push(`${v.fil}: saknas`);
      continue;
    }
    fel.push(...omvagar([f], v.modul, v.namn));
    const anrop = argumenten(f.text, new RegExp(`\\b${v.namn}\\(`));
    if (anrop.length === 0) fel.push(`${v.fil}: inget anrop av ${v.namn}`);
    const vantad = v.konstant ?? aktorslitteral(v.aktor);
    for (const a of anrop) {
      const ok =
        v.namn === 'skrivHandelse'
          ? argumentlista(a)[2] === vantad
          : a.includes(`aktor: ${vantad}`) && (a.match(/\baktor\b/g) ?? []).length === 1;
      if (!ok) fel.push(`${v.fil}: ${v.namn}(${a.slice(0, 120)})`);
    }
    if (v.konstant) {
      const kod = utanKommentarer(f.text).replace(/\s+/g, ' ');
      if (!kod.includes(`const ${v.konstant}: Aktor = ${aktorslitteral(v.aktor)};`)) {
        fel.push(`${v.fil}: ${v.konstant} är inte ${aktorslitteral(v.aktor)}`);
      }
    }
  }
  return fel;
}

/**
 * API-vägens två skrivställen tar aktören ur parametern, aldrig ur en literal: skrivHandelse i
 * executeAction (params.aktor, tredje argumentet) och laggTillKommentar i add_comment (ctx.aktor, femte).
 * Ett nytt verktyg som läggs i en fil som redan står på listan fälls därmed också. Bara argumenten()
 * här — omvagar() hade fällt egenskapen `skrivHandelse:` i ctx-objektet (execute.ts rad 42).
 */
const API_VAGENS_SKRIVSTALLEN: readonly { fil: string; anrop: RegExp; plats: number; vantad: string }[] = [
  { fil: 'actions/execute.ts', anrop: /\bskrivHandelse\(/, plats: 2, vantad: 'params.aktor' },
  { fil: 'actions/registry.ts', anrop: /\blaggTillKommentar\(/, plats: 4, vantad: 'ctx.aktor' },
];

function apiVagensAktorFel(filer: { fil: string; text: string }[]): string[] {
  const fel: string[] = [];
  for (const s of API_VAGENS_SKRIVSTALLEN) {
    const f = filer.find((x) => x.fil === s.fil);
    if (!f) {
      fel.push(`${s.fil}: saknas`);
      continue;
    }
    const anrop = argumenten(f.text, s.anrop);
    if (anrop.length === 0) fel.push(`${s.fil}: inget anrop av ${s.anrop.source}`);
    for (const a of anrop) {
      if (argumentlista(a)[s.plats] !== s.vantad) fel.push(`${s.fil}: ${s.anrop.source}${a.slice(0, 120)})`);
    }
  }
  return fel;
}

/** Filerna som binder skrivställena — Story 1.3:s lista (F14), samlad här för den negativa kontrollen. */
const SLUTNA_LISTAN: readonly { modul: string; namn: string; filer: readonly string[] }[] = [
  { modul: 'services/handelser', namn: 'skrivHandelse', filer: ['actions/execute.ts', 'import/importeraArkiv.ts', 'scripts/skapaNyckel.ts'] },
  { modul: 'services/kommentarer', namn: 'laggTillKommentar', filer: ['actions/registry.ts', 'import/importeraArkiv.ts'] },
  { modul: 'actions/execute', namn: 'executeAction', filer: ['http/routes/actions.ts', 'http/vy/skrivning.ts', 'import/aterlasLinear.ts'] },
];

/** Avvikelserna från den slutna listan och från verktygens fasta aktörer. Tom = listan håller. */
function slutnaListansFel(filer: { fil: string; text: string }[]): string[] {
  const fel: string[] = [];
  for (const { modul, namn, filer: vantade } of SLUTNA_LISTAN) {
    const faktiska = filerSomBinder(filer, modul, namn);
    const extra = faktiska.filter((f) => !vantade.includes(f));
    const saknas = vantade.filter((f) => !faktiska.includes(f));
    if (extra.length > 0) fel.push(`${namn} binds också av: ${extra.join(', ')}`);
    if (saknas.length > 0) fel.push(`${namn} binds inte längre av: ${saknas.join(', ')}`);
  }
  return [...fel, ...verktygensAktorFel(filer), ...apiVagensAktorFel(filer)];
}

/**
 * Story 1.4, AK 2: avvikelserna i README:s FR-4-avsnitt från den slutna listan. Tom = avsnittet bär
 * de fyra undantagen, de fasta aktörerna, beslutet och regeln, och FR-4-raden pekar på AK 3.
 * Avsnittet slutar vid nästa rubrik (## eller ###), så att en text i ett annat avsnitt inte räknas.
 */
function readmeFel(readme: string): string[] {
  const start = readme.indexOf('### FR-4 —');
  if (start === -1) return ['README saknar avsnittet ### FR-4 —'];
  const langd = readme.slice(start + 1).search(/\n#{2,3} /);
  const avsnitt = langd === -1 ? readme.slice(start) : readme.slice(start, start + 1 + langd);
  const rader = avsnitt.split('\n');
  const fel: string[] = [];

  const fr4 = rader.filter((r) => r.startsWith('| FR-4 |'));
  if (!fr4.some((r) => r.includes('Story 1.4 AK 3'))) fel.push('FR-4-raden pekar inte på Story 1.4 AK 3');

  // Exakt fyra undantag, i ordningen migrationerna, nyckelskriptet, importen, återläsningen.
  const undantag = rader.filter((r) => r.startsWith('| FR-4, undantag: '));
  if (undantag.length !== 4) fel.push(`${undantag.length} undantagsrader, inte 4`);
  const kod = ['`src/db/migrate.ts`', '`src/scripts/skapaNyckel.ts`', '`src/import/importeraArkiv.ts`', '`src/import/aterlasLinear.ts`'];
  undantag.forEach((r, i) => {
    for (const krav of [kod[i] ?? '(ingen femte rad)', 'test/skrivvagar.test.ts', 'Davids beslut 2026-10-16 11:00']) {
      if (!r.includes(krav)) fel.push(`undantagsrad ${i + 1} saknar ${krav}`);
    }
  });
  const migrationer = undantag[0] ?? '';
  if (!migrationer.includes('migrationerna') || !migrationer.includes('aldrig rader i `events` eller `comments`')) {
    fel.push('migrationsraden säger inte "aldrig rader i `events` eller `comments`"');
  }
  // Samma fasta aktörer som provet prövar mot koden och datan — dokumentationen kan inte glida isär från dem.
  for (const a of FASTA_SYSTEMAKTORER) {
    const n = undantag.filter((r) => r.includes(`\`${a.typ} · ${a.namn}\``)).length;
    if (n !== 1) fel.push(`${a.typ} · ${a.namn} står på ${n} undantagsrader`);
  }

  // Regeln och beslutet, i avsnittets text.
  const text = avsnitt.replace(/\s+/g, ' ');
  for (const krav of [
    'Inget nytt skrivande verktyg får läggas till utanför `executeAction`',
    'skriver via API:t med en nyckel',
    'Davids beslut 2026-10-16 11:00',
  ]) {
    if (!text.includes(krav)) fel.push(`avsnittet saknar «${krav}»`);
  }
  return fel;
}

describe('FR-4/Story 1.4 AK 1 och AK 3: de slutna undantagen och invarianten över alla vägar', () => {
  let app: Express;
  let server: Server;
  let bas: string;
  let agentnyckel: string;
  let nyckelF18: string;

  beforeAll(async () => {
    app = createApp();
    glomAllaSessioner();
    ({ server, bas } = await lyssna(app));
    const t = await raknaAllaTabeller();
    if (t.events!.n > 0 || t.comments!.n > 0 || t.issues!.n > 0) {
      throw new Error('Story 1.4:s block måste stå först i filen: AK 3 läser alla rader i events och comments');
    }
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'f16 agent' });
  });

  afterAll(async () => {
    if (server) await new Promise<void>((klar) => server.close(() => klar()));
  });

  it('F16 (Story 1.4, AK 1 och AK 3): importens ärenden och kommentarer delar transaktion med sina händelserader', async () => {
    const resultat = await importeraArkiv(ARKIVFIXTURER);
    expect(resultat.nya_arenden).toBe(3);
    expect(resultat.nya_kommentarer).toBe(3);
    // Ärendena: en importerade_arende per ärende, med importens aktör och samma xmin.
    const arenden = await pool.query<{ identifier: string; n: number; aktorer: string[]; samma: boolean | null }>(
      `SELECT t.key || '-' || i.sequence_number AS identifier,
              count(e.id)::int AS n,
              array_remove(array_agg(DISTINCT e.aktor_typ || '·' || e.aktor_namn), NULL) AS aktorer,
              bool_and(e.xmin = i.xmin) AS samma
         FROM issues i
         JOIN teams t ON t.id = i.team_id
         LEFT JOIN events e ON e.issue_id = i.id AND e.verb = 'importerade_arende'
        WHERE i.source_ref IS NOT NULL
        GROUP BY 1`,
    );
    const somKarta = <T extends { n: number; aktorer: string[]; samma: boolean | null }>(
      rader: T[], nyckel: (r: T) => string,
    ) => Object.fromEntries(rader.map((r) => [nyckel(r), { n: r.n, aktorer: r.aktorer, samma: r.samma }]));
    const enRad = { n: 1, aktorer: ['system·linear-import'], samma: true };
    expect(somKarta(arenden.rows, (r) => r.identifier)).toEqual({ 'LOC-316': enRad, 'LOC-329': enRad, 'LOC-88': enRad });

    // Kommentarerna: en importerade_kommentar som namnger kommentaren, med importens aktör och samma xmin.
    const kommentarer = await pool.query<{ source_ref: string; n: number; aktorer: string[]; samma: boolean | null }>(
      `SELECT c.source_ref,
              count(e.id)::int AS n,
              array_remove(array_agg(DISTINCT e.aktor_typ || '·' || e.aktor_namn), NULL) AS aktorer,
              bool_and(e.xmin = c.xmin) AS samma
         FROM comments c
         LEFT JOIN events e ON e.verb = 'importerade_kommentar' AND e.payload->>'kommentar_id' = c.id::text
        WHERE c.source_ref IS NOT NULL
        GROUP BY c.source_ref`,
    );
    expect(somKarta(kommentarer.rows, (r) => r.source_ref)).toEqual({
      'linear-arkiv:LOC-329#1': enRad,
      'linear-arkiv:LOC-88#1': enRad,
      'linear-arkiv:LOC-88#2': enRad,
    });

    // Allt i EN transaktion: en enda xmin bland importens rader.
    const xminer = await pool.query<{ x: string }>(
      `SELECT DISTINCT x FROM (
         SELECT xmin::text AS x FROM issues WHERE source_ref IS NOT NULL
         UNION ALL SELECT xmin::text FROM comments WHERE source_ref IS NOT NULL
         UNION ALL SELECT xmin::text FROM events WHERE aktor_namn = 'linear-import') r`,
    );
    expect(xminer.rows).toHaveLength(1);
    const importensXmin = xminer.rows[0]!.x;

    expect(await aktorerITabell('events')).toEqual(['system·linear-import']);

    // Kontroll: ett create_issue efteråt är en annan transaktion — men ärendet och dess rad delar den.
    const skapat = await kor(app, agentnyckel, 'create_issue', { title: 'F16 kontroll', team_key: 'LOC' });
    expect(skapat.status).toBe(200);
    const kontroll = await pool.query<{ arende: string; handelse: string }>(
      'SELECT i.xmin::text AS arende, e.xmin::text AS handelse FROM issues i JOIN events e ON e.issue_id = i.id WHERE i.id = $1',
      [skapat.body.result.id],
    );
    expect(kontroll.rows).toHaveLength(1);
    expect(kontroll.rows[0]!.arende).toBe(kontroll.rows[0]!.handelse);
    expect(kontroll.rows[0]!.arende).not.toBe(importensXmin);
    expect(await aktorerITabell('events')).toEqual(['agent·f16 agent', 'system·linear-import']);
  });

  it('F17 (Story 1.4, AK 1 och AK 3): återläsningens relationer och bilagor delar transaktion med dess händelserader', async () => {
    const sedan = await storstaEventId();
    const resultat = await aterlasLinear(LINEARFIXTUR, 'allt');
    expect(resultat.relationer_nya).toBe(2);
    expect(resultat.bilagor_nya).toBe(2);
    const aktorer = await aktorerSedan(sedan);
    expect(aktorer.length).toBeGreaterThan(0);
    expect(aktorer.every((a) => a.aktor_typ === 'system' && a.aktor_namn === 'linear-aterlasning')).toBe(true);
    for (const tabell of ['issue_relations', 'issue_attachments'] as const) {
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id::text AS id FROM ${tabell} WHERE source_ref LIKE 'linear-arkiv:%'`,
      );
      expect(rows, tabell).toHaveLength(2);
      expect(await utanAterlasningensHandelse(tabell, rows.map((r) => r.id)), tabell).toEqual([]);
    }
    // Kontroll: API-relationens händelserad har agentnyckelns aktör, inte återläsningens.
    const svar = await kor(app, agentnyckel, 'link_issues', { fran: 'LOC-316', till: 'LOC-88', typ: 'related' });
    expect(svar.status).toBe(200);
    const kontroll = await pool.query<{ id: string }>(
      'SELECT id::text AS id FROM issue_relations WHERE source_ref IS NULL',
    );
    expect(kontroll.rows).toHaveLength(1);
    const ids = kontroll.rows.map((r) => r.id);
    expect(await utanAterlasningensHandelse('issue_relations', ids)).toEqual(ids);
  });

  it('F18 (Story 1.4, AK 1 och AK 3): nyckelskriptet skriver nyckeln och systemhändelsen i samma transaktion', async () => {
    expect(JSON.parse(readFileSync(path.join(ROT, 'package.json'), 'utf8')).scripts.nyckel)
      .toBe('tsx src/scripts/skapaNyckel.ts');
    const sedan = await storstaEventId();
    const fore = await raknaAllaTabeller();
    const { nyckel, stdout } = await korNyckelskriptet('manniska', 'f18 människa');
    expect(nyckel).toMatch(/^[0-9a-f]{64}$/);
    expect(stdout).not.toContain(nyckel);
    const efter = await raknaAllaTabeller();
    expect(skillnad(fore, efter)).toEqual({ api_keys: 1, events: 1 });
    expect(andradeTabeller(fore, efter)).toEqual(['api_keys', 'events']);
    const { rows } = await pool.query<{
      nyckel_id: string; verb: string; aktor_typ: string; aktor_namn: string; payload_nyckel: string; samma: boolean;
    }>(
      `SELECT k.id::text AS nyckel_id, e.verb, e.aktor_typ, e.aktor_namn,
              e.payload->>'nyckel_id' AS payload_nyckel, e.xmin = k.xmin AS samma
         FROM api_keys k CROSS JOIN events e
        WHERE k.aktor_namn = 'f18 människa' AND e.id > $1`,
      [sedan],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      nyckel_id: rows[0]!.nyckel_id,
      verb: 'skapade_aktorsidentitet',
      aktor_typ: 'system',
      aktor_namn: 'skapa-nyckel',
      payload_nyckel: rows[0]!.nyckel_id,
      samma: true,
    });
    nyckelF18 = nyckel;
    // Kontroll: provhjälparen skriver bara nyckeln i en egen transaktion.
    await nyNyckel({ typ: 'agent', namn: 'f18 kontroll' });
    const kontroll = await pool.query<{ delar: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM api_keys k JOIN events e ON e.xmin = k.xmin
        WHERE k.aktor_namn = 'f18 kontroll') AS delar`,
    );
    expect(kontroll.rows).toEqual([{ delar: false }]);
  });

  it('F19 (Story 1.4, AK 1 och AK 3): migrationskedjan skriver inga händelser eller kommentarer', async () => {
    const katalog = path.join(ROT, 'migrations');
    const filer = readdirSync(katalog).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f));
    expect(filer.length).toBeGreaterThan(0);
    const tom = await migreradTomDatabas();
    expect(tom.applied).toBe(filer.length);
    expect(tom.ledger).toBe(filer.length);
    expect(tom.events).toBe(0);
    expect(tom.comments).toBe(0);
    expect(tom.tenants).toBeGreaterThan(0);
    const texter = filer.map((fil) => ({ fil, text: readFileSync(path.join(katalog, fil), 'utf8') }));
    expect(traffar(texter, /\bINSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?(?:events|comments)\b/)).toEqual({});
    // Kontroll: samma räkning mot scenariots databas hittar importens rader.
    const c = await adminKlient();
    try {
      const { rows } = await c.query<{ events: number; comments: number }>(
        `SELECT (SELECT count(*)::int FROM events) AS events,
                (SELECT count(*)::int FROM comments) AS comments`,
      );
      expect(rows[0]!.events).toBeGreaterThan(0);
      expect(rows[0]!.comments).toBeGreaterThan(0);
    } finally {
      await c.end();
    }
  });

  it('F20 (Story 1.4, AK 1 och AK 3): skrivställenas bindningar och aktörer följer den slutna listan', () => {
    const alla = kallfiler();
    const texten = (fil: string): string => alla.find((f) => f.fil === fil)!.text;
    const med = (fil: string, text: string) => alla.map((f) => (f.fil === fil ? { fil, text } : f));
    const IMPORT = 'import/importeraArkiv.ts';
    const ATERLAS = 'import/aterlasLinear.ts';
    const NYCKEL = 'scripts/skapaNyckel.ts';
    const varianter: Record<string, { fil: string; text: string }> = {
      'importens konstant byter aktör': { fil: IMPORT, text: texten(IMPORT).replace("namn: 'linear-import'", "namn: 'linear-import-2'") },
      'importen skriver med en annan hårdkodad aktör': {
        fil: IMPORT,
        text: texten(IMPORT).replace(
          'resultat.nya_arenden += 1;',
          "resultat.nya_arenden += 1;\n        await skrivHandelse(client, TENANT_ID, { typ: 'system', namn: 'nytt' }, { issueId: id, verb: 'x' });",
        ),
      },
      'återläsningen med en annan aktör': { fil: ATERLAS, text: texten(ATERLAS).replace('aktor: ATERLASAKTOR', "aktor: { typ: 'system', namn: 'annan' }") },
      'återläsningens konstant byter aktör': { fil: ATERLAS, text: texten(ATERLAS).replace("namn: 'linear-aterlasning'", "namn: 'linear-aterlasning-2'") },
      'nyckelskriptet med en annan aktör': { fil: NYCKEL, text: texten(NYCKEL).replace("namn: 'skapa-nyckel'", "namn: 'annat-skript'") },
      'executeAction skriver med en hårdkodad aktör': {
        fil: 'actions/execute.ts',
        text: texten('actions/execute.ts').replace('params.aktor, handelse)', "{ typ: 'system', namn: 'nytt' }, handelse)"),
      },
      'add_comment med en hårdkodad aktör': {
        fil: 'actions/registry.ts',
        text: texten('actions/registry.ts').replace('arende.id, input.body, ctx.aktor)', "arende.id, input.body, { typ: 'system', namn: 'nytt' })"),
      },
    };
    expect(slutnaListansFel(alla)).toEqual([]);
    expect(Object.entries(varianter).filter(([, v]) => v.text === texten(v.fil)).map(([namn]) => namn),
      'oförändrade varianter').toEqual([]);
    const slapps = Object.entries(varianter)
      .filter(([, v]) => slutnaListansFel(med(v.fil, v.text)).length === 0)
      .map(([namn]) => namn);
    expect(slapps, `släpps igenom: ${slapps.join(', ')}`).toEqual([]);
  });

  it('F21 (Story 1.4, AK 3): alla vägars rader bär tillåtna aktörer och arkivkommentarerna binds till importens händelserader', async () => {
    expect(nyckelF18, 'F18 måste ha körts före F21').toBeTruthy();
    const skapat = await kor(app, agentnyckel, 'create_issue', { title: 'F21 ärende', team_key: 'LOC' });
    expect(skapat.status).toBe(200);
    const nytt = skapat.body.result.identifier;
    expect(typeof nytt).toBe('string');
    expect((await kor(app, agentnyckel, 'add_comment', { identifier: 'LOC-88', body: 'F21 api' })).status).toBe(200);
    expect((await kor(app, agentnyckel, 'update_issue', { identifier: 'LOC-316', priority: 3 })).status).toBe(200);
    expect((await kor(app, agentnyckel, 'update_issue_state', { identifier: nytt, state_typ: 'started' })).status).toBe(200);
    const webblasare = await inloggad(bas, nyckelF18);
    const kommenterad = await webblasare.post('/vy/arende/LOC-88/kommentar').type('form').send({ body: 'F21 vy' });
    expect(kommenterad.status).toBe(303);
    expect(kommenterad.headers['location']).toContain('notis=kommenterad');
    const rattad = await webblasare.post('/vy/arende/LOC-88/ratta').type('form')
      .send({ titel: 'LOC-88 rättad i F21', beskrivning: 'F21 beskrivning' });
    expect(rattad.status).toBe(303);
    expect(rattad.headers['location']).toContain('notis=arendet_rattat');

    // Hela tabellerna, utan baslinje. De positiva mängderna gör att en tom tenantläsning inte kan bli grön.
    expect(await ogiltigaAktorerAllaVagar()).toEqual([]);
    expect(await aktorerITabell('events')).toEqual([
      'agent·f16 agent', 'manniska·f18 människa',
      ...FASTA_SYSTEMAKTORER.map((a) => `${a.typ}·${a.namn}`),
    ].sort());
    expect(await aktorerITabell('comments')).toEqual([
      'agent·f16 agent', 'manniska·david mancilla', 'manniska·f18 människa',
    ].sort());
    const importerade = await pool.query<{ id: string }>(
      'SELECT id::text AS id FROM comments WHERE source_ref IS NOT NULL',
    );
    expect(importerade.rows).toHaveLength(3);
    expect(await kommentarerUtanforNycklarna()).toEqual(importerade.rows.map((r) => r.id).sort());
  });

  it('F22 (Story 1.4, AK 3): ett nytt verktyg fälls i data och källtext, även med en falsk importbindning', async () => {
    // (a) Data: ett nytt verktyg med en egen hårdkodad aktör, som skriver förbi executeAction.
    const loc88 = (
      await pool.query<{ id: string }>(
        "SELECT i.id FROM issues i JOIN teams t ON t.id = i.team_id WHERE t.key = 'LOC' AND i.sequence_number = 88",
      )
    ).rows[0]!.id;
    const nyttVerktyg: Aktor = { typ: 'system', namn: 'f22 nytt verktyg' };
    const { c1, c2 } = await withTransaction(async (client) => {
      await skrivHandelse(client, TENANT_ID, nyttVerktyg, { issueId: null, verb: 'f22_prov' });
      const k1 = await laggTillKommentar(client, TENANT_ID, loc88, 'F22 utan nyckel', { typ: 'manniska', namn: 'f22 påhittad' });
      const k2 = await laggTillKommentar(
        client, TENANT_ID, loc88, 'F22 falsk import', { typ: 'manniska', namn: 'f22 arkivnamn' },
        { source_ref: 'f22-falsk-import#1' },
      );
      // En bindning som är importens i allt utom aktören — fel verktyg. Den ska inte bära kommentaren.
      await skrivHandelse(client, TENANT_ID, nyttVerktyg, {
        issueId: loc88,
        verb: 'importerade_kommentar',
        payload: {
          kommentar_id: k2.id,
          source_ref: 'f22-falsk-import#1',
          kommentarens_aktor_typ: 'manniska',
          kommentarens_aktor_namn: 'f22 arkivnamn',
        },
      });
      return { c1: k1.id, c2: k2.id };
    });
    const verktygetsRader = (
      await pool.query<{ id: string }>("SELECT id::text AS id FROM events WHERE aktor_namn = 'f22 nytt verktyg'")
    ).rows.map((r) => ({ tabell: 'events', id: r.id }));
    expect(verktygetsRader).toHaveLength(2);
    expect(radnycklar(await ogiltigaAktorerAllaVagar())).toEqual(
      radnycklar([{ tabell: 'comments', id: c1 }, { tabell: 'comments', id: c2 }, ...verktygetsRader]),
    );

    // (b) Källtext: en ny fil som binder ett skrivställe fälls av den slutna listan och namnges.
    const pahittade = [
      {
        fil: 'scripts/nyttVerktyg.ts',
        text: "import { skrivHandelse } from '../services/handelser.js';\nawait skrivHandelse(client, TENANT_ID, { typ: 'system', namn: 'nytt-verktyg' }, { issueId: null, verb: 'x' });\n",
      },
      {
        fil: 'import/nyImport.ts',
        text: "import { laggTillKommentar } from '../services/kommentarer.js';\nawait laggTillKommentar(client, TENANT_ID, id, 'x', { typ: 'system', namn: 'ny-import' });\n",
      },
      {
        fil: 'scripts/nyKorning.ts',
        text: "import { executeAction } from '../actions/execute.js';\nawait executeAction({ aktor: { typ: 'system', namn: 'ny-korning' }, actionName: 'x', input: {} });\n",
      },
    ];
    for (const p of pahittade) {
      expect(slutnaListansFel([...kallfiler(), p]).join('\n'), p.fil).toContain(p.fil);
    }
  });
});

describe('FR-4/AK 1 och AK 4: ingen skrivning utan nyckel, och events är orubbliga', () => {
  let app: Express;
  let manniskonyckel: string;
  let agentnyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'f1 människa' });
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'f1 agent' });
  });

  it('F1 (AK 1): varje write-action ger 401 utan nyckel, med påhittad och med återkallad nyckel — noll rader', async () => {
    const aterkallad = await nyNyckel({ typ: 'agent', namn: 'f1 återkallad' });
    const lasMed = (nyckel: string) => request(app).get('/api/actions').set('Authorization', `Bearer ${nyckel}`);
    // Nyckeln fungerar före återkallningen. Annars hade 401 nedan inte sagt något om återkallningen.
    expect((await lasMed(aterkallad)).status, 'nyckeln fungerade aldrig').toBe(200);

    // Återkallad den riktiga vägen, med revoke_api_key — inte med en UPDATE som ägaren.
    const foreAterkallning = await raknaAllaTabeller();
    const aterkallning = await kor(app, manniskonyckel, 'revoke_api_key', {
      nyckel_id: await nyckelId('f1 återkallad'),
    });
    expect(aterkallning.status).toBe(200);
    expect(aterkallning.body.result.andrad).toBe(true);
    expect((await lasMed(aterkallad)).status, 'återkallningen tog inte').toBe(401);
    // Kontroll av måttet: återkallningen ändrar api_keys utan att radantalet rör sig, och avtrycket
    // ser det. Likheten nedan säger alltså något också om en UPDATE.
    const efterAterkallning = await raknaAllaTabeller();
    expect(skillnad(foreAterkallning, efterAterkallning)).toEqual({ events: 1 });
    expect(andradeTabeller(foreAterkallning, efterAterkallning)).toEqual(['api_keys', 'events']);

    // Listan läses ur registret när provet körs: en ny write-action prövas utan att någon skriver in den.
    const skrivande = ACTIONS.filter((a) => a.sensitivity === 'write');
    expect(skrivande.length, 'registret har inga write-actions').toBeGreaterThan(0);

    const lagen: { lage: string; authorization: string | undefined }[] = [
      { lage: 'utan nyckel', authorization: undefined },
      { lage: 'påhittad nyckel', authorization: `Bearer ${randomBytes(32).toString('hex')}` },
      { lage: 'återkallad nyckel', authorization: `Bearer ${aterkallad}` },
    ];

    const fore = await raknaAllaTabeller();
    const avvikelser: string[] = [];
    for (const a of skrivande) {
      for (const { lage, authorization } of lagen) {
        const anrop = request(app).post(`/api/actions/${a.name}`);
        if (authorization !== undefined) anrop.set('Authorization', authorization);
        const svar = await anrop.send({});
        // 401 och inte 400: anropet stoppades FÖRE valideringen, alltså före executeAction.
        if (svar.status !== 401 || svar.body.error !== 'unauthenticated') {
          avvikelser.push(`${a.name} · ${lage} · ${svar.status}`);
        }
      }
    }
    expect(avvikelser, `släpptes förbi nyckelkravet: ${avvikelser.join('; ')}`).toEqual([]);
    expect(await raknaAllaTabeller()).toEqual(fore);
  });

  it('F2 (AK 1, kontroll): samma mätning slår ut för ett giltigt anrop — exakt issues +1 och events +1', async () => {
    const fore = await raknaAllaTabeller();
    const svar = await kor(app, manniskonyckel, 'create_issue', { title: 'F2 kontroll', team_key: 'LOC' });
    expect(svar.status).toBe(200);
    const efter = await raknaAllaTabeller();
    expect(skillnad(fore, efter)).toEqual({ issues: 1, events: 1 });
    expect(andradeTabeller(fore, efter)).toEqual(['events', 'issues']);
  });

  it('F3 (AK 4): app-rollen får 42501 på UPDATE, DELETE och TRUNCATE av events, och raderna är oförändrade', async () => {
    const s0 = await handelsebild();
    const svar = await kor(app, agentnyckel, 'create_issue', { title: 'F3 ärende', team_key: 'LOC' });
    expect(svar.status).toBe(200);
    const s1 = await handelsebild();
    // Kontroll: ögonblicksbilden kan röra sig, så likheten nedan säger något.
    expect(s1).not.toEqual(s0);

    await expect(pool.query("UPDATE events SET verb = 'omskrivet'")).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('DELETE FROM events')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('TRUNCATE events')).rejects.toMatchObject({ code: '42501' });

    expect(await handelsebild()).toEqual(s1);
  });

  it('F4 (AK 4): ägaren får triggerns fel (P0001) på UPDATE, DELETE och TRUNCATE, och raderna är oförändrade', async () => {
    const s0 = await handelsebild();
    const svar = await kor(app, agentnyckel, 'create_issue', { title: 'F4 ärende', team_key: 'LOC' });
    expect(svar.status).toBe(200);
    const s1 = await handelsebild();
    expect(s1).not.toEqual(s0);

    // Radtriggern verkar bara på rader som satsen träffar, så UPDATE och DELETE riktas mot en
    // befintlig rad. Annars hade en sats som inte träffar något passerat utan fel.
    const id = s1[s1.length - 1]!['id'];
    const admin = await adminKlient();
    try {
      const satser: [string, unknown[]][] = [
        ["UPDATE events SET verb = 'omskrivet' WHERE id = $1", [id]],
        ['DELETE FROM events WHERE id = $1', [id]],
        ['TRUNCATE events', []],
      ];
      for (const [sats, params] of satser) {
        await expect(admin.query(sats, params), sats).rejects.toMatchObject({
          code: 'P0001',
          message: expect.stringMatching(/append-only/),
        });
      }
    } finally {
      await admin.end();
    }

    expect(await handelsebild()).toEqual(s1);
  });
});

describe('FR-4/AK 2: aktören tas ur nyckeln, aldrig ur indata', () => {
  let app: Express;
  let server: Server;
  let bas: string;
  let agentnyckel: string;
  let manniskonyckel: string;

  beforeAll(async () => {
    app = createApp();
    glomAllaSessioner();
    ({ server, bas } = await lyssna(app));
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'f6 agent' });
    manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'f7 människa' });
  });

  afterAll(async () => {
    await new Promise<void>((klar) => server.close(() => klar()));
  });

  it('F5 (AK 2): varje schema i registret, read och write, avvisar aktor_typ och aktor_namn', () => {
    expect(ACTIONS.length).toBeGreaterThan(0);
    const slapper = ACTIONS.filter((a) => !avvisarAktorsfalt(a.parse)).map((a) => a.name);
    expect(slapper, `scheman som inte avvisar aktörsfälten: ${slapper.join(', ')}`).toEqual([]);

    // Kontroll: ett schema utan .strict() tar bort okända nycklar tyst — mätningen fäller det.
    expect(avvisarAktorsfalt((x) => z.object({ title: z.string().optional() }).parse(x))).toBe(false);
  });

  it('F6 (AK 2): /api avvisar aktörsfälten med 400 och noll rader; utan dem bär raderna nyckelns aktör', async () => {
    const skapat = await kor(app, agentnyckel, 'create_issue', { title: 'F6 ärende', team_key: 'LOC' });
    expect(skapat.status).toBe(200);
    const identifier = skapat.body.result.identifier as string;

    const fall: { action: string; input: Record<string, unknown> }[] = [
      { action: 'create_issue', input: { title: 'F6 skapat', team_key: 'LOC' } },
      { action: 'add_comment', input: { identifier, body: 'F6 kommentar' } },
      { action: 'update_issue', input: { identifier, title: 'F6 rättad' } },
      { action: 'update_issue_state', input: { identifier, state_typ: 'started' } },
    ];
    for (const { action, input } of fall) {
      // (a) Med fälten: stoppat i parse, som körs innan någon transaktion öppnas.
      const fore = await raknaAllaTabeller();
      const avvisat = await kor(app, agentnyckel, action, {
        ...input,
        aktor_typ: 'manniska',
        aktor_namn: 'david',
      });
      expect(avvisat.status, action).toBe(400);
      expect(avvisat.body.error, action).toBe('validation_error');
      const meddelanden = ((avvisat.body.details ?? []) as { message: string }[]).map((d) => d.message);
      expect(
        meddelanden.some((m) => m.includes('aktor_typ')),
        `${action}: ${meddelanden.join(' | ')}`,
      ).toBe(true);
      expect(await raknaAllaTabeller(), action).toEqual(fore);

      // (b) Utan fälten: varje ny händelserad bär nyckelns aktör.
      const sedan = await storstaEventId();
      const godtaget = await kor(app, agentnyckel, action, input);
      expect(godtaget.status, action).toBe(200);
      const nya = await aktorerSedan(sedan);
      expect(nya.length, `${action}: ingen ny händelserad`).toBeGreaterThan(0);
      expect(nya, action).toEqual(nya.map(() => ({ aktor_typ: 'agent', aktor_namn: 'f6 agent' })));
      if (action === 'add_comment') {
        const k = await pool.query('SELECT aktor_typ, aktor_namn FROM comments WHERE id = $1', [
          godtaget.body.result.id,
        ]);
        expect(k.rows).toEqual([{ aktor_typ: 'agent', aktor_namn: 'f6 agent' }]);
      }
    }
  });

  it('F7 (AK 2): vyns kommentarsformulär med aktörsfält bär sessionens människoaktör', async () => {
    const skapat = await kor(app, agentnyckel, 'create_issue', { title: 'F7 ärende', team_key: 'LOC' });
    expect(skapat.status).toBe(200);
    const identifier = skapat.body.result.identifier as string;
    const webblasare = await inloggad(bas, manniskonyckel);

    const b = await baslinje();
    const svar = await webblasare
      .post(`/vy/arende/${identifier}/kommentar`)
      .type('form')
      .send({ body: 'F7 kommentar', aktor_typ: 'agent', aktor_namn: 'hermes' });
    expect(svar.status).toBe(303);
    expect(svar.headers['location']).toContain('notis=kommenterad');

    // Vyn bygger actionens indata ur namngivna fält, så de extra fälten når aldrig actionen.
    const kommentar = await pool.query('SELECT aktor_typ, aktor_namn FROM comments WHERE body = $1', [
      'F7 kommentar',
    ]);
    expect(kommentar.rows).toEqual([{ aktor_typ: 'manniska', aktor_namn: 'f7 människa' }]);
    const handelser = await pool.query(
      'SELECT verb, aktor_typ, aktor_namn FROM events WHERE id > $1 ORDER BY id',
      [b.eventId],
    );
    expect(handelser.rows).toEqual([{ verb: 'kommenterade', aktor_typ: 'manniska', aktor_namn: 'f7 människa' }]);

    const aktorer = await nyaAktorer(b);
    expect(aktorer.filter((a) => a.includes('hermes'))).toEqual([]);
    expect(aktorer).toEqual(['manniska·f7 människa']);
  });
});

describe('FR-4/AK 3: en write-action utan händelserad rullas tillbaka', () => {
  // Ingen egen beforeAll: tenanten finns ur migrationen, och provet anropar executeAction direkt.

  it('F8 (AK 3): en handler utan händelserad, körd genom executeAction, lämnar inget efter sig', async () => {
    const ordinarie = ACTIONS.find((a) => a.name === 'claim_next_issue')!.handler;
    const aktor: Aktor = { typ: 'agent', namn: 'f8' };
    const korClaim = () => executeAction({ aktor, actionName: 'claim_next_issue', input: {} });

    const fore = await raknaAllaTabeller();
    const utan: RegistreradAction['handler'] = async (ctx) => {
      await ctx.client.query('INSERT INTO labels (tenant_id, namn) VALUES ($1, $2)', [
        ctx.tenantId,
        'F8 utan händelse',
      ]);
      return null;
    };
    // Direkt och inte via /api: där blir felet ett innehållslöst 500, och först här syns att
    // rollbacken kom av proveniensregeln och inte av något annat fel.
    await expect(medUtbyttHandler('claim_next_issue', utan, korClaim)).rejects.toThrow(
      /proveniens är obligatorisk/,
    );
    expect(await finnsEtikett('F8 utan händelse')).toBe(false);
    expect(await raknaAllaTabeller()).toEqual(fore);

    // Kontroll: samma handler MED en händelserad committas, och raden bär aktören som skickades in.
    const med: RegistreradAction['handler'] = async (ctx) => {
      await ctx.client.query('INSERT INTO labels (tenant_id, namn) VALUES ($1, $2)', [
        ctx.tenantId,
        'F8 med händelse',
      ]);
      await ctx.skrivHandelse({ issueId: null, verb: 'provets_skrivning', payload: {} });
      return null;
    };
    const foreKontroll = await raknaAllaTabeller();
    const sedan = await storstaEventId();
    expect(await medUtbyttHandler('claim_next_issue', med, korClaim)).toEqual({
      status: 'ok',
      action: 'claim_next_issue',
      result: null,
    });
    expect(await finnsEtikett('F8 med händelse')).toBe(true);
    const efterKontroll = await raknaAllaTabeller();
    expect(skillnad(foreKontroll, efterKontroll)).toEqual({ labels: 1, events: 1 });
    expect(andradeTabeller(foreKontroll, efterKontroll)).toEqual(['events', 'labels']);
    const nya = await pool.query('SELECT verb, aktor_typ, aktor_namn FROM events WHERE id > $1', [sedan]);
    expect(nya.rows).toEqual([{ verb: 'provets_skrivning', aktor_typ: 'agent', aktor_namn: 'f8' }]);

    expect(ACTIONS.find((a) => a.name === 'claim_next_issue')!.handler).toBe(ordinarie);
  });

  it('F9 (AK 3): en handler anropas bara i def och executeAction, och getAction bara i executeAction', () => {
    const filer = kallfiler();
    expect(filer.map((f) => f.fil), 'granskningen läste inga källfiler').toContain('actions/execute.ts');

    const handlers = anropsstallen(filer, /\.handler\(/);
    expect(handlers, beskriv(handlers)).toEqual([
      { fil: 'actions/execute.ts', avsnitt: 'executeAction' },
      { fil: 'actions/registry.ts', avsnitt: 'def' },
    ]);
    // Handlern nås bara som direkt anrop av egenskapen: ingen referens som inte är ett anrop, ingen
    // hakparentesåtkomst och ingen destrukturering. Annars hade räkningen ovan inte sett varje väg.
    const omvagTillHandler = [
      ...anropsstallen(filer, /\.handler\b(?!\()/),
      ...anropsstallen(filer, /\[\s*['"`]handler['"`]\s*\]/),
      ...anropsstallen(filer, /\{[^{}]*\bhandler\b[^{}]*\}\s*=(?![=>])/),
    ];
    expect(omvagTillHandler, beskriv(omvagTillHandler)).toEqual([]);

    // Definitionen av getAction i registry.ts är en definitionsrad och räknas inte.
    const uppslag = anropsstallen(filer, /\bgetAction\(/);
    expect(uppslag, beskriv(uppslag)).toEqual([{ fil: 'actions/execute.ts', avsnitt: 'executeAction' }]);
    // getAction binds bara av executeAction, utan alias och bara som direkt anrop.
    expect(filerSomBinder(filer, 'actions/registry', 'getAction')).toEqual(['actions/execute.ts']);
    expect(omvagar(filer, 'actions/registry', 'getAction')).toEqual([]);

    // Kontroll: räkningen ser ett påhittat anrop, men inte kommentarsraden under det.
    const pahittad = {
      fil: 'http/prov.ts',
      text: 'export function prov() {\n  action.handler(ctx, input);\n  // action.handler(ctx, input);\n}\n',
    };
    expect(anropsstallen([pahittad], /\.handler\(/)).toEqual([{ fil: 'http/prov.ts', avsnitt: 'prov' }]);
    // Kontroll: omvägarna till handlern syns.
    const omvag = {
      fil: 'http/prov.ts',
      text: "const h = action.handler;\nconst k = action['handler'];\nconst { handler } = action;\n",
    };
    expect([
      anropsstallen([omvag], /\.handler\b(?!\()/).length,
      anropsstallen([omvag], /\[\s*['"`]handler['"`]\s*\]/).length,
      anropsstallen([omvag], /\{[^{}]*\bhandler\b[^{}]*\}\s*=(?![=>])/).length,
    ]).toEqual([1, 1, 1]);
  });
});

describe('FR-4/AK 6: ingen SQL-skrivning i transportlagret', () => {
  it('F10 (AK 6): ingen fil under src/http/ innehåller någon av de fyra skrivsatserna', () => {
    const filer = kallfiler('http');
    // Belägg för att granskningen läste något: en tom fillista hade gett noll träffar.
    expect(filer.map((f) => f.fil)).toEqual(
      expect.arrayContaining(['http/app.ts', 'http/routes/vy.ts', 'http/vy/skrivning.ts']),
    );
    const avvikelser = filer.flatMap(({ fil, text }) => skrivsatser(text).map((m) => `${fil} · ${m}`));
    expect(avvikelser, `skrivsatser i transportlagret: ${avvikelser.join('; ')}`).toEqual([]);
  });

  it('F11 (AK 6, kontroll): granskningen fäller påhittade källtexter med vart och ett av mönstren', () => {
    const texter = [
      'client.query("insert into labels (namn) values (\'x\')")',
      'await client.query(`UPDATE issues\n   SET title = $1`)',
      "await client.query('DELETE FROM comments')",
      "await client.query('truncate events')",
    ];
    texter.forEach((text, i) => {
      expect(skrivsatser(text), text).toEqual([String(SKRIVSATSER[i])]);
    });
    expect(skrivsatser("const t = 'Uppdatera ärendet';")).toEqual([]);
  });

  it('F15 (AK 6): README:s rad som börjar med | FR-4 | pekar på proven för AK 5 och AK 6', () => {
    const rader = readFileSync(path.join(ROT, 'README.md'), 'utf8')
      .split('\n')
      .filter((r) => r.startsWith('| FR-4 |'));
    expect(rader.length, 'README saknar en rad som börjar med | FR-4 |').toBeGreaterThan(0);
    expect(
      rader.some((r) => r.includes('test/skrivvagar.test.ts') && r.includes('AK 5') && r.includes('AK 6')),
      rader.join('\n'),
    ).toBe(true);
  });
});

describe('FR-4/AK 5: varje rad som skrivs via /api och vyn bär en nyckels aktör', () => {
  const A: Aktor = { typ: 'agent', namn: 'f12 agent' };
  const M: Aktor = { typ: 'manniska', namn: 'f12 människa' };
  const V: Aktor = { typ: 'manniska', namn: 'f12 vy' };

  let app: Express;
  let server: Server;
  let bas: string;
  let nyckelA: string;
  let nyckelM: string;
  let nyckelV: string;
  let idX: string;
  let idY: string;

  beforeAll(async () => {
    app = createApp();
    glomAllaSessioner();
    ({ server, bas } = await lyssna(app));
    await seedaTeam();
    // nyNyckel skriver bara api_keys — inget här skriver i events eller comments.
    nyckelA = await nyNyckel(A);
    nyckelM = await nyNyckel(M);
    nyckelV = await nyNyckel(V);
    await nyNyckel({ typ: 'agent', namn: 'f12 återkallas via api' });
    await nyNyckel({ typ: 'agent', namn: 'f12 återkallas via vyn' });
    idX = await nyckelId('f12 återkallas via api');
    idY = await nyckelId('f12 återkallas via vyn');
    await pool.query("INSERT INTO projects (tenant_id, namn) VALUES ($1, 'F12 projekt')", [TENANT_ID]);
  });

  afterAll(async () => {
    await new Promise<void>((klar) => server.close(() => klar()));
  });

  it('F12 (AK 5 och AK 2): 17 anrop via /api och vyns nio skrivrutter — varje ny rad bär anropets aktör', async () => {
    const b = await baslinje();

    /**
     * Ett steg i scenariot: rätt status, minst en ny händelserad, varje ny rad sedan förra steget
     * bär stegets aktör, och — där steget skapar en kommentar — kommentaren likaså.
     */
    const steg = async (
      namn: string,
      aktor: Aktor,
      status: number,
      korning: () => PromiseLike<Svar>,
      kommentarId?: (svar: Svar) => Promise<string>,
    ): Promise<Svar> => {
      const sedan = await storstaEventId();
      const svar = await korning();
      expect(svar.status, `${namn}: ${svar.text.slice(0, 300)}`).toBe(status);
      const nya = await aktorerSedan(sedan);
      expect(nya.length, `${namn}: ingen ny händelserad`).toBeGreaterThan(0);
      expect(nya, namn).toEqual(nya.map(() => ({ aktor_typ: aktor.typ, aktor_namn: aktor.namn })));
      if (kommentarId) {
        const k = await pool.query('SELECT aktor_typ, aktor_namn FROM comments WHERE id = $1', [
          await kommentarId(svar),
        ]);
        expect(k.rows, namn).toEqual([{ aktor_typ: aktor.typ, aktor_namn: aktor.namn }]);
      }
      return svar;
    };
    const api = (nyckel: string, action: string, input: unknown) => () => kor(app, nyckel, action, input);
    const ur = async (svar: Svar): Promise<string> => svar.body.result.id as string;

    // ---- /api, med A och M ----
    const skapat1 = await steg('a1', A, 200, api(nyckelA, 'create_issue', { title: 'F12 ärende 1', team_key: 'LOC' }));
    const arende1 = skapat1.body.result.identifier as string;
    const skapat2 = await steg('a2', A, 200, api(nyckelA, 'create_issue', { title: 'F12 ärende 2', team_key: 'LOC' }));
    const arende2 = skapat2.body.result.identifier as string;
    const k3 = await ur(
      await steg('a3', M, 200, api(nyckelM, 'add_comment', { identifier: arende1, body: 'F12 människa' }), ur),
    );
    const k4 = await ur(
      await steg('a4', A, 200, api(nyckelA, 'add_comment', { identifier: arende1, body: 'F12 agent' }), ur),
    );
    await steg('a5', M, 200, api(nyckelM, 'update_issue', { identifier: arende1, title: 'F12 ärende 1 rättad' }));
    await steg('a6', A, 200, api(nyckelA, 'update_issue_state', { identifier: arende1, state_typ: 'started' }));
    await steg('a7', M, 200, api(nyckelM, 'update_comment', { kommentar_id: k3, body: 'F12 människa rättad' }));
    await steg('a8', M, 200, api(nyckelM, 'delete_comment', { kommentar_id: k4 }));
    await steg('a9', M, 200, api(nyckelM, 'restore_comment', { kommentar_id: k4 }));
    await steg('a10', A, 200, api(nyckelA, 'add_label', { identifier: arende1, label: 'f12-etikett' }));
    await steg('a11', A, 200, api(nyckelA, 'remove_label', { identifier: arende1, label: 'f12-etikett' }));
    await steg('a12', M, 200, api(nyckelM, 'rename_label', { fran: 'f12-etikett', till: 'f12-etikett-ny' }));
    await steg('a13', A, 200, api(nyckelA, 'link_issues', { fran: arende1, till: arende2, typ: 'related' }));
    await steg(
      'a14',
      A,
      200,
      api(nyckelA, 'add_attachment', { identifier: arende1, titel: 'F12 bilaga', url: 'https://example.com/f12' }),
    );
    await steg('a15', A, 200, api(nyckelA, 'claim_next_issue', {}));
    await steg('a16', M, 200, api(nyckelM, 'revoke_api_key', { nyckel_id: idX }));
    await steg('a17', A, 200, api(nyckelA, 'add_label', { identifier: arende1, label: 'f12-vy-etikett' }));

    // ---- Vyn, inloggad med V ----
    // Inloggningen skriver inget i databasen. Varje vysteg skickar dessutom aktörsfälten, så att
    // AK 2:s vyled prövas på alla nio skrivrutter: raderna ska ändå bära sessionens aktör.
    const webblasare = await inloggad(bas, nyckelV);
    // 303 ensamt bevisar inget: också "oförändrat" omdirigerar. Notisen säger att skrivningen gick igenom.
    const vy = (vag: string, falt: Record<string, string>, notis: string) => async (): Promise<Svar> => {
      const svar = await webblasare
        .post(vag)
        .type('form')
        .send({ ...falt, aktor_typ: 'agent', aktor_namn: 'hermes' });
      expect(svar.headers['location'], `${vag}: ${svar.status}`).toContain(`notis=${notis}`);
      return svar;
    };
    const arendesida = `/vy/arende/${arende1}`;
    const vyKommentar = async (): Promise<string> => {
      const { rows } = await pool.query<{ id: string }>('SELECT id FROM comments WHERE body = $1', ['F12 vy']);
      expect(rows).toHaveLength(1);
      return rows[0]!.id;
    };

    await steg('v1', V, 303, vy(`${arendesida}/kommentar`, { body: 'F12 vy' }, 'kommenterad'), vyKommentar);
    const k1v = await vyKommentar();
    await steg(
      'v2',
      V,
      303,
      vy(`${arendesida}/ratta`, { titel: 'F12 ärende 1 från vyn', beskrivning: 'F12 beskrivning' }, 'arendet_rattat'),
    );
    await steg('v3', V, 303, vy(`/vy/kommentar/${k1v}/ratta`, { body: 'F12 vy rättad', fran: arendesida }, 'rattad'));
    await steg('v4', V, 303, vy(`/vy/kommentar/${k1v}/tabort`, { fran: arendesida }, 'borttagen'));
    await steg('v5', V, 303, vy(`/vy/kommentar/${k1v}/aterstall`, { fran: arendesida }, 'aterstalld'));
    await steg('v6', V, 303, vy(`${arendesida}/etikett/tabort`, { etikett: 'f12-vy-etikett' }, 'etikett_borttagen'));
    await steg('v7', V, 303, vy('/vy/namn/projekt', { fran: 'F12 projekt', till: 'F12 projekt rättat' }, 'namn_andrat'));
    await steg('v8', V, 303, vy('/vy/namn/etikett', { fran: 'f12-etikett-ny', till: 'f12-etikett-vy' }, 'namn_andrat'));
    await steg('v9', V, 303, vy(`/vy/nyckel/${idY}/aterkalla`, {}, 'nyckel_aterkallad'));

    // Invarianten: ingen rad i scenariot bär en aktör utanför api_keys, och aktörerna är exakt de
    // tre nycklarnas — 'hermes' ur formulärfälten finns inte bland dem.
    expect(await ogiltigaAktorer(b)).toEqual([]);
    expect(await nyaAktorer(b)).toEqual(['agent·f12 agent', 'manniska·f12 människa', 'manniska·f12 vy'].sort());
  });

  it('F13 (AK 5, kontroll): rader som ägaren skriver med aktörer utanför api_keys fäller kontrollfrågan', async () => {
    const skapat = await kor(app, nyckelA, 'create_issue', { title: 'F13 negativ kontroll', team_key: 'LOC' });
    expect(skapat.status).toBe(200);
    const issueId = skapat.body.result.id as string;
    const b = await baslinje();

    let eventId: string;
    let kommentarId: string;
    const admin = await adminKlient();
    try {
      const e = await admin.query<{ id: string }>(
        `INSERT INTO events (tenant_id, issue_id, aktor_typ, aktor_namn, verb)
         VALUES ($1, $2, 'system', 'f13 påhittad', 'f13_prov') RETURNING id`,
        [TENANT_ID, issueId],
      );
      const c = await admin.query<{ id: string }>(
        `INSERT INTO comments (tenant_id, issue_id, body, aktor_typ, aktor_namn)
         VALUES ($1, $2, 'F13', 'manniska', 'f13 utan nyckel') RETURNING id`,
        [TENANT_ID, issueId],
      );
      eventId = String(e.rows[0]!.id);
      kommentarId = String(c.rows[0]!.id);
    } finally {
      await admin.end();
    }

    // Samma fråga som gav [] i F12 ger nu exakt de två raderna.
    expect(await ogiltigaAktorer(b)).toEqual([
      { tabell: 'comments', id: kommentarId },
      { tabell: 'events', id: eventId },
    ]);
  });

  it('F14 (AK 5): anropsställena och skrivställena för events och comments är en sluten lista', () => {
    const alla = kallfiler();
    const http = kallfiler('http');
    const filerFor = (stallen: { fil: string }[]): string[] => stallen.map((s) => s.fil);
    const texten = (fil: string): string => alla.find((f) => f.fil === fil)!.text;

    // (1) Från transportlagret når en aktör executeAction på exakt två ställen ...
    const transport = anropsstallen(http, /\bexecuteAction\(/);
    expect(transport, beskriv(transport)).toEqual([
      { fil: 'http/routes/actions.ts', avsnitt: '(filhuvud)' },
      { fil: 'http/vy/skrivning.ts', avsnitt: 'kor' },
    ]);
    // ... och på båda bär anropet nyckelns aktör: kravAktor(req) på /api, och i vyn skrivruttens
    // aktör ur kravSessionsAktor(req), förd genom varje kor()-anrop.
    expect(apiaktorFel(texten('http/routes/actions.ts'))).toEqual([]);
    expect(vyvagensFel(texten('http/vy/skrivning.ts'))).toEqual([]);

    // Utanför transportlagret bara återläsningen (Story 1.4:s).
    const overallt = anropsstallen(alla, /\bexecuteAction\(/);
    expect(filerFor(overallt), beskriv(overallt)).toEqual([
      'http/routes/actions.ts',
      'http/vy/skrivning.ts',
      'import/aterlasLinear.ts',
    ]);
    // executeAction binds bara i de filerna, utan alias och bara som direkt anrop: då ser räkningen
    // ovan varje väg dit.
    expect(filerSomBinder(alla, 'actions/execute', 'executeAction')).toEqual([
      'http/routes/actions.ts',
      'http/vy/skrivning.ts',
      'import/aterlasLinear.ts',
    ]);
    expect(omvagar(alla, 'actions/execute', 'executeAction')).toEqual([]);

    // En nyckelsession föds på exakt ett ställe: POST /vy/logga-in, ur slaUppAktor.
    const sessioner = anropsstallen(alla, /\bstartaSession\(/);
    expect(filerFor(sessioner), beskriv(sessioner)).toEqual(['http/vy/skrivning.ts']);
    expect(filerSomBinder(alla, 'http/vy/session', 'startaSession')).toEqual(['http/vy/skrivning.ts']);
    expect(omvagar(alla, 'http/vy/session', 'startaSession')).toEqual([]);

    // (2) events skrivs bara av skrivHandelse, och den binds bara i de här filerna, i vilken
    // importform som helst. Registret når tjänsten bara genom ctx.skrivHandelse, så det är filerna
    // och inte anropen som är den slutna listan.
    expect(filerSomBinder(alla, 'services/handelser', 'skrivHandelse')).toEqual([
      'actions/execute.ts',
      'import/importeraArkiv.ts',
      'scripts/skapaNyckel.ts',
    ]);

    // comments skrivs bara av laggTillKommentar, och den anropas bara här.
    const kommentatorer = anropsstallen(alla, /\blaggTillKommentar\(/);
    expect(filerFor(kommentatorer), beskriv(kommentatorer)).toEqual([
      'actions/registry.ts',
      'import/importeraArkiv.ts',
    ]);
    expect(filerSomBinder(alla, 'services/kommentarer', 'laggTillKommentar')).toEqual([
      'actions/registry.ts',
      'import/importeraArkiv.ts',
    ]);
    expect(omvagar(alla, 'services/kommentarer', 'laggTillKommentar')).toEqual([]);

    // De enda INSERT-satserna mot de två tabellerna, skiftlägesokänsligt, över radbrytningar och
    // också med schema eller citattecken (public.events, "events").
    expect(traffar(alla, /\bINSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?events\b/)).toEqual({
      'services/handelser.ts': 1,
    });
    expect(traffar(alla, /\bINSERT\s+INTO\s+(?:"?public"?\s*\.\s*)?"?comments\b/)).toEqual({
      'services/kommentarer.ts': 1,
    });

    // ---- Kontroller: varje form provet säger sig läsa fäller en påhittad källtext ----

    // Anropen räknas också på en definitionsrad, efter en blockkommentar och inne i en mallsträng,
    // men inte i en kommentar; '/*' och '//' i strängar och citattecken i ett regex tas inte fel.
    const anropIText = (text: string): number =>
      anropsstallen([{ fil: 'http/prov.ts', text }], /\bexecuteAction\(/).length;
    expect(
      [
        'export async function prov() {\n  await executeAction(a);\n  await executeAction(b);\n}\n',
        'export function prov() { return executeAction(a); }\n',
        '/* förklaring */ await executeAction(a);\n',
        "const m = '/*'; await executeAction(a); const n = '*/';\n",
        "const u = 'https://x'; await executeAction(a); // executeAction(b)\n",
        'const t = `/* ${await executeAction(a)} */`;\n',
        "const r = /'/; await executeAction(a); const s = \"'\";\n",
        '// executeAction(a)\n/* executeAction(b) */\n/**\n * executeAction(c)\n */\n',
      ].map(anropIText),
    ).toEqual([2, 1, 1, 1, 1, 1, 1, 0]);

    // Varje importform binder modulen; en import av ett annat namn och en bortkommenterad gör det inte.
    const importformer = [
      { fil: 'http/hel.ts', text: "import * as h from '../services/handelser.js';\n" },
      { fil: 'http/alias.ts', text: "import {\n  listaHandelser,\n  skrivHandelse as s,\n} from '../services/handelser.js';\n" },
      { fil: 'services/samlad.ts', text: "export * from './handelser.js';\n" },
      { fil: 'services/vidare.ts', text: "export { skrivHandelse } from './handelser.js';\n" },
      { fil: 'http/dynamisk.ts', text: "const h = await import('../services/handelser.js');\n" },
      { fil: 'http/efterkommentar.ts', text: "/* x */ import { skrivHandelse } from '../services/handelser.js';\n" },
      {
        fil: 'http/lasning.ts',
        text: "import { listaHandelser } from '../services/handelser.js';\n// import { skrivHandelse } from '../services/handelser.js';\n",
      },
    ];
    expect(filerSomBinder(importformer, 'services/handelser', 'skrivHandelse')).toEqual([
      'http/alias.ts',
      'http/dynamisk.ts',
      'http/efterkommentar.ts',
      'http/hel.ts',
      'services/samlad.ts',
      'services/vidare.ts',
    ]);

    // I en fil som binder executeAction fäller ett alias, hela modulen och en referens som inte är
    // ett anrop; den raka importen med ett direkt anrop gör det inte.
    const iActions = (text: string) => omvagar([{ fil: 'http/routes/actions.ts', text }], 'actions/execute', 'executeAction');
    const imp = "import { executeAction } from '../../actions/execute.js';\n";
    expect(
      [
        "import { executeAction as x } from '../../actions/execute.js';\nawait x({});\n",
        "import * as e from '../../actions/execute.js';\nawait e.executeAction({});\n",
        `${imp}const f = executeAction;\nawait f({});\n`,
        `${imp}await executeAction({});\n`,
      ].map((text) => iActions(text).length > 0),
    ).toEqual([true, true, true, false]);

    // /api: en aktör som inte är kravAktor(req), en egen kravAktor eller en från fel modul fäller.
    const actionsTs = texten('http/routes/actions.ts');
    const apiVarianter: Record<string, string> = {
      'aktören ur kroppen': actionsTs.replace(
        'aktor: kravAktor(req),',
        "aktor: { typ: 'manniska', namn: String(req.body.namn) },",
      ),
      'ett anrop till': `${actionsTs}\nactionsRouter.post('/x', async () => { await executeAction({ aktor: { typ: 'agent', namn: 'x' }, actionName: 'x', input: {} }); });\n`,
      'egen kravAktor': `${actionsTs}\nconst kravAktor = (req: unknown) => ({ typ: 'manniska', namn: String(req) });\n`,
      'kravAktor ur fel modul': actionsTs.replace("from '../middleware/autentisera.js'", "from './egen.js'"),
    };
    const apiSlapps = Object.entries(apiVarianter)
      .filter(([, text]) => apiaktorFel(text).length === 0)
      .map(([namn]) => namn);
    expect(apiSlapps, `släpps igenom på /api: ${apiSlapps.join(', ')}`).toEqual([]);

    // Vyn: den riktiga skrivning.ts plus en avvikelse i taget. Varje avvikelse fäller vyvägen.
    const skrivningTs = texten('http/vy/skrivning.ts');
    const sist = skrivningTs.lastIndexOf('}');
    const iRutterna = (kod: string): string => `${skrivningTs.slice(0, sist)}${kod}\n${skrivningTs.slice(sist)}`;
    const vyVarianter: Record<string, string> = {
      'aktören ur formuläret': iRutterna(
        "  router.post('/prov', skrivrutt(async (req, res, aktor) => { await kor({ typ: 'manniska', namn: String(kroppen(req)['namn']) }, 'add_comment', {}); res.end(); }));",
      ),
      'egen aktor i hanteraren': iRutterna(
        "  router.post('/prov', skrivrutt(async (req, res) => { const aktor = { typ: 'manniska' as const, namn: 'prov' }; await kor(aktor, 'add_comment', {}); res.end(); }));",
      ),
      'aktor tilldelas om': iRutterna(
        "  router.post('/prov', skrivrutt(async (req, res, aktor) => { aktor = { typ: 'agent', namn: 'prov' }; await kor(aktor, 'add_comment', {}); res.end(); }));",
      ),
      'hjälpare med egen parameter': iRutterna("  const hjalp = (aktor: Aktor) => kor(aktor, 'add_comment', {});"),
      'kor som värde': iRutterna('  const omvag = kor;'),
      'anrop efter blockkommentar': iRutterna(
        "  router.post('/prov', skrivrutt(async (req, res, aktor) => {\n/* prov */ await kor({ typ: 'agent', namn: 'prov' }, 'add_comment', {});\n  }));",
      ),
      'kor utanför rutterna': `${skrivningTs}\nexport async function utanfor(aktor: Aktor): Promise<void> {\n  await kor(aktor, 'add_comment', {});\n}\n`,
      'skrivrutt utan sessionen': skrivningTs.replace(
        'const aktor = kravSessionsAktor(req);',
        "const aktor = { typ: 'manniska' as const, namn: 'prov' };",
      ),
      'hanteraren utan sessionens aktör': skrivningTs.replace(
        'await hanterare(req, res, aktor);',
        "await hanterare(req, res, { typ: 'manniska', namn: 'prov' });",
      ),
      'kor för vidare en annan aktör': skrivningTs.replace(
        'executeAction({ aktor, actionName, input })',
        "executeAction({ aktor: { typ: 'manniska', namn: String(input) }, actionName, input })",
      ),
      'egen kravSessionsAktor': `${skrivningTs}\nfunction kravSessionsAktor(): Aktor {\n  return { typ: 'manniska', namn: 'prov' };\n}\n`,
    };
    // Belägg för att varje variant verkligen ändrade texten.
    expect(Object.values(vyVarianter).filter((v) => v === skrivningTs)).toEqual([]);
    const vySlapps = Object.entries(vyVarianter)
      .filter(([, text]) => vyvagensFel(text).length === 0)
      .map(([namn]) => namn);
    expect(vySlapps, `släpps igenom i vyn: ${vySlapps.join(', ')}`).toEqual([]);
  });
});

describe('FR-4/Story 1.4 AK 2: listan är dokumenterad i README', () => {
  it('F23 (Story 1.4, AK 2): README:s FR-4-avsnitt bär de fyra undantagen, beslutet, regeln och pekar på AK 3', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect(readmeFel(readme)).toEqual([]);

    // Kontroll i samma it: varje led i mätningen slår ut på en variant av den riktiga texten.
    const stycke = /\*\*Skrivvägarna förbi nyckelhärledningen[\s\S]*?\n\n/.exec(readme)?.[0] ?? '';
    expect(stycke, 'stycket om den slutna listan').not.toBe('');
    const varianter: Record<string, string> = {
      'FR-4-raden utan AK 3': readme.replace('; Story 1.4 AK 3: invarianten', '; invarianten'),
      'återläsningens rad borta': readme.replace(/^\| FR-4, undantag: återläsningen.*\n/m, ''),
      'importens aktör ändrad': readme.replace('fast aktör `system · linear-import`', 'fast aktör `system · linear-import-2`'),
      'migrationsraden utan "aldrig"': readme.replace(
        /^(\| FR-4, undantag: migrationerna.*?)aldrig rader i `events` eller `comments`/m,
        '$1',
      ),
      'regelstycket i ett annat avsnitt': `${readme.replace(stycke, '')}\n### Ett annat avsnitt\n\n${stycke}`,
    };
    expect(Object.entries(varianter).filter(([, v]) => v === readme).map(([namn]) => namn), 'oförändrade varianter').toEqual([]);
    const slapps = Object.entries(varianter)
      .filter(([, v]) => readmeFel(v).length === 0)
      .map(([namn]) => namn);
    expect(slapps, `släpps igenom: ${slapps.join(', ')}`).toEqual([]);
  });
});
