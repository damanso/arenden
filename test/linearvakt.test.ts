// FR-33, NFR-11, ADR-0003, B-17 Linear-återfallsvakten, Story 10.8.
// Vakten läser cron-skript och moduler och fångar klientens nät innan något lämnar
// värden. Linear eller fel adress ger ROD; oläsbart underlag ger KUNDE_INTE.
// Egna hem i tmpdir(), crontab-attrapp först i PATH och repots klient som kopia.
// Systemets crontab, provvakten, riktiga ~/.hermes och valvet läses aldrig.
// Vakten kör inget cron-skript och skriver inget. Införandet görs utanför bygget.
import { execFile } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

// Barnprocess och städning: kopplingslasning.test.ts; attrapp: spegelleverans.test.ts.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const KLIENTKALLAN = path.join(ADAPTERN, 'arenden_klient.py');
const MODULEN = path.join(ADAPTERN, 'arende_linearvakt.py');
const ANROPSRAD = 'KUNDE_INTE: anropet gar inte att tolka: provet tar inga argument';
const VARD = '127.0.0.1';
const PORT = 3002;
const NATT_RADER = [
  'import json', 'import os', 'from hjalp import summa', 'import arenden_klient',
  'open(os.path.join(os.path.expanduser("~"), "kordes-natt"), "w").write("x")',
  'print(json.dumps(summa([1, 2])))',
];
const HJALP_RADER = [
  'import os', 'def summa(tal):', '    return sum(tal)',
  'open(os.path.join(os.path.expanduser("~"), "kordes-hjalp"), "w").write("x")',
];
const KVALL_RADER = ['#!/bin/sh', 'touch $HOME/kordes-kvall'];
const ATTRAPP_RADER = [
  '#!/bin/sh', '[ "$#" -eq 1 ] && [ "$1" = "-l" ] || exit 9',
  'exec cat "$HOME/crontab-fixtur"',
];
const VANTANDE_RADER = ['#!/bin/sh', 'exec sleep 30'];

interface Underlag {
  hem: string; bin: string; skills: string; crontab: string;
  natt: string; hjalp: string; kvall: string; klient: string;
}
interface Processutfall { kod: number; ut: string; fel: string }
interface Crontablage { text: string | null; fel: string | null }
type Kommando = [number, string[], string | null];
interface Skillslage { moduler: string[] | null; paket: string[] | null; fel: string | null }
interface Fil { sokvag: string; slag: string; via: string; traffar: number[] | null; fel: string | null }
interface Utovning {
  anrop: (string | number | null)[][]; status: string[]; fel: string | null; aterstallda: boolean;
}
const PLATTFORMSANROP = ['urlopen', 'http', VARD, PORT, '/api/actions/list_issues'];
const PLATTFORMSADRESS = `http://${VARD}:${PORT}/api/actions/list_issues`;
const SOCKEL_RADER = ['import socket', 'def list_issues(nyckel=None):', '    socket.socket()'];
const UTAN_ANROP_RADER = ['def list_issues(nyckel=None):', '    return {}'];
const LADDNINGSANROP_RADER = ['import urllib.request',
  `urllib.request.urlopen("${PLATTFORMSADRESS}")`, ...UTAN_ANROP_RADER];
const GRONRAD = 'GRON: inga cron-korda skript eller moduler innehaller api.linear.app, och klientens anrop gar till plattformen';
const RODRAD = 'ROD: aterfall mot Linear eller ett anrop som inte gar till plattformen';
const KUNDE_INTE_RAD = 'KUNDE_INTE: delar av linearvakten gar inte att prova';
const UTAN_SKRIPT_7 = 'crontab rad 7 har inget skript';
function summa(kommandon: number, skript: number, moduler: number, olasta: number, traffar: number): string {
  return `underlag: kommandon=${kommandon} skript=${skript} moduler=${moduler} olasta=${olasta} traffar=${traffar}`;
}
function traffrad(slag: string, fil: string, rad: number, via: string): string {
  return `api.linear.app i ${slag} ${fil} rad ${rad} (cron-skript ${via})`;
}
function olasbar(slag: string, fil: string, typ: string): string {
  return `${slag} ${fil} gar inte att lasa (${typ})`;
}
function anropsrad(vag: string, schema: string | null, varden: string | null, port: number | null,
  sokvag: string | null, status: string): string {
  const v = (x: string | number | null): string => x === null ? '-' : String(x);
  return `klientens anrop via ${vag}: schema=${v(schema)} varden=${v(varden)} port=${v(port)} sokvag=${v(sokvag)}, ${status}`;
}
const KLIENTRAD_OK = anropsrad('urlopen', 'http', VARD, PORT, '/api/actions/list_issues', 'ok');
async function ogonblick(rot: string): Promise<string[]> {
  const poster: string[] = [];
  async function besok(katalog: string): Promise<void> {
    for (const namn of await readdir(katalog)) {
      const fil = path.join(katalog, namn);
      const s = await lstat(fil, { bigint: true });
      const typ = s.isSymbolicLink() ? 'lank' : s.isDirectory() ? 'katalog' : 'fil';
      poster.push(`${path.relative(rot, fil)}\t${typ}\t${s.size}\t${s.mtimeNs}`);
      if (s.isDirectory()) await besok(fil);
    }
  }
  await besok(rot);
  return poster.sort();
}
async function inteKort(u: Underlag): Promise<boolean> {
  const namn = new Set(['kordes-natt', 'kordes-hjalp', 'kordes-kvall', '__pycache__']);
  return (await ogonblick(u.hem)).every((rad) =>
    !rad.split('\t')[0]!.split(path.sep).some((led) => namn.has(led)));
}

function barnmiljo(u: Underlag, bas?: string): NodeJS.ProcessEnv {
  // Hela miljön är en tillåtelselista: test/env.ts och riktiga HOME får inte läcka in.
  // Attrappen står först så att systemets crontab aldrig nås.
  return { PATH: `${u.bin}${path.delimiter}${process.env.PATH}`, HOME: u.hem,
    ...(bas !== undefined ? { ARENDEN_API_URL: bas } : {}) };
}
function textrader(rader: readonly string[]): string { return `${rader.join('\n')}\n`; }
async function skriv(fil: string, innehall: string | Buffer): Promise<void> {
  await writeFile(fil, innehall);
}
function crontabRader(u: Underlag): string[] {
  return [
    '# Hermes nattkorningar', 'MAILTO=""', 'SHELL=/bin/sh',
    `15 2 * * * /usr/bin/python3 ${u.natt} >> /dev/null 2>&1`,
    '@daily sh ~/.hermes/skills/kvall.sh',
    '30 6 * * 1-5 cd $HOME/.hermes/skills && python3 natt.py',
    '0 4 * * * /usr/bin/true',
  ];
}
async function skrivCrontab(u: Underlag, rader: string[]): Promise<void> {
  await skriv(u.crontab, textrader(rader));
}
const hemkataloger: string[] = [];
async function nyttHem(): Promise<Underlag> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-linearvakt-'));
  hemkataloger.push(hem);
  const skills = path.join(hem, '.hermes', 'skills');
  const u = { hem, skills, bin: path.join(hem, 'bin'), crontab: path.join(hem, 'crontab-fixtur'),
    natt: path.join(skills, 'natt.py'), hjalp: path.join(skills, 'hjalp.py'),
    kvall: path.join(skills, 'kvall.sh'), klient: path.join(skills, 'arenden_klient.py') };
  await mkdir(u.bin);
  await mkdir(skills, { recursive: true });
  await skriv(path.join(u.bin, 'crontab'), textrader(ATTRAPP_RADER));
  await chmod(path.join(u.bin, 'crontab'), 0o755);
  await skriv(u.natt, textrader(NATT_RADER));
  await skriv(u.hjalp, textrader(HJALP_RADER));
  await skriv(u.kvall, textrader(KVALL_RADER));
  await copyFile(KLIENTKALLAN, u.klient);
  await skrivCrontab(u, crontabRader(u));
  return u;
}
afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

// -I isolerar importerna, -B hindrar cache; kod 3 skiljer drivrutinsfel från domen.
const DRIVER = [
  'import json, os, socket, sys, traceback, urllib.request',
  'try:',
  '    sys.path.insert(0, sys.argv[1])',
  '    import arende_linearvakt as k',
  '    operation = sys.argv[2]',
  '    def byt(lage):',
  '        if lage == "hel":',
  '            return',
  '        elif lage == "kort_tidsgrans":',
  '            k.TIDSGRANS = 1',
  '        elif lage == "utan_kommando":',
  '            k.CRONTAB = ("linearvakt-saknat-kommando", "-l")',
  '        elif lage == "krasch":',
  '            def krasch(*argument):',
  '                raise RuntimeError("provets krasch")',
  '            k.kor = krasch',
  '        else:',
  '            raise ValueError("okant lage")',
  '    if operation == "crontab":',
  '        byt(sys.argv[3])',
  '        resultat = k.las_crontab(k.kor_crontab)._asdict()',
  '    elif operation == "lasare":',
  '        def lasare():',
  '            if sys.argv[3] == "kastar":',
  '                raise RuntimeError("provets lasare")',
  '            return 7 if sys.argv[3] == "tal" else sys.argv[3]',
  '        resultat = k.las_crontab(lasare)._asdict()',
  '    elif operation == "kommandon":',
  '        resultat = [[c.nr, list(c.skript), c.fel] for c in k.tolka_kommandon(sys.argv[3], sys.argv[4])]',
  '    elif operation == "samla":',
  '        hem = sys.argv[3]',
  '        skills = os.path.join(hem, ".hermes", "skills")',
  '        with open(os.path.join(hem, "crontab-fixtur"), encoding="utf-8") as fil:',
  '            kommandon = k.tolka_kommandon(fil.read(), hem)',
  '        lage = k.las_skills(skills)',
  '        resultat = {"skills": lage._asdict(), "filer": [f._asdict() for f in k.samla_filer(kommandon, lage, skills, hem)]}',
  '    elif operation == "traffar":',
  '        resultat = list(k.traffar(sys.argv[3]))',
  '    elif operation == "utova":',
  '        original = (urllib.request.urlopen, socket.create_connection, socket.getaddrinfo, socket.socket)',
  '        u = k.utova_klienten(sys.argv[3])',
  '        efter = (urllib.request.urlopen, socket.create_connection, socket.getaddrinfo, socket.socket)',
  '        resultat = {"anrop": list(u.anrop), "status": [k.anrop_status(a) for a in u.anrop], "fel": u.fel, "aterstallda": all(a is b for a, b in zip(original, efter))}',
  '    elif operation == "kor":',
  '        byt(sys.argv[3])',
  '        resultat = k.kor(sys.argv[4])._asdict()',
  '    elif operation == "prov":',
  '        byt(sys.argv[3])',
  '        sys.exit(k.huvud(sys.argv[4:]))',
  '    else:',
  '        sys.exit(2)',
  '    print(json.dumps(resultat))',
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
async function korDrivern(u: Underlag, argument: string[], bas?: string): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, ...argument],
      { cwd: ROT, env: barnmiljo(u, bas), timeout: 20_000 });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
async function korCrontab(u: Underlag, lage: string): Promise<Crontablage> {
  const p = await korDrivern(u, ['crontab', lage]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as Crontablage;
}
async function korLasare(u: Underlag, lage: string): Promise<Crontablage> {
  const p = await korDrivern(u, ['lasare', lage]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as Crontablage;
}
async function korKommandon(u: Underlag, text: string): Promise<Kommando[]> {
  const p = await korDrivern(u, ['kommandon', text, u.hem]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as Kommando[];
}
async function korSamla(u: Underlag): Promise<{ skills: Skillslage; filer: Fil[] }> {
  const p = await korDrivern(u, ['samla', u.hem]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as { skills: Skillslage; filer: Fil[] };
}
async function korTraffar(u: Underlag, text: string): Promise<number[]> {
  const p = await korDrivern(u, ['traffar', text]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as number[];
}
async function korUtova(u: Underlag, klientfil: string, bas?: string): Promise<Utovning> {
  const p = await korDrivern(u, ['utova', klientfil], bas);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as Utovning;
}
async function klientMed(u: Underlag, namn: string, rader: string[]): Promise<string> {
  const fil = path.join(u.hem, namn);
  await skriv(fil, textrader(rader));
  return fil;
}
async function korKor(u: Underlag, bas?: string): Promise<{ utfall: string; kod: number; rader: string[] }> {
  const p = await korDrivern(u, ['kor', 'hel', u.hem], bas);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as { utfall: string; kod: number; rader: string[] };
}
async function korProvet(u: Underlag, argument: string[]): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', MODULEN, ...argument],
      { cwd: ROT, env: barnmiljo(u), timeout: 20_000 });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
function rader(ut: string): string[] {
  return ut.split(/\r?\n/).filter((rad) => rad.length > 0);
}

describe('FR-33/Story 10.8 AK 1, 3: crontab läses genom en enda väg och raderna ger skripten', () => {
  it('F1 (AK 1, 3): crontab läses genom en enda väg; läsfel ger ingen text och sin typ', async () => {
    const u = await nyttHem();
    expect(await korCrontab(u, 'hel')).toEqual({ text: textrader(crontabRader(u)), fel: null });
    await rm(u.crontab);
    expect(await korCrontab(u, 'hel')).toEqual({ text: null, fel: 'CalledProcessError' });
    await skriv(u.crontab, Buffer.from([0xff, 0xfe, 0x0a]));
    expect(await korCrontab(u, 'hel')).toEqual({ text: null, fel: 'UnicodeDecodeError' });
    await skriv(path.join(u.bin, 'crontab'), textrader(VANTANDE_RADER));
    await chmod(path.join(u.bin, 'crontab'), 0o755);
    expect(await korCrontab(u, 'kort_tidsgrans')).toEqual({ text: null, fel: 'TimeoutExpired' });
    expect(await korCrontab(u, 'utan_kommando')).toEqual({ text: null, fel: 'FileNotFoundError' });
    await skriv(path.join(u.bin, 'crontab'), textrader(ATTRAPP_RADER));
    await skrivCrontab(u, crontabRader(u));
    expect(await korCrontab(u, 'hel')).toEqual({ text: textrader(crontabRader(u)), fel: null });
    expect(await korLasare(u, 'kastar')).toEqual({ text: null, fel: 'RuntimeError' });
    expect(await korLasare(u, 'tal')).toEqual({ text: null, fel: 'TypeError' });
    expect(await korLasare(u, 'rad')).toEqual({ text: 'rad', fel: null });
  });

  it('F2 (AK 1, 3): varje kommandorad ger sina skript efter en sluten grammatik', async () => {
    const u = await nyttHem();
    expect(await korKommandon(u, textrader(crontabRader(u)))).toEqual([
      [4, [u.natt], null], [5, [u.kvall], null], [6, [u.natt], null], [7, [], null],
    ]);
    expect(await korKommandon(u, textrader(['', '# kommentar', '   # indragen kommentar',
      'MAILTO=""', 'MAILTO=a@b.se', 'SHELL=/bin/bash', 'PATH = /usr/bin:/bin']))).toEqual([]);
    for (const rad of ['PYTHONPATH=/a', 'HOME=/opt/x', 'BASH_ENV=/a/x.sh', 'SHELL=/a/skal',
      `PATH=/usr/bin:${u.hem}/bin`, 'PATH=/usr/bin:bin', 'MAILTO=-be']) {
      expect(await korKommandon(u, textrader([rad])), rad).toEqual([[1, [], 'ValueError']]);
    }
    expect(await korKommandon(u, textrader(['0 1 * * * python3 ~/a.py',
      '0 1 * * * sh $HOME/b.sh', '0 1 * * * python3 ${HOME}/c.py']))).toEqual([
      [1, [path.join(u.hem, 'a.py')], null], [2, [path.join(u.hem, 'b.sh')], null],
      [3, [path.join(u.hem, 'c.py')], null],
    ]);
    const tillatna: [string, string[]][] = [
      ['cd /opt/x && python3 y.py', ['/opt/x/y.py']],
      ['python3 z.py', [path.join(u.hem, 'z.py')]],
      ['cd ~/d && sh e.sh', [path.join(u.hem, 'd/e.sh')]],
      ['cd sub && python3 f.py', [path.join(u.hem, 'sub/f.py')]],
      ['cd && python3 q.py', [path.join(u.hem, 'q.py')]],
      ['cd /opt/x && python3 y.py | logger -t natt', ['/opt/x/y.py']],
      ['python3 /a/g.py > /a/logg.sh 2>&1', ['/a/g.py']],
      ['sh /a/h.sh < /a/in.py', ['/a/h.sh']], ['date >> ~/logg', []],
      ['python3 /a/j.py', ['/a/j.py']],
      ['sh /a/n.sh && sh /a/n.sh; python3 /a/o.py', ['/a/n.sh', '/a/o.py']],
      ['/usr/bin/true', []], ['curl -s https://x.invalid/a', []], ['echo klar | logger -t natt', []],
      ['python3 -u /a/p.py', ['/a/p.py']], ['bash -e /a/v.sh', ['/a/v.sh']],
      ['timeout 60 /usr/bin/python3 /a/q.py', ['/a/q.py']],
      ['flock -n /tmp/las python3 /a/u.py --kor', ['/a/u.py']],
      ['flock -n ~/.las timeout 5m python3 /a/w.py', ['/a/w.py']],
    ];
    for (const [kommando, skript] of tillatna) {
      expect(await korKommandon(u, textrader([`0 1 * * * ${kommando}`])), kommando)
        .toEqual([[1, skript, null]]);
    }
    expect(await korKommandon(u, textrader(['@reboot python3 /a/i.py'])))
      .toEqual([[1, ['/a/i.py'], null]]);
    for (const rad of ['@sometimes python3 /a/i.py', '@daily', '* * * *',
      '0 1? * * * python3 /a/j.py']) {
      expect(await korKommandon(u, textrader([rad])), rad).toEqual([[1, [], 'ValueError']]);
    }
    // (k): ett ändligt urval per regel och plats, med tillåtna kontroller ovan.
    const ovriga = [
      '~/.hermes/skills/natt.py', '/a/w.py', 'perl /a/x.pl', '. /a/y.sh', 'natt',
      '~/bin/true', 'bin/true', 'X=1 python3 /a/z.py',
      'python3', 'python3 -m modul', 'python3 -c x', 'python3 -I /a/p.py',
      'bash -s /a/v.sh', 'sh /a/p.py', 'python3 /a/v.sh', '~/venv/bin/python3 /a/r.py',
      'python3 ../a.py', "python3 '/a/k.py'", 'echo `python3 -m natt`',
      'echo $(python3 -m natt)', 'cat <(python3 -m natt)', '/usr/bin/true#; python3 -m natt',
      'echo a%b', 'python3 $SKILLS/l.py', 'python3 ~annan/m.py', 'python3 /a/*.py',
      'true || python3 /a/p.py', 'python3 /a/p.py &', 'python3 /a/p.py;',
      'python3 /a/p.py >', 'python3 /a/p.py >&2',
      'cd /opt/x; python3 y.py', 'cd /opt/x | python3 y.py',
      'cd /opt/x && python3 y.py; python3 z.py', 'python3 /a/p.py && cd /opt/x',
      'cd /opt/x /opt/y && python3 y.py', 'cd - && python3 y.py', 'cd /opt/x/../y && python3 z.py',
      'flock -c x python3 /a/p.py', 'flock /tmp/las python3 /a/p.py',
      'timeout -s 9 60 python3 /a/p.py', 'timeout 60', 'timeout 60 cd /opt/x',
      'flock -n -x python3 /a/p.py', 'flock -n -- python3 /a/p.py', 'flock -n las python3 /a/p.py',
    ];
    for (const kommando of ovriga) {
      expect(await korKommandon(u, textrader([`0 1 * * * ${kommando}`])), kommando)
        .toEqual([[1, [], 'ValueError']]);
    }
  });
});

describe('FR-33/Story 10.8 AK 1–3: skripten och modulerna läses', () => {
  it('F3 (AK 1, 3): varje användning läses en gång och oläsbara filer bär sin typ', async () => {
    const post = (sokvag: string, slag: string, via = sokvag, traffar: number[] | null = [],
      fel: string | null = null): Fil => ({ sokvag, slag, via, traffar, fel });
    const standard = (u: Underlag): Fil[] => [post(u.natt, 'skript'), post(u.kvall, 'skript'),
      post(u.klient, 'modul', u.natt), post(u.hjalp, 'modul', u.natt)];
    const moduler = ['arenden_klient', 'hjalp', 'natt'];
    const a = await nyttHem();
    await mkdir(path.join(a.skills, 'katalog.py'));
    await skriv(path.join(a.skills, 'inte-namn.py'), 'x = 1');
    expect(await korSamla(a)).toEqual({ skills: { moduler, paket: [], fel: null }, filer: standard(a) });

    const b = await nyttHem();
    const djup = path.join(b.skills, 'djup.py');
    await skriv(b.hjalp, textrader([...HJALP_RADER, 'import djup']));
    await skriv(djup, 'import os');
    expect((await korSamla(b)).filer).toEqual([...standard(b), post(djup, 'modul', b.natt)]);

    const c = await nyttHem();
    const former = path.join(c.skills, 'former.py');
    await skrivCrontab(c, ['0 1 * * * python3 ~/.hermes/skills/former.py']);
    await skriv(former, textrader(['import alfa.beta', 'from gamma import delta', 'from . import epsilon',
      'import json', 'import saknas', 'def f():', '    import zeta']));
    for (const namn of ['alfa', 'gamma', 'epsilon', 'zeta']) await skriv(path.join(c.skills, `${namn}.py`), 'x = 1');
    expect((await korSamla(c)).filer).toEqual([post(former, 'skript'),
      ...['alfa', 'gamma', 'zeta'].map((namn) => post(path.join(c.skills, `${namn}.py`), 'modul', former))]);

    const d = await nyttHem();
    const filer = ['borta', 'mapp', 'binar', 'trasig', 'importor'].map((namn) => path.join(d.skills, `${namn}.py`));
    await skrivCrontab(d, ['borta', 'mapp', 'binar', 'trasig', 'importor']
      .map((namn, i) => `0 ${i + 1} * * * python3 ~/.hermes/skills/${namn}.py`));
    await mkdir(filer[1]!);
    await skriv(filer[2]!, Buffer.from([0xff, 0xfe, 0x0a]));
    await skriv(filer[3]!, textrader(['def (:', '# api.linear.app']));
    await skriv(filer[4]!, 'import binmodul');
    const binmodul = path.join(d.skills, 'binmodul.py');
    await skriv(binmodul, Buffer.from([0xff, 0xfe, 0x0a]));
    expect((await korSamla(d)).filer).toEqual([
      post(filer[0]!, 'skript', filer[0]!, null, 'FileNotFoundError'),
      post(filer[1]!, 'skript', filer[1]!, null, 'IsADirectoryError'),
      post(filer[2]!, 'skript', filer[2]!, null, 'UnicodeDecodeError'),
      post(filer[3]!, 'skript', filer[3]!, [2], 'SyntaxError'), post(filer[4]!, 'skript'),
      post(binmodul, 'modul', filer[4]!, null, 'UnicodeDecodeError'),
    ]);
    const e = await nyttHem();
    await rm(e.skills, { recursive: true, force: true });
    await skrivCrontab(e, ['0 1 * * * python3 ~/.hermes/skills/natt.py']);
    expect(await korSamla(e)).toEqual({ skills: { moduler: null, paket: null, fel: 'FileNotFoundError' },
      filer: [post(e.natt, 'skript', e.natt, null, 'FileNotFoundError')] });

    // (g), (g2): shellens skript följs med samma grammatik och känd katalog bara på raden.
    for (const rad of ['python3 ~/.hermes/skills/del.py', 'cd ~/.hermes/skills && python3 del.py']) {
      const u = await nyttHem();
      const del = path.join(u.skills, 'del.py');
      await skriv(del, 'x = 1');
      await skriv(u.kvall, textrader([...KVALL_RADER, rad]));
      expect((await korSamla(u)).filer, rad).toEqual([...standard(u), post(del, 'skript', u.kvall)]);
    }
    for (const rad of ['python3 -m del', 'python3 del.py', 'X=1 python3 ~/.hermes/skills/del.py',
      'cd ~/.hermes/skills; python3 del.py', 'exec python3 ~/.hermes/skills/del.py']) {
      const u = await nyttHem();
      await skriv(path.join(u.skills, 'del.py'), 'x = 1');
      await skriv(u.kvall, textrader([...KVALL_RADER, rad]));
      expect((await korSamla(u)).filer, rad).toEqual(standard(u).map((f) => f.sokvag === u.kvall
        ? { ...f, fel: 'ValueError' } : f));
    }
    // (i1–i5) och kontroll utan import: även sammansatta .so och andra Python-versioner.
    for (const rad of ['import paket', 'import snabb', 'from gammal import x', 'import tung',
      'import aldre', null]) {
      const u = await nyttHem();
      await mkdir(path.join(u.skills, 'paket'));
      await skriv(path.join(u.skills, 'paket', '__init__.py'), 'x = 1');
      for (const namn of ['snabb.so', 'tung.abi3.so', 'aldre.cpython-311-x86_64-linux-gnu.so', 'gammal.pyc']) {
        await skriv(path.join(u.skills, namn), 'x');
      }
      if (rad !== null) await skriv(u.hjalp, textrader([...HJALP_RADER, rad]));
      expect(await korSamla(u), rad ?? 'kontroll').toEqual({
        skills: { moduler, paket: ['aldre', 'gammal', 'paket', 'snabb', 'tung'], fel: null },
        filer: standard(u).map((f) => f.sokvag === u.hjalp && rad !== null ? { ...f, fel: 'ValueError' } : f),
      });
    }
    const j = await nyttHem();
    const ute = path.join(j.hem, 'ute.py');
    await skrivCrontab(j, ['0 1 * * * python3 ~/ute.py']);
    await skriv(ute, textrader(['import hjalp', '# api.linear.app']));
    expect((await korSamla(j)).filer).toEqual([post(ute, 'skript', ute, [2], 'ValueError')]);

    // (k1), (k3): samma sökväg som modul och skript; länken får bara modulrollen godkänd.
    for (const lank of [false, true]) {
      const u = await nyttHem();
      await skriv(u.kvall, textrader([...KVALL_RADER, 'python3 ~/.hermes/skills/hjalp.py']));
      if (lank) {
        await mkdir(path.join(u.hem, 'annan'));
        const mal = path.join(u.hem, 'annan', 'hjalp.py');
        await skriv(mal, textrader(HJALP_RADER));
        await rm(u.hjalp);
        await symlink(mal, u.hjalp);
      }
      expect((await korSamla(u)).filer).toEqual([...standard(u),
        post(u.hjalp, 'skript', u.kvall, [], lank ? 'ValueError' : null)]);
    }
    const k2 = await nyttHem();
    const andra = path.join(k2.skills, 'andra.py');
    await skrivCrontab(k2, ['0 1 * * * python3 ~/.hermes/skills/natt.py',
      '0 2 * * * python3 ~/.hermes/skills/andra.py']);
    await skriv(andra, 'import hjalp');
    expect((await korSamla(k2)).filer).toEqual([post(k2.natt, 'skript'), post(andra, 'skript'),
      post(k2.klient, 'modul', k2.natt), post(k2.hjalp, 'modul', k2.natt), post(k2.hjalp, 'modul', andra)]);
  });

  it('F4 (AK 1, 2): varje rad med api.linear.app räknas utan hänsyn till skiftläge', async () => {
    const u = await nyttHem();
    for (const [rader, vantat] of [
      [['a', 'url = "https://api.linear.app/graphql"', 'b'], [2]],
      [['HAMTA FRAN API.LINEAR.APP'], [1]], [['api.linear.app', 'x', '# api.linear.app'], [1, 3]],
      [['linear.app', 'api.linear.ap', 'api-linear-app'], []],
    ] as [string[], number[]][]) expect(await korTraffar(u, textrader(rader))).toEqual(vantat);
    await skriv(u.hjalp, textrader([...HJALP_RADER, 'URL = "https://api.linear.app/graphql"']));
    expect((await korSamla(u)).filer.find((f) => f.sokvag === u.hjalp)).toEqual({
      sokvag: u.hjalp, slag: 'modul', via: u.natt, traffar: [5], fel: null,
    });
  });
});

describe('FR-33/Story 10.8 AK 1, 3: klienten utövas med nätet fångat', () => {
  it('F5 (AK 1, 3): nätanrop fångas, klienten prövas i två steg och originalen återställs', async () => {
    const u = await nyttHem();
    expect(await korUtova(u, u.klient)).toEqual({ anrop: [PLATTFORMSANROP], status: ['ok'],
      fel: null, aterstallda: true });
    for (const [bas, schema, varden, port] of [
      ['https://api.linear.app', 'https', 'api.linear.app', null],
      ['http://localhost', 'http', 'localhost', null], [`https://${VARD}:${PORT}`, 'https', VARD, PORT],
    ] as [string, string, string, number | null][]) {
      expect(await korUtova(u, u.klient, bas)).toEqual({
        anrop: [['urlopen', schema, varden, port, '/api/actions/list_issues']],
        status: ['inte plattformen'], fel: null, aterstallda: true,
      });
    }
    const linear = ['urlopen', 'https', 'api.linear.app', null, '/graphql'];
    const ok = [PLATTFORMSANROP];
    const begar = `urllib.request.urlopen("${PLATTFORMSADRESS}")`;
    const urlImport = 'import urllib.request';
    const funktion = 'def list_issues(nyckel=None):';
    type Klientfall = [string, string[], (string | number | null)[][], string[], string | null];
    const fall: Klientfall[] = [
      ['d1', [urlImport, funktion, '    urllib.request.urlopen("https://api.linear.app/graphql")'],
        [linear], ['inte plattformen'], null],
      ['d2', ['import http.client', funktion, '    c = http.client.HTTPConnection("api.linear.app", 80)',
        '    c.request("POST", "/graphql")'],
      [['create_connection', null, 'api.linear.app', 80, null]], ['inte plattformen'], null],
      ['d3', ['import socket', funktion, '    socket.create_connection(("api.linear.app", 443))'],
        [['create_connection', null, 'api.linear.app', 443, null]], ['inte plattformen'], null],
      ['d4', ['import socket', funktion, '    socket.getaddrinfo("api.linear.app", "443")'],
        [['getaddrinfo', null, 'api.linear.app', 443, null]], ['inte plattformen'], null],
      ['d5', SOCKEL_RADER, [['socket', null, null, null, null]], ['adressen gar inte att avgora'], null],
      ['d6', ['from urllib.request import urlopen', funktion,
        '    urlopen("https://api.linear.app/graphql")'], [linear], ['inte plattformen'], null],
      ['d7', UTAN_ANROP_RADER, [], [], 'list_issues gav ett svar'],
      ['d8', [urlImport, funktion, '    try:', `        ${begar}`, '    except:', '        pass',
        '    return {}'], ok, ['ok'], 'list_issues gav ett svar'],
      ['d9', [urlImport, funktion, '    for i in range(3):', '        try:',
        '            urllib.request.urlopen("https://api.linear.app/graphql")',
        '        except Exception:', '            continue'], [linear], ['inte plattformen'], null],
      ['d10', ['import sys', funktion, '    sys.exit(0)'], [], [], 'SystemExit'],
      ['d11', ['def list_issues():', '    return {}'], [], [], 'TypeError'],
      ['d13', [urlImport, 'urllib.request.urlopen("https://api.linear.app/graphql")'],
        [linear], ['inte plattformen'], 'laddningen gjorde ett anrop'],
      ['d14', [urlImport, funktion, '    urllib.request.urlopen(7)'],
        [['urlopen', null, null, null, null]], ['adressen gar inte att avgora'], null],
      ['d15', ['import socket', funktion, '    socket.create_connection("api.linear.app")'],
        [['create_connection', null, null, null, null]], ['adressen gar inte att avgora'], null],
      ['d16', ['import socket', funktion, '    socket.getaddrinfo(b"api.linear.app", None)'],
        [['getaddrinfo', null, null, null, null]], ['adressen gar inte att avgora'], null],
      ['d17', ['import socket', funktion, `    socket.create_connection(("${VARD}", ${PORT}))`],
        [['create_connection', null, VARD, PORT, null]], ['ok'], null],
      ['d18', [urlImport, funktion, `    urllib.request.urlopen("https://api.linear.app:${'x'}/graphql")`],
        [['urlopen', null, null, null, null]], ['adressen gar inte att avgora'], null],
      ['d19', [urlImport, funktion, '    try:', `        ${begar}`, '    except BaseException:',
        '        raise RuntimeError("klientens eget fel")'], ok, ['ok'], 'RuntimeError'],
      ['d20a', LADDNINGSANROP_RADER, ok, ['ok'], 'laddningen gjorde ett anrop'],
      ['d20b', [urlImport, 'try:', `    ${begar}`, 'except BaseException:', '    pass',
        ...UTAN_ANROP_RADER], ok, ['ok'], 'laddningen gjorde ett anrop'],
      ['d21', [urlImport, funktion, '    try:', `        ${begar}`, '    except BaseException:',
        '        pass', `    ${begar}`], [PLATTFORMSANROP, PLATTFORMSANROP], ['ok', 'ok'],
      'fler an ett anrop fangades'],
    ];
    for (const [namn, rader, anrop, status, fel] of fall) {
      const fil = await klientMed(u, namn, rader);
      expect(await korUtova(u, fil), namn).toEqual({ anrop, status, fel, aterstallda: true });
    }
    // (d12): fel i läsning/kompilering måste också återställa alla fyra original.
    for (const [namn, text, fel] of [
      ['saknas', null, 'FileNotFoundError'], ['binar', Buffer.from([0xff, 0xfe, 0x0a]), 'UnicodeDecodeError'],
      ['syntax', 'def (:', 'SyntaxError'],
    ] as [string, string | Buffer | null, string][]) {
      const fil = path.join(u.hem, namn);
      if (text !== null) await skriv(fil, text);
      expect(await korUtova(u, fil), namn).toEqual({ anrop: [], status: [], fel, aterstallda: true });
    }
    // Kontroll: en enda fångst under list_issues, ingen laddningsfångst och inget eget svar/fel.
    expect(await korUtova(u, u.klient)).toEqual({ anrop: ok, status: ['ok'], fel: null, aterstallda: true });
  });
});

describe('FR-33/Story 10.8 AK 1–3: domen', () => {
  it('F6 (AK 1, 2, 3): oläsbart underlag först, återfall ROD och GRON sist', async () => {
    async function prova(u: Underlag, utfall: string, kod: number, rader: string[], bas?: string): Promise<void> {
      const fore = await ogonblick(u.hem);
      const d = await korKor(u, bas);
      expect(d).toEqual({ utfall, kod, rader });
      if (utfall === 'KUNDE_INTE') {
        expect(d.rader.some((rad) => /^(GRON|ROD)/.test(rad))).toBe(false);
      } else {
        expect(d.rader.join('\n')).not.toMatch(/Error|kunde inte/);
      }
      // (p): också vid återfall och oläsbar crontab förblir hemmet och markörerna orörda.
      expect(await ogonblick(u.hem)).toEqual(fore);
      expect(await inteKort(u)).toBe(true);
    }
    async function linearfil(u: Underlag): Promise<string> {
      const fil = path.join(u.skills, 'linearanrop.py');
      await skriv(fil, textrader(['import urllib.request',
        'urllib.request.urlopen("https://api.linear.app/graphql")']));
      return fil;
    }
    const a = await nyttHem();
    await prova(a, 'GRON', 0, [GRONRAD, summa(4, 2, 2, 0, 0), UTAN_SKRIPT_7, KLIENTRAD_OK]);
    const b = await nyttHem();
    const l = await linearfil(b);
    await skrivCrontab(b, [...crontabRader(b), '45 3 * * * python3 ~/.hermes/skills/linearanrop.py']);
    await prova(b, 'ROD', 1, [RODRAD, summa(5, 3, 2, 0, 1), UTAN_SKRIPT_7,
      traffrad('skript', l, 2, l), KLIENTRAD_OK]);
    const c = await nyttHem();
    await skriv(c.hjalp, textrader([...HJALP_RADER, 'URL = "https://api.linear.app/graphql"']));
    await prova(c, 'ROD', 1, [RODRAD, summa(4, 2, 2, 0, 1), UTAN_SKRIPT_7,
      traffrad('modul', c.hjalp, 5, c.natt), KLIENTRAD_OK]);
    const d = await nyttHem();
    await skriv(d.kvall, textrader([...KVALL_RADER, 'curl -s https://api.linear.app/graphql']));
    await prova(d, 'ROD', 1, [RODRAD, summa(4, 2, 2, 0, 1), UTAN_SKRIPT_7,
      traffrad('skript', d.kvall, 3, d.kvall), KLIENTRAD_OK]);
    const e = await nyttHem();
    await skrivCrontab(e, [...crontabRader(e), '0 5 * * * curl -s https://api.linear.app/graphql']);
    await prova(e, 'ROD', 1, [RODRAD, summa(5, 2, 2, 0, 1), UTAN_SKRIPT_7,
      'crontab rad 8 har inget skript', 'api.linear.app i crontab rad 8', KLIENTRAD_OK]);
    const f = await nyttHem();
    await prova(f, 'ROD', 1, [RODRAD, summa(4, 2, 2, 0, 0), UTAN_SKRIPT_7,
      anropsrad('urlopen', 'https', 'api.linear.app', null, '/api/actions/list_issues', 'inte plattformen')],
    'https://api.linear.app');
    const g = await nyttHem();
    await rm(g.crontab);
    await prova(g, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(0, 0, 0, 0, 0),
      'crontab gar inte att lasa (CalledProcessError)', KLIENTRAD_OK]);
    const h = await nyttHem();
    const borta = path.join(h.skills, 'borta.py');
    await skrivCrontab(h, [...crontabRader(h), '45 3 * * * python3 ~/.hermes/skills/borta.py']);
    await prova(h, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(5, 3, 2, 1, 0), UTAN_SKRIPT_7,
      olasbar('skript', borta, 'FileNotFoundError'), KLIENTRAD_OK]);
    const i = await nyttHem();
    await skriv(i.hjalp, Buffer.from([0xff, 0xfe, 0x0a]));
    await prova(i, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(4, 2, 2, 1, 0), UTAN_SKRIPT_7,
      olasbar('modul', i.hjalp, 'UnicodeDecodeError'), KLIENTRAD_OK]);
    const j = await nyttHem();
    const ute = path.join(j.hem, 'ute.py');
    await skrivCrontab(j, ['0 1 * * * python3 ~/ute.py']);
    await skriv(ute, 'print(1)');
    await rm(j.skills, { recursive: true, force: true });
    await prova(j, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(1, 1, 0, 1, 0),
      'skills gar inte att lasa (FileNotFoundError)', olasbar('skript', ute, 'ValueError'),
      'klienten gar inte att prova (FileNotFoundError)']);
    const k = await nyttHem();
    await skrivCrontab(k, [...crontabRader(k), "0 1 * * * python3 '~/.hermes/skills/natt.py"]);
    await prova(k, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(5, 2, 2, 0, 0), UTAN_SKRIPT_7,
      'crontab rad 8 gar inte att tolka (ValueError)', KLIENTRAD_OK]);
    const tom = await nyttHem();
    await skriv(tom.crontab, '');
    await prova(tom, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(0, 0, 0, 0, 0),
      'inga cron-korda skript att lasa', KLIENTRAD_OK]);
    const m = await nyttHem();
    const ml = await linearfil(m);
    await skrivCrontab(m, [...crontabRader(m), '45 3 * * * python3 ~/.hermes/skills/linearanrop.py',
      '45 3 * * * python3 ~/.hermes/skills/borta.py']);
    await prova(m, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(6, 4, 2, 1, 1), UTAN_SKRIPT_7,
      olasbar('skript', path.join(m.skills, 'borta.py'), 'FileNotFoundError'),
      traffrad('skript', ml, 2, ml), KLIENTRAD_OK]);
    const n = await nyttHem();
    await skriv(n.klient, textrader(UTAN_ANROP_RADER));
    await prova(n, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(4, 2, 2, 0, 0), UTAN_SKRIPT_7,
      'klienten gar inte att prova (list_issues gav ett svar)']);
    const o = await nyttHem();
    await skriv(o.klient, textrader(SOCKEL_RADER));
    await prova(o, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(4, 2, 2, 0, 0), UTAN_SKRIPT_7,
      anropsrad('socket', null, null, null, null, 'adressen gar inte att avgora')]);
    const r = await nyttHem();
    await skrivCrontab(r, [...crontabRader(r), '0 2 * * * python3 -m natt']);
    await prova(r, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(5, 2, 2, 0, 0), UTAN_SKRIPT_7,
      'crontab rad 8 gar inte att tolka (ValueError)', KLIENTRAD_OK]);
    const s = await nyttHem();
    const sl = await linearfil(s);
    await skriv(s.kvall, textrader([...KVALL_RADER, 'python3 ~/.hermes/skills/linearanrop.py']));
    await prova(s, 'ROD', 1, [RODRAD, summa(4, 3, 2, 0, 1), UTAN_SKRIPT_7,
      traffrad('skript', sl, 2, s.kvall), KLIENTRAD_OK]);
    const t = await nyttHem();
    await skriv(t.klient, textrader(LADDNINGSANROP_RADER));
    await prova(t, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(4, 2, 2, 0, 0), UTAN_SKRIPT_7,
      'klienten gar inte att prova (laddningen gjorde ett anrop)', KLIENTRAD_OK]);
    const u = await nyttHem();
    await skriv(u.kvall, textrader([...KVALL_RADER, 'python3 ~/.hermes/skills/hjalp.py']));
    await mkdir(path.join(u.hem, 'annan'));
    const mal = path.join(u.hem, 'annan', 'hjalp.py');
    await skriv(mal, textrader(HJALP_RADER));
    await rm(u.hjalp);
    await symlink(mal, u.hjalp);
    await prova(u, 'KUNDE_INTE', 2, [KUNDE_INTE_RAD, summa(4, 3, 2, 1, 0), UTAN_SKRIPT_7,
      olasbar('skript', u.hjalp, 'ValueError'), KLIENTRAD_OK]);
    const v = await nyttHem();
    const andra = path.join(v.skills, 'andra.py');
    await skrivCrontab(v, [...crontabRader(v), '0 3 * * * python3 ~/.hermes/skills/andra.py']);
    await skriv(andra, 'import hjalp');
    await skriv(v.hjalp, textrader([...HJALP_RADER, 'URL = "https://api.linear.app/graphql"']));
    await prova(v, 'ROD', 1, [RODRAD, summa(5, 3, 3, 0, 2), UTAN_SKRIPT_7,
      traffrad('modul', v.hjalp, 5, v.natt), traffrad('modul', v.hjalp, 5, andra), KLIENTRAD_OK]);
    // (q): samma kontroll som (a), skild från fallen bara i respektive ändring.
  });
});

describe('FR-33/Story 10.8 AK 1–3: vakten som skript', () => {
  it('F7 (AK 1, 2, 3): skriptet utan argument ger tre utfall med var sin exitkod och skriver inget', async () => {
    const koderna: number[] = [];
    const forsta: string[] = [];
    for (const lage of ['gron', 'rod', 'olasbar']) {
      const u = await nyttHem();
      let vantat = [GRONRAD, summa(4, 2, 2, 0, 0), UTAN_SKRIPT_7, KLIENTRAD_OK];
      if (lage === 'rod') {
        const l = path.join(u.skills, 'linearanrop.py');
        await skriv(l, textrader(['import urllib.request',
          'urllib.request.urlopen("https://api.linear.app/graphql")']));
        await skrivCrontab(u, [...crontabRader(u), '45 3 * * * python3 ~/.hermes/skills/linearanrop.py']);
        vantat = [RODRAD, summa(5, 3, 2, 0, 1), UTAN_SKRIPT_7,
          traffrad('skript', l, 2, l), KLIENTRAD_OK];
      } else if (lage === 'olasbar') {
        await rm(u.crontab);
        vantat = [KUNDE_INTE_RAD, summa(0, 0, 0, 0, 0),
          'crontab gar inte att lasa (CalledProcessError)', KLIENTRAD_OK];
      }
      const fore = await ogonblick(u.hem);
      const adapterFore = (await readdir(ADAPTERN)).sort();
      const p = await korProvet(u, []);
      expect(p.kod, lage).toBe(lage === 'gron' ? 0 : lage === 'rod' ? 1 : 2);
      expect(p.fel, lage).toBe('');
      expect(rader(p.ut), lage).toEqual(vantat);
      if (lage !== 'olasbar') expect(p.ut).not.toMatch(/Error|kunde inte/);
      expect(await ogonblick(u.hem)).toEqual(fore);
      expect(await inteKort(u)).toBe(true);
      expect((await readdir(ADAPTERN)).sort()).toEqual(adapterFore);
      koderna.push(p.kod);
      forsta.push(rader(p.ut)[0]!);
    }
    expect(koderna).toEqual([0, 1, 2]);
    expect(new Set(koderna).size).toBe(3);
    expect(forsta.map((rad) => rad.split(': ')[0])).toEqual(['GRON', 'ROD', 'KUNDE_INTE']);
  });

  it('F8 (AK 3): argument ger KUNDE_INTE före läsningen', async () => {
    const u = await nyttHem();
    for (const argument of [['x'], ['--hem', u.hem], ['--crontab', u.crontab]]) {
      const p = await korProvet(u, argument);
      expect(p.fel).toBe('');
      expect({ kod: p.kod, rader: rader(p.ut) }).toEqual({ kod: 2, rader: [ANROPSRAD] });
    }
    const p = await korDrivern(u, ['prov', 'krasch', 'x']);
    expect(p.fel).toBe('');
    expect({ kod: p.kod, rader: rader(p.ut) }).toEqual({ kod: 2, rader: [ANROPSRAD] });
    // Kontroll utan argument och med samma läsbara hem finns i F7 (a).
  });

  it('F9 (AK 3): en krasch ger KUNDE_INTE och exitkod 2', async () => {
    const u = await nyttHem();
    const p = await korDrivern(u, ['prov', 'krasch']);
    expect(p.kod).toBe(2);
    expect(p.fel).toBe('');
    expect(rader(p.ut)).toEqual(['KUNDE_INTE: provet stannade: RuntimeError']);
  });
});
