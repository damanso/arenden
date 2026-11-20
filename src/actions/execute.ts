import { withTransaction } from '../db/tx.js';
import { pool } from '../db/pool.js';
import type { Aktor } from '../lib/aktor.js';
import { NotFoundError } from '../lib/errors.js';
import { lasNyckelnsTenant, TENANT_ID } from '../lib/tenant.js';
import { skrivHandelse } from '../services/handelser.js';
import { getAction, type ActionContext } from './registry.js';

export interface ActionResult {
  status: 'ok';
  action: string;
  result: unknown;
}

async function transaktionensTenant(params: { aktor: Aktor; tenantId?: string }): Promise<string> {
  const nyckelns = await lasNyckelnsTenant(pool, params.aktor);
  if (nyckelns !== null && params.tenantId !== undefined && nyckelns !== params.tenantId) {
    throw new Error('Nyckelns tenant och den angivna tenanten skiljer sig.');
  }
  if (nyckelns !== null) return nyckelns;
  if (params.tenantId !== undefined) return params.tenantId;
  // Bara provens direktanrop och direktfödda sessioner har aktörer utan nyckel.
  // Produktionsanroparna ger antingen en nyckelaktör eller anger tenanten.
  return TENANT_ID;
}

/**
 * Enda vägen in i kärnan. Allt muterande går hit: transport (HTTP) → executeAction
 * → actions-registret → tjänstelagret → Postgres.
 *
 * Två invarianter tvingas här:
 *  1. Indata valideras mot actionens zod-strict-schema INNAN transaktionen öppnas.
 *  2. En write-action som inte skrivit någon event-rad committas ALDRIG (KRAV-8).
 *     Proveniensen kan alltså inte glömmas bort i en ny action — den som
 *     försöker får ett fel i stället för en tyst lucka i historiken.
 *
 * Aktören kommer från API-nyckeln (KRAV-10) och skickas hit av transportlagret;
 * indata kan aldrig påverka vem skrivningen tillskrivs.
 * Tenanten läses ur aktörens nycklar (B-27, tillägget 2026-11-19), medan
 * aktören skickas vidare oförändrad.
 */
export async function executeAction(params: {
  aktor: Aktor;
  tenantId?: string;
  actionName: string;
  input: unknown;
}): Promise<ActionResult> {
  const action = getAction(params.actionName);
  if (!action) throw new NotFoundError('action');
  const input = action.parse(params.input);
  const tenantId = await transaktionensTenant(params);

  const avbrottsatgarder: (() => Promise<void>)[] = [];
  let result: unknown;
  try {
    result = await withTransaction(async (client) => {
      let antalHandelser = 0;
      const ctx: ActionContext = {
        client,
        tenantId,
        aktor: params.aktor,
        vidAvbrott: (atgard) => { avbrottsatgarder.push(atgard); },
        skrivHandelse: async (handelse) => {
          antalHandelser += 1;
          await skrivHandelse(client, tenantId, params.aktor, handelse);
        },
      };
      const varde = await action.handler(ctx, input);
      if (action.sensitivity === 'write' && antalHandelser === 0) {
        throw new Error(
          `actionen "${action.name}" muterade utan att skriva en event-rad — ` +
            'proveniens är obligatorisk (KRAV-8), transaktionen rullas tillbaka',
        );
      }
      return varde;
    }, tenantId);
  } catch (err) {
    for (const atgard of avbrottsatgarder) {
      try {
        await atgard();
      } catch {
        // Städningen får aldrig ersätta transaktionens ursprungliga fel.
      }
    }
    throw err;
  }

  return { status: 'ok', action: action.name, result };
}
