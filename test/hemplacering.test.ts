// FR-19, B-17 punkten Hemplaceringen, Story 10.3.
// Kör adapter/hemplacering.py som barnprocess på funktionsnivå och mot appen/testdatabasen.
// AK 1: projektnamn, bara_om_osatt och ordagrant skäl. AK 2: mandatet före spärren med egna
// regler ur provet. AK 3: bevisregler och högar som summerar till universum före skrivningen.
// Läser aldrig hemplaceringen i drift, beslutskön eller driftens nyckel. Införandet sker utanför bygget.
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import pg from 'pg';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';
import { withTransaction } from '../src/db/tx.js';
import { pool } from '../src/db/pool.js';
import { hamtaEllerSkapaProjekt } from '../src/services/arenden.js';

// Barnprocess och tillåtelselista följer pythonklient.test.ts och spegellasning.test.ts.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const MODULEN = path.join(ADAPTERN, 'hemplacering.py');
const ANROPSRAD = 'FEL: anropet gar inte att tolka: [--skriv] [--regler <fil>]';
const EFTER = tid('2026-10-20', '10.00.00');
const FORE = tid('2026-09-20', '08.00.00');
const NFD = 'Älvdalen'.normalize('NFD');
const REGISTER = ['Kundbolaget', 'Locollabs', 'Privat', 'Ledning', 'Uppdrag', 'Importbrus', 'Älvdalen'.normalize('NFC')];
const REGLER = JSON.stringify({ beslut: 54, skapare: [
  { aktor_typ: 'agent', aktor_namn: 'provets-rollpass', klass: 'rollpass' },
  { aktor_typ: 'agent', aktor_namn: 'provets-hermes', klass: 'annan' },
] });

function tid(datum: string, hhmmss: string): string {
  return `${datum}T${hhmmss.replaceAll('.', ':')}.000Z`;
}

function skal(kalla: string, varde: string, projekt: string, niva: number, beslut?: number): string {
  return `hemplacering: ${kalla} "${varde}" ger ${projekt} (niva ${niva})`
    + (beslut === undefined ? '' : `; fore sparren, beslut #${beslut}`);
}

function rad(identifier: string, titel: string, etiketter: string[] = [], skapad = EFTER) {
  return { identifier, title: titel, labels: etiketter, skapad, projekt: null };
}

function skapadAv(typ: string, namn: string, verb = 'skapade_arende') {
  return [{ verb, aktor_typ: typ, aktor_namn: namn }];
}

type Handelser = ReturnType<typeof skapadAv> | null;
interface Bedomning { identifier: string; kod: string; projekt: string | null; text: string }
interface Processutfall { kod: number; ut: string; fel: string }

function barnmiljo(hem: string, bas?: string, nyckel?: string): NodeJS.ProcessEnv {
  // Testmiljön bär en attrappnyckel och riktiga HOME bär driftens nyckel: ingen spridning av process.env.
  return { PATH: process.env.PATH, HOME: hem,
    ...(bas === undefined ? {} : { ARENDEN_API_URL: bas }),
    ...(nyckel === undefined ? {} : { ARENDEN_API_KEY: nyckel }),
  };
}

const hemkataloger: string[] = [];
async function nyttHem(): Promise<string> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-hemplacering-'));
  hemkataloger.push(hem);
  return hem;
}
afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

// -I isolerar importerna, -B hindrar cachefiler. Kod 3 betyder trasig drivrutin, aldrig modulens utfall.
const DRIVER = `
import json
import sys
import traceback
try:
    sys.path.insert(0, sys.argv[1])
    import hemplacering as h
    import arenden_klient
    operation = sys.argv[2]
    if operation == "bedom":
        data = json.loads(sys.argv[3])
        regler = h.Regelutfall(h.tolka_regler(data["regler"]), None) if data["regler"] is not None else h.Regelutfall(None, data["regelorsak"])
        print(json.dumps([h.bedom_arende(h.till_arende(a["rad"], a["handelser"]), frozenset(data["register"]), regler)._asdict() for a in data["arenden"]]))
    elif operation == "regler":
        resultat = h.las_regler(None if sys.argv[3] == "-" else sys.argv[3])
        print(json.dumps({"skapare": resultat.regler.rader if resultat.regler is not None else None, "orsak": resultat.orsak}))
    elif operation in ("kor", "kor_mellanskrivning", "kor_skrivfel", "kor_trasig"):
        if operation == "kor_trasig":
            if sys.argv[4] == "okand_kod":
                original = h.bedom_arende
                forsta = True
                def trasig(arende, register, regler):
                    global forsta
                    if forsta:
                        forsta = False
                        return h.Bedomning(arende.identifier, "X9", None, "provets trasiga kod")
                    return original(arende, register, regler)
                h.bedom_arende = trasig
            elif sys.argv[4] == "tappad":
                original_alla = h.bedom_alla
                def tappad(universum, register, regler):
                    return original_alla(universum, register, regler)[1:]
                h.bedom_alla = tappad
            else:
                raise ValueError("okant fellage")
        anrop = []
        mellan_gjord = False
        def inspelare(action, indata):
            global mellan_gjord
            if operation == "kor_mellanskrivning" and action == "update_issue" and indata["identifier"] == sys.argv[4] and not mellan_gjord:
                mellan_gjord = True
                mellan = {"identifier": sys.argv[4], "projekt": sys.argv[5], "skal": "provets andra skrivare"}
                anrop.append(["mellan", mellan])
                arenden_klient.anropa("update_issue", mellan, nyckel=sys.argv[6])
            anrop.append([action, indata])
            if operation == "kor_skrivfel" and action == "update_issue" and indata["identifier"] == sys.argv[4]:
                raise arenden_klient.ArendeFel(500, "provets_fel")
            return arenden_klient.anropa(action, indata)
        skriv = sys.argv[4] == "1" if operation == "kor" else True
        resultat = h.korning(inspelare, None if sys.argv[3] == "-" else sys.argv[3], skriv)
        print(json.dumps({"kod": resultat.kod, "rader": resultat.rader,
            "bedomningar": [b._asdict() for b in resultat.bedomningar],
            "skrivningar": [s._asdict() for s in resultat.skrivningar], "anrop": anrop}))
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

async function korBedom(arenden: { rad: ReturnType<typeof rad>; handelser: Handelser }[],
  regler: string | null = null, regelorsak: string | null = 'ingen regelfil', register = REGISTER): Promise<Bedomning[]> {
  const utfall = await korDrivern(await nyttHem(), ['bedom', JSON.stringify({ arenden, regler, regelorsak, register })]);
  if (utfall.kod !== 0) throw new Error(utfall.fel);
  return JSON.parse(utfall.ut) as Bedomning[];
}

async function korRegler(sokvag: string | null) {
  const utfall = await korDrivern(await nyttHem(), ['regler', sokvag ?? '-']);
  if (utfall.kod !== 0) throw new Error(utfall.fel);
  return JSON.parse(utfall.ut) as { skapare: [string, string, string][] | null; orsak: string | null };
}

function bedomning(n: number, kod: string, projekt: string | null, text: string): Bedomning {
  return { identifier: `LOC-${n}`, kod, projekt, text };
}

describe('FR-19/Story 10.3 AK 1–3: bedömningen', () => {
  it('F1 (AK 1, 3): bevis i tre nivåer, och fler än ett mål placerar inte', async () => {
    const indata = [
      rad('LOC-1', '[Kundbolaget] Offert'), rad('LOC-2', 'Offert', ['kundbolaget']),
      rad('LOC-3', 'Fakturafrågor', ['ADMIN']), rad('LOC-4', `[${NFD}] Resa`),
      rad('LOC-5', '[Kundbolaget][Privat] Två'), rad('LOC-6', '[Väntar-extern] Daniel', ['Okänd']),
      rad('LOC-7', 'Ingenting'), rad('LOC-8', '[Kundbolaget] Dubbelt', ['Kundbolaget']),
      rad('LOC-9', 'Offert [Kundbolaget]'), rad('LOC-10', '  [Kundbolaget] Offert'),
    ];
    expect(await korBedom(indata.map((a) => ({ rad: a, handelser: null })))).toEqual([
      bedomning(1, 'P1', 'Kundbolaget', skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1)),
      bedomning(2, 'P1', 'Kundbolaget', skal('etikett', 'kundbolaget', 'Kundbolaget', 2)),
      bedomning(3, 'P1', 'Locollabs', skal('etikett', 'ADMIN', 'Locollabs', 3)),
      bedomning(4, 'P1', 'Älvdalen', skal('titeltagg', NFD, 'Älvdalen', 2)),
      bedomning(5, 'F2', null, 'motstridiga bevis: Kundbolaget, Privat'),
      bedomning(6, 'F1', null, 'omatchat bevis: Väntar-extern, Okänd'),
      bedomning(7, 'U1', null, 'inget bevis'),
      bedomning(8, 'P1', 'Kundbolaget', skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1)),
      bedomning(9, 'U1', null, 'inget bevis'),
      bedomning(10, 'P1', 'Kundbolaget', skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1)),
    ]);
    expect(await korBedom([{ rad: rad('LOC-11', 'X', ['privat']), handelser: null }], null,
      'ingen regelfil', ['Privat', 'PRIVAT'])).toEqual([
      bedomning(11, 'F2', null, 'motstridiga bevis: PRIVAT, Privat'),
    ]);
  });

  it('F2 (AK 2): spärren och mandatet för ärendena från före spärren', async () => {
    const a = (n: number, titel: string, etiketter: string[] = [],
      handelser: Handelser = skapadAv('agent', 'provets-hermes'), skapad = FORE) =>
      ({ rad: rad(`LOC-${n}`, titel, etiketter, skapad), handelser });
    const admin = a(21, 'Admin-arbete', ['Admin']);
    const grans = tid('2026-09-27', '22.00.00');
    const precisFore = tid('2026-09-27', '21.59.59');
    const rollpass = skapadAv('agent', 'provets-rollpass');
    const resultat = await korBedom([
      a(20, '[Kundbolaget] Rollpassets uppgift', [], rollpass), admin,
      a(22, '[Privat] Tandläkare'), a(23, 'Styrelsemöte', ['ledning']),
      a(24, '[Uppdrag] Leverans'), a(25, 'Importerat', ['Importbrus']),
      a(26, '[Kundbolaget] Offert före spärren'), a(27, 'Utan bevis'),
      a(28, '[Kundbolaget] Två mål', ['Admin']), a(29, '[Väntar-extern] Väntar'),
      a(30, 'Okänd', ['Admin'], skapadAv('agent', 'provets-okand')),
      a(31, 'Ingen', ['Admin'], []), a(32, 'Två', ['Admin'], [...skapadAv('agent', 'provets-hermes'), ...skapadAv('agent', 'provets-hermes')]),
      a(33, 'Oläst', ['Admin'], null), a(34, 'Import', ['Admin'], skapadAv('system', 'linear-import', 'importerade_arende')),
      a(35, '[Kundbolaget] Gräns', [], rollpass, grans), a(36, '[Kundbolaget] Gräns', [], rollpass, precisFore),
      a(37, 'Admin-arbete', ['Admin'], skapadAv('agent', 'provets-hermes'), EFTER),
    ], REGLER);
    expect(resultat).toEqual([
      bedomning(20, 'U2', null, 'skapat av rollpass agent/provets-rollpass, beslut #54'),
      bedomning(21, 'P2', 'Locollabs', skal('etikett', 'Admin', 'Locollabs', 3, 55)),
      bedomning(22, 'P2', 'Privat', skal('titeltagg', 'Privat', 'Privat', 1, 56)),
      bedomning(23, 'P2', 'Ledning', skal('etikett', 'ledning', 'Ledning', 2, 56)),
      bedomning(24, 'P2', 'Uppdrag', skal('titeltagg', 'Uppdrag', 'Uppdrag', 1, 56)),
      bedomning(25, 'P2', 'Importbrus', skal('etikett', 'Importbrus', 'Importbrus', 1, 57)),
      bedomning(26, 'F3', null, 'fore sparren, bevis utan beslut: Kundbolaget'),
      bedomning(27, 'F4', null, 'fore sparren, utan bevis'),
      bedomning(28, 'F2', null, 'motstridiga bevis: Kundbolaget, Locollabs'),
      bedomning(29, 'F1', null, 'omatchat bevis: Väntar-extern'),
      ...[
        'agent/provets-okand star inte i regelfilen', '0 skapandehandelser', '2 skapandehandelser',
        'skapandehandelserna ar inte lasta', 'system/linear-import star inte i regelfilen',
      ].map((text, i) => bedomning(30 + i, 'U3', null, `skaparen gar inte att avgora: ${text}`)),
      bedomning(35, 'P1', 'Kundbolaget', skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1)),
      bedomning(36, 'U2', null, 'skapat av rollpass agent/provets-rollpass, beslut #54'),
      bedomning(37, 'P1', 'Locollabs', skal('etikett', 'Admin', 'Locollabs', 3)),
    ]);
    for (const orsak of ['ingen regelfil', 'regelfilen gar inte att lasa (ValueError)']) {
      expect(await korBedom([admin], null, orsak)).toEqual([
        bedomning(21, 'U3', null, `skaparen gar inte att avgora: ${orsak}`),
      ]);
    }
    expect(await korBedom([
      a(35, '[Kundbolaget] Gräns', [], rollpass, grans), a(36, '[Kundbolaget] Gräns', [], rollpass, precisFore),
    ])).toEqual([
      bedomning(35, 'P1', 'Kundbolaget', skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1)),
      bedomning(36, 'U3', null, 'skaparen gar inte att avgora: ingen regelfil'),
    ]);
    expect(await korBedom([a(38, 'Admin-arbete', ['Admin']),
      a(39, 'Admin-arbete', ['Admin'], skapadAv('agent', 'provets-hermes'), EFTER)], REGLER, null,
    [...REGISTER, 'Admin'])).toEqual([
      bedomning(38, 'F3', null, 'fore sparren, bevis utan beslut: Admin'),
      bedomning(39, 'P1', 'Admin', skal('etikett', 'Admin', 'Admin', 1)),
    ]);
  });

  it('F3 (AK 2): regelfilen har en sluten form och allt annat ger en orsak', async () => {
    const hem = await nyttHem();
    const fil = path.join(hem, 'regler.json');
    await writeFile(fil, REGLER);
    expect(await korRegler(fil)).toEqual({ skapare: [
      ['agent', 'provets-rollpass', 'rollpass'], ['agent', 'provets-hermes', 'annan'],
    ], orsak: null });
    expect(await korRegler(null)).toEqual({ skapare: null, orsak: 'ingen regelfil' });
    expect(await korRegler(path.join(hem, 'saknas'))).toEqual({
      skapare: null, orsak: 'regelfilen gar inte att lasa (FileNotFoundError)',
    });
    const grund = JSON.parse(REGLER) as { beslut: number; skapare: Record<string, unknown>[] };
    const forsta = grund.skapare[0]!;
    const fel: (string | Buffer)[] = [
      '{', '[]', JSON.stringify({ ...grund, extra: 1 }),
      JSON.stringify({ ...grund, beslut: 55 }), JSON.stringify({ ...grund, beslut: true }),
      JSON.stringify({ ...grund, skapare: [] }),
      ...[{ ...forsta, extra: 1 }, { ...forsta, aktor_typ: 'robot' }, { ...forsta, aktor_namn: '' },
        { ...forsta, klass: 'kanske' }].map((skapare) => JSON.stringify({ beslut: 54, skapare: [skapare] })),
      JSON.stringify({ beslut: 54, skapare: [forsta, { ...forsta, klass: 'annan' }] }),
      Buffer.from([0xff, 0xfe, 0x7b, 0x7d]),
    ];
    for (const [i, text] of fel.entries()) {
      const sokvag = path.join(hem, `fel-${i}.json`);
      await writeFile(sokvag, text);
      const typ = i === 0 ? 'JSONDecodeError' : i === 11 ? 'UnicodeDecodeError' : 'ValueError';
      expect(await korRegler(sokvag)).toEqual({ skapare: null, orsak: `regelfilen gar inte att lasa (${typ})` });
    }
  });
});

const PROJEKT = ['Kundbolaget', 'Locollabs', 'Privat', 'Ledning', 'Uppdrag', 'Importbrus'];
interface Testserver {
  app: Express; server: Server; bas: string; hem: string; regler: string;
  modul: string; hermes: string; rollpass: string; okand: string; annan: string;
}
interface Skrivindata { identifier: string; projekt: string; skal: string; bara_om_osatt: boolean }
interface Korutfall {
  kod: number; rader: string[]; bedomningar: Bedomning[];
  skrivningar: { identifier: string; projekt: string; utfall: string }[];
  anrop: [string, Record<string, unknown>][];
}
interface Handelse {
  verb: string; aktor_typ: string; aktor_namn: string; payload: Record<string, unknown>;
}
let v: Testserver;

async function adminKlient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  return client;
}
async function seedaProjekt(namn: string): Promise<void> {
  await withTransaction((client) => hamtaEllerSkapaProjekt(client, TENANT_ID, namn));
}
async function regelfil(hem: string, text: string): Promise<string> {
  const fil = path.join(hem, 'regler.json');
  await writeFile(fil, text);
  return fil;
}
async function starta(): Promise<Testserver> {
  const app = createApp();
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  try {
    await seedaTeam();
    for (const namn of PROJEKT) await seedaProjekt(namn);
    const modul = await nyNyckel({ typ: 'agent', namn: 'hemplaceringen' });
    const hermes = await nyNyckel({ typ: 'agent', namn: 'provets-hermes' });
    const rollpass = await nyNyckel({ typ: 'agent', namn: 'provets-rollpass' });
    const okand = await nyNyckel({ typ: 'agent', namn: 'provets-okand' });
    const annan = await nyNyckel({ typ: 'agent', namn: 'provets-annan' });
    const hem = await nyttHem();
    return { app, server, bas: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      modul, hermes, rollpass, okand, annan, hem, regler: await regelfil(hem, REGLER) };
  } catch (fel) {
    await new Promise<void>((klar) => server.close(() => klar()));
    throw fel;
  }
}
async function nyttArende(nyckel: string, titel: string, etiketter: string[] = []) {
  const svar = await kor(v.app, nyckel, 'create_issue', { title: titel, team_key: 'LOC', labels: etiketter });
  expect(svar.status).toBe(200);
  return svar.body.result as { id: string; identifier: string };
}
async function sattSkapad(id: string, tidpunkt: string): Promise<void> {
  const client = await adminKlient();
  try {
    await client.query('UPDATE issues SET skapad = $2 WHERE id = $1', [id, tidpunkt]);
  } finally { await client.end(); }
}
async function handelserFor(id: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM events WHERE issue_id = $1', [id]);
  return Number(rows[0]!.n);
}
async function hemlosa(): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM issues WHERE project_id IS NULL');
  return Number(rows[0]!.n);
}
async function hamtat(identifier: string) {
  const svar = await kor(v.app, v.hermes, 'get_issue', { identifier });
  expect(svar.status).toBe(200);
  return svar.body.result as { arende: { projekt: string | null }; handelser: Handelse[] };
}
async function korMedServer(argument: string[]): Promise<Korutfall> {
  const resultat = await korDrivern(v.hem, argument, v.bas, v.modul);
  if (resultat.kod !== 0) throw new Error(resultat.fel);
  return JSON.parse(resultat.ut) as Korutfall;
}
async function korKorning(regler: string | null, skriv: boolean): Promise<Korutfall> {
  return korMedServer(['kor', regler ?? '-', skriv ? '1' : '0']);
}
async function korMellan(regler: string, identifier: string, projekt: string, nyckel: string) {
  return korMedServer(['kor_mellanskrivning', regler, identifier, projekt, nyckel]);
}
async function korSkrivfel(regler: string, identifier: string) {
  return korMedServer(['kor_skrivfel', regler, identifier]);
}
function uppdateringar(utfall: Korutfall): Skrivindata[] {
  return utfall.anrop.filter(([action]) => action === 'update_issue').map(([, data]) => data as unknown as Skrivindata);
}
function indataFor(utfall: Korutfall, identifier: string): Skrivindata[] {
  return uppdateringar(utfall).filter((a) => a.identifier === identifier);
}
function bFor(utfall: Korutfall, identifier: string): Bedomning | undefined {
  return utfall.bedomningar.find((b) => b.identifier === identifier);
}

describe('FR-19/Story 10.3 AK 1–3: hemplaceringen mot testservern', () => {
  beforeAll(async () => { v = await starta(); });
  afterAll(async () => { if (v) await new Promise<void>((klar) => v.server.close(() => klar())); });

  it('F4 (AK 1): projektets namn, aldrig id, och skälet ordagrant i händelseraden', async () => {
    const a = await nyttArende(v.hermes, '[Kundbolaget] Offert till kunden');
    const s = skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1);
    const utfall = await korKorning(v.regler, true);
    expect(utfall.kod).toBe(0);
    expect(indataFor(utfall, a.identifier)).toEqual([
      { identifier: a.identifier, projekt: 'Kundbolaget', skal: s, bara_om_osatt: true },
    ]);
    for (const [, indata] of utfall.anrop) {
      for (const value of Object.values(indata)) {
        if (typeof value === 'string') expect(value).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
      }
      if ('projekt' in indata) expect(PROJEKT).toContain(indata.projekt);
    }
    expect(utfall.rader).toContain(`${a.identifier} P1: ${s}`);
    expect(utfall.rader).toContain(`skrev ${a.identifier}: projekt Kundbolaget`);
    const hamta = await hamtat(a.identifier);
    expect(hamta.arende.projekt).toBe('Kundbolaget');
    const andrade = hamta.handelser.filter((h) => h.verb === 'andrade_projekt');
    expect(andrade).toHaveLength(1);
    expect(andrade[0]).toMatchObject({ aktor_typ: 'agent', aktor_namn: 'hemplaceringen' });
    expect(andrade[0]!.payload).toEqual({ identifier: a.identifier, falt: 'projekt', fran: null, till: 'Kundbolaget', skal: s });
    const c = await nyttArende(v.hermes, 'Kontroll med id');
    const registerSvar = await kor(v.app, v.hermes, 'list_project_customers', {});
    const register = registerSvar.body.result as { projekt: string; projekt_id: string }[];
    const id = register.find((p) => p.projekt === 'Kundbolaget')!.projekt_id;
    const n = await raknaRader('events');
    const kontroll = await kor(v.app, v.modul, 'update_issue', {
      identifier: c.identifier, projekt: id, skal: s, bara_om_osatt: true,
    });
    expect(kontroll.status).toBe(404);
    expect(kontroll.body).toEqual({ error: 'not_found' });
    expect(await raknaRader('events')).toBe(n);
    expect((await hamtat(c.identifier)).arende.projekt).toBeNull();
  });

  it('F5 (AK 2): ärendena från före spärren följer besluten och regelfilen', async () => {
    const r = await nyttArende(v.rollpass, '[Kundbolaget] Rollpassets uppgift');
    const a = await nyttArende(v.hermes, 'Admin-arbete', ['Admin']);
    const p = await nyttArende(v.hermes, '[Privat] Tandläkare');
    const l = await nyttArende(v.hermes, 'Styrelsemöte', ['ledning']);
    const n = await nyttArende(v.hermes, 'Utan bevis');
    const k = await nyttArende(v.hermes, '[Kundbolaget] Offert före spärren');
    const u = await nyttArende(v.hermes, '[Uppdrag] Leverans');
    const i = await nyttArende(v.hermes, 'Importerat', ['Importbrus']);
    const o = await nyttArende(v.okand, 'Okänd skapare', ['Admin']);
    for (const arende of [r, a, p, l, n, k, u, i, o]) await sattSkapad(arende.id, FORE);
    const par = [
      { a, titel: 'Admin-arbete', labels: ['Admin'], projekt: 'Locollabs', s: skal('etikett', 'Admin', 'Locollabs', 3, 55) },
      { a: p, titel: '[Privat] Tandläkare', labels: [], projekt: 'Privat', s: skal('titeltagg', 'Privat', 'Privat', 1, 56) },
      { a: l, titel: 'Styrelsemöte', labels: ['ledning'], projekt: 'Ledning', s: skal('etikett', 'ledning', 'Ledning', 2, 56) },
      { a: u, titel: '[Uppdrag] Leverans', labels: [], projekt: 'Uppdrag', s: skal('titeltagg', 'Uppdrag', 'Uppdrag', 1, 56) },
      { a: i, titel: 'Importerat', labels: ['Importbrus'], projekt: 'Importbrus', s: skal('etikett', 'Importbrus', 'Importbrus', 1, 57) },
    ];
    const tvillingar = [];
    for (const item of par) tvillingar.push(await nyttArende(v.hermes, `${item.titel} efter spärren`, item.labels));
    const ororda = [
      { a: r, kod: 'U2', text: 'skapat av rollpass agent/provets-rollpass, beslut #54' },
      { a: n, kod: 'F4', text: 'fore sparren, utan bevis' },
      { a: k, kod: 'F3', text: 'fore sparren, bevis utan beslut: Kundbolaget' },
      { a: o, kod: 'U3', text: 'skaparen gar inte att avgora: agent/provets-okand star inte i regelfilen' },
    ];
    const antal = await Promise.all(ororda.map((item) => handelserFor(item.a.id)));
    const utfall = await korKorning(v.regler, true);
    expect(utfall.kod).toBe(0);
    for (const [index, item] of ororda.entries()) {
      expect(indataFor(utfall, item.a.identifier)).toEqual([]);
      expect(await handelserFor(item.a.id)).toBe(antal[index]);
      expect((await hamtat(item.a.identifier)).arende.projekt).toBeNull();
      expect(bFor(utfall, item.a.identifier)).toEqual({ identifier: item.a.identifier,
        kod: item.kod, projekt: null, text: item.text });
    }
    for (const [index, item] of par.entries()) {
      expect(indataFor(utfall, item.a.identifier)).toEqual([
        { identifier: item.a.identifier, projekt: item.projekt, skal: item.s, bara_om_osatt: true },
      ]);
      const hamta = await hamtat(item.a.identifier);
      expect(hamta.arende.projekt).toBe(item.projekt);
      const andrade = hamta.handelser.filter((h) => h.verb === 'andrade_projekt');
      expect(andrade).toHaveLength(1);
      expect(andrade[0]!.payload.skal).toBe(item.s);
      expect(indataFor(utfall, tvillingar[index]!.identifier)).toEqual([
        { identifier: tvillingar[index]!.identifier, projekt: item.projekt,
          skal: item.s.replace(/; fore sparren, beslut #\d+$/, ''), bara_om_osatt: true },
      ]);
    }
    expect(utfall.rader.slice(0, 2)).toEqual([
      'regel #54: agent/provets-rollpass ar rollpass', 'regel #54: agent/provets-hermes ar annan',
    ]);
    expect((await hamtat(r.identifier)).handelser.filter((h) => h.verb === 'skapade_arende')).toEqual([
      expect.objectContaining({ aktor_typ: 'agent', aktor_namn: 'provets-rollpass' }),
    ]);
    const a2 = await nyttArende(v.hermes, 'Admin-arbete igen', ['Admin']);
    await sattSkapad(a2.id, FORE);
    const utan = await korKorning(null, true);
    expect(utan.kod).toBe(0);
    expect(utan.rader[0]).toBe('regel #54: ingen regelfil, inget arende fran fore sparren placeras');
    expect(bFor(utan, a2.identifier)).toEqual({ identifier: a2.identifier, kod: 'U3', projekt: null,
      text: 'skaparen gar inte att avgora: ingen regelfil' });
    expect(indataFor(utan, a2.identifier)).toEqual([]);
    expect((await hamtat(a2.identifier)).arende.projekt).toBeNull();
    const med = await korKorning(v.regler, true);
    expect(med.kod).toBe(0);
    expect(indataFor(med, a2.identifier)).toEqual([
      { identifier: a2.identifier, projekt: 'Locollabs', skal: skal('etikett', 'Admin', 'Locollabs', 3, 55), bara_om_osatt: true },
    ]);
    expect((await hamtat(a2.identifier)).arende.projekt).toBe('Locollabs');
  });

  it('F6 (AK 1, 3): bara_om_osatt håller mot en annan skrivare, och skrivfel syns', async () => {
    const m = await nyttArende(v.hermes, '[Kundbolaget] Mellan');
    const g = await nyttArende(v.hermes, '[Kundbolaget] Granne');
    const s = skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1);
    const utfall = await korMellan(v.regler, m.identifier, 'Privat', v.annan);
    expect(utfall.kod).toBe(0);
    const mellan = ['mellan', { identifier: m.identifier, projekt: 'Privat', skal: 'provets andra skrivare' }];
    expect(utfall.anrop).toContainEqual(mellan);
    expect(utfall.anrop.findIndex(([action]) => action === 'mellan')).toBeLessThan(
      utfall.anrop.findIndex(([action, data]) => action === 'update_issue' && data.identifier === m.identifier));
    expect(utfall.rader).toContain(`oforandrat ${m.identifier}: projektet var redan satt`);
    expect(utfall.rader).toContain(`skrev ${g.identifier}: projekt Kundbolaget`);
    expect(utfall.rader.at(-1)).toBe('KLAR: 1 skrivna, 1 oforandrade, 0 fel');
    const hamta = await hamtat(m.identifier);
    expect(hamta.arende.projekt).toBe('Privat');
    expect(hamta.handelser.map((h) => [h.verb, h.aktor_namn])).toEqual([
      ['skapade_arende', 'provets-hermes'], ['andrade_projekt', 'provets-annan'], ['arendet_oforandrat', 'hemplaceringen'],
    ]);
    expect(hamta.handelser[1]!.payload.till).toBe('Privat');
    expect(hamta.handelser[2]!.payload).toEqual({ identifier: m.identifier, skal: s });
    const kontroll = await kor(v.app, v.modul, 'update_issue', { identifier: m.identifier, projekt: 'Kundbolaget', skal: s });
    expect(kontroll.status).toBe(200);
    expect(kontroll.body.result.andringar).toEqual([{ falt: 'projekt', fran: 'Privat', till: 'Kundbolaget' }]);
    const x = await nyttArende(v.hermes, '[Kundbolaget] Fel');
    const y = await nyttArende(v.hermes, '[Kundbolaget] Rätt');
    const fel = await korSkrivfel(v.regler, x.identifier);
    expect(fel.kod).toBe(1);
    expect(fel.rader).toContain(`FEL ${x.identifier}: update_issue gav 500 provets_fel`);
    expect(fel.rader).toContain(`skrev ${y.identifier}: projekt Kundbolaget`);
    expect(fel.rader.at(-1)).toBe('KLAR: 1 skrivna, 0 oforandrade, 1 fel');
    expect((await hamtat(x.identifier)).arende.projekt).toBeNull();
    expect((await hamtat(y.identifier)).arende.projekt).toBe('Kundbolaget');
  });
});

async function korTrasig(regler: string, lage: string): Promise<Korutfall> {
  return korMedServer(['kor_trasig', regler, lage]);
}
async function korSkriptet(argument: string[], bas: string): Promise<{ kod: number; rader: string[] }> {
  let resultat: Processutfall;
  try {
    // -s och tillåtelselistan isolerar användarmiljön; skriptets katalog behövs för klientimporten.
    const { stdout, stderr } = await korProcess('python3', ['-B', '-s', MODULEN, ...argument], {
      cwd: ROT, env: barnmiljo(v.hem, bas, v.modul), timeout: 20_000,
    });
    resultat = { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (!arProcessfel(fel)) throw fel;
    resultat = { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
  }
  return { kod: resultat.kod, rader: resultat.ut.split(/\r?\n/).filter((rad) => rad.length > 0) };
}
interface Raknare { server: Server; bas: string; antal: () => number; nollstall: () => void }
async function raknare(): Promise<Raknare> {
  let antal = 0;
  const server = createServer((req, res) => {
    antal += 1;
    req.resume();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"raknaren"}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  return { server, bas: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    antal: () => antal, nollstall: () => { antal = 0; } };
}

describe('FR-19/Story 10.3 AK 3: högarna och skriptet', () => {
  let rakna: Raknare;
  beforeAll(async () => { v = await starta(); rakna = await raknare(); });
  afterAll(async () => {
    if (v) await new Promise<void>((klar) => v.server.close(() => klar()));
    if (rakna) await new Promise<void>((klar) => rakna.server.close(() => klar()));
  });

  it('F7 (AK 3): högarna summerar till universum före första skrivningen', async () => {
    const t = await nyttArende(v.hermes, '[Kundbolaget] Titeltagg');
    const e = await nyttArende(v.hermes, 'Etikett', ['Kundbolaget']);
    const m = await nyttArende(v.hermes, '[Kundbolaget] Motstridigt', ['Admin']);
    const f = await nyttArende(v.hermes, '[Väntar-extern] Omatchat');
    const u = await nyttArende(v.hermes, 'Utan bevis efter spärren');
    const n = await hemlosa();
    const antal = await raknaRader('events');
    for (const lage of ['okand_kod', 'tappad']) {
      const trasig = await korTrasig(v.regler, lage);
      expect(trasig.kod).toBe(2);
      expect(trasig.rader.at(-1)).toBe(`FEL: hogarna stammer inte med universum (summa ${n - 1}, universum ${n}), inget skrevs`);
      expect(uppdateringar(trasig)).toEqual([]);
      expect(await raknaRader('events')).toBe(antal);
      expect((await hamtat(t.identifier)).arende.projekt).toBeNull();
      expect((await hamtat(e.identifier)).arende.projekt).toBeNull();
    }
    const hel = await korKorning(v.regler, true);
    expect(hel.kod).toBe(0);
    const vantat: [string, string, string | null, string][] = [
      [t.identifier, 'P1', 'Kundbolaget', skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1)],
      [e.identifier, 'P1', 'Kundbolaget', skal('etikett', 'Kundbolaget', 'Kundbolaget', 1)],
      [m.identifier, 'F2', null, 'motstridiga bevis: Kundbolaget, Locollabs'],
      [f.identifier, 'F1', null, 'omatchat bevis: Väntar-extern'],
      [u.identifier, 'U1', null, 'inget bevis'],
    ];
    for (const [identifier, kod, projekt, text] of vantat) {
      expect(bFor(hel, identifier)).toEqual({ identifier, kod, projekt, text });
    }
    const placeras = hel.bedomningar.filter((b) => ['P1', 'P2'].includes(b.kod));
    const fragor = hel.bedomningar.filter((b) => ['F1', 'F2', 'F3', 'F4'].includes(b.kod));
    const utan = hel.bedomningar.filter((b) => ['U1', 'U2', 'U3'].includes(b.kod));
    expect(placeras.length + fragor.length + utan.length).toBe(n);
    expect(hel.rader.filter((rad) => rad.startsWith('hogar: '))).toEqual([
      `hogar: placeras=${placeras.length} fragegrupper=${fragor.length} utan_vag=${utan.length} summa=${n} universum=${n}`,
    ]);
    expect(hel.rader).toContain(`fragegrupp "motstridiga bevis: Kundbolaget, Locollabs": ${m.identifier}`);
    expect(hel.rader).toContain(`fragegrupp "omatchat bevis: Väntar-extern": ${f.identifier}`);
    expect(uppdateringar(hel).map((a) => a.identifier).sort()).toEqual(placeras.map((b) => b.identifier).sort());
    expect((await hamtat(t.identifier)).arende.projekt).toBe('Kundbolaget');
    expect((await hamtat(e.identifier)).arende.projekt).toBe('Kundbolaget');
  });

  it('F8 (AK 3): torrkörning som standard, skrivning på begäran och fel ger kod 2', async () => {
    const p = await nyttArende(v.hermes, '[Kundbolaget] Torr');
    const fore = await raknaRader('events');
    const torr = await korSkriptet(['--regler', v.regler], v.bas);
    expect(torr.kod).toBe(0);
    const k = torr.rader.filter((rad) => /^\S+ P[12]: /.test(rad)).length;
    expect(k).toBeGreaterThan(0);
    expect(torr.rader.at(-1)).toBe(`TORRKORNING: ${k} placeringar skrevs inte`);
    expect((await hamtat(p.identifier)).arende.projekt).toBeNull();
    expect(await raknaRader('events')).toBe(fore);
    const skriv = await korSkriptet(['--skriv', '--regler', v.regler], v.bas);
    expect(skriv.kod).toBe(0);
    expect(skriv.rader.at(-1)).toBe(`KLAR: ${k} skrivna, 0 oforandrade, 0 fel`);
    expect((await hamtat(p.identifier)).arende.projekt).toBe('Kundbolaget');
    const lasfel = ['FEL: hemplaceringen stannade: ArendeFel'];
    rakna.nollstall();
    expect(await korSkriptet(['--skriv', '--regler', v.regler], rakna.bas)).toEqual({ kod: 2, rader: lasfel });
    expect(rakna.antal()).toBe(1);
    for (const argument of [['--okand'], ['--regler'], ['--skriv', '--skriv'],
      ['--regler', v.regler, '--regler', v.regler], ['extra']]) {
      rakna.nollstall();
      expect(await korSkriptet(argument, rakna.bas)).toEqual({ kod: 2, rader: [ANROPSRAD] });
      expect(rakna.antal()).toBe(0);
    }
    rakna.nollstall();
    expect(await korSkriptet(['--regler', v.regler], rakna.bas)).toEqual({ kod: 2, rader: lasfel });
    expect(rakna.antal()).toBe(1);
  });
});
