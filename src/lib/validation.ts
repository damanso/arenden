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

// B-20 (D-1): ärendenumret i sökningen. Numret lagras aldrig (identifier härleds ur
// team.key + sequence_number) och finns därför inte i sökindexet — det slås upp på
// (team, sequence_number). Gränsen är Postgres integer, typen för issues.sequence_number
// (0003_arenden.sql): ett större tal kan inte finnas och får aldrig nå databasen (22003 → 500).
export const MAX_ARENDENUMMER = 2_147_483_647;

/** `text` är den kanoniska formen för visning: LOC-503, eller 503 utan teamnyckel. */
export type TolkatArendenummer =
  | { slag: 'nummer'; teamKey: string | null; nummer: number; text: string }
  | { slag: 'kan_inte_finnas'; teamKey: string | null; text: string };

// Avskiljare: bindestreck, hårt bindestreck U+2011, tankstreck U+2013, långt tankstreck U+2014, minus U+2212.
const MED_STRECK = /^([A-Za-z][A-Za-z0-9]{0,9})\s*[-\u2011\u2013\u2014\u2212]\s*(\d+)$/;
const MED_MELLANRUM = /^([A-Za-z][A-Za-z0-9]{0,9})\s+(\d+)$/;
// Utan avskiljare är prefixet bokstäverna före första siffran (en teamnyckel med siffror kräver avskiljare).
const UTAN_AVSKILJARE = /^([A-Za-z]{1,10})(\d+)$/;
const BART = /^#?(\d+)$/;

export function tolkaArendenummer(q: string): TolkatArendenummer | null {
  const s = q.trim();
  const delar = MED_STRECK.exec(s) ?? MED_MELLANRUM.exec(s) ?? UTAN_AVSKILJARE.exec(s);
  const teamKey = delar ? delar[1]!.toUpperCase() : null;
  const siffror = delar ? delar[2] : BART.exec(s)?.[1];
  if (siffror === undefined) return null;
  const utanNollor = siffror.replace(/^0+(?=\d)/, '');
  const text = teamKey === null ? utanNollor : `${teamKey}-${utanNollor}`;
  if (utanNollor.length > 10 || Number(utanNollor) > MAX_ARENDENUMMER) {
    return { slag: 'kan_inte_finnas', teamKey, text };
  }
  return { slag: 'nummer', teamKey, nummer: Number(utanNollor), text };
}

/** AK 5: samma tolkning ord för ord, i sökningens ordning, varje nummer en gång. */
export function tolkaArendenumrenIText(q: string): TolkatArendenummer[] {
  const sedda = new Set<string>();
  const nummer: TolkatArendenummer[] = [];
  for (const ord of q.split(/\s+/)) {
    const tolkat = tolkaArendenummer(ord);
    if (tolkat === null || sedda.has(tolkat.text)) continue;
    sedda.add(tolkat.text);
    nummer.push(tolkat);
  }
  return nummer;
}

// D-2, B-21 (Story 11.2): ärendeadressens form. Exakt teamnyckel, bindestreck och siffror, i vilket
// skiftläge som helst; svaret har teamnyckeln i versaler och numret utan inledande nollor. Ingen gräns för
// numret: funktionen arbetar på text, och gränsen hör till uppslagen (MAX_ARENDENUMMER).
const IDENTIFIERFORM = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/;

export function kanoniskIdentifier(s: string): string | null {
  const delar = IDENTIFIERFORM.exec(s);
  if (!delar) return null;
  return `${delar[1]!.toUpperCase()}-${delar[2]!.replace(/^0+(?=\d)/, '')}`;
}
