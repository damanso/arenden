import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { ClientBase, Pool, PoolClient } from 'pg';
import type { Aktor } from '../lib/aktor.js';
import { NotFoundError } from '../lib/errors.js';
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

// db ar ClientBase (inte Pool) sa att nyckelskriptet kan minta INNE i sin
// egen transaktion — nyckelraden och dess handelserad hor ihop (K-1).
export async function skapaNyckel(
  db: ClientBase,
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

// ---- K-1: nyckelns livscykel ----------------------------------------------

export interface NyckelIVy {
  id: string;
  aktor_typ: AktorTyp;
  aktor_namn: string;
  aktiv: boolean;
  skapad: Date;
}

/**
 * Nycklarna som identiteter — id, aktör, tillstånd, ålder.
 *
 * `nyckelhash` finns MEDVETET inte i SELECT-listan. Kolumnen ska aldrig kunna
 * ramla ut i ett svar eller en HTML-sida bara för att någon senare skriver
 * `SELECT *`, och den säger inget en människa behöver veta.
 */
export async function listaNycklar(client: ClientBase, tenantId: string): Promise<NyckelIVy[]> {
  const { rows } = await client.query<NyckelIVy>(
    `SELECT id, aktor_typ, aktor_namn, aktiv, skapad
       FROM api_keys WHERE tenant_id = $1
      ORDER BY aktiv DESC, aktor_typ, aktor_namn, skapad`,
    [tenantId],
  );
  return rows;
}

/**
 * Återkallar en nyckel: `aktiv = false`, aldrig DELETE.
 *
 * Raden ÄR aktörens identitet — historiken pekar på namnet den bär, och att
 * radera raden hade gjort gamla händelserader svårare att förklara utan att
 * göra något ogjort. `slaUppAktor` kräver `AND aktiv`, så en återkallad nyckel
 * ger 401 vid nästa anrop.
 *
 * Kolumn-GRANT (migration 0011) ger app-rollen skrivrätt på ENBART `aktiv`:
 * en utfärdad nyckel kan aldrig döpas om till en annan aktör i efterhand.
 *
 * Idempotent: en redan återkallad nyckel rapporteras som oförändrad.
 */
export async function aterkallaNyckel(
  client: PoolClient,
  tenantId: string,
  nyckelId: string,
): Promise<{ nyckel: NyckelIVy; andrad: boolean }> {
  const { rows } = await client.query<NyckelIVy>(
    `SELECT id, aktor_typ, aktor_namn, aktiv, skapad
       FROM api_keys WHERE tenant_id = $1 AND id = $2`,
    [tenantId, nyckelId],
  );
  const fore = rows[0];
  if (!fore) throw new NotFoundError('nyckel');
  if (!fore.aktiv) return { nyckel: fore, andrad: false };

  await client.query('UPDATE api_keys SET aktiv = false WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    nyckelId,
  ]);
  return { nyckel: { ...fore, aktiv: false }, andrad: true };
}
