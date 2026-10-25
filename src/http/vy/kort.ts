// D-3, D-5, B-23 (Story 11.4): ärendekortet. Kortets fält renderas här ur den slutna konstanten KORTFALT,
// i fast ordning och vart och ett i en section med ankaret falt-<id>.
//
// FYRA invarianter, som granskaren kan läsa av rakt här:
//   1. SLUTEN FÄLTLISTA. KORTFALT är kortets enda fältlista. FALTLAGE har en lägesfunktion per fält, typad
//      som en mappad typ över fältens id, så att tsc kräver en funktion för varje fält i listan, och
//      kortet() renderar fälten bara genom en loop över KORTFALT och renderaFalt(). Ett nytt fält kräver
//      alltså en post i listan, en lägesfunktion och ett provfall för värde och för sitt tomma läge
//      (FALLEN i test/arendekort.test.ts).
//   2. EXAKT ETT AV FEM LÄGEN. Ett fält är ett värde eller ett av fyra tomma lägen, och ett tomt läge bär en
//      text som säger varför fältet är tomt och var uppgiften sätts. Lägena är en sluten union, varde() och
//      tomt() är de enda konstruktörerna och kastar för en tom text, och renderaFalt() har en uttömmande
//      switch. Inget fält utelämnas, och inget renderas som en tom yta.
//   3. INGEN SQL OCH INGEN HÄMTNING. Underlaget kommer från ärenderutten, som hämtar det med
//      hamtaArendekort i src/services/arendekort.ts, och dokumentindexet, som rutten redan har. All text
//      går genom esc(), varje ärendelänk byggs med arendeSokvag() eller arendereferens() och varje aktör
//      skrivs med proveniens().
//   4. EN VÄG FÖR VARJE REFERENS (D-4, B-25; Story 11.5). Varje referens som ett fält visar går genom
//      privatKalla() och REFERENSLANK: referens() för åtagandets och insatsernas referenser och kallrad() för
//      insatsernas källor frågar privatKalla() först och skriver då bara den fasta meningen PRIVAT_TEXT.
//      Därefter avgör den slutna tabellen REFERENSLANK hur länken härleds, och en typ som tabellen inte
//      känner visas som «typ · id» utan länk och utelämnas aldrig.
//
// Raderna som redan fanns (bilagornas, relationernas, kommentarernas och historikens rader och delärendenas
// kort) byggs kvar i ärenderutten och kommer hit som färdig markup; modulen avgör fältets läge och lägger
// raderna i fältet. Inga nya komponenter: rubriken är h2 eller h3, lägestexten p.notis och listan ul.lista.
import { arendeSokvag, type Befintliga } from '../../lib/arendelank.js';
import type { Arende, SoktraffIVy } from '../../services/arenden.js';
import {
  REFERENSBARARE,
  TAK_NAMNS_I,
  type Arendekort,
  type Jsonform,
  type Kortatagande,
  type Kortbeslut,
  type Kortinsats,
  type Kortkalla,
  type Kortsvarsversion,
  type Markning,
} from '../../services/arendekort.js';
import type { Lage, Slag, Tillhor, Villkor } from '../../services/atagande.js';
import type { Handelse } from '../../services/handelser.js';
import type { InsatsLage, InsatsTyp } from '../../services/insats.js';
import type { Kommentar } from '../../services/kommentarer.js';
import type { Kundkoppling } from '../../services/kundkoppling.js';
import type { Bilaga } from '../../services/relationer.js';
import { privatKalla, type Dokumentindex } from './dokument.js';
import { datum, datumtid, esc, proveniens, sakerUrl, verbText } from './mall.js';
import {
  arendereferens,
  AVVECKLAD_LINEAR_LANK,
  dokUrl,
  dokumentreferenser,
  dokumentsokvag,
  linearAdress,
  renderaArendetext,
  TIDIGARE_LINEAR_LANK,
  type Uppslag,
} from './markdown.js';

type Grupp = 'laget' | 'kopplade';

interface Faltpost {
  id: string;
  rubrik: string;
  niva: 'h2' | 'h3';
  grupp: Grupp | null;
  /** Ett räknat fält har antalet rader i rubriken, också 0. */
  raknas: boolean;
}

/** Kortets enda fältlista, i den ordning fälten står på sidan. */
export const KORTFALT = [
  { id: 'frist', rubrik: 'Frist', niva: 'h3', grupp: 'laget', raknas: false },
  { id: 'agare', rubrik: 'Ägare', niva: 'h3', grupp: 'laget', raknas: false },
  { id: 'projekt', rubrik: 'Projekt', niva: 'h3', grupp: 'laget', raknas: false },
  { id: 'kund', rubrik: 'Kund', niva: 'h3', grupp: 'laget', raknas: false },
  { id: 'uppdrag', rubrik: 'Uppdrag', niva: 'h3', grupp: 'laget', raknas: false },
  { id: 'ursprung', rubrik: 'Ursprung', niva: 'h3', grupp: 'laget', raknas: false },
  { id: 'beskrivning', rubrik: 'Beskrivning', niva: 'h2', grupp: null, raknas: false },
  // D-3, D-4 (Story 11.5): åtagandet, besluten, insatserna, dokumenten och mailen efter rättelseformuläret.
  // Bilagorna står under Dokument och underlag.
  { id: 'atagande', rubrik: 'Åtagande', niva: 'h2', grupp: null, raknas: false },
  { id: 'beslut', rubrik: 'Beslut', niva: 'h2', grupp: null, raknas: true },
  { id: 'insatser', rubrik: 'Insatser', niva: 'h2', grupp: null, raknas: true },
  { id: 'dokument', rubrik: 'Dokument och underlag', niva: 'h2', grupp: null, raknas: false },
  { id: 'mail', rubrik: 'Mail', niva: 'h2', grupp: null, raknas: false },
  { id: 'foralder', rubrik: 'Förälder', niva: 'h3', grupp: 'kopplade', raknas: false },
  { id: 'delarenden', rubrik: 'Delärenden', niva: 'h3', grupp: 'kopplade', raknas: true },
  { id: 'relationer', rubrik: 'Relationer', niva: 'h3', grupp: 'kopplade', raknas: true },
  { id: 'namner', rubrik: 'Nämner', niva: 'h3', grupp: 'kopplade', raknas: false },
  { id: 'namns-i', rubrik: 'Nämns i', niva: 'h3', grupp: 'kopplade', raknas: false },
  { id: 'dubbletter', rubrik: 'Dubbletter', niva: 'h3', grupp: 'kopplade', raknas: false },
  { id: 'kommentarer', rubrik: 'Kommentarer', niva: 'h2', grupp: null, raknas: true },
  { id: 'historik', rubrik: 'Historik', niva: 'h2', grupp: null, raknas: true },
] as const satisfies readonly Faltpost[];

export type Kortfalt = (typeof KORTFALT)[number];
export type FaltId = Kortfalt['id'];

const GRUPPRUBRIK: Record<Grupp, string> = { laget: 'Läget', kopplade: 'Kopplade ärenden' };

// ---- De fem lägena -----------------------------------------------------------------------------------

export const LAGEN = ['varde', 'inga', 'saknas', 'finns_inte', 'kunde_inte'] as const;
export type Lagesnamn = (typeof LAGEN)[number];
export type TomtLagesnamn = Exclude<Lagesnamn, 'varde'>;

/**
 * Fältets läge: ett värde (markup) eller ett av de fyra tomma lägena med sin text. `delvis` är markup för
 * det som ändå gick att läsa, och den står före lägestexten.
 */
export type Faltlage =
  | { readonly lage: 'varde'; readonly html: string }
  | { readonly lage: TomtLagesnamn; readonly text: string; readonly delvis: string | null };

function kravInnehall(varde: string, vad: string): void {
  if (varde.trim() === '') throw new Error(`ett fält på ärendekortet får inte vara tomt: ${vad}`);
}

/** Värdeläget. Kastar för en tom eller blank markup: ett tomt värde är ett tomt läge och ska säga det. */
export function varde(html: string): Faltlage {
  kravInnehall(html, 'värdet');
  return { lage: 'varde', html };
}

/** Ett tomt läge med sin text. Kastar för en tom eller blank text och för en given men tom `delvis`. */
export function tomt(lage: TomtLagesnamn, text: string, delvis?: string): Faltlage {
  kravInnehall(text, 'lägestexten');
  if (delvis !== undefined) kravInnehall(delvis, 'det som ändå lästes');
  return { lage, text, delvis: delvis === undefined ? null : delvis };
}

/** Fältet som markup: ankaret, rubriken och värdet eller lägestexten. Den enda vägen från läge till sida. */
export function renderaFalt(falt: Kortfalt, lage: Faltlage, antal: number): string {
  const rubrik = esc(falt.raknas ? `${falt.rubrik} (${antal})` : falt.rubrik);
  const huvud =
    `<section id="falt-${esc(falt.id)}">` + (falt.niva === 'h2' ? `<h2>${rubrik}</h2>` : `<h3>${rubrik}</h3>`);
  switch (lage.lage) {
    case 'varde':
      return `${huvud}${lage.html}</section>`;
    case 'inga':
    case 'saknas':
    case 'finns_inte':
    case 'kunde_inte':
      return `${huvud}${lage.delvis ?? ''}<p class=notis>${esc(lage.text)}</p></section>`;
    default: {
      const okant: never = lage;
      throw new Error(`okänt läge på ärendekortet: ${JSON.stringify(okant)}`);
    }
  }
}

// ---- Lägestexterna (Dev Notes → Texterna) -----------------------------------------------------------

const TEXT = {
  frist: 'Saknas — ingen deadline satt (update_issue, fältet due).',
  agare:
    'Finns inte i plattformen — ärendeplattformen har inget ansvarigfält. ' +
    'Ägaren härleds ur åtagandet när ärendet bär ett.',
  projekt: 'Saknas — ärendet har inget projekt (update_issue, fältet projekt).',
  kundOavgjord: 'Saknas — kundkopplingen är inte avgjord (set_project_customer).',
  kundUtanProjekt: 'Saknas — ärendet har inget projekt att koppla kunden genom.',
  kundCrmNere: 'Kunde inte läsas just nu — CRM-data ej tillgänglig.',
  kundInternt: 'Internt projekt — ska aldrig kopplas till en kund.',
  uppdrag:
    'Finns inte i plattformen — föreslagen källa: redovisningens uppdrag för projektets kund (David har sagt ja ' +
    'till kopplingen, som byggs i Story 11.8).',
  ursprung: 'Saknas — ingen skapanderad i händelseloggen.',
  beskrivning:
    'Saknas — ingen beskrivning (update_issue, fältet description; i ytan under Rätta titel eller beskrivning).',
  bilagor: 'Inga bilagor (add_attachment).',
  foralder: 'Inga — ärendet ligger överst i sin hierarki.',
  delarenden: 'Inga delärenden (update_issue, fältet parent).',
  relationer: 'Inga relationer (link_issues).',
  namner:
    'Inga — beskrivningen och de synliga kommentarerna nämner inget annat ärende som finns (ett nummer skrivs ' +
    'in med add_comment eller update_issue, fältet description).',
  dubbletter:
    'Finns inte i plattformen — relationstyperna är relaterat och blockerar (migration 0008). Föreslagen källa: ' +
    'en relationstyp för dubbletter i link_issues.',
  kommentarer: 'Ingen har kommenterat det här ärendet ännu.',
  historik: 'Ärendet har inte ändrats sedan det kom in.',
  // D-3, D-4 (Story 11.5). Besluts- och mailtexterna följer Davids svar 2026-10-18 och nämner inte CRM
  // (Dev Notes → Tolkningar, punkt 2 och 3).
  atagande: 'Inga — inget åtagande registrerat (registrera_atagande).',
  beslut: 'Inga — inget beslut kopplat (koppla_beslut).',
  beslutstext:
    'Finns inte i plattformen — texten finns i beslutskön. Föreslagen källa: Story 11.9 (David har valt att ' +
    'Beslutskön skickar texten med svarsversionen och att kortet länkar till beslutet).',
  insatser: 'Inga — ingen insats registrerad på ärendet (registrera_insats).',
  ingaDokument: 'Inget dokument i dokumentområdet nämns i beskrivningen eller i de synliga kommentarerna.',
  mail:
    'Finns inte i plattformen — plattformen bär inga mail. Föreslagen källa: redovisningens mailtrådar för ' +
    'projektets kund (David har sagt ja till kopplingen, som byggs i Story 11.8).',
  mailrad:
    'Länk och rubrik ur mailen kräver kopplingen till redovisningens mailtrådar — David har sagt ja till den, ' +
    'och den byggs i Story 11.8.',
} as const;

/** Dokument och underlag utan spegel, med ärendets eget nummer (Dev Notes → Tolkningar, punkt 5). */
function spegeltext(identifier: string): string {
  return `Saknas — spegeln (arenden_arkiv.py) har inte skrivit ${identifier}.md än.`;
}

/**
 * Vad «Nämns i» räknar: sökfrågans träffar (Story 11.1). Hur sökindexet delar upp en text i ord avgör
 * Postgres och inte kortet, och Nämner läser i stället sidans egen rendering, så de två kan skilja sig åt.
 * Fältet påstår därför bara det som K18 i test/arendekort.test.ts prövar: att numret skrivet som ett eget ord
 * hittas, och att de två exemplen inte läses som numret. Om andra skrivsätt påstår det ingenting. Texten
 * står i båda lägena, i notisen och efter listan, så att varken notisen eller listan läses som fullständig
 * (Dev Notes → Tolkningar, punkt 6).
 */
function namnsIOmfang(identifier: string): string {
  return (
    `Ett annat ärende räknas här när sökningen efter ${identifier} hittar det, och sökningen hittar numret ` +
    'skrivet som ett eget ord i ett ärendes titel, beskrivning eller synliga kommentarer. Ett omnämnande som ' +
    'sökningen inte läser som numret, till exempel inne i en Linear-adress eller med inledande nollor, räknas ' +
    'inte här men kan stå under Nämner på det andra ärendet.'
  );
}

/** «Nämns i» utan träffar, med ärendets eget nummer. */
function namnsIInga(identifier: string): string {
  return (
    `Inga — inget annat ärende nämner ${identifier} i sin text eller i en synlig kommentar ` +
    `(add_comment på det andra ärendet). ${namnsIOmfang(identifier)}`
  );
}

// ---- Referenserna och källorna (D-4, B-25; Story 11.5) ----------------------------------------------

/** R5: det enda som står på kortet för en referens i ett privat område (privatKalla i dokument.ts). */
export const PRIVAT_TEXT = 'Källa i ett privat område — visas inte på kortet.';
/** En referens som inte är ett objekt med strängarna typ och id (och version som sträng eller utan). */
const OKAND_FORM = 'Referens i en form som kortet inte läser — visas inte på kortet.';
/**
 * En del av åtagandet eller insatsen som finns men inte har den form som kortet läser (en äldre jsonb-rad
 * eller ägarrollen). Delen står som en rad med sin etikett och den här texten och tappas aldrig i tysthet.
 */
const OKAND_DEL = 'Uppgift i en form som kortet inte läser — visas inte på kortet.';

/** Hur en referens länk härleds: till ett ärende, ett valvdokument, en adress, aldrig (mail) eller som text. */
export type Lankslag = 'arende' | 'dokument' | 'url' | 'mail' | 'text';

/**
 * AK 1: den slutna tabellen typ → hur länken härleds. beslut, prov och commit är typerna i sviten och i
 * fixturernas mätning, och arende, dokument, url och mail är plattformens namn för de slag som länkas eller
 * visas som mail (Dev Notes → Tolkningar, punkt 1). Driftens typer mäts med src/scripts/matReferenstyper.ts;
 * en typ som pekar på ett ärende, ett valvdokument eller en adress under ett annat namn förs in här genom
 * correct-course. En typ som inte står här blir text och utelämnas aldrig.
 */
export const REFERENSLANK: Readonly<Record<string, Lankslag>> = Object.freeze({
  arende: 'arende',
  dokument: 'dokument',
  url: 'url',
  mail: 'mail',
  beslut: 'text',
  prov: 'text',
  commit: 'text',
});

/** AK 7: typerna och objekttyperna som är mail: tabellens nycklar med slaget mail. De får aldrig en länk. */
export const MAILTYPER: ReadonlySet<string> = new Set(
  Object.keys(REFERENSLANK).filter((typ) => REFERENSLANK[typ] === 'mail'),
);

/** Ett objekt ur jsonb: inte null och ingen lista. */
function arObjekt(varde: unknown): varde is Record<string, unknown> {
  return typeof varde === 'object' && varde !== null && !Array.isArray(varde);
}

/**
 * En referens i den form som ReferensSchema i src/actions/registry.ts skriver. Jsonb-raden behöver inte
 * följa schemat (en äldre rad eller ägarrollen), så en rubrik kan stå; Mail visar den när den är en text.
 */
type Referensform = { typ: string; id: string; version?: string; rubrik?: unknown };

function arReferens(varde: unknown): varde is Referensform {
  return (
    arObjekt(varde) &&
    typeof varde.typ === 'string' &&
    typeof varde.id === 'string' &&
    (varde.version === undefined || typeof varde.version === 'string')
  );
}

/**
 * En adress ur data som länk (FR-37, B-14): en Linear-adress blir aldrig en utåtlänk utan ärendets nummer
 * med «tidigare Linear-länk», eller texten att Linear är avvecklat; en annan http(s)-adress blir en utåtlänk
 * med `text`, som redan är escapad. null för allt som inte är http(s), och anroparen skriver då texten.
 */
function adresslank(adress: string, text: string, uppslag: Uppslag): string | null {
  const url = sakerUrl(adress);
  if (url === null) return null;
  const linear = linearAdress(url);
  if (linear === null) return `<a href="${esc(url)}" rel="noreferrer noopener">${text}</a>`;
  if (linear.nummer === null) return esc(AVVECKLAD_LINEAR_LANK);
  const nummer = arendereferens(esc(linear.nummer), linear.nummer, uppslag) ?? esc(linear.nummer);
  return `${nummer} (${esc(TIDIGARE_LINEAR_LANK)})`;
}

/**
 * Referensens id som markup, efter slaget: en länk där slaget och datat medger det, annars text. `rel` är
 * dokumentmålet som referens() redan slagit upp och prövat (bara för slaget dokument).
 */
function referensId(slag: Lankslag, id: string, rel: string | null, uppslag: Uppslag): string {
  const text = `<code>${esc(id)}</code>`;
  switch (slag) {
    case 'arende':
      // En länk när ärendet finns, nummeruppslaget med «(finns inte)» när teamet finns (Story 11.2).
      return arendereferens(esc(id), id, uppslag) ?? text;
    case 'dokument':
      // Autolänkarens eget uppslag: bara en vitlistad sökväg, eller ett filnamn med en träff i indexet.
      return rel === null ? text : `<a href="${esc(dokUrl(rel))}">${esc(id)}</a>`;
    case 'url':
      return adresslank(id, esc(id), uppslag) ?? text;
    case 'mail':
    case 'text':
      return text;
    default: {
      const okant: never = slag;
      throw new Error(`okänt länkslag på ärendekortet: ${String(okant)}`);
    }
  }
}

/**
 * AK 1 och AK 6: en referens ({ typ, id, version }) som markup, och den enda vägen dit för åtagandets och
 * insatsernas referenser. En referens i en annan form blir texten om formen, en privat referens den fasta
 * meningen, och annars avgör REFERENSLANK hur id:t länkas; en okänd typ blir text. Privat är referensen när
 * typen, id:t, versionen eller dokumentmålet som id:t slås upp till är det; adressen som ett href får är
 * en av de former som privatKalla prövar id:t i. Ingen gren ger en tom sträng. Under en insamling
 * (arendekandidater) antecknas ett ärendenummer som referensen länkar.
 */
export function referens(ref: unknown, index: Dokumentindex, uppslag: Uppslag): string {
  if (!arReferens(ref)) return esc(OKAND_FORM);
  // Object.hasOwn: bara en egen nyckel är en typ, aldrig ett ärvt namn som constructor.
  const slag: Lankslag = Object.hasOwn(REFERENSLANK, ref.typ) ? (REFERENSLANK[ref.typ] ?? 'text') : 'text';
  const rel = slag === 'dokument' ? dokumentsokvag(ref.id, index) : null;
  if ([ref.typ, ref.id, ref.version, rel].some((del) => typeof del === 'string' && privatKalla(del))) {
    return esc(PRIVAT_TEXT);
  }
  const version = ref.version === undefined ? '' : ` · version <code>${esc(ref.version)}</code>`;
  return `<code>${esc(ref.typ)}</code> · ${referensId(slag, ref.id, rel, uppslag)}${version}`;
}

/** Flera referenser på en rad, åtskilda med semikolon; varje post genom referens(). */
function referenser(lista: readonly unknown[], index: Dokumentindex, uppslag: Uppslag): string {
  return lista.map((ref) => referens(ref, index, uppslag)).join('; ');
}

/**
 * AK 4 och AK 6: en källa till en insats, och den enda vägen dit för källorna. Ett privat fält ger bara den
 * fasta meningen. Annars står system, objekttyp, objekt-id och version som maskinnamn, och länken byggs bara
 * ur `lank`: ingen för en källa vars objekttyp är mail, en utåtlänk bara för en http(s)-adress som inte går
 * till Linear, och annars adressen som text.
 */
export function kallrad(k: Kortkalla, uppslag: Uppslag): string {
  const falt = [k.system, k.objekttyp, k.objekt_id, k.objekt_version, k.lank];
  if (falt.some((v) => v !== null && privatKalla(v))) return `<p>Källa: ${esc(PRIVAT_TEXT)}</p>`;
  const version = k.objekt_version === null ? '' : ` · version <code>${esc(k.objekt_version)}</code>`;
  const lank =
    MAILTYPER.has(k.objekttyp) || k.lank === null
      ? ''
      : ` · ${adresslank(k.lank, 'länk', uppslag) ?? `<code>${esc(k.lank)}</code>`}`;
  return (
    `<p>Källa: <code>${esc(k.system)}</code> · <code>${esc(k.objekttyp)}</code> · ` +
    `<code>${esc(k.objekt_id)}</code>${version}${lank}</p>`
  );
}

// ---- Lägesfunktionerna, en per fält ----------------------------------------------------------------

/** En ärendelänk: adressen byggs bara med arendeSokvag() (D-2, Story 11.2). */
function arendelank(identifier: string): string {
  return `<a href="${esc(arendeSokvag(identifier))}">${esc(identifier)}</a>`;
}

/** Tillhörigheten i ord. Insatsens tillhörighet (ägaren eller användaren) slås upp i samma tabell. */
const TILLHORORD: Record<Tillhor, string> = { agare: 'ägaren', anvandare: 'användaren', hermes: 'Hermes' };

const INSATSTYPORD: Record<InsatsTyp, string> = {
  agarbeslut: 'ägarbeslut',
  utathandling: 'utåthandling',
  kundkontakt: 'kundkontakt',
  godkannande: 'godkännande',
  intygande: 'intygande',
};

/** Hur CRM-uppslaget gick: inget uppslag (projektet är inte kopplat), ett svar eller inget svar. */
export type Crmsvar = 'okopplat' | 'svarade' | 'svarade_inte';

/**
 * AK 2: varje frist med sin källa — ärendets deadline, åtagandets uppföljning och de öppna insatsernas frist
 * och väckningstid, insatserna i läsmodellens ordning.
 */
export function fristLage(
  arende: Pick<Arende, 'due_date'>,
  atagande: Pick<Kortatagande, 'foljs_upp'> | null,
  insatser: readonly Pick<Kortinsats, 'frist' | 'vackningstid'>[],
): Faltlage {
  const rader: string[] = [];
  if (arende.due_date !== null) rader.push(`<p>senast ${esc(arende.due_date)}</p>`);
  if (atagande !== null && atagande.foljs_upp !== null) {
    rader.push(`<p>åtagandet följs upp ${esc(datumtid(atagande.foljs_upp))}</p>`);
  }
  for (const insats of insatser) {
    if (insats.frist !== null) rader.push(`<p>insatsens frist ${esc(datumtid(insats.frist))}</p>`);
    if (insats.vackningstid !== null) {
      rader.push(`<p>insatsens väckningstid ${esc(datumtid(insats.vackningstid))}</p>`);
    }
  }
  return rader.length === 0 ? tomt('saknas', TEXT.frist) : varde(rader.join(''));
}

/** Händelsen som agentkön skriver när en aktör plockar ärendet (claim_next_issue). */
const PLOCKVERB = 'claimade_arende';
/** Aktörstypen när händelseloggen inte bär plockningen: proveniens() märker den som okänd, aldrig omärkt. */
const OKAND_AKTORSTYP = 'okänd';

/**
 * AK 2: plattformen har inget ansvarigfält, så ägaren härleds vid läsning ur åtagandets tillhörighet och
 * utförare, de öppna insatsernas tillhörighet och agentköns claimad_av. AK 8: varje aktör skrivs med
 * proveniens(). claimad_av bär bara namnet, så typen läses ur den senaste plockningen av samma aktör i
 * händelseloggen, som kortet redan har hämtat.
 */
export function agareLage(
  arende: Pick<Arende, 'claimad_av'>,
  atagande: Pick<Kortatagande, 'tillhor' | 'utforare_typ' | 'utforare_namn' | 'overtaget_nar'> | null,
  insatser: readonly Pick<Kortinsats, 'typ' | 'tillhor'>[],
  handelser: readonly Pick<Handelse, 'verb' | 'aktor_typ' | 'aktor_namn'>[],
): Faltlage {
  const rader: string[] = [];
  if (atagande !== null) {
    rader.push(`<p>åtagandet tillhör ${esc(TILLHORORD[atagande.tillhor])}</p>`);
    if (atagande.utforare_typ !== null && atagande.utforare_namn !== null) {
      const nar = atagande.overtaget_nar === null ? '' : ` tog över ${esc(datumtid(atagande.overtaget_nar))}`;
      rader.push(`<p>utförare ${proveniens(atagande.utforare_typ, atagande.utforare_namn)}${nar}</p>`);
    }
  }
  for (const insats of insatser) {
    rader.push(
      `<p>öppen insats (${esc(INSATSTYPORD[insats.typ])}) tillhör ${esc(TILLHORORD[insats.tillhor])}</p>`,
    );
  }
  if (arende.claimad_av !== null) {
    const namn = arende.claimad_av;
    const plockning = handelser.findLast((h) => h.verb === PLOCKVERB && h.aktor_namn === namn);
    rader.push(`<p>plockat av ${proveniens(plockning?.aktor_typ ?? OKAND_AKTORSTYP, namn)}</p>`);
  }
  return rader.length === 0 ? tomt('finns_inte', TEXT.agare) : varde(rader.join(''));
}

export function projektLage(arende: Pick<Arende, 'projekt'>): Faltlage {
  return arende.projekt === null ? tomt('saknas', TEXT.projekt) : varde(`<p>${esc(arende.projekt)}</p>`);
}

/**
 * AK 3: kunden läses ur projektets kundkoppling. `null` betyder att ärendet inget projekt har. Svarar CRM
 * inte för ett kopplat projekt står kopplingen ur databasen kvar som det som ändå lästes.
 */
export function kundLage(koppling: Kundkoppling | null, crm: Crmsvar): Faltlage {
  if (koppling === null) return tomt('saknas', TEXT.kundUtanProjekt);
  switch (koppling.koppling_status) {
    case 'intern':
      return varde(`<p>${esc(TEXT.kundInternt)}</p>`);
    case 'oavgjord':
      return tomt('saknas', TEXT.kundOavgjord);
    case 'kopplad': {
      const delar = [
        koppling.kund_kalla,
        koppling.kund_id === null ? null : `kund-id ${koppling.kund_id}`,
        koppling.kund_kopplad_at === null ? null : `kopplad ${datum(koppling.kund_kopplad_at)}`,
      ].filter((d): d is string => d !== null);
      const rad = `<p>${esc(delar.join(' · '))}</p>`;
      return crm === 'svarade_inte' ? tomt('kunde_inte', TEXT.kundCrmNere, rad) : varde(rad);
    }
    default: {
      const okand: never = koppling.koppling_status;
      throw new Error(`okänd kundkoppling: ${String(okand)}`);
    }
  }
}

/** AK 3: en lucka tills Story 11.8 läser redovisningens uppdrag. */
export function uppdragLage(): Faltlage {
  return tomt('finns_inte', TEXT.uppdrag);
}

const ARKIVKALLA = 'linear-arkiv:';
const SKAPANDEVERB: ReadonlySet<string> = new Set(['skapade_arende', 'importerade_arende']);

/**
 * AK 4: hur ärendet kom in, och den som skapade det enligt händelseloggen. Saknas skapanderaden står
 * källan kvar som det som ändå lästes, och ingenting fylls i efterhand.
 */
export function ursprungLage(
  arende: Pick<Arende, 'source_ref'>,
  handelser: readonly Pick<Handelse, 'verb' | 'aktor_typ' | 'aktor_namn' | 'tidpunkt'>[],
): Faltlage {
  const kalla =
    arende.source_ref === null
      ? 'skapat i plattformen'
      : arende.source_ref.startsWith(ARKIVKALLA)
        ? `importerat ur Linear-arkivet (arkivfilen ${arende.source_ref.slice(ARKIVKALLA.length)})`
        : `källa: ${arende.source_ref}`;
  const kallrad = `<p>${esc(kalla)}</p>`;
  const skapande = handelser.find((h) => SKAPANDEVERB.has(h.verb));
  if (skapande === undefined) return tomt('saknas', TEXT.ursprung, kallrad);
  return varde(
    kallrad +
      `<p>${esc(verbText(skapande.verb))} ${proveniens(skapande.aktor_typ, skapande.aktor_namn)} ` +
      `${esc(datumtid(skapande.tidpunkt))}</p>`,
  );
}

/** Beskrivningen: `renderad` är sidans egen markup för texten, och den visas bara när texten inte är blank. */
export function beskrivningLage(beskrivning: string, renderad: string): Faltlage {
  return beskrivning.trim() === '' ? tomt('saknas', TEXT.beskrivning) : varde(renderad);
}

/** Ett fält vars värde är en lista rader. Listan renderas bara när den har rader. */
export function listLage(rader: readonly string[], ingaText: string): Faltlage {
  if (rader.length === 0) return tomt('inga', ingaText);
  return varde(`<ul class=lista role=list>${rader.join('')}</ul>`);
}

export function foralderLage(arende: Pick<Arende, 'foralder_identifier' | 'foralder_titel'>): Faltlage {
  if (arende.foralder_identifier === null) return tomt('inga', TEXT.foralder);
  return varde(`<p>${arendelank(arende.foralder_identifier)} — ${esc(arende.foralder_titel ?? '')}</p>`);
}

/** FR-16 delkrav 5 (Story 5.5): raden under ett delärende som är märkt som nödvändigt delresultat. */
function markningsrad(markning: Markning | undefined): string {
  if (markning === undefined) return '';
  return (
    `<p class=summering>nödvändigt delresultat — märkt ${esc(datumtid(markning.markt))} av ` +
    `${proveniens(markning.markt_av_typ, markning.markt_av_namn)}</p>`
  );
}

/**
 * FR-16 delkrav 5 (Story 5.5): en märkning vars delärende inte längre är barn till huvudärendet. Märkningen
 * hör till paret och står kvar efter en flytt (migration 0018), och spärren läser märkningen och inte
 * hierarkin, så kortet visar den med delärendets nummer i stället för att tappa den.
 */
function flyttadMarkningsrad(markning: Markning): string {
  return (
    `<p class=summering>${arendelank(markning.del_identifier)} är inte längre delärende — nödvändigt ` +
    `delresultat, märkt ${esc(datumtid(markning.markt))} av ` +
    `${proveniens(markning.markt_av_typ, markning.markt_av_namn)}. Märkningen står kvar tills den tas bort ` +
    '(ta_bort_nodvandigt_delresultat).</p>'
  );
}

/**
 * Delärendenas kort, ett per delärende och i samma ordning som `barn`, och efter kortet märkningsraden när
 * delärendet är märkt som nödvändigt delresultat. Varje aktiv märkning står exakt en gång: under sitt
 * delärendes kort, eller efter korten med delärendets nummer när delärendet har flyttats. Utan delärenden
 * är läget inga, och de flyttade märkningarna står kvar som det som ändå lästes.
 */
export function delarendenLage(
  barn: readonly Pick<Arende, 'id'>[],
  kortrader: readonly string[],
  markningar: readonly Markning[],
): Faltlage {
  // Korten kommer ur barn.map i ärenderutten. Avviker antalet hade ett kort försvunnit i tysthet.
  if (kortrader.length !== barn.length) {
    throw new Error(`delärendenas kort (${kortrader.length}) svarar inte mot delärendena (${barn.length})`);
  }
  const barnIds = new Set(barn.map((b) => b.id));
  const vidKort = new Map(
    markningar.filter((m) => barnIds.has(m.del_issue_id)).map((m): [string, Markning] => [m.del_issue_id, m]),
  );
  const flyttade = markningar.filter((m) => !barnIds.has(m.del_issue_id)).map(flyttadMarkningsrad).join('');
  if (barn.length === 0) {
    return flyttade === '' ? tomt('inga', TEXT.delarenden) : tomt('inga', TEXT.delarenden, flyttade);
  }
  const kort = barn.map((b, i) => (kortrader[i] ?? '') + markningsrad(vidKort.get(b.id)));
  return varde(kort.join('') + flyttade);
}

/**
 * AK 5: de ärenden som finns och vars nummer står i beskrivningen eller i en synlig kommentar, utan ärendet
 * självt och utan dubbletter, i den ordning sidans rendering mötte dem. `namnda` och `befintliga.arenden`
 * är båda i kanonisk form. Bara numret som länk: en titel hade krävt en fråga till.
 */
export function namnerLage(
  arende: Pick<Arende, 'identifier'>,
  namnda: readonly string[],
  befintliga: Befintliga,
): Faltlage {
  const visade = [...new Set(namnda)].filter((n) => n !== arende.identifier && befintliga.arenden.has(n));
  if (visade.length === 0) return tomt('inga', TEXT.namner);
  return varde(visade.map((n) => `<p>${arendelank(n)}</p>`).join(''));
}

/**
 * AK 5: de ärenden vars text eller synliga kommentar nämner numret, ur sökningens fråga (Story 11.1), och
 * ärendet självt bortfiltrerat i läsmodellen. Når listan taket säger kortet det, och efter listan står vad
 * fältet räknar.
 */
export function namnsILage(
  arende: Pick<Arende, 'identifier'>,
  traffar: readonly Pick<SoktraffIVy, 'identifier' | 'title' | 'traff_i'>[],
  kapat: boolean,
): Faltlage {
  if (traffar.length === 0) return tomt('inga', namnsIInga(arende.identifier));
  const rader = traffar.map(
    (t) =>
      `<p>${arendelank(t.identifier)} — ${esc(t.title)} · ` +
      `${esc(t.traff_i === 'kommentar' ? 'träff i kommentar' : 'träff i ärendetexten')}</p>`,
  );
  const tak = kapat
    ? `<p class=summering>Taket ${esc(TAK_NAMNS_I)} är nått — fler ärenden nämner numret än listan visar.</p>`
    : '';
  return varde(rader.join('') + tak + `<p class=summering>${esc(namnsIOmfang(arende.identifier))}</p>`);
}

/** AK 5: en lucka tills link_issues får en relationstyp för dubbletter. */
export function dubbletterLage(): Faltlage {
  return tomt('finns_inte', TEXT.dubbletter);
}

// ---- Åtagandet, besluten och insatserna (D-3, D-4; Story 11.5 AK 2–4) ---------------------------------
//
// Fri text visas ordagrant, escapad och utan länk i div.text, som bevarar radbrytningarna (Dev Notes →
// Tolkningar, punkt 12). Varje referens går genom referens() och varje källa genom kallrad(), och
// maskinnamnen (system, kommando, objekttyp, id) står i code. Inga nya komponenter, och de nya fälten skriver
// ingen li.rad: KRAV-5 kräver ett proveniensmärke i varje sådan rad, och bara bilagornas rader, som fanns
// förut, är li.rad.

/** Åtagandets läge i ord. Record över unionen, så att tsc fäller ett läge utan ord. */
const ATAGANDELAGEORD: Record<Lage, string> = {
  registrerat: 'registrerat',
  overtaget: 'övertaget',
  hindrat: 'hindrat',
  genomfort: 'genomfört',
  avslutat: 'avslutat',
};

/** Nästa stegs slag i ord. */
const SLAGORD: Record<Slag, string> = { internt: 'internt', riktning: 'riktning', utathandling: 'utåthandling' };

/** Villkorets utfall i ord. */
const UTFALLORD: Record<Villkor['utfall'], string> = {
  okant: 'okänt',
  uppfyllt: 'uppfyllt',
  ej_uppfyllt: 'ej uppfyllt',
};

/** Insatsens läge i ord. */
const INSATSLAGEORD: Record<InsatsLage, string> = {
  vantande: 'väntande',
  uppskjuten: 'uppskjuten',
  svar_mottaget: 'svar mottaget',
  aterkallad: 'återkallad',
  avslutad: 'avslutad',
};

// Värdena ur jsonb är unknown: de indexerar en ordtabell först efter en typvakt. Ett värde som finns men
// inte klarar vakten är en del utan rätt form och står som raden om formen (felform).
function arSlag(varde: unknown): varde is Slag {
  return typeof varde === 'string' && Object.hasOwn(SLAGORD, varde);
}

function arUtfall(varde: unknown): varde is Villkor['utfall'] {
  return typeof varde === 'string' && Object.hasOwn(UTFALLORD, varde);
}

/** Saknas delen? Bara en del som saknas står inte alls; en del i fel form står med raden om formen. */
function saknas(varde: unknown): boolean {
  return varde === undefined || varde === null;
}

/** En del som finns men har fel form: etiketten och texten om formen, och inget av värdet. */
function felform(etikett: string): string {
  return `<p>${esc(etikett)}: ${esc(OKAND_DEL)}</p>`;
}

/** Fri text ordagrant under en etikett; inget när värdet saknas, raden om formen när det inte är en text. */
function fritext(etikett: string, varde: unknown): string {
  if (saknas(varde)) return '';
  if (typeof varde !== 'string') return felform(etikett);
  return `<div class=text><b>${esc(etikett)}:</b> ${esc(varde)}</div>`;
}

/** En referens under en etikett, eller inget när den saknas. En referens i fel form säger referens() ifrån om. */
function referensrad(etikett: string, ref: unknown, index: Dokumentindex, uppslag: Uppslag): string {
  return saknas(ref) ? '' : `<p>${esc(etikett)}: ${referens(ref, index, uppslag)}</p>`;
}

/**
 * En lista referenser under en etikett; inget när listan saknas eller är tom, raden om formen när värdet
 * inte är en lista.
 */
function referenslistrad(etikett: string, lista: unknown, index: Dokumentindex, uppslag: Uppslag): string {
  if (saknas(lista)) return '';
  if (!Array.isArray(lista)) return felform(etikett);
  return lista.length === 0 ? '' : `<p>${esc(etikett)}: ${referenser(lista, index, uppslag)}</p>`;
}

/** En del som ska vara ett objekt: inget när den saknas, raden om formen när den inte är ett objekt. */
function objektdel(etikett: string, varde: unknown, rendera: (del: Record<string, unknown>) => string): string {
  if (saknas(varde)) return '';
  return arObjekt(varde) ? rendera(varde) : felform(etikett);
}

/**
 * AK 2: åtagandet ordagrant, rad för rad: läget och tillhörigheten, utföraren och när den tog över,
 * uppföljningen och revisionen, utfallet (ärendets titel) och preciseringen, grunden, nästa steg, varje
 * villkor, hindret, resultatet och avslutsskälet. En del som saknas står inte, och en del som finns men har
 * fel form står med sin etikett och raden om formen (felform), så att ingen hämtad del tappas i tysthet och
 * villkorens numrering aldrig får en lucka. Varje referensbärare i REFERENSBARARE (src/services/arendekort.ts)
 * står här; K38 i test/arendekort.test.ts prövar att listan och fältet stämmer. Ärenderutten kör funktionen
 * också under insamlingen av kandidater, så att varje ärende som en referens länkar slås upp.
 */
export function atagandeLage(
  arende: Pick<Arende, 'title'>,
  atagande: Kortatagande | null,
  index: Dokumentindex,
  uppslag: Uppslag,
): Faltlage {
  if (atagande === null) return tomt('inga', TEXT.atagande);
  const rader = [
    `<p>Läge: ${esc(ATAGANDELAGEORD[atagande.lage])} · tillhör ${esc(TILLHORORD[atagande.tillhor])}</p>`,
  ];
  if (atagande.utforare_typ !== null && atagande.utforare_namn !== null) {
    const nar = atagande.overtaget_nar === null ? '' : ` · tog över ${esc(datumtid(atagande.overtaget_nar))}`;
    rader.push(`<p>Utförare: ${proveniens(atagande.utforare_typ, atagande.utforare_namn)}${nar}</p>`);
  }
  if (atagande.foljs_upp !== null) rader.push(`<p>Följs upp: ${esc(datumtid(atagande.foljs_upp))}</p>`);
  rader.push(`<p>Revision: ${esc(atagande.revision)}</p>`);
  rader.push(fritext('Utfall', arende.title));

  // Jsonb-datan läses med typvakter: en äldre rad behöver inte följa AtagandeJson.
  if (!saknas(atagande.data) && !arObjekt(atagande.data)) rader.push(felform('Åtagandets uppgifter'));
  const data: Record<string, unknown> = arObjekt(atagande.data) ? atagande.data : {};
  rader.push(fritext('Precisering', data.utfall_precisering));
  rader.push(referenslistrad('Grund', data.grund, index, uppslag));
  rader.push(
    objektdel('Nästa steg', data.nasta, (nasta) => {
      const slag = nasta.slag;
      const slagtext = arSlag(slag) ? ` (${SLAGORD[slag]})` : '';
      return (
        fritext(`Nästa steg${slagtext}`, nasta.handling) +
        (saknas(slag) || arSlag(slag) ? '' : felform('Nästa stegs slag')) +
        referensrad('Nästa stegs grund', nasta.grund, index, uppslag)
      );
    }),
  );
  const villkoren = data.villkor;
  if (!saknas(villkoren) && !Array.isArray(villkoren)) rader.push(felform('Villkor'));
  if (Array.isArray(villkoren)) {
    villkoren.forEach((villkor: unknown, i: number) => {
      const etikett = `Villkor ${i + 1}`;
      if (!arObjekt(villkor)) {
        rader.push(felform(etikett));
        return;
      }
      const utfall = villkor.utfall;
      rader.push(fritext(etikett, villkor.text));
      rader.push(referensrad('Villkorets källa', villkor.kalla, index, uppslag));
      rader.push(fritext('Gäller', villkor.galler));
      rader.push(fritext('Kontroll', villkor.kontroll));
      if (arUtfall(utfall)) rader.push(`<p>Utfall: ${esc(UTFALLORD[utfall])}</p>`);
      else if (!saknas(utfall)) rader.push(felform('Utfall'));
      rader.push(referensrad('Villkorets belägg', villkor.belagg, index, uppslag));
    });
  }
  rader.push(
    objektdel(
      'Hinder',
      data.hinder,
      (hinder) => fritext('Hinder', hinder.orsak) + referensrad('Hindrets belägg', hinder.belagg, index, uppslag),
    ),
  );
  rader.push(
    objektdel('Resultat', data.resultat, (resultat) => {
      const kontrollerat = resultat.kontrollerat;
      return (
        fritext('Resultat', resultat.sammanfattning) +
        referenslistrad('Resultatets belägg', resultat.belagg, index, uppslag) +
        (typeof kontrollerat === 'string'
          ? `<p>Kontrollerat: ${esc(kontrollerat)}</p>`
          : saknas(kontrollerat)
            ? ''
            : felform('Kontrollerat'))
      );
    }),
  );
  rader.push(
    objektdel(
      'Avslutsskäl',
      data.avslutsskal,
      (skal) =>
        fritext('Avslutsskäl', skal.text) + referensrad('Avslutsskälets grund', skal.grund, index, uppslag),
    ),
  );
  return varde(rader.join(''));
}

/** En behandlad svarsversion: löpnumret, eller hashens första tolv tecken för den äldre klientens identitet. */
function svarsversionsrad(v: Kortsvarsversion): string {
  const vilken =
    v.version === null ? `med hashen <code>${esc(v.svar_hash.slice(0, 12))}</code>` : esc(v.version);
  return `<p>svarsversion ${vilken} · tillämpad ${esc(datumtid(v.tillampad))}</p>`;
}

/**
 * AK 3: varje kopplat beslut med kopplingens tid och sina behandlade svarsversioner. En version som
 * registrerats på ärendet för ett beslut som inte är kopplat dit står under sitt nummer med «inte kopplat
 * till ärendet», så att ingen hämtad rad tappas (Dev Notes → Tolkningar, punkt 4). Beslutets text och
 * Davids svar finns inte i plattformen förrän Story 11.9; raden om det står sist bland besluten, i värdet
 * och, när bara versioner för okopplade beslut finns, i det som ändå lästes.
 */
export function beslutLage(beslut: readonly Kortbeslut[], versioner: readonly Kortsvarsversion[]): Faltlage {
  const versionerFor = (id: number): string =>
    versioner
      .filter((v) => v.beslut_id === id)
      .map(svarsversionsrad)
      .join('');
  const kopplade = new Set(beslut.map((b) => b.beslut_id));
  const kopplat = beslut
    .map(
      (b) => `<p>beslut #${esc(b.beslut_id)} · kopplat ${esc(datumtid(b.kopplad))}</p>${versionerFor(b.beslut_id)}`,
    )
    .join('');
  const okopplat = [...new Set(versioner.map((v) => v.beslut_id).filter((id) => !kopplade.has(id)))]
    .map((id) => `<p>beslut #${esc(id)} · inte kopplat till ärendet (koppla_beslut)</p>${versionerFor(id)}`)
    .join('');
  // Raden om beslutens text och Davids svar står efter varje beslut som visas, kopplat eller inte (AK 3).
  const beslutstext = `<p class=summering>${esc(TEXT.beslutstext)}</p>`;
  if (beslut.length > 0) return varde(`${kopplat}${okopplat}${beslutstext}`);
  return okopplat === '' ? tomt('inga', TEXT.beslut) : tomt('inga', TEXT.beslut, `${okopplat}${beslutstext}`);
}

/**
 * AK 4 och AK 6: handlingskontraktets system, kommando och objekt, de delar som finns. En privat del ger
 * bara den fasta meningen, och ett kontrakt utan någon av delarna ingen rad. Ett kontrakt som inte är ett
 * objekt, eller en del som finns men inte är en text, står med raden om formen.
 */
function handlingskontraktrad(kontrakt: unknown): string {
  if (saknas(kontrakt)) return '';
  if (!arObjekt(kontrakt)) return felform('Handlingskontrakt');
  const finns = [kontrakt.system, kontrakt.kommando, kontrakt.objekt].filter((del) => !saknas(del));
  if (finns.length === 0) return '';
  const delar = finns.filter((del): del is string => typeof del === 'string');
  if (delar.length !== finns.length) return felform('Handlingskontrakt');
  if (delar.some((del) => privatKalla(del))) return `<p>Handlingskontrakt: ${esc(PRIVAT_TEXT)}</p>`;
  return `<p>Handlingskontrakt: ${delar.map((del) => `<code>${esc(del)}</code>`).join(' · ')}</p>`;
}

/** En insats på kortet: rubriken med typ, läge och tillhörighet, och sedan dess delar i fast ordning. */
function insatsblock(i: Kortinsats, index: Dokumentindex, uppslag: Uppslag): string {
  const delar = [
    `<h3>${esc(INSATSTYPORD[i.typ])} · ${esc(INSATSLAGEORD[i.lage])} · tillhör ${esc(TILLHORORD[i.tillhor])}</h3>`,
    `<p>Insats <code>${esc(i.id)}</code> · registrerad ${esc(datumtid(i.skapad))}</p>`,
    fritext('Utfall', i.utfall),
    fritext('Begärd handling', i.begard_handling),
    fritext('Blockeringsgrund', i.blockeringsgrund),
    i.frist === null ? '' : `<p>Frist: ${esc(datumtid(i.frist))}</p>`,
    i.vackningstid === null ? '' : `<p>Väckningstid: ${esc(datumtid(i.vackningstid))}</p>`,
    referenslistrad('Belägg', i.belagg, index, uppslag),
    handlingskontraktrad(i.handlingskontrakt),
    ...i.kallor.map((k) => kallrad(k, uppslag)),
  ];
  // Svaret ordagrant, med den som svarade (bara en människa svarar, besvaraInsats i insats.ts) och källan.
  if (i.svar_text !== null) {
    const vem = i.svar_aktor === null ? '' : ` av ${proveniens('manniska', i.svar_aktor)}`;
    const nar = i.svar_nar === null ? '' : ` ${esc(datumtid(i.svar_nar))}`;
    delar.push(
      fritext('Svar', i.svar_text),
      `<p>Svarat${vem}${nar} · källa: svar på insats ${esc(i.id)}, version ${esc(i.version)}</p>`,
    );
  }
  return delar.join('');
}

/**
 * AK 4: varje insats på ärendet, i läsmodellens ordning och i varje läge. Ärenderutten kör funktionen också
 * under insamlingen av kandidater, så att varje ärende som en källa länkar slås upp.
 */
export function insatserLage(
  insatser: readonly Kortinsats[],
  index: Dokumentindex,
  uppslag: Uppslag,
): Faltlage {
  if (insatser.length === 0) return tomt('inga', TEXT.insatser);
  return varde(insatser.map((i) => insatsblock(i, index, uppslag)).join(''));
}

// ---- Dokument och underlag och Mail (D-3, D-4; Story 11.5 AK 5–7) -------------------------------------

/** Katalogen som linear-arkivets spegling (arenden_arkiv.py) skriver till, en av VITLISTA:s kataloger. */
const SPEGELKATALOG = '02-Områden/linear-arkiv/';

/**
 * AK 5: ärendets spegelfil, när just den sökvägen står i dokumentindexet under filnamnets nyckel, annars
 * null. Uppslaget läser indexet som ärenderutten redan hämtat och ingen fil.
 */
export function spegelsokvag(identifier: string, index: Dokumentindex): string | null {
  const rel = `${SPEGELKATALOG}${identifier}.md`.normalize('NFC');
  const traffar = index.filnamn.get(`${identifier}.md`.normalize('NFC').toLowerCase()) ?? [];
  return traffar.some((t) => t.normalize('NFC') === rel) ? rel : null;
}

/**
 * AK 5 och AK 6: dokumenten som beskrivningen och de synliga kommentarerna nämner, bilagorna och spegeln.
 *
 * Dokumenten tas fram av autolänkarens egen rendering genom dokumentreferenser() i markdown.ts, en gång per
 * text, och slås ihop på sökvägen med platserna i ordning. Länktexten är sökvägen, inte texten i ärendet.
 * Ett privat mål blir den fasta meningen med platserna. Bilagornas rader kommer färdiga ur ärenderutten
 * (bilageRad), och en bilaga vars adress, titel eller undertitel är privat får den fasta meningen i stället.
 * Dokumentdelen och bilagedelen säger alltid något, också utan poster. Utan spegel är läget saknas med det
 * som ändå lästes före lägestexten (Dev Notes → Tolkningar, punkt 5).
 */
export function dokumentLage(
  arende: Pick<Arende, 'identifier' | 'description'>,
  kommentarer: readonly Pick<Kommentar, 'body' | 'skapad' | 'aktor_typ' | 'aktor_namn'>[],
  bilagor: readonly Pick<Bilaga, 'url' | 'titel' | 'undertitel'>[],
  bilagerader: readonly string[],
  index: Dokumentindex,
): Faltlage {
  // Raderna kommer ur bilagor.map i ärenderutten. Avviker antalet hade en bilaga försvunnit i tysthet.
  if (bilagerader.length !== bilagor.length) {
    throw new Error(`bilagornas rader (${bilagerader.length}) svarar inte mot bilagorna (${bilagor.length})`);
  }

  const platser = new Map<string, string[]>();
  const privata: string[] = [];
  const samla = (text: string, plats: string): void => {
    for (const post of dokumentreferenser((uppslag) => renderaArendetext(text, index, uppslag))) {
      if (post.slag === 'privat') {
        privata.push(plats);
      } else {
        platser.set(post.rel, [...(platser.get(post.rel) ?? []), plats]);
      }
    }
  };
  samla(arende.description, 'i beskrivningen');
  for (const k of kommentarer) {
    samla(k.body, `i kommentar ${esc(datumtid(k.skapad))} av ${proveniens(k.aktor_typ, k.aktor_namn)}`);
  }
  const dokumentrader = [...platser].map(
    ([rel, vilka]) => `<p><a href="${esc(dokUrl(rel))}">${esc(rel)}</a> · nämns ${vilka.join(' · ')}</p>`,
  );
  if (privata.length > 0) dokumentrader.push(`<p>${esc(PRIVAT_TEXT)} · nämns ${privata.join(' · ')}</p>`);
  const dokumentdel = dokumentrader.length === 0 ? `<p>${esc(TEXT.ingaDokument)}</p>` : dokumentrader.join('');

  const bilagerad = (b: Pick<Bilaga, 'url' | 'titel' | 'undertitel'>, i: number): string =>
    [b.url, b.titel, b.undertitel].some((falt) => falt !== null && privatKalla(falt))
      ? `<li class=rad><div class=huvud><span>${esc(PRIVAT_TEXT)}</span></div></li>`
      : (bilagerader[i] ?? '');
  const bilagedel =
    `<h3>${esc(`Bilagor (${bilagor.length})`)}</h3>` +
    (bilagor.length === 0
      ? `<p>${esc(TEXT.bilagor)}</p>`
      : `<ul class=lista role=list>${bilagor.map(bilagerad).join('')}</ul>`);

  const spegel = spegelsokvag(arende.identifier, index);
  if (spegel === null) return tomt('saknas', spegeltext(arende.identifier), dokumentdel + bilagedel);
  const spegelrad = `<p><a href="${esc(dokUrl(spegel))}">Spegeln i valvet</a> · ${esc(spegel)}</p>`;
  return varde(`${dokumentdel}${bilagedel}${spegelrad}`);
}

/** Ett jsonb-värde i den form som bäraren har: en listas element eller ett ensamt objekt, annars inget. */
function iForm(varde: unknown, form: Jsonform): unknown[] {
  if (form === 'lista') return Array.isArray(varde) ? varde : [];
  return arObjekt(varde) ? [varde] : [];
}

/**
 * Åtagandets referenser i jsonb-datan, bärare för bärare i REFERENSBARARE (src/services/arendekort.ts), den
 * slutna listan som också mätningen läser. En del utan bärarens form har inga referenser här; Åtagande visar
 * den med raden om formen.
 */
function atagandetsReferenser(data: unknown): unknown[] {
  if (!arObjekt(data)) return [];
  const atagandet: Record<string, unknown> = data;
  return REFERENSBARARE.flatMap((b): unknown[] => {
    const delar: unknown[] = b.del === null ? [atagandet] : iForm(atagandet[b.del.nyckel], b.del.form);
    return delar.flatMap((del) => (arObjekt(del) ? iForm(del[b.nyckel], b.form) : []));
  });
}

/**
 * AK 6 och AK 7: en mailreferens, och den enda vägen dit för raderna i Mail. privatKalla() först, på id:t
 * och på rubriken, och ingen länkgren: mailen själv finns inte i plattformen. Rubriken står, escapad, när
 * referensen själv bär en som text; ReferensSchema skriver ingen, men jsonb-raden behöver inte följa schemat,
 * och en källa har ingen. `plats` är färdig markup.
 */
function mailrad(id: string, rubrik: unknown, plats: string): string {
  const rubriken = typeof rubrik === 'string' && rubrik.trim() !== '' ? rubrik : null;
  if (privatKalla(id) || (rubriken !== null && privatKalla(rubriken))) {
    return `<p>${esc(PRIVAT_TEXT)} · ${plats}</p>`;
  }
  const visad = rubriken === null ? '' : ` · ${esc(rubriken)}`;
  return `<p>mail · <code>${esc(id)}</code>${visad} · ${plats}</p>`;
}

/**
 * AK 7: åtagandets referenser vars typ är mail, insatsernas belägg med sådan typ och källorna med sådan
 * objekttyp (MAILTYPER), som «mail · id», med rubriken när referensen själv bär en, utan mailtext och utan
 * länk. Utan någon är fältet en lucka tills Story 11.8 kopplar redovisningens mailtrådar.
 */
export function mailLage(
  atagande: Pick<Kortatagande, 'data'> | null,
  insatser: readonly Pick<Kortinsats, 'id' | 'belagg' | 'kallor'>[],
): Faltlage {
  const rader: string[] = [];
  if (atagande !== null) {
    for (const ref of atagandetsReferenser(atagande.data)) {
      if (arReferens(ref) && MAILTYPER.has(ref.typ)) rader.push(mailrad(ref.id, ref.rubrik, 'i åtagandet'));
    }
  }
  for (const i of insatser) {
    const plats = `på insats <code>${esc(i.id)}</code>`;
    const belagg: unknown[] = Array.isArray(i.belagg) ? i.belagg : [];
    for (const ref of belagg) {
      if (arReferens(ref) && MAILTYPER.has(ref.typ)) rader.push(mailrad(ref.id, ref.rubrik, plats));
    }
    for (const k of i.kallor) {
      if (MAILTYPER.has(k.objekttyp)) rader.push(mailrad(k.objekt_id, null, plats));
    }
  }
  if (rader.length === 0) return tomt('finns_inte', TEXT.mail);
  return varde(`${rader.join('')}<p class=summering>${esc(TEXT.mailrad)}</p>`);
}

// ---- Kortet -------------------------------------------------------------------------------------------

/**
 * Underlaget: läsmodellen, CRM-uppslagets utfall, de nummer som beskrivningen och de synliga kommentarerna
 * nämner (i kanonisk form, ur sidans egen rendering), dokumentindexet som ärenderutten redan har hämtat
 * (Story 11.5) och de rader som ärenderutten redan bygger.
 */
export interface Kortunderlag {
  kort: Arendekort;
  crm: Crmsvar;
  namnda: readonly string[];
  index: Dokumentindex;
  rader: {
    beskrivning: string;
    bilagor: readonly string[];
    delarenden: readonly string[];
    relationer: readonly string[];
    kommentarer: readonly string[];
    historik: readonly string[];
  };
}

/** Det som står mellan fälten och inte är något fält: CRM-kortet och skrivformulären. */
export interface Kortinslag {
  crmKort: string;
  efterBeskrivning: string;
  efterKommentarer: string;
}

/** En lägesfunktion per fält. Den mappade typen gör att tsc fäller ett fält i KORTFALT utan funktion. */
export const FALTLAGE: { readonly [K in FaltId]: (u: Kortunderlag) => Faltlage } = {
  frist: (u) => fristLage(u.kort.arende, u.kort.atagande, u.kort.oppnaInsatser),
  agare: (u) => agareLage(u.kort.arende, u.kort.atagande, u.kort.oppnaInsatser, u.kort.handelser),
  projekt: (u) => projektLage(u.kort.arende),
  kund: (u) => kundLage(u.kort.kundkoppling, u.crm),
  uppdrag: () => uppdragLage(),
  ursprung: (u) => ursprungLage(u.kort.arende, u.kort.handelser),
  beskrivning: (u) => beskrivningLage(u.kort.arende.description, u.rader.beskrivning),
  atagande: (u) => atagandeLage(u.kort.arende, u.kort.atagande, u.index, u.kort.befintliga),
  beslut: (u) => beslutLage(u.kort.beslut, u.kort.svarsversioner),
  insatser: (u) => insatserLage(u.kort.insatser, u.index, u.kort.befintliga),
  dokument: (u) => dokumentLage(u.kort.arende, u.kort.kommentarer, u.kort.bilagor, u.rader.bilagor, u.index),
  mail: (u) => mailLage(u.kort.atagande, u.kort.insatser),
  foralder: (u) => foralderLage(u.kort.arende),
  delarenden: (u) => delarendenLage(u.kort.barn, u.rader.delarenden, u.kort.markningar),
  relationer: (u) => listLage(u.rader.relationer, TEXT.relationer),
  namner: (u) => namnerLage(u.kort.arende, u.namnda, u.kort.befintliga),
  'namns-i': (u) => namnsILage(u.kort.arende, u.kort.namnsI, u.kort.namnsIKapat),
  dubbletter: () => dubbletterLage(),
  kommentarer: (u) => listLage(u.rader.kommentarer, TEXT.kommentarer),
  historik: (u) => listLage(u.rader.historik, TEXT.historik),
};

type RaknatFalt = Extract<Kortfalt, { readonly raknas: true }>;

/** Antalet rader i ett räknat fält, en funktion per räknat fält. */
const ANTAL: { readonly [K in RaknatFalt['id']]: (u: Kortunderlag) => number } = {
  // Story 11.5: de kopplade besluten och alla insatser på ärendet. Bilagorna räknas under Dokument och
  // underlag, i dess egen rubrik för bilagedelen.
  beslut: (u) => u.kort.beslut.length,
  insatser: (u) => u.kort.insatser.length,
  delarenden: (u) => u.kort.barn.length,
  relationer: (u) => u.kort.relationer.length,
  kommentarer: (u) => u.kort.kommentarer.length,
  historik: (u) => u.kort.handelser.length,
};

function arRaknat(falt: Kortfalt): falt is RaknatFalt {
  return falt.raknas;
}

/**
 * Hela kortet: fälten i KORTFALT:s ordning, gruppens rubrik före gruppens första fält, CRM-kortet direkt
 * före Beskrivning, rättelseformuläret direkt efter den och kommentarsformuläret med de borttagna
 * kommentarerna direkt efter Kommentarer.
 */
export function kortet(u: Kortunderlag, inslag: Kortinslag): string {
  let html = '';
  let grupp: Grupp | null = null;
  for (const falt of KORTFALT) {
    if (falt.grupp !== null && falt.grupp !== grupp) html += `<h2>${esc(GRUPPRUBRIK[falt.grupp])}</h2>`;
    grupp = falt.grupp;
    if (falt.id === 'beskrivning') html += inslag.crmKort;
    html += renderaFalt(falt, FALTLAGE[falt.id](u), arRaknat(falt) ? ANTAL[falt.id](u) : 0);
    if (falt.id === 'beskrivning') html += inslag.efterBeskrivning;
    if (falt.id === 'kommentarer') html += inslag.efterKommentarer;
  }
  return html;
}
