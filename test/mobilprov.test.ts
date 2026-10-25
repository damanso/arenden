// FR-15, B-16 och B-17 Tre utfall, Story 10.9: mobilprovet mäter ytan i telefonens och iPadens bredd.
// adapter/arende_mobilprov.py öppnar ytan i en huvudlös webbläsare vid 375 och 744 px, kräver att dokumentet
// ryms i fönstret, att menyn öppnas och att formulärens knappar ligger inom fönstret, och skickar inloggningen,
// en kommentar och en titelrättning genom ytans egna formulär. Ett motprov med ett 800 px brett element måste
// fällas i varje bredd, och ett underlag som inte går att läsa ger KUNDE_INTE, aldrig GRON.
// Provet kör modulen med webbläsarattrappen test/fixtures/mobilprov/webblasare.py i stället för Chromium: samma
// protokoll över samma rör, riktiga hämtningar och formulär, men ingen layout. Den riktiga layouten mäts i drift.
// Egna hem och TMPDIR under tmpdir(); Chromium, ~/.hermes och driftens app nås aldrig. Införandet sker utanför bygget.
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { runInNewContext, Script } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { glomAllaSessioner } from '../src/http/vy/session.js';
import { kor, nyNyckel, seedaTeam, TENANT_ID } from './helpers.js';

// Barnprocess, hem och drivrutin: test/linearvakt.test.ts; servrar och stängd port: test/placeringslasning.test.ts.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const MODULEN = path.join(ADAPTERN, 'arende_mobilprov.py');
const ATTRAPPEN = path.join(ROT, 'test', 'fixtures', 'mobilprov', 'webblasare.py');
const VARD = '127.0.0.1';
const DRIFTPORT = 3002;
// Ingen server lyssnar här och ingen behövs: konfigurationen prövar bara adressens form (Uppgift 1).
const KONFIGPORT = 43109;
const KONFIGBAS = `http://${VARD}:${KONFIGPORT}`;
const PROFILPREFIX = 'arende_mobilprov-';
const STARTFLAGGOR = ['--headless=new', '--remote-debugging-pipe', '--no-first-run', '--no-default-browser-check',
  '--disable-gpu', '--disable-extensions', '--user-data-dir=%s', 'about:blank'];
const KANALMETODER = ['Target.createTarget', 'Target.attachToTarget', 'Page.enable', 'Network.enable',
  'Emulation.setDeviceMetricsOverride', 'Browser.close'];
const F1_NYCKEL = 'f1-provets-nyckel';
const UTFALL: Record<string, number> = { GRON: 0, ROD: 1, KUNDE_INTE: 2 };
const GRON_RAD = 'GRON: ytan haller sig inom fonstret i 375 och 744 px, och skrivningarna gav kvitto och handelserad';
const ROD_RAD = 'ROD: ytan gar utanfor fonstret eller ett formular fungerar inte i telefonens eller iPadens bredd';
const KUNDE_INTE_RAD = 'KUNDE_INTE: mobilprovet gar inte att genomfora';
const FORSTA_RAD: Record<string, string> = { GRON: GRON_RAD, ROD: ROD_RAD, KUNDE_INTE: KUNDE_INTE_RAD };
const SEKVENS = ['motprov', 'laslage', 'inloggningssidan', 'inloggning', 'oversikt', 'mitt', 'arendesidan',
  'kommentar', 'titel'];
const SAKNAT_ARENDE = 'LOC-9999';
const ANROPSRAD = 'KUNDE_INTE: anropet gar inte att tolka: provet tar inga argument';
// AK 3: modulen och attrappen importerar bara de här modulerna ur standardbiblioteket.
const STDLIB_TILLATNA = ['base64', 'fcntl', 'html', 'html.parser', 'http', 'http.cookiejar', 'json', 'os', 're',
  'select', 'shutil', 'signal', 'sys', 'tempfile', 'time', 'typing', 'urllib', 'urllib.error', 'urllib.parse',
  'urllib.request'];

interface Underlag { hem: string; bin: string; tmp: string; logg: string; webblasare: string; nyckelfil: string }
interface Processutfall { kod: number; ut: string; fel: string }
interface Konfigutfall {
  bas: string | null; arende: string | null; webblasare: string | null; nyckel_ratt: boolean; fel: string | null;
}
interface Loggrad {
  argv?: string[]; pid?: number; method?: string; params?: Record<string, unknown>; skript?: string | null;
  svar?: string; typsnitt?: string; status?: number;
}
interface Kanalutfall {
  fel: string | null; text: string | null; argv: string[] | undefined; metoder: string[];
  parametrar: Record<string, unknown>; profil_kvar: boolean; lever: boolean;
}
interface Skrivutfall {
  skickat: boolean; status: number | null; plats: string | null; kvitto: boolean; formular: (string | null)[];
  ny_handelse: string | null;
}
interface Handelse { verb: string; aktor_typ: string; aktor_namn: string }
interface Dom { utfall: string; kod: number; rader: string[] }
interface Breddutfall { bredd: number; fynd: string[][]; fel: string[][]; rader: string[] }
interface Korval {
  bara375?: boolean; handelser_fel?: boolean; handelser_fel_vid?: number; motprov?: string;
  stangd?: { steg: string; bas: string };
}
interface Sidlage { ok: boolean; status: number | null; fel: string | null }
interface Matning { dokument: number; fonster: number; kvitto: boolean; formular: (string | null)[]; typsnitt: number }
interface Sidutfall {
  sida: Sidlage; matning: Matning; matfel: string | null; meny: { oppen: boolean; vanster: number; hoger: number };
  knappar: Record<string, [number, number] | null>;
}

// Fixtursidorna har ytans form för menyn och formulären (src/http/vy/mall.ts och skrivning.ts).
const SIDHUVUD = '<!doctype html><html lang=sv><head><meta charset=utf-8>' +
  "<meta name=viewport content='width=device-width,initial-scale=1'><title>Fixtur</title>";
function fixtursida(stil: string, kropp: string): string {
  return `${SIDHUVUD}${stil}</head><body>${kropp}</body></html>`;
}
const SMAL_KROPP = '<header><nav class=nav><details class=navmenu><summary><span>Meny</span></summary>' +
  '<div class=navmenu__panel><a href="/smal">Smal</a></div></details></nav></header><main>' +
  '<form class=skrivform method=post action="/f/ett"><input type=text name=a>' +
  '<div class=skrivrad><button type=submit>Ett</button></div></form>' +
  '<details class=rattelse><summary>Två</summary><form class=skrivform method=post action="/f/tva">' +
  '<input type=text name=b><div class=skrivrad><button type=submit>Två</button></div></form></details></main>';
const SMAL_SIDA = fixtursida('', SMAL_KROPP);
const BRED_SIDA = fixtursida('', '<main><div style="width:800px;height:10px"></div></main>');
function typsnittsregel(familj: string, kalla: string): string {
  return `@font-face{font-family:"${familj}";font-display:swap;src:url("${kalla}") format("woff2")}`;
}
const TYPSNITT_ETT = fixtursida(`<style>${typsnittsregel('Ett', '/t/finns.woff2')}</style>`, SMAL_KROPP);
// Kontrollen för TYPSNITT_TVA är TYPSNITT_ETT, skild bara i det andra typsnittet.
const TYPSNITT_TVA = fixtursida(
  `<style>${typsnittsregel('Ett', '/t/finns.woff2')}${typsnittsregel('Tva', '/t/saknas.woff2')}</style>`, SMAL_KROPP);

const servrar: Server[] = [];
async function lyssna(server: Server): Promise<string> {
  server.listen(0, VARD);
  await once(server, 'listening');
  return `http://${VARD}:${(server.address() as AddressInfo).port}`;
}
async function stang(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((klar, fel) => server.close((err) => err ? fel(err) : klar()));
}
/** Med bredYta ger varje sökväg under /vy BRED_SIDA med 200 (F5 (b), F6 (b)). */
async function nyFixturserver(bredYta = false): Promise<string> {
  const sidor = new Map([['/smal', SMAL_SIDA], ['/bred', BRED_SIDA], ['/typsnitt/ett', TYPSNITT_ETT],
    ['/typsnitt/tva', TYPSNITT_TVA]]);
  const server = createServer((req, res) => {
    req.resume();
    const sokvag = (req.url ?? '/').split('?')[0]!;
    const sida = bredYta && (sokvag === '/vy' || sokvag.startsWith('/vy/')) ? BRED_SIDA : sidor.get(sokvag);
    if (sida !== undefined) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(sida);
    } else if (sokvag === '/t/finns.woff2') {
      res.writeHead(200, { 'Content-Type': 'font/woff2' });
      res.end(Buffer.from('wOF2-fixtur'));
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('saknas');
    }
  });
  servrar.push(server);
  return lyssna(server);
}
/** En port som provet just lyssnat på och stängt, som i test/placeringslasning.test.ts. */
async function stangdPort(): Promise<string> {
  const server = createServer((_req, res) => res.end());
  const bas = await lyssna(server);
  await stang(server);
  return bas;
}
afterAll(async () => {
  await Promise.all(servrar.map(stang));
});

// Testservern: appen ur createApp() mot testdatabasen, på en loopbackport som provet självt öppnar.
const MANNISKA = 'm109 människa';
let hermes: string;
let provnyckel: string;
let provarende: string;
let A: string;
let TESTBAS: string;
beforeAll(async () => {
  const app = createApp();
  glomAllaSessioner();
  await seedaTeam();
  hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  provnyckel = await nyNyckel({ typ: 'manniska', namn: MANNISKA });
  const skapat = await kor(app, hermes, 'create_issue', { title: 'M109 mobilprovet', team_key: 'LOC' });
  expect(skapat.status, JSON.stringify(skapat.body)).toBe(200);
  provarende = skapat.body.result.identifier as string;
  A = `/vy/arende/${provarende}`;
  const server = app.listen(0, VARD);
  servrar.push(server);
  TESTBAS = await new Promise<string>((klar) => server.once('listening',
    () => klar(`http://${VARD}:${(server.address() as AddressInfo).port}`)));
});

/** Ärendets händelserader i ordning, ur tabellen events, som sistaHandelse i test/mobil-formular.test.ts. */
async function handelserFor(identifier: string): Promise<Handelse[]> {
  const { rows } = await pool.query<Handelse>(
    `SELECT e.verb, e.aktor_typ, e.aktor_namn FROM events e
       JOIN issues i ON i.id = e.issue_id
       JOIN teams t ON t.id = i.team_id
      WHERE e.tenant_id = $1 AND t.key || '-' || i.sequence_number = $2
      ORDER BY e.id`,
    [TENANT_ID, identifier],
  );
  return rows;
}

function barnmiljo(u: Underlag, lage: string, plats: string): NodeJS.ProcessEnv {
  // Hela miljön är en tillåtelselista: test/env.ts och riktiga HOME får inte läcka in.
  // Hemmets bin står först, och TMPDIR är hemmets egen, så att profilerna kan räknas efteråt.
  return { PATH: `${u.bin}${path.delimiter}${process.env.PATH}`, HOME: u.hem, TMPDIR: u.tmp,
    ATTRAPP_LAGE: lage, ATTRAPP_PLATS: plats, ATTRAPP_LOGG: u.logg };
}
async function skriv(fil: string, innehall: string | Buffer, rattigheter?: number): Promise<void> {
  await writeFile(fil, innehall);
  if (rattigheter !== undefined) await chmod(fil, rattigheter);
}
const hemkataloger: string[] = [];
async function nyttHem(): Promise<Underlag> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-mobilprov-'));
  hemkataloger.push(hem);
  const u = { hem, bin: path.join(hem, 'bin'), tmp: path.join(hem, 'tmp'), logg: path.join(hem, 'attrapp.logg'),
    webblasare: path.join(hem, 'bin', 'webblasare'), nyckelfil: path.join(hem, 'provnyckel') };
  await mkdir(u.bin);
  await mkdir(u.tmp);
  await mkdir(path.join(hem, '.hermes'));
  await copyFile(ATTRAPPEN, u.webblasare);
  await chmod(u.webblasare, 0o755);
  return u;
}
afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

function konfigfil(u: Underlag): string {
  return path.join(u.hem, '.hermes', 'arende_mobilprov.json');
}
async function skrivKonfig(u: Underlag, falt: unknown): Promise<void> {
  await skriv(konfigfil(u), JSON.stringify(falt));
}
async function skrivNyckel(u: Underlag, nyckel: string): Promise<void> {
  await skriv(u.nyckelfil, `${nyckel}\n`, 0o600);
}
function helKonfig(u: Underlag, bas: string, arende: string): Record<string, unknown> {
  return { bas, arende, nyckelfil: u.nyckelfil, webblasare: u.webblasare };
}

// -I isolerar importerna, -B hindrar cache; kod 3 skiljer drivrutinsfel från provets utfall.
const DRIVER = [
  'import json, os, sys, traceback, urllib.parse',
  'try:',
  '    sys.path.insert(0, sys.argv[1])',
  '    import arende_mobilprov as k',
  '    operation = sys.argv[2]',
  '    arg = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}',
  '    hem = os.environ["HOME"]',
  '    def lever():',
  '        try:',
  '            with open(os.environ["ATTRAPP_LOGG"], encoding="utf-8") as fil:',
  '                forsta = fil.readline()',
  '        except FileNotFoundError:',
  '            return False',
  '        if not forsta:',
  '            return False',
  '        try:',
  '            os.kill(json.loads(forsta)["pid"], 0)',
  '        except ProcessLookupError:',
  '            return False',
  '        return True',
  '    def konfig():',
  '        lage = k.hamta_konfig(hem)',
  '        if lage.fel is not None:',
  '            raise RuntimeError("konfigurationen: " + lage.fel)',
  '        return lage.konfig',
  '    if operation == "konfig":',
  '        lage = k.hamta_konfig(hem)',
  '        c = lage.konfig',
  '        resultat = {"bas": None if c is None else c.bas, "arende": None if c is None else c.arende,',
  '                    "webblasare": None if c is None else c.webblasare,',
  '                    "nyckel_ratt": c is not None and c.nyckel == arg["nyckel"], "fel": lage.fel}',
  '    elif operation == "kanal":',
  '        if arg.get("kort"):',
  '            k.TIDSGRANS = 1',
  '        c = konfig()',
  '        fel = text = None',
  '        try:',
  '            kanal, session = k.starta(c, 375, 812)',
  '            kanal.stang()',
  '        except Exception as undantag:',
  '            fel, text = type(undantag).__name__, str(undantag)',
  '        resultat = {"fel": fel, "text": text, "lever": lever()}',
  '    elif operation == "sida":',
  '        kanal, session = k.starta(konfig(), 375, 812)',
  '        try:',
  '            url = k.MOTPROV if arg["url"] == "MOTPROV" else arg["url"]',
  '            sida = k.navigera(kanal, session, url, arg["url"] != "MOTPROV")',
  '            matning, matfel = k.mata(kanal, session, 375)',
  '            meny = k.oppna_meny(kanal, session)',
  '            knappar = k.knappar(kanal, session, arg["fragor"])',
  '        finally:',
  '            kanal.stang()',
  '        resultat = {"sida": sida._asdict(), "matning": matning._asdict(), "matfel": matfel,',
  '                    "meny": meny._asdict(), "knappar": knappar}',
  '    elif operation == "skript":',
  '        resultat = {"SKRIPT": k.SKRIPT, "VANTA_TYPSNITT": k.VANTA_TYPSNITT,',
  '                    "VANTA_ANIMATIONER": k.VANTA_ANIMATIONER}',
  '    elif operation == "kantfynd":',
  '        resultat = {"knappar": [list(k.knappfynd({"/f": None if kant is None else tuple(kant)}, [("/f", "F")],',
  '                                                arg["bredd"])) for kant in arg["knappar"]],',
  '                    "menyer": [list(k.menyfynd(k.Meny(*meny), arg["bredd"])) for meny in arg["menyer"]]}',
  '    elif operation == "skrivningar":',
  '        c = konfig()',
  '        a = "/vy/arende/" + c.arende',
  '        tabell = {"inloggning": ("/vy/logga-in", {"nyckel": c.nyckel}, None),',
  '                  "kommentar": (a + "/kommentar", {"body": "F4 kommentar"}, "kommenterade"),',
  '                  "titel": (a + "/ratta", {"titel": "M109 F4 titel"}, "andrade_titel"),',
  '                  "saknas": (a + "/saknas", {"body": "F4 saknas"}, "kommenterade")}',
  '        kanal, session = k.starta(c, 375, 812)',
  '        resultat = []',
  '        try:',
  '            sida = k.navigera(kanal, session, c.bas + "/vy/logga-in?fran=" + urllib.parse.quote(a, safe=""), True)',
  '            if not sida.ok:',
  '                raise RuntimeError(sida.fel)',
  '            for namn in arg["steg"]:',
  '                adress, falt, verb = tabell[namn]',
  '                fore = k.hamta_handelser(c.bas, c.nyckel, c.arende) if verb else None',
  '                s = k.skicka(kanal, session, adress, falt, 375)',
  '                regel = None',
  '                if verb:',
  '                    regel = k.ny_handelse(fore.rader, k.hamta_handelser(c.bas, c.nyckel, c.arende).rader, verb)',
  '                resultat.append({"skickat": s.skickat, "status": s.status, "plats": s.plats, "kvitto": s.kvitto,',
  '                                 "formular": list(s.formular), "ny_handelse": regel})',
  '        finally:',
  '            kanal.stang()',
  '    elif operation == "handelser":',
  '        resultat = k.hamta_handelser(arg["bas"], arg["nyckel"], arg["arende"])._asdict()',
  '    elif operation == "handelseregel":',
  '        resultat = {"skal": k.ny_handelse([tuple(r) for r in arg["fore"]], [tuple(r) for r in arg["efter"]],',
  '                                          arg["verb"])}',
  '    elif operation == "kor":',
  '        if arg.get("bara375"):',
  '            k.BREDDER = ((375, 812),)',
  '        if arg.get("handelser_fel"):',
  '            def utan_handelser(bas, nyckel, arende):',
  '                return k.Handelselage((), "HTTPError")',
  '            k.hamta_handelser = utan_handelser',
  '        if arg.get("handelser_fel_vid"):',
  '            verklig_hamtning = k.hamta_handelser',
  '            anrop = []',
  '            def fel_vid(bas, nyckel, arende):',
  '                anrop.append(arende)',
  '                if len(anrop) == arg["handelser_fel_vid"]:',
  '                    return k.Handelselage((), "HTTPError")',
  '                return verklig_hamtning(bas, nyckel, arende)',
  '            k.hamta_handelser = fel_vid',
  '        if arg.get("motprov"):',
  '            k.MOTPROV = arg["motprov"]',
  '        if arg.get("stangd"):',
  '            stangt_steg, stangd_bas = arg["stangd"]["steg"], arg["stangd"]["bas"]',
  '            verkligt_steg = k.STEGEN[stangt_steg]',
  '            def mot_stangd_port(korning):',
  '                return verkligt_steg(korning._replace(konfig=korning.konfig._replace(bas=stangd_bas)))',
  '            k.STEGEN[stangt_steg] = mot_stangd_port',
  '        resultat = k.kor(hem)._asdict()',
  '    elif operation == "doma":',
  '        utfall = tuple(k.Breddutfall(b["bredd"], tuple(tuple(f) for f in b["fynd"]),',
  '                                     tuple(tuple(f) for f in b["fel"]), tuple(b["rader"])) for b in arg["bredder"])',
  '        resultat = k.doma(arg["konfigfel"], utfall)._asdict()',
  '    elif operation == "krasch":',
  '        def krasch(*argument):',
  '            raise RuntimeError("provets krasch")',
  '        k.kor = krasch',
  '        sys.exit(k.huvud([]))',
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
async function korDrivern(u: Underlag, argument: string[], lage = 'normal', plats = '/vy'): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, ...argument],
      { cwd: ROT, env: barnmiljo(u, lage, plats), timeout: 25_000 });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
/** Modulen som skript, utan drivrutin, som provvakten kör den. */
async function korProvet(u: Underlag, argument: string[] = []): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', MODULEN, ...argument],
      { cwd: ROT, env: barnmiljo(u, 'normal', '/vy'), timeout: 25_000 });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
function rader(ut: string): string[] {
  return ut.split(/\r?\n/).filter((rad) => rad.length > 0);
}
async function korJson<T>(u: Underlag, operation: string, arg: unknown, lage = 'normal', plats = '/vy'): Promise<T> {
  const p = await korDrivern(u, [operation, JSON.stringify(arg)], lage, plats);
  if (p.kod !== 0) throw new Error(`drivrutinen avslutade med ${p.kod}: ${p.fel}`);
  return JSON.parse(p.ut) as T;
}
async function hamtaLogg(u: Underlag): Promise<Loggrad[]> {
  let text: string;
  try {
    text = await readFile(u.logg, 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter((rad) => rad.length > 0).map((rad) => JSON.parse(rad) as Loggrad);
}
async function profilKvar(u: Underlag): Promise<boolean> {
  return (await readdir(u.tmp)).some((namn) => namn.startsWith(PROFILPREFIX));
}

async function korKonfig(u: Underlag): Promise<Konfigutfall> {
  return korJson<Konfigutfall>(u, 'konfig', { nyckel: F1_NYCKEL });
}
/**
 * Startar 375 mot konfigurationens bas, öppnar inloggningssidan med fran lika med ärendesidan och skickar
 * stegen i följd genom ytans formulär, med hamta_handelser före och efter kommentaren och titeln.
 */
async function korSkrivningar(u: Underlag, steg: string[]): Promise<Skrivutfall[]> {
  return korJson<Skrivutfall[]>(u, 'skrivningar', { steg });
}
/** Hela stegföljden genom kor(hem), med drivrutinens val bara375 och handelser_fel. */
async function korKor(u: Underlag, lage = 'normal', val: Korval = {}, plats = '/vy'): Promise<Dom> {
  return korJson<Dom>(u, 'kor', val, lage, plats);
}
function fyndOchFel(d: Dom): string[] {
  return d.rader.filter((rad) => rad.startsWith('FYND: ') || rad.startsWith('FEL: '));
}
/** Startar 375, navigerar (med statuskrav utom för MOTPROV) och mäter dokumentet, menyn och knapparna. */
async function korSida(u: Underlag, lage: string, url: string, fragor: string[] = []): Promise<Sidutfall> {
  return korJson<Sidutfall>(u, 'sida', { url, fragor }, lage);
}
async function korKanal(u: Underlag, lage: string, kort = false): Promise<Kanalutfall> {
  await rm(u.logg, { force: true });
  const k = await korJson<{ fel: string | null; text: string | null; lever: boolean }>(u, 'kanal', { kort }, lage);
  const logg = await hamtaLogg(u);
  const anrop = logg.filter((rad) => rad.method !== undefined);
  return { fel: k.fel, text: k.text, argv: logg[0]?.argv, metoder: anrop.map((rad) => rad.method!),
    parametrar: anrop.find((rad) => rad.method === 'Emulation.setDeviceMetricsOverride')?.params ?? {},
    profil_kvar: await profilKvar(u), lever: k.lever };
}

describe('FR-15/Story 10.9 AK 1, 2: konfigurationen läses genom en enda väg och webbläsaren startas över rören', () => {
  it('F1 (AK 1, AK 2): konfigurationen läses genom en enda väg', async () => {
    const u = await nyttHem();
    await skrivNyckel(u, F1_NYCKEL);
    const hel = helKonfig(u, KONFIGBAS, 'LOC-1');
    const fel = async (falt: unknown): Promise<string | null> => {
      await skrivKonfig(u, falt);
      return (await korKonfig(u)).fel;
    };
    // (a) Kontrollen: en hel konfiguration ger exakt de fyra värdena, och nyckeln skrivs aldrig ut.
    await skrivKonfig(u, hel);
    const p = await korDrivern(u, ['konfig', JSON.stringify({ nyckel: F1_NYCKEL })]);
    expect(p.ut).not.toContain(F1_NYCKEL);
    expect(JSON.parse(p.ut)).toEqual({ bas: KONFIGBAS, arende: 'LOC-1', webblasare: u.webblasare,
      nyckel_ratt: true, fel: null });
    // (b) Filen saknas. (c) Filen är inte JSON.
    await rm(konfigfil(u));
    expect((await korKonfig(u)).fel).toBe('FileNotFoundError');
    await skriv(konfigfil(u), '{ inte json');
    expect((await korKonfig(u)).fel).toBe('JSONDecodeError');
    // (d) Fel nycklar: en för mycket, en som saknas, och en lista i stället för ett objekt.
    const utanArende = { bas: hel.bas, nyckelfil: hel.nyckelfil, webblasare: hel.webblasare };
    for (const falt of [{ ...hel, extra: 'x' }, utanArende, [hel]]) {
      expect(await fel(falt), JSON.stringify(falt)).toBe('fel nycklar');
    }
    // (e) Bas som inte är en testserver.
    for (const bas of [`https://${VARD}:${KONFIGPORT}`, `http://localhost:${KONFIGPORT}`, `http://${VARD}:${DRIFTPORT}`,
      `http://${VARD}`, `${KONFIGBAS}/vy`, 7]) {
      expect(await fel({ ...hel, bas }), String(bas)).toBe('bas ar ingen testserver');
    }
    // (f) Ärendet.
    for (const arende of ['loc-1', 'LOC-0', 'LOC-1 x']) {
      expect(await fel({ ...hel, arende }), arende).toBe('arendet gar inte att tolka');
    }
    // (g) Nyckelfilen: relativ, saknas och tom.
    expect(await fel({ ...hel, nyckelfil: 'provnyckel' })).toBe('nyckelfilen ar inte en absolut sokvag');
    expect(await fel({ ...hel, nyckelfil: path.join(u.hem, 'saknas') })).toBe('FileNotFoundError');
    const tom = path.join(u.hem, 'tom-nyckel');
    await skriv(tom, '\n', 0o600);
    expect(await fel({ ...hel, nyckelfil: tom })).toBe('nyckelfilen ar tom');
    // (h) Webbläsaren: en relativ sökväg och ett namn med blanktecken fälls, ett bart namn godtas.
    for (const webblasare of ['bin/x', 'a b']) {
      expect(await fel({ ...hel, webblasare }), webblasare).toBe('webblasaren gar inte att tolka');
    }
    await skrivKonfig(u, { ...hel, webblasare: 'chromium' });
    expect(await korKonfig(u)).toEqual({ bas: KONFIGBAS, arende: 'LOC-1', webblasare: 'chromium',
      nyckel_ratt: true, fel: null });
  });

  it('F2 (AK 1, AK 2): webbläsaren startas en gång över rören, och en som inte startar bär sin typ', async () => {
    const u = await nyttHem();
    await skrivNyckel(u, F1_NYCKEL);
    await skrivKonfig(u, helKonfig(u, KONFIGBAS, 'LOC-1'));
    // (a) Kontrollen: flaggorna i ordning med profilen i provets TMPDIR, och de sex metoderna.
    const a = await korKanal(u, 'normal');
    expect(a.fel).toBeNull();
    const profil = a.argv?.[6] ?? '';
    expect(profil.startsWith(`--user-data-dir=${path.join(u.tmp, PROFILPREFIX)}`)).toBe(true);
    expect(a.argv).toEqual(STARTFLAGGOR.map((flagga) => flagga === '--user-data-dir=%s' ? profil : flagga));
    expect(a.metoder).toEqual(KANALMETODER);
    expect(a.parametrar).toEqual({ width: 375, height: 812, deviceScaleFactor: 2, mobile: true });
    expect(a.lever).toBe(false);
    expect(a.profil_kvar).toBe(false);
    // (b) Programmet saknas.
    await skrivKonfig(u, { ...helKonfig(u, KONFIGBAS, 'LOC-1'), webblasare: path.join(u.bin, 'saknas') });
    const b = await korKanal(u, 'normal');
    expect({ fel: b.fel, lever: b.lever, metoder: b.metoder }).toEqual({ fel: 'FileNotFoundError', lever: false, metoder: [] });
    await skrivKonfig(u, helKonfig(u, KONFIGBAS, 'LOC-1'));
    // (c) Attrappen avslutar innan den läst något.
    const c = await korKanal(u, 'startar_inte');
    expect({ fel: c.fel, lever: c.lever }).toEqual({ fel: 'EOFError', lever: false });
    // (d) Attrappen läser men svarar aldrig: tidsgränsen, och stang dödar och hämtar processen.
    const d = await korKanal(u, 'tyst', true);
    expect({ fel: d.fel, lever: d.lever }).toEqual({ fel: 'TimeoutError', lever: false });
    // (e) Ett felsvar på ett protokollanrop bär metodens namn.
    const e = await korKanal(u, 'cdp_fel');
    expect(e.fel).toBe('Kanalfel');
    expect(e.text).toContain('Emulation.setDeviceMetricsOverride');
    expect(e.lever).toBe(false);
    // (f) Ingen profil står kvar efter någon av körningarna.
    expect([a, b, c, d, e].map((k) => k.profil_kvar)).toEqual([false, false, false, false, false]);
  });

  // Omtag 2, samma felklass som i stegen: en gren som inget fall framkallar. Bas-regelns fråga och fragment, en port
  // som inte går att tolka, och ett annat värde än bas som inte är text hade inget fall. Kontrollen är F1 (a).
  it('F1 (AK 2): (d), (e) varje del av formreglerna har ett fall: fråga, fragment, port och värden som inte är text',
    async () => {
      const u = await nyttHem();
      await skrivNyckel(u, F1_NYCKEL);
      const hel = helKonfig(u, KONFIGBAS, 'LOC-1');
      const fel = async (falt: unknown): Promise<string | null> => {
        await skrivKonfig(u, falt);
        return (await korKonfig(u)).fel;
      };
      expect(await fel(hel)).toBeNull();
      for (const bas of [`${KONFIGBAS}?x=1`, `${KONFIGBAS}#x`, `http://${VARD}:x`, `http://${VARD}:99999`]) {
        expect(await fel({ ...hel, bas }), bas).toBe('bas ar ingen testserver');
      }
      for (const falt of [{ ...hel, arende: 7 }, { ...hel, nyckelfil: null }, { ...hel, webblasare: ['x'] }]) {
        expect(await fel(falt), JSON.stringify(falt)).toBe('fel nycklar');
      }
    });

  // Omtag 2, samma felklass: ett bart namn slås upp i PATH (Dev Notes, Kanal), och grenen där inget hittas hade
  // inget fall. Kontrollen är attrappens eget namn, som står i hemmets bin först i provets PATH.
  it('F2 (AK 2): (b) ett bart namn slås upp i PATH, och ett som inte finns där ger FileNotFoundError', async () => {
    const u = await nyttHem();
    await skrivNyckel(u, F1_NYCKEL);
    const kort = (k: Kanalutfall): Record<string, unknown> =>
      ({ fel: k.fel, metoder: k.metoder, lever: k.lever, profil_kvar: k.profil_kvar });
    await skrivKonfig(u, { ...helKonfig(u, KONFIGBAS, 'LOC-1'), webblasare: 'webblasare' });
    expect(kort(await korKanal(u, 'normal')))
      .toEqual({ fel: null, metoder: KANALMETODER, lever: false, profil_kvar: false });
    await skrivKonfig(u, { ...helKonfig(u, KONFIGBAS, 'LOC-1'), webblasare: 'arende-mobilprov-saknas' });
    expect(kort(await korKanal(u, 'normal')))
      .toEqual({ fel: 'FileNotFoundError', metoder: [], lever: false, profil_kvar: false });
  });
});

// Stubbsidan för skripten (omtag 2). Attrappen gör ingen layout och tolkar aldrig skripten, så det som skripten
// själva gör med geometrin prövas här: texterna ur SKRIPT körs i node:vm mot ett dokument vars geometri följer
// tillståndet, som i en webbläsare. En animation ger mellanlägets kanter tills den är klar, och ett element som inte
// ritas har inga kanter. Ingen yta och inget nät är inblandat; ytan prövas genom attrappen och testservern.
interface Animering { klar: boolean; finished: Promise<void> }
interface Rekt { left: number; right: number; width: number; height: number }
type Dold = 'display' | 'visibility' | null;
const rekt = (left: number, right: number, height = 20): Rekt => ({ left, right, width: right - left, height });
const INGEN_REKT = rekt(0, 0, 0);
/** Startar en animation; finished uppfylls först efter en makrouppgift, som efter en riktig animations bildrutor. */
function animera(animationer: Animering[]): Animering {
  const a: Animering = { klar: false, finished: Promise.resolve() };
  a.finished = new Promise<void>((klar) => setTimeout(() => { a.klar = true; klar(); }, 20));
  animationer.push(a);
  return a;
}
class Stubbnod {
  private oppen = false;
  constructor(readonly tag: string, readonly parentElement: Stubbnod | null = null, readonly klass = '',
    private readonly vidOppning: () => void = () => undefined) {}
  get open(): boolean { return this.oppen; }
  set open(varde: boolean) {
    if (varde && !this.oppen) this.vidOppning();
    this.oppen = varde;
  }
  closest(valjare: string): Stubbnod | null {
    for (let n: Stubbnod | null = this; n !== null; n = n.parentElement) {
      if (valjare === 'details' && n.tag === 'details') return n;
    }
    return null;
  }
  /** Noden ritas bara när varje details runt den är öppen. */
  iOppnaDetails(): boolean {
    for (let n = this.parentElement; n !== null; n = n.parentElement) {
      if (n.tag === 'details' && !n.open) return false;
    }
    return true;
  }
}
class Stubbformular extends Stubbnod {
  readonly elements: Stubbnod[] = [];
  constructor(readonly adress: string, foralder: Stubbnod | null) { super('form', foralder); }
  getAttribute(namn: string): string | null { return namn === 'action' ? this.adress : null; }
  medKnapp(geometri: () => Rekt, dold: Dold = null): this {
    this.elements.push(new Stubbknapp(this, geometri, dold));
    return this;
  }
}
/** En knapp av typen submit. Med dold 'display' har den ingen ruta, med 'visibility' en ruta som inte syns. */
class Stubbknapp extends Stubbnod {
  readonly type = 'submit';
  constructor(foralder: Stubbformular, private readonly geometri: () => Rekt, private readonly dold: Dold) {
    super('button', foralder);
  }
  checkVisibility(): boolean { return this.dold === null && this.iOppnaDetails(); }
  getBoundingClientRect(): Rekt {
    return this.dold === 'display' || !this.iOppnaDetails() ? INGEN_REKT : this.geometri();
  }
}
function stubbdokument(animationer: Animering[], delar: { former?: Stubbformular[]; details?: Stubbnod[];
  meny?: Stubbnod; rot?: { scrollWidth: number; clientWidth: number } }): object {
  return {
    fonts: Object.assign([], { ready: Promise.resolve() }),
    getAnimations: () => [...animationer],
    forms: delar.former ?? [],
    documentElement: delar.rot ?? { scrollWidth: 375, clientWidth: 375 },
    querySelector: (valjare: string) => (valjare === 'details.navmenu' ? delar.meny ?? null : null),
    querySelectorAll: (valjare: string) => (valjare === 'details.rattelse'
      ? (delar.details ?? []).filter((d) => d.klass === 'rattelse') : []),
  };
}
/** Ytans meny: panelen reser sig när menyn öppnas (navrise, 170 ms) och är skalad kring mitten under resningen. */
function menysida(panel: 'reser_sig' | 'display' | 'saknas'): object {
  const animationer: Animering[] = [];
  let resning: Animering | null = null;
  const meny = new Stubbnod('details', null, 'navmenu', () => { resning = animera(animationer); });
  const summary = { click: () => { meny.open = true; } };
  const panelen = {
    checkVisibility: () => meny.open && panel === 'reser_sig',
    // Slutläget spiller 2 px utanför 375; resningens första bildruta (scale .985) ligger inom fönstret.
    getBoundingClientRect: () => (!meny.open || panel === 'display' ? INGEN_REKT
      : resning?.klar === true ? rekt(8, 377) : rekt(11, 374)),
  };
  Object.assign(meny, { querySelector: (valjare: string) => (valjare === ':scope > summary' ? summary
    : valjare === '.navmenu__panel' && panel !== 'saknas' ? panelen : null) });
  return stubbdokument(animationer, { meny });
}
/** En rättelse vars innehåll glider in när den öppnas; i slutläget spiller knappen 4 px utanför 375. */
function rattelsesida(): object {
  const animationer: Animering[] = [];
  let infallning: Animering | null = null;
  const rattelse = new Stubbnod('details', null, 'rattelse', () => { infallning = animera(animationer); });
  const form = new Stubbformular('/f/ett', rattelse)
    .medKnapp(() => (infallning?.klar === true ? rekt(8, 379) : rekt(2, 373)));
  return stubbdokument(animationer, { former: [form], details: [rattelse] });
}
/** En sida som glider in när den laddats; i slutläget är dokumentet 391 px brett. */
function inglidningssida(): object {
  const animationer: Animering[] = [];
  const intag = animera(animationer);
  const rot = { get scrollWidth() { return intag.klar ? 391 : 375; }, clientWidth: 375 };
  return stubbdokument(animationer, { rot });
}
/** Kör ett skript ur SKRIPT som Runtime.evaluate med returnByValue gör: i en egen kontext, och svaret som JSON. */
async function korISida(text: string, dokument: object, arg: unknown = null): Promise<unknown> {
  const skript = runInNewContext(`(${text})`, { document: dokument }) as (a: unknown) => Promise<unknown>;
  return JSON.parse(JSON.stringify(await skript(arg))) as unknown;
}
interface Skripten { SKRIPT: Record<string, string>; VANTA_TYPSNITT: string; VANTA_ANIMATIONER: string }

describe('FR-15/Story 10.9 AK 1, 2: en sida mäts i en bredd', () => {
  it('F3 (AK 1, AK 2): en sida öppnas, och dokumentet, menyn och knapparna mäts efter typsnitten', async () => {
    const fixtur = await nyFixturserver();
    const u = await nyttHem();
    await skrivNyckel(u, F1_NYCKEL);
    await skrivKonfig(u, helKonfig(u, fixtur, 'LOC-1'));
    // (a) Kontrollen: en smal sida med menyn och två formulär.
    expect(await korSida(u, 'normal', `${fixtur}/smal`, ['/f/ett', '/f/saknas'])).toEqual({
      sida: { ok: true, status: 200, fel: null },
      matning: { dokument: 375, fonster: 375, kvitto: false, formular: ['/f/ett', '/f/tva'], typsnitt: 0 },
      matfel: null,
      meny: { oppen: true, vanster: 8, hoger: 367 },
      knappar: { '/f/ett': [8, 367], '/f/saknas': null },
    });
    // (b) Ett 800 px brett element.
    const b = await korSida(u, 'normal', `${fixtur}/bred`);
    expect({ dokument: b.matning.dokument, fonster: b.matning.fonster }).toEqual({ dokument: 800, fonster: 375 });
    // (c) 404 och (d) en stängd port.
    expect((await korSida(u, 'normal', `${fixtur}/saknas`)).sida)
      .toEqual({ ok: false, status: 404, fel: 'sidan nas inte: /saknas (status 404)' });
    const d = (await korSida(u, 'normal', `${await stangdPort()}/`)).sida;
    expect(d.ok).toBe(false);
    expect(d.fel?.startsWith('sidan nas inte: /')).toBe(true);
    expect(d.fel?.endsWith('(net::ERR_CONNECTION_REFUSED)')).toBe(true);
    // (e) Motprovet utan statuskrav.
    const e = await korSida(u, 'normal', 'MOTPROV');
    expect({ ok: e.sida.ok, dokument: e.matning.dokument }).toEqual({ ok: true, dokument: 800 });
    // (f) Attrappens lägen för de senare fallen, och ett läge med en adress gäller bara den adressen.
    expect((await korSida(u, 'smal', `${fixtur}/bred`)).matning.dokument).toBe(375);
    expect((await korSida(u, 'meny_stangd', `${fixtur}/smal`)).meny.oppen).toBe(false);
    expect((await korSida(u, 'knapp_utanfor', `${fixtur}/smal`, ['/f/ett'])).knappar['/f/ett']).toEqual([8, 415]);
    expect((await korSida(u, 'meny_utanfor', `${fixtur}/smal`)).meny.hoger).toBe(415);
    const fonster = await korSida(u, 'fonster_fel', `${fixtur}/smal`);
    expect({ fonster: fonster.matning.fonster, matfel: fonster.matfel })
      .toEqual({ fonster: 374, matfel: 'fonstret fick inte bredden 375' });
    const saknat = await korSida(u, 'typsnitt_saknas', `${fixtur}/smal`);
    expect({ typsnitt: saknat.matning.typsnitt, matfel: saknat.matfel })
      .toEqual({ typsnitt: 1, matfel: '1 typsnitt laddades inte' });
    expect((await korSida(u, 'typsnitt_saknas+fonster_fel', `${fixtur}/smal`)).matfel).toBe('1 typsnitt laddades inte');
    expect((await korSida(u, 'bred', `${fixtur}/smal`)).matning.dokument).toBe(800);
    expect((await korSida(u, 'knapp_utanfor@/f/saknas', `${fixtur}/smal`, ['/f/ett'])).knappar['/f/ett'])
      .toEqual([8, 367]);
    // (g) Skripten kompileras, och varje skript som läser geometri börjar med förleden.
    const s = await korJson<{ SKRIPT: Record<string, string>; VANTA_TYPSNITT: string }>(u, 'skript', {});
    expect(Object.keys(s.SKRIPT).sort()).toEqual(['knappar', 'matning', 'meny', 'skicka']);
    for (const [namn, text] of Object.entries(s.SKRIPT)) {
      expect(() => new Script(`(${text})`), namn).not.toThrow();
    }
    expect(s.VANTA_TYPSNITT).toContain('document.fonts.ready');
    expect(s.VANTA_TYPSNITT).toContain('.load()');
    const medForled = (text: string): boolean => text.startsWith(`async function (arg) { ${s.VANTA_TYPSNITT}`);
    expect(['knappar', 'matning', 'meny'].map((namn) => medForled(s.SKRIPT[namn] ?? ''))).toEqual([true, true, true]);
    // Kontrollen: skicka läser ingen geometri, och samma prövning slår ut.
    expect(medForled(s.SKRIPT['skicka'] ?? '')).toBe(false);
    // (h) Typsnitten: ett som laddas och ett som inte laddas, båda hämtade före svaret på matning.
    const ett = await korSida(u, 'normal', `${fixtur}/typsnitt/ett`);
    expect({ typsnitt: ett.matning.typsnitt, matfel: ett.matfel }).toEqual({ typsnitt: 0, matfel: null });
    await rm(u.logg, { force: true });
    const tva = await korSida(u, 'normal', `${fixtur}/typsnitt/tva`);
    expect({ typsnitt: tva.matning.typsnitt, matfel: tva.matfel }).toEqual({ typsnitt: 1, matfel: '1 typsnitt laddades inte' });
    const logg = await hamtaLogg(u);
    const anrop = logg.findIndex((rad) => rad.method === 'Runtime.evaluate' && rad.skript === 'matning');
    const svar = logg.findIndex((rad) => rad.svar === 'Runtime.evaluate' && rad.skript === 'matning');
    expect(anrop).toBeGreaterThan(-1);
    expect(logg.slice(anrop + 1, svar)).toEqual([{ typsnitt: '/t/finns.woff2', status: 200 },
      { typsnitt: '/t/saknas.woff2', status: 404 }]);
  });

  // Omtag 2, felklassen: geometrin lästes innan den var slutlig. Förleden väntar ut typsnitten, men menyns panel
  // reser sig i 170 ms efter klicket (navrise i src/http/vy/mall.ts), och det som ett skript öppnar eller en sida
  // gör när den laddats kan också röra sig. Varje skript som läser geometri väntar därför ut animationerna efter sin
  // egen handling och före varje läsning. Kontrollen i varje del är samma skript utan väntan, som läser mellanläget.
  it('F3 (AK 1): (g) varje skript som läser geometri väntar ut animationerna efter sin handling', async () => {
    const s = await korJson<Skripten>(await nyttHem(), 'skript', {});
    const skript = (namn: string): string => s.SKRIPT[namn] ?? '';
    const utanVantan = (namn: string): string => skript(namn).replace(s.VANTA_ANIMATIONER, '');
    expect(s.VANTA_ANIMATIONER).toContain('document.getAnimations()');
    expect(s.VANTA_ANIMATIONER).toContain('.finished');
    // Ordningen i texten: förleden, handlingen, väntan, och först därefter en läsning av geometrin.
    const LASNINGAR = ['getBoundingClientRect', 'checkVisibility', 'scrollWidth', 'clientWidth'];
    const vantarForeLasning = (text: string): boolean => {
      const vantan = text.indexOf(s.VANTA_ANIMATIONER);
      const lasning = Math.min(...LASNINGAR.map((ord) => text.indexOf(ord)).filter((i) => i >= 0));
      return vantan > text.indexOf(s.VANTA_TYPSNITT) && vantan < lasning;
    };
    expect(['knappar', 'matning', 'meny'].map((namn) => vantarForeLasning(skript(namn)))).toEqual([true, true, true]);
    expect(['knappar', 'matning', 'meny'].map((namn) => vantarForeLasning(utanVantan(namn))))
      .toEqual([false, false, false]);
    // Menyn: med väntan läses panelens slutläge, som spiller 2 px utanför 375. Utan väntan läses resningens första
    // bildruta, som ligger inom fönstret och hade gett GRON.
    expect(await korISida(skript('meny'), menysida('reser_sig'))).toEqual({ oppen: true, vanster: 8, hoger: 377 });
    expect(await korISida(utanVantan('meny'), menysida('reser_sig'))).toEqual({ oppen: true, vanster: 11, hoger: 374 });
    // Knapparna: rättelsen som skriptet öppnar glider in, och i slutläget spiller knappen 4 px.
    expect(await korISida(skript('knappar'), rattelsesida(), ['/f/ett'])).toEqual({ '/f/ett': [8, 379] });
    expect(await korISida(utanVantan('knappar'), rattelsesida(), ['/f/ett'])).toEqual({ '/f/ett': [2, 373] });
    // Mätningen: sidan glider in när den laddats, och i slutläget är dokumentet 391 px.
    expect(await korISida(skript('matning'), inglidningssida()))
      .toEqual({ dokument: 391, fonster: 375, kvitto: false, formular: [], typsnitt: 0 });
    expect(await korISida(utanVantan('matning'), inglidningssida())).toMatchObject({ dokument: 375 });
  });

  // Omtag 2, felklassen: en kant som inte ritas godtogs som inom fönstret. En knapp med display:none, eller i en
  // stängd details utan klassen rattelse, har kanterna [0, 0], och 0 ligger inom fönstret. Skriptet öppnar därför
  // varje details runt knappen, och ett element som inte ritas ger [0, 0], som fyndreglerna aldrig godtar.
  it('F3 (AK 1): (f) knappar öppnar varje details runt knappen, och det som inte ritas godtas aldrig', async () => {
    const u = await nyttHem();
    const s = await korJson<Skripten>(u, 'skript', {});
    const skript = (namn: string): string => s.SKRIPT[namn] ?? '';
    // En knapp i två stängda details utan klassen rattelse mäts utfälld, och båda står öppna efteråt.
    const yttre = new Stubbnod('details');
    const inre = new Stubbnod('details', yttre);
    const kapslad = new Stubbformular('/f/kapslad', inre).medKnapp(() => rekt(8, 367));
    const knappen = kapslad.elements[0] as Stubbknapp;
    // Kontrollen: så länge de är stängda ritas knappen inte och har inga kanter.
    expect([knappen.checkVisibility(), knappen.getBoundingClientRect()]).toEqual([false, INGEN_REKT]);
    expect(await korISida(skript('knappar'), stubbdokument([], { former: [kapslad], details: [yttre, inre] }),
      ['/f/kapslad'])).toEqual({ '/f/kapslad': [8, 367] });
    expect([yttre.open, inre.open]).toEqual([true, true]);
    // Det som inte ritas: display:none, visibility:hidden och en ruta utan höjd. Kontrollen är /f/ett, som ritas.
    const former = [
      new Stubbformular('/f/ett', null).medKnapp(() => rekt(8, 367)),
      new Stubbformular('/f/display', null).medKnapp(() => rekt(8, 367), 'display'),
      new Stubbformular('/f/visibility', null).medKnapp(() => rekt(8, 367), 'visibility'),
      new Stubbformular('/f/platt', null).medKnapp(() => rekt(8, 367, 0)),
    ];
    expect(await korISida(skript('knappar'), stubbdokument([], { former }),
      [...former.map((f) => f.adress), '/f/saknas'])).toEqual({
      '/f/ett': [8, 367], '/f/display': [0, 0], '/f/visibility': [0, 0], '/f/platt': [0, 0], '/f/saknas': null,
    });
    // En menypanel som inte ritas, och en meny utan panel, har inga kanter.
    for (const panel of ['display', 'saknas'] as const) {
      expect(await korISida(skript('meny'), menysida(panel)), panel).toEqual({ oppen: true, vanster: 0, hoger: 0 });
    }
    // Fyndreglerna: bara en kant med bredd, helt inom fönstret, godtas. Knapparna i ordningen saknas, ritas inte
    // (vid 0 och mitt på sidan), har negativ bredd, och sedan två kontroller inom fönstret och två utanför.
    const SAKNAS = ['knappen i F saknas'];
    const UTANFOR = ['knappen i F hamnar utanfor fonstret'];
    const MENY_STANGD = ['menyn gar inte att oppna'];
    const MENY_UTANFOR = ['menypanelen hamnar utanfor fonstret'];
    expect(await korJson(u, 'kantfynd', {
      bredd: 375,
      knappar: [null, [0, 0], [200, 200], [210, 200], [8, 367], [0, 375], [-1, 100], [8, 376]],
      menyer: [[false, 8, 367], [true, 0, 0], [true, 200, 200], [true, 8, 367], [true, 0, 375], [true, -1, 367],
        [true, 8, 376]],
    })).toEqual({
      knappar: [SAKNAS, SAKNAS, SAKNAS, SAKNAS, [], [], UTANFOR, UTANFOR],
      menyer: [MENY_STANGD, MENY_STANGD, MENY_STANGD, [], [], MENY_UTANFOR, MENY_UTANFOR],
    });
  });
});

/** Ett hem vars konfiguration pekar på testservern, provärendet och en nyckelfil med den givna nyckeln. */
async function testhem(nyckel = provnyckel, bas = TESTBAS, arende = provarende): Promise<Underlag> {
  const u = await nyttHem();
  await skrivNyckel(u, nyckel);
  await skrivKonfig(u, helKonfig(u, bas, arende));
  return u;
}

describe('FR-15/Story 10.9 AK 1, 2: skrivningarna ger 303, kvitto och en händelserad', () => {
  it('F4 (AK 1, AK 2): inloggningen, kommentaren och titeln skickas genom ytans formulär', async () => {
    const aktor = { aktor_typ: 'manniska', aktor_namn: MANNISKA };
    // (a), (c) och (d) i en körning: inloggningen med provnyckeln, kommentaren och titeln.
    const u = await testhem();
    const fore = await handelserFor(provarende);
    const [inloggning, kommentar, titel] = await korSkrivningar(u, ['inloggning', 'kommentar', 'titel']);
    expect(inloggning).toMatchObject({ skickat: true, status: 303, plats: `${A}?notis=inloggad`, kvitto: true });
    expect(inloggning?.formular).toContain(`${A}/kommentar`);
    expect(kommentar).toMatchObject({ skickat: true, status: 303, plats: `${A}?notis=kommenterad`, kvitto: true,
      ny_handelse: null });
    expect(titel).toMatchObject({ skickat: true, status: 303, plats: `${A}?notis=arendet_rattat`, kvitto: true,
      ny_handelse: null });
    // Exakt en rad till per skrivning, med människoaktören, och ingen rattade_beskrivning.
    expect((await handelserFor(provarende)).slice(fore.length)).toEqual([
      { verb: 'kommenterade', ...aktor }, { verb: 'andrade_titel', ...aktor },
    ]);
    // (b) Kontrollen är (a), skild bara i nyckeln: en okänd nyckel och en agentnyckel.
    const okand = await korSkrivningar(await testhem('m109-okand-nyckel'), ['inloggning']);
    expect(okand[0]?.status).toBe(303);
    expect(okand[0]?.plats?.startsWith('/vy/logga-in?fel=1&fran=')).toBe(true);
    expect(okand[0]?.kvitto).toBe(false);
    const agent = await korSkrivningar(await testhem(hermes), ['inloggning']);
    expect(agent[0]?.status).toBe(303);
    expect(agent[0]?.plats?.startsWith('/vy/logga-in?fel=agent&fran=')).toBe(true);
    // (e) Händelseregeln på funktionsnivå; kontrollen är en ny rad med rätt verb och människoaktören.
    const regel = async (efter: [number, string, string][], verb: string): Promise<string | null> =>
      (await korJson<{ skal: string | null }>(u, 'handelseregel', {
        fore: [[9, 'skapade', 'agent']], efter: [[9, 'skapade', 'agent'], ...efter], verb })).skal;
    expect(await regel([[10, 'kommenterade', 'manniska']], 'kommenterade')).toBeNull();
    expect(await regel([], 'kommenterade')).toBe('gav 0 nya handelser');
    expect(await regel([[10, 'kommenterade', 'manniska'], [11, 'kommenterade', 'manniska']], 'kommenterade'))
      .toBe('gav 2 nya handelser');
    expect(await regel([[10, 'kommenterade', 'manniska']], 'andrade_titel')).toBe('handelsen har verbet kommenterade');
    expect(await regel([[10, 'kommenterade', 'agent']], 'kommenterade')).toBe('handelsen har aktoren agent');
    // (f) API:ts läsfel bär sin typ; kontrollen är samma operation med provnyckeln.
    const handelser = async (bas: string, nyckel: string): Promise<{ rader: unknown[]; fel: string | null }> =>
      korJson<{ rader: unknown[]; fel: string | null }>(u, 'handelser', { bas, nyckel, arende: provarende });
    expect((await handelser(TESTBAS, 'm109-okand-nyckel')).fel).toBe('HTTPError');
    expect((await handelser(await stangdPort(), provnyckel)).fel).toBe('URLError');
    const kontroll = await handelser(TESTBAS, provnyckel);
    expect(kontroll.fel).toBeNull();
    expect(kontroll.rader.length).toBeGreaterThanOrEqual(1);
    // (g) En adress utan formulär: inget skickas, och ingen rad tillkommer.
    const innan = await handelserFor(provarende);
    const [, saknas] = await korSkrivningar(await testhem(), ['inloggning', 'saknas']);
    expect(saknas?.skickat).toBe(false);
    expect(await handelserFor(provarende)).toEqual(innan);
  });
});

// F5 (l): varje fynd och fel i stegtabellen, ett it per rad. A står för ärendesidans sökväg och byggs vid
// körningen ur provärendet; plats är ATTRAPP_PLATS, som annars är /vy. Raderna är FYND och FEL i ordning.
interface Stegfall { rad: number; lage: string; val?: Korval; plats?: string; utfall: string; rader: string[] }
const DOK = 'dokumentet ar 800 px men fonstret 375 px';
const STEGFALL: Stegfall[] = [
  { rad: 0, lage: 'normal', utfall: 'GRON', rader: [] },
  { rad: 1, lage: 'meny_utanfor@/vy', utfall: 'ROD',
    rader: ['FYND: bredd 375 oversikt: menypanelen hamnar utanfor fonstret'] },
  { rad: 2, lage: 'fonster_fel@/vy/mitt', utfall: 'KUNDE_INTE',
    rader: ['FEL: bredd 375 mitt: fonstret fick inte bredden 375'] },
  { rad: 3, lage: 'typsnitt_saknas@/vy/mitt', utfall: 'KUNDE_INTE',
    rader: ['FEL: bredd 375 mitt: 1 typsnitt laddades inte'] },
  { rad: 4, lage: 'skript_fel@/vy/mitt', utfall: 'KUNDE_INTE',
    rader: ['FEL: bredd 375 mitt: steget stannade: Kanalfel'] },
  { rad: 5, lage: 'bred@/vy', utfall: 'ROD', rader: [`FYND: bredd 375 oversikt: ${DOK}`] },
  { rad: 6, lage: 'bred@/vy/mitt', utfall: 'ROD', rader: [`FYND: bredd 375 mitt: ${DOK}`] },
  { rad: 7, lage: 'bred@A', utfall: 'ROD',
    rader: [`FYND: bredd 375 laslage: ${DOK}`, `FYND: bredd 375 arendesidan: ${DOK}`] },
  { rad: 8, lage: 'bred@A?notis=inloggad', utfall: 'ROD', rader: [`FYND: bredd 375 inloggning: ${DOK}`] },
  { rad: 9, lage: 'bred@A?notis=kommenterad', utfall: 'ROD', rader: [`FYND: bredd 375 kommentar: ${DOK}`] },
  { rad: 10, lage: 'bred@A?notis=arendet_rattat', utfall: 'ROD', rader: [`FYND: bredd 375 titel: ${DOK}`] },
  { rad: 11, lage: 'utan_formular@A/kommentar', utfall: 'ROD',
    rader: ['FYND: bredd 375 arendesidan: knappen i kommentaren saknas',
      'FYND: bredd 375 kommentar: kommentaren gick inte att skicka'] },
  { rad: 12, lage: 'utan_formular@A/ratta', utfall: 'ROD',
    rader: ['FYND: bredd 375 arendesidan: knappen i rattelsen saknas',
      'FYND: bredd 375 titel: titeln gick inte att skicka'] },
  { rad: 13, lage: 'utan_formular@A/ratta?handgrepp=tillstand', utfall: 'ROD',
    rader: ['FYND: bredd 375 arendesidan: knappen i tillstandet saknas'] },
  { rad: 14, lage: 'ingen_omdirigering@/vy/logga-in', utfall: 'ROD',
    rader: ['FYND: bredd 375 inloggning: inloggningen gav inte 303'] },
  { rad: 15, lage: 'ingen_omdirigering@A/kommentar', utfall: 'ROD',
    rader: ['FYND: bredd 375 kommentar: kommentaren gav inte 303'] },
  { rad: 16, lage: 'ingen_omdirigering@A/ratta', utfall: 'ROD',
    rader: ['FYND: bredd 375 titel: titeln gav inte 303'] },
  { rad: 17, lage: 'annan_plats@/vy/logga-in', utfall: 'ROD',
    rader: ['FYND: bredd 375 inloggning: inloggningen landade pa /vy'] },
  { rad: 18, lage: 'annan_plats@A/kommentar', utfall: 'ROD',
    rader: ['FYND: bredd 375 kommentar: kommentaren landade pa /vy'] },
  { rad: 19, lage: 'annan_plats@A/ratta', utfall: 'ROD', rader: ['FYND: bredd 375 titel: titeln landade pa /vy'] },
  { rad: 20, lage: 'utan_kvitto@A?notis=inloggad', utfall: 'ROD',
    rader: ['FYND: bredd 375 inloggning: inloggningen gav inget kvitto'] },
  { rad: 21, lage: 'utan_kvitto@A?notis=kommenterad', utfall: 'ROD',
    rader: ['FYND: bredd 375 kommentar: kommentaren gav inget kvitto'] },
  { rad: 22, lage: 'utan_kvitto@A?notis=arendet_rattat', utfall: 'ROD',
    rader: ['FYND: bredd 375 titel: titeln gav inget kvitto'] },
  { rad: 23, lage: 'utan_kaka', utfall: 'ROD', rader: ['FYND: bredd 375 inloggning: inloggningen gav ingen session'] },
  { rad: 24, lage: 'skicka_inte@A/kommentar', plats: 'A?notis=kommenterad', utfall: 'ROD',
    rader: ['FYND: bredd 375 kommentar: kommentaren gav 0 nya handelser'] },
  { rad: 25, lage: 'skicka_inte@A/ratta', plats: 'A?notis=arendet_rattat', utfall: 'ROD',
    rader: ['FYND: bredd 375 titel: titeln gav 0 nya handelser'] },
  { rad: 26, lage: 'normal', val: { handelser_fel: true }, utfall: 'KUNDE_INTE',
    rader: ['FEL: bredd 375 kommentar: handelserna gar inte att lasa: HTTPError'] },
  { rad: 27, lage: 'cdp_fel', utfall: 'KUNDE_INTE',
    rader: ['FEL: bredd 375 start: webblasaren svarade med fel pa Emulation.setDeviceMetricsOverride'] },
];

describe('FR-15/Story 10.9 AK 1, 2: stegföljden i 375 och 744 px och domen', () => {
  const aktor = { aktor_typ: 'manniska', aktor_namn: MANNISKA };
  const fyraRader = [{ verb: 'kommenterade', ...aktor }, { verb: 'andrade_titel', ...aktor },
    { verb: 'kommenterade', ...aktor }, { verb: 'andrade_titel', ...aktor }];
  const avbrutna = (bredd: number, steg: string[], efter: string): string[] =>
    steg.map((namn) => `bredd ${bredd} ${namn}: provades inte efter ${efter}`);

  it('F5 (AK 1, AK 2): (a) mot testservern ger GRON, fyra händelserader och ytans typsnitt före mätningarna', async () => {
    const u = await testhem();
    const fore = await handelserFor(provarende);
    const d = await korKor(u);
    expect(d).toEqual({ utfall: 'GRON', kod: 0, rader: [GRON_RAD,
      'bredd 375: sidor=8 skrivningar=3 fynd=0', 'bredd 744: sidor=8 skrivningar=3 fynd=0'] });
    expect(d.rader.join('\n')).not.toContain(provnyckel);
    expect(d.rader.join('\n')).not.toMatch(/Error|kunde inte/);
    expect((await handelserFor(provarende)).slice(fore.length)).toEqual(fyraRader);
    const typsnitt = (await hamtaLogg(u)).filter((rad) => rad.typsnitt !== undefined);
    expect(typsnitt.length).toBeGreaterThanOrEqual(5);
    expect(typsnitt.filter((rad) => !rad.typsnitt!.startsWith('/vy/typsnitt/') || rad.status !== 200)).toEqual([]);
  });

  it('F5 (AK 1, AK 2): (b) en yta där varje sida har ett 800 px brett element fälls (ROD)', async () => {
    const d = await korKor(await testhem(provnyckel, await nyFixturserver(true)));
    const bredd = (b: number): string[] => [
      `bredd ${b}: sidor=2 skrivningar=0 fynd=5`,
      `FYND: bredd ${b} laslage: dokumentet ar 800 px men fonstret ${b} px`,
      `FYND: bredd ${b} laslage: menyn gar inte att oppna`,
      `FYND: bredd ${b} inloggningssidan: dokumentet ar 800 px men fonstret ${b} px`,
      `FYND: bredd ${b} inloggningssidan: knappen i inloggningen saknas`,
      `FYND: bredd ${b} inloggning: inloggningen gick inte att skicka`,
      ...avbrutna(b, SEKVENS.slice(4), 'fynd'),
    ];
    expect(d).toEqual({ utfall: 'ROD', kod: 1, rader: [ROD_RAD, ...bredd(375), ...bredd(744)] });
  });

  it('F5 (AK 1, AK 2): (c) knappar utanför fönstret och (d) en meny som inte öppnas fälls', async () => {
    const fore = await handelserFor(provarende);
    const c = await korKor(await testhem(), 'knapp_utanfor');
    const knappar = (b: number): string[] => [
      `bredd ${b}: sidor=8 skrivningar=3 fynd=4`,
      `FYND: bredd ${b} inloggningssidan: knappen i inloggningen hamnar utanfor fonstret`,
      ...['kommentaren', 'rattelsen', 'tillstandet']
        .map((namn) => `FYND: bredd ${b} arendesidan: knappen i ${namn} hamnar utanfor fonstret`),
    ];
    expect(c).toEqual({ utfall: 'ROD', kod: 1, rader: [ROD_RAD, ...knappar(375), ...knappar(744)] });
    // Fyndet i inloggningssidan avbryter inte: skrivningarna ger sina fyra rader som i (a).
    expect((await handelserFor(provarende)).slice(fore.length)).toEqual(fyraRader);
    const d = await korKor(await testhem(), 'meny_stangd');
    const meny = (b: number): string[] => [`bredd ${b}: sidor=8 skrivningar=3 fynd=4`,
      ...['laslage', 'oversikt', 'mitt', 'arendesidan'].map((steg) => `FYND: bredd ${b} ${steg}: menyn gar inte att oppna`)];
    expect(d).toEqual({ utfall: 'ROD', kod: 1, rader: [ROD_RAD, ...meny(375), ...meny(744)] });
  });

  it('F5 (AK 2): (e)–(g) ett motprov som inte slår ut, en webbläsare som inte startar och en stängd port', async () => {
    const e = await korKor(await testhem(), 'smal');
    const motprov = (b: number): string[] => [`bredd ${b}: sidor=0 skrivningar=0 fynd=0`,
      `FEL: bredd ${b} motprov: motprovet slog inte ut`, ...avbrutna(b, SEKVENS.slice(1), 'fel')];
    expect(e).toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [KUNDE_INTE_RAD, ...motprov(375), ...motprov(744)] });
    const f = await korKor(await testhem(), 'startar_inte');
    expect({ utfall: f.utfall, kod: f.kod, forsta: f.rader[0] })
      .toEqual({ utfall: 'KUNDE_INTE', kod: 2, forsta: KUNDE_INTE_RAD });
    expect(fyndOchFel(f)).toEqual([375, 744].map((b) => `FEL: bredd ${b} start: webblasaren startar inte: EOFError`));
    const g = await korKor(await testhem(provnyckel, await stangdPort()));
    expect(g.utfall).toBe('KUNDE_INTE');
    expect(fyndOchFel(g)).toEqual([375, 744]
      .map((b) => `FEL: bredd ${b} laslage: sidan nas inte: ${A} (net::ERR_CONNECTION_REFUSED)`));
  });

  it('F5 (AK 2): (h)–(j) konfigurationen saknas, provnyckeln godtas inte och ärendet finns inte', async () => {
    expect(await korKor(await nyttHem())).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: [KUNDE_INTE_RAD, 'FEL: konfigurationen: FileNotFoundError'] });
    const fore = await handelserFor(provarende);
    const i = await korKor(await testhem(hermes));
    expect(i.utfall).toBe('KUNDE_INTE');
    expect(fyndOchFel(i)).toEqual([375, 744].map((b) => `FEL: bredd ${b} inloggning: provnyckeln godtogs inte`));
    expect(await handelserFor(provarende)).toEqual(fore);
    const j = await korKor(await testhem(provnyckel, TESTBAS, SAKNAT_ARENDE));
    expect(j.utfall).toBe('KUNDE_INTE');
    expect(fyndOchFel(j)).toEqual([375, 744]
      .map((b) => `FEL: bredd ${b} laslage: sidan nas inte: /vy/arende/${SAKNAT_ARENDE} (status 404)`));
  });

  it('F5 (AK 2): (k) domen prövar fel först, fynd sedan och GRON sist', async () => {
    const u = await nyttHem();
    const doma = async (konfigfel: string | null, bredder: Breddutfall[]): Promise<Dom> =>
      korJson<Dom>(u, 'doma', { konfigfel, bredder });
    const fyndrad = `FYND: bredd 375 laslage: ${DOK}`;
    const medFynd: Breddutfall = { bredd: 375, fynd: [['laslage', DOK]], fel: [],
      rader: ['bredd 375: sidor=8 skrivningar=3 fynd=1', fyndrad] };
    const medFel: Breddutfall = { bredd: 744, fynd: [], fel: [['mitt', '1 typsnitt laddades inte']],
      rader: ['bredd 744: sidor=5 skrivningar=1 fynd=0', 'FEL: bredd 744 mitt: 1 typsnitt laddades inte'] };
    const ren: Breddutfall = { bredd: 744, fynd: [], fel: [], rader: ['bredd 744: sidor=8 skrivningar=3 fynd=0'] };
    expect(await doma(null, [medFynd, medFel])).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: [KUNDE_INTE_RAD, ...medFynd.rader, ...medFel.rader] });
    expect(await doma(null, [medFynd, ren])).toEqual({ utfall: 'ROD', kod: 1,
      rader: [ROD_RAD, ...medFynd.rader, ...ren.rader] });
    expect(await doma(null, [ren])).toEqual({ utfall: 'GRON', kod: 0, rader: [GRON_RAD, ...ren.rader] });
    expect(await doma(null, [])).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: [KUNDE_INTE_RAD, 'FEL: inga bredder provades'] });
    expect(await doma('FileNotFoundError', [medFynd])).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: [KUNDE_INTE_RAD, 'FEL: konfigurationen: FileNotFoundError', ...medFynd.rader] });
  });

  for (const fall of STEGFALL) {
    const namn = `${fall.lage}${fall.val?.handelser_fel ? ' med valet handelser_fel' : ''}`;
    it(`F5 (AK 1, AK 2): (l) rad ${fall.rad}, ${namn}, ger ${fall.utfall}`, async () => {
      const lage = fall.lage.replaceAll('@A', `@${A}`);
      const plats = fall.plats === undefined ? '/vy' : fall.plats.replace(/^A/, A);
      const d = await korKor(await testhem(), lage, { bara375: true, ...fall.val }, plats);
      expect({ utfall: d.utfall, kod: d.kod, forsta: d.rader[0] })
        .toEqual({ utfall: fall.utfall, kod: UTFALL[fall.utfall], forsta: FORSTA_RAD[fall.utfall] });
      expect(fyndOchFel(d)).toEqual(fall.rader);
      // Kontrollen, rad 0: samma körning i läget normal ger GRON med åtta sidor och tre skrivningar.
      if (fall.rad === 0) expect(d.rader).toEqual([GRON_RAD, 'bredd 375: sidor=8 skrivningar=3 fynd=0']);
    });
  }

  // Omtaget efter rad 18: titeln skickades på sidan som kommentaren lämnade, så en kommentar som landade på en
  // annan sida fällde också titeln. Felklassen är ett steg som beror på var steget före slutade. Varje skrivning
  // öppnar därför sin egen sida, som varje sidsteg redan gör, och fallen nedan fäller klassen för alla tre.
  it('F5 (AK 1): (l) varje skrivning öppnar sin egen sida närmast före sitt skicka', async () => {
    const u = await testhem();
    const d = await korKor(u, 'normal', { bara375: true });
    expect(d.utfall).toBe('GRON');
    const anrop = (await hamtaLogg(u)).filter((rad) => rad.method !== undefined);
    // Adressen som navigerades till närmast före varje skicka, eller null när ett annat anrop stod där.
    const sidorForeSkicka = (lista: Loggrad[]): (string | null)[] => lista.flatMap((rad, i) => {
      if (rad.method !== 'Runtime.evaluate' || rad.skript !== 'skicka') return [];
      const fore = lista[i - 1];
      return [fore?.method === 'Page.navigate' ? String(fore.params?.['url']) : null];
    });
    const vantade = [`${TESTBAS}/vy/logga-in?fran=${encodeURIComponent(A)}`, `${TESTBAS}${A}`, `${TESTBAS}${A}`];
    expect(sidorForeSkicka(anrop)).toEqual(vantade);
    // Kontroll: utan navigeringen före titelns skicka slår prövningen ut.
    const sista = anrop.map((rad) => rad.method).lastIndexOf('Page.navigate');
    expect(sidorForeSkicka(anrop.filter((_, i) => i !== sista))).not.toEqual(vantade);
  });

  // Steget före landar på en annan sida ur ytan, eller skickar inte, och skrivningen efter går ändå att skicka:
  // titeln ger sin händelserad och skrivningar=3. Raderna är FYND och FEL i ordning; verb är de nya raderna.
  const EGEN_SIDA: { lage: string; plats: string; rader: string[]; verb: string[] }[] = [
    { lage: 'annan_plats@A/kommentar', plats: '/vy/mitt',
      rader: ['FYND: bredd 375 kommentar: kommentaren landade pa /vy/mitt'], verb: ['kommenterade', 'andrade_titel'] },
    { lage: 'annan_plats@A/kommentar+annan_plats@A/ratta', plats: '/vy/mitt',
      rader: ['FYND: bredd 375 kommentar: kommentaren landade pa /vy/mitt',
        'FYND: bredd 375 titel: titeln landade pa /vy/mitt'], verb: ['kommenterade', 'andrade_titel'] },
    { lage: 'skicka_inte@A/kommentar', plats: '/vy',
      rader: ['FYND: bredd 375 kommentar: kommentaren landade pa /vy'], verb: ['andrade_titel'] },
  ];
  for (const fall of EGEN_SIDA) {
    it(`F5 (AK 1): (l) ${fall.lage} med platsen ${fall.plats}: skrivningen efter går ändå att skicka`, async () => {
      const fore = await handelserFor(provarende);
      const d = await korKor(await testhem(), fall.lage.replaceAll('@A', `@${A}`), { bara375: true }, fall.plats);
      expect({ utfall: d.utfall, summa: d.rader[1] }).toEqual({ utfall: 'ROD',
        summa: `bredd 375: sidor=8 skrivningar=3 fynd=${fall.rader.length}` });
      expect(fyndOchFel(d)).toEqual(fall.rader);
      expect((await handelserFor(provarende)).slice(fore.length).map((h) => h.verb)).toEqual(fall.verb);
    });
  }

  // Omtag 2, felklassen: en gren i stegen som inget fall framkallar. Omtag 1 gav skrivningarna en egen navigering,
  // och felet «sidan nas inte: …» kunde då komma ur inloggningen, kommentaren och titeln utan att något fall visade
  // det. Tabellen har ett fall per gren i stegen: navigeringen i varje steg mot en stängd port, motprovets fel,
  // händelserna som inte går att läsa före och efter varje skrivning, mätningens fel efter varje skrivning,
  // mätningen sist i varje sidsteg, efter menyn och knapparna, och en menypanel eller knapp som inte ritas.
  // Raderna är hela utskriften efter domens rad, och verb är ärendets nya händelserader. {A} står för ärendesidan
  // och {L} för inloggningssidan med fran; stangt är steget vars bas byts mot en stängd port.
  interface Grenfall {
    namn: string; lage?: string; val?: Korval; stangt?: string; motprov?: boolean; utfall: string;
    rader: (a: string, l: string) => string[]; verb: string[];
  }
  const summa = (sidor: number, skrivningar: number, fynd: number): string =>
    `bredd 375: sidor=${sidor} skrivningar=${skrivningar} fynd=${fynd}`;
  const nasInte = (sokvag: string): string => `sidan nas inte: ${sokvag} (net::ERR_CONNECTION_REFUSED)`;
  const efterFel = (steg: string): string[] => avbrutna(375, SEKVENS.slice(SEKVENS.indexOf(steg) + 1), 'fel');
  const FONSTER = 'fonstret fick inte bredden 375';
  const LASFEL = 'handelserna gar inte att lasa: HTTPError';
  const BADA = ['kommenterade', 'andrade_titel'];
  const GRENFALL: Grenfall[] = [
    { namn: 'motprovet nås inte', motprov: true, utfall: 'KUNDE_INTE', verb: [],
      rader: () => [summa(0, 0, 0), `FEL: bredd 375 motprov: ${nasInte('/')}`, ...efterFel('motprov')] },
    { namn: 'läsläget nås inte', stangt: 'laslage', utfall: 'KUNDE_INTE', verb: [],
      rader: (a) => [summa(0, 0, 0), `FEL: bredd 375 laslage: ${nasInte(a)}`, ...efterFel('laslage')] },
    { namn: 'inloggningssidan nås inte', stangt: 'inloggningssidan', utfall: 'KUNDE_INTE', verb: [],
      rader: (_a, l) => [summa(1, 0, 0), `FEL: bredd 375 inloggningssidan: ${nasInte(l)}`,
        ...efterFel('inloggningssidan')] },
    { namn: 'inloggningens egen sida nås inte', stangt: 'inloggning', utfall: 'KUNDE_INTE', verb: [],
      rader: (_a, l) => [summa(2, 0, 0), `FEL: bredd 375 inloggning: ${nasInte(l)}`, ...efterFel('inloggning')] },
    { namn: 'översikten nås inte', stangt: 'oversikt', utfall: 'KUNDE_INTE', verb: [],
      rader: () => [summa(3, 1, 0), `FEL: bredd 375 oversikt: ${nasInte('/vy')}`, ...efterFel('oversikt')] },
    { namn: 'mitt nås inte', stangt: 'mitt', utfall: 'KUNDE_INTE', verb: [],
      rader: () => [summa(4, 1, 0), `FEL: bredd 375 mitt: ${nasInte('/vy/mitt')}`, ...efterFel('mitt')] },
    { namn: 'ärendesidan nås inte', stangt: 'arendesidan', utfall: 'KUNDE_INTE', verb: [],
      rader: (a) => [summa(5, 1, 0), `FEL: bredd 375 arendesidan: ${nasInte(a)}`, ...efterFel('arendesidan')] },
    { namn: 'kommentarens egen sida nås inte', stangt: 'kommentar', utfall: 'KUNDE_INTE', verb: [],
      rader: (a) => [summa(6, 1, 0), `FEL: bredd 375 kommentar: ${nasInte(a)}`, ...efterFel('kommentar')] },
    { namn: 'titelns egen sida nås inte', stangt: 'titel', utfall: 'KUNDE_INTE', verb: ['kommenterade'],
      rader: (a) => [summa(7, 2, 0), `FEL: bredd 375 titel: ${nasInte(a)}`] },
    { namn: 'händelserna efter kommentaren går inte att läsa', val: { handelser_fel_vid: 2 }, utfall: 'KUNDE_INTE',
      verb: ['kommenterade'], rader: () => [summa(7, 2, 0), `FEL: bredd 375 kommentar: ${LASFEL}`,
        ...efterFel('kommentar')] },
    { namn: 'händelserna före titeln går inte att läsa', val: { handelser_fel_vid: 3 }, utfall: 'KUNDE_INTE',
      verb: ['kommenterade'], rader: () => [summa(7, 2, 0), `FEL: bredd 375 titel: ${LASFEL}`] },
    { namn: 'händelserna efter titeln går inte att läsa', val: { handelser_fel_vid: 4 }, utfall: 'KUNDE_INTE',
      verb: BADA, rader: () => [summa(8, 3, 0), `FEL: bredd 375 titel: ${LASFEL}`] },
    { namn: 'motprovets fönster', lage: 'fonster_fel', utfall: 'KUNDE_INTE', verb: [],
      rader: () => [summa(0, 0, 0), `FEL: bredd 375 motprov: ${FONSTER}`, ...efterFel('motprov')] },
    { namn: 'fönstret efter inloggningen', lage: 'fonster_fel@{A}?notis=inloggad', utfall: 'KUNDE_INTE', verb: [],
      rader: () => [summa(3, 1, 0), `FEL: bredd 375 inloggning: ${FONSTER}`, ...efterFel('inloggning')] },
    { namn: 'typsnitten efter kommentaren', lage: 'typsnitt_saknas@{A}?notis=kommenterad', utfall: 'KUNDE_INTE',
      verb: ['kommenterade'], rader: () => [summa(7, 2, 0), 'FEL: bredd 375 kommentar: 1 typsnitt laddades inte',
        ...efterFel('kommentar')] },
    { namn: 'mätningens fel före händelsernas efter kommentaren', lage: 'typsnitt_saknas@{A}?notis=kommenterad',
      val: { handelser_fel_vid: 2 }, utfall: 'KUNDE_INTE', verb: ['kommenterade'],
      rader: () => [summa(7, 2, 0), 'FEL: bredd 375 kommentar: 1 typsnitt laddades inte', ...efterFel('kommentar')] },
    { namn: 'fönstret efter titeln', lage: 'fonster_fel@{A}?notis=arendet_rattat', utfall: 'KUNDE_INTE', verb: BADA,
      rader: () => [summa(8, 3, 0), `FEL: bredd 375 titel: ${FONSTER}`] },
    { namn: 'översikten blir bred när menyn öppnats', lage: 'bred_efter_oppning@/vy', utfall: 'ROD', verb: BADA,
      rader: () => [summa(8, 3, 1), `FYND: bredd 375 oversikt: ${DOK}`] },
    { namn: 'ärendesidan blir bred när menyn och knapparna öppnats', lage: 'bred_efter_oppning@{A}', utfall: 'ROD',
      verb: BADA, rader: () => [summa(8, 3, 2), `FYND: bredd 375 laslage: ${DOK}`,
        `FYND: bredd 375 arendesidan: ${DOK}`] },
    { namn: 'inloggningssidan blir bred när knapparna öppnats', lage: 'bred_efter_oppning@{L}', utfall: 'ROD',
      verb: BADA, rader: () => [summa(8, 3, 1), `FYND: bredd 375 inloggningssidan: ${DOK}`] },
    { namn: 'fönstret efter menyn', lage: 'fonster_fel_efter_oppning@/vy', utfall: 'KUNDE_INTE', verb: [],
      rader: () => [summa(4, 1, 0), `FEL: bredd 375 oversikt: ${FONSTER}`, ...efterFel('oversikt')] },
    { namn: 'fyndet före menyn står kvar med felet efter den', lage: 'bred@/vy+fonster_fel_efter_oppning@/vy',
      utfall: 'KUNDE_INTE', verb: [], rader: () => [summa(4, 1, 1), `FYND: bredd 375 oversikt: ${DOK}`,
        `FEL: bredd 375 oversikt: ${FONSTER}`, ...efterFel('oversikt')] },
    { namn: 'menypanelen ritas inte', lage: 'meny_dold@/vy', utfall: 'ROD', verb: BADA,
      rader: () => [summa(8, 3, 1), 'FYND: bredd 375 oversikt: menyn gar inte att oppna'] },
    { namn: 'inloggningens knapp ritas inte', lage: 'knapp_dold@/vy/logga-in', utfall: 'ROD', verb: BADA,
      rader: () => [summa(8, 3, 1), 'FYND: bredd 375 inloggningssidan: knappen i inloggningen saknas'] },
    { namn: 'tillståndets knapp ritas inte', lage: 'knapp_dold@{A}/ratta?handgrepp=tillstand', utfall: 'ROD',
      verb: BADA, rader: () => [summa(8, 3, 1), 'FYND: bredd 375 arendesidan: knappen i tillstandet saknas'] },
  ];
  for (const fall of GRENFALL) {
    it(`F5 (AK 1, AK 2): (l) grenen «${fall.namn}» ger ${fall.utfall}`, async () => {
      const L = `/vy/logga-in?fran=${encodeURIComponent(A)}`;
      const lage = (fall.lage ?? 'normal').replaceAll('{A}', A).replaceAll('{L}', L);
      const stangd = fall.stangt !== undefined || fall.motprov === true ? await stangdPort() : '';
      const val: Korval = { bara375: true, ...fall.val };
      if (fall.stangt !== undefined) val.stangd = { steg: fall.stangt, bas: stangd };
      if (fall.motprov === true) val.motprov = `${stangd}/`;
      const fore = await handelserFor(provarende);
      const d = await korKor(await testhem(), lage, val);
      expect(d).toEqual({ utfall: fall.utfall, kod: UTFALL[fall.utfall],
        rader: [FORSTA_RAD[fall.utfall], ...fall.rader(A, L)] });
      expect((await handelserFor(provarende)).slice(fore.length).map((h) => h.verb)).toEqual(fall.verb);
    });
  }
});

/**
 * Modulerna som en Python-text importerar (F8 (c)). Varje sats läses, också indragna satser, flera namn med komma
 * och as, en kommentar efter satsen, satser efter semikolon eller kolon och satser över en fortsättningsrad. En
 * dynamisk import (__import__, importlib, exec, eval) ger sitt eget namn, som aldrig står i tillåtelselistan.
 */
function importer(text: string): string[] {
  const namn: string[] = [];
  for (const sats of text.replace(/\\\r?\n/g, ' ').split(/\r?\n|;|:/)) {
    const fran = /^\s*from\s+(\S+)\s+import\b/.exec(sats);
    const imp = /^\s*import\s+(.+)$/.exec(sats);
    if (fran !== null) {
      namn.push(fran[1]!);
    } else if (imp !== null) {
      namn.push(...imp[1]!.split('#')[0]!.split(',')
        .map((del) => del.replace(/\s+as\s+\w+\s*$/, '').replace(/[()]/g, '').trim()));
    }
  }
  return [...namn, ...[...text.matchAll(/\b(__import__|importlib|exec|eval)\b/g)].map((m) => m[1]!)];
}
function otillatnaImporter(text: string): string[] {
  return importer(text).filter((namn) => !STDLIB_TILLATNA.includes(namn));
}

describe('FR-15/Story 10.9 AK 2, 3: skriptet och repot', () => {
  it('F6 (AK 2): tre utfall med var sin exitkod', async () => {
    const a = await korProvet(await testhem());
    expect({ kod: a.kod, forsta: rader(a.ut)[0], fel: a.fel }).toEqual({ kod: 0, forsta: GRON_RAD, fel: '' });
    const b = await korProvet(await testhem(provnyckel, await nyFixturserver(true)));
    expect({ kod: b.kod, forsta: rader(b.ut)[0] }).toEqual({ kod: 1, forsta: ROD_RAD });
    const c = await korProvet(await nyttHem());
    expect({ kod: c.kod, forsta: rader(c.ut)[0] }).toEqual({ kod: 2, forsta: KUNDE_INTE_RAD });
    const koderna = [a.kod, b.kod, c.kod];
    expect(koderna).toEqual([0, 1, 2]);
    expect(new Set(koderna).size).toBe(3);
  });

  it('F7 (AK 2): ett anrop som inte går att tolka och en krasch ger KUNDE_INTE och kod 2', async () => {
    // (a) Kontrollen är F6 (c), skild bara i argumentet.
    const u = await nyttHem();
    const a = await korProvet(u, ['x']);
    expect({ kod: a.kod, rader: rader(a.ut) }).toEqual({ kod: 2, rader: [ANROPSRAD] });
    // (b) kor byts mot en funktion som kastar, och huvud([]) gör kraschen till KUNDE_INTE.
    const b = await korDrivern(u, ['krasch']);
    expect({ kod: b.kod, rader: rader(b.ut) })
      .toEqual({ kod: 2, rader: ['KUNDE_INTE: mobilprovet stannade: RuntimeError'] });
  });

  it('F8 (AK 3): repot rörs inte: namnet, beroendena, importerna och inget kvar efter körningarna', async () => {
    // (a) Modulen förs in under kanalens prov_prefix arende. Kontroll: ett annat namn slår ut.
    const inforbar = (namn: string): boolean => namn === 'arende_mobilprov.py' && namn.startsWith('arende');
    expect(inforbar(path.basename(MODULEN))).toBe(true);
    expect(inforbar('mobilprov.py')).toBe(false);
    // (b) Inga nya beroenden; bara nycklarna jämförs. Kontroll: en tillagd nyckel slår ut.
    type Paket = { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const paket = JSON.parse(await readFile(path.join(ROT, 'package.json'), 'utf8')) as Paket;
    const nycklar = (p: Paket): string[][] =>
      [Object.keys(p.dependencies).sort(), Object.keys(p.devDependencies).sort()];
    const VANTADE = [['dotenv', 'express', 'express-rate-limit', 'helmet', 'pg', 'zod'],
      ['@types/express', '@types/node', '@types/pg', '@types/supertest', 'supertest', 'tsx', 'typescript', 'vitest']];
    expect(nycklar(paket)).toEqual(VANTADE);
    expect(nycklar({ ...paket, devDependencies: { ...paket.devDependencies, playwright: '^1.0.0' } }))
      .not.toEqual(VANTADE);
    // (c) Bara standardbiblioteket i modulen och attrappen. Kontroll: en import utanför listan ger en träff.
    for (const fil of [MODULEN, ATTRAPPEN]) {
      const text = await readFile(fil, 'utf8');
      expect(importer(text).length, fil).toBeGreaterThan(0);
      expect(otillatnaImporter(text), fil).toEqual([]);
    }
    expect(otillatnaImporter('import json\nimport requests\n')).toEqual(['requests']);
    // (d) Egna körningar med F6 (a):s och F6 (c):s konfigurationer: adapter/ är oförändrad och ingen profil
    //     står kvar, också efter KUNDE_INTE. Kontroll: ett tillagt namn slår ut i båda jämförelserna.
    const fore = (await readdir(ADAPTERN)).sort();
    const gron = await testhem();
    const tom = await nyttHem();
    expect([(await korProvet(gron)).kod, (await korProvet(tom)).kod]).toEqual([0, 2]);
    const efter = (await readdir(ADAPTERN)).sort();
    expect(efter).toEqual(fore);
    expect([...efter, '__pycache__'].sort()).not.toEqual(fore);
    const kvar = (namn: string[]): boolean => namn.some((n) => n.startsWith(PROFILPREFIX));
    expect([kvar(await readdir(gron.tmp)), kvar(await readdir(tom.tmp))]).toEqual([false, false]);
    expect(kvar([...await readdir(gron.tmp), `${PROFILPREFIX}kvar`])).toBe(true);
  });

  // Omtag 2, felklassen: importläsaren såg bara det första namnet på en rad som börjar i vänsterkanten, så
  // «import json, requests» och en indragen import gick igenom. Varje form av import ger nu sin träff.
  it('F8 (AK 3): (c) importläsaren ser varje form av import, också indragen, flera på en rad och dynamisk', () => {
    const FORMER: [string, string[]][] = [
      ['import json, requests\n', ['requests']],
      ['def f():\n    import requests\n', ['requests']],
      ['import json as j, requests as r\n', ['requests']],
      ['import json  # en kommentar\nimport requests  # en till\n', ['requests']],
      ['import json; import requests\n', ['requests']],
      ['x = 1; import requests\n', ['requests']],
      ['if True: import requests\n', ['requests']],
      ['try:\n    from requests import get\nexcept ImportError:\n    pass\n', ['requests']],
      ['import json, \\\n    requests\n', ['requests']],
      ['from requests.adapters import (HTTPAdapter,\n    Retry)\n', ['requests.adapters']],
      ['from . import grannen\n', ['.']],
      ['modul = __import__("requests")\n', ['__import__']],
      ['modul = importlib.import_module("requests")\n', ['importlib']],
      ['exec("import requests")\n', ['exec']],
    ];
    for (const [text, vantat] of FORMER) expect(otillatnaImporter(text), text).toEqual(vantat);
    // Kontrollen: tillåtna moduler i samma former ger ingen träff.
    expect(otillatnaImporter('import json, os as o\n    import re\nfrom urllib import parse; import sys\n' +
      'from json import (loads,\n    dumps)\nimport time, \\\n    typing\nif True: import shutil\n')).toEqual([]);
  });
});
