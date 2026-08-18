import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';

// KRAV-4: RLS-beredskap från dag 1. Policyerna byggs i Etapp 3, men KOLUMNEN och
// indexet måste finnas på varje tabell nu — annars blir Etapp 3 en datamigrering
// i stället för en policyändring.
const UNDANTAG = ['tenants', 'schema_migrations'];

describe('KRAV-4/9: schemat är RLS-berett och sökbart', () => {
  it('varje tabell har tenant_id NOT NULL', async () => {
    const { rows } = await pool.query<{ tabell: string; nullable: string | null }>(
      `SELECT t.tablename AS tabell, c.is_nullable AS nullable
         FROM pg_tables t
         LEFT JOIN information_schema.columns c
           ON c.table_name = t.tablename AND c.column_name = 'tenant_id' AND c.table_schema = 'public'
        WHERE t.schemaname = 'public' AND t.tablename <> ALL($1::text[])
        ORDER BY t.tablename`,
      [UNDANTAG],
    );

    expect(rows.length).toBeGreaterThan(0);
    for (const rad of rows) {
      expect(rad.nullable, `${rad.tabell} saknar tenant_id`).not.toBeNull();
      expect(rad.nullable, `${rad.tabell}.tenant_id är nullbar`).toBe('NO');
    }
  });

  it('varje tabell har ett index som börjar på tenant_id', async () => {
    const { rows } = await pool.query<{ tabell: string }>(
      `SELECT t.tablename AS tabell
         FROM pg_tables t
        WHERE t.schemaname = 'public'
          AND t.tablename <> ALL($1::text[])
          AND NOT EXISTS (
            SELECT 1 FROM pg_index i
              JOIN pg_class c ON c.oid = i.indrelid
              JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
             WHERE c.relname = t.tablename AND a.attname = 'tenant_id')`,
      [UNDANTAG],
    );
    expect(rows.map((r) => r.tabell)).toEqual([]);
  });

  it('events är append-only och app-rollen saknar UPDATE/DELETE', async () => {
    const { rows } = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'events' AND grantee = 'app'`,
    );
    const rattigheter = rows.map((r) => r.privilege_type).sort();
    expect(rattigheter).toEqual(['INSERT', 'SELECT']);
  });

  it('sökkolumnerna är GENERATED och GIN-indexerade', async () => {
    const { rows } = await pool.query<{ table_name: string; is_generated: string }>(
      `SELECT table_name, is_generated FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'sokvektor' ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual(['comments', 'issues']);
    for (const rad of rows) expect(rad.is_generated).toBe('ALWAYS');

    const index = await pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE schemaname = 'public' AND indexdef LIKE '%USING gin%' ORDER BY indexname`,
    );
    expect(index.rows.map((r) => r.indexname)).toEqual(['comments_sok_idx', 'issues_sok_idx']);
  });

  it('appen kör som en icke-superuser utan BYPASSRLS och utan tabellägarskap', async () => {
    const { assertAppRollArBegransad } = await import('../src/db/pool.js');
    await expect(assertAppRollArBegransad()).resolves.toBeUndefined();
  });
});
