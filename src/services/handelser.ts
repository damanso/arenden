import type { PoolClient } from 'pg';
import type { Aktor } from '../lib/aktor.js';

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
