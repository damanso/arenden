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
import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
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

export type Config = typeof config;
