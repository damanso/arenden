import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { Aktor } from '../lib/aktor.js';
import type { AktorTyp } from '../lib/validation.js';

/**
 * Endast hashen lagras. sha256 räcker här (till skillnad från ett
 * användarlösenord) eftersom nyckeln är 32 slumpade bytes — det finns inget
 * lösenordsutrymme att brute-forca.
 */
export function hashaNyckel(nyckel: string): string {
  return createHash('sha256').update(nyckel, 'utf8').digest('hex');
}

export function slumpaNyckel(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Slår upp aktören bakom en bearer-nyckel. Returnerar null om nyckeln är okänd
 * eller inaktiverad — anroparen svarar 401 och ingen rad skrivs.
 *
 * Jämförelsen görs på hashen i databasen (index), och verifieras sedan
 * konstanttidsmässigt så att en träff/miss inte kan tidsmätas.
 */
export async function slaUppAktor(db: Pool, nyckel: string): Promise<Aktor | null> {
  const hash = hashaNyckel(nyckel);
  const { rows } = await db.query<{ nyckelhash: string; aktor_typ: AktorTyp; aktor_namn: string }>(
    'SELECT nyckelhash, aktor_typ, aktor_namn FROM api_keys WHERE nyckelhash = $1 AND aktiv',
    [hash],
  );
  const rad = rows[0];
  if (!rad) return null;
  const a = Buffer.from(rad.nyckelhash, 'utf8');
  const b = Buffer.from(hash, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return { typ: rad.aktor_typ, namn: rad.aktor_namn };
}

export async function skapaNyckel(
  db: Pool,
  tenantId: string,
  aktor: Aktor,
): Promise<{ nyckel: string; id: string }> {
  const nyckel = slumpaNyckel();
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_keys (tenant_id, nyckelhash, aktor_typ, aktor_namn)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, hashaNyckel(nyckel), aktor.typ, aktor.namn],
  );
  return { nyckel, id: rows[0]!.id };
}
