// FR-32 (ythalvan), FR-37, FR-14 och B-04 (Story 3.3 AK 1–10): David byter tillstånd och stänger ett
// ärende från ärendesidan. T1 visar läget i läsmodellen (AK 9), T2–T7 formuläret (AK 1, 4, 5, 7, 9) och
// T8–T14 tillståndsgrenen i rättelserutten (AK 2, 3, 4, 6, 7, 8, 10).
//
// Ytan visar regeln i förväg, och servern upprätthåller den (uppdateraArendeState, Story 3.2): T11 skickar
// förbi formuläret. Tillståndsbytet går genom den befintliga POST /vy/arende/:identifier/ratta med
// ?handgrepp=tillstand, så att ingen ny rutt behövs och adresskontraktet står orört (AK 10).
//
// «Noll rader» betyder oförändrade räkningar av events och issues och ett oförändrat avtryck: state_id,
// uppdaterad och åtagandekolumnerna. Befintliga åtaganden ändras alltid med forvantad_revision (Story 5.2).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { hamtaArende } from '../src/services/arenden.js';
import { glomAllaSessioner, startaSession, SESSIONSKAKA } from '../src/http/vy/session.js';
// Namnrymden låter filen laddas innan tillatnaMal finns, så att T5 blir rött och inte hela filen.
import * as skrivning from '../src/http/vy/skrivning.js';
import type { Aktor } from '../src/lib/aktor.js';
import type { StateTyp } from '../src/lib/validation.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

// Fixturernas grunder och belägg, som i test/statusharledning.test.ts rad 29–34.
const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const NY_GRUND = { typ: 'beslut', id: '171', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const HINDER = { typ: 'beslut', id: '145' };
const BELAGG = [{ typ: 'prov', id: 'tillstand-yta', version: '2026-10-23' }];
const SEN = '2026-09-30T08:00:00Z';
const ROT = fileURLToPath(new URL('../', import.meta.url));
const SRC = fileURLToPath(new URL('../src/', import.meta.url));

// ---- Provets egna tabeller ---------------------------------------------------------
//
// Utskrivna ur berättelsen och Story 3.2 AK 3, inte importerade: provet är en specifikation, inte en
// kopia av koden.

/** Lägets tillstånd (Story 3.2 AK 3). */
const MAL = {
  registrerat: 'unstarted', overtaget: 'started', hindrat: 'started',
  genomfort: 'completed', avslutat: 'canceled',
} as const;
type Lage = keyof typeof MAL;
const LAGEN = ['registrerat', 'overtaget', 'hindrat', 'genomfort', 'avslutat'] as const;
const TYPER = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;

const ORD: Record<StateTyp, string> = {
  backlog: 'Ej planerat',
  unstarted: 'Att göra',
  started: 'Pågår',
  completed: 'Klart',
  canceled: 'Avbrutet',
};

const KLASS: Record<StateTyp, string> = {
  backlog: 'chip--muted',
  unstarted: 'chip--muted',
  started: 'chip--info',
  completed: 'chip--ok',
  canceled: 'chip--neg',
};

const LAGESORD: Record<Lage, string> = {
  registrerat: 'registrerat',
  overtaget: 'övertaget',
  hindrat: 'hindrat',
  genomfort: 'genomfört',
  avslutat: 'avslutat',
};

/** T5: det enda mål ytan får erbjuda för ett ärende med åtagande. Öppna mål erbjuds aldrig (AK 5). */
const YTANS_MAL: Record<Lage, StateTyp | null> = {
  registrerat: null,
  overtaget: null,
  hindrat: null,
  genomfort: 'completed',
  avslutat: 'canceled',
};

const BLOCKSTART = '<details class=rattelse><summary>Byt tillstånd</summary>';
const META =
  '<span class=meta>Det gamla tillståndet står kvar i historiken. Ändringen bär din aktörsidentitet.</span>';
const KVITTO_BYTT = '<p class="notis kvitto">Tillståndet är bytt. Det gamla står kvar i historiken.</p>';
const KVITTO_OFORANDRAD = '<p class="notis kvitto">Ingenting ändrades — värdet var redan det du angav.</p>';
const MENING_GENOMFORT = '<p class=notis>Åtagandet är genomfört — ärendet kan stängas som Klart.</p>';
const MENING_AVSLUTAT = '<p class=notis>Åtagandet är avslutat — ärendet kan stängas som Avbrutet.</p>';

/** AK 5: spärrmeningen, med lägesordet utan citattecken. */
function sparrmening(lageord: string): string {
  return (
    `Tillståndet följer åtagandet, som står i läget ${lageord}. Klart går när åtagandet är genomfört ` +
    'och Avbrutet när det är avslutat. Åtagandet redovisas med belägg av den som utför det — inte härifrån.'
  );
}

const chippet = (typ: StateTyp): string => `<span class="chip ${KLASS[typ]}">${ORD[typ]}</span>`;

let app: Express;
let hermes: string;
let david: string;
let teamId: string;
const stateId = {} as Record<StateTyp, string>;

// ---- Hjälpare ur test/statusharledning.test.ts rad 95–195 -------------------------

/** Ett anrop som MÅSTE lyckas. Ett tyst 400 i ett förberedande steg får aldrig bära ett senare fall. */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

/** Ett nytt ärende, skapat av agenten och därför i Ej planerat. */
async function nyttArende(titel: string): Promise<string> {
  return (await steg(hermes, 'create_issue', { title: titel, team_key: 'LOC' })).identifier;
}

/** «Ärende i Pågår»: agenten byter, så att bara fallets egen POST bär människans aktör. */
async function arendeIPagar(titel: string): Promise<string> {
  const id = await nyttArende(titel);
  await steg(hermes, 'update_issue_state', { identifier: id, state_typ: 'started' });
  return id;
}

async function revisionNu(identifier: string): Promise<number> {
  return (await steg(hermes, 'get_atagande', { identifier })).revision;
}

async function iLage(lage: Lage, titel: string): Promise<string> {
  const id = await nyttArende(titel);
  await steg(hermes, 'registrera_atagande', { identifier: id, grund: GRUND, nasta: INTERNT, foljs_upp: SEN });
  const vidare = async (action: string, input: Record<string, unknown>, nyckel = hermes) =>
    steg(nyckel, action, { identifier: id, ...input, forvantad_revision: await revisionNu(id) });
  if (lage === 'registrerat') return id;
  if (lage === 'hindrat') {
    await vidare('hindra_atagande', { orsak: 'Väntar på DNS', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN });
    return id;
  }
  await vidare('ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN }, david);
  if (lage === 'overtaget') return id;
  if (lage === 'genomfort') {
    await vidare('redovisa_resultat', { sammanfattning: 'Klart enligt provet', belagg: BELAGG });
  } else {
    await vidare('avsluta_atagande', { text: 'Ersatt av annat åtagande', grund: NY_GRUND });
  }
  return id;
}

// Ett ärendes id ändras aldrig och inget fall här byter team, så id:t slås upp en gång per ärende.
const ARENDE_ID = new Map<string, string>();
async function arendeId(identifier: string): Promise<string> {
  const sparat = ARENDE_ID.get(identifier);
  if (sparat !== undefined) return sparat;
  const id: string = (await steg(hermes, 'get_issue', { identifier })).arende.id;
  ARENDE_ID.set(identifier, id);
  return id;
}

async function rakningar() {
  return { events: await raknaRader('events'), issues: await raknaRader('issues') };
}

async function avtryck(identifier: string) {
  const { rows } = await pool.query(
    `SELECT state_id, uppdaterad::text, atagande_lage, atagande_tillhor, atagande_revision,
            atagande, atagande_foljs_upp::text, atagande_utforare_typ, atagande_utforare_namn,
            atagande_overtaget_nar::text FROM issues WHERE tenant_id = $1 AND id = $2`,
    [TENANT_ID, await arendeId(identifier)],
  );
  return { ...(await rakningar()), rad: rows[0] };
}

async function radNu(identifier: string) {
  const { rows } = await pool.query(
    'SELECT state_id, uppdaterad::text FROM issues WHERE tenant_id = $1 AND id = $2',
    [TENANT_ID, await arendeId(identifier)],
  );
  return rows[0];
}

async function sistaHandelse(identifier: string) {
  const { rows } = await pool.query(
    `SELECT verb, payload, aktor_typ, aktor_namn FROM events
      WHERE tenant_id = $1 AND issue_id = $2 ORDER BY id DESC LIMIT 1`,
    [TENANT_ID, await arendeId(identifier)],
  );
  return rows[0];
}

async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/** Ägarrollen sätter tillståndet vid sidan av åtagandet, som API:t aldrig gör (Tolkningar punkt 9). */
async function sattStateSomAgare(identifier: string, typ: StateTyp): Promise<void> {
  const id = await arendeId(identifier);
  const admin = await adminKlient();
  try {
    const svar = await admin.query('UPDATE issues SET state_id = $1 WHERE tenant_id = $2 AND id = $3',
      [stateId[typ], TENANT_ID, id]);
    expect(svar.rowCount).toBe(1);
  } finally {
    await admin.end();
  }
}

// ---- Sessioner och felsidor ur test/felbesked-yta.test.ts och test/manniska-yta.test.ts ----

/**
 * Kopia av sessionskaka(nyckel) i test/felbesked-yta.test.ts rad 57–64, bunden till david. En misslyckad
 * inloggning svarar också 303, så kvittot och kakan visar att en session föddes.
 */
async function manniskokaka(): Promise<string> {
  const svar = await request(app).post('/vy/logga-in').type('form').send({ nyckel: david, fran: '/vy' });
  const kaka = [svar.headers['set-cookie'] ?? []].flat().map(String).find((c) => c.startsWith('arenden_vy='));
  if (svar.status !== 303 || svar.headers['location'] !== '/vy?notis=inloggad' || kaka === undefined) {
    throw new Error(`inloggningen misslyckades: ${svar.status} ${String(svar.headers['location'])}`);
  }
  return kaka.split(';')[0]!;
}

/** Kopia ur test/manniska-yta.test.ts rad 100–102: en session som ingen nyckel kan föda i vyn. */
function sessionskakaFor(aktor: Aktor): string {
  return `${SESSIONSKAKA}=${startaSession(aktor)}`;
}

/** Texterna i sidans h1 och p.notis, ur test/felbesked-yta.test.ts rad 74–83. */
function felsidan(html: string): { h1: string[]; notis: string[] } {
  const alla = (re: RegExp): string[] => [...html.matchAll(re)].map((m) => m[1]!);
  return {
    h1: alla(/<h1>([\s\S]*?)<\/h1>/g),
    notis: alla(/<p class=notis>([\s\S]*?)<\/p>/g),
  };
}

// ---- Språket ur test/svenska-yta.test.ts rad 134–150 -------------------------------

const ENTITETER: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/** Synlig text: varje <style>-block bort, varje tagg blir ett blanksteg, esc():s entiteter avkodas. */
function synligText(html: string): string {
  return html
    .replace(/<style\b[\s\S]*?<\/style>/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/g, (entitet) => ENTITETER[entitet]!);
}

/** De fem engelska standardnamnen som hela ord, skiftlägeskänsligt, i den ordning de står. */
function engelskaNamn(text: string): string[] {
  return [...text.matchAll(/\b(Backlog|Todo|In Progress|Done|Canceled)\b/g)].map((m) => m[1]!);
}

// ---- Källtexten under src/http/ ur test/escape-yta.test.ts rad 159–169 -----------

/** Varje .ts-fil under src/http/, med sökvägen relativt src/ och '/' som avskiljare. */
function kallfiler(): { fil: string; text: string }[] {
  return readdirSync(path.join(SRC, 'http'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.posix.join('http', f.split(path.sep).join('/')))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(SRC, fil), 'utf8') }));
}

/** T1: filerna vars text innehåller en fråga mot databasen. Den slutna listan har en post, /health. */
function sqlfiler(filer: { fil: string; text: string }[]): string[] {
  return filer.filter(({ text }) => text.includes('.query(')).map(({ fil }) => fil);
}

/** T1: en post per förekomst av läget som inte föregås direkt av en punkt, alltså inte läses som fält. */
function lagefel(filer: { fil: string; text: string }[]): string[] {
  return filer.flatMap(({ fil, text }) =>
    [...text.matchAll(/atagande_lage/g)].filter((m) => text[m.index! - 1] !== '.').map(() => fil),
  );
}

// ---- Rättelseformuläret ur test/arendetext.test.ts rad 63–92 -----------------------

/** Rättelseformuläret som det första `/ratta"` på sidan, med adressen och fältnamnen ur sidan. */
function rattningsformular(html: string): { action: string; falt: string[] } {
  const trafft = html.indexOf('/ratta"');
  expect(trafft, 'hittade inget rattningsformular pa sidan').toBeGreaterThan(-1);
  const start = html.lastIndexOf('<form', trafft);
  const slut = html.indexOf('</form>', trafft);
  expect(start, 'formularets start hittades inte').toBeGreaterThan(-1);
  expect(slut).toBeGreaterThan(start);
  const form = html.slice(start, slut);
  const action = /action="([^"]+)"/.exec(form)?.[1];
  expect(action, 'formularet saknar action').toBeTruthy();
  const falt: string[] = [];
  for (const m of form.matchAll(/name=(?:"([^"]+)"|([\w-]+))/g)) falt.push((m[1] ?? m[2]) as string);
  return { action: action as string, falt };
}

// ---- Nya hjälpare -------------------------------------------------------------------

/** Tillståndsadressen, provets enda källa för den: grenen i rättelserutten (B-04). */
function tillstandsvag(identifier: string): string {
  return `/vy/arende/${identifier}/ratta?handgrepp=tillstand`;
}

/** GET som måste ge 200. */
async function hamta(vag: string, kaka?: string) {
  const begaran = request(app).get(vag);
  const svar = await (kaka === undefined ? begaran : begaran.set('Cookie', kaka));
  expect(svar.status, `GET ${vag}`).toBe(200);
  return svar;
}

async function sidan(identifier: string, kaka?: string): Promise<string> {
  return (await hamta(`/vy/arende/${identifier}`, kaka)).text;
}

/** Texten från BLOCKSTART till och med nästa </details>; null när blocket saknas. */
function blocket(html: string): string | null {
  const start = html.indexOf(BLOCKSTART);
  if (start === -1) return null;
  if (html.indexOf(BLOCKSTART, start + 1) !== -1) throw new Error('blocket Byt tillstånd står mer än en gång');
  const slut = html.indexOf('</details>', start);
  if (slut === -1) throw new Error('blocket Byt tillstånd slutar aldrig');
  return html.slice(start, slut + '</details>'.length);
}

/** Blocket, eller ett fel som säger att det saknas. */
function blocketPa(html: string): string {
  const b = blocket(html);
  if (b === null) throw new Error('blocket Byt tillstånd saknas på sidan');
  return b;
}

/** Paren värde och ord ur etiketternas exakta form. */
function radioerna(block: string): [string, string][] {
  return [
    ...block.matchAll(/<label><input type=radio name=state_typ value="([^"]*)" required><span>([^<]*)<\/span><\/label>/g),
  ].map((m) => [m[1]!, m[2]!]);
}

/** Formulärets adress och radioknapparnas namn, lästa ur blocket. */
function formularet(block: string): { action: string; namn: string[] } {
  const action = /<form class=skrivform method=post action="([^"]+)">/.exec(block)?.[1];
  if (action === undefined) throw new Error('blocket har inget formulär');
  const namn = [...new Set([...block.matchAll(/<input type=radio name=([\w-]+)/g)].map((m) => m[1]!))];
  return { action, namn };
}

/** Ett formulär-POST, med eller utan kaka och med valfria huvuden. */
function posta(vag: string, kaka: string | undefined, falt: Record<string, string>, huvuden: Record<string, string> = {}) {
  const begaran = request(app).post(vag).set(huvuden);
  return (kaka === undefined ? begaran : begaran.set('Cookie', kaka)).type('form').send(falt);
}

// På filnivå, utanför varje describe, så att varje block har fixturen också när det körs ensamt.
beforeAll(async () => {
  app = createApp();
  glomAllaSessioner();
  // T7 (b) lägger in ett eget tillstånd för teamet och behöver dess id.
  teamId = (await seedaTeam()).id;
  hermes = await nyNyckel({ typ: 'agent', namn: 't33 agent' });
  david = await nyNyckel({ typ: 'manniska', namn: 't33 människa' });
  // Före T7:s nya tillstånd, så att varje typ pekar på standardtillståndet.
  const states = await steg(hermes, 'list_states', { team_key: 'LOC' });
  for (const state of states) stateId[state.typ as StateTyp] = state.id;
});

describe('FR-32/Story 3.3 AK 9: läget kommer ur läsmodellen', () => {
  it('T1 (AK 9): get_issue och hamtaArende bär läget, och vylagret har ingen SQL', async () => {
    const utan = await nyttArende('T1 utan åtagande');
    expect((await steg(hermes, 'get_issue', { identifier: utan })).arende.atagande_lage).toBeNull();
    const medLage = {} as Record<Lage, string>;
    for (const lage of LAGEN) {
      medLage[lage] = await iLage(lage, `T1 ${lage}`);
      const arende = (await steg(hermes, 'get_issue', { identifier: medLage[lage] })).arende;
      expect(arende.atagande_lage, lage).toBe(lage);
    }
    const genomfort = await withTransaction((c) => hamtaArende(c, TENANT_ID, medLage.genomfort));
    expect(genomfort.atagande_lage).toBe('genomfort');

    // Statiskt: under src/http/ finns ingen SQL utom hälsokontrollen, och läget läses bara som fält.
    const filer = kallfiler();
    expect(filer.length).toBeGreaterThan(0);
    expect(sqlfiler(filer)).toEqual(['http/app.ts']);
    expect(lagefel(filer)).toEqual([]);

    // Kontrollen: en påhittad SQL-text i vylagret ger fynd i båda granskningarna.
    const pahittad = [
      ...filer,
      { fil: 'http/vy/pahittad.ts', text: "await client.query('SELECT atagande_lage FROM issues')" },
    ];
    expect(sqlfiler(pahittad)).toEqual(['http/app.ts', 'http/vy/pahittad.ts']);
    expect(lagefel(pahittad)).toEqual(['http/vy/pahittad.ts']);
  });
});

describe('FR-32/Story 3.3 AK 1: formuläret för ett ärende utan åtagande', () => {
  it('T2 (AK 1): blocket står mellan föräldern och etiketterna, med fyra val utan förval', async () => {
    const kaka = await manniskokaka();
    const P = await nyttArende('T2 förälder');
    const C = await nyttArende('T2 barn i Pågår');
    await steg(hermes, 'update_issue', { identifier: C, parent: P });
    await steg(hermes, 'add_label', { identifier: C, label: 't33-etikett' });
    await steg(hermes, 'update_issue_state', { identifier: C, state_typ: 'started' });
    const html = await sidan(C, kaka);

    // Ordningen: summeringen < föräldraraden < blocket < etiketterna.
    const summering = html.indexOf('<p class=summering><span class="chip');
    const foralder = html.indexOf(`<p class=summering>Del av <a href="/vy/arende/${P}">`);
    const start = html.indexOf(BLOCKSTART);
    const taggar = html.indexOf('<div class=taggar>');
    expect(summering, 'summeringen').toBeGreaterThan(-1);
    expect(foralder, 'föräldraraden efter summeringen').toBeGreaterThan(summering);
    expect(start, 'blocket efter föräldraraden').toBeGreaterThan(foralder);
    expect(taggar, 'etiketterna efter blocket').toBeGreaterThan(start);

    const b = blocketPa(html);
    expect(b).toContain(`<form class=skrivform method=post action="${tillstandsvag(C)}">`);
    expect(b).toContain(`<p class=summering>Nu: ${chippet('started')}</p>`);
    expect(b).toContain('<fieldset class=tillstand><legend>Nytt tillstånd</legend>');
    // Rättelseformuläret förblir det första `/ratta"` på sidan (test/arendetext.test.ts rad 68).
    expect(b).not.toContain('/ratta"');
    expect(html.indexOf('/ratta"'), 'det första /ratta" står efter blocket').toBeGreaterThan(start + b.length - 1);

    expect(radioerna(b)).toEqual([
      ['backlog', ORD.backlog], ['unstarted', ORD.unstarted], ['completed', ORD.completed], ['canceled', ORD.canceled],
    ]);
    // Varje knapp har etikettens exakta form, alltså `required` (radioerna() kräver det), och ingen har förval.
    expect(b.match(/type=radio/g)).toHaveLength(4);
    expect(b.match(/<label>/g)).toHaveLength(4);
    expect(b).not.toContain('checked');
    expect(b).not.toContain('disabled');
    expect(b.match(/<button type=submit>Byt tillstånd<\/button>/g)).toHaveLength(1);
    expect(b.match(/<button/g)).toHaveLength(1);
    expect(b).toContain(META);

    // Kontrollen: det utelämnade följer det nuvarande.
    const B = await nyttArende('T2 kontroll i Ej planerat');
    expect(radioerna(blocketPa(await sidan(B, kaka))).map(([varde]) => varde))
      .toEqual(['unstarted', 'started', 'completed', 'canceled']);
  });
});

describe('FR-32/Story 3.3 AK 4 och AK 5: åtagandet styr valen', () => {
  it('T3 (AK 4): genomfört utanför Klart erbjuder bara Klart, avslutat utanför Avbrutet bara Avbrutet', async () => {
    const kaka = await manniskokaka();
    const G = await iLage('genomfort', 'T3 genomfört i Pågår');
    await sattStateSomAgare(G, 'started');
    const A = await iLage('avslutat', 'T3 avslutat i Klart');
    await sattStateSomAgare(A, 'completed');

    const g = blocketPa(await sidan(G, kaka));
    expect(g).toContain(MENING_GENOMFORT);
    expect(radioerna(g)).toEqual([['completed', ORD.completed]]);
    expect(g.match(/type=radio/g)).toHaveLength(1);
    expect(g.match(/<button/g)).toHaveLength(1);
    expect(g).toContain(`<p class=summering>Nu: ${chippet('started')}</p>`);

    const a = blocketPa(await sidan(A, kaka));
    expect(a).toContain(MENING_AVSLUTAT);
    expect(radioerna(a)).toEqual([['canceled', ORD.canceled]]);
    expect(a.match(/type=radio/g)).toHaveLength(1);
    expect(a.match(/<button/g)).toHaveLength(1);
    expect(a).toContain(`<p class=summering>Nu: ${chippet('completed')}</p>`);
  });

  it('T4 (AK 5): i övriga lägen står spärrmeningen och inget val, ingen knapp och inget formulär', async () => {
    const kaka = await manniskokaka();
    for (const lage of LAGEN) {
      const id = await iLage(lage, `T4 ${lage}`);
      const b = blocketPa(await sidan(id, kaka));
      expect(b, lage).toContain(`<p class=summering>Nu: ${chippet(MAL[lage])}</p>`);
      expect(felsidan(b).notis, lage).toEqual([sparrmening(LAGESORD[lage])]);
      for (const text of ['type=radio', '<button', '<form', 'disabled']) {
        expect(b, `${lage}: ${text}`).not.toContain(text);
      }
    }
    // Kontrollen: ett genomfört åtagande utanför Klart har en radioknapp.
    const K = await iLage('genomfort', 'T4 kontroll');
    await sattStateSomAgare(K, 'started');
    expect(blocketPa(await sidan(K, kaka)).match(/type=radio/g)).toHaveLength(1);
  });

  it('T5 (AK 5): tillatnaMal ger exakt tabellens svar, och källtexten saknar disabled och checked', () => {
    const avvikelser: string[] = [];
    const medAtagande: { lage: Lage; typ: StateTyp; svar: StateTyp[] }[] = [];
    let anrop = 0;
    for (const lage of [null, ...LAGEN]) {
      for (const typ of TYPER) {
        const svar: StateTyp[] = skrivning.tillatnaMal(typ, lage);
        anrop += 1;
        const ytans = lage === null ? null : YTANS_MAL[lage];
        const vantat = lage === null
          ? TYPER.filter((t) => t !== typ)
          : ytans !== null && ytans !== typ ? [ytans] : [];
        if (JSON.stringify(svar) !== JSON.stringify(vantat)) {
          avvikelser.push(`${lage ?? 'inget åtagande'}/${typ}: ${JSON.stringify(svar)}`);
        }
        if (lage !== null) medAtagande.push({ lage, typ, svar });
      }
    }
    expect(anrop).toBe(30);
    expect(avvikelser).toEqual([]);

    // De tre «aldrig»-leden var för sig, över de 25 anropen med åtagande.
    expect(medAtagande).toHaveLength(25);
    expect(medAtagande.filter((x) => x.lage === 'genomfort' && x.svar.includes('canceled'))).toEqual([]);
    expect(medAtagande.filter((x) => x.lage === 'avslutat' && x.svar.includes('completed'))).toEqual([]);
    expect(medAtagande.filter((x) => x.svar.some((t) => t === 'backlog' || t === 'unstarted' || t === 'started')))
      .toEqual([]);

    const kalla = readFileSync(path.join(ROT, 'src/http/vy/skrivning.ts'), 'utf8');
    expect(kalla).not.toContain('disabled');
    expect(kalla).not.toContain('checked');
  });
});

describe('FR-32/FR-14/Story 3.3 AK 7: formuläret bara för en människa', () => {
  it('T6 (AK 7): utan kaka, med agentsession och med systemsession saknar sidan formuläret', async () => {
    const X = await arendeIPagar('T6 i Pågår');
    const fall: [string, string | undefined][] = [
      ['utan kaka', undefined],
      ['agentsession', sessionskakaFor({ typ: 'agent', namn: 't33 agentsession' })],
      ['systemsession', sessionskakaFor({ typ: 'system', namn: 't33 systemsession' })],
    ];
    for (const [namn, kaka] of fall) {
      const html = await sidan(X, kaka);
      expect(html, namn).not.toContain('Byt tillstånd');
      expect(html, namn).not.toContain('name=state_typ');
    }
    // Kontrollen: människosessionen har blocket.
    expect(blocket(await sidan(X, await manniskokaka()))).not.toBeNull();
  });
});

describe('FR-37/FR-15/Story 3.3 AK 9: språket, escapingen och träffytorna', () => {
  it('T7 (AK 9): svenska ord, esc() på tillståndets namn, JS-fritt, träffytor och fokus', async () => {
    const kaka = await manniskokaka();
    const B = await nyttArende('T7 språket');
    const svar = await hamta(`/vy/arende/${B}`, kaka);
    const b = blocketPa(svar.text);

    // (a) Språket: alla fem orden i blockets synliga text och inget engelskt standardnamn.
    const synlig = synligText(b);
    for (const ord of Object.values(ORD)) expect(synlig, ord).toContain(ord);
    expect(engelskaNamn(synlig)).toEqual([]);

    // (b) Escapingen: ett tillstånd vars namn bär HTML-tecken. Positionen 5 gör att stateAvTyp(…, 'started')
    // fortfarande väljer In Progress, så att de andra fallen inte påverkas.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workflow_states (tenant_id, team_id, namn, typ, position)
       VALUES ($1, $2, $3, 'started', 5) RETURNING id`,
      [TENANT_ID, teamId, '<b>T33</b>'],
    );
    const E = await nyttArende('T7 escapingen');
    await steg(hermes, 'update_issue_state', { identifier: E, state_id: rows[0]!.id });
    const e = blocketPa(await sidan(E, kaka));
    expect(e).toContain('Nu: <span class="chip chip--info">&lt;b&gt;T33&lt;/b&gt;</span>');
    expect(e).not.toContain('<b>T33</b>');
    expect(radioerna(e).map(([varde]) => varde)).toEqual(['backlog', 'unstarted', 'completed', 'canceled']);

    // (c) JS-fritt: inget skript, inget händelseattribut i blocket och CSP:n oförändrad.
    const handelseattribut = /\son[a-z]+=/i;
    expect(svar.text).not.toContain('<script');
    expect(handelseattribut.test(b)).toBe(false);
    expect(String(svar.headers['content-security-policy'])).toContain("script-src 'none'");
    expect(handelseattribut.test('<button onclick="x">'), 'kontrollen').toBe(true);

    // (d) CSS: fokusringen, scroll-margin-top och träffytorna.
    const css = /<style>([\s\S]*?)<\/style>/.exec(svar.text)?.[1] ?? '';
    for (const text of [
      ':focus-visible{outline:var(--fokus-tjocklek) solid var(--fokus);',
      ':target,a,button,input,summary{scroll-margin-top:3.5rem}',
      'details.rattelse summary{display:flex;align-items:center;min-height:var(--p-traff);',
      '--p-traff:var(--traff)',
    ]) {
      expect(css, text).toContain(text);
    }
    const regelStart = css.indexOf('fieldset.tillstand label{');
    expect(regelStart, 'regeln fieldset.tillstand label').toBeGreaterThan(-1);
    expect(css.slice(regelStart, css.indexOf('}', regelStart))).toContain('min-height:var(--p-traff)');

    // (e) De fokusbara elementen är en sluten mängd: summary, fyra radioknappar och knappen.
    const fokusbara = [...b.matchAll(/<(a|button|input|select|textarea|summary)\b[^>]*>/g)];
    expect(fokusbara.map((m) => m[1])).toEqual(['summary', 'input', 'input', 'input', 'input', 'button']);
    expect(fokusbara.filter((m) => m[1] === 'input').every((m) => m[0].includes('type=radio'))).toBe(true);
    expect(b).not.toContain('tabindex');
  });
});

/** Händelseradens aktör när människan skickat formuläret. */
const MANNISKAN = { aktor_typ: 'manniska', aktor_namn: 't33 människa' };

describe('FR-32/Story 3.3 AK 2 och AK 3: stänga och dubbeltryck', () => {
  it('T8 (AK 2): Klart från formuläret stänger ärendet med människans aktör', async () => {
    const kaka = await manniskokaka();
    const C8 = await arendeIPagar('T8 stangs tillstandsprovet8');
    const lank = `href="/vy/arende/${C8}"`;
    expect((await hamta('/vy')).text, 'överblicken före').toContain(lank);

    // Adressen, fältnamnet och värdet läses ur den renderade sidan.
    const b = blocketPa(await sidan(C8, kaka));
    const { action, namn } = formularet(b);
    expect(action).toBe(tillstandsvag(C8));
    expect(namn).toHaveLength(1);
    const klart = radioerna(b).find(([, ord]) => ord === ORD.completed);
    expect(klart, 'valet Klart').toBeDefined();

    const svar = await posta(action, kaka, { [namn[0]!]: klart![0] });
    expect(svar.status).toBe(303);
    expect(svar.headers['location']).toBe(`/vy/arende/${C8}?notis=tillstand_bytt`);
    expect(await sistaHandelse(C8)).toEqual({
      verb: 'andrade_status',
      payload: { identifier: C8, fran: 'In Progress', till: 'Done', typ: 'completed' },
      ...MANNISKAN,
    });

    const efter = (await hamta(svar.headers['location'], kaka)).text;
    expect(efter).toContain(KVITTO_BYTT);
    expect(efter).toContain(`<p class=summering>${chippet('completed')}`);
    const rader = efter.split('<li class=rad>').filter((rad) => rad.includes('ändrade status Pågår → Klart'));
    expect(rader).toHaveLength(1);
    expect(rader[0]).toContain('människa · t33 människa');

    // Ärendet lämnar överblicken men hittas i sökningen med statusfasetten Klart.
    expect((await hamta('/vy')).text, 'överblicken efter').not.toContain(lank);
    expect((await hamta('/vy/sok?q=tillstandsprovet8&status=completed')).text).toContain(lank);
    expect((await hamta('/vy/sok?q=tillstandsprovet8&status=started')).text).not.toContain(lank);
  });

  it('T9 (AK 3): samma POST igen ger oforandrad, en status_oforandrad-rad och orört tillstånd', async () => {
    const kaka = await manniskokaka();
    const D = await arendeIPagar('T9 dubbeltryck');
    const forsta = await posta(tillstandsvag(D), kaka, { state_typ: 'completed' });
    expect(forsta.status).toBe(303);
    expect(forsta.headers['location']).toBe(`/vy/arende/${D}?notis=tillstand_bytt`);

    const rad = await radNu(D);
    const n = await raknaRader('events');
    const andra = await posta(tillstandsvag(D), kaka, { state_typ: 'completed' });
    expect(andra.status).toBe(303);
    expect(andra.headers['location']).toBe(`/vy/arende/${D}?notis=oforandrad`);
    expect((await hamta(andra.headers['location'], kaka)).text).toContain(KVITTO_OFORANDRAD);
    expect(await raknaRader('events')).toBe(n + 1);
    expect(await sistaHandelse(D)).toEqual({ verb: 'status_oforandrad', payload: { identifier: D }, ...MANNISKAN });
    expect(await radNu(D)).toEqual(rad);
  });
});

describe('FR-32/Story 3.3 AK 4 och AK 6: åtagandet genom tillståndsadressen', () => {
  it('T10 (AK 4): det erbjudna valet går igenom med tillstand_bytt och människans aktör', async () => {
    const kaka = await manniskokaka();
    const G = await iLage('genomfort', 'T10 genomfört i Pågår');
    await sattStateSomAgare(G, 'started');
    const A = await iLage('avslutat', 'T10 avslutat i Klart');
    await sattStateSomAgare(A, 'completed');
    const fall: [string, StateTyp, string, string, string][] = [
      [G, 'completed', 'In Progress', 'Done', LAGESORD.genomfort],
      [A, 'canceled', 'Done', 'Canceled', LAGESORD.avslutat],
    ];
    for (const [id, typ, fran, till, lageord] of fall) {
      const b = blocketPa(await sidan(id, kaka));
      const { action, namn } = formularet(b);
      const val = radioerna(b);
      expect(val, id).toEqual([[typ, ORD[typ]]]);
      const svar = await posta(action, kaka, { [namn[0]!]: val[0]![0] });
      expect(svar.status, id).toBe(303);
      expect(svar.headers['location']).toBe(`/vy/arende/${id}?notis=tillstand_bytt`);
      expect(await sistaHandelse(id)).toEqual({
        verb: 'andrade_status', payload: { identifier: id, fran, till, typ }, ...MANNISKAN,
      });
      expect((await steg(hermes, 'get_issue', { identifier: id })).arende.state_typ).toBe(typ);

      // Ärendet står nu i lägets mål, så sidan visar spärrmeningen och inget val.
      const efter = blocketPa(await sidan(id, kaka));
      expect(felsidan(efter).notis, id).toEqual([sparrmening(lageord)]);
      expect(efter).not.toContain('type=radio');
    }
  });

  it('T11 (AK 6): ett mål som läget inte tillåter ger 400 och noll rader', async () => {
    const kaka = await manniskokaka();
    const R1 = await iLage('genomfort', 'T11 R1 genomfört');
    const R2 = await iLage('registrerat', 'T11 R2 registrerat');
    const R3 = await iLage('avslutat', 'T11 R3 avslutat');
    const fall: [string, StateTyp][] = [[R1, 'canceled'], [R2, 'completed'], [R3, 'started']];
    const fore = new Map<string, unknown>();
    for (const [id] of fall) fore.set(id, await avtryck(id));

    for (const [id, mal] of fall) {
      const svar = await posta(tillstandsvag(id), kaka, { state_typ: mal });
      expect(svar.status, `${id} ${mal}`).toBe(400);
      const felet = felsidan(svar.text);
      expect(felet.h1).toEqual(['Tillståndet följer åtagandet']);
      expect(felet.notis).toEqual([
        `${id} bär ett åtagande, och då följer tillståndet åtagandets läge. ` +
          'Klart går när åtagandet är genomfört och Avbrutet när det är avslutat.',
      ]);
      expect(svar.text).toContain(`<p><a href="/vy/arende/${id}">Tillbaka till ${id}</a></p>`);
      expect(svar.text).toContain('<p>Felkod: <code>atagandet_styr_statusen</code></p>');
    }
    for (const [id] of fall) expect(await avtryck(id), id).toEqual(fore.get(id));

    // Kontrollen skiljer sig bara i målet: lägets eget mål går igenom som ingen ändring.
    const kontroll = await posta(tillstandsvag(R1), kaka, { state_typ: 'completed' });
    expect(kontroll.status).toBe(303);
    expect(kontroll.headers['location']).toBe(`/vy/arende/${R1}?notis=oforandrad`);
  });
});

describe('FR-32/FR-37/Story 3.3 AK 8: ogiltiga värden och okänt ärende', () => {
  it('T12 (AK 8): saknat och ogiltigt värde ger 400 Nytt tillstånd, ett okänt ärende 404 som HTML-sida', async () => {
    const kaka = await manniskokaka();
    const Y = await arendeIPagar('T12 ogiltiga värden');
    const fore = await avtryck(Y);

    const fel: Record<string, string>[] = [{}, { state_typ: 'done' }];
    for (const falt of fel) {
      const svar = await posta(tillstandsvag(Y), kaka, falt);
      expect(svar.status, JSON.stringify(falt)).toBe(400);
      const felet = felsidan(svar.text);
      expect(felet.h1).toEqual(['Ogiltig inmatning']);
      expect(felet.notis).toEqual(['Nytt tillstånd har ett värde som inte kan tas emot.']);
    }

    const okand = await posta(tillstandsvag('LOC-987654'), kaka, { state_typ: 'completed' });
    expect(okand.status).toBe(404);
    expect(String(okand.headers['content-type'])).toContain('text/html');
    expect(okand.text).toContain('<html lang=sv>');
    expect(okand.text.match(/<h1\b/g)).toHaveLength(1);
    expect(felsidan(okand.text).h1).toEqual(['Gick inte att utföra']);
    expect(okand.text).toContain('<p>Felkod: <code>not_found</code></p>');

    expect(await avtryck(Y)).toEqual(fore);

    // Kontrollen: ett giltigt värde till det befintliga ärendet går igenom.
    expect((await posta(tillstandsvag(Y), kaka, { state_typ: 'completed' })).status).toBe(303);
  });
});

describe('FR-14/FR-32/Story 3.3 AK 7: tillståndsadressen kräver session, människa och samma ursprung', () => {
  it('T13 (AK 7): utan kaka 401, agent och system 403, främmande ursprung 403, och noll rader', async () => {
    const kaka = await manniskokaka();
    const X = await arendeIPagar('T13 spärrarna');
    const fore = await avtryck(X);
    const falt = { state_typ: 'completed' };

    const utan = await posta(tillstandsvag(X), undefined, falt);
    expect(utan.status).toBe(401);
    expect(utan.text).toContain('<h1>Inloggning krävs</h1>');

    for (const typ of ['agent', 'system'] as const) {
      const svar = await posta(tillstandsvag(X), sessionskakaFor({ typ, namn: `t33 ${typ}session` }), falt);
      expect(svar.status, typ).toBe(403);
      expect(svar.text).toContain('<h1>Det här kräver en människa</h1>');
      expect(svar.text).toContain('<p>Felkod: <code>kraver_manniska</code></p>');
    }

    const frammande: Record<string, string>[] = [{ Origin: 'https://elak.example' }, { 'Sec-Fetch-Site': 'cross-site' }];
    for (const huvuden of frammande) {
      const svar = await posta(tillstandsvag(X), kaka, falt, huvuden);
      expect(svar.status, JSON.stringify(huvuden)).toBe(403);
      expect(svar.text).toContain('<h1>Gick inte att utföra</h1>');
      expect(svar.text).toContain('<p>Felkod: <code>cross_origin</code></p>');
    }

    expect(await avtryck(X)).toEqual(fore);

    // Kontrollen skiljer sig bara i huvudena: människosessionen utan främmande ursprung byter tillstånd.
    const kontroll = await posta(tillstandsvag(X), kaka, falt);
    expect(kontroll.status).toBe(303);
    expect(kontroll.headers['location']).toBe(`/vy/arende/${X}?notis=tillstand_bytt`);
    expect(await avtryck(X)).not.toEqual(fore);
  });
});

describe('FR-32/FR-29/Story 3.3 AK 10: grenvalet och rättelsen oförändrad', () => {
  it('T14 (AK 10): ett annat handgrepp ger 400 Okänt handgrepp, och rättelsen gör som förut', async () => {
    const kaka = await manniskokaka();
    const Z = await arendeIPagar('T14 grenvalet');
    await steg(david, 'update_issue', { identifier: Z, description: 'T14 grundtext tillstandsprovet14' });
    const fore = await avtryck(Z);

    // De tre avvikande formerna: ett annat värde, ett tomt värde och ett upprepat fält.
    for (const fraga of ['handgrepp=annat', 'handgrepp=', 'handgrepp=tillstand&handgrepp=tillstand']) {
      const svar = await posta(`/vy/arende/${Z}/ratta?${fraga}`, kaka, { state_typ: 'completed' });
      expect(svar.status, fraga).toBe(400);
      const felet = felsidan(svar.text);
      expect(felet.h1, fraga).toEqual(['Okänt handgrepp']);
      expect(felet.notis, fraga).toEqual(['Adressen anger ett handgrepp som ärendesidan inte har. Ingenting sparades.']);
      expect(svar.text).toContain(`<p><a href="/vy/arende/${Z}">Tillbaka till ${Z}</a></p>`);
      expect(svar.text).toContain('<p>Felkod: <code>okant_handgrepp</code></p>');
    }

    expect(await avtryck(Z)).toEqual(fore);
    const arende = (await steg(hermes, 'get_issue', { identifier: Z })).arende;
    expect([arende.description, arende.state_typ]).toEqual(['T14 grundtext tillstandsprovet14', 'started']);

    // Kontrollen: rättelseformuläret är fortfarande det första `/ratta"` på sidan och rättar som förut.
    const form = rattningsformular(await sidan(Z, kaka));
    expect(form.action).toBe(`/vy/arende/${Z}/ratta`);
    expect(form.falt).toEqual(expect.arrayContaining(['titel', 'beskrivning']));
    const rattad = await posta(form.action, kaka, {
      titel: 'T14 rattad titel',
      beskrivning: 'T14 grundtext tillstandsprovet14',
    });
    expect(rattad.status).toBe(303);
    expect(rattad.headers['location']).toBe(`/vy/arende/${Z}?notis=arendet_rattat`);
    const sista = await sistaHandelse(Z);
    expect([sista.verb, sista.aktor_typ, sista.aktor_namn]).toEqual(['andrade_titel', 'manniska', 't33 människa']);
    expect((await steg(hermes, 'get_issue', { identifier: Z })).arende.state_typ).toBe('started');
  });
});
