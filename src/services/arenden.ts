import type { PoolClient } from 'pg';
import { BadRequestError, NotFoundError } from '../lib/errors.js';
import { delaIdentifier, type StateTyp } from '../lib/validation.js';
import { kravTeam, stateAvTyp, type WorkflowState } from './team.js';

export interface Arende {
  id: string;
  identifier: string;
  team_key: string;
  title: string;
  description: string;
  state_namn: string;
  state_typ: StateTyp;
  projekt: string | null;
  labels: string[];
  priority: number | null;
  due_date: string | null;
  claimad_av: string | null;
  source_ref: string | null;
  skapad: Date;
  uppdaterad: Date;
}

// identifier härleds alltid ur team.key + sequence_number (aldrig lagrad, aldrig
// beräknad två gånger på olika sätt). due_date formateras som text så att den
// inte tidszonsförskjuts på vägen genom drivrutinen.
const KOLUMNER = `
  i.id,
  t.key || '-' || i.sequence_number AS identifier,
  t.key AS team_key,
  i.title,
  i.description,
  s.namn AS state_namn,
  s.typ AS state_typ,
  p.namn AS projekt,
  i.priority,
  to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
  i.claimad_av,
  i.source_ref,
  i.skapad,
  i.uppdaterad,
  COALESCE((
    SELECT array_agg(l.namn ORDER BY l.namn)
      FROM issue_labels il JOIN labels l ON l.id = il.label_id
     WHERE il.issue_id = i.id
  ), '{}'::text[]) AS labels`;

const FRAN = `
  FROM issues i
  JOIN teams t ON t.id = i.team_id
  JOIN workflow_states s ON s.id = i.state_id
  LEFT JOIN projects p ON p.id = i.project_id`;

export async function hamtaArendeViaId(
  client: PoolClient,
  tenantId: string,
  id: string,
): Promise<Arende> {
  const { rows } = await client.query<Arende>(
    `SELECT ${KOLUMNER} ${FRAN} WHERE i.tenant_id = $1 AND i.id = $2`,
    [tenantId, id],
  );
  const arende = rows[0];
  if (!arende) throw new NotFoundError('ärende');
  return arende;
}

export async function hamtaArende(
  client: PoolClient,
  tenantId: string,
  identifier: string,
): Promise<Arende> {
  const { teamKey, nummer } = delaIdentifier(identifier);
  const { rows } = await client.query<Arende>(
    `SELECT ${KOLUMNER} ${FRAN} WHERE i.tenant_id = $1 AND t.key = $2 AND i.sequence_number = $3`,
    [tenantId, teamKey, nummer],
  );
  const arende = rows[0];
  if (!arende) throw new NotFoundError('ärende');
  return arende;
}

// ---- Cursor-paginering ----------------------------------------------------
// Keyset på (skapad, id) — stabil även när nya ärenden skapas mitt i en
// genomläsning, till skillnad från OFFSET.

// Tidpunkten tas som Postgres EGEN textrepresentation (mikrosekundsupplösning).
// Date.toISOString() hade kapat till millisekunder, och två ärenden skapade
// inom samma millisekund hade då kunnat hoppas över mellan två sidor.
function kodaCursor(skapadText: string, id: string): string {
  return Buffer.from(`${skapadText}|${id}`, 'utf8').toString('base64url');
}

function avkodaCursor(cursor: string): { skapad: string; id: string } {
  const rader = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const [skapad, id] = rader;
  if (rader.length !== 2 || !skapad || !id) throw new BadRequestError('ogiltig_cursor');
  return { skapad, id };
}

export interface ListaFilter {
  stateTyper?: StateTyp[];
  teamKey?: string;
  label?: string;
  projekt?: string;
  cursor?: string;
  limit: number;
}

export interface ListaResultat {
  arenden: Arende[];
  pageInfo: { har_nasta: boolean; slut_cursor: string | null };
}

export async function listaArenden(
  client: PoolClient,
  tenantId: string,
  filter: ListaFilter,
): Promise<ListaResultat> {
  const efter = filter.cursor ? avkodaCursor(filter.cursor) : null;
  const { rows } = await client.query<Arende & { skapad_nyckel: string }>(
    `SELECT ${KOLUMNER}, i.skapad::text AS skapad_nyckel ${FRAN}
      WHERE i.tenant_id = $1
        AND ($2::text[] IS NULL OR s.typ = ANY($2::text[]))
        AND ($3::text IS NULL OR t.key = $3)
        AND ($4::text IS NULL OR EXISTS (
              SELECT 1 FROM issue_labels il JOIN labels l ON l.id = il.label_id
               WHERE il.issue_id = i.id AND l.namn = $4))
        AND ($5::text IS NULL OR p.namn = $5)
        AND ($6::timestamptz IS NULL OR (i.skapad, i.id) < ($6::timestamptz, $7::uuid))
      ORDER BY i.skapad DESC, i.id DESC
      LIMIT $8`,
    [
      tenantId,
      filter.stateTyper && filter.stateTyper.length > 0 ? filter.stateTyper : null,
      filter.teamKey ?? null,
      filter.label ?? null,
      filter.projekt ?? null,
      efter?.skapad ?? null,
      efter?.id ?? null,
      filter.limit + 1,
    ],
  );

  const harNasta = rows.length > filter.limit;
  const valda = harNasta ? rows.slice(0, filter.limit) : rows;
  const sista = valda[valda.length - 1];
  return {
    // skapad_nyckel är intern paginering och lämnar aldrig tjänstelagret.
    arenden: valda.map(({ skapad_nyckel: _, ...arende }) => arende),
    pageInfo: {
      har_nasta: harNasta,
      slut_cursor: sista ? kodaCursor(sista.skapad_nyckel, sista.id) : null,
    },
  };
}

// ---- Skrivningar ----------------------------------------------------------

export async function hamtaEllerSkapaLabel(
  client: PoolClient,
  tenantId: string,
  namn: string,
): Promise<string> {
  await client.query(
    'INSERT INTO labels (tenant_id, namn) VALUES ($1, $2) ON CONFLICT (tenant_id, namn) DO NOTHING',
    [tenantId, namn],
  );
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM labels WHERE tenant_id = $1 AND namn = $2',
    [tenantId, namn],
  );
  return rows[0]!.id;
}

export async function hamtaEllerSkapaProjekt(
  client: PoolClient,
  tenantId: string,
  namn: string,
): Promise<string> {
  await client.query(
    'INSERT INTO projects (tenant_id, namn) VALUES ($1, $2) ON CONFLICT (tenant_id, namn) DO NOTHING',
    [tenantId, namn],
  );
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM projects WHERE tenant_id = $1 AND namn = $2',
    [tenantId, namn],
  );
  return rows[0]!.id;
}

/**
 * Etapp 2a KRAV-3: underlag för projekt- och etikettfasetterna. Rena läsningar
 * (vylagret får inte innehålla SQL) och samma namn som list_issues filtrerar på.
 */
export async function listaProjektnamn(client: PoolClient, tenantId: string): Promise<string[]> {
  const { rows } = await client.query<{ namn: string }>(
    'SELECT namn FROM projects WHERE tenant_id = $1 ORDER BY namn',
    [tenantId],
  );
  return rows.map((r) => r.namn);
}

export async function listaEtikettnamn(client: PoolClient, tenantId: string): Promise<string[]> {
  const { rows } = await client.query<{ namn: string }>(
    'SELECT namn FROM labels WHERE tenant_id = $1 ORDER BY namn',
    [tenantId],
  );
  return rows.map((r) => r.namn);
}

/** Söker upp en etikett utan att skapa den — sokLabel i adapterkontraktet. */
export async function sokLabel(
  client: PoolClient,
  tenantId: string,
  namn: string,
): Promise<string | null> {
  const { rows } = await client.query<{ id: string }>(
    'SELECT id FROM labels WHERE tenant_id = $1 AND namn = $2',
    [tenantId, namn],
  );
  return rows[0]?.id ?? null;
}

async function kopplaLabels(
  client: PoolClient,
  tenantId: string,
  issueId: string,
  labels: string[],
): Promise<void> {
  for (const labelNamn of labels) {
    const labelId = await hamtaEllerSkapaLabel(client, tenantId, labelNamn);
    await client.query(
      `INSERT INTO issue_labels (tenant_id, issue_id, label_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [tenantId, issueId, labelId],
    );
  }
}

export interface SkapaArendeInput {
  title: string;
  description?: string;
  team_key: string;
  labels?: string[];
  priority?: number;
  due?: string;
}

/**
 * KRAV-5: numret hämtas med nextval ur teamets dedikerade sekvens i SAMMA
 * transaktion som insert:en — aldrig MAX+1. Två samtidiga anrop kan därför
 * aldrig få samma nummer (nextval är icke-transaktionell och därmed racefri).
 */
export async function skapaArende(
  client: PoolClient,
  tenantId: string,
  input: SkapaArendeInput,
): Promise<Arende> {
  const team = await kravTeam(client, tenantId, input.team_key);
  const stateId = (await stateAvTyp(client, team.id, 'backlog')).id;

  const seq = await client.query<{ n: string }>('SELECT nextval($1::regclass)::text AS n', [
    team.sekvensnamn,
  ]);
  const nummer = Number(seq.rows[0]!.n);

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO issues (tenant_id, team_id, state_id, sequence_number,
                         title, description, priority, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date)
     RETURNING id`,
    [
      tenantId,
      team.id,
      stateId,
      nummer,
      input.title,
      input.description ?? '',
      input.priority ?? null,
      input.due ?? null,
    ],
  );
  const id = rows[0]!.id;
  await kopplaLabels(client, tenantId, id, input.labels ?? []);
  return hamtaArendeViaId(client, tenantId, id);
}

export interface ImporteraArendeInput {
  team_id: string;
  team_key: string;
  /** LOC-numret ur filnamnet — numreringen BEHÅLLS (KRAV-15). */
  sequence_number: number;
  /** Idempotensnyckeln ur CRM-kontraktet: 'linear-arkiv:LOC-316' (KRAV-16). */
  source_ref: string;
  state_id: string;
  project_id: string | null;
  title: string;
  description: string;
  labels: string[];
  skapad: string | null;
  uppdaterad: string | null;
}

/**
 * KRAV-16: INSERT ... ON CONFLICT på source_ref. En omkörning skapar noll
 * dubbletter och rapporterar ärendet som oförändrat i stället för att fela.
 */
export async function importeraArende(
  client: PoolClient,
  tenantId: string,
  input: ImporteraArendeInput,
): Promise<{ id: string; identifier: string; nyskapad: boolean }> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO issues (tenant_id, team_id, project_id, state_id, sequence_number,
                         title, description, source_ref, skapad, uppdaterad)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             COALESCE($9::timestamptz, now()), COALESCE($10::timestamptz, now()))
     ON CONFLICT (source_ref) DO NOTHING
     RETURNING id`,
    [
      tenantId,
      input.team_id,
      input.project_id,
      input.state_id,
      input.sequence_number,
      input.title,
      input.description,
      input.source_ref,
      input.skapad,
      input.uppdaterad,
    ],
  );

  const identifier = `${input.team_key}-${input.sequence_number}`;
  const nyId = rows[0]?.id;
  if (nyId) {
    await kopplaLabels(client, tenantId, nyId, input.labels);
    return { id: nyId, identifier, nyskapad: true };
  }

  const befintlig = await client.query<{ id: string }>(
    'SELECT id FROM issues WHERE tenant_id = $1 AND source_ref = $2',
    [tenantId, input.source_ref],
  );
  return { id: befintlig.rows[0]!.id, identifier, nyskapad: false };
}

/**
 * KRAV-15: efter importen sätts teamets sekvens över det högsta importerade
 * numret, så att nya ärenden fortsätter DÄR (LOC-330) i stället för att krocka
 * med arkivet.
 */
export async function sattSekvens(
  client: PoolClient,
  sekvensnamn: string,
  hogstaNummer: number,
): Promise<void> {
  // last_value är NULL tills sekvensen använts första gången. Vi sänker aldrig
  // sekvensen: har någon redan skapat LOC-330 får en omkörd import inte
  // återanvända numret.
  const { rows } = await client.query<{ last_value: string | null }>(
    "SELECT last_value FROM pg_sequences WHERE schemaname = 'public' AND sequencename = $1",
    [sekvensnamn],
  );
  const nuvarande = Number(rows[0]?.last_value ?? 0);
  if (hogstaNummer > nuvarande) {
    await client.query('SELECT setval($1::regclass, $2::bigint)', [sekvensnamn, hogstaNummer]);
  }
}

/**
 * KRAV-11: uppdatera status via state-TYP eller state-ID. Typvägen är
 * done_state-mönstret ur skillsen (slå upp teamets completed-state); ID-vägen
 * finns för den som redan listat states.
 */
export async function uppdateraArendeState(
  client: PoolClient,
  tenantId: string,
  identifier: string,
  mal: { state_typ?: StateTyp; state_id?: string },
): Promise<{ arende: Arende; fran: string; till: WorkflowState }> {
  const arende = await hamtaArende(client, tenantId, identifier);
  const team = await kravTeam(client, tenantId, arende.team_key);

  let state: WorkflowState;
  if (mal.state_typ) {
    state = await stateAvTyp(client, team.id, mal.state_typ);
  } else {
    const { rows } = await client.query<WorkflowState>(
      'SELECT id, namn, typ, position FROM workflow_states WHERE id = $1 AND team_id = $2',
      [mal.state_id, team.id],
    );
    const traff = rows[0];
    // Ett state-id som tillhör ett annat team är inte "not found" på ärendet
    // utan ett felaktigt anrop — men vi läcker inte vilket.
    if (!traff) throw new NotFoundError('workflow_state');
    state = traff;
  }

  await client.query('UPDATE issues SET state_id = $1, uppdaterad = now() WHERE id = $2', [
    state.id,
    arende.id,
  ]);

  return { arende: await hamtaArendeViaId(client, tenantId, arende.id), fran: arende.state_namn, till: state };
}

/**
 * Beslut #24 KRAV-1: en ny kommentar RÖR ärendet. Utan detta ändras
 * issues.uppdaterad bara av statusbyten, och en spegel (arenden_arkiv.py) kan
 * inte använda vattenmärket för att hitta ärenden med nya kommentarer — den
 * tvingas läsa SAMTLIGA ärenden varje körning och slår i rate-limiten.
 * Kallas i samma transaktion som kommentaren skrivs.
 */
export async function rorArende(
  client: PoolClient,
  tenantId: string,
  issueId: string,
): Promise<void> {
  await client.query('UPDATE issues SET uppdaterad = now() WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    issueId,
  ]);
}

/**
 * KRAV-12: agentkön. FOR UPDATE SKIP LOCKED gör att två samtidiga anrop plockar
 * OLIKA ärenden — den som kommer tvåa hoppar över den låsta raden i stället för
 * att vänta in den och sedan se ett redan claimat ärende. Tom kö = null.
 */
export async function claimaNastaArende(
  client: PoolClient,
  tenantId: string,
  aktorNamn: string,
): Promise<Arende | null> {
  const { rows } = await client.query<{ id: string; team_id: string }>(
    `SELECT i.id, i.team_id
       FROM issues i
       JOIN workflow_states s ON s.id = i.state_id
      WHERE i.tenant_id = $1
        AND i.claimad_av IS NULL
        AND s.typ IN ('backlog', 'unstarted')
      ORDER BY i.priority ASC NULLS LAST, i.skapad ASC
      FOR UPDATE OF i SKIP LOCKED
      LIMIT 1`,
    [tenantId],
  );
  const traff = rows[0];
  if (!traff) return null;

  const started = await stateAvTyp(client, traff.team_id, 'started');
  await client.query(
    'UPDATE issues SET claimad_av = $1, state_id = $2, uppdaterad = now() WHERE id = $3',
    [aktorNamn, started.id, traff.id],
  );
  return hamtaArendeViaId(client, tenantId, traff.id);
}

// ---- Sök ------------------------------------------------------------------

export interface Soktraff {
  id: string;
  identifier: string;
  title: string;
  state_typ: StateTyp;
  rang: number;
  traff_i: string;
}

/**
 * KRAV-9/11: fritext över ärenden OCH kommentarer, rankad. Ett ord som bara
 * finns i en kommentar ska hitta ärendet — därför OR:as issues.sokvektor med en
 * EXISTS över comments.sokvektor, och rangen är den bästa av de två.
 */
export async function sokArenden(
  client: PoolClient,
  tenantId: string,
  fraga: string,
  limit: number,
): Promise<Soktraff[]> {
  const { rows } = await client.query<Soktraff>(
    `SELECT i.id,
            t.key || '-' || i.sequence_number AS identifier,
            i.title,
            s.typ AS state_typ,
            GREATEST(
              ts_rank(i.sokvektor, q.tsq),
              COALESCE((SELECT max(ts_rank(c.sokvektor, q.tsq)) FROM comments c
                         WHERE c.issue_id = i.id AND c.sokvektor @@ q.tsq), 0)
            ) AS rang,
            CASE WHEN i.sokvektor @@ q.tsq THEN 'arende' ELSE 'kommentar' END AS traff_i
       FROM issues i
       JOIN teams t ON t.id = i.team_id
       JOIN workflow_states s ON s.id = i.state_id
       CROSS JOIN (SELECT plainto_tsquery('simple', $2) AS tsq) q
      WHERE i.tenant_id = $1
        AND (i.sokvektor @@ q.tsq
             OR EXISTS (SELECT 1 FROM comments c
                         WHERE c.issue_id = i.id AND c.sokvektor @@ q.tsq))
      ORDER BY rang DESC, i.skapad DESC
      LIMIT $3`,
    [tenantId, fraga, limit],
  );
  return rows;
}
