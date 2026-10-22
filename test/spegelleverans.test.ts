// FR-18, B-17 punkten Spegeln, Story 10.1.
// Kör adapter/spegelleverans.py som barnprocess mot ett tillfälligt valv med en bar fjärr i tmpdir().
// Varje git-steg läses och fel avbryter, också när ett steg aldrig svarar. Nästa körning levererar
// det som låg kvar utan en ny commit för samma filer. Bara spegelkatalogen levereras. Vattenmärket
// flyttas först efter lyckad leverans; låset omsluter leveransen och fel ger en felrad och exitkod 1.
// Provet rör aldrig driftspegeln, riktiga valvet eller riktiga git-konfigurationen. Spegelns egen
// läsning och skrivning (epics.md AK 3) prövas i drift.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// Som test/pythonklient.test.ts och test/spegellasning.test.ts: provfiler exporterar inga hjälpare.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const KATALOG = '02-Områden/linear-arkiv';
const STEG = ['add', 'diff', 'commit', 'pull', 'push'] as const;

type Steg = typeof STEG[number];
interface Varld { hem: string; valv: string; fjarr: string; markfil: string }
interface Processutfall { kod: number; ut: string; fel: string }
interface Leverans {
  levererad: boolean;
  steg: Steg | null;
  kod: number | null;
  committade: boolean;
  anrop: string[];
}

function barnmiljo(hem: string, bas?: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  // test/env.ts bär en attrappnyckel; riktiga HOME bär driftens nyckel och git-konfiguration.
  // Tillåtelselistan hindrar båda från att påverka provet. Git läser bara repots egen konfiguration.
  return {
    PATH: process.env.PATH,
    HOME: hem,
    GIT_AUTHOR_NAME: 'spegelprovet',
    GIT_COMMITTER_NAME: 'spegelprovet',
    GIT_AUTHOR_EMAIL: 'spegelprovet@exempel.invalid',
    GIT_COMMITTER_EMAIL: 'spegelprovet@exempel.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
    ...(bas !== undefined ? { ARENDEN_API_URL: bas } : {}),
    ...extra,
  };
}

async function git(v: { hem: string }, cwd: string, ...argument: string[]): Promise<string> {
  const { stdout } = await korProcess('git', argument, {
    cwd, env: barnmiljo(v.hem), timeout: 20_000,
  });
  return stdout;
}

const hemkataloger: string[] = [];
async function nyVarld(): Promise<Varld> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-spegelleverans-'));
  hemkataloger.push(hem);
  const fjarr = path.join(hem, 'fjarr.git');
  const valv = path.join(hem, 'valv');
  const markfil = path.join(hem, 'vattenmarke');
  await git({ hem }, hem, 'init', '--bare', '-q', fjarr);
  await git({ hem }, hem, 'init', '-q', valv);
  await writeFile(path.join(valv, 'start.txt'), 'start\n');
  await git({ hem }, valv, 'add', 'start.txt');
  await git({ hem }, valv, 'commit', '-q', '-m', 'start');
  await git({ hem }, valv, 'remote', 'add', 'origin', fjarr);
  await git({ hem }, valv, 'push', '-q', '-u', 'origin', 'HEAD');
  await writeFile(markfil, 'v0');
  return { hem, valv, fjarr, markfil };
}

afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

async function gren(v: Varld): Promise<string> {
  return (await git(v, v.valv, 'symbolic-ref', '--short', 'HEAD')).trim();
}
async function lokalSpets(v: Varld): Promise<string> {
  return (await git(v, v.valv, 'rev-parse', 'HEAD')).trim();
}
async function fjarrSpets(v: Varld): Promise<string> {
  return (await git(v, v.fjarr, 'rev-parse', `refs/heads/${await gren(v)}`)).trim();
}
async function antalCommits(v: Varld): Promise<number> {
  return Number((await git(v, v.valv, 'rev-list', '--count', 'HEAD')).trim());
}
async function okommittat(v: Varld, relativ: string): Promise<boolean> {
  return (await git(v, v.valv, 'status', '--porcelain', '-z', '--', relativ)).length > 0;
}
async function iFjarren(v: Varld, relativ: string): Promise<boolean> {
  return (await git(v, v.fjarr, 'ls-tree', '-r', '--name-only', '-z', await gren(v), '--', relativ))
    .split('\0').includes(relativ);
}
async function sparrfiler(v: Varld): Promise<string[]> {
  return (await readdir(path.join(v.valv, '.git'))).filter((namn) => namn.endsWith('.lock')).sort();
}
function spegelfil(n: number | string): string {
  return `${typeof n === 'number' ? `LOC-${n}` : n}.md`;
}
async function skrivSpegelfil(v: Varld, namn: string, text: string): Promise<void> {
  await mkdir(path.join(v.valv, KATALOG), { recursive: true });
  await writeFile(path.join(v.valv, KATALOG, namn), text);
}
async function sattKrok(katalog: string, namn: string, rad = 'exit 1'): Promise<void> {
  await mkdir(katalog, { recursive: true });
  const fil = path.join(katalog, namn);
  await writeFile(fil, `#!/bin/sh\n${rad}\n`);
  await chmod(fil, 0o755);
}
async function sattHangning(v: Varld): Promise<string> {
  const fil = path.join(v.hem, 'hanger');
  await writeFile(fil, '#!/bin/sh\nexec sleep 30\n');
  await chmod(fil, 0o755);
  return fil;
}
async function sattSegGit(v: Varld): Promise<string> {
  const katalog = path.join(v.hem, 'seg');
  await mkdir(katalog);
  const fil = path.join(katalog, 'git');
  await writeFile(fil, "#!/bin/sh\ntrap '' TERM\nexec sleep 30\n");
  await chmod(fil, 0o755);
  return katalog;
}

// -I isolerar importerna, -B hindrar __pycache__. Kod 3 skiljer en krasch från leveransfelets 1.
// json.dumps ger ren ASCII eftersom barnprocessen saknar LANG.
const DRIVER = String.raw`
import contextlib
import json
import os
import sys
import traceback

try:
    sys.path.insert(0, sys.argv[1])
    import spegelleverans
    operation = sys.argv[2]
    anrop = []

    def kor(valv, argument):
        anrop.append(argument[0])
        if os.environ.get("SPEGEL_FEL_STEG") == argument[0]:
            return 97
        if "SPEGEL_TIDSGRANS" in os.environ:
            return spegelleverans.kor_git(valv, argument, int(os.environ["SPEGEL_TIDSGRANS"]))
        return spegelleverans.kor_git(valv, argument)

    @contextlib.contextmanager
    def sparr():
        anrop.append("sparr-in")
        try:
            yield
        finally:
            anrop.append("sparr-ut")

    if operation == "leverera":
        leverans = spegelleverans.leverera(sys.argv[3], sys.argv[4], "spegeln: provet", kor)
        print(json.dumps(dict(leverans._asdict(), anrop=anrop)))
        sys.exit(0)
    elif operation == "kommando":
        katalog = sys.argv[3]
        okant = None
        try:
            spegelleverans.kommando("status", katalog, "spegeln: provet")
        except Exception as fel:
            okant = type(fel).__name__
        print(json.dumps({
            "steg": list(spegelleverans.STEG),
            "listor": [spegelleverans.kommando(s, katalog, "spegeln: provet") for s in spegelleverans.STEG],
            "okant": okant,
            "tidsgrans": spegelleverans.TIDSGRANS_S,
            "frist": spegelleverans.FRIST_S,
            "koder": [spegelleverans.KOD_TIDSGRANS, spegelleverans.KOD_DODAD, spegelleverans.KOD_STARTFEL],
        }))
        sys.exit(0)
    elif operation == "korgit":
        kod = spegelleverans.kor_git(sys.argv[3], ["status", "--porcelain"], int(sys.argv[4]), int(sys.argv[5]))
        print(json.dumps({"kod": kod}))
        sys.exit(0)
    elif operation == "spegla":
        valv, katalog, markfil, nytt = sys.argv[3:7]
        skrivna = 0
        sedan = None

        def hamta_mark():
            global sedan
            with open(markfil, encoding="utf-8") as fil:
                sedan = fil.read().strip()
            return sedan

        def spegla(sedan):
            global skrivna
            import arenden_klient
            noder = arenden_klient.list_issues()["noder"]
            os.makedirs(os.path.join(valv, katalog), exist_ok=True)
            for nod in noder:
                identifier, title = nod["identifier"], nod["title"]
                sokvag = os.path.join(valv, katalog, identifier + ".md")
                text = "# %s %s\n" % (identifier, title)
                gammal = None
                if os.path.exists(sokvag):
                    with open(sokvag, encoding="utf-8") as fil:
                        gammal = fil.read()
                if gammal != text:
                    with open(sokvag, "w", encoding="utf-8") as fil:
                        fil.write(text)
                    skrivna += 1
            return nytt

        def spara_mark(varde):
            with open(markfil, "w", encoding="utf-8") as fil:
                fil.write(varde)

        extra = {}
        if "SPEGEL_FEL_STEG" in os.environ or "SPEGEL_TIDSGRANS" in os.environ:
            extra = {"kor": kor, "sparr": sparr}
        kod = spegelleverans.kor_spegling(hamta_mark, spegla, spara_mark, valv, katalog, "spegeln: provet", **extra)
        print(json.dumps({"skrivna": skrivna, "sedan": sedan, "anrop": anrop}))
        sys.exit(kod)
    else:
        sys.exit(2)
except Exception:
    traceback.print_exc()
    sys.exit(3)
`;

function arProcessfel(fel: unknown): fel is { code: number; stdout: string; stderr: string } {
  return typeof fel === 'object' && fel !== null
    && 'code' in fel && typeof fel.code === 'number'
    && 'stdout' in fel && typeof fel.stdout === 'string'
    && 'stderr' in fel && typeof fel.stderr === 'string';
}
async function korDrivern(
  v: { hem: string }, argument: string[], bas?: string, extra?: Record<string, string>,
): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess(
      'python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, ...argument],
      { cwd: ROT, env: barnmiljo(v.hem, bas, extra), timeout: 20_000 },
    );
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
async function korLeverera(v: Varld, extra?: Record<string, string>): Promise<Leverans> {
  const resultat = await korDrivern(v, ['leverera', v.valv, KATALOG], undefined, extra);
  if (resultat.kod !== 0) throw new Error(resultat.fel);
  return JSON.parse(resultat.ut) as Leverans;
}
async function korKommando(): Promise<unknown> {
  const resultat = await korDrivern({ hem: tmpdir() }, ['kommando', KATALOG]);
  if (resultat.kod !== 0) throw new Error(resultat.fel);
  return JSON.parse(resultat.ut) as unknown;
}
async function korKorGit(v: Varld, extra?: Record<string, string>): Promise<{ kod: number }> {
  const resultat = await korDrivern(v, ['korgit', v.valv, '3', '3'], undefined, extra);
  if (resultat.kod !== 0) throw new Error(resultat.fel);
  return JSON.parse(resultat.ut) as { kod: number };
}

describe('FR-18/Story 10.1 AK 1–3: leveransen läser varje git-steg', () => {
  it('F1 (AK 1, 3): en misslyckad commit tas igen utan ny skrivning', async () => {
    const v = await nyVarld();
    const fore = await antalCommits(v);
    const spets0 = await fjarrSpets(v);
    await skrivSpegelfil(v, spegelfil(1), 'ett\n');
    await sattKrok(path.join(v.valv, '.git', 'hooks'), 'pre-commit');
    expect(await korLeverera(v)).toEqual({
      levererad: false, steg: 'commit', kod: 1, committade: false, anrop: ['add', 'diff', 'commit'],
    });
    expect(await antalCommits(v)).toBe(fore);
    expect(await okommittat(v, KATALOG + '/' + spegelfil(1))).toBe(true);
    expect(await fjarrSpets(v)).toBe(spets0);

    await rm(path.join(v.valv, '.git', 'hooks', 'pre-commit'), { force: true });
    expect(await korLeverera(v)).toEqual({
      levererad: true, steg: null, kod: null, committade: true, anrop: [...STEG],
    });
    expect(await antalCommits(v)).toBe(fore + 1);
    expect(await okommittat(v, KATALOG + '/' + spegelfil(1))).toBe(false);
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
    expect(await iFjarren(v, KATALOG + '/' + spegelfil(1))).toBe(true);
    // Kontroll: bara det okommittade saknas.
    expect(await korLeverera(v)).toEqual({
      levererad: true, steg: null, kod: null, committade: false, anrop: ['add', 'diff', 'pull', 'push'],
    });
    expect(await antalCommits(v)).toBe(fore + 1);
  });

  it('F2 (AK 2): pull och push som fallerar tas igen med den befintliga committen', async () => {
    const v = await nyVarld();
    await skrivSpegelfil(v, spegelfil(2), 'tva\n');
    const fore = await antalCommits(v);
    const spets0 = await fjarrSpets(v);
    await git(v, v.valv, 'remote', 'set-url', 'origin', path.join(v.hem, 'finns-inte.git'));
    const pull = await korLeverera(v);
    expect(pull).toMatchObject({
      levererad: false, steg: 'pull', committade: true, anrop: ['add', 'diff', 'commit', 'pull'],
    });
    expect(Number.isInteger(pull.kod)).toBe(true);
    expect(pull.kod).not.toBe(0);
    expect(await antalCommits(v)).toBe(fore + 1);
    expect(await fjarrSpets(v)).toBe(spets0);
    await git(v, v.valv, 'remote', 'set-url', 'origin', v.fjarr);
    expect(await korLeverera(v)).toEqual({
      levererad: true, steg: null, kod: null, committade: false, anrop: ['add', 'diff', 'pull', 'push'],
    });
    expect(await antalCommits(v)).toBe(fore + 1);
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
    expect(await iFjarren(v, KATALOG + '/' + spegelfil(2))).toBe(true);

    await skrivSpegelfil(v, spegelfil(3), 'tre\n');
    const fore2 = await antalCommits(v);
    await sattKrok(path.join(v.fjarr, 'hooks'), 'pre-receive');
    const push = await korLeverera(v);
    expect(push).toMatchObject({ levererad: false, steg: 'push', committade: true, anrop: [...STEG] });
    expect(Number.isInteger(push.kod)).toBe(true);
    expect(push.kod).not.toBe(0);
    expect(await antalCommits(v)).toBe(fore2 + 1);
    expect(await fjarrSpets(v)).not.toBe(await lokalSpets(v));
    await rm(path.join(v.fjarr, 'hooks', 'pre-receive'), { force: true });
    expect(await korLeverera(v)).toEqual({
      levererad: true, steg: null, kod: null, committade: false, anrop: ['add', 'diff', 'pull', 'push'],
    });
    expect(await antalCommits(v)).toBe(fore2 + 1);
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
  });

  it('F3 (AK 1, 2): varje fel avbryter vid just det steget', async () => {
    for (const [i, steg] of STEG.entries()) {
      const v = await nyVarld();
      await skrivSpegelfil(v, spegelfil(1), 'ett\n');
      const spets0 = await fjarrSpets(v);
      expect(await korLeverera(v, { SPEGEL_FEL_STEG: steg })).toEqual({
        levererad: false, steg, kod: 97, committade: steg === 'pull' || steg === 'push',
        anrop: STEG.slice(0, i + 1),
      });
      expect(await fjarrSpets(v)).toBe(spets0);
    }
    const v = await nyVarld();
    await skrivSpegelfil(v, spegelfil(1), 'ett\n');
    expect(await korLeverera(v, { SPEGEL_FEL_STEG: 'ingen' })).toEqual({
      levererad: true, steg: null, kod: null, committade: true, anrop: [...STEG],
    });
  });

  it('F8 (AK 3): argumentlistorna är den slutna tillåtelselistan', async () => {
    expect(await korKommando()).toEqual({
      steg: [...STEG],
      listor: [
        ['add', '-A', '--', KATALOG], ['diff', '--cached', '--quiet', '--', KATALOG],
        ['commit', '-q', '-m', 'spegeln: provet', '--', KATALOG], ['pull', '-q'], ['push', '-q'],
      ],
      okant: 'ValueError', tidsgrans: 120, frist: 10, koder: [124, 137, 127],
    });
  });

  it('F9 (AK 2): pull och push som aldrig svarar ger kod 124 inom tidsgränsen', async () => {
    const v = await nyVarld();
    await skrivSpegelfil(v, spegelfil(1), 'ett\n');
    const spets0 = await fjarrSpets(v);
    const skript = await sattHangning(v);
    await git(v, v.valv, 'config', 'remote.origin.uploadpack', skript);
    const t0 = Date.now();
    expect(await korLeverera(v, { SPEGEL_TIDSGRANS: '3' })).toEqual({
      levererad: false, steg: 'pull', kod: 124, committade: true, anrop: ['add', 'diff', 'commit', 'pull'],
    });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(await fjarrSpets(v)).toBe(spets0);
    await git(v, v.valv, 'config', '--unset', 'remote.origin.uploadpack');
    await git(v, v.valv, 'config', 'remote.origin.receivepack', skript);
    const t1 = Date.now();
    expect(await korLeverera(v, { SPEGEL_TIDSGRANS: '3' })).toEqual({
      levererad: false, steg: 'push', kod: 124, committade: false, anrop: ['add', 'diff', 'pull', 'push'],
    });
    expect(Date.now() - t1).toBeLessThan(15_000);
    expect(await fjarrSpets(v)).toBe(spets0);
    await git(v, v.valv, 'config', '--unset', 'remote.origin.receivepack');
    expect(await korLeverera(v, { SPEGEL_TIDSGRANS: '3' })).toEqual({
      levererad: true, steg: null, kod: null, committade: false, anrop: ['add', 'diff', 'pull', 'push'],
    });
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
  });

  it('F11 (AK 1, 2): git städar egna lås vid tidsgränsen och lämnar andra skrivares lås', async () => {
    const v = await nyVarld();
    await skrivSpegelfil(v, spegelfil(1), 'ett\n');
    const fore = await antalCommits(v);
    const spets0 = await fjarrSpets(v);
    await sattKrok(path.join(v.valv, '.git', 'hooks'), 'pre-commit', 'exec sleep 30');
    const t0 = Date.now();
    expect(await korLeverera(v, { SPEGEL_TIDSGRANS: '3' })).toEqual({
      levererad: false, steg: 'commit', kod: 124, committade: false, anrop: ['add', 'diff', 'commit'],
    });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(await sparrfiler(v)).toEqual([]);
    expect(await antalCommits(v)).toBe(fore);
    expect(await okommittat(v, KATALOG + '/' + spegelfil(1))).toBe(true);
    expect(await fjarrSpets(v)).toBe(spets0);
    await rm(path.join(v.valv, '.git', 'hooks', 'pre-commit'), { force: true });
    expect(await korLeverera(v, { SPEGEL_TIDSGRANS: '3' })).toEqual({
      levererad: true, steg: null, kod: null, committade: true, anrop: [...STEG],
    });
    expect(await antalCommits(v)).toBe(fore + 1);
    expect(await okommittat(v, KATALOG + '/' + spegelfil(1))).toBe(false);
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
    expect(await iFjarren(v, KATALOG + '/' + spegelfil(1))).toBe(true);
    expect(await sparrfiler(v)).toEqual([]);

    await skrivSpegelfil(v, spegelfil(2), 'tva\n');
    const fore2 = await antalCommits(v);
    const sparrfil = path.join(v.valv, '.git', 'index.lock');
    await writeFile(sparrfil, '');
    const blockerad = await korLeverera(v);
    expect(blockerad).toMatchObject({ levererad: false, steg: 'add', committade: false, anrop: ['add'] });
    expect(Number.isInteger(blockerad.kod)).toBe(true);
    expect(blockerad.kod).not.toBe(0);
    expect(await sparrfiler(v)).toEqual(['index.lock']);
    expect(await antalCommits(v)).toBe(fore2);
    expect(await okommittat(v, KATALOG + '/' + spegelfil(2))).toBe(true);
    // Kontroll: den andra skrivaren släpper sitt lås. Modulen får aldrig göra det.
    await rm(sparrfil, { force: true });
    expect(await korLeverera(v)).toEqual({
      levererad: true, steg: null, kod: null, committade: true, anrop: [...STEG],
    });
    expect(await antalCommits(v)).toBe(fore2 + 1);
    expect(await iFjarren(v, KATALOG + '/' + spegelfil(2))).toBe(true);
    expect(await sparrfiler(v)).toEqual([]);
  });

  it('F12 (AK 1, 2): ett program som ignorerar SIGTERM dödas efter fristen', async () => {
    const v = await nyVarld();
    const seg = await sattSegGit(v);
    const t0 = Date.now();
    expect(await korKorGit(v, { PATH: seg + path.delimiter + (process.env.PATH ?? '') })).toEqual({ kod: 137 });
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(await korKorGit(v)).toEqual({ kod: 0 });
  });
});

async function skrivNyckel(hem: string, nyckel: string): Promise<void> {
  const katalog = path.join(hem, '.hermes');
  await mkdir(katalog, { recursive: true });
  const fil = path.join(katalog, 'arenden-nyckel');
  await writeFile(fil, nyckel, { mode: 0o600 });
  await chmod(fil, 0o600);
}
const FELRAD = (steg: string, kod: number): string =>
  `spegeln: leveransen misslyckades i git ${steg} (kod ${kod}); vattenmarket ar orort`;
async function hamtaVattenmarke(v: Varld): Promise<string> {
  return readFile(v.markfil, 'utf8');
}
async function statuskod(v: Varld, relativ: string): Promise<string> {
  return (await git(v, v.valv, 'status', '--porcelain', '-z', '--', relativ)).slice(0, 2);
}
async function filerIHead(v: Varld): Promise<string[]> {
  return (await git(v, v.valv, 'diff-tree', '--no-commit-id', '--name-only', '-r', '-z', 'HEAD'))
    .split('\0').filter((fil) => fil.length > 0);
}
interface Spegelutfall {
  kod: number;
  ut: { skrivna: number; sedan: string; anrop: string[] };
  fel: string;
}

describe('FR-18/Story 10.1 AK 1–3: spegeln körs mot testservern', () => {
  let app: Express;
  let server: Server;
  let bas: string;
  let nyckel: string;
  let forsta: string;

  beforeAll(async () => {
    app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((klar) => server.once('listening', klar));
    bas = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await seedaTeam();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'spegeln' });
    const svar = await kor(app, nyckel, 'create_issue', { title: 'Spegelprovet ett', team_key: 'LOC' });
    expect(svar.status).toBe(200);
    forsta = svar.body.result.identifier as string;
  });

  afterAll(async () => {
    await new Promise<void>((klar) => server.close(() => klar()));
  });

  async function korSpegeln(v: Varld, nytt: string, extra?: Record<string, string>): Promise<Spegelutfall> {
    const resultat = await korDrivern(v, ['spegla', v.valv, KATALOG, v.markfil, nytt], bas, extra);
    if (resultat.kod !== 0 && resultat.kod !== 1) throw new Error(resultat.fel);
    return { kod: resultat.kod, ut: JSON.parse(resultat.ut) as Spegelutfall['ut'], fel: resultat.fel };
  }

  it('F4 (AK 1): commitfel larmar utan flyttat vattenmärke och tas igen utan skrivning', async () => {
    const v = await nyVarld();
    await skrivNyckel(v.hem, nyckel);
    await sattKrok(path.join(v.valv, '.git', 'hooks'), 'pre-commit');
    const fore = await antalCommits(v);
    const spets0 = await fjarrSpets(v);
    const fel = await korSpegeln(v, 'v1');
    expect(fel.kod).toBe(1);
    expect(fel.ut.sedan).toBe('v0');
    expect(fel.ut.anrop).toEqual([]);
    expect(fel.ut.skrivna).toBeGreaterThan(0);
    expect(fel.fel).toBe(FELRAD('commit', 1) + '\n');
    expect(await hamtaVattenmarke(v)).toBe('v0');
    expect(await antalCommits(v)).toBe(fore);
    expect(await okommittat(v, KATALOG + '/' + spegelfil(forsta))).toBe(true);
    expect(await fjarrSpets(v)).toBe(spets0);
    await rm(path.join(v.valv, '.git', 'hooks', 'pre-commit'), { force: true });
    expect(await korSpegeln(v, 'v2')).toEqual({
      kod: 0, ut: { skrivna: 0, sedan: 'v0', anrop: [] }, fel: '',
    });
    expect(await hamtaVattenmarke(v)).toBe('v2');
    expect(await antalCommits(v)).toBe(fore + 1);
    expect(await okommittat(v, KATALOG + '/' + spegelfil(forsta))).toBe(false);
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
    expect(await iFjarren(v, KATALOG + '/' + spegelfil(forsta))).toBe(true);
  });

  it('F5 (AK 2): pull- och pushfel behåller vattenmärket och nästa körning levererar samma commit', async () => {
    const v = await nyVarld();
    await skrivNyckel(v.hem, nyckel);
    expect((await korSpegeln(v, 'v1')).kod).toBe(0);
    expect(await hamtaVattenmarke(v)).toBe('v1');
    const andra = await kor(app, nyckel, 'create_issue', { title: 'Spegelprovet tva', team_key: 'LOC' });
    expect(andra.status).toBe(200);
    const fore = await antalCommits(v);
    const spets0 = await fjarrSpets(v);
    await git(v, v.valv, 'remote', 'set-url', 'origin', path.join(v.hem, 'finns-inte.git'));
    const pull = await korSpegeln(v, 'v2');
    expect(pull.kod).toBe(1);
    expect(pull.ut).toEqual({ skrivna: 1, sedan: 'v1', anrop: [] });
    const pullkod = /\(kod (-?\d+)\)/.exec(pull.fel)?.[1];
    expect(pullkod).toBeDefined();
    const k = Number(pullkod);
    expect(Number.isInteger(k)).toBe(true);
    expect(k).not.toBe(0);
    expect(pull.fel).toBe(FELRAD('pull', k) + '\n');
    expect(await hamtaVattenmarke(v)).toBe('v1');
    expect(await antalCommits(v)).toBe(fore + 1);
    expect(await fjarrSpets(v)).toBe(spets0);
    await git(v, v.valv, 'remote', 'set-url', 'origin', v.fjarr);
    expect(await korSpegeln(v, 'v3')).toEqual({
      kod: 0, ut: { skrivna: 0, sedan: 'v1', anrop: [] }, fel: '',
    });
    expect(await antalCommits(v)).toBe(fore + 1);
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
    expect(await hamtaVattenmarke(v)).toBe('v3');

    const tredje = await kor(app, nyckel, 'create_issue', { title: 'Spegelprovet tre', team_key: 'LOC' });
    expect(tredje.status).toBe(200);
    const fore2 = await antalCommits(v);
    await sattKrok(path.join(v.fjarr, 'hooks'), 'pre-receive');
    const push = await korSpegeln(v, 'v4');
    expect(push.kod).toBe(1);
    expect(push.ut).toEqual({ skrivna: 1, sedan: 'v3', anrop: [] });
    const pushkod = /\(kod (-?\d+)\)/.exec(push.fel)?.[1];
    expect(pushkod).toBeDefined();
    const k2 = Number(pushkod);
    expect(Number.isInteger(k2)).toBe(true);
    expect(k2).not.toBe(0);
    expect(push.fel).toBe(FELRAD('push', k2) + '\n');
    expect(await hamtaVattenmarke(v)).toBe('v3');
    expect(await antalCommits(v)).toBe(fore2 + 1);
    await rm(path.join(v.fjarr, 'hooks', 'pre-receive'), { force: true });
    expect(await korSpegeln(v, 'v5')).toEqual({
      kod: 0, ut: { skrivna: 0, sedan: 'v3', anrop: [] }, fel: '',
    });
    expect(await antalCommits(v)).toBe(fore2 + 1);
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
    expect(await hamtaVattenmarke(v)).toBe('v5');
  });

  it('F6 (AK 3): levererade bytes står kvar och bara spegelkatalogen levereras', async () => {
    const v = await nyVarld();
    await skrivNyckel(v.hem, nyckel);
    expect((await korSpegeln(v, 'v1')).kod).toBe(0);
    await writeFile(path.join(v.valv, 'start.txt'), 'andrad\n');
    await writeFile(path.join(v.valv, 'utanfor.txt'), 'utanfor\n');
    await writeFile(path.join(v.valv, 'forberedd.txt'), 'forberedd\n');
    await git(v, v.valv, 'add', 'forberedd.txt');
    expect(await statuskod(v, 'start.txt')).toBe(' M');
    expect(await statuskod(v, 'utanfor.txt')).toBe('??');
    expect(await statuskod(v, 'forberedd.txt')).toBe('A ');
    const fore = await antalCommits(v);
    const namn = (await readdir(path.join(v.valv, KATALOG))).sort();
    const foreFiler = new Map<string, Buffer>();
    for (const fil of namn) foreFiler.set(fil, await readFile(path.join(v.valv, KATALOG, fil)));
    expect(await korSpegeln(v, 'v2')).toEqual({
      kod: 0, ut: { skrivna: 0, sedan: 'v1', anrop: [] }, fel: '',
    });
    expect(await antalCommits(v)).toBe(fore);
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
    expect(await hamtaVattenmarke(v)).toBe('v2');
    expect((await readdir(path.join(v.valv, KATALOG))).sort()).toEqual(namn);
    for (const [fil, bytes] of foreFiler) {
      expect((await readFile(path.join(v.valv, KATALOG, fil))).equals(bytes)).toBe(true);
    }
    expect(await statuskod(v, 'start.txt')).toBe(' M');
    expect(await statuskod(v, 'utanfor.txt')).toBe('??');
    expect(await statuskod(v, 'forberedd.txt')).toBe('A ');
    expect(await iFjarren(v, 'utanfor.txt')).toBe(false);
    expect(await iFjarren(v, 'forberedd.txt')).toBe(false);

    // Kontroll: bara en ny fil under spegelkatalogen skiljer körningen från den förra.
    await skrivSpegelfil(v, spegelfil(9999), 'hand\n');
    expect(await korSpegeln(v, 'v3')).toEqual({
      kod: 0, ut: { skrivna: 0, sedan: 'v2', anrop: [] }, fel: '',
    });
    expect(await antalCommits(v)).toBe(fore + 1);
    expect(await filerIHead(v)).toEqual([KATALOG + '/' + spegelfil(9999)]);
    expect(await iFjarren(v, KATALOG + '/' + spegelfil(9999))).toBe(true);
    expect(await statuskod(v, 'start.txt')).toBe(' M');
    expect(await statuskod(v, 'utanfor.txt')).toBe('??');
    expect(await statuskod(v, 'forberedd.txt')).toBe('A ');
    expect(await iFjarren(v, 'utanfor.txt')).toBe(false);
    expect(await iFjarren(v, 'forberedd.txt')).toBe(false);
  });

  it('F7 (AK 1, 2): varje fel behåller vattenmärket och låset omsluter hela leveransen', async () => {
    for (const [i, steg] of STEG.entries()) {
      const v = await nyVarld();
      await skrivNyckel(v.hem, nyckel);
      const fel = await korSpegeln(v, 'v9', { SPEGEL_FEL_STEG: steg });
      expect(fel.kod).toBe(1);
      expect(fel.ut.sedan).toBe('v0');
      expect(fel.ut.anrop).toEqual(['sparr-in', ...STEG.slice(0, i + 1), 'sparr-ut']);
      expect(fel.fel).toBe(FELRAD(steg, 97) + '\n');
      expect(await hamtaVattenmarke(v)).toBe('v0');
    }
    const v = await nyVarld();
    await skrivNyckel(v.hem, nyckel);
    const kontroll = await korSpegeln(v, 'v9', { SPEGEL_FEL_STEG: 'ingen' });
    expect(kontroll.kod).toBe(0);
    expect(kontroll.ut.anrop).toEqual(['sparr-in', ...STEG, 'sparr-ut']);
    expect(kontroll.fel).toBe('');
    expect(await hamtaVattenmarke(v)).toBe('v9');
  });

  it('F10 (AK 2): en pull som aldrig svarar larmar och lämnar vattenmärket orört', async () => {
    const v = await nyVarld();
    await skrivNyckel(v.hem, nyckel);
    const skript = await sattHangning(v);
    await git(v, v.valv, 'config', 'remote.origin.uploadpack', skript);
    const spets0 = await fjarrSpets(v);
    const t0 = Date.now();
    const fel = await korSpegeln(v, 'v1', { SPEGEL_TIDSGRANS: '3' });
    expect(fel.kod).toBe(1);
    expect(fel.ut.sedan).toBe('v0');
    expect(fel.ut.anrop).toEqual(['sparr-in', 'add', 'diff', 'commit', 'pull', 'sparr-ut']);
    expect(fel.fel).toBe(FELRAD('pull', 124) + '\n');
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(await hamtaVattenmarke(v)).toBe('v0');
    expect(await fjarrSpets(v)).toBe(spets0);
    await git(v, v.valv, 'config', '--unset', 'remote.origin.uploadpack');
    expect(await korSpegeln(v, 'v2', { SPEGEL_TIDSGRANS: '3' })).toEqual({
      kod: 0, ut: { skrivna: 0, sedan: 'v0', anrop: ['sparr-in', 'add', 'diff', 'pull', 'push', 'sparr-ut'] },
      fel: '',
    });
    expect(await hamtaVattenmarke(v)).toBe('v2');
    expect(await fjarrSpets(v)).toBe(await lokalSpets(v));
  });
});
