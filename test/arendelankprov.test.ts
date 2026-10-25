// D-5, D-2, B-21 (mätningen i två steg), B-17 Tre utfall, Story 11.7: det stående länkprovet
// adapter/arendelankar.py. Modulen följer varje ärendelänk på appens fyra startsidor, ytans Din insats
// och Gå igenom, fältet lank i list_issues och list_insatser och varje ärendesida som nås därifrån, och
// kräver 200 efter högst en 308. Fallen F1–F8 kör modulen i en barnprocess mot provets egna servrar på
// loopback och mot en stängd port. Barnprocessen får ett eget hem i tmpdir(): ~/.hermes, provvakten,
// ytan och driften läses aldrig. Införandet som prov i drift sker utanför bygget (förkrav i drift).
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { ARENDEPREFIX } from '../src/lib/arendelank.js';
import { TEST_VY_PUBLIK_URL } from './env.js';
import { kor, nyNyckel, raknaRader } from './helpers.js';

// Barnprocess, drivrutin och städning: test/linearvakt.test.ts; stängd port: test/placeringslasning.test.ts.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const MODULEN = path.join(ADAPTERN, 'arendelankar.py');
const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));
const VARD = '127.0.0.1';
const P = TEST_VY_PUBLIK_URL;

interface Underlag { hem: string; konfig: string; nyckelfil: string }
interface Processutfall { kod: number; ut: string; fel: string }
interface Konfigutfall {
  app: string | null; yta: string | null; publik: string | null; sokord: string | null;
  ga_igenom: string | null; nyckel_ratt: boolean; fel: string | null;
}

function barnmiljo(u: Underlag): NodeJS.ProcessEnv {
  // Hela miljön är en tillåtelselista: test/env.ts, proxyvariabler och riktiga HOME får inte läcka in.
  return { PATH: process.env.PATH, HOME: u.hem };
}
async function skriv(fil: string, innehall: string): Promise<void> {
  await writeFile(fil, innehall);
}
async function stang(server: Server): Promise<void> {
  await new Promise<void>((klar, fel) => server.close((err) => err ? fel(err) : klar()));
}
async function lyssna(server: Server): Promise<string> {
  server.listen(0, VARD);
  await new Promise<void>((klar) => server.once('listening', klar));
  return `http://${VARD}:${(server.address() as { port: number }).port}`;
}
/** En port som provet just lyssnat på och stängt: en hämtning dit får inget svar. */
async function stangdPort(): Promise<string> {
  const server = createServer((_req, res) => { res.end(); });
  const bas = await lyssna(server);
  await stang(server);
  return bas;
}

// Fixturservern är en egen server på loopback som modulen läser på riktigt, ingen mock. Varje begäran
// loggas med metod och sökväg, så att fallen visar vad som hämtas och att bara GET görs.
const fixturanrop: string[] = [];
let fixturserver: Server | undefined;
let stangdBas = '';
function fixtursvar(req: IncomingMessage, res: ServerResponse): void {
  const sokvag = req.url ?? '';
  fixturanrop.push(`${req.method ?? ''} ${sokvag}`);
  req.resume();
  const sidan = (status: number, kropp: string): void => {
    res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><body>${kropp}</body></html>`);
  };
  const flytt = (plats: string | null): void => {
    res.writeHead(308, plats === null ? {} : { Location: plats });
    res.end();
  };
  if (sokvag === '/ok') sidan(200, '<p>ok</p>');
  else if (sokvag === '/flytt') flytt('/ok');
  else if (sokvag === '/flytt-saknas') flytt('/saknas');
  else if (sokvag === '/flytt-flytt') flytt('/flytt');
  else if (sokvag === '/flytt-utan') flytt(null);
  else if (sokvag === '/flytt-bort') flytt(`${stangdBas}/ok`);
  else if (sokvag === '/fel') sidan(500, '<p>fel</p>');
  // inloggning: Din insats kräver inloggning och skickar vidare (Frågor till David, punkt 1).
  else if (sokvag === '/beslut' && ytlage === 'inloggning') {
    res.writeHead(302, { Location: '/logga-in' });
    res.end();
  } else if (sokvag === '/beslut') sidan(200, dinInsats());
  else if (sokvag === '/ga-igenom') sidan(200, gaIgenom());
  // bruten: förbindelsen bryts innan något svar skrivs.
  else if (sokvag.startsWith(ARENDEPREFIX) && ytlage === 'bruten') req.socket.destroy();
  else if (sokvag.startsWith(ARENDEPREFIX)) sidan(ytlage === 'yta500' ? 500 : 404, '<p>ytans ärendesida</p>');
  else sidan(404, '<p>saknas</p>');
}

// Ytans fixturkopia: Din insats och Gå igenom i kortformen, styrda av ytlage. I drift läses ytans egen
// server (förkrav i drift); kopian visar mätningens väg och domen, inte ytans markup.
type Ytlage = 'normal' | 'saknas' | 'heltal' | 'yta500' | 'uppfoljning' | 'annat_ursprung' | 'utan_lankar'
  | 'inloggning' | 'bruten' | 'etikett_utanfor' | 'andra_kort' | 'utan_etikett' | 'fientlig';
let ytlage: Ytlage = 'normal';
// fientlig: värden utifrån som en rå utskrift hade delat i två rader, eller låtit bära ett Python-felnamn
// eller orden «kunde inte». Varje ärendelänk svarar 404, så utfallet är ROD. Den andra länken har ett annat
// schema än ytans sida, så urljoin lämnar den rå, med radbrytningen kvar.
const FIENTLIGA_LANKAR = [
  `${ARENDEPREFIX}LOC-88?fel=ValueError`,
  `${P}${ARENDEPREFIX}LOC-9999\n9`,
  `${P.replace('https://', 'https://kunde inte@')}${ARENDEPREFIX}LOC-99998`,
];
const FIENTLIGT_KORT = '/uppfoljning\nFEL: KeyError, kunde inte ö';
function dinInsats(): string {
  // andra_kort: korten har id som plattformen inte har.
  const id = (insats: Insatspar, n: number): string => ytlage === 'andra_kort' ? `okand-${n}` : insats.id;
  const forstaHref = ytlage === 'uppfoljning' ? '/uppfoljning' : ytlage === 'fientlig' ? FIENTLIGT_KORT : A.lank ?? '';
  const kort: [string, string][] = [
    [id(A, 1), forstaHref],
    [id(B, 2), '/uppfoljning'],
    [id(C, 3), C.lank ?? ''],
  ];
  // utan_etikett: A:s kort saknar etiketten. etikett_utanfor: en etikett står före det första kortet.
  const sida = kort.map(([kortid, href], i) => i === 0 && ytlage === 'utan_etikett'
    ? kortHtml(kortid, lank(href)) : kortHtml(kortid, ETIKETTRAD, lank(href))).join('');
  return (ytlage === 'etikett_utanfor' ? ETIKETTRAD : '') + sida;
}
function gaIgenom(): string {
  if (ytlage === 'utan_lankar') return '<a href="/beslut">Din insats</a>';
  if (ytlage === 'fientlig') return [A.lank ?? '', ...FIENTLIGA_LANKAR].map(lank).join('');
  const extra: Partial<Record<Ytlage, string>> = {
    saknas: `${P}${ARENDEPREFIX}LOC-99999`,
    heltal: `${P}${ARENDEPREFIX}LOC-99999999999`,
    yta500: `${ARENDEPREFIX}LOC-88`,
    annat_ursprung: `https://annan.invalid${ARENDEPREFIX}LOC-88`,
    bruten: `${ARENDEPREFIX}LOC-88`,
  };
  const tillagd = extra[ytlage];
  return lank(A.lank ?? '') + (tillagd === undefined ? '' : lank(tillagd));
}

// Testservern är appen ur createApp() mot testdatabasen (test/env.ts sätter den med =). Lyssnaren
// loggar metod och sökväg för varje begäran från modulen innan appen tar den. Fixturdatans egna
// anrop går genom supertest direkt till appen och syns inte i loggen.
let app: ReturnType<typeof createApp>;
let testserver: Server | undefined;
const appanrop: string[] = [];
let agent = '';
let foralder = '';
let andra = '';
interface Insatspar { id: string; lank: string | null }
let A: Insatspar = { id: '', lank: null };
let B: Insatspar = { id: '', lank: null };
let C: Insatspar = { id: '', lank: null };

/** Ett anrop som MÅSTE lyckas (som i test/arendelankar.test.ts). */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}
function registreraInsats(stopp: string, identifier: string | null) {
  // Samma fält som i test/arendelankar.test.ts, med eget stopp_id och egen källa, och underlaget
  // /uppfoljning lagrat: läsningen härleder underlaget och lank ur ärendet (Story 11.3).
  return steg(agent, 'registrera_insats', {
    stopp_id: `arendelankprov-${stopp}`,
    typ: 'agarbeslut',
    tillhor: 'agare',
    utfall: 'Riktningen är vald och arbetet kan fortsätta',
    begard_handling: 'Välj mellan A och B',
    blockeringsgrund: 'Tidigare besked avgör inte valet',
    handlingskontrakt: { system: 'hermes', kommando: 'beslutskoe --besvara', objekt: '#153', underlag: '/uppfoljning' },
    kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: `arendelankprov-${stopp}` }],
    ...(identifier === null ? {} : { identifier }),
  });
}

// Baserna och nyckeln sätts av filnivåns beforeAll innan något fall körs. F1 hämtar ingenting, så
// konfigurationens fall håller för varje loopbackbas och varje nyckel. Den stängda porten tas efter
// att servrarna lyssnar, så att den inte kan vara en servers port.
let appBas = '';
let ytBas = '';
let provetsNyckel = '';
beforeAll(async () => {
  fixturserver = createServer(fixtursvar);
  ytBas = await lyssna(fixturserver);
  app = createApp();
  testserver = createServer((req, res) => {
    appanrop.push(`${req.method ?? ''} ${req.url ?? ''}`);
    app(req, res);
  });
  appBas = await lyssna(testserver);
  stangdBas = await stangdPort();

  // Teamet LOC, LOC-316, LOC-329 och LOC-88 skapas av importen. Ingen action skriver på dem, så att
  // /vy/mitt utan session har dem i högen «Ingen har rört dem» (test/arendelankar.test.ts rad 18–19).
  await importeraArkiv(FIXTURER);
  agent = await nyNyckel({ typ: 'agent', namn: 'arendelankprov-fixtur' });
  provetsNyckel = await nyNyckel({ typ: 'agent', namn: 'arendelankar' });
  foralder = (await steg(agent, 'create_issue', { title: 'Länkprovets förälder', team_key: 'LOC' }))
    .identifier as string;
  andra = (await steg(agent, 'create_issue', { title: 'Länkprovets andra ärende', team_key: 'LOC' }))
    .identifier as string;
  // Kommentaren ger ärendesidan ärendelänkar, också i gemener.
  await steg(agent, 'add_comment', { identifier: foralder, body: 'Hänger ihop med LOC-88 och loc-316.' });
  await registreraInsats('a', foralder);
  await registreraInsats('b', null);
  await registreraInsats('c', andra);
  const insatser = (await steg(agent, 'list_insatser', {})) as { id: string; stopp_id: string; lank: string | null }[];
  const insats = (stopp: string): Insatspar => {
    const i = insatser.find((x) => x.stopp_id === `arendelankprov-${stopp}`);
    if (!i) throw new Error(`insatsen ${stopp} saknas i list_insatser`);
    return { id: i.id, lank: i.lank };
  };
  A = insats('a');
  B = insats('b');
  C = insats('c');
});
afterAll(async () => {
  if (fixturserver) await stang(fixturserver);
  if (testserver) await stang(testserver);
});

const hemkataloger: string[] = [];
async function nyttHem(): Promise<Underlag> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-arendelankprov-'));
  hemkataloger.push(hem);
  await mkdir(path.join(hem, '.hermes'));
  const u = { hem, konfig: path.join(hem, '.hermes', 'arendelankar.json'),
    nyckelfil: path.join(hem, 'arenden-nyckel') };
  await writeFile(u.nyckelfil, provetsNyckel, { mode: 0o600 });
  return u;
}
afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

function standardKonfig(u: Underlag): Record<string, unknown> {
  return { app: appBas, yta: ytBas, publik: P, nyckelfil: u.nyckelfil, sokord: 'HubSpot', ga_igenom: '/ga-igenom' };
}
/** Ett fall ändrar bara det fält som det prövar. */
async function skrivKonfig(u: Underlag, falt: Record<string, unknown> = {}): Promise<void> {
  await skriv(u.konfig, JSON.stringify({ ...standardKonfig(u), ...falt }));
}

// -I isolerar importerna och -B hindrar en cachekatalog i adapter/. Kod 3 skiljer drivrutinens fel
// från provets utfall; spåret står då på stderr.
const DRIVER = [
  'import json, sys, traceback',
  'try:',
  '    sys.path.insert(0, sys.argv[1])',
  '    import arendelankar as k',
  '    operation = sys.argv[2]',
  '    def konfig(hem):',
  '        l = k.konfiguration(hem)',
  '        if l.fel is not None:',
  '            raise RuntimeError(l.fel)',
  '        return l.konfig',
  '    def byt(val):',
  '        if val == "hel":',
  '            return',
  '        elif val == "sidstorlek2":',
  '            k.SIDSTORLEK = 2',
  '        elif val == "skrivande":',
  '            k.LASACTIONS = ("list_issues", "create_issue")',
  '        elif val == "tak2":',
  '            k.LANKTAK = 2',
  '        elif val == "utan_prefix":',
  '            svaret = k.plattformens_svar',
  '            def utan_prefix(konfig):',
  '                a = svaret(konfig)',
  '                forsta = (a.arenden[0][0], konfig.publik + "/vy/mitt")',
  '                return a._replace(arenden=(forsta,) + a.arenden[1:])',
  '            k.plattformens_svar = utan_prefix',
  '        elif val == "krasch":',
  '            def krasch(*argument):',
  '                raise RuntimeError("provets krasch")',
  '            k.kor = krasch',
  '        else:',
  '            raise ValueError("okant val")',
  '    if operation == "konfig":',
  '        l = k.konfiguration(sys.argv[3])',
  '        c = l.konfig',
  '        resultat = {"fel": l.fel, "nyckel_ratt": c is not None and c.nyckel == sys.argv[4]}',
  '        for falt in ("app", "yta", "publik", "sokord", "ga_igenom"):',
  '            resultat[falt] = None if c is None else getattr(c, falt)',
  '    elif operation == "konstanter":',
  '        resultat = {"ARENDEPREFIX": k.ARENDEPREFIX, "SIDOR": list(k.SIDOR), "LASACTIONS": list(k.LASACTIONS),',
  '                    "DATABASPORTAR": list(k.DATABASPORTAR), "ETIKETT": k.ETIKETT}',
  '    elif operation == "lankar":',
  '        resultat = [x._asdict() for x in k.lankar(sys.argv[4], sys.argv[5], konfig(sys.argv[3]))]',
  '    elif operation == "till_mal":',
  '        mal, fel = k.till_mal(sys.argv[4], konfig(sys.argv[3]))',
  '        resultat = {"mal": mal, "fel": fel}',
  '    elif operation == "folj":',
  '        f = k.folj(sys.argv[3])',
  '        resultat = {"status": f.status, "trasig": f.trasig, "fel": f.fel, "slut": f.slut}',
  '    elif operation == "api":',
  '        byt(sys.argv[4])',
  '        resultat = k.plattformens_svar(konfig(sys.argv[3]))._asdict()',
  '    elif operation == "fraga_action":',
  '        resultat = k.fraga_action(konfig(sys.argv[3]), sys.argv[4], {})._asdict()',
  '    elif operation == "korten":',
  '        l = k.korten(sys.argv[3])',
  '        resultat = {"kort": [c._asdict() for c in l.kort], "fel": l.fel}',
  '    elif operation == "jamfor":',
  '        insatser = [tuple(p) for p in json.loads(sys.argv[4])]',
  '        resultat = k.jamfor_korten(k.korten(sys.argv[3]), insatser)._asdict()',
  '    elif operation == "kor":',
  '        byt(sys.argv[4])',
  '        resultat = k.kor(sys.argv[3])._asdict()',
  '    elif operation == "doma":',
  '        d = json.loads(sys.argv[3])',
  '        foljda = {namn: set(mal) for namn, mal in d["foljda"].items()}',
  '        resultat = k.doma(d["konfigfel"], foljda, d["fel"], d["trasiga"], d["fynd"], d["kort"],',
  '                          d["jamforda"])._asdict()',
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
async function korDrivern(u: Underlag, argument: string[]): Promise<Processutfall> {
  try {
    const { stdout, stderr } = await korProcess('python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, ...argument],
      { cwd: ROT, env: barnmiljo(u), timeout: 20_000 });
    return { kod: 0, ut: stdout, fel: stderr };
  } catch (fel: unknown) {
    if (arProcessfel(fel)) return { kod: fel.code, ut: fel.stdout, fel: fel.stderr };
    throw fel;
  }
}
/** Ett fall före sin modulkod fälls med drivrutinens spår i felet. */
async function korJson<T>(u: Underlag, argument: string[]): Promise<T> {
  const p = await korDrivern(u, argument);
  if (p.kod !== 0) throw new Error(p.fel);
  return JSON.parse(p.ut) as T;
}
async function korKonfig(u: Underlag): Promise<Konfigutfall> {
  // Nyckeln jämförs i drivrutinen och skrivs aldrig ut: bara nyckel_ratt kommer tillbaka.
  return korJson<Konfigutfall>(u, ['konfig', u.hem, provetsNyckel]);
}
interface Lankutfall { href: string; mal: string | null; fel: string | null }
interface Foljutfall { status: string | null; trasig: boolean; fel: string | null; slut: string | null }
async function korLankar(u: Underlag, html: string, sidansAdress: string): Promise<Lankutfall[]> {
  return korJson<Lankutfall[]>(u, ['lankar', u.hem, html, sidansAdress]);
}
async function korTillMal(u: Underlag, adress: string): Promise<{ mal: string | null; fel: string | null }> {
  return korJson<{ mal: string | null; fel: string | null }>(u, ['till_mal', u.hem, adress]);
}
async function korFolj(u: Underlag, adress: string): Promise<Foljutfall> {
  return korJson<Foljutfall>(u, ['folj', adress]);
}
interface Apiutfall { arenden: [string, string][]; insatser: [string, string | null][]; fel: string | null }
async function korApi(u: Underlag, val: string): Promise<Apiutfall> {
  return korJson<Apiutfall>(u, ['api', u.hem, val]);
}
interface Kortutfall { id: string; etikett: boolean; href: string | null }
interface Jamforutfall { fynd: string[]; kort: number; jamforda: number; fel: string | null }
async function korKorten(u: Underlag, html: string): Promise<{ kort: Kortutfall[]; fel: string | null }> {
  return korJson<{ kort: Kortutfall[]; fel: string | null }>(u, ['korten', html]);
}
async function korJamfor(u: Underlag, html: string, insatser: [string, string | null][]): Promise<Jamforutfall> {
  return korJson<Jamforutfall>(u, ['jamfor', html, JSON.stringify(insatser)]);
}
// Kortformen (Dev Notes → Modulen): ett element med data-insats, etiketten som egen text och den
// första länken efter etiketten.
const ETIKETTRAD = '<p>Där handlingen görs</p>';
function kortHtml(id: string, ...delar: string[]): string {
  return `<article data-insats="${id}"><h3>Insats</h3>${delar.join('')}</article>`;
}
function lank(href: string): string {
  return `<a href="${href}">Öppna</a>`;
}
function fyndPekar(id: string, href: string, arendelank: string): string {
  return `FYND till kanalen Beslutskon: insats ${id}: Dar handlingen gors pekar pa ${href}, arendets lank ar ${arendelank}`;
}
function fyndSaknas(id: string, arendelank: string): string {
  return `FYND till kanalen Beslutskon: insats ${id}: Dar handlingen gors saknas eller har ingen lank, arendets lank ar ${arendelank}`;
}
const GRON_RAD = 'GRON: varje arendelank i ytan och appen svarar 200 efter hogst en 308';
const ROD_RAD = 'ROD: en arendelank i ytan eller appen svarar inte 200';
const KUNDE_INTE_RAD = 'KUNDE_INTE: arendelankarna gar inte att prova';
const SIDOR = ['oversikt', 'mitt', 'digest', 'sok', 'din_insats', 'ga_igenom', 'list_issues', 'list_insatser',
  'arendesidor'];
interface Domutfall { utfall: string; kod: number; rader: string[] }
interface Domunderlag {
  konfigfel: string | null; foljda: Record<string, string[]>; fel: string[]; trasiga: string[]; fynd: string[];
  kort: number; jamforda: number;
}
// Varje körning av kor sparas, så att F6 (q) kan pröva radformerna över alla körningar.
const korningar: Domutfall[] = [];
async function korKor(u: Underlag, lage: Ytlage, val = 'hel'): Promise<Domutfall> {
  ytlage = lage;
  const dom = await korJson<Domutfall>(u, ['kor', u.hem, val]);
  korningar.push(dom);
  return dom;
}
async function korDoma(u: Underlag, underlag: Domunderlag): Promise<Domutfall> {
  return korJson<Domutfall>(u, ['doma', JSON.stringify(underlag)]);
}
function borjarMed(rader: string[], prefix: string): string[] {
  return rader.filter((rad) => rad.startsWith(prefix));
}
// Skriptet som provvakten kör det: utan argument, med hemmet i HOME.
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
const ANROPSRAD = 'KUNDE_INTE: anropet gar inte att tolka: provet tar inga argument';
// Modulen använder bara standardbiblioteket (projektkontexten): varje import namnger en modul härifrån.
const STDLIB_TILLATNA = ['html', 'html.parser', 'json', 'os', 're', 'sys', 'typing', 'urllib', 'urllib.error',
  'urllib.parse', 'urllib.request'];
function importrader(text: string): string[] {
  return text.split(/\r?\n/).filter((rad) => /^(import|from)\s/.test(rad));
}
function otillatnaImporter(text: string): string[] {
  return importrader(text).flatMap((rad) => {
    const fran = /^from\s+(\S+)\s+import\b/.exec(rad);
    const moduler = fran ? [fran[1] ?? ''] : rad.replace(/^import\s+/, '').split(',')
      .map((del) => del.trim().split(/\s+/)[0] ?? '');
    return moduler.filter((modul) => !STDLIB_TILLATNA.includes(modul));
  });
}
function lankrad(...hrefs: (string | null)[]): string {
  return hrefs.map((href) => href === null ? '<a>utan href</a>' : `<a href="${href}">länk</a>`).join('');
}

// Utskriftens radformer, en sluten lista (Dev Notes → Modulen, Tabellen över felraderna): varje rad i en
// körning av kor hör till exakt en form, och varje form har minst ett fall genom kor (F6 (q)). Ett värde
// utifrån står i sluten form och har därför aldrig ett blanktecken (\S+).
const NAMNEN = SIDOR.join('|');
const STARTNAMNEN = SIDOR.slice(0, 6).join('|');
const exakt = (text: string) => (rad: string): boolean => rad === text;
const form = (monster: RegExp) => (rad: string): boolean => monster.test(rad);
const RADFORMER: [string, (rad: string) => boolean][] = [
  ['GRON', exakt(GRON_RAD)],
  ['ROD', exakt(ROD_RAD)],
  ['KUNDE_INTE', exakt(KUNDE_INTE_RAD)],
  ['sida', form(new RegExp(`^sida (${NAMNEN}): foljda=\\d+$`))],
  ['kort', form(/^kort i din_insats: kort=\d+ jamforda=\d+$/)],
  ['FEL konfigurationen', form(/^FEL: konfigurationen: .+$/)],
  ['FEL plattformens api', form(/^FEL: plattformens api: (actions|list_issues|list_insatser) \(.+\)$/)],
  ['FEL sidan nas inte (status N)', form(new RegExp(`^FEL: sidan nas inte: (${STARTNAMNEN}) \\(status \\d+\\)$`))],
  ['FEL sidan nas inte (Typ)', form(new RegExp(`^FEL: sidan nas inte: (${STARTNAMNEN}) \\([A-Za-z]+\\)$`))],
  ['FEL ursprung', form(new RegExp(`^FEL: lanken gar till ett ursprung som provet inte nar: sida (${NAMNEN}): \\S+$`))],
  ['FEL ingen arendeadress', form(/^FEL: lanken ar ingen arendeadress: sida (list_issues|list_insatser): \S+$/)],
  ['FEL svarar inte', form(new RegExp(`^FEL: lanken svarar inte: sida (${NAMNEN}): \\S+ \\([A-Za-z]+\\)$`))],
  ['FEL taket', form(/^FEL: taket pa \d+ lankar nades, resten foljdes inte$/)],
  ['FEL utanfor ett kort', exakt('FEL: din_insats: Dar handlingen gors star utanfor ett kort')],
  ['FEL inget kort', exakt('FEL: din_insats: inget kort galler en insats med arende')],
  ['FEL inga lankar', form(new RegExp(`^FEL: inga lankar foljdes pa (${NAMNEN})$`))],
  ['TRASIG', form(new RegExp(`^TRASIG: sida (${NAMNEN}): lank \\S+: status `
    + '(\\d{3}|308 och sedan \\d{3}|308 utan plats|308 till ett annat ursprung)$'))],
  ['FYND pekar pa', form(/^FYND till kanalen Beslutskon: insats \S+: Dar handlingen gors pekar pa \S+, arendets lank ar \S+$/)],
  ['FYND saknas', form(/^FYND till kanalen Beslutskon: insats \S+: Dar handlingen gors saknas eller har ingen lank, arendets lank ar \S+$/)],
];
function utanforFormerna(rader: string[]): string[] {
  return rader.filter((rad) => RADFORMER.filter(([, passar]) => passar(rad)).length !== 1);
}
function otackta(rader: string[]): string[] {
  return RADFORMER.filter(([, passar]) => !rader.some(passar)).map(([namn]) => namn);
}
/** En rad är en fysisk rad i synlig ASCII: inget radbrott, inget kontrolltecken och inget tecken utanför ASCII. */
function utanforAscii(rader: string[]): string[] {
  return rader.filter((rad) => !/^[\x20-\x7e]+$/.test(rad));
}
// Det provvaktens dom läser som KUNDE_INTE i en utskrift (Lärdomar ur byggda berättelser).
const FELNAMN = /Error|Exception|Traceback|kunde inte/i;

describe('D-5/Story 11.7 AK 1, 4: konfigurationen läses genom en enda väg', () => {
  it('F1 (AK 1, AK 4): en hel konfiguration läses, och varje fel i formen ger sin text och aldrig värdet', async () => {
    // (a) Kontrollen för (b)–(i): en hel konfiguration ger exakt värdena.
    const u = await nyttHem();
    await skrivKonfig(u);
    expect(await korKonfig(u)).toEqual({ app: appBas, yta: ytBas, publik: P, sokord: 'HubSpot',
      ga_igenom: '/ga-igenom', nyckel_ratt: true, fel: null });
    const tom = { app: null, yta: null, publik: null, sokord: null, ga_igenom: null, nyckel_ratt: false };

    // (b), (c): filen saknas, och filen är inte JSON.
    const b = await nyttHem();
    expect(await korKonfig(b)).toEqual({ ...tom, fel: 'FileNotFoundError' });
    await skriv(b.konfig, '{');
    expect(await korKonfig(b)).toEqual({ ...tom, fel: 'JSONDecodeError' });

    // (d): fel nycklar, var i en egen fil. Ett värde som inte är text fälls före formreglerna.
    const standard = standardKonfig(u);
    const { sokord: _sokord, ...utanSokord } = standard;
    for (const [namn, text] of [
      ['en nyckel för mycket', JSON.stringify({ ...standard, extra: 'x' })],
      ['en nyckel saknas', JSON.stringify(utanSokord)],
      ['en lista', JSON.stringify(Object.values(standard))],
      ['app som tal', JSON.stringify({ ...standard, app: 3002 })],
    ] as const) {
      await skriv(u.konfig, text);
      expect(await korKonfig(u), namn).toEqual({ ...tom, fel: 'fel nycklar' });
    }

    // (e)–(i): ett fält i taget, skilt från (a) bara i det fältet.
    const tomNyckel = path.join(u.hem, 'tom-nyckel');
    await skriv(tomNyckel, '');
    const fall: [Record<string, unknown>, string][] = [
      [{ app: appBas.replace('http:', 'https:') }, 'app ar ingen loopbackadress'],
      [{ app: appBas.replace(VARD, 'localhost') }, 'app ar ingen loopbackadress'],
      [{ app: `http://${VARD}` }, 'app ar ingen loopbackadress'],
      [{ app: `${appBas}/vy` }, 'app ar ingen loopbackadress'],
      [{ yta: `http://${VARD}` }, 'yta ar ingen loopbackadress'],
      [{ app: `http://${VARD}:5435` }, 'app ar en databasport'],
      [{ app: `http://${VARD}:5433` }, 'app ar en databasport'],
      [{ yta: `http://${VARD}:5436` }, 'yta ar en databasport'],
      [{ publik: P.replace('https:', 'http:') }, 'publik ar ingen https-adress'],
      [{ publik: `${P}/vy` }, 'publik ar ingen https-adress'],
      [{ publik: `${P}/` }, 'publik ar ingen https-adress'],
      [{ sokord: 'LOC-1' }, 'sokordet gar inte att tolka'],
      [{ sokord: 'a' }, 'sokordet gar inte att tolka'],
      [{ sokord: 'hub spot' }, 'sokordet gar inte att tolka'],
      [{ ga_igenom: 'ga-igenom' }, 'ga_igenom gar inte att tolka'],
      [{ ga_igenom: '/a//b' }, 'ga_igenom gar inte att tolka'],
      [{ ga_igenom: '/a/../b' }, 'ga_igenom gar inte att tolka'],
      [{ ga_igenom: '/A' }, 'ga_igenom gar inte att tolka'],
      [{ nyckelfil: 'arenden-nyckel' }, 'nyckelfilen ar inte en absolut sokvag'],
      [{ nyckelfil: path.join(u.hem, 'saknas') }, 'FileNotFoundError'],
      [{ nyckelfil: tomNyckel }, 'nyckelfilen ar tom'],
    ];
    for (const [falt, fel] of fall) {
      await skrivKonfig(u, falt);
      expect(await korKonfig(u), JSON.stringify(falt)).toEqual({ ...tom, fel });
    }
    await skrivKonfig(u);
    expect((await korKonfig(u)).fel).toBeNull();

    // (j): konstanterna. ARENDEPREFIX binds till appens (K-9): det som delas bevakas av ett prov.
    expect(await korJson(u, ['konstanter'])).toEqual({
      ARENDEPREFIX,
      SIDOR: ['oversikt', 'mitt', 'digest', 'sok', 'din_insats', 'ga_igenom', 'list_issues', 'list_insatser',
        'arendesidor'],
      LASACTIONS: ['list_issues', 'list_insatser'],
      DATABASPORTAR: [5433, 5435, 5436],
      ETIKETT: 'Där handlingen görs',
    });
  });
});

describe('D-5/Story 11.7 AK 1, 2: länkregeln och följandet', () => {
  it('F2 (AK 1): varje href med ärendesökvägen blir ett mål eller ett fel, och inget annat ger en post', async () => {
    const u = await nyttHem();
    await skrivKonfig(u);
    const A = appBas;
    const Y = ytBas;
    // (a) En relativ ärendelänk på en sida i appen.
    expect(await korLankar(u, lankrad('/vy/arende/LOC-1'), `${A}/vy`)).toEqual([
      { href: `${A}/vy/arende/LOC-1`, mal: `${A}/vy/arende/LOC-1`, fel: null },
    ]);
    // (b) Läsvyns publika adress går till appens bas, med frågan och utan fragmentet.
    expect(await korLankar(u, lankrad(`${P}/vy/arende/LOC-2?x=1#f`), `${A}/vy`)).toEqual([
      { href: `${P}/vy/arende/LOC-2?x=1#f`, mal: `${A}/vy/arende/LOC-2?x=1`, fel: null },
    ]);
    // (c) En relativ ärendelänk på ytans sida går till ytans bas.
    expect(await korLankar(u, lankrad('/vy/arende/LOC-3'), `${Y}/ga-igenom`)).toEqual([
      { href: `${Y}/vy/arende/LOC-3`, mal: `${Y}/vy/arende/LOC-3`, fel: null },
    ]);
    // (d) Entiteterna i attributet avkodas.
    const d = await korLankar(u, '<a href="/vy/arende/LOC-4?a=1&amp;b=2">d</a>', `${A}/vy`);
    expect(d.map((l) => l.href)).toEqual([`${A}/vy/arende/LOC-4?a=1&b=2`]);
    expect(d[0]?.mal).toBe(`${A}/vy/arende/LOC-4?a=1&b=2`);
    // (e) Länkar utan ärendesökvägen ger inga poster. Kontroll: samma sida med en ärendelänk till ger en.
    const ovriga = ['/vy/mitt', '/vy/sok?q=LOC-5', 'https://example.invalid/sida', 'mailto:prov@example.invalid', null];
    expect(await korLankar(u, lankrad(...ovriga), `${A}/vy`)).toEqual([]);
    expect(await korLankar(u, lankrad(...ovriga, '/vy/arende/LOC-5'), `${A}/vy`)).toEqual([
      { href: `${A}/vy/arende/LOC-5`, mal: `${A}/vy/arende/LOC-5`, fel: null },
    ]);
    // (f) En ärendelänk till ett ursprung som provet inte når hoppas inte över: den blir ett fel.
    expect(await korLankar(u, lankrad('https://annan.invalid/vy/arende/LOC-6'), `${A}/vy`)).toEqual([
      { href: 'https://annan.invalid/vy/arende/LOC-6', mal: null,
        fel: 'lanken gar till ett ursprung som provet inte nar' },
    ]);
    // (g) Schema och värd jämförs utan hänsyn till skiftläge.
    const versaler = await korLankar(u, lankrad(`${P.toUpperCase()}/vy/arende/LOC-7`), `${A}/vy`);
    expect(versaler.map((l) => [l.mal, l.fel])).toEqual([[`${A}/vy/arende/LOC-7`, null]]);
    // (h) till_mal direkt: en adress utan ärendesökvägen är ett fel. Kontroll: en ärendeadress ger ett mål.
    expect(await korTillMal(u, `${P}/vy/mitt`)).toEqual({ mal: null, fel: 'lanken ar ingen arendeadress' });
    expect(await korTillMal(u, `${P}/vy/arende/LOC-8`)).toEqual({ mal: `${A}/vy/arende/LOC-8`, fel: null });
  });

  it('F3 (AK 2): följandet godtar 200 eller en 308 inom samma ursprung följd av 200, och följer inget själv', async () => {
    const u = await nyttHem();
    const Y = ytBas;
    const alla: string[] = [];
    async function prova(sokvag: string): Promise<Foljutfall> {
      fixturanrop.length = 0;
      const f = await korFolj(u, `${Y}${sokvag}`);
      alla.push(...fixturanrop);
      return f;
    }
    const trasig = (status: string): Foljutfall => ({ status, trasig: true, fel: null, slut: null });
    // (a), (b): de två godkända formerna, kontrollen för (c)–(i).
    expect(await prova('/ok')).toEqual({ status: '200', trasig: false, fel: null, slut: `${Y}/ok` });
    expect(fixturanrop).toEqual(['GET /ok']);
    expect(await prova('/flytt')).toEqual({ status: '308 och sedan 200', trasig: false, fel: null, slut: `${Y}/ok` });
    expect(fixturanrop).toEqual(['GET /flytt', 'GET /ok']);
    // (c)–(h): varje annat svar är en trasig länk med sin status.
    expect(await prova('/flytt-saknas')).toEqual(trasig('308 och sedan 404'));
    expect(await prova('/flytt-flytt')).toEqual(trasig('308 och sedan 308'));
    expect(fixturanrop).toEqual(['GET /flytt-flytt', 'GET /flytt']);
    expect(await prova('/flytt-utan')).toEqual(trasig('308 utan plats'));
    // (f) fel null: ingen hämtning gjordes mot den stängda porten, som i (i) hade gett URLError.
    expect(await prova('/flytt-bort')).toEqual(trasig('308 till ett annat ursprung'));
    expect(fixturanrop).toEqual(['GET /flytt-bort']);
    expect(await prova('/saknas')).toEqual(trasig('404'));
    expect(await prova('/fel')).toEqual(trasig('500'));
    // (i) Inget svar är ett fel med undantagets typnamn, aldrig en trasig länk.
    expect(await korFolj(u, `${stangdBas}/ok`)).toEqual({ status: null, trasig: false, fel: 'URLError', slut: null });
    // (j) Över (a)–(h) har fixturservern bara fått GET.
    expect(alla.length).toBeGreaterThanOrEqual(10);
    expect(alla.filter((rad) => !rad.startsWith('GET '))).toEqual([]);
  });
});

const LASANROP = ['GET /api/actions', 'POST /api/actions/list_issues', 'POST /api/actions/list_insatser'];

describe('D-5/Story 11.7 AK 1, 4: plattformens svar läses genom två läsande actions', () => {
  it('F4 (AK 1, AK 4): manifestet prövas före den första POST, och bara de två läsande actions anropas', async () => {
    const u = await nyttHem();
    await skrivKonfig(u);
    // Det väntade ur plattformen själv. Fältet lank har arendeLank():s form (K-9).
    const lista = (await steg(agent, 'list_issues', { limit: 100 })) as {
      arenden: { identifier: string; lank: string }[]; pageInfo: { har_nasta: boolean };
    };
    expect(lista.pageInfo.har_nasta).toBe(false);
    const arenden = lista.arenden.map((a): [string, string] => [a.identifier, a.lank]);
    expect(arenden).toHaveLength(5);
    const insatser = ((await steg(agent, 'list_insatser', {})) as { id: string; lank: string | null }[])
      .map((i): [string, string | null] => [i.id, i.lank]);
    expect(insatser).toHaveLength(3);
    expect(insatser).toEqual(expect.arrayContaining([[A.id, A.lank], [B.id, null], [C.id, C.lank]]));
    expect(A.lank).toBe(`${P}${ARENDEPREFIX}${foralder}`);
    expect(C.lank).toBe(`${P}${ARENDEPREFIX}${andra}`);
    const tomt = { arenden: [], insatser: [] };

    // (a), (g): kontrollen för (c)–(f). Ett GET för manifestet och en POST per läsande action, inget skrivs.
    const handelser = await raknaRader('events');
    const insatsrader = await raknaRader('insatser');
    appanrop.length = 0;
    expect(await korApi(u, 'hel')).toEqual({ arenden, insatser, fel: null });
    expect(appanrop).toEqual(LASANROP);
    expect(await raknaRader('events')).toBe(handelser);
    expect(await raknaRader('insatser')).toBe(insatsrader);

    // (b) Sidorna följs med cursor: fem ärenden i sidor om två är tre anrop.
    appanrop.length = 0;
    expect(await korApi(u, 'sidstorlek2')).toEqual({ arenden, insatser, fel: null });
    expect(appanrop.filter((rad) => rad === 'POST /api/actions/list_issues')).toHaveLength(3);

    // (c) En nyckel som inte finns.
    const okand = path.join(u.hem, 'okand-nyckel');
    await writeFile(okand, 'arendelankprov-okand-nyckel', { mode: 0o600 });
    await skrivKonfig(u, { nyckelfil: okand });
    expect(await korApi(u, 'hel')).toEqual({ ...tomt, fel: 'actions (status 401)' });

    // (d) Appen svarar inte.
    await skrivKonfig(u, { app: stangdBas });
    expect(await korApi(u, 'hel')).toEqual({ ...tomt, fel: 'actions (URLError)' });

    // (e) Ett namn som manifestet inte visar som läsande: ingen POST alls.
    await skrivKonfig(u);
    appanrop.length = 0;
    expect(await korApi(u, 'skrivande')).toEqual({ ...tomt, fel: 'actions (create_issue ar inte lasande)' });
    expect(appanrop).toEqual(['GET /api/actions']);

    // (f) fraga_action kastar för ett namn utanför LASACTIONS innan något hämtas.
    appanrop.length = 0;
    const f = await korDrivern(u, ['fraga_action', u.hem, 'create_issue']);
    expect(f.kod).toBe(3);
    expect(f.fel.trim().split(/\r?\n/).at(-1)).toBe('ValueError: actionen ar inte lasande');
    expect(appanrop).toEqual([]);
    expect(await raknaRader('events')).toBe(handelser);
    expect(await raknaRader('insatser')).toBe(insatsrader);
  });
});

describe('D-5/Story 11.7 AK 1, 2: korten i Din insats jämförs med ärendets lank', () => {
  it('F5 (AK 1, AK 2, AK 3): korten läses i en sluten form, och jämförelsen skriver fynd utan att döma', async () => {
    const u = await nyttHem();
    const [ia, ib, ic, ix] = ['a', 'b', 'c', 'f'].map((t) => `${t.repeat(8)}-0000-4000-8000-00000000000${t}`) as
      [string, string, string, string];
    const la = `${P}${ARENDEPREFIX}LOC-1`;
    const lc = `${P}${ARENDEPREFIX}LOC-3`;
    // (a) Två kort: id, etiketten och länken efter den.
    expect(await korKorten(u, kortHtml(ia, ETIKETTRAD, lank(la)) + kortHtml(ic, ETIKETTRAD, lank(lc)))).toEqual({
      kort: [{ id: ia, etikett: true, href: la }, { id: ic, etikett: true, href: lc }], fel: null,
    });
    // (b) Kolon sist, entiteter och radbrytning med dubbla blanksteg inne i texten.
    const b = await korKorten(u, kortHtml(ia, '<p>Där handlingen görs:</p>', lank(la))
      + kortHtml(ib, '<p>D&auml;r handlingen g&ouml;rs</p>', lank(la))
      + kortHtml(ic, '<p>Där\n  handlingen  görs</p>', lank(la)));
    expect(b.fel).toBeNull();
    expect(b.kort.map((k) => k.etikett)).toEqual([true, true, true]);
    // (c) Länken efter etiketten, inte den före. Ett kort utan etikett har ingen länk, fast det har en a.
    expect(await korKorten(u, kortHtml(ia, lank('/fore'), ETIKETTRAD, lank('/efter')) + kortHtml(ib, lank(la))))
      .toEqual({ kort: [{ id: ia, etikett: true, href: '/efter' }, { id: ib, etikett: false, href: null }], fel: null });
    // (d) En etikett före det första kortet är ett fel, aldrig en tyst jämförelse.
    const utanfor = ETIKETTRAD + lank(la) + kortHtml(ia, ETIKETTRAD, lank(la));
    expect((await korKorten(u, utanfor)).fel).toBe('Dar handlingen gors star utanfor ett kort');
    // (e) Två etiketter i ett kort: den första länken efter den första etiketten.
    expect((await korKorten(u, kortHtml(ia, ETIKETTRAD, lank('/forsta'), ETIKETTRAD, lank('/andra')))).kort)
      .toEqual([{ id: ia, etikett: true, href: '/forsta' }]);

    // (f)–(j): jämförelsen. B har ingen lank och jämförs inte.
    const insatser: [string, string | null][] = [[ia, la], [ib, null], [ic, lc]];
    const sida = (hrefA: string | null): string =>
      kortHtml(ia, ...(hrefA === null ? [lank(la)] : [ETIKETTRAD, lank(hrefA)]))
      + kortHtml(ib, ETIKETTRAD, lank('/uppfoljning')) + kortHtml(ic, ETIKETTRAD, lank(lc));
    expect(await korJamfor(u, sida(la), insatser)).toEqual({ fynd: [], kort: 3, jamforda: 2, fel: null });
    expect(await korJamfor(u, sida('/uppfoljning'), insatser)).toEqual({
      fynd: [fyndPekar(ia, '/uppfoljning', la)], kort: 3, jamforda: 2, fel: null,
    });
    expect(await korJamfor(u, sida(null), insatser)).toEqual({
      fynd: [fyndSaknas(ia, la)], kort: 3, jamforda: 2, fel: null,
    });
    // (i) Inget kort gäller en insats med ärende. Kontroll: utan insatser med lank finns inget att jämföra.
    const andraKort = kortHtml(ix, ETIKETTRAD, lank(la));
    expect(await korJamfor(u, andraKort, insatser)).toEqual({
      fynd: [], kort: 1, jamforda: 0, fel: 'din_insats: inget kort galler en insats med arende',
    });
    expect((await korJamfor(u, andraKort, [[ia, null], [ib, null]])).fel).toBeNull();
    // (j) Etiketten utanför ett kort når jämförelsen som fel.
    expect((await korJamfor(u, utanfor, insatser)).fel).toBe('din_insats: Dar handlingen gors star utanfor ett kort');
  });

  it('F5 (k) (AK 2): kortets id, href och ärendets lank står i fyndet bara i sluten form', async () => {
    const u = await nyttHem();
    const [ia, ic] = ['a', 'c'].map((t) => `${t.repeat(8)}-0000-4000-8000-00000000000${t}`) as [string, string];
    const la = `${P}${ARENDEPREFIX}LOC-1`;
    const lc = `${P}${ARENDEPREFIX}LOC-3`;
    // Värden utifrån som en rå rad hade delat, eller låtit bära ett felnamn eller orden «kunde inte».
    const id1 = 'id\nGRON: Traceback';
    const href1 = '/uppfoljning\tKeyError';
    const lank1 = `${P}${ARENDEPREFIX}LOC-1?q=kunde inte`;
    const id2 = 'id-2 ValueError';
    const lank2 = `${P}${ARENDEPREFIX}LOC-2#ä`;
    const sida = kortHtml(id1, ETIKETTRAD, lank(href1)) + kortHtml(id2, lank(la))
      + kortHtml(ia, ETIKETTRAD, lank('/uppfoljning?x=%0A')) + kortHtml(ic, ETIKETTRAD, lank('/uppfoljning'));
    const j = await korJamfor(u, sida, [[id1, lank1], [id2, lank2], [ia, la], [ic, lc]]);
    expect(j).toEqual({
      fynd: [
        fyndPekar('id%0AGRON:%20%54raceback', '/uppfoljning%09%4Bey%45rror', `${P}${ARENDEPREFIX}LOC-1?q=kunde%20inte`),
        fyndSaknas('id-2%20%56alue%45rror', `${P}${ARENDEPREFIX}LOC-2%23%C3%A4`),
        // Procenttecknet kodas också, så att en kodad radbrytning och texten %0A aldrig blir samma rad.
        fyndPekar(ia, '/uppfoljning?x=%250A', la),
        // Kontroll: ett vanligt id, en vanlig href och en vanlig lank står kvar som de är.
        fyndPekar(ic, '/uppfoljning', lc),
      ],
      kort: 4, jamforda: 4, fel: null,
    });
    expect(utanforAscii(j.fynd)).toEqual([]);
    expect(j.fynd.filter((rad) => FELNAMN.test(rad))).toEqual([]);
    // Kontroll: samma prövningar slår ut på de råa värdena.
    expect(utanforAscii([id1, href1, lank2])).toEqual([id1, href1, lank2]);
    expect([id1, href1, lank1, id2].filter((varde) => FELNAMN.test(varde))).toEqual([id1, href1, lank1, id2]);
  });
});

describe('D-5/Story 11.7 AK 1–4: hela listan mot testservern och ytans fixturkopia', () => {
  /** GRON och ROD bär aldrig ett felnamn: varje fel ger KUNDE_INTE före de trasiga länkarna. */
  function utanFelnamn(d: Domutfall): void {
    expect(d.rader.join('\n')).not.toMatch(/Error|kunde inte/);
    expect(borjarMed(d.rader, 'FEL')).toEqual([]);
  }

  it('F6 (a) (AK 1, AK 2): varje post i SIDOR följs, och utan fel och trasiga länkar blir det GRON', async () => {
    const u = await nyttHem();
    await skrivKonfig(u);
    const d = await korKor(u, 'normal');
    expect({ utfall: d.utfall, kod: d.kod }).toEqual({ utfall: 'GRON', kod: 0 });
    expect(d.rader[0]).toBe(GRON_RAD);
    expect(d.rader).toHaveLength(11);
    expect(d.rader.slice(1, 10).map((rad) => rad.split(': ')[0])).toEqual(SIDOR.map((namn) => `sida ${namn}`));
    expect(d.rader).toEqual(expect.arrayContaining(['sida list_issues: foljda=5', 'sida list_insatser: foljda=2',
      'sida din_insats: foljda=2', 'sida ga_igenom: foljda=1', 'kort i din_insats: kort=3 jamforda=2']));
    for (const namn of ['oversikt', 'mitt', 'digest', 'sok', 'arendesidor']) {
      const rad = d.rader.find((r) => r.startsWith(`sida ${namn}: foljda=`)) ?? '';
      expect(Number(rad.split('=')[1]), namn).toBeGreaterThanOrEqual(1);
    }
    expect(d.rader.filter((rad) => /^(FEL|TRASIG|FYND)/.test(rad))).toEqual([]);
    expect(d.rader.join('\n')).not.toContain(provetsNyckel);
    utanFelnamn(d);
  });

  it('F6 (b)–(d) (AK 2, AK 3): ett okänt ärende, ett nummer över gränsen och ett 500 ger ROD med sin rad', async () => {
    const u = await nyttHem();
    await skrivKonfig(u);
    const b = await korKor(u, 'saknas');
    expect({ utfall: b.utfall, kod: b.kod, forsta: b.rader[0] }).toEqual({ utfall: 'ROD', kod: 1, forsta: ROD_RAD });
    expect(b.rader).toContain('sida ga_igenom: foljda=2');
    expect(borjarMed(b.rader, 'TRASIG')).toEqual([`TRASIG: sida ga_igenom: lank ${P}${ARENDEPREFIX}LOC-99999: status 404`]);
    utanFelnamn(b);
    const c = await korKor(u, 'heltal');
    expect({ utfall: c.utfall, kod: c.kod, forsta: c.rader[0] }).toEqual({ utfall: 'ROD', kod: 1, forsta: ROD_RAD });
    expect(borjarMed(c.rader, 'TRASIG'))
      .toEqual([`TRASIG: sida ga_igenom: lank ${P}${ARENDEPREFIX}LOC-99999999999: status 404`]);
    utanFelnamn(c);
    const d = await korKor(u, 'yta500');
    expect({ utfall: d.utfall, kod: d.kod, forsta: d.rader[0] }).toEqual({ utfall: 'ROD', kod: 1, forsta: ROD_RAD });
    expect(borjarMed(d.rader, 'TRASIG')).toEqual([`TRASIG: sida ga_igenom: lank ${ytBas}${ARENDEPREFIX}LOC-88: status 500`]);
    utanFelnamn(d);
  });

  it('F6 (e) (AK 2, AK 3): ett kort som pekar på /uppfoljning ger ett FYND och utfallet GRON', async () => {
    const u = await nyttHem();
    await skrivKonfig(u);
    const e = await korKor(u, 'uppfoljning');
    expect({ utfall: e.utfall, kod: e.kod, forsta: e.rader[0] }).toEqual({ utfall: 'GRON', kod: 0, forsta: GRON_RAD });
    expect(e.rader).toContain('sida din_insats: foljda=1');
    expect(e.rader).toContain('kort i din_insats: kort=3 jamforda=2');
    expect(borjarMed(e.rader, 'FYND')).toEqual([fyndPekar(A.id, '/uppfoljning', A.lank ?? '')]);
    expect(borjarMed(e.rader, 'TRASIG')).toEqual([]);
    utanFelnamn(e);
  });

  it('F6 (f)–(i) (AK 2, AK 4): en sida som inte nås, en sida utan länk, ett annat ursprung och en databasport ger KUNDE_INTE', async () => {
    const u = await nyttHem();
    // (f) Ytan svarar inte: båda ytans sidor saknas och har noll följda länkar.
    await skrivKonfig(u, { yta: stangdBas });
    const f = await korKor(u, 'normal');
    expect({ utfall: f.utfall, kod: f.kod, forsta: f.rader[0] })
      .toEqual({ utfall: 'KUNDE_INTE', kod: 2, forsta: KUNDE_INTE_RAD });
    expect(borjarMed(f.rader, 'FEL')).toEqual(['FEL: sidan nas inte: din_insats (URLError)',
      'FEL: sidan nas inte: ga_igenom (URLError)', 'FEL: inga lankar foljdes pa din_insats',
      'FEL: inga lankar foljdes pa ga_igenom']);
    expect(borjarMed(f.rader, 'TRASIG')).toEqual([]);
    await skrivKonfig(u);
    // (g) Gå igenom utan ärendelänk.
    const g = await korKor(u, 'utan_lankar');
    expect({ utfall: g.utfall, kod: g.kod }).toEqual({ utfall: 'KUNDE_INTE', kod: 2 });
    expect(borjarMed(g.rader, 'FEL')).toEqual(['FEL: inga lankar foljdes pa ga_igenom']);
    // (h) En ärendelänk till ett ursprung som provet inte når hoppas inte över.
    const h = await korKor(u, 'annat_ursprung');
    expect({ utfall: h.utfall, kod: h.kod }).toEqual({ utfall: 'KUNDE_INTE', kod: 2 });
    expect(borjarMed(h.rader, 'FEL')).toEqual([
      `FEL: lanken gar till ett ursprung som provet inte nar: sida ga_igenom: https://annan.invalid${ARENDEPREFIX}LOC-88`,
    ]);
    // (i) Porten 5435: KUNDE_INTE innan något hämtas.
    await skrivKonfig(u, { app: `http://${VARD}:5435` });
    appanrop.length = 0;
    fixturanrop.length = 0;
    const i = await korKor(u, 'normal');
    expect(i).toEqual({ utfall: 'KUNDE_INTE', kod: 2,
      rader: [KUNDE_INTE_RAD, 'FEL: konfigurationen: app ar en databasport'] });
    expect(appanrop).toEqual([]);
    expect(fixturanrop).toEqual([]);
  });

  it('F6 (j) (AK 4): fyra körningar gör bara GET och de två läsande POST, och inget skrivs', async () => {
    const u = await nyttHem();
    await skrivKonfig(u);
    const handelser = await raknaRader('events');
    const insatsrader = await raknaRader('insatser');
    appanrop.length = 0;
    fixturanrop.length = 0;
    for (const lage of ['normal', 'saknas', 'uppfoljning', 'annat_ursprung'] as const) await korKor(u, lage);
    const post = LASANROP.slice(1);
    expect(appanrop.filter((rad) => !rad.startsWith('GET ') && !post.includes(rad))).toEqual([]);
    expect(appanrop.some((rad) => rad.startsWith('GET '))).toBe(true);
    for (const rad of post) expect(appanrop).toContain(rad);
    expect(fixturanrop.length).toBeGreaterThan(0);
    expect(fixturanrop.filter((rad) => !rad.startsWith('GET '))).toEqual([]);
    expect(await raknaRader('events')).toBe(handelser);
    expect(await raknaRader('insatser')).toBe(insatsrader);
  });

  it('F6 (k) (AK 2): domen prövar fel först, tomma sidor sedan och trasiga länkar sist före GRON', async () => {
    const u = await nyttHem();
    const alla = Object.fromEntries(SIDOR.map((namn) => [namn, [`${appBas}${ARENDEPREFIX}LOC-1`]]));
    const underlag = (andring: Partial<Domunderlag>): Domunderlag => ({
      konfigfel: null, foljda: alla, fel: [], trasiga: [], fynd: [], kort: 3, jamforda: 2, ...andring,
    });
    const summa = [...SIDOR.map((namn) => `sida ${namn}: foljda=1`), 'kort i din_insats: kort=3 jamforda=2'];
    const trasig = `TRASIG: sida ga_igenom: lank ${P}${ARENDEPREFIX}LOC-99999: status 404`;
    const fynd = fyndPekar(A.id, '/uppfoljning', A.lank ?? '');
    expect(await korDoma(u, underlag({ fel: ['sidan nas inte: din_insats (URLError)'], trasiga: [trasig] })))
      .toEqual({ utfall: 'KUNDE_INTE', kod: 2,
        rader: [KUNDE_INTE_RAD, ...summa, 'FEL: sidan nas inte: din_insats (URLError)', trasig] });
    expect(await korDoma(u, underlag({ trasiga: [trasig] })))
      .toEqual({ utfall: 'ROD', kod: 1, rader: [ROD_RAD, ...summa, trasig] });
    const utanDigest = await korDoma(u, underlag({ foljda: { ...alla, digest: [] } }));
    expect({ utfall: utanDigest.utfall, kod: utanDigest.kod }).toEqual({ utfall: 'KUNDE_INTE', kod: 2 });
    expect(borjarMed(utanDigest.rader, 'FEL')).toEqual(['FEL: inga lankar foljdes pa digest']);
    expect(utanDigest.rader).toContain('sida digest: foljda=0');
    expect(await korDoma(u, underlag({}))).toEqual({ utfall: 'GRON', kod: 0, rader: [GRON_RAD, ...summa] });
    expect(await korDoma(u, underlag({ fynd: [fynd] })))
      .toEqual({ utfall: 'GRON', kod: 0, rader: [GRON_RAD, ...summa, fynd] });
    expect(await korDoma(u, underlag({ konfigfel: 'fel nycklar', trasiga: [trasig], fynd: [fynd] })))
      .toEqual({ utfall: 'KUNDE_INTE', kod: 2, rader: [KUNDE_INTE_RAD, 'FEL: konfigurationen: fel nycklar'] });
  });

  it('F6 (l) (AK 1, AK 2): ett nått tak ger KUNDE_INTE, aldrig en tyst avkapning', async () => {
    const u = await nyttHem();
    await skrivKonfig(u);
    const l = await korKor(u, 'normal', 'tak2');
    expect({ utfall: l.utfall, kod: l.kod, forsta: l.rader[0] })
      .toEqual({ utfall: 'KUNDE_INTE', kod: 2, forsta: KUNDE_INTE_RAD });
    expect(l.rader.filter((rad) => rad === 'FEL: taket pa 2 lankar nades, resten foljdes inte')).toHaveLength(1);
  });

  interface Felfall {
    namn: string; lage: Ytlage; val?: string; falt?: Record<string, unknown>; fel: string[];
    /** En begäran till ytan som körningen aldrig får göra. */
    aldrig?: string;
    /** Körningen får inte göra någon POST alls. */
    utanPost?: boolean;
  }
  /** Varje fall ger KUNDE_INTE med exakt sina FEL-rader, och bara läsningar: GET och de två läsande POST. */
  async function provaFelfall(u: Underlag, fall: Felfall[]): Promise<void> {
    for (const f of fall) {
      await skrivKonfig(u, f.falt ?? {});
      appanrop.length = 0;
      fixturanrop.length = 0;
      const d = await korKor(u, f.lage, f.val);
      expect({ namn: f.namn, utfall: d.utfall, kod: d.kod, forsta: d.rader[0], fel: borjarMed(d.rader, 'FEL') })
        .toEqual({ namn: f.namn, utfall: 'KUNDE_INTE', kod: 2, forsta: KUNDE_INTE_RAD, fel: f.fel });
      const tillatnaPost = f.utanPost ? [] : LASANROP.slice(1);
      expect(appanrop.filter((rad) => !rad.startsWith('GET ') && !tillatnaPost.includes(rad)), f.namn).toEqual([]);
      expect(fixturanrop.filter((rad) => !rad.startsWith('GET ')), f.namn).toEqual([]);
      if (f.aldrig !== undefined) expect(fixturanrop, f.namn).not.toContain(f.aldrig);
    }
  }

  it('F6 (m) (AK 2): en startsida som svarar annat än 200 läses aldrig och följs aldrig, och ger KUNDE_INTE', async () => {
    const u = await nyttHem();
    // Kontrollen är (a), skild bara i läget eller i adressen till Gå igenom. Platsen i en omdirigering
    // från en startsida hämtas aldrig.
    await provaFelfall(u, [
      // Din insats kräver inloggning och skickar vidare (Frågor till David, punkt 1).
      { namn: 'inloggning', lage: 'inloggning', aldrig: 'GET /logga-in',
        fel: ['FEL: sidan nas inte: din_insats (status 302)', 'FEL: inga lankar foljdes pa din_insats'] },
      { namn: 'ga_igenom 500', lage: 'normal', falt: { ga_igenom: '/fel' },
        fel: ['FEL: sidan nas inte: ga_igenom (status 500)', 'FEL: inga lankar foljdes pa ga_igenom'] },
      { namn: 'ga_igenom 308', lage: 'normal', falt: { ga_igenom: '/flytt' }, aldrig: 'GET /ok',
        fel: ['FEL: sidan nas inte: ga_igenom (status 308)', 'FEL: inga lankar foljdes pa ga_igenom'] },
    ]);
  });

  it('F6 (n) (AK 2, AK 4): en länk utan svar och ett plattformssvar som inte går att läsa ger KUNDE_INTE genom kor', async () => {
    const u = await nyttHem();
    const okand = path.join(u.hem, 'okand-nyckel');
    await writeFile(okand, 'arendelankprov-okand-nyckel', { mode: 0o600 });
    // Kontrollen är (a), skild bara i läget, nyckeln eller valet.
    await provaFelfall(u, [
      // Ytan bryter förbindelsen för en ärendelänk: inget svar är ett fel, aldrig en trasig länk.
      { namn: 'bruten', lage: 'bruten',
        fel: [`FEL: lanken svarar inte: sida ga_igenom: ${ytBas}${ARENDEPREFIX}LOC-88 (RemoteDisconnected)`] },
      { namn: 'okand nyckel', lage: 'normal', falt: { nyckelfil: okand },
        fel: ['FEL: plattformens api: actions (status 401)', 'FEL: inga lankar foljdes pa list_issues',
          'FEL: inga lankar foljdes pa list_insatser'] },
      // Ett namn som manifestet inte visar som läsande: ingen POST alls, också genom kor.
      { namn: 'skrivande', lage: 'normal', val: 'skrivande', utanPost: true,
        fel: ['FEL: plattformens api: actions (create_issue ar inte lasande)', 'FEL: inga lankar foljdes pa list_issues',
          'FEL: inga lankar foljdes pa list_insatser'] },
      // Plattformen ger aldrig en lank utan prefixet (VY_PUBLIK_URL är exakt sitt ursprung, test/config.test.ts
      // C1, och arendeLank lägger alltid till prefixet, test/djuplank.test.ts D3). Valet byter därför svaret i
      // modulens process, som valet krasch byter kor, och raden visas genom kor.
      { namn: 'utan prefix', lage: 'normal', val: 'utan_prefix',
        fel: [`FEL: lanken ar ingen arendeadress: sida list_issues: ${P}/vy/mitt`] },
    ]);
  });

  it('F6 (o) (AK 1, AK 2): kortformens två vakter och fyndet utan länk nås genom kor', async () => {
    const u = await nyttHem();
    // Kontrollen är (a), skild bara i läget.
    await provaFelfall(u, [
      { namn: 'etikett utanfor', lage: 'etikett_utanfor', fel: ['FEL: din_insats: Dar handlingen gors star utanfor ett kort'] },
      { namn: 'andra kort', lage: 'andra_kort', fel: ['FEL: din_insats: inget kort galler en insats med arende'] },
    ]);
    await skrivKonfig(u);
    const d = await korKor(u, 'utan_etikett');
    expect({ utfall: d.utfall, kod: d.kod, forsta: d.rader[0] }).toEqual({ utfall: 'GRON', kod: 0, forsta: GRON_RAD });
    expect(d.rader).toContain('kort i din_insats: kort=3 jamforda=2');
    expect(borjarMed(d.rader, 'FYND')).toEqual([fyndSaknas(A.id, A.lank ?? '')]);
    expect(d.rader.filter((rad) => /^(FEL|TRASIG)/.test(rad))).toEqual([]);
  });

  it('F6 (p) (AK 2): värden utifrån står i sluten form, så en ROD-utskrift delas aldrig och bär inget felnamn', async () => {
    const u = await nyttHem();
    await skrivKonfig(u);
    const d = await korKor(u, 'fientlig');
    expect({ utfall: d.utfall, kod: d.kod, forsta: d.rader[0] }).toEqual({ utfall: 'ROD', kod: 1, forsta: ROD_RAD });
    expect(d.rader).toContain('sida ga_igenom: foljda=4');
    expect(borjarMed(d.rader, 'TRASIG')).toEqual([
      `TRASIG: sida ga_igenom: lank ${ytBas}${ARENDEPREFIX}LOC-88?fel=%56alue%45rror: status 404`,
      `TRASIG: sida ga_igenom: lank ${P}${ARENDEPREFIX}LOC-9999%0A9: status 404`,
      `TRASIG: sida ga_igenom: lank ${P.replace('https://', 'https://kunde%20inte%40')}${ARENDEPREFIX}LOC-99998: status 404`,
    ]);
    expect(borjarMed(d.rader, 'FYND'))
      .toEqual([fyndPekar(A.id, '/uppfoljning%0AFEL:%20%4Bey%45rror%2C%20kunde%20inte%20%C3%B6', A.lank ?? '')]);
    expect(utanforAscii(d.rader)).toEqual([]);
    expect(d.rader.filter((rad) => FELNAMN.test(rad))).toEqual([]);
    utanFelnamn(d);
    // Skriptet skriver samma rader, en fysisk rad var.
    const p = await korProvet(u, []);
    expect({ kod: p.kod, rader: rader(p.ut), fel: p.fel }).toEqual({ kod: 1, rader: d.rader, fel: '' });
    // Kontroll: de råa värdena hade delat raden och burit felnamnen.
    expect(utanforAscii([...FIENTLIGA_LANKAR, FIENTLIGT_KORT])).toEqual([FIENTLIGA_LANKAR[1], FIENTLIGT_KORT]);
    expect([...FIENTLIGA_LANKAR, FIENTLIGT_KORT].filter((varde) => FELNAMN.test(varde)))
      .toEqual([FIENTLIGA_LANKAR[0], FIENTLIGA_LANKAR[2], FIENTLIGT_KORT]);
  });

  it('F6 (q) (AK 1, AK 2): varje radform, också varje rad i tabellen över felraderna, har ett fall genom kor', () => {
    const alla = korningar.flatMap((k) => k.rader);
    expect(alla.length).toBeGreaterThan(0);
    expect(utanforFormerna(alla)).toEqual([]);
    expect(otackta(alla)).toEqual([]);
    expect(utanforAscii(alla)).toEqual([]);
    expect(korningar.filter((k) => k.utfall !== 'KUNDE_INTE').flatMap((k) => k.rader)
      .filter((rad) => FELNAMN.test(rad))).toEqual([]);
    // Kontroll: en rad utanför formerna, en form som ingen körning gav och en delad rad slår ut.
    expect(utanforFormerna([...alla, 'FEL: en rad som ingen form har'])).toEqual(['FEL: en rad som ingen form har']);
    expect(otackta(alla.filter((rad) => !rad.startsWith('FEL: lanken svarar inte')))).toEqual(['FEL svarar inte']);
    expect(utanforAscii([...alla, 'TRASIG: sida ga_igenom: lank /a\nFEL: b: status 404']))
      .toEqual(['TRASIG: sida ga_igenom: lank /a\nFEL: b: status 404']);
  });
});

describe('D-5/Story 11.7 AK 2, 4: skriptet och repot', () => {
  it('F7 (AK 2): skriptet ger tre utfall med var sin exitkod, och en krasch blir aldrig 1', async () => {
    const u = await nyttHem();
    // (a) F6 (a):s konfiguration och läge.
    await skrivKonfig(u);
    ytlage = 'normal';
    const a = await korProvet(u, []);
    expect({ kod: a.kod, forsta: rader(a.ut)[0], fel: a.fel }).toEqual({ kod: 0, forsta: GRON_RAD, fel: '' });
    // (b) Ett okänt ärende i Gå igenom.
    ytlage = 'saknas';
    const b = await korProvet(u, []);
    expect({ kod: b.kod, forsta: rader(b.ut)[0] }).toEqual({ kod: 1, forsta: ROD_RAD });
    // (c) Porten 5435; kontrollen för (d).
    ytlage = 'normal';
    await skrivKonfig(u, { app: `http://${VARD}:5435` });
    const c = await korProvet(u, []);
    expect({ kod: c.kod, forsta: rader(c.ut)[0] }).toEqual({ kod: 2, forsta: KUNDE_INTE_RAD });
    // (d) Ett argument ger KUNDE_INTE innan något läses eller hämtas.
    await skrivKonfig(u);
    appanrop.length = 0;
    fixturanrop.length = 0;
    const d = await korProvet(u, ['x']);
    expect({ kod: d.kod, rader: rader(d.ut) }).toEqual({ kod: 2, rader: [ANROPSRAD] });
    expect(appanrop).toEqual([]);
    expect(fixturanrop).toEqual([]);
    // (e) En krasch i körningen fångas av huvud.
    const e = await korDrivern(u, ['prov', 'krasch']);
    expect({ kod: e.kod, rader: rader(e.ut) }).toEqual({ kod: 2, rader: ['KUNDE_INTE: arendelankar stannade: RuntimeError'] });
    // (f) Var sin kod, och nyckeln står aldrig i utskriften.
    expect([a.kod, b.kod, c.kod]).toEqual([0, 1, 2]);
    for (const p of [a, b, c]) {
      expect(p.ut).not.toContain(provetsNyckel);
      expect(p.fel).not.toContain(provetsNyckel);
    }
  });

  it('F8 (AK 4): repot rörs inte: namnet, package.json, importerna och ingen cachekatalog', async () => {
    // (a) Modulen förs in under kanalens prov_prefix arende. Kontroll: ett annat namn slår ut.
    const inforbar = (namn: string): boolean => namn === 'arendelankar.py' && namn.startsWith('arende');
    expect(inforbar(path.basename(MODULEN))).toBe(true);
    expect(inforbar('lankprov.py')).toBe(false);
    // Mot repot: filen som förs in finns som en vanlig fil i adapter/ och är ett skript för python3.
    // Kontroll: en listning utan filen, och en text utan skriptraden, slår ut.
    const vanligaFiler = (await readdir(ADAPTERN, { withFileTypes: true })).filter((f) => f.isFile()).map((f) => f.name);
    const forsIn = (filer: string[]): string[] => filer.filter(inforbar);
    expect(forsIn(vanligaFiler)).toEqual(['arendelankar.py']);
    expect(forsIn(vanligaFiler.filter((namn) => namn !== 'arendelankar.py'))).toEqual([]);
    const arSkript = (text: string): boolean => text.startsWith('#!/usr/bin/env python3\n');
    expect(arSkript(await readFile(path.join(ADAPTERN, 'arendelankar.py'), 'utf8'))).toBe(true);
    expect(arSkript('import json\n')).toBe(false);
    // (b) Inga nya beroenden. Kontroll: en tillagd nyckel slår ut.
    type Paket = { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const paket = JSON.parse(await readFile(path.join(ROT, 'package.json'), 'utf8')) as Paket;
    const nycklar = (p: Paket): string[][] => [Object.keys(p.dependencies).sort(), Object.keys(p.devDependencies).sort()];
    const VANTADE = [['dotenv', 'express', 'express-rate-limit', 'helmet', 'pg', 'zod'],
      ['@types/express', '@types/node', '@types/pg', '@types/supertest', 'supertest', 'tsx', 'typescript', 'vitest']];
    expect(nycklar(paket)).toEqual(VANTADE);
    expect(nycklar({ ...paket, dependencies: { ...paket.dependencies, requests: '^1.0.0' } })).not.toEqual(VANTADE);
    // (c) Bara standardbiblioteket. Kontroll: en import utanför listan ger en träff.
    const modultext = await readFile(MODULEN, 'utf8');
    expect(importrader(modultext).length).toBeGreaterThanOrEqual(9);
    expect(otillatnaImporter(modultext)).toEqual([]);
    expect(otillatnaImporter('import json\nimport requests\n')).toEqual(['requests']);
    // (d) Efter F7 finns ingen cachekatalog i adapter/. Kontroll: namnet i listan slår ut.
    const utanCache = (namn: string[]): boolean => !namn.includes('__pycache__');
    const listning = await readdir(ADAPTERN);
    expect(utanCache(listning)).toBe(true);
    expect(utanCache([...listning, '__pycache__'])).toBe(false);
  });
});
