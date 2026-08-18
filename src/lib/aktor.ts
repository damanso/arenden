import type { AktorTyp } from './validation.js';

/**
 * Vem som skriver. Aktören härleds ALLTID ur API-nyckeln (KRAV-10) — aldrig ur
 * request-body. Det är hela poängen med proveniensen: en agents kommentar kan
 * inte stämplas som Davids genom att skicka ett annat namn i JSON:en.
 */
export interface Aktor {
  typ: AktorTyp;
  namn: string;
}
