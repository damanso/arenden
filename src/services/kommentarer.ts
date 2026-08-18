import type { PoolClient } from 'pg';
import type { Aktor } from '../lib/aktor.js';
import type { AktorTyp } from '../lib/validation.js';

export interface Kommentar {
  id: string;
  body: string;
  aktor_typ: AktorTyp;
  aktor_namn: string;
  source_ref: string | null;
  skapad: Date;
}

/**
 * Aktören kommer ur API-nyckeln (KRAV-10), aldrig ur anropets body. Det är den
 * konkreta boten mot smärtan "agentkommentarer stämplas David".
 */
export async function laggTillKommentar(
  client: PoolClient,
  tenantId: string,
  issueId: string,
  body: string,
  aktor: Aktor,
  extra: { source_ref?: string; skapad?: string } = {},
): Promise<Kommentar> {
  const { rows } = await client.query<Kommentar>(
    `INSERT INTO comments (tenant_id, issue_id, body, aktor_typ, aktor_namn, source_ref, skapad)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (source_ref) DO NOTHING
     RETURNING id, body, aktor_typ, aktor_namn, source_ref, skapad`,
    [tenantId, issueId, body, aktor.typ, aktor.namn, extra.source_ref ?? null, extra.skapad ?? null],
  );
  const rad = rows[0];
  if (rad) return rad;

  // ON CONFLICT slog till (importen kör om) — returnera den befintliga raden.
  const befintlig = await client.query<Kommentar>(
    'SELECT id, body, aktor_typ, aktor_namn, source_ref, skapad FROM comments WHERE source_ref = $1',
    [extra.source_ref ?? null],
  );
  return befintlig.rows[0]!;
}

export async function listaKommentarer(
  client: PoolClient,
  tenantId: string,
  issueId: string,
): Promise<Kommentar[]> {
  const { rows } = await client.query<Kommentar>(
    `SELECT id, body, aktor_typ, aktor_namn, source_ref, skapad
       FROM comments WHERE tenant_id = $1 AND issue_id = $2 ORDER BY skapad, id`,
    [tenantId, issueId],
  );
  return rows;
}
