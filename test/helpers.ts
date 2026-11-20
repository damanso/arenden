import type { PoolClient } from 'pg';
import type { Express } from 'express';
import request, { type Test } from 'supertest';
import { withTransaction } from '../src/db/tx.js';
import type { Aktor } from '../src/lib/aktor.js';
import { TENANT_ID } from '../src/lib/tenant.js';
import { skapaNyckel } from '../src/services/nycklar.js';
import { hamtaEllerSkapaTeam, type Team } from '../src/services/team.js';

export { TENANT_ID };

export async function seedaTeam(key = 'LOC', namn = 'Locollabs'): Promise<Team> {
  return withTransaction((client) => hamtaEllerSkapaTeam(client, TENANT_ID, key, namn), TENANT_ID);
}

/** Mintar en nyckel direkt i databasen — samma väg som `npm run nyckel`. */
export async function nyNyckel(aktor: Aktor): Promise<string> {
  return withTransaction(async (client) => (await skapaNyckel(client, TENANT_ID, aktor)).nyckel, TENANT_ID);
}

export function kor(app: Express, nyckel: string, action: string, input: unknown = {}): Test {
  return request(app)
    .post(`/api/actions/${action}`)
    .set('Authorization', `Bearer ${nyckel}`)
    .send(input as object);
}

/** B-27: en räkning som app utan tenant är inget belägg för noll rader. */
export async function raknaMedTenant(client: PoolClient, tabell: string): Promise<number> {
  const { rows: tenant } = await client.query<{ tenant: string | null }>(
    "SELECT NULLIF(current_setting('app.tenant_id', true), '') AS tenant",
  );
  if (tenant[0]?.tenant == null) {
    throw new Error('En räkning som app utan tenant är inget belägg för noll rader (B-27).');
  }
  const { rows } = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabell}`);
  return Number(rows[0]!.n);
}

export async function raknaRader(tabell: string): Promise<number> {
  return withTransaction((c) => raknaMedTenant(c, tabell), TENANT_ID);
}
