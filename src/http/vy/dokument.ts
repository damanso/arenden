// Vaultens läsyta i vyn (Dokumentlänkar). Enda modulen som rör /home/hermes/brain
// — och den LÄSER bara.
//
// TRE invarianter, som granskaren kan läsa av rakt här:
//   1. VITLISTA (KRAV-2): endast katalogerna i VITLISTA finns för vyn. Allt
//      annat — jag.md, journal/, 02-Områden/hälsa/, 05-Dagligt/, .git,
//      .obsidian — ger samma tomma svar som ett dokument som inte finns. Vyn
//      bekräftar aldrig att något utanför området existerar.
//   2. Sökvägen prövas TVÅ gånger: som text (inga '..', '//', måste sluta .md,
//      måste ligga under vitlistan) och som upplöst realpath (symlink som pekar
//      ut ur vaulten, eller in i en icke-vitlistad katalog, faller bort).
//   3. Filnamnsindexet är RENT en cache (TTL ~10 min) för autolänkningen —
//      renderingen gör aldrig egna filsystemssökningar (KRAV-5).
import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../../config.js';

/** KRAV-2: hela dokumentområdet. Ändras bara medvetet — det här ÄR R5-gränsen. */
export const VITLISTA = [
  '01-Projekt',
  '02-Områden/ledningsgrupp',
  '02-Områden/hermes',
  '02-Områden/linear-arkiv',
  '03-Resurser',
] as const;

/** Filnamn (gemener) → vaultrelativa sökvägar. Fler än en träff = tvetydigt. */
export interface Dokumentindex {
  readonly filnamn: ReadonlyMap<string, readonly string[]>;
}

const TOM: Dokumentindex = { filnamn: new Map() };
const TTL_MS = 10 * 60_000;
const MAX_DJUP = 12;

// Jämförelser sker alltid i NFC — vitlistan innehåller å/ä/ö och en klient kan
// skicka samma tecken dekomponerat.
function nfc(varde: string): string {
  return varde.normalize('NFC');
}

export function vitlistad(rel: string): boolean {
  const norm = nfc(rel);
  return VITLISTA.some((katalog) => norm.startsWith(`${katalog}/`));
}

/**
 * Textprövningen av en begärd sökväg. Returnerar den rena vaultrelativa
 * sökvägen, eller null — och null betyder ALLTID samma sak utåt: 404 utan
 * innehåll och utan katalognamn.
 */
export function sakerSokvag(ra: string): string | null {
  const norm = nfc(ra);
  if (norm === '' || norm.includes('\0') || norm.includes('\\')) return null;
  const delar = norm.split('/');
  // Tom del fångar både '//' och inledande/avslutande '/'.
  if (delar.some((d) => d === '' || d === '.' || d === '..')) return null;
  const rel = delar.join('/');
  if (!rel.toLowerCase().endsWith('.md')) return null;
  return vitlistad(rel) ? rel : null;
}

/**
 * Läser EN fil per anrop. Realpath-kontrollen är det som stoppar symlinkar:
 * den upplösta filen måste ligga inuti vaultroten OCH under vitlistan.
 */
export async function lasDokument(rel: string): Promise<string | null> {
  const rot = await realpath(config.VAULT_PATH).catch(() => null);
  if (rot === null) return null;
  // Andra försöket täcker vaulter vars filnamn ligger dekomponerade på disk.
  const abs =
    (await realpath(path.join(rot, rel)).catch(() => null)) ??
    (await realpath(path.join(rot, rel.normalize('NFD'))).catch(() => null));
  if (abs === null) return null;

  const inuti = path.relative(rot, abs).split(path.sep).join('/');
  if (inuti === '' || inuti.startsWith('..') || path.isAbsolute(inuti)) return null;
  if (!vitlistad(inuti)) return null;
  return readFile(abs, 'utf8').catch(() => null);
}

// ---- Filnamnsindexet (KRAV-5) ---------------------------------------------

let cache: { byggd: number; index: Dokumentindex } | null = null;
let pagaende: Promise<Dokumentindex> | null = null;

/** Färskt index ur cachen; bygger om först när TTL:n gått ut. */
export function hamtaIndex(): Promise<Dokumentindex> {
  if (cache !== null && Date.now() - cache.byggd < TTL_MS) return Promise.resolve(cache.index);
  if (pagaende !== null) return pagaende;
  pagaende = byggIndex().then(
    (index) => {
      cache = { byggd: Date.now(), index };
      pagaende = null;
      return index;
    },
    () => {
      // En oläsbar vault får aldrig välta vyn — den ger bara noll autolänkar.
      cache = { byggd: Date.now(), index: TOM };
      pagaende = null;
      return TOM;
    },
  );
  return pagaende;
}

/** Serverstart: värm indexet UTAN att blockera lyssnandet. */
export function startaIndexbygge(): void {
  void hamtaIndex();
}

/** Bara för testerna: nästa hamtaIndex() bygger om direkt. */
export function nollstallIndex(): void {
  cache = null;
}

async function byggIndex(): Promise<Dokumentindex> {
  const filnamn = new Map<string, string[]>();
  for (const katalog of VITLISTA) await gaIgenom(katalog, filnamn, 0);
  return { filnamn };
}

async function gaIgenom(rel: string, filnamn: Map<string, string[]>, djup: number): Promise<void> {
  if (djup > MAX_DJUP) return;
  const poster = await readdir(path.join(config.VAULT_PATH, rel), { withFileTypes: true }).catch(
    () => null,
  );
  if (poster === null) return;
  for (const post of poster) {
    // Symlinkar följs ALDRIG vid indexeringen — de kan peka ut ur vaulten.
    if (post.name.startsWith('.') || post.isSymbolicLink()) continue;
    const barn = `${rel}/${nfc(post.name)}`;
    if (post.isDirectory()) {
      await gaIgenom(barn, filnamn, djup + 1);
    } else if (post.isFile() && post.name.toLowerCase().endsWith('.md')) {
      const nyckel = nfc(post.name).toLowerCase();
      const lista = filnamn.get(nyckel);
      if (lista === undefined) filnamn.set(nyckel, [barn]);
      else if (!lista.includes(barn)) lista.push(barn);
    }
  }
}
