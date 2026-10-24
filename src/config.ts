// Miljökonfiguration med fail-fast (redovisningsmönstret).
//
// Den här modulen är den ENDA som läser process.env. Undantagen är
// migrations-CLI:t (src/db/migrate.ts) och nyckelskriptet
// (src/scripts/skapaNyckel.ts) — de kör som ägarrollen och får inte kräva
// appens konfiguration. Alla andra moduler importerar `config` härifrån, så
// env är garanterat laddad innan något värde läses.
//
// Servern vägrar starta med ofullständig config. Det finns inga
// fallback-hemligheter och det ska aldrig införas några.
//
// D-2, B-21 (Story 11.2): VY_PUBLIK_URL lämnas till adressmodulen
// (src/lib/arendelank.ts) när konfigurationen laddats, eftersom tjänstelagret,
// som bygger läsmodellernas `lank`, aldrig importerar den här filen.
import 'dotenv/config';
import { homedir } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { sattVyPublikUrl } from './lib/arendelank.js';

// D-2, B-21 (Story 11.2): driftens adress, tailnet-adressen där tailscale serve
// exponerar /vy (README avsnitt 8, FR-39: porten 8446) utan /vy på slutet. Ett
// satt värde går före, och en annan installation sätter sitt eget. Adressen är
// ett driftvärde och ingen hemlighet — samma mönster som VAULT_PATH och
// CRM_KONF_PATH — och standardvärdet prövas som varje satt värde.
export const VY_PUBLIK_URL_STANDARD = 'https://david-brain.tail743706.ts.net:8446';

/**
 * En https-adress som är exakt sin egen origin. Jämförelsen med origin fäller en
 * sökväg, ett avslutande snedstreck, en fråga eller ett fragment (också tomma),
 * användarnamn och lösenord, versaler i värden och en utskriven standardport.
 */
function arPublikAdress(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && v === u.origin;
}

export const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Ärendeplattformen kör på 3002 — redovisningen äger 3000/3001-området.
  PORT: z.coerce.number().int().nonnegative().max(65535).default(3002),
  // Ingen extern yta i Etapp 1: servern binds till loopback.
  HOST: z.string().min(1).default('127.0.0.1'),
  DATABASE_URL: z
    .string()
    .min(1, 'DATABASE_URL krävs (postgres://app@127.0.0.1:5435/arenden — den lågprivilegierade rollen)'),
  DATABASE_ADMIN_URL: z.string().min(1).optional(),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(120),
  // Vaulten som dokumentlänkarna läser ur. Vyn läser ENDAST, och bara de
  // vitlistade katalogerna i src/http/vy/dokument.ts.
  VAULT_PATH: z.string().min(1).default('/home/hermes/brain'),
  // CRM-kortet (src/http/vy/crm.ts) läser bas-URL, company-id och agent-token ur
  // SAMMA fil som crm_ingest.py. Sökvägen är konfiguration — samma mönster som
  // VAULT_PATH — så att testmiljön kan peka på en egen fil. Värdena i filen
  // stannar i processen och når aldrig klienten.
  CRM_KONF_PATH: z.string().min(1).default(path.join(homedir(), '.hermes', 'redovisning-mcp.json')),
  // D-2, B-21: läsvyns publika adress, grunden för ärendenas absoluta adress.
  // Förfiningen står på fältet (så att EnvSchema.shape finns kvar) och
  // standardvärdet utanpå den, så att också standardvärdet går genom prövningen.
  VY_PUBLIK_URL: z
    .string()
    .refine(
      arPublikAdress,
      'VY_PUBLIK_URL ska vara en https-adress utan sökväg, fråga eller fragment ' +
        '(i drift tailnet-adressen där tailscale serve exponerar /vy, utan /vy)',
    )
    .default(VY_PUBLIK_URL_STANDARD),
  // Adaptern (src/adapter/) ringer actions-API:t över HTTP — aldrig databasen.
  ARENDEN_API_URL: z.string().url().default('http://127.0.0.1:3002'),
  ARENDEN_API_KEY: z.string().min(1).optional(),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('FATAL: vägrar starta — ogiltig miljökonfiguration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(env)'}: ${issue.message}`);
  }
  process.exit(1);
}

export const config = Object.freeze({
  ...parsed.data,
  isTest: parsed.data.NODE_ENV === 'test',
});

// Tjänstelagret importerar aldrig den här filen (MCP-gatewayens importgräns,
// Story 4.2 F6), så det validerade värdet lämnas till adressmodulen här.
sattVyPublikUrl(config.VY_PUBLIK_URL);

export type Config = typeof config;
