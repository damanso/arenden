// D-3, D-5, B-23 (Story 11.4): ärendekortet. Kortets fält renderas här ur den slutna konstanten KORTFALT,
// i fast ordning och vart och ett i en section med ankaret falt-<id>.
//
// TRE invarianter, som granskaren kan läsa av rakt här:
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
//      hamtaArendekort i src/services/arendekort.ts. All text går genom esc(), varje ärendelänk byggs med
//      arendeSokvag() och varje aktör skrivs med proveniens().
//
// Raderna som redan fanns (bilagornas, relationernas, kommentarernas och historikens rader och delärendenas
// kort) byggs kvar i ärenderutten och kommer hit som färdig markup; modulen avgör fältets läge och lägger
// raderna i fältet. Inga nya komponenter: rubriken är h2 eller h3, lägestexten p.notis och listan ul.lista.
import { arendeSokvag, type Befintliga } from '../../lib/arendelank.js';
import type { Arende, SoktraffIVy } from '../../services/arenden.js';
import {
  TAK_NAMNS_I,
  type Arendekort,
  type Kortatagande,
  type Kortinsats,
  type Markning,
} from '../../services/arendekort.js';
import type { Tillhor } from '../../services/atagande.js';
import type { Handelse } from '../../services/handelser.js';
import type { InsatsTyp } from '../../services/insats.js';
import type { Kundkoppling } from '../../services/kundkoppling.js';
import { datum, datumtid, esc, proveniens, verbText } from './mall.js';

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
  { id: 'bilagor', rubrik: 'Bilagor', niva: 'h2', grupp: null, raknas: true },
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
} as const;

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

// ---- Kortet -------------------------------------------------------------------------------------------

/**
 * Underlaget: läsmodellen, CRM-uppslagets utfall, de nummer som beskrivningen och de synliga kommentarerna
 * nämner (i kanonisk form, ur sidans egen rendering) och de rader som ärenderutten redan bygger.
 */
export interface Kortunderlag {
  kort: Arendekort;
  crm: Crmsvar;
  namnda: readonly string[];
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
  bilagor: (u) => listLage(u.rader.bilagor, TEXT.bilagor),
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
  bilagor: (u) => u.kort.bilagor.length,
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
