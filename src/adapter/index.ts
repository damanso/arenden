// Adaptern (KRAV-17): speglar exakt de GraphQL-anrop de 15 skripten gör mot
// Linear i dag, men mot vårt actions-API. Den exporteras som BIBLIOTEK — inga
// skript kopplas om nu; omkopplingen är Etapp 2.
//
// Adaptern går ALLTID via HTTP + bearer (aldrig direkt mot databasen), så den
// lyder samma proveniens- och autentiseringsregler som varje annan klient:
// aktören sitter i nyckeln.
import { config } from '../config.js';
import type { StateTyp } from '../lib/validation.js';

export interface AdapterOptions {
  basUrl?: string;
  nyckel?: string;
}

export interface ArendeNod {
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
  skapad: string;
  uppdaterad: string;
}

export interface Sida {
  noder: ArendeNod[];
  pageInfo: { harNasta: boolean; slutCursor: string | null };
}

export interface WorkflowStateNod {
  id: string;
  namn: string;
  typ: StateTyp;
}

export class AdapterError extends Error {
  constructor(
    readonly status: number,
    readonly kod: string,
  ) {
    super(`arende-API svarade ${status}: ${kod}`);
    this.name = 'AdapterError';
  }
}

async function anropa(action: string, input: unknown, options: AdapterOptions = {}): Promise<unknown> {
  const basUrl = options.basUrl ?? config.ARENDEN_API_URL;
  const nyckel = options.nyckel ?? config.ARENDEN_API_KEY;
  if (!nyckel) {
    throw new Error('ARENDEN_API_KEY saknas — adaptern kan inte skriva utan aktörsnyckel (KRAV-10)');
  }
  const svar = await fetch(`${basUrl}/api/actions/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${nyckel}` },
    body: JSON.stringify(input),
  });
  const kropp = (await svar.json()) as { result?: unknown; error?: string };
  if (!svar.ok) throw new AdapterError(svar.status, kropp.error ?? 'okant_fel');
  return kropp.result;
}

/** Motsvarar issues(first:, after:, filter:{state:{type:{in:[…]}}}) + pageInfo. */
export async function listIssues(
  args: {
    stateTyper?: StateTyp[];
    teamKey?: string;
    label?: string;
    projekt?: string;
    cursor?: string;
    limit?: number;
  } = {},
  options: AdapterOptions = {},
): Promise<Sida> {
  const result = (await anropa(
    'list_issues',
    {
      ...(args.stateTyper ? { state_typer: args.stateTyper } : {}),
      ...(args.teamKey ? { team_key: args.teamKey } : {}),
      ...(args.label ? { label: args.label } : {}),
      ...(args.projekt ? { projekt: args.projekt } : {}),
      ...(args.cursor ? { cursor: args.cursor } : {}),
      ...(args.limit ? { limit: args.limit } : {}),
    },
    options,
  )) as { arenden: ArendeNod[]; pageInfo: { har_nasta: boolean; slut_cursor: string | null } };
  return {
    noder: result.arenden,
    pageInfo: { harNasta: result.pageInfo.har_nasta, slutCursor: result.pageInfo.slut_cursor },
  };
}

/** Motsvarar team(id:){states{nodes{id name type}}} — done_state-uppslaget. */
export async function getWorkflowStates(
  teamKey: string,
  options: AdapterOptions = {},
): Promise<WorkflowStateNod[]> {
  const result = (await anropa('list_states', { team_key: teamKey }, options)) as WorkflowStateNod[];
  return result.map((s) => ({ id: s.id, namn: s.namn, typ: s.typ }));
}

/** Motsvarar issueCreate(input:{title, description, teamId, labelIds, priority, dueDate}). */
export async function createIssue(
  args: {
    titel: string;
    beskrivning?: string;
    teamKey: string;
    labels?: string[];
    priority?: number;
    due?: string;
  },
  options: AdapterOptions = {},
): Promise<{ id: string; identifier: string }> {
  const result = (await anropa(
    'create_issue',
    {
      title: args.titel,
      team_key: args.teamKey,
      ...(args.beskrivning ? { description: args.beskrivning } : {}),
      ...(args.labels ? { labels: args.labels } : {}),
      ...(args.priority !== undefined ? { priority: args.priority } : {}),
      ...(args.due ? { due: args.due } : {}),
    },
    options,
  )) as { id: string; identifier: string };
  return { id: result.id, identifier: result.identifier };
}

const STATE_TYPER = ['backlog', 'unstarted', 'started', 'completed', 'canceled'];

/**
 * Motsvarar issueUpdate(input:{stateId}). Andra argumentet får vara antingen en
 * state-TYP ('completed' — done_state-mönstret) eller ett state-ID, precis som
 * skripten använder det i dag.
 */
export async function updateIssueState(
  identifier: string,
  stateTypEllerId: string,
  options: AdapterOptions = {},
): Promise<ArendeNod> {
  const input = STATE_TYPER.includes(stateTypEllerId)
    ? { identifier, state_typ: stateTypEllerId }
    : { identifier, state_id: stateTypEllerId };
  return (await anropa('update_issue_state', input, options)) as ArendeNod;
}

/** Motsvarar commentCreate(input:{issueId, body}). */
export async function addComment(
  identifier: string,
  body: string,
  options: AdapterOptions = {},
): Promise<{ id: string; skapad: string }> {
  return (await anropa('add_comment', { identifier, body }, options)) as { id: string; skapad: string };
}

/** Motsvarar issueLabels(filter:{name:{eq:}}) → id eller null. */
export async function sokLabel(namn: string, options: AdapterOptions = {}): Promise<string | null> {
  const result = (await anropa('sok_label', { namn }, options)) as { id: string | null };
  return result.id;
}
