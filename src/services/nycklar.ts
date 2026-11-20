import { createHash, randomBytes } from 'node:crypto';
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
 * B-27, Story 9.2: uppslaget går genom funktionen, enda läsvägen till api_keys
 * utan tenant. Databasen prövar likheten på hashen, så en tidsskillnad säger
 * inget om nyckeln. Funktionen lämnar aldrig ut hashen.
 */
export async function slaUppAktor(db: Pool, nyckel: string): Promise<Aktor | null> {
  const hash = hashaNyckel(nyckel);
  const { rows } = await db.query<{ aktor_typ: AktorTyp; aktor_namn: string }>(
    'SELECT aktor_typ, aktor_namn FROM nyckelns_aktor($1)',
    [hash],
  );
  const rad = rows[0];
  if (!rad) return null;
  return { typ: rad.aktor_typ, namn: rad.aktor_namn };
}

// db ar ClientBase (inte Pool) sa att nyckelskriptet kan minta INNE i sin
// egen transaktion — nyckelraden och dess handelserad hor ihop (K-1).
export async function skapaNyckel(
  db: ClientBase,
  tenantId: string,
  aktor: Aktor,
): Promise<{ nyckel: string; id: string }> {
  // B-27, Story 9.2 AK 3: nyckelskriptet ansluter som app och anropar tjänsten
  // först i sin transaktion. Den måste vara öppen, eftersom inställningen är lokal.
  const { rows: tenanter } = await db.query<{ tenant: string | null }>(
    "SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant",
  );
  const tenant = tenanter[0]?.tenant;
  if (tenant == null) {
    await db.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  } else if (tenant !== tenantId) {
    throw new Error('Transaktionen har redan en annan tenant och nyckeln skrivs inte.');
  }
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
