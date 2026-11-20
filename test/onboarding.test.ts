/**
 * FR-25, FR-4, B-27, Story 9.4: ett operatörssteg, med ärlig aktör.
 * AK 1/3: migration, tenantgräns och API (M1–M8). AK 2: numrering (M10).
 * AK 4: felvägar, fil och atomicitet även vid COMMIT (M3, M5, M9, M11–M12).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { format } from 'node:util';
import { ZodError } from 'zod';
import { ACTIONS } from '../src/actions/registry.js';
import { VERB } from '../src/http/vy/mall.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { hamtaEllerSkapaTeam, STANDARD_STATES } from '../src/services/team.js';
import { skapaNyckel } from '../src/services/nycklar.js';
import { TENANT_ID, lasNyckelnsTenant } from '../src/lib/tenant.js';
import { seedaTeam, nyNyckel, kor } from './helpers.js';
import * as provmiljon from './env.js';
import * as mottagningen from '../src/services/onboarding.js';

// Tenantgränsen prövas som i drift, utan provets anslutningsval (Story 9.2).
provmiljon.utanProvetsTenant();

const TENANT_C = '00000000-0000-0000-0000-000000000094';
let app: ReturnType<typeof createApp>;
let systemA: string;
let agentA: string;
let manniskaA: string;
let systemC: string;
let provkatalog: string;
let mottagningskatalog: string;
let tidigareKatalog: string;

async function agare<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  try {
    await c.connect();
    return await fn(c);
  } finally {
    await c.end();
  }
}

type Tabelltillstand = { n: number; avtryck: string };
async function avtryckAllaTabeller(tenantId?: string): Promise<Record<string, Tabelltillstand>> {
  return agare(async (c) => {
    const { rows } = await c.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const ut: Record<string, Tabelltillstand> = {};
    for (const { tablename } of rows) {
      const tabell = '"' + tablename.replaceAll('"', '""') + '"';
      const r = await c.query<Tabelltillstand>(
        `SELECT count(*)::int AS n,
                coalesce(md5(string_agg(t::text, chr(10) ORDER BY t::text)), '') AS avtryck
           FROM public.${tabell} t ${tenantId ? 'WHERE tenant_id = $1' : ''}`,
        tenantId ? [tenantId] : [],
      );
      ut[tablename] = r.rows[0]!;
    }
    return ut;
  });
}

function skillnad(fore: Record<string, Tabelltillstand>, efter: Record<string, Tabelltillstand>) {
  return Object.fromEntries(Object.entries(efter)
    .map(([t, v]) => [t, v.n - (fore[t]?.n ?? 0)] as const).filter(([, n]) => n !== 0));
}

function andradeTabeller(fore: Record<string, Tabelltillstand>, efter: Record<string, Tabelltillstand>) {
  return Object.keys({ ...fore, ...efter }).filter((t) => fore[t]?.avtryck !== efter[t]?.avtryck).sort();
}

const ORSAK = {
  aktorsnamnet_finns: 'Människans namn används redan av en nyckel i en tenant, och ingenting skapades.',
  tenantnamnet_finns: 'En tenant med det namnet finns redan, och ingenting skapades.',
  teamnyckeln_finns: 'Teamnyckeln används redan av en annan tenant, och ingenting skapades.',
  mottagningen_avbrots: 'Mottagningen avbröts innan den var klar, och ingenting skapades.',
  nyckelfilen_kunde_inte_skrivas: 'Nyckelfilen kunde inte skrivas, och ingenting skapades.',
} as const;

async function filer(): Promise<string[]> {
  try {
    return (await readdir(mottagningskatalog)).sort();
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
}

async function medAvbrott(fn: () => Promise<void>): Promise<void> {
  await agare(async (c) => {
    await c.query(`CREATE FUNCTION m94_avbryt() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'm94 avbrott'; END $$`);
    try {
      await c.query(`CREATE TRIGGER m94_avbryt BEFORE INSERT ON api_keys FOR EACH ROW
        WHEN (NEW.aktor_namn IN ('m3 avbryts', 'm9 avbryts')) EXECUTE FUNCTION m94_avbryt()`);
      await fn();
    } finally {
      await c.query('DROP TRIGGER IF EXISTS m94_avbryt ON api_keys');
      await c.query('DROP FUNCTION m94_avbryt()');
    }
  });
}

async function lasRader(tenantId: string) {
  return agare(async (c) => ({
    tenants: (await c.query('SELECT id, namn, tenant_id, xmin::text AS xmin FROM tenants WHERE id = $1',
      [tenantId])).rows,
    teams: (await c.query('SELECT id, key, namn, sekvensnamn, tenant_id, xmin::text AS xmin FROM teams WHERE tenant_id = $1',
      [tenantId])).rows,
    states: (await c.query('SELECT team_id, namn, typ, position, tenant_id, xmin::text AS xmin FROM workflow_states WHERE tenant_id = $1 ORDER BY position',
      [tenantId])).rows,
    api_keys: (await c.query('SELECT id, aktor_typ, aktor_namn, nyckelhash, tenant_id, xmin::text AS xmin FROM api_keys WHERE tenant_id = $1',
      [tenantId])).rows,
  }));
}

function hash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

async function fangUtdata<T>(fn: () => Promise<T>): Promise<{ svar: T; texter: string[] }> {
  const texter: string[] = [];
  const aterstall: (() => void)[] = [];
  for (const strom of [process.stdout, process.stderr]) {
    const original = strom.write;
    strom.write = function (...args: unknown[]): boolean {
      texter.push(String(args[0]));
      return Reflect.apply(original, strom, args);
    };
    aterstall.push(() => { strom.write = original; });
  }
  for (const namn of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[namn];
    console[namn] = (...args: unknown[]) => {
      texter.push(format(...args));
      Reflect.apply(original, console, args);
    };
    aterstall.push(() => { console[namn] = original; });
  }
  try {
    return { svar: await fn(), texter };
  } finally {
    for (const atgard of aterstall.reverse()) atgard();
  }
}

function apiIndata(namn: string, team_key: string, forsta_manniska: string) {
  return { namn, team_key, team_namn: `${team_key} team`, forsta_manniska,
    beslut: 'Davids ja 2026-11-20' };
}

beforeAll(async () => {
  await seedaTeam();
  await agare((c) => c.query(
    "INSERT INTO tenants (id, namn) VALUES ($1, 'Tenant C (Story 9.4)')", [TENANT_C],
  ));
  await withTransaction((c) => hamtaEllerSkapaTeam(c, TENANT_C, 'TC', 'Tenant C'), TENANT_C);
  systemA = await nyNyckel({ typ: 'system', namn: 'm94 operatör' });
  agentA = await nyNyckel({ typ: 'agent', namn: 'm94 agent' });
  manniskaA = await nyNyckel({ typ: 'manniska', namn: 'm94 manniska' });
  const nyC = (typ: 'agent' | 'manniska' | 'system', namn: string) => withTransaction(async (c) =>
    (await skapaNyckel(c, TENANT_C, { typ, namn })).nyckel, TENANT_C);
  const agentC = await nyC('agent', 'm94c agent');
  await nyC('manniska', 'm94c manniska');
  systemC = await nyC('system', 'm94c operatör');
  app = createApp();
  expect((await kor(app, agentC, 'create_issue', { title: 'm94c arende', team_key: 'TC' })).status).toBe(200);
  provkatalog = await mkdtemp(path.join(tmpdir(), 'onboarding-prov-'));
  mottagningskatalog = path.join(provkatalog, 'mottagna');
  tidigareKatalog = mottagningen.sattNyckelfilernasKatalog(mottagningskatalog);
});

afterAll(async () => {
  if (tidigareKatalog !== undefined) mottagningen.sattNyckelfilernasKatalog(tidigareKatalog);
  if (provkatalog) await rm(provkatalog, { recursive: true, force: true });
});

describe('FR-25/Story 9.4 AK 1: migrationen ger steget dess rättigheter', () => {
  it('M1 (AK 1 och AK 3): kolumnrättigheter, unikt namn, tenantgräns och transaktionslås', async () => {
    await agare(async (c) => {
      expect((await c.query(`SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_schema = 'public' AND table_name = 'tenants' AND grantee = 'app'
        ORDER BY privilege_type`)).rows.map((r) => r.privilege_type)).toEqual(['SELECT']);
      expect((await c.query(`SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'public' AND table_name = 'tenants' AND grantee = 'app'
          AND privilege_type = 'INSERT' ORDER BY column_name`)).rows.map((r) => r.column_name))
        .toEqual(['id', 'namn']);
      await c.query('BEGIN');
      try {
        await c.query('INSERT INTO tenants (id, namn) VALUES ($1, $2)', [randomUUID(), 'M1 Kund']);
        await expect(c.query('INSERT INTO tenants (id, namn) VALUES ($1, $2)', [randomUUID(), '  m1 kund ']))
          .rejects.toMatchObject({ code: '23505', constraint: 'tenants_namn_unik' });
      } finally {
        await c.query('ROLLBACK');
      }
    });
    const fore = await avtryckAllaTabeller();
    const avbryt = new Error('M1 rulla tillbaka');
    const x = randomUUID();
    await expect(withTransaction(async (c) => {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [x]);
      await c.query('INSERT INTO tenants (id, namn) VALUES ($1, $2)', [x, 'M1 app']);
      throw avbryt;
    }, TENANT_ID)).rejects.toBe(avbryt);
    await expect(withTransaction(async (c) => {
      await c.query("SELECT set_config('app.tenant_id', $1, true)", [x]);
      await c.query('INSERT INTO tenants (id, namn) VALUES ($1, $2)', [randomUUID(), 'M1 fel tenant']);
      throw avbryt;
    }, TENANT_ID)).rejects.toMatchObject({ code: '42501' });
    expect(await avtryckAllaTabeller()).toEqual(fore);
    expect((await pool.query(`SELECT p.prosecdef,
      has_function_privilege('app', p.oid, 'EXECUTE') AS app,
      (SELECT count(*)::int FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        WHERE a.grantee = 0) AS publik
      FROM pg_proc p WHERE p.oid = 'tenantmottagningens_las()'::regprocedure`)).rows)
      .toEqual([{ prosecdef: false, app: true, publik: 0 }]);
    await agare(async (forsta) => {
      await forsta.query('BEGIN');
      try {
        await forsta.query('SELECT tenantmottagningens_las()');
        await agare(async (andra) => {
          await andra.query('BEGIN');
          try {
            await andra.query("SET LOCAL lock_timeout = '200ms'");
            await expect(andra.query('SELECT tenantmottagningens_las()'))
              .rejects.toMatchObject({ code: '55P03' });
          } finally {
            await andra.query('ROLLBACK');
          }
          await forsta.query('COMMIT');
          await andra.query('BEGIN');
          try {
            await andra.query("SET LOCAL lock_timeout = '200ms'");
            await andra.query('SELECT tenantmottagningens_las()');
          } finally {
            await andra.query('ROLLBACK');
          }
        });
      } finally {
        await forsta.query('ROLLBACK');
      }
    });
    const sql = readFileSync(new URL('../migrations/0021_onboarding.sql', import.meta.url), 'utf8');
    expect(sql.startsWith('-- ')).toBe(true);
    expect(sql).not.toMatch(/\bCREATE\s+(TABLE|POLICY)\b/i);
    expect(readFileSync(new URL('../migrations/0020_radsakerhet.sql', import.meta.url), 'utf8'))
      .toMatch(/\bCREATE\s+(TABLE|POLICY)\b/i);
  });
});

describe('FR-25/Story 9.4 AK 1: tjänsten skriver den nya tenantens rader i den tenanten', () => {
  it('M2 (AK 1): fyra slags rader har samma xmin och tjänsten återställer tenant A', async () => {
    const fore = await avtryckAllaTabeller();
    const svar = await withTransaction(async (c) => {
      const varde = await mottagningen.taEmotTenant(c, TENANT_ID, { typ: 'system', namn: 'm2 operatör' }, {
        namn: 'M2 Kund AB', team_key: 'MTVA', team_namn: 'M2 team', forsta_manniska: 'm2 manniska',
      });
      expect((await c.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant)
        .toBe(TENANT_ID);
      return varde;
    }, TENANT_ID);
    const r = await lasRader(svar.tenant_id);
    expect(r.tenants).toHaveLength(1);
    expect(r.tenants[0]).toMatchObject({ id: svar.tenant_id, namn: 'M2 Kund AB', tenant_id: svar.tenant_id });
    expect(r.teams).toHaveLength(1);
    expect(r.teams[0]).toMatchObject({ key: 'MTVA', namn: 'M2 team', sekvensnamn: 'arende_nummer_mtva' });
    expect(r.states.map(({ namn, typ, position }) => ({ namn, typ, position }))).toEqual(STANDARD_STATES);
    expect(r.states.every((s) => s.team_id === r.teams[0].id)).toBe(true);
    expect(r.api_keys).toHaveLength(1);
    expect(r.api_keys[0]).toMatchObject({
      id: svar.nyckel_id, aktor_typ: 'manniska', aktor_namn: 'm2 manniska', nyckelhash: hash(svar.nyckel),
    });
    const alla = [...r.tenants, ...r.teams, ...r.states, ...r.api_keys];
    expect(alla.every((rad) => rad.tenant_id === svar.tenant_id)).toBe(true);
    expect(new Set(alla.map((rad) => rad.xmin)).size).toBe(1);
    expect((await avtryckAllaTabeller()).events).toEqual(fore.events);
    expect(await lasNyckelnsTenant(pool, { typ: 'manniska', namn: 'm2 manniska' })).toBe(svar.tenant_id);
  });

  it('M4 (AK 1): tenantbytet släpper bara igenom den nya tenantens rader', async () => {
    const fore = await avtryckAllaTabeller(TENANT_C);
    const ny = randomUUID();
    for (const [sql, params] of [
      ['INSERT INTO teams (tenant_id, key, namn, sekvensnamn) VALUES ($1, $2, $3, $4)',
        [TENANT_C, 'MFYRA', 'M4 team', 'arende_nummer_mfyra']],
      ['INSERT INTO api_keys (tenant_id, nyckelhash, aktor_typ, aktor_namn) VALUES ($1, $2, $3, $4)',
        [TENANT_C, 'a'.repeat(64), 'manniska', 'm4 manniska']],
      ['INSERT INTO tenants (id, namn) VALUES ($1, $2)', [randomUUID(), 'M4 fel tenant']],
    ] as const) {
      await expect(withTransaction(async (c) => {
        await mottagningen.vaxlaTenant(c, ny);
        await c.query(sql, [...params]);
      }, TENANT_ID)).rejects.toMatchObject({ code: '42501' });
    }
    const avbryt = new Error('M4 kontroll rullas tillbaka');
    await expect(withTransaction(async (c) => {
      await mottagningen.vaxlaTenant(c, ny);
      expect((await c.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant).toBe(ny);
      await c.query('INSERT INTO tenants (id, namn) VALUES ($1, $2)', [ny, 'M4 egen tenant']);
      await c.query('INSERT INTO teams (tenant_id, key, namn, sekvensnamn) VALUES ($1, $2, $3, $4)',
        [ny, 'MFYRA', 'M4 team', 'arende_nummer_mfyra']);
      throw avbryt;
    }, TENANT_ID)).rejects.toBe(avbryt);
    expect(await avtryckAllaTabeller(TENANT_C)).toEqual(fore);
  });
});

describe('FR-25/Story 9.4 AK 1 och AK 4: tjänstens prövningar och felvägar', () => {
  it('M3 (AK 1 och AK 4): otillåtna aktörer, namnkonflikter och avbrott lämnar noll rader', async () => {
    const indata = { namn: 'M3 Kund AB', team_key: 'MTREA', team_namn: 'M3 team', forsta_manniska: 'm3 manniska' };
    const prova = async (aktor: { typ: 'agent' | 'manniska' | 'system'; namn: string },
      tenantId: string, input: typeof indata, code: 'kraver_system' | keyof typeof ORSAK) => {
      const fore = await avtryckAllaTabeller();
      const foreFiler = await filer();
      await expect(withTransaction((c) => mottagningen.taEmotTenant(c, tenantId, aktor, input), tenantId))
        .rejects.toMatchObject(code === 'kraver_system' ? { status: 403, code } : {
          status: code === 'mottagningen_avbrots' ? 500 : 409, code, details: { orsak: ORSAK[code] },
        });
      expect(await avtryckAllaTabeller()).toEqual(fore);
      expect(await filer()).toEqual(foreFiler);
    };
    await prova({ typ: 'agent', namn: 'm3 agent' }, TENANT_ID, indata, 'kraver_system');
    await prova({ typ: 'manniska', namn: 'm3 manniska' }, TENANT_ID, indata, 'kraver_system');
    const system = { typ: 'system' as const, namn: 'm3 operatör' };
    await prova(system, TENANT_C, indata, 'kraver_system');
    await prova(system, TENANT_ID, { ...indata, namn: '  tenant c (story 9.4) ',
      team_key: 'MTRED', forsta_manniska: 'm3d manniska' }, 'tenantnamnet_finns');
    for (const [bokstav, key] of [['e', 'TC'], ['f', 'LOC']]) {
      await prova(system, TENANT_ID, { ...indata, namn: `M3${bokstav} Kund AB`, team_key: key!,
        forsta_manniska: `m3${bokstav} manniska` }, 'teamnyckeln_finns');
    }
    for (const namn of ['m94 manniska', 'm94c manniska']) {
      await prova(system, TENANT_ID, { ...indata, namn: 'M3g Kund AB', team_key: 'MTREG',
        forsta_manniska: namn }, 'aktorsnamnet_finns');
    }
    await medAvbrott(() => prova(system, TENANT_ID, { ...indata, namn: 'M3h Kund AB', team_key: 'MTREH',
      forsta_manniska: 'm3 avbryts' }, 'mottagningen_avbrots'));
    const fore = await avtryckAllaTabeller();
    await withTransaction((c) => mottagningen.taEmotTenant(c, TENANT_ID, system, {
      ...indata, namn: 'M3 Kontroll AB', team_key: 'MTREK', forsta_manniska: 'm3k manniska',
    }), TENANT_ID);
    expect(andradeTabeller(fore, await avtryckAllaTabeller())).toEqual(['api_keys', 'teams', 'tenants', 'workflow_states']);
  });
});

describe('FR-25/Story 9.4 AK 1 och AK 4: nyckelfilen', () => {
  it('M5 (AK 1 och AK 4): privat fil, oförändrat vid katalogfel och idempotent borttagning', async () => {
    const katalog = path.join(provkatalog, 'm5');
    mottagningen.sattNyckelfilernasKatalog(katalog);
    try {
      const id = randomUUID();
      const klartext = 'b'.repeat(64);
      const fil = await mottagningen.skrivNyckelfil(id, klartext);
      expect(fil).toBe(path.join(katalog, `tenant-${id}-manniska.txt`));
      expect((await stat(fil)).mode & 0o777).toBe(0o600);
      expect((await stat(katalog)).mode & 0o777).toBe(0o700);
      expect(await readFile(fil, 'utf8')).toBe(`${klartext}\n`);
      await mottagningen.taBortNyckelfil(fil);
      await expect(mottagningen.taBortNyckelfil(fil)).resolves.toBeUndefined();
      expect(await readdir(katalog)).toEqual([]);
      const vanligFil = path.join(provkatalog, 'm5-hinder');
      await writeFile(vanligFil, 'vanlig fil');
      const fore = (await readdir(provkatalog)).sort();
      mottagningen.sattNyckelfilernasKatalog(vanligFil);
      await expect(mottagningen.skrivNyckelfil(randomUUID(), klartext)).rejects.toMatchObject({
        status: 500, code: 'nyckelfilen_kunde_inte_skrivas',
        details: { orsak: ORSAK.nyckelfilen_kunde_inte_skrivas },
      });
      expect((await readdir(provkatalog)).sort()).toEqual(fore);
    } finally {
      mottagningen.sattNyckelfilernasKatalog(mottagningskatalog);
    }
  });
});

describe('FR-25/Story 9.4 AK 1 och AK 3: operatörssteget via API:t', () => {
  it('M6 (AK 1 och AK 3): ett steg skriver exakt raderna, ärlig historik och klartext bara i filen', async () => {
    const input = { ...apiIndata('M6 Kund AB', 'MSEX', 'm6 manniska'), team_namn: 'M6 team',
      beslut: 'beslut m6: Davids ja 2026-11-20' };
    const fore = await avtryckAllaTabeller();
    const cFore = await avtryckAllaTabeller(TENANT_C);
    const foreFiler = await filer();
    const { svar, texter } = await fangUtdata(async () => {
      console.log('m94 kontroll av fångstriggen');
      return kor(app, systemA, 'ta_emot_tenant', input);
    });
    expect(texter.join('\n')).toContain('m94 kontroll av fångstriggen');
    expect(svar.status).toBe(200);
    expect(svar.body).toMatchObject({ status: 'ok', action: 'ta_emot_tenant' });
    const r = svar.body.result;
    expect(Object.keys(r).sort()).toEqual([
      'tenant_id', 'tenant_namn', 'team_key', 'team_namn', 'nyckel_id', 'manniska', 'nyckelfil',
    ].sort());
    expect(r.tenant_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(r.nyckel_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(r).toMatchObject({ tenant_namn: input.namn, team_key: 'MSEX', team_namn: 'M6 team', manniska: 'm6 manniska' });
    expect(r.nyckelfil).toBe(path.join(mottagningskatalog, `tenant-${r.tenant_id}-manniska.txt`));
    const efter = await avtryckAllaTabeller();
    expect(skillnad(fore, efter)).toEqual({ api_keys: 1, events: 1, teams: 1, tenants: 1, workflow_states: 5 });
    expect(andradeTabeller(fore, efter)).toEqual(['api_keys', 'events', 'teams', 'tenants', 'workflow_states']);
    expect(await avtryckAllaTabeller(TENANT_C)).toEqual(cFore);
    expect((await filer()).filter((fil) => !foreFiler.includes(fil))).toEqual([path.basename(r.nyckelfil)]);
    const rader = await lasRader(r.tenant_id);
    expect(rader.tenants).toHaveLength(1);
    expect(rader.teams).toHaveLength(1);
    expect(rader.states).toHaveLength(5);
    expect(rader.api_keys).toHaveLength(1);
    const events = await agare(async (c) => (await c.query(
      "SELECT tenant_id, issue_id, aktor_typ, aktor_namn, verb, payload, xmin::text AS xmin FROM events WHERE verb = 'tog_emot_tenant' AND payload->>'tenant_id' = $1",
      [r.tenant_id],
    )).rows);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ tenant_id: TENANT_ID, issue_id: null,
      aktor_typ: 'system', aktor_namn: 'm94 operatör', verb: 'tog_emot_tenant' });
    expect(events[0].payload).toEqual({
      tenant_id: r.tenant_id, tenant_namn: input.namn, team_key: input.team_key, team_namn: input.team_namn,
      nyckel_id: r.nyckel_id, ny_aktor_typ: 'manniska', ny_aktor_namn: input.forsta_manniska, beslut: input.beslut,
    });
    expect(new Set([...rader.tenants, ...rader.teams, ...rader.states, ...rader.api_keys, ...events]
      .map((rad) => rad.xmin)).size).toBe(1);
    const innehall = await readFile(r.nyckelfil, 'utf8');
    expect(innehall).toMatch(/^[0-9a-f]{64}\n$/);
    expect((await stat(r.nyckelfil)).mode & 0o777).toBe(0o600);
    const klartext = innehall.trimEnd();
    for (const text of [svar.text, JSON.stringify(events[0].payload), ...texter]) {
      expect(text).not.toContain(klartext);
      expect(text).not.toContain(hash(klartext));
    }
    expect(rader.api_keys[0]).toMatchObject({ tenant_id: r.tenant_id,
      aktor_typ: 'manniska', aktor_namn: 'm6 manniska', nyckelhash: hash(klartext) });
    const vem = await kor(app, klartext, 'vem_ar_jag');
    expect(vem.status).toBe(200);
    expect(vem.body.result).toEqual({ aktor_typ: 'manniska', aktor_namn: 'm6 manniska' });
    expect(await lasNyckelnsTenant(pool, { typ: 'manniska', namn: 'm6 manniska' })).toBe(r.tenant_id);
    expect(VERB.tog_emot_tenant).toBe('tog emot en ny tenant');
  });

  it('M7 (AK 1 och AK 3): agent, människa och system i C nekas utan rader eller fil', async () => {
    for (const nyckel of [agentA, manniskaA, systemC]) {
      const fore = await avtryckAllaTabeller();
      const foreFiler = await filer();
      const svar = await kor(app, nyckel, 'ta_emot_tenant', apiIndata('M7 Kund AB', 'MSJU', 'm7 manniska'));
      expect(svar.status).toBe(403);
      expect(svar.body).toEqual({ error: 'kraver_system' });
      expect(await avtryckAllaTabeller()).toEqual(fore);
      expect(await filer()).toEqual(foreFiler);
    }
  });

  it('M8 (AK 1 och AK 3): det slutna schemat kräver fem fält och avvisar påstådd aktör och tenant', async () => {
    const input = apiIndata('M8 Kund AB', 'MATTA', 'm8 manniska');
    const { beslut: _beslut, ...utanBeslut } = input;
    for (const indata of [utanBeslut, { ...input, beslut: '' }, { ...input, tenant_id: TENANT_C },
      { ...input, aktor_typ: 'manniska', aktor_namn: 'påstådd människa' }]) {
      const fore = await avtryckAllaTabeller();
      const foreFiler = await filer();
      const svar = await kor(app, systemA, 'ta_emot_tenant', indata);
      expect(svar.status).toBe(400);
      expect(svar.body.error).toBe('validation_error');
      expect(await avtryckAllaTabeller()).toEqual(fore);
      expect(await filer()).toEqual(foreFiler);
    }
    const action = ACTIONS.find((a) => a.name === 'ta_emot_tenant')!;
    expect(action).toBeDefined();
    expect(action.parse(input)).toEqual(input);
    for (const falt of Object.keys(input)) {
      const ofullstandigt: Record<string, string> = { ...input };
      delete ofullstandigt[falt];
      expect(() => action.parse(ofullstandigt)).toThrow(ZodError);
    }
    try {
      action.parse({ ...input, okant: 'avvisas' });
      expect.fail('okänt fält godtogs');
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      expect((err as ZodError).issues.some((i) => i.code === 'unrecognized_keys')).toBe(true);
    }
    expect((await request(app).post('/api/actions/ta_emot_tenant').send(input)).status).toBe(401);
  });
});

describe('FR-25/Story 9.4 AK 4: felvägarna via API:t', () => {
  it('M9 (AK 4): konflikter, avbrott och filfel ger en fast mening och noll rader', async () => {
    const prova = async (input: ReturnType<typeof apiIndata>, code: keyof typeof ORSAK) => {
      const fore = await avtryckAllaTabeller();
      const foreFiler = await filer();
      const svar = await kor(app, systemA, 'ta_emot_tenant', input);
      expect(svar.status).toBe(code === 'mottagningen_avbrots' || code === 'nyckelfilen_kunde_inte_skrivas' ? 500 : 409);
      expect(svar.body).toEqual({ error: code, details: { orsak: ORSAK[code] } });
      expect(await avtryckAllaTabeller()).toEqual(fore);
      expect(await filer()).toEqual(foreFiler);
    };
    await prova(apiIndata('TENANT C (STORY 9.4)', 'MNIOA', 'm9a manniska'), 'tenantnamnet_finns');
    await prova(apiIndata('M9b Kund AB', 'TC', 'm9b manniska'), 'teamnyckeln_finns');
    await prova(apiIndata('M9c Kund AB', 'MNIOC', 'm94c manniska'), 'aktorsnamnet_finns');
    await medAvbrott(() => prova(apiIndata('M9d Kund AB', 'MNIOD', 'm9 avbryts'), 'mottagningen_avbrots'));
    const hinder = path.join(provkatalog, 'm9-hinder');
    await writeFile(hinder, 'vanlig fil');
    const fore = (await readdir(provkatalog)).sort();
    mottagningen.sattNyckelfilernasKatalog(hinder);
    try {
      await prova(apiIndata('M9e Kund AB', 'MNIOE', 'm9e manniska'), 'nyckelfilen_kunde_inte_skrivas');
      expect((await readdir(provkatalog)).sort()).toEqual(fore);
    } finally {
      mottagningen.sattNyckelfilernasKatalog(mottagningskatalog);
    }
  });

  it('M11 (AK 4): samtidiga steg kan bara skapa samma människa eller tenantnamn en gång', async () => {
    for (const [input1, input2, code] of [
      [apiIndata('M11a Kund AB', 'MELVA', 'm11 samma'), apiIndata('M11a Annan AB', 'MELVB', 'm11 samma'), 'aktorsnamnet_finns'],
      [apiIndata('M11 Samma AB', 'MELVC', 'm11c manniska'), apiIndata('M11 Samma AB', 'MELVD', 'm11d manniska'), 'tenantnamnet_finns'],
    ] as const) {
      const fore = await avtryckAllaTabeller();
      const foreFiler = await filer();
      const svar = await Promise.all([
        kor(app, systemA, 'ta_emot_tenant', input1), kor(app, systemA, 'ta_emot_tenant', input2),
      ]);
      expect(svar.map((s) => s.status).sort()).toEqual([200, 409]);
      expect(svar.find((s) => s.status === 409)!.body)
        .toEqual({ error: code, details: { orsak: ORSAK[code] } });
      expect((await filer()).filter((fil) => !foreFiler.includes(fil))).toHaveLength(1);
      expect(skillnad(fore, await avtryckAllaTabeller()))
        .toEqual({ api_keys: 1, events: 1, teams: 1, tenants: 1, workflow_states: 5 });
      await agare(async (c) => {
        if (code === 'aktorsnamnet_finns') {
          expect((await c.query("SELECT tenant_id FROM aktorens_tenanter('manniska', 'm11 samma')")).rows)
            .toHaveLength(1);
        } else {
          expect((await c.query("SELECT id FROM tenants WHERE namn = 'M11 Samma AB'")).rows).toHaveLength(1);
        }
      });
    }
  });
});

describe('FR-25/Story 9.4 AK 2: den nya tenanten börjar från noll', () => {
  it('M10 (AK 2): egna nummer från ett, Locollabs fortsätter och läsningen stannar i N', async () => {
    const locFore = await kor(app, agentA, 'create_issue', { title: 'M10 LOC före', team_key: 'LOC' });
    expect(locFore.status).toBe(200);
    const svar = await kor(app, systemA, 'ta_emot_tenant', apiIndata('M10 Kund AB', 'MTIO', 'm10 manniska'));
    expect(svar.status).toBe(200);
    const klartext = (await readFile(svar.body.result.nyckelfil, 'utf8')).trimEnd();
    for (const nr of [1, 2]) {
      const nytt = await kor(app, klartext, 'create_issue', { title: `M10 ärende ${nr}`, team_key: 'MTIO' });
      expect(nytt.status).toBe(200);
      expect(nytt.body.result.identifier).toBe(`MTIO-${nr}`);
    }
    const locEfter = await kor(app, agentA, 'create_issue', { title: 'M10 LOC efter', team_key: 'LOC' });
    expect(locEfter.status).toBe(200);
    const k = Number(locFore.body.result.identifier.split('-')[1]);
    expect(locEfter.body.result.identifier).toBe(`LOC-${k + 1}`);
    const lista = await kor(app, klartext, 'list_issues');
    expect(lista.status).toBe(200);
    expect(lista.body.result.arenden.map((r: { identifier: string }) => r.identifier).sort())
      .toEqual(['MTIO-1', 'MTIO-2']);
    expect((await kor(app, klartext, 'get_issue', { identifier: locFore.body.result.identifier })).status).toBe(404);
  });
});

describe('FR-25/Story 9.4 AK 4: en avvisad COMMIT lämnar ingen nyckelfil', () => {
  it('M12 (AK 4): uppskjutet databasfel rullar tillbaka allt och tar bort filen, framgång behåller den', async () => {
    const fore = await avtryckAllaTabeller();
    const foreFiler = await filer();
    await agare(async (c) => {
      await c.query(`CREATE FUNCTION m94_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'm94 commit avvisas'; END $$`);
      try {
        await c.query(`CREATE CONSTRAINT TRIGGER m94_commit AFTER INSERT ON tenants
          DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.namn = 'M12 Commit avvisas')
          EXECUTE FUNCTION m94_commit()`);
        const svar = await kor(app, systemA, 'ta_emot_tenant',
          apiIndata('M12 Commit avvisas', 'MTOLV', 'm12 manniska'));
        expect(svar.status).toBe(409);
        expect(svar.body).toEqual({ error: 'rule_violation' });
        expect(await avtryckAllaTabeller()).toEqual(fore);
        expect(await filer()).toEqual(foreFiler);
      } finally {
        await c.query('DROP TRIGGER IF EXISTS m94_commit ON tenants');
        await c.query('DROP FUNCTION m94_commit()');
      }
    });
    const svar = await kor(app, systemA, 'ta_emot_tenant',
      apiIndata('M12 Kontroll AB', 'MTOLVK', 'm12k manniska'));
    expect(svar.status).toBe(200);
    expect((await filer()).filter((fil) => !foreFiler.includes(fil)))
      .toEqual([path.basename(svar.body.result.nyckelfil)]);
    expect(await readFile(svar.body.result.nyckelfil, 'utf8')).toMatch(/^[0-9a-f]{64}\n$/);
  });
});
