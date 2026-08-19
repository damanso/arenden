import { tmpdir } from 'node:os';
import path from 'node:path';

// Testmiljö för globalSetup (huvudprocessen) och setup.ts (varje testworker).
//
// VIKTIGT (KRAV-19): värdena sätts med `=` — ALDRIG `??=`. En utvecklares .env
// hinner laddas av dotenv innan detta körs, och med `??=` hade testsviten då
// kunnat köra mot utvecklingsdatabasen på 5435 (eller värre). Explicit omval
// sker via TEST_*-variabler, inte via .env.
export const TEST_DB_NAME = process.env.TEST_DB_NAME ?? 'arenden_test';
// Mall-databas: migreras EN gång i globalSetup och används sedan för att
// återskapa TEST_DB_NAME färsk före varje testfil.
export const TEST_TEMPLATE_DB_NAME = `${TEST_DB_NAME}_template`;

const HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
// 5436 = testdatabasen i compose-projektet `arenden-test`. Aldrig 5435
// (utveckling) och aldrig 5433 (redovisningen).
const PORT = process.env.TEST_PG_PORT ?? '5436';

// Sätter SAMTLIGA variabler i EnvSchema (src/config.ts) — även de som har
// default där — så att sviten är självförsörjande på ren maskin och ingen
// utvecklar-.env kan påverka någon av dem.
// Testvault för dokumentlänkarna — ALDRIG den riktiga /home/hermes/brain.
// Sökvägen är deterministisk så att globalSetup, workers och testfilen är
// överens; test/dokumentlankar.test.ts bygger innehållet i sitt beforeAll.
export const TEST_VAULT = path.join(tmpdir(), 'arenden-test-vault');

export function applyTestEnv(): void {
  process.env.NODE_ENV = 'test';
  process.env.VAULT_PATH = TEST_VAULT;
  process.env.HOST = '127.0.0.1';
  process.env.PORT = '3002';
  process.env.DATABASE_URL = `postgres://app@${HOST}:${PORT}/${TEST_DB_NAME}`;
  process.env.DATABASE_ADMIN_URL = `postgres://postgres@${HOST}:${PORT}/${TEST_DB_NAME}`;
  process.env.MAINTENANCE_DATABASE_URL = `postgres://postgres@${HOST}:${PORT}/postgres`;
  // Testerna gör många anrop i följd — rate-limitern testas inte här.
  process.env.RATE_LIMIT_PER_MINUTE = '100000';
  process.env.ARENDEN_API_URL = `http://127.0.0.1:3002`;
  // Adaptern kräver en aktörsnyckel vid import (KRAV-10). Värdet är en
  // uppenbar attrapp — tester som verkligen skriver skapar egna nycklar.
  process.env.ARENDEN_API_KEY = 'test-nyckel-ej-giltig';
}
