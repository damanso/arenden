// Migrationsrunner med versionstabell (redovisningsmönstret, KRAV-3).
//
// Egenskaper:
//  - Versionstabell (schema_migrations) → återkörning är en no-op (idempotent).
//  - VÄGRAR dubbelnumrerade filer (odefinierad ordning = schemadrift).
//  - Checksumma per migration — en redan körd fil som ändrats ger fel i stället
//    för tyst drift.
//  - Advisory lock — två samtidiga körningar kan inte kapplöpa.
//  - Varje migration körs i en egen transaktion.
//
// OBS: detta är ett CLI som även används av testkoden via `migrate()`. Det läser
// DATABASE_ADMIN_URL/DATABASE_URL DIREKT ur process.env i CLI-läget (undantaget
// från config.ts-regeln: migrationer kör som ägarrollen och får inte kräva
// appens konfiguration).
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
// Konstant nyckel för pg_advisory_lock, unik för det här systemet.
const ADVISORY_LOCK_KEY = 502_874_311;

export interface MigrationFile {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** Läser och validerar migrationskatalogen. Kastar vid dubbelnumrering. */
export async function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const byVersion = new Map<number, string>();
  const migrations: MigrationFile[] = [];

  for (const filename of entries) {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) {
      throw new Error(
        `Ogiltigt migrationsfilnamn: ${filename} (förväntat NNNN_namn.sql, t.ex. 0001_grund.sql)`,
      );
    }
    const version = Number(match[1]);
    const existing = byVersion.get(version);
    if (existing !== undefined) {
      throw new Error(
        `Dubbelnumrerade migrationer: ${existing} och ${filename} har båda nummer ${match[1]} — ` +
          'vägrar köra (ordningen vore odefinierad)',
      );
    }
    byVersion.set(version, filename);
    const sql = await readFile(path.join(dir, filename), 'utf8');
    migrations.push({
      version,
      name: match[2] as string,
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(
  adminUrl: string,
  options: { dir?: string; log?: (msg: string) => void } = {},
): Promise<MigrateResult> {
  const log = options.log ?? (() => {});
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY,
        name text NOT NULL,
        checksum text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = await loadMigrations(options.dir);
    const appliedRows = await client.query<{ version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    );

    for (const row of appliedRows.rows) {
      const file = files.find((f) => f.version === row.version);
      if (!file) {
        throw new Error(`Migration ${row.version} (${row.name}) är körd i databasen men saknas på disk`);
      }
      if (file.checksum !== row.checksum) {
        throw new Error(
          `Checksumman för ${file.filename} matchar inte databasen — filen har ändrats efter att den körts. ` +
            'Skriv en ny migration i stället för att ändra en körd.',
        );
      }
    }

    const appliedVersions = new Set(appliedRows.rows.map((r) => r.version));
    const maxApplied = Math.max(0, ...appliedVersions);
    const pending = files.filter((f) => !appliedVersions.has(f.version));

    const outOfOrder = pending.find((f) => f.version < maxApplied);
    if (outOfOrder) {
      throw new Error(
        `Migration ${outOfOrder.filename} har lägre nummer än redan körda migrationer — ` +
          'vägrar köra i efterhand (skriv en ny migration med högre nummer)',
      );
    }

    const applied: string[] = [];
    for (const migration of pending) {
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [
          migration.version,
          migration.name,
          migration.checksum,
        ]);
        await client.query('COMMIT');
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignorera — ursprungsfelet nedan är det som betyder något
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Migration ${migration.filename} misslyckades: ${message}`);
      }
      log(`applied  ${migration.filename}`);
      applied.push(migration.filename);
    }

    return { applied, alreadyApplied: appliedRows.rowCount ?? 0 };
  } finally {
    await client.end(); // släpper advisory-låset
  }
}

// ---- CLI ----
const isCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isCli) {
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!adminUrl) {
    console.error('FATAL: DATABASE_ADMIN_URL (eller DATABASE_URL) måste vara satt');
    process.exit(1);
  }
  try {
    const result = await migrate(adminUrl, { log: (msg) => console.log(msg) });
    console.log(`OK: ${result.applied.length} migration(er) kördes, ${result.alreadyApplied} var redan körda`);
  } catch (err) {
    console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
