// FR-19, B-17 punkten Tre utfall, Story 10.4.
// Kör placeringslasning.py mot appen/testdatabasen, stängd port och räknare:
// oläsbar plattform ger KUNDE_INTE med vad som inte kunde läsas, aldrig GRON.
// Hemlösa efter spärren räknas mot spärr 0; de från före står kvar i talet.
// Negativ kontroll fångar påhittad placering och tre utfall har var sin exitkod.
// Läser aldrig placeringsprovet i drift eller driftens nyckel. Införandet sker utanför bygget.
import { execFile } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as vanta } from 'node:timers/promises';
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
import { hamtaEllerSkapaProjekt } from '../src/services/arenden.js';
import { getAction } from '../src/actions/registry.js';
import { skrivHandelse } from '../src/services/handelser.js';
import type { Aktor } from '../src/lib/aktor.js';

// Barnprocess och fixturer följer hemplacering.test.ts och pythonklient.test.ts.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const FORE = tid('2026-09-20', '08.00.00');
const PROJEKT = ['Kundbolaget', 'Locollabs', 'Privat'];
const REGLER = JSON.stringify({ beslut: 54, skapare: [
  { aktor_typ: 'agent', aktor_namn: 'provets-rollpass', klass: 'rollpass' },
  { aktor_typ: 'agent', aktor_namn: 'provets-hermes', klass: 'annan' },
] });
function tid(datum: string, hhmmss: string): string {
  return `${datum}T${hhmmss.replaceAll('.', ':')}.000Z`;
}
interface Processutfall { kod: number; ut: string; fel: string }
interface Rad {
  identifier: string; projekt: string | null; fore_sparren: boolean;
  skapare: [string, string][] | null; placering: [string | null, string | null] | null;
}
interface Lasutfall { fel: string | null; arenden: Rad[]; register: string[]; anrop: [string, Record<string, unknown>][] }
type Avbrott = [string, number] | null;
interface Testserver {
  app: Express; server: Server; bas: string; hem: string; regler: string;
  provet: string; hermes: string; rollpass: string; david: string; hemplaceringen: string;
}
let v: Testserver;
function barnmiljo(hem: string, bas?: string, nyckel?: string): NodeJS.ProcessEnv {
  // Provprocessen bär attrappnyckeln och riktiga HOME driftens nyckel: bara tillåtelselistan förs vidare.
  return { PATH: process.env.PATH, HOME: hem,
    ...(bas === undefined ? {} : { ARENDEN_API_URL: bas }),
    ...(nyckel === undefined ? {} : { ARENDEN_API_KEY: nyckel }),
  };
}
const hemkataloger: string[] = [];
async function nyttHem(): Promise<string> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-placeringslasning-'));
  hemkataloger.push(hem);
  return hem;
}
afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

// -I isolerar importerna, -B hindrar cache. Drivrutinsfel har kod 3, aldrig modulens utfall.
const DRIVER = `
import json
import os
import sys
import time
import traceback
try:
    sys.path.insert(0, sys.argv[1])
    import placeringslasning as p
    import hemplacering as h
    import arenden_klient
    operation = sys.argv[2]
    anrop = []
    antal = {}
    avbrott = ("-", 0)
    sluss = []
    if operation == "hamta":
        p.SIDSTORLEK = int(sys.argv[3])
        avbrott = (sys.argv[4], int(sys.argv[5]))
        sluss = [] if sys.argv[6] == "-" else sys.argv[6].split(",")
    elif operation == "kor":
        avbrott = (sys.argv[4], int(sys.argv[5]))
    def inspelare(action, indata):
        anrop.append([action, indata])
        antal[action] = antal.get(action, 0) + 1
        if (action, antal[action]) == avbrott:
            raise arenden_klient.ArendeFel(503, "provets_avbrott")
        nyckel = "%s:%d" % (action, antal[action])
        if nyckel in sluss:
            n = sluss.index(nyckel) + 1
            open(os.path.join(os.environ["HOME"], "paus-%d" % n), "w").close()
            slut = time.monotonic() + 10
            while not os.path.exists(os.path.join(os.environ["HOME"], "fortsatt-%d" % n)):
                if time.monotonic() >= slut:
                    raise RuntimeError("slussen")
                time.sleep(0.02)
        return arenden_klient.anropa(action, indata)
    if operation == "hamta":
        l = p.hamta_plattformen(inspelare)
        print(json.dumps({"fel": l.fel, "arenden": [
            {"identifier": r.arende.identifier, "projekt": r.projekt,
             "fore_sparren": h.fore_sparren(r.arende), "skapare": r.arende.skapare,
             "placering": r.placering} for r in l.arenden],
             "register": sorted(l.register), "anrop": anrop}))
    elif operation in ("kor", "tom", "motprov"):
        regler = None if sys.argv[3] == "-" else sys.argv[3]
        regelutfall = h.las_regler(regler)
        l = p.hamta_plattformen(inspelare)
        if operation == "tom":
            if l.fel is not None:
                raise RuntimeError(l.fel)
            l = l._replace(arenden=())
        if operation == "motprov":
            p.harled_om = lambda *args: None
        d = p.doma(l, regelutfall, regler is not None)
        print(json.dumps(d._asdict()))
    elif operation == "hemplacera":
        r = h.korning(arenden_klient.anropa, sys.argv[3], True)
        print(json.dumps({"kod": r.kod, "rader": r.rader}))
    elif operation == "krasch":
        def krasch(*args):
            raise RuntimeError("provets krasch")
        p.hamta_plattformen = krasch
        sys.exit(p.huvud(sys.argv[3:]))
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
async function korHamta(bas: string, nyckel: string | undefined, sidstorlek = 100,
  avbrott: Avbrott = null): Promise<Lasutfall> {
  const u = await korDrivern(await nyttHem(), ['hamta', String(sidstorlek),
    avbrott?.[0] ?? '-', String(avbrott?.[1] ?? 0), '-'], bas, nyckel);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as Lasutfall;
}
async function vantaPaFil(fil: string, klar: () => Processutfall | undefined): Promise<void> {
  const slut = Date.now() + 10_000;
  while (Date.now() < slut) {
    try { await access(fil); return; } catch { /* Filen skrivs när drivrutinen nått slussen. */ }
    const u = klar();
    if (u) throw new Error(u.fel || 'drivrutinen avslutades före slussen');
    await vanta(20);
  }
  throw new Error('slussen öppnades aldrig');
}
async function korHamtaMedSluss(sluss: string[], vidPaus: (n: number) => Promise<void>): Promise<Lasutfall> {
  const hem = await nyttHem();
  let klar: Processutfall | undefined;
  let processfel: unknown;
  const korning = korDrivern(hem, ['hamta', '100', '-', '0', sluss.join(',')], v.bas, v.provet)
    .then((u) => { klar = u; return u; }, (fel: unknown) => { processfel = fel; klar = { kod: 3, ut: '', fel: String(fel) }; return klar; });
  try {
    for (let n = 1; n <= sluss.length; n += 1) {
      await vantaPaFil(path.join(hem, `paus-${n}`), () => klar);
      await vidPaus(n);
      await writeFile(path.join(hem, `fortsatt-${n}`), '');
    }
  } finally {
    // Frigör också vid ett fixturfel, så ingen barnprocess lämnas väntande vid städningen.
    for (let n = 1; n <= sluss.length; n += 1) await writeFile(path.join(hem, `fortsatt-${n}`), '');
    await korning;
  }
  if (processfel) throw processfel;
  const u = await korning;
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as Lasutfall;
}
async function stang(server: Server): Promise<void> {
  await new Promise<void>((klar, fel) => server.close((err) => err ? fel(err) : klar()));
}
async function raknare(kod: string) {
  let antal = 0;
  const server = createServer((req, res) => {
    antal += 1;
    req.resume();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: kod }));
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  return { server, bas: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    antal: () => antal, nollstall: () => { antal = 0; } };
}
async function stangdPort(): Promise<string> {
  const r = await raknare('oanvand');
  await stang(r.server);
  return r.bas;
}
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
    const provet = await nyNyckel({ typ: 'agent', namn: 'placeringsprovet' });
    const hermes = await nyNyckel({ typ: 'agent', namn: 'provets-hermes' });
    const rollpass = await nyNyckel({ typ: 'agent', namn: 'provets-rollpass' });
    const david = await nyNyckel({ typ: 'manniska', namn: 'provets-david' });
    const hemplaceringen = await nyNyckel({ typ: 'agent', namn: 'hemplaceringen' });
    const hem = await nyttHem();
    return { app, server, bas: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      provet, hermes, rollpass, david, hemplaceringen, hem, regler: await regelfil(hem, REGLER) };
  } catch (fel) { await stang(server); throw fel; }
}
async function nyttArende(nyckel: string, titel: string, etiketter: string[] = []) {
  const svar = await kor(v.app, nyckel, 'create_issue', { title: titel, team_key: 'LOC', labels: etiketter });
  expect(svar.status).toBe(200);
  return svar.body.result as { id: string; identifier: string };
}
async function sattSkapad(id: string, tidpunkt: string): Promise<void> {
  const client = await adminKlient();
  try { await client.query('UPDATE issues SET skapad = $2 WHERE id = $1', [id, tidpunkt]); }
  finally { await client.end(); }
}
async function placera(nyckel: string, identifier: string, projekt: string, skal?: string): Promise<void> {
  const svar = await kor(v.app, nyckel, 'update_issue', { identifier, projekt,
    ...(skal === undefined ? {} : { skal }) });
  expect(svar.status).toBe(200);
}
async function bytNamn(fran: string, till: string): Promise<void> {
  const svar = await kor(v.app, v.david, 'rename_project', { fran, till });
  expect(svar.status).toBe(200);
  expect(svar.body.result.andrad).toBe(true);
}
async function bytIOppenTransaktion(identifier: string, projekt: string, skal: string,
  medan: () => Promise<void>): Promise<void> {
  // Story 10.4 F9: transaktionens starttid måste ligga före bytet som den ersätter.
  await withTransaction(async (client) => {
    await medan();
    const action = getAction('update_issue');
    if (!action) throw new Error('update_issue saknas');
    const aktor: Aktor = { typ: 'agent', namn: 'hemplaceringen' };
    await action.handler({ client, tenantId: TENANT_ID, aktor,
      skrivHandelse: (h) => skrivHandelse(client, TENANT_ID, aktor, h),
    }, action.parse({ identifier, projekt, skal }));
  });
}

describe('FR-19/Story 10.4 AK 1–2: läsningen av plattformen', () => {
  let H: Awaited<ReturnType<typeof nyttArende>>;
  let P: Awaited<ReturnType<typeof nyttArende>>;
  let grund: Rad[];
  beforeAll(async () => { v = await starta(); });
  afterAll(async () => { if (v) await stang(v.server); });

  it('F1 (AK 1): varje läsfel säger steget och felet, inga delresultat förs vidare', async () => {
    H = await nyttArende(v.hermes, 'Hemlöst före spärren');
    await sattSkapad(H.id, FORE);
    P = await nyttArende(v.hermes, '[Kundbolaget] Placerat');
    await placera(v.david, P.identifier, 'Kundbolaget', 'provets placering');
    const d = await raknare('internal_error');
    try {
      const former: [string, string | undefined, number, Avbrott, string][] = [
        [await stangdPort(), v.provet, 100, null, 'list_issues (URLError)'],
        [d.bas, v.provet, 100, null, 'list_issues (500 internal_error)'],
        [v.bas, 'provets-ogiltiga-nyckel', 100, null, 'list_issues (401 unauthenticated)'],
        [v.bas, undefined, 100, null, 'list_issues (401 ingen_nyckel)'],
        [v.bas + '/fel', v.provet, 100, null, 'list_issues (404 not_found)'],
        [v.bas, v.provet, 100, ['get_issue', 1], `get_issue ${P.identifier} (503 provets_avbrott)`],
        [v.bas, v.provet, 100, ['list_project_customers', 1], 'list_project_customers (503 provets_avbrott)'],
        [v.bas, v.provet, 1, ['list_issues', 2], 'list_issues (503 provets_avbrott)'],
        [v.bas, v.provet, 100, ['get_issue', 2], `get_issue ${P.identifier} (503 provets_avbrott)`],
        [v.bas, v.provet, 100, ['list_project_customers', 2], 'list_project_customers (503 provets_avbrott)'],
      ];
      for (const [bas, nyckel, storlek, avbrott, fel] of former) {
        const u = await korHamta(bas, nyckel, storlek, avbrott);
        expect({ fel: u.fel, arenden: u.arenden, register: u.register }).toEqual({ fel, arenden: [], register: [] });
        if (avbrott?.[0] === 'list_issues') expect(u.anrop.map(([a]) => a)).toEqual([
          'list_issues', 'list_project_customers', 'get_issue', 'get_issue', 'list_issues',
        ]);
        if (avbrott?.[0] === 'list_project_customers' && avbrott[1] === 2) {
          expect(u.anrop.at(-1)?.[0]).toBe('list_project_customers');
        }
      }
      expect(d.antal()).toBe(1);
    } finally { await stang(d.server); }
    grund = [
      { identifier: H.identifier, projekt: null, fore_sparren: true, skapare: null, placering: null },
      { identifier: P.identifier, projekt: 'Kundbolaget', fore_sparren: false,
        skapare: [['agent', 'provets-hermes']], placering: ['Kundbolaget', 'provets placering'] },
    ];
    const kontroll = await korHamta(v.bas, v.provet);
    expect(kontroll.fel).toBeNull();
    expect(kontroll.register).toEqual(PROJEKT);
    expect(kontroll.arenden).toEqual(grund);
  });

  it('F2 (AK 2): sidor, senaste placeringen och bara de tre läsande rutterna', async () => {
    const R = await nyttArende(v.hermes, 'Två byten');
    await placera(v.david, R.identifier, 'Kundbolaget', 'provets första');
    await placera(v.david, R.identifier, 'Privat', 'provets andra');
    const S = await nyttArende(v.hermes, 'Utan skäl');
    await placera(v.david, S.identifier, 'Locollabs');
    grund = [...grund,
      { identifier: R.identifier, projekt: 'Privat', fore_sparren: false,
        skapare: [['agent', 'provets-hermes']], placering: ['Privat', 'provets andra'] },
      { identifier: S.identifier, projekt: 'Locollabs', fore_sparren: false,
        skapare: [['agent', 'provets-hermes']], placering: ['Locollabs', null] },
    ];
    for (const storlek of [2, 100]) {
      const u = await korHamta(v.bas, v.provet, storlek);
      expect(u.fel).toBeNull();
      expect(u.register).toEqual(PROJEKT);
      expect(u.arenden).toEqual(grund);
      expect(u.anrop.map(([a]) => a)).toEqual(storlek === 2 ? [
        'list_issues', 'list_project_customers', 'get_issue', 'get_issue', 'get_issue', 'get_issue',
        'list_issues', 'get_issue', 'get_issue', 'list_project_customers',
      ] : ['list_issues', 'list_project_customers', 'get_issue', 'get_issue', 'get_issue', 'get_issue',
        'get_issue', 'get_issue', 'list_project_customers']);
      expect(u.anrop[0]).toEqual(['list_issues', { limit: storlek }]);
      if (storlek === 2) {
        const sida = u.anrop.filter(([a]) => a === 'list_issues')[1]![1];
        expect(sida).toEqual({ limit: 2, cursor: expect.any(String) });
        expect(sida.cursor).not.toBe('');
      }
      expect(u.anrop.filter(([a]) => a === 'list_project_customers').map(([, d]) => d)).toEqual([{}, {}]);
      expect(u.anrop.filter(([a]) => a === 'get_issue').map(([, d]) => d.identifier))
        .toEqual([S, S, R, R, P, P].map((a) => a.identifier));
    }
  });

  it('F8 (AK 1, 2): samtidiga ändringar ger en stabil version eller ett läsfel', async () => {
    const Q = await nyttArende(v.hermes, 'Samtidig läsning');
    await placera(v.david, Q.identifier, 'Kundbolaget', 'provets början');
    const qRad = (projekt: string, skal: string): Rad => ({ identifier: Q.identifier, projekt,
      fore_sparren: false, skapare: [['agent', 'provets-hermes']], placering: [projekt, skal] });
    const qAnrop = (u: Lasutfall) => u.anrop.filter(([a, d]) => a === 'get_issue' && d.identifier === Q.identifier);
    const hel = (u: Lasutfall, projekt: string, skal: string) => {
      expect(u.fel).toBeNull();
      expect(u.register).toEqual(PROJEKT);
      expect(u.arenden).toEqual([...grund, qRad(projekt, skal)]);
    };
    const a = await korHamtaMedSluss(['get_issue:1'], async () => {
      await placera(v.david, Q.identifier, 'Privat', 'provets samtidiga 1');
    });
    hel(a, 'Privat', 'provets samtidiga 1');
    expect(qAnrop(a)).toHaveLength(2);
    const b = await korHamtaMedSluss(['get_issue:2'], async () => {
      await placera(v.david, Q.identifier, 'Locollabs', 'provets samtidiga 2');
    });
    hel(b, 'Locollabs', 'provets samtidiga 2');
    expect(qAnrop(b)).toHaveLength(3);
    expect(b.anrop.filter(([a]) => a === 'get_issue').slice(0, 3)).toEqual(qAnrop(b));
    const c = await korHamtaMedSluss(['get_issue:2', 'get_issue:3'], async (n) => {
      await placera(v.david, Q.identifier, n === 1 ? 'Privat' : 'Locollabs', `provets samtidiga ${n + 2}`);
    });
    expect({ fel: c.fel, arenden: c.arenden, register: c.register }).toEqual({
      fel: `get_issue ${Q.identifier} (AndradesUnderLasningen)`, arenden: [], register: [],
    });
    expect(c.anrop.map(([a]) => a)).toEqual([
      'list_issues', 'list_project_customers', 'get_issue', 'get_issue', 'get_issue',
    ]);
    expect(qAnrop(c)).toHaveLength(3);
    const d = await korHamta(v.bas, v.provet);
    hel(d, 'Locollabs', 'provets samtidiga 4');
    expect(qAnrop(d)).toHaveLength(2);
    const e = await korHamtaMedSluss(['list_project_customers:2'], async () => { await seedaProjekt('Samtidigt'); });
    expect({ fel: e.fel, arenden: e.arenden, register: e.register }).toEqual({
      fel: 'list_project_customers (AndradesUnderLasningen)', arenden: [], register: [],
    });
    try {
      const f = await korHamtaMedSluss(['get_issue:1'], async () => {
        await bytNamn('Locollabs', 'Locollabs under namnbyte');
      });
      expect({ fel: f.fel, arenden: f.arenden, register: f.register }).toEqual({
        fel: `get_issue ${Q.identifier} (AndradesUnderLasningen)`, arenden: [], register: [],
      });
      expect(f.anrop.map(([a]) => a)).toEqual(['list_issues', 'list_project_customers', 'get_issue', 'get_issue']);
    } finally { await bytNamn('Locollabs under namnbyte', 'Locollabs'); }
    const aterstalld = await korHamta(v.bas, v.provet);
    expect(aterstalld.fel).toBeNull();
    expect(aterstalld.arenden).toEqual([...grund, qRad('Locollabs', 'provets samtidiga 4')]);
  });

  it('F9 (AK 2): största heltals-id väljer placeringen när tidsordningen är omvänd', async () => {
    const W = await nyttArende(v.hermes, 'Byte under öppen transaktion');
    await placera(v.david, W.identifier, 'Kundbolaget', 'provets början');
    const SKAL9 = 'provets byte i öppen transaktion';
    await bytIOppenTransaktion(W.identifier, 'Locollabs', SKAL9, async () => {
      await placera(v.david, W.identifier, 'Privat', 'provets byte under transaktionen');
    });
    const svar = await kor(v.app, v.hermes, 'get_issue', { identifier: W.identifier });
    expect(svar.status).toBe(200);
    const handelser = (svar.body.result.handelser as { id: string; verb: string; payload: { till?: string } }[])
      .filter((h) => h.verb === 'andrade_projekt');
    const locollabs = handelser.find((h) => h.payload.till === 'Locollabs')!;
    expect(handelser.at(-1)?.payload.till).toBe('Privat');
    expect(handelser.indexOf(locollabs)).toBeLessThan(handelser.length - 1);
    expect(Number(locollabs.id)).toBeGreaterThan(Number(handelser.at(-1)!.id));
    expect(svar.body.result.arende.projekt).toBe('Locollabs');
    const a = await korHamta(v.bas, v.provet);
    expect(a.fel).toBeNull();
    expect(a.arenden.find((r) => r.identifier === W.identifier)).toEqual({ identifier: W.identifier,
      projekt: 'Locollabs', fore_sparren: false, skapare: [['agent', 'provets-hermes']], placering: ['Locollabs', SKAL9] });
    await placera(v.david, W.identifier, 'Privat', 'provets byte efter transaktionen');
    const kontrollSvar = await kor(v.app, v.hermes, 'get_issue', { identifier: W.identifier });
    const byten = (kontrollSvar.body.result.handelser as typeof handelser).filter((h) => h.verb === 'andrade_projekt');
    expect(byten.at(-1)?.payload.till).toBe('Privat');
    expect(Number(byten.at(-1)!.id)).toBe(Math.max(...byten.map((h) => Number(h.id))));
    const b = await korHamta(v.bas, v.provet);
    expect(b.fel).toBeNull();
    expect(b.arenden.find((r) => r.identifier === W.identifier)).toEqual({ identifier: W.identifier,
      projekt: 'Privat', fore_sparren: false, skapare: [['agent', 'provets-hermes']],
      placering: ['Privat', 'provets byte efter transaktionen'] });
  });
});

const GRANS = tid('2026-09-27', '22.00.00');
const GRON1 = 'GRON: varje placering ar harledd om och sparren haller';
const ROD1 = 'ROD: placeringarna haller inte';
const MOTPROVRAD = 'motprov: den pahittade placeringen fangades';
const efterRad = (id: string) => 'LARM: hemlost efter sparren (sparr 0): ' + id;
const ejRad = (a: { identifier: string }, projekt: string, s: string, kod: string, text: string) =>
  `LARM: ej harledd ${a.identifier}: projekt ${projekt}, skal "${s}", omharledning ${kod}: ${text}`;
function skal(kalla: string, varde: string, projekt: string, niva: number, beslut?: number): string {
  return `hemplacering: ${kalla} "${varde}" ger ${projekt} (niva ${niva})`
    + (beslut === undefined ? '' : `; fore sparren, beslut #${beslut}`);
}
interface Dom { utfall: string; kod: number; rader: string[] }
interface Lage { arenden: number; efter: number; fore: number }
interface Handelse { id: string; verb: string; aktor_typ: string; aktor_namn: string; payload: Record<string, unknown> }
async function korKor(regel: string | null, bas = v.bas, nyckel = v.provet,
  avbrott: Avbrott = null): Promise<Dom> {
  const u = await korDrivern(await nyttHem(), ['kor', regel ?? '-', avbrott?.[0] ?? '-',
    String(avbrott?.[1] ?? 0)], bas, nyckel);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as Dom;
}
async function korTom(regel: string): Promise<Dom> {
  const u = await korDrivern(await nyttHem(), ['tom', regel], v.bas, v.provet);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as Dom;
}
async function korMotprov(regel: string): Promise<Dom> {
  const u = await korDrivern(await nyttHem(), ['motprov', regel], v.bas, v.provet);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as Dom;
}
async function korHemplacera(regel: string): Promise<{ kod: number; rader: string[] }> {
  const u = await korDrivern(await nyttHem(), ['hemplacera', regel], v.bas, v.hemplaceringen);
  if (u.kod !== 0) throw new Error(u.fel);
  return JSON.parse(u.ut) as { kod: number; rader: string[] };
}
async function hamtat(identifier: string) {
  const svar = await kor(v.app, v.hermes, 'get_issue', { identifier });
  expect(svar.status).toBe(200);
  return svar.body.result as { arende: { projekt: string | null }; handelser: Handelse[] };
}
async function lage(): Promise<Lage> {
  const svar = await kor(v.app, v.hermes, 'list_issues', { limit: 100 });
  expect(svar.status).toBe(200);
  expect(svar.body.result.pageInfo.har_nasta).toBe(false);
  const arenden = svar.body.result.arenden as { projekt: string | null; skapad: string }[];
  const hemlosa = arenden.filter((a) => a.projekt === null);
  return { arenden: arenden.length,
    efter: hemlosa.filter((a) => Date.parse(a.skapad) >= Date.parse(GRANS)).length,
    fore: hemlosa.filter((a) => Date.parse(a.skapad) < Date.parse(GRANS)).length };
}
function sammanfattning(l: Lage, hemplacerade: number, harledda: number): string {
  return `placeringar: arenden=${l.arenden} hemplacerade=${hemplacerade} harledda=${harledda}`
    + ` ej_harledda=${hemplacerade - harledda} hemlosa_efter_sparren=${l.efter} hemlosa_fore_sparren=${l.fore}`;
}

describe('FR-19/Story 10.4 AK 1–2: domen', () => {
  beforeAll(async () => { v = await starta(); });
  afterAll(async () => { if (v) await stang(v.server); });

  it('F3 (AK 2): spärr 0 för efter gränsen, före-talet dömer aldrig och inget skrivs', async () => {
    const B1 = await nyttArende(v.hermes, 'Före spärren utan enhet');
    const B2 = await nyttArende(v.hermes, 'Före spärren, andra');
    for (const a of [B1, B2]) await sattSkapad(a.id, FORE);
    const E1 = await nyttArende(v.hermes, 'Efter spärren utan enhet');
    const E2 = await nyttArende(v.hermes, 'Efter spärren, andra');
    const G1 = await nyttArende(v.hermes, 'Gränsen, efter');
    await sattSkapad(G1.id, GRANS);
    const G2 = await nyttArende(v.hermes, 'Gränsen, före');
    await sattSkapad(G2.id, tid('2026-09-27', '21.59.59'));
    const e = await raknaRader('events');
    const l = await lage();
    expect(l.efter).toBe(3);
    expect(await korKor(v.regler)).toEqual({ utfall: 'ROD', kod: 1, rader: [
      ROD1, sammanfattning(l, 0, 0), MOTPROVRAD, ...[E1, E2, G1].map((a) => efterRad(a.identifier)),
    ] });
    expect(await raknaRader('events')).toBe(e);
    for (const a of [E1, E2, G1]) await placera(v.david, a.identifier, 'Kundbolaget', 'provets ordning');
    const l2 = await lage();
    expect(l2.efter).toBe(0);
    expect(l2.fore).toBe(l.fore);
    expect(await korKor(v.regler)).toEqual({ utfall: 'GRON', kod: 0,
      rader: [GRON1, sammanfattning(l2, 0, 0), MOTPROVRAD] });
    for (const a of [B1, B2, G2]) expect((await hamtat(a.identifier)).arende.projekt).toBeNull();
  });

  it('F4 (AK 2): riktiga hemplaceringar härleds om, påhittade fångas och motprovet prövar domen', async () => {
    const T = await nyttArende(v.hermes, '[Kundbolaget] Offert');
    const A = await nyttArende(v.hermes, 'Admin-arbete', ['Admin']);
    await sattSkapad(A.id, FORE);
    const sT = skal('titeltagg', 'Kundbolaget', 'Kundbolaget', 1);
    const sA = skal('etikett', 'Admin', 'Locollabs', 3, 55);
    expect((await korHemplacera(v.regler)).kod).toBe(0);
    for (const [a, projekt, s] of [[T, 'Kundbolaget', sT], [A, 'Locollabs', sA]] as const) {
      const u = await hamtat(a.identifier);
      expect(u.arende.projekt).toBe(projekt);
      expect(u.handelser.filter((h) => h.verb === 'andrade_projekt')).toEqual([
        expect.objectContaining({ aktor_typ: 'agent', aktor_namn: 'hemplaceringen',
          payload: expect.objectContaining({ till: projekt, skal: s }) }),
      ]);
    }
    expect(await korKor(v.regler)).toEqual({ utfall: 'GRON', kod: 0,
      rader: [GRON1, sammanfattning(await lage(), 2, 2), MOTPROVRAD] });
    const X = await nyttArende(v.hermes, 'Utan bevis');
    const Y = await nyttArende(v.hermes, '[Privat] Tandläkare');
    const Rp = await nyttArende(v.rollpass, 'Admin från rollpass', ['Admin']);
    await sattSkapad(Rp.id, FORE);
    const sX = sT;
    const sY = skal('titeltagg', 'Privat', 'Privat', 1);
    const sR = sA;
    await placera(v.hemplaceringen, X.identifier, 'Kundbolaget', sX);
    await placera(v.hemplaceringen, Y.identifier, 'Kundbolaget', sY);
    await placera(v.hemplaceringen, Rp.identifier, 'Locollabs', sR);
    const l = await lage();
    const xRad = ejRad(X, 'Kundbolaget', sX, 'U1', 'inget bevis');
    const yRad = ejRad(Y, 'Kundbolaget', sY, 'P1', sY);
    expect(await korKor(v.regler)).toEqual({ utfall: 'ROD', kod: 1, rader: [
      ROD1, sammanfattning(l, 5, 2), MOTPROVRAD, xRad, yRad,
      ejRad(Rp, 'Locollabs', sR, 'U2', 'skapat av rollpass agent/provets-rollpass, beslut #54'),
    ] });
    const U3TEXT = 'skaparen gar inte att avgora: ingen regelfil';
    expect(await korKor(null)).toEqual({ utfall: 'ROD', kod: 1, rader: [
      ROD1, sammanfattning(l, 5, 1), MOTPROVRAD, ejRad(A, 'Locollabs', sA, 'U3', U3TEXT),
      xRad, yRad, ejRad(Rp, 'Locollabs', sR, 'U3', U3TEXT),
    ] });
    // Varje rättelse måste byta projekt för att skriva en ny andrade_projekt.
    await placera(v.david, X.identifier, 'Privat', 'provets rättelse');
    await placera(v.david, Y.identifier, 'Privat', 'provets rättelse');
    await placera(v.david, Rp.identifier, 'Kundbolaget', 'provets rättelse');
    expect(await korKor(v.regler)).toEqual({ utfall: 'GRON', kod: 0,
      rader: [GRON1, sammanfattning(await lage(), 2, 2), MOTPROVRAD] });
    expect(await korMotprov(v.regler)).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: ['KUNDE_INTE: motprovet slapptes igenom, omharledningen fangar inte en pahittad placering'] });
  });

  it('F5 (AK 1): läsfel, oläsbar regelfil och tom plattform dömer före spärren', async () => {
    const E3 = await nyttArende(v.hermes, 'Efter spärren, läsfel');
    const d = await raknare('internal_error');
    try {
      for (const [bas, avbrott, fel] of [
        [await stangdPort(), null, 'list_issues (URLError)'],
        [d.bas, null, 'list_issues (500 internal_error)'],
        [v.bas, ['list_project_customers', 1], 'list_project_customers (503 provets_avbrott)'],
      ] as [string, Avbrott, string][]) {
        expect(await korKor(v.regler, bas, v.provet, avbrott)).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
          rader: ['KUNDE_INTE: arendeplattformen gar inte att lasa: ' + fel] });
      }
      expect(d.antal()).toBe(1);
    } finally { await stang(d.server); }
    expect(await korKor(path.join(v.hem, 'saknas.json'))).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: ['KUNDE_INTE: regelfilen gar inte att lasa (FileNotFoundError)'] });
    const trasig = path.join(v.hem, 'trasig.json');
    await writeFile(trasig, '{');
    expect(await korKor(trasig)).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: ['KUNDE_INTE: regelfilen gar inte att lasa (JSONDecodeError)'] });
    expect(await korTom(v.regler)).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: ['KUNDE_INTE: inga arenden lastes'] });
    const kontroll = await korKor(v.regler);
    expect(kontroll.kod).toBe(1);
    expect(kontroll.rader[0]).toBe(ROD1);
    expect(kontroll.rader.filter((r) => r.startsWith('LARM: hemlost'))).toEqual([efterRad(E3.identifier)]);
    await placera(v.david, E3.identifier, 'Kundbolaget', 'provets ordning');
    const placerad = await korKor(v.regler);
    expect(placerad.kod).toBe(0);
    expect(placerad.rader[0]).toBe(GRON1);
  });
});

const MODULEN = path.join(ADAPTERN, 'placeringslasning.py');
const ANROPSRAD = 'KUNDE_INTE: anropet gar inte att tolka: [--regler <fil>]';
async function korSkriptet(argument: string[], bas: string, nyckel: string | undefined) {
  let resultat: Processutfall;
  try {
    // Skriptets katalog behövs för importerna; -s och tillåtelselistan isolerar användarmiljön.
    const { stdout, stderr } = await korProcess('python3', ['-B', '-s', MODULEN, ...argument], {
      cwd: ROT, env: barnmiljo(v.hem, bas, nyckel), timeout: 20_000,
    });
    resultat = { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (!arProcessfel(fel)) throw fel;
    resultat = { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
  }
  expect(resultat.fel).toBe('');
  return { kod: resultat.kod, rader: resultat.ut.split(/\r?\n/).filter((r) => r.length > 0) };
}

describe('FR-19/Story 10.4 AK 1–2: placeringsprovet som skript', () => {
  beforeAll(async () => { v = await starta(); });
  afterAll(async () => { if (v) await stang(v.server); });

  it('F6 (AK 1): oläsbar plattform ger kod 2 och vad som inte kunde läsas, aldrig GRON', async () => {
    const d = await raknare('internal_error');
    try {
      for (const [bas, nyckel, fel] of [
        [await stangdPort(), v.provet, 'list_issues (URLError)'],
        [d.bas, v.provet, 'list_issues (500 internal_error)'],
        [v.bas, undefined, 'list_issues (401 ingen_nyckel)'],
      ] as const) {
        const u = await korSkriptet([], bas, nyckel);
        expect(u).toEqual({ kod: 2, rader: ['KUNDE_INTE: arendeplattformen gar inte att lasa: ' + fel] });
        expect(u.rader.some((r) => r.startsWith('GRON'))).toBe(false);
      }
      expect(d.antal()).toBe(1);
    } finally { await stang(d.server); }
    const kontroll = await korSkriptet(['--regler', v.regler], v.bas, v.provet);
    expect(kontroll.kod).toBe(0);
    expect(kontroll.rader[0]).toBe(GRON1);
  });

  it('F7 (AK 1, 2): tre exitkoder, ogiltigt anrop utan nätanrop och krasch ger KUNDE_INTE', async () => {
    const g = await korSkriptet(['--regler', v.regler], v.bas, v.provet);
    const E4 = await nyttArende(v.hermes, 'Efter spärren, skriptet');
    const r = await korSkriptet(['--regler', v.regler], v.bas, v.provet);
    const k = await korSkriptet([], await stangdPort(), v.provet);
    expect([g.kod, r.kod, k.kod]).toEqual([0, 1, 2]);
    expect(new Set([g.kod, r.kod, k.kod]).size).toBe(3);
    expect(g.rader[0]).toBe(GRON1);
    expect(r.rader[0]).toBe(ROD1);
    expect(r.rader).toContain(efterRad(E4.identifier));
    expect(k.rader[0]).toMatch(/^KUNDE_INTE: /);
    await placera(v.david, E4.identifier, 'Kundbolaget', 'provets ordning');
    const rakna = await raknare('raknaren');
    try {
      for (const argument of [['--okand'], ['--regler'], ['--regler', ''], ['--regler', '--okand'],
        ['--regler', v.regler, 'extra'], ['extra']]) {
        rakna.nollstall();
        expect(await korSkriptet(argument, rakna.bas, v.provet)).toEqual({ kod: 2, rader: [ANROPSRAD] });
        expect(rakna.antal()).toBe(0);
      }
      expect(await korSkriptet([], rakna.bas, v.provet)).toEqual({ kod: 2,
        rader: ['KUNDE_INTE: arendeplattformen gar inte att lasa: list_issues (500 raknaren)'] });
      expect(rakna.antal()).toBe(1);
    } finally { await stang(rakna.server); }
    expect(await korSkriptet(['--regler', path.join(v.hem, 'saknas.json')], v.bas, v.provet)).toEqual({ kod: 2,
      rader: ['KUNDE_INTE: regelfilen gar inte att lasa (FileNotFoundError)'] });
    const krasch = await korDrivern(v.hem, ['krasch'], v.bas, v.provet);
    expect(krasch.kod).toBe(2);
    expect(krasch.fel).toBe('');
    expect(krasch.ut.trim().split(/\r?\n/)).toEqual(['KUNDE_INTE: placeringsprovet stannade: RuntimeError']);
  });
});
