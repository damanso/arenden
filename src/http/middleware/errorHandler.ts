import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../../lib/errors.js';

/**
 * Central felöversättning. Klienten får strukturerade felkoder — aldrig
 * stacktraces eller interna felmeddelanden.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'validation_error',
      details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    });
    return;
  }
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.code });
    return;
  }
  // body-parser (express.json) kastar fel med klientstatus, t.ex. SyntaxError
  // vid trasig JSON (400).
  if (arKlientfel(err)) {
    res.status(err.statusCode).json({ error: 'invalid_body' });
    return;
  }
  const pg = pgFelStatus(err);
  if (pg) {
    res.status(pg.status).json({ error: pg.code });
    return;
  }
  console.error('Ohanterat fel:', err);
  res.status(500).json({ error: 'internal_error' });
}

function arKlientfel(err: unknown): err is { statusCode: number } {
  return (
    typeof err === 'object' &&
    err !== null &&
    'statusCode' in err &&
    typeof (err as { statusCode: unknown }).statusCode === 'number' &&
    (err as { statusCode: number }).statusCode >= 400 &&
    (err as { statusCode: number }).statusCode < 500
  );
}

/**
 * Postgres-fel som beror på klientens indata mappas till 4xx — ett kantfall
 * eller ett tävlingsvillkor ska aldrig läcka ut som 500. Okända pg-fel faller
 * vidare till 500 (de är genuina serverfel).
 */
function pgFelStatus(err: unknown): { status: number; code: string } | null {
  if (typeof err !== 'object' || err === null || !('code' in err)) return null;
  switch ((err as { code: unknown }).code) {
    case '23505': // unique_violation
    case '23503': // foreign_key_violation
      return { status: 409, code: 'conflict' };
    case '42501': // insufficient_privilege — t.ex. UPDATE mot events
      return { status: 403, code: 'forbidden' };
    case '23514': // check_violation
    case '22P02': // invalid_text_representation
    case '22007': // invalid_datetime_format
    case '22008': // datetime_field_overflow
      return { status: 400, code: 'invalid_input' };
    case 'P0001': // raise_exception — append-only-triggern på events
      return { status: 409, code: 'rule_violation' };
    default:
      return null;
  }
}
