// FR-20, Story 7.3: sviten rör aldrig driftdatabasen. globalSetup() är den enda ingången före varje
// provfil, och vakten testdatabasfel() är första satsen efter applyTestEnv(), före första klienten. Kastar
// globalSetup() startar vitest ingen provfil, så ingen databas skapas eller tas bort (test/setup.ts körs
// aldrig). Ändra inte ordningen, och lägg aldrig en anslutning före vakten.
import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { applyTestEnv, TEST_DB_NAME, TEST_TEMPLATE_DB_NAME } from './env.js';

// Utvecklings- och driftklustrets port (docker-compose.yml, compose-projektet `arenden`;
// docs/project-context.md rad 33). Sviten får aldrig nå den. Exporteras, så att test/grind.test.ts (G7)
// binder den till porten som docker-compose.yml publicerar.
export const DRIFTENS_PORT = 5435;

// Adresserna som sviten ansluter med, i den ordning globalSetup() använder dem. Underhållsadressen ska peka
// på underhållsdatabasen och de andra två på TEST_DB_NAME (test/env.ts). Listan exporteras, så att G7
// binder den till adresserna som applyTestEnv() sätter.
export const TESTADRESSERNA = ['MAINTENANCE_DATABASE_URL', 'DATABASE_ADMIN_URL', 'DATABASE_URL'] as const;
const UNDERHALLSDATABASEN = 'postgres';

// Postgres längsta namn i byte (NAMEDATALEN - 1); ett längre namn kortas tyst. Mallens ändelse är den som
// test/env.ts bildar TEST_TEMPLATE_DB_NAME med. Ett namn får ha högst 54 byte, så att också mallens namn
// står okortat. Båda exporteras, så att G7 binder dem till testklustret och till test/env.ts.
export const POSTGRES_NAMNGRANS = 63;
export const MALLENS_ANDELSE = '_template';
const NAMNETS_STORSTA_LANGD = POSTGRES_NAMNGRANS - MALLENS_ANDELSE.length;

/**
 * Vakten (FR-20, Story 7.3): fynden mot svitens databasnamn och adresser, en tom lista när de godtas. Gör
 * inga anslutningar och läser inget annat än argumenten. Fynden, i ordning:
 *  1. namnet har andra tecken än gemener, siffror och understreck. Det är en tillåtelselista: namnet står
 *     oquotat i DROP DATABASE och CREATE DATABASE, och Postgres kör flera satser i en sträng, så namnet
 *     som prövas är exakt det som körs;
 *  2. namnet slutar inte på `_test`;
 *  3. namnet är längre än 54 byte. Postgres kortar tyst ett namn över 63 byte, så utan gränsen hade servern
 *     fått ett annat namn än det prövade, och vid 63 byte hade `<namn>_template` kortats till namnet självt;
 *  4. för varje adress i TESTADRESSERNA, i listans ordning, högst ett fynd per adress (adressfel()).
 */
export function testdatabasfel(databasnamn: string, miljo: Record<string, string | undefined>): string[] {
  const fel: string[] = [];
  if (!/^[a-z0-9_]+$/.test(databasnamn)) {
    fel.push(`TEST_DB_NAME "${databasnamn}" har andra tecken än gemener, siffror och understreck`);
  }
  if (!databasnamn.endsWith('_test')) fel.push(`TEST_DB_NAME "${databasnamn}" slutar inte på _test`);
  if (Buffer.byteLength(databasnamn) > NAMNETS_STORSTA_LANGD) {
    fel.push(
      `TEST_DB_NAME "${databasnamn}" är längre än ${NAMNETS_STORSTA_LANGD} byte, och Postgres kortar då ` +
        `mallnamnet till ${POSTGRES_NAMNGRANS} byte`,
    );
  }
  for (const namn of TESTADRESSERNA) {
    const databas = namn === 'MAINTENANCE_DATABASE_URL' ? UNDERHALLSDATABASEN : databasnamn;
    const fyndet = adressfel(miljo[namn], databas);
    if (fyndet) fel.push(`${namn} ${fyndet}`);
  }
  return fel;
}

/**
 * Adressens första fel, eller null när adressen godtas. Reglerna är en tillåtelselista för formen
 * postgres://användare@värd:port/databas, så att vakten läser samma port och databas som pg. pg
 * (pg-connection-string) tar värd, port, användare och databas ur frågedelen före adressens egna, läser
 * databasen ur sökvägen, läser schemat socket: på ett annat sätt och tar en tom del ur miljön (PGPORT,
 * PGDATABASE), som vakten inte ser. Fynden, i ordning:
 *  1. adressen saknas eller är tom;
 *  2. den går inte att läsa som URL;
 *  3. den saknar uttrycklig port. Ett tomt TEST_PG_PORT ger en sådan adress, eftersom `??` i test/env.ts
 *     bara ersätter ett saknat värde;
 *  4. den pekar på DRIFTENS_PORT;
 *  5. den har en frågedel eller ett fragment (tecknet ? eller #);
 *  6. den är inte en postgres-adress i normalform: schemat är inte postgres:, eller texten är inte exakt den
 *     som URL-tolkningen skriver ut. Det fäller det som tolkningen tar bort eller skriver om men pg läser på
 *     ett annat sätt, som ett inledande blanksteg, som pg kodar innan den tolkar adressen;
 *  7. den pekar på en annan databas än `databas`.
 */
function adressfel(varde: string | undefined, databas: string): string | null {
  if (!varde) return 'saknas';
  let url: URL;
  try {
    url = new URL(varde);
  } catch {
    return 'går inte att läsa som adress';
  }
  if (url.port === '') return 'saknar port';
  if (Number(url.port) === DRIFTENS_PORT) return `pekar på porten ${DRIFTENS_PORT}, driftdatabasens port`;
  if (/[?#]/.test(varde)) return 'har en frågedel eller ett fragment';
  if (url.protocol !== 'postgres:' || url.href !== varde) return 'är inte en postgres-adress i normalform';
  if (url.pathname !== `/${databas}`) return `pekar på databasen "${url.pathname.slice(1)}", inte "${databas}"`;
  return null;
}

export default async function globalSetup(): Promise<void> {
  applyTestEnv();

  // Vakten först, före första klienten (filens huvud).
  const fel = testdatabasfel(TEST_DB_NAME, process.env);
  if (fel.length > 0) throw new Error('testsviten vägrar databasen: ' + fel.join('; '));

  // Färsk databas varje körning — migrationskedjan bevisas mot ett tomt schema.
  const admin = new pg.Client({ connectionString: process.env.MAINTENANCE_DATABASE_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_DB_NAME}`);

  const resultat = await migrate(process.env.DATABASE_ADMIN_URL!);
  console.log(
    `[globalSetup] färsk databas ${TEST_DB_NAME}: ${resultat.applied.length} migrationer körda`,
  );

  // Ögonblicksbild av den migrerade databasen som MALL. Varje testfil återskapar
  // TEST_DB_NAME från mallen i sitt beforeAll (test/setup.ts) — ingen fil kan
  // läcka tillstånd in i nästa, och sviten blir oberoende av filordning.
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_TEMPLATE_DB_NAME} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEST_TEMPLATE_DB_NAME} TEMPLATE ${TEST_DB_NAME}`);
  await admin.end();
}
