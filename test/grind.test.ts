// FR-40, FR-20, B-17 (Story 7.3): grinden kan inte bli grön utan prov och aldrig mot driftdatabasen.
// Fallistorna: G1 de tre skripten i package.json och fyra kontroller (AK 1); G2 konfigurationens fyra fält
// och fem kontroller, G3 en vitest-körning utan provfiler med kontrollen --passWithNoTests (AK 2); G4 vakten
// testdatabasfel() i 25 poster, G5 globalSetup i sju barnprocesser genom test/env.ts, där varje vägrad
// körning har en kontroll som bara skiljer sig i det prövade värdet, G6 standardvärdena och `=` i
// applyTestEnv(), G7 vaktens konstanter mot sina källor (AK 3).
//
// Provet når bara testklustret. Barnprocessen i G3 hittar inga provfiler, och G5:s barnprocesser pekar på
// porten 1 på loopback, där ingenting lyssnar, eller på värden grind.invalid, som aldrig löses upp. Porten
// 5435 når därför aldrig något kluster, inte ens om vakten skulle saknas.
// Provfilerna exporterar inga hjälpare, så barnprocessernas mönster skrivs om här, efter test/config.test.ts
// (rad 30–72).
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import pg from 'pg';
import { applyTestEnv, TEST_DB_NAME, TEST_TEMPLATE_DB_NAME } from './env.js';

const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));

/** En kopia av objektet utan nyckeln, så att en kontroll ändrar en enda sak. */
function utan<T>(objekt: Record<string, T>, nyckel: string): Record<string, T> {
  const kopia = { ...objekt };
  delete kopia[nyckel];
  return kopia;
}

// ---- AK 1: ett kommando i rätt ordning -------------------------------------------------------------

/**
 * Grindens tre skript och deras värden, i den ordning `skriptfel()` prövar dem (FR-40): `check` kör sviten
 * bara när `tsc` avslutat med 0, och `test` är en körning som avslutar, inte bevakningsläget.
 */
const SKRIPTEN: readonly (readonly [string, string])[] = [
  ['check', 'npm run build && npm test'],
  ['build', 'tsc'],
  ['test', 'vitest run'],
];

/**
 * Fynden för AK 1, i SKRIPTENs ordning: `<namn> saknas` när värdet inte är en sträng, annars
 * `<namn> är "<värde>", inte "<väntat>"` när det skiljer sig. Jämförelsen är exakt, så ingen annan form går
 * igenom; inga andra skript prövas.
 */
function skriptfel(skript: Record<string, unknown>): string[] {
  const fel: string[] = [];
  for (const [namn, vantat] of SKRIPTEN) {
    const varde = skript[namn];
    if (typeof varde !== 'string') fel.push(`${namn} saknas`);
    else if (varde !== vantat) fel.push(`${namn} är "${varde}", inte "${vantat}"`);
  }
  return fel;
}

describe('FR-40/Story 7.3 AK 1: ett kommando i rätt ordning', () => {
  it('G1 (R, AK 1): check är build och sedan test, build är tsc och test är vitest run', () => {
    const paket = JSON.parse(readFileSync(path.join(ROT, 'package.json'), 'utf8')) as {
      scripts: Record<string, unknown>;
    };
    const skript = paket.scripts;
    // (a) repots skript
    expect(skriptfel(skript)).toEqual([]);
    // (b) kontroll: omvänd ordning, som kör sviten före tsc
    expect(skriptfel({ ...skript, check: 'npm test && npm run build' })).toEqual([
      'check är "npm test && npm run build", inte "npm run build && npm test"',
    ]);
    // (c) kontroll: semikolon, som kör sviten också efter ett tsc-fel
    expect(skriptfel({ ...skript, check: 'npm run build; npm test' })).toEqual([
      'check är "npm run build; npm test", inte "npm run build && npm test"',
    ]);
    // (d) kontroll: bevakningsläget, som aldrig avslutar
    expect(skriptfel({ ...skript, test: 'vitest' })).toEqual(['test är "vitest", inte "vitest run"']);
    // (e) kontroll: utan build
    expect(skriptfel(utan(skript, 'build'))).toEqual(['build saknas']);
  });
});

// ---- AK 2: noll prov är inte grönt -----------------------------------------------------------------

/**
 * Fynden för AK 2, i ordning: `passWithNoTests` med strikt likhet mot false, så att ett saknat fält fälls
 * lika som true (B-17: garantin står i repot, inte i vitests standardvärde); sedan de tre fält som bär
 * svitens isolering och som vakten i test/globalSetup.ts förutsätter.
 */
function konfigfel(test: Record<string, unknown>): string[] {
  const fel: string[] = [];
  if (test['passWithNoTests'] !== false) fel.push('passWithNoTests är inte uttryckligen false');
  if (test['globalSetup'] !== './test/globalSetup.ts') fel.push('globalSetup är inte ./test/globalSetup.ts');
  const setupFiles = test['setupFiles'];
  if (!Array.isArray(setupFiles) || !setupFiles.includes('./test/setup.ts')) {
    fel.push('setupFiles saknar ./test/setup.ts');
  }
  if (test['fileParallelism'] !== false) fel.push('fileParallelism är inte false');
  return fel;
}

/**
 * Barnprocessens miljö: en kopia av provets miljö utan varje nyckel som börjar med VITEST, eftersom provets
 * egen vitest sätter dem och en ny vitest ska starta som från `npm test`; DOTENV_CONFIG_PATH pekar på en fil
 * som inte finns, så att ingen .env kan rikta barnprocessen mot en annan databas (samma skydd som
 * test/config.test.ts rad 30–43); sist ändringarna.
 */
function barnmiljo(andringar: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [nyckel, varde] of Object.entries(process.env)) {
    if (!nyckel.startsWith('VITEST')) env[nyckel] = varde;
  }
  return { ...env, DOTENV_CONFIG_PATH: path.join(tmpdir(), 'grind-prov-finns-inte.env'), ...andringar };
}

interface Vitestutfall {
  kod: number | null;
  utskrift: string;
}

/**
 * Kör repots vitest med repots konfiguration under repots rot och kastar aldrig: `kod` är 0 när processen
 * lyckas, annars dess exitkod, och null för en process som dödats; `utskrift` är stdout följt av stderr.
 * Tidsgränsen och SIGKILL fäller en körning som hänger (som korBarnprocess() i test/config.test.ts rad 56–72).
 */
async function korVitest(argument: string[], env: NodeJS.ProcessEnv): Promise<Vitestutfall> {
  try {
    const { stdout, stderr } = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'vitest'),
      ['run', '--config', path.join(ROT, 'vitest.config.ts'), ...argument],
      { cwd: ROT, env, timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 },
    );
    return { kod: 0, utskrift: stdout + stderr };
  } catch (err) {
    const fel: Record<string, unknown> = typeof err === 'object' && err !== null ? { ...err } : {};
    const stdout = typeof fel['stdout'] === 'string' ? fel['stdout'] : '';
    const stderr = typeof fel['stderr'] === 'string' ? fel['stderr'] : '';
    return { kod: typeof fel['code'] === 'number' ? fel['code'] : null, utskrift: stdout + stderr };
  }
}

/**
 * Tar bort databasen `namn` och dess mall i testklustret, med underhållsadressen som test/setup.ts satt.
 * Städar efter G3 för det fall att vitest skulle köra globalSetup också utan provfiler; G3 påstår inget om
 * det. `namn` är en kodkonstant i fallet, aldrig ett värde utifrån, eftersom det står oquotat i SQL-texten.
 */
async function taBortDatabaser(namn: string): Promise<void> {
  const underhall = new pg.Client({ connectionString: process.env.MAINTENANCE_DATABASE_URL });
  await underhall.connect();
  try {
    await underhall.query(`DROP DATABASE IF EXISTS ${namn} WITH (FORCE)`);
    await underhall.query(`DROP DATABASE IF EXISTS ${namn}_template WITH (FORCE)`);
  } finally {
    await underhall.end();
  }
}

/** Filtret i G3: inget filnamn i repot innehåller det, så körningen hittar noll provfiler var den än söker. */
const INGET_PROV = 'grind-inget-prov-heter-sa';
/** G3:s eget databasnamn, så att den pågående svitens databas aldrig rörs. */
const TOM_DATABAS = 'arenden_grind_tom_test';

describe('FR-20/Story 7.3 AK 2: noll prov är inte grönt', () => {
  it('G2 (AK 2): konfigurationen sätter passWithNoTests: false uttryckligen och bär svitens isolering', async () => {
    // Konfigurationen importeras, så att provet ser värdet som vitest själv får (defineConfig returnerar
    // objektet oförändrat); en textsökning hade också godtagit en kommentar.
    const { default: konfig } = await import('../vitest.config.js');
    const test: Record<string, unknown> = { ...konfig.test };
    // (a) repots konfiguration
    expect(konfigfel(test)).toEqual([]);
    // (b) kontroll: utan fältet, alltså vitests standardvärde
    expect(konfigfel(utan(test, 'passWithNoTests'))).toEqual(['passWithNoTests är inte uttryckligen false']);
    // (c) kontroll: passWithNoTests: true
    expect(konfigfel({ ...test, passWithNoTests: true })).toEqual(['passWithNoTests är inte uttryckligen false']);
    // (d) kontroll: utan globalSetup
    expect(konfigfel(utan(test, 'globalSetup'))).toEqual(['globalSetup är inte ./test/globalSetup.ts']);
    // (e) kontroll: setupFiles utan ./test/setup.ts
    expect(konfigfel({ ...test, setupFiles: [] })).toEqual(['setupFiles saknar ./test/setup.ts']);
    // (f) kontroll: fileParallelism: true
    expect(konfigfel({ ...test, fileParallelism: true })).toEqual(['fileParallelism är inte false']);
  });

  it('G3 (R, AK 2): en körning utan provfiler avslutar med 1, och bara --passWithNoTests gör den grön', async () => {
    const tom = mkdtempSync(path.join(tmpdir(), 'grind-tom-'));
    const miljon = barnmiljo({ TEST_DB_NAME: TOM_DATABAS });
    try {
      // (a) repots konfiguration: noll provfiler, exitkod 1
      const standard = await korVitest(['--dir', tom, INGET_PROV], miljon);
      expect(
        { kod: standard.kod, ingaFiler: standard.utskrift.includes('No test files found') },
        standard.utskrift,
      ).toEqual({ kod: 1, ingaFiler: true });
      // (b) kontroll: samma körning med flaggan ger 0, så det är inställningen som fäller
      const flaggan = await korVitest(['--dir', tom, INGET_PROV, '--passWithNoTests'], miljon);
      expect(
        { kod: flaggan.kod, ingaFiler: flaggan.utskrift.includes('No test files found') },
        flaggan.utskrift,
      ).toEqual({ kod: 0, ingaFiler: true });
    } finally {
      rmSync(tom, { recursive: true, force: true });
      await taBortDatabaser(TOM_DATABAS);
    }
  }, 120_000);
});

// ---- AK 3: sviten vägrar driftdatabasen ------------------------------------------------------------

/** Värden i adresserna i G4 och i G5:s barnprocesser mot porten 1: loopback, som i test/env.ts. */
const VARD = '127.0.0.1';
/**
 * Värden i G5:s barnprocesser som annars hade kunnat nå en port där ett kluster lyssnar: .invalid är en
 * reserverad toppdomän som aldrig löses upp, så ingen sådan körning når något kluster ens utan vakt.
 */
const OLOSLIG_VARD = 'grind.invalid';

type Adresserna = { MAINTENANCE_DATABASE_URL: string; DATABASE_ADMIN_URL: string; DATABASE_URL: string };

/**
 * De tre adresserna i samma form som applyTestEnv() bygger dem (test/env.ts rad 44–46). Porten sätts in
 * som text, som TEST_PG_PORT, så att en post kan pröva vad ett värde i variabeln gör med adresserna.
 */
function adresser(namn: string, port: number | string): Adresserna {
  return {
    MAINTENANCE_DATABASE_URL: `postgres://postgres@${VARD}:${port}/postgres`,
    DATABASE_ADMIN_URL: `postgres://postgres@${VARD}:${port}/${namn}`,
    DATABASE_URL: `postgres://app@${VARD}:${port}/${namn}`,
  };
}

/** Kontrollpostens adresser; varje post som byter en enda adress utgår från dem. */
const GODA = adresser('arenden_test', 5436);

/** Ett namn ur tillåtelselistan som slutar på _test och har exakt `langd` tecken (och byte). */
function namnMedLangd(langd: number): string {
  return 'arenden_' + 'x'.repeat(langd - 'arenden_'.length - '_test'.length) + '_test';
}

interface Vaktpost {
  databasnamn: string;
  miljo: Record<string, string | undefined>;
  fynd: string[];
}

/** Samma fynd för alla tre adresserna, i vaktens ordning. */
function treFynd(fyndet: string): string[] {
  return ['MAINTENANCE_DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_URL'].map((namn) => `${namn} ${fyndet}`);
}

const PORTFYNDEN = treFynd('pekar på porten 5435, driftdatabasens port');

/** Fyndet för ett namn som Postgres hade kortat, själv eller i mallens namn. */
function langdfynd(namn: string): string {
  return `TEST_DB_NAME "${namn}" är längre än 54 byte, och Postgres kortar då mallnamnet till 63 byte`;
}

/**
 * G4:s fallista. Post 1–11 är tabellen i Dev Notes → Avgränsade kriterier: nio fällda poster och två
 * kontroller. Post 5 och 6 bygger adresserna med arenden_test, eftersom de prövar namnet, och får därför också
 * fynden för de två adresser som pekar på en annan databas än namnet (sökvägsregeln). Post 12–21 prövar
 * adressen så som pg läser den, post 22–24 namn som Postgres kortar, och post 25 är kontrollen till dem.
 * Varje kontroll (10, 11, 25) skiljer sig från de fällda posterna den hör till bara i det prövade.
 */
const VAKTPOSTER: readonly Vaktpost[] = [
  {
    databasnamn: 'arenden',
    miljo: adresser('arenden', 5436),
    fynd: ['TEST_DB_NAME "arenden" slutar inte på _test'],
  },
  { databasnamn: 'arenden_test', miljo: adresser('arenden_test', 5435), fynd: PORTFYNDEN },
  {
    databasnamn: 'arenden',
    miljo: adresser('arenden', 5435),
    fynd: ['TEST_DB_NAME "arenden" slutar inte på _test', ...PORTFYNDEN],
  },
  {
    databasnamn: 'arenden_test_kopia',
    miljo: adresser('arenden_test_kopia', 5436),
    fynd: ['TEST_DB_NAME "arenden_test_kopia" slutar inte på _test'],
  },
  {
    databasnamn: 'arenden; DROP DATABASE arenden; --_test',
    miljo: GODA,
    fynd: [
      'TEST_DB_NAME "arenden; DROP DATABASE arenden; --_test" har andra tecken än gemener, siffror och understreck',
      'DATABASE_ADMIN_URL pekar på databasen "arenden_test", inte "arenden; DROP DATABASE arenden; --_test"',
      'DATABASE_URL pekar på databasen "arenden_test", inte "arenden; DROP DATABASE arenden; --_test"',
    ],
  },
  {
    databasnamn: 'Arenden_test',
    miljo: GODA,
    fynd: [
      'TEST_DB_NAME "Arenden_test" har andra tecken än gemener, siffror och understreck',
      'DATABASE_ADMIN_URL pekar på databasen "arenden_test", inte "Arenden_test"',
      'DATABASE_URL pekar på databasen "arenden_test", inte "Arenden_test"',
    ],
  },
  {
    databasnamn: 'arenden_test',
    miljo: { ...GODA, DATABASE_URL: 'inte en adress' },
    fynd: ['DATABASE_URL går inte att läsa som adress'],
  },
  {
    databasnamn: 'arenden_test',
    miljo: utan(GODA, 'MAINTENANCE_DATABASE_URL'),
    fynd: ['MAINTENANCE_DATABASE_URL saknas'],
  },
  {
    databasnamn: 'arenden_test',
    miljo: { ...GODA, DATABASE_ADMIN_URL: `postgres://postgres@${VARD}/arenden_test` },
    fynd: ['DATABASE_ADMIN_URL saknar port'],
  },
  { databasnamn: 'arenden_test', miljo: GODA, fynd: [] },
  { databasnamn: 'arenden_grind_tom_test', miljo: adresser('arenden_grind_tom_test', 5436), fynd: [] },
  {
    // 12: TEST_PG_PORT med en frågedel; pg tar porten ur frågedelen före adressens egen och databasen ur
    // sökvägen, så adresserna hade nått databasen arenden på driftens port
    databasnamn: 'arenden_test',
    miljo: adresser('arenden_test', '5436/arenden?port=5435#'),
    fynd: treFynd('har en frågedel eller ett fragment'),
  },
  {
    // 13: en frågedel som väljer värden, i en enda adress
    databasnamn: 'arenden_test',
    miljo: { ...GODA, DATABASE_URL: `${GODA.DATABASE_URL}?host=${OLOSLIG_VARD}` },
    fynd: ['DATABASE_URL har en frågedel eller ett fragment'],
  },
  {
    // 14: ett fragment
    databasnamn: 'arenden_test',
    miljo: { ...GODA, DATABASE_ADMIN_URL: `${GODA.DATABASE_ADMIN_URL}#x` },
    fynd: ['DATABASE_ADMIN_URL har en frågedel eller ett fragment'],
  },
  {
    // 15: migreringens adress mot en annan databas än den som globalSetup() skapar
    databasnamn: 'arenden_test',
    miljo: { ...GODA, DATABASE_ADMIN_URL: adresser('arenden', 5436).DATABASE_ADMIN_URL },
    fynd: ['DATABASE_ADMIN_URL pekar på databasen "arenden", inte "arenden_test"'],
  },
  {
    // 16: underhållsadressen mot testdatabasen i stället för underhållsdatabasen
    databasnamn: 'arenden_test',
    miljo: { ...GODA, MAINTENANCE_DATABASE_URL: GODA.DATABASE_ADMIN_URL },
    fynd: ['MAINTENANCE_DATABASE_URL pekar på databasen "arenden_test", inte "postgres"'],
  },
  {
    // 17: utan databas, så att pg tar den ur PGDATABASE
    databasnamn: 'arenden_test',
    miljo: { ...GODA, DATABASE_URL: GODA.DATABASE_URL.slice(0, -'/arenden_test'.length) },
    fynd: ['DATABASE_URL pekar på databasen "", inte "arenden_test"'],
  },
  {
    // 18: schemat socket:, där pg läser värden ur sökvägen och databasen ur frågedelen
    databasnamn: 'arenden_test',
    miljo: { ...GODA, DATABASE_URL: GODA.DATABASE_URL.replace(/^postgres:/, 'socket:') },
    fynd: ['DATABASE_URL är inte en postgres-adress i normalform'],
  },
  {
    // 19: ett inledande blanksteg, som URL-tolkningen tar bort men pg kodar innan den tolkar adressen
    databasnamn: 'arenden_test',
    miljo: { ...GODA, DATABASE_URL: ` ${GODA.DATABASE_URL}` },
    fynd: ['DATABASE_URL är inte en postgres-adress i normalform'],
  },
  {
    // 20: driftens port med en inledande nolla
    databasnamn: 'arenden_test',
    miljo: adresser('arenden_test', '05435'),
    fynd: PORTFYNDEN,
  },
  {
    // 21: tomt TEST_PG_PORT, som `??` i test/env.ts släpper igenom: ett kolon utan port, och pg tar PGPORT
    databasnamn: 'arenden_test',
    miljo: adresser('arenden_test', ''),
    fynd: treFynd('saknar port'),
  },
  // 22: ett byte för långt för mallens namn
  { databasnamn: namnMedLangd(55), miljo: adresser(namnMedLangd(55), 5436), fynd: [langdfynd(namnMedLangd(55))] },
  // 23: 63 byte, där mallens namn kortas till namnet självt och globalSetup() hade tagit bort den migrerade
  // databasen
  { databasnamn: namnMedLangd(63), miljo: adresser(namnMedLangd(63), 5436), fynd: [langdfynd(namnMedLangd(63))] },
  // 24: 70 byte, där namnet självt kortas och inte längre slutar på _test
  { databasnamn: namnMedLangd(70), miljo: adresser(namnMedLangd(70), 5436), fynd: [langdfynd(namnMedLangd(70))] },
  // 25: kontroll, 54 byte
  { databasnamn: namnMedLangd(54), miljo: adresser(namnMedLangd(54), 5436), fynd: [] },
];

/** Variablerna som applyTestEnv() sätter, en sluten lista (test/env.ts rad 37–53). */
const TESTMILJONS_VARIABLER = [
  'NODE_ENV', 'VAULT_PATH', 'CRM_KONF_PATH', 'VY_PUBLIK_URL', 'HOST', 'PORT', 'DATABASE_URL',
  'DATABASE_ADMIN_URL', 'MAINTENANCE_DATABASE_URL', 'RATE_LIMIT_PER_MINUTE', 'ARENDEN_API_URL', 'ARENDEN_API_KEY',
] as const;

/** Variablernas värden i process.env just nu, i listans ordning. */
function testmiljon(): Record<string, string | undefined> {
  return Object.fromEntries(TESTMILJONS_VARIABLER.map((namn) => [namn, process.env[namn]]));
}

/** Vaktens fel i utskriften, och globalSetup()s rad efter den första anslutningen. */
const VAGRAN = 'testsviten vägrar databasen';
const FARSK_DATABAS = '[globalSetup] färsk databas';
/** Uppslagsfelet för OLOSLIG_VARD: utan nät kan uppslaget också ge EAI_AGAIN. */
const UPPSLAGSFEL = /ENOTFOUND|EAI_AGAIN/;
/** G5:s namn som godtas, så att en vägrad körning med det bara kan vägras för det prövade värdet. */
const VAKTENS_NAMN = 'arenden_grind_vakt_test';

interface Vaktkorning {
  korning: string;
  andringar: Record<string, string>;
  finns: readonly (string | RegExp)[];
  saknas: readonly (string | RegExp)[];
}

/**
 * G5:s körningar. Varje värde går genom test/env.ts och applyTestEnv() till globalSetup() i en egen
 * vitest-process, inte genom provets kopia adresser(). En vägrad körning ska ha vaktens fel och orsaken, men
 * varken anslutnings- eller uppslagsfelet eller raden efter anslutningen: den stoppades före första
 * anslutningen. Kontrollerna (2 och 4) försöker ansluta, och varje vägrad körning skiljer sig från sin
 * kontroll i ett enda värde: körning 1 från 2 i namnet, körning 3, 5, 6 och 7 från 4 i porten eller namnet.
 */
const VAKTKORNINGAR: readonly Vaktkorning[] = [
  {
    korning: '1: TEST_DB_NAME arenden',
    andringar: { TEST_DB_NAME: 'arenden', TEST_PG_HOST: VARD, TEST_PG_PORT: '1' },
    finns: [VAGRAN, 'TEST_DB_NAME "arenden" slutar inte på _test'],
    saknas: ['ECONNREFUSED', FARSK_DATABAS],
  },
  {
    korning: '2: kontroll, ett namn som slutar på _test mot porten 1',
    andringar: { TEST_DB_NAME: VAKTENS_NAMN, TEST_PG_HOST: VARD, TEST_PG_PORT: '1' },
    finns: ['ECONNREFUSED'],
    saknas: [VAGRAN],
  },
  {
    korning: '3: TEST_PG_PORT 5435',
    andringar: { TEST_DB_NAME: VAKTENS_NAMN, TEST_PG_HOST: OLOSLIG_VARD, TEST_PG_PORT: '5435' },
    finns: [VAGRAN, 'MAINTENANCE_DATABASE_URL pekar på porten 5435'],
    saknas: [UPPSLAGSFEL, FARSK_DATABAS],
  },
  {
    korning: '4: kontroll, TEST_PG_PORT 5436 mot värden som aldrig löses upp',
    andringar: { TEST_DB_NAME: VAKTENS_NAMN, TEST_PG_HOST: OLOSLIG_VARD, TEST_PG_PORT: '5436' },
    finns: [UPPSLAGSFEL],
    saknas: [VAGRAN],
  },
  {
    korning: '5: TEST_PG_PORT med en frågedel som pekar på porten 5435',
    andringar: { TEST_DB_NAME: VAKTENS_NAMN, TEST_PG_HOST: OLOSLIG_VARD, TEST_PG_PORT: '5436/arenden?port=5435#' },
    finns: [VAGRAN, 'MAINTENANCE_DATABASE_URL har en frågedel eller ett fragment'],
    saknas: [UPPSLAGSFEL, FARSK_DATABAS],
  },
  {
    korning: '6: tomt TEST_PG_PORT',
    andringar: { TEST_DB_NAME: VAKTENS_NAMN, TEST_PG_HOST: OLOSLIG_VARD, TEST_PG_PORT: '' },
    finns: [VAGRAN, 'MAINTENANCE_DATABASE_URL saknar port'],
    saknas: [UPPSLAGSFEL, FARSK_DATABAS],
  },
  {
    korning: '7: TEST_DB_NAME med 55 byte',
    andringar: { TEST_DB_NAME: namnMedLangd(55), TEST_PG_HOST: OLOSLIG_VARD, TEST_PG_PORT: '5436' },
    finns: [VAGRAN, 'är längre än 54 byte'],
    saknas: [UPPSLAGSFEL, FARSK_DATABAS],
  },
];

function innehaller(utskrift: string, monster: string | RegExp): boolean {
  return typeof monster === 'string' ? utskrift.includes(monster) : monster.test(utskrift);
}

/**
 * Värdportarna i en compose-fils portlista, i filens ordning. Varje rad där är bindningsadressen, värdporten
 * och containerporten med kolon emellan, och bindningsadressen kan saknas.
 */
function publiceradePortar(compose: string): number[] {
  return [...compose.matchAll(/^\s*-\s*["']?(?:[\d.]+:)?(\d+):\d+["']?\s*$/gm)].map(([, port]) => Number(port));
}

/** Variablerna som får en postgres-adress i en källtext som test/env.ts, sorterade. */
function postgresadresser(kallan: string): string[] {
  return [...kallan.matchAll(/process\.env\.([A-Z_]+) = `postgres:\/\//g)].map(([, namn = '']) => namn).sort();
}

describe('FR-20/Story 7.3 AK 3: sviten vägrar driftdatabasen', () => {
  it('G4 (AK 3): vakten fäller namnet utanför tillåtelselistan och varje adress som pg inte läser som testklustrets', async () => {
    const { testdatabasfel } = await import('./globalSetup.js');
    // Alla utfall mot alla väntade i en jämförelse, så att ett rött utfall visar varje post.
    const utfall = VAKTPOSTER.map(({ databasnamn, miljo }, i) => ({
      post: i + 1,
      fynd: testdatabasfel(databasnamn, miljo),
    }));
    expect(utfall).toEqual(VAKTPOSTER.map(({ fynd }, i) => ({ post: i + 1, fynd })));
  });

  it('G5 (AK 3): globalSetup avbryter med vaktens fel före första anslutningen, för varje värde genom test/env.ts', async () => {
    // Porten 1 på loopback och värden grind.invalid: ingen av körningarna når någon databas. Körningarna
    // går en i taget, och alla utfall jämförs med alla väntade i en jämförelse, så att ett rött utfall visar
    // varje körning.
    const utfall: { korning: string; kod: number | null; saknade: string[]; ovantade: string[] }[] = [];
    const utskrifter: string[] = [];
    for (const { korning, andringar, finns, saknas } of VAKTKORNINGAR) {
      const { kod, utskrift } = await korVitest(['test/fore-filer.test.ts'], barnmiljo(andringar));
      utskrifter.push(`---- ${korning}\n${utskrift}`);
      utfall.push({
        korning,
        kod,
        saknade: finns.filter((monster) => !innehaller(utskrift, monster)).map(String),
        ovantade: saknas.filter((monster) => innehaller(utskrift, monster)).map(String),
      });
    }
    expect(utfall, utskrifter.join('\n')).toEqual(
      VAKTKORNINGAR.map(({ korning }) => ({ korning, kod: 1, saknade: [], ovantade: [] })),
    );
  }, 300_000);

  it('G6 (AK 3): standardvärdena godtas, och applyTestEnv() sätter fortfarande varje variabel med =', async () => {
    const { testdatabasfel } = await import('./globalSetup.js');
    // (a) den pågående svitens namn och adresser
    expect(testdatabasfel(TEST_DB_NAME, process.env)).toEqual([]);
    // (b) regression: en .env som hunnit sätta varje variabel styr ingen av dem (KRAV-19)
    const fore = testmiljon();
    try {
      for (const namn of TESTMILJONS_VARIABLER) process.env[namn] = 'satt-av-en-env-fil';
      // kontroll: mätningen kan slå ut, alla tolv skiljer sig nu från fore
      expect(TESTMILJONS_VARIABLER.filter((namn) => process.env[namn] === fore[namn])).toEqual([]);
      applyTestEnv();
      expect(testmiljon()).toEqual(fore);
    } finally {
      for (const namn of TESTMILJONS_VARIABLER) {
        const varde = fore[namn];
        if (varde === undefined) delete process.env[namn];
        else process.env[namn] = varde;
      }
    }
    // kontroll: den pågående svitens adress pekar på TEST_DB_NAME och inte på driftens port
    const adress = new URL(fore['DATABASE_URL'] ?? '');
    expect({ sokvag: adress.pathname, driftensPort: adress.port === '5435' }).toEqual({
      sokvag: `/${TEST_DB_NAME}`,
      driftensPort: false,
    });
  });

  it('G7 (AK 3): vaktens konstanter är bundna till sina källor, så att ingen av dem kan glida isär tyst', async () => {
    const { DRIFTENS_PORT, POSTGRES_NAMNGRANS, MALLENS_ANDELSE, TESTADRESSERNA } = await import('./globalSetup.js');
    // (a) driftens port är porten som docker-compose.yml publicerar för driftklustret
    const compose = readFileSync(path.join(ROT, 'docker-compose.yml'), 'utf8');
    expect(publiceradePortar(compose)).toEqual([DRIFTENS_PORT]);
    // kontroll: ett flyttat driftkluster ger en annan port
    expect(publiceradePortar(compose.replace(`:${DRIFTENS_PORT}:`, ':5434:'))).toEqual([5434]);
    // (b) namngränsen är testklustrets, där globalSetup() och test/setup.ts skapar och tar bort databaserna
    const underhall = new pg.Client({ connectionString: process.env.MAINTENANCE_DATABASE_URL });
    await underhall.connect();
    try {
      const { rows } = await underhall.query<{ max_identifier_length: string }>('SHOW max_identifier_length');
      expect(Number(rows[0]?.max_identifier_length)).toBe(POSTGRES_NAMNGRANS);
    } finally {
      await underhall.end();
    }
    // (c) mallens ändelse är den som test/env.ts bildar mallens namn med
    expect(TEST_TEMPLATE_DB_NAME).toBe(`${TEST_DB_NAME}${MALLENS_ANDELSE}`);
    // (d) vakten prövar varje adress som applyTestEnv() sätter till en postgres-adress
    const envKallan = readFileSync(path.join(ROT, 'test', 'env.ts'), 'utf8');
    expect(postgresadresser(envKallan)).toEqual([...TESTADRESSERNA].sort());
    // kontroll: en fjärde postgres-adress i test/env.ts syns
    expect(postgresadresser(`${envKallan}\n  process.env.EXTRA_DATABASE_URL = \`postgres://extra\`;\n`)).toEqual(
      [...TESTADRESSERNA, 'EXTRA_DATABASE_URL'].sort(),
    );
  });
});
