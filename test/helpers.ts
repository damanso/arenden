import type { Express } from 'express';
import request, { type Test } from 'supertest';
import { withTransaction } from '../src/db/tx.js';
import { pool } from '../src/db/pool.js';
import type { Aktor } from '../src/lib/aktor.js';
import { TENANT_ID } from '../src/lib/tenant.js';
import { skapaNyckel } from '../src/services/nycklar.js';
import { hamtaEllerSkapaTeam, type Team } from '../src/services/team.js';

export { TENANT_ID };

export async function seedaTeam(key = 'LOC', namn = 'Locollabs'): Promise<Team> {
  return withTransaction((client) => hamtaEllerSkapaTeam(client, TENANT_ID, key, namn));
}

/** Mintar en nyckel direkt i databasen — samma väg som `npm run nyckel`. */
export async function nyNyckel(aktor: Aktor): Promise<string> {
  return withTransaction(async (client) => (await skapaNyckel(client, TENANT_ID, aktor)).nyckel);
}

export function kor(app: Express, nyckel: string, action: string, input: unknown = {}): Test {
  return request(app)
    .post(`/api/actions/${action}`)
    .set('Authorization', `Bearer ${nyckel}`)
    .send(input as object);
}

export async function raknaRader(tabell: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${tabell}`);
  return Number(rows[0]!.n);
}
