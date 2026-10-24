// Åtagandet: den beständiga länken genom underlag, beslut, utförande och
// resultat. Spec: Astra 2026-09-09 (02-Områden/hermes/atagandet-spec-...).
// Ram: ägaren ger riktning, användaren bär utgången till verkligheten,
// Hermes är bolaget och gör allt annat självt.
//
// Det som skiljer den här filen från ett vanligt statusfält är att de fyra
// lögnerna specen förbjuder inte går att skriva här:
//
//   1. "övertaget" utan att någon tagit över   → utföraren tas ur aktören
//   2. "genomfört" utan resultat               → belägg krävs, annars fel
//   3. samma svar verkställt två gånger        → unik svarsversion
//   4. utåthandling som blir intern            → kräver ny grund
//
// Ingen av dem är en kommentar i koden. Alla fyra kastar.
//
// Därtill gäller varje åtgärd som ändrar ett befintligt åtagande (FR-16
// delkrav 6, B-07; Story 5.2): forvantad_revision krävs (revision_saknas), en
// ändring utan ny grund och utan nytt nästa steg kräver skal (skal_saknas),
// varje skrivning går genom skrivOchJamfor och lämnar sin ändring till
// händelseraden (andring, över hela åtagandets fältlista),
// och återöppningen lämnar dessutom det den tar bort i tidigare.
//
// Och ett oavslutat åtagande har alltid nasta och foljs_upp (FR-16 delkrav 2 och 6,
// B-07; Story 5.1). kravOppetSteg är invariantens enda definition. Den står först i
// skriv, den enda funktion som skriver ett åtagande, och i andraAtagande före skälet,
// så att skal_saknas fortfarande prövas sist. Invarianten är ingen CHECK: rader som
// skrivits förbi API:t mäts av matAtagandebrott, som bara läser, och rättas bara med
// andra_atagande.
//
// Ärendets state-typ härleds ur läget på alla vägar (FR-16 delkrav 4 och 6,
// B-02; Story 3.2). STATE_FOR_LAGE är tabellen, synkaState sätter den, och
// uppdateraArendeState godtar för ett ärende med åtagande bara den, under radlås.
//
// Och huvudåtagandet kan inte bli genomfört medan ett märkt nödvändigt delresultat
// saknas (FR-16 delkrav 5, B-07; Story 5.5). Vilka delresultat som är nödvändiga är
// data med spår, inte en räkning av barnärenden: märkningen har en enda skrivare,
// markaNodvandigtDelresultat och taBortNodvandigtDelresultat, och spärren är en enda
// fråga, saknadeDelresultat, i redovisaResultat före skrivningen. Mätningen
// matDelresultat läser dagens hierarki med den gamla regelns villkor och bara läser:
// den är underlaget för märkningen i drift, inte en spärr.
import { isDeepStrictEqual } from 'node:util';
import type { PoolClient } from 'pg';
import { arendeLank } from '../lib/arendelank.js';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import type { Aktor } from '../lib/aktor.js';
import type { StateTyp } from '../lib/validation.js';
import { hamtaArende } from './arenden.js';

export type Lage = 'registrerat' | 'overtaget' | 'hindrat' | 'genomfort' | 'avslutat';
export type Tillhor = 'agare' | 'anvandare' | 'hermes';
export type Slag = 'internt' | 'riktning' | 'utathandling';
export type Moment =
  | 'hitta_underlag'
  | 'avgora_riktning'
  | 'forbereda'
  | 'utfora'
  | 'kontrollera'
  | 'folja_upp';

/** En referens pekar på en bestämd post — inte på en länk. Länken härleds. */
export interface Referens {
  typ: string;
  id: string;
  version?: string;
}

export interface Villkor {
  text: string;
  kalla: Referens;
  galler: string;
  kontroll: string;
  utfall: 'okant' | 'uppfyllt' | 'ej_uppfyllt';
  belagg?: Referens | null;
}

export interface Nasta {
  handling: string;
  slag: Slag;
  grund: Referens;
}

export interface AtagandeJson {
  grund: Referens[];
  nasta: Nasta | null;
  villkor: Villkor[];
  utfall_precisering?: string;
  hinder?: { orsak: string; belagg: Referens };
  resultat?: { sammanfattning: string; belagg: Referens[]; kontrollerat: string };
  avslutsskal?: { text: string; grund: Referens };
}

export interface Atagande {
  identifier: string;
  /** D-2, B-21 (Story 11.2): ärendets absoluta adress, härledd vid läsning och aldrig lagrad. */
  lank: string;
  issue_id: string;
  utfall: string;
  lage: Lage;
  tillhor: Tillhor;
  utforare_typ: string | null;
  utforare_namn: string | null;
  overtaget_nar: Date | null;
  foljs_upp: Date | null;
  revision: number;
  data: AtagandeJson;
}

interface Rad {
  id: string;
  identifier: string;
  title: string;
  atagande_lage: Lage | null;
  atagande_tillhor: Tillhor | null;
  atagande_utforare_typ: string | null;
  atagande_utforare_namn: string | null;
  atagande_overtaget_nar: Date | null;
  atagande_foljs_upp: Date | null;
  atagande_revision: number;
  atagande: AtagandeJson;
  team_id: string;
}

const HAMTA = `
  SELECT i.id,
         t.key || '-' || i.sequence_number AS identifier,
         i.title,
         i.team_id,
         i.atagande_lage, i.atagande_tillhor,
         i.atagande_utforare_typ, i.atagande_utforare_namn,
         i.atagande_overtaget_nar, i.atagande_foljs_upp,
         i.atagande_revision, i.atagande
    FROM issues i JOIN teams t ON t.id = i.team_id
   WHERE i.tenant_id = $1 AND i.id = $2`;

// Mutationer läser med radlås: två routerkörningar får inte höja revisionen
// från samma utgångsläge. Rena läsningar tar inget lås.
const HAMTA_LAS = `${HAMTA} FOR UPDATE OF i`;

/** Vem nästa nödvändiga insats tillhör. HÄRLEDS — fylls aldrig i för hand. */
export function tillhorAv(nasta: Nasta | null): Tillhor {
  if (!nasta) return 'hermes';
  if (nasta.slag === 'riktning') return 'agare';
  if (nasta.slag === 'utathandling') return 'anvandare';
  return 'hermes';
}

/** Tillåtna övergångar. Allt som inte står här är förbjudet. */
const OVERGANGAR: Record<Lage, Lage[]> = {
  registrerat: ['overtaget', 'hindrat', 'avslutat'],
  overtaget: ['hindrat', 'genomfort', 'avslutat', 'overtaget'],
  // hindrat -> genomfort saknas MED FLIT: ett hinder som blir gammalt är
  // inte ett genomfört arbete. Vägen tillbaka går via overtaget.
  hindrat: ['overtaget', 'avslutat'],
  genomfort: ['registrerat'],
  avslutat: ['registrerat'],
};

function kravOvergang(fran: Lage, till: Lage): void {
  if (!OVERGANGAR[fran].includes(till)) {
    throw new BadRequestError(
      'otillaten_overgang',
      `${fran} → ${till} är inte en tillåten övergång för ett åtagande`,
    );
  }
}

async function las(
  client: PoolClient,
  tenantId: string,
  issueId: string,
  lasa = true,
): Promise<Rad> {
  const { rows } = await client.query<Rad>(lasa ? HAMTA_LAS : HAMTA, [tenantId, issueId]);
  const rad = rows[0];
  if (!rad) throw new NotFoundError('ärende');
  return rad;
}

async function viaIdentifier(
  client: PoolClient,
  tenantId: string,
  identifier: string,
  lasa = true,
): Promise<Rad> {
  const arende = await hamtaArende(client, tenantId, identifier);
  return las(client, tenantId, arende.id, lasa);
}

function kravAtagande(rad: Rad): Lage {
  if (!rad.atagande_lage) {
    throw new BadRequestError('inget_atagande', `${rad.identifier} bär inget åtagande`);
  }
  return rad.atagande_lage;
}

/**
 * FR-16 delkrav 6, B-07 (Story 5.2 AK 6): revisionen är OBLIGATORISK på varje
 * åtgärd som ändrar ett befintligt åtagande. Schemat har forvantad_revision som
 * .optional() MED FLIT: ett utelämnat fält ska få sin egen felkod och prövas här,
 * efter kravAtagande och före varje annan regel, inte som ett anonymt
 * validation_error före allt annat.
 */
function kravRevision(rad: Rad, forvantad: number | undefined): void {
  if (forvantad === undefined) {
    throw new BadRequestError(
      'revision_saknas',
      'ange forvantad_revision — läs åtagandet och utgå från dess revision innan nästa sidoeffekt',
    );
  }
  if (forvantad !== rad.atagande_revision) {
    throw new BadRequestError(
      'gammal_revision',
      `åtagandet är på revision ${rad.atagande_revision}, anropet utgick från ${forvantad} — ` +
        'läs om innan nästa sidoeffekt',
    );
  }
}

/**
 * FR-16 delkrav 2 och 6, B-07 (Story 5.1): ett oavslutat åtagande har alltid ett nästa steg och
 * en uppföljningstid. Invariantens ENDA definition, och de två felkoderna står bara här. Den står
 * först i skriv(), så att ingen åtgärd kan skriva ett öppet åtagande utan båda. De stängda lägena
 * nollställer båda med flit och släpps igenom. nasta_saknas prövas först: båda saknade ger den.
 */
export function kravOppetSteg(
  lage: Lage,
  nasta: Nasta | null | undefined,
  foljsUpp: Date | string | null | undefined,
): void {
  if (lage === 'genomfort' || lage === 'avslutat') return;
  if (!nasta) {
    throw new BadRequestError('nasta_saknas', 'ett oavslutat åtagande måste ha ett nästa steg');
  }
  if (!foljsUpp) {
    throw new BadRequestError(
      'uppfoljning_saknas',
      'ett åtagande utan uppföljningstid blir liggande utan att någon märker det',
    );
  }
}

function tillAtagande(rad: Rad): Atagande {
  return {
    identifier: rad.identifier,
    lank: arendeLank(rad.identifier),
    issue_id: rad.id,
    utfall: rad.title,
    lage: rad.atagande_lage as Lage,
    tillhor: rad.atagande_tillhor as Tillhor,
    utforare_typ: rad.atagande_utforare_typ,
    utforare_namn: rad.atagande_utforare_namn,
    overtaget_nar: rad.atagande_overtaget_nar,
    foljs_upp: rad.atagande_foljs_upp,
    revision: rad.atagande_revision,
    data: rad.atagande ?? { grund: [], nasta: null, villkor: [] },
  };
}

/**
 * Ärendets vanliga workflow-status HÄRLEDS ur läget (spec §3.5). `hindrat`
 * får aldrig se avslutat ut: det stannar i started och syns som hinder.
 * Härledningens enda definition (B-02, Story 3.2): används av synkaState,
 * uppdateraArendeState och matStatusavvikelser.
 */
export const STATE_FOR_LAGE: Record<Lage, StateTyp> = {
  registrerat: 'unstarted',
  overtaget: 'started',
  hindrat: 'started',
  genomfort: 'completed',
  avslutat: 'canceled',
};

async function synkaState(
  client: PoolClient,
  rad: Rad,
  lage: Lage,
): Promise<void> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM workflow_states
      WHERE team_id = $1 AND typ = $2 ORDER BY position LIMIT 1`,
    [rad.team_id, STATE_FOR_LAGE[lage]],
  );
  const state = rows[0];
  if (!state) return;
  await client.query('UPDATE issues SET state_id = $1, uppdaterad = now() WHERE id = $2', [
    state.id,
    rad.id,
  ]);
}

async function skriv(
  client: PoolClient,
  rad: Rad,
  falt: {
    lage: Lage;
    data: AtagandeJson;
    foljsUpp?: Date | string | null;
    utforare?: Aktor | null;
    hojRevision?: boolean;
  },
): Promise<void> {
  // FR-16 delkrav 2 och 6, B-07 (Story 5.1): vakten står före varje fråga och prövar exakt den
  // uppföljningstid som skrivs ($5). Ett avvisat anrop har alltså inte skrivit något.
  const foljsUpp = falt.foljsUpp === undefined ? rad.atagande_foljs_upp : falt.foljsUpp;
  kravOppetSteg(falt.lage, falt.data.nasta, foljsUpp);
  const tillhor = tillhorAv(falt.data.nasta ?? null);
  const satsUtforare =
    falt.utforare === undefined
      ? ''
      : falt.utforare === null
        ? ', atagande_utforare_typ = NULL, atagande_utforare_namn = NULL, atagande_overtaget_nar = NULL'
        : ', atagande_utforare_typ = $6, atagande_utforare_namn = $7, atagande_overtaget_nar = now()';
  const params: unknown[] = [
    rad.id,
    falt.lage,
    tillhor,
    JSON.stringify(falt.data),
    foljsUpp,
  ];
  if (falt.utforare) params.push(falt.utforare.typ, falt.utforare.namn);
  await client.query(
    `UPDATE issues
        SET atagande_lage = $2,
            atagande_tillhor = $3,
            atagande = $4::jsonb,
            atagande_foljs_upp = $5,
            atagande_revision = atagande_revision + ${falt.hojRevision === false ? 0 : 1},
            uppdaterad = now()
            ${satsUtforare}
      WHERE id = $1`,
    params,
  );
  await synkaState(client, rad, falt.lage);
}

// ---------------------------------------------------------------- operationer

export interface RegistreraIn {
  identifier: string;
  grund: Referens[];
  nasta: Nasta | null;
  foljs_upp: string | null;
  villkor?: Villkor[];
  utfall_precisering?: string;
}

/**
 * Skapar åtagandet på ett befintligt ärende. Idempotent: finns det redan ett
 * åtagande returneras det oförändrat. Det är hela poängen med den unika
 * beslutskopplingen — en avbruten routerkörning får inte skapa arbete två gånger.
 */
export async function registreraAtagande(
  client: PoolClient,
  tenantId: string,
  input: RegistreraIn,
): Promise<
  | { atagande: Atagande; nyskapad: false }
  | { atagande: Atagande; nyskapad: true; andring: Andring }
> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  if (rad.atagande_lage) {
    return { atagande: tillAtagande(rad), nyskapad: false };
  }
  if (!input.grund.length) {
    throw new BadRequestError('grund_saknas', 'ett åtagande utan grund är en gissning');
  }
  // Nästa steg och uppföljningstid prövas av vakten i skriv() (Story 5.1), inte här.
  const data: AtagandeJson = {
    grund: input.grund,
    nasta: input.nasta,
    villkor: input.villkor ?? [],
    ...(input.utfall_precisering ? { utfall_precisering: input.utfall_precisering } : {}),
  };
  const svar = await skrivOchJamfor(client, tenantId, rad, {
    lage: 'registrerat',
    data,
    foljsUpp: input.foljs_upp,
  });
  return { ...svar, nyskapad: true };
}

/**
 * Övertagande. Utföraren tas UR AKTÖREN — en skickad överlämning är ingen
 * mottagare som arbetar, och ett fält i indatat kan inte påstå motsatsen.
 */
export async function overtaAtagande(
  client: PoolClient,
  tenantId: string,
  aktor: Aktor,
  input: { identifier: string; nasta: Nasta; foljs_upp: string; forvantad_revision?: number },
): Promise<{ atagande: Atagande; andring: Andring }> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  kravOvergang(fran, 'overtaget');
  const data: AtagandeJson = { ...rad.atagande, nasta: input.nasta };
  delete data.hinder;
  return skrivOchJamfor(client, tenantId, rad, {
    lage: 'overtaget',
    data,
    foljsUpp: input.foljs_upp,
    utforare: aktor,
  });
}

/**
 * FR-16 delkrav 6, B-07 (Story 5.2 AK 2 och AK 12): hela åtagandets slutna
 * fältlista. tsc kräver varje AtagandeJson-nyckel och atagande_-kolumn i Rad.
 * Revisionen står på händelseraden som revision och jämförs inte här.
 */
const KOLUMNFALT = {
  lage: 'atagande_lage',
  tillhor: 'atagande_tillhor',
  utforare_typ: 'atagande_utforare_typ',
  utforare_namn: 'atagande_utforare_namn',
  overtaget_nar: 'atagande_overtaget_nar',
  foljs_upp: 'atagande_foljs_upp',
} as const satisfies Record<string, keyof Rad>;
const DATAFALT = [
  'grund', 'nasta', 'villkor', 'utfall_precisering', 'hinder', 'resultat', 'avslutsskal',
] as const satisfies readonly (keyof AtagandeJson)[];

type SaknatDatafalt = Exclude<keyof AtagandeJson, (typeof DATAFALT)[number]>;
type SaknadKolumn = Exclude<
  Extract<keyof Rad, `atagande_${string}`>,
  (typeof KOLUMNFALT)[keyof typeof KOLUMNFALT] | 'atagande_revision'
>;
// Blir någon av typerna annat än never kan `true` inte tilldelas, och tsc fäller bygget.
const FALTLISTAN_AR_HEL: [SaknatDatafalt, SaknadKolumn] extends [never, never] ? true : false = true;
void FALTLISTAN_AR_HEL;

type AndringsFalt = keyof typeof KOLUMNFALT | (typeof DATAFALT)[number];
export type Andring = Partial<Record<AndringsFalt, { fran: unknown; till: unknown }>>;
const ANDRINGSFALT: readonly AndringsFalt[] = [
  ...(Object.keys(KOLUMNFALT) as (keyof typeof KOLUMNFALT)[]),
  ...DATAFALT,
];

/** pg ger Date; en ISO-sträng jämförs och loggas likadant på båda sidor. */
function iso(tid: Date | null): string | null {
  return tid ? tid.toISOString() : null;
}

/** Värdena före respektive efter. Ett fält som saknas är null — också före registreringen (atagande = {}). */
function andringsvarden(rad: Rad): Record<AndringsFalt, unknown> {
  const data: Partial<AtagandeJson> = rad.atagande ?? {};
  return {
    lage: rad.atagande_lage,
    tillhor: rad.atagande_tillhor,
    utforare_typ: rad.atagande_utforare_typ,
    utforare_namn: rad.atagande_utforare_namn,
    overtaget_nar: iso(rad.atagande_overtaget_nar),
    foljs_upp: iso(rad.atagande_foljs_upp),
    grund: data.grund ?? null,
    nasta: data.nasta ?? null,
    villkor: data.villkor ?? null,
    utfall_precisering: data.utfall_precisering ?? null,
    hinder: data.hinder ?? null,
    resultat: data.resultat ?? null,
    avslutsskal: data.avslutsskal ?? null,
  };
}

/**
 * Ett fält står i andring om och endast om dess värde före och efter skiljer sig.
 * Båda radlägena kommer ur databasen (det låsta före och omläsningen efter), så
 * samma värde har samma form, och nyckelordningen i jsonb spelar ingen roll.
 */
function andringMellan(fore: Rad, efter: Rad): Andring {
  const f = andringsvarden(fore);
  const e = andringsvarden(efter);
  const andring: Andring = {};
  for (const falt of ANDRINGSFALT) {
    if (!isDeepStrictEqual(f[falt], e[falt])) andring[falt] = { fran: f[falt], till: e[falt] };
  }
  return andring;
}

/**
 * FR-16 delkrav 6, B-07 (Story 5.2 AK 12): den ENDA vägen till skriv(). Varje åtgärd som
 * skriver ett åtagande får tillbaka sin ändring, räknad ur det LÅSTA radläget före och
 * omläsningen efter, över hela fältlistan. Det som tas bort står därför i ändringen med
 * sitt gamla värde, utan att någon åtgärd behöver komma ihåg vad den tar bort.
 */
async function skrivOchJamfor(
  client: PoolClient,
  tenantId: string,
  rad: Rad,
  falt: Parameters<typeof skriv>[2],
): Promise<{ atagande: Atagande; andring: Andring }> {
  await skriv(client, rad, falt);
  const efter = await las(client, tenantId, rad.id);
  return { atagande: tillAtagande(efter), andring: andringMellan(rad, efter) };
}

/**
 * Ändrar nästa steg, uppföljning eller villkor. Byter nästa steg slag FRÅN
 * utåthandling krävs en ny grund: annars vore "gör det internt i stället" en
 * väg runt kravet att en människa ska stå för det som lämnar bolaget.
 */
export async function andraAtagande(
  client: PoolClient,
  tenantId: string,
  input: {
    identifier: string;
    nasta?: Nasta;
    foljs_upp?: string | null;
    villkor?: Villkor[];
    grund?: Referens;
    skal?: string;
    forvantad_revision?: number;
  },
): Promise<{ atagande: Atagande; andring: Andring }> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const lage = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  if (lage === 'genomfort' || lage === 'avslutat') {
    throw new BadRequestError(
      'atagandet_ar_stangt',
      'ett stängt åtagande ändras genom att återöppnas med nytt belägg, inte genom att skrivas om',
    );
  }
  // FR-16 delkrav 2 och 6, B-07 (Story 5.1): värdena som ändringen skulle skriva prövas här,
  // före skälet. Vakten i skriv() fäller samma anrop, men först efter skal_saknas, och 5.2 AK 3
  // kräver att skal_saknas prövas efter uppfoljning_saknas. Radens värden gäller för det som
  // inte ändras, så en rad som redan bryter kan bara ändras när det saknade fältet förs in.
  kravOppetSteg(
    lage,
    input.nasta ?? rad.atagande?.nasta ?? null,
    input.foljs_upp !== undefined ? input.foljs_upp : rad.atagande_foljs_upp,
  );
  // FR-16 delkrav 6, B-07 (Story 5.2 AK 3): en ändring utan ny grund och utan nytt
  // nästa steg bär inget eget skäl och kräver `skal`. Prövas SIST bland reglerna,
  // så att varje annan regel ger sin egen felkod. utathandling_kringgas kan bara
  // träffa ett anrop med nasta, och då krävs inget skäl.
  if (input.grund === undefined && input.nasta === undefined && input.skal === undefined) {
    throw new BadRequestError(
      'skal_saknas',
      'en ändring utan ny grund och utan nytt nästa steg kräver ett skäl (skal)',
    );
  }
  const data: AtagandeJson = { ...rad.atagande };
  if (input.nasta) {
    const foreSlag = rad.atagande?.nasta?.slag;
    if (foreSlag === 'utathandling' && input.nasta.slag !== 'utathandling' && !input.grund) {
      throw new BadRequestError(
        'utathandling_kringgas',
        'att göra en utåthandling intern kräver en ny grund — annars är det en väg runt människospärren',
      );
    }
    data.nasta = input.nasta;
  }
  if (input.villkor) data.villkor = input.villkor;
  if (input.grund) data.grund = [...(data.grund ?? []), input.grund];
  return skrivOchJamfor(client, tenantId, rad, {
    lage,
    data,
    ...(input.foljs_upp !== undefined ? { foljsUpp: input.foljs_upp } : {}),
  });
}

export async function hindraAtagande(
  client: PoolClient,
  tenantId: string,
  input: {
    identifier: string;
    orsak: string;
    belagg: Referens;
    nasta: Nasta;
    foljs_upp: string;
    forvantad_revision?: number;
  },
): Promise<{ atagande: Atagande; andring: Andring }> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  kravOvergang(fran, 'hindrat');
  const data: AtagandeJson = {
    ...rad.atagande,
    nasta: input.nasta,
    hinder: { orsak: input.orsak, belagg: input.belagg },
  };
  return skrivOchJamfor(client, tenantId, rad, { lage: 'hindrat', data, foljsUpp: input.foljs_upp });
}

/**
 * Genomfört. Kräver belägg, uppfyllda villkor och att varje märkt nödvändigt
 * delresultat finns (FR-16 delkrav 5, B-07; Story 5.5). Går ALDRIG från hindrat:
 * ett hinder som blivit gammalt är inte ett resultat.
 */
export async function redovisaResultat(
  client: PoolClient,
  tenantId: string,
  input: {
    identifier: string;
    sammanfattning: string;
    belagg: Referens[];
    forvantad_revision?: number;
  },
): Promise<{ atagande: Atagande; andring: Andring }> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  kravOvergang(fran, 'genomfort');
  if (!input.belagg.length) {
    throw new BadRequestError(
      'belagg_saknas',
      'ett genomfört åtagande utan belägg är en ambition, inte ett resultat',
    );
  }
  const kvar = (rad.atagande?.villkor ?? []).filter((v) => v.utfall !== 'uppfyllt');
  if (kvar.length) {
    throw new BadRequestError(
      'villkor_haller_inte',
      `${kvar.length} villkor är inte uppfyllt: ${kvar.map((v) => v.text).join(' | ')}`,
    );
  }
  // FR-16 delkrav 5, B-07 (Story 5.5): spärren står före skrivningen och prövas sist bland
  // reglerna. Bara märkta delärenden räknas, och ett avslut utan resultat spärrar fortfarande
  // (Davids svar 2026-10-16 kl. 13.21). Listan går till anroparen som details, så att felet
  // namnger delärendena; meningen når aldrig klienten.
  const saknas = await saknadeDelresultat(client, tenantId, rad.id);
  if (saknas.length) {
    const lista = saknas.map((s) => `${s.identifier} (${s.lage ?? 'inget åtagande'})`).join(', ');
    throw new BadRequestError(
      'nodvandigt_delresultat_saknas',
      `nödvändigt delresultat saknas: ${lista} — huvudåtagandet kan inte redovisas`,
      saknas,
    );
  }
  const data: AtagandeJson = {
    ...rad.atagande,
    nasta: null,
    resultat: {
      sammanfattning: input.sammanfattning,
      belagg: input.belagg,
      kontrollerat: new Date().toISOString(),
    },
  };
  delete data.hinder;
  return skrivOchJamfor(client, tenantId, rad, { lage: 'genomfort', data, foljsUpp: null });
}

export async function avslutaAtagande(
  client: PoolClient,
  tenantId: string,
  input: {
    identifier: string;
    text: string;
    grund: Referens;
    forvantad_revision?: number;
  },
): Promise<{ atagande: Atagande; andring: Andring }> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  kravOvergang(fran, 'avslutat');
  const data: AtagandeJson = {
    ...rad.atagande,
    nasta: null,
    avslutsskal: { text: input.text, grund: input.grund },
  };
  return skrivOchJamfor(client, tenantId, rad, { lage: 'avslutat', data, foljsUpp: null });
}

/** FR-16 delkrav 3 (Story 5.2 AK 4): det återöppningen tar bort. null = det fanns inget sådant. */
export interface Tidigare {
  resultat: NonNullable<AtagandeJson['resultat']> | null;
  avslutsskal: NonNullable<AtagandeJson['avslutsskal']> | null;
}

/** Återöppnar ett stängt åtagande. Historiken bevaras; revisionen höjs. */
export async function aterppnaAtagande(
  client: PoolClient,
  tenantId: string,
  input: {
    identifier: string;
    grund: Referens;
    nasta: Nasta;
    foljs_upp: string;
    forvantad_revision?: number;
  },
): Promise<{ atagande: Atagande; tidigare: Tidigare; andring: Andring }> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  kravOvergang(fran, 'registrerat');
  // Ur det LÅSTA radläget, innan något tas bort: händelseraden bär exakt det som försvinner.
  const tidigare: Tidigare = {
    resultat: rad.atagande?.resultat ?? null,
    avslutsskal: rad.atagande?.avslutsskal ?? null,
  };
  const data: AtagandeJson = {
    ...rad.atagande,
    grund: [...(rad.atagande?.grund ?? []), input.grund],
    nasta: input.nasta,
  };
  delete data.resultat;
  delete data.avslutsskal;
  const svar = await skrivOchJamfor(client, tenantId, rad, {
    lage: 'registrerat',
    data,
    foljsUpp: input.foljs_upp,
    utforare: null,
  });
  return { ...svar, tidigare };
}

export async function hamtaAtagande(
  client: PoolClient,
  tenantId: string,
  identifier: string,
): Promise<Atagande> {
  const rad = await viaIdentifier(client, tenantId, identifier, false);
  kravAtagande(rad);
  return tillAtagande(rad);
}

// ------------------------------------------------------ delresultatspärren
//
// FR-16 delkrav 5, B-07 (Story 5.5; Davids svar 2026-10-16 kl. 13.21): vilka delresultat som är
// nödvändiga är ett beslut med spår, inte en räkning av barnärenden. Märkningen är en rad per par av
// huvudärende och delärende i nodvandiga_delresultat, och den skrivs bara av de två funktionerna
// här, nådda bara från actionerna marka_nodvandigt_delresultat och ta_bort_nodvandigt_delresultat.
// Ingenting härleds ur titlar eller hierarkin.

/** Märkningens svar. issue_id och identifier är huvudärendets, där spärren verkar. */
export interface Delresultatsmarkning {
  issue_id: string;
  identifier: string;
  delarende: string;
  andrad: boolean;
}

/**
 * B-01 (architecture.md, låsande läsning): delärendets radlås och förälder i samma sats, så att ingen
 * kan flytta delärendet medan märkningen prövar föräldern och skriver. Delärendet låses FÖRE
 * huvudärendet: update_issue låser delärendet och tar sedan, genom främmandenyckeln foralder_id, ett
 * delat lås på den nya föräldern. I samma ordning väntar den ena in den andra, i stället för att
 * Postgres avbryter en av dem med 40P01.
 */
async function hamtaDelarendeForAndring(
  client: PoolClient,
  tenantId: string,
  delId: string,
): Promise<string | null> {
  const { rows } = await client.query<{ foralder_id: string | null }>(
    'SELECT foralder_id FROM issues WHERE tenant_id = $1 AND id = $2 FOR UPDATE',
    [tenantId, delId],
  );
  const rad = rows[0];
  if (!rad) throw new NotFoundError('ärende');
  return rad.foralder_id;
}

/**
 * FR-16 delkrav 5, B-07 (Story 5.5 AK 5): märker ett delärende som nödvändigt delresultat för
 * huvudåtagandet, med aktören ur nyckeln. Delärendet måste ha huvudåtagandets ärende som förälder
 * när märkningen görs (inte_delarende), och huvudärendet måste bära ett åtagande (inget_atagande).
 * Märkningen rör inte åtagandet: ingen revision höjs och issues skrivs inte. Samma märkning igen
 * ger andrad: false, och det unika indexet med villkor gör två samtidiga märkningar till en rad.
 */
export async function markaNodvandigtDelresultat(
  client: PoolClient,
  tenantId: string,
  aktor: Aktor,
  input: { identifier: string; delarende: string },
): Promise<Delresultatsmarkning> {
  const del = await hamtaArende(client, tenantId, input.delarende);
  const foralderId = await hamtaDelarendeForAndring(client, tenantId, del.id);
  const huvud = await viaIdentifier(client, tenantId, input.identifier);
  kravAtagande(huvud);
  // Täcker ett fristående ärende, ett barnbarn, ett barn till ett annat ärende och huvudärendet självt.
  if (foralderId !== huvud.id) {
    throw new BadRequestError(
      'inte_delarende',
      `${del.identifier} är inte ett delärende till ${huvud.identifier} — bara huvudåtagandets egna delärenden kan märkas`,
    );
  }
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO nodvandiga_delresultat (tenant_id, huvud_issue_id, del_issue_id, markt_av_typ, markt_av_namn)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, huvud_issue_id, del_issue_id) WHERE borttagen IS NULL DO NOTHING
     RETURNING id`,
    [tenantId, huvud.id, del.id, aktor.typ, aktor.namn],
  );
  return {
    issue_id: huvud.id,
    identifier: huvud.identifier,
    delarende: del.identifier,
    andrad: rows.length > 0,
  };
}

/**
 * FR-16 delkrav 5, B-07 (Story 5.5 AK 6): tar bort märkningen genom att sätta borttagen på den aktiva
 * raden. Raden står kvar som historik, och spärren läser bara rader utan borttagen. Skälet krävs av
 * schemat och står i händelseraden. Inget krav på åtagande eller förälder: en märkning ska alltid
 * kunna tas bort med skäl, också efter att delärendet flyttats. Huvudärendet låses, så att
 * borttagningen och en samtidig redovisning går i tur och ordning. En märkning som inte finns ger
 * andrad: false.
 */
export async function taBortNodvandigtDelresultat(
  client: PoolClient,
  tenantId: string,
  input: { identifier: string; delarende: string },
): Promise<Delresultatsmarkning> {
  const del = await hamtaArende(client, tenantId, input.delarende);
  const huvud = await viaIdentifier(client, tenantId, input.identifier);
  const { rows } = await client.query<{ id: string }>(
    `UPDATE nodvandiga_delresultat SET borttagen = now()
      WHERE tenant_id = $1 AND huvud_issue_id = $2 AND del_issue_id = $3 AND borttagen IS NULL
      RETURNING id`,
    [tenantId, huvud.id, del.id],
  );
  return {
    issue_id: huvud.id,
    identifier: huvud.identifier,
    delarende: del.identifier,
    andrad: rows.length > 0,
  };
}

/** Ett märkt delärende vars resultat saknas, med delåtagandets läge (null: inget åtagande). */
export interface SaknatDelresultat {
  identifier: string;
  lage: Lage | null;
}

/**
 * FR-16 delkrav 5, B-07 (Story 5.5 AK 1–4): spärrens enda definition. De aktiva märkningarna för
 * huvudärendet vars delärende inte står i genomfört, ordnade efter nummer. Ett genomfört åtagande
 * bär alltid sitt resultat (CHECK issues_atagande_resultat), så läget genomfort är «genomfört med
 * resultat». IS DISTINCT FROM är sant också för NULL: ett delärende utan åtagande saknar resultat.
 * Frågan utgår från märkningen och aldrig från hierarkin, så ett omärkt delärende spärrar inte, och
 * den läser varken ärendets tillstånd eller dess namn. Delärendets läge läses utan lås, som förut.
 */
export async function saknadeDelresultat(
  client: PoolClient,
  tenantId: string,
  huvudId: string,
): Promise<SaknatDelresultat[]> {
  const { rows } = await client.query<SaknatDelresultat>(
    `SELECT t.key || '-' || d.sequence_number AS identifier, d.atagande_lage AS lage
       FROM nodvandiga_delresultat n
       JOIN issues d ON d.id = n.del_issue_id
       JOIN teams t ON t.id = d.team_id
      WHERE n.tenant_id = $1 AND n.huvud_issue_id = $2 AND n.borttagen IS NULL
        AND d.atagande_lage IS DISTINCT FROM 'genomfort'
      ORDER BY t.key, d.sequence_number`,
    [tenantId, huvudId],
  );
  return rows;
}

// ------------------------------------------------------- beslut → åtagande

/**
 * Kopplar ett beslut till sitt huvudåtagande. Unik nyckel på (tenant, beslut):
 * en omkörning hittar samma åtagande i stället för att skapa ett andra.
 */
export async function kopplaBeslut(
  client: PoolClient,
  tenantId: string,
  input: { beslut_id: number; identifier: string },
): Promise<{ identifier: string; issue_id: string; nyskapad: boolean }> {
  const arende = await hamtaArende(client, tenantId, input.identifier);
  const { rows } = await client.query<{ issue_id: string }>(
    `INSERT INTO beslut_atagande (tenant_id, beslut_id, issue_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, beslut_id) DO NOTHING
     RETURNING issue_id`,
    [tenantId, input.beslut_id, arende.id],
  );
  if (rows[0]) {
    return { identifier: arende.identifier, issue_id: arende.id, nyskapad: true };
  }
  const befintlig = await client.query<{ issue_id: string; identifier: string }>(
    `SELECT b.issue_id, t.key || '-' || i.sequence_number AS identifier
       FROM beslut_atagande b
       JOIN issues i ON i.id = b.issue_id
       JOIN teams t ON t.id = i.team_id
      WHERE b.tenant_id = $1 AND b.beslut_id = $2`,
    [tenantId, input.beslut_id],
  );
  const rad = befintlig.rows[0];
  if (!rad) throw new NotFoundError('beslutskoppling');
  return { identifier: rad.identifier, issue_id: rad.issue_id, nyskapad: false };
}

export async function atagandeForBeslut(
  client: PoolClient,
  tenantId: string,
  beslutId: number,
): Promise<Atagande | null> {
  const { rows } = await client.query<{ issue_id: string }>(
    'SELECT issue_id FROM beslut_atagande WHERE tenant_id = $1 AND beslut_id = $2',
    [tenantId, beslutId],
  );
  const rad = rows[0];
  if (!rad) return null;
  const full = await las(client, tenantId, rad.issue_id, false);
  return full.atagande_lage ? tillAtagande(full) : null;
}

/**
 * Registrerar ett svarstillfälle. Med löpnummer är hashen en kontroll av
 * innehållet; utan löpnummer används den äldre klientens hashidentitet.
 * Samma identitet och hash returnerar false utan att ändra historikraden.
 */
export async function registreraSvarsversion(
  client: PoolClient,
  tenantId: string,
  input: { beslut_id: number; svar_hash: string; issue_id?: string | null; version?: number },
): Promise<{ nyskapad: boolean }> {
  if (input.version === undefined) {
    const { rows } = await client.query(
      `INSERT INTO beslut_svarsversion (tenant_id, beslut_id, svar_hash, issue_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, beslut_id, svar_hash) WHERE version IS NULL DO NOTHING
       RETURNING svar_hash`,
      [tenantId, input.beslut_id, input.svar_hash, input.issue_id ?? null],
    );
    return { nyskapad: rows.length > 0 };
  }

  const { rows } = await client.query(
    `INSERT INTO beslut_svarsversion (tenant_id, beslut_id, version, svar_hash, issue_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, beslut_id, version) WHERE version IS NOT NULL DO NOTHING
     RETURNING svar_hash`,
    [tenantId, input.beslut_id, input.version, input.svar_hash, input.issue_id ?? null],
  );
  if (rows.length === 0) {
    // INSERT väntar på en samtidig insättning. I READ COMMITTED ser denna
    // separata SELECT därefter den bekräftade raden innan någon händelse skrivs.
    const befintlig = await client.query<{ svar_hash: string }>(
      `SELECT svar_hash FROM beslut_svarsversion
       WHERE tenant_id = $1 AND beslut_id = $2 AND version = $3`,
      [tenantId, input.beslut_id, input.version],
    );
    if (befintlig.rows[0]?.svar_hash !== input.svar_hash) {
      throw new BadRequestError('svarsversion_hash_avviker');
    }
  }
  return { nyskapad: rows.length > 0 };
}

// ------------------------------------------------------------- momentloggen

/**
 * Skriver ett arbetsmoment. Aktören tas UR NYCKELN — annars mäter prov 6 vad
 * någon påstår om arbetsfördelningen i stället för vem som arbetade.
 *
 * `historisk` är den enda vägen att ange en annan aktör, och den finns bara
 * för backfill av gammal data. Historiska rader räknas aldrig in i mätningen
 * efter införandet; de skulle blanda påstående med observation.
 */
export async function loggaMoment(
  client: PoolClient,
  tenantId: string,
  aktor: Aktor,
  input: {
    moment: Moment;
    issue_id?: string | null;
    beslut_id?: number | null;
    belagg?: unknown;
    historisk?: { aktor_typ: string; aktor_namn: string; tidpunkt: string };
  },
): Promise<{ id: string }> {
  const h = input.historisk;
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO arbetsmoment
       (tenant_id, issue_id, beslut_id, moment, aktor_typ, aktor_namn, belagg, historisk, tidpunkt)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, COALESCE($9::timestamptz, now()))
     RETURNING id::text`,
    [
      tenantId,
      input.issue_id ?? null,
      input.beslut_id ?? null,
      input.moment,
      h ? h.aktor_typ : aktor.typ,
      h ? h.aktor_namn : aktor.namn,
      JSON.stringify(input.belagg ?? {}),
      Boolean(h),
      h ? h.tidpunkt : null,
    ],
  );
  const rad = rows[0];
  if (!rad) throw new Error('arbetsmoment kunde inte skrivas');
  return rad;
}

export interface Arbetsandel {
  fran: string;
  till: string;
  moment_totalt: number;
  moment_manniska: number;
  andel_manniska: number | null;
  per_moment: { moment: string; manniska: number; agent: number; system: number }[];
}

/**
 * Davids arbetsandel, mätt på faktiskt skrivna moment. Läser INTE `tillhor`,
 * antal ärenden, frågor eller klick — de är proxyer och skulle ljuga tyst.
 * Historiska rader utesluts: de är påstådda, inte observerade.
 */
export async function arbetsandel(
  client: PoolClient,
  tenantId: string,
  fran: string,
  till: string,
): Promise<Arbetsandel> {
  const { rows } = await client.query<{
    moment: string;
    manniska: string;
    agent: string;
    system: string;
  }>(
    `SELECT moment,
            count(*) FILTER (WHERE aktor_typ = 'manniska')::text AS manniska,
            count(*) FILTER (WHERE aktor_typ = 'agent')::text    AS agent,
            count(*) FILTER (WHERE aktor_typ = 'system')::text   AS system
       FROM arbetsmoment
      WHERE tenant_id = $1 AND historisk = false
        AND tidpunkt >= $2::timestamptz AND tidpunkt < $3::timestamptz
      GROUP BY moment ORDER BY moment`,
    [tenantId, fran, till],
  );
  const per = rows.map((r) => ({
    moment: r.moment,
    manniska: Number(r.manniska),
    agent: Number(r.agent),
    system: Number(r.system),
  }));
  const totalt = per.reduce((s, r) => s + r.manniska + r.agent + r.system, 0);
  const manniska = per.reduce((s, r) => s + r.manniska, 0);
  return {
    fran,
    till,
    moment_totalt: totalt,
    moment_manniska: manniska,
    // Ingen observation ger INGEN siffra. Noll vore ett påstående.
    andel_manniska: totalt === 0 ? null : Math.round((manniska / totalt) * 1000) / 10,
    per_moment: per,
  };
}

// ------------------------------------------------------------------ listning

export interface AtagandeRad extends Atagande {
  forfallen_uppfoljning: boolean;
}

/** Åtaganden för ytan. Sorterade så att det som kräver en människa ligger först. */
export async function listaAtaganden(
  client: PoolClient,
  tenantId: string,
  filter: { tillhor?: Tillhor; lage?: Lage; oavslutade?: boolean } = {},
): Promise<AtagandeRad[]> {
  const villkor: string[] = ['i.tenant_id = $1', 'i.atagande_lage IS NOT NULL'];
  const params: unknown[] = [tenantId];
  if (filter.tillhor) {
    params.push(filter.tillhor);
    villkor.push(`i.atagande_tillhor = $${params.length}`);
  }
  if (filter.lage) {
    params.push(filter.lage);
    villkor.push(`i.atagande_lage = $${params.length}`);
  }
  if (filter.oavslutade) {
    villkor.push("i.atagande_lage NOT IN ('genomfort','avslutat')");
  }
  const { rows } = await client.query<Rad & { forfallen: boolean }>(
    `SELECT i.id,
            t.key || '-' || i.sequence_number AS identifier,
            i.title, i.team_id,
            i.atagande_lage, i.atagande_tillhor,
            i.atagande_utforare_typ, i.atagande_utforare_namn,
            i.atagande_overtaget_nar, i.atagande_foljs_upp,
            i.atagande_revision, i.atagande,
            (i.atagande_foljs_upp IS NOT NULL AND i.atagande_foljs_upp < now()) AS forfallen
       FROM issues i JOIN teams t ON t.id = i.team_id
      WHERE ${villkor.join(' AND ')}
      ORDER BY CASE i.atagande_tillhor
                 WHEN 'agare' THEN 0 WHEN 'anvandare' THEN 1 ELSE 2 END,
               i.atagande_foljs_upp NULLS LAST`,
    params,
  );
  return rows.map((r) => ({ ...tillAtagande(r), forfallen_uppfoljning: r.forfallen }));
}

// ------------------------------------------------------------------ mätningen

/** Ett öppet åtagande som bryter mot kravOppetSteg, med de fält som saknas (nasta före foljs_upp). */
export interface Atagandebrott {
  identifier: string;
  lage: Lage;
  saknas: ('nasta' | 'foljs_upp')[];
}

/**
 * B-07 (Story 5.1 AK 7): läsande mätning av öppna åtaganden som saknar nästa steg eller
 * uppföljningstid, alltså rader som skrivits förbi API:t. Invarianten är ingen CHECK, så de kan
 * finnas, och de rättas bara med andra_atagande, aldrig här. Inget radlås och ingen skrivning.
 * jsonb_typeof ger 'null' för JSON-null och SQL-NULL för en saknad nyckel, så IS DISTINCT FROM
 * 'object' fångar båda; IS NULL hade missat JSON-null.
 */
export async function matAtagandebrott(client: PoolClient, tenantId: string): Promise<Atagandebrott[]> {
  const { rows } = await client.query<{
    identifier: string;
    lage: Lage;
    saknar_nasta: boolean;
    saknar_foljs_upp: boolean;
  }>(
    `SELECT t.key || '-' || i.sequence_number AS identifier,
            i.atagande_lage AS lage,
            jsonb_typeof(i.atagande->'nasta') IS DISTINCT FROM 'object' AS saknar_nasta,
            i.atagande_foljs_upp IS NULL AS saknar_foljs_upp
       FROM issues i JOIN teams t ON t.id = i.team_id
      WHERE i.tenant_id = $1
        AND i.atagande_lage IN ('registrerat','overtaget','hindrat')
        AND (jsonb_typeof(i.atagande->'nasta') IS DISTINCT FROM 'object'
             OR i.atagande_foljs_upp IS NULL)
      ORDER BY t.key, i.sequence_number`,
    [tenantId],
  );
  return rows.map((r) => {
    const saknas: Atagandebrott['saknas'] = [];
    if (r.saknar_nasta) saknas.push('nasta');
    if (r.saknar_foljs_upp) saknas.push('foljs_upp');
    return { identifier: r.identifier, lage: r.lage, saknas };
  });
}

export type Statusavvikelse = { identifier: string; lage: Lage; state_typ: StateTyp; mal: StateTyp };

/**
 * B-02, Story 3.2 AK 7 och AK 9: läsande mätning av rader skrivna förbi API:t.
 * Inget radlås och ingen skrivning. Rättningen sker bara med update_issue_state till mal.
 * Tabellen skickas som jsonb-värde så att härledningen har en enda definition.
 */
export async function matStatusavvikelser(client: PoolClient, tenantId: string): Promise<Statusavvikelse[]> {
  const { rows } = await client.query<Statusavvikelse>(
    `SELECT t.key || '-' || i.sequence_number AS identifier,
            i.atagande_lage AS lage,
            s.typ AS state_typ,
            $2::jsonb ->> i.atagande_lage AS mal
       FROM issues i
       JOIN teams t ON t.id = i.team_id
       JOIN workflow_states s ON s.id = i.state_id
      WHERE i.tenant_id = $1
        AND i.atagande_lage IS NOT NULL
        AND s.typ IS DISTINCT FROM ($2::jsonb ->> i.atagande_lage)
      ORDER BY t.key, i.sequence_number`,
    [tenantId, JSON.stringify(STATE_FOR_LAGE)],
  );
  return rows;
}

/** Ett huvudåtagande som barnräkningen spärrade, med delärendena vars åtagande var öppet. */
export interface Delresultatsparr {
  identifier: string;
  lage: Lage;
  delarenden: { identifier: string; lage: Lage }[];
}

/**
 * FR-16 delkrav 5, B-07 (Story 5.5 AK 8–9): läsande mätning av dagens spärrar, underlaget för
 * märkningen i drift. Den mäter med avsikt den gamla regeln, barnräkningen: varje ärende med åtagande
 * som har minst ett delärende vars åtagande finns och inte står i genomfört eller avslutat. Spärren
 * själv är saknadeDelresultat, och skillnaden är meningen: mätningen säger vilka delärenden som ska
 * märkas eller lämnas med ett antecknat skäl. Den läser bara issues och teams, så den ger samma lista
 * före migrationen 0018 som direkt efter driftsättningen. Den listar huvudåtagandet i varje läge, också
 * genomfört, så att ett huvudåtagande som redovisats efter spärrbytet syns i listan (AK 9). Inget
 * radlås och ingen skrivning. Står sist i filen, så att provet N17 läser kroppen till filens slut.
 */
export async function matDelresultat(client: PoolClient, tenantId: string): Promise<Delresultatsparr[]> {
  const { rows } = await client.query<{ identifier: string; lage: Lage; del_identifier: string; del_lage: Lage }>(
    `SELECT ht.key || '-' || h.sequence_number AS identifier,
            h.atagande_lage AS lage,
            bt.key || '-' || b.sequence_number AS del_identifier,
            b.atagande_lage AS del_lage
       FROM issues h
       JOIN teams ht ON ht.id = h.team_id
       JOIN issues b ON b.foralder_id = h.id
       JOIN teams bt ON bt.id = b.team_id
      WHERE h.tenant_id = $1 AND b.tenant_id = $1
        AND h.atagande_lage IS NOT NULL
        AND b.atagande_lage IS NOT NULL
        AND b.atagande_lage NOT IN ('genomfort','avslutat')
      ORDER BY ht.key, h.sequence_number, bt.key, b.sequence_number`,
    [tenantId],
  );
  // Raderna kommer ordnade per huvudärende; de grupperas här, ett huvudåtagande per post.
  const sparrar: Delresultatsparr[] = [];
  for (const r of rows) {
    let sista = sparrar[sparrar.length - 1];
    if (!sista || sista.identifier !== r.identifier) {
      sista = { identifier: r.identifier, lage: r.lage, delarenden: [] };
      sparrar.push(sista);
    }
    sista.delarenden.push({ identifier: r.del_identifier, lage: r.del_lage });
  }
  return sparrar;
}
