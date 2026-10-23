// FR-16 delkrav 4 och 6, B-02 (Story 3.2 AK 7 och AK 9): mät ärenden vars
// tillstånd avviker från åtagandets läge. Rader skrivna förbi API:t rättas bara
// med update_issue_state till det härledda målet, aldrig av mätningen.
//
// Kör tills npm-raden finns: tsx src/scripts/matStatusavvikelser.ts
// npm run statusavvikelser kräver skriptraden som ett förkrav i drift.
//
// Läsande genom konstruktion: första satsen är SET TRANSACTION READ ONLY.
// Poolen använder rollen app och konfigurationen läses av src/config.ts.
// Ett fynd är underlag (kod 0). Ett fel ger FATAL, kod 1 och ingen Antal-rad,
// så att en mätning som inte kunde göras aldrig kan se ut som noll fynd (NFR-6).
import { closePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { TENANT_ID } from '../lib/tenant.js';
import { matStatusavvikelser } from '../services/atagande.js';

try {
  const avvikelser = await withTransaction(async (client) => {
    await client.query('SET TRANSACTION READ ONLY');
    return matStatusavvikelser(client, TENANT_ID);
  });
  for (const a of avvikelser) console.log(`${a.identifier} ${a.lage} ${a.state_typ} ska vara ${a.mal}`);
  console.log(`Antal: ${avvikelser.length}`);
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
