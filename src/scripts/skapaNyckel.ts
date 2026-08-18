// Mintar en API-nyckel. Utan en nyckel går det inte att skriva någonting alls
// (KRAV-10), så den här vägen in måste finnas — men den går ALDRIG via API:t.
//
// Läser env direkt (samma undantag som migrations-CLI:t) och ansluter som
// ägarrollen, eftersom nyckelutdelning är en ops-åtgärd och inte en app-åtgärd.
//
//   npm run nyckel -- <manniska|agent|system> <namn>
import 'dotenv/config';
import pg from 'pg';
import { TENANT_ID } from '../lib/tenant.js';
import { hashaNyckel, slumpaNyckel } from '../services/nycklar.js';

const [typ, ...namnDelar] = process.argv.slice(2);
const namn = namnDelar.join(' ');

if (typ !== 'manniska' && typ !== 'agent' && typ !== 'system') {
  console.error('Användning: npm run nyckel -- <manniska|agent|system> <namn>');
  process.exit(1);
}
if (!namn) {
  console.error('FATAL: aktörens namn måste anges (det är namnet som hamnar i events)');
  process.exit(1);
}

const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('FATAL: DATABASE_ADMIN_URL (eller DATABASE_URL) måste vara satt');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const nyckel = slumpaNyckel();
  await client.query(
    `INSERT INTO api_keys (tenant_id, nyckelhash, aktor_typ, aktor_namn) VALUES ($1, $2, $3, $4)`,
    [TENANT_ID, hashaNyckel(nyckel), typ, namn],
  );
  console.log(`OK: nyckel skapad för ${typ} "${namn}".`);
  console.log('Endast hashen lagras — nyckeln visas här EN gång:');
  console.log(nyckel);
} finally {
  await client.end();
}
