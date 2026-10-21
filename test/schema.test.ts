import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import { createApp } from '../src/http/app.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { assertAppRollArBegransad, pool } from '../src/db/pool.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';
import { TEST_DB_NAME } from './env.js';

// KRAV-4: RLS-beredskap från dag 1. Policyerna byggs i Etapp 3, men KOLUMNEN och
// indexet måste finnas på varje tabell nu — annars blir Etapp 3 en datamigrering
// i stället för en policyändring.
const UNDANTAG = ['tenants', 'schema_migrations'];

describe('KRAV-4/9: schemat är RLS-berett och sökbart', () => {
  it('varje tabell har tenant_id NOT NULL', async () => {
    const { rows } = await pool.query<{ tabell: string; nullable: string | null }>(
      `SELECT t.tablename AS tabell, c.is_nullable AS nullable
         FROM pg_tables t
         LEFT JOIN information_schema.columns c
           ON c.table_name = t.tablename AND c.column_name = 'tenant_id' AND c.table_schema = 'public'
        WHERE t.schemaname = 'public' AND t.tablename <> ALL($1::text[])
        ORDER BY t.tablename`,
      [UNDANTAG],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const rad of rows) {
      expect(rad.nullable, `${rad.tabell} saknar tenant_id`).not.toBeNull();
      expect(rad.nullable, `${rad.tabell}.tenant_id är nullbar`).toBe('NO');
    }
  });

  it('varje tabell har ett index som börjar på tenant_id', async () => {
    const { rows } = await pool.query<{ tabell: string }>(
      `SELECT t.tablename AS tabell
         FROM pg_tables t
        WHERE t.schemaname = 'public'
          AND t.tablename <> ALL($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
              JOIN pg_class c ON c.oid = i.indrelid
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
             WHERE c.relname = t.tablename AND a.attname = 'tenant_id')`,
      [UNDANTAG],
    );
    expect(rows.map((r) => r.tabell)).toEqual([]);
  });

  it('events är append-only och app-rollen saknar UPDATE/DELETE', async () => {
    const { rows } = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'events' AND grantee = 'app'`,
    );
    const rattigheter = rows.map((r) => r.privilege_type).sort();
    expect(rattigheter).toEqual(['INSERT', 'SELECT']);
  });

  it('sökkolumnerna är GENERATED och GIN-indexerade', async () => {
    const { rows } = await pool.query<{ table_name: string; is_generated: string }>(
      `SELECT table_name, is_generated FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'sokvektor' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['comments', 'issues']);
    for (const rad of rows) expect(rad.is_generated).toBe('ALWAYS');

    const index = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexdef LIKE '%USING gin%' ORDER BY indexname`,
    );
    expect(index.rows.map((r) => r.indexname)).toEqual(['comments_sok_idx', 'issues_sok_idx']);
  });

  it('appen kör som en icke-superuser utan BYPASSRLS och utan tabellägarskap', async () => {
    const { assertAppRollArBegransad } = await import('../src/db/pool.js');
    await expect(assertAppRollArBegransad()).resolves.toBeUndefined();
  });
});

// ---- FR-38/Story 7.1: hjälparna -------------------------------------------------------------------
//
// Provfilerna exporterar inga hjälpare, så mönstren skrivs om här: barnprocessen efter
// test/rattelser.test.ts (rad 111–134) och adminKlient() efter samma fil (rad 42–46).

const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));

/** Ägarrollen: användaren i DATABASE_ADMIN_URL (i testklustret superuser-rollen postgres). */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/** DATABASE_URL med användaren utbytt mot `roll`: samma kluster och databas, en annan inloggningsroll. */
function adressSom(roll: string): string {
  const url = new URL(process.env.DATABASE_URL!);
  url.username = roll;
  return url.toString();
}

async function anslutSom(roll: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: adressSom(roll) });
  await c.connect();
  return c;
}

/**
 * Provrollerna: roller som bara finns för det här provet, ingen av dem `app`. Två är inloggningsroller;
 * två saknar inloggning och finns för att app ska beviljas medlemskap i dem (F12): en som äger en
 * tillfällig tabell under F12 och en med SUPERUSER. Namnen och attributen är kodkonstanter, och bara de
 * interpoleras i SQL:en.
 */
const PROVROLLER = [
  { namn: 'arenden_prov_annan', attribut: 'LOGIN NOSUPERUSER NOBYPASSRLS' },
  { namn: 'arenden_prov_bypass', attribut: 'LOGIN NOSUPERUSER BYPASSRLS' },
  { namn: 'arenden_prov_agare', attribut: 'NOLOGIN NOSUPERUSER NOBYPASSRLS' },
  { namn: 'arenden_prov_super', attribut: 'NOLOGIN SUPERUSER NOBYPASSRLS' },
] as const;

/**
 * Roller gäller hela klustret och överlever DROP DATABASE i test/setup.ts. Ett avbrutet varv kan ha
 * lämnat kvar en provroll med ett medlemskap eller en rollinställning (F12, F13), och de följer med
 * rollen. Därför tas rollerna först bort, och sedan skapas de idempotent (mönstret i
 * migrations/0001_grund.sql rad 9–15), med attributen ur ALTER ROLE.
 */
async function skapaProvroller(): Promise<void> {
  await taBortProvroller();
  const admin = await adminKlient();
  try {
    for (const { namn, attribut } of PROVROLLER) {
      await admin.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${namn}') THEN
            CREATE ROLE ${namn};
          END IF;
        END
        $$`);
      await admin.query(`ALTER ROLE ${namn} ${attribut}`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Rollerna äger ingenting och har inga egna rättigheter när fallen har städat (F12 tar bort sin tabell),
 * så borttagningen går igenom. DROP ROLE tar också bort rollens medlemskap åt båda hållen och dess
 * rollinställningar.
 */
async function taBortProvroller(): Promise<void> {
  const admin = await adminKlient();
  try {
    for (const { namn } of PROVROLLER) await admin.query(`DROP ROLE IF EXISTS ${namn}`);
  } finally {
    await admin.end();
  }
}

/** Felets text, eller null när körningen lyckas. Fallen jämför problemtexterna, inte bara att något kastas. */
async function rollfel(korning: () => Promise<unknown>): Promise<string | null> {
  try {
    await korning();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Barnprocessens miljö: en kopia av provets miljö, med ändringarna och utan nycklarna i `utan`.
 * DOTENV_CONFIG_PATH pekar på en fil som inte finns, så att ingen .env kan rikta barnprocessen mot en
 * annan databas (samma skydd som test/rattelser.test.ts rad 128–132).
 */
function barnmiljo(andringar: Record<string, string>, utan: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: path.join(tmpdir(), 'schema-roller-finns-inte.env'),
    ...andringar,
  };
  for (const nyckel of utan) delete env[nyckel];
  return env;
}

interface Barnutfall {
  kod: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Kör `fil` med tsx under repots rot och kastar aldrig: `kod` är 0 när processen lyckas, annars dess
 * exitkod, och null för en process som dödats. Tidsgränsen och SIGKILL behövs för en server som godtar
 * rollen: den lyssnar annars tills provets tidsgräns, och SIGTERM hade fått src/server.ts att stänga ner
 * med exitkod 0.
 */
async function korBarnprocess(fil: string, env: NodeJS.ProcessEnv): Promise<Barnutfall> {
  try {
    const { stdout, stderr } = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'tsx'),
      [path.join(ROT, fil)],
      { cwd: ROT, env, timeout: 15_000, killSignal: 'SIGKILL' },
    );
    return { kod: 0, stdout, stderr };
  } catch (err) {
    const fel: Record<string, unknown> = typeof err === 'object' && err !== null ? { ...err } : {};
    return {
      kod: typeof fel['code'] === 'number' ? fel['code'] : null,
      stdout: typeof fel['stdout'] === 'string' ? fel['stdout'] : '',
      stderr: typeof fel['stderr'] === 'string' ? fel['stderr'] : '',
    };
  }
}

/** Ledgern, läst som ägarrollen: app har ingen rättighet på schema_migrations. */
async function ledgern(): Promise<unknown[]> {
  const admin = await adminKlient();
  try {
    const { rows } = await admin.query(
      'SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version',
    );
    return rows;
  } finally {
    await admin.end();
  }
}

/**
 * Migrationernas advisory-lås: samma nyckel som ADVISORY_LOCK_KEY i src/db/migrate.ts. Kontrollen i F5
 * visar att nyckeln stämmer: när provet håller låset väntar ägarrollens migrate() på det.
 */
const MIGRATIONSLASET = 502_874_311;

/** Löftets värde, eller 'väntar' när det inte är avgjort inom `ms`. Timern städas alltid. */
async function inomTid<T>(lofte: Promise<T>, ms: number): Promise<T | 'väntar'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const vantan = new Promise<'väntar'>((resolve) => {
    timer = setTimeout(() => resolve('väntar'), ms);
  });
  try {
    return await Promise.race([lofte, vantan]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * En NY databas i testklustret, migrerad med migrate() och ägarrollens adress, efter migreradTomDatabas()
 * i test/skrivvagar.test.ts (rad 694–726). `korning` får en klient som ägarrollen och körningens resultat.
 * Databasen tas alltid bort efteråt.
 */
async function migreradNyDatabas(
  namn: string,
  korning: (klient: pg.Client, resultat: Awaited<ReturnType<typeof migrate>>) => Promise<void>,
): Promise<void> {
  const underhall = new pg.Client({ connectionString: process.env.MAINTENANCE_DATABASE_URL });
  await underhall.connect();
  try {
    await underhall.query(`DROP DATABASE IF EXISTS ${namn} WITH (FORCE)`);
    await underhall.query(`CREATE DATABASE ${namn}`);
    const url = new URL(process.env.DATABASE_ADMIN_URL!);
    url.pathname = `/${namn}`;
    const resultat = await migrate(url.toString());
    const klient = new pg.Client({ connectionString: url.toString() });
    await klient.connect();
    try {
      await korning(klient, resultat);
    } finally {
      await klient.end();
    }
  } finally {
    try {
      await underhall.query(`DROP DATABASE IF EXISTS ${namn} WITH (FORCE)`);
    } finally {
      await underhall.end();
    }
  }
}

/**
 * Fynden för AK 4: varje tabell i public, läst med en fråga utan tabellista, ska ägas av `roll` och aldrig
 * av app. Tom = ägarskapet håller. En tom lista och saknade kärntabeller är egna fynd, så att provet inte
 * kan bli grönt på att ingenting lästes.
 */
async function agarfel(klient: pg.Client, roll: string): Promise<string[]> {
  const { rows } = await klient.query<{ tabell: string; agare: string }>(
    `SELECT tablename::text AS tabell, tableowner::text AS agare
       FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const fynd: string[] = [];
  if (rows.length === 0) fynd.push('inga tabeller');
  const tabeller = rows.map((r) => r.tabell);
  if (!tabeller.includes('events')) fynd.push('events saknas');
  if (!tabeller.includes('schema_migrations')) fynd.push('schema_migrations saknas');
  for (const { tabell, agare } of rows) {
    if (agare !== roll || agare === 'app') fynd.push(`${tabell}: ${agare}`);
  }
  return fynd;
}

// README (krav → kod → test), efter mönstret i test/linear-lankar.test.ts (rad 432–490).

const RUBRIKEN = '### FR-38 — appen kör bara som app och migrationerna aldrig som app (Story 7.1)';
const GRANSER_2A = '## Gränser för Etapp 2a';
const REGELNS_BORJAN = '- Rollerna (FR-38, B-11, Story 7.1):';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN =
  '- Rollerna (FR-38, B-11, Story 7.1): appen kör bara som rollen `app`, och migrationerna kör aldrig som ' +
  'den. `assertAppRollArBegransad()` i `src/db/pool.ts` kräver att `current_user` är `APP_ROLL` ur ' +
  '`src/db/migrate.ts`, att rollen varken är superuser eller har BYPASSRLS och att den inte äger någon ' +
  'tabell i `public`; `src/server.ts` avslutar annars med FATAL och exitkod 1. `migrate()` i ' +
  '`src/db/migrate.ts` vägrar som första sak att köra som `APP_ROLL` och returnerar rollen som körde, och ' +
  '`npm run migrate` skriver ut den. En ny tabell skapas av en migration som ägarrollen och ges till `app` ' +
  'bara med GRANT, aldrig med OWNER TO.';

/** Avsnittets gränser: från rubriken till nästa rad som börjar med '## ' eller '### '. */
function avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/**
 * Fynden för F11: rubriken en gång och före Etapp 2a:s gränser, regelns rad exakt en gång och
 * fyra tabellrader, var och en med provfilen.
 */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const fel: string[] = [];
  const rubriker = rader.filter((r) => r === RUBRIKEN).length;
  if (rubriker !== 1) fel.push(`rubriken står ${rubriker} gånger`);
  const etapp2a = rader.indexOf(GRANSER_2A);
  if (etapp2a === -1 || etapp2a < granser.start) fel.push(`rubriken står inte före ${GRANSER_2A}`);
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const regler = avsnitt.filter((r) => r.startsWith(REGELNS_BORJAN));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regeln avviker');
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-38'));
  if (tabell.length !== 4) fel.push(`${tabell.length} rader börjar med | FR-38`);
  for (const r of tabell) if (!r.includes('test/schema.test.ts')) fel.push(`rad utan provfilen: ${r}`);
  return fel;
}

/** Texten utan avsnittet: raderna från rubriken till nästa rubrik på nivå två eller tre tas bort. */
function utanAvsnittet(text: string): string {
  const rader = text.split('\n');
  const granser = avsnittet(rader.map((r) => r.replace(/\r$/, '')));
  if (!granser) return text;
  return [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
}

// ---- FR-38/Story 7.1 AK 1 och AK 2 ----------------------------------------------------------------

describe('FR-38/Story 7.1 AK 1 och AK 2: appen kör bara som app och äger ingen tabell', () => {
  beforeAll(skapaProvroller);
  afterAll(taBortProvroller);

  it('F1 (AK 1): en annan roll än app fälls på namnet och bara på det', async () => {
    const klient = await anslutSom('arenden_prov_annan');
    try {
      const fel = await rollfel(() => assertAppRollArBegransad(klient));
      expect(fel).not.toBeNull();
      expect(fel).toContain('"arenden_prov_annan"');
      expect(fel).toContain('rollen är inte "app"');
      for (const annat of ['SUPERUSER', 'BYPASSRLS', 'äger tabeller']) expect(fel).not.toContain(annat);
    } finally {
      await klient.end();
    }
  });

  it('F2 (AK 1): servern startar inte som en annan roll, utan slutar med FATAL och exitkod 1', async () => {
    const utfall = await korBarnprocess(
      'src/server.ts',
      barnmiljo({ DATABASE_URL: adressSom('arenden_prov_annan'), PORT: '0' }),
    );
    expect(utfall.stdout).not.toContain('lyssnar på');
    expect(utfall.kod).toBe(1);
    expect(utfall.stderr).toContain('FATAL:');
    expect(utfall.stderr).toContain('"arenden_prov_annan"');
    expect(utfall.stderr).toContain('rollen är inte "app"');
  });

  it('F3 (AK 2): app som äger en annan tabell än events fälls med tabellens namn', async () => {
    // En ny tabell och inte en befintlig: ägarbytet skriver om rättighetslistan, och att flytta
    // tillbaka hade inte gett app dess ursprungliga GRANT i databasen som resten av filen delar.
    const admin = await adminKlient();
    try {
      await admin.query('CREATE TABLE public.f3_tillfallig (tenant_id uuid NOT NULL)');
      await admin.query('ALTER TABLE public.f3_tillfallig OWNER TO app');
      const fel = await rollfel(() => assertAppRollArBegransad());
      expect(fel).not.toBeNull();
      expect(fel).toContain('rollen äger tabeller i public: f3_tillfallig');
      expect(fel).toContain('"app"');
      expect(fel).not.toContain('rollen är inte "app"');
    } finally {
      try {
        await admin.query('DROP TABLE IF EXISTS public.f3_tillfallig');
      } finally {
        await admin.end();
      }
    }

    // Kontrollen: efter borttagningen godtas app igen, så det var tabellen som fällde.
    expect(await rollfel(() => assertAppRollArBegransad())).toBeNull();
  });

  it('F4 (AK 2): superuser och BYPASSRLS fälls som förut, var för sig, och app godtas', async () => {
    const agarroll = new URL(process.env.DATABASE_ADMIN_URL!).username;
    const admin = await adminKlient();
    try {
      const bypass = await anslutSom('arenden_prov_bypass');
      try {
        const superfel = await rollfel(() => assertAppRollArBegransad(admin));
        expect(superfel).not.toBeNull();
        expect(superfel).toContain('rollen är SUPERUSER');
        expect(superfel).toContain(`"${agarroll}"`);

        const bypassfel = await rollfel(() => assertAppRollArBegransad(bypass));
        expect(bypassfel).not.toBeNull();
        expect(bypassfel).toContain('rollen har BYPASSRLS');
        expect(bypassfel).toContain('"arenden_prov_bypass"');
        expect(bypassfel).not.toContain('SUPERUSER');

        // Kontrollen: app godtas, med poolen som argument och utan argument (serverns anrop).
        expect(await rollfel(() => assertAppRollArBegransad(pool))).toBeNull();
        expect(await rollfel(() => assertAppRollArBegransad())).toBeNull();
      } finally {
        await bypass.end();
      }
    } finally {
      await admin.end();
    }
  });

  it('F12 (AK 2): app som är medlem i en annan roll fälls, också när ägarskap eller SUPERUSER bara nås genom den', async () => {
    // Genom ett medlemskap når app rollens rättigheter, ärvda eller med SET ROLE. Fallistan är
    // felklassen: ägarskap ärvt, nått med SET ROLE och nått genom en mellanroll, SUPERUSER och
    // BYPASSRLS som bara rollen har, och ett medlemskap utan attribut och utan tabeller, som
    // tillåtelselistan (inget medlemskap alls) också fäller. Varje fall slutar med REVOKE och kontrollen
    // att app godtas igen, så att det är medlemskapet som fäller.
    const MEDLEM = 'rollen är medlem i andra roller och kan nå deras rättigheter: ';
    const AGER = 'rollen äger tabeller i public: f12_tillfallig';
    const fall: { namn: string; bevilja: string[]; aterkalla: string[]; finns: string[]; saknas: string[] }[] = [
      {
        namn: 'en roll som äger en tabell, med arv',
        bevilja: ['GRANT arenden_prov_agare TO app'],
        aterkalla: ['REVOKE arenden_prov_agare FROM app'],
        finns: [AGER, `${MEDLEM}arenden_prov_agare`],
        saknas: ['arenden_prov_annan', 'SUPERUSER', 'BYPASSRLS'],
      },
      {
        namn: 'samma roll utan arv, nådd med SET ROLE',
        bevilja: ['GRANT arenden_prov_agare TO app WITH INHERIT FALSE'],
        aterkalla: ['REVOKE arenden_prov_agare FROM app'],
        finns: [AGER, `${MEDLEM}arenden_prov_agare`],
        saknas: ['arenden_prov_annan', 'SUPERUSER', 'BYPASSRLS'],
      },
      {
        namn: 'samma roll genom en mellanroll',
        bevilja: ['GRANT arenden_prov_agare TO arenden_prov_annan', 'GRANT arenden_prov_annan TO app'],
        aterkalla: ['REVOKE arenden_prov_annan FROM app', 'REVOKE arenden_prov_agare FROM arenden_prov_annan'],
        finns: [AGER, `${MEDLEM}arenden_prov_agare, arenden_prov_annan`],
        saknas: ['SUPERUSER', 'BYPASSRLS'],
      },
      {
        namn: 'en roll med SUPERUSER',
        bevilja: ['GRANT arenden_prov_super TO app'],
        aterkalla: ['REVOKE arenden_prov_super FROM app'],
        finns: [`${MEDLEM}arenden_prov_super (SUPERUSER)`],
        saknas: ['rollen är SUPERUSER', 'äger tabeller', 'BYPASSRLS'],
      },
      {
        namn: 'en roll med BYPASSRLS',
        bevilja: ['GRANT arenden_prov_bypass TO app'],
        aterkalla: ['REVOKE arenden_prov_bypass FROM app'],
        finns: [`${MEDLEM}arenden_prov_bypass (BYPASSRLS)`],
        saknas: ['rollen har BYPASSRLS', 'äger tabeller', 'SUPERUSER'],
      },
      {
        namn: 'en roll utan attribut och utan tabeller',
        bevilja: ['GRANT arenden_prov_annan TO app'],
        aterkalla: ['REVOKE arenden_prov_annan FROM app'],
        finns: [`${MEDLEM}arenden_prov_annan`],
        saknas: ['arenden_prov_agare', 'SUPERUSER', 'BYPASSRLS', 'äger tabeller'],
      },
    ];

    const admin = await adminKlient();
    try {
      await admin.query('CREATE TABLE public.f12_tillfallig (tenant_id uuid NOT NULL)');
      await admin.query('ALTER TABLE public.f12_tillfallig OWNER TO arenden_prov_agare');
      // Utgångsläget: tabellen är provrollens, inte appens, och app godtas.
      expect(await rollfel(() => assertAppRollArBegransad())).toBeNull();

      for (const f of fall) {
        try {
          for (const sats of f.bevilja) await admin.query(sats);
          const fel = await rollfel(() => assertAppRollArBegransad());
          expect(fel, f.namn).not.toBeNull();
          for (const text of f.finns) expect(fel, f.namn).toContain(text);
          for (const text of [...f.saknas, 'rollen är inte "app"', 'inloggningsrollen']) {
            expect(fel, f.namn).not.toContain(text);
          }
        } finally {
          for (const sats of f.aterkalla) await admin.query(sats);
        }
        // Kontrollen: efter REVOKE godtas app igen.
        expect(await rollfel(() => assertAppRollArBegransad()), f.namn).toBeNull();
      }
    } finally {
      try {
        await admin.query('DROP TABLE IF EXISTS public.f12_tillfallig');
      } finally {
        await admin.end();
      }
    }
  });

  it('F13 (AK 1): en session som loggat in som en annan roll och bytt till app fälls på inloggningsrollen', async () => {
    // current_user kan sessionen sätta själv, och RESET ROLE tar den tillbaka till inloggningsrollen.
    // Fallistan är vägarna dit: -c role=app i adressen, SET ROLE i sessionen, ALTER ROLE … SET role för en
    // inloggningsroll som är medlem i app, och serverns start med en sådan DATABASE_URL.
    const agarroll = new URL(process.env.DATABASE_ADMIN_URL!).username;
    const rollbyte = new URL(process.env.DATABASE_ADMIN_URL!);
    rollbyte.searchParams.set('options', '-c role=app');
    const sessionsfel = (inloggning: string) => `inloggningsrollen (session_user) är "${inloggning}" och inte "app"`;

    /** Klienten ska vara app för current_user men inloggad som `inloggning`; bara sessionsproblemet får fälla. */
    async function provaSession(namn: string, klient: pg.Client, inloggning: string): Promise<void> {
      const { rows } = await klient.query<{ cu: string; su: string }>(
        'SELECT current_user::text AS cu, session_user::text AS su',
      );
      // Utgångsläget: current_user är app, så kontrollen av den ensam hade godtagit sessionen.
      expect(rows[0], namn).toEqual({ cu: 'app', su: inloggning });
      const fel = await rollfel(() => assertAppRollArBegransad(klient));
      expect(fel, namn).not.toBeNull();
      expect(fel, namn).toContain(sessionsfel(inloggning));
      for (const text of ['rollen är inte "app"', 'SUPERUSER', 'BYPASSRLS', 'äger tabeller', 'medlem i andra roller']) {
        expect(fel, namn).not.toContain(text);
      }
    }

    const medOption = new pg.Client({ connectionString: rollbyte.toString() });
    await medOption.connect();
    try {
      await provaSession('ägarrollen med -c role=app i adressen', medOption, agarroll);
    } finally {
      await medOption.end();
    }

    const medSetRole = await adminKlient();
    try {
      await medSetRole.query('SET ROLE app');
      await provaSession('ägarrollen efter SET ROLE app', medSetRole, agarroll);
    } finally {
      await medSetRole.end();
    }

    const admin = await adminKlient();
    try {
      await admin.query('GRANT app TO arenden_prov_annan');
      await admin.query("ALTER ROLE arenden_prov_annan SET role = 'app'");
      const annan = await anslutSom('arenden_prov_annan');
      try {
        await provaSession('arenden_prov_annan med ALTER ROLE … SET role', annan, 'arenden_prov_annan');
      } finally {
        await annan.end();
      }
    } finally {
      try {
        await admin.query('ALTER ROLE arenden_prov_annan RESET role');
        await admin.query('REVOKE app FROM arenden_prov_annan');
      } finally {
        await admin.end();
      }
    }

    // Startvägen: servern med samma adress som det första fallet startar inte.
    const utfall = await korBarnprocess(
      'src/server.ts',
      barnmiljo({ DATABASE_URL: rollbyte.toString(), PORT: '0' }),
    );
    expect(utfall.stdout).not.toContain('lyssnar på');
    expect(utfall.kod).toBe(1);
    expect(utfall.stderr).toContain('FATAL:');
    expect(utfall.stderr).toContain(sessionsfel(agarroll));

    // Kontrollen: appens egen inloggning godtas.
    expect(await rollfel(() => assertAppRollArBegransad())).toBeNull();
  }, 60_000);
});

// ---- FR-38/Story 7.1 AK 3 -------------------------------------------------------------------------

describe('FR-38/Story 7.1 AK 3: migrationerna kör aldrig som app', () => {
  // F15 behöver provrollen arenden_prov_agare; blocket ovan tar bort rollerna i sitt afterAll.
  beforeAll(skapaProvroller);
  afterAll(taBortProvroller);

  it('F5 (AK 3): migrate() som app vägrar före filerna och före advisory-låset, och ledgern står orörd', async () => {
    const fore = await ledgern();
    const loggrader: string[] = [];
    const fel = await rollfel(() =>
      migrate(process.env.DATABASE_URL!, { log: (m) => loggrader.push(m) }),
    );
    expect(fel).not.toBeNull();
    expect(fel).toContain('migrationer körs som ägarroll');
    expect(fel).toContain('"app"');
    expect(await ledgern()).toEqual(fore);
    expect(loggrader).toEqual([]);

    // Platsen, före filerna: med en migrationskatalog som inte finns kommer vägran och inte läsfelet.
    const ingenKatalog = path.join(tmpdir(), 'schema-f5-migrationer-finns-inte');
    const felUtanKatalog = await rollfel(() => migrate(process.env.DATABASE_URL!, { dir: ingenKatalog }));
    expect(felUtanKatalog).toContain('migrationer körs som ägarroll');
    expect(felUtanKatalog).not.toContain('ENOENT');
    // Kontrollen: ägarrollen når filerna med samma katalog och faller på läsfelet.
    expect(await rollfel(() => migrate(process.env.DATABASE_ADMIN_URL!, { dir: ingenKatalog }))).toContain(
      'ENOENT',
    );

    // Platsen, före låset: ägarrollen håller migrationernas advisory-lås i en egen session. Stod vägran
    // efter låset hade migrate() som app väntat på det i stället för att svara.
    const lasare = await adminKlient();
    let agarkorning: Promise<string | null> | undefined;
    try {
      await lasare.query('SELECT pg_advisory_lock($1)', [MIGRATIONSLASET]);
      const felMedLas = await inomTid(rollfel(() => migrate(process.env.DATABASE_URL!)), 5_000);
      expect(felMedLas).not.toBe('väntar');
      expect(felMedLas).toContain('migrationer körs som ägarroll');
      // Kontrollen: samma lås håller ägarrollens migrate() kvar, så låset är migrationernas och
      // mätningen kan slå ut.
      agarkorning = rollfel(() => migrate(process.env.DATABASE_ADMIN_URL!));
      expect(await inomTid(agarkorning, 2_000)).toBe('väntar');
    } finally {
      await lasare.end(); // släpper låset
    }
    expect(await agarkorning).toBeNull();
    expect(await ledgern()).toEqual(fore);
  }, 60_000);

  it('F6 (AK 3): CLI-läget som app slutar med FATAL och exitkod 1, och ledgern står orörd', async () => {
    const fore = await ledgern();
    const utfall = await korBarnprocess(
      'src/db/migrate.ts',
      barnmiljo({ DATABASE_ADMIN_URL: process.env.DATABASE_URL! }),
    );
    expect(utfall.kod).toBe(1);
    expect(utfall.stderr).toContain('FATAL:');
    expect(utfall.stderr).toContain('migrationer körs som ägarroll');
    expect(await ledgern()).toEqual(fore);
  });

  it('F7 (AK 3, AK 5): ägarrollen går igenom, rollen skrivs ut och omkörningen är en no-op', async () => {
    const agarroll = new URL(process.env.DATABASE_ADMIN_URL!).username;
    const n = (await loadMigrations()).length;

    // (a) Funktionen: inget kördes, alla var redan körda, och rollen är ägarrollen.
    const resultat = await migrate(process.env.DATABASE_ADMIN_URL!);
    expect(resultat.applied).toEqual([]);
    expect(resultat.alreadyApplied).toBe(n);
    expect(resultat.roll).toBe(agarroll);

    // (b) CLI-läget nedan är samma kommando som npm run migrate.
    const paket = JSON.parse(readFileSync(path.join(ROT, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(paket.scripts['migrate']).toBe('tsx src/db/migrate.ts');

    // (c) CLI-läget: OK-raden ordagrant som förut, och rollen på en egen rad.
    const utfall = await korBarnprocess(
      'src/db/migrate.ts',
      barnmiljo({ DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL! }),
    );
    expect(utfall.kod).toBe(0);
    expect(utfall.stdout).toContain(`OK: 0 migration(er) kördes, ${n} var redan körda`);
    expect(utfall.stdout).toContain(`Migrationerna kördes som rollen "${agarroll}"`);

    // (d) Ledgern har en rad per migrationsfil, varken fler eller färre.
    expect((await ledgern()).length).toBe(n);
  });

  it('F14 (AK 3, AK 5): CLI-läget vägrar app också genom reservvägen, och DATABASE_ADMIN_URL går före', async () => {
    // Fallistan är CLI-lägets adressval, DATABASE_ADMIN_URL ?? DATABASE_URL, med den adress som saknas
    // eller pekar på app. F6 (DATABASE_ADMIN_URL som app), F7 (båda satta, rätt) och F9 (ingen adress)
    // prövar resten. Varje kontroll skiljer sig från sitt fällda fall bara i rollen.
    const agarroll = new URL(process.env.DATABASE_ADMIN_URL!).username;
    const appAdress = process.env.DATABASE_URL!;
    const agarAdress = process.env.DATABASE_ADMIN_URL!;
    const fall: { namn: string; andringar: Record<string, string>; utan: string[]; vagras: boolean }[] = [
      {
        namn: 'bara DATABASE_URL, som app (en glömd DATABASE_ADMIN_URL)',
        andringar: { DATABASE_URL: appAdress },
        utan: ['DATABASE_ADMIN_URL'],
        vagras: true,
      },
      {
        namn: 'bara DATABASE_URL, som ägarrollen (kontroll: reservvägen når migrate())',
        andringar: { DATABASE_URL: agarAdress },
        utan: ['DATABASE_ADMIN_URL'],
        vagras: false,
      },
      {
        namn: 'DATABASE_ADMIN_URL som app och DATABASE_URL som ägarrollen (ingen reserv förbi vägran)',
        andringar: { DATABASE_ADMIN_URL: appAdress, DATABASE_URL: agarAdress },
        utan: [],
        vagras: true,
      },
      {
        namn: 'DATABASE_ADMIN_URL som ägarrollen och DATABASE_URL som app (kontroll)',
        andringar: { DATABASE_ADMIN_URL: agarAdress, DATABASE_URL: appAdress },
        utan: [],
        vagras: false,
      },
    ];

    for (const f of fall) {
      const fore = await ledgern();
      const utfall = await korBarnprocess('src/db/migrate.ts', barnmiljo(f.andringar, f.utan));
      if (f.vagras) {
        expect(utfall.kod, f.namn).toBe(1);
        expect(utfall.stderr, f.namn).toContain('FATAL:');
        expect(utfall.stderr, f.namn).toContain('migrationer körs som ägarroll');
        expect(utfall.stderr, f.namn).toContain('anslutningen är rollen "app"');
        expect(utfall.stdout, f.namn).not.toContain('Migrationerna kördes som rollen');
      } else {
        expect(utfall.kod, f.namn).toBe(0);
        expect(utfall.stdout, f.namn).toContain(`Migrationerna kördes som rollen "${agarroll}"`);
      }
      expect(await ledgern(), f.namn).toEqual(fore);
    }
  }, 60_000);

  it('F15 (AK 3): migrate() vägrar också en inloggning som app som bytt till en annan roll', async () => {
    // current_user kan sessionen sätta med -c role=… i adressen, om inloggningen är medlem i rollen.
    const medRoll = (adress: string): string => {
      const url = new URL(adress);
      url.searchParams.set('options', '-c role=arenden_prov_agare');
      return url.toString();
    };
    const fore = await ledgern();
    const admin = await adminKlient();
    try {
      await admin.query('GRANT arenden_prov_agare TO app');
      const fel = await rollfel(() => migrate(medRoll(process.env.DATABASE_URL!)));
      expect(fel).toContain('migrationer körs som ägarroll');
      expect(fel).toContain('anslutningen är rollen "arenden_prov_agare", inloggad som "app"');

      // Kontrollen: samma roll med ägarrollens inloggning vägras inte. Den når låset och ledgern och
      // faller där på Postgres rättighetsfel, eftersom provrollen saknar CREATE i public och rättigheter
      // på ledgern.
      const kontroll = await rollfel(() => migrate(medRoll(process.env.DATABASE_ADMIN_URL!)));
      expect(kontroll).not.toBeNull();
      expect(kontroll).not.toContain('migrationer körs som ägarroll');
      expect(kontroll).toMatch(/public|schema_migrations/);
    } finally {
      try {
        await admin.query('REVOKE arenden_prov_agare FROM app');
      } finally {
        await admin.end();
      }
    }
    expect(await ledgern()).toEqual(fore);
  });
});

// ---- FR-38/Story 7.1 AK 4 -------------------------------------------------------------------------

describe('FR-38/Story 7.1 AK 4: varje tabell ägs av migrationsrollen', () => {
  it('F8 (AK 4): i en nymigrerad databas ägs varje tabell i public av migrationsrollen', async () => {
    const agarroll = new URL(process.env.DATABASE_ADMIN_URL!).username;
    await migreradNyDatabas(`${TEST_DB_NAME}_f8_agarskap`, async (klient, resultat) => {
      expect(resultat.roll).toBe(agarroll);
      expect(await agarfel(klient, resultat.roll)).toEqual([]);

      // Kontrollen: en tabell som ges till app fälls, och bara den. Engångsdatabasen tas bort efteråt.
      await klient.query('ALTER TABLE labels OWNER TO app');
      expect(await agarfel(klient, resultat.roll)).toEqual(['labels: app']);
    });
  });
});

// ---- FR-38/Story 7.1 AK 5 -------------------------------------------------------------------------

describe('FR-38/Story 7.1 AK 5: CLI-läget utan adress och FR-8:s skiljelinje', () => {
  let app: Express;
  let agentnyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  it('F9 (AK 5): CLI-läget utan båda adresserna slutar med FATAL och exitkod 1', async () => {
    const fore = await ledgern();
    const utan = await korBarnprocess(
      'src/db/migrate.ts',
      barnmiljo({}, ['DATABASE_ADMIN_URL', 'DATABASE_URL']),
    );
    expect(utan.kod).toBe(1);
    expect(utan.stderr).toContain('FATAL: DATABASE_ADMIN_URL (eller DATABASE_URL) måste vara satt');
    expect(await ledgern()).toEqual(fore);

    // Kontrollen: samma körning med DATABASE_ADMIN_URL satt går igenom, så det är den saknade
    // adressen som fäller.
    const med = await korBarnprocess(
      'src/db/migrate.ts',
      barnmiljo({ DATABASE_ADMIN_URL: process.env.DATABASE_ADMIN_URL! }, ['DATABASE_URL']),
    );
    expect(med.kod).toBe(0);
  });

  it('F10 (AK 5): app får 42501 och ägarrollen P0001 på proveniensen i comments', async () => {
    const skapat = await kor(app, agentnyckel, 'create_issue', { title: 'F10 proveniens', team_key: 'LOC' });
    expect(skapat.status).toBe(200);
    const identifier = skapat.body.result.identifier as string;
    const kommentar = await kor(app, agentnyckel, 'add_comment', { identifier, body: 'F10 orörd text.' });
    expect(kommentar.status).toBe(200);
    const id = kommentar.body.result.id as string;

    // Linje 1, kolumn-GRANT:en: app får inte skriva aktor_namn.
    await expect(
      pool.query("UPDATE comments SET aktor_namn = 'f10 annan' WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: '42501' });

    const admin = await adminKlient();
    try {
      // Linje 2, triggern: den gäller också ägaren, som går förbi GRANT-nivån.
      await expect(
        admin.query("UPDATE comments SET aktor_namn = 'f10 annan' WHERE id = $1", [id]),
      ).rejects.toMatchObject({ code: 'P0001' });

      // Kontrollen: samma tabell och rad med en tillåten kolumn går igenom för båda.
      await expect(
        pool.query("UPDATE comments SET body = 'F10 rättad' WHERE id = $1", [id]),
      ).resolves.toMatchObject({ rowCount: 1 });
      await expect(
        admin.query("UPDATE comments SET body = 'F10 rättad' WHERE id = $1", [id]),
      ).resolves.toMatchObject({ rowCount: 1 });
      const { rows } = await admin.query<{ aktor_namn: string }>(
        'SELECT aktor_namn FROM comments WHERE id = $1',
        [id],
      );
      expect(rows[0]?.aktor_namn).toBe('hermes');
    } finally {
      await admin.end();
    }
  });
});

// ---- FR-38/Story 7.1: README ----------------------------------------------------------------------

describe('FR-38/Story 7.1: README bär regeln', () => {
  it('F11 (AK 1–5): avsnittet bär regeln och fyra rader krav → kod → test', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect(readmefel(readme)).toEqual([]);

    // Kontrollen: samma kontroll på texten utan avsnittet fälls.
    expect(readmefel(utanAvsnittet(readme))).toEqual(['rubriken saknas']);
  });
});
