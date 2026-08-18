import { afterAll, beforeAll } from 'vitest';
import pg from 'pg';
import { applyTestEnv, TEST_DB_NAME, TEST_TEMPLATE_DB_NAME } from './env.js';

// Körs i varje worker INNAN testfilens imports — config.ts läser env vid import.
applyTestEnv();

// Testisolering: varje testfil får en pristin, migrerad databas. Vi återskapar
// TEST_DB_NAME från mallen INNAN filens egna beforeAll kör — då kan ingen
// tidigare fil läcka tillstånd in i nästa.
//
// Säkerhet: fileParallelism:false (vitest.config.ts) gör att bara en fil kör i
// taget, så DROP/CREATE DATABASE kapplöper aldrig. WITH (FORCE) kopplar bort
// eventuella kvarlämnade sessioner.
beforeAll(async () => {
  const admin = new pg.Client({ connectionString: process.env.MAINTENANCE_DATABASE_URL });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${TEST_DB_NAME} TEMPLATE ${TEST_TEMPLATE_DB_NAME}`);
  } finally {
    await admin.end();
  }
});

afterAll(async () => {
  // Dynamisk import så att poolen inte skapas förrän env är satt.
  const { closePool } = await import('../src/db/pool.js');
  await closePool();
});
