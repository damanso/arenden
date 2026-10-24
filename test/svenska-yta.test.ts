// FR-37, B-14 (Story 2.1 AK 1–6): ytan visar varje tillstånd och varje händelse på svenska.
//
// Tillstånden översätts BARA vid visning. De lagrade namnen är Linears (STANDARD_STATES) och står
// kvar i workflow_states och i händelsernas payload (AK 3); tabellen STATUSORD i
// src/http/vy/mall.ts ger ordet, och ett namn som inte står där visas som det är lagrat (AK 2).
//
// Verben läses ur källkoden, i en sluten lista filer och en sluten lista skrivsätt, eftersom events
// bara har en väg in (låst av F14 i test/skrivvagar.test.ts). Ett skrivsätt utanför listan fäller
// provet i stället för att passera, och ett verb utan text i VERB fäller det med verbets namn (AK 5).
//
// F11 står efter F9 och F10: den lägger orden «Done» och «Backlog» i data, och AK 4:s förutsättning
// är testdata utan orden. Inget fall efter F11 letar efter de engelska namnen.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { STATUSORD, statuschip, statusord, statusordForTyp, VERB, verbText } from '../src/http/vy/mall.js';
import { StateTypSchema, type StateTyp } from '../src/lib/validation.js';
import { STANDARD_STATES } from '../src/services/team.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

// ---- Fixturen ------------------------------------------------------------------

type Fixturnyckel = StateTyp | 'granskning';

const TYPER = StateTypSchema.options;
const OPPNA: StateTyp[] = ['backlog', 'unstarted', 'started'];

/** Titlarna bär inget av de fem engelska namnen (AK 4:s förutsättning). */
const TITLAR: [Fixturnyckel, string][] = [
  ['backlog', 'F21 statusprovet ett'],
  ['unstarted', 'F21 statusprovet två'],
  ['started', 'F21 statusprovet tre'],
  ['completed', 'F21 statusprovet fyra'],
  ['canceled', 'F21 statusprovet fem'],
  ['granskning', 'F21 statusprovet sex'],
];

let app: Express;
let agentnyckel: string;
let manniskonyckel: string;
let teamId: string;
const fixtur = {} as Record<Fixturnyckel, { identifier: string; id: string }>;

/** Ett anrop som MÅSTE lyckas. Ett tyst 400 i ett förberedande steg får aldrig bära ett senare fall. */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

// På filnivå, utanför varje describe, så att varje block har fixturen också när det körs ensamt.
beforeAll(async () => {
  app = createApp();
  const team = await seedaTeam();
  teamId = team.id;
  agentnyckel = await nyNyckel({ typ: 'agent', namn: 'f21 agent' });
  manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'f21 människa' });

  // Ingen action skapar ett tillstånd, och importen lägger ett okänt namn i Backlog, så provet lägger
  // in det själv med appens roll (migration 0002 ger INSERT). Positionen 5 gör att stateAvTyp(…,
  // 'started') fortfarande väljer In Progress.
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workflow_states (tenant_id, team_id, namn, typ, position)
     VALUES ($1, $2, 'Granskning', 'started', 5) RETURNING id`,
    [TENANT_ID, team.id],
  );
  const granskning = rows[0]!.id;

  for (const [nyckel, titel] of TITLAR) {
    const r = await steg(agentnyckel, 'create_issue', { title: titel, team_key: 'LOC' });
    fixtur[nyckel] = { identifier: r.identifier as string, id: r.id as string };
  }
  for (const typ of ['unstarted', 'started', 'completed', 'canceled'] as const) {
    await steg(agentnyckel, 'update_issue_state', { identifier: fixtur[typ].identifier, state_typ: typ });
  }
  await steg(agentnyckel, 'update_issue_state', {
    identifier: fixtur.granskning.identifier,
    state_id: granskning,
  });
});

// ---- Provets egna tabeller ---------------------------------------------------------
//
// Utskrivna ur berättelsens tabell, inte importerade: provet är en specifikation, inte en kopia av koden.

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

const chippet = (typ: StateTyp): string => `<span class="chip ${KLASS[typ]}">${ORD[typ]}</span>`;
const GRANSKNINGSCHIPET = '<span class="chip chip--info">Granskning</span>';

/** Kortet för ärendet, från länken till första </a>. Ett saknat kort kastar, så att det blir rött. */
function kortet(html: string, identifier: string): string {
  const borjan = `<a class=kort href="/vy/arende/${identifier}">`;
  const start = html.indexOf(borjan);
  if (start === -1) throw new Error(`kortet för ${identifier} saknas`);
  const slut = html.indexOf('</a>', start);
  if (slut === -1) throw new Error(`kortet för ${identifier} slutar aldrig`);
  return html.slice(start, slut + '</a>'.length);
}

/** Chippet direkt efter <p class=summering> på ärendesidan. Kastar när det saknas. */
function summeringschipet(html: string): string {
  const traff = /<p class=summering>(<span class="chip [^"]*">[^<]*<\/span>)/.exec(html);
  if (!traff) throw new Error('summeringens chip saknas');
  return traff[1]!;
}

/** Sidan från <h2>Historik till slutet, som test/arendetext.test.ts. Kastar när rubriken saknas. */
function historiken(html: string): string {
  const start = html.indexOf('<h2>Historik');
  if (start === -1) throw new Error('historikblocket saknas');
  return html.slice(start);
}

const ENTITETER: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

/**
 * Sidans synliga text (AK 4, «som synlig text»): varje <style>-block bort, varje tagg blir ett
 * blanksteg, och esc():s fem entiteter avkodas i ett enda pass. Attributvärden räknas alltså inte.
 */
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

/** De sexton sidorna i AK 4 och AK 3. Byggs när fixturen finns. */
function sidor(): string[] {
  return [
    '/vy',
    '/vy/mitt',
    '/vy/mitt?aktor=f21%20agent',
    '/vy/digest',
    '/vy/digest?dagar=alla',
    '/vy/sok',
    ...TYPER.map((t) => `/vy/sok?status=${t}`),
    '/vy/sok?q=statusprovet',
    `/vy/arende/${fixtur.completed.identifier}`,
    `/vy/arende/${fixtur.granskning.identifier}`,
    '/vy/rattelser',
    '/vy/logga-in',
  ];
}

/** Det som en skrivning ändrar: tillstånden, händelserna och räkningen av ärenden och kommentarer. */
async function ogonblick() {
  const states = await pool.query('SELECT id, namn, typ FROM workflow_states ORDER BY id');
  const events = await pool.query('SELECT id, verb, payload::text AS payload FROM events ORDER BY id');
  return {
    workflow_states: states.rows,
    events: events.rows,
    issues: await raknaRader('issues'),
    comments: await raknaRader('comments'),
  };
}

// ---- Uppgift 1: tabellen och chippet -------------------------------------------------

describe('FR-37/Story 2.1 AK 1 och AK 2: tabellen och chippet', () => {
  it('F1 (AK 1): STATUSORD har en rad per typ, med seedningens namn, och chip och summering läser samma rad', () => {
    expect(Object.keys(STATUSORD)).toEqual(StateTypSchema.options);
    for (const s of STANDARD_STATES) expect(STATUSORD[s.typ].namn).toBe(s.namn);

    const orden = ['Ej planerat', 'Att göra', 'Pågår', 'Klart', 'Avbrutet'];
    expect(StateTypSchema.options.map((t) => statusordForTyp(t))).toEqual(orden);
    expect(STANDARD_STATES.map((s) => statusord(s.namn))).toEqual(orden);
    for (const s of STANDARD_STATES) expect(statusord(s.namn)).toBe(statusordForTyp(s.typ));
  });

  it('F2 (AK 2 och AK 1): ett okänt namn visas som det är lagrat, och klassen kommer ur typen', () => {
    for (const namn of ['Granskning', 'done', 'IN PROGRESS', '', 'toString']) {
      expect(statusord(namn)).toBe(namn);
    }
    expect(statuschip('completed', 'Done')).toBe('<span class="chip chip--ok">Klart</span>');
    expect(statuschip('started', 'Granskning')).toBe('<span class="chip chip--info">Granskning</span>');
    // En okänd typ får den dämpade klassen, som i dag.
    expect(statuschip('okand_typ', 'Done')).toBe('<span class="chip chip--muted">Klart</span>');
    // Ordet går fortfarande genom esc().
    expect(statuschip('started', '<b>"x"</b>')).toBe(
      '<span class="chip chip--info">&lt;b&gt;&quot;x&quot;&lt;/b&gt;</span>',
    );
  });

  it('F3 (AK 1): chippet säger det svenska ordet på ärendesidan, i /vy och i /vy/mitt', async () => {
    for (const typ of TYPER) {
      const svar = await request(app).get(`/vy/arende/${fixtur[typ].identifier}`);
      expect(svar.status).toBe(200);
      expect(summeringschipet(svar.text)).toBe(chippet(typ));
    }

    const vy = await request(app).get('/vy');
    const mitt = await request(app).get('/vy/mitt?aktor=f21%20agent');
    expect(vy.status).toBe(200);
    expect(mitt.status).toBe(200);
    for (const typ of OPPNA) {
      expect(kortet(vy.text, fixtur[typ].identifier)).toContain(`<span class=meta>${chippet(typ)}</span>`);
      expect(kortet(mitt.text, fixtur[typ].identifier)).toContain(`<span class=meta>${chippet(typ)}</span>`);
    }
  });

  it('F4 (AK 2): det okända namnet står som det är lagrat på ärendesidan, i /vy och i /vy/mitt (R)', async () => {
    const sidan = await request(app).get(`/vy/arende/${fixtur.granskning.identifier}`);
    const vy = await request(app).get('/vy');
    const mitt = await request(app).get('/vy/mitt?aktor=f21%20agent');
    for (const svar of [sidan, vy, mitt]) expect(svar.status).toBe(200);

    expect(summeringschipet(sidan.text)).toContain(GRANSKNINGSCHIPET);
    expect(kortet(vy.text, fixtur.granskning.identifier)).toContain(GRANSKNINGSCHIPET);
    expect(kortet(mitt.text, fixtur.granskning.identifier)).toContain(GRANSKNINGSCHIPET);

    // Kontroll: kontrollen avgör per kort — backlog-ärendets kort i /vy bär inte «Granskning».
    expect(kortet(vy.text, fixtur.backlog.identifier)).not.toContain('Granskning');
  });
});

// ---- Uppgift 2: summeringen, fasetten, sökträffarna och historiken ------------------

describe('FR-37/Story 2.1 AK 1 och AK 2: summering, fasett, sökträffar och historik', () => {
  it('F5 (AK 1): summeringsraden i /vy säger de svenska orden, med antalen ur list_issues', async () => {
    const antal = {} as Record<StateTyp, number>;
    for (const typ of OPPNA) {
      const svar = await kor(app, agentnyckel, 'list_issues', { state_typer: [typ], limit: 100 });
      expect(svar.status, JSON.stringify(svar.body)).toBe(200);
      antal[typ] = (svar.body.result.arenden as unknown[]).length;
    }

    const vy = await request(app).get('/vy');
    expect(vy.status).toBe(200);
    expect(vy.text).toContain(
      `— ${ORD.backlog}: ${antal.backlog} · ${ORD.unstarted}: ${antal.unstarted} · ` +
        `${ORD.started}: ${antal.started}.</p>`,
    );
    expect(vy.text).not.toContain('Backlog: ');
    expect(vy.text).not.toContain('Todo: ');
  });

  it('F6 (AK 1): statusfasetten och raden Aktiva filter i /vy/sok säger de svenska orden', async () => {
    const sok = await request(app).get('/vy/sok');
    expect(sok.status).toBe(200);
    let forra = -1;
    for (const typ of TYPER) {
      const lank = `<a class="fasett" href="/vy/sok?status=${typ}">${ORD[typ]}</a>`;
      const plats = sok.text.indexOf(lank);
      expect(plats, lank).toBeGreaterThan(forra);
      forra = plats;
    }

    for (const typ of TYPER) {
      const svar = await request(app).get(`/vy/sok?status=${typ}`);
      expect(svar.status).toBe(200);
      expect(svar.text).toContain(
        `<a class="fasett aktiv" aria-current=true href="/vy/sok">status: ${ORD[typ]} ×</a>`,
      );
      expect(svar.text).toContain(`<a class="fasett aktiv" aria-current=true href="/vy/sok">${ORD[typ]} ×</a>`);
    }

    const klara = await request(app).get('/vy/sok?status=completed');
    expect(klara.status).toBe(200);
    expect(kortet(klara.text, fixtur.completed.identifier)).toContain(chippet('completed'));
  });

  it('F7 (AK 1 och AK 2): sökträffarna bär det lagrade namnets ord, och search_issues är oförändrat', async () => {
    const sok = await request(app).get('/vy/sok?q=statusprovet');
    expect(sok.status).toBe(200);
    for (const typ of TYPER) {
      expect(kortet(sok.text, fixtur[typ].identifier)).toContain(`<span class=meta>${chippet(typ)}</span>`);
    }
    expect(kortet(sok.text, fixtur.granskning.identifier)).toContain(`<span class=meta>${GRANSKNINGSCHIPET}</span>`);

    const api = await kor(app, agentnyckel, 'search_issues', { fraga: 'statusprovet' });
    expect(api.status).toBe(200);
    expect(Array.isArray(api.body.result)).toBe(true);
    const traffar = api.body.result as Record<string, unknown>[];
    // Ordningen prövas inte: Story 2.5 bestämmer den.
    expect(traffar.map((t) => String(t.identifier)).sort()).toEqual(
      TITLAR.map(([nyckel]) => fixtur[nyckel].identifier).sort(),
    );
    for (const traff of traffar) {
      expect(Object.keys(traff).sort()).toEqual(['id', 'identifier', 'lank', 'rang', 'state_typ', 'title', 'traff_i']);
    }
  });

  it('F8 (AK 1 och AK 2): historikens statusbyte står på svenska på ärendesidan och i digesten', async () => {
    const byten: [Fixturnyckel, string][] = [
      ['unstarted', ORD.unstarted],
      ['started', ORD.started],
      ['completed', ORD.completed],
      ['canceled', ORD.canceled],
      ['granskning', 'Granskning'],
    ];
    const digest = await request(app).get('/vy/digest');
    expect(digest.status).toBe(200);
    for (const [nyckel, ord] of byten) {
      const rad = `<span>ändrade status ${ORD.backlog} → ${ord}</span>`;
      const sida = await request(app).get(`/vy/arende/${fixtur[nyckel].identifier}`);
      expect(sida.status).toBe(200);
      expect(historiken(sida.text)).toContain(rad);
      expect(digest.text).toContain(rad);
    }
  });
});

describe('FR-37/Story 2.1 AK 4 och AK 3: inga engelska standardnamn, och datat rörs inte', () => {
  it('F9 (AK 4): ingen av de sexton sidorna visar ett engelskt standardnamn som synlig text', async () => {
    // Kontroller först: detektorn fäller ett påhittat chip och löptext, men inte CSS eller attribut.
    expect(engelskaNamn(synligText('<p><span class="chip chip--ok">Done</span> In Progress</p>'))).toEqual([
      'Done',
      'In Progress',
    ]);
    expect(
      engelskaNamn(
        synligText('<style>.Done{}</style><a href="/vy/sok?status=completed" title="Canceled">Klart</a>'),
      ),
    ).toEqual([]);

    let allt = '';
    for (const vag of sidor()) {
      const svar = await request(app).get(vag);
      expect(svar.status, vag).toBe(200);
      expect(svar.text, vag).toContain('<html lang=sv>');
      const text = synligText(svar.text);
      expect(engelskaNamn(text), vag).toEqual([]);
      allt += `${text}\n`;
    }

    const vy = await request(app).get('/vy');
    expect(vy.text).toContain('<h1>Ärenden</h1>');

    // Kontroll sist: tillstånden visas faktiskt, så att frånvaron ovan betyder något.
    for (const ord of ['Ej planerat', 'Att göra', 'Pågår', 'Klart', 'Avbrutet', 'Granskning']) {
      expect(allt).toContain(ord);
    }
  });

  it('F10 (AK 3): ingen GET skriver, och de lagrade namnen och payloaden är oförändrade (R)', async () => {
    const fore = await ogonblick();
    for (const vag of sidor()) expect((await request(app).get(vag)).status, vag).toBe(200);
    expect(await ogonblick()).toEqual(fore);

    const { rows: statusbyten } = await pool.query<{ payload: { fran?: unknown; till?: unknown } }>(
      "SELECT payload FROM events WHERE issue_id = $1 AND verb = 'andrade_status'",
      [fixtur.completed.id],
    );
    expect(statusbyten).toHaveLength(1);
    expect(statusbyten[0]!.payload.fran).toBe('Backlog');
    expect(statusbyten[0]!.payload.till).toBe('Done');

    const { rows: tillstand } = await pool.query<{ namn: string }>(
      'SELECT namn FROM workflow_states WHERE team_id = $1 ORDER BY position',
      [teamId],
    );
    expect(tillstand.map((r) => r.namn)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled', 'Granskning']);

    // Kontroll sist: en skrivning ändrar ögonblicksbilden, så att jämförelsen ovan kan slå ut.
    await steg(agentnyckel, 'create_issue', { title: 'F21 kontrollärende', team_key: 'LOC' });
    expect((await ogonblick()).events).not.toEqual(fore.events);
  });
});

// F11 står efter F9 och F10: den lägger orden «Done» och «Backlog» i data.
describe('FR-37/Story 2.1 AK 1: bara statusbytet översätts', () => {
  it('F11 (AK 1): en titel som exakt är «Done» står som den är lagrad, och statusbytet översätts', async () => {
    const skapat = await steg(agentnyckel, 'create_issue', { title: 'Done', team_key: 'LOC' });
    const identifier = skapat.identifier as string;
    await steg(agentnyckel, 'update_issue', { identifier, title: 'Backlog' });
    await steg(agentnyckel, 'update_issue_state', { identifier, state_typ: 'completed' });

    const sida = await request(app).get(`/vy/arende/${identifier}`);
    expect(sida.status).toBe(200);
    const historik = historiken(sida.text);
    expect(historik).toContain(' Done → Backlog</span>');
    expect(historik).toContain(`<span>ändrade status ${ORD.backlog} → ${ORD.completed}</span>`);
    expect(historik).not.toContain('Klart → Ej planerat');
  });
});

// ---- Uppgift 3: verben ur källkoden ---------------------------------------------------

const ROT = fileURLToPath(new URL('../', import.meta.url));

/**
 * Den slutna listan filer. events har en enda väg in, och den nås bara från execute.ts (registret),
 * importen och nyckelskriptet (F14 i test/skrivvagar.test.ts). Verbet väljs i registret, importen
 * och nyckelskriptet; execute.ts och återläsningen väljer inget och ska därför ge noll förekomster.
 */
const VERBFILER = [
  'src/actions/registry.ts',
  'src/import/importeraArkiv.ts',
  'src/scripts/skapaNyckel.ts',
  'src/actions/execute.ts',
  'src/import/aterlasLinear.ts',
];

const lasKalla = (fil: string): string => readFileSync(path.join(ROT, fil), 'utf8');

const VERBNAMN = '[a-z][a-z0-9_]*';

/** Hela kommentarsrader, som kodrader() i test/escape-yta.test.ts. */
const arKommentar = (rad: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(rad);

/**
 * Strängarna i blocket från första raden som (trimmad) börjar med `borjan` till första raden där
 * `slut` gäller, utom kommentarsraderna. `null` när blocket saknas.
 */
function blocket(
  rader: string[],
  borjan: string,
  slut: (rad: string) => boolean,
  strang: RegExp,
): string[] | null {
  const start = rader.findIndex((r) => r.trim().startsWith(borjan));
  if (start === -1) return null;
  const ut: string[] = [];
  for (let i = start; i < rader.length; i++) {
    const rad = rader[i]!;
    if (!arKommentar(rad)) for (const m of rad.matchAll(strang)) ut.push(m[1]!);
    if (slut(rad)) return ut;
  }
  return null;
}

/**
 * Verben i en källtext, och fynden. Varje förekomst av ordet verb (skiftlägeskänsligt, helt ord) på en
 * kodrad ska ha ett av sex skrivsätt; allt annat är ett fynd, så att ett nytt skrivsätt fäller provet
 * i stället för att passera:
 *   (a) verb: 'x'                      — verbet
 *   (b) verb: namn ? 'x' : 'y'         — båda verben
 *   (c) verb: VERB_FOR_FALT[           — varje sträng efter ett kolon i blocket const VERB_FOR_FALT … };
 *   (d) verb: string                   — inget verb (parametertypen i ActionContext)
 *   (e) verb: AtagandeVerb | UppdateringsVerb — varje sträng i blocket type AtagandeVerb = … ;
 *   (f) verb,                          — bara i registret och högst en gång; räknas som (e)
 */
function verbIKallan(fil: string, text: string): { verb: string[]; fynd: string[] } {
  const rader = text.split('\n');
  const verb: string[] = [];
  const fynd: string[] = [];
  let forkortningar = 0;

  const falt = (): void => {
    const efterKolon = new RegExp(`:\\s*'(${VERBNAMN})'`, 'g');
    const strangar = blocket(rader, 'const VERB_FOR_FALT', (r) => r.trim() === '};', efterKolon);
    if (strangar === null) fynd.push(`${fil}: blocket const VERB_FOR_FALT saknas`);
    else verb.push(...strangar);
  };
  const atagande = (): void => {
    const varjeStrang = new RegExp(`'(${VERBNAMN})'`, 'g');
    const strangar = blocket(rader, 'type AtagandeVerb =', (r) => r.trimEnd().endsWith(';'), varjeStrang);
    if (strangar === null) fynd.push(`${fil}: blocket type AtagandeVerb saknas`);
    else verb.push(...strangar);
  };

  const A = new RegExp(`^verb:\\s*'(${VERBNAMN})'`);
  const B = new RegExp(`^verb:\\s*[A-Za-z0-9_.]+\\s*\\?\\s*'(${VERBNAMN})'\\s*:\\s*'(${VERBNAMN})'`);

  rader.forEach((rad, i) => {
    if (arKommentar(rad)) return;
    for (const m of rad.matchAll(/\bverb\b/g)) {
      const resten = rad.slice(m.index);
      const a = A.exec(resten);
      const b = B.exec(resten);
      if (a) verb.push(a[1]!);
      else if (b) verb.push(b[1]!, b[2]!);
      else if (/^verb:\s*VERB_FOR_FALT\[/.test(resten)) falt();
      else if (/^verb:\s*string\b/.test(resten)) continue;
      else if (/^verb:\s*(?:AtagandeVerb|UppdateringsVerb)\b/.test(resten)) atagande();
      else if (/^verb,/.test(resten) && fil === 'src/actions/registry.ts' && ++forkortningar === 1) atagande();
      else fynd.push(`${fil} rad ${i + 1}: okänt skrivsätt för verb: ${rad.trim()}`);
    }
  });
  return { verb: [...new Set(verb)], fynd };
}

/** Verben utan en EGEN post i VERB (ett ärvt namn räknas aldrig), utan dubbletter och sorterade. */
function utanText(verb: string[]): string[] {
  return [...new Set(verb.filter((v) => !Object.hasOwn(VERB, v)))].sort();
}

/** Varje TypeScript-fil under src/ vars text nämner `namn` som helt ord, relativt repots rot, sorterade. */
function filerSomNamner(namn: string): string[] {
  const monster = new RegExp(`\\b${namn}\\b`);
  return readdirSync(path.join(ROT, 'src'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.posix.join('src', f.split(path.sep).join('/')))
    .filter((fil) => monster.test(lasKalla(fil)))
    .sort();
}

/** UX-specifikationens sjutton och de sju no-op-verben (AK 5), och sex verb som fanns före berättelsen. */
const NAMNGIVNA_VERB = [
  'andrade_titel',
  'rattade_beskrivning',
  'satte_etikett',
  'andrade_kundkoppling',
  'registrerade_atagande',
  'tog_over_atagande',
  'andrade_atagande',
  'hindrade_atagande',
  'redovisade_resultat',
  'avslutade_atagande',
  'aterppnade_atagande',
  'kopplade_beslut',
  'skrev_arbetsmoment',
  'registrerade_insats',
  'besvarade_insats',
  'skot_upp_insats',
  'aterkallade_insats',
  'etiketten_fanns_redan',
  'kundkoppling_oforandrad',
  'atagandet_fanns_redan',
  'beslutet_var_redan_kopplat',
  'behandlade_svarsversion',
  'svarsversionen_var_behandlad',
  'insatsen_fanns_redan',
  'skapade_arende',
  'andrade_status',
  'andrade_prioritet',
  'importerade_arende',
  'importerade_kommentar',
  'skapade_aktorsidentitet',
];

/** De 25 nya texterna, ordagrant ur berättelsens tabell (Dev Notes → Texterna). */
const NYA_TEXTER: [string, string][] = [
  ['andrade_titel', 'rättade titeln'],
  ['rattade_beskrivning', 'rättade beskrivningen'],
  ['satte_etikett', 'satte en etikett'],
  ['andrade_kundkoppling', 'ändrade kundkopplingen'],
  ['registrerade_atagande', 'registrerade ett åtagande'],
  ['tog_over_atagande', 'tog över åtagandet'],
  ['andrade_atagande', 'ändrade åtagandet'],
  ['hindrade_atagande', 'markerade åtagandet som hindrat'],
  ['redovisade_resultat', 'redovisade resultatet'],
  ['avslutade_atagande', 'avslutade åtagandet'],
  ['aterppnade_atagande', 'återöppnade åtagandet'],
  ['kopplade_beslut', 'kopplade ett beslut'],
  ['skrev_arbetsmoment', 'loggade ett arbetsmoment'],
  ['registrerade_insats', 'registrerade en insats'],
  ['besvarade_insats', 'besvarade en insats'],
  ['skot_upp_insats', 'sköt upp en insats'],
  ['aterkallade_insats', 'återkallade en insats'],
  ['etiketten_fanns_redan', 'etiketten fanns redan på ärendet'],
  ['kundkoppling_oforandrad', 'lämnade kundkopplingen oförändrad'],
  ['atagandet_fanns_redan', 'åtagandet fanns redan'],
  ['beslutet_var_redan_kopplat', 'beslutet var redan kopplat'],
  ['behandlade_svarsversion', 'behandlade en svarsversion'],
  ['svarsversionen_var_behandlad', 'svarsversionen var redan behandlad'],
  ['insatsen_fanns_redan', 'insatsen fanns redan'],
  ['importerade_kommentar', 'importerade en kommentar'],
];

describe('FR-37/Story 2.1 AK 5: varje verb har en svensk text', () => {
  it('F12 (AK 5): verben ur källkoden har var sin post i VERB, och ett nytt verb utan text fälls', () => {
    // Kontroller först, på påhittade källtexter: varje form ger exakt det väntade utfallet.
    const fabricerad = (text: string) => verbIKallan('fabricerad', text);

    const nytt = fabricerad("await ctx.skrivHandelse({ issueId: null, verb: 'f21_nytt_verb' });");
    expect(nytt.fynd).toEqual([]);
    expect(utanText(nytt.verb)).toEqual(['f21_nytt_verb']);

    const villkor = fabricerad("verb: klar ? 'f21_ny_a' : 'f21_ny_b',");
    expect(villkor.fynd).toEqual([]);
    expect(utanText(villkor.verb)).toEqual(['f21_ny_a', 'f21_ny_b']);

    const falt = fabricerad(
      "const VERB_FOR_FALT: Record<Falt, string> = {\n  ny: 'f21_falt_verb',\n};\nverb: VERB_FOR_FALT[a.falt],",
    );
    expect(falt.fynd).toEqual([]);
    expect(utanText(falt.verb)).toEqual(['f21_falt_verb']);

    const atagande = fabricerad(
      "type AtagandeVerb =\n  | 'registrerade_atagande'\n  | 'f21_atagande_verb';\nverb: AtagandeVerb,",
    );
    expect(atagande.fynd).toEqual([]);
    expect(utanText(atagande.verb)).toEqual(['f21_atagande_verb']);

    const okant = fabricerad('verb: hamtaVerb(x),');
    expect(okant.verb).toEqual([]);
    expect(okant.fynd).toHaveLength(1);
    expect(okant.fynd[0]).toContain('fabricerad');
    expect(okant.fynd[0]).toContain('rad 1');

    const variabel = fabricerad("const verb = 'f21_dold';\nawait ctx.skrivHandelse({ issueId: null, verb });");
    expect(variabel.verb).toEqual([]);
    expect(variabel.fynd).toHaveLength(2);
    expect(variabel.fynd[0]).toContain('rad 1');
    expect(variabel.fynd[1]).toContain('rad 2');

    const forkortning = fabricerad('await skriv({\n  verb,\n});');
    expect(forkortning.verb).toEqual([]);
    expect(forkortning.fynd).toHaveLength(1);
    expect(forkortning.fynd[0]).toContain('rad 2');

    // Den slutna listan av skrivställen: just de fem filerna nämner namnet.
    expect(filerSomNamner('skrivHandelse')).toEqual([
      'src/actions/execute.ts',
      'src/actions/registry.ts',
      'src/import/importeraArkiv.ts',
      'src/scripts/skapaNyckel.ts',
      'src/services/handelser.ts',
    ]);

    // Återläsningen skriver bara genom executeAction, alltså med registrets verb.
    const aterlas = lasKalla('src/import/aterlasLinear.ts');
    expect(aterlas).toContain('executeAction(');
    expect(verbIKallan('src/import/aterlasLinear.ts', aterlas)).toEqual({ verb: [], fynd: [] });

    const insamlade: string[] = [];
    const fynd: string[] = [];
    for (const fil of VERBFILER) {
      const ur = verbIKallan(fil, lasKalla(fil));
      insamlade.push(...ur.verb);
      fynd.push(...ur.fynd);
    }
    expect(fynd).toEqual([]);
    // Antalet prövas inte, så att en senare berättelse kan lägga till ett verb och dess text.
    expect(insamlade).toEqual(expect.arrayContaining(NAMNGIVNA_VERB));

    const saknas = utanText(insamlade);
    expect(saknas, `verb utan svensk text i VERB: ${saknas.join(', ')}`).toEqual([]);
  });

  it('F13 (AK 5): de 25 nya texterna, inga understreck och reservvägen står kvar', () => {
    for (const [verb, text] of NYA_TEXTER) expect(VERB[verb], verb).toBe(text);
    for (const [verb, text] of Object.entries(VERB)) {
      expect(typeof text, verb).toBe('string');
      expect(text.length, verb).toBeGreaterThan(0);
      expect(text, verb).not.toContain('_');
    }
    expect(verbText('helt_okant_verb')).toBe('helt okant verb');
    // Ett ärvt namn räknas aldrig som en post.
    expect(verbText('toString')).toBe('toString');
    expect(verbText('constructor')).toBe('constructor');
    for (const nyckel of Object.keys(VERB)) expect(verbText(nyckel)).toBe(VERB[nyckel]);
  });
});

// ---- Scenariot för F14: åtagandets livscykel, beslutet, svarsversionen, momentet och två insatser ----
//
// Egna kopior av konstanterna och hjälparna i test/atagande-handelser.test.ts (rad 22–68) och av
// insatsens fält ur grund() i test/insats.test.ts (rad 17–33).

const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const NY_GRUND = { typ: 'beslut', id: '171', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const HINDER = { typ: 'beslut', id: '145' };
const BELAGG = [
  { typ: 'prov', id: 'atagande-handelser', version: '2026-10-17' },
  { typ: 'commit', id: 'abc1234' },
];
const SEN = '2026-09-30T08:00:00Z';
const SENARE = '2026-10-30T08:00:00Z';
// Ett år fram, räknat när provet körs (som SEN i test/insats.test.ts). Heter inte SEN: det är
// åtagandets fasta tid ovan.
const UPPSKJUTEN_TILL = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const KONTRAKT = { system: 'hermes', kommando: 'beslutskoe --besvara', objekt: '#153' };

/** Insatsens fält ur grund() i test/insats.test.ts, med källan och ärendet. Utan identifier räknas raden inte i historiken. */
function insatsen(stopp: string, identifier: string) {
  return {
    stopp_id: stopp,
    typ: 'agarbeslut',
    tillhor: 'agare',
    utfall: 'Riktningen är vald och arbetet kan fortsätta',
    begard_handling: 'Välj mellan A och B',
    blockeringsgrund: 'Tidigare besked avgör inte valet',
    handlingskontrakt: KONTRAKT,
    kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: stopp }],
    identifier,
  };
}

async function revisionNu(identifier: string): Promise<number> {
  return (await steg(agentnyckel, 'get_atagande', { identifier })).revision as number;
}

/** De 21 händelserna som scenariot ger ärendet, i ordning. */
const SCENARIOVERB = [
  'skapade_arende',
  'registrerade_atagande',
  'atagandet_fanns_redan',
  'kopplade_beslut',
  'beslutet_var_redan_kopplat',
  'behandlade_svarsversion',
  'svarsversionen_var_behandlad',
  'skrev_arbetsmoment',
  'tog_over_atagande',
  'andrade_atagande',
  'hindrade_atagande',
  'tog_over_atagande',
  'redovisade_resultat',
  'aterppnade_atagande',
  'avslutade_atagande',
  'registrerade_insats',
  'insatsen_fanns_redan',
  'skot_upp_insats',
  'besvarade_insats',
  'registrerade_insats',
  'aterkallade_insats',
];

describe('FR-37/Story 2.1 AK 6: historik och digest på svenska', () => {
  let identifier: string;
  let issueId: string;

  beforeAll(async () => {
    const skapat = await steg(agentnyckel, 'create_issue', { title: 'F21 åtagandeprovet', team_key: 'LOC' });
    identifier = skapat.identifier as string;
    issueId = skapat.id as string;
    const vidare = async (nyckel: string, action: string, input: Record<string, unknown>) =>
      steg(nyckel, action, { identifier, ...input, forvantad_revision: await revisionNu(identifier) });

    const registrering = { identifier, grund: GRUND, nasta: INTERNT, foljs_upp: SEN };
    await steg(agentnyckel, 'registrera_atagande', registrering);
    await steg(agentnyckel, 'registrera_atagande', registrering);
    await steg(agentnyckel, 'koppla_beslut', { identifier, beslut_id: 9021 });
    await steg(agentnyckel, 'koppla_beslut', { identifier, beslut_id: 9021 });
    const svarsversion = { identifier, beslut_id: 9021, svar_hash: 'f21f21f21f21f21f' };
    await steg(agentnyckel, 'registrera_svarsversion', svarsversion);
    await steg(agentnyckel, 'registrera_svarsversion', svarsversion);
    await steg(agentnyckel, 'logga_moment', { identifier, moment: 'utfora' });
    await vidare(manniskonyckel, 'ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN });
    await vidare(agentnyckel, 'andra_atagande', { foljs_upp: SENARE, skal: 'F21 uppföljningen flyttas' });
    await vidare(agentnyckel, 'hindra_atagande', {
      orsak: 'F21 väntar på ett svar',
      belagg: HINDER,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    await vidare(manniskonyckel, 'ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN });
    await vidare(agentnyckel, 'redovisa_resultat', { sammanfattning: 'F21 resultatet', belagg: BELAGG });
    await vidare(agentnyckel, 'aterppna_atagande', { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SEN });
    await vidare(agentnyckel, 'avsluta_atagande', {
      text: 'F21 ersatt av ett annat åtagande',
      grund: { typ: 'beslut', id: '160' },
    });

    const insatsA = (await steg(agentnyckel, 'registrera_insats', insatsen('f21-a', identifier))).insats.id as string;
    await steg(agentnyckel, 'registrera_insats', insatsen('f21-a', identifier));
    await steg(manniskonyckel, 'skjut_upp_insats', { id: insatsA, till: UPPSKJUTEN_TILL, skal: 'F21 senare' });
    await steg(manniskonyckel, 'besvara_insats', { id: insatsA, svar: 'F21 svaret' });
    const insatsB = (await steg(agentnyckel, 'registrera_insats', insatsen('f21-b', identifier))).insats.id as string;
    await steg(agentnyckel, 'aterkalla_insats', { id: insatsB, skal: 'F21 inte längre aktuell' });
  });

  it('F14 (AK 6): varje rad i historiken och digesten står med sin svenska text, aldrig i snake_case', async () => {
    const { rows } = await pool.query<{ verb: string }>('SELECT verb FROM events WHERE issue_id = $1 ORDER BY id', [
      issueId,
    ]);
    expect(rows.map((r) => r.verb)).toEqual(SCENARIOVERB);

    const sida = await request(app).get(`/vy/arende/${identifier}`);
    const digest = await request(app).get('/vy/digest');
    expect(sida.status).toBe(200);
    expect(digest.status).toBe(200);
    expect(sida.text).toContain('<h2>Historik (21)</h2>');

    const delar: [string, string][] = [
      ['historiken', historiken(sida.text)],
      ['digesten', digest.text],
    ];
    for (const [namn, html] of delar) {
      for (const verb of SCENARIOVERB) {
        expect(html, `${namn}: ${verb}`).toContain(`<span>${VERB[verb]}</span>`);
        const reserv = verb.replace(/_/g, ' ');
        if (VERB[verb] !== reserv) expect(html, `${namn}: ${verb}`).not.toContain(`<span>${reserv}</span>`);
      }
      expect(html, namn).not.toMatch(/<span>[a-z]+(?:_[a-z]+)+/);
    }
    expect(delar[0]![1]).toContain('<span>återöppnade åtagandet</span>');
  });
});

// ---- Uppgift 4: README (krav → kod → test) --------------------------------------------

const RUBRIKEN = '### FR-37 — statusord och händelseverb på svenska (Story 2.1)';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN =
  '- Statusord och händelseverb i vyn (FR-37, B-14, Story 2.1): ett tillstånd visas i vyn bara genom tabellen ' +
  '`STATUSORD` i `src/http/vy/mall.ts`, som har en rad per typ och översätter de fem standardnamnen: Backlog ' +
  'blir Ej planerat, Todo blir Att göra, In Progress blir Pågår, Done blir Klart och Canceled blir Avbrutet. Ett ' +
  'lagrat namn visas genom `statusord()` och en typ genom `statusordForTyp()`, som läser samma rad. Ett namn som ' +
  'inte står i tabellen visas som det är lagrat, och chippets klass kommer ur typen. Översättningen sker bara vid ' +
  'visning, och `workflow_states.namn` och händelsernas payload ändras aldrig för den. Varje verb som koden skriver ' +
  'har en svensk visningstext i `VERB` i samma fil, och den som inför ett nytt verb skriver texten i samma diff. ' +
  'Provet `test/svenska-yta.test.ts` läser verben ur källkoden i en sluten lista filer och skrivsätt och fäller ett ' +
  'verb utan text. Ett nytt skrivsätt läggs i provets lista. `verbText()` slår upp texten med `Object.hasOwn()`, ' +
  "och reservvägen `verb.replace(/_/g, ' ')` står kvar som sista skydd.";

/** Avsnittets rader, från rubriken till nästa rubrik på nivå två eller tre, och dess gränser. */
function avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/** Fynden för README:s avsnitt: rubriken och dess plats, regelns rad exakt en gång och tre tabellrader. */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const fel: string[] = [];
  const felbesked = rader.indexOf('### FR-37 — svenska felbesked i vyn (Story 2.2)');
  if (felbesked === -1 || felbesked > granser.start) fel.push('rubriken står inte efter avsnittet för Story 2.2');
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const regler = avsnitt.filter((r) => r.startsWith('- Statusord och händelseverb i vyn (FR-37, B-14, Story 2.1):'));
  if (regler.length !== 1) fel.push(`regelns rad står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regelns rad är inte ordagrant densamma som i regelkällan');
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-37'));
  if (tabell.length !== 3) fel.push(`${tabell.length} tabellrader för FR-37, inte 3`);
  for (const r of tabell) if (!r.includes('test/svenska-yta.test.ts')) fel.push(`utan provfilen: ${r}`);
  return fel;
}

describe('FR-37/Story 2.1: README bär statusorden och verben', () => {
  it('F15 (dokumentationen): avsnittet bär regeln och tre rader krav → kod → test', () => {
    const text = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readmefel(text)).toEqual([]);

    // Kontrollen: samma kontroll på texten utan avsnittet fälls.
    const rader = text.split('\n');
    const granser = avsnittet(rader.map((r) => r.replace(/\r$/, '')))!;
    const utan = [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
    expect(readmefel(utan)).not.toEqual([]);
  });
});
