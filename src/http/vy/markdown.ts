// Autolänkning och enkel markdown för vyn (Dokumentlänkar + Markdown i vyn).
//
// TRE regler, och de är samma som resten av vylagret vilar på:
//   1. KRAV-6 (etapp 2a) / KRAV-3 (markdown): ALL text som kommer från
//      databasen eller vaulten går genom esc() i mall.js — EN gång, på hela
//      strängen, INNAN någon konstruktion tolkas. Allt nedanför arbetar därför
//      på en sträng där '<', '>', '&', '"' och '\'' redan är entiteter.
//   2. KRAV-3 (dokumentlänkar): en referens till ett dokument UTANFÖR vitlistan
//      — eller ett filnamn som finns på flera ställen — lämnas som ren text.
//      Ingen markering, ingen titel, inget som avslöjar att dokumentet finns.
//   3. FR-37, B-14 (Story 2.3): en adress vars värd är linear.app eller en
//      underdomän blir aldrig en utåtlänk. linearAdress() avgör, och både
//      markdownlänkarna här och bilageRad() i routes/vy.ts frågar den före
//      sitt href.
//
// VARFÖR ESCAPEN LIGGER FÖRST OCH INTE SIST (KRAV-3, och det viktigaste valet i
// filen): innehållet skrivs av agenter som läser mail, transkript och
// Drive-dokument. Angriparen behöver inte komma åt databasen — det räcker att
// hen kommer åt ett mail som en agent sammanfattar, så angreppsytan är den
// normala driftvägen. En renderare som escapar EFTER omvandlingen måste kunna
// skilja innehållets '<' från sin egen markup, och den skillnaden måste hållas
// korrekt i VARJE konstruktion, även den som läggs till om ett halvår. Escapar
// den före finns det ingen rå HTML kvar att släppa igenom: nästa konstruktion
// ärver säkerheten i stället för att behöva förtjäna den.
//
// Följden för läsaren av den här filen: nedanför esc()-anropet står inte ett
// enda esc() på innehåll. Ser du ett, är det ett fynd — antingen dubbelescapar
// det, eller så kom texten in oescapad.
//
// Autolänkningen sker i RENDERINGSSTEGET. Beskrivningar, kommentarer och
// databasen rörs inte.
//
// D-2, D-5, B-21 (Story 11.2): ett ärendenummer i vilket team och skiftläge som
// helst (ARENDE) blir en länk bara när ärendet finns. Renderarna får mängden
// befintliga nummer som parameter, och anroparen slår upp den en gång per sida
// med befintligaArenden i tjänstelagret — filen har ingen databasåtkomst.
// arendereferens är den enda funktionen som gör ett nummer till markup, och
// därför också den enda som samlar kandidaterna: anroparen kör samma rendering
// först med en insamling (arendekandidater) och sedan med de befintliga numren.
import { arendeSokvag, nummeruppslagSokvag, type Befintliga } from '../../lib/arendelank.js';
import { kanoniskIdentifier } from '../../lib/validation.js';
import { vitlistad, type Dokumentindex } from './dokument.js';
import { esc } from './mall.js';

// Mönstren delas mellan de två lägena och plockas isär via namngivna grupper.
const WIKI = String.raw`\[\[(?<mal>[^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|(?<alias>[^\[\]]*))?\]\]`;
const SOKVAG = String.raw`(?<sokvag>[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*\.md)\b`;
// KRAV-1: originalnamnet på ett speglat kunddokument. Samma teckenklass som
// SOKVAG men UTAN '/', så i en längre Drive-sökväg matchas bara sista segmentet.
const FILNAMN = String.raw`(?<filnamn>[\p{L}\p{N}_][\p{L}\p{N}_.\-]*\.(?:docx|pdf|pptx|xlsx))\b`;
// D-2 (Story 11.2): teamnyckel och nummer i alla team och skiftlägen. Mönstret
// har inget tecken som esc() ändrar, och det står sist i alternationerna, så att
// en sökväg eller ett filnamn som börjar på samma plats vinner.
const ARENDE = String.raw`\b(?<arende>[A-Za-z][A-Za-z0-9]{0,9}-\d+)\b`;
const KOD = String.raw`\x60(?<kod>[^\x60\n]+)\x60`;
const FET = String.raw`\*\*(?<fet>[^*\n]+)\*\*`;
const MDLANK = String.raw`\[(?<mdtext>[^\[\]]+)\]\((?<mdurl>[^()\s]+)\)`;

// Ärendetexter: BARA länkar. Ingen fetstil — ärendebeskrivningarna visas som de
// är skrivna (pre-wrap), precis som i etapp 2a.
const LANKAR = new RegExp(`${WIKI}|${SOKVAG}|${FILNAMN}|${ARENDE}`, 'gu');
// Dokumentsidan: samma länkar plus den lilla markdownen.
const MARKDOWN = new RegExp(
  `${KOD}|${FET}|${WIKI}|${MDLANK}|${SOKVAG}|${FILNAMN}|${ARENDE}`,
  'gu',
);

export function dokUrl(rel: string): string {
  return `/vy/dok/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

// ---- FR-37, B-14 (Story 2.3): Linear-adresser blir aldrig utåtlänkar ------

/** Svaret för en Linear-adress: ärendenumret i sökvägen, eller null utan nummer. */
export type LinearAdress = { nummer: string | null };

/** Metan för en Linear-adress med nummer, som nu är en intern länk. */
export const TIDIGARE_LINEAR_LANK = 'tidigare Linear-länk';
/** Metan för en Linear-adress utan nummer, som nu är ren text. */
export const AVVECKLAD_LINEAR_LANK = 'Linear-länk — Linear är avvecklat';
/** D-2 (Story 11.2): efter en länk till nummeruppslaget, när teamet finns men inte numret. */
export const FINNS_INTE = '(finns inte)';

const LINEARVARD = 'linear.app';
const LINEARNUMMER = /^LOC-\d+$/;

/**
 * FR-37: «inga länkar till Linear». Plattformen är källan, och en kvarglömd
 * adress till Linear i en bilaga eller ett dokument får inte bli en väg dit.
 *
 * Värden läses ur URL-tolkens hostname, aldrig ur adressens text: tolken har
 * redan gjort värden till gemener och skilt den från schema, användarnamn och
 * port, så versaler, `f23@` eller `:443` avgör aldrig. En avslutande punkt står
 * kvar i hostname och tas bort här. En textsökning efter «linear.app» hade
 * gått att kringgå åt båda hållen (notlinear.app, example.com/linear.app).
 *
 * Bara http och https klassas: inget annat schema blir ett href på de två
 * ställen som frågar (sakerUrl() och markdownlänkarnas schemaprov).
 *
 * Numret räknas bara som ett HELT segment i sökvägen, med versaler och teamet
 * LOC, som Linear skrev det. Linears ärendeadresser har numret som eget segment;
 * ett nummer i frågan eller inne i ett längre segment är inget ärende, och en
 * sådan adress blir ren text i stället för en gissad länk.
 */
export function linearAdress(adress: string): LinearAdress | null {
  let tolkad: URL;
  try {
    tolkad = new URL(adress);
  } catch {
    return null;
  }
  if (tolkad.protocol !== 'http:' && tolkad.protocol !== 'https:') return null;
  const vard = tolkad.hostname.replace(/\.$/, '');
  if (vard !== LINEARVARD && !vard.endsWith(`.${LINEARVARD}`)) return null;
  const nummer = tolkad.pathname.split('/').find((segment) => LINEARNUMMER.test(segment));
  return { nummer: nummer ?? null };
}

// ---- D-2, B-21 (Story 11.2): en länk till ett ärende bara när det finns ----

/**
 * Insamlingen av kandidater (arendekandidater): arendereferens antecknar varje
 * nummer den får i kanonisk form, i stället för att slå upp det.
 */
class Insamling {
  private readonly nummer = new Set<string>();

  samla(identifier: string): void {
    const k = kanoniskIdentifier(identifier);
    if (k !== null) this.nummer.add(k);
  }

  kandidater(): string[] {
    return [...this.nummer];
  }
}

/** Vad renderarna slår upp ett nummer i: de befintliga numren, eller en insamling av kandidaterna. */
export type Uppslag = Befintliga | Insamling;

/**
 * Den ENDA byggaren av markup för ett ärendenummer: autolänkaren, linearlank()
 * och bilageRad() i routes/vy.ts anropar den. `visad` är redan escapad text och
 * skrivs som den är. Finns ärendet blir numret en länk till ärendet; finns
 * teamet men inte numret blir det en länk till nummeruppslaget i /vy/sok med
 * «(finns inte)»; ett okänt team ger null, och anroparen skriver vanlig text.
 * esc() kring sökvägarna är, som i dokumentlank(), ett bälte kring en adress
 * vi själva byggt.
 *
 * Under insamlingen antecknas numret och svaret är null. Vilka nummer som når
 * hit beror aldrig på svaret, eftersom genererad markup aldrig skannas om; så
 * insamlingen ser exakt de nummer som renderingen sedan slår upp.
 */
export function arendereferens(visad: string, identifier: string, uppslag: Uppslag): string | null {
  if (uppslag instanceof Insamling) {
    uppslag.samla(identifier);
    return null;
  }
  const k = kanoniskIdentifier(identifier);
  if (k === null) return null;
  if (uppslag.arenden.has(k)) return `<a href="${esc(arendeSokvag(k))}">${visad}</a>`;
  if (uppslag.team.has(k.slice(0, k.indexOf('-')))) {
    return `<a href="${esc(nummeruppslagSokvag(k))}">${visad}</a> ${FINNS_INTE}`;
  }
  return null;
}

/**
 * Kandidaterna att slå upp: `rendera` är sidans egen rendering, och den körs här
 * med en insamling. Svaret är varje nummer som arendereferens fick, i kanonisk
 * form och utan dubbletter, och markupen kastas. Kandidaterna tas alltså inte
 * fram av ett eget mönsterpass över texten: ett sådant pass delar inte upp
 * texten som renderaren gör (kursiv med understreck, `_LOC-504_`, där ordgränsen
 * bara finns i delsträngen) och ser inte adressen som URL-tolken normaliserat
 * (en bilaga med tabb eller radbrytning i numret). Med samma rendering är varje
 * nummer som sidan slår upp en kandidat, genom konstruktion.
 */
export function arendekandidater(rendera: (uppslag: Uppslag) => unknown): string[] {
  const insamling = new Insamling();
  rendera(insamling);
  return insamling.kandidater();
}

/**
 * Autolänkaren ensam: escape, sedan de fyra mönstren. Ärendevyn går numera via
 * renderaArendetext() (som lägger markdown mellan de två stegen), men den här
 * funktionen är fortfarande steg 3 i sin renaste form och används som
 * referenspunkt när autolänkningen ska bevisas oförändrad (KRAV-5).
 */
export function autolanka(text: string, index: Dokumentindex, uppslag: Uppslag): string {
  return lankaEscapad(esc(text), index, LANKAR, uppslag);
}

/**
 * Steg 3: autolänkning av REDAN ESCAPAD text.
 *
 * En traversering, aldrig två: matchningarna byggs till HTML och texten mellan
 * dem skrivs ut som den är — den är escapad sedan steg 1. Genererad HTML
 * skannas därför aldrig om, och ingen textbit escapas två gånger.
 *
 * Mönstren matchar lika bra på escapad text: ingen av de fyra teckenklasserna
 * innehåller '&' eller ';', så en entitet delar aldrig upp en träff som förut
 * var hel (och tvärtom).
 */
function lankaEscapad(saker: string, index: Dokumentindex, monster: RegExp, uppslag: Uppslag): string {
  let ut = '';
  let sist = 0;
  monster.lastIndex = 0;
  for (const m of saker.matchAll(monster)) {
    ut += saker.slice(sist, m.index);
    ut += ersatt(m.groups ?? {}, m[0], index, uppslag);
    sist = m.index + m[0].length;
  }
  return ut + saker.slice(sist);
}

// Motsatsen till esc(), och ENBART för uppslagning: en referens som ska slås upp
// mot vitlistan måste jämföras med sitt ursprungliga tecken ([[Avtal & bilagor]]
// heter inte "Avtal &amp; bilagor" på disken). Resultatet går bara in i
// losUpp() och skrivs ALDRIG ut — det är därför den här funktionen inte är ett
// hål i regeln ovanför.
const ENTITET: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function avesc(saker: string): string {
  return saker.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITET[e]!);
}

/** Alla textbitar här in är escapade och skrivs ut oförändrade. */
function ersatt(
  g: Record<string, string | undefined>,
  hel: string,
  index: Dokumentindex,
  uppslag: Uppslag,
): string {
  // Dokumentsidans kod inline länkas som ärendetextens (beslut #42, D-2 Story
  // 11.2 AK 6): bara länkmönstren, aldrig formatering, och sökvägar går genom
  // vitlistan som all annan text.
  if (g['kod'] !== undefined) return `<code>${lankaEscapad(g['kod'], index, LANKAR, uppslag)}</code>`;
  if (g['fet'] !== undefined) return `<b>${g['fet']}</b>`;
  if (g['mal'] !== undefined) {
    const alias = g['alias']?.trim();
    const text = alias === undefined || alias === '' ? g['mal'] : alias;
    return dokumentlank(avesc(g['mal']), text, hel, index);
  }
  if (g['mdurl'] !== undefined) {
    const url = g['mdurl'];
    const text = g['mdtext'] ?? url;
    // Bara http(s) släpps ut som extern länk — aldrig javascript:/data:.
    if (/^https?:\/\//i.test(url)) {
      // FR-37, B-14 (Story 2.3): avesc() bara för klassningen, som för
      // losUpp() — den avkodade adressen skrivs aldrig ut.
      const linear = linearAdress(avesc(url));
      if (linear !== null) return linearlank(text, linear, uppslag);
      return `<a href="${url}" rel="noreferrer noopener">${text}</a>`;
    }
    return dokumentlank(avesc(url), text, hel, index);
  }
  if (g['sokvag'] !== undefined) return dokumentlank(g['sokvag'], g['sokvag'], hel, index);
  // spegellank() rörs inte: FILNAMN:s teckenklass innehåller inget tecken som
  // esc() rör, så dess egna esc()-anrop är identitet på escapad indata.
  if (g['filnamn'] !== undefined) return spegellank(g['filnamn'], hel, index);
  if (g['arende'] !== undefined) {
    // D-2 (Story 11.2): numret slås upp i uppslaget. Texten står kvar som den
    // skrevs (loc-503 visas som loc-503); ARENDE innehåller inget escapat tecken.
    return arendereferens(g['arende'], g['arende'], uppslag) ?? hel;
  }
  return hel;
}

function dokumentlank(
  mal: string,
  text: string,
  hel: string,
  index: Dokumentindex,
): string {
  const rel = losUpp(mal, index);
  // KRAV-3: utanför vitlistan eller tvetydigt → ren text, oskiljaktigt från
  // vilken annan text som helst.
  if (rel === null) return hel;
  // rel kommer ur det vitlistade indexet, inte ur innehållet; esc() här är
  // därför inte innehållsescape utan ett bälte kring en URL vi själva byggt.
  return `<a href="${esc(dokUrl(rel))}">${text}</a>`;
}

/**
 * FR-37, B-14 (Story 2.3): en markdownlänk till Linear. Länktexten står kvar så
 * att meningen går att läsa, och metan står inom parentes efter den, eftersom
 * löptexten inte har någon metaklass. text är redan escapad, och numret är
 * LOC-\d+, som esc() lämnar orört; båda skrivs därför som de är, liksom
 * konstanterna (F1 i test/linear-lankar.test.ts visar att esc() lämnar dem).
 *
 * D-2 (Story 11.2): numret går genom arendereferens, som för ett befintligt
 * ärende ger samma markup som förut, för ett nummer som inte finns en länk till
 * nummeruppslaget med «(finns inte)», och för ett okänt team numret som text.
 */
function linearlank(text: string, adress: LinearAdress, uppslag: Uppslag): string {
  if (adress.nummer === null) return `${text} (${AVVECKLAD_LINEAR_LANK})`;
  const referens = arendereferens(adress.nummer, adress.nummer, uppslag) ?? adress.nummer;
  return `${text} (${referens}, ${TIDIGARE_LINEAR_LANK})`;
}

// ---- KRAV-2: speglade kunddokument ----------------------------------------

/** Speglingen dokument_index.py skriver till — enda katalogen som får länkas. */
const KUNDDOKUMENT = '03-Resurser/kunddokument/';
const ORIGINALANDELSE = /\.(?:docx|pdf|pptx|xlsx)$/;

/**
 * `Konsultavtal_NVR_Locollabs.docx` → spegeln under kunddokument. KRAV-3: ett
 * ospeglat eller tvetydigt originalnamn förblir ren text — ingen markering,
 * ingen titel, och ingen filsystemsåtkomst; bara det redan byggda indexet.
 */
function spegellank(namn: string, hel: string, index: Dokumentindex): string {
  const spegel = `${namn.replace(ORIGINALANDELSE, '')}.md`.normalize('NFC').toLowerCase();
  const traffar = (index.filnamn.get(spegel) ?? []).filter((rel) =>
    rel.normalize('NFC').startsWith(KUNDDOKUMENT),
  );
  if (traffar.length !== 1) return esc(hel);
  return `<a href="${esc(dokUrl(traffar[0]!))}">${esc(namn)}</a>`;
}

/** Referens → vaultrelativ sökväg, eller null när den inte får länkas. */
function losUpp(ra: string, index: Dokumentindex): string | null {
  const utan = ra.split('#')[0]!.trim().replace(/^\.\//, '');
  if (utan === '' || utan.split('/').some((d) => d === '' || d === '.' || d === '..')) return null;
  const rel = (utan.toLowerCase().endsWith('.md') ? utan : `${utan}.md`).normalize('NFC');
  if (rel.includes('/')) return vitlistad(rel) ? rel : null;
  // (d) Rent filnamn: bara EN träff i indexet får bli länk. Indexet innehåller
  // enbart vitlistade kataloger, så en träff är alltid tillåten.
  const traffar = index.filnamn.get(rel.toLowerCase());
  return traffar !== undefined && traffar.length === 1 ? traffar[0]! : null;
}

// ---- Markdown i ärendevyn (KRAV-1..12) -------------------------------------
//
// KRAV-10: renderaren är egen och liten, inget npm-beroende. Skälet är inte
// stolthet utan räkning: ett markdownbibliotek drar in angreppsyta och
// uppdateringsskuld för ÅTTA konstruktioner, i en yta som redan kör med
// `Content-Security-Policy: script-src 'none'` just för att den inte litar på
// sitt eget innehåll. Åtta konstruktioner ryms i den här filen; ett bibliotek
// gör det inte.
//
// KRAV-1, delmängden, är EXAKT: fetstil, kursiv, kod inline, rubrik (nivå 2–4),
// blockcitat, punktlista, numrerad lista, horisontell linje. Datan avgjorde:
// fetstil 150 ärenden, kod inline 72, punktlista 67, numrerad 28, blockcitat 24,
// rubrik 11, kursiv 8, hr 6 — och tabell 1, som därför INTE byggs.
// Allt annat är text (KRAV-2), inklusive markdownlänkar: autolänkaren äger
// länkar, och två system som skapar <a> ur samma text är en angreppsyta utan
// vinst (KRAV-4).

/** KRAV-11: över den här gränsen renderas inte alls, bara escapas. */
const MAX_TECKEN = 200_000;
/** KRAV-11: djupare nästling än så plattas till. */
const MAX_DJUP = 6;

// Steg 2, inline. KOD står FÖRST och vinner alltid: inne i kod inline sker
// aldrig markdown — en asterisk i ett kodexempel ska stå kvar som asterisk.
// LÄNKNING sker däremot (beslut #42, David 2026-08-24): `LOC-339` i en kodsnutt
// blir en länk, precis som `LOC-339` i en rubrik. Ursprungliga KRAV-6 förbjöd
// båda, vilket antog att en sökväg i backticks är ett exempel — i den här
// datan är den nästan alltid en referens, och regeln kostade 18,9 % av
// länkarna.
//
// Den dubbla backticken finns för att en kodsnutt ska kunna innehålla en
// enkel backtick. Lookaheaden `(?!\x60\x60)` gör inte bara mönstret korrekt
// utan också linjärt: ett oavslutat `` kan bara backtracka till lägen där
// lookaheaden redan sagt nej, så varje backtrack faller på första tecknet.
const KOD_DUBBEL = String.raw`\x60\x60(?<kod2>(?:(?!\x60\x60)[^\n])+)\x60\x60`;
const KOD_ENKEL = String.raw`\x60(?<kod1>[^\x60\n]+)\x60`;
// Fetstil får spänna över en radbrytning INNE i ett stycke — så skriver
// agenterna faktiskt (LOC-337: "**fem genomförda broker-möten → …\n… 28/9.**").
// Kursiv får det INTE: en ensam asterisk är ett vanligt tecken i löptext, och
// två orelaterade asterisker på olika rader ska inte hitta varandra. Två
// asterisker i rad är sällan en slump; en är det ofta.
const FETSTIL = String.raw`\*\*(?<fet2>[^*]+)\*\*`;
const KURSIV = String.raw`\*(?<kursiv>[^*\n]+)\*`;
// Understreck bara vid ordgräns: Konsultavtal_NVR_Locollabs och 01_Kunder är
// filnamn i den här datan, inte kursiv text.
const KURSIV_UNDER = String.raw`(?<![\p{L}\p{N}_])_(?<kursivu>[^_\n]+)_(?![\p{L}\p{N}_])`;
const INLINE = new RegExp(
  `${KOD_DUBBEL}|${KOD_ENKEL}|${FETSTIL}|${KURSIV}|${KURSIV_UNDER}`,
  'gu',
);

// Steg 2, block. Mönstren är skrivna mot ESCAPAD text — därför är blockcitatets
// markör `&gt;` och inte `>`. Det är inte en fulhet utan hela poängen: skrev
// agenten `&gt;` i klartext blir det `&amp;gt;` efter escapen och kan alltså
// inte längre låtsas vara ett blockcitat.
const CITAT = /[ \t]*&gt;[ \t]?/y;
const RUBRIK = /^(#{1,6})[ \t]+(.*)$/;
const LINJE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
const PUNKT = /^[ \t]*[-*+][ \t]+(.*)$/;
const NUMRERAD = /^[ \t]*\d+[.)][ \t]+(.*)$/;

/**
 * Beskrivning och kommentar i ärendevyn.
 *
 * Ordningen är escape → markdown → autolänkning (KRAV-5), och esc() nedan är
 * det enda stället i hela kedjan där innehåll escapas.
 *
 * `uppslag` har ingen standardparameter (D-2, Story 11.2): en renderare utan
 * kunskap om vad som finns hade länkat till ärenden som inte finns.
 */
export function renderaArendetext(text: string, index: Dokumentindex, uppslag: Uppslag): string {
  const saker = esc(text);
  // KRAV-11: en vy som visar asterisker är bättre än en vy som kraschar, och en
  // vy som visar 200 000 tecken text är bättre än en som lägger sekunder på att
  // tolka dem. Kommentaren står i markupen så att den som ser rådata i vyn
  // förstår varför den ser oformaterad ut.
  if (text.length > MAX_TECKEN) {
    return `<!-- över ${MAX_TECKEN} tecken: visas oformaterad -->` + `<p>${saker}</p>`;
  }
  try {
    return block(saker.split(/\r?\n/), index, uppslag);
  } catch {
    return `<p>${saker}</p>`;
  }
}

/** Antal blockcitatsmarkörer på raden, och raden utan dem. */
function citatdjup(rad: string): { djup: number; rest: string } {
  CITAT.lastIndex = 0;
  let djup = 0;
  let slut = 0;
  // Sticky exec nollställer lastIndex när den misslyckas — spara den själv.
  while (CITAT.exec(rad) !== null) {
    djup++;
    slut = CITAT.lastIndex;
  }
  return { djup, rest: rad.slice(slut) };
}

function block(rader: readonly string[], index: Dokumentindex, uppslag: Uppslag): string {
  const ut: string[] = [];
  let stycke: string[] = [];
  let lista: 'ul' | 'ol' | null = null;
  let citat = 0;

  const stangStycke = (): void => {
    if (stycke.length > 0) {
      ut.push(`<p>${inline(stycke.join('\n'), index, 0, uppslag)}</p>`);
      stycke = [];
    }
  };
  const stangLista = (): void => {
    if (lista !== null) {
      ut.push(`</${lista}>`);
      lista = null;
    }
  };
  const oppnaLista = (typ: 'ul' | 'ol'): void => {
    if (lista !== typ) {
      stangLista();
      ut.push(`<${typ}>`);
      lista = typ;
    }
  };
  const citatTill = (mal: number): void => {
    if (mal === citat) return;
    stangStycke();
    stangLista();
    while (citat > mal) {
      ut.push('</blockquote>');
      citat--;
    }
    while (citat < mal) {
      ut.push('<blockquote>');
      citat++;
    }
  };

  for (const rad of rader) {
    const { djup, rest } = citatdjup(rad);

    if (rest.trim() === '') {
      stangStycke();
      stangLista();
      citatTill(0);
      continue;
    }
    // KRAV-11: 200 nästlade blockcitat blir 6. Djupet plattas, texten blir kvar.
    citatTill(Math.min(djup, MAX_DJUP));

    if (LINJE.test(rest)) {
      stangStycke();
      stangLista();
      ut.push('<hr>');
      continue;
    }

    const rubrik = RUBRIK.exec(rest);
    // KRAV-7: sidan äger h1 och h2. Nivå 2→h3, 3→h4, 4 och djupare→h5. Nivå 1
    // ingår inte i KRAV-1:s delmängd (nivå 2–4) och blir text som allt annat
    // som inte stöds.
    if (rubrik !== null && rubrik[1]!.length >= 2) {
      stangStycke();
      stangLista();
      const niva = Math.min(rubrik[1]!.length + 1, 5);
      ut.push(`<h${niva}>${inline(rubrik[2]!.trim(), index, 0, uppslag)}</h${niva}>`);
      continue;
    }

    const punkt = PUNKT.exec(rest);
    if (punkt !== null) {
      stangStycke();
      oppnaLista('ul');
      ut.push(`<li>${inline(punkt[1]!, index, 0, uppslag)}</li>`);
      continue;
    }
    const numrerad = NUMRERAD.exec(rest);
    if (numrerad !== null) {
      stangStycke();
      oppnaLista('ol');
      ut.push(`<li>${inline(numrerad[1]!, index, 0, uppslag)}</li>`);
      continue;
    }

    stangLista();
    stycke.push(rest);
  }

  stangStycke();
  stangLista();
  citatTill(0);
  return ut.join('');
}

/**
 * Steg 2 (inline) och steg 3 (autolänkning) i EN traversering: det som inte är
 * en markdownkonstruktion skickas vidare till autolänkaren, det som är kod
 * skickas ingenstans alls (KRAV-6).
 */
function inline(saker: string, index: Dokumentindex, djup: number, uppslag: Uppslag): string {
  if (djup > MAX_DJUP) return lankaEscapad(saker, index, LANKAR, uppslag);
  let ut = '';
  let sist = 0;
  INLINE.lastIndex = 0;
  // matchAll itererar över en egen kopia av mönstret, så rekursionen nedan kan
  // inte trampa på den här slingans position.
  for (const m of saker.matchAll(INLINE)) {
    ut += lankaEscapad(saker.slice(sist, m.index), index, LANKAR, uppslag);
    const g = m.groups!;
    // Beslut #42 (David, 2026-08-24): sökvägar och ärendenummer i backticks
    // SKA länkas. Formatering sker fortfarande aldrig i kod — innehållet går
    // genom lankaEscapad med LANKAR (bara länkmönstren), aldrig genom INLINE.
    // Mätt före ändringen: 55 av 291 länkar (18,9 %) föll bort på den gamla
    // regeln, i 31 av 336 ärenden.
    if (g['kod2'] !== undefined) {
      ut += `<code>${lankaEscapad(kodspan(g['kod2']), index, LANKAR, uppslag)}</code>`;
    } else if (g['kod1'] !== undefined) {
      ut += `<code>${lankaEscapad(g['kod1'], index, LANKAR, uppslag)}</code>`;
    }
    else if (g['fet2'] !== undefined) ut += `<strong>${inline(g['fet2'], index, djup + 1, uppslag)}</strong>`;
    else if (g['kursiv'] !== undefined) ut += `<em>${inline(g['kursiv'], index, djup + 1, uppslag)}</em>`;
    else ut += `<em>${inline(g['kursivu']!, index, djup + 1, uppslag)}</em>`;
    sist = m.index + m[0].length;
  }
  return ut + lankaEscapad(saker.slice(sist), index, LANKAR, uppslag);
}

/** `` `x` `` skrivs med ett mellanrum i varje ände för att rymma backticken. */
function kodspan(kod: string): string {
  return kod.startsWith(' ') && kod.endsWith(' ') && kod.trim() !== ''
    ? kod.slice(1, -1)
    : kod;
}

// ---- KRAV-1: enkel markdown ------------------------------------------------

/**
 * Rubriker, listor, fetstil, kod och länkar — inget mer. Ingen markdownmotor,
 * inga nya beroenden; radbaserat och förutsägbart.
 *
 * Dokumentsidan har sin egen uppsättning konstruktioner (kodblock, frontmatter,
 * h2 som första nivå) och rörs inte av KRAV-1 — men den delar KRAV-3:s ordning,
 * så esc() står här och ingen annanstans nedanför.
 */
export function renderaMarkdown(text: string, index: Dokumentindex, uppslag: Uppslag): string {
  const rader = esc(text).split(/\r?\n/);
  const ut: string[] = [];
  let stycke: string[] = [];
  let lista: 'ul' | 'ol' | null = null;
  let kod: string[] | null = null;

  const inline = (rad: string): string => lankaEscapad(rad, index, MARKDOWN, uppslag);
  const stangStycke = (): void => {
    if (stycke.length > 0) {
      ut.push(`<p>${inline(stycke.join('\n'))}</p>`);
      stycke = [];
    }
  };
  const stangLista = (): void => {
    if (lista !== null) {
      ut.push(`</${lista}>`);
      lista = null;
    }
  };
  const oppnaLista = (typ: 'ul' | 'ol'): void => {
    if (lista !== typ) {
      stangLista();
      ut.push(`<${typ}>`);
      lista = typ;
    }
  };

  let i = 0;
  // Frontmatter hör till filen, inte till läsningen.
  if (rader[0]?.trim() === '---') {
    const slut = rader.findIndex((r, n) => n > 0 && r.trim() === '---');
    if (slut > 0) i = slut + 1;
  }

  for (; i < rader.length; i++) {
    const rad = rader[i]!;
    if (kod !== null) {
      if (/^\s*```/.test(rad)) {
        ut.push(`<pre>${kod.join('\n')}</pre>`);
        kod = null;
      } else {
        kod.push(rad);
      }
      continue;
    }
    if (/^\s*```/.test(rad)) {
      stangStycke();
      stangLista();
      kod = [];
      continue;
    }
    if (rad.trim() === '') {
      stangStycke();
      stangLista();
      continue;
    }

    const rubrik = /^(#{1,6})\s+(.*)$/.exec(rad);
    if (rubrik !== null) {
      stangStycke();
      stangLista();
      // Sidans egen h1 är dokumentnamnet — filens rubriker börjar på h2.
      const niva = Math.min(rubrik[1]!.length + 1, 4);
      ut.push(`<h${niva}>${inline(rubrik[2]!.trim())}</h${niva}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(rad)) {
      stangStycke();
      stangLista();
      ut.push('<hr>');
      continue;
    }

    const punkt = /^\s*[-*+]\s+(.*)$/.exec(rad);
    if (punkt !== null) {
      stangStycke();
      oppnaLista('ul');
      ut.push(`<li>${inline(punkt[1]!)}</li>`);
      continue;
    }
    const numrerad = /^\s*\d+[.)]\s+(.*)$/.exec(rad);
    if (numrerad !== null) {
      stangStycke();
      oppnaLista('ol');
      ut.push(`<li>${inline(numrerad[1]!)}</li>`);
      continue;
    }

    stangLista();
    stycke.push(rad);
  }

  if (kod !== null) ut.push(`<pre>${kod.join('\n')}</pre>`);
  stangStycke();
  stangLista();
  return ut.join('');
}
