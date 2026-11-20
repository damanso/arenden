/**
 * FR-25, FR-3, B-27, Story 9.2: databasen håller tenantgränsen.
 * AK 1: katalogstyrda policyer (S7). AK 2: räkning och isolering (S2, S8–S9).
 * AK 3: provmiljö, skript, numrering och uttrycklig tenant (S1, S6, S11–S14).
 * AK 4: begränsade uppslag och fungerande ingångar (S3–S5, S10).
 */
import { execFile } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { assertAppRollArBegransad, pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { hamtaEllerSkapaTeam } from '../src/services/team.js';
import { TENANT_ID, lasNyckelnsTenant } from '../src/lib/tenant.js';
import { skapaArende } from '../src/services/arenden.js';
import { laggTillKommentar } from '../src/services/kommentarer.js';
import { skrivHandelse } from '../src/services/handelser.js';
import { glomAllaSessioner } from '../src/http/vy/session.js';
import * as provhjalpare from './helpers.js';
import * as nyckeltjansten from '../src/services/nycklar.js';
import * as provmiljon from './env.js';

// Filen prövar tenantgränsen som i drift, före den första anslutningen (B-27).
provmiljon.utanProvetsTenant?.();

const TENANT_B = '00000000-0000-0000-0000-000000000092';
let app: ReturnType<typeof createApp>;
let agentA: string;
let manniskaA: string;
let agentB: string;

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
async function avtryck(): Promise<Record<'issues' | 'comments' | 'events', Tabelltillstand>> {
  return agare(async (c) => {
    const ut = {} as Record<'issues' | 'comments' | 'events', Tabelltillstand>;
    for (const tabell of ['issues', 'comments', 'events'] as const) {
      const { rows } = await c.query<Tabelltillstand>(
        `SELECT count(*)::int AS n,
                coalesce(md5(string_agg(t::text, chr(10) ORDER BY t::text)), '') AS avtryck
           FROM public.${tabell} t`,
      );
      ut[tabell] = rows[0]!;
    }
    return ut;
  });
}

beforeAll(async () => {
  await provhjalpare.seedaTeam();
  await agare((c) => c.query("INSERT INTO tenants (id, namn) VALUES ($1, 'Tenant B (Story 9.2)')", [TENANT_B]));
  await withTransaction((c) => hamtaEllerSkapaTeam(c, TENANT_B, 'TB', 'Tenant B'), TENANT_B);
  agentA = await provhjalpare.nyNyckel({ typ: 'agent', namn: 'r92 agent A' });
  manniskaA = await provhjalpare.nyNyckel({ typ: 'manniska', namn: 'r92 manniska A' });
  agentB = await withTransaction(async (c) =>
    (await nyckeltjansten.skapaNyckel(c, TENANT_B, { typ: 'agent', namn: 'r92 agent B' })).nyckel, TENANT_B);
  app = createApp();
});

describe('FR-25/Story 9.2 AK 2 och AK 3: provmiljöns tenant och räkningen som app', () => {
  it('S1 (AK 3): anslutningsvalet ger Locollabs tenant och kan stängas av', async () => {
    const lasNyAnslutning = async () => {
      const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
      try {
        await c.connect();
        return (await c.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant;
      } finally {
        await c.end();
      }
    };
    try {
      expect(provmiljon.PROVETS_TENANTVAL).toBe(`-c app.tenant_id=${TENANT_ID}`);
      process.env.PGOPTIONS = provmiljon.PROVETS_TENANTVAL;
      expect(await lasNyAnslutning()).toBe(TENANT_ID);
      provmiljon.utanProvetsTenant();
      expect(await lasNyAnslutning()).toBeNull();
      provmiljon.applyTestEnv();
      expect(process.env.PGOPTIONS).toBe(provmiljon.PROVETS_TENANTVAL);
    } finally {
      provmiljon.utanProvetsTenant?.();
    }
  });

  it('S2 (AK 2): räkning utan tenant avvisas och en satt tenant ger ägarrollens antal', async () => {
    expect((await provhjalpare.kor(app, agentA, 'create_issue', {
      title: 'S2 räkningsvakt', team_key: 'LOC',
    })).status).toBe(200);
    await expect(withTransaction((c) => provhjalpare.raknaMedTenant(c, 'issues')))
      .rejects.toThrow(/tenant/);
    const antal = await agare(async (c) => Number((await c.query(
      'SELECT count(*) AS n FROM issues WHERE tenant_id = $1', [TENANT_ID],
    )).rows[0].n));
    expect(antal).toBeGreaterThan(0);
    expect(await withTransaction((c) => provhjalpare.raknaMedTenant(c, 'issues'), TENANT_ID)).toBe(antal);
    expect(await provhjalpare.raknaRader('issues')).toBe(antal);
  });
});

describe('FR-25/Story 9.2 AK 4: nyckeluppslaget går genom funktionerna', () => {
  it('S3 (AK 4): hash ger bara aktiv nyckels aktör och tenant', async () => {
    const las = (nyckel: string) => pool.query(
      'SELECT aktor_typ, aktor_namn, tenant_id FROM nyckelns_aktor($1)',
      [nyckeltjansten.hashaNyckel(nyckel)],
    );
    expect((await las(agentA)).rows).toEqual([
      { aktor_typ: 'agent', aktor_namn: 'r92 agent A', tenant_id: TENANT_ID },
    ]);
    expect((await las(agentB)).rows).toEqual([
      { aktor_typ: 'agent', aktor_namn: 'r92 agent B', tenant_id: TENANT_B },
    ]);
    const aterkallad = await provhjalpare.nyNyckel({ typ: 'agent', namn: 'r92 s3 aterkallad' });
    await agare((c) => c.query('UPDATE api_keys SET aktiv = false WHERE nyckelhash = $1',
      [nyckeltjansten.hashaNyckel(aterkallad)]));
    expect((await las(aterkallad)).rows).toEqual([]);
    expect((await las('r92 okand')).rows).toEqual([]);
    expect((await pool.query(
      "SELECT pg_get_function_result('nyckelns_aktor(text)'::regprocedure) AS resultat",
    )).rows).toEqual([{ resultat: 'TABLE(aktor_typ text, aktor_namn text, tenant_id uuid)' }]);
    expect(await nyckeltjansten.slaUppAktor(pool, agentA)).toEqual({ typ: 'agent', namn: 'r92 agent A' });
    expect(await nyckeltjansten.slaUppAktor(pool, aterkallad)).toBeNull();
  });

  it('S4 (AK 4): aktörens tenanter omfattar återkallade nycklar och ingen okänd aktör', async () => {
    const las = (namn: string) => pool.query('SELECT tenant_id FROM aktorens_tenanter($1, $2)', ['agent', namn]);
    expect((await las('r92 agent A')).rows).toEqual([{ tenant_id: TENANT_ID }]);
    expect((await las('r92 agent B')).rows).toEqual([{ tenant_id: TENANT_B }]);
    const aterkallad = await provhjalpare.nyNyckel({ typ: 'agent', namn: 'r92 s4 aterkallad' });
    await agare((c) => c.query('UPDATE api_keys SET aktiv = false WHERE nyckelhash = $1',
      [nyckeltjansten.hashaNyckel(aterkallad)]));
    expect((await las('r92 s4 aterkallad')).rows).toEqual([{ tenant_id: TENANT_ID }]);
    expect((await las('r92 utan nyckel')).rows).toEqual([]);
    for (const [namn, tenant] of [
      ['r92 agent A', TENANT_ID], ['r92 agent B', TENANT_B], ['r92 utan nyckel', null],
      ['r92 s4 aterkallad', TENANT_ID],
    ] as const) {
      expect(await lasNyckelnsTenant(pool, { typ: 'agent', namn })).toBe(tenant);
    }
  });

  it('S5 (AK 4): funktionerna ägs av tabellägaren med låst sökväg och begränsad anropsrätt', async () => {
    for (const funktion of ['nyckelns_aktor(text)', 'aktorens_tenanter(text,text)']) {
      const { rows } = await pool.query(
        `SELECT p.prosecdef, p.proconfig,
                p.proowner = (SELECT relowner FROM pg_class WHERE oid = 'api_keys'::regclass) AS agare,
                has_function_privilege('app', p.oid, 'EXECUTE') AS app,
                (SELECT count(*)::int
                   FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                  WHERE a.grantee = 0) AS publik
           FROM pg_proc p WHERE p.oid = $1::regprocedure`, [funktion],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        prosecdef: true, proconfig: ['search_path=public, pg_temp'], agare: true, app: true, publik: 0,
      });
    }
  });
});

describe('FR-25/Story 9.2 AK 3: nyckelskriptets tenant', () => {
  it('S6 (AK 3): tjänsten sätter saknad tenant, godtar samma och nekar en annan före skrivning', async () => {
    const tenant = await withTransaction(async (c) => {
      await nyckeltjansten.skapaNyckel(c, TENANT_B, { typ: 'agent', namn: 'r92 s6 b' });
      return (await c.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant;
    });
    expect(tenant).toBe(TENANT_B);
    expect(await agare(async (c) => (await c.query(
      "SELECT tenant_id FROM api_keys WHERE aktor_namn = 'r92 s6 b'",
    )).rows)).toEqual([{ tenant_id: TENANT_B }]);
    await expect(withTransaction((c) => nyckeltjansten.skapaNyckel(
      c, TENANT_ID, { typ: 'agent', namn: 'r92 s6 a' },
    ), TENANT_ID)).resolves.toHaveProperty('id');
    await expect(withTransaction((c) => nyckeltjansten.skapaNyckel(
      c, TENANT_B, { typ: 'agent', namn: 'r92 s6 krock' },
    ), TENANT_ID)).rejects.toThrow(/tenant/);
    expect(await agare(async (c) => (await c.query(
      "SELECT count(*)::int AS n FROM api_keys WHERE aktor_namn = 'r92 s6 krock'",
    )).rows)).toEqual([{ n: 0 }]);
  });
});

const ROT = fileURLToPath(new URL('..', import.meta.url));
// API-svaret är ett kuvert; båda fixturerna valideras innan deras fält används.
// Proven typkontrolleras inte, så en typdeklaration ensam skyddar inte S13.
const FixturarendeSchema = z.object({
  id: z.string().uuid(),
  identifier: z.string().min(1),
  title: z.string().min(1),
});
let arendeA: z.infer<typeof FixturarendeSchema>;
let arendeB: z.infer<typeof FixturarendeSchema>;
let kommentarA: string;
let kommentarB: string;
let handelseA: string;
let handelseB: string;

beforeAll(async () => {
  glomAllaSessioner();
  const a = await provhjalpare.kor(app, agentA, 'create_issue', {
    title: 'r92 loc radsakerhetsord', team_key: 'LOC',
  });
  expect(a.status).toBe(200);
  arendeA = FixturarendeSchema.parse(a.body.result.arende);
  const kommentar = await provhjalpare.kor(app, agentA, 'add_comment', {
    identifier: arendeA.identifier, body: 'r92 a kommentar',
  });
  expect(kommentar.status).toBe(200);
  kommentarA = kommentar.body.result.id;
  await withTransaction(async (c) => {
    const aktor = { typ: 'agent' as const, namn: 'r92 agent B' };
    arendeB = FixturarendeSchema.parse(await skapaArende(
      c, TENANT_B, { title: 'r92 b radsakerhetsord', team_key: 'TB' },
    ));
    await skrivHandelse(c, TENANT_B, aktor, {
      issueId: arendeB.id, verb: 'skapade_arende',
      payload: { identifier: arendeB.identifier, title: arendeB.title },
    });
    const b = await laggTillKommentar(c, TENANT_B, arendeB.id, 'r92 b kommentar', aktor);
    kommentarB = b.id;
    await skrivHandelse(c, TENANT_B, aktor, {
      issueId: arendeB.id, verb: 'kommenterade',
      payload: { identifier: arendeB.identifier, kommentar_id: b.id },
    });
  }, TENANT_B);
  [handelseA, handelseB] = await agare(async (c) => {
    const las = async (id: string) => (await c.query(
      "SELECT id::text FROM events WHERE issue_id = $1 AND verb = 'skapade_arende'", [id],
    )).rows[0].id as string;
    return [await las(arendeA.id), await las(arendeB.id)];
  });
});

type Anslutning = {
  query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>;
};
const TENANTTABELLER = `
  SELECT t.relname::text AS tabell, t.relrowsecurity, t.relforcerowsecurity
    FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE n.nspname = 'public' AND t.relkind IN ('r', 'p')
     AND EXISTS (SELECT 1 FROM pg_attribute a
                  WHERE a.attrelid = t.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped)
   ORDER BY t.relname`;

async function rlsfynd(c: Anslutning): Promise<string[]> {
  const { rows: tabeller } = await c.query<{
    tabell: string; relrowsecurity: boolean; relforcerowsecurity: boolean;
  }>(TENANTTABELLER);
  const { rows: policyer } = await c.query<{
    tablename: string; policyname: string; cmd: string; roles: string[];
    qual: string | null; with_check: string | null;
  }>(`SELECT tablename, policyname, cmd, roles::text[], qual, with_check
        FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename, policyname`);
  const fynd: string[] = [];
  const uttryck = new Set<string | null>();
  for (const t of tabeller) {
    if (!t.relrowsecurity) fynd.push(`${t.tabell}: radsäkerheten är av`);
    if (t.relforcerowsecurity) fynd.push(`${t.tabell}: radsäkerheten är tvingad`);
    const egna = policyer.filter((p) => p.tablename === t.tabell);
    if (egna.length !== 1) fynd.push(`${t.tabell}: ${egna.length} policyer`);
    for (const p of egna) {
      if (p.policyname !== 'tenant_isolering' || p.cmd !== 'ALL'
        || JSON.stringify(p.roles) !== JSON.stringify(['app']) || p.qual !== p.with_check
        || !p.qual?.includes('app.tenant_id') || !/NULLIF/i.test(p.qual)) {
        fynd.push(`${t.tabell}: ${p.policyname} har fel form`);
      }
      // Jämför isoleringspolicyn mellan tabeller; en extra policy får sitt eget fynd ovan.
      if (p.policyname === 'tenant_isolering') uttryck.add(p.qual);
    }
  }
  if (uttryck.size > 1) fynd.push('policyerna har olika uttryck');
  return fynd.sort();
}

describe('FR-25/Story 9.2 AK 1: policyer på varje tenantbunden tabell', () => {
  it('S7 (AK 1): katalogens alla tabeller har samma isoleringspolicy, och kontrollen fäller fel', async () => {
    expect(await rlsfynd(pool)).toEqual([]);
    const tabeller = (await pool.query(TENANTTABELLER)).rows.map((t) => t.tabell);
    expect(tabeller).toEqual(expect.arrayContaining([
      'tenants', 'teams', 'workflow_states', 'projects', 'labels', 'issues', 'issue_labels',
      'comments', 'events', 'api_keys', 'issue_relations', 'issue_attachments', 'beslut_atagande',
      'beslut_svarsversion', 'arbetsmoment', 'insatser', 'insats_kallor', 'nodvandiga_delresultat',
      'schema_migrations',
    ]));
    await expect(assertAppRollArBegransad(pool)).resolves.toBeUndefined();
    await agare(async (c) => {
      await c.query('BEGIN');
      try {
        await c.query('CREATE TABLE s7_kontroll (tenant_id uuid)');
        await c.query('ALTER TABLE labels DISABLE ROW LEVEL SECURITY');
        await c.query('CREATE POLICY s7_extra ON issues USING (true)');
        expect(await rlsfynd(c)).toEqual([
          's7_kontroll: radsäkerheten är av', 's7_kontroll: 0 policyer',
          'labels: radsäkerheten är av', 'issues: 2 policyer', 'issues: s7_extra har fel form',
        ].sort());
      } finally {
        await c.query('ROLLBACK');
      }
    });
    expect(await rlsfynd(pool)).toEqual([]);
  });
});

describe('FR-25/Story 9.2 AK 2: isoleringen håller också när en fråga glömt filtret', () => {
  it('S8 (AK 2): A ser bara A och kan varken ändra eller infoga B:s rader', async () => {
    const fore = await avtryck();
    const fixturer = [
      ['issues', arendeA.id, arendeB.id], ['comments', kommentarA, kommentarB],
      ['events', handelseA, handelseB],
    ] as const;
    await withTransaction(async (c) => {
      for (const [tabell, a, b] of fixturer) {
        const { rows } = await c.query(`SELECT id::text AS id, tenant_id FROM ${tabell}`);
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((r) => r.tenant_id === TENANT_ID)).toBe(true);
        expect(rows.map((r) => r.id)).toContain(a);
        expect(rows.map((r) => r.id)).not.toContain(b);
      }
      expect((await c.query("UPDATE issues SET title = 'S8 kapad' WHERE id = $1", [arendeB.id])).rowCount).toBe(0);
      expect((await c.query("UPDATE comments SET body = 'S8 kapad' WHERE id = $1", [kommentarB])).rowCount).toBe(0);
    }, TENANT_ID);
    await expect(withTransaction((c) => c.query(
      `INSERT INTO comments (tenant_id, issue_id, body, aktor_typ, aktor_namn)
       VALUES ($1, $2, 'S8 kapad', 'agent', 'r92 agent A')`, [TENANT_B, arendeB.id],
    ), TENANT_ID)).rejects.toMatchObject({ code: '42501' });
    await expect(withTransaction((c) => c.query(
      `INSERT INTO events (tenant_id, issue_id, aktor_typ, aktor_namn, verb)
       VALUES ($1, $2, 'agent', 'r92 agent A', 'kommenterade')`, [TENANT_B, arendeB.id],
    ), TENANT_ID)).rejects.toMatchObject({ code: '42501' });
    expect(await avtryck()).toEqual(fore);
    // Kontroll: B:s rader är verkliga och läsbara med B som tenant.
    await withTransaction(async (c) => {
      for (const [tabell, a, b] of fixturer) {
        const { rows } = await c.query(`SELECT id::text AS id, tenant_id FROM ${tabell}`);
        expect(rows.every((r) => r.tenant_id === TENANT_B)).toBe(true);
        expect(rows.map((r) => r.id)).toContain(b);
        expect(rows.map((r) => r.id)).not.toContain(a);
      }
    }, TENANT_B);
  });

  it('S9 (AK 2): utan tenant syns noll rader, även efter återanvändning av poolanslutningen', async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try {
      await c.connect();
      expect((await c.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant).toBeNull();
      for (const tabell of ['issues', 'comments', 'events', 'api_keys']) {
        expect((await c.query(`SELECT count(*)::int AS n FROM ${tabell}`)).rows).toEqual([{ n: 0 }]);
        expect(await agare(async (admin) => (await admin.query(
          `SELECT count(*)::int AS n FROM ${tabell}`,
        )).rows[0].n)).toBeGreaterThan(0);
      }
    } finally {
      await c.end();
    }
    const rakna = async (client: pg.PoolClient) => (await client.query(
      'SELECT count(*)::int AS n FROM issues',
    )).rows[0].n;
    expect(await withTransaction(rakna)).toBe(0);
    expect(await withTransaction(rakna, TENANT_ID)).toBeGreaterThan(0);
    for (let i = 0; i < 10; i += 1) expect(await withTransaction(rakna)).toBe(0);
  });
});

describe('FR-25/Story 9.2 AK 4: direkt läsning och uppslag under RLS', () => {
  it('S10 (AK 4): direktläsningen stänger medan uppslag, API och människans inloggning fungerar', async () => {
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try {
      await c.connect();
      expect((await c.query('SELECT id FROM api_keys')).rows).toEqual([]);
      expect((await c.query(
        'SELECT aktor_typ, aktor_namn, tenant_id FROM nyckelns_aktor($1)',
        [nyckeltjansten.hashaNyckel(agentA)],
      )).rows).toEqual([{ aktor_typ: 'agent', aktor_namn: 'r92 agent A', tenant_id: TENANT_ID }]);
    } finally {
      await c.end();
    }
    const svar = await provhjalpare.kor(app, agentA, 'vem_ar_jag');
    expect(svar.status).toBe(200);
    expect(svar.body.result).toEqual({ aktor_typ: 'agent', aktor_namn: 'r92 agent A' });
    const manniska = await request(app).post('/vy/logga-in').type('form').send({ nyckel: manniskaA, fran: '/vy' });
    expect(manniska.status).toBe(303);
    expect((manniska.headers['set-cookie'] ?? []).join(';')).toContain('arenden_vy=');
    const agent = await request(app).post('/vy/logga-in').type('form').send({ nyckel: agentA, fran: '/vy' });
    expect(agent.status).toBe(303);
    expect(agent.headers.location).toContain('fel=agent');
    expect(agent.headers['set-cookie']).toBeUndefined();
  });
});

describe('FR-25/Story 9.2 AK 3: nyckelskriptet och numreringen', () => {
  it('S11 (AK 3): skriptet anger tenant för nyckeln och dess händelse i samma transaktion', async () => {
    const fil = path.join(tmpdir(), `rls-s11-${process.pid}-${Date.now()}.txt`);
    const miljo = { ...process.env, DOTENV_CONFIG_PATH: path.join(tmpdir(), 'rls-s11-finns-inte') };
    delete miljo.PGOPTIONS;
    try {
      const resultat = await promisify(execFile)(path.join(ROT, 'node_modules', '.bin', 'tsx'), [
        path.join(ROT, 'src', 'scripts', 'skapaNyckel.ts'), 'agent', 'r92 s11 agent', '--fil', fil,
      ], { cwd: ROT, env: miljo, timeout: 20_000 });
      // execFile avvisar varje exitkod utom 0.
      expect(resultat.stderr).toBe('');
      expect(await agare(async (c) => (await c.query(
        `SELECT k.tenant_id, e.tenant_id AS handelsens, e.verb
           FROM api_keys k JOIN events e ON e.xmin = k.xmin
          WHERE k.aktor_namn = 'r92 s11 agent'`,
      )).rows)).toEqual([{
        tenant_id: TENANT_ID, handelsens: TENANT_ID, verb: 'skapade_aktorsidentitet',
      }]);
      const nyckel = (await readFile(fil, 'utf8')).trim();
      expect((await provhjalpare.kor(app, nyckel, 'vem_ar_jag')).status).toBe(200);
    } finally {
      await rm(fil, { force: true });
    }
    // Kontroll: app utan inställning får inte skriva en ny identitet direkt.
    const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
    try {
      await c.connect();
      await c.query('BEGIN');
      try {
        await expect(c.query(
          `INSERT INTO api_keys (tenant_id, nyckelhash, aktor_typ, aktor_namn)
           VALUES ($1, $2, 'agent', 'r92 s11 kontroll')`,
          [TENANT_ID, nyckeltjansten.hashaNyckel('r92 s11 attrapp')],
        )).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.query('ROLLBACK');
      }
    } finally {
      await c.end();
    }
  });

  it('S12 (AK 3, R): LOC-numren följer varandra med ett separat TB-ärende emellan', async () => {
    const hogsta = () => agare(async (c) => (await c.query(
      `SELECT coalesce(max(i.sequence_number), 0)::int AS n
         FROM issues i JOIN teams t ON t.id = i.team_id
        WHERE i.tenant_id = $1 AND t.key = 'LOC'`, [TENANT_ID],
    )).rows[0].n as number);
    const n = await hogsta();
    const ett = await provhjalpare.kor(app, agentA, 'create_issue', { title: 'S12 LOC ett', team_key: 'LOC' });
    expect(ett.status).toBe(200);
    expect(ett.body.result.identifier).toBe(`LOC-${n + 1}`);
    const b = await withTransaction((c) => skapaArende(
      c, TENANT_B, { title: 'S12 i B', team_key: 'TB' },
    ), TENANT_B);
    expect(b.identifier).toMatch(/^TB-\d+$/);
    const tva = await provhjalpare.kor(app, agentA, 'create_issue', { title: 'S12 LOC två', team_key: 'LOC' });
    expect(tva.status).toBe(200);
    expect(tva.body.result.identifier).toBe(`LOC-${n + 2}`);
    // Kontroll: mät även databasen och B:s prefix, inte bara API-svaren.
    expect(await hogsta()).toBe(n + 2);
    expect(b.identifier).not.toMatch(/^LOC-/);
  });
});

// Samma parentesräkning som i tenantgränsprovet; kommentarerna räknas inte som anrop.
function argumenten(text: string, monster: RegExp): string[] {
  const kod = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const ut: string[] = [];
  for (const m of kod.matchAll(new RegExp(monster.source, 'g'))) {
    const start = m.index! + m[0].length;
    let djup = 0;
    let j = start;
    for (; j < kod.length; j += 1) {
      if (kod[j] === '(') djup += 1;
      else if (kod[j] === ')' && djup-- === 0) break;
    }
    ut.push(kod.slice(start, j).replace(/\s+/g, ' ').trim().replace(/,\s*$/, ''));
  }
  return ut;
}

function argumentlista(args: string): string[] {
  const ut: string[] = [];
  let djup = 0;
  let start = 0;
  for (let i = 0; i < args.length; i += 1) {
    const c = args[i]!;
    if ('([{'.includes(c)) djup += 1;
    else if (')]}'.includes(c)) djup -= 1;
    else if (c === ',' && djup === 0) {
      ut.push(args.slice(start, i).trim());
      start = i + 1;
    }
  }
  const sista = args.slice(start).trim();
  if (sista) ut.push(sista);
  return ut;
}

describe('FR-25/Story 9.2 AK 3: vyns läsningar och mätskripten i Locollabs tenant', () => {
  it('S13 (AK 3): vyn visar Locollabs rader utan provets anslutningsval', async () => {
    expect(process.env.PGOPTIONS).toBeUndefined();
    // Kontrollera hela felklassen för båda inläsningsvägarna: kuvertet är inte
    // ärendet, och inget fält som används i provet får saknas eller ha fel typ.
    for (const [arende, title] of [
      [arendeA, 'r92 loc radsakerhetsord'], [arendeB, 'r92 b radsakerhetsord'],
    ] as const) {
      expect(arende.title).toBe(title);
      expect(FixturarendeSchema.safeParse(arende).success).toBe(true);
      expect(FixturarendeSchema.safeParse({
        id: arende.id, identifier: arende.identifier, arende,
      }).success).toBe(false);
      for (const falt of ['id', 'identifier', 'title'] as const) {
        for (const varde of [undefined, null, 42, '']) {
          expect(FixturarendeSchema.safeParse({ ...arende, [falt]: varde }).success,
            `${arende.identifier}: ${falt} = ${String(varde)}`).toBe(false);
        }
      }
    }
    const oversikt = await request(app).get('/vy');
    expect(oversikt.status).toBe(200);
    expect(oversikt.text).toContain(arendeA.title);
    expect(oversikt.text).not.toContain(arendeB.title);
    const digest = await request(app).get('/vy/digest');
    expect(digest.status).toBe(200);
    // Händelseraden visar numret som länk (handelseRad i vy-routern).
    expect(digest.text).toContain(arendeA.identifier);
    const mitt = await request(app).get('/vy/mitt');
    expect(mitt.status).toBe(200);
    expect(mitt.text).toContain('r92 agent A');
    const fritext = await request(app).get('/vy/sok').query({ q: 'radsakerhetsord' });
    expect(fritext.status).toBe(200);
    expect(fritext.text).toContain(arendeA.title);
    const adress = `/vy/arende/${arendeA.identifier}`;
    const nummer = await request(app).get('/vy/sok').query({ q: arendeA.identifier });
    expect(nummer.status).toBe(303);
    expect(nummer.headers.location).toBe(adress);
    const kort = await request(app).get(adress);
    expect(kort.status).toBe(200);
    expect(kort.text).toContain(arendeA.title);
    const rattelser = await request(app).get('/vy/rattelser');
    expect(rattelser.status).toBe(200);
    expect(rattelser.text).toContain('r92 agent A');
  });

  it('S14 (AK 3): varje produktionsanrop anger tenant och typen kräver den', () => {
    const mat = (text: string) => argumenten(text, /\bwithTransaction\s*\(/)
      .filter((args) => argumentlista(args).length !== 2);
    const src = path.join(ROT, 'src');
    const fynd: string[] = [];
    let antal = 0;
    for (const fil of readdirSync(src, { recursive: true }) as string[]) {
      if (!fil.endsWith('.ts')) continue;
      const text = readFileSync(path.join(src, fil), 'utf8');
      antal += argumenten(text, /\bwithTransaction\s*\(/).length;
      fynd.push(...mat(text).map((args) => `${fil}: ${args.slice(0, 120)}`));
    }
    expect(fynd).toEqual([]);
    expect(antal).toBeGreaterThanOrEqual(14);
    const tx = readFileSync(path.join(src, 'db', 'tx.ts'), 'utf8');
    expect(tx).toContain('tenantId: string');
    expect(tx).not.toMatch(/tenantId\s*\?:/);
    // Kontroller: ett saknat argument fälls, medan en flerradig lista med slutkomma godtas.
    expect(mat('withTransaction((c) => f(c, TENANT_ID))')).toHaveLength(1);
    expect(mat('withTransaction((c) =>\n  f(c),\n  TENANT_ID,\n)')).toEqual([]);
  });
});
