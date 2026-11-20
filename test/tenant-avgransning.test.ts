/**
 * FR-25, B-27 (tillägg 2026-11-19), Story 9.1, leads besked 2026-11-19.
 * AK 1: nyckelns tenant i kontext, inställning och händelser; aktören är orörd.
 * AK 2: läsning och skrivning avgränsas mellan A och B, med ägarrollens avtryck.
 * AK 3: LOC-numreringen och alla befintliga prov behåller sitt beteende.
 * N1–N2: uppslag och transaktion. N3–N8: API, vy, isolering och numrering.
 * N9–N10: uttrycklig tenant och slutna undantag. N11: proveniens (R).
 * N12: en aktör i flera tenanter nekas innan något skrivs.
 */
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { nyNyckel, seedaTeam, kor, TENANT_ID } from './helpers.js';
import { hamtaEllerSkapaTeam } from '../src/services/team.js';
import * as nyckeltjansten from '../src/services/nycklar.js';
import * as tenantmodulen from '../src/lib/tenant.js';
import { executeAction } from '../src/actions/execute.js';
import { ACTIONS, type RegistreradAction } from '../src/actions/registry.js';
import { skapaArende } from '../src/services/arenden.js';
import { laggTillKommentar } from '../src/services/kommentarer.js';
import { skrivHandelse } from '../src/services/handelser.js';
import { glomAllaSessioner } from '../src/http/vy/session.js';
import { utanProvetsTenant } from './env.js';

// Tenantgränsen prövas som i drift; N2 kräver en transaktion utan inställning.
utanProvetsTenant();

const TENANT_B = '00000000-0000-0000-0000-000000000091';
let app: ReturnType<typeof createApp>;
let agentA: string;
let manniskaA: string;
let agentB: string;
let manniskaB: string;
let deladAgent: string;
let deladManniska: string;

async function agare<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  try {
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
  await seedaTeam();
  await agare((c) => c.query("INSERT INTO tenants (id, namn) VALUES ($1, 'Tenant B (Story 9.1)')", [TENANT_B]));
  await withTransaction((c) => hamtaEllerSkapaTeam(c, TENANT_B, 'TB', 'Tenant B'), TENANT_B);
  agentA = await nyNyckel({ typ: 'agent', namn: 'n91 agent A' });
  manniskaA = await nyNyckel({ typ: 'manniska', namn: 'n91 människa A' });
  deladAgent = await nyNyckel({ typ: 'agent', namn: 'n91 delat namn' });
  deladManniska = await nyNyckel({ typ: 'manniska', namn: 'n91 delat namn' });
  agentB = await withTransaction(async (c) =>
    (await nyckeltjansten.skapaNyckel(c, TENANT_B, { typ: 'agent', namn: 'n91 agent B' })).nyckel);
  manniskaB = await withTransaction(async (c) =>
    (await nyckeltjansten.skapaNyckel(c, TENANT_B, { typ: 'manniska', namn: 'n91 människa B' })).nyckel);
  app = createApp();
});

describe('FR-25/Story 9.1 AK 1: nyckelns tenant och transaktionens inställning', () => {
  it('N1 (AK 1): uppslaget räknar typ, återkallade nycklar och flera tenanter', async () => {
    const a = await tenantmodulen.lasNyckelnsTenant(pool, { typ: 'agent', namn: 'n91 agent A' });
    const b = await tenantmodulen.lasNyckelnsTenant(pool, { typ: 'agent', namn: 'n91 agent B' });
    expect(a).toBe(TENANT_ID);
    expect(b).toBe(TENANT_B);
    expect(a).not.toBe(b);
    expect(await tenantmodulen.lasNyckelnsTenant(pool, { typ: 'manniska', namn: 'n91 människa A' })).toBe(TENANT_ID);
    expect(await tenantmodulen.lasNyckelnsTenant(pool, { typ: 'manniska', namn: 'n91 människa B' })).toBe(TENANT_B);
    const aterkallad = await withTransaction((c) =>
      nyckeltjansten.skapaNyckel(c, TENANT_B, { typ: 'agent', namn: 'n91 återkallad B' }));
    await agare((c) => c.query('UPDATE api_keys SET aktiv = false WHERE id = $1', [aterkallad.id]));
    expect(await tenantmodulen.lasNyckelnsTenant(pool, { typ: 'agent', namn: 'n91 återkallad B' })).toBe(TENANT_B);
    const utan = await tenantmodulen.lasNyckelnsTenant(pool, { typ: 'agent', namn: 'n91 utan nyckel' });
    expect(utan).toBeNull();
    expect([a, b]).not.toContain(utan);
    await withTransaction((c) =>
      nyckeltjansten.skapaNyckel(c, TENANT_B, { typ: 'agent', namn: 'n91 människa A' }));
    expect(await tenantmodulen.lasNyckelnsTenant(pool, { typ: 'agent', namn: 'n91 människa A' })).toBe(TENANT_B);
    expect(await tenantmodulen.lasNyckelnsTenant(pool, { typ: 'manniska', namn: 'n91 människa A' })).toBe(TENANT_ID);
    await nyNyckel({ typ: 'manniska', namn: 'n91 dubbel N1' });
    await withTransaction((c) =>
      nyckeltjansten.skapaNyckel(c, TENANT_B, { typ: 'manniska', namn: 'n91 dubbel N1' }));
    await expect(tenantmodulen.lasNyckelnsTenant(pool, { typ: 'manniska', namn: 'n91 dubbel N1' }))
      .rejects.toMatchObject({ status: 403, code: 'aktor_i_flera_tenanter' });
  });

  it('N2 (AK 1): inställningen är lokal, även på återanvänd anslutning och efter rollback', async () => {
    const las = async (c: pg.PoolClient) => (await c.query<{ pid: number; tenant: string | null }>(
      "SELECT pg_backend_pid() AS pid, current_setting('app.tenant_id', true) AS tenant",
    )).rows[0]!;
    const med = await withTransaction(las, TENANT_B);
    expect(med.tenant).toBe(TENANT_B);
    const utan = await withTransaction(las);
    expect([null, '']).toContain(utan.tenant);
    const satt = await withTransaction(las, TENANT_B);
    const ateranvanda = [];
    for (let i = 0; i < 10; i += 1) {
      const rad = await withTransaction(las);
      expect([null, '']).toContain(rad.tenant);
      expect(rad.tenant).not.toBe(TENANT_B);
      ateranvanda.push(rad.pid);
    }
    expect(ateranvanda).toContain(satt.pid);
    await expect(withTransaction(async (c) => {
      expect((await las(c)).tenant).toBe(TENANT_B);
      await c.query('INSERT INTO labels (tenant_id, namn) VALUES ($1, $2)', [TENANT_B, 'N2 återställs']);
      throw new Error('N2 avsiktligt fel');
    }, TENANT_B)).rejects.toThrow('N2 avsiktligt fel');
    expect(await agare(async (c) => (await c.query(
      'SELECT id FROM labels WHERE tenant_id = $1 AND namn = $2', [TENANT_B, 'N2 återställs'],
    )).rows)).toEqual([]);
    expect([null, '']).toContain((await withTransaction(las)).tenant);
  });
});

describe('FR-25/Story 9.1 AK 1: aktören är orörd, en agentnyckel skriver aldrig i en människas namn', () => {
  it('N11 (AK 1, R): agentens försök att ange människans proveniens avvisas', async () => {
    const skapad = await kor(app, deladAgent, 'create_issue', { title: 'N11 agent', team_key: 'LOC' });
    expect(skapad.status).toBe(200);
    const { identifier, id } = skapad.body.result;
    expect((await kor(app, deladAgent, 'add_comment', { identifier, body: 'N11 agentkommentar' })).status).toBe(200);
    await agare(async (c) => {
      expect((await c.query('SELECT verb, aktor_typ, aktor_namn FROM events WHERE issue_id = $1 ORDER BY id', [id])).rows)
        .toEqual([
          { verb: 'skapade_arende', aktor_typ: 'agent', aktor_namn: 'n91 delat namn' },
          { verb: 'kommenterade', aktor_typ: 'agent', aktor_namn: 'n91 delat namn' },
        ]);
      expect((await c.query('SELECT aktor_typ, aktor_namn FROM comments WHERE issue_id = $1', [id])).rows)
        .toEqual([{ aktor_typ: 'agent', aktor_namn: 'n91 delat namn' }]);
    });
    const mans = await kor(app, deladManniska, 'add_comment', { identifier, body: 'N11 människokommentar' });
    expect(mans.status).toBe(200);
    await agare(async (c) => {
      expect((await c.query('SELECT aktor_typ, aktor_namn FROM comments WHERE id = $1', [mans.body.result.id])).rows)
        .toEqual([{ aktor_typ: 'manniska', aktor_namn: 'n91 delat namn' }]);
      expect((await c.query('SELECT aktor_typ, aktor_namn FROM events WHERE issue_id = $1 ORDER BY id DESC LIMIT 1', [id])).rows)
        .toEqual([{ aktor_typ: 'manniska', aktor_namn: 'n91 delat namn' }]);
    });
    const fore = await avtryck();
    const falsk = await kor(app, deladAgent, 'add_comment', {
      identifier, body: 'N11 förfalskad', aktor_typ: 'manniska', aktor_namn: 'n91 delat namn',
    });
    expect(falsk.status).toBe(400);
    expect(falsk.body.error).toBe('validation_error');
    expect(await avtryck()).toEqual(fore);
    const inloggning = await request(app).post('/vy/logga-in').type('form').send({ nyckel: deladAgent, fran: '/vy' });
    expect(inloggning.status).toBe(303);
    expect(inloggning.headers.location).toContain('fel=agent');
    expect(String(inloggning.headers['set-cookie'] ?? '')).not.toContain('arenden_vy=');
    expect((await request(app).post(`/vy/arende/${identifier}/kommentar`).type('form')
      .send({ body: 'N11 utan kaka' })).status).toBe(401);
    expect(await avtryck()).toEqual(fore);
    await agare(async (c) => {
      for (const tabell of ['events', 'comments']) {
        const { rows } = await c.query(
          `SELECT id FROM ${tabell} WHERE aktor_namn = $1 AND aktor_typ = 'manniska'`, ['n91 delat namn'],
        );
        expect(rows).toHaveLength(1);
      }
    });
  });
});

async function medUtbytt<T>(
  actionName: string,
  handler: RegistreradAction['handler'],
  korning: () => Promise<T>,
): Promise<T> {
  const action = ACTIONS.find((a) => a.name === actionName);
  if (!action) throw new Error(`Okänd action: ${actionName}`);
  const ordinarie = action.handler;
  action.handler = handler;
  try {
    return await korning();
  } finally {
    action.handler = ordinarie;
  }
}

const locIdentifier: string[] = [];
const bArenden: Awaited<ReturnType<typeof skapaArende>>[] = [];
beforeAll(async () => {
  glomAllaSessioner();
  for (const title of ['LOC ett tenantprovord', 'LOC två']) {
    const svar = await kor(app, agentA, 'create_issue', { title, team_key: 'LOC' });
    expect(svar.status).toBe(200);
    locIdentifier.push(svar.body.result.identifier);
  }
  expect((await kor(app, agentA, 'add_comment', {
    identifier: locIdentifier[1], body: 'kommentar med tenantprovord',
  })).status).toBe(200);
  await withTransaction(async (c) => {
    const aktor = { typ: 'agent' as const, namn: 'n91 agent B' };
    for (const title of ['TB ett tenantprovord', 'TB två']) {
      const arende = await skapaArende(c, TENANT_B, { title, team_key: 'TB' });
      bArenden.push(arende);
      await skrivHandelse(c, TENANT_B, aktor, {
        issueId: arende.id, verb: 'skapade_arende', payload: { identifier: arende.identifier, title },
      });
    }
    const arende = bArenden[1]!;
    const kommentar = await laggTillKommentar(c, TENANT_B, arende.id, 'kommentar med tenantprovord', aktor);
    await skrivHandelse(c, TENANT_B, aktor, {
      issueId: arende.id, verb: 'kommenterade',
      payload: { identifier: arende.identifier, kommentar_id: kommentar.id },
    });
  }, TENANT_B);
});

describe('FR-25/Story 9.1 AK 1: transaktionens tenant via /api och vyn', () => {
  it('N3 (AK 1): handlern ser samma tenant i kontext och databas', async () => {
    const ordinarie = ACTIONS.find((a) => a.name === 'vem_ar_jag')!.handler;
    await medUtbytt('vem_ar_jag', async (ctx) => ({
      tenant: ctx.tenantId,
      installning: (await ctx.client.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant,
    }), async () => {
      for (const [nyckel, tenant] of [[agentA, TENANT_ID], [agentB, TENANT_B]]) {
        const svar = await kor(app, nyckel!, 'vem_ar_jag');
        expect(svar.status).toBe(200);
        expect(svar.body.result).toEqual({ tenant, installning: tenant });
      }
    });
    expect(ACTIONS.find((a) => a.name === 'vem_ar_jag')!.handler).toBe(ordinarie);
    const svar = await kor(app, agentB, 'vem_ar_jag');
    expect(svar.status).toBe(200);
    expect(svar.body.result).toEqual({ aktor_typ: 'agent', aktor_namn: 'n91 agent B' });
    expect(Object.keys(svar.body.result)).toHaveLength(2);
  });

  it('N6 (AK 1): B:s ärende och händelse bär B och nyckelns agent', async () => {
    const svar = await kor(app, agentB, 'create_issue', { title: 'N6 i B', team_key: 'TB' });
    expect(svar.status).toBe(200);
    expect(svar.body.result.identifier).toMatch(/^TB-/);
    await agare(async (c) => {
      expect((await c.query('SELECT tenant_id FROM issues WHERE id = $1', [svar.body.result.id])).rows)
        .toEqual([{ tenant_id: TENANT_B }]);
      expect((await c.query(
        'SELECT tenant_id, aktor_typ, aktor_namn FROM events WHERE issue_id = $1', [svar.body.result.id],
      )).rows).toEqual([{ tenant_id: TENANT_B, aktor_typ: 'agent', aktor_namn: 'n91 agent B' }]);
    });
    const fore = await avtryck();
    const nekad = await kor(app, agentA, 'create_issue', { title: 'N6 i B', team_key: 'TB' });
    expect(nekad.status).toBe(404);
    expect(nekad.body.error).toBe('not_found');
    expect(await avtryck()).toEqual(fore);
  });

  it('N7 (AK 1): vyskrivningen använder människans tenant och avvisar A mot B', async () => {
    const inB = await request(app).post('/vy/logga-in').type('form').send({ nyckel: manniskaB, fran: '/vy' });
    expect(inB.status).toBe(303);
    const kakaB = (inB.headers['set-cookie'] as unknown as string[]).find((s) => s.startsWith('arenden_vy='))!.split(';')[0]!;
    const vag = `/vy/arende/${bArenden[0]!.identifier}/kommentar`;
    const foreB = await avtryck();
    const svar = await request(app).post(vag).set('Cookie', kakaB).type('form').send({ body: 'N7 ur vyn' });
    expect(svar.status).toBe(303);
    const efterB = await avtryck();
    expect(efterB.comments.n).toBe(foreB.comments.n + 1);
    expect(efterB.events.n).toBe(foreB.events.n + 1);
    await agare(async (c) => {
      expect((await c.query(
        'SELECT tenant_id, aktor_typ, aktor_namn FROM comments WHERE issue_id = $1 AND body = $2',
        [bArenden[0]!.id, 'N7 ur vyn'],
      )).rows).toEqual([{ tenant_id: TENANT_B, aktor_typ: 'manniska', aktor_namn: 'n91 människa B' }]);
      expect((await c.query(
        'SELECT tenant_id, aktor_typ, aktor_namn FROM events WHERE issue_id = $1 ORDER BY id DESC LIMIT 1',
        [bArenden[0]!.id],
      )).rows).toEqual([{ tenant_id: TENANT_B, aktor_typ: 'manniska', aktor_namn: 'n91 människa B' }]);
    });
    const inA = await request(app).post('/vy/logga-in').type('form').send({ nyckel: manniskaA, fran: '/vy' });
    expect(inA.status).toBe(303);
    const kakaA = (inA.headers['set-cookie'] as unknown as string[]).find((s) => s.startsWith('arenden_vy='))!.split(';')[0]!;
    const fore = await avtryck();
    expect((await request(app).post(vag).set('Cookie', kakaA).type('form').send({ body: 'N7 ur vyn' })).status).toBe(404);
    expect(await avtryck()).toEqual(fore);
  });

  it('N12 (AK 1): båda nycklarna för en aktör i två tenanter nekas med noll rader', async () => {
    const a = await nyNyckel({ typ: 'agent', namn: 'n91 dubbel' });
    const b = await withTransaction(async (c) =>
      (await nyckeltjansten.skapaNyckel(c, TENANT_B, { typ: 'agent', namn: 'n91 dubbel' })).nyckel);
    const input = { title: 'N12 dubbel', team_key: 'LOC' };
    const fore = await avtryck();
    for (const nyckel of [a, b]) {
      const svar = await kor(app, nyckel, 'create_issue', input);
      expect(svar.status).toBe(403);
      expect(svar.body).toEqual({ error: 'aktor_i_flera_tenanter' });
      expect(await avtryck()).toEqual(fore);
    }
    expect((await kor(app, agentA, 'create_issue', input)).status).toBe(200);
    expect((await avtryck()).issues.n).toBe(fore.issues.n + 1);
  });
});

describe('FR-25/Story 9.1 AK 2: isoleringen genom nyckeln', () => {
  it('N4 (AK 2): get, list och sök visar bara nyckelns tenant utan skrivning', async () => {
    const fore = await avtryck();
    const nekad = await kor(app, agentA, 'get_issue', { identifier: bArenden[0]!.identifier });
    expect(nekad.status).toBe(404);
    expect(nekad.body.error).toBe('not_found');
    const egen = await kor(app, agentB, 'get_issue', { identifier: bArenden[0]!.identifier });
    expect(egen.status).toBe(200);
    expect(egen.body.result.arende.identifier).toBe(bArenden[0]!.identifier);
    for (const [nyckel, prefix, vantade] of [
      [agentA, 'LOC-', locIdentifier],
      [agentB, 'TB-', bArenden.map((a) => a.identifier)],
    ] as const) {
      const lista = await kor(app, nyckel, 'list_issues', { limit: 100 });
      expect(lista.status).toBe(200);
      const nummer = lista.body.result.arenden.map((a: { identifier: string }) => a.identifier);
      expect(nummer.length).toBeGreaterThanOrEqual(2);
      expect(nummer.every((id: string) => id.startsWith(prefix))).toBe(true);
      expect(nummer).toEqual(expect.arrayContaining([...vantade]));
      const sok = await kor(app, nyckel, 'search_issues', { fraga: 'tenantprovord', limit: 50 });
      expect(sok.status).toBe(200);
      expect(sok.body.result.map((a: { identifier: string }) => a.identifier).sort()).toEqual([...vantade].sort());
    }
    expect(await avtryck()).toEqual(fore);
  });

  it('N5 (AK 2): tre skrivningar mot B från A ger 404 och oförändrat avtryck', async () => {
    const identifier = bArenden[0]!.identifier;
    const fore = await avtryck();
    for (const [action, input] of [
      ['update_issue', { identifier, title: 'N5 kapad' }],
      ['update_issue_state', { identifier, state_typ: 'completed' }],
      ['add_comment', { identifier, body: 'N5 kapad' }],
    ] as const) {
      const svar = await kor(app, agentA, action, input);
      expect(svar.status).toBe(404);
      expect(svar.body.error).toBe('not_found');
      expect(await avtryck()).toEqual(fore);
    }
    expect((await kor(app, agentB, 'add_comment', { identifier, body: 'N5 kapad' })).status).toBe(200);
    const efter = await avtryck();
    expect(efter.issues.n).toBe(fore.issues.n);
    expect(efter.comments.n).toBe(fore.comments.n + 1);
    expect(efter.events.n).toBe(fore.events.n + 1);
    for (const tabell of ['issues', 'comments', 'events'] as const) {
      expect(efter[tabell].avtryck).not.toBe(fore[tabell].avtryck);
    }
  });
});

describe('FR-25/Story 9.1 AK 3: LOC-numreringen', () => {
  it('N8 (AK 3): LOC löper vidare oberoende av B:s två nästa nummer', async () => {
    const m = await agare(async (c) => Number((await c.query(
      `SELECT max(i.sequence_number) AS nummer FROM issues i JOIN teams t ON t.id = i.team_id
        WHERE i.tenant_id = $1 AND t.key = 'TB'`, [TENANT_B],
    )).rows[0].nummer));
    const forsta = await kor(app, agentA, 'create_issue', { title: 'N8 LOC före', team_key: 'LOC' });
    expect(forsta.status).toBe(200);
    const n = Number(forsta.body.result.identifier.split('-')[1]);
    for (const nummer of [m + 1, m + 2]) {
      const svar = await kor(app, agentB, 'create_issue', { title: 'N8 i B', team_key: 'TB' });
      expect(svar.status).toBe(200);
      expect(svar.body.result.identifier).toBe(`TB-${nummer}`);
    }
    const sista = await kor(app, agentA, 'create_issue', { title: 'N8 LOC efter', team_key: 'LOC' });
    expect(sista.status).toBe(200);
    expect(sista.body.result.identifier).toBe(`LOC-${n + 1}`);
  });
});

// Samma parentesräkning som skrivvägsprovet; dessa tre filer saknar kommentarmärken i strängar.
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

describe('FR-25/Story 9.1 AK 1: de slutna undantagen och den uttryckliga tenanten', () => {
  it('N9 (AK 1): uttrycklig tenant och Locollabs-grenen fungerar, krock nekas före handlern', async () => {
    const ordinarie = ACTIONS.find((a) => a.name === 'vem_ar_jag')!.handler;
    let anrop = 0;
    const fore = await avtryck();
    await medUtbytt('vem_ar_jag', async (ctx) => {
      anrop += 1;
      return {
        tenant: ctx.tenantId,
        installning: (await ctx.client.query("SELECT current_setting('app.tenant_id', true) AS tenant")).rows[0].tenant,
      };
    }, async () => {
      const params = { aktor: { typ: 'system' as const, namn: 'n9 nyckellos' }, actionName: 'vem_ar_jag', input: {} };
      expect((await executeAction({ ...params, tenantId: TENANT_B })).result)
        .toEqual({ tenant: TENANT_B, installning: TENANT_B });
      expect((await executeAction(params)).result).toEqual({ tenant: TENANT_ID, installning: TENANT_ID });
      const medNyckel = { ...params, aktor: { typ: 'agent' as const, namn: 'n91 agent B' } };
      const foreKrock = anrop;
      await expect(executeAction({ ...medNyckel, tenantId: TENANT_ID })).rejects.toThrow(/tenant/);
      expect(anrop).toBe(foreKrock);
      expect((await executeAction({ ...medNyckel, tenantId: TENANT_B })).result)
        .toEqual({ tenant: TENANT_B, installning: TENANT_B });
      expect(anrop).toBe(3);
    });
    expect(ACTIONS.find((a) => a.name === 'vem_ar_jag')!.handler).toBe(ordinarie);
    expect(await avtryck()).toEqual(fore);
  });

  it('N10 (AK 1): undantagen anger tenant och actionen förmedlar aktören oförändrad', () => {
    const las = (fil: string) => readFileSync(new URL(`../src/${fil}`, import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    const actionFel = (text: string) => argumenten(text, /\bexecuteAction\(/).filter((a) =>
      !a.includes('aktor: ATERLASAKTOR') || !a.includes('tenantId: TENANT_ID'));
    const txFel = (text: string) => argumenten(text, /\bwithTransaction\(/)
      .filter((a) => !a.endsWith(', TENANT_ID'));
    const aterlasning = las('import/aterlasLinear.ts');
    expect(argumenten(aterlasning, /\bexecuteAction\(/)).toHaveLength(1);
    expect(actionFel(aterlasning)).toEqual([]);
    expect(argumenten(aterlasning, /\bwithTransaction\(/)).toHaveLength(3);
    expect(txFel(aterlasning)).toEqual([]);
    const arkiv = las('import/importeraArkiv.ts');
    expect(argumenten(arkiv, /\bwithTransaction\(/)).toHaveLength(1);
    expect(txFel(arkiv)).toEqual([]);
    const action = las('actions/execute.ts');
    expect(action.match(/\bTENANT_ID\b/g)).toHaveLength(2);
    expect(action).not.toContain('tenantId: TENANT_ID,');
    expect(action).not.toContain('skrivHandelse(client, TENANT_ID');
    expect(action.match(/\blasNyckelnsTenant\(/g)).toHaveLength(1);
    expect(action).toContain('aktor: params.aktor,');
    expect(action).toContain('params.aktor, handelse)');
    expect(actionFel('executeAction({ aktor: ATERLASAKTOR, actionName, input })')).toHaveLength(1);
    expect(txFel('withTransaction((c) => f(c),\n  TENANT_ID,\n)')).toEqual([]);
    expect(txFel('withTransaction((c) => f(c, TENANT_ID))')).toHaveLength(1);
    // Ett tenantnamn i en kommentar får aldrig få gammal kod att klara grinden.
    expect(actionFel('executeAction({ aktor: ATERLASAKTOR, actionName, input }) // tenantId: TENANT_ID'))
      .toHaveLength(1);
  });
});
