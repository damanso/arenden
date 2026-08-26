// Mintar en API-nyckel. Utan en nyckel går det inte att skriva någonting alls
// (KRAV-10), så den här vägen in måste finnas — men den går ALDRIG via API:t.
//
//   npm run nyckel -- <manniska|agent|system> <namn> [--fil <sökväg>]
//
// K-1 rättade två saker här.
//
// 1. ROLLEN. Skriptet anslöt förut som ÄGARROLLEN (DATABASE_ADMIN_URL först).
//    Det behövdes aldrig: app-rollen har INSERT på api_keys och på events, och
//    det är allt som krävs. Att minta identiteter som ägaren gav skriptet rätt
//    att göra vad som helst med schemat under tiden — en rättighet ingen bad
//    om. Nu ansluter det som `app`, och att kommandot fungerar är samtidigt ett
//    bevis på att app-rollen räcker.
//
// 2. SPÅRET. Skriptet skrev INGEN händelserad. Att skapa en aktörsidentitet —
//    alltså rätten att skriva i systemet under ett namn — var den enda
//    mutationen i hela plattformen som inte syntes någonstans. Nu skrivs
//    api_keys-raden och dess event-rad i SAMMA transaktion, precis som varje
//    annan mutation (KRAV-8).
//
//    Aktören på den raden är `system` / `skapa-nyckel`, inte den identitet som
//    skapas: händelsen är att SKRIPTET utfärdade en identitet, och identiteten
//    som utfärdades står i payloaden. Att stämpla raden med den nya aktören
//    hade varit att låta någon signera sin egen födelseattest — och den första
//    nyckeln i ett tomt system har per definition ingen tidigare aktör att
//    hänvisa till.
//
// Läser env direkt (samma undantag som migrations-CLI:t).
import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import pg from 'pg';
import type { AktorTyp } from '../lib/validation.js';
import { TENANT_ID } from '../lib/tenant.js';
import { skrivHandelse } from '../services/handelser.js';
import { skapaNyckel } from '../services/nycklar.js';

function avbryt(text: string): never {
  console.error(text);
  process.exit(1);
}

const argv = process.argv.slice(2);
const filFlagga = argv.indexOf('--fil');
const angivenFil = filFlagga === -1 ? undefined : argv[filFlagga + 1];
const positionella =
  filFlagga === -1 ? argv : [...argv.slice(0, filFlagga), ...argv.slice(filFlagga + 2)];

const [raTyp, ...namnDelar] = positionella;
const namn = namnDelar.join(' ');

if (raTyp !== 'manniska' && raTyp !== 'agent' && raTyp !== 'system') {
  avbryt('Användning: npm run nyckel -- <manniska|agent|system> <namn> [--fil <sökväg>]');
}
const typ: AktorTyp = raTyp;

if (!namn) avbryt('FATAL: aktörens namn måste anges (det är namnet som hamnar i events)');
if (filFlagga !== -1 && !angivenFil) avbryt('FATAL: --fil kräver en sökväg');

// Ägarrollen används INTE (se punkt 1 ovan).
const url = process.env.DATABASE_URL;
if (!url) avbryt('FATAL: DATABASE_URL måste vara satt (den lågprivilegierade rollen `app`)');

/** Filnamn utan tecken som behöver citeras i ett skal. */
function slugga(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[åä]/g, 'a')
    .replace(/ö/g, 'o')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'aktor';
}

async function utfarda(): Promise<{ nyckel: string; id: string }> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // api_keys-raden och dess händelserad i SAMMA transaktion — utfärdandet är
    // en mutation som vilken annan och får inte kunna committa utan sitt spår.
    await client.query('BEGIN');
    const utfardad = await skapaNyckel(client, TENANT_ID, { typ, namn });
    await skrivHandelse(
      client,
      TENANT_ID,
      { typ: 'system', namn: 'skapa-nyckel' },
      {
        issueId: null,
        verb: 'skapade_aktorsidentitet',
        // Identiteten som utfärdades — ALDRIG nyckeln och aldrig hashen.
        payload: { nyckel_id: utfardad.id, ny_aktor_typ: typ, ny_aktor_namn: namn },
      },
    );
    await client.query('COMMIT');
    return utfardad;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ursprungsfelet är det som betyder något.
    }
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const stampel = new Date().toISOString().replace(/[:.]/g, '-');
const malfil =
  angivenFil ??
  path.join(homedir(), '.arenden', 'nycklar', `${typ}-${slugga(namn)}-${stampel}.nyckel`);

const utfardad = await utfarda().catch((err: unknown) =>
  avbryt(`FATAL: ${err instanceof Error ? err.message : String(err)}`),
);

// Nyckeln skrivs ALDRIG till stdout. Terminalutdata hamnar i skalhistorik, i
// loggar, i en agents transkript och i klippbufferten — och en hemlighet som
// passerat något av dem är inte längre en hemlighet. Den går till EN fil som
// bara ägaren kan läsa; det är den enda gången den finns i klartext.
try {
  await mkdir(path.dirname(malfil), { recursive: true, mode: 0o700 });
  await writeFile(malfil, `${utfardad.nyckel}\n`, { mode: 0o600, flag: 'wx' });
} catch (err) {
  console.error(
    `FATAL: kunde inte skriva nyckelfilen ${malfil}: ${err instanceof Error ? err.message : err}`,
  );
  avbryt(`Nyckeln är utfärdad men oåtkomlig. Återkalla nyckel-id ${utfardad.id} i /vy/rattelser.`);
}

console.log(`OK: nyckel skapad för ${typ} "${namn}".`);
console.log(`Nyckel-id: ${utfardad.id} (händelseraden skapade_aktorsidentitet är skriven).`);
console.log('Endast hashen lagras. Nyckeln i klartext finns i EN fil, läsbar bara av dig:');
console.log(`  ${malfil}`);
console.log('Läs den en gång och radera den sedan:');
console.log(`  cat '${malfil}' && shred -u '${malfil}'`);
