// FR-15 och B-16 (Story 4.1 AK 1–5): formulären håller sig inom skärmen på telefon och iPad. Stilmallen har
// ett eget block för formulären under telefonbrytpunkten, direkt efter markören B-16. M1 prövar blocket (AK 1)
// och M2 att varje formulärdel på ytans sidor täcks av en regel i det (AK 2). M3 visar att inget max-width-block
// döljer något och att sidramen bär viewport-metan och menypanelen (AK 3), och M5 att designkontraktet står
// kvar: lager 0 och mörkt läge byte för byte, typsnitten från vyn och en JS-fri yta (AK 5). M4 skickar
// inloggningen, en kommentar och en titelrättning genom sidornas egna formulär, med adress och fältnamn lästa
// ur den renderade sidan, och läser kvittot och händelseraden (AK 4).
//
// Provet läser regler, inte layout: ingen webbläsare och ingen CSS-tolk. Mätningen vid telefonens och iPadens
// bredd är Story 10.9. Varje «ingen» och «varje» har en sluten lista: ORD för blockets värden (AK 1), TACKNING
// och SIDOR för formulärdelarna (AK 2), där sidlistan binds till koden av räkningen av formulär i källtexten
// och adressmängden ACTIONS, och de tre max-width-blocken (AK 3). Varje fall prövar först sina kontroller,
// som visar att mätningen kan slå ut.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { glomAllaSessioner } from '../src/http/vy/session.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// ---- Provets egna tabeller ---------------------------------------------------------
//
// Utskrivna ur berättelsen (Dev Notes, Formulärblocket och Sidorna och formulären), inte importerade: provet
// är en specifikation, inte en kopia av stilmallen.

/** AK 1: markören står exakt en gång, och formulärblocket följer direkt efter den. */
const MARKOR = '/* B-16 (FR-15, Story 4.1): formularen under telefonbrytpunkten */';
const BLOCKSTART = '@media(max-width:640px){';

type Regel = { selektorer: string[]; deklarationer: string[] };

/** AK 1: de åtta reglerna i blocket, normaliserade och utan avslutande semikolon. */
const REGLER: Regel[] = [
  { selektorer: ['label'], deklarationer: ['display:block'] },
  {
    selektorer: [
      'input[type=text]', 'input[type=password]', 'input[type=date]', 'input[type=search]', 'textarea', 'select',
    ],
    deklarationer: ['width:100%', 'max-width:100%', 'min-width:0', 'box-sizing:border-box'],
  },
  { selektorer: ['fieldset'], deklarationer: ['border:0', 'padding:0', 'min-width:0'] },
  { selektorer: ['legend'], deklarationer: ['padding:0', 'max-width:100%'] },
  { selektorer: ['fieldset label'], deklarationer: ['display:flex', 'align-items:center', 'min-height:var(--falt-hojd)'] },
  { selektorer: ['form'], deklarationer: ['max-width:100%', 'min-width:0'] },
  { selektorer: ['button'], deklarationer: ['max-width:100%'] },
  { selektorer: ['.skrivrad>button'], deklarationer: ['flex:1 1 auto'] },
];

/** AK 1: de enda delarna utöver var(--namn) som ett värde i blocket får bestå av (Tolkningar, punkt 2). */
const ORD = new Set(['block', 'flex', 'center', 'border-box', 'auto', '0', '1', '100%']);

type Tackning = { signatur: string; selektor: string; deklaration: string } | { signatur: string; ritasInte: true };

/** AK 2: signatur → selektor och deklaration i blocket. Arton på sidorna och två som AK 1 kräver ändå. */
const TACKNING: Tackning[] = [
  { signatur: 'form.skrivform', selektor: 'form', deklaration: 'max-width:100%' },
  { signatur: 'form.taggform', selektor: 'form', deklaration: 'max-width:100%' },
  { signatur: 'form.namnform', selektor: 'form', deklaration: 'max-width:100%' },
  { signatur: 'form.sok', selektor: 'form', deklaration: 'max-width:100%' },
  { signatur: 'input[type=text]', selektor: 'input[type=text]', deklaration: 'width:100%' },
  { signatur: 'input[type=password]', selektor: 'input[type=password]', deklaration: 'width:100%' },
  { signatur: 'input[type=search]', selektor: 'input[type=search]', deklaration: 'width:100%' },
  { signatur: 'input[type=date]', selektor: 'input[type=date]', deklaration: 'width:100%' },
  { signatur: 'textarea', selektor: 'textarea', deklaration: 'width:100%' },
  { signatur: 'select', selektor: 'select', deklaration: 'width:100%' },
  { signatur: 'input[type=radio]', selektor: 'fieldset label', deklaration: 'display:flex' },
  { signatur: 'input[type=hidden]', ritasInte: true },
  { signatur: 'label', selektor: 'label', deklaration: 'display:block' },
  { signatur: 'label.dold', selektor: 'label', deklaration: 'display:block' },
  { signatur: 'fieldset.tillstand', selektor: 'fieldset', deklaration: 'min-width:0' },
  { signatur: 'legend', selektor: 'legend', deklaration: 'max-width:100%' },
  { signatur: 'button', selektor: 'button', deklaration: 'max-width:100%' },
  { signatur: 'button.mild', selektor: 'button', deklaration: 'max-width:100%' },
  { signatur: 'button.tagg', selektor: 'button', deklaration: 'max-width:100%' },
  { signatur: 'div.skrivrad', selektor: '.skrivrad>button', deklaration: 'flex:1 1 auto' },
];

/** AK 2: de arton signaturerna som de sex sidorna bär, exakt. */
const SIGNATURER = [
  'form.skrivform', 'form.taggform', 'form.namnform', 'form.sok', 'input[type=hidden]', 'input[type=password]',
  'input[type=text]', 'input[type=search]', 'input[type=radio]', 'textarea', 'label', 'label.dold',
  'fieldset.tillstand', 'legend', 'button', 'button.mild', 'button.tagg', 'div.skrivrad',
];

type Sida = { namn: string; vag: string; kaka: boolean };

/** AK 2: de sex sidorna. Ärendesidans adress fylls i av beforeAll, när fixturens ärende finns. */
const SIDOR: Sida[] = [
  { namn: 'P1', vag: '/vy/logga-in', kaka: false },
  { namn: 'P2', vag: '/vy/logga-in', kaka: true },
  { namn: 'P3', vag: '', kaka: true },
  { namn: 'P4', vag: '/vy/rattelser', kaka: true },
  { namn: 'P5', vag: '/vy/sok', kaka: false },
  { namn: 'P6', vag: '/vy', kaka: false },
];

/** AK 2: formulärens normaliserade adresser på de sex sidorna. Tolv ställen i koden ger tretton. */
const ACTIONS = new Set([
  '/vy/logga-in',
  '/vy/logga-ut',
  '/vy/arende/LOC-N/kommentar',
  '/vy/arende/LOC-N/ratta',
  '/vy/arende/LOC-N/ratta?handgrepp=tillstand',
  '/vy/kommentar/:id/ratta',
  '/vy/kommentar/:id/tabort',
  '/vy/kommentar/:id/aterstall',
  '/vy/arende/LOC-N/etikett/tabort',
  '/vy/namn/projekt',
  '/vy/namn/etikett',
  '/vy/nyckel/:id/aterkalla',
  '/vy/sok',
]);

/** AK 1: lager 2 och 3 står mellan de här markörerna. Tankstrecket är U+2014, som i stilmallen. */
const LAGER23_START = '/* 2 — SEMANTISKA: roll i granssnittet.';
const MORKT_START = '@media(prefers-color-scheme:dark){';

/** AK 3: viewport-metan, exakt en gång på varje sida. */
const VIEWPORT = "<meta name=viewport content='width=device-width,initial-scale=1'>";

/**
 * AK 5: lager 0 och mörkt läge, från markör till, men inte med, nästa markör. Hasharna är sha256 i hex av
 * texten som utf8, räknade i create-story ur src/http/vy/mall.ts rad 62–83 och 136–151 (Designkontraktets
 * hash). En röd hash betyder i första hand att lager 0 eller mörkt läge har ändrats.
 */
const LAGER0_START = '/* 0 — KONTRAKTET.';
const LAGER0_SLUT = '/* 1 — PRIMITIVA';
const MORKT_SLUT = '/* ---- Grund ---- */';
const LAGER0_SHA256 = 'ecadecd852632ebede1d4a447ea29b845fffb92ac8cdea2cf8af43a2e827cf81';
const MORKT_SHA256 = '19687cd6f7d94d77ce2660af425e6deb4921cf52d98e3a0b374750a5fd34ff75';

let app: Express;
let hermes: string;
let manniska: string;
let kaka: string;

// ---- De rena hjälparna. Alla tar text och ger värden eller fynd, och ingen kastar för ett fynd ----

/** Blanktecken blir ett, och inga blanktecken står kring { } : ; , och >. */
function normalisera(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/ ?([{}:;,>]) ?/g, '$1').trim();
}

/** Texten i det första <style>-blocket, annars tom sträng. */
function stilmall(html: string): string {
  return /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
}

/** Sidan utan sina <style>-block, så att stilmallens text aldrig tas för HTML. */
function utanStil(html: string): string {
  return html.replace(/<style\b[\s\S]*?<\/style>/g, '');
}

function antal(text: string, del: string): number {
  return del === '' ? 0 : text.split(del).length - 1;
}

type Mediablock = { villkor: string; inre: string; slut: number };

/**
 * Blocket som börjar med @media vid `start`: villkoret inom parentesen utan blanktecken, den inre texten
 * mellan blockets klamrar och platsen efter den stängande klammern. null när blocket aldrig stängs.
 */
function mediainre(text: string, start: number): Mediablock | null {
  const oppna = text.indexOf('{', start);
  if (oppna === -1) return null;
  const huvud = text.slice(start + '@media'.length, oppna).replace(/\s+/g, '');
  const villkor = /^\(([^()]*)\)$/.exec(huvud)?.[1] ?? huvud;
  let djup = 0;
  for (let i = oppna; i < text.length; i++) {
    if (text[i] === '{') djup++;
    if (text[i] === '}' && --djup === 0) return { villkor, inre: text.slice(oppna + 1, i), slut: i + 1 };
  }
  return null;
}

/** AK 1: formulärblockets inre text, eller fynden som säger varför det inte går att läsa. */
function formularblocket(css: string): { block: string | null; fynd: string[] } {
  const n = antal(css, MARKOR);
  if (n === 0) return { block: null, fynd: ['markören saknas'] };
  if (n !== 1) return { block: null, fynd: [`markören står ${n} gånger`] };
  const efter = css.indexOf(MARKOR) + MARKOR.length;
  const start = efter + (/^\s*/.exec(css.slice(efter))?.[0].length ?? 0);
  if (!css.startsWith(BLOCKSTART, start)) return { block: null, fynd: [`markören följs inte av ${BLOCKSTART}`] };
  const m = mediainre(css, start);
  if (m === null) return { block: null, fynd: ['blocket stängs inte'] };
  return { block: m.inre, fynd: [] };
}

/** Blockets regler, normaliserade och utan tomma deklarationer. Blocket har inga nästlade block. */
function regler(block: string | null): Regel[] {
  if (block === null) return [];
  return [...block.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selektorer: normalisera(m[1]!).split(',').filter((s) => s !== ''),
    deklarationer: normalisera(m[2]!).split(';').filter((d) => d !== ''),
  }));
}

/** Namnen som texten definierar, alltså --namn följt av kolon. */
function namnI(text: string): Set<string> {
  return new Set([...text.matchAll(/--([a-z0-9-]+):/g)].map((m) => m[1]!));
}

/** Texten från startmarkören till, men inte med, slutmarkören. Varje markör ska stå exakt en gång. */
function segment(css: string, start: string, slut: string): { text: string; fynd: string[] } {
  const fynd: string[] = [];
  const nStart = antal(css, start);
  const nSlut = antal(css, slut);
  if (nStart !== 1) fynd.push(`startmarkören står ${nStart} gånger`);
  if (nSlut !== 1) fynd.push(`slutmarkören står ${nSlut} gånger`);
  if (fynd.length > 0) return { text: '', fynd };
  const i = css.indexOf(start);
  const j = css.indexOf(slut);
  if (j < i) return { text: '', fynd: ['markörerna står i fel ordning'] };
  return { text: css.slice(i, j), fynd: [] };
}

/** AK 1: namnen i lager 2 och 3, de enda som blocket får referera. */
function lager23(css: string): Set<string> {
  return namnI(segment(css, LAGER23_START, MORKT_START).text);
}

function bar(regellista: Regel[], selektor: string, deklaration: string): boolean {
  return regellista.some((r) => r.selektorer.includes(selektor) && r.deklarationer.includes(deklaration));
}

/** AK 1: varje selektor och deklaration i REGLER som ingen regel med selektorn bär. */
function regelfel(regellista: Regel[]): string[] {
  return REGLER.flatMap(({ selektorer, deklarationer }) =>
    selektorer.flatMap((s) => deklarationer.filter((d) => !bar(regellista, s, d)).map((d) => `saknas: ${s} { ${d} }`)),
  );
}

/**
 * AK 1, tillåtelselistan: ett värde består bara av var(--namn) med ett lager 2- eller 3-namn och av orden i
 * ORD. Allt annat är ett fynd, så provet behöver inte känna igen formen av en literal.
 */
function vardefel(regellista: Regel[], namn: Set<string>): string[] {
  const fynd: string[] = [];
  for (const deklaration of regellista.flatMap((r) => r.deklarationer)) {
    const kolon = deklaration.indexOf(':');
    if (kolon === -1) {
      fynd.push(`${deklaration}: utan värde`);
      continue;
    }
    const egenskap = deklaration.slice(0, kolon);
    const varde = deklaration.slice(kolon + 1);
    for (const grupp of varde.match(/var\([^)]*\)/g) ?? []) {
      const n = /^var\(--([a-z0-9-]+)\)$/.exec(grupp)?.[1];
      if (n === undefined || !namn.has(n)) fynd.push(`${egenskap}: ${grupp}`);
    }
    for (const del of varde.replace(/var\([^)]*\)/g, ' ').split(' ')) {
      if (del !== '' && !ORD.has(del)) fynd.push(`${egenskap}: ${del}`);
    }
  }
  return fynd;
}

const ENTITETER: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Attributen i en starttagg, citerade och ociterade, med esc():s entiteter avkodade. */
function attributen(text: string): Map<string, string> {
  const ut = new Map<string, string>();
  for (const m of text.matchAll(/([^\s=/]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    const varde = m[2] ?? m[3] ?? m[4] ?? '';
    ut.set(m[1]!.toLowerCase(), varde.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITETER[e]!));
  }
  return ut;
}

type Element = { signatur: string; attribut: string };

/**
 * AK 2: varje formulärelement på sidan med sin signatur: taggen, för input typen inom hakparentes och
 * klasserna med punkt i bokstavsordning. En div räknas bara när klasslistan har skrivrad. Ett input utan
 * typ får ingen hakparentes, så att det aldrig tas för input[type=text], som selektorn inte träffar.
 */
function formularelement(html: string): Element[] {
  const ut: Element[] = [];
  const taggar = /<(form|input|textarea|select|button|label|fieldset|legend|div)(?=[\s>/])([^>]*)>/gi;
  for (const m of utanStil(html).matchAll(taggar)) {
    const tagg = m[1]!.toLowerCase();
    const attr = attributen(m[2]!);
    const klasser = (attr.get('class') ?? '').split(/\s+/).filter((k) => k !== '').sort();
    if (tagg === 'div' && !klasser.includes('skrivrad')) continue;
    const typ = attr.get('type');
    const hak = tagg === 'input' && typ !== undefined ? `[type=${typ.toLowerCase()}]` : '';
    ut.push({ signatur: tagg + hak + klasser.map((k) => `.${k}`).join(''), attribut: m[2]! });
  }
  return ut;
}

type Hamtad = { namn: string; html: string; csp?: string };

/** AK 2: en okänd formulärdel, eller en känd utan sin regel, per sida. Varje fynd står en gång. */
function tackningsfel(sidor: Hamtad[], regellista: Regel[]): string[] {
  const fynd = new Set<string>();
  for (const { namn, html } of sidor) {
    for (const { signatur } of formularelement(html)) {
      const rad = TACKNING.find((t) => t.signatur === signatur);
      if (rad === undefined) fynd.add(`okänd formulärdel: ${signatur} på ${namn}`);
      else if (!('ritasInte' in rad) && !bar(regellista, rad.selektor, rad.deklaration)) {
        fynd.add(`utan regel: ${signatur} (${rad.selektor} { ${rad.deklaration} }) på ${namn}`);
      }
    }
  }
  return [...fynd];
}

/** AK 2: style, size och cols på ett formulärelement. Citerade värden läses inte, bara attributnamnen. */
function attributfel(sidor: Hamtad[]): string[] {
  const fynd: string[] = [];
  for (const { namn, html } of sidor) {
    for (const { signatur, attribut } of formularelement(html)) {
      const utanVarden = attribut.replace(/"[^"]*"|'[^']*'/g, '""');
      for (const m of utanVarden.matchAll(/(?:^|\s)(style|size|cols)=/gi)) {
        fynd.push(`${signatur}: ${m[1]!.toLowerCase()} på ${namn}`);
      }
    }
  }
  return fynd;
}

/** Ärendenumret blir LOC-N och ett uuid :id, så att adressen inte beror på fixturens nummer. */
function normaliseradAdress(adress: string): string {
  return adress
    .replace(/\/LOC-\d+(?=[/?#]|$)/g, '/LOC-N')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
}

/** AK 2: formulärens normaliserade adresser på sidan. Ett formulär utan adress syns som ett eget värde. */
function actions(html: string): Set<string> {
  const ut = new Set<string>();
  for (const m of utanStil(html).matchAll(/<form(?=[\s>])([^>]*)>/gi)) {
    const action = attributen(m[1]!).get('action');
    ut.add(action === undefined ? '(utan action)' : normaliseradAdress(action));
  }
  return ut;
}

/** AK 2: antalet ställen i källtexten under src/http/ som renderar ett formulär. */
function formstallen(): number {
  return readdirSync(path.join(SRC, 'http'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .reduce((summa, f) => summa + antal(readFileSync(path.join(SRC, 'http', f), 'utf8'), '<form'), 0);
}

/**
 * AK 3: varje block i stilmallen vars villkor börjar med max-width, också med blanktecken mellan @media,
 * parentesen och kolonet. null står för ett block som aldrig stängs.
 */
function mediablocken(css: string): (Mediablock | null)[] {
  return [...css.matchAll(/@media\s*\(\s*max-width\s*:/g)].map((m) => mediainre(css, m.index!));
}

/** AK 3: de två deklarationerna som döljer, med blanktecken borttagna och gemener. */
function doljfel(inre: string): string[] {
  const tat = inre.replace(/\s+/g, '').toLowerCase();
  return ['display:none', 'visibility:hidden'].filter((d) => tat.includes(d));
}

/** AK 3 och 5: sidramen bär viewport-metan exakt en gång och menyn utan skript. */
function sidramfel(html: string): string[] {
  const fynd: string[] = [];
  const n = antal(html, VIEWPORT);
  if (n !== 1) fynd.push(`viewport-metan står ${n} gånger`);
  if (!html.includes('<details class=navmenu><summary>')) fynd.push('menyknappen saknas');
  if (!html.includes('<div class=navmenu__panel><div class=navmenu__grid>')) fynd.push('menypanelen saknas');
  if (html.includes('<script')) fynd.push('skript');
  return fynd;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** AK 5: namnen i `a` som inte står i `b`, sorterade. */
function skillnad(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((n) => !b.has(n)).sort();
}

type Formular = { action: string; falt: { namn: string; typ: string }[]; dolda: Record<string, string> };

/**
 * AK 4: det första formuläret vars adress slutar på `slutpa`, med adressen, namn och typ för varje synligt
 * input och textarea, och de dolda fälten med sina värden. Förebilden är test/arendetext.test.ts rad 63–92.
 */
function formularet(html: string, slutpa: string): Formular {
  for (const m of utanStil(html).matchAll(/<form(?=[\s>])([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = attributen(m[1]!).get('action');
    if (action === undefined || !action.endsWith(slutpa)) continue;
    const falt: Formular['falt'] = [];
    const dolda: Record<string, string> = {};
    for (const f of m[2]!.matchAll(/<(input|textarea)(?=[\s>/])([^>]*)>/gi)) {
      const attr = attributen(f[2]!);
      const namn = attr.get('name');
      if (namn === undefined) continue;
      const typ = f[1]!.toLowerCase() === 'textarea' ? 'textarea' : (attr.get('type') ?? 'text').toLowerCase();
      if (typ === 'hidden') dolda[namn] = attr.get('value') ?? '';
      else falt.push({ namn, typ });
    }
    return { action, falt, dolda };
  }
  throw new Error(`sidan har inget formulär med en adress som slutar på ${slutpa}`);
}

// ---- Kontrollernas hjälpare --------------------------------------------------------

/** En påhittad stilmall: markören, brytpunkten och den inre texten. */
function medBlock(inre: string): string {
  return `${MARKOR}\n${BLOCKSTART}${inre}}`;
}

/** Blockets inre text ur REGLER, en regel per post. `utan` utelämnar posten med den selektorlistan. */
function braBlock(utan?: string): string {
  return REGLER.filter((r) => r.selektorer.join(',') !== utan)
    .map((r) => `${r.selektorer.join(',')}{${r.deklarationer.join(';')}}`)
    .join('\n');
}

// ---- Ramen ur test/tillstand-yta.test.ts rad 104–117, 215–228 och 361–371 -------

/** Ett anrop som MÅSTE lyckas. Ett tyst 400 i ett förberedande steg får aldrig bära ett senare fall. */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

/** Kopia av manniskokaka() i test/tillstand-yta.test.ts rad 221–228, bunden till människans nyckel. */
async function manniskokaka(): Promise<string> {
  const svar = await request(app).post('/vy/logga-in').type('form').send({ nyckel: manniska, fran: '/vy' });
  const kakan = [svar.headers['set-cookie'] ?? []].flat().map(String).find((c) => c.startsWith('arenden_vy='));
  if (svar.status !== 303 || svar.headers['location'] !== '/vy?notis=inloggad' || kakan === undefined) {
    throw new Error(`inloggningen misslyckades: ${svar.status} ${String(svar.headers['location'])}`);
  }
  return kakan.split(';')[0]!;
}

/** GET som måste ge 200, med eller utan kaka. */
async function hamta(vag: string, kakan?: string) {
  const begaran = request(app).get(vag);
  const svar = await (kakan === undefined ? begaran : begaran.set('Cookie', kakan));
  expect(svar.status, `GET ${vag}`).toBe(200);
  return svar;
}

/** De sex sidorna i SIDOR, var och en med 200, sin HTML och sitt CSP-huvud. */
async function sidorna(): Promise<Hamtad[]> {
  const ut: Hamtad[] = [];
  for (const { namn, vag, kaka: medKaka } of SIDOR) {
    const svar = await hamta(vag, medKaka ? kaka : undefined);
    ut.push({ namn, html: svar.text, csp: String(svar.headers['content-security-policy']) });
  }
  return ut;
}

/** Ett formulär-POST, med eller utan kaka. */
function posta(vag: string, kakan: string | undefined, falt: Record<string, string>) {
  const begaran = request(app).post(vag);
  return (kakan === undefined ? begaran : begaran.set('Cookie', kakan)).type('form').send(falt);
}

async function arendeId(identifier: string): Promise<string> {
  return (await steg(hermes, 'get_issue', { identifier })).arende.id;
}

/** AK 4: ärendets senaste händelserad, med verbet om det anges, som i test/tillstand-yta.test.ts rad 187–194. */
async function sistaHandelse(identifier: string, verb?: string) {
  const villkor = verb === undefined ? '' : ' AND verb = $3';
  const { rows } = await pool.query(
    `SELECT verb, payload, aktor_typ, aktor_namn FROM events
      WHERE tenant_id = $1 AND issue_id = $2${villkor} ORDER BY id DESC LIMIT 1`,
    [TENANT_ID, await arendeId(identifier), ...(verb === undefined ? [] : [verb])],
  );
  return rows[0];
}

// På filnivå, utanför varje describe, så att varje block har fixturen också när det körs ensamt.
beforeAll(async () => {
  app = createApp();
  glomAllaSessioner();
  await seedaTeam();
  hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  manniska = await nyNyckel({ typ: 'manniska', namn: 'm41 människa' });
  // Ärendet saknar åtagande, så Byt tillstånd visar fyra radioknappar. Etiketten ger etikettknappen.
  const arende = await steg(hermes, 'create_issue', {
    title: 'M41 formulären', team_key: 'LOC', labels: ['M41-etikett'],
  });
  SIDOR.find((s) => s.namn === 'P3')!.vag = `/vy/arende/${arende.identifier}`;
  // En kommentar som står kvar ger Rätta eller ta bort, och en borttagen ger Återställ.
  await steg(manniska, 'add_comment', { identifier: arende.identifier, body: 'M41 kommentar som står kvar' });
  const bort = await steg(manniska, 'add_comment', { identifier: arende.identifier, body: 'M41 kommentar som tas bort' });
  await steg(manniska, 'delete_comment', { kommentar_id: bort.id });
  // Ett projekt, så att /vy/rattelser visar form.namnform för projekt som för etiketter.
  await pool.query("INSERT INTO projects (tenant_id, namn) VALUES ($1, 'M41 projekt') ON CONFLICT DO NOTHING", [TENANT_ID]);
  kaka = await manniskokaka();
});

describe('FR-15/Story 4.1 AK 1: formulärreglerna under telefonbrytpunkten', () => {
  it('M1 (AK 1): blocket efter markören har reglerna, bara lager 2/3-tokens och orden i ORD', async () => {
    const css = stilmall((await hamta('/vy/logga-in')).text);
    const namn = lager23(css);

    // Kontrollerna: var och en skiljer sig från det goda utfallet i exakt en sak.
    expect(formularblocket('').fynd).toEqual(['markören saknas']);
    expect(formularblocket(medBlock(braBlock()) + medBlock(braBlock())).fynd).toEqual(['markören står 2 gånger']);
    expect(formularblocket(`${MARKOR}\n@media(max-width:700px){${braBlock()}}`).fynd)
      .toEqual(['markören följs inte av @media(max-width:640px){']);
    expect(formularblocket(medBlock(braBlock())).fynd, 'den positiva kontrollen').toEqual([]);
    expect(regelfel(regler(braBlock())), 'den positiva kontrollen').toEqual([]);
    expect(vardefel(regler(braBlock()), namn), 'den positiva kontrollen').toEqual([]);
    expect(vardefel(regler(braBlock() + 'label{color:#fff}'), namn)).toEqual(['color: #fff']);
    expect(vardefel(regler(braBlock() + '.x{margin:8px}'), namn)).toEqual(['margin: 8px']);
    expect(vardefel(regler(braBlock() + '.x{width:var(--paper)}'), namn)).toEqual(['width: var(--paper)']);
    expect(vardefel(regler(braBlock() + '.x{min-height:var(--p-traff)}'), namn)).toEqual(['min-height: var(--p-traff)']);
    const reserv = vardefel(regler(braBlock() + '.x{min-height:var(--falt-hojd, 2px)}'), namn);
    expect(reserv).toHaveLength(1);
    expect(reserv[0]).toMatch(/^min-height: var\(--falt-hojd/);
    expect(regelfel(regler(braBlock('fieldset label')))).toEqual(expect.arrayContaining([
      'saknas: fieldset label { display:flex }',
      'saknas: fieldset label { min-height:var(--falt-hojd) }',
    ]));
    for (const n of ['falt-hojd', 'text-svag', 'fokus-avstand']) expect(namn.has(n), `lager 2/3 har ${n}`).toBe(true);
    for (const n of ['traff', 'p-traff', 'paper']) expect(namn.has(n), `lager 2/3 saknar ${n}`).toBe(false);

    // Stilmallen ur sidan: blocket finns, bär varje regel och har bara tillåtna värden.
    const { block, fynd } = formularblocket(css);
    expect(fynd).toEqual([]);
    expect(regelfel(regler(block))).toEqual([]);
    expect(vardefel(regler(block), namn)).toEqual([]);
    // Minst --traff höjd genom lager 3: --falt-hojd → --p-traff → --traff.
    for (const text of ['--falt-hojd:var(--p-traff)', '--p-traff:var(--traff)', '--traff:2.75rem']) {
      expect(css, text).toContain(text);
    }
  });
});

describe('FR-15/Story 4.1 AK 2: varje formulär i ytan omfattas', () => {
  it('M2 (AK 2): varje formulärdel på de sex sidorna har en regel, och ingen har en fast bredd', async () => {
    const pahittad: Hamtad = {
      namn: 'påhittad',
      html:
        '<form class=ny method=post action="/vy/ny"><input type=email name=e><textarea name=t cols=80></textarea>' +
        '<input type=text name=s size=40><input type=text name=w style="width:30rem">' +
        '<input type=hidden name=h value=x><button type=submit>Skicka</button></form>',
    };
    const knapplos: Hamtad = {
      namn: 'utan knappregel',
      html: '<form class=skrivform action="/vy/x"><button type=submit>x</button></form>',
    };

    // Kontrollerna: en okänd formklass och inputtyp, hidden utan fynd, ett fynd per attribut och en saknad regel.
    expect(tackningsfel([pahittad], regler(braBlock()))).toEqual([
      'okänd formulärdel: form.ny på påhittad',
      'okänd formulärdel: input[type=email] på påhittad',
    ]);
    expect(attributfel([pahittad])).toEqual([
      'textarea: cols på påhittad',
      'input[type=text]: size på påhittad',
      'input[type=text]: style på påhittad',
    ]);
    expect(tackningsfel([knapplos], regler(braBlock('button'))))
      .toEqual(['utan regel: button (button { max-width:100% }) på utan knappregel']);
    const sidor = await sidorna();
    const utanP4 = new Set(sidor.filter((s) => s.namn !== 'P4').flatMap((s) => [...actions(s.html)]));
    expect([...ACTIONS].filter((a) => !utanP4.has(a)).sort())
      .toEqual(['/vy/namn/etikett', '/vy/namn/projekt', '/vy/nyckel/:id/aterkalla']);

    // De sex sidorna mot blocket ur stilmallen.
    const { block } = formularblocket(stilmall(sidor[0]!.html));
    expect(tackningsfel(sidor, regler(block))).toEqual([]);
    expect(attributfel(sidor)).toEqual([]);
    const signaturer = new Set(sidor.flatMap((s) => formularelement(s.html).map((e) => e.signatur)));
    expect([...signaturer].sort()).toEqual([...SIGNATURER].sort());
    expect([...new Set(sidor.flatMap((s) => [...actions(s.html)]))].sort()).toEqual([...ACTIONS].sort());
    // Sidlistan är bunden till koden: ett nytt formulär ändrar räkningen tills det står i SIDOR och ACTIONS.
    expect(formstallen()).toBe(12);
  });
});

describe('FR-15/Story 4.1 AK 3: ingen funktion döljs under brytpunkten', () => {
  it('M3 (AK 3): inget max-width-block döljer något, och varje sida bär viewport-metan och menypanelen', async () => {
    const sidor = await sidorna();
    const css = stilmall(sidor[0]!.html);

    // Kontrollerna: blanksteg, versaler, en saknad viewport och ett fjärde block med blanksteg efter @media.
    expect(doljfel('.x{display: none}')).toEqual(['display:none']);
    expect(doljfel('.y{VISIBILITY:HIDDEN}')).toEqual(['visibility:hidden']);
    expect(sidramfel(sidor[0]!.html.replace(VIEWPORT, ''))).toEqual(['viewport-metan står 0 gånger']);
    expect(mediablocken(`${css}@media (max-width:500px){.z{color:var(--text)}}`)).toHaveLength(4);

    // Stilmallen: exakt tre max-width-block, och inget av dem döljer något.
    const block = mediablocken(css);
    expect(block.map((b) => b?.villkor)).toEqual(['max-width:1099px', 'max-width:640px', 'max-width:640px']);
    for (const b of block) expect(doljfel(b?.inre ?? ''), b?.villkor).toEqual([]);
    // Menypanelen tar skärmens bredd i en spalt (regression), och det andra 640-blocket är formulärblocket.
    const meny = block.filter((b) => b?.inre.includes('.navmenu__panel{'));
    expect(meny).toHaveLength(1);
    expect(meny[0]!.inre).toContain('.navmenu__panel{left:0;margin:0 8px;width:calc(100vw - 16px);');
    expect(meny[0]!.inre).toContain('.navmenu__grid{columns:1;column-gap:0}');
    expect(block[2]?.inre).toBe(formularblocket(css).block);
    for (const s of sidor) expect(sidramfel(s.html), s.namn).toEqual([]);
  });
});

describe('FR-15/Story 4.1 AK 5: designkontraktet står kvar', () => {
  it('M5 (AK 5): lager 0 och mörkt läge byte för byte, typsnitten från vyn och en JS-fri yta', async () => {
    const sidor = await sidorna();
    const css = stilmall(sidor[0]!.html);
    const lager0 = segment(css, LAGER0_START, LAGER0_SLUT);
    const morkt = segment(css, MORKT_START, MORKT_SLUT);
    const handelseattribut = /\son[a-z]+=/i;

    // Kontrollerna: ett ändrat tecken, en saknad markör, ett främmande namn, en okänd fil och ett händelseattribut.
    expect(lager0.text).toContain('oklch(0.984');
    expect(sha256(lager0.text.replace('oklch(0.984', 'oklch(0.985'))).not.toBe(LAGER0_SHA256);
    expect(segment(css.replace(LAGER0_START, '/* 0 - X'), LAGER0_START, LAGER0_SLUT).fynd)
      .toEqual(['startmarkören står 0 gånger']);
    expect(skillnad(namnI(`${morkt.text}--yta:var(--paper);`), namnI(lager0.text))).toEqual(['yta']);
    expect((await request(app).get('/vy/typsnitt/okand.woff2')).status).toBe(404);
    expect(handelseattribut.test('<button onclick="x">')).toBe(true);

    // Lager 0 och mörkt läge byte för byte, och mörkt läge pekar bara om namn som lager 0 definierar.
    expect(lager0.fynd).toEqual([]);
    expect(morkt.fynd).toEqual([]);
    expect(sha256(lager0.text)).toBe(LAGER0_SHA256);
    expect(sha256(morkt.text)).toBe(MORKT_SHA256);
    const morkaNamn = namnI(morkt.text);
    expect(morkaNamn.size).toBeGreaterThan(0);
    expect(skillnad(morkaNamn, namnI(lager0.text))).toEqual([]);

    // Typsnitten serveras från vyns egen rutt: exakt fem url(, alla till en woff2 under /vy/typsnitt/.
    expect(antal(css, 'url(')).toBe(5);
    for (const [, varde] of css.matchAll(/url\(([^)]*)\)/g)) {
      const fil = /^"(\/vy\/typsnitt\/[^"]+\.woff2)"$/.exec(varde!)?.[1];
      expect(fil, `url(${varde})`).toBeDefined();
      const svar = await request(app).get(fil!);
      expect(svar.status, fil).toBe(200);
      expect(String(svar.headers['content-type']), fil).toMatch(/^font\/woff2/);
    }

    // Ytan är JS-fri: inget skript, inget händelseattribut och CSP:n med script-src 'none'.
    for (const s of sidor) {
      expect(s.html, s.namn).not.toContain('<script');
      expect(handelseattribut.test(utanStil(s.html)), s.namn).toBe(false);
      expect(s.csp, s.namn).toContain("script-src 'none'");
    }
  });
});

describe('FR-15/Story 4.1 AK 4: formulären går att skicka med kvitto', () => {
  it('M4 (AK 4): inloggningen, kommentaren och titelrättningen skickas genom sidornas egna formulär', async () => {
    // Fallets eget ärende, skapat av agenten, så att bara fallets egna POST bär människans aktör.
    const identifier = (await steg(hermes, 'create_issue', { title: 'M41 skicka', team_key: 'LOC' })).identifier;
    const arendesidan = `/vy/arende/${identifier}`;

    // (a) Inloggningen: adressen, det dolda fältet och lösenordsfältets namn ur sidan. Inloggningen skriver
    // ingen händelserad (Tolkningar, punkt 3); kvittot är notisen och hörnet med människo-aktören.
    const foreA = await raknaRader('events');
    const inlogg = formularet((await hamta('/vy/logga-in')).text, '/vy/logga-in');
    expect(inlogg.action).toBe('/vy/logga-in');
    expect(Object.keys(inlogg.dolda)).toEqual(['fran']);
    const losen = inlogg.falt.find((f) => f.typ === 'password');
    expect(losen, 'lösenordsfältet').toBeDefined();
    const a = await posta(inlogg.action, undefined, { ...inlogg.dolda, [losen!.namn]: manniska });
    expect(a.status).toBe(303);
    expect(a.headers['location']).toBe('/vy?notis=inloggad');
    const satt = [a.headers['set-cookie'] ?? []].flat().map(String).find((c) => c.startsWith('arenden_vy='));
    expect(satt, 'kakan arenden_vy').toBeDefined();
    const kakan = satt!.split(';')[0]!;
    const efterA = (await hamta(String(a.headers['location']), kakan)).text;
    expect(efterA).toContain(
      '<p class="notis kvitto">Du är inloggad. Dina ändringar bär din aktörsidentitet i händelseloggen.</p>',
    );
    expect(efterA).toContain('människa · m41 människa');
    expect(await raknaRader('events')).toBe(foreA);

    // (b) Kommentaren: formuläret vars adress slutar på /kommentar och dess textruta, med kakan ur (a).
    const kommentar = formularet((await hamta(arendesidan, kakan)).text, '/kommentar');
    const textruta = kommentar.falt.find((f) => f.typ === 'textarea');
    expect(textruta, 'kommentarens textruta').toBeDefined();
    const kommentarsfalt = { ...kommentar.dolda, [textruta!.namn]: 'M41 från telefonformuläret' };
    const foreB = await raknaRader('events');
    const b = await posta(kommentar.action, kakan, kommentarsfalt);
    expect(b.status).toBe(303);
    expect(b.headers['location']).toBe(`${arendesidan}?notis=kommenterad`);
    expect((await hamta(String(b.headers['location']), kakan)).text)
      .toContain('<p class="notis kvitto">Kommentaren är sparad.</p>');
    expect(await raknaRader('events')).toBe(foreB + 1);
    const kommenterade = await sistaHandelse(identifier);
    expect([kommenterade.verb, kommenterade.aktor_typ, kommenterade.aktor_namn])
      .toEqual(['kommenterade', 'manniska', 'm41 människa']);

    // (c) Titelrättningen: det första formuläret med en adress som slutar på /ratta. Tillståndsformulärets
    // adress slutar på ?handgrepp=tillstand och kommentarens /vy/kommentar/<id>/ratta står längre ner (B-04).
    const ratta = formularet((await hamta(arendesidan, kakan)).text, '/ratta');
    expect(ratta.action).toBe(`${arendesidan}/ratta`);
    const titel = ratta.falt.find((f) => f.typ === 'text');
    const beskrivning = ratta.falt.find((f) => f.typ === 'textarea');
    expect(titel, 'titelfältet').toBeDefined();
    expect(beskrivning, 'beskrivningens textruta').toBeDefined();
    const c = await posta(ratta.action, kakan, {
      ...ratta.dolda, [titel!.namn]: 'M41 rättad titel', [beskrivning!.namn]: '',
    });
    expect(c.status).toBe(303);
    expect(c.headers['location']).toBe(`${arendesidan}?notis=arendet_rattat`);
    expect((await hamta(String(c.headers['location']), kakan)).text)
      .toContain('<p class="notis kvitto">Ärendet är rättat. Den gamla texten finns kvar i historiken.</p>');
    const { rows } = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND issue_id = $2 AND verb = 'andrade_titel'",
      [TENANT_ID, await arendeId(identifier)],
    );
    expect(rows[0]!.n).toBe(1);
    const titelrad = await sistaHandelse(identifier, 'andrade_titel');
    expect([titelrad.payload.fran, titelrad.payload.till, titelrad.aktor_typ, titelrad.aktor_namn])
      .toEqual(['M41 skicka', 'M41 rättad titel', 'manniska', 'm41 människa']);

    // (d) Kontrollen: samma POST som i (b) utan kakan ger 401 och skriver ingenting.
    const foreD = await raknaRader('events');
    const d = await posta(kommentar.action, undefined, kommentarsfalt);
    expect(d.status).toBe(401);
    expect(await raknaRader('events')).toBe(foreD);
  });
});
