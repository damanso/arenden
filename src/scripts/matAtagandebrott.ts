// Mäter öppna åtaganden som saknar nästa steg eller uppföljningstid (FR-16 delkrav 2 och 6,
// B-07; Story 5.1 AK 7–8).
//
//   npm run atagandebrott      (tsx src/scripts/matAtagandebrott.ts)
//
// Varför skriptet finns: invarianten ligger i tjänstelagret och inte som CHECK (B-07). Vakten
// kravOppetSteg fäller varje ny skrivning genom API:t, men rader som skrevs före den eller av
// ägarrollen står kvar, och hur många de är är omätt. En NOT VALID-CHECK hade fällt varje senare
// UPDATE av en sådan rad, också en titelrättning. Därför mäts de här, och varje listat åtagande
// får nasta och foljs_upp med andra_atagande ur sitt eget underlag eller lämnas över (AK 8).
// Skriptet backfyller ingenting och rättar ingenting.
//
// Läsande genom konstruktion: transaktionen börjar med SET TRANSACTION READ ONLY, så Postgres
// avvisar varje skrivning i den (SQLSTATE 25006). Skriptet ansluter som rollen app genom poolen
// och läser ingen miljövariabel själv; src/config.ts är fortfarande den enda som gör det.
//
// Utskriften: en rad per brott, `<ärendenummer> <läge> saknar <fält>[, <fält>]`, och sist
// `Antal: <N>`. Ett fynd är ingen felkod (kod 0): mätningen är underlag och ingen grind. Ett fel
// ger `FATAL: …` på stderr, kod 1 och ingen rad Antal. En mätning som inte kunde göras får aldrig
// se ut som noll brott (NFR-6).
import { closePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { TENANT_ID } from '../lib/tenant.js';
import { matAtagandebrott } from '../services/atagande.js';

try {
  const brott = await withTransaction(async (client) => {
    // Första satsen efter BEGIN; därefter avvisar Postgres varje skrivning i transaktionen.
    await client.query('SET TRANSACTION READ ONLY');
    return matAtagandebrott(client, TENANT_ID);
  });
  for (const b of brott) console.log(`${b.identifier} ${b.lage} saknar ${b.saknas.join(', ')}`);
  // Sist, och först när mätningen returnerat: ett fel ovan når aldrig hit.
  console.log(`Antal: ${brott.length}`);
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
