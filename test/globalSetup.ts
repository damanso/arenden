import pg from 'pg';
import { migrate } from '../src/db/migrate.js';
import { applyTestEnv, TEST_DB_NAME, TEST_TEMPLATE_DB_NAME } from './env.js';

export default async function globalSetup(): Promise<void> {
  applyTestEnv();

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
