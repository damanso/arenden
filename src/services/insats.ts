// Insatsen: ETT bestämt stopp där arbetet behöver en människa.
// Spec: Astra 2026-09-09 §4. David: "Dessa ska vara samlade."
//
// Det som gör det här till mer än en ny inkorg:
//
//   * Källorna KOPPLAS, de kopieras inte. Samma fråga som kommer som beslut,
//     CRM-löfte och briefrad blir EN insats med tre källreferenser — den unika
//     nyckeln i insats_kallor gör dubbletten omöjlig, inte otrolig.
//   * TYPEN överlever. Ett CRM-löfte och ett ägarbeslut får inte bli identiska
//     kort: typen avgör vilket kommando som får köras och vad formuläret ber om.
//     KOMMANDOTABELL binder varje typ till sina kommandon, och registreraInsats
//     avvisar en otillåten kombination före varje skrivning (FR-27, B-09, Story 6.3).
//   * SVARET kräver en människa. Aktören tas ur API-nyckeln; en agentnyckel kan
//     inte bokföras som om David svarat. Det är inte en regel i en kommentar —
//     besvaraInsats kastar.
//   * Hermes UTFÖR ALDRIG härifrån. Handlingskontraktet pekar ut ägarsystemet
//     och dess kommando; svaret registrerar ställningstagandet och lämnar
//     utförandet till den som äger domänreglerna.
import type { PoolClient } from 'pg';
import { arendeLank } from '../lib/arendelank.js';
import { BadRequestError, ForbiddenError, NotFoundError } from '../lib/errors.js';
import type { Aktor } from '../lib/aktor.js';

export type InsatsTyp =
  | 'agarbeslut'
  | 'utathandling'
  | 'kundkontakt'
  | 'godkannande'
  | 'intygande';
export type InsatsTillhor = 'agare' | 'anvandare';
export type InsatsLage =
  | 'vantande'
  | 'uppskjuten'
  | 'svar_mottaget'
  | 'aterkallad'
  | 'avslutad';

export interface Kallreferens {
  system: string;
  objekttyp: string;
  objekt_id: string;
  objekt_version?: string | null;
  lank?: string | null;
}

/** D-2, B-22 (Story 11.3): ärendet som en insats hör till, joinat in i insatsfrågan. */
export interface InsatsArende {
  identifier: string;
  titel: string;
  /** Ärendets absoluta adress ur arendeLank. Härleds vid läsning och lagras aldrig. */
  lank: string;
}

export interface Insats {
  id: string;
  stopp_id: string;
  issue_id: string | null;
  /**
   * D-2, B-21 (Story 11.2): ärendets absoluta adress, eller null för en insats utan ärende.
   * Härleds vid läsning i medKallor och lagras aldrig. Samma värde som `arende.lank`.
   */
  lank: string | null;
  /** D-2, B-22 (Story 11.3): ärendet, eller null för en insats utan ärende. */
  arende: InsatsArende | null;
  typ: InsatsTyp;
  tillhor: InsatsTillhor;
  utfall: string;
  begard_handling: string;
  blockeringsgrund: string;
  belagg: unknown[];
  frist: Date | null;
  vackningstid: Date | null;
  lage: InsatsLage;
  version: number;
  /**
   * jsonb som pg ger det, med underlaget härlett vid läsning (harledHandlingskontrakt). Ett objekt för
   * varje rad som API:t skrivit; `unknown`, som Kortinsats.handlingskontrakt, eftersom en rad som bara
   * ägarrollen kan skriva får vara något annat och då returneras oförändrad.
   */
  handlingskontrakt: unknown;
  svar_text: string | null;
  svar_aktor: string | null;
  svar_nar: Date | null;
  fortsattning: unknown;
  skapad: Date;
  kallor: Kallreferens[];
}

// Insatsens kolumner, kvalificerade med insatsens alias ins: issues har också id, tenant_id och skapad.
const KOL = `ins.id, ins.stopp_id, ins.issue_id, ins.typ, ins.tillhor, ins.utfall, ins.begard_handling,
             ins.blockeringsgrund, ins.belagg, ins.frist, ins.vackningstid, ins.lage, ins.version,
             ins.handlingskontrakt, ins.svar_text, ins.svar_aktor, ins.svar_nar, ins.fortsattning, ins.skapad`;

// D-2, B-22 (Story 11.3): ärendet joinas in i insatsfrågan, så att adressen och underlaget härleds ur samma
// fråga som insatsen och ingen fråga ställs per insats eller per ärende (inga N+1-frågor). LEFT JOIN, så att
// en insats utan ärende står kvar med två null-kolumner. De två kolumnerna står aldrig i svaret.
const ARENDEKOL = `t.key || '-' || i.sequence_number AS arende_identifier, i.title AS arende_titel`;
const FRAN = `FROM insatser ins
  LEFT JOIN issues i ON i.id = ins.issue_id AND i.tenant_id = ins.tenant_id
  LEFT JOIN teams t ON t.id = i.team_id AND t.tenant_id = i.tenant_id`;

/** En rad ur insatsfrågan: insatsens kolumner och ärendets två inkopplade kolumner (null utan ärende). */
type Insatsrad = Omit<Insats, 'kallor' | 'lank' | 'arende'> & {
  arende_identifier: string | null;
  arende_titel: string | null;
};

/**
 * D-2, B-22 (Story 11.3): handlingskontraktet som läsvägarna svarar med. För en insats på ett ärende är
 * underlaget ärendets adress ur arendeLank, och det lagrade underlaget står bredvid som
 * `underlag_lagrat`. Utan ärende är underlaget det lagrade, eller null när nyckeln saknas, aldrig en påhittad
 * adress. `underlag_harlett` säger vilket. Härledd data lagras inte: funktionen är ren, läser ingen databas,
 * ändrar inte sitt indata och anropas bara vid läsning. De tre nycklarna skrivs efter de lagrade, så att en
 * äldre rad med egna värden för dem aldrig behåller dem. Ett lagrat kontrakt som inte är ett objekt (bara
 * ägarrollen kan skriva ett sådant, schemat i registrera_insats är strikt) returneras oförändrat.
 */
export function harledHandlingskontrakt(lagrat: unknown, identifier: string | null): unknown {
  if (typeof lagrat !== 'object' || lagrat === null || Array.isArray(lagrat)) return lagrat;
  const kontrakt = lagrat as Record<string, unknown>;
  // Object.hasOwn: bara en egen nyckel är ett lagrat underlag, som i arInsatsTyp.
  const lagratUnderlag = Object.hasOwn(kontrakt, 'underlag') ? kontrakt.underlag : null;
  return {
    ...kontrakt,
    underlag: identifier === null ? lagratUnderlag : arendeLank(identifier),
    underlag_harlett: identifier !== null,
    underlag_lagrat: lagratUnderlag,
  };
}

/**
 * Läsmodellen byggs bara här, och alla läsvägar går hit: las, listaInsatser och, via las, insatsForKalla
 * och skrivvägarnas svar. Källorna läses i EN fråga för hela uppsättningen rader; ärendet kommer redan ur
 * insatsfrågan. Härledningen skriver aldrig: raden i insatser är densamma före och efter (B-22).
 */
async function medKallor(
  client: PoolClient,
  tenantId: string,
  rader: Insatsrad[],
): Promise<Insats[]> {
  if (!rader.length) return [];
  const { rows } = await client.query<Kallreferens & { insats_id: string }>(
    `SELECT insats_id, system, objekttyp, objekt_id, objekt_version, lank
       FROM insats_kallor WHERE tenant_id = $1 AND insats_id = ANY($2::uuid[])`,
    [tenantId, rader.map((r) => r.id)],
  );
  const per = new Map<string, Kallreferens[]>();
  for (const k of rows) {
    const lista = per.get(k.insats_id) ?? [];
    lista.push({
      system: k.system,
      objekttyp: k.objekttyp,
      objekt_id: k.objekt_id,
      objekt_version: k.objekt_version ?? null,
      lank: k.lank ?? null,
    });
    per.set(k.insats_id, lista);
  }
  // D-2, B-21 och B-22 (Story 11.2 och 11.3): ärendets adress och handlingskontraktets underlag
  // härleds ur de två inkopplade kolumnerna, som inte följer med till svaret.
  return rader.map(({ arende_identifier, arende_titel, ...r }) => {
    const arende: InsatsArende | null =
      arende_identifier === null || arende_titel === null
        ? null
        : { identifier: arende_identifier, titel: arende_titel, lank: arendeLank(arende_identifier) };
    const identifier = arende === null ? null : arende.identifier;
    return {
      ...r,
      lank: arende === null ? null : arende.lank,
      arende,
      handlingskontrakt: harledHandlingskontrakt(r.handlingskontrakt, identifier),
      kallor: per.get(r.id) ?? [],
    };
  });
}

async function las(
  client: PoolClient,
  tenantId: string,
  id: string,
  lasa = false,
): Promise<Insats> {
  if (lasa) {
    // B-01 (som hamtaArendeForAndring i src/services/arenden.ts): sats 1 tar radlåset på insatsens rad och
    // väntar in den som håller det, och sats 2 nedan läser insatsen och ärendet med en NY ögonblicksbild
    // (READ COMMITTED ger varje sats sin egen). En enda låsande sats med joinen hade efter väntan gett
    // insatsens nya rad men ärendet ur den gamla ögonblicksbilden: en samtidig koppling hade svarat med
    // issue_id satt och arende null. Därför är varje låsande läsning färsk, också den som en skrivväg svarar
    // med utan att skriva. Låset tar bara insatsens rad; ärendet och teamet låses inte.
    const { rows: last } = await client.query<{ id: string }>(
      'SELECT ins.id FROM insatser ins WHERE ins.tenant_id = $1 AND ins.id = $2 FOR UPDATE OF ins',
      [tenantId, id],
    );
    if (!last[0]) throw new NotFoundError('insats');
  }
  const { rows } = await client.query<Insatsrad>(
    `SELECT ${KOL}, ${ARENDEKOL} ${FRAN} WHERE ins.tenant_id = $1 AND ins.id = $2`,
    [tenantId, id],
  );
  const rad = rows[0];
  if (!rad) throw new NotFoundError('insats');
  return (await medKallor(client, tenantId, [rad]))[0]!;
}

/**
 * Slår upp insatsen för ett källobjekt. Det är den här uppslagningen som gör
 * att samma fråga från fyra håll blir EN insats i stället för fyra kort.
 */
export async function insatsForKalla(
  client: PoolClient,
  tenantId: string,
  kalla: { system: string; objekttyp: string; objekt_id: string },
): Promise<Insats | null> {
  const { rows } = await client.query<{ insats_id: string }>(
    `SELECT insats_id FROM insats_kallor
      WHERE tenant_id = $1 AND system = $2 AND objekttyp = $3 AND objekt_id = $4`,
    [tenantId, kalla.system, kalla.objekttyp, kalla.objekt_id],
  );
  const rad = rows[0];
  if (!rad) return null;
  return las(client, tenantId, rad.insats_id);
}

export interface RegistreraIn {
  stopp_id: string;
  typ: InsatsTyp;
  tillhor: InsatsTillhor;
  utfall: string;
  begard_handling: string;
  blockeringsgrund: string;
  belagg?: unknown[];
  frist?: string | null;
  identifier?: string | null;
  handlingskontrakt: Record<string, unknown>;
  kallor: Kallreferens[];
}

/** En rad i KOMMANDOTABELL: härledd med sina kommandon, eller väntande med dagens beteende. */
export type Kommandorad =
  | { readonly lage: 'harledd'; readonly kommandon: readonly string[]; readonly grund: string }
  | { readonly lage: 'vantar'; readonly grund: string };

// Object.freeze är grund. Därför fryser de två hjälparna själva raden och listan med
// kommandon, och tabellen byggs bara med dem.
function harledd(kommandon: readonly string[], grund: string): Kommandorad {
  const rad: Kommandorad = { lage: 'harledd', kommandon: Object.freeze([...kommandon]), grund };
  return Object.freeze(rad);
}

function vantar(grund: string): Kommandorad {
  const rad: Kommandorad = { lage: 'vantar', grund };
  return Object.freeze(rad);
}

/**
 * Typen styr vilket kommando som får utföras (FR-27, B-09). Den enda tabellen över vilka kommandon i
 * handlingskontraktet en insatstyp får bära. Raderna är härledda ur Astras enprodukt-analys §4, så som
 * korten som Davids svar 2026-10-16 och 2026-10-23 godkände återger den, och varje rad bär sin grund
 * som text. Tabellen ändras bara genom en berättelse eller correct-course, aldrig i förbigående.
 *
 * Den är djupfryst: tabellen, varje rad och varje lista. En väntande rad (`vantar`) är dagens
 * beteende, att typen godtar varje kommando, tills raden förs in. `satisfies` gör att tsc fäller en
 * saknad och en extra typ. Grinden i registreraInsats och mätningen läser tabellen bara genom
 * kommandotTillats().
 */
export const KOMMANDOTABELL: Readonly<Record<InsatsTyp, Kommandorad>> = Object.freeze({
  agarbeslut: harledd(
    ['beslutskoe --besvara'],
    '§4 enligt kortets rekommendation, som Davids svar 2026-10-16 kl. 13.21 godkände: «ägarbeslut ger ' +
      'ett svar på beslutet». Kommandot är Beslutsköns svarskommando, som insatssamling.py skickar för ' +
      'beslut ur beslutskön (avläst 2026-10-17).',
  ),
  utathandling: harledd(
    ['redovisa_resultat'],
    '§4 enligt kortets rekommendation, som Davids svar 2026-10-16 kl. 13.21 godkände: «att godkänna ett ' +
      'utkast är ett annat kommando än att registrera att något faktiskt har skickats». Registreringen av ' +
      'ett faktiskt utfört utskick är redovisa_resultat, som kräver belägg (FR-16, B-07).',
  ),
  kundkontakt: harledd(
    ['set_crm_commitment_status', 'snooze_crm_commitment', 'log_contact'],
    '§4 enligt kortets rekommendation, som Davids svar 2026-10-23 kl. 22.28 godkände: CRM-löftena i ' +
      'redovisningen ägs där, och «Typen får därför bara set_crm_commitment_status (klart kräver belägg), ' +
      'snooze_crm_commitment och log_contact». Kommandona är CRM:ets befintliga kommandon för kundlöften.',
  ),
  godkannande: vantar(
    '§4 enligt kortets rekommendation, som Davids svar 2026-10-23 kl. 22.28 godkände: «Därför får typen ' +
      'bara redovisningens godkänn och avslå». Saknas: kommandonas namn i redovisningen, som ingen källa ' +
      'i repot namnger. Raden förs in genom correct-course när namnen är lästa (FR-27, Story 6.3).',
  ),
  intygande: vantar(
    '§4 enligt kortets rekommendation, som Davids svar 2026-10-23 kl. 22.28 godkände: ett eget kommando ' +
      'i ärendeplattformen, skilt från att registrera ett resultat, byggs i en egen berättelse. Saknas: ' +
      'kommandot, som inte finns än. «Fram till dess godtar typen varje kommando, som i dag» (FR-27, ' +
      'Story 6.3).',
  ),
} satisfies Record<InsatsTyp, Kommandorad>);

// Object.hasOwn: bara en egen nyckel är en typ, aldrig ett ärvt namn som constructor. Mätningen
// läser typen ur databasen, där zod och CHECK inte står emellan.
function arInsatsTyp(typ: string): typ is InsatsTyp {
  return Object.hasOwn(KOMMANDOTABELL, typ);
}

/**
 * Får en insats av typen bära kommandot (FR-27, B-09, Story 6.3)? En härledd rad godtar bara ett
 * kommando som är en sträng och lika, tecken för tecken, med ett i raden: ingen trimning, inget
 * skiftläge och inga argument. En väntande rad godtar varje kommando, också ett som saknas, eftersom
 * det är dagens beteende. En typ som inte är en egen nyckel i tabellen godtas aldrig.
 */
export function kommandotTillats(typ: string, kommando: unknown): boolean {
  if (!arInsatsTyp(typ)) return false;
  const rad = KOMMANDOTABELL[typ];
  if (rad.lage === 'vantar') return true;
  return typeof kommando === 'string' && rad.kommandon.includes(kommando);
}

/**
 * Registrerar en insats. IDEMPOTENT PÅ TVÅ SÄTT, ATOMÄR OCH BUNDEN TILL TYPENS KOMMANDON, och alla
 * fyra behövs:
 *
 *   1. Samma stopp_id ger samma insats tillbaka — en omkörning skapar inget nytt.
 *   2. En källa som redan hör till EN ANNAN insats kopplas inte om i tysthet;
 *      anropet får veta det. Att tyst flytta en källa hade gjort en tappad
 *      koppling osynlig, och tappade kopplingar är hela problemet.
 *   3. Registreringen är ATOMÄR (FR-27, B-09, Story 6.2): raden skapas med
 *      INSERT … ON CONFLICT (tenant_id, stopp_id) DO NOTHING RETURNING, och kommer
 *      ingen rad tillbaka läses den befintliga om. En SELECT före INSERT räcker
 *      inte: en rad som en annan transaktion lagt in men inte committat syns inte
 *      och går inte att låsa, så två samtidiga registreringar av samma nya stopp
 *      gick båda till INSERT, den andra fick 23505 och svaret blev 409.
 *   4. TYPEN STYR KOMMANDOT (FR-27, B-09, Story 6.3): typen och kommandot i handlingskontraktet
 *      prövas mot KOMMANDOTABELL med kommandotTillats() före varje skrivning, och en otillåten
 *      kombination avvisas med otillatet_kommando. Transaktionen rullas då tillbaka innan
 *      händelseraden skrivs. Grinden prövar indatan och inte den lagrade raden, så en avvisad
 *      omregistrering av ett befintligt stopp lämnar raden orörd.
 */
export async function registreraInsats(
  client: PoolClient,
  tenantId: string,
  input: RegistreraIn,
): Promise<{ insats: Insats; nyskapad: boolean; krockar: Kallreferens[] }> {
  if (!input.kallor.length) {
    throw new BadRequestError(
      'kalla_saknas',
      'en insats utan källa går inte att följa tillbaka till varför den finns',
    );
  }

  // FR-27, B-09, Story 6.3: typen styr kommandot. Prövas före ärendeuppslaget och varje skrivning,
  // så att en otillåten kombination ger noll rader, också när stoppet redan finns.
  if (!kommandotTillats(input.typ, input.handlingskontrakt.kommando)) {
    throw new BadRequestError(
      'otillatet_kommando',
      `kommandot får inte utföras för en insats av typen ${input.typ} enligt KOMMANDOTABELL (FR-27)`,
    );
  }

  let issueId: string | null = null;
  if (input.identifier) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT i.id FROM issues i JOIN teams t ON t.id = i.team_id
        WHERE i.tenant_id = $1 AND t.key || '-' || i.sequence_number = $2`,
      [tenantId, input.identifier],
    );
    if (!rows[0]) throw new NotFoundError('ärende');
    issueId = rows[0].id;
  }

  // Ingen läsning före INSERT avgör om stoppet finns. Möter ON CONFLICT en rad som en
  // pågående transaktion lagt in väntar satsen ut den; committar den kommer ingen rad
  // tillbaka, och nästa sats (READ COMMITTED) ser den committade raden.
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO insatser
       (tenant_id, stopp_id, issue_id, typ, tillhor, utfall, begard_handling,
        blockeringsgrund, belagg, frist, handlingskontrakt)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb)
     ON CONFLICT (tenant_id, stopp_id) DO NOTHING
     RETURNING id`,
    [
      tenantId, input.stopp_id, issueId, input.typ, input.tillhor,
      input.utfall, input.begard_handling, input.blockeringsgrund,
      JSON.stringify(input.belagg ?? []), input.frist ?? null,
      JSON.stringify(input.handlingskontrakt),
    ],
  );

  let id: string;
  let nyskapad = false;
  const ny = rows[0];
  if (ny) {
    id = ny.id;
    nyskapad = true;
  } else {
    // Stoppet fanns redan: den befintliga raden returneras oförändrad. FOR UPDATE som
    // förut, så att registreringen väntar ut ett pågående svar, en uppskjutning eller
    // en återkallelse (de låser med las(…, true)).
    const { rows: befintlig } = await client.query<{ id: string }>(
      'SELECT id FROM insatser WHERE tenant_id = $1 AND stopp_id = $2 FOR UPDATE',
      [tenantId, input.stopp_id],
    );
    const rad = befintlig[0];
    if (!rad) throw new NotFoundError('insats');
    id = rad.id;
  }

  // Källorna kopplas en och en. En källa som redan tillhör en ANNAN insats
  // rapporteras som krock — den flyttas aldrig i tysthet.
  const krockar: Kallreferens[] = [];
  for (const k of input.kallor) {
    const { rows } = await client.query<{ insats_id: string }>(
      `INSERT INTO insats_kallor
         (tenant_id, insats_id, system, objekttyp, objekt_id, objekt_version, lank)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, system, objekttyp, objekt_id) DO NOTHING
       RETURNING insats_id`,
      [tenantId, id, k.system, k.objekttyp, k.objekt_id,
       k.objekt_version ?? null, k.lank ?? null],
    );
    if (!rows[0]) {
      const { rows: agare } = await client.query<{ insats_id: string }>(
        `SELECT insats_id FROM insats_kallor
          WHERE tenant_id = $1 AND system = $2 AND objekttyp = $3 AND objekt_id = $4`,
        [tenantId, k.system, k.objekttyp, k.objekt_id],
      );
      if (agare[0] && agare[0].insats_id !== id) krockar.push(k);
    }
  }
  return { insats: await las(client, tenantId, id), nyskapad, krockar };
}

/**
 * Davids svar. KRÄVER EN MÄNNISKA: aktören kommer ur API-nyckeln, och en
 * agentnyckel kan inte bokföras som om han svarat. Det är precis den lögnen
 * hela mätningen av hans arbetsandel står och faller med.
 *
 * Svaret UTFÖR ingenting. Det registrerar ställningstagandet och pekar på
 * handlingskontraktets ägarsystem; domänreglerna ligger kvar där de hör hemma.
 */
export async function besvaraInsats(
  client: PoolClient,
  tenantId: string,
  aktor: Aktor,
  input: { id: string; svar: string; forvantad_version?: number },
): Promise<Insats> {
  if (aktor.typ !== 'manniska') {
    throw new ForbiddenError(
      'kraver_manniska',
      'en insats besvaras av en människa — en agentnyckel kan inte bokföras som ett mänskligt svar',
    );
  }
  const fore = await las(client, tenantId, input.id, true);
  if (input.forvantad_version !== undefined && input.forvantad_version !== fore.version) {
    throw new BadRequestError(
      'gammal_version',
      `insatsen är på version ${fore.version}, svaret utgick från ${input.forvantad_version}`,
    );
  }
  if (fore.lage === 'svar_mottaget') {
    throw new BadRequestError('redan_besvarad', 'insatsen är redan besvarad');
  }
  if (fore.lage === 'aterkallad' || fore.lage === 'avslutad') {
    throw new BadRequestError('stangd', `insatsen är ${fore.lage} och tar inte emot svar`);
  }
  await client.query(
    `UPDATE insatser
        SET lage = 'svar_mottaget', svar_text = $3, svar_aktor = $4,
            svar_nar = now(), version = version + 1, uppdaterad = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, input.id, input.svar, aktor.namn],
  );
  return las(client, tenantId, input.id);
}

/** Uppskjutet ändrar VÄCKNINGSTID, aldrig fristen. Löftet står kvar. */
export async function skjutUppInsats(
  client: PoolClient,
  tenantId: string,
  aktor: Aktor,
  input: { id: string; till: string; skal: string },
): Promise<Insats> {
  if (aktor.typ !== 'manniska') {
    throw new ForbiddenError('kraver_manniska', 'bara en människa kan skjuta upp sin egen insats');
  }
  const fore = await las(client, tenantId, input.id, true);
  if (fore.lage !== 'vantande' && fore.lage !== 'uppskjuten') {
    throw new BadRequestError('stangd', `insatsen är ${fore.lage}`);
  }
  await client.query(
    `UPDATE insatser
        SET lage = 'uppskjuten', vackningstid = $3,
            blockeringsgrund = blockeringsgrund || E'\\nUppskjuten: ' || $4,
            version = version + 1, uppdaterad = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, input.id, input.till, input.skal],
  );
  return las(client, tenantId, input.id);
}

/** Källan är borta eller frågan är inte längre aktuell. Kräver ett skäl. */
export async function aterkallaInsats(
  client: PoolClient,
  tenantId: string,
  input: { id: string; skal: string },
): Promise<Insats> {
  const fore = await las(client, tenantId, input.id, true);
  if (fore.lage === 'svar_mottaget') {
    throw new BadRequestError(
      'redan_besvarad',
      'ett mottaget svar återkallas inte — det är Davids arbete och ska följas till sin fortsättning',
    );
  }
  await client.query(
    `UPDATE insatser
        SET lage = 'aterkallad',
            blockeringsgrund = blockeringsgrund || E'\\nÅterkallad: ' || $3,
            version = version + 1, uppdaterad = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, input.id, input.skal],
  );
  return las(client, tenantId, input.id);
}

/**
 * D-2, B-22 (Story 11.3 AK 4): kopplar en insats som saknar ärende till sitt ärende i efterhand. Det är den
 * enda rättningsvägen för mätningens grupp arendekalla, och den går genom en action med händelserad, aldrig
 * genom rå SQL. TRE utfall, alla avgjorda under radlåset ur las(…, true), så att två samtidiga kopplingar
 * köar och den andra ser den förstas issue_id. las läser insatsen och ärendet först efter låset, så varje
 * svar bär ärendet som det är committat:
 *
 *   1. Samma ärende: `andrad: false` och ingen skrivning, med insatsen som den lästes efter låset.
 *   2. Ett annat ärende: insatsen_hor_till_annat_arende före varje skrivning. En insats flyttas aldrig i
 *      tysthet, och executeAction rullar tillbaka hela transaktionen.
 *   3. Inget ärende: issue_id sätts. Skrivningen har dessutom villkoret att issue_id är null, och det prövas:
 *      träffar den ingen rad har raden ändrats förbi radlåset, och då kastas ett fel i stället för
 *      `andrad: true`, så att transaktionen rullas tillbaka och ingen händelserad påstår en koppling.
 *
 * `version` ändras inte: den skyddar svaret mot en ändrad fråga, och kopplingen ändrar inte frågan. Ett svar
 * som David påbörjat före kopplingen avvisas alltså inte som gammalt. Insatsen kopplas i varje läge.
 */
export async function kopplaInsatsTillArende(
  client: PoolClient,
  tenantId: string,
  input: { id: string; issue_id: string },
): Promise<{ insats: Insats; andrad: boolean }> {
  const fore = await las(client, tenantId, input.id, true);
  if (fore.issue_id === input.issue_id) return { insats: fore, andrad: false };
  if (fore.issue_id !== null) {
    throw new BadRequestError(
      'insatsen_hor_till_annat_arende',
      'insatsen hör redan till ett annat ärende och flyttas aldrig i tysthet',
    );
  }
  const { rowCount } = await client.query(
    `UPDATE insatser SET issue_id = $3, uppdaterad = now()
      WHERE tenant_id = $1 AND id = $2 AND issue_id IS NULL`,
    [tenantId, input.id, input.issue_id],
  );
  if (rowCount !== 1) throw new Error(`insatsen ${input.id} ändrades förbi radlåset och kopplades inte`);
  return { insats: await las(client, tenantId, input.id), andrad: true };
}

export async function hamtaInsats(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<Insats> {
  return las(client, tenantId, id);
}

/**
 * Kön. Ordningen är Astras: det som kräver ägaren först, sedan användaren,
 * inom det efter frist. En uppskjuten insats vars väckningstid passerat
 * räknas som väntande igen — annars vore "skjut upp" ett sätt att glömma.
 */
export async function listaInsatser(
  client: PoolClient,
  tenantId: string,
  filter: { lage?: InsatsLage; tillhor?: InsatsTillhor; inklusive_stangda?: boolean } = {},
): Promise<Insats[]> {
  // Villkoren och ordningen kvalificeras med insatsens alias, eftersom ärendet är inkopplat (Story 11.3).
  // Ordningen i kön är densamma som förut.
  const villkor = ['ins.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter.lage) {
    params.push(filter.lage);
    villkor.push(`ins.lage = $${params.length}`);
  } else if (!filter.inklusive_stangda) {
    villkor.push(
      `(ins.lage = 'vantande' OR (ins.lage = 'uppskjuten' AND ins.vackningstid <= now()))`,
    );
  }
  if (filter.tillhor) {
    params.push(filter.tillhor);
    villkor.push(`ins.tillhor = $${params.length}`);
  }
  const { rows } = await client.query<Insatsrad>(
    `SELECT ${KOL}, ${ARENDEKOL} ${FRAN} WHERE ${villkor.join(' AND ')}
      ORDER BY CASE ins.tillhor WHEN 'agare' THEN 0 ELSE 1 END,
               ins.frist NULLS LAST, ins.skapad`,
    params,
  );
  return medKallor(client, tenantId, rows);
}

// ------------------------------------------------------------------ mätningen

/** En befintlig insats vars kombination av typ och kommando tabellen avvisar; kommandot null när det saknas. */
export interface Kombinationsbrott {
  stopp_id: string;
  typ: string;
  lage: string;
  kommando: string | null;
}

/**
 * FR-27, B-09 (Story 6.3 AK 4): läsande mätning av befintliga insatser vars kombination tabellen
 * avvisar, alltså rader som registrerades före grinden eller skrevs förbi den. Listan är underlaget
 * för Beslutskön, som ändrar sina anropare. Inget rättas här, och ingen befintlig rad skrivs om.
 * Mätningen filtrerar med samma kommandotTillats() som grinden och har ingen egen lista över
 * kommandon. Inget radlås och ingen skrivning. handlingskontrakt->>'kommando' är SQL-NULL när
 * kommandot saknas, och predikatet avvisar det för en härledd typ. Ordningen är skapad och id.
 */
export async function matInsatskombinationer(client: PoolClient, tenantId: string): Promise<Kombinationsbrott[]> {
  const { rows } = await client.query<Kombinationsbrott>(
    `SELECT stopp_id, typ, lage, handlingskontrakt->>'kommando' AS kommando
       FROM insatser
      WHERE tenant_id = $1
      ORDER BY skapad, id`,
    [tenantId],
  );
  return rows.filter((r) => !kommandotTillats(r.typ, r.kommando));
}

/**
 * D-2, B-22 (Story 11.3 AK 5): mätningens fyra grupper, i den här ordningen. Varje insats i tenanten står i
 * exakt en, och id:na står i ordningen skapad och id. För arendekalla står också de ärendenummer som
 * insatsens källor pekar på, unika och sorterade.
 */
export interface Insatsunderlag {
  /** Med ärende, och det lagrade underlaget är exakt «/uppfoljning». */
  arende_uppfoljning: string[];
  /** Med ärende och ett annat lagrat underlag, eller inget. */
  arende_eget: string[];
  /** Utan ärende, och minst en källa vars objekt_id tecken för tecken är ett befintligt ärendes identifierare. */
  arendekalla: { id: string; arenden: string[] }[];
  /** Allt annat. */
  utan_arende: string[];
}

/**
 * D-2, B-22 (Story 11.3 AK 5): läsande mätning före rättningen. Mät först, rätta sedan: listan pekar ut de
 * insatser som saknar ärende men har en källa som är ett ärendenummer, och rättningen görs bara med actionen
 * koppla_insats_till_arende. Grupperna är en sluten regel som prövas i ordning, och den första som gäller
 * vinner. Mätningen tolkar inga skrivsätt: ett objekt_id som loc-503 eller LOC-0503 är ingen ärendekälla.
 * Den läser issue_id och det lagrade underlaget, som härledningen vid läsning aldrig skriver om, och ger
 * därför samma grupper före och efter driftsättningen. Inget radlås och ingen skrivning; skriptet kör den
 * i en READ ONLY-transaktion.
 */
export async function matInsatsunderlag(client: PoolClient, tenantId: string): Promise<Insatsunderlag> {
  // En fråga: insatsen och, för varje källa vars objekt_id är ett ärendes identifierare, det ärendet.
  const { rows } = await client.query<{
    id: string;
    issue_id: string | null;
    underlag: string | null;
    arenden: string[];
  }>(
    `SELECT ins.id, ins.issue_id, ins.handlingskontrakt->>'underlag' AS underlag,
            ARRAY(SELECT t.key || '-' || i.sequence_number
                    FROM insats_kallor k
                    JOIN issues i ON i.tenant_id = k.tenant_id
                    JOIN teams t ON t.id = i.team_id
                   WHERE k.tenant_id = ins.tenant_id AND k.insats_id = ins.id
                     AND k.objekt_id = t.key || '-' || i.sequence_number) AS arenden
       FROM insatser ins
      WHERE ins.tenant_id = $1
      ORDER BY ins.skapad, ins.id`,
    [tenantId],
  );
  const svar: Insatsunderlag = { arende_uppfoljning: [], arende_eget: [], arendekalla: [], utan_arende: [] };
  for (const r of rows) {
    if (r.issue_id !== null) {
      (r.underlag === '/uppfoljning' ? svar.arende_uppfoljning : svar.arende_eget).push(r.id);
    } else if (r.arenden.length > 0) {
      svar.arendekalla.push({ id: r.id, arenden: [...new Set(r.arenden)].sort() });
    } else {
      svar.utan_arende.push(r.id);
    }
  }
  return svar;
}
