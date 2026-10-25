// Mäter referenstyperna som ärendekortet visar (D-4, B-25; Story 11.5 AK 1): varje typ med antal i
// åtagandets referenser (grund, nästa stegs grund, villkorens källa och belägg, hindrets belägg,
// resultatets belägg och avslutsskälets grund) och i insatsernas belägg, och varje par av system och
// objekttyp med antal i insatsernas källor.
//
//   npx tsx src/scripts/matReferenstyper.ts
//
// När förkravet i drift har lagt raden i package.json är kommandot `npm run matning:referenstyper`
// (tsx src/scripts/matReferenstyper.ts).
//
// Varför skriptet finns: kortet avgör hur en referens länkas ur den slutna tabellen REFERENSLANK i
// src/http/vy/kort.ts, och en typ som tabellen inte känner visas som «typ · id» utan länk och utelämnas
// aldrig. Tabellen sattes ur koden och fixturernas mätning, eftersom skriptet byggs i samma berättelse
// som tabellen; driftens typer mäts efter driftsättningen (arkitekturens driftordning, punkt 4). Visar
// mätningen en typ som pekar på ett ärende, ett valvdokument eller en adress under ett annat namn, förs
// den in i tabellen genom correct-course. Skriptet rättar ingenting och skriver inga befintliga rader om.
//
// Läsande genom konstruktion: transaktionen börjar med SET TRANSACTION READ ONLY, så Postgres avvisar
// varje skrivning i den (SQLSTATE 25006). Skriptet ansluter som rollen app genom poolen och läser ingen
// miljövariabel själv; src/config.ts är fortfarande den enda som gör det.
//
// Utskriften: en rad per post, `referens\t<bärare>\t<typ>\t<antal>` med `(saknas)` när typen saknas, och
// `kalla\t<system>\t<objekttyp>\t<antal>`, och sist `Antal: <N>`, antalet rader. Tabb, vagnretur och
// radbrytning i ett fält skrivs som ett blanksteg var, så att en rad alltid är en post med fyra fält. En
// okänd typ är ingen felkod (kod 0): mätningen är underlag och ingen grind. Ett fel ger `FATAL: …` på
// stderr, kod 1 och ingen rad Antal. En mätning som inte kunde göras får aldrig se ut som noll referenser
// (NFR-6).
import { closePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import { TENANT_ID } from '../lib/tenant.js';
import { matReferenstyper } from '../services/arendekort.js';

/** Ett fält på raden: varje tabb, vagnretur och radbrytning blir ett blanksteg. */
const falt = (varde: string): string => varde.replace(/[\t\r\n]/g, ' ');

try {
  const matning = await withTransaction(async (client) => {
    // Första satsen efter BEGIN; därefter avvisar Postgres varje skrivning i transaktionen.
    await client.query('SET TRANSACTION READ ONLY');
    return matReferenstyper(client, TENANT_ID);
  });
  const rader = [
    ...matning.referenser.map((r) => ['referens', r.barare, r.typ ?? '(saknas)', String(r.antal)]),
    ...matning.kallor.map((k) => ['kalla', k.system, k.objekttyp, String(k.antal)]),
  ];
  for (const rad of rader) console.log(rad.map(falt).join('\t'));
  // Sist, och först när mätningen returnerat: ett fel ovan når aldrig hit.
  console.log(`Antal: ${rader.length}`);
} catch (err) {
  console.error(`FATAL: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
