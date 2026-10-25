// FR-20, B-17 punkten Nattsviten, Story 10.5.
// Kör adapter/nattsviten.py som barnprocess: domen genom en drivrutin, och hela skriptet med en fejkad npm,
// ett fejkat larmprogram och en fejkad processkatalog. GRON kräver körda prov, en körning som inte kom fram
// till någon Tests-rad är KUNDE_INTE, fallerade prov är ROD och larmar, och förkontrollerna ger KUNDE_INTE
// utan att npm startas. Varje värld ligger i tmpdir() med provets attrapper först i barnprocessens sökväg,
// och testdatabasens port är en lyssnare på loopback i provets egen process. Modulen förs in i nattskriptet
// som förkrav i drift. Inget fall startar systemets npm eller ett riktigt larm, och inget fall rör ~/.hermes.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, type AddressInfo, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Barnprocess, attrapper och städning: test/linearvakt.test.ts och test/spegelleverans.test.ts.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const MODULEN = path.join(ADAPTERN, 'nattsviten.py');

interface Processutfall { kod: number; ut: string; fel: string }
interface Varld { hem: string; bin: string; proc: string; katalog: string; larm: string }
interface Dom { utfall: string; kod: number; rader: string[] }

// Provets egna kopior av modulens fasta rader (Dev Notes → Modulen, Raderna).
const GRONRAD = (n: number): string => `GRON: nattsviten korde ${n} prov och inget fallerade`;
const RODRAD = (f: number, ff: number, k: number): string =>
  `ROD: nattsviten fallerade (${f} fallerade prov, ${ff} fallerade provfiler, kod ${k})`;
const KUNDE_INTE_RAD = (skal: string): string => `KUNDE_INTE: nattsviten kunde inte koras: ${skal}`;
const LARMFEL = (k: number): string => `LARM: larmet gick inte fram (kod ${k})`;
const ANROPSRAD = 'KUNDE_INTE: anropet gar inte att tolka: --katalog <katalog> --larm <program> '
  + '[--proc <katalog>] [--dbport <port>] [--tidsgrans <sekunder>]';
const STANNADE = (namn: string): string => `KUNDE_INTE: nattsviten stannade: ${namn}`;

function textrader(rader: readonly string[]): string { return `${rader.join('\n')}\n`; }
// Markörerna för barnprocessernas egen utskrift: ingen av dem får nå nattsvitens stdout eller stderr
// (invariant 4). npm skriver sin i UT_ROD och, i F5, på stderr; larmet skriver sin på stdout och stderr.
const NPM_HEMLIGHET = 'provets-hemlighet';
const LARMETS_HEMLIGHET = 'larmets-hemlighet';
// Vitests standardrapport utan färgkoder; klockslaget skrivs med punkt.
const UT_GRON = textrader([
  ' RUN  v3.2.4 /opt/arenden', '', ' ✓ prov (12 tests) 812ms', '', ' Test Files  1 passed (1)',
  '      Tests  12 passed (12)', '   Start at  02.00.01', '   Duration  1.20s',
]);
const UT_ROD = textrader([
  ' RUN  v3.2.4 /opt/arenden', '', ' ✗ prov (12 tests | 2 failed) 812ms', NPM_HEMLIGHET, '',
  ' Test Files  1 failed (1)', '      Tests  2 failed | 10 passed (12)', '   Start at  02.00.01',
  '   Duration  1.20s',
]);
// npm:s egna rader när skriptet test inte hittar vitest: ingen Tests-rad.
const UT_STARTFEL = textrader(['> arenden@1.0.0 test', '> vitest run', '', 'sh: 1: vitest: not found']);

async function skrivProgram(fil: string, rader: readonly string[]): Promise<void> {
  await writeFile(fil, textrader(['#!/bin/sh', ...rader]));
  await chmod(fil, 0o755);
}
// Larmprogrammet läser stdin till slut, skriver varje argument på en egen rad till en fil i världen och sin
// markör på stdout och stderr, och avslutar med kod. Med domens rad som enda argument blir filen exakt den
// raden, och ett argument till blir en rad till. Ärvde det nattsvitens stdin, väntade det på provets rör.
async function larmprogram(v: Pick<Varld, 'bin'>, kod: number): Promise<void> {
  await skrivProgram(path.join(v.bin, 'larm'), [
    'cat > /dev/null',
    'printf \'%s\\n\' "$@" >> "$HOME/larm-rader"',
    `printf '%s\\n' ${LARMETS_HEMLIGHET}`,
    `printf '%s\\n' ${LARMETS_HEMLIGHET} >&2`,
    `exit ${kod}`,
  ]);
}

const varldar: string[] = [];
async function nyVarld(): Promise<Varld> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-nattsviten-'));
  varldar.push(hem);
  const bin = path.join(hem, 'bin');
  const v = {
    hem, bin, proc: path.join(hem, 'proc'), katalog: path.join(hem, 'arenden'), larm: path.join(bin, 'larm'),
  };
  for (const katalog of [v.bin, v.proc, v.katalog]) await mkdir(katalog);
  await larmprogram(v, 0);
  return v;
}
afterAll(async () => {
  await Promise.all(varldar.map((hem) => rm(hem, { recursive: true, force: true })));
});

function barnmiljo(v: Varld, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // Hela miljön är en tillåtelselista: riktiga HOME, NO_COLOR och FORCE_COLOR ärvs aldrig.
  // Attrapperna står först, så att systemets npm aldrig nås.
  return { PATH: v.bin + path.delimiter + (process.env.PATH ?? ''), HOME: v.hem, ...extra };
}

// -I isolerar importerna, -B hindrar __pycache__ i adapter/. Kod 3 skiljer en krasch från domens koder.
const DRIVER = [
  'import json, sys, traceback',
  'try:',
  '    sys.path.insert(0, sys.argv[1])',
  '    import nattsviten as n',
  '    operation = sys.argv[2]',
  '    if operation == "doma":',
  '        with open(sys.argv[4], encoding="utf-8") as fil:',
  '            text = fil.read()',
  '        d = n.doma(int(sys.argv[3]), text)',
  '        print(json.dumps({"utfall": d.utfall, "kod": d.kod, "rader": list(d.rader)}))',
  '    elif operation == "kor_npm":',
  '        if sys.argv[6:] == ["utan_kommando"]:',
  '            n.KOMMANDO = ("nattsviten-saknat-kommando", "test")',
  '        kod, text = n.kor_npm(sys.argv[3], float(sys.argv[4]), float(sys.argv[5]))',
  '        print(json.dumps({"kod": kod, "text": text}))',
  // kor_larm sätter fristen och anropar n.kor_larm med tidsgränsen; FRIST_S läses vid anropet.
  '    elif operation == "kor_larm":',
  '        n.FRIST_S = float(sys.argv[6])',
  '        print(json.dumps({"kod": n.kor_larm(sys.argv[3], sys.argv[4], float(sys.argv[5]))}))',
  // databasfragan och anropen kör huvud med modulens fyra vägar ut ur processen (vitest_pagar,
  // databasen_svarar, kor_npm och kor_larm) utbytta mot ersättare som antecknar sina argument. Ingen
  // processkatalog läses, ingen fråga lämnar processen, och varken npm eller larmet startas. kor_npm svarar
  // med ett fallerat prov, så att larmet nås. databasfragan svarar nej från databasen och ger frågorna;
  // anropen svarar ja och ger varje anrop i ordning.
  '    elif operation in ("databasfragan", "anropen"):',
  '        import contextlib, io',
  '        anrop = []',
  '        def ersattare(namn, svar):',
  '            def ersattning(*argument):',
  '                anrop.append([namn, *argument])',
  '                return svar',
  '            return ersattning',
  '        n.vitest_pagar = ersattare("vitest_pagar", False)',
  '        n.databasen_svarar = ersattare("databasen_svarar", operation == "anropen")',
  '        n.kor_npm = ersattare("kor_npm", (1, "      Tests  1 failed (1)\\n"))',
  '        n.kor_larm = ersattare("kor_larm", 0)',
  '        utskrift = io.StringIO()',
  '        with contextlib.redirect_stdout(utskrift):',
  '            kod = n.huvud(sys.argv[3:])',
  '        svar = {"kod": kod, "rader": utskrift.getvalue().splitlines()}',
  '        if operation == "databasfragan":',
  '            svar["fragor"] = [a[1:] for a in anrop if a[0] == "databasen_svarar"]',
  '        else:',
  '            svar["anrop"] = anrop',
  '        print(json.dumps(svar))',
  '    else:',
  '        sys.exit(2)',
  '    sys.exit(0)',
  'except Exception:',
  '    traceback.print_exc()',
  '    sys.exit(3)',
].join('\n');
function arProcessfel(fel: unknown): fel is { code: number; stdout: string; stderr: string } {
  return typeof fel === 'object' && fel !== null
    && 'code' in fel && typeof fel.code === 'number'
    && 'stdout' in fel && typeof fel.stdout === 'string'
    && 'stderr' in fel && typeof fel.stderr === 'string';
}
async function korDrivern(v: Varld, argument: string[], extra?: Record<string, string>): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, ...argument],
      { cwd: ROT, env: barnmiljo(v, extra), timeout: 25_000 });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
async function korDoma(kod: number, text: string): Promise<Dom> {
  const v = await nyVarld();
  const fil = path.join(v.hem, 'utskrift');
  await writeFile(fil, text);
  const p = await korDrivern(v, ['doma', String(kod), fil]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as Dom;
}
function rader(ut: string): string[] {
  return ut.split(/\r?\n/).filter((rad) => rad.length > 0);
}

const gron = (n: number): Dom => ({ utfall: 'GRON', kod: 0, rader: [GRONRAD(n)] });
const rod = (f: number, ff: number, k: number): Dom => ({ utfall: 'ROD', kod: 1, rader: [RODRAD(f, ff, k)] });
const kundeInte = (skal: string): Dom => ({ utfall: 'KUNDE_INTE', kod: 2, rader: [KUNDE_INTE_RAD(skal)] });
type Fall = readonly [etikett: string, kod: number, text: string, vantat: Dom];
async function provaFall(fall: readonly Fall[]): Promise<void> {
  for (const [etikett, kod, text, vantat] of fall) {
    expect(await korDoma(kod, text), etikett).toEqual(vantat);
  }
}

describe('FR-20/Story 10.5 AK 1–3: domen över en körning', () => {
  it('F1 (AK 1): GRON när prov körts och inget fallerat', async () => {
    await provaFall([
      ['(a)', 0, UT_GRON, gron(12)],
      ['(b)', 0, '      Tests  3 passed | 1 skipped | 2 todo (6)\n', gron(3)],
      // Ordet failed står i ORDEN: noll fallerade prov i den prövade formen hindrar inte GRON.
      ['(c)', 0, '      Tests  0 failed | 5 passed (5)\n', gron(5)],
    ]);
  });

  it('F2 (AK 1): kod 0 utan körda prov är KUNDE_INTE, aldrig GRON', async () => {
    const ingenRad = kundeInte('ingen Tests-rad i utskriften (kod 0)');
    const form = kundeInte('Tests-raden har en okand form (kod 0)');
    await provaFall([
      ['(a)', 0, '', ingenRad],
      ['(b)', 0, ' Test Files  2 passed (2)\n', ingenRad],
      ['(c)', 0, '      Tests  4 skipped (4)\n', kundeInte('inga prov korda (kod 0)')],
      // En Tests-rad som inte har formen TESTSRAD; kontrollen är F4 (j), skild bara i koden.
      ['(d)', 0, '      Tests  no tests\n', form],
      ['(e)', 0, UT_GRON + '      Tests  12 passed (12)\n', kundeInte('2 Tests-rader i utskriften (kod 0)')],
      ['(f)', 0, '      Tests  2 passed (3)\n', form],
      ['(g)', 0, '      Tests  2 passed | 1 passed (3)\n', form],
      ['(h)', 0, '      Tests  2 passed | 1 expected (3)\n', form],
      // Utan summan inom parentes matchar raden inte TESTSRAD.
      ['(i)', 0, '      Tests  5 passed\n', form],
      // Text efter summan: formen slutar vid parentesen (TESTSRAD:s slut). Kontrollen tillåter bara blanktecken.
      ['(j)', 0, '      Tests  5 passed (5) x\n', form],
      ['kontroll (j)', 0, '      Tests  5 passed (5)   \n', gron(5)],
      // Kontroll: F1 (a), exakt en Tests-rad i formen.
      ['kontroll', 0, UT_GRON, gron(12)],
    ]);
  });

  it('F3 (AK 2): en körning som inte kom fram till proven är KUNDE_INTE, aldrig ROD', async () => {
    const ingenRad = kundeInte('ingen Tests-rad i utskriften (kod 1)');
    await provaFall([
      ['(a)', 1, '', ingenRad],
      ['(b)', 1, UT_STARTFEL, ingenRad],
      ['(c)', 127, '', kundeInte('npm test startade inte (kod 127)')],
      ['(d)', 124, UT_ROD, kundeInte('npm test avbrots innan sviten var klar (kod 124)')],
      ['(e)', 137, '', kundeInte('npm test avbrots innan sviten var klar (kod 137)')],
      // Dödad av en signal: koden kommer till drivrutinen som texten '-15'.
      ['(f)', -15, UT_ROD, kundeInte('npm test avbrots innan sviten var klar (kod -15)')],
      // Första ordet är Testsvit, inte Tests (ordgränsen).
      ['(g)', 1, '      Testsvit  1 failed (1)\n', ingenRad],
      // Ordet Tests står inte först på raden (ankaret).
      ['(h)', 1, 'npm error Tests  1 failed (1)\n', ingenRad],
      // En Test Files-rad är ingen Tests-rad.
      ['(i)', 1, ' Test Files  2 failed (2)\n', ingenRad],
      // Kontroller: F4 (a) med en Tests-rad, och F4 (j) där raden börjar med ordet Tests.
      ['kontroll (a)', 1, UT_ROD, rod(2, 1, 1)],
      ['kontroll (j)', 1, '      Tests  no tests\n', rod(0, 0, 1)],
    ]);
  });

  it('F4 (AK 3): vitest startade och dömde körningen som fallerad, och då blir det ROD', async () => {
    await provaFall([
      ['(a)', 1, UT_ROD, rod(2, 1, 1)],
      ['(b)', 1, '      Tests  1 failed (1)\n', rod(1, 0, 1)],
      // Ett fallerat prov ger ROD också vid kod 0.
      ['(c)', 0, '      Tests  1 failed | 3 passed (4)\n', rod(1, 0, 0)],
      // Vitest startade och avslutade med 1 fast inget fallerade (regel 5).
      ['(d)', 1, '      Tests  5 passed (5)\n', rod(0, 0, 1)],
      // Ett okänt ord fäller formen, men det fallerade provet prövas före formen (regel 4).
      ['(e)', 1, '      Tests  2 failed | 1 expected (3)\n', rod(2, 0, 1)],
      ['(f)', 0, '      Tests  1 failed | 1 failed (2)\n', rod(2, 0, 0)],
      ['(g)', 0, UT_GRON + '      Tests  1 failed (1)\n', rod(1, 0, 0)],
      ['(i)', 0, ' Test Files  1 failed | 2 passed (3)\n      Tests  5 passed (5)\n', rod(0, 1, 0)],
      ['(j)', 1, '      Tests  no tests\n', rod(0, 0, 1)],
      ['(k)', 1, ' Test Files  3 failed (3)\n      Tests  no tests\n', rod(0, 3, 1)],
      ['(l)', 0, '      Tests  2 failed | 10 passed\n', rod(2, 0, 0)],
      ['(m)', 0, ' Test Files  1 failed\n      Tests  5 passed (5)\n', rod(0, 1, 0)],
      // Kontroll: skild från (d) bara i koden och från (i) och (m) i att Test Files-raden saknas.
      ['(h)', 0, '      Tests  5 passed (5)\n', gron(5)],
      // FILMARKE har samma ankare och ordgräns som TESTSMARKE (F3 (g) och (h)): en rad där något annat än
      // blanktecken står före orden, eller där ordet fortsätter, är ingen Test Files-rad. Kontrollen är (i).
      ['(n)', 0, 'npm error Test Files  1 failed (1)\n      Tests  5 passed (5)\n', gron(5)],
      ['(o)', 0, ' Test Filesystem  1 failed (1)\n      Tests  5 passed (5)\n', gron(5)],
    ]);
  });
});

// ---- Uppgift 2: förkontrollen, npm med tidsgräns, larmet och skriptet ------------------------------

// npm-attrappen läser stdin till slut, antecknar katalogen, argumenten, NO_COLOR och FORCE_COLOR och svarar
// med världens felutskrift på stderr, utskrift på stdout och kod. Ärvde den nattsvitens stdin, väntade den
// på provets rör.
async function falskNpm(v: Varld, utskrift: string | Buffer, kod: number, felutskrift = ''): Promise<void> {
  await writeFile(path.join(v.hem, 'npm-utskrift'), utskrift);
  await writeFile(path.join(v.hem, 'npm-felutskrift'), felutskrift);
  await writeFile(path.join(v.hem, 'npm-kod'), String(kod));
  await skrivProgram(path.join(v.bin, 'npm'), [
    'cat > /dev/null',
    'printf \'%s\\n\' "$(pwd -P)" "$*" "${NO_COLOR-saknas}" "${FORCE_COLOR-saknas}" > "$HOME/npm-anrop"',
    'cat "$HOME/npm-felutskrift" >&2',
    'cat "$HOME/npm-utskrift"',
    'exit "$(cat "$HOME/npm-kod")"',
  ]);
}
// Ett program som aldrig svarar. Med ignoreraTerm ärver sleep att SIGTERM ignoreras genom exec.
async function segtProgram(fil: string, ignoreraTerm: boolean): Promise<void> {
  await skrivProgram(fil, [...(ignoreraTerm ? ["trap '' TERM"] : []), 'exec sleep 30']);
}
async function segNpm(v: Varld, ignoreraTerm: boolean): Promise<void> {
  await segtProgram(path.join(v.bin, 'npm'), ignoreraTerm);
}
// Ett larm som klarar förkontrollen (en absolut sökväg till en körbar fil) men inte går att starta: tolken i
// dess shebang saknas, så exec ger ENOENT och Popen kastar FileNotFoundError.
async function larmUtanTolk(v: Varld): Promise<void> {
  await writeFile(v.larm, textrader([`#!${path.join(v.hem, 'saknad-tolk')}`, 'exit 0']));
  await chmod(v.larm, 0o755);
}
// En post i provets processkatalog, i samma form som /proc/<pid>/cmdline. Ett argument som Buffer skrivs
// byte för byte, också när det inte är UTF-8.
async function procPost(v: Varld, namn: number | string, argv: readonly (string | Buffer)[]): Promise<void> {
  const katalog = path.join(v.proc, String(namn));
  await mkdir(katalog);
  const delar = argv.flatMap((a) => [typeof a === 'string' ? Buffer.from(a) : a, Buffer.from([0])]);
  await writeFile(path.join(katalog, 'cmdline'), Buffer.concat(delar));
}
// Lyssnaren tar emot anslutningen och stänger den direkt, utan att skicka något. Den är ingen attrapp av
// en tjänst, och stang väntar aldrig på en öppen anslutning.
async function lyssnare(): Promise<{ port: number; server: Server }> {
  const server = createServer((s) => s.destroy());
  await new Promise<void>((klar, fel) => {
    server.once('error', fel);
    server.listen(0, '127.0.0.1', () => klar());
  });
  return { port: (server.address() as AddressInfo).port, server };
}
async function stang(server: Server): Promise<void> {
  await new Promise<void>((klar) => server.close(() => klar()));
}
// En port som provet just lyssnat på och stängt: en testdatabas som inte svarar.
async function stangdPort(): Promise<number> {
  const { port, server } = await lyssnare();
  await stang(server);
  return port;
}
async function korSkriptet(v: Varld, argument: string[], extra?: Record<string, string>): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', MODULEN, ...argument],
      { cwd: ROT, env: barnmiljo(v, extra), timeout: 25_000 });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
async function npmAnrop(v: Varld): Promise<string[]> {
  return rader(await readFile(path.join(v.hem, 'npm-anrop'), 'utf8'));
}
function npmAnropFinns(v: Varld): boolean {
  return existsSync(path.join(v.hem, 'npm-anrop'));
}
async function larmrader(v: Varld): Promise<string[]> {
  const fil = path.join(v.hem, 'larm-rader');
  return existsSync(fil) ? rader(await readFile(fil, 'utf8')) : [];
}
// Standardanropet, med ett eller flera värden utbytta på sin plats.
type Namn = '--katalog' | '--larm' | '--proc' | '--dbport';
function standardanrop(v: Varld, port: number, byt: Partial<Record<Namn, string>> = {}): string[] {
  const varden: Record<Namn, string> = {
    '--katalog': v.katalog, '--larm': v.larm, '--proc': v.proc, '--dbport': String(port), ...byt,
  };
  return Object.entries(varden).flat();
}
type Forberedelse = (v: Varld) => Promise<string[]>;

describe('FR-20/Story 10.5 AK 1–4: nattsviten som skript', () => {
  let port = 0;
  let server: Server | undefined;
  beforeAll(async () => {
    ({ port, server } = await lyssnare());
  });
  afterAll(async () => {
    if (server) await stang(server);
  });

  it('F5 (AK 1, 2, 3): hela skriptet ger rätt utfall, exitkod och larm', async () => {
    type Larmet = number | 'utan tolk';
    const fall: readonly (readonly [string, string | Buffer, number, Larmet, number, string[], string[]])[] = [
      // [etikett, npm:s utskrift, npm:s kod, larmets kod eller 'utan tolk', skriptets kod, rader, larmrader]
      ['(a)', UT_GRON, 0, 0, 0, [GRONRAD(12)], []],
      ['(b)', '', 0, 0, 2, [KUNDE_INTE_RAD('ingen Tests-rad i utskriften (kod 0)')], []],
      ['(c)', UT_STARTFEL, 1, 0, 2, [KUNDE_INTE_RAD('ingen Tests-rad i utskriften (kod 1)')], []],
      ['(d)', UT_ROD, 1, 0, 1, [RODRAD(2, 1, 1)], [RODRAD(2, 1, 1)]],
      ['(e)', UT_ROD, 1, 3, 1, [RODRAD(2, 1, 1), LARMFEL(3)], [RODRAD(2, 1, 1)]],
      // Kontroll för (c), skild bara i att npm ger kod 0 och UT_GRON.
      ['(f)', UT_GRON, 0, 0, 0, [GRONRAD(12)], []],
      ['(g)', '      Tests  5 passed (5)\n', 1, 0, 1, [RODRAD(0, 0, 1)], [RODRAD(0, 0, 1)]],
      ['(h)', ' Test Files  2 failed (2)\n      Tests  no tests\n', 1, 0, 1,
        [RODRAD(0, 2, 1)], [RODRAD(0, 2, 1)]],
      // Ett larm som klarar förkontrollen men inte går att starta: natten står kvar som ROD med kod 1, och
      // raden LARMFEL bär startfelet 127. Kontrollen är (d), skild bara i larmprogrammets tolk.
      ['(i)', UT_ROD, 1, 'utan tolk', 1, [RODRAD(2, 1, 1), LARMFEL(127)], []],
      // En byte som inte är UTF-8 i npm:s utskrift avkodas med ersättningstecken i kor_npm, så natten döms
      // som vanligt. Kontrollen är (a), skild bara i den sista raden.
      ['(j)', Buffer.concat([Buffer.from(UT_GRON), Buffer.from([0xff, 0x0a])]), 0, 0, 0, [GRONRAD(12)], []],
    ];
    for (const [etikett, utskrift, npmkod, larmet, kod, vantat, larm] of fall) {
      const v = await nyVarld();
      if (larmet === 'utan tolk') await larmUtanTolk(v);
      else await larmprogram(v, larmet);
      // npm skriver sin markör också på stderr; larmet skriver sin på stdout och stderr.
      await falskNpm(v, utskrift, npmkod, textrader([NPM_HEMLIGHET]));
      const p = await korSkriptet(v, standardanrop(v, port));
      expect({ kod: p.kod, rader: rader(p.ut), fel: p.fel, larm: await larmrader(v) }, etikett)
        .toEqual({ kod, rader: vantat, fel: '', larm });
      // Barnprocessernas utskrift förs aldrig vidare, varken npm:s eller larmets, på stdout eller stderr
      // (invariant 4). Raderna ovan är exakt domens.
      for (const hemlighet of [NPM_HEMLIGHET, LARMETS_HEMLIGHET]) {
        expect(p.ut, `${etikett} stdout`).not.toContain(hemlighet);
        expect(p.fel, `${etikett} stderr`).not.toContain(hemlighet);
      }
    }
  });

  it('F6 (AK 1): anropet är exakt npm test i katalogen, utan färgkoder', async () => {
    const v = await nyVarld();
    await falskNpm(v, UT_GRON, 0);
    const p = await korSkriptet(v, standardanrop(v, port), { FORCE_COLOR: '1' });
    expect(p.kod).toBe(0);
    expect(await npmAnrop(v)).toEqual([await realpath(v.katalog), 'test', '1', 'saknas']);
  });

  it('F7 (AK 4, AK 3): förkontrollerna ger KUNDE_INTE, och npm startas aldrig', async () => {
    const saknas = (v: Varld): string => path.join(v.hem, 'finns-inte');
    const pagaendeVitest = (v: Varld, pid: number): Promise<void> =>
      procPost(v, pid, ['node', '/opt/arenden/node_modules/.bin/vitest', 'run']);
    const fall: readonly (readonly [string, Forberedelse, string])[] = [
      ['(a)', async (v) => standardanrop(v, port, { '--katalog': saknas(v) }), 'katalogen saknas'],
      ['(b)', async (v) => {
        const fil = path.join(v.hem, 'vanlig-fil');
        await writeFile(fil, 'x\n');
        return standardanrop(v, port, { '--katalog': fil });
      }, 'katalogen saknas'],
      ['(c)', async (v) => {
        await pagaendeVitest(v, 4711);
        return standardanrop(v, port);
      }, 'en vitest-korning pagar redan'],
      ['(d)', async (v) => {
        await procPost(v, 4712, ['node', '/opt/arenden/node_modules/vitest/vitest.mjs', 'run']);
        return standardanrop(v, port);
      }, 'en vitest-korning pagar redan'],
      ['(e)', async (v) => standardanrop(v, port, { '--dbport': String(await stangdPort()) }),
        'testdatabasen svarar inte'],
      // Alla tre fel samtidigt, som (a), (c) och (e): katalogen prövas först.
      ['(f)', async (v) => {
        await pagaendeVitest(v, 4711);
        return standardanrop(v, port, { '--katalog': saknas(v), '--dbport': String(await stangdPort()) });
      }, 'katalogen saknas'],
      ['(h)', async (v) => standardanrop(v, port, { '--larm': path.join(v.bin, 'finns-inte') }),
        'larmprogrammet gar inte att starta'],
      ['(i)', async (v) => {
        const fil = path.join(v.bin, 'larm-utan-korratt');
        await writeFile(fil, '#!/bin/sh\nexit 0\n');
        await chmod(fil, 0o644);
        return standardanrop(v, port, { '--larm': fil });
      }, 'larmprogrammet gar inte att starta'],
      // Samma körbara fil som v.larm, relativt barnprocessens arbetskatalog: bara kravet på en absolut
      // sökväg fäller den. Kontrollen för (h)–(j) är F5 (a).
      ['(j)', async (v) => standardanrop(v, port, { '--larm': path.relative(ROT, v.larm) }),
        'larmprogrammet gar inte att starta'],
      // Ordningen efter katalogen ((f)): larmprogrammet före en pågående vitest och databasen, och en
      // pågående vitest före databasen.
      ['(k)', async (v) => {
        await pagaendeVitest(v, 4711);
        return standardanrop(v, port, {
          '--larm': path.join(v.bin, 'finns-inte'), '--dbport': String(await stangdPort()),
        });
      }, 'larmprogrammet gar inte att starta'],
      ['(l)', async (v) => {
        await pagaendeVitest(v, 4711);
        return standardanrop(v, port, { '--dbport': String(await stangdPort()) });
      }, 'en vitest-korning pagar redan'],
      // Ett argument som inte är UTF-8 avkodas med ersättningstecken, och dess sista led är vitest.
      ['(m)', async (v) => {
        const vitest = Buffer.concat([
          Buffer.from('/opt/'), Buffer.from([0xff]), Buffer.from('/node_modules/.bin/vitest'),
        ]);
        await procPost(v, 4715, ['node', vitest, 'run']);
        return standardanrop(v, port);
      }, 'en vitest-korning pagar redan'],
      // En katalog är ingen vanlig fil, fast den har en absolut sökväg och får genomsökas (os.path.isfile).
      ['(r)', async (v) => standardanrop(v, port, { '--larm': v.bin }), 'larmprogrammet gar inte att starta'],
      // Katalogen före larmprogrammet: (f) har inget larmfel.
      ['(s)', async (v) => standardanrop(v, port, {
        '--katalog': saknas(v), '--larm': path.join(v.bin, 'finns-inte'),
      }), 'katalogen saknas'],
    ];
    for (const [etikett, forbered, skal] of fall) {
      const v = await nyVarld();
      await falskNpm(v, UT_GRON, 0);
      const p = await korSkriptet(v, await forbered(v));
      expect({ kod: p.kod, rader: rader(p.ut), npm: npmAnropFinns(v) }, etikett)
        .toEqual({ kod: 2, rader: [KUNDE_INTE_RAD(skal)], npm: false });
    }
    const kontroller: readonly (readonly [string, (v: Varld) => Promise<void>])[] = [
      // (g) Kontroll, skild bara i processerna: ingen av dem räknas som en pågående vitest.
      ['(g)', async (v) => {
        await procPost(v, 4713, ['sh', '-c', 'vitest run']);
        await procPost(v, 4714, ['node', '/opt/arenden/vitest-hjalp']);
        await procPost(v, 'self', ['vitest']);
      }],
      // (n) En process som avslutades mellan listningen och läsningen: posten saknar cmdline och hoppas över.
      ['(n)', async (v) => { await mkdir(path.join(v.proc, '4716')); }],
    ];
    for (const [etikett, forbered] of kontroller) {
      const v = await nyVarld();
      await falskNpm(v, UT_GRON, 0);
      await forbered(v);
      const p = await korSkriptet(v, standardanrop(v, port));
      expect({ kod: p.kod, rader: rader(p.ut), npm: npmAnropFinns(v) }, etikett)
        .toEqual({ kod: 0, rader: [GRONRAD(12)], npm: true });
    }
  });

  it('F7 (AK 4): förkontrollen frågar samma testdatabas som sviten', async () => {
    // (o) Värden ur TEST_PG_HOST, som i test/env.ts rad 15. Lyssnaren svarar bara på 127.0.0.1, så samma
    //     port på 127.0.0.2 är en testdatabas som inte svarar. Kontrollen är (p), skild bara i värden.
    const o = await nyVarld();
    await falskNpm(o, UT_GRON, 0);
    const po = await korSkriptet(o, standardanrop(o, port), { TEST_PG_HOST: '127.0.0.2' });
    expect({ kod: po.kod, rader: rader(po.ut), npm: npmAnropFinns(o) }, '(o)')
      .toEqual({ kod: 2, rader: [KUNDE_INTE_RAD('testdatabasen svarar inte')], npm: false });
    const pv = await nyVarld();
    await falskNpm(pv, UT_GRON, 0);
    const pp = await korSkriptet(pv, standardanrop(pv, port), { TEST_PG_HOST: '127.0.0.1' });
    expect({ kod: pp.kod, rader: rader(pp.ut), npm: npmAnropFinns(pv) }, '(p)')
      .toEqual({ kod: 0, rader: [GRONRAD(12)], npm: true });

    // (q) Frågan som huvud ställer, genom drivrutinens databasfragan: databasen_svarar är utbytt, så ingen
    //     fråga lämnar processen. Anropet saknar --dbport utom där det står. Värdena är adresser på
    //     loopback, så att ingen fråga kan gå till ett namn.
    const adresser: readonly (readonly [string, Record<string, string>, string[], [string, number][]])[] = [
      // [etikett, miljön, extra argument, frågorna till databasen]
      ['inga variabler: standardvärdena i test/env.ts', {}, [], [['127.0.0.1', 5436]]],
      ['TEST_PG_PORT', { TEST_PG_PORT: '5999' }, [], [['127.0.0.1', 5999]]],
      ['TEST_PG_HOST', { TEST_PG_HOST: '127.0.0.9' }, [], [['127.0.0.9', 5436]]],
      ['båda, och --dbport före TEST_PG_PORT', { TEST_PG_HOST: '127.0.0.9', TEST_PG_PORT: '5999' },
        ['--dbport', '4711'], [['127.0.0.9', 4711]]],
      ['den högsta porten', { TEST_PG_PORT: '65535' }, [], [['127.0.0.1', 65535]]],
      // Som ?? i test/env.ts får ett tomt värde inget standardvärde, och sviten når då ingen databas. Ingen
      // fråga ställs, och skälet är databasens.
      ['tom port', { TEST_PG_PORT: '' }, [], []],
      ['tom värd', { TEST_PG_HOST: '' }, [], []],
      ['en port som inte är ett tal', { TEST_PG_PORT: 'abc' }, [], []],
      ['en upphöjd siffra', { TEST_PG_PORT: String.fromCharCode(0xb2) }, [], []],
      ['en inledande nolla', { TEST_PG_PORT: '05436' }, [], []],
      ['porten 0', { TEST_PG_PORT: '0' }, [], []],
      ['porten 65536', { TEST_PG_PORT: '65536' }, [], []],
    ];
    for (const [etikett, miljo, extra, fragor] of adresser) {
      const v = await nyVarld();
      await falskNpm(v, UT_GRON, 0);
      const p = await korDrivern(v, ['databasfragan', '--katalog', v.katalog, '--larm', v.larm, '--proc', v.proc,
        ...extra], miljo);
      if (p.kod !== 0) throw new Error(p.fel);
      expect({ ...(JSON.parse(p.ut) as object), npm: npmAnropFinns(v) }, `(q) ${etikett}`).toEqual({
        kod: 2, rader: [KUNDE_INTE_RAD('testdatabasen svarar inte')], fragor, npm: false,
      });
    }
  });

  it('F9 (AK 1–3): ett anrop som inte går att tolka, och en krasch, ger KUNDE_INTE med kod 2', async () => {
    const fall: readonly (readonly [string, Forberedelse, string])[] = [
      ['(a)', async () => [], ANROPSRAD],
      ['(b)', async (v) => ['--katalog', v.katalog], ANROPSRAD],
      ['(c)', async (v) => standardanrop(v, port, { '--dbport': 'abc' }), ANROPSRAD],
      ['(d)', async (v) => [...standardanrop(v, port), '--annat', 'x'], ANROPSRAD],
      ['(e)', async (v) => {
        const fil = path.join(v.hem, 'vanlig-fil');
        await writeFile(fil, 'x\n');
        return standardanrop(v, port, { '--proc': fil });
      }, STANNADE('NotADirectoryError')],
      // Siffran två i upphöjd form: str.isdigit() godtar den, men int() tar den inte.
      ['(f) upphöjd siffra', async (v) => standardanrop(v, port, { '--dbport': String.fromCharCode(0xb2) }),
        ANROPSRAD],
      ['(f) porten 0', async (v) => standardanrop(v, port, { '--dbport': '0' }), ANROPSRAD],
      ['(f) tidsgränsen 0', async (v) => [...standardanrop(v, port), '--tidsgrans', '0'], ANROPSRAD],
      // Varje regel i tolkningen fäller ett eget anrop, som bara den regeln fäller. Ett namn utan värde sist
      // ger ett udda antal argument.
      ['(g) ett namn utan värde sist', async (v) => [...standardanrop(v, port), '--tidsgrans'], ANROPSRAD],
      ['(h) ett namn två gånger', async (v) => [...standardanrop(v, port), '--katalog', v.katalog], ANROPSRAD],
      // Ett namn utan värde före nästa namn, som då står som dess värde.
      ['(i) --katalog följt av --larm', async (v) =>
        ['--katalog', '--larm', '--larm', v.larm, '--proc', v.proc, '--dbport', String(port)], ANROPSRAD],
      ['(i) --katalog följt av --proc', async (v) =>
        ['--larm', v.larm, '--katalog', '--proc', '--proc', v.proc, '--dbport', String(port)], ANROPSRAD],
      ['(j) ett tomt värde efter --proc', async (v) => standardanrop(v, port, { '--proc': '' }), ANROPSRAD],
      ['(j) ett tomt värde efter --katalog', async (v) => standardanrop(v, port, { '--katalog': '' }), ANROPSRAD],
    ];
    for (const [etikett, forbered, rad] of fall) {
      const v = await nyVarld();
      await falskNpm(v, UT_GRON, 0);
      const p = await korSkriptet(v, await forbered(v));
      expect({ kod: p.kod, rader: rader(p.ut), fel: p.fel, npm: npmAnropFinns(v) }, etikett)
        .toEqual({ kod: 2, rader: [rad], fel: '', npm: false });
    }
  });

  it('F9 (AK 1–4): varje värde i anropet når sin användning, och ett namn som saknas ger sitt standardvärde',
    async () => {
      // Anropsspåret: drivrutinens anropen kör huvud med modulens fyra vägar ut ur processen utbytta mot
      // ersättare som antecknar sina argument, så att ingen processkatalog läses, ingen fråga ställs och varken
      // npm eller larmet startas. Varje valfritt namn prövas angivet och utelämnat, och hela spåret jämförs:
      // ett värde som inte förs vidare, ett standardvärde i stället för det angivna eller ett värde som når
      // fel anrop fäller sitt fall. Standardvärdena är modulens PROC, DB_VARD och DB_PORT (som test/env.ts)
      // och TIDSGRANS_S. Larmet anropas med domens rad som enda argument och med sin egen tidsgräns.
      const rodrad = RODRAD(1, 0, 1);
      type Anrop = (string | number)[];
      const spar = (v: Varld, proc: string, port: number, tidsgrans: number): Anrop[] => [
        ['vitest_pagar', proc], ['databasen_svarar', '127.0.0.1', port], ['kor_npm', v.katalog, tidsgrans],
        ['kor_larm', v.larm, rodrad],
      ];
      const krav = (v: Varld): string[] => ['--katalog', v.katalog, '--larm', v.larm];
      const fall: readonly (readonly [string, (v: Varld) => string[], (v: Varld) => Anrop[]])[] = [
        ['alla namn', (v) => [...standardanrop(v, 4711), '--tidsgrans', '2'], (v) => spar(v, v.proc, 4711, 2)],
        ['bara de två kraven', (v) => krav(v), (v) => spar(v, '/proc', 5436, 1800)],
        ['bara --proc', (v) => [...krav(v), '--proc', v.proc], (v) => spar(v, v.proc, 5436, 1800)],
        ['bara --dbport', (v) => [...krav(v), '--dbport', '4711'], (v) => spar(v, '/proc', 4711, 1800)],
        ['bara --tidsgrans', (v) => [...krav(v), '--tidsgrans', '2'], (v) => spar(v, '/proc', 5436, 2)],
      ];
      for (const [etikett, argument, vantat] of fall) {
        const v = await nyVarld();
        await falskNpm(v, UT_GRON, 0);
        const p = await korDrivern(v, ['anropen', ...argument(v)]);
        if (p.kod !== 0) throw new Error(p.fel);
        expect({ ...(JSON.parse(p.ut) as object), npm: npmAnropFinns(v), larm: await larmrader(v) }, etikett)
          .toEqual({ kod: 1, rader: [rodrad], anrop: vantat(v), npm: false, larm: [] });
      }
    });

  it('F8 (AK 2): tidsgränsen ur --tidsgrans når npm genom hela skriptet', async () => {
    // (f) en npm som aldrig svarar och --tidsgrans 2: SIGTERM efter 2 sekunder, inte efter TIDSGRANS_S.
    const f = await nyVarld();
    await segNpm(f, false);
    const t0 = Date.now();
    const pf = await korSkriptet(f, [...standardanrop(f, port), '--tidsgrans', '2']);
    expect(Date.now() - t0, '(f) tid').toBeLessThan(15_000);
    expect({ kod: pf.kod, rader: rader(pf.ut), larm: await larmrader(f) }, '(f)').toEqual({
      kod: 2, rader: [KUNDE_INTE_RAD('npm test avbrots innan sviten var klar (kod 124)')], larm: [],
    });
    // (g) kontroll, skild från (f) bara i att npm svarar: --tidsgrans 2 godtas, och natten blir GRON.
    const g = await nyVarld();
    await falskNpm(g, UT_GRON, 0);
    const pgron = await korSkriptet(g, [...standardanrop(g, port), '--tidsgrans', '2']);
    expect({ kod: pgron.kod, rader: rader(pgron.ut) }, '(g)').toEqual({ kod: 0, rader: [GRONRAD(12)] });
  });
});

describe('FR-20/Story 10.5 AK 2: barnprocessen kommer alltid tillbaka', () => {
  async function korNpm(v: Varld, ...lage: string[]): Promise<{ kod: number; text: string }> {
    const p = await korDrivern(v, ['kor_npm', v.katalog, '2', '2', ...lage]);
    if (p.kod !== 0) throw new Error(p.fel);
    return JSON.parse(p.ut) as { kod: number; text: string };
  }
  // Larmet med domens rad som enda argument, tidsgränsen 2 och fristen 2 sekunder.
  async function korLarm(v: Varld): Promise<{ kod: number }> {
    const p = await korDrivern(v, ['kor_larm', v.larm, RODRAD(2, 1, 1), '2', '2']);
    if (p.kod !== 0) throw new Error(p.fel);
    return JSON.parse(p.ut) as { kod: number };
  }

  it('F8 (AK 2): barnprocessen kommer tillbaka, och tidsgränsen ger KUNDE_INTE', async () => {
    // (a) en npm som sover i 30 sekunder: SIGTERM vid tidsgränsen
    const a = await nyVarld();
    await segNpm(a, false);
    const t0 = Date.now();
    expect(await korNpm(a), '(a)').toEqual({ kod: 124, text: '' });
    expect(Date.now() - t0).toBeLessThan(15_000);
    // (b) samma med trap '' TERM: SIGKILL först efter fristen
    const b = await nyVarld();
    await segNpm(b, true);
    const t1 = Date.now();
    expect(await korNpm(b), '(b)').toEqual({ kod: 137, text: '' });
    expect(Date.now() - t1).toBeLessThan(15_000);
    // (c) ett kommando som saknas. Attrappen står i världen, så att ett kor_npm som inte läser KOMMANDO
    //     vid anropet når attrappen och aldrig systemets npm.
    const c = await nyVarld();
    await falskNpm(c, UT_GRON, 0);
    expect(await korNpm(c, 'utan_kommando'), '(c)').toEqual({ kod: 127, text: '' });
    expect(npmAnropFinns(c)).toBe(false);
    // (d) kontroll, skild från (c) bara i att läget utan_kommando saknas
    const d = await nyVarld();
    await falskNpm(d, UT_GRON, 0);
    expect(await korNpm(d), '(d)').toEqual({ kod: 0, text: UT_GRON });
    // (e) npm:s stderr hamnar i samma anonyma fil som stdout, i skrivordningen, och aldrig hos nattsviten
    //     (invariant 4; F5 visar att skriptet aldrig skriver markören). Kontrollen är (d).
    const e = await nyVarld();
    await falskNpm(e, UT_GRON, 0, textrader([NPM_HEMLIGHET]));
    expect(await korNpm(e), '(e)').toEqual({ kod: 0, text: textrader([NPM_HEMLIGHET]) + UT_GRON });
  });

  it('F8 (AK 2, AK 3): larmet kommer tillbaka, och ett larm som inte går att starta ger 127', async () => {
    // Larmet startas genom samma kor_barnprocess som npm, och varje väg prövas här också från larmets sida.
    // (h) ett larm som sover i 30 sekunder: SIGTERM vid tidsgränsen
    const h = await nyVarld();
    await segtProgram(h.larm, false);
    const t0 = Date.now();
    expect(await korLarm(h), '(h)').toEqual({ kod: 124 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    // (i) samma med trap '' TERM: SIGKILL först efter fristen. Under 10 sekunder, eftersom fristen är
    //     FRIST_S vid anropet (2 här) och inget eget tal i kor_larm.
    const i = await nyVarld();
    await segtProgram(i.larm, true);
    const t1 = Date.now();
    expect(await korLarm(i), '(i)').toEqual({ kod: 137 });
    expect(Date.now() - t1).toBeLessThan(10_000);
    // (j) ett larm vars tolk saknas: startfelet 127, och larmet skrev ingen rad
    const j = await nyVarld();
    await larmUtanTolk(j);
    expect(await korLarm(j), '(j)').toEqual({ kod: 127 });
    expect(await larmrader(j), '(j) larmrader').toEqual([]);
    // (k) kontroll, skild från (j) bara i tolken och från (h) och (i) i att larmet avslutas: kod 0, och larmet
    //     fick domens rad som enda argument
    const k = await nyVarld();
    expect(await korLarm(k), '(k)').toEqual({ kod: 0 });
    expect(await larmrader(k), '(k) larmrader').toEqual([RODRAD(2, 1, 1)]);
  });
});
