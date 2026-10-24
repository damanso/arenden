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

export interface Insats {
  id: string;
  stopp_id: string;
  issue_id: string | null;
  /**
   * D-2, B-21 (Story 11.2): ärendets absoluta adress, eller null för en insats utan ärende.
   * Härleds vid läsning i medKallor och lagras aldrig.
   */
  lank: string | null;
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
  handlingskontrakt: Record<string, unknown>;
  svar_text: string | null;
  svar_aktor: string | null;
  svar_nar: Date | null;
  fortsattning: unknown;
  skapad: Date;
  kallor: Kallreferens[];
}

const KOL = `id, stopp_id, issue_id, typ, tillhor, utfall, begard_handling,
             blockeringsgrund, belagg, frist, vackningstid, lage, version,
             handlingskontrakt, svar_text, svar_aktor, svar_nar, fortsattning, skapad`;

async function medKallor(
  client: PoolClient,
  tenantId: string,
  rader: Omit<Insats, 'kallor' | 'lank'>[],
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
  // D-2, B-21 (Story 11.2): ärendets adress, i EN fråga för hela uppsättningen rader som
  // källfrågan ovan — aldrig en per rad. Bara när någon rad har ett ärende.
  const arendeIdn = [...new Set(rader.flatMap((r) => (r.issue_id === null ? [] : [r.issue_id])))];
  const identifierFor = new Map<string, string>();
  if (arendeIdn.length > 0) {
    const { rows: arenden } = await client.query<{ id: string; identifier: string }>(
      `SELECT i.id, t.key || '-' || i.sequence_number AS identifier
         FROM issues i JOIN teams t ON t.id = i.team_id
        WHERE i.tenant_id = $1 AND i.id = ANY($2::uuid[])`,
      [tenantId, arendeIdn],
    );
    for (const a of arenden) identifierFor.set(a.id, a.identifier);
  }
  return rader.map((r) => {
    const identifier = r.issue_id === null ? undefined : identifierFor.get(r.issue_id);
    return { ...r, lank: identifier === undefined ? null : arendeLank(identifier), kallor: per.get(r.id) ?? [] };
  });
}

async function las(
  client: PoolClient,
  tenantId: string,
  id: string,
  lasa = false,
): Promise<Insats> {
  const { rows } = await client.query<Omit<Insats, 'kallor' | 'lank'>>(
    `SELECT ${KOL} FROM insatser WHERE tenant_id = $1 AND id = $2${lasa ? ' FOR UPDATE' : ''}`,
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
  const villkor = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (filter.lage) {
    params.push(filter.lage);
    villkor.push(`lage = $${params.length}`);
  } else if (!filter.inklusive_stangda) {
    villkor.push(
      `(lage = 'vantande' OR (lage = 'uppskjuten' AND vackningstid <= now()))`,
    );
  }
  if (filter.tillhor) {
    params.push(filter.tillhor);
    villkor.push(`tillhor = $${params.length}`);
  }
  const { rows } = await client.query<Omit<Insats, 'kallor' | 'lank'>>(
    `SELECT ${KOL} FROM insatser WHERE ${villkor.join(' AND ')}
      ORDER BY CASE tillhor WHEN 'agare' THEN 0 ELSE 1 END,
               frist NULLS LAST, skapad`,
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
