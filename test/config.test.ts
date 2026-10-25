// D-2, B-21 (Story 11.2 AK 2): VY_PUBLIK_URL är en https-adress som är exakt sin egen origin, med
// driftens adress som standardvärde. Fallistorna: C1 nio ogiltiga former, C2 tre giltiga (två satta och
// den saknade) och konstanten mot README:n, C3 två barnprocesser.
//
// FR-39, B-12 (Story 7.2): HOST godtar bara 127.0.0.1. Fallistorna: H1 fem former som fälls och två som
// godtas, H2 en serverstart som stoppas, H3 den startade serverns lyssnande adress ur kärnans båda tabeller,
// H4 nyckelgränsen genom samma server och H5 README-avsnittet, där varje del av AK 4 prövas ordagrant och
// ger sitt eget fynd. Ingen server i filen binder alla adresser, inte heller i ett rött utfall, eftersom
// sviten körs på driftens värd (docs/project-context.md rad 140).
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config, EnvSchema, VY_PUBLIK_URL_STANDARD } from '../src/config.js';
import { TEST_VY_PUBLIK_URL } from './env.js';
import { nyNyckel, raknaRader, seedaTeam } from './helpers.js';

const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));

const OGILTIGA = [
  '',
  'http://arenden-prov.invalid',
  'https://arenden-prov.invalid/',
  'https://arenden-prov.invalid/vy',
  'https://arenden-prov.invalid?x=1',
  'https://arenden-prov.invalid#x',
  'https://arenden-prov.invalid?',
  'https://arenden-prov.invalid#',
  'inte en adress',
];
const GILTIGA = ['https://arenden-prov.invalid', 'https://arenden-prov.invalid:8446'];

/**
 * Barnprocessens miljö: en kopia av provets miljö, med ändringarna och utan nycklarna i `utan`.
 * DOTENV_CONFIG_PATH pekar på en fil som inte finns, så att ingen .env kan rikta barnprocessen mot en
 * annan databas (samma skydd som test/schema.test.ts rad 212–225).
 */
function barnmiljo(andringar: Record<string, string>, utan: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: path.join(tmpdir(), 'config-prov-finns-inte.env'),
    ...andringar,
  };
  for (const nyckel of utan) delete env[nyckel];
  return env;
}

interface Barnutfall {
  kod: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Kör `fil` med tsx under repots rot och kastar aldrig: `kod` är 0 när processen lyckas, annars dess
 * exitkod, och null för en process som dödats. Tidsgränsen och SIGKILL fäller en server som startar i
 * stället för att stoppas av konfigurationen (som test/schema.test.ts rad 233–255).
 */
async function korBarnprocess(fil: string, env: NodeJS.ProcessEnv): Promise<Barnutfall> {
  try {
    const { stdout, stderr } = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'tsx'),
      [path.join(ROT, fil)],
      { cwd: ROT, env, timeout: 15_000, killSignal: 'SIGKILL' },
    );
    return { kod: 0, stdout, stderr };
  } catch (err) {
    const fel: Record<string, unknown> = typeof err === 'object' && err !== null ? { ...err } : {};
    return {
      kod: typeof fel['code'] === 'number' ? fel['code'] : null,
      stdout: typeof fel['stdout'] === 'string' ? fel['stdout'] : '',
      stderr: typeof fel['stderr'] === 'string' ? fel['stderr'] : '',
    };
  }
}

describe('D-2/Story 11.2 AK 2: den publika adressen är konfiguration, med driftens adress som standardvärde', () => {
  it('C1 (AK 2): nio ogiltiga former fälls med ett fel som namnger VY_PUBLIK_URL', () => {
    const obs = OGILTIGA.map((form) => {
      const svar = EnvSchema.safeParse({ DATABASE_URL: 'postgres://c1@prov/prov', VY_PUBLIK_URL: form });
      return {
        form,
        ok: svar.success,
        sokvagar: svar.success ? [] : svar.error.issues.map((i) => i.path.join('.')),
      };
    });
    expect(obs).toEqual(OGILTIGA.map((form) => ({ form, ok: false, sokvagar: ['VY_PUBLIK_URL'] })));
  });

  it('C2 (AK 2): en https-adress utan sökväg godtas, och utan variabeln gäller driftens adress', () => {
    const obs = GILTIGA.map((form) => {
      const svar = EnvSchema.safeParse({ DATABASE_URL: 'postgres://c2@prov/prov', VY_PUBLIK_URL: form });
      return { form, ok: svar.success, varde: svar.success ? svar.data.VY_PUBLIK_URL : null };
    });
    const utan = EnvSchema.safeParse({ DATABASE_URL: 'postgres://c2@prov/prov' });
    obs.push({ form: '(saknas)', ok: utan.success, varde: utan.success ? utan.data.VY_PUBLIK_URL : null });
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect({
      obs,
      https: VY_PUBLIK_URL_STANDARD.startsWith('https://'),
      iReadme: readme.includes(VY_PUBLIK_URL_STANDARD + '/vy'),
    }).toEqual({
      obs: [
        ...GILTIGA.map((form) => ({ form, ok: true, varde: form })),
        { form: '(saknas)', ok: true, varde: VY_PUBLIK_URL_STANDARD },
      ],
      https: true,
      iReadme: true,
    });
    // Kontroll: sviten kör med provets värde, inte med standardvärdet, eftersom test/env.ts sätter det.
    expect(config.VY_PUBLIK_URL).toBe(TEST_VY_PUBLIK_URL);
    expect(config.VY_PUBLIK_URL).not.toBe(VY_PUBLIK_URL_STANDARD);
  });

  it('C3 (AK 2): servern startar inte med ett ogiltigt värde, och felraden namnger variabeln', async () => {
    const ogiltig = await korBarnprocess('src/server.ts', barnmiljo({ VY_PUBLIK_URL: 'http://arenden-prov.invalid' }));
    expect({
      kod: ogiltig.kod,
      vagrar: ogiltig.stderr.includes('vägrar starta'),
      namnger: ogiltig.stderr.includes('VY_PUBLIK_URL'),
    }, ogiltig.stderr).toEqual({ kod: 1, vagrar: true, namnger: true });
    // Kontroll: felraden skiljer variablerna åt — en saknad DATABASE_URL namnger bara den.
    const utanDatabas = await korBarnprocess('src/server.ts', barnmiljo({}, ['DATABASE_URL']));
    expect({
      kod: utanDatabas.kod,
      databas: utanDatabas.stderr.includes('DATABASE_URL'),
      adress: utanDatabas.stderr.includes('VY_PUBLIK_URL'),
    }, utanDatabas.stderr).toEqual({ kod: 1, databas: true, adress: false });
  });
});

// ---- FR-39, B-12 (Story 7.2): servern kan bara binda 127.0.0.1 -----------------------------------------

/**
 * AK 1:s fem former, en per sätt att binda något annat än 127.0.0.1: alla adresser i IPv4 och i IPv6, ett
 * namn som kan lösas till ::1, en LAN-adress och den tomma strängen. Fallistan visar tillåtelselistan; den är
 * inte mekanismen.
 */
const OGILTIGA_HOST = ['0.0.0.0', '::', 'localhost', '192.168.1.10', ''];

// Hjälparna för H3 och H4 skrivs om ur test/mcp-granser.test.ts (rad 56–159), eftersom provfilerna inte
// exporterar några hjälpare.

/** Raden som src/server.ts skriver på stdout när servern lyssnar. */
const LYSSNAR = 'Ärende-API lyssnar på';

/** Titeln på ärendet som H4:s kontroll skapar; ärendesidan ska bära den. */
const TITEL_H4 = 'Story 7.2 H4 nyckelgränsen';

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
 * Startar appens riktiga ingång, src/server.ts, med `node --import tsx` i barnmiljön: en enda process, så att
 * `kill()` når servern själv och ingen mellanprocess. Löftet uppfylls med processen och loggraden när en hel
 * rad på stdout bär LYSSNAR, och avvisas, med stderr i felet, om processen avslutas först eller om 15
 * sekunder går (då med SIGKILL).
 */
function startaServern(
  andringar: Record<string, string>,
  utan: string[] = [],
): Promise<{ barn: ChildProcess; rad: string }> {
  return new Promise((klar, fel) => {
    const barn = spawn(process.execPath, ['--import', 'tsx', path.join(ROT, 'src/server.ts')], {
      cwd: ROT,
      env: barnmiljo(andringar, utan),
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
      fel(new Error(`servern startade inte (${orsak}). stderr: ${stderr}`));
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
 * Filens enda väg till HTTP: fetch med `redirect: 'manual'`, oavsett vad anroparen anger, så att en
 * omdirigering till inloggningen blir 302 och fäller kravet på 200 i stället för att följas.
 */
function hamta(adress: string, init: Parameters<typeof fetch>[1] = {}): ReturnType<typeof fetch> {
  return fetch(adress, { ...init, redirect: 'manual' });
}

/** Läget LISTEN i kärnans tabeller över TCP-socklar. */
const LISTEN = '0A';

/**
 * De lokala adresserna som lyssnar på `port`, sorterade, ur kärnans tabeller över TCP-socklar: samma källa
 * som `ss -ltn` läser, och den visar vad som faktiskt är bundet, inte vad koden skriver i sin loggrad.
 * /proc/net/tcp krävs, och ett läsfel kastas, så att ett oläsbart underlag aldrig blir grönt; /proc/net/tcp6
 * saknas bara när IPv6 är avstängt och ger då inga rader. Varje datarad har den lokala adressen i andra fältet
 * (adressen och porten i hex, åtskilda av ett kolon) och läget i fjärde. Porten tolkas som tal, eftersom
 * kärnan skriver den med fyra versala hexsiffror. En IPv4-adress står med bytena i omvänd ordning (0100007F
 * är 127.0.0.1); en tcp6-rad ges som `tcp6 ` och adressens hex, eftersom varje sådan rad ändå fäller provet.
 */
function lyssnandeAdresser(port: number): string[] {
  const adresser: string[] = [];
  for (const [fil, kravs] of [['/proc/net/tcp', true], ['/proc/net/tcp6', false]] as const) {
    let text: string;
    try {
      text = readFileSync(fil, 'utf8');
    } catch (err) {
      if (!kravs && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    for (const rad of text.split('\n').slice(1)) {
      const falt = rad.trim().split(/\s+/);
      const lokal = falt[1];
      if (lokal === undefined || falt[3] !== LISTEN) continue;
      const [adress = '', porthex = ''] = lokal.split(':');
      if (parseInt(porthex, 16) !== port) continue;
      adresser.push(
        fil === '/proc/net/tcp'
          ? (adress.match(/../g) ?? []).map((b) => parseInt(b, 16)).reverse().join('.')
          : `tcp6 ${adress}`,
      );
    }
  }
  return adresser.sort();
}

/**
 * H3:s kontrollservrar, en per tabell i kärnan, så att båda grenarna i lyssnandeAdresser visas se en lyssnande
 * socket: 127.0.0.2 står bara i /proc/net/tcp och avkodas till punktform, ::1 står bara i /proc/net/tcp6 och
 * ges som hex (fyra ord om 32 bitar, vart och ett med bytena i värdens ordning, little-endian som driftens
 * värd). I tcp6 hade också en server synts som binder :: med både IPv4 och IPv6. Båda adresserna är loopback,
 * och ingen av dem binder alla adresser.
 */
const KONTROLLER_H3 = [
  { adress: '127.0.0.2', vantat: ['127.0.0.2'] },
  { adress: '::1', vantat: ['tcp6 00000000000000000000000001000000'] },
];

// README-hjälparna för H5 följer test/schema.test.ts och test/djuplank.test.ts (D19).

const RUBRIK_72 = '### FR-39 — servern kan bara binda 127.0.0.1 (Story 7.2)';
const REGELNS_BORJAN_72 = '- Bindningen (FR-39, B-12, Story 7.2):';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN_72 =
  '- Bindningen (FR-39, B-12, Story 7.2): `HOST` i `EnvSchema` godtar bara 127.0.0.1, som också är ' +
  'standardvärdet, och varje annat värde stoppar starten med en felrad som namnger `HOST`. `src/server.ts` har ' +
  'ett enda `listen`, med `config.PORT` och `config.HOST`. Appen nås utifrån bara genom `tailscale serve` på ' +
  'porten 8446, och inget prov och ingen hjälpare i sviten binder alla adresser.';
const GRANSER_2A = '## Gränser för Etapp 2a';

/**
 * En rad i avsnittet som bär en del av AK 4, ordagrant som i Dev Notes → Dokumentationen. Varje del som AK 4
 * räknar upp står exakt en gång på raden.
 */
interface BarandeRad {
  /** Namnet i fynden; för en mätning kommandot, som också hittar raden i avsnittet. */
  namn: string;
  rad: string;
  delar: readonly string[];
  /** Ordet som H5:s kontroll sätter «inte» efter, så att raden behåller alla delar men säger något annat. */
  nekas: string;
}

/** Meningen om var kommando, utfall och datum antecknas (AK 4); den hittas på sin början. */
const MENINGENS_BORJAN_72 = 'Bindningen och exponeringen ';
const MENINGEN_72: BarandeRad = {
  namn: 'meningen om kommando, utfall och datum',
  rad:
    'Bindningen och exponeringen mäts på värden efter driftsättningen, och kommando, utfall och datum ' +
    'antecknas i berättelsefilen för Story 7.2:',
  delar: [
    'mäts på värden efter driftsättningen',
    'kommando, utfall och datum antecknas',
    'i berättelsefilen för Story 7.2',
  ],
  nekas: 'antecknas ',
};

/** Mätningarna i drift, var och en på sin numrerade rad i avsnittet och med sitt väntade utfall (AK 4). */
const MATNING_SERVE_72: BarandeRad = {
  namn: '`tailscale serve status`',
  rad:
    '1. `tailscale serve status` visar porten 8446 med sökvägen `/vy` mot appen på 127.0.0.1 port 3002, och ' +
    'ingen annan väg till port 3002. Den enda vägen utanför tailnet är funneln på porten 8443 mot ' +
    'MCP-gatewayen på 127.0.0.1 port 3003 (avsnittet för Story 4.4), aldrig mot port 3002.',
  delar: [
    'porten 8446',
    'sökvägen `/vy`',
    'appen på 127.0.0.1 port 3002',
    'ingen annan väg till port 3002',
    'funneln på porten 8443',
    'MCP-gatewayen på 127.0.0.1 port 3003',
    'aldrig mot port 3002',
  ],
  nekas: 'visar ',
};
const MATNING_SS_72: BarandeRad = {
  namn: '`ss -ltnp`',
  rad:
    '2. `ss -ltnp` visar port 3002 bara med den lokala adressen 127.0.0.1, och ingen rad för port 3002 med ' +
    '`0.0.0.0`, `*` eller `[::]`.',
  delar: ['port 3002 bara med den lokala adressen', 'ingen rad för port 3002', '`0.0.0.0`', '`*`', '`[::]`'],
  nekas: 'visar ',
};
const MATNINGAR_72 = [MATNING_SERVE_72, MATNING_SS_72];

/** Avsnittets rader: från rubriken till raden före nästa rad som börjar med '## ' eller '### ', eller null. */
function avsnittet(rader: string[]): string[] | null {
  const start = rader.indexOf(RUBRIK_72);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return rader.slice(start, nasta === -1 ? rader.length : nasta);
}

/**
 * Fynden för en bärande rad: varje del som saknas ger sitt eget fynd, och först när alla delar finns jämförs
 * raden tecken för tecken med texten, så att också en omskrivning som behåller orden men ändrar utfallet fälls.
 */
function utfallsfel(barande: BarandeRad, raden: string): string[] {
  const saknas = barande.delar.filter((d) => !raden.includes(d));
  if (saknas.length > 0) return saknas.map((d) => `${barande.namn} saknar «${d}»`);
  return raden === barande.rad ? [] : [`${barande.namn} avviker`];
}

/**
 * Fynden för H5, en tom lista när avsnittet stämmer. Rubriken och regelns rad räknas i hela README:n, och
 * regeln ska dessutom stå i avsnittet; meningen, kommandona och tabellraderna räknas bara i avsnittet,
 * eftersom avsnittet för Story 4.4 redan har två rader som börjar med `| FR-39` och `tailscale serve status`
 * står på två andra ställen. Meningen och mätningarna prövas mot sin text ordagrant (utfallsfel), så att
 * provet läser hela AK 4: varje väntat utfall på sin rad och var kommando, utfall och datum antecknas.
 */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const avsnitt = avsnittet(rader);
  if (avsnitt === null) return ['rubriken saknas'];
  const fel: string[] = [];
  if (rader.filter((r) => r === RUBRIK_72).length !== 1) fel.push('rubriken står inte exakt en gång');
  const granserna = rader.indexOf(GRANSER_2A);
  if (granserna === -1 || granserna < rader.indexOf(RUBRIK_72)) {
    fel.push('rubriken står inte före gränserna för Etapp 2a');
  }
  const regler = rader.filter((r) => r.startsWith(REGELNS_BORJAN_72));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== REGELN_72) fel.push('regeln avviker');
  else if (!avsnitt.includes(REGELN_72)) fel.push('regeln står inte i avsnittet');
  const inne = avsnitt.slice(1);
  const meningar = inne.filter((r) => r.startsWith(MENINGENS_BORJAN_72));
  const [mening] = meningar;
  if (meningar.length !== 1 || mening === undefined) {
    fel.push(`${MENINGEN_72.namn} står ${meningar.length} gånger`);
  } else {
    fel.push(...utfallsfel(MENINGEN_72, mening));
  }
  for (const matning of MATNINGAR_72) {
    const kommando = matning.namn;
    const antal = inne.join('\n').split(kommando).length - 1;
    if (antal !== 1) {
      fel.push(`${kommando} står ${antal} gånger`);
      continue;
    }
    const raden = inne.find((r) => r.includes(kommando)) ?? '';
    if (!/^\d+\. /.test(raden) || !raden.includes('127.0.0.1')) {
      fel.push(`${kommando} står inte på en numrerad rad med 127.0.0.1`);
      continue;
    }
    fel.push(...utfallsfel(matning, raden));
  }
  const tabell = inne.filter((r) => r.startsWith('| FR-39'));
  if (tabell.length !== 4) fel.push(`${tabell.length} rader börjar med | FR-39`);
  for (const r of tabell) if (!r.includes('test/config.test.ts')) fel.push(`rad utan provfilen: ${r}`);
  return fel;
}

/** Texten utan avsnittet: raderna från rubriken till nästa rubrik tas bort. */
function utanAvsnittet(text: string): string {
  const rader = text.split('\n');
  const start = rader.map((r) => r.replace(/\r$/, '')).indexOf(RUBRIK_72);
  if (start === -1) return text;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return [...rader.slice(0, start), ...rader.slice(nasta === -1 ? rader.length : nasta)].join('\n');
}

/**
 * `text` med den enda förekomsten av `fran` utbytt mot `till`, för kontrollerna i H5. Står `fran` inte exakt
 * en gång kastas ett fel, så att en kontroll aldrig prövar en text som den inte har ändrat.
 */
function bytUt(text: string, fran: string, till: string): string {
  const delar = text.split(fran);
  if (fran === '' || delar.length !== 2) {
    throw new Error(`väntade «${fran}» exakt en gång, fann ${delar.length - 1}`);
  }
  return delar.join(till);
}

describe('FR-39/Story 7.2 AK 1: konfigurationen godtar bara loopback', () => {
  it('H1 (AK 1): fem andra former fälls med ett fel som namnger HOST, och utelämnat och 127.0.0.1 godtas', () => {
    const obs = OGILTIGA_HOST.map((form) => {
      const svar = EnvSchema.safeParse({ DATABASE_URL: 'postgres://h1@prov/prov', HOST: form });
      return {
        form,
        ok: svar.success,
        sokvagar: svar.success ? [] : svar.error.issues.map((i) => i.path.join('.')),
        namnerVardet: svar.success ? false : svar.error.issues.some((i) => i.message.includes('127.0.0.1')),
      };
    });
    expect(obs).toEqual(
      OGILTIGA_HOST.map((form) => ({ form, ok: false, sokvagar: ['HOST'], namnerVardet: true })),
    );

    // Kontroll: det enda tillåtna värdet godtas, både utelämnat (standardvärdet går genom samma prövning) och
    // satt. Provet jämför med värdet självt, aldrig med en konstant ur src/config.ts.
    const godtas = [
      { form: '(saknas)', indata: { DATABASE_URL: 'postgres://h1@prov/prov' } },
      { form: '127.0.0.1', indata: { DATABASE_URL: 'postgres://h1@prov/prov', HOST: '127.0.0.1' } },
    ].map(({ form, indata }) => {
      const svar = EnvSchema.safeParse(indata);
      return { form, ok: svar.success, varde: svar.success ? svar.data.HOST : null };
    });
    expect({ godtas, sviten: config.HOST }).toEqual({
      godtas: [
        { form: '(saknas)', ok: true, varde: '127.0.0.1' },
        { form: '127.0.0.1', ok: true, varde: '127.0.0.1' },
      ],
      sviten: '127.0.0.1',
    });
  });

  it('H2 (AK 1): servern startar inte med en annan adress, och felraden namnger bara HOST', async () => {
    // 192.0.2.1 hör till ett block som är reserverat för dokumentation och sitter aldrig på en värd, så att
    // inget binds ens om konfigurationen skulle godta värdet; 0.0.0.0 och :: prövas bara mot schemat (H1).
    const utfall = await korBarnprocess('src/server.ts', barnmiljo({ HOST: '192.0.2.1', PORT: '0' }));
    expect({
      kod: utfall.kod,
      vagrar: utfall.stderr.includes('vägrar starta'),
      variabler: utfall.stderr
        .split('\n')
        .filter((r) => r.startsWith('  - '))
        .map((r) => r.slice('  - '.length).split(':')[0]),
      lyssnar: utfall.stdout.includes('lyssnar på'),
    }, utfall.stderr).toEqual({ kod: 1, vagrar: true, variabler: ['HOST'], lyssnar: false });
  });
});

describe('FR-39/Story 7.2 AK 2 och AK 3: den startade servern lyssnar på loopback och håller nyckelgränsen', () => {
  let barn: ChildProcess | undefined;
  let port: number;
  let rad: string;

  beforeAll(async () => {
    // Samma barnmiljö som H2, med det enda tillåtna värdet satt: kontrollen till H2. G2 i
    // test/mcp-granser.test.ts startar utan HOST, så båda godtagna formerna prövas genom en riktig start.
    port = await hittaLedigPort();
    ({ barn, rad } = await startaServern({ HOST: '127.0.0.1', PORT: String(port) }));
  });

  afterAll(async () => {
    if (barn !== undefined) await stoppa(barn);
  });

  it('H3 (AK 2): kärnans tabell visar servern bara på 127.0.0.1, med en kontroll av läsningen', async () => {
    expect(rad).toContain(`127.0.0.1:${port}`);
    expect(lyssnandeAdresser(port)).toEqual(['127.0.0.1']);
    const halsa = await hamta(`http://127.0.0.1:${port}/health`);
    expect(halsa.status).toBe(200);
    await halsa.text();

    // Kontroll, en server per tabell i kärnan (KONTROLLER_H3): en server som provet binder till 127.0.0.2
    // respektive ::1 syns med just den adressen, och när den har stängts syns ingen adress alls, så att båda
    // grenarna i läsningen ser en lyssnande socket, avkodar adressen och speglar vad som lyssnar just nu. En
    // server som bundit alla adresser hade gett 0.0.0.0 i tcp eller en rad i tcp6; ingen av kontrollerna gör
    // det (filhuvudet).
    for (const { adress, vantat } of KONTROLLER_H3) {
      const kontroll = createServer((s) => s.destroy());
      await new Promise<void>((klar, fel) => {
        kontroll.once('error', fel);
        kontroll.listen(0, adress, () => klar());
      });
      const kontrollport = (kontroll.address() as AddressInfo).port;
      try {
        expect(lyssnandeAdresser(kontrollport), adress).toEqual(vantat);
      } finally {
        await new Promise<void>((klar) => kontroll.close(() => klar()));
      }
      expect(lyssnandeAdresser(kontrollport), adress).toEqual([]);
    }
  });

  it('H4 (AK 3): läsningarna svarar 200 utan nyckel, och skrivningen utan nyckel ger 401 och noll rader', async () => {
    await seedaTeam();
    const nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    const tabeller = ['issues', 'events', 'comments'];
    const fore = await Promise.all(tabeller.map((t) => raknaRader(t)));
    const skapa = (auth: string | undefined): ReturnType<typeof fetch> =>
      hamta(`http://127.0.0.1:${port}/api/actions/create_issue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth !== undefined ? { Authorization: auth } : {}) },
        body: JSON.stringify({ title: TITEL_H4, team_key: 'LOC' }),
      });

    const utan = await skapa(undefined);
    expect({ status: utan.status, svar: await utan.json() }).toEqual({
      status: 401,
      svar: { error: 'unauthenticated' },
    });
    expect(await Promise.all(tabeller.map((t) => raknaRader(t)))).toEqual(fore);

    // Kontroll: samma anrop med agentnyckelns bearer skriver, så att räkningen kan slå ut och 401 ovan kommer
    // av den saknade nyckeln.
    const med = await skapa(`Bearer ${nyckel}`);
    const svar = (await med.json()) as { result?: { identifier?: unknown } };
    const [issues = 0, events = 0] = await Promise.all(tabeller.map((t) => raknaRader(t)));
    const [issuesFore = 0, eventsFore = 0] = fore;
    expect({ status: med.status, issues, eventsOkade: events >= eventsFore + 1 }).toEqual({
      status: 200,
      issues: issuesFore + 1,
      eventsOkade: true,
    });
    const nummer = svar.result?.identifier;
    expect(nummer).toMatch(/^LOC-\d+$/);

    for (const vag of ['/vy', `/vy/arende/${String(nummer)}`, '/health']) {
      const lasning = await hamta(`http://127.0.0.1:${port}${vag}`);
      const text = await lasning.text();
      expect(lasning.status, vag).toBe(200);
      if (vag.startsWith('/vy/arende/')) expect(text, vag).toContain(TITEL_H4);
    }
  });
});

describe('FR-39/Story 7.2 AK 4: README bär regeln och kommandona', () => {
  it('H5 (AK 4): regeln, mätningarna med väntade utfall, meningen om utfall och datum och fyra tabellrader', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect(readmefel(readme)).toEqual([]);

    // Kontroll: varje del av AK 4 som tas bort, flyttas eller skrivs om ger sitt eget fynd och inget annat, så
    // att varje gren i readmefel kan slå ut och ingen del av kriteriet står i README:n utan att provet läser den.
    // Omskrivningen med alla delar kvar visar att raden prövas ordagrant och inte bara på sina ord.
    const rader = readme.split('\n').map((r) => r.replace(/\r$/, ''));
    const avsnittsrader = avsnittet(rader) ?? [];
    const tabellrad = avsnittsrader.find((r) => r.startsWith('| FR-39')) ?? '';
    const utanProvfil = tabellrad.replace('test/config.test.ts', 'test/vy.test.ts');
    const andra = (b: BarandeRad, ny: string): string => bytUt(readme, b.rad, ny);
    const varianter: { namn: string; text: string; fynd: string[] }[] = [
      { namn: 'utan avsnittet', text: utanAvsnittet(readme), fynd: ['rubriken saknas'] },
      { namn: 'rubriken två gånger', text: `${readme}\n${RUBRIK_72}\n`, fynd: ['rubriken står inte exakt en gång'] },
      {
        namn: 'avsnittet efter gränserna',
        text: `${utanAvsnittet(readme)}\n${avsnittsrader.join('\n')}\n`,
        fynd: ['rubriken står inte före gränserna för Etapp 2a'],
      },
      { namn: 'utan regeln', text: bytUt(readme, REGELN_72, ''), fynd: ['regeln står 0 gånger'] },
      {
        namn: 'regeln omskriven',
        text: bytUt(readme, REGELN_72, bytUt(REGELN_72, 'godtar bara', 'godtar')),
        fynd: ['regeln avviker'],
      },
      {
        namn: 'regeln utanför avsnittet',
        text: `${bytUt(readme, REGELN_72, '')}\n${REGELN_72}\n`,
        fynd: ['regeln står inte i avsnittet'],
      },
      ...[MENINGEN_72, ...MATNINGAR_72].flatMap((b) => [
        { namn: `utan ${b.namn}`, text: andra(b, ''), fynd: [`${b.namn} står 0 gånger`] },
        ...b.delar.map((del) => ({
          namn: `${b.namn} utan «${del}»`,
          text: andra(b, bytUt(b.rad, del, '')),
          fynd: [`${b.namn} saknar «${del}»`],
        })),
        {
          namn: `${b.namn} omskriven med alla delar kvar`,
          text: andra(b, bytUt(b.rad, b.nekas, `${b.nekas}inte `)),
          fynd: [`${b.namn} avviker`],
        },
      ]),
      {
        namn: 'mätningen utan numrering',
        text: andra(MATNING_SERVE_72, MATNING_SERVE_72.rad.replace(/^\d+\. /, '')),
        fynd: ['`tailscale serve status` står inte på en numrerad rad med 127.0.0.1'],
      },
      {
        namn: 'mätningen utan 127.0.0.1',
        text: andra(MATNING_SS_72, bytUt(MATNING_SS_72.rad, ' 127.0.0.1', '')),
        fynd: ['`ss -ltnp` står inte på en numrerad rad med 127.0.0.1'],
      },
      { namn: 'utan en tabellrad', text: bytUt(readme, tabellrad, ''), fynd: ['3 rader börjar med | FR-39'] },
      {
        namn: 'tabellrad utan provfilen',
        text: bytUt(readme, tabellrad, utanProvfil),
        fynd: [`rad utan provfilen: ${utanProvfil}`],
      },
    ];
    expect(varianter.map((v) => ({ namn: v.namn, fynd: readmefel(v.text) }))).toEqual(
      varianter.map((v) => ({ namn: v.namn, fynd: v.fynd })),
    );
  });
});
