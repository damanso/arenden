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
import type { PoolClient } from 'pg';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import type { Aktor } from '../lib/aktor.js';
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
  antal_oavslutade_barn: number;
}

const HAMTA = `
  SELECT i.id,
         t.key || '-' || i.sequence_number AS identifier,
         i.title,
         i.team_id,
         i.atagande_lage, i.atagande_tillhor,
         i.atagande_utforare_typ, i.atagande_utforare_namn,
         i.atagande_overtaget_nar, i.atagande_foljs_upp,
         i.atagande_revision, i.atagande,
         (SELECT count(*)::int FROM issues b
           WHERE b.foralder_id = i.id
             AND b.atagande_lage IS NOT NULL
             AND b.atagande_lage NOT IN ('genomfort','avslutat')) AS antal_oavslutade_barn
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

function kravRevision(rad: Rad, forvantad: number | undefined): void {
  if (forvantad !== undefined && forvantad !== rad.atagande_revision) {
    throw new BadRequestError(
      'gammal_revision',
      `åtagandet är på revision ${rad.atagande_revision}, anropet utgick från ${forvantad} — ` +
        'läs om innan nästa sidoeffekt',
    );
  }
}

function tillAtagande(rad: Rad): Atagande {
  return {
    identifier: rad.identifier,
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
 */
const STATE_FOR_LAGE: Record<Lage, string> = {
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
    falt.foljsUpp === undefined ? rad.atagande_foljs_upp : falt.foljsUpp,
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
): Promise<{ atagande: Atagande; nyskapad: boolean }> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  if (rad.atagande_lage) {
    return { atagande: tillAtagande(rad), nyskapad: false };
  }
  if (!input.grund.length) {
    throw new BadRequestError('grund_saknas', 'ett åtagande utan grund är en gissning');
  }
  if (input.nasta === null && input.foljs_upp !== null) {
    throw new BadRequestError('nasta_saknas', 'ett oavslutat åtagande måste ha ett nästa steg');
  }
  if (input.nasta !== null && !input.foljs_upp) {
    throw new BadRequestError(
      'uppfoljning_saknas',
      'ett åtagande utan uppföljningstid blir liggande utan att någon märker det',
    );
  }
  const data: AtagandeJson = {
    grund: input.grund,
    nasta: input.nasta,
    villkor: input.villkor ?? [],
    ...(input.utfall_precisering ? { utfall_precisering: input.utfall_precisering } : {}),
  };
  await skriv(client, rad, { lage: 'registrerat', data, foljsUpp: input.foljs_upp });
  return { atagande: tillAtagande(await las(client, tenantId, rad.id)), nyskapad: true };
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
): Promise<Atagande> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  kravOvergang(fran, 'overtaget');
  const data: AtagandeJson = { ...rad.atagande, nasta: input.nasta };
  delete data.hinder;
  await skriv(client, rad, {
    lage: 'overtaget',
    data,
    foljsUpp: input.foljs_upp,
    utforare: aktor,
  });
  return tillAtagande(await las(client, tenantId, rad.id));
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
    forvantad_revision?: number;
  },
): Promise<Atagande> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const lage = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  if (lage === 'genomfort' || lage === 'avslutat') {
    throw new BadRequestError(
      'atagandet_ar_stangt',
      'ett stängt åtagande ändras genom att återöppnas med nytt belägg, inte genom att skrivas om',
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
  await skriv(client, rad, {
    lage,
    data,
    ...(input.foljs_upp !== undefined ? { foljsUpp: input.foljs_upp } : {}),
  });
  return tillAtagande(await las(client, tenantId, rad.id));
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
): Promise<Atagande> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  kravOvergang(fran, 'hindrat');
  const data: AtagandeJson = {
    ...rad.atagande,
    nasta: input.nasta,
    hinder: { orsak: input.orsak, belagg: input.belagg },
  };
  await skriv(client, rad, { lage: 'hindrat', data, foljsUpp: input.foljs_upp });
  return tillAtagande(await las(client, tenantId, rad.id));
}

/**
 * Genomfört. Kräver belägg, uppfyllda villkor och att inget nödvändigt
 * delarbete återstår. Går ALDRIG från hindrat: ett hinder som blivit gammalt
 * är inte ett resultat.
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
): Promise<Atagande> {
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
  if (rad.antal_oavslutade_barn > 0) {
    throw new BadRequestError(
      'delarbete_aterstar',
      `${rad.antal_oavslutade_barn} delåtagande är inte avslutade — huvudåtagandet kan inte stängas`,
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
  await skriv(client, rad, { lage: 'genomfort', data, foljsUpp: null });
  return tillAtagande(await las(client, tenantId, rad.id));
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
): Promise<Atagande> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravRevision(rad, input.forvantad_revision);
  kravOvergang(fran, 'avslutat');
  const data: AtagandeJson = {
    ...rad.atagande,
    nasta: null,
    avslutsskal: { text: input.text, grund: input.grund },
  };
  await skriv(client, rad, { lage: 'avslutat', data, foljsUpp: null });
  return tillAtagande(await las(client, tenantId, rad.id));
}

/** Återöppnar ett stängt åtagande. Historiken bevaras; revisionen höjs. */
export async function aterppnaAtagande(
  client: PoolClient,
  tenantId: string,
  input: { identifier: string; grund: Referens; nasta: Nasta; foljs_upp: string },
): Promise<Atagande> {
  const rad = await viaIdentifier(client, tenantId, input.identifier);
  const fran = kravAtagande(rad);
  kravOvergang(fran, 'registrerat');
  const data: AtagandeJson = {
    ...rad.atagande,
    grund: [...(rad.atagande?.grund ?? []), input.grund],
    nasta: input.nasta,
  };
  delete data.resultat;
  delete data.avslutsskal;
  await skriv(client, rad, {
    lage: 'registrerat',
    data,
    foljsUpp: input.foljs_upp,
    utforare: null,
  });
  return tillAtagande(await las(client, tenantId, rad.id));
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
 * Registrerar att en bestämd svarsversion har behandlats. Returnerar false om
 * den redan var behandlad — det är spärren mot att samma svar verkställs två
 * gånger, och mot att en komplettering tyst tappas bort (ny text = ny hash).
 */
export async function registreraSvarsversion(
  client: PoolClient,
  tenantId: string,
  input: { beslut_id: number; svar_hash: string; issue_id?: string | null },
): Promise<{ nyskapad: boolean }> {
  const { rows } = await client.query(
    `INSERT INTO beslut_svarsversion (tenant_id, beslut_id, svar_hash, issue_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, beslut_id, svar_hash) DO NOTHING
     RETURNING svar_hash`,
    [tenantId, input.beslut_id, input.svar_hash, input.issue_id ?? null],
  );
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
            0 AS antal_oavslutade_barn,
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
