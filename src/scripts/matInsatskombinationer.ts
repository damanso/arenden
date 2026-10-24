// Mäter befintliga insatser vars kombination av typ och kommando KOMMANDOTABELL avvisar (FR-27,
// B-09; Story 6.3 AK 4).
//
//   npx tsx src/scripts/matInsatskombinationer.ts
//
// Varför skriptet finns: grinden i registreraInsats prövar varje ny registrering mot tabellen, men
// rader som registrerades före grinden eller av ägarrollen står kvar, och hur många de är är omätt.
// Listan är underlaget för kanalen Beslutskön, som ändrar sina anropare. Skriptet rättar ingenting
// och skriver inga befintliga rader om. Det har inget npm-skript, eftersom bygget inte ändrar
// package.json.
//
// Läsande genom konstruktion: transaktionen börjar med SET TRANSACTION READ ONLY, så Postgres
// avvisar varje skrivning i den (SQLSTATE 25006). Skriptet ansluter som rollen app genom poolen
// och läser ingen miljövariabel själv; src/config.ts är fortfarande den enda som gör det.
//
// Utskriften: en rad per fynd, `<stopp>\t<typ>\t<läge>\t<kommando>` med `(saknas)` när kommandot
// saknas, och sist `Antal: <N>`. Tabb, vagnretur och radbrytning i ett fält skrivs som ett blanksteg
// var, så att en rad alltid är ett fynd med fyra fält. Ett fynd är ingen felkod (kod 0): mätningen
// är underlag och ingen grind. Ett fel ger `FATAL: …` på stderr, kod 1 och ingen rad Antal. En
// mätning som inte kunde göras får aldrig se ut som noll fynd (NFR-6).
import { closePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { TENANT_ID } from '../lib/tenant.js';
import { matInsatskombinationer } from '../services/insats.js';

/** Ett fält på raden: varje tabb, vagnretur och radbrytning blir ett blanksteg. */
const falt = (varde: string): string => varde.replace(/[\t\r\n]/g, ' ');

try {
  const fynd = await withTransaction(async (client) => {
    // Första satsen efter BEGIN; därefter avvisar Postgres varje skrivning i transaktionen.
    await client.query('SET TRANSACTION READ ONLY');
    return matInsatskombinationer(client, TENANT_ID);
  });
  for (const f of fynd) {
    console.log([f.stopp_id, f.typ, f.lage, f.kommando ?? '(saknas)'].map(falt).join('\t'));
  }
  // Sist, och först när mätningen returnerat: ett fel ovan når aldrig hit.
  console.log(`Antal: ${fynd.length}`);
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
