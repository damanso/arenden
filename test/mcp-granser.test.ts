// FR-39 (KRAV-10f) och FR-24 (d), B-19 punkt 1, Story 4.4: fjärr-MCP nås utan Macen och gränserna står kvar.
//
// Kriterierna, som granskaren kan läsa av här:
//   AK 1  appens enda listen tar config.HOST, med standardvärdena 127.0.0.1 och porten 3002 (G1); appens
//         riktiga ingång svarar på 127.0.0.1 och nekas på 127.0.0.2, och en kontroll visar att mätpunkten
//         skiljer adresserna åt (G2); /vy svarar utan nyckel, och skrivande /api utan giltig nyckel ger 401 och
//         skriver ingenting (G3); genom gatewayens egen port ger sju vägar utanför dess lista 404 (G4), och
//         /mcp, de tre metadatavägarna, /authorize och /token svarar (G5);
//   AK 2  README-avsnittet för 4.4 bär funnelns tre kommandon, kopplingen i Claude, klientfilen, stängningen
//         och regeln, med förkontrollen före påslagningen och en åtgärd för varje kontroll som avviker (G6);
//         4.2:s och 4.3:s avsnitt och raden under Vad som finns står där, i ordning, och 4.3:s avsnitt säger
//         vad som gäller i stället för de påståenden i 4.2:s som 4.3 gjorde inaktuella, också för varje
//         import ur Node som koden under src/mcp/ har (G7).
//
// TRE invarianter för provet själv: ingen server i filen binder alla adresser, eftersom sviten körs på
// driftens värd (docs/project-context.md rad 140); inget anrop når appen i drift: appen lyssnar på en
// ledig port och aldrig på 3002, och gatewayen får bara begäranden som besvaras innan den anropar API:t
// (Dev Notes → Driften rörs aldrig); och varje HTTP-anrop går genom hamta(), som aldrig följer en
// omdirigering, så att varje fall mäter svaret på själva vägen (G3:s kontroll). Ingen vi.mock: appen är
// src/server.ts framför testdatabasen.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as skapaHttpServer } from 'node:http';
import type { Server } from 'node:http';
import { connect, createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EnvSchema } from '../src/config.js';
import { startaGateway } from '../src/mcp/server.js';
import { raknaRader, seedaTeam } from './helpers.js';

const ROT = fileURLToPath(new URL('..', import.meta.url));

/** Raden som src/server.ts skriver på stdout när servern lyssnar. */
const LYSSNAR = 'Ärende-API lyssnar på';

/**
 * Barnprocessens miljö: en kopia av provets miljö, med ändringarna och utan nycklarna i `utan`.
 * DOTENV_CONFIG_PATH pekar på en fil som inte finns, så att ingen .env kan rikta barnprocessen mot en
 * annan databas (samma skydd som test/config.test.ts rad 30–43).
 */
function byggBarnmiljo(andringar: Record<string, string>, utan: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: path.join(tmpdir(), 'mcp-granser-finns-inte.env'),
    ...andringar,
  };
  for (const nyckel of utan) delete env[nyckel];
  return env;
}

/** En port som är ledig på 127.0.0.1: systemet väljer den, och servern stängs innan porten ges. */
function hittaLedigPort(): Promise<number> {
  return new Promise<number>((klar, fel) => {
    const server = createServer();
    server.once('error', fel);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => klar(port));
    });
  });
}

/**
 * Startar appens riktiga ingång, src/server.ts, med `node --import tsx`: en enda process, så att `kill()`
 * når servern själv och ingen mellanprocess. HOST tas bort ur miljön, så att standardvärdet gäller, och
 * porten är `port`. Löftet uppfylls med processen och loggraden när raden syns på stdout, och avvisas, med
 * stderr i felet, om processen avslutas först eller om 15 sekunder går.
 */
function startaAppen(port: number): Promise<{ barn: ChildProcess; rad: string }> {
  return new Promise((klar, fel) => {
    const barn = spawn(process.execPath, ['--import', 'tsx', path.join(ROT, 'src/server.ts')], {
      cwd: ROT,
      env: byggBarnmiljo({ PORT: String(port) }, ['HOST']),
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
      barn.kill('SIGKILL');
      fel(new Error(`appen startade inte (${orsak}). stderr: ${stderr}`));
    }
    barn.stderr?.setEncoding('utf8');
    barn.stderr?.on('data', (del: string) => {
      stderr += del;
    });
    barn.stdout?.setEncoding('utf8');
    barn.stdout?.on('data', (del: string) => {
      stdout += del;
      // Bara hela rader: en del kan sluta mitt i raden, och då hade porten kapats.
      const rad = stdout.split('\n').slice(0, -1).find((r) => r.includes(LYSSNAR));
      if (rad === undefined || avgjort) return;
      avgjort = true;
      clearTimeout(timer);
      klar({ barn, rad });
    });
    barn.once('exit', (kod, signal) => avbryt(`avslutades med ${kod ?? signal}`));
    barn.once('error', (e) => avbryt(e.name));
  });
}

/**
 * Stoppar barnprocessen med SIGTERM, så att src/server.ts stänger sin pool och avslutar, och med SIGKILL om
 * den inte har avslutats på tio sekunder. Löftet uppfylls först när processen har avslutats, så att ingen
 * anslutning till provdatabasen står kvar till nästa fils test/setup.ts.
 */
async function stoppa(barn: ChildProcess): Promise<void> {
  if (barn.exitCode !== null || barn.signalCode !== null) return;
  const avslutad = new Promise<void>((klar) => barn.once('exit', () => klar()));
  barn.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  const hann = await Promise.race([
    avslutad.then(() => true),
    new Promise<boolean>((klar) => {
      timer = setTimeout(() => klar(false), 10_000);
    }),
  ]);
  clearTimeout(timer);
  if (!hann) {
    barn.kill('SIGKILL');
    await avslutad;
  }
}

/**
 * Ansluter med TCP till `vard` och `port` och ger 'ansluten', felets kod (till exempel 'ECONNREFUSED') eller
 * 'tidsgrans' efter två sekunder. Sockeln förstörs alltid efteråt.
 */
function anslut(vard: string, port: number): Promise<string> {
  return new Promise<string>((klar) => {
    const sockel = connect({ host: vard, port });
    const timer = setTimeout(() => avsluta('tidsgrans'), 2_000);
    function avsluta(utfall: string): void {
      clearTimeout(timer);
      sockel.destroy();
      klar(utfall);
    }
    sockel.once('connect', () => avsluta('ansluten'));
    sockel.once('error', (fel: NodeJS.ErrnoException) => avsluta(fel.code ?? fel.name));
  });
}

/**
 * Filens enda väg till HTTP: fetch med `redirect: 'manual'`, oavsett vad anroparen anger. Varje fall mäter
 * då svaret på själva vägen och aldrig målet för en omdirigering, så att en regression som skickar /vy till
 * inloggningssidan blir 302 och inte sidans 200, och inget svar kan leda provet bort från loopback.
 */
function hamta(adress: string, init: Parameters<typeof fetch>[1] = {}): ReturnType<typeof fetch> {
  return fetch(adress, { ...init, redirect: 'manual' });
}

// ---- Appens gränser (Uppgift 1) -------------------------------------------------------------------------

describe('FR-39/KRAV-10f, Story 4.4 AK 1: appens enda väg in binder 127.0.0.1', () => {
  it('G1 (AK 1): standardvärdena är 127.0.0.1 och 3002, och src/server.ts har ett enda listen', () => {
    const svar = EnvSchema.safeParse({ DATABASE_URL: 'postgres://g1@prov/prov' });
    expect({
      ok: svar.success,
      host: svar.success ? svar.data.HOST : null,
      port: svar.success ? svar.data.PORT : null,
    }).toEqual({ ok: true, host: '127.0.0.1', port: 3002 });

    // Anropet innehåller `.listen(`, så när båda står exakt en gång är det enda listen just det anropet.
    const kallan = readFileSync(path.join(ROT, 'src/server.ts'), 'utf8');
    expect({
      listen: kallan.split('.listen(').length - 1,
      anropet: kallan.split('app.listen(config.PORT, config.HOST,').length - 1,
    }).toEqual({ listen: 1, anropet: 1 });
  });
});

describe('FR-39/KRAV-10f, Story 4.4 AK 1: appens riktiga ingång, startad utan HOST', () => {
  let barn: ChildProcess | undefined;
  let port: number;
  let rad: string;

  beforeAll(async () => {
    port = await hittaLedigPort();
    ({ barn, rad } = await startaAppen(port));
  });

  afterAll(async () => {
    if (barn !== undefined) await stoppa(barn);
  });

  it('G2 (AK 1): appen svarar på 127.0.0.1 och nekas på 127.0.0.2, med en kontroll av mätpunkten', async () => {
    expect(rad).toContain(`127.0.0.1:${port}`);
    expect({ loopback: await anslut('127.0.0.1', port), annan: await anslut('127.0.0.2', port) }).toEqual({
      loopback: 'ansluten',
      annan: 'ECONNREFUSED',
    });

    // Kontroll: en server bunden till 127.0.0.2 nås där och nekas på 127.0.0.1, så bindningen avgör svaret
    // per adress. Den binder med flit inte alla adresser (filhuvudet).
    const kontroll = createServer((s) => s.destroy());
    await new Promise<void>((klar, fel) => {
      kontroll.once('error', fel);
      kontroll.listen(0, '127.0.0.2', () => klar());
    });
    try {
      const kontrollport = (kontroll.address() as AddressInfo).port;
      expect({
        annan: await anslut('127.0.0.2', kontrollport),
        loopback: await anslut('127.0.0.1', kontrollport),
      }).toEqual({ annan: 'ansluten', loopback: 'ECONNREFUSED' });
    } finally {
      await new Promise<void>((klar) => kontroll.close(() => klar()));
    }

    const halsa = await hamta(`http://127.0.0.1:${port}/health`);
    expect(halsa.status).toBe(200);
    await halsa.text();
  });

  it('G3 (AK 1): /vy svarar utan nyckel, och skrivande /api utan giltig nyckel ger 401 utan rader', async () => {
    await seedaTeam();
    const tabeller = ['events', 'issues', 'comments'];
    const fore = await Promise.all(tabeller.map((t) => raknaRader(t)));

    for (const vag of ['/vy', '/vy/digest']) {
      const svar = await hamta(`http://127.0.0.1:${port}${vag}`);
      expect(svar.status, vag).toBe(200);
      await svar.text();
    }

    const skrivningar = [
      ['create_issue', { title: 'nej', team_key: 'LOC' }],
      ['add_comment', { identifier: 'LOC-1', body: 'nej' }],
    ] as const;
    for (const [action, indata] of skrivningar) {
      for (const auth of [undefined, 'Bearer inte-en-nyckel']) {
        const namn = `${action} ${auth ?? 'utan Authorization'}`;
        const svar = await hamta(`http://127.0.0.1:${port}/api/actions/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(auth !== undefined ? { Authorization: auth } : {}) },
          body: JSON.stringify(indata),
        });
        expect(svar.status, namn).toBe(401);
        expect(await svar.json(), namn).toEqual({ error: 'unauthenticated' });
      }
    }

    expect(await Promise.all(tabeller.map((t) => raknaRader(t)))).toEqual(fore);

    // Kontroll: hamta() följer ingen omdirigering. En server som skickar /vy vidare till en inloggningssida,
    // som själv svarar 200, ger 302 här och hade alltså fällt 200-kravet ovan. hamta() är filens enda anrop
    // till fetch, så också G2, G4 och G5 mäter svaret på själva vägen.
    const omdirigerande = skapaHttpServer((req, res) => {
      if (req.url === '/vy') res.writeHead(302, { Location: '/vy/logga-in' }).end();
      else res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('inloggningssidan');
    });
    await new Promise<void>((klar, fel) => {
      omdirigerande.once('error', fel);
      omdirigerande.listen(0, '127.0.0.1', () => klar());
    });
    try {
      const svar = await hamta(`http://127.0.0.1:${(omdirigerande.address() as AddressInfo).port}/vy`);
      await svar.text();
      expect({
        status: svar.status,
        location: svar.headers.get('location'),
        fetchanrop: readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\bfetch\(/g)?.length ?? 0,
      }).toEqual({ status: 302, location: '/vy/logga-in', fetchanrop: 1 });
    } finally {
      await stang(omdirigerande);
    }
  });
});

// ---- Gatewayens vägar genom dess egen port (Uppgift 2) --------------------------------------------------

/** Stänger servern med close(); löftet avvisas om close() ger ett fel. */
function stang(s: Server): Promise<void> {
  return new Promise<void>((klar, fel) => {
    s.close((e) => (e ? fel(e) : klar()));
    s.closeAllConnections();
  });
}

/** Klientfilens innehåll i provet, samma form som klientfilen i drift (test/mcp.test.ts rad 163). */
const PROVKLIENT = Object.freeze({
  client_id: 'claude-prov',
  client_secret: `prov-hemlighet-${'x'.repeat(25)}`,
  utgivare: 'https://prov.example',
});

describe('FR-24 (d)/Story 4.4 AK 1: gatewayen svarar bara på /mcp, OAuth-vägarna och metadata', () => {
  let katalog: string | undefined;
  let gateway: Server | undefined;
  let bas: string;

  beforeAll(async () => {
    // Klientfilen i en tillfällig katalog, aldrig i hemkatalogen; rättigheterna sätts efter skrivningen.
    katalog = mkdtempSync(path.join(tmpdir(), 'arenden-mcp-granser-'));
    const klientfil = path.join(katalog, 'arenden-mcp-klient.json');
    writeFileSync(klientfil, JSON.stringify(PROVKLIENT));
    chmodSync(klientfil, 0o600);
    gateway = await startaGateway(0, klientfil);
    bas = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    if (gateway !== undefined) await stang(gateway);
    if (katalog !== undefined) rmSync(katalog, { recursive: true, force: true });
  });

  it('G4 (AK 1): sju vägar utanför gatewayens lista ger 404 genom gatewayens port', async () => {
    const vagar = [
      ['GET', '/'],
      ['GET', '/vy'],
      ['GET', '/vy/arende/LOC-1'],
      ['POST', '/vy/logga-in'],
      ['GET', '/health'],
      ['GET', '/api/actions'],
      ['POST', '/api/actions/get_issue'],
    ] as const;
    for (const [metod, vag] of vagar) {
      const namn = `${metod} ${vag}`;
      const svar = await hamta(
        `${bas}${vag}`,
        metod === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' } : {},
      );
      expect(svar.status, namn).toBe(404);
      expect(await svar.json(), namn).toEqual({ error: 'not_found' });
    }
  });

  it('G5 (AK 1): /mcp, de tre metadatavägarna, /authorize och /token svarar genom samma port', async () => {
    // Kontrollen för G4: samma port och samma 404-hanterare, men de sex vägarna når sina egna svar. Ingen av
    // begärandena når gatewayens API-anrop (Dev Notes → Driften rörs aldrig).
    const statusar: number[] = [];

    const initiera = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };
    const mcp = await hamta(`${bas}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(initiera),
    });
    statusar.push(mcp.status);
    expect(mcp.status, '/mcp').toBe(401);
    expect(mcp.headers.get('www-authenticate') ?? '', '/mcp').toMatch(/^Bearer /);
    expect(await mcp.json(), '/mcp').toEqual({ error: 'unauthenticated' });

    for (const vag of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp']) {
      const svar = await hamta(`${bas}${vag}`);
      statusar.push(svar.status);
      expect(svar.status, vag).toBe(200);
      expect(await svar.json(), vag).toHaveProperty('resource', `${PROVKLIENT.utgivare}/mcp`);
    }

    const server = await hamta(`${bas}/.well-known/oauth-authorization-server`);
    statusar.push(server.status);
    expect(server.status, 'oauth-authorization-server').toBe(200);
    expect(await server.json(), 'oauth-authorization-server').toHaveProperty('issuer', PROVKLIENT.utgivare);

    // Utan fråga stoppas /authorize av klientkontrollen: felsidan om klienten, ingen omdirigering.
    const authorize = await hamta(`${bas}/authorize`);
    statusar.push(authorize.status);
    expect(authorize.status, '/authorize').toBe(400);
    expect(await authorize.text(), '/authorize').toContain('Kopplingen är inte känd.');

    const token = await hamta(`${bas}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    statusar.push(token.status);
    expect(token.status, '/token').toBe(401);
    expect(await token.json(), '/token').toEqual({ error: 'invalid_client' });

    expect({ antal: statusar.length, utan404: statusar.filter((s) => s !== 404).length }).toEqual({
      antal: 6,
      utan404: 6,
    });
  });
});

// ---- README-avsnitten (Uppgift 3) -----------------------------------------------------------------------

const RUBRIK_42 = '### FR-24 (d) — Claude-sessionen når ärendenas actions och inget annat (Story 4.2)';
const RUBRIK_43 = '### FR-24 (d) — OAuth knyter Claude-sessionen till Davids människonyckel (Story 4.3)';
const RUBRIK_44 = '### FR-24 (d) — Fjärr-MCP nås utan Macen och gränserna står kvar (Story 4.4)';
const GRANSER_2A = '## Gränser för Etapp 2a';

/** Regelraderna, ordagrant som i regelkällan (4.2:s, 4.3:s och 4.4:s Dev Notes). */
const REGELN_42 =
  '- Regel (FR-24 (d), B-19, Story 4.2): `src/mcp/` importerar bara express, express-rate-limit, zod, `path` ' +
  'och `pathToFileURL` ur Node, Nodes typer, varandra och `actionManifest` ur `src/actions/registry.ts`, läser ' +
  'ingen miljövariabel, och anropar plattformen bara genom `anropaApi()` mot `/api/actions/` med ett namn ur ' +
  'verktygslistan.';
const REGELN_43 =
  '- Regel (FR-24 (d), B-19, Story 4.3): bara en människonyckel, prövad med `vem_ar_jag` genom `/api`, ger en ' +
  'kod; koder och tokens lagras bara som sha256 i processens minne; nyckeln skickas bara som bearer till API:t; ' +
  '`src/mcp/` skriver aldrig till disk, och `src/mcp/oauth.ts` loggar inget.';
const REGELN_44 =
  '- Regel (FR-24 (d), FR-39, B-19, Story 4.4): den enda vägen utanför tailnet är `tailscale funnel` på porten ' +
  '8443 mot MCP-gatewayen på 127.0.0.1 port 3003, enligt Davids svar 2026-10-13. Appen på 3002 binder bara ' +
  '127.0.0.1 och nås utifrån bara genom `tailscale serve` på 8446 mot `/vy`. Ingen annan väg öppnas, och ' +
  'gatewayen svarar bara på `/mcp`, OAuth-vägarna och metadata. `test/mcp-granser.test.ts` prövar gränserna i ' +
  'koden.';

/** Funnelns tre kommandon: slå på, kontrollera och stäng. */
const KOMMANDON = [
  '`tailscale funnel --bg --https=8443 3003`',
  '`tailscale funnel status`',
  '`tailscale funnel --https=8443 off`',
] as const;

/**
 * Påslagningen och stängningen, i den ordning de görs: förkontrollen före påslagningen, kontrollen efter den,
 * och stängningen. Varje steg bär på sin egen rad vad som gäller för steget: förkontrollen och kontrollen vad
 * som görs när de avviker, påslagningen sitt mål och stängningen kontrollen som följer. Funnel slås på för
 * hela porten, så en kontroll som kommer efter påslagningen, eller som saknar en åtgärd, skyddar inte en väg
 * som redan står på 8443 (granskningen 2026-10-24). En sluten lista.
 */
const STEGEN = [
  { kommando: '`tailscale serve status`', kravet: 'slå inte på funneln' },
  { kommando: KOMMANDON[0], kravet: '127.0.0.1 port 3003' },
  { kommando: KOMMANDON[1], kravet: 'stäng funneln direkt' },
  { kommando: KOMMANDON[2], kravet: 'statuskommandot' },
] as const;

/** Den slutna fragmentlistan för G6 (Dev Notes → Fallen). */
const FRAGMENT = [
  '127.0.0.1 port 3003',
  'arenden-mcp-klient.json',
  '0600',
  '`client_id`',
  '`client_secret`',
  '`utgivare`',
  'Add custom connector',
  'Advanced settings',
  '*Godkänn Claude-kopplingen*',
  '`revoke_api_key`',
  '`/mcp`',
] as const;

/**
 * 4.2:s påståenden som Story 4.3 gjorde inaktuella, ordagrant ur 4.2:s avsnitt: en sluten lista
 * (granskningen 2026-10-24). 4.2:s text står kvar, och 4.3:s avsnitt säger för vart och ett vad som gäller nu,
 * på en punktrad som börjar med påståendet inom «».
 */
const ERSATTA_42 = [
  '404 för allt utom `/mcp`',
  'importerar bara express, express-rate-limit, zod, `path` och `pathToFileURL` ur Node',
  'läser ingen miljövariabel',
  'ingen miljöläsning',
  'bara genom `anropaApi()` mot `/api/actions/` med ett namn ur verktygslistan',
] as const;

/**
 * Värdena som filerna under src/mcp/ importerar ur Nodes moduler, sorterade och utan typimporter. Filerna har
 * en importsats per rad. Ett alias räknas med sitt ursprungliga namn.
 */
function listaNodeimporter(): string[] {
  const katalog = path.join(ROT, 'src/mcp');
  const namn = new Set<string>();
  for (const fil of readdirSync(katalog).filter((f) => f.endsWith('.ts'))) {
    const kallan = readFileSync(path.join(katalog, fil), 'utf8');
    for (const [, bundet = ''] of kallan.matchAll(/^import (?!type )(.+) from 'node:[a-z_/]+';$/gm)) {
      for (const del of bundet.replace(/[{}]/g, '').split(',')) {
        const ord = del.trim();
        if (ord !== '' && !ord.startsWith('type ')) namn.add(ord.split(/\s+as\s+/)[0] ?? ord);
      }
    }
  }
  return [...namn].sort();
}

const GATEWAYRADEN = '| MCP-gatewayen (egen process, klient till /api) | `src/mcp/` |';
const STRUKEN = 'Sessionerna kommer med OAuth-flödet i Story 4.3; tills dess svarar processen 401 på varje anrop.';

/**
 * Avsnittet under `rubrik`: raderna från rubrikraden till raden före nästa rad som börjar med '## ' eller
 * '### '. Rubriken söks som en hel rad; saknas den blir avsnittet tomt.
 */
function hamtaAvsnitt(text: string, rubrik: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const start = rader.indexOf(rubrik);
  if (start === -1) return [];
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return rader.slice(start, nasta === -1 ? rader.length : nasta);
}

describe('FR-24 (d)/Story 4.4 AK 2: vägen är dokumenterad i README', () => {
  it('G6 (AK 2): avsnittet för 4.4 bär funnelns kommandon, kopplingen, klientfilen, stängningen och regeln', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    const rader = readme.split('\n').map((r) => r.replace(/\r$/, ''));
    const avsnitt = hamtaAvsnitt(readme, RUBRIK_44);
    const text = avsnitt.join('\n');
    const stegensRader = STEGEN.map((s) => avsnitt.findIndex((r) => r.includes(s.kommando)));
    expect({
      rubriken: rader.filter((r) => r === RUBRIK_44).length,
      kommandona: KOMMANDON.map((k) => text.split(k).length - 1),
      paslagningenIReadme: readme.split('tailscale funnel --bg --https=8443 3003').length - 1,
      forkontrollen: text.split(STEGEN[0].kommando).length - 1,
      stegenIOrdning: stegensRader.every((p, i) => p !== -1 && (i === 0 || p > (stegensRader[i - 1] ?? -1))),
      stegUtanKravet: STEGEN.filter((s, i) => !(avsnitt[stegensRader[i] ?? -1] ?? '').includes(s.kravet)).map(
        (s) => s.kommando,
      ),
      saknade: FRAGMENT.filter((f) => !text.includes(f)),
      regeln: avsnitt.filter((r) => r.startsWith('- Regel (FR-24 (d), FR-39, B-19, Story 4.4):')),
      tabellrader: avsnitt.filter((r) => r.startsWith('| FR-')).length,
    }).toEqual({
      rubriken: 1,
      kommandona: [1, 1, 1],
      paslagningenIReadme: 1,
      forkontrollen: 1,
      stegenIOrdning: true,
      stegUtanKravet: [],
      saknade: [],
      regeln: [REGELN_44],
      tabellrader: 4,
    });
  });

  it('G7 (AK 2): 4.2:s och 4.3:s avsnitt och gatewayens rad står där, och 4.2:s gamla mening är struken', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    const rader = readme.split('\n').map((r) => r.replace(/\r$/, ''));
    const rubrikerna = [RUBRIK_42, RUBRIK_43, RUBRIK_44];
    const platser = rubrikerna.map((r) => rader.indexOf(r));
    const etapp2a = rader.indexOf(GRANSER_2A);
    const gatewayraden = rader.indexOf(GATEWAYRADEN);
    const vadSomFinns = rader.indexOf('## Vad som finns');
    const actions = rader.indexOf('### Actions');
    const avsnitt42 = hamtaAvsnitt(readme, RUBRIK_42).join('\n');
    const avsnitt43 = hamtaAvsnitt(readme, RUBRIK_43);
    const nodeimporter = listaNodeimporter();
    expect({
      rubrikerna: rubrikerna.map((r) => rader.filter((x) => x === r).length),
      iOrdning: platser.every((p, i) => p !== -1 && (i === 0 || p > (platser[i - 1] ?? -1))),
      foreEtapp2a: platser.every((p) => p !== -1 && p < etapp2a),
      regel42: rader.filter((r) => r.startsWith('- Regel (FR-24 (d), B-19, Story 4.2):')),
      regel43: rader.filter((r) => r.startsWith('- Regel (FR-24 (d), B-19, Story 4.3):')),
      gatewayraden: rader.filter((r) => r === GATEWAYRADEN).length,
      gatewayradensPlats: vadSomFinns !== -1 && vadSomFinns < gatewayraden && gatewayraden < actions,
      struken: readme.includes(STRUKEN),
      // Det 4.2 sade och 4.3 ändrade: varje påstående står kvar i 4.2:s avsnitt och har sitt svar i 4.3:s.
      ersattaSomSaknasI42: ERSATTA_42.filter((p) => !avsnitt42.includes(p)),
      ersattaUtanSvarI43: ERSATTA_42.filter(
        (p) => !avsnitt43.some((r) => r.startsWith('- «') && r.includes(`«${p}»`)),
      ),
      // Ur koden: varje värde som src/mcp/ importerar ur Node står i kodformat i 4.2:s eller 4.3:s avsnitt.
      // Kontrollen visar att genomgången hittar importer i båda filerna som har sådana.
      importernaHittade: nodeimporter.includes('homedir') && nodeimporter.includes('pathToFileURL'),
      importerUtanText: nodeimporter.filter(
        (n) => !`${avsnitt42}\n${avsnitt43.join('\n')}`.includes(`\`${n}\``),
      ),
    }).toEqual({
      rubrikerna: [1, 1, 1],
      iOrdning: true,
      foreEtapp2a: true,
      regel42: [REGELN_42],
      regel43: [REGELN_43],
      gatewayraden: 1,
      gatewayradensPlats: true,
      struken: false,
      ersattaSomSaknasI42: [],
      ersattaUtanSvarI43: [],
      importernaHittade: true,
      importerUtanText: [],
    });
  });
});
