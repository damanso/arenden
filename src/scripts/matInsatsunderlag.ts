// Mäter insatsernas handlingskontrakt före rättningen (D-2, B-22; Story 11.3 AK 5): varje insats i tenanten i
// exakt en av fyra grupper, med ärende och underlaget «/uppfoljning», med ärende och ett eget underlag, utan
// ärende men med en källa som är ett ärendenummer, och utan ärende.
//
//   npx tsx src/scripts/matInsatsunderlag.ts
//
// När förkravet i drift har lagt raden i package.json är kommandot `npm run matning:insatsunderlag`
// (tsx src/scripts/matInsatsunderlag.ts). Bygget ändrar inte package.json, och provet kör skriptfilen med tsx.
//
// Varför skriptet finns: läsvägarna härleder underlaget ur ärendet, men bara för en insats som har ett ärende.
// En insats som registrerades utan identifier pekar fortfarande på det allmänna underlaget, och hur många de
// är och vilka ärenden deras källor pekar ut är omätt. Mät först, rätta sedan: listan är underlaget för
// rättningen, som görs bara med actionen koppla_insats_till_arende, med händelserad, aldrig med rå SQL.
// Skriptet rättar ingenting och skriver inga befintliga rader om. Gruppen utan_arende lämnas, eftersom det
// saknas belägg för vilket ärende de hör till.
//
// Läsande genom konstruktion: transaktionen börjar med SET TRANSACTION READ ONLY, så Postgres avvisar varje
// skrivning i den (SQLSTATE 25006). Skriptet ansluter som rollen app genom poolen och läser ingen
// miljövariabel själv; src/config.ts är fortfarande den enda som gör det.
//
// Utskriften: en rad per insats, `<grupp>\t<id>`, och för arendekalla `<grupp>\t<id>\t<ärendenummer>` med
// ärendenumren åtskilda av kommatecken, grupperna i ordningen arende_uppfoljning, arende_eget, arendekalla
// och utan_arende. Därefter fyra rader `<grupp>: <antal>` i samma ordning, också när antalet är 0, och sist
// `Antal: <N>`, summan. Ett fynd är ingen felkod (kod 0): mätningen är underlag och ingen grind. Ett fel ger
// `FATAL: …` på stderr, kod 1 och ingen rad Antal. En mätning som inte kunde göras får aldrig se ut som noll
// insatser (NFR-6).
import { closePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { TENANT_ID } from '../lib/tenant.js';
import { matInsatsunderlag } from '../services/insats.js';

try {
  const matning = await withTransaction(async (client) => {
    // Första satsen efter BEGIN; därefter avvisar Postgres varje skrivning i transaktionen.
    await client.query('SET TRANSACTION READ ONLY');
    return matInsatsunderlag(client, TENANT_ID);
  });
  // Id:na är uuid och ärendenumren identifierare, så inget fält kan bära en tabb eller en radbrytning.
  const rader = [
    ...matning.arende_uppfoljning.map((id) => ['arende_uppfoljning', id]),
    ...matning.arende_eget.map((id) => ['arende_eget', id]),
    ...matning.arendekalla.map((k) => ['arendekalla', k.id, k.arenden.join(',')]),
    ...matning.utan_arende.map((id) => ['utan_arende', id]),
  ];
  for (const rad of rader) console.log(rad.join('\t'));
  const antal: [string, number][] = [
    ['arende_uppfoljning', matning.arende_uppfoljning.length],
    ['arende_eget', matning.arende_eget.length],
    ['arendekalla', matning.arendekalla.length],
    ['utan_arende', matning.utan_arende.length],
  ];
  for (const [grupp, n] of antal) console.log(`${grupp}: ${n}`);
  // Sist, och först när mätningen returnerat: ett fel ovan når aldrig hit.
  console.log(`Antal: ${rader.length}`);
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
