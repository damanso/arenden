// FR-28, B-10 (Story 6.4): ärendehierarkin kan inte bli cirkulär, ens vid samtidiga ändringar.
//
// Cykelspärren (triggern issues_ingen_foralderscykel, 0007) vandrade förälderkedjan utan lås. Två samtidiga
// ändringar, A under B och B under A, kunde därför båda godtas mot det gamla läget, eller sluta i ett dödläge
// (40P01, som errorHandler inte översätter: svaret blev 500). Migrationen 0019_hierarkilas.sql lägger
// låsnyckelns enda definition, databasfunktionen issues_ta_hierarkilas, och låter triggerfunktionen ta låset
// när raden får eller byter förälder, före vandringen. uppdateraArendeFalt tar samma lås, genom samma
// funktion, före radlåset när indata har parent.
//
// Fallistorna, slutna:
//   AK 1  HL1  migrationsfilen: numret, kommentaren först, låsnyckeln exakt en gång, de arton tidigare filernas
//              sha256 och nio satser som inte får stå i filen; fyra påhittade uppsättningar som kontroll.
//         HL2  en tom engångsdatabas migreras till och med 0018 och sedan vidare: katalogens form för varje
//              tabell är densamma, funktionerna skiljer sig i exakt två poster, app får anropa låsfunktionen och
//              PUBLIC inte, och en tredje körning är en no-op; en tillagd kolumn som kontroll.
//         HL3  triggerns lås: (a) ett förälderbyte och (c) en INSERT med förälder väntar på låset, (b) samma
//              sats utan byte väntar inte; (d) och (e) låset tas före vandringen, så den andra av två motriktade
//              ägarskrivningar ser den första efter COMMIT och fälls, och godtas efter ROLLBACK, både när den
//              första tar låset själv och när dess trigger gör det; (f) nyckeln gäller per tenant: (a) och (c)
//              väntar inte på en annan tenants lås.
//   AK 2  HL5  låsets ordning i tjänstelagret: (a) parent väntar före radlåset, (b) parent null väntar,
//              (c) titel och status utan parent väntar inte; (d) låset hålls medan anropet väntar på radlåset
//              och skriver, och utan parent hålls inget; (e) nyckeln gäller per tenant också här.
//         HL6  Promise.all, ett it per varv: (1) A under B och B under A, 25 varv; (2) förälderändring och
//              titelrättelse på den nya föräldern, 20 varv; (3) förälderändring och statusbyte, 20 varv.
//         HL7  hierarkilåsets plats i källtexten under src, med tre påhittade källor som kontroll.
//   AK 3  HL4  ägarrollen: cykeln, självfallet och en kedja djupare än 100 steg fälls med P0001; 100 steg godtas.
//         HL8  API:t: samma tre ger 409 rule_violation och noll händelserader; 100 steg ger 200.
//   AK 4  HL9  relationer och bilagor utan dubbletter, en förälder, milstolpen, inga kolumner för estimat och cykel.
//   AK 5  test/aterlasning.test.ts, orörd.
//
// Varje fall bär en kontroll som visar att mätningen kan slå ut, och den skiljer sig från det prövade bara i det
// som provas (lärdomen ur Story 6.2:s F10).
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';
import { TEST_DB_NAME } from './env.js';

const ROT_64 = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONER_64 = path.join(ROT_64, 'migrations');
const NY_MIGRATION = '0019_hierarkilas.sql';

/** Triggerns två meddelanden, ordagrant som i 0007. */
const CIRKULAR = 'förälderkedjan skulle bli cirkulär: ärendet kan inte ligga under sig självt';
const DJUP = 'förälderkedjan är orimligt djup (över 100 steg) — vägrar skriva';

/**
 * En annan tenant, för kontrollen att låsnyckeln gäller per tenant (HL3 (f), HL5 (e)). Låsfunktionen läser ingen
 * tabell, så tenanten behöver inte finnas.
 */
const ANNAN_TENANT = '00000000-0000-0000-0000-000000000002';

// ---- Avskrivna hjälpare ---------------------------------------------------------------------------------

// vanta, svarInom, adminKlient och vantaTillsNagonVantarPaLas: avskrivna ur test/samtidighet.test.ts (Story 1.1).
const vanta = (ms: number): Promise<void> => new Promise((klar) => setTimeout(klar, ms));

/** Svaret, eller 'tidsgräns' om det inte kommit inom 2 s. */
const svarInom = <T>(p: PromiseLike<T>): Promise<T | 'tidsgräns'> =>
  Promise.race([Promise.resolve(p), vanta(2_000).then(() => 'tidsgräns' as const)]);

/** Ägarrollen (postgres). Den som öppnar en anslutning stänger den i finally. */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/**
 * Väntar tills någon backend i testdatabasen står och väntar på ett lås. Anropas med en EGEN anslutning utan
 * öppen transaktion: pg_stat_activity läses som en ögonblicksbild per transaktion.
 */
async function vantaTillsNagonVantarPaLas(vakt: pg.Client, tidsgransMs = 5_000): Promise<void> {
  const slut = Date.now() + tidsgransMs;
  while (Date.now() < slut) {
    const { rows } = await vakt.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await vanta(25);
  }
  throw new Error('ingen transaktion väntade på låset inom tidsgränsen');
}

// tomDatabas: avskriven ur test/schema.test.ts (Story 7.4, F20).
/** Ägaranslutning till en tom engångsdatabas i testklustret. Databasen tas bort efteråt. */
async function tomDatabas(
  namn: string,
  korning: (adress: string, klient: pg.Client) => Promise<void>,
): Promise<void> {
  const underhall = new pg.Client({ connectionString: process.env.MAINTENANCE_DATABASE_URL });
  await underhall.connect();
  try {
    await underhall.query(`DROP DATABASE IF EXISTS ${namn} WITH (FORCE)`);
    await underhall.query(`CREATE DATABASE ${namn}`);
    const url = new URL(process.env.DATABASE_ADMIN_URL!);
    url.pathname = `/${namn}`;
    const klient = new pg.Client({ connectionString: url.toString() });
    try {
      await klient.connect();
      await korning(url.toString(), klient);
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

// ---- Appen, nycklarna och ärendena ----------------------------------------------------------------------

let app: Express;
let hermes: string; // agent
let david: string; // människa

beforeAll(async () => {
  app = createApp();
  await seedaTeam();
  hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  david = await nyNyckel({ typ: 'manniska', namn: 'david' });
});

type Nytt = { id: string; identifier: string };

/** Ett nytt ärende genom create_issue (som tar team_key men ingen parent). */
async function nytt(titel: string): Promise<Nytt> {
  const svar = await kor(app, hermes, 'create_issue', { title: titel, team_key: 'LOC' });
  expect(svar.status, JSON.stringify(svar.body)).toBe(200);
  return { id: svar.body.result.id as string, identifier: svar.body.result.identifier as string };
}

/** update_issue med parent; ett tyst fel i förberedelserna får aldrig bära ett senare fall. */
async function foralderTill(identifier: string, parent: string | null): Promise<void> {
  const svar = await kor(app, hermes, 'update_issue', { identifier, parent });
  expect(svar.status, JSON.stringify(svar.body)).toBe(200);
}

/** Ärendets lagrade förälder, läst ur issues.foralder_id och inte ur ett svar. */
async function lagradForalder(id: string): Promise<string | null> {
  const { rows } = await pool.query<{ foralder_id: string | null }>(
    'SELECT foralder_id FROM issues WHERE id = $1',
    [id],
  );
  return rows[0]!.foralder_id;
}

/**
 * Ägarrollen lägger in `antal` ärenden utan förälder med en sats (team och state ur ett befintligt ärende,
 * sekvensnumren från `startnummer`) och sätter sedan, en sats per ärende i ordning, varje ärendes förälder till
 * det föregående. K0 först; K(n) ligger under K(n-1).
 */
async function byggKedja(prefix: string, antal: number, startnummer: number): Promise<Nytt[]> {
  const agare = await adminKlient();
  try {
    const { rows } = await agare.query<Nytt>(
      `WITH nya AS (
         INSERT INTO issues (tenant_id, team_id, state_id, sequence_number, title)
         SELECT i.tenant_id, i.team_id, i.state_id, $2::int + n, $3::text || ' K' || n
           FROM (SELECT tenant_id, team_id, state_id FROM issues
                  WHERE tenant_id = $1 ORDER BY skapad, id LIMIT 1) i,
                generate_series(0, $4::int - 1) AS n
         RETURNING id, team_id, sequence_number
       )
       SELECT nya.id, t.key || '-' || nya.sequence_number AS identifier
         FROM nya JOIN teams t ON t.id = nya.team_id
        ORDER BY nya.sequence_number`,
      [TENANT_ID, startnummer, prefix, antal],
    );
    for (let k = 1; k < rows.length; k++) {
      await agare.query('UPDATE issues SET foralder_id = $1 WHERE id = $2', [rows[k - 1]!.id, rows[k]!.id]);
    }
    return rows;
  } finally {
    await agare.end();
  }
}

// ---- Uppgift 1: migrationsfilen och katalogen ------------------------------------------------------------

/** De arton tidigare migrationerna och deras sha256, avlästa i kopian 2026-10-25. Listan är sluten. */
const TIDIGARE_MIGRATIONER: readonly { fil: string; sha256: string }[] = [
  { fil: '0001_grund.sql', sha256: '5c0b7cd60ffe3cb63234febb9fc90f21add92be0d885f1ac2f7a2a967c51455a' },
  { fil: '0002_teams_och_states.sql', sha256: '37fb1c66288dcfd1c4193022a016d6cc991d91ea01b3ed6b484670fe44920810' },
  { fil: '0003_arenden.sql', sha256: '1ca9fca1ef081b81d9e4456d803bd6238e36deff8331beeb20ca3538bc660bbe' },
  { fil: '0004_events.sql', sha256: '6e4488356fecd7c4f40e6742a2511197d72e21c2d1712137386e64c04b6facb0' },
  { fil: '0005_sok.sql', sha256: '0b325d3fa6b1947d6f7273f7f36f65fcd86faeb0a2c116d32d68452fd917f052' },
  { fil: '0006_api_keys.sql', sha256: 'a4d4af6c613e5636fe09ffc3933d1ad38b5312dbeb4540cdcbcc23dfbfc9e117' },
  { fil: '0007_arendehierarki.sql', sha256: '21c8d2ea30f604586649238ece5e6d744404dc18790d248bb8239826055f9fc7' },
  { fil: '0008_arenderelationer.sql', sha256: '7426c1c196ec41b31a556e370f779be06ded0c2df290a14f86d840ef5ff42552' },
  { fil: '0009_arendebilagor.sql', sha256: 'b44be43308d9a79cac9923f8faf77aef63ad6c2219760a67d2a4bb5ab1b6cbc4' },
  { fil: '0010_milstolpe.sql', sha256: '75d783c0607d01040acb4aa8d61ccfc1eb1bf95c2c0a0ca4d63e1e48e5ab4bc6' },
  { fil: '0011_rattelser.sql', sha256: '25b82066e8ba2d08c3a4aa756d97bab00588f7c4d66828899b0367467b095a94' },
  { fil: '0012_kundkoppling.sql', sha256: 'c12171eb1e182cf1f7d73af3dc391ca23b80a240d1b3ca3b670cc22d65b08c07' },
  { fil: '0013_kundkoppling_grant.sql', sha256: 'cfa8f96e10d68b8795ed88cfa6857f1984c7d9c452660ebceda2bf2b9ac02303' },
  { fil: '0014_atagande.sql', sha256: 'ec245584c35d2923c48d4ee77718bb730099293b00e5c730877ec934a236fb88' },
  { fil: '0015_insats.sql', sha256: 'c7ec7d39e780f47e1ebe501f91973ffef295985329352f748651f893ec5af8a9' },
  { fil: '0016_svarsversion_lopnummer.sql', sha256: '49da45056874c2d60620f7398f6342c62384aab987a37ddd2c2e67fbf3c3e3b9' },
  { fil: '0017_tenant_id_overallt.sql', sha256: 'de5a3cc60c3e9389496ebad2f4e36f72637db2e5257dc7517fa54531ae259f0a' },
  { fil: '0018_nodvandiga_delresultat.sql', sha256: '1cc6226fa7cffaeb2b6477169e1ce0a2fd1b3bc99afd339fca0a82954fa2b7b9' },
];

/** Satserna som inte får stå i den nya filen (AK 1). Ett stöd; beviset är katalogens form i HL2. */
const FORBJUDNA_SATSER = [
  'ALTER TABLE', 'CREATE TABLE', 'DROP TABLE', 'CREATE TRIGGER', 'DROP TRIGGER',
  'CREATE INDEX', 'INSERT INTO', 'DELETE FROM', 'TRUNCATE',
] as const;

type Fil = { fil: string; text: string };

/** sha256 över hela texten, som loadMigrations räknar checksumman. */
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
const antalGanger = (text: string, del: string): number => text.split(del).length - 1;
const migrationsnummer = (fil: string): number => Number(/^(\d{4})_/.exec(fil)?.[1] ?? Number.NaN);

/** SQL-texten utan kommentarsrader (som börjar med -- efter blanktecken). */
function utanSqlKommentarer(text: string): string {
  return text.split('\n').filter((rad) => !rad.trimStart().startsWith('--')).join('\n');
}

/** Varje .sql-fil i migrationskatalogen, sorterad. */
function migrationsfiler(): Fil[] {
  return readdirSync(MIGRATIONER_64)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(MIGRATIONER_64, fil), 'utf8') }));
}

/**
 * Fynden för migrationskatalogen, i fast ordning. sha256 och första raden prövas på den oförändrade texten,
 * de övriga textkontrollerna utan kommentarsrader.
 */
function migrationsfel(filer: Fil[]): string[] {
  const fynd: string[] = [];
  const nya = filer.filter((f) => f.fil.endsWith('_hierarkilas.sql'));
  if (nya.length === 0) fynd.push('ingen migration slutar på _hierarkilas.sql');
  if (nya.length > 1) fynd.push(`${nya.length} migrationer slutar på _hierarkilas.sql`);
  const ny = nya.length === 1 ? nya[0] : undefined;
  const ovriga = filer.filter((f) => f !== ny);

  if (ny) {
    const vantat = Math.max(...ovriga.map((f) => migrationsnummer(f.fil))) + 1;
    if (migrationsnummer(ny.fil) !== vantat) {
      fynd.push(`numret är ${ny.fil.slice(0, 4)}, väntat ${String(vantat).padStart(4, '0')}`);
    }
    if (!ny.text.startsWith('-- ')) fynd.push('kommentaren står inte först');
  }

  for (const { fil, sha256: vantad } of TIDIGARE_MIGRATIONER) {
    const funnen = filer.find((f) => f.fil === fil);
    if (!funnen) fynd.push(`${fil} saknas`);
    else if (sha256(funnen.text) !== vantad) fynd.push(`${fil} har ändrats`);
  }
  for (const { fil } of ovriga) {
    if (TIDIGARE_MIGRATIONER.some((t) => t.fil === fil)) continue;
    // En fil med högre nummer än den nya ger redan fyndet om numret.
    if (ny && migrationsnummer(fil) > migrationsnummer(ny.fil)) continue;
    fynd.push(`${fil} står inte i listan`);
  }

  if (ny) {
    const kod = utanSqlKommentarer(ny.text);
    const las = antalGanger(kod, 'pg_advisory_xact_lock');
    if (las !== 1) fynd.push(`pg_advisory_xact_lock står ${las} gånger`);
    const anrop = antalGanger(kod, 'issues_ta_hierarkilas(');
    if (anrop < 2) fynd.push(`issues_ta_hierarkilas( står ${anrop} gånger`);
  }
  for (const { fil, text } of ovriga) {
    const kod = utanSqlKommentarer(text);
    if (kod.includes('pg_advisory_xact_lock') || kod.includes('issues_ta_hierarkilas')) {
      fynd.push(`${fil} nämner hierarkilåset`);
    }
  }
  if (ny) {
    const kod = utanSqlKommentarer(ny.text);
    for (const sats of FORBJUDNA_SATSER) {
      if (new RegExp(`\\b${sats.split(' ').join('\\s+')}\\b`, 'i').test(kod)) fynd.push(`${sats} står i ${ny.fil}`);
    }
  }
  return fynd;
}

/**
 * Katalogens form för varje tabell i schemat public: kolumner (namn, typ, NOT NULL, standarduttryck), villkor,
 * index, triggrar som inte är interna och tabellens rättigheter. Sorterad, så att två läsningar kan jämföras.
 */
async function schemaform(klient: pg.Client) {
  const rader = async (sql: string): Promise<unknown[]> => (await klient.query(sql)).rows;
  return {
    tabeller: await rader(
      `SELECT c.relname::text AS tabell, c.relacl::text AS rattigheter
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname`,
    ),
    kolumner: await rader(
      `SELECT c.relname::text AS tabell, a.attname::text AS kolumn, format_type(a.atttypid, a.atttypmod) AS typ,
              a.attnotnull AS not_null, pg_get_expr(d.adbin, d.adrelid) AS standard
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname, a.attname`,
    ),
    villkor: await rader(
      `SELECT c.relname::text AS tabell, k.conname::text AS villkor, pg_get_constraintdef(k.oid) AS definition
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
        ORDER BY c.relname, k.conname`,
    ),
    index: await rader(
      `SELECT tablename::text AS tabell, indexname::text AS index, indexdef
         FROM pg_indexes WHERE schemaname = 'public'
        ORDER BY tablename, indexname`,
    ),
    triggrar: await rader(
      `SELECT c.relname::text AS tabell, t.tgname::text AS trigger, pg_get_triggerdef(t.oid) AS definition
         FROM pg_trigger t
         JOIN pg_class c ON c.oid = t.tgrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT t.tgisinternal
        ORDER BY c.relname, t.tgname`,
    ),
  };
}

type Funktion = { namn: string; argument: string; md5: string; rattigheter: string | null };

/** Varje funktion i schemat public: namn, argumenttyper, md5 över källtexten och rättigheterna. */
async function funktionsform(klient: pg.Client): Promise<Funktion[]> {
  const { rows } = await klient.query<Funktion>(
    `SELECT p.proname::text AS namn, pg_get_function_identity_arguments(p.oid) AS argument,
            md5(p.prosrc) AS md5, p.proacl::text AS rattigheter
       FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
      ORDER BY 1, 2`,
  );
  return rows;
}

/** Skillnaden mellan två funktionsformer: nya, borttagna och ändrade poster med de ändrade fälten. */
function funktionsskillnad(fore: Funktion[], efter: Funktion[]): string[] {
  const nyckel = (f: Funktion): string => `${f.namn}(${f.argument})`;
  const forut = new Map(fore.map((f) => [nyckel(f), f]));
  const sedan = new Map(efter.map((f) => [nyckel(f), f]));
  const ut: string[] = [];
  for (const [k, f] of sedan) {
    const gammal = forut.get(k);
    if (!gammal) {
      ut.push(`ny: ${k}`);
      continue;
    }
    const falt = (['md5', 'rattigheter'] as const).filter((namn) => gammal[namn] !== f[namn]);
    if (falt.length > 0) ut.push(`ändrad ${falt.join(' och ')}: ${k}`);
  }
  for (const k of forut.keys()) if (!sedan.has(k)) ut.push(`borta: ${k}`);
  return ut.sort();
}

describe('FR-28/Story 6.4 AK 1: migrationen tar hierarkilåset per tenant före vandringen, utan att ändra någon tabell', () => {
  it('HL1 (AK 1): migrationsfilen har nästa nummer, kommentaren först, låsnyckeln en gång och orörda föregångare', async () => {
    const filer = migrationsfiler();
    expect(filer.map((f) => f.fil), 'hittade inga migrationer').toContain('0007_arendehierarki.sql');
    // sha256 här är samma värde som migrationsverktygets checksumma.
    expect(filer.map((f) => sha256(f.text))).toEqual((await loadMigrations()).map((m) => m.checksum));
    expect(migrationsfel(filer)).toEqual([]);

    // Kontroll: fyra påhittade uppsättningar byggda ur katalogens filer ger exakt sina fynd.
    const ny = filer.find((f) => f.fil.endsWith('_hierarkilas.sql'));
    if (!ny) throw new Error('ingen migration slutar på _hierarkilas.sql');
    const medAndrad = (fil: string, andra: (text: string) => string): Fil[] =>
      filer.map((f) => (f.fil === fil ? { fil, text: andra(f.text) } : f));
    expect(migrationsfel(filer.filter((f) => f !== ny))).toEqual(['ingen migration slutar på _hierarkilas.sql']);
    expect(migrationsfel(medAndrad('0007_arendehierarki.sql', (t) => `${t} `)))
      .toEqual(['0007_arendehierarki.sql har ändrats']);
    expect(migrationsfel(medAndrad(ny.fil, (t) => `\n${t}`))).toEqual(['kommentaren står inte först']);
    expect(migrationsfel(medAndrad(ny.fil, (t) => `${t}\nALTER TABLE issues ADD COLUMN x int;\n`)))
      .toEqual([`ALTER TABLE står i ${NY_MIGRATION}`]);
  });

  it('HL2 (AK 1): katalogen är oförändrad, låsfunktionen är appens och inte PUBLIC:s, och tredje körningen är en no-op', async () => {
    await tomDatabas(`${TEST_DB_NAME}_hl2`, async (adress, klient) => {
      const dir = mkdtempSync(path.join(tmpdir(), 'hierarkilas-hl2-migrationer-'));
      try {
        for (const { fil } of TIDIGARE_MIGRATIONER) {
          copyFileSync(path.join(MIGRATIONER_64, fil), path.join(dir, fil));
        }
        const forsta = await migrate(adress, { dir });
        expect(forsta.applied).toHaveLength(TIDIGARE_MIGRATIONER.length);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
      const schemaFore = await schemaform(klient);
      const funktionerFore = await funktionsform(klient);

      const andra = await migrate(adress);
      expect(andra.applied).toEqual([NY_MIGRATION]);
      expect(await schemaform(klient)).toEqual(schemaFore);
      expect(funktionsskillnad(funktionerFore, await funktionsform(klient))).toEqual([
        'ny: issues_ta_hierarkilas(p_tenant uuid)',
        'ändrad md5: issues_vagra_foralderscykel()',
      ]);
      // acldefault ersätter en tom proacl, som annars hade dolt PUBLIC:s standardrätt att anropa funktionen.
      const ratt = await klient.query<{ app: boolean; publik: number }>(
        `SELECT has_function_privilege('app', 'issues_ta_hierarkilas(uuid)', 'EXECUTE') AS app,
                (SELECT count(*)::int
                   FROM pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) AS a
                  WHERE p.oid = 'issues_ta_hierarkilas(uuid)'::regprocedure AND a.grantee = 0) AS publik`,
      );
      expect(ratt.rows).toEqual([{ app: true, publik: 0 }]);

      const ledgerSql = 'SELECT version, name, checksum, applied_at, tenant_id FROM schema_migrations ORDER BY version';
      const ledger = (await klient.query(ledgerSql)).rows;
      expect(ledger).toHaveLength(TIDIGARE_MIGRATIONER.length + 1);
      const tredje = await migrate(adress);
      expect(tredje.applied).toEqual([]);
      expect((await klient.query(ledgerSql)).rows).toEqual(ledger);

      // Kontroll: en tillagd kolumn syns i formen, så jämförelsen kan slå ut.
      await klient.query('BEGIN');
      try {
        await klient.query('ALTER TABLE issues ADD COLUMN hl2_kontroll integer');
        expect(await schemaform(klient)).not.toEqual(schemaFore);
      } finally {
        await klient.query('ROLLBACK');
      }
    });
  }, 60_000);

  it('HL3 (AK 1): triggern tar låset per tenant när föräldern byts eller sätts vid INSERT, före vandringen, och inte när den står kvar', async () => {
    const P = await nytt('HL3 P');
    const C1 = await nytt('HL3 C1');
    const C2 = await nytt('HL3 C2');
    const C3 = await nytt('HL3 C3');
    await foralderTill(C2.identifier, P.identifier);
    const X = await adminKlient();
    const skrivare = await adminKlient();
    const vakt = await adminKlient();
    const taLaset = async (tenant: string = TENANT_ID): Promise<void> => {
      await X.query('BEGIN');
      await X.query('SELECT issues_ta_hierarkilas($1)', [tenant]);
    };
    /** Skrivarens förälderbyte (a, b, d, e, f) och INSERT med P som förälder (c, f), samma sats varje gång. */
    const byt = (arende: Nytt, foralder: Nytt) =>
      skrivare.query('UPDATE issues SET foralder_id = $1 WHERE id = $2', [foralder.id, arende.id]);
    const laggUnderP = (nummer: number, titel: string) =>
      skrivare.query(
        `INSERT INTO issues (tenant_id, team_id, state_id, sequence_number, title, foralder_id)
         SELECT tenant_id, team_id, state_id, $2::int, $3::text, id FROM issues WHERE id = $1`,
        [P.id, nummer, titel],
      );
    /**
     * (d) och (e): X byter A:s förälder till B i en öppen transaktion, och skrivaren byter B:s förälder till A medan
     * X håller låset. Ger skrivarens utfall, rowCount eller felet, efter X:s COMMIT eller ROLLBACK. Varje anrop får
     * ett eget nytt par, så att COMMIT och ROLLBACK prövas från samma läge.
     */
    const motriktat = async (lasetForst: boolean, slut: 'COMMIT' | 'ROLLBACK') => {
      const namn = `HL3 ${lasetForst ? 'd' : 'e'} ${slut}`;
      const A = await nytt(`${namn} A`);
      const B = await nytt(`${namn} B`);
      await X.query('BEGIN');
      if (lasetForst) await X.query('SELECT issues_ta_hierarkilas($1)', [TENANT_ID]);
      await X.query('UPDATE issues SET foralder_id = $1 WHERE id = $2', [B.id, A.id]);
      const motsatt = byt(B, A);
      motsatt.catch(() => undefined);
      await vantaTillsNagonVantarPaLas(vakt);
      await X.query(slut);
      const utfall: unknown = await motsatt.then(
        (r) => r.rowCount,
        (fel: unknown) => fel,
      );
      return { A, B, utfall };
    };
    try {
      // (a) Samma sats som byter förälder väntar på låset.
      await taLaset();
      const byte = byt(C1, P);
      byte.catch(() => undefined);
      await vantaTillsNagonVantarPaLas(vakt);
      await X.query('ROLLBACK');
      expect((await byte).rowCount).toBe(1);
      expect(await lagradForalder(C1.id)).toBe(P.id);

      // (b) Samma sats på C2, som redan har P: triggern körs men byter inget, och väntar inte.
      await taLaset();
      const utanByte = await svarInom(byt(C2, P));
      expect(utanByte, 'satsen utan byte väntade på låset').not.toBe('tidsgräns');
      if (utanByte !== 'tidsgräns') expect(utanByte.rowCount).toBe(1);
      await X.query('ROLLBACK');

      // (c) En INSERT med förälder väntar på låset.
      await taLaset();
      const insattning = laggUnderP(990001, 'HL3 c');
      insattning.catch(() => undefined);
      await vantaTillsNagonVantarPaLas(vakt);
      await X.query('ROLLBACK');
      expect((await insattning).rowCount).toBe(1);

      // (d) Låset tas före vandringen, och vandringen ser det som den som höll låset just committade. X gör som
      // kommentaren i 0019 säger att ett ägarskript ska göra (låset först, sedan förälderbytet), och skrivaren
      // byter åt andra hållet utan att anropa låsfunktionen först, så att bara dess trigger väntar: efter COMMIT
      // fälls skrivarens sats med cykelfelet, och B har ingen förälder. Kontroll: rullar X i stället tillbaka,
      // godtas samma sats. Med låset efter slingan, eller med en STABLE triggerfunktion som läser satsens gamla
      // ögonblicksbild, hade satsen godtagits också efter COMMIT.
      // (e) Samma sak när X inte tar låset själv: triggern i X:s egen sats tar det och håller det till COMMIT.
      for (const lasetForst of [true, false]) {
        const led = lasetForst ? '(d)' : '(e)';
        const godtagen = await motriktat(lasetForst, 'ROLLBACK');
        expect(godtagen.utfall, `${led} efter ROLLBACK`).toBe(1);
        expect(await lagradForalder(godtagen.B.id), `${led} efter ROLLBACK`).toBe(godtagen.A.id);
        const avvisad = await motriktat(lasetForst, 'COMMIT');
        expect(avvisad.utfall, `${led} efter COMMIT`).toMatchObject({ code: 'P0001', message: CIRKULAR });
        expect(await lagradForalder(avvisad.A.id), `${led} efter COMMIT`).toBe(avvisad.B.id);
        expect(await lagradForalder(avvisad.B.id), `${led} efter COMMIT`).toBeNull();
      }

      // (f) Nyckeln gäller per tenant: medan X håller låset för en annan tenant väntar varken förälderbytet ur (a)
      // eller INSERT:en ur (c). Satserna skiljer sig från (a) och (c) bara i tenanten som X låser (och i raden och
      // numret, som unikheten kräver). Med en nyckel utan tenanten hade båda väntat.
      await taLaset(ANNAN_TENANT);
      const bytePerTenant = await svarInom(byt(C3, P));
      expect(bytePerTenant, '(f) förälderbytet väntade på en annan tenants lås').not.toBe('tidsgräns');
      if (bytePerTenant !== 'tidsgräns') expect(bytePerTenant.rowCount).toBe(1);
      const insattningPerTenant = await svarInom(laggUnderP(990002, 'HL3 f'));
      expect(insattningPerTenant, '(f) INSERT:en väntade på en annan tenants lås').not.toBe('tidsgräns');
      if (insattningPerTenant !== 'tidsgräns') expect(insattningPerTenant.rowCount).toBe(1);
      await X.query('ROLLBACK');
      expect(await lagradForalder(C3.id)).toBe(P.id);
    } finally {
      await X.query('ROLLBACK').catch(() => undefined);
      await X.end();
      await skrivare.end();
      await vakt.end();
    }
  });
});

// ---- Uppgift 2: låsordningen i tjänstelagret ------------------------------------------------------------

type Kedjerad = { id: string; foralder_id: string | null };

/**
 * Provets egen kedjevandring: varje kedja följs uppåt med en mängd besökta id, och ett id som nås två gånger i
 * samma vandring blir fyndet «cykel genom <id>». Sorterad, utan dubbletter.
 */
function cykelfel(rader: Kedjerad[]): string[] {
  const foralder = new Map(rader.map((r) => [r.id, r.foralder_id]));
  const fynd = new Set<string>();
  for (const { id } of rader) {
    const besokta = new Set<string>();
    let nuvarande: string | null | undefined = id;
    while (nuvarande !== null && nuvarande !== undefined) {
      if (besokta.has(nuvarande)) {
        fynd.add(`cykel genom ${nuvarande}`);
        break;
      }
      besokta.add(nuvarande);
      nuvarande = foralder.get(nuvarande);
    }
  }
  return [...fynd].sort();
}

/** Alla par av id och förälder i tenanten. */
async function allaKedjor(): Promise<Kedjerad[]> {
  const { rows } = await pool.query<Kedjerad>('SELECT id, foralder_id FROM issues WHERE tenant_id = $1', [
    TENANT_ID,
  ]);
  return rows;
}

const TJANSTEFILEN = 'services/arenden.ts';

/** TypeScript-texten utan kommentarsrader (som börjar med //, /* eller * efter blanktecken). */
function utanTsKommentarer(text: string): string {
  return text.split('\n').filter((rad) => !/^(\/\/|\/\*|\*)/.test(rad.trimStart())).join('\n');
}

/** Varje .ts-fil under src, läst rekursivt och sorterad; sökvägen relativt src. */
function kallfilerISrc(): Fil[] {
  const src = path.join(ROT_64, 'src');
  return readdirSync(src, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split(path.sep).join('/'))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(src, fil), 'utf8') }));
}

/**
 * Fynden för hierarkilåsets plats i källtexten: låsfunktionen anropas från exakt ett ställe, i tjänstefilen;
 * låsnyckeln står ingenstans under src; och i uppdateraArendeFalt står hjälparens anrop före radlåset.
 */
function lasplatsfel(filer: Fil[]): string[] {
  const fynd: string[] = [];
  const kod = filer.map(({ fil, text }) => ({ fil, kod: utanTsKommentarer(text) }));

  const medFunktionen = kod.filter((f) => f.kod.includes('issues_ta_hierarkilas'));
  const enda = medFunktionen.length === 1 ? medFunktionen[0]! : undefined;
  if (!enda) fynd.push(`issues_ta_hierarkilas står i ${medFunktionen.length} filer`);
  else if (enda.fil !== TJANSTEFILEN) fynd.push(`issues_ta_hierarkilas står i ${enda.fil}`);
  else if (antalGanger(enda.kod, 'issues_ta_hierarkilas') > 1) {
    fynd.push(`issues_ta_hierarkilas står ${antalGanger(enda.kod, 'issues_ta_hierarkilas')} gånger`);
  }

  for (const f of kod) if (f.kod.includes('pg_advisory_xact_lock')) fynd.push(`pg_advisory_xact_lock står i ${f.fil}`);

  // Kroppen: från funktionens första rad till nästa rad som börjar med export.
  const tjanst = kod.find((f) => f.fil === TJANSTEFILEN)?.kod ?? '';
  const start = tjanst.indexOf('export async function uppdateraArendeFalt(');
  const slut = start === -1 ? -1 : tjanst.indexOf('\nexport ', start);
  const kropp = start === -1 ? '' : tjanst.slice(start, slut === -1 ? undefined : slut);
  const las = kropp.indexOf('taHierarkilaset(');
  const radlas = kropp.indexOf('hamtaArendeForAndring(');
  if (las === -1 || radlas === -1 || las > radlas) fynd.push('taHierarkilaset( står inte före hamtaArendeForAndring(');
  return fynd;
}

// De påhittade källorna utgår från en rätt tjänstefil och ändrar bara det som provas.
const LASANROPET = '  if (input.parent !== undefined) await taHierarkilaset(client, tenantId);';
const RADLASET = '  const arende = await hamtaArendeForAndring(client, tenantId, identifier);';
function pahittadTjanst(forst: string, sedan: string): Fil {
  return {
    fil: TJANSTEFILEN,
    text: [
      'async function taHierarkilaset(client, tenantId) {',
      "  await client.query('SELECT issues_ta_hierarkilas($1::uuid)', [tenantId]);",
      '}',
      '',
      'export async function uppdateraArendeFalt(client, tenantId, identifier, input) {',
      forst,
      sedan,
      '}',
      '',
      'export async function barnFor() {}',
    ].join('\n'),
  };
}
const RATT_KALLA: Fil[] = [pahittadTjanst(LASANROPET, RADLASET)];
const ANROPET_EFTER_RADLASET: Fil[] = [pahittadTjanst(RADLASET, LASANROPET)];
const NYCKELN_I_TVA_FILER: Fil[] = [
  ...RATT_KALLA,
  { fil: 'services/insats.ts', text: "await client.query('SELECT issues_ta_hierarkilas($1::uuid)', [tenantId]);" },
];
const LASET_I_TJANSTEN: Fil[] = [
  ...RATT_KALLA,
  { fil: 'services/insats.ts', text: "await client.query('SELECT pg_advisory_xact_lock(28064, 1)');" },
];

const varvlista = (antal: number): number[] => Array.from({ length: antal }, (_, n) => n + 1);

describe('FR-28/Story 6.4 AK 2: samtidiga motriktade ändringar ger exakt en vinnare, aldrig 40P01 eller 500', () => {
  it('HL5 (AK 2): update_issue tar hierarkilåset per tenant före radlåset och håller det till COMMIT när indata har parent, också null, och annars inte', async () => {
    const A = await nytt('HL5 A');
    const B = await nytt('HL5 B');
    const D = await nytt('HL5 D');
    const E = await nytt('HL5 E');
    const F = await nytt('HL5 F');
    const G = await nytt('HL5 G');
    const P = await nytt('HL5 P');
    await foralderTill(D.identifier, P.identifier);
    await foralderTill(E.identifier, P.identifier);
    const X = await adminKlient();
    const annan = await adminKlient();
    const vakt = await adminKlient();
    const taLaset = async (tenant: string = TENANT_ID): Promise<void> => {
      await X.query('BEGIN');
      await X.query('SELECT issues_ta_hierarkilas($1)', [tenant]);
    };
    /**
     * (d): X håller F:s radlås, update_issue på F startas och väntar på det, och den andra anslutningen försöker ta
     * hierarkilåset. Ger om försöket väntade (inget svar inom två sekunder) och anropets status.
     */
    const hallerLaset = async (indata: Record<string, unknown>) => {
      await X.query('BEGIN');
      await X.query('SELECT id FROM issues WHERE id = $1 FOR UPDATE', [F.id]);
      const anrop = Promise.resolve(kor(app, hermes, 'update_issue', { identifier: F.identifier, ...indata }));
      anrop.catch(() => undefined);
      await vantaTillsNagonVantarPaLas(vakt);
      await annan.query('BEGIN');
      const forsok = annan.query('SELECT issues_ta_hierarkilas($1)', [TENANT_ID]);
      forsok.catch(() => undefined);
      const vantade = (await svarInom(forsok)) === 'tidsgräns';
      // Fick den andra anslutningen låset släpps det direkt, så att anropet aldrig väntar på provet.
      if (!vantade) await annan.query('ROLLBACK');
      await X.query('ROLLBACK');
      const { status } = await anrop;
      if (vantade) {
        await forsok;
        await annan.query('ROLLBACK');
      }
      return { vantade, status };
    };
    try {
      // (a) Anropet väntar på hierarkilåset innan det har låst B: en annan anslutning får B:s radlås.
      await taLaset();
      // Promise.resolve anropar .then(), och det är då en supertest-Test skickas.
      const flytt = Promise.resolve(kor(app, hermes, 'update_issue', { identifier: B.identifier, parent: A.identifier }));
      flytt.catch(() => undefined);
      await vantaTillsNagonVantarPaLas(vakt);
      // Utan BEGIN: radlåset släpps när satsen är klar.
      const nowait = await annan.query('SELECT id FROM issues WHERE id = $1 FOR UPDATE NOWAIT', [B.id]);
      expect(nowait.rows).toEqual([{ id: B.id }]);
      await X.query('ROLLBACK');
      expect((await flytt).status).toBe(200);
      expect(await lagradForalder(B.id)).toBe(A.id);

      // (b) parent null väntar också: villkoret är att indata har parent, inte värdet.
      await taLaset();
      const lyft = Promise.resolve(kor(app, hermes, 'update_issue', { identifier: D.identifier, parent: null }));
      lyft.catch(() => undefined);
      await vantaTillsNagonVantarPaLas(vakt);
      await X.query('ROLLBACK');
      expect((await lyft).status).toBe(200);
      expect(await lagradForalder(D.id)).toBeNull();

      // (c) Kontroll: samma action i samma låsta tillstånd, utan parent, väntar inte; inte heller ett statusbyte.
      // E har en förälder, så titelrättelsens UPDATE nämner foralder_id utan att byta värdet.
      await taLaset();
      const titel = await svarInom(
        kor(app, hermes, 'update_issue', { identifier: E.identifier, title: 'HL5 c' }).then((r) => r.status),
      );
      expect(titel, 'titelrättelsen väntade på hierarkilåset').toBe(200);
      const status = await svarInom(
        kor(app, hermes, 'update_issue_state', { identifier: E.identifier, state_typ: 'started' }).then((r) => r.status),
      );
      expect(status, 'statusbytet väntade på hierarkilåset').toBe(200);
      await X.query('ROLLBACK');

      // (d) Anropet håller hierarkilåset i sin egen transaktion medan det väntar på radlåset och skriver: den andra
      // anslutningen får inte låset förrän anropet har committat. Kontroll: samma anrop på samma ärende, i samma
      // läge men utan parent, håller inget lås, och den andra anslutningen får det direkt. F har efter det första
      // anropet en förälder, så kontrollens UPDATE nämner foralder_id utan att byta värdet. Hade låset tagits i en
      // annan transaktion än anropets, eller först efter radlåset, hade den andra anslutningen fått det direkt
      // också med parent.
      expect(await hallerLaset({ parent: A.identifier }), '(d) med parent').toEqual({ vantade: true, status: 200 });
      expect(await lagradForalder(F.id)).toBe(A.id);
      expect(await hallerLaset({ title: 'HL5 d' }), '(d) utan parent').toEqual({ vantade: false, status: 200 });

      // (e) Nyckeln gäller per tenant också i tjänstelagret: medan X håller låset för en annan tenant svarar samma
      // slags förälderändring som i (a) inom två sekunder. Den skiljer sig från (a) bara i tenanten som X låser.
      await taLaset(ANNAN_TENANT);
      const perTenant = await svarInom(
        kor(app, hermes, 'update_issue', { identifier: G.identifier, parent: A.identifier }).then((r) => r.status),
      );
      expect(perTenant, '(e) förälderändringen väntade på en annan tenants lås').toBe(200);
      await X.query('ROLLBACK');
      expect(await lagradForalder(G.id)).toBe(A.id);
    } finally {
      await X.query('ROLLBACK').catch(() => undefined);
      await annan.query('ROLLBACK').catch(() => undefined);
      await X.end();
      await annan.end();
      await vakt.end();
    }
  });

  it('HL6 (AK 2): kontroll — kedjevandringen hittar en påhittad cykel och ingenting utan den', () => {
    expect(
      cykelfel([
        { id: 'x', foralder_id: 'y' },
        { id: 'y', foralder_id: 'x' },
        { id: 'z', foralder_id: null },
      ]),
    ).toEqual(['cykel genom x', 'cykel genom y']);
    expect(
      cykelfel([
        { id: 'x', foralder_id: 'y' },
        { id: 'y', foralder_id: null },
      ]),
    ).toEqual([]);
  });

  // Ett it per varv: i ett gemensamt it hade varven delat en enda tidsgräns (lärdomen ur Story 1.1:s F12).
  it.each(varvlista(25))(
    'HL6 (AK 2): (1) A under B och B under A samtidigt ger exakt en vinnare och ingen cykel: varv %i',
    async (n) => {
      const A = await nytt(`HL6 (1) A ${n}`);
      const B = await nytt(`HL6 (1) B ${n}`);
      const rakning = await raknaRader('events');
      const [forA, forB] = await Promise.all([
        kor(app, david, 'update_issue', { identifier: A.identifier, parent: B.identifier }),
        kor(app, hermes, 'update_issue', { identifier: B.identifier, parent: A.identifier }),
      ]);
      const statusar = [forA.status, forB.status];
      // 500 är svaret som 40P01 ger, eftersom errorHandler inte översätter koden.
      expect(statusar, `varv ${n}: ${JSON.stringify([forA.body, forB.body])}`).not.toContain(500);
      expect([...statusar].sort((x, y) => x - y), `varv ${n}`).toEqual([200, 409]);
      const avvisad = forA.status === 409 ? forA : forB;
      expect(avvisad.body.error, `varv ${n}`).toBe('rule_violation');
      expect(await raknaRader('events'), `varv ${n}: bara vinnarens andrade_foralder`).toBe(rakning + 1);
      const foraldrar = [await lagradForalder(A.id), await lagradForalder(B.id)];
      expect(foraldrar, `varv ${n}`).toEqual(forA.status === 200 ? [B.id, null] : [null, A.id]);
      expect(cykelfel(await allaKedjor()), `varv ${n}`).toEqual([]);
    },
  );

  it.each(varvlista(20))(
    'HL6 (AK 2): (2) förälderändring och titelrättelse på den nya föräldern svarar båda 200: varv %i',
    async (n) => {
      const P = await nytt(`HL6 (2) P ${n}`);
      const A = await nytt(`HL6 (2) A ${n}`);
      const B = await nytt(`HL6 (2) B ${n}`);
      await foralderTill(A.identifier, P.identifier);
      const titel = `HL6 varv ${n}`;
      const [flytt, rattelse] = await Promise.all([
        kor(app, hermes, 'update_issue', { identifier: B.identifier, parent: A.identifier }),
        kor(app, david, 'update_issue', { identifier: A.identifier, title: titel }),
      ]);
      expect([flytt.status, rattelse.status], `varv ${n}: ${JSON.stringify([flytt.body, rattelse.body])}`)
        .toEqual([200, 200]);
      expect(await lagradForalder(B.id), `varv ${n}`).toBe(A.id);
      const { rows } = await pool.query<{ title: string }>('SELECT title FROM issues WHERE id = $1', [A.id]);
      expect(rows[0]!.title, `varv ${n}`).toBe(titel);
    },
  );

  it.each(varvlista(20))(
    'HL6 (AK 2): (3) förälderändring och statusbyte på den nya föräldern svarar båda 200: varv %i',
    async (n) => {
      const P = await nytt(`HL6 (3) P ${n}`);
      const A = await nytt(`HL6 (3) A ${n}`);
      const B = await nytt(`HL6 (3) B ${n}`);
      await foralderTill(A.identifier, P.identifier);
      const [flytt, statusbyte] = await Promise.all([
        kor(app, hermes, 'update_issue', { identifier: B.identifier, parent: A.identifier }),
        kor(app, david, 'update_issue_state', { identifier: A.identifier, state_typ: 'started' }),
      ]);
      expect([flytt.status, statusbyte.status], `varv ${n}: ${JSON.stringify([flytt.body, statusbyte.body])}`)
        .toEqual([200, 200]);
      expect(await lagradForalder(B.id), `varv ${n}`).toBe(A.id);
    },
  );

  it('HL7 (AK 2): låsfunktionen anropas bara från tjänstefilen, före radlåset, och låsnyckeln står inte under src', () => {
    const filer = kallfilerISrc();
    expect(filer.map((f) => f.fil), 'hittade inga källfiler').toContain(TJANSTEFILEN);
    expect(lasplatsfel(filer)).toEqual([]);

    // Kontroll: den rätta påhittade källan ger inget, och var och en av de tre ändringarna ger exakt sitt fynd.
    expect(lasplatsfel(RATT_KALLA)).toEqual([]);
    expect(lasplatsfel(ANROPET_EFTER_RADLASET)).toEqual(['taHierarkilaset( står inte före hamtaArendeForAndring(']);
    expect(lasplatsfel(NYCKELN_I_TVA_FILER)).toEqual(['issues_ta_hierarkilas står i 2 filer']);
    expect(lasplatsfel(LASET_I_TJANSTEN)).toEqual(['pg_advisory_xact_lock står i services/insats.ts']);
  });
});

describe('FR-28/Story 6.4 AK 3: cykelspärren gäller i alla vägar, också ägarrollens (regression)', () => {
  it('HL4 (AK 3): den omskrivna triggerfunktionen fäller cykeln, självfallet och djupet också för ägarrollen', async () => {
    const A = await nytt('HL4 A');
    const B = await nytt('HL4 B');
    const C = await nytt('HL4 C');
    await foralderTill(B.identifier, A.identifier);
    await foralderTill(C.identifier, B.identifier);
    const agare = await adminKlient();
    try {
      await expect(agare.query('UPDATE issues SET foralder_id = $1 WHERE id = $2', [C.id, A.id]))
        .rejects.toMatchObject({ code: 'P0001', message: CIRKULAR });
      await expect(agare.query('UPDATE issues SET foralder_id = id WHERE id = $1', [A.id]))
        .rejects.toMatchObject({ code: 'P0001', message: CIRKULAR });
      expect(await lagradForalder(A.id)).toBeNull();

      const kedja = await byggKedja('HL4', 101, 970000);
      expect(kedja).toHaveLength(101);
      const underKedjan = (foralder: Nytt, nummer: number, titel: string) =>
        agare.query(
          `INSERT INTO issues (tenant_id, team_id, state_id, sequence_number, title, foralder_id)
           SELECT tenant_id, team_id, state_id, $2::int, $3::text, $4::uuid FROM issues WHERE id = $1`,
          [kedja[0]!.id, nummer, titel, foralder.id],
        );
      await expect(underKedjan(kedja[100]!, 970200, 'HL4 N')).rejects.toMatchObject({ code: 'P0001', message: DJUP });
      // Kontroll: samma INSERT ett steg högre upp godtas (numret skiljer sig bara för unikhetens skull).
      expect((await underKedjan(kedja[99]!, 970201, 'HL4 N2')).rowCount).toBe(1);
    } finally {
      await agare.end();
    }
  });

  it('HL8 (AK 3): update_issue avvisar cykeln, självfallet och djupet med 409 rule_violation och noll händelserader', async () => {
    const A = await nytt('HL8 A');
    const B = await nytt('HL8 B');
    const C = await nytt('HL8 C');
    await foralderTill(B.identifier, A.identifier);
    await foralderTill(C.identifier, B.identifier);

    const avvisas = async (arende: Nytt, parent: string): Promise<void> => {
      const fore = await raknaRader('events');
      const svar = await kor(app, hermes, 'update_issue', { identifier: arende.identifier, parent });
      expect(svar.status, `${arende.identifier} under ${parent}: ${JSON.stringify(svar.body)}`).toBe(409);
      expect(svar.body.error, `${arende.identifier} under ${parent}`).toBe('rule_violation');
      expect(await raknaRader('events'), `${arende.identifier} under ${parent}: händelserader`).toBe(fore);
      expect(await lagradForalder(arende.id), `${arende.identifier} under ${parent}`).toBeNull();
    };
    await avvisas(A, C.identifier);
    await avvisas(A, A.identifier);

    const kedja = await byggKedja('HL8', 101, 960000);
    expect(kedja).toHaveLength(101);
    await avvisas(await nytt('HL8 N'), kedja[100]!.identifier);

    // Kontroll: samma anrop ett steg högre upp i kedjan godtas och skriver en händelserad.
    const N2 = await nytt('HL8 N2');
    const fore = await raknaRader('events');
    const svar = await kor(app, hermes, 'update_issue', { identifier: N2.identifier, parent: kedja[99]!.identifier });
    expect(svar.status, JSON.stringify(svar.body)).toBe(200);
    expect(await raknaRader('events')).toBe(fore + 1);
    expect(await lagradForalder(N2.id)).toBe(kedja[99]!.id);
  });
});

// ---- Uppgift 3: relationerna, bilagorna och milstolpen ----------------------------------------------------

/** Kolumnerna i schemat public vars namn innehåller estimat, estimate, cycle eller cykel, som tabell.kolumn. */
const ESTIMAT_OCH_CYKEL = `
  SELECT c.relname::text || '.' || a.attname::text AS kolumn
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
     AND a.attname ~* '(estimat|estimate|cycle|cykel)'
   ORDER BY 1`;

describe('FR-28/Story 6.4 AK 4: relationer, bilagor och milstolpe (regression)', () => {
  it('HL9 (AK 4): inga dubbletter av relationer och bilagor, en förälder, milstolpen och inga kolumner för estimat och cykel', async () => {
    const X = await nytt('HL9 X');
    const Y = await nytt('HL9 Y');
    const senasteVerb = async (): Promise<string> =>
      (await pool.query<{ verb: string }>('SELECT verb FROM events ORDER BY id DESC LIMIT 1')).rows[0]!.verb;

    const relationerFore = await raknaRader('issue_relations');
    const lank = { fran: X.identifier, till: Y.identifier, typ: 'blocks' };
    const forstaLank = await kor(app, hermes, 'link_issues', lank);
    expect(forstaLank.status, JSON.stringify(forstaLank.body)).toBe(200);
    expect(forstaLank.body.result.nyskapad).toBe(true);
    const andraLank = await kor(app, hermes, 'link_issues', lank);
    expect(andraLank.status, JSON.stringify(andraLank.body)).toBe(200);
    expect(andraLank.body.result.nyskapad).toBe(false);
    expect(await senasteVerb()).toBe('lank_fanns_redan');
    expect(await raknaRader('issue_relations')).toBe(relationerFore + 1);

    const bilagorFore = await raknaRader('issue_attachments');
    const bilaga = {
      identifier: X.identifier,
      titel: 'HL9 bilaga',
      url: 'https://exempel.se/hl9',
      source_ref: 'hl9-bilaga-ett',
    };
    const forstaBilaga = await kor(app, hermes, 'add_attachment', bilaga);
    expect(forstaBilaga.status, JSON.stringify(forstaBilaga.body)).toBe(200);
    expect(forstaBilaga.body.result.nyskapad).toBe(true);
    const andraBilaga = await kor(app, hermes, 'add_attachment', bilaga);
    expect(andraBilaga.status, JSON.stringify(andraBilaga.body)).toBe(200);
    expect(andraBilaga.body.result.nyskapad).toBe(false);
    expect(await senasteVerb()).toBe('bilagan_fanns_redan');
    expect(await raknaRader('issue_attachments')).toBe(bilagorFore + 1);

    // Högst en förälder: exakt en främmande nyckel från issues till issues, på kolumnen foralder_id.
    const { rows: nycklar } = await pool.query<{ kolumner: string[] }>(
      `SELECT array(SELECT a.attname::text FROM unnest(k.conkey) AS nr
                      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = nr) AS kolumner
         FROM pg_constraint k
        WHERE k.contype = 'f' AND k.conrelid = 'issues'::regclass AND k.confrelid = 'issues'::regclass`,
    );
    expect(nycklar).toEqual([{ kolumner: ['foralder_id'] }]);
    // En ny förälder ersätter den gamla.
    const P1 = await nytt('HL9 P1');
    const P2 = await nytt('HL9 P2');
    await foralderTill(X.identifier, P1.identifier);
    const byte = await kor(app, hermes, 'update_issue', { identifier: X.identifier, parent: P2.identifier });
    expect(byte.status, JSON.stringify(byte.body)).toBe(200);
    expect(byte.body.result.arende.foralder_identifier).toBe(P2.identifier);

    const satt = await kor(app, hermes, 'update_issue', { identifier: Y.identifier, milstolpe: 'HL9 milstolpe' });
    expect(satt.status, JSON.stringify(satt.body)).toBe(200);
    expect(satt.body.result.arende.milstolpe).toBe('HL9 milstolpe');
    const nollad = await kor(app, hermes, 'update_issue', { identifier: Y.identifier, milstolpe: null });
    expect(nollad.status, JSON.stringify(nollad.body)).toBe(200);
    expect(nollad.body.result.arende.milstolpe).toBeNull();

    expect((await pool.query<{ kolumn: string }>(ESTIMAT_OCH_CYKEL)).rows.map((r) => r.kolumn)).toEqual([]);
    // Kontroll: i en ägartransaktion som rullas tillbaka ger en tillagd kolumn exakt ett fynd.
    const agare = await adminKlient();
    try {
      await agare.query('BEGIN');
      try {
        await agare.query('ALTER TABLE issues ADD COLUMN cycle_id integer');
        expect((await agare.query<{ kolumn: string }>(ESTIMAT_OCH_CYKEL)).rows.map((r) => r.kolumn))
          .toEqual(['issues.cycle_id']);
      } finally {
        await agare.query('ROLLBACK');
      }
    } finally {
      await agare.end();
    }
  });
});
