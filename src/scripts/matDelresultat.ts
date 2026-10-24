// Mäter dagens delresultatspärrar: varje huvudåtagande som barnräkningen spärrade, med delärendenas
// nummer och delåtagandenas läge (FR-16 delkrav 5, B-07; Story 5.5 AK 8–9).
//
//   npx tsx src/scripts/matDelresultat.ts
//
// När förkravet i drift har lagt raden i package.json är kommandot `npm run matning:delresultat`
// (tsx src/scripts/matDelresultat.ts).
//
// Varför skriptet finns: Story 5.5 byter barnräkningen mot märkta nödvändiga delresultat, och ett
// delresultat märks bara med actionen marka_nodvandigt_delresultat, aldrig härlett ur hierarkin
// (Davids svar 2026-10-16 kl. 13.21). Listan är underlaget för märkningen i drift direkt efter
// driftsättningen: varje listat delärende märks eller lämnas omärkt med ett antecknat skäl. Ett listat
// huvudåtagande i läget genomfort har redovisats efter spärrbytet eller före ett senare delärende, och
// dess händelser läses med get_issue (AK 9). Mätningen läser bara issues och teams, så den ger samma
// lista före migrationen 0018 som efter. Skriptet märker ingenting och rättar ingenting.
//
// Läsande genom konstruktion: transaktionen börjar med SET TRANSACTION READ ONLY, så Postgres avvisar
// varje skrivning i den (SQLSTATE 25006). Skriptet ansluter som rollen app genom poolen och läser
// ingen miljövariabel själv; src/config.ts är fortfarande den enda som gör det.
//
// Utskriften: en rad per huvudåtagande, `<huvudärende> <läge>: <delärende> <läge>[, <delärende> <läge>]`,
// och sist `Antal: <N>`, antalet huvudåtaganden. Ett fynd är ingen felkod (kod 0): mätningen är underlag
// och ingen grind. Ett fel ger `FATAL: …` på stderr, kod 1 och ingen rad Antal. En mätning som inte
// kunde göras får aldrig se ut som noll spärrar (NFR-6).
import { closePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { TENANT_ID } from '../lib/tenant.js';
import { matDelresultat } from '../services/atagande.js';

try {
  const sparrar = await withTransaction(async (client) => {
    // Första satsen efter BEGIN; därefter avvisar Postgres varje skrivning i transaktionen.
    await client.query('SET TRANSACTION READ ONLY');
    return matDelresultat(client, TENANT_ID);
  });
  for (const s of sparrar) {
    const delarenden = s.delarenden.map((d) => `${d.identifier} ${d.lage}`).join(', ');
    console.log(`${s.identifier} ${s.lage}: ${delarenden}`);
  }
  // Sist, och först när mätningen returnerat: ett fel ovan når aldrig hit.
  console.log(`Antal: ${sparrar.length}`);
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
