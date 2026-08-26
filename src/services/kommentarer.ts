import type { PoolClient } from 'pg';
import type { Aktor } from '../lib/aktor.js';
import { NotFoundError } from '../lib/errors.js';
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

/**
 * K-1: BORTTAGNA KOMMENTARER SYNS INTE HÄR. Mjuk radering hade varit
 * verkningslös om läsvägen ändå visade raden — och den här funktionen är
 * läsvägen för både `get_issue` och ärendesidan i vyn.
 */
export async function listaKommentarer(
  client: PoolClient,
  tenantId: string,
  issueId: string,
): Promise<Kommentar[]> {
  const { rows } = await client.query<Kommentar>(
    `SELECT id, body, aktor_typ, aktor_namn, source_ref, skapad
       FROM comments
      WHERE tenant_id = $1 AND issue_id = $2 AND borttagen IS NULL
      ORDER BY skapad, id`,
    [tenantId, issueId],
  );
  return rows;
}

// ---- K-1: rättningsvägarna -------------------------------------------------

export interface KommentarMedTillstand extends Kommentar {
  issue_id: string;
  borttagen: Date | null;
}

/** Hela raden, borttagen eller ej — underlaget för att kunna logga GAMLA värdet. */
export async function hamtaKommentar(
  client: PoolClient,
  tenantId: string,
  kommentarId: string,
): Promise<KommentarMedTillstand> {
  const { rows } = await client.query<KommentarMedTillstand>(
    `SELECT id, issue_id, body, aktor_typ, aktor_namn, source_ref, skapad, borttagen
       FROM comments WHERE tenant_id = $1 AND id = $2`,
    [tenantId, kommentarId],
  );
  const rad = rows[0];
  if (!rad) throw new NotFoundError('kommentar');
  return rad;
}

/**
 * Rättar kommentarens TEXT. aktor_typ/aktor_namn rörs inte — de går inte ens
 * att skriva (kolumn-GRANT + trigger, migration 0011). Att rätta en text är
 * något helt annat än att byta vem som sa den.
 *
 * Returnerar den gamla texten: anroparen SKA skriva den i händelseraden, annars
 * har vi bytt ett permanent fel mot en osynlig ändring.
 */
export async function rattaKommentar(
  client: PoolClient,
  tenantId: string,
  kommentarId: string,
  nyText: string,
): Promise<{ kommentar: KommentarMedTillstand; gammalText: string }> {
  const fore = await hamtaKommentar(client, tenantId, kommentarId);
  if (fore.borttagen !== null) throw new NotFoundError('kommentar');
  await client.query('UPDATE comments SET body = $3 WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    kommentarId,
    nyText,
  ]);
  return { kommentar: await hamtaKommentar(client, tenantId, kommentarId), gammalText: fore.body };
}

/**
 * MJUK radering. Raden ligger kvar med sin text och sin proveniens — det som
 * ändras är att den inte längre visas eller söks. En hård DELETE hade tagit bort
 * bevis; app-rollen har inte ens rätten (REVOKE i migration 0011).
 *
 * Idempotent: en redan borttagen kommentar rapporteras som oförändrad i stället
 * för att fela, så att ett dubbelklick i webbläsaren inte blir en felsida.
 */
export async function taBortKommentar(
  client: PoolClient,
  tenantId: string,
  kommentarId: string,
): Promise<{ kommentar: KommentarMedTillstand; andrad: boolean }> {
  const fore = await hamtaKommentar(client, tenantId, kommentarId);
  if (fore.borttagen !== null) return { kommentar: fore, andrad: false };
  await client.query('UPDATE comments SET borttagen = now() WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    kommentarId,
  ]);
  return { kommentar: await hamtaKommentar(client, tenantId, kommentarId), andrad: true };
}

/** Ångrar en mjuk radering. Utan den vore "mjuk" bara ett ord. */
export async function aterstallKommentar(
  client: PoolClient,
  tenantId: string,
  kommentarId: string,
): Promise<{ kommentar: KommentarMedTillstand; andrad: boolean }> {
  const fore = await hamtaKommentar(client, tenantId, kommentarId);
  if (fore.borttagen === null) return { kommentar: fore, andrad: false };
  await client.query('UPDATE comments SET borttagen = NULL WHERE tenant_id = $1 AND id = $2', [
    tenantId,
    kommentarId,
  ]);
  return { kommentar: await hamtaKommentar(client, tenantId, kommentarId), andrad: true };
}

/**
 * De borttagna kommentarerna på ett ärende — ENDAST id och tidpunkt.
 *
 * Medvetet utan body och utan aktör: sidan ska visa ATT något togs bort (och ge
 * vägen tillbaka), aldrig återge det borttagna innehållet eller den aktör som
 * stod på det. Var det just aktörsuppgiften som var fel — LOC-255:s tre falska
 * "personer" — hade en återgivning här gjort borttagningen meningslös. Det gamla
 * värdet finns i händelseraden, som är den plats där det hör hemma.
 */
export async function listaBorttagnaKommentarer(
  client: PoolClient,
  tenantId: string,
  issueId: string,
): Promise<{ id: string; borttagen: Date }[]> {
  const { rows } = await client.query<{ id: string; borttagen: Date }>(
    `SELECT id, borttagen FROM comments
      WHERE tenant_id = $1 AND issue_id = $2 AND borttagen IS NOT NULL
      ORDER BY borttagen, id`,
    [tenantId, issueId],
  );
  return rows;
}
