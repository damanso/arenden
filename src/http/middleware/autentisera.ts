import type { NextFunction, Request, Response } from 'express';
import { pool } from '../../db/pool.js';
import type { Aktor } from '../../lib/aktor.js';
import { UnauthenticatedError } from '../../lib/errors.js';
import { slaUppAktor } from '../../services/nycklar.js';

// Express 5 + TS: vi utökar Request med aktörskontext via declaration merging.
declare module 'express-serve-static-core' {
  interface Request {
    aktor?: Aktor;
  }
}

/**
 * KRAV-10: alla /api-anrop kräver `Authorization: Bearer <nyckel>`. Utan giltig
 * nyckel avvisas anropet med 401 INNAN någon action körs — ingen rad skrivs, och
 * anonym skrivning är därmed omöjlig.
 */
export async function autentisera(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new UnauthenticatedError();
  const aktor = await slaUppAktor(pool, header.slice('Bearer '.length).trim());
  if (!aktor) throw new UnauthenticatedError();
  req.aktor = aktor;
  next();
}

/** Typsäker åtkomst — autentisera() garanterar req.aktor för skyddade rutter. */
export function kravAktor(req: Request): Aktor {
  if (!req.aktor) throw new UnauthenticatedError();
  return req.aktor;
}
