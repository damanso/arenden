// FR-30, B-17 punkten Överlämningen, Story 10.6.
// Kör adapter/overlamningsvag.py och adapter/arende_overlamning.py som barnprocesser:
// funktioner, app/testdatabas, stängd port och räknare. AK 1: skapandefel stoppar sparande
// och analys. AK 2: avvisningar, rubrik/etikett, intern väg, beslutsfråga och provets tre utfall.
// Läser aldrig vägen i drift, provvakten eller driftens nyckel. Införandet sker utanför bygget.
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

// Barnprocesser och tillåtelselista följer test/hemplacering.test.ts.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const PREFIX = '[Från Hermes] '.normalize('NFC');
const ETIKETT = 'Från-Hermes'.normalize('NFC');
const FORE_ARBETET = 'Mottagaren frågar David om en för- och nackdelsanalys innan arbetet börjar (Davids direktiv 17/8).'.normalize('NFC');
const UTAN = 'en overlamning utan rekommendation ar arbete som skickats vidare, inte ett problem som lamnats over';
const MOTTAGARE = { externa: ['sidoprojektet'], interna: ['provets-roll'] };
const VAGEN = path.join(ADAPTERN, 'overlamningsvag.py');
const ANROPSRAD = 'FEL: anropet gar inte att tolka: --overlamning <fil> --mottagare <fil> --ut <katalog>';
const PROVET = path.join(ADAPTERN, 'arende_overlamning.py');
const KLIENTEN = path.join(ADAPTERN, 'arenden_klient.py');
const PROV_ANROPSRAD = 'ROD: anropet gar inte att tolka: [--moduler <katalog>]';
const GRON_RADER = [
  'GRON: overlamningsvagen haller i alla sex fall',
  fallrad('ok', 'P1', 'utan rekommendation', 2, 0, 0, 0, 0),
  fallrad('ok', 'P2', 'okand mottagare', 2, 0, 0, 0, 0),
  fallrad('ok', 'P3', 'extern', 0, 1, 1, 1, 0),
  fallrad('ok', 'P4', 'intern', 0, 0, 1, 0, 0),
  fallrad('ok', 'P5', 'extern, svarar 400', 1, 1, 0, 0, 0),
  fallrad('ok', 'P6', 'extern, svarar inte', 1, 1, 0, 0, 0),
];
type Indata = Record<string, unknown>;
interface Processutfall { kod: number; ut: string; fel: string }

function overlamning(over: Indata = {}): Indata {
  return { mottagare: 'sidoprojektet', rubrik: 'Ny kundportal', text: 'Kunden vill ha en portal.',
    rekommendation: 'Bygg den i redovisningen.', ...over };
}
function utan(o: Indata, nyckel: string): Indata {
  const kopia = { ...o };
  delete kopia[nyckel];
  return kopia;
}
function beskrivning(text: unknown, rek: unknown): string {
  return [...(typeof text === 'string' && text.trim() ? [text] : []),
    `Rekommendation: ${rek}`, FORE_ARBETET].join('\n\n');
}
function arendeindata(o: Indata) {
  return { titel: PREFIX + o.rubrik, team_key: 'LOC', beskrivning: beskrivning(o.text, o.rekommendation),
    labels: [ETIKETT] };
}
function analys(o: Indata, arende: string) {
  return { slag: 'beslutsfraga', arende, mottagare: o.mottagare, rubrik: o.rubrik,
    rekommendation: o.rekommendation, bygge: 'efter_davids_ja' };
}
function barnmiljo(hem: string, bas?: string, nyckel?: string): NodeJS.ProcessEnv {
  // Testmiljön bär attrappnyckeln och riktiga HOME driftens nyckel: ingen spridning av process.env.
  return { PATH: process.env.PATH, HOME: hem,
    ...(bas === undefined ? {} : { ARENDEN_API_URL: bas }),
    ...(nyckel === undefined ? {} : { ARENDEN_API_KEY: nyckel }),
  };
}
const hemkataloger: string[] = [];
async function nyttHem(): Promise<string> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-overlamning-'));
  hemkataloger.push(hem);
  return hem;
}
afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

// -I isolerar importerna, -B hindrar cachefiler. Kod 3 är en trasig drivrutin.
const DRIVER = `
import json
import sys
import traceback
try:
    sys.path.insert(0, sys.argv[1])
    import overlamningsvag as v
    import arenden_klient
    operation = sys.argv[2]
    if operation == "bedom":
        data = json.loads(sys.argv[3])
        print(json.dumps(v.bedom(v.tolka_overlamning(data["overlamning"]), v.tolka_mottagare(data["mottagare"]))._asdict()))
    elif operation == "indata":
        data = json.loads(sys.argv[3])
        o = v.tolka_overlamning(data["overlamning"])
        print(json.dumps({"arende": v.arendeindata(o), "analys": v.analysindata(o, data["arende"]), "steg": list(v.Steg._fields)}))
    elif operation == "tolka":
        fel = None
        try:
            funktion = v.tolka_overlamning if sys.argv[3] == "overlamning" else v.tolka_mottagare
            funktion(json.loads(sys.argv[4]))
        except Exception as e:
            fel = type(e).__name__
        print(json.dumps({"fel": fel}))
    elif operation == "leverera":
        data = json.loads(sys.argv[3])
        o = v.tolka_overlamning(data["overlamning"])
        m = v.tolka_mottagare(data["mottagare"])
        anrop = []
        def skapa(**argument):
            anrop.append(["create_issue", argument])
            if data["skapa"] == "svarar_400":
                raise arenden_klient.ArendeFel(400, "validation_error")
            if data["skapa"] == "svarar_inte":
                raise TimeoutError("provets stubbe svarar inte")
            return arenden_klient.create_issue(**argument)
        def spara(o, arende):
            anrop.append(["spara", {"overlamning": o._asdict(), "arende": arende}])
            if data.get("spara", "ok") == "fel":
                raise RuntimeError("provets sparfel")
        def starta_analys(fraga):
            anrop.append(["starta_analys", fraga])
            if data.get("analys", "ok") == "fel":
                raise RuntimeError("provets analysfel")
        resultat = v.leverera(o, m, v.Steg(skapa, spara, starta_analys))
        print(json.dumps(dict(resultat._asdict(), anrop=anrop)))
    elif operation == "prov":
        import arende_overlamning as p
        lage = sys.argv[3]
        if lage == "lucka8":
            original = v.leverera
            def lucka(o, mottagare, steg):
                resultat = original(o, mottagare, steg)
                if resultat.utfall == "MISSLYCKAD" and resultat.arende is None:
                    steg.spara(o, None)
                    return v.Resultat("OVERLAMNAD", 0, resultat.rader, None)
                return resultat
            v.leverera = lucka
        elif lage == "projekt":
            original = v.arendeindata
            def projekt(o):
                return dict(original(o), projekt="Locollabs")
            v.arendeindata = projekt
        elif lage == "natet":
            original = v.leverera
            def natet(o, mottagare, steg):
                try:
                    arenden_klient.anropa("list_issues", {})
                except Exception:
                    pass
                return original(o, mottagare, steg)
            v.leverera = natet
        elif lage != "hel":
            raise ValueError("okant provlage")
        sys.exit(p.huvud([]))
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
async function korDrivern(hem: string, argument: string[], bas?: string, nyckel?: string): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, ...argument], {
      cwd: ROT, env: barnmiljo(hem, bas, nyckel), timeout: 20_000,
    });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
async function korBedom(o: Indata, m = MOTTAGARE) {
  const u = await korDrivern(await nyttHem(), ['bedom', JSON.stringify({ overlamning: o, mottagare: m })]);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as { slag: string; skal: string | null };
}
async function korIndata(o: Indata, arende: string) {
  const u = await korDrivern(await nyttHem(), ['indata', JSON.stringify({ overlamning: o, arende })]);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as { arende: ReturnType<typeof arendeindata>; analys: ReturnType<typeof analys>; steg: string[] };
}
async function korTolka(slag: string, varde: unknown) {
  const u = await korDrivern(await nyttHem(), ['tolka', slag, JSON.stringify(varde)]);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as { fel: string | null };
}

describe('FR-30/Story 10.6 AK 1–2: klassningen och ärendets indata', () => {
  it('F1 (AK 2): avvisningarna, rekommendationen först och exakt mottagare', async () => {
    for (const o of [utan(overlamning(), 'rekommendation'),
      ...[null, '', '  \n '].map((rekommendation) => overlamning({ rekommendation })),
      utan(overlamning({ mottagare: 'provets okanda mottagare' }), 'rekommendation')]) {
      expect(await korBedom(o)).toEqual({ slag: 'avvisad', skal: UTAN });
    }
    for (const mottagare of ['provets okanda mottagare', 'Sidoprojektet']) {
      expect(await korBedom(overlamning({ mottagare }))).toEqual({ slag: 'avvisad', skal: `okand mottagare: ${mottagare}` });
    }
    expect(await korBedom(overlamning())).toEqual({ slag: 'extern', skal: null });
    expect(await korBedom(overlamning({ mottagare: 'provets-roll' }))).toEqual({ slag: 'intern', skal: null });
  });
  it('F2 (AK 2): exakt fyra ärendefält, beslutsfråga och tre steg utan byggsteg', async () => {
    const o = overlamning();
    const u = await korIndata(o, 'LOC-9');
    expect(u.arende).toEqual(arendeindata(o));
    expect(Object.keys(u.arende).sort()).toEqual(['beskrivning', 'labels', 'team_key', 'titel']);
    expect(u.analys).toEqual(analys(o, 'LOC-9'));
    expect(u.steg).toEqual(['skapa_arende', 'spara', 'starta_analys']);
    for (const utanText of [utan(o, 'text'), overlamning({ text: null }), overlamning({ text: '  ' })]) {
      expect((await korIndata(utanText, 'LOC-9')).arende.beskrivning)
        .toBe('Rekommendation: Bygg den i redovisningen.\n\n' + FORE_ARBETET);
    }
  });
  it('F3 (AK 2): överlämning och mottagarlistor har en sluten form', async () => {
    for (const o of [[], overlamning({ projekt: 'Locollabs' }), utan(overlamning(), 'mottagare'),
      overlamning({ mottagare: '' }), overlamning({ rubrik: '  ' }), overlamning({ text: 5 }),
      overlamning({ rekommendation: 5 })]) {
      expect(await korTolka('overlamning', o)).toEqual({ fel: 'ValueError' });
    }
    for (const o of [overlamning(), utan(overlamning(), 'rekommendation')]) {
      expect(await korTolka('overlamning', o)).toEqual({ fel: null });
    }
    for (const m of [[], { ...MOTTAGARE, extra: [] }, { externa: ['sidoprojektet'] },
      { externa: 'sidoprojektet', interna: [] }, { externa: [7], interna: [] },
      { externa: ['Sidoprojektet'], interna: [] }, { externa: ['sidoprojektet'], interna: ['sidoprojektet'] },
      { externa: ['sidoprojektet', 'sidoprojektet'], interna: [] }]) {
      expect(await korTolka('mottagare', m)).toEqual({ fel: 'ValueError' });
    }
    for (const m of [MOTTAGARE, { externa: [], interna: [] }]) {
      expect(await korTolka('mottagare', m)).toEqual({ fel: null });
    }
  });
});

interface Testserver { app: Express; server: Server; bas: string; modul: string }
interface Leverans {
  utfall: string; kod: number; rader: string[]; arende: string | null;
  anrop: [string, Indata][];
}
let v: Testserver;
async function stang(server: Server): Promise<void> {
  await new Promise<void>((klar, fel) => server.close((e) => e ? fel(e) : klar()));
}
async function starta(): Promise<Testserver> {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  try {
    await seedaTeam();
    const modul = await nyNyckel({ typ: 'agent', namn: 'overlamningen' });
    return { app, server, bas: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, modul };
  } catch (fel) { await stang(server); throw fel; }
}
async function stangdPort(): Promise<string> {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  const bas = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await stang(server);
  return bas;
}
async function hamtat(identifier: string) {
  const svar = await kor(v.app, v.modul, 'get_issue', { identifier });
  expect(svar.status).toBe(200);
  return svar.body.result as {
    arende: { title: string; labels: string[]; projekt: string | null; description: string };
    handelser: { verb: string; aktor_typ: string; aktor_namn: string }[];
  };
}
async function korLeverera(o: Indata, m: unknown, lagen: Indata, bas = v.bas): Promise<Leverans> {
  const u = await korDrivern(await nyttHem(), ['leverera', JSON.stringify({ overlamning: o, mottagare: m, ...lagen })], bas, v.modul);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as Leverans;
}
function radExtern(m: string, a: string): string {
  return `OVERLAMNAD: ${m} fick ${a}, analysen ar en beslutsfraga och bygget vantar pa Davids ja`;
}
function radIntern(m: string): string { return `OVERLAMNAD: ${m} ar intern, inget arende skapas`; }
function radFel(namn: string, b: string, a: string | null): string {
  return `MISSLYCKAD: ${namn} gav ${b}, arende ${a ?? 'inget'}, overlamningen ar inte sparad och ingen analys startades`;
}

describe('FR-30/Story 10.6 AK 1–2: leveransen mot testservern', () => {
  beforeAll(async () => { v = await starta(); });
  afterAll(async () => { if (v) await stang(v.server); });

  it('F4 (AK 2): extern går stegen i ordning, intern sparar och avvisad når inget steg', async () => {
    const o = overlamning();
    const i = await raknaRader('issues');
    const e = await raknaRader('events');
    const u = await korLeverera(o, MOTTAGARE, { skapa: 'lyckas' });
    expect(u).toEqual({ utfall: 'OVERLAMNAD', kod: 0, arende: expect.stringMatching(/^LOC-/),
      rader: [radExtern('sidoprojektet', u.arende!)], anrop: [
        ['create_issue', arendeindata(o)], ['spara', { overlamning: o, arende: u.arende }],
        ['starta_analys', analys(o, u.arende!)],
      ] });
    const a = await hamtat(u.arende!);
    expect(a.arende).toMatchObject({ title: PREFIX + 'Ny kundportal', labels: [ETIKETT], projekt: null,
      description: arendeindata(o).beskrivning });
    expect(a.handelser.map((h) => [h.verb, h.aktor_typ, h.aktor_namn]))
      .toEqual([['skapade_arende', 'agent', 'overlamningen']]);
    expect(await raknaRader('issues')).toBe(i + 1);
    expect(await raknaRader('events')).toBe(e + 1);

    const intern = overlamning({ mottagare: 'provets-roll' });
    const i2 = await raknaRader('issues');
    const e2 = await raknaRader('events');
    expect(await korLeverera(intern, MOTTAGARE, { skapa: 'lyckas' })).toEqual({
      utfall: 'OVERLAMNAD', kod: 0, arende: null, rader: [radIntern('provets-roll')],
      anrop: [['spara', { overlamning: intern, arende: null }]],
    });
    expect(await raknaRader('issues')).toBe(i2);
    expect(await raknaRader('events')).toBe(e2);
    for (const [o2, skal] of [
      [utan(overlamning(), 'rekommendation'), UTAN],
      [overlamning({ mottagare: 'provets okanda mottagare' }), 'okand mottagare: provets okanda mottagare'],
    ] as const) {
      const foreI = await raknaRader('issues');
      const foreE = await raknaRader('events');
      expect(await korLeverera(o2, MOTTAGARE, { skapa: 'lyckas' })).toEqual({
        utfall: 'AVVISAD', kod: 2, arende: null, rader: [`AVVISAD: ${skal}`], anrop: [],
      });
      expect(await raknaRader('issues')).toBe(foreI);
      expect(await raknaRader('events')).toBe(foreE);
    }
  });

  it('F5 (AK 1): skapandefel stoppar sparande och analys utan nya ärenden eller händelser', async () => {
    for (const [o, skapa, b, bas] of [
      [overlamning(), 'svarar_400', '400 validation_error', v.bas],
      [overlamning(), 'svarar_inte', 'TimeoutError', v.bas],
      [overlamning({ rubrik: 'x'.repeat(290) }), 'lyckas', '400 validation_error', v.bas],
      [overlamning(), 'lyckas', 'URLError', await stangdPort()],
    ] as const) {
      const i = await raknaRader('issues');
      const e = await raknaRader('events');
      expect(await korLeverera(o, MOTTAGARE, { skapa }, bas)).toEqual({
        utfall: 'MISSLYCKAD', kod: 1, arende: null, rader: [radFel('create_issue', b, null)],
        anrop: [['create_issue', arendeindata(o)]],
      });
      expect(await raknaRader('issues')).toBe(i);
      expect(await raknaRader('events')).toBe(e);
    }
    // Kontroll: bara skapandet lyckas nu, samma indata och samma väg.
    const i = await raknaRader('issues');
    const u = await korLeverera(overlamning(), MOTTAGARE, { skapa: 'lyckas' });
    expect(u.kod).toBe(0);
    expect(u.anrop).toEqual([
      ['create_issue', arendeindata(overlamning())],
      ['spara', { overlamning: overlamning(), arende: u.arende }],
      ['starta_analys', analys(overlamning(), u.arende!)],
    ]);
    expect(await raknaRader('issues')).toBe(i + 1);
  });

  it('F6 (AK 1): senare fel stoppar följande steg och raden namnger det som finns', async () => {
    const u = await korLeverera(overlamning(), MOTTAGARE, { skapa: 'lyckas', spara: 'fel' });
    expect(u.utfall).toBe('MISSLYCKAD');
    expect(u.kod).toBe(1);
    expect(u.arende).toMatch(/^LOC-/);
    expect(u.rader).toEqual([radFel('spara', 'RuntimeError', u.arende)]);
    expect(u.anrop.map(([namn]) => namn)).toEqual(['create_issue', 'spara']);
    await hamtat(u.arende!);
    const a = await korLeverera(overlamning(), MOTTAGARE, { skapa: 'lyckas', analys: 'fel' });
    expect(a.utfall).toBe('MISSLYCKAD');
    expect(a.kod).toBe(1);
    expect(a.rader).toEqual([`MISSLYCKAD: starta_analys gav RuntimeError, arende ${a.arende}, overlamningen ar sparad men analysen startades inte`]);
    expect(a.anrop.map(([namn]) => namn)).toEqual(['create_issue', 'spara', 'starta_analys']);
    const intern = await korLeverera(overlamning({ mottagare: 'provets-roll' }), MOTTAGARE, { skapa: 'lyckas', spara: 'fel' });
    expect(intern.kod).toBe(1);
    expect(intern.arende).toBeNull();
    expect(intern.rader).toEqual([radFel('spara', 'RuntimeError', null)]);
    expect(intern.anrop.map(([namn]) => namn)).toEqual(['spara']);
    // F4 har kontrollerna där samma steg lyckas för extern respektive intern.
  });
});

interface Raknare { server: Server; bas: string; antal: () => number; nollstall: () => void }
async function raknare(status: number, kod: string): Promise<Raknare> {
  let antal = 0;
  const server = createServer((req, res) => {
    antal += 1;
    req.resume();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: kod }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  return { server, bas: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    antal: () => antal, nollstall: () => { antal = 0; } };
}
async function skrivIndata(o: unknown, m: unknown = MOTTAGARE) {
  const hem = await nyttHem();
  const f = path.join(hem, 'overlamning.json');
  const mottagare = path.join(hem, 'mottagare.json');
  const ut = path.join(hem, 'ut');
  await writeFile(f, typeof o === 'string' || Buffer.isBuffer(o) ? o : JSON.stringify(o));
  await writeFile(mottagare, JSON.stringify(m));
  return { hem, argument: ['--overlamning', f, '--mottagare', mottagare, '--ut', ut], ut };
}
async function jsonRader(fil: string): Promise<unknown[]> {
  try {
    return (await readFile(fil, 'utf8')).split(/\r?\n/).filter((rad) => rad.length > 0)
      .map((rad) => JSON.parse(rad) as unknown);
  } catch (fel: unknown) {
    if (typeof fel === 'object' && fel !== null && 'code' in fel && fel.code === 'ENOENT') return [];
    throw fel;
  }
}
async function korSkriptet(argument: string[], bas: string, nyckel = v.modul) {
  let resultat: Processutfall;
  try {
    // -s isolerar användarmiljön; skriptets katalog behövs för klientimporten.
    const { stdout, stderr } = await korProcess('python3', ['-B', '-s', VAGEN, ...argument], {
      cwd: ROT, env: barnmiljo(await nyttHem(), bas, nyckel), timeout: 20_000,
    });
    resultat = { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (!arProcessfel(fel)) throw fel;
    resultat = { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
  }
  return { kod: resultat.kod, rader: resultat.ut.split(/\r?\n/).filter((rad) => rad.length > 0) };
}

describe('FR-30/Story 10.6 AK 1–2: överlämningsvägen som skript', () => {
  let rakna: Raknare;
  beforeAll(async () => { v = await starta(); rakna = await raknare(400, 'validation_error'); });
  afterAll(async () => { if (v) await stang(v.server); if (rakna) await stang(rakna.server); });

  it('F7 (AK 1, 2): tre exitkoder och bara lyckad överlämning lämnar rader i katalogen', async () => {
    const o = overlamning();
    const f = await skrivIndata(o);
    const lyckad = await korSkriptet(f.argument, v.bas);
    expect(lyckad.kod).toBe(0);
    expect(lyckad.rader).toHaveLength(1);
    const a = / fick (LOC-\d+),/.exec(lyckad.rader[0]!)?.[1];
    expect(a).toMatch(/^LOC-/);
    expect(lyckad.rader).toEqual([radExtern('sidoprojektet', a!)]);
    expect(await jsonRader(path.join(f.ut, 'overlamnade.jsonl'))).toEqual([
      { mottagare: o.mottagare, rubrik: o.rubrik, rekommendation: o.rekommendation, arende: a },
    ]);
    expect(await jsonRader(path.join(f.ut, 'beslutsfragor.jsonl'))).toEqual([analys(o, a!)]);
    expect((await hamtat(a!)).arende.labels).toEqual([ETIKETT]);

    const felkoder: number[] = [];
    for (const [bas, beskriv] of [[rakna.bas, '400 validation_error'], [await stangdPort(), 'URLError']]) {
      const g = await skrivIndata(o);
      rakna.nollstall();
      const u = await korSkriptet(g.argument, bas!);
      expect(u).toEqual({ kod: 1, rader: [radFel('create_issue', beskriv!, null)] });
      felkoder.push(u.kod);
      expect(rakna.antal()).toBe(bas === rakna.bas ? 1 : 0);
      expect(await jsonRader(path.join(g.ut, 'overlamnade.jsonl'))).toEqual([]);
      expect(await jsonRader(path.join(g.ut, 'beslutsfragor.jsonl'))).toEqual([]);
    }
    const avvisad = await skrivIndata(utan(o, 'rekommendation'));
    rakna.nollstall();
    const nej = await korSkriptet(avvisad.argument, rakna.bas);
    expect(nej).toEqual({ kod: 2, rader: ['AVVISAD: ' + UTAN] });
    expect(rakna.antal()).toBe(0);
    expect(await jsonRader(path.join(avvisad.ut, 'overlamnade.jsonl'))).toEqual([]);
    expect(await jsonRader(path.join(avvisad.ut, 'beslutsfragor.jsonl'))).toEqual([]);
    const intern = await skrivIndata(overlamning({ mottagare: 'provets-roll' }));
    rakna.nollstall();
    expect(await korSkriptet(intern.argument, rakna.bas)).toEqual({ kod: 0, rader: [radIntern('provets-roll')] });
    expect(rakna.antal()).toBe(0);
    expect(await jsonRader(path.join(intern.ut, 'overlamnade.jsonl'))).toEqual([
      { mottagare: 'provets-roll', rubrik: o.rubrik, rekommendation: o.rekommendation, arende: null },
    ]);
    expect(await jsonRader(path.join(intern.ut, 'beslutsfragor.jsonl'))).toEqual([]);
    expect([lyckad.kod, felkoder[0], nej.kod]).toEqual([0, 1, 2]);
  });

  it('F8 (AK 1): anropsfel och oläsbara filer avvisas innan något anrop görs', async () => {
    const g = await skrivIndata(overlamning());
    const f = g.argument[1]!;
    const m = g.argument[3]!;
    const u = g.ut;
    for (const argument of [[], ['--overlamning', f, '--mottagare', m],
      ['--overlamning', f, '--mottagare', m, '--ut'],
      ['--overlamning', f, '--overlamning', f, '--ut', u],
      [...g.argument, 'extra'], ['--okand', f, '--mottagare', m, '--ut', u],
      ['--overlamning', '', '--mottagare', m, '--ut', u]]) {
      rakna.nollstall();
      expect(await korSkriptet(argument, rakna.bas)).toEqual({ kod: 2, rader: [ANROPSRAD] });
      expect(rakna.antal()).toBe(0);
    }
    const saknad = await skrivIndata(overlamning());
    saknad.argument[3] = path.join(saknad.hem, 'saknas');
    const ogiltig = await skrivIndata(overlamning(), { externa: ['Sidoprojektet'], interna: [] });
    const jsonfel = await skrivIndata('{');
    const bytefel = await skrivIndata(Buffer.from([0xff, 0xfe, 0x7b]));
    for (const [data, rad] of [
      [saknad, 'FEL: mottagarfilen gar inte att lasa (FileNotFoundError)'],
      [ogiltig, 'FEL: mottagarfilen gar inte att lasa (ValueError)'],
      [jsonfel, 'FEL: overlamningen gar inte att lasa (JSONDecodeError)'],
      [bytefel, 'FEL: overlamningen gar inte att lasa (UnicodeDecodeError)'],
    ] as const) {
      rakna.nollstall();
      expect(await korSkriptet(data.argument, rakna.bas)).toEqual({ kod: 2, rader: [rad] });
      expect(rakna.antal()).toBe(0);
      expect(await jsonRader(path.join(data.ut, 'overlamnade.jsonl'))).toEqual([]);
      expect(await jsonRader(path.join(data.ut, 'beslutsfragor.jsonl'))).toEqual([]);
    }
    // Kontroll: samma nyckel och räknare, men hela filer och ett giltigt anrop.
    rakna.nollstall();
    expect((await korSkriptet(g.argument, rakna.bas)).kod).toBe(1);
    expect(rakna.antal()).toBe(1);
  });
});

function fallrad(status: string, id: string, namn: string, kod: number, skapade: number,
  sparade: number, analyser: number, natanrop: number, innehall = true): string {
  return `${status} ${id} ${namn}: kod ${kod}, skapade ${skapade}, sparade ${sparade}, analyser ${analyser}, natanrop ${natanrop}`
    + (innehall ? '' : ', innehallet avviker');
}
let natet: Raknare;
async function korProvet(argument: string[], hem: string) {
  let resultat: Processutfall;
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', PROVET, ...argument], {
      cwd: ROT, env: barnmiljo(hem, natet.bas, 'provets-nyckel-som-aldrig-anvands'), timeout: 20_000,
    });
    resultat = { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (!arProcessfel(fel)) throw fel;
    resultat = { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
  }
  return { kod: resultat.kod, rader: resultat.ut.split(/\r?\n/).filter((rad) => rad.length > 0) };
}
async function korProvDrivern(lage: string) {
  const u = await korDrivern(await nyttHem(), ['prov', lage], natet.bas, 'provets-nyckel-som-aldrig-anvands');
  if (u.kod === 3) throw new Error(u.fel);
  return { kod: u.kod, rader: u.ut.split(/\r?\n/).filter((rad) => rad.length > 0) };
}
async function modulkatalog(filer: Record<string, string | Buffer>) {
  const katalog = await nyttHem();
  for (const [namn, varde] of Object.entries(filer)) {
    if (typeof varde === 'string' && path.dirname(varde) === ADAPTERN) {
      await copyFile(varde, path.join(katalog, namn));
    } else {
      await writeFile(path.join(katalog, namn), varde);
    }
  }
  return katalog;
}

describe('FR-30/Story 10.6 AK 2: det stående provet', () => {
  beforeAll(async () => { natet = await raknare(500, 'raknaren'); });
  afterAll(async () => { if (natet) await stang(natet.server); });

  it('F9 (AK 1, 2): GRON i sex fall utan nätanrop och med orört hem', async () => {
    const hem = await nyttHem();
    natet.nollstall();
    expect(await korProvet([], hem)).toEqual({ kod: 0, rader: GRON_RADER });
    expect(natet.antal()).toBe(0);
    expect(await readdir(hem)).toEqual([]);
  });

  it('F10 (AK 1, 2): sparande efter skapandefel, projekt och nätanrop ger ROD', async () => {
    const rod = 'ROD: overlamningsvagen haller inte';
    const vantat: Record<string, string[]> = {
      lucka8: [rod, ...GRON_RADER.slice(1, 5),
        fallrad('AVVIKER', 'P5', 'extern, svarar 400', 0, 1, 1, 0, 0),
        fallrad('AVVIKER', 'P6', 'extern, svarar inte', 0, 1, 1, 0, 0)],
      projekt: [rod, GRON_RADER[1]!, GRON_RADER[2]!,
        fallrad('AVVIKER', 'P3', 'extern', 0, 1, 1, 1, 0, false), GRON_RADER[4]!,
        fallrad('AVVIKER', 'P5', 'extern, svarar 400', 1, 1, 0, 0, 0, false),
        fallrad('AVVIKER', 'P6', 'extern, svarar inte', 1, 1, 0, 0, 0, false)],
      natet: [rod, ...GRON_RADER.slice(1).map((rad) => rad.replace(/^ok /, 'AVVIKER ').replace('natanrop 0', 'natanrop 1'))],
      hel: GRON_RADER,
    };
    for (const lage of ['lucka8', 'projekt', 'natet', 'hel']) {
      natet.nollstall();
      const u = await korProvDrivern(lage);
      expect(u).toEqual({ kod: lage === 'hel' ? 0 : 1, rader: vantat[lage] });
      expect(natet.antal()).toBe(0);
      expect(u.rader.some((rad) => rad.startsWith('KUNDE_INTE'))).toBe(false);
    }
  });

  it('F11 (AK 2): KUNDE_INTE bara vid läsning/import, övriga fel ger ROD', async () => {
    const hem = await nyttHem();
    const tabell: [Record<string, string | Buffer>, string][] = [
      [{ 'arenden_klient.py': KLIENTEN }, 'overlamningsvag gar inte att importera (ModuleNotFoundError)'],
      [{ 'overlamningsvag.py': VAGEN }, 'arenden_klient gar inte att importera (ModuleNotFoundError)'],
      [{ 'arenden_klient.py': KLIENTEN, 'overlamningsvag.py': Buffer.from([0xff, 0xfe, 0x0a]) },
        'overlamningsvag gar inte att importera (SyntaxError)'],
      [{ 'arenden_klient.py': KLIENTEN, 'overlamningsvag.py': 'raise RuntimeError("provets importfel")\n' },
        'overlamningsvag gar inte att importera (RuntimeError)'],
    ];
    natet.nollstall();
    const koder: number[] = [];
    for (const [filer, fel] of tabell) {
      const k = await modulkatalog(filer);
      const u = await korProvet(['--moduler', k], hem);
      expect(u).toEqual({ kod: 2, rader: ['KUNDE_INTE: ' + fel] });
      koder.push(u.kod);
    }
    const anropsfel = await korProvet(['--okand'], hem);
    expect(anropsfel).toEqual({ kod: 1, rader: [PROV_ANROPSRAD] });
    const hel = await modulkatalog({ 'arenden_klient.py': KLIENTEN, 'overlamningsvag.py': VAGEN });
    const kontroll = await korProvet(['--moduler', hel], hem);
    expect(kontroll).toEqual({ kod: 0, rader: GRON_RADER });
    expect([kontroll.kod, anropsfel.kod, koder[0]]).toEqual([0, 1, 2]);
    expect(natet.antal()).toBe(0);
  });
});
