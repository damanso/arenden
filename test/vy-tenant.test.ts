/**
 * FR-25, B-27, Story 9.3: läsvyn håller tenantgränsen.
 * AK 1: tenantval (VT1), Locollabs regression (VT2), listor (VT3), ärendesida (VT4).
 * AK 2: rättelser och dokument (VT5), varje sida utan skrivning (VT6), enda vägen (VT7).
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import request from 'supertest';
import type { Request } from 'express';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { hamtaEllerSkapaTeam } from '../src/services/team.js';
import { arendeSokvag } from '../src/lib/arendelank.js';
import { skapaNyckel } from '../src/services/nycklar.js';
import { TENANT_ID } from '../src/lib/tenant.js';
import { seedaTeam, nyNyckel, kor } from './helpers.js';
import * as provmiljon from './env.js';
import * as sessionsmodulen from '../src/http/vy/session.js';
import { nollstallIndex } from '../src/http/vy/dokument.js';
import { TEST_VAULT } from './env.js';

// Filen prövar tenantgränsen som i drift, utan anslutningens provval (Story 9.2).
provmiljon.utanProvetsTenant();

const TENANT_B = '00000000-0000-0000-0000-000000000093';
let app: ReturnType<typeof createApp>;
let kakaA: string;
let kakaB: string;
let kakaDubbel: string;
type Fixturarende = { identifier: string; title: string };
let arendeA: Fixturarende;
let arendeB: Fixturarende;

async function agare<T>(fn: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  try {
    await c.connect();
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function loggaIn(nyckel: string): Promise<string> {
  const svar = await request(app).post('/vy/logga-in').type('form').send({ nyckel, fran: '/vy' });
  expect(svar.status).toBe(303);
  const kaka = (svar.headers['set-cookie'] as unknown as string[])
    .find((s) => s.startsWith('arenden_vy='))?.split(';')[0];
  expect(kaka).toBeTruthy();
  return kaka!;
}

function hamta(sokvag: string, kaka?: string) {
  const anrop = request(app).get(sokvag);
  return kaka === undefined ? anrop : anrop.set('Cookie', kaka);
}

function begaran(kaka?: string): Request {
  return { headers: kaka === undefined ? {} : { cookie: kaka } } as Request;
}

// Samma mätning används av sidproven och deras kontroller. Hela nummer räknas.
function harAndrasTexter(text: string, andra: Fixturarende, ord: string, nummer = true): boolean {
  return text.includes(ord) || text.includes(`href="${arendeSokvag(andra.identifier)}"`) ||
    (nummer && new RegExp(`\\b${andra.identifier}\\b`).test(text));
}

type Tabelltillstand = { n: number; avtryck: string };
const TABELLER = ['issues', 'comments', 'events', 'api_keys', 'labels'] as const;
async function avtryck(): Promise<Record<typeof TABELLER[number], Tabelltillstand>> {
  return agare(async (c) => {
    const ut = {} as Record<typeof TABELLER[number], Tabelltillstand>;
    for (const tabell of TABELLER) {
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

// Råtexten behålls: kommentarerna räknas också av VT7.
function argumenten(text: string, monster: RegExp): string[] {
  const ut: string[] = [];
  for (const m of text.matchAll(new RegExp(monster.source, 'g'))) {
    const start = m.index! + m[0].length;
    let djup = 0;
    let j = start;
    for (; j < text.length; j += 1) {
      if (text[j] === '(') djup += 1;
      else if (text[j] === ')' && djup-- === 0) break;
    }
    ut.push(text.slice(start, j).replace(/\s+/g, ' ').trim().replace(/,\s*$/, ''));
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

function transaktionsfel(text: string): string[] {
  return argumenten(text, /\bwithTransaction\s*\(/).filter((args) => {
    const lista = argumentlista(args);
    return lista.length !== 2 || lista[1] !== 'tenant';
  });
}

function lasrutter(text: string, router: string): { namn: string; kropp: string }[] {
  const starter = [...text.matchAll(new RegExp(`\\b${router}\\.(get|post|use)\\s*\\(`, 'g'))];
  return starter.flatMap((m, i) => {
    if (m[1] !== 'get') return [];
    const kropp = text.slice(m.index, starter[i + 1]?.index ?? text.length);
    if (!/\bwithTransaction\s*\(/.test(kropp)) return [];
    const namn = kropp.match(/\.get\(\s*'([^']+)'/)?.[1];
    return [{ namn: namn!, kropp }];
  });
}

function ruttfel(text: string, router: string): string[] {
  return lasrutter(text, router)
    .filter(({ kropp }) => !/\bvynsTenant\s*\(\s*req\s*\)/.test(kropp))
    .map(({ namn }) => namn);
}

beforeAll(async () => {
  await seedaTeam();
  await agare((c) => c.query("INSERT INTO tenants (id, namn) VALUES ($1, 'Tenant B (Story 9.3)')", [TENANT_B]));
  await withTransaction((c) => hamtaEllerSkapaTeam(c, TENANT_B, 'TB', 'Tenant B'), TENANT_B);
  const agentA = await nyNyckel({ typ: 'agent', namn: 'v93a agent' });
  const manniskaA = await nyNyckel({ typ: 'manniska', namn: 'v93a manniska' });
  const agentB = await withTransaction(async (c) =>
    (await skapaNyckel(c, TENANT_B, { typ: 'agent', namn: 'v93b agent' })).nyckel, TENANT_B);
  const manniskaB = await withTransaction(async (c) =>
    (await skapaNyckel(c, TENANT_B, { typ: 'manniska', namn: 'v93b manniska' })).nyckel, TENANT_B);
  const dubbel = await nyNyckel({ typ: 'manniska', namn: 'v93 dubbel' });
  await withTransaction((c) => skapaNyckel(c, TENANT_B, { typ: 'manniska', namn: 'v93 dubbel' }), TENANT_B);
  app = createApp();

  // Kuvertet bär numret direkt och titeln i arende (Story 9.2:s granskningsfynd).
  const a = await kor(app, agentA, 'create_issue', {
    title: 'v93a arende tenantvyord', team_key: 'LOC', labels: ['v93a-etikett'],
  });
  expect(a.status).toBe(200);
  expect(a.body.result.identifier).toMatch(/^LOC-\d+$/);
  expect(a.body.result.arende.title).toBe('v93a arende tenantvyord');
  arendeA = { identifier: a.body.result.identifier, title: a.body.result.arende.title };
  expect((await kor(app, agentA, 'add_comment', {
    identifier: arendeA.identifier, body: 'v93a kommentar tenantvyord',
  })).status).toBe(200);
  const b = await kor(app, agentB, 'create_issue', {
    title: 'v93b arende tenantvyord', team_key: 'TB', labels: ['v93b-etikett'],
  });
  expect(b.status).toBe(200);
  expect(b.body.result.identifier).toMatch(/^TB-\d+$/);
  expect(b.body.result.arende.title).toBe('v93b arende tenantvyord');
  arendeB = { identifier: b.body.result.identifier, title: b.body.result.arende.title };
  expect((await kor(app, agentB, 'add_comment', {
    identifier: arendeB.identifier, body: 'v93b kommentar tenantvyord',
  })).status).toBe(200);
  kakaA = await loggaIn(manniskaA);
  kakaB = await loggaIn(manniskaB);
  kakaDubbel = await loggaIn(dubbel);
});

const DOKKATALOG = path.join(TEST_VAULT, '01-Projekt', 'v93-tenantvy');
const DOKADRESS = '/vy/dok/01-Projekt/v93-tenantvy/dokument.md';
beforeAll(async () => {
  await mkdir(DOKKATALOG, { recursive: true });
  await writeFile(path.join(DOKKATALOG, 'dokument.md'),
    `# Tenantgränsen\n\nReferenser till ${arendeA.identifier} och ${arendeB.identifier}.\n`, 'utf8');
  nollstallIndex();
});

afterAll(async () => {
  await rm(DOKKATALOG, { recursive: true, force: true });
  nollstallIndex();
});

describe('FR-25/Story 9.3 AK 1: läsvyn per tenant', () => {
  it('VT1 (AK 1): tenantvalet följer sessionens aktör och nekar flera tenanter', async () => {
    const original = pool.query;
    let antal = 0;
    pool.query = function (...args: Parameters<typeof pool.query>) {
      antal += 1;
      return original.apply(pool, args);
    } as typeof pool.query;
    try {
      expect(await sessionsmodulen.vynsTenant(begaran())).toBe(TENANT_ID);
      expect(await sessionsmodulen.vynsTenant(begaran('arenden_vy=okand'))).toBe(TENANT_ID);
      expect(antal).toBe(0);
      expect(await sessionsmodulen.vynsTenant(begaran(kakaB))).toBe(TENANT_B);
      expect(antal).toBeGreaterThanOrEqual(1);
      expect(await sessionsmodulen.vynsTenant(begaran(kakaA))).toBe(TENANT_ID);
      const utan = sessionsmodulen.startaSession({ typ: 'manniska', namn: 'v93 utan nyckel' });
      expect(await sessionsmodulen.vynsTenant(begaran(`arenden_vy=${utan}`))).toBe(TENANT_ID);
      await expect(sessionsmodulen.vynsTenant(begaran(kakaDubbel)))
        .rejects.toMatchObject({ status: 403, code: 'aktor_i_flera_tenanter' });
    } finally {
      pool.query = original;
    }
  });

  it('VT2 (AK 1 och AK 2, R): utan session visas Locollabs rader och mätningen slår ut', async () => {
    for (const vag of ['/vy', '/vy/sok?q=tenantvyord', arendeSokvag(arendeA.identifier)]) {
      const svar = await hamta(vag);
      expect(svar.status).toBe(200);
      expect(svar.text).toContain(arendeA.title);
      expect(harAndrasTexter(svar.text, arendeB, 'v93b')).toBe(false);
    }
    const mitt = await hamta('/vy/mitt');
    expect(mitt.status).toBe(200);
    expect(mitt.text).toContain('v93a agent');
    expect(harAndrasTexter(mitt.text, arendeB, 'v93b')).toBe(false);
    const annan = await hamta(arendeSokvag(arendeB.identifier));
    expect(annan.status).toBe(404);
    expect(annan.text).toContain('Hittades inte');
    expect(harAndrasTexter(annan.text, arendeB, 'v93b', false)).toBe(false);
    expect(harAndrasTexter(arendeB.title, arendeB, 'v93b')).toBe(true);
    const saknas = await hamta('/vy/finns-inte');
    expect(saknas.status).toBe(404);
    expect(saknas.text.includes(arendeA.title)).toBe(false);
  });
});

describe('FR-25/Story 9.3 AK 1: listsidorna i sessionens tenant', () => {
  it('VT3 (AK 1): listor, nummeruppslag och fasetter visar bara den egna tenanten', async () => {
    for (const [kaka, eget, andra, ord, annatOrd] of [
      [kakaB, arendeB, arendeA, 'v93b', 'v93a'],
      [kakaA, arendeA, arendeB, 'v93a', 'v93b'],
    ] as const) {
      for (const vag of [
        '/vy', '/vy/digest?dagar=alla', '/vy/sok?q=tenantvyord',
        `/vy/sok?aktor=${encodeURIComponent(`${ord} agent`)}`,
        `/vy/sok?etikett=${ord}-etikett`,
      ]) {
        const svar = await hamta(vag, kaka);
        expect(svar.status, vag).toBe(200);
        expect(svar.text, vag).toContain(eget.title);
        expect(harAndrasTexter(svar.text, andra, annatOrd), vag).toBe(false);
      }
      const mitt = await hamta('/vy/mitt', kaka);
      expect(mitt.status).toBe(200);
      expect(mitt.text).toContain(`${ord} agent`);
      expect(harAndrasTexter(mitt.text, andra, annatOrd)).toBe(false);
      const nummer = await hamta(`/vy/sok?q=${eget.identifier}`, kaka);
      expect(nummer.status).toBe(303);
      expect(nummer.headers.location).toBe(arendeSokvag(eget.identifier));
      const frammande = await hamta(`/vy/sok?q=${andra.identifier}`, kaka);
      expect(frammande.status).toBe(200);
      expect(frammande.text).toContain('Inget ärende har numret');
      expect(harAndrasTexter(frammande.text, andra, annatOrd, false)).toBe(false);
    }
    const nekad = await hamta('/vy', kakaDubbel);
    expect(nekad.status).toBe(403);
    expect(nekad.body).toEqual({ error: 'aktor_i_flera_tenanter' });
    expect(nekad.text).not.toMatch(/v93a|v93b/);
  });
});

describe('FR-25/Story 9.3 AK 1: ärendesidan i sessionens tenant', () => {
  it('VT4 (AK 1): eget ärende visar titel och kommentar, andras ger HTML 404', async () => {
    for (const [kaka, eget, andra, ord, annatOrd] of [
      [kakaB, arendeB, arendeA, 'v93b', 'v93a'],
      [kakaA, arendeA, arendeB, 'v93a', 'v93b'],
      [undefined, arendeA, arendeB, 'v93a', 'v93b'],
    ] as const) {
      const svar = await hamta(arendeSokvag(eget.identifier), kaka);
      expect(svar.status).toBe(200);
      expect(svar.text).toContain(eget.title);
      expect(svar.text).toContain(`${ord} kommentar tenantvyord`);
      expect(harAndrasTexter(svar.text, andra, annatOrd)).toBe(false);
      const frammande = await hamta(arendeSokvag(andra.identifier), kaka);
      expect(frammande.status).toBe(404);
      expect(frammande.headers['content-type']).toContain('text/html');
      expect(frammande.text).toContain('Hittades inte');
      expect(harAndrasTexter(frammande.text, andra, annatOrd, false)).toBe(false);
    }
  });
});

describe('FR-25/Story 9.3 AK 2: negativ kontroll över varje sida', () => {
  it('VT5 (AK 2): rättelsernas identiteter och dokumentets länkar följer tenanten', async () => {
    for (const [kaka, eget, andra, ord, annatOrd] of [
      [kakaB, arendeB, arendeA, 'v93b', 'v93a'],
      [kakaA, arendeA, arendeB, 'v93a', 'v93b'],
      [undefined, arendeA, arendeB, 'v93a', 'v93b'],
    ] as const) {
      const rattelser = await hamta('/vy/rattelser', kaka);
      expect(rattelser.status).toBe(200);
      for (const text of [`${ord}-etikett`, `${ord} agent`, `${ord} manniska`]) {
        expect(rattelser.text).toContain(text);
      }
      expect(harAndrasTexter(rattelser.text, andra, annatOrd)).toBe(false);
      const dokument = await hamta(DOKADRESS, kaka);
      expect(dokument.status).toBe(200);
      expect(dokument.text).toContain(`href="${arendeSokvag(eget.identifier)}"`);
      expect(harAndrasTexter(dokument.text, andra, annatOrd, false)).toBe(false);
      // Okända team ger ren text, inte heller en länk till nummeruppslaget.
      expect(dokument.text).toContain(andra.identifier);
      expect(dokument.text).not.toContain(`href="/vy/sok?q=${andra.identifier}"`);
    }
  });

  it('VT6 (AK 2): varje GET håller gränsen och lämnar fem tabellers avtryck orörda', async () => {
    const fore = await avtryck();
    for (const [kaka, eget, andra, ord, annatOrd] of [
      [kakaB, arendeB, arendeA, 'v93b', 'v93a'],
      [kakaA, arendeA, arendeB, 'v93a', 'v93b'],
      [undefined, arendeA, arendeB, 'v93a', 'v93b'],
    ] as const) {
      const sidor: [string, boolean, number][] = [
        ['/vy', true, 200], ['/vy/digest?dagar=alla', true, 200], ['/vy/mitt', true, 200],
        ['/vy/sok?q=tenantvyord', true, 200], [`/vy/sok?q=${eget.identifier}`, true, 303],
        [`/vy/sok?q=${andra.identifier}`, false, 200],
        [arendeSokvag(eget.identifier), true, 200], [arendeSokvag(andra.identifier), false, 404],
        [DOKADRESS, false, 200], ['/vy/rattelser', true, 200],
        ['/vy/logga-in', true, 200], ['/vy/finns-inte', true, 404],
      ];
      for (const [vag, kontrolleraNummer, status] of sidor) {
        const svar = await hamta(vag, kaka);
        expect(svar.status, vag).toBe(status);
        expect(harAndrasTexter(svar.text, andra, annatOrd, kontrolleraNummer), vag).toBe(false);
        if (vag === '/vy') expect(svar.text).toContain(ord);
      }
    }
    expect(await avtryck()).toEqual(fore);
    // Kontrollen står sist och visar att samma mätning märker en egen skrivning.
    await agare((c) => c.query("INSERT INTO labels (tenant_id, namn) VALUES ($1, 'v93 kontroll')", [TENANT_ID]));
    const efter = await avtryck();
    expect(efter).not.toEqual(fore);
    expect(efter.labels.n).toBe(fore.labels.n + 1);
    expect(efter.labels.avtryck).not.toBe(fore.labels.avtryck);
  });

  it('VT7 (AK 2): varje databasläsande GET använder vyns enda tenantkälla', () => {
    const rot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const http = path.join(rot, 'src', 'http');
    const medKonstant = (readdirSync(http, { recursive: true }) as string[])
      .filter((fil) => fil.endsWith('.ts') && /\bTENANT_ID\b/.test(readFileSync(path.join(http, fil), 'utf8')))
      .sort();
    expect(medKonstant).toEqual(['vy/session.ts']);
    const vy = readFileSync(path.join(http, 'routes', 'vy.ts'), 'utf8');
    const skrivning = readFileSync(path.join(http, 'vy', 'skrivning.ts'), 'utf8');
    expect(argumenten(vy, /\bwithTransaction\s*\(/)).toHaveLength(7);
    expect(argumenten(skrivning, /\bwithTransaction\s*\(/)).toHaveLength(1);
    expect(transaktionsfel(vy)).toEqual([]);
    expect(transaktionsfel(skrivning)).toEqual([]);
    expect(lasrutter(vy, 'vyRouter').map(({ namn }) => namn))
      .toEqual(['/', '/digest', '/mitt', '/sok', '/arende/:identifier', '/dok/*sokvag']);
    expect(lasrutter(skrivning, 'router').map(({ namn }) => namn)).toEqual(['/rattelser']);
    expect(ruttfel(vy, 'vyRouter')).toEqual([]);
    expect(ruttfel(skrivning, 'router')).toEqual([]);
    expect(transaktionsfel('withTransaction((c) => f(c, TENANT_ID), TENANT_ID)')).toHaveLength(1);
    expect(transaktionsfel('withTransaction((c) => f(c, tenant), tenant)')).toEqual([]);
    const kontroll = "vyRouter.get('/', async (req, res) => { await withTransaction((c) => f(c), tenant); });";
    expect(ruttfel(kontroll, 'vyRouter')).toEqual(['/']);
    expect(ruttfel(kontroll.replace('await withTransaction',
      'const tenant = await vynsTenant(req); await withTransaction'), 'vyRouter')).toEqual([]);
  });
});
