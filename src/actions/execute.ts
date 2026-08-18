import { withTransaction } from '../db/tx.js';
import type { Aktor } from '../lib/aktor.js';
import { NotFoundError } from '../lib/errors.js';
import { TENANT_ID } from '../lib/tenant.js';
import { skrivHandelse } from '../services/handelser.js';
import { getAction, type ActionContext } from './registry.js';

export interface ActionResult {
  status: 'ok';
  action: string;
  result: unknown;
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
 */
export async function executeAction(params: {
  aktor: Aktor;
  actionName: string;
  input: unknown;
}): Promise<ActionResult> {
  const action = getAction(params.actionName);
  if (!action) throw new NotFoundError('action');
  const input = action.parse(params.input);

  const result = await withTransaction(async (client) => {
    let antalHandelser = 0;
    const ctx: ActionContext = {
      client,
      tenantId: TENANT_ID,
      aktor: params.aktor,
      skrivHandelse: async (handelse) => {
        antalHandelser += 1;
        await skrivHandelse(client, TENANT_ID, params.aktor, handelse);
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
  });

  return { status: 'ok', action: action.name, result };
}
