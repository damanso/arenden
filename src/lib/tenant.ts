import type { Pool } from 'pg';
import type { Aktor } from './aktor.js';
import { ForbiddenError } from './errors.js';

// Locollabs tenant (KRAV-4). /api och vyns skrivningar tar tenanten ur nyckeln
// genom lasNyckelnsTenant (B-27, Story 9.1). Konstanten används av de slutna
// undantagen (import och återläsning), migrationsverktyget för ledgerns rader,
// mätskripten, nyckelskriptet, vyns läsningar och grenen i executeAction för
// provens aktörer utan nyckel. Värdet seedas i migration 0001.
export const TENANT_ID = '00000000-0000-0000-0000-000000000001';

/**
 * B-27, tillägg och leads besked 2026-11-19: aktören lämnas orörd. Nyckelraden
 * finns alltid kvar: inget DELETE och bara aktiv får ändras. Återkallade rader
 * räknas därför också. null betyder en aktör utan nyckel; flera tenanter nekas.
 * B-27, tillägg 2026-11-19: läsningen går genom uppslagsfunktionen, eftersom
 * app utan tenant inte ser några rader i api_keys under RLS (Story 9.2).
 */
export async function lasNyckelnsTenant(db: Pool, aktor: Aktor): Promise<string | null> {
  const { rows } = await db.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM aktorens_tenanter($1, $2)',
    [aktor.typ, aktor.namn],
  );
  if (rows.length > 1) {
    throw new ForbiddenError(
      'aktor_i_flera_tenanter',
      'Aktören har nycklar i fler än en tenant och anropet nekas.',
    );
  }
  const rad = rows[0];
  return rad ? rad.tenant_id : null;
}
