import type { PoolClient } from 'pg';
import type { Aktor } from '../lib/aktor.js';
import type { AktorTyp } from '../lib/validation.js';

export interface Handelse {
  id: number;
  issue_id: string | null;
  aktor_typ: string;
  aktor_namn: string;
  verb: string;
  payload: unknown;
  tidpunkt: Date;
}

/**
 * Skriver en rad i den append-only loggen (KRAV-8). Anropas ALLTID med samma
 * `client` som mutationen, alltså i samma transaktion — event och verkan lever
 * och dör tillsammans.
 */
export async function skrivHandelse(
  client: PoolClient,
  tenantId: string,
  aktor: Aktor,
  handelse: { issueId: string | null; verb: string; payload?: unknown },
): Promise<void> {
  await client.query(
    `INSERT INTO events (tenant_id, issue_id, aktor_typ, aktor_namn, verb, payload)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      tenantId,
      handelse.issueId,
      aktor.typ,
      aktor.namn,
      handelse.verb,
      JSON.stringify(handelse.payload ?? {}),
    ],
  );
}

export async function listaHandelser(
  client: PoolClient,
  tenantId: string,
  issueId: string,
): Promise<Handelse[]> {
  const { rows } = await client.query<Handelse>(
    `SELECT id, issue_id, aktor_typ, aktor_namn, verb, payload, tidpunkt
       FROM events
      WHERE tenant_id = $1 AND issue_id = $2
      ORDER BY tidpunkt, id`,
    [tenantId, issueId],
  );
  return rows;
}

// ---- Läsfrågor för läsvyn (Etapp 2a) --------------------------------------
// Vylagret får inte innehålla SQL. Frågorna nedan finns därför HÄR, och de är
// rena läsningar — vyn skriver aldrig en rad.

export interface HandelseIVy extends Handelse {
  /** 'LOC-316' — härledd som överallt annars, aldrig lagrad. */
  identifier: string | null;
  arende_titel: string | null;
}

/**
 * Etapp 2a KRAV-2 (digesten "vad hände"): hela tenantens händelser, nyaste
 * först, med ärendets identifier på raden så att vyn slipper slå upp varje
 * ärende för sig. `dagar = null` = inget tidsfönster (länken "visa äldre").
 * issue_id är nullbar (t.ex. verbet tom_ko) — därför LEFT JOIN.
 */
export async function listaSenasteHandelser(
  client: PoolClient,
  tenantId: string,
  filter: { dagar: number | null; limit: number },
): Promise<HandelseIVy[]> {
  const { rows } = await client.query<HandelseIVy>(
    `SELECT e.id, e.issue_id, e.aktor_typ, e.aktor_namn, e.verb, e.payload, e.tidpunkt,
            CASE WHEN i.id IS NULL THEN NULL ELSE t.key || '-' || i.sequence_number END AS identifier,
            i.title AS arende_titel
       FROM events e
       LEFT JOIN issues i ON i.id = e.issue_id
       LEFT JOIN teams t ON t.id = i.team_id
      WHERE e.tenant_id = $1
        AND ($2::int IS NULL OR e.tidpunkt >= now() - make_interval(days => $2::int))
      ORDER BY e.tidpunkt DESC, e.id DESC
      LIMIT $3`,
    [tenantId, filter.dagar, filter.limit],
  );
  return rows;
}

export interface AktorMedAktivitet {
  aktor_typ: AktorTyp;
  aktor_namn: string;
  antal: number;
}

/**
 * Aktörerna som FAKTISKT lämnat spår — underlag för aktör-fasetten (KRAV-3).
 * Både händelser och kommentarer räknas: det är aktiviteten David söker i.
 */
export async function listaAktorer(
  client: PoolClient,
  tenantId: string,
  limit: number,
): Promise<AktorMedAktivitet[]> {
  const { rows } = await client.query<AktorMedAktivitet>(
    `SELECT aktor_typ, aktor_namn, count(*)::int AS antal
       FROM (SELECT aktor_typ, aktor_namn FROM events WHERE tenant_id = $1
             UNION ALL
             SELECT aktor_typ, aktor_namn FROM comments WHERE tenant_id = $1) x
      GROUP BY aktor_typ, aktor_namn
      ORDER BY antal DESC, aktor_namn
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

/**
 * KRAV-3: aktör-fasetten filtrerar på AKTIVITET, inte på ett fält hos ärendet —
 * ärenden har ingen aktör. Returnerar id:n för de ärenden där aktören skrivit
 * en händelse eller en kommentar.
 */
export async function arendenMedAktivitetAv(
  client: PoolClient,
  tenantId: string,
  aktorNamn: string,
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT i.id
       FROM issues i
      WHERE i.tenant_id = $1
        AND (EXISTS (SELECT 1 FROM events e
                      WHERE e.issue_id = i.id AND e.aktor_namn = $2)
             OR EXISTS (SELECT 1 FROM comments c
                         WHERE c.issue_id = i.id AND c.aktor_namn = $2))`,
    [tenantId, aktorNamn],
  );
  return rows.map((r) => r.id);
}
