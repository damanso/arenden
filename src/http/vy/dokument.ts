// Vaultens läsyta i vyn (Dokumentlänkar). Enda modulen som rör /home/hermes/brain
// — och den LÄSER bara.
//
// FYRA invarianter, som granskaren kan läsa av rakt här:
//   1. VITLISTA (KRAV-2): endast katalogerna i VITLISTA finns för vyn. Allt
//      annat — jag.md, journal/, 02-Områden/hälsa/, 05-Dagligt/, .git,
//      .obsidian — ger samma tomma svar som ett dokument som inte finns. Vyn
//      bekräftar aldrig att något utanför området existerar.
//   2. Sökvägen prövas TVÅ gånger: som text (inga '..', '//', måste sluta .md,
//      måste ligga under vitlistan) och som upplöst realpath (symlink som pekar
//      ut ur vaulten, eller in i en icke-vitlistad katalog, faller bort).
//   3. Filnamnsindexet är RENT en cache (TTL ~10 min) för autolänkningen —
//      renderingen gör aldrig egna filsystemssökningar (KRAV-5).
//   4. PRIVATA (R5, D-4, B-25; Story 11.5): de privata områdena står uppräknade
//      en gång, och privatKalla är ärendekortets enda prövning av en referens
//      mot dem. Varje referens som kortet visar frågar den först, och en privat
//      referens ersätts med en fast mening. Prövningen läser referensen i varje
//      form som en läsare, URL-tolken, Obsidian eller autolänkaren läser den, och
//      ett led är en följd av namntecken ur en tillåtelselista. Prövningen är ren
//      text: ingen fil, inget index och ingen miljö, och /vy/dok svarar som förut
//      ur VITLISTA.
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

/**
 * R5 (PRD §5): de privata områdena, samma uppräkning som invariant 1 ovan. Ändras bara medvetet, som
 * VITLISTA. En post som slutar med snedstreck är en katalog, de andra är en fil.
 */
export const PRIVATA = ['jag.md', 'journal/', '02-Områden/hälsa/', '05-Dagligt/', '.git/', '.obsidian/'] as const;

/**
 * Var en referens delas i led: vid varje tecken som inte är ett namntecken. Namntecknen är en
 * tillåtelselista: bokstäver, siffror, kombinerande tecken, punkt, bindestreck och understreck. Allt annat
 * skiljer två led, bland annat snedstreck och bakstreck, blanktecken, frågetecken, et-tecken,
 * likhetstecken, nummertecken, kolon, procenttecken (det står bara kvar i en följd som inte gick att
 * avkoda), hakparenteser, lodstreck, parenteser, citattecken, vinkelparenteser, komma och semikolon. Ett
 * tecken intill ett privat led kan alltså aldrig dölja ledet, som «[[journal/…]]», «Källa: jag.md» eller
 * «jag.md » med ett blanksteg sist (Story 11.5, granskningsfynd 3).
 */
const LEDGRANS = /[^\p{L}\p{N}\p{M}._-]+/u;
/**
 * Tecken som inte syns eller som URL-tolken tar bort var de än står: tabb, radbrytning och vagnretur
 * (WHATWG URL) och Unicodes osynliga tecken (Default_Ignorable_Code_Point, till exempel mjukt bindestreck
 * och nollbrett mellanrum). Texten prövas också utan dem, så att «jo<tabb>urnal» läses som ledet journal,
 * som URL-tolken läser det (granskningsfynd 2).
 */
const OSYNLIGA = new RegExp(String.raw`[\t\n\r\p{Default_Ignorable_Code_Point}]`, 'gu');
/** En följd av procentkodade tecken, som avkodas för sig. */
const PROCENTFOLJD = /(?:%[0-9A-Fa-f]{2})+/g;
/** Tre varv avkodning: en dubbelkodad referens blir läsbar efter det andra. */
const AVKODNINGSVARV = 3;
/** Wikilänkens mål, före rubriken och aliaset: [[mål#rubrik|alias]]. */
const WIKIMAL = /\[\[([^[\]|#]+)/g;
/** Markdownlänkens mål: [text](mål) och [text](<mål>). */
const MDMAL = /\]\(\s*<?([^()<>\s]+)/g;
/** En frågeparameters filvärde, som obsidian-formen bär det: ?file=…, &path=… eller &filepath=…. */
const FILPARAMETER = /[?&](?:file|filepath|path)=([^&#\s]*)/gi;

/** Texten som leden den består av: gemener, inga tomma led och inget led som bara är en punkt. */
function ledI(text: string, form: 'NFC' | 'NFKC'): string[] {
  return text
    .normalize(form)
    .toLowerCase()
    .normalize(form)
    .split(LEDGRANS)
    .filter((led) => led !== '' && led !== '.')
    .map((led) => (led === '..' ? led : led.replace(/\.+$/, '')))
    .filter((led) => led !== '');
}

/** Leden med varje «..» upplöst mot ledet före, som URL-tolken och en sökväg löser upp dem. */
function upplost(led: readonly string[]): string[] {
  const ut: string[] = [];
  for (const del of led) {
    if (del === '..') ut.pop();
    else ut.push(del);
  }
  return ut;
}

/** Varje post i PRIVATA som en följd av led, delad som referenserna. */
const PRIVATA_LED: readonly (readonly string[])[] = PRIVATA.map((post) => ledI(post, 'NFC'));

/**
 * Varje följd av procentkodade tecken avkodas för sig, tre varv. En följd som inte går att avkoda står
 * kvar; decodeURIComponent kastar URIError för den, och ingenting kastas härifrån.
 */
function avkoda(text: string): string {
  let ut = text;
  for (let varv = 0; varv < AVKODNINGSVARV; varv++) {
    ut = ut.replace(PROCENTFOLJD, (foljd) => {
      try {
        return decodeURIComponent(foljd);
      } catch {
        return foljd;
      }
    });
  }
  return ut;
}

/**
 * Målen i en text som Obsidian och autolänkaren läser utan att ändelsen .md behöver stå: obsidian-formens
 * filvärde, wikilänkens och markdownlänkens mål och hela texten när den saknar blanktecken (ett
 * dokumentmål som en referens id, som losUpp i markdown.ts läser med .md). Rubriken efter nummertecknet,
 * blanktecken runt målet och punkter sist tas bort.
 */
function malI(text: string): string[] {
  const mal: string[] = [];
  for (const m of text.matchAll(FILPARAMETER)) {
    mal.push(new URLSearchParams(`file=${m[1] ?? ''}`).get('file') ?? '');
  }
  for (const m of text.matchAll(WIKIMAL)) mal.push(m[1] ?? '');
  for (const m of text.matchAll(MDMAL)) mal.push(m[1] ?? '');
  if (!/\s/.test(text.trim())) mal.push(text);
  return mal.map((m) => (m.split('#')[0] ?? '').trim().replace(/\.+$/, '')).filter((m) => m !== '');
}

/**
 * Adressen som URL-tolken läser den, alltså exakt det som sakerUrl i mall.ts lägger i ett href: utan tabb
 * och radbrytning, utan blanktecken först och sist och med punktleden upplösta. null när texten inte är en
 * adress.
 */
function urlform(text: string): string | null {
  try {
    return new URL(text).href;
  } catch {
    return null;
  }
}

/**
 * Varje form som referensen kan läsas i: texten som den står och avkodad, varje mål i dem med och utan
 * ändelsen .md (malI), och adressen som URL-tolken läser var och en av dem (urlform).
 */
function formerAv(ref: string): string[] {
  const former = new Set<string>();
  for (const text of [ref, avkoda(ref)]) {
    former.add(text);
    for (const mal of malI(text)) {
      former.add(mal);
      former.add(`${mal}.md`);
    }
  }
  for (const text of [...former]) {
    const href = urlform(text);
    if (href !== null) former.add(href);
  }
  return [...former];
}

/**
 * En forms led i varje läsning: avkodad, med och utan de osynliga tecknen, i NFC och i NFKC (så att
 * fullbreddstecken läses som de vanliga) och med «..» både kvar och upplöst.
 */
function ledlistor(text: string): string[][] {
  const avkodad = avkoda(text);
  const listor: string[][] = [];
  for (const variant of [avkodad, avkodad.replace(OSYNLIGA, '')]) {
    for (const form of ['NFC', 'NFKC'] as const) {
      const led = ledI(variant, form);
      listor.push(led, upplost(led));
    }
  }
  return listor;
}

/** Står postens led som en följd var som helst bland referensens led? */
function harFoljd(led: readonly string[], post: readonly string[]): boolean {
  for (let start = 0; start + post.length <= led.length; start++) {
    if (post.every((del, i) => led[start + i] === del)) return true;
  }
  return false;
}

/**
 * R5, D-4, B-25 (Story 11.5 AK 6): ligger referensen i ett privat område? Referensen läses i varje form som
 * en läsare, URL-tolken, Obsidian eller autolänkaren läser den (formerAv och ledlistor), och den är privat
 * när en post i PRIVATA står som en följd av hela led var som helst i någon av dem. Det gör regeln sann för
 * en ren sökväg, en absolut sökväg, en adress, /fil/, /katalog/, /vy/dok/, obsidian-formen, en wikilänk och
 * en markdownlänk, en sökväg i en mening eller med blanksteg runt sig, procentkodad, dubbelkodad, i NFD,
 * med versaler, med fullbreddstecken, med tabb, radbrytning eller osynliga tecken inne i ett led och med
 * punktled, utan att någon form räknas upp. Adressen som ett href får (sakerUrl) är en av formerna, så en
 * länk går aldrig till ett privat område när texten den byggs ur prövats här (granskningsfynd 2).
 *
 * Regeln är restriktiv (Dev Notes → Tolkningar, punkt 6, och project-context: välj det mer restriktiva):
 * ett vitlistat dokument med ett led som heter som en privat post, till exempel en katalog journal under
 * 01-Projekt, räknas också som privat, liksom en titel där ordet journal står som ett eget led. «journalist»
 * eller «hälsning» är andra led och räknas inte. En sökväg med andra tecken som bara liknar en privat
 * (andra bokstäver) är inte samma sökväg för någon av läsarna och räknas inte.
 */
export function privatKalla(ref: string): boolean {
  return formerAv(ref).some((text) =>
    ledlistor(text).some((led) => PRIVATA_LED.some((post) => harFoljd(led, post))),
  );
}

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
