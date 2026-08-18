import type { PoolClient } from 'pg';
import { NotFoundError } from '../lib/errors.js';
import type { StateTyp } from '../lib/validation.js';

export interface Team {
  id: string;
  key: string;
  namn: string;
  sekvensnamn: string;
}

export interface WorkflowState {
  id: string;
  namn: string;
  typ: StateTyp;
  position: number;
}

// KRAV-6: standarduppsättningen som seedas per team. Namnen är Linears, så att
// importen av arkivet (som bara har statusnamn) mappar rakt av.
export const STANDARD_STATES: { namn: string; typ: StateTyp; position: number }[] = [
  { namn: 'Backlog', typ: 'backlog', position: 0 },
  { namn: 'Todo', typ: 'unstarted', position: 1 },
  { namn: 'In Progress', typ: 'started', position: 2 },
  { namn: 'Done', typ: 'completed', position: 3 },
  { namn: 'Canceled', typ: 'canceled', position: 4 },
];

export async function hamtaTeam(client: PoolClient, tenantId: string, key: string): Promise<Team | null> {
  const { rows } = await client.query<Team>(
    'SELECT id, key, namn, sekvensnamn FROM teams WHERE tenant_id = $1 AND key = $2',
    [tenantId, key],
  );
  return rows[0] ?? null;
}

export async function kravTeam(client: PoolClient, tenantId: string, key: string): Promise<Team> {
  const team = await hamtaTeam(client, tenantId, key);
  if (!team) throw new NotFoundError('team');
  return team;
}

/**
 * Skapar teamet med en DEDIKERAD sekvens för ärendenumren (KRAV-5) och seedar
 * standardstatusarna (KRAV-6). Sekvensen skapas av skapa_arendesekvens (migration
 * 0001) eftersom app-rollen medvetet saknar rätt att skapa objekt i schemat.
 */
export async function hamtaEllerSkapaTeam(
  client: PoolClient,
  tenantId: string,
  key: string,
  namn: string,
): Promise<Team> {
  const befintligt = await hamtaTeam(client, tenantId, key);
  if (befintligt) return befintligt;

  const seq = await client.query<{ skapa_arendesekvens: string }>('SELECT skapa_arendesekvens($1)', [key]);
  const sekvensnamn = seq.rows[0]!.skapa_arendesekvens;

  const { rows } = await client.query<Team>(
    `INSERT INTO teams (tenant_id, key, namn, sekvensnamn)
     VALUES ($1, $2, $3, $4)
     RETURNING id, key, namn, sekvensnamn`,
    [tenantId, key, namn, sekvensnamn],
  );
  const team = rows[0]!;

  for (const state of STANDARD_STATES) {
    await client.query(
      `INSERT INTO workflow_states (tenant_id, team_id, namn, typ, position)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, team.id, state.namn, state.typ, state.position],
    );
  }
  return team;
}

/** KRAV-11: list_states — motsvarar GraphQL:ens team.states.nodes{id name type}. */
export async function listaStates(
  client: PoolClient,
  tenantId: string,
  teamKey: string,
): Promise<WorkflowState[]> {
  const team = await kravTeam(client, tenantId, teamKey);
  const { rows } = await client.query<WorkflowState>(
    `SELECT id, namn, typ, position FROM workflow_states
      WHERE tenant_id = $1 AND team_id = $2 ORDER BY position`,
    [tenantId, team.id],
  );
  return rows;
}

/** Slår upp teamets state av en viss typ — done_state-mönstret ur skillsen. */
export async function stateAvTyp(
  client: PoolClient,
  teamId: string,
  typ: StateTyp,
): Promise<WorkflowState> {
  const { rows } = await client.query<WorkflowState>(
    `SELECT id, namn, typ, position FROM workflow_states
      WHERE team_id = $1 AND typ = $2 ORDER BY position LIMIT 1`,
    [teamId, typ],
  );
  const state = rows[0];
  if (!state) throw new NotFoundError(`workflow_state (${typ})`);
  return state;
}

export async function stateMedNamn(
  client: PoolClient,
  teamId: string,
  namn: string,
): Promise<WorkflowState | null> {
  const { rows } = await client.query<WorkflowState>(
    'SELECT id, namn, typ, position FROM workflow_states WHERE team_id = $1 AND namn = $2',
    [teamId, namn],
  );
  return rows[0] ?? null;
}
