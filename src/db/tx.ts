import type { PoolClient } from 'pg';
import { pool } from './pool.js';

/**
 * Riktig atomicitet: checkar ut EN klient ur poolen och kör BEGIN/COMMIT på
 * just den anslutningen. (BEGIN/COMMIT via poolen kan hamna på olika
 * anslutningar — då är transaktionen en illusion.)
 *
 * Det är den här transaktionen som gör KRAV-8 sant: mutationen och dess
 * event-rad skrivs eller rullas tillbaka tillsammans.
 * B-27: en angiven tenants inställning gäller bara den här transaktionen.
 */
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>,
  tenantId?: string,
): Promise<T> {
  const client = await pool.connect();
  let rollbackMisslyckades = false;
  try {
    await client.query('BEGIN');
    if (tenantId !== undefined) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    }
    const resultat = await fn(client);
    await client.query('COMMIT');
    return resultat;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Anslutningen är trasig/aborterad — markera så att den förstörs nedan
      // i stället för att återlämnas till poolen och förgifta nästa request.
      rollbackMisslyckades = true;
    }
    throw err;
  } finally {
    client.release(rollbackMisslyckades);
  }
}
