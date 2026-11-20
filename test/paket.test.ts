/**
 * FR-25, Story 9.5: modul 2 enligt Davids svar 2026-10-16 13.21.
 * AK 1: starten, onboardingen och MCP-vägen (P1, P8, P9).
 * AK 2: valvets och CRM:s frånvaro, kortets lägen och inloggningen (P2–P5).
 * AK 3: installationsanvisningen och den slutna beroendelistan (P6–P7).
 * Riktig ingång och riktig Postgres; kopplingarna pekar på sökvägar som inte finns.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from '../src/db/tx.js';
import { hamtaEllerSkapaProjekt, type Arende, type ListaResultat } from '../src/services/arenden.js';
import { TENANT_ID } from '../src/lib/tenant.js';
import { startaGateway } from '../src/mcp/server.js';
import { seedaTeam, nyNyckel } from './helpers.js';
import * as dokumentet from '../src/http/vy/dokument.js';
import * as crm from '../src/http/vy/crm.js';
import * as kortet from '../src/http/vy/kort.js';

const ROT = fileURLToPath(new URL('../', import.meta.url));
const LYSSNAR = 'Ärende-API lyssnar på';
const KUND_CRM_EJ_ANSLUTET = 'Kunde inte läsas — CRM är inte anslutet i den här installationen.';
const VALV_PA_KORTET =
  'Kunde inte läsas — valvet är inte anslutet i den här installationen, så dokument och spegel visas inte.';
let provkatalog: string;
let hem: string;
let ingetValv: string;
let bas: string;
let barn: ChildProcess | undefined;
let loggrad: string;
let lasStderr: () => string;
let systemnyckel: string;
let kopplat: string;
let okopplat: string;

function hittaLedigPort(): Promise<number> {
  return new Promise((klar, fel) => {
    const server = createServer();
    server.once('error', fel);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => klar(port));
    });
  });
}

/** Samma ingång som i drift; hela loggraden inväntas och stderr kan läsas även efter starten. */
function startaServern(miljo: NodeJS.ProcessEnv): Promise<{
  barn: ChildProcess; rad: string; lasStderr: () => string;
}> {
  return new Promise((klar, fel) => {
    const processbarn = spawn(process.execPath, ['--import', 'tsx', path.join(ROT, 'src/server.ts')], {
      cwd: ROT,
      env: miljo,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let avgjort = false;
    const timer = setTimeout(() => avbryt('ingen loggrad på 15 sekunder'), 15_000);
    function avbryt(orsak: string): void {
      if (avgjort) return;
      avgjort = true;
      clearTimeout(timer);
      processbarn.kill('SIGKILL');
      fel(new Error(`servern startade inte (${orsak}). stderr: ${stderr}`));
    }
    processbarn.stderr?.setEncoding('utf8');
    processbarn.stderr?.on('data', (del: string) => { stderr += del; });
    processbarn.stdout?.setEncoding('utf8');
    processbarn.stdout?.on('data', (del: string) => {
      stdout += del;
      const rad = stdout.split('\n').slice(0, -1).find((r) => r.includes(LYSSNAR));
      if (rad === undefined || avgjort) return;
      avgjort = true;
      clearTimeout(timer);
      klar({ barn: processbarn, rad, lasStderr: () => stderr });
    });
    processbarn.once('exit', (kod, signal) => avbryt(`avslutades med ${kod ?? signal}`));
    processbarn.once('error', (e) => avbryt(e.name));
  });
}

/** Invänta avslutet, så att inga anslutningar finns kvar inför nästa provfil. */
async function stoppa(processbarn: ChildProcess): Promise<void> {
  if (processbarn.exitCode !== null || processbarn.signalCode !== null) return;
  const avslutad = new Promise<void>((klar) => processbarn.once('exit', () => klar()));
  processbarn.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const hann = await Promise.race([
    avslutad.then(() => true),
    new Promise<boolean>((klar) => { timer = setTimeout(() => klar(false), 10_000); }),
  ]);
  clearTimeout(timer);
  if (!hann) {
    processbarn.kill('SIGKILL');
    await avslutad;
  }
}

function hamta(adress: string, init: Parameters<typeof fetch>[1] = {}): ReturnType<typeof fetch> {
  return fetch(adress, { ...init, redirect: 'manual' });
}

/** FR-25: API-svaren binds till actionen, så att adapterns format inte kan väljas av anroparen. */
type Paketsvar = {
  list_issues: ListaResultat;
  create_issue: Pick<Arende, 'id' | 'identifier'> & { arende: Arende };
  ta_emot_tenant: { nyckelfil: string };
  set_project_customer: unknown;
};

/** Ett typat svarskuvert; inga nycklar skrivs i loggar eller förväntade svar. */
async function korServern<A extends keyof Paketsvar>(nyckel: string, action: A, input: unknown = {}): Promise<{
  status: number; kropp: { status: string; action: A; result: Paketsvar[A] };
}> {
  const svar = await hamta(`${bas}/api/actions/${action}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${nyckel}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  const kropp = await svar.json() as { status: string; action: A; result: Paketsvar[A] };
  expect(kropp.status).toBe('ok');
  expect(kropp.action).toBe(action);
  return { status: svar.status, kropp };
}

function utanKrom(text: string): string {
  const i = text.indexOf('</header>');
  return i === -1 ? text : text.slice(i + '</header>'.length);
}

beforeAll(async () => {
  provkatalog = mkdtempSync(path.join(tmpdir(), 'paket-prov-'));
  hem = path.join(provkatalog, 'hem');
  mkdirSync(hem);
  ingetValv = path.join(provkatalog, 'inget-valv');
  await seedaTeam();
  const agentnyckel = await nyNyckel({ typ: 'agent', namn: 'p95 agent' });
  systemnyckel = await nyNyckel({ typ: 'system', namn: 'p95 operatör' });
  await withTransaction((c) => hamtaEllerSkapaProjekt(c, TENANT_ID, 'P95 Kund'), TENANT_ID);
  const port = await hittaLedigPort();
  const miljo: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: path.join(provkatalog, 'ingen-miljofil'),
    PORT: String(port),
    VAULT_PATH: ingetValv,
    CRM_KONF_PATH: path.join(provkatalog, 'ingen-crm.json'),
    VY_PUBLIK_URL: 'https://kund-prov.invalid',
    HOME: hem,
  };
  delete miljo.PGOPTIONS;
  const startad = await startaServern(miljo);
  barn = startad.barn;
  loggrad = startad.rad;
  lasStderr = startad.lasStderr;
  bas = `http://127.0.0.1:${port}`;
  const koppling = await korServern(agentnyckel, 'set_project_customer', {
    projekt: 'P95 Kund', status: 'kopplad', kund_id: randomUUID(), kund_kalla: 'redovisning',
  });
  expect(koppling.status).toBe(200);
  const a = await korServern(agentnyckel, 'create_issue', {
    title: 'P95 kopplat', team_key: 'LOC', projekt: 'P95 Kund',
  });
  expect(a.status).toBe(200);
  kopplat = a.kropp.result.identifier;
  const b = await korServern(agentnyckel, 'create_issue', {
    title: 'P95 okopplat', team_key: 'LOC', description: 'Planen står i 01-Projekt/p95/plan.md.',
  });
  expect(b.status).toBe(200);
  okopplat = b.kropp.result.identifier;
});

afterAll(async () => {
  try {
    if (barn) await stoppa(barn);
  } finally {
    if (provkatalog) rmSync(provkatalog, { recursive: true, force: true });
  }
});

describe('FR-25/Story 9.5 AK 1: installationen startar utan Davids system', () => {
  it('P1 (AK 1): den riktiga ingången startar utan valv och CRM', async () => {
    expect(loggrad).toContain(LYSSNAR);
    expect((await hamta(`${bas}/health`)).status).toBe(200);
    const vy = await hamta(`${bas}/vy`);
    expect(vy.status).toBe(200);
    expect(vy.headers.get('content-type')).toContain('text/html');
    await vy.text();
    expect(lasStderr()).not.toContain('FATAL');
  });

  it('P8 (AK 1): onboardingen ger kunden sitt första ärende och en egen lista', async () => {
    const mottagen = await korServern(systemnyckel, 'ta_emot_tenant', {
      namn: 'P95 Kund AB', team_key: 'PKUND', team_namn: 'P95 Kund', forsta_manniska: 'p95 manniska',
      beslut: 'Davids ja för P95 Kund AB (provet för Story 9.5)',
    });
    expect(mottagen.status).toBe(200);
    expect(mottagen.kropp.result.nyckelfil.startsWith(path.join(hem, '.arenden') + path.sep)).toBe(true);
    const manniska = readFileSync(mottagen.kropp.result.nyckelfil, 'utf8').trimEnd();
    // FR-25: samma listkontrakt gäller före första ärendet, för flera ärenden och för varje sida.
    const tom = await korServern(manniska, 'list_issues');
    expect(tom.status).toBe(200);
    expect(tom.kropp.result.arenden).toEqual([]);
    expect(tom.kropp.result.pageInfo).toEqual({ har_nasta: false, slut_cursor: null });
    const skapat = await korServern(manniska, 'create_issue', {
      title: 'P95 kundens första', team_key: 'PKUND',
    });
    expect(skapat.status).toBe(200);
    expect(skapat.kropp.result.identifier).toBe('PKUND-1');
    const lista = await korServern(manniska, 'list_issues');
    expect(lista.status).toBe(200);
    expect(lista.kropp.result.arenden.map((a) => a.identifier)).toEqual(['PKUND-1']);
    expect(lista.kropp.result.pageInfo.har_nasta).toBe(false);

    const andra = await korServern(manniska, 'create_issue', {
      title: 'P95 kundens andra', team_key: 'PKUND',
    });
    expect(andra.status).toBe(200);
    expect(andra.kropp.result.identifier).toBe('PKUND-2');
    for (const input of [{}, { team_key: 'PKUND' }]) {
      const flera = await korServern(manniska, 'list_issues', input);
      expect(flera.status).toBe(200);
      expect(flera.kropp.result.arenden.map((a) => a.identifier)).toEqual(['PKUND-2', 'PKUND-1']);
      expect(flera.kropp.result.pageInfo.har_nasta).toBe(false);
    }
    const frammande = await korServern(
      manniska, 'list_issues', { team_key: 'LOC' },
    );
    expect(frammande.status).toBe(200);
    expect(frammande.kropp.result.arenden).toEqual([]);
    expect(frammande.kropp.result.pageInfo).toEqual({ har_nasta: false, slut_cursor: null });
    const forstaSidan = await korServern(manniska, 'list_issues', { limit: 1 });
    expect(forstaSidan.status).toBe(200);
    expect(forstaSidan.kropp.result.arenden.map((a) => a.identifier)).toEqual(['PKUND-2']);
    expect(forstaSidan.kropp.result.pageInfo.har_nasta).toBe(true);
    expect(forstaSidan.kropp.result.pageInfo.slut_cursor).toEqual(expect.any(String));
    const sistaSidan = await korServern(manniska, 'list_issues', {
      limit: 1, cursor: forstaSidan.kropp.result.pageInfo.slut_cursor,
    });
    expect(sistaSidan.status).toBe(200);
    expect(sistaSidan.kropp.result.arenden.map((a) => a.identifier)).toEqual(['PKUND-1']);
    expect(sistaSidan.kropp.result.pageInfo.har_nasta).toBe(false);
  });

  it('P9 (AK 1): MCP-gatewayen lyssnar på loopback och kräver auktorisering', async () => {
    const klientfil = path.join(provkatalog, 'arenden-mcp-klient.json');
    writeFileSync(klientfil, JSON.stringify({
      client_id: 'claude-prov', client_secret: `prov-hemlighet-${'x'.repeat(25)}`,
      utgivare: 'https://prov.example',
    }));
    chmodSync(klientfil, 0o600);
    const gateway = await startaGateway(0, klientfil);
    try {
      const adress = gateway.address() as AddressInfo;
      expect(adress.address).toBe('127.0.0.1');
      const svar = await hamta(`http://127.0.0.1:${adress.port}/mcp`, { method: 'POST' });
      expect(svar.status).toBe(401);
      await svar.text();
    } finally {
      await new Promise<void>((klar, fel) => gateway.close((e) => e ? fel(e) : klar()));
    }
  });
});

describe('FR-25/Story 9.5 AK 2: dokumentsidan säger att valvet saknas', () => {
  it('P2 (AK 2): valvet prövas och bara vitlistade sökvägar får beskedet', async () => {
    const svar = await hamta(`${bas}/vy/dok/01-Projekt/p95/plan.md`);
    expect(svar.status).toBe(404);
    expect(svar.headers.get('content-type')).toContain('text/html');
    const text = await svar.text();
    expect(text).toContain(dokumentet.VALV_SAKNAS);
    expect(text).toContain('Dokumentet kan inte visas');
    expect(text).not.toContain('utanför vyns dokumentområde');
    expect(utanKrom(text)).not.toContain('CRM');
    const utanfor = await hamta(`${bas}/vy/dok/journal/p95.md`);
    expect(utanfor.status).toBe(404);
    const utanforText = await utanfor.text();
    expect(utanforText).toContain('Hittades inte');
    expect(utanforText).toContain('utanför vyns dokumentområde');
    expect(utanforText).not.toContain(dokumentet.VALV_SAKNAS);
    const vanligFil = path.join(provkatalog, 'vanlig-fil.txt');
    writeFileSync(vanligFil, 'En vanlig fil.');
    expect(await dokumentet.valvetArAnslutet(provkatalog)).toBe(true);
    expect(await dokumentet.valvetArAnslutet(ingetValv)).toBe(false);
    expect(await dokumentet.valvetArAnslutet(vanligFil)).toBe(false);
  });
});

describe('FR-25/Story 9.5 AK 2: ärendesidan säger vilka kopplingar som saknas', () => {
  it('P3 (AK 2): kopplat och okopplat ärende visar valvläget och rätt CRM-besked', async () => {
    const kopplad = await hamta(`${bas}/vy/arende/${kopplat}`);
    expect(kopplad.status).toBe(200);
    expect(kopplad.headers.get('content-type')).toContain('text/html');
    const koppladText = await kopplad.text();
    expect(koppladText).toContain('P95 kopplat');
    expect(koppladText).toContain(crm.CRM_EJ_ANSLUTET);
    expect(koppladText).toContain(KUND_CRM_EJ_ANSLUTET);
    expect(koppladText).toContain(VALV_PA_KORTET);
    expect(koppladText).not.toContain('ej tillgänglig just nu');
    expect(koppladText).not.toContain('ej tillgänglig.');
    expect(koppladText).not.toContain('har inte skrivit');

    const okopplad = await hamta(`${bas}/vy/arende/${okopplat}`);
    expect(okopplad.status).toBe(200);
    expect(okopplad.headers.get('content-type')).toContain('text/html');
    const okoppladText = await okopplad.text();
    expect(okoppladText).toContain('P95 okopplat');
    expect(okoppladText).toContain(VALV_PA_KORTET);
    expect(okoppladText).toContain('href="/vy/dok/01-Projekt/p95/plan.md"');
    expect(okoppladText).not.toContain(crm.CRM_EJ_ANSLUTET);
    expect(okoppladText).not.toContain(KUND_CRM_EJ_ANSLUTET);
  });

  it('P5 (AK 2): inloggningen behöver inga kopplingar och alla sidor svarar utan serverfel', async () => {
    const svar = await hamta(`${bas}/vy/logga-in`);
    expect(svar.status).toBe(200);
    expect(svar.headers.get('content-type')).toContain('text/html');
    const text = await svar.text();
    expect(text).toContain('<h1>Logga in</h1>');
    expect(text).toContain('action="/vy/logga-in"');
    for (const mening of [
      dokumentet.VALV_SAKNAS,
      'CRM är inte anslutet i den här installationen.',
      KUND_CRM_EJ_ANSLUTET,
      VALV_PA_KORTET,
    ]) expect(text).not.toContain(mening);
    expect(text).not.toContain('ej tillgänglig');
    expect(svar.status).toBeLessThan(500);
    for (const adress of [
      '/vy/dok/01-Projekt/p95/plan.md', `/vy/arende/${kopplat}`, `/vy/arende/${okopplat}`,
    ]) {
      const sida = await hamta(`${bas}${adress}`);
      expect(sida.status).toBeLessThan(500);
      expect(sida.headers.get('content-type')).toContain('text/html');
      await sida.text();
    }
  });
});

describe('FR-25/Story 9.5 AK 2: prövningarna och kortets lägen', () => {
  it('P4 (AK 2): läsrätt och kortets nya lägen bevarar befintliga utfall', async () => {
    const lasbar = path.join(provkatalog, 'lasbar-konfiguration.json');
    writeFileSync(lasbar, '{}');
    expect(await crm.crmKonfigurationFinns(lasbar)).toBe(true);
    expect(await crm.crmKonfigurationFinns(path.join(provkatalog, 'ingen-crm.json'))).toBe(false);
    const koppling = {
      projekt_id: randomUUID(), projekt: 'P95 Kund', kund_id: randomUUID(), kund_kalla: 'redovisning',
      koppling_status: 'kopplad' as const, kund_kopplad_at: null,
    };
    expect(kortet.kundLage(koppling, 'ej_anslutet')).toMatchObject({
      lage: 'kunde_inte', text: KUND_CRM_EJ_ANSLUTET,
    });
    expect(kortet.kundLage(koppling, 'svarade_inte')).toMatchObject({
      lage: 'kunde_inte', text: 'Kunde inte läsas just nu — CRM-data ej tillgänglig.',
    });
    const arende = { identifier: 'LOC-1', description: '' };
    const index = { filnamn: new Map<string, readonly string[]>() };
    const lage = kortet.dokumentLage(arende, [], [], [], index, 'saknas');
    expect(lage).toMatchObject({ lage: 'kunde_inte', text: VALV_PA_KORTET });
    expect('delvis' in lage && lage.delvis).toContain('Bilagor (0)');
    expect(kortet.dokumentLage(arende, [], [], [], index, 'ansluten'))
      .toEqual(kortet.dokumentLage(arende, [], [], [], index));
    expect(crm.crmKortEjAnslutet()).toContain('<h2>CRM</h2>');
    expect(crm.crmKortEjAnslutet()).toContain(crm.CRM_EJ_ANSLUTET);
  });
});

describe('FR-25/Story 9.5 AK 3: installationsanvisningen och omfattningen', () => {
  it('P6 (AK 3): anvisningen innehåller stegen i ordning och avgränsar paketet', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    const rubrik = '## Modul 2 — installera ärendeplattformen för en ny kund (Story 9.5)';
    expect(readme.split('\n').filter((rad) => rad === rubrik)).toHaveLength(1);
    const efterRubrik = readme.slice(readme.indexOf(rubrik) + rubrik.length);
    const slut = efterRubrik.search(/^## /m);
    const avsnitt = slut === -1 ? efterRubrik : efterRubrik.slice(0, slut);
    const rader = avsnitt.split('\n');
    const steg = rader.filter((rad) => /^\d+\. /.test(rad));
    expect(steg.length).toBeGreaterThanOrEqual(7);
    let fore = -1;
    for (const kommando of [
      'npm ci', 'VY_PUBLIK_URL', 'npm run migrate', 'npm start', 'ta_emot_tenant', 'npm run check',
    ]) {
      const plats = steg.findIndex((rad) => rad.includes(kommando));
      expect(plats).toBeGreaterThan(fore);
      fore = plats;
    }
    expect(steg.some((rad) => rad.includes('npm run mcp'))).toBe(true);
    for (const rad of steg) {
      expect(rad).not.toMatch(/npm run import|npm run aterlas|[Ss]pegeln|[Nn]attproven/);
    }
    for (const namn of ['Linear-importen', 'Spegeln', 'Nattproven']) {
      const poster = rader.filter((rad) => rad.startsWith(`- ${namn}`));
      expect(poster).toHaveLength(1);
      expect(poster[0]).toContain('ingår inte');
    }
    for (const innehall of ['VAULT_PATH', 'CRM_KONF_PATH', dokumentet.VALV_SAKNAS, crm.CRM_EJ_ANSLUTET]) {
      expect(avsnitt).toContain(innehall);
    }
    expect(rader.some((rad) => rad.startsWith('| Modul 2 (FR-25) |')
      && rad.includes('test/paket.test.ts'))).toBe(true);
    for (const del of ['/api', '/vy', 'ta_emot_tenant', 'MCP']) expect(avsnitt).toContain(del);
    for (const underrubrik of [
      '### Installationsstegen (modul 2)', '### Valfria kopplingar (modul 2)', '### Ingår inte i modul 2',
    ]) expect(rader.filter((rad) => rad === underrubrik)).toHaveLength(1);
  });

  it('P7 (AK 3): paketet har exakt de befintliga npm-beroendena', () => {
    const paket = JSON.parse(readFileSync(path.join(ROT, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>; devDependencies: Record<string, string>;
    };
    expect(Object.keys(paket.dependencies).sort())
      .toEqual(['dotenv', 'express', 'express-rate-limit', 'helmet', 'pg', 'zod']);
    expect(Object.keys(paket.devDependencies).sort()).toEqual([
      '@types/express', '@types/node', '@types/pg', '@types/supertest',
      'supertest', 'tsx', 'typescript', 'vitest',
    ]);
  });
});
