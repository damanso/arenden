// FR-31, B-17 punkten Tre utfall, Story 10.7.
// Kör adapter/kopplingslasning.py mot egna underlag i tmpdir(): oläsbara register ger
// KUNDE_INTE för kopplingen och aldrig GRON (AK 1). Id-register kräver id, kunddokument
// är enda namnregistret där en bar sträng är giltig, och KONTROLL 4–6 fäller namnmatchning
// (AK 2). De tre utfallen har var sin exitkod. Kopplingsprovet i drift, provvakten,
// redovisningen och riktiga valvet läses aldrig; införandet sker utanför bygget.
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

// Barnprocess, drivrutin och städning följer test/spegellasning.test.ts.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const MODULEN = path.join(ADAPTERN, 'kopplingslasning.py');
const ANROPSRAD = 'KUNDE_INTE: anropet gar inte att tolka: --manifest <fil> --redovisning <fil> --arenden <fil> --kunddokument <katalog>';
const REDOVISNING = [
  { id: 'kund-1', namn: 'Kunden Ett AB' }, { id: 'kund-2', namn: 'Kunden Tva AB' },
];
const ARENDEN = [{ id: 'projekt-1', namn: 'Projektet Ett' }];
const KATALOGER = ['Kunden Ett AB', 'Kunden Tva AB'];
const KUND_ETT = {
  manifest: 'kund-ett', redovisning: 'kund-1', arenden: 'projekt-1', kunddokument: 'Kunden Ett AB',
};
const KUND_TVA = {
  manifest: 'kund-tva', redovisning: 'kund-2', arenden: null, kunddokument: 'Kunden Tva AB',
};
const MANIFEST = [KUND_ETT, KUND_TVA];
const GRONRAD = 'GRON: varje ifylld koppling finns i sitt register, och konsumenterna laser id:t';
const RODRAD = 'ROD: kopplingarna haller inte';
const KUNDE_INTE_RAD = 'KUNDE_INTE: delar av kopplingsprovet gar inte att prova';
const NAMNREGISTERRAD = 'kunddokument ar det enda namnregistret: katalognamnet ar hela identiteten, och en bar strang ar giltig dar';
const KONTROLLER_OK = [
  'KONTROLL 4 redovisning: ok', 'KONTROLL 5 arenden: ok', 'KONTROLL 6 kunddokument: ok',
];

function summa(ifyllda: number, ok: number, fel: number, oprovade: number, tomma: number): string {
  return `kopplingar: ifyllda=${ifyllda} ok=${ok} fel=${fel} oprovade=${oprovade} tomma=${tomma}`;
}

function koppling(manifest: string, register: string, varde: string, status: string, skal: string): string {
  return `koppling ${manifest} ${register}=${varde}: ${status}, ${skal}`;
}

function olasbar(typ: string): string {
  return `registret gar inte att lasa (${typ})`;
}

function manifestMed(over: Partial<typeof KUND_ETT>): typeof MANIFEST {
  return [{ ...KUND_ETT, ...over }, KUND_TVA];
}

interface Underlag {
  hem: string;
  manifest: string;
  redovisning: string;
  arenden: string;
  kunddokument: string;
}

interface Processutfall { kod: number; ut: string; fel: string }
interface Registerlage { register: string; poster: unknown[] | null; fel: string | null }
interface Manifestlage { manifest: (string | null)[][] | null; fel: string | null }

function barnmiljo(hem: string): NodeJS.ProcessEnv {
  // Testprocessen bär test/env.ts:s variabler; riktiga HOME hör till driften.
  // Detta är hela miljön, aldrig en spridning av process.env.
  return { PATH: process.env.PATH, HOME: hem };
}

const hemkataloger: string[] = [];

async function skriv(fil: string, innehall: unknown): Promise<void> {
  await writeFile(fil, typeof innehall === 'string' || Buffer.isBuffer(innehall)
    ? innehall : JSON.stringify(innehall));
}

async function nyttUnderlag(): Promise<Underlag> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-kopplingslasning-'));
  hemkataloger.push(hem);
  const u = {
    hem, manifest: path.join(hem, 'manifest'), redovisning: path.join(hem, 'redovisning'),
    arenden: path.join(hem, 'arenden'), kunddokument: path.join(hem, 'kunddokument'),
  };
  await skriv(u.manifest, MANIFEST);
  await skriv(u.redovisning, REDOVISNING);
  await skriv(u.arenden, ARENDEN);
  await mkdir(u.kunddokument);
  for (const namn of [...KATALOGER, '.dold']) await mkdir(path.join(u.kunddokument, namn));
  await skriv(path.join(u.kunddokument, 'las-mig.txt'), 'x\n');
  return u;
}

afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

// -I isolerar importerna, -B hindrar cachefiler i adapter/. Kod 3 och spår på stderr
// skiljer en trasig drivrutin från modulens tre utfall.
const DRIVER = [
  'import json',
  'import sys',
  'import traceback',
  '',
  'try:',
  '    sys.path.insert(0, sys.argv[1])',
  '    import kopplingslasning as k',
  '    operation = sys.argv[2]',
  '    def byt(lage):',
  '        if lage == "hel":',
  '            return',
  '        if lage in ("namn_redovisning", "namn_arenden"):',
  '            register = lage.removeprefix("namn_")',
  '            k.KONSUMENTER[register] = lambda v, p: next((id for id, namn in p if v in (id, namn)), None)',
  '        elif lage == "skiftlage_kund":',
  '            k.KONSUMENTER["kunddokument"] = lambda v, p: next((n for n in p if n.casefold() == v.casefold()), None)',
  '        elif lage == "strang_avvisas":',
  '            k.KONSUMENTER["kunddokument"] = lambda v, p: None',
  '        elif lage == "kastar":',
  '            def kastar(v, p):',
  '                raise RuntimeError("provets konsument")',
  '            k.KONSUMENTER["redovisning"] = kastar',
  '        elif lage == "id_saknas":',
  '            k.KONSUMENTER["arenden"] = lambda v, p: None',
  '        elif lage == "utan_kund":',
  '            del k.KONSUMENTER["kunddokument"]',
  '        elif lage == "krasch":',
  '            def krasch(*argument):',
  '                raise RuntimeError("provets krasch")',
  '            k.kor = krasch',
  '        else:',
  '            raise ValueError("okant lage")',
  '    if operation == "las":',
  '        resultat = k.las_register(sys.argv[3], k.filregister(sys.argv[3], sys.argv[4]))._asdict()',
  '    elif operation == "lasare":',
  '        def lasare():',
  '            if sys.argv[4] == "kastar":',
  '                raise RuntimeError("provets lasare")',
  '            return json.loads(sys.argv[4])',
  '        resultat = k.las_register(sys.argv[3], lasare)._asdict()',
  '    elif operation == "manifest":',
  '        resultat = k.las_manifesten(sys.argv[3])._asdict()',
  '    elif operation == "kontrollera":',
  '        byt(sys.argv[3])',
  '        resultat = [list(kontroll) for kontroll in k.kontrollera(k.KONSUMENTER)]',
  '    elif operation == "doma":',
  '        byt(sys.argv[3])',
  '        filer = dict(zip(k.REGISTER, sys.argv[5:8]))',
  '        resultat = k.kor(sys.argv[4], filer)._asdict()',
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

async function korDrivern(hem: string, argument: string[]): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess(
      'python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, ...argument],
      { cwd: ROT, env: barnmiljo(hem), timeout: 20_000 },
    );
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}

async function korLas(u: Underlag, register: string, sokvag: string): Promise<Registerlage> {
  const p = await korDrivern(u.hem, ['las', register, sokvag]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as Registerlage;
}

async function korLasare(u: Underlag, register: string, text: string): Promise<Registerlage> {
  const p = await korDrivern(u.hem, ['lasare', register, text]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as Registerlage;
}

async function korManifest(u: Underlag, sokvag: string): Promise<Manifestlage> {
  const p = await korDrivern(u.hem, ['manifest', sokvag]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as Manifestlage;
}

async function korKontrollera(u: Underlag, lage: string): Promise<[number, string, string | null][]> {
  const p = await korDrivern(u.hem, ['kontrollera', lage]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as [number, string, string | null][];
}

async function korDoma(u: Underlag, lage = 'hel'): Promise<{ utfall: string; kod: number; rader: string[] }> {
  const p = await korDrivern(u.hem, ['doma', lage, u.manifest, u.redovisning, u.arenden, u.kunddokument]);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as { utfall: string; kod: number; rader: string[] };
}

function argumentFor(u: Underlag): string[] {
  return ['--manifest', u.manifest, '--redovisning', u.redovisning,
    '--arenden', u.arenden, '--kunddokument', u.kunddokument];
}

async function korProvet(u: Underlag, argument: string[]): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', MODULEN, ...argument], {
      cwd: ROT, env: barnmiljo(u.hem), timeout: 20_000,
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

describe('FR-31/Story 10.7 AK 1–2: registren och manifestet läses genom en enda väg', () => {
  it('F1 (AK 1, 2): varje register läses en gång och en oläsbar form ger inga poster och sin typ', async () => {
    const u = await nyttUnderlag();
    expect(await korLas(u, 'redovisning', u.redovisning)).toEqual({
      register: 'redovisning', poster: [['kund-1', 'Kunden Ett AB'], ['kund-2', 'Kunden Tva AB']], fel: null,
    });
    expect(await korLas(u, 'arenden', u.arenden)).toEqual({
      register: 'arenden', poster: [['projekt-1', 'Projektet Ett']], fel: null,
    });
    expect(await korLas(u, 'kunddokument', u.kunddokument)).toEqual({
      register: 'kunddokument', poster: KATALOGER, fel: null,
    });

    const former: [string, unknown, string][] = [
      ['r1', undefined, 'FileNotFoundError'], ['r2', undefined, 'IsADirectoryError'],
      ['r3', Buffer.from([0xff, 0xfe, 0x5b, 0x5d]), 'UnicodeDecodeError'],
      ['r4', '[', 'JSONDecodeError'],
      ['r5', { id: 'projekt-1', namn: 'Projektet Ett' }, 'ValueError'],
      ['r6', ['projekt-1'], 'ValueError'], ['r7', [{ id: 'projekt-1' }], 'ValueError'],
      ['r8', [{ id: 'projekt-1', namn: 'Projektet Ett', kund: 'kund-1' }], 'ValueError'],
      ['r9', [{ id: 7, namn: 'Projektet Ett' }], 'ValueError'],
      ['r10', [{ id: 'projekt-1', namn: null }], 'ValueError'],
      ['r11', [{ id: '  ', namn: 'Projektet Ett' }], 'ValueError'],
      ['r12', [{ id: 'projekt-1', namn: ' ' }], 'ValueError'],
      ['r13', [{ id: 'projekt-1', namn: 'A' }, { id: 'projekt-1', namn: 'B' }], 'ValueError'],
    ];
    for (const [namn, innehall, fel] of former) {
      const fil = path.join(u.hem, namn);
      if (namn === 'r2') await mkdir(fil);
      else if (namn !== 'r1') await skriv(fil, innehall);
      expect(await korLas(u, 'arenden', fil), namn).toEqual({ register: 'arenden', poster: null, fel });
    }
    expect(await korLas(u, 'redovisning', path.join(u.hem, 'r1'))).toEqual({
      register: 'redovisning', poster: null, fel: 'FileNotFoundError',
    });
    for (const [fil, fel] of [
      [path.join(u.hem, 'n1'), 'FileNotFoundError'], [u.manifest, 'NotADirectoryError'],
    ]) {
      expect(await korLas(u, 'kunddokument', fil!)).toEqual({ register: 'kunddokument', poster: null, fel });
    }

    // Kontroller: bara formen ändras; tomma register och lika namn med olika id är giltiga.
    const tomFil = path.join(u.hem, 'tom-fil');
    const tomKatalog = path.join(u.hem, 'tom-katalog');
    await skriv(tomFil, []);
    await mkdir(tomKatalog);
    expect(await korLas(u, 'arenden', tomFil)).toEqual({ register: 'arenden', poster: [], fel: null });
    expect(await korLas(u, 'kunddokument', tomKatalog)).toEqual({
      register: 'kunddokument', poster: [], fel: null,
    });
    const likaNamn = path.join(u.hem, 'lika-namn');
    await skriv(likaNamn, [
      { id: 'projekt-2', namn: 'Projektet Ett' }, { id: 'projekt-3', namn: 'Projektet Ett' },
    ]);
    expect(await korLas(u, 'arenden', likaNamn)).toEqual({
      register: 'arenden', poster: [['projekt-2', 'Projektet Ett'], ['projekt-3', 'Projektet Ett']], fel: null,
    });
    expect(await korLasare(u, 'kunddokument', '["Kunden Tva AB", "Kunden Ett AB"]')).toEqual({
      register: 'kunddokument', poster: KATALOGER, fel: null,
    });
    expect(await korLasare(u, 'redovisning', 'kastar')).toEqual({
      register: 'redovisning', poster: null, fel: 'RuntimeError',
    });
    for (const text of ['["x", "x"]', '["x", ""]', '[7]', '"x"']) {
      expect(await korLasare(u, 'kunddokument', text)).toEqual({
        register: 'kunddokument', poster: null, fel: 'ValueError',
      });
    }
    expect(await korLasare(u, 'redovisning', '[{"id": "kund-9", "namn": "Nio AB"}]')).toEqual({
      register: 'redovisning', poster: [['kund-9', 'Nio AB']], fel: null,
    });
    expect(await korLas(u, 'projekt', u.arenden)).toEqual({
      register: 'projekt', poster: null, fel: 'ValueError',
    });
  });

  it('F2 (AK 1, 2): manifestets slutna form ger inga manifest och sin typ när läsningen misslyckas', async () => {
    const u = await nyttUnderlag();
    expect(await korManifest(u, u.manifest)).toEqual({
      manifest: [['kund-ett', 'kund-1', 'projekt-1', 'Kunden Ett AB'],
        ['kund-tva', 'kund-2', null, 'Kunden Tva AB']], fel: null,
    });
    const saknadNyckel = path.join(u.hem, 'saknad-nyckel');
    await skriv(saknadNyckel, [{ manifest: 'kund-tre', kunddokument: 'Kunden Ett AB' }]);
    expect(await korManifest(u, saknadNyckel)).toEqual({
      manifest: [['kund-tre', null, null, 'Kunden Ett AB']], fel: null,
    });
    const tom = path.join(u.hem, 'tom');
    await skriv(tom, []);
    expect(await korManifest(u, tom)).toEqual({ manifest: [], fel: null });
    const former: [unknown, string][] = [
      [undefined, 'FileNotFoundError'], ['[', 'JSONDecodeError'],
      [Buffer.from([0xff, 0xfe, 0x5b, 0x5d]), 'UnicodeDecodeError'],
      ...[{}, ['kund-ett'], [{ redovisning: 'kund-1' }], [{ manifest: '  ' }],
        [{ manifest: 7 }], [{ manifest: 'kund-ett' }, { manifest: 'kund-ett' }],
        [{ manifest: 'kund-ett', projekt: 'x' }], [{ manifest: 'kund-ett', redovisning: 5 }],
        [{ manifest: 'kund-ett', arenden: '' }], [{ manifest: 'kund-ett', kunddokument: '  ' }],
      ].map((data): [unknown, string] => [data, 'ValueError']),
    ];
    for (const [index, [innehall, fel]] of former.entries()) {
      const fil = path.join(u.hem, `m${index + 1}`);
      if (index !== 0) await skriv(fil, innehall);
      expect(await korManifest(u, fil), `m${index + 1}`).toEqual({ manifest: null, fel });
    }
    // (a)–(c) ovan är kontrollerna: samma läsning, hel form.
  });
});

describe('FR-31/Story 10.7 AK 2: KONTROLL 4–6 fäller namnmatchning', () => {
  it('F3 (AK 2): modulens egna konsumenter klarar alla tre kontrollerna', async () => {
    const u = await nyttUnderlag();
    expect(await korKontrollera(u, 'hel')).toEqual([
      [4, 'redovisning', null], [5, 'arenden', null], [6, 'kunddokument', null],
    ]);
  });

  it('F4 (AK 2): namnmatchning och konsumentfel fälls av respektive kontroll', async () => {
    const u = await nyttUnderlag();
    const fall: [string, number, string][] = [
      ['namn_redovisning', 4, 'Provkunden AB gav prov-kund-1, vantat ingen traff'],
      ['namn_arenden', 5, 'Provprojektet gav prov-projekt-1, vantat ingen traff'],
      ['skiftlage_kund', 6, 'provkunden ab gav Provkunden AB, vantat ingen traff'],
      ['strang_avvisas', 6, 'Provkunden AB gav ingen traff, vantat Provkunden AB'],
      ['kastar', 4, 'prov-kund-1 stannade konsumenten'],
      ['id_saknas', 5, 'prov-projekt-1 gav ingen traff, vantat prov-projekt-1'],
      ['utan_kund', 6, 'ingen konsument'],
    ];
    for (const [lage, nr, avvikelse] of fall) {
      expect(await korKontrollera(u, lage), lage).toEqual([
        [4, 'redovisning', nr === 4 ? avvikelse : null],
        [5, 'arenden', nr === 5 ? avvikelse : null],
        [6, 'kunddokument', nr === 6 ? avvikelse : null],
      ]);
    }
    // Kontroll: endast konsumenterna skiljer, samma underlag och drivrutin som F3.
    expect(await korKontrollera(u, 'hel')).toEqual([
      [4, 'redovisning', null], [5, 'arenden', null], [6, 'kunddokument', null],
    ]);
  });
});

describe('FR-31/Story 10.7 AK 1–2: KONTROLL 1 och domen', () => {
  it('F5 (AK 1): varje oläsbart underlag ger KUNDE_INTE, även utan koppling dit eller utan ifyllda värden', async () => {
    const olasbaraDomar: Awaited<ReturnType<typeof korDoma>>[] = [];
    // (a), (b): bara arendens läsbarhet skiljer mellan fallen och kontrollen (h).
    for (const typ of ['FileNotFoundError', 'JSONDecodeError']) {
      const u = await nyttUnderlag();
      if (typ === 'FileNotFoundError') await rm(u.arenden);
      else await skriv(u.arenden, '[');
      const d = await korDoma(u);
      expect(d).toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [
        KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(5, 4, 0, 1, 1),
        `register arenden gar inte att lasa (${typ})`,
        koppling('kund-ett', 'arenden', 'projekt-1', 'KUNDE_INTE', olasbar(typ)), ...KONTROLLER_OK,
      ] });
      olasbaraDomar.push(d);
    }
    // (c): båda kopplingarna till redovisningen förblir oprovade.
    const c = await nyttUnderlag();
    await rm(c.redovisning);
    const dc = await korDoma(c);
    expect(dc).toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [
      KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(5, 3, 0, 2, 1),
      'register redovisning gar inte att lasa (FileNotFoundError)',
      koppling('kund-ett', 'redovisning', 'kund-1', 'KUNDE_INTE', olasbar('FileNotFoundError')),
      koppling('kund-tva', 'redovisning', 'kund-2', 'KUNDE_INTE', olasbar('FileNotFoundError')),
      ...KONTROLLER_OK,
    ] });
    olasbaraDomar.push(dc);
    // (d): saknad katalog respektive vanlig fil ger samma oprovade kopplingar.
    for (const typ of ['FileNotFoundError', 'NotADirectoryError']) {
      const u = await nyttUnderlag();
      await rm(u.kunddokument, { recursive: true, force: true });
      if (typ === 'NotADirectoryError') await skriv(u.kunddokument, 'x\n');
      const d = await korDoma(u);
      expect(d).toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [
        KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(5, 3, 0, 2, 1),
        `register kunddokument gar inte att lasa (${typ})`,
        koppling('kund-ett', 'kunddokument', 'Kunden Ett AB', 'KUNDE_INTE', olasbar(typ)),
        koppling('kund-tva', 'kunddokument', 'Kunden Tva AB', 'KUNDE_INTE', olasbar(typ)), ...KONTROLLER_OK,
      ] });
      olasbaraDomar.push(d);
    }
    // (e): även ett oläsbart register utan koppling dit hindrar GRON.
    const e = await nyttUnderlag();
    await skriv(e.manifest, [{ manifest: 'kund-ett', redovisning: 'kund-1', kunddokument: 'Kunden Ett AB' }]);
    await rm(e.arenden);
    const de = await korDoma(e);
    expect(de).toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [
      KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(2, 2, 0, 0, 1),
      'register arenden gar inte att lasa (FileNotFoundError)', ...KONTROLLER_OK,
    ] });
    olasbaraDomar.push(de);
    const f = await nyttUnderlag();
    await skriv(f.manifest, '[');
    const df = await korDoma(f);
    expect(df).toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [
      KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(0, 0, 0, 0, 0),
      'manifesten gar inte att lasa (JSONDecodeError)', ...KONTROLLER_OK,
    ] });
    olasbaraDomar.push(df);
    // (g): noll manifest respektive ett manifest med tre tomma kopplingar.
    for (const [manifest, tomma] of [[[], 0], [[{ manifest: 'kund-tom' }], 3]] as const) {
      const u = await nyttUnderlag();
      await skriv(u.manifest, manifest);
      const d = await korDoma(u);
      expect(d).toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [
        KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(0, 0, 0, 0, tomma),
        'inga ifyllda kopplingar att prova', ...KONTROLLER_OK,
      ] });
      olasbaraDomar.push(d);
    }
    for (const d of olasbaraDomar) expect(d.rader.some((rad) => rad.startsWith('GRON'))).toBe(false);
    // (h): endast läsbarheten/ifyllda värden skiljer; kunddokumentens bara strängar håller.
    const h = await nyttUnderlag();
    const dh = await korDoma(h);
    expect(dh).toEqual({ utfall: 'GRON', kod: 0, rader: [
      GRONRAD, NAMNREGISTERRAD, summa(5, 5, 0, 0, 1), ...KONTROLLER_OK,
    ] });
    expect(dh.rader.join('\n')).not.toMatch(/Error|kunde inte/);
  });

  it('F6 (AK 1, 2): id-register avvisar namn och kunddokument kräver exakt katalognamn; konsumentfel ger ROD', async () => {
    const fall: [Partial<typeof KUND_ETT>, string][] = [
      [{ redovisning: 'Kunden Ett AB' }, koppling('kund-ett', 'redovisning', 'Kunden Ett AB', 'FEL',
        'namnburen, vardet ar ett namn i registret och inget id')],
      [{ arenden: 'projekt-9' }, koppling('kund-ett', 'arenden', 'projekt-9', 'FEL', 'id:t finns inte i registret')],
      [{ arenden: 'Projektet Ett' }, koppling('kund-ett', 'arenden', 'Projektet Ett', 'FEL',
        'namnburen, vardet ar ett namn i registret och inget id')],
      [{ kunddokument: 'kunden ett ab' }, koppling('kund-ett', 'kunddokument', 'kunden ett ab', 'FEL',
        'katalognamnet finns inte i registret')],
      [{ kunddokument: 'kund-1' }, koppling('kund-ett', 'kunddokument', 'kund-1', 'FEL',
        'katalognamnet finns inte i registret')],
    ];
    // (a)–(e): varje del har ett eget underlag.
    for (const [over, felrad] of fall) {
      const u = await nyttUnderlag();
      await skriv(u.manifest, manifestMed(over));
      const d = await korDoma(u);
      expect(d).toEqual({ utfall: 'ROD', kod: 1, rader: [
        RODRAD, NAMNREGISTERRAD, summa(5, 4, 1, 0, 1), felrad, ...KONTROLLER_OK,
      ] });
      expect(d.rader.join('\n')).not.toMatch(/Error|kunde inte/);
      expect(d.rader.some((rad) => rad.startsWith('KUNDE_INTE'))).toBe(false);
    }
    // (f): en felaktig koppling får inte dölja ett oläsbart register.
    const f = await nyttUnderlag();
    await skriv(f.manifest, manifestMed({ redovisning: 'Kunden Ett AB' }));
    await rm(f.arenden);
    const df = await korDoma(f);
    expect(df).toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [
      KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(5, 3, 1, 1, 1),
      'register arenden gar inte att lasa (FileNotFoundError)',
      koppling('kund-ett', 'redovisning', 'Kunden Ett AB', 'FEL',
        'namnburen, vardet ar ett namn i registret och inget id'),
      koppling('kund-ett', 'arenden', 'projekt-1', 'KUNDE_INTE', olasbar('FileNotFoundError')), ...KONTROLLER_OK,
    ] });
    // (g): KONTROLL 1 håller; den trasiga konsumenten fälls separat av KONTROLL 4.
    const g = await nyttUnderlag();
    const dg = await korDoma(g, 'namn_redovisning');
    expect(dg).toEqual({ utfall: 'ROD', kod: 1, rader: [
      RODRAD, NAMNREGISTERRAD, summa(5, 5, 0, 0, 1),
      'KONTROLL 4 redovisning: AVVIKER, Provkunden AB gav prov-kund-1, vantat ingen traff',
      'KONTROLL 5 arenden: ok', 'KONTROLL 6 kunddokument: ok',
    ] });
    expect(dg.rader.join('\n')).not.toMatch(/Error|kunde inte/);
    expect(dg.rader.some((rad) => rad.startsWith('KUNDE_INTE'))).toBe(false);
    // (h): kontroll med samma register och endast giltiga värden/egna konsumenter som F5 (h).
    const h = await nyttUnderlag();
    expect(await korDoma(h)).toEqual({ utfall: 'GRON', kod: 0, rader: [
      GRONRAD, NAMNREGISTERRAD, summa(5, 5, 0, 0, 1), ...KONTROLLER_OK,
    ] });
  });
});

describe('FR-31/Story 10.7 AK 1–2: kopplingsprovet som skript', () => {
  it('F7 (AK 1): skriptet ger KUNDE_INTE för kopplingen till oläsbart register, aldrig GRON', async () => {
    const a = await nyttUnderlag();
    await rm(a.arenden);
    const pa = await korProvet(a, argumentFor(a));
    expect(pa.kod).toBe(2);
    expect(pa.fel).toBe('');
    expect(rader(pa.ut)).toEqual([
      KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(5, 4, 0, 1, 1),
      'register arenden gar inte att lasa (FileNotFoundError)',
      koppling('kund-ett', 'arenden', 'projekt-1', 'KUNDE_INTE', olasbar('FileNotFoundError')),
      ...KONTROLLER_OK,
    ]);
    expect(rader(pa.ut).some((rad) => rad.startsWith('GRON'))).toBe(false);
    const b = await nyttUnderlag();
    await rm(b.kunddokument, { recursive: true, force: true });
    const pb = await korProvet(b, argumentFor(b));
    expect(pb.kod).toBe(2);
    expect(pb.fel).toBe('');
    expect(rader(pb.ut)).toEqual([
      KUNDE_INTE_RAD, NAMNREGISTERRAD, summa(5, 3, 0, 2, 1),
      'register kunddokument gar inte att lasa (FileNotFoundError)',
      koppling('kund-ett', 'kunddokument', 'Kunden Ett AB', 'KUNDE_INTE', olasbar('FileNotFoundError')),
      koppling('kund-tva', 'kunddokument', 'Kunden Tva AB', 'KUNDE_INTE', olasbar('FileNotFoundError')),
      ...KONTROLLER_OK,
    ]);
    expect(rader(pb.ut).some((rad) => rad.startsWith('GRON'))).toBe(false);
    // Kontroll: enda skillnaden är att alla registren går att läsa.
    const c = await nyttUnderlag();
    const pc = await korProvet(c, argumentFor(c));
    expect(pc.kod).toBe(0);
    expect(pc.fel).toBe('');
    expect(rader(pc.ut)).toEqual([GRONRAD, NAMNREGISTERRAD, summa(5, 5, 0, 0, 1), ...KONTROLLER_OK]);
  });

  it('F8 (AK 2): utskriften anger namnregistrets undantag, fäller namnmatchning och har tre skilda exitkoder', async () => {
    const a = await nyttUnderlag();
    const pa = await korProvet(a, argumentFor(a));
    expect(pa.kod).toBe(0);
    expect(pa.fel).toBe('');
    expect(rader(pa.ut)).toEqual([GRONRAD, NAMNREGISTERRAD, summa(5, 5, 0, 0, 1), ...KONTROLLER_OK]);
    expect(rader(pa.ut).filter((rad) => rad === NAMNREGISTERRAD)).toHaveLength(1);
    const b = await nyttUnderlag();
    await skriv(b.manifest, manifestMed({ redovisning: 'Kunden Ett AB' }));
    const pb = await korProvet(b, argumentFor(b));
    expect(pb.kod).toBe(1);
    expect(pb.fel).toBe('');
    expect(rader(pb.ut)).toEqual([
      RODRAD, NAMNREGISTERRAD, summa(5, 4, 1, 0, 1),
      koppling('kund-ett', 'redovisning', 'Kunden Ett AB', 'FEL',
        'namnburen, vardet ar ett namn i registret och inget id'), ...KONTROLLER_OK,
    ]);
    const c = await nyttUnderlag();
    const pc = await korDrivern(c.hem, ['prov', 'namn_redovisning', ...argumentFor(c)]);
    expect(pc.kod).toBe(1);
    expect(pc.fel).toBe('');
    expect(rader(pc.ut)).toEqual([
      RODRAD, NAMNREGISTERRAD, summa(5, 5, 0, 0, 1),
      'KONTROLL 4 redovisning: AVVIKER, Provkunden AB gav prov-kund-1, vantat ingen traff',
      'KONTROLL 5 arenden: ok', 'KONTROLL 6 kunddokument: ok',
    ]);
    const d = await nyttUnderlag();
    await rm(d.arenden);
    const pd = await korProvet(d, argumentFor(d));
    expect(pd.fel).toBe('');
    const utfall = [pa, pb, pd];
    const koderna = utfall.map((p) => p.kod);
    expect(koderna).toEqual([0, 1, 2]);
    expect(new Set(koderna).size).toBe(3);
    expect(utfall.map((p) => rader(p.ut)[0]?.split(': ')[0])).toEqual(['GRON', 'ROD', 'KUNDE_INTE']);
    for (const p of utfall) expect(rader(p.ut)[1]).toBe(NAMNREGISTERRAD);
    for (const p of [pa, pb, pc]) expect(p.ut).not.toMatch(/Error|kunde inte/);
  });

  it('F9 (AK 1): ogiltiga anrop och en krasch ger KUNDE_INTE, aldrig 0 eller 1', async () => {
    const u = await nyttUnderlag();
    const { manifest: m, redovisning: r, arenden: a, kunddokument: k } = u;
    for (const anrop of [
      [], ['--manifest', m],
      ['--manifest', m, '--redovisning', r, '--manifest', a, '--kunddokument', k],
      [...argumentFor(u), 'extra'],
      ['--projekt', m, '--redovisning', r, '--arenden', a, '--kunddokument', k],
      ['--manifest', '', '--redovisning', r, '--arenden', a, '--kunddokument', k],
      ['--manifest', '--x', '--redovisning', r, '--arenden', a, '--kunddokument', k],
    ]) {
      const p = await korProvet(u, anrop);
      expect(p.fel).toBe('');
      expect({ kod: p.kod, rader: rader(p.ut) }, JSON.stringify(anrop)).toEqual({ kod: 2, rader: [ANROPSRAD] });
    }
    // Kontroll: endast anropet ändras. Flaggornas ordning påverkar inte domen.
    for (const anrop of [argumentFor(u),
      ['--kunddokument', k, '--arenden', a, '--redovisning', r, '--manifest', m],
    ]) {
      const p = await korProvet(u, anrop);
      expect(p.fel).toBe('');
      expect({ kod: p.kod, rader: rader(p.ut) }).toEqual({ kod: 0, rader: [
        GRONRAD, NAMNREGISTERRAD, summa(5, 5, 0, 0, 1), ...KONTROLLER_OK,
      ] });
    }
    const p = await korDrivern(u.hem, ['prov', 'krasch', ...argumentFor(u)]);
    expect(p.kod).toBe(2);
    expect(p.fel).toBe('');
    expect(rader(p.ut)).toEqual(['KUNDE_INTE: provet stannade: RuntimeError']);
  });
});
