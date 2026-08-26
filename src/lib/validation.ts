import { z } from 'zod';

// Fritext som ska in i Postgres text/jsonb: NUL (U+0000) är förbjudet i både
// text och jsonb och skulle annars ge ett omappat databasfel → 500. Vi avvisar
// NUL och övriga C0-kontrolltecken (utom \t \n \r) redan i valideringen.
function harForbjudetKontrolltecken(varde: string): boolean {
  for (const ch of varde) {
    const kod = ch.codePointAt(0)!;
    if (kod < 0x20 && kod !== 0x09 && kod !== 0x0a && kod !== 0x0d) return true;
    if (kod === 0x7f) return true;
  }
  return false;
}

export function safeText(max: number): z.ZodEffects<z.ZodString, string, string> {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((v) => !harForbjudetKontrolltecken(v), {
      message: 'texten innehåller otillåtna kontrolltecken',
    });
}

export const UuidSchema = z.string().uuid();

// Teamnyckel: 'LOC'. Samma format som CHECK-villkoret i migration 0002 och
// valideringen i skapa_arendesekvens — nyckeln blir en del av ett
// sekvensidentifierarnamn och får därför aldrig innehålla något annat.
export const TeamKeySchema = z.string().regex(/^[A-Z][A-Z0-9]{0,9}$/, 'teamnyckel anges som t.ex. LOC');

// Ärendets identitet utåt: 'LOC-330'.
export const IdentifierSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]{0,9}-\d+$/, "ärendet anges som '<TEAM>-<nummer>', t.ex. LOC-330");

export const StateTypSchema = z.enum(['backlog', 'unstarted', 'started', 'completed', 'canceled']);
export type StateTyp = z.infer<typeof StateTypSchema>;

export const AktorTypSchema = z.enum(['manniska', 'agent', 'system']);
export type AktorTyp = z.infer<typeof AktorTypSchema>;

// Linears skala: 1 = brådskande … 4 = låg.
export const PrioritySchema = z.number().int().min(1).max(4);

// Datum måste vara ett verkligt kalenderdatum — enbart regexen släpper igenom
// t.ex. 2026-02-30, som annars blir ett Postgres-fel → 500.
export const IsoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'datum anges som YYYY-MM-DD')
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'ogiltigt kalenderdatum');

// Bilagans adress. ENDAST http/https: en bilagerad renderas som en <a href>, och
// ett `javascript:`- eller `data:`-schema hade blivit körbar kod i Davids
// webbläsare. Schemat kontrolleras vid skrivningen OCH vid renderingen
// (sakerUrl i vy/mall.ts) — den som bara har en av dem har ingen.
export const HttpUrlSchema = z
  .string()
  .min(1)
  .max(2000)
  .refine((v) => {
    let u: URL;
    try {
      u = new URL(v);
    } catch {
      return false;
    }
    return u.protocol === 'http:' || u.protocol === 'https:';
  }, 'adressen måste vara en absolut http- eller https-URL');

// Linears relationstyper som arkivet faktiskt bär. 'related' är SYMMETRISK
// (A–B är samma relation som B–A), 'blocks' är RIKTAD (A blockerar B).
export const RelationTypSchema = z.enum(['related', 'blocks']);
export type RelationTyp = z.infer<typeof RelationTypSchema>;

export function delaIdentifier(identifier: string): { teamKey: string; nummer: number } {
  const delar = /^([A-Z][A-Z0-9]{0,9})-(\d+)$/.exec(identifier);
  if (!delar) throw new Error(`ogiltig identifier: ${identifier}`);
  return { teamKey: delar[1]!, nummer: Number(delar[2]!) };
}
