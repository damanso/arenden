// FR-18, B-17 punkten Tre utfall, Story 10.2.
// Kör adapter/spegellasning.py som barnprocess mot egna speglar i tmpdir(): varje fil som
// inte går att läsa får sitt namn i olasbara och ger KUNDE_INTE, aldrig GRON; frisk synk
// ger GRON utan larm, stannad ger ROD med larm, och utfallen har var sin exitkod.
// Den riktiga spegeln och spegelprovet i drift läses aldrig. Införandet där sker utanför bygget.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

// Barnprocessen och tillåtelselistan följer test/pythonklient.test.ts; provfiler exporterar inga hjälpare.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const MODULEN = path.join(ADAPTERN, 'spegellasning.py');
const NU = kl('2026-10-22', '12.00');
const ANROPSRAD = 'KUNDE_INTE: anropet gar inte att tolka: <katalog> <grans_minuter> [<nu>]';

function kl(datum: string, hhmm: string): string {
  return `${datum} ${hhmm.replace('.', ':')}`;
}

function namn(n: number): string {
  return `LOC-${n}.md`;
}

interface Spegel {
  hem: string;
  katalog: string;
}

interface Processutfall {
  kod: number;
  ut: string;
  fel: string;
}

interface Lasning {
  katalogfel: string | null;
  filer: number;
  lasta: number;
  senaste: string | null;
  olasbara: [string, string][];
}

function barnmiljo(hem: string): NodeJS.ProcessEnv {
  // Provprocessen bär test/env.ts:s variabler, och riktiga HOME hör till driften.
  // Därför är detta hela miljön, utan spridning av process.env.
  return { PATH: process.env.PATH, HOME: hem };
}

const hemkataloger: string[] = [];

async function nySpegel(): Promise<Spegel> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-spegellasning-'));
  hemkataloger.push(hem);
  const katalog = path.join(hem, 'linear-arkiv');
  await mkdir(katalog);
  return { hem, katalog };
}

afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

function arendetext(nummer: number, falt: string[]): string {
  return [
    '---', 'typ: linear-arkiv', `arende: LOC-${nummer}`, 'status: Backlog', ...falt, '---',
    '', `# LOC-${nummer} — Spegelprovet ${nummer}`, '', '> **Derivat — redigera inte.**',
    '', '**Status:** Backlog', '', '## Beskrivning', 'Fixtur.', '',
  ].join('\n');
}

async function skrivFil(v: Spegel, filnamn: string, innehall: string | Buffer): Promise<void> {
  await writeFile(path.join(v.katalog, filnamn), innehall);
}

// -I isolerar importerna och -B hindrar cachefiler i adapter/. Kod 3 skiljer en trasig
// drivrutin från modulens tre utfall; varje oväntat undantag syns med sitt spår.
const DRIVER = [
  'import json',
  'import sys',
  'import traceback',
  '',
  'try:',
  '    sys.path.insert(0, sys.argv[1])',
  '    import spegellasning',
  '    operation = sys.argv[2]',
  '    if operation == "las":',
  '        print(json.dumps(spegellasning.las_spegeln(sys.argv[3])._asdict()))',
  '        sys.exit(0)',
  '    elif operation == "krasch":',
  '        def krasch(katalog):',
  '            raise RuntimeError("provets krasch")',
  '        spegellasning.las_spegeln = krasch',
  '        sys.exit(spegellasning.huvud(sys.argv[3:]))',
  '    else:',
  '        sys.exit(2)',
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

async function korDrivern(v: Spegel, argument: string[]): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess(
      'python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, ...argument],
      { cwd: ROT, env: barnmiljo(v.hem), timeout: 20_000 },
    );
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}

async function korLas(v: Spegel, katalog: string): Promise<Lasning> {
  const resultat = await korDrivern(v, ['las', katalog]);
  if (resultat.kod !== 0) throw new Error(resultat.fel);
  return JSON.parse(resultat.ut) as Lasning;
}

async function korProvet(v: Spegel, argument: string[]): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', MODULEN, ...argument], {
      cwd: ROT, env: barnmiljo(v.hem), timeout: 20_000,
    });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}

function rader(ut: string): string[] {
  return ut.split(/\r?\n/).filter((rad) => rad.length > 0);
}

describe('FR-18/Story 10.2 AK 1–3: läsningen ser varje fil som inte går att läsa', () => {
  it('F1 (AK 1, 2): varje oläsbar form hamnar i olasbara med sitt namn, och de läsbara räknas', async () => {
    const v = await nySpegel();
    await skrivFil(v, namn(1), arendetext(1, [
      `uppdaterad: '${kl('2026-10-22', '09.15')}'`, "skapad: '2026-10-20'",
    ]));
    await skrivFil(v, namn(2), arendetext(2, [`uppdaterad: "${kl('2026-10-22', '10.40')}"`]));
    await skrivFil(v, namn(3), arendetext(3, ["skapad: '2026-10-21'"]));
    await skrivFil(v, namn(4), arendetext(4, [`uppdaterad: ${kl('2026-10-22', '08.05')}`]));
    await skrivFil(v, '_las-mig.md', 'läs mig\n');
    await symlink(path.join(v.hem, 'mal-som-saknas'), path.join(v.katalog, namn(7)));
    await mkdir(path.join(v.katalog, namn(8)));
    await skrivFil(v, namn(9), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
    await skrivFil(v, namn(10), arendetext(10, []));
    await skrivFil(v, namn(11), arendetext(11, ["uppdaterad: '22/10 2026'"]));
    await skrivFil(v, namn(12), arendetext(12, [`uppdaterad: '${kl('2026-02-30', '10.00')}'`]));

    expect(await korLas(v, v.katalog)).toEqual({
      katalogfel: null, filer: 10, lasta: 4, senaste: kl('2026-10-22', '10.40'),
      olasbara: [
        [namn(10), 'ValueError'], [namn(11), 'ValueError'], [namn(12), 'ValueError'],
        [namn(7), 'FileNotFoundError'], [namn(8), 'IsADirectoryError'], [namn(9), 'UnicodeDecodeError'],
      ],
    });

    // Kontroll: endast de sex oläsbara posterna tas bort.
    for (const n of [7, 8, 9, 10, 11, 12]) {
      await rm(path.join(v.katalog, namn(n)), { recursive: true, force: true });
    }
    expect(await korLas(v, v.katalog)).toEqual({
      katalogfel: null, filer: 4, lasta: 4, senaste: kl('2026-10-22', '10.40'), olasbara: [],
    });
  });

  it('F2 (AK 3): en katalog som inte går att läsa ger katalogfel, och en tom katalog ger noll filer', async () => {
    const v = await nySpegel();
    expect(await korLas(v, path.join(v.hem, 'finns-inte'))).toEqual({
      katalogfel: 'FileNotFoundError', filer: 0, lasta: 0, senaste: null, olasbara: [],
    });
    const fil = path.join(v.hem, 'vanlig.txt');
    await writeFile(fil, 'x\n');
    expect(await korLas(v, fil)).toEqual({
      katalogfel: 'NotADirectoryError', filer: 0, lasta: 0, senaste: null, olasbara: [],
    });
    // Kontroll: katalogen finns och är tom.
    expect(await korLas(v, v.katalog)).toEqual({
      katalogfel: null, filer: 0, lasta: 0, senaste: null, olasbara: [],
    });
  });
});

describe('FR-18/Story 10.2 AK 1–3: provet har tre utfall med var sin exitkod', () => {
  it('F3 (AK 1): en oläsbar fil ger KUNDE_INTE med filens namn, aldrig GRON, och går före färskheten', async () => {
    const v = await nySpegel();
    await skrivFil(v, namn(1), arendetext(1, [`uppdaterad: '${kl('2026-10-22', '11.30')}'`]));
    await skrivFil(v, namn(2), arendetext(2, [`uppdaterad: '${kl('2026-10-22', '11.00')}'`]));
    await symlink(path.join(v.hem, 'mal-som-saknas'), path.join(v.katalog, namn(5)));
    const vantade = [
      'KUNDE_INTE: 1 av 3 spegelfiler gar inte att lasa',
      `spegeln: filer=3 lasta=2 olasbara=1 senaste=${kl('2026-10-22', '11.30')}`,
      `olasbar: ${namn(5)} (FileNotFoundError)`,
    ];
    const frisk = await korProvet(v, [v.katalog, '120', NU]);
    expect(frisk.kod).toBe(2);
    expect(frisk.fel).toBe('');
    expect(rader(frisk.ut)).toEqual(vantade);
    expect(rader(frisk.ut).some((rad) => rad.startsWith('GRON'))).toBe(false);
    expect(frisk.ut).not.toContain('inget nytt');

    const gammal = await korProvet(v, [v.katalog, '120', kl('2026-10-23', '12.00')]);
    expect(gammal.kod).toBe(2);
    expect(gammal.fel).toBe('');
    expect(rader(gammal.ut)).toEqual(vantade);
    expect(rader(gammal.ut).some((rad) => /^(GRON|ROD|LARM)/.test(rad))).toBe(false);
    expect(gammal.ut).not.toContain('inget nytt');

    await rm(path.join(v.katalog, namn(5)));
    await mkdir(path.join(v.katalog, namn(5)));
    const katalog = await korProvet(v, [v.katalog, '120', NU]);
    expect(katalog.kod).toBe(2);
    expect(katalog.fel).toBe('');
    expect(rader(katalog.ut)).toEqual([
      ...vantade.slice(0, 2), `olasbar: ${namn(5)} (IsADirectoryError)`,
    ]);

    // Kontroll: samma spegel utan den oläsbara posten.
    await rm(path.join(v.katalog, namn(5)), { recursive: true, force: true });
    const kontroll = await korProvet(v, [v.katalog, '120', NU]);
    expect(kontroll.kod).toBe(0);
    expect(kontroll.fel).toBe('');
    expect(rader(kontroll.ut)).toEqual([
      'GRON: spegeln ar farsk',
      `spegeln: filer=2 lasta=2 olasbara=0 senaste=${kl('2026-10-22', '11.30')}`,
    ]);
  });

  it('F4 (AK 2): en frisk synk tiger och en stannad larmar', async () => {
    const v = await nySpegel();
    await skrivFil(v, namn(1), arendetext(1, [`uppdaterad: '${kl('2026-10-22', '10.00')}'`]));
    const S = `spegeln: filer=1 lasta=1 olasbara=0 senaste=${kl('2026-10-22', '10.00')}`;
    const frisk = await korProvet(v, [v.katalog, '120', kl('2026-10-22', '11.00')]);
    expect(frisk.kod).toBe(0);
    expect(frisk.fel).toBe('');
    expect(rader(frisk.ut)).toEqual(['GRON: spegeln ar farsk', S]);
    expect(rader(frisk.ut).some((rad) => rad.startsWith('LARM'))).toBe(false);

    const stannad = await korProvet(v, [v.katalog, '120', kl('2026-10-22', '13.00')]);
    expect(stannad.kod).toBe(1);
    expect(stannad.fel).toBe('');
    expect(rader(stannad.ut)).toEqual([
      'ROD: spegeln har stannat', S,
      `LARM: senaste uppdaterad ${kl('2026-10-22', '10.00')} ar 180 minuter gammal, gransen ar 120 minuter`,
    ]);

    const gransen = await korProvet(v, [v.katalog, '120', kl('2026-10-22', '12.00')]);
    expect(gransen.kod).toBe(0);
    expect(rader(gransen.ut)[0]).toBe('GRON: spegeln ar farsk');
    const over = await korProvet(v, [v.katalog, '120', kl('2026-10-22', '12.01')]);
    expect(over.kod).toBe(1);
    expect(rader(over.ut).at(-1)).toBe(
      `LARM: senaste uppdaterad ${kl('2026-10-22', '10.00')} ar 121 minuter gammal, gransen ar 120 minuter`,
    );

    const framtida = await nySpegel();
    await skrivFil(framtida, namn(1), arendetext(1, [`uppdaterad: '${kl('2999-12-31', '23.59')}'`]));
    const framtid = await korProvet(framtida, [framtida.katalog, '60']);
    expect(framtid.kod).toBe(0);
    expect(rader(framtid.ut)[0]).toBe('GRON: spegeln ar farsk');
    const gammal = await nySpegel();
    await skrivFil(gammal, namn(1), arendetext(1, [`uppdaterad: '${kl('2000-01-01', '00.00')}'`]));
    const forfluten = await korProvet(gammal, [gammal.katalog, '60']);
    expect(forfluten.kod).toBe(1);
    expect(rader(forfluten.ut)[0]).toBe('ROD: spegeln har stannat');
    const larm = rader(forfluten.ut).at(-1);
    expect(larm?.startsWith(`LARM: senaste uppdaterad ${kl('2000-01-01', '00.00')} ar `)).toBe(true);
    expect(larm?.endsWith(' minuter gammal, gransen ar 60 minuter')).toBe(true);
  });

  it('F5 (AK 3): tre utfall, tre skilda exitkoder, och varje väg som inte kan döma ger KUNDE_INTE', async () => {
    const gron = await nySpegel();
    const rod = await nySpegel();
    const kundeInte = await nySpegel();
    for (const v of [gron, rod, kundeInte]) {
      await skrivFil(v, namn(1), arendetext(1, [`uppdaterad: '${kl('2026-10-22', '10.00')}'`]));
    }
    await skrivFil(kundeInte, namn(9), Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a]));
    const utfall = [
      await korProvet(gron, [gron.katalog, '120', kl('2026-10-22', '11.00')]),
      await korProvet(rod, [rod.katalog, '120', kl('2026-10-22', '13.00')]),
      await korProvet(kundeInte, [kundeInte.katalog, '120', kl('2026-10-22', '11.00')]),
    ];
    const koderna = utfall.map((u) => u.kod);
    expect(koderna).toEqual([0, 1, 2]);
    expect(new Set(koderna).size).toBe(3);
    expect(utfall.map((u) => rader(u.ut)[0]?.split(': ')[0])).toEqual(['GRON', 'ROD', 'KUNDE_INTE']);

    const v = await nySpegel();
    const tom = await korProvet(v, [v.katalog, '120', NU]);
    expect(tom.kod).toBe(2);
    expect(rader(tom.ut)).toEqual([
      `KUNDE_INTE: inga spegelfiler i ${v.katalog}`,
      'spegeln: filer=0 lasta=0 olasbara=0 senaste=-',
    ]);
    const k = path.join(v.hem, 'finns-inte');
    const saknad = await korProvet(v, [k, '120', NU]);
    expect(saknad.kod).toBe(2);
    expect(rader(saknad.ut)).toEqual([
      `KUNDE_INTE: spegelkatalogen gar inte att lasa: ${k} (FileNotFoundError)`,
      'spegeln: filer=0 lasta=0 olasbara=0 senaste=-',
    ]);

    await skrivFil(v, namn(1), arendetext(1, [`uppdaterad: '${kl('2026-10-22', '11.00')}'`]));
    for (const argument of [
      [], [v.katalog], [v.katalog, 'tva'], [v.katalog, '120', '22/10 2026'],
      [v.katalog, '120', kl('2026-02-30', '10.00')], [v.katalog, '120', NU, 'extra'],
    ]) {
      const ogiltigt = await korProvet(v, argument);
      expect(ogiltigt.kod).toBe(2);
      expect(rader(ogiltigt.ut)).toEqual([ANROPSRAD]);
    }
    // Kontroll: samma spegel med ett anrop som går att tolka.
    const kontroll = await korProvet(v, [v.katalog, '120', NU]);
    expect(kontroll.kod).toBe(0);
    expect(rader(kontroll.ut)).toEqual([
      'GRON: spegeln ar farsk',
      `spegeln: filer=1 lasta=1 olasbara=0 senaste=${kl('2026-10-22', '11.00')}`,
    ]);
    const krasch = await korDrivern(v, ['krasch', v.katalog, '120', NU]);
    expect(krasch.kod).toBe(2);
    expect(krasch.fel).toBe('');
    expect(rader(krasch.ut)).toEqual(['KUNDE_INTE: provet stannade: RuntimeError']);
  });
});
