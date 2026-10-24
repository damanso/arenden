import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

const ROT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));

// KRAV-20 (d): söket måste träffa både ord i titeln OCH ord som bara finns i en
// kommentar — annars tappar man halva historiken när man letar.
describe('KRAV-9/11/20d: search_issues över ärenden och kommentarer', () => {
  let app: Express;
  let nyckel: string;
  let medOrdetITiteln: string;
  let medOrdetIKommentaren: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });

    const a = await kor(app, nyckel, 'create_issue', {
      title: 'Kvartalsrapporten till styrelsen',
      description: 'Sammanställning inför mötet.',
      team_key: 'LOC',
    });
    medOrdetITiteln = a.body.result.identifier;

    const b = await kor(app, nyckel, 'create_issue', {
      title: 'Ett helt orelaterat ärende',
      description: 'Ingenting om ekonomi här.',
      team_key: 'LOC',
    });
    medOrdetIKommentaren = b.body.result.identifier;
    await kor(app, nyckel, 'add_comment', {
      identifier: medOrdetIKommentaren,
      body: 'Det visade sig höra ihop med kvartalsrapporten ändå.',
    });
  });

  it('hittar ord i titeln', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'styrelsen' });
    expect(svar.status).toBe(200);
    const traffar = svar.body.result as { identifier: string }[];
    expect(traffar.map((t) => t.identifier)).toContain(medOrdetITiteln);
  });

  it('hittar ord i beskrivningen', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'sammanställning' });
    const traffar = svar.body.result as { identifier: string }[];
    expect(traffar.map((t) => t.identifier)).toContain(medOrdetITiteln);
  });

  it('hittar ord som BARA finns i en kommentar', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'kvartalsrapporten' });
    const identifierare = (svar.body.result as { identifier: string }[]).map((t) => t.identifier);
    expect(identifierare).toContain(medOrdetITiteln);
    expect(identifierare).toContain(medOrdetIKommentaren);
  });

  it('rankar träffarna och markerar var träffen satt', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'kvartalsrapporten' });
    const traffar = svar.body.result as { rang: number; traff_i: string }[];
    expect(traffar.length).toBeGreaterThanOrEqual(2);
    for (const t of traffar) expect(t.rang).toBeGreaterThan(0);
    expect(traffar.map((t) => t.traff_i)).toContain('kommentar');
  });

  it('ord som inte finns ger noll träffar', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'zebrafinkarna' });
    expect(svar.body.result).toEqual([]);
  });
});

// ---- FR-2, B-18 (Story 2.5): en bestämd, provad ordning ----------------------------------------------
//
// Ordningen bestäms av fixturen och inte av när anropen råkar köras: ägarrollen sätter
// varje ärendes skapad. Varje sökord bärs bara av sitt eget block, och varje fall läser
// bara sitt eget blocks fixtur, så att det också kan köras ensamt.

interface Fil { fil: string; text: string }
interface Skapat { id: string; identifier: string; kommentarer: string[] }
interface Traff { id: string; identifier: string; title: string; state_typ: string; rang: number; traff_i: string }
/** Ett fynd som en mätning ska ge: mallens namn och detaljerna mallen fylls i med. */
type Fynd = [mall: string, ...detaljer: unknown[]];
/** Ett påhittat underlag, som mätningens argument, och exakt de fynd det ska ge. */
type Utslag = [underlag: unknown[], fynd: Fynd[]];

const SOKFIL = 'services/arenden.ts';
const TOTAL_ORDNING = 'ORDER BY rang DESC, i.skapad DESC, i.id DESC';

let sokApp: Express;
let hermes: string;
let david: string;

beforeAll(async () => {
  sokApp = createApp();
  await seedaTeam();
  hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  david = await nyNyckel({ typ: 'manniska', namn: 'david' });
});

async function adminKlient(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await client.connect();
  return client;
}

/** Fixtur, inte en skrivväg: ägarrollen sätter skapad till 2026-01-01 plus `timme` hela timmar. */
async function sattSkapad(id: string, timme: number): Promise<void> {
  const client = await adminKlient();
  try {
    const { rowCount } = await client.query(
      "UPDATE issues SET skapad = timestamptz '2026-01-01' + make_interval(hours => $2::int) WHERE id = $1",
      [id, timme],
    );
    expect(rowCount).toBe(1);
  } finally {
    await client.end();
  }
}

async function skapa(titel: string, kommentarer: string[] = [], beskrivning?: string): Promise<Skapat> {
  const falt = beskrivning === undefined
    ? { title: titel, team_key: 'LOC' }
    : { title: titel, description: beskrivning, team_key: 'LOC' };
  const svar = await kor(sokApp, hermes, 'create_issue', falt);
  expect(svar.status, JSON.stringify(svar.body)).toBe(200);
  const { id, identifier } = svar.body.result as { id: string; identifier: string };
  const kommentarIds: string[] = [];
  for (const body of kommentarer) {
    const kommentar = await kor(sokApp, hermes, 'add_comment', { identifier, body });
    expect(kommentar.status, JSON.stringify(kommentar.body)).toBe(200);
    kommentarIds.push(kommentar.body.result.id as string);
  }
  return { id, identifier, kommentarer: kommentarIds };
}

const TRAFFPLATSER = ['arende', 'kommentar'];

/** AK 4: varje fynd traffbildsfel() kan ge, en mall per gren. */
const TRAFFBILDSFYND = {
  rang: (identifier: string, rang: unknown) => `rang är inte större än noll: ${identifier} (${String(rang)})`,
  plats: (identifier: string, traffI: unknown) =>
    `traff_i är varken arende eller kommentar: ${identifier} (${String(traffI)})`,
};

/** AK 4: varje träff bär rang större än noll och traff_i arende eller kommentar. Tom lista när allt stämmer. */
function traffbildsfel(traffar: Traff[]): string[] {
  const fynd: string[] = [];
  for (const { identifier, rang, traff_i } of traffar) {
    if (!(typeof rang === 'number' && rang > 0)) fynd.push(TRAFFBILDSFYND.rang(identifier, rang));
    if (!TRAFFPLATSER.includes(traff_i)) fynd.push(TRAFFBILDSFYND.plats(identifier, traff_i));
  }
  return fynd;
}

/** search_issues. Varje sökning prövar också AK 4:s löfte om varje träff (traffbildsfel). */
async function sok(fraga: string, limit?: number): Promise<Traff[]> {
  const svar = await kor(sokApp, hermes, 'search_issues', limit === undefined ? { fraga } : { fraga, limit });
  expect(svar.status, JSON.stringify(svar.body)).toBe(200);
  expect(Array.isArray(svar.body.result)).toBe(true);
  const traffar = svar.body.result as Traff[];
  expect(traffbildsfel(traffar), fraga).toEqual([]);
  return traffar;
}

/** Varje TypeScript-fil under src/, relativt src/ med snedstreck, sorterad på sökvägen. */
function kodfiler(): Fil[] {
  const src = path.join(ROT, 'src');
  return readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith('.ts'))
    .map((f) => ({ fil: f.split(path.sep).join('/'), text: readFileSync(path.join(src, f), 'utf8') }))
    .sort((a, b) => (a.fil < b.fil ? -1 : a.fil > b.fil ? 1 : 0));
}

/** Textens rader utom hela kommentarsrader (samma regel som S4c). */
function kodrader(text: string): string[] {
  return text.split('\n').filter((rad) => !/^(\/\/|\/\*|\*)/.test(rad.trimStart()));
}

function antal(text: string, del: string): number {
  return text.split(del).length - 1;
}

/**
 * Kontrollen att en mätning kan slå ut, gren för gren. Mätningen ger sina fynd bara genom
 * sina mallar, en mall per gren. Varje mall ska ge ett fynd för något påhittat underlag,
 * och varje underlag ska ge exakt de fynd som står utskrivna för det.
 */
function provaUtslag(
  matning: (...underlag: never[]) => string[],
  mallar: Record<string, (...detaljer: never[]) => string>,
  utslag: Utslag[],
): void {
  // En väg in: varje fynd skjuts in genom en mall, så att mallarna är mätningens alla grenar.
  expect(String(matning), matning.name).not.toMatch(/\.push\((?![A-Z][\w$]*\.)/);
  const provade = [...new Set(utslag.flatMap(([, fynd]) => fynd.map(([mall]) => mall)))].sort();
  expect(provade, `${matning.name}: varje mall ger ett fynd för något underlag`).toEqual(Object.keys(mallar).sort());
  for (const [i, [underlag, fynd]] of utslag.entries()) {
    const vantat = fynd.map(([mall, ...detaljer]) => mallar[mall]!(...(detaljer as never[])));
    expect(matning(...(underlag as never[])), `${matning.name}, underlag ${i + 1}`).toEqual(vantat);
  }
}

/** O2: varje fynd ordningsfel() kan ge, en mall per gren. */
const ORDNINGSFYND = {
  ordningar: (n: number) => `ORDER BY rang står ${n} gånger`,
  ordningIFil: (fil: string) => `ORDER BY rang står i ${fil}`,
  inteTotal: (rad: string) => `ordningen är inte total: ${rad}`,
  fragor: (n: number) => `plainto_tsquery( står ${n} gånger`,
  anrop: (n: number) => `sokTraffar( står ${n} gånger i ${SOKFIL}`,
  anropIFil: (fil: string) => `sokTraffar( står i ${fil}`,
};

/** O2: den enda sökfrågan bär den totala ordningen. Tom lista när allt stämmer. */
function ordningsfel(filer: Fil[]): string[] {
  const fynd: string[] = [];
  const ordningar = filer.flatMap(({ fil, text }) =>
    kodrader(text).filter((rad) => rad.includes('ORDER BY rang')).map((rad) => ({ fil, rad: rad.trim() })));
  if (ordningar.length !== 1) fynd.push(ORDNINGSFYND.ordningar(ordningar.length));
  for (const { fil, rad } of ordningar) {
    if (fil !== SOKFIL) fynd.push(ORDNINGSFYND.ordningIFil(fil));
    if (rad !== TOTAL_ORDNING) fynd.push(ORDNINGSFYND.inteTotal(rad));
  }
  const fragor = filer.reduce((n, { text }) => n + antal(kodrader(text).join('\n'), 'plainto_tsquery('), 0);
  if (fragor !== 1) fynd.push(ORDNINGSFYND.fragor(fragor));
  for (const { fil, text } of filer) {
    const anrop = antal(kodrader(text).join('\n'), 'sokTraffar(');
    if (fil === SOKFIL && anrop !== 3) fynd.push(ORDNINGSFYND.anrop(anrop));
    if (fil !== SOKFIL && anrop > 0) fynd.push(ORDNINGSFYND.anropIFil(fil));
  }
  return fynd;
}

/** Identifierarna ordnade som Postgres ordnar id fallande: uuid som gemen text, sorterad och vänd. */
function idFallande(arenden: Skapat[]): string[] {
  return [...arenden].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).reverse().map((a) => a.identifier);
}

describe('FR-2/B-18/Story 2.5 AK 1: total ordning', () => {
  // Tre nivåer: två med ordet två gånger (högre rang) och olika skapad; åtta med ordet
  // en gång, av vilka sex har exakt samma skapad och två ligger före respektive efter dem.
  const NIVAER = [
    ['hogA', 'Ordningsprovet ordningsprovet högt A', 9],
    ['hogB', 'Ordningsprovet ordningsprovet högt B', 10],
    ['sent', 'Ordningsprovet sent', 13],
    ['lika1', 'Ordningsprovet lika ett', 12],
    ['lika2', 'Ordningsprovet lika två', 12],
    ['lika3', 'Ordningsprovet lika tre', 12],
    ['lika4', 'Ordningsprovet lika fyra', 12],
    ['lika5', 'Ordningsprovet lika fem', 12],
    ['lika6', 'Ordningsprovet lika sex', 12],
    ['tidigt', 'Ordningsprovet tidigt', 8],
  ] as const;
  const LIKA = ['lika1', 'lika2', 'lika3', 'lika4', 'lika5', 'lika6'] as const;
  const roll: Record<string, Skapat> = {};

  beforeAll(async () => {
    for (const [namn, titel, timme] of NIVAER) {
      roll[namn] = await skapa(titel);
      await sattSkapad(roll[namn].id, timme);
    }
  });

  it('O1 (AK 1): två körningar ger samma totala ordning, och limit 5 tar samma början inne i gruppen av lika', async () => {
    const forsta = await sok('ordningsprovet');
    // Kontroll först: nivåerna är de fallet påstår.
    expect(forsta).toHaveLength(10);
    const rang = (namn: string) => forsta.find((t) => t.identifier === roll[namn]!.identifier)!.rang;
    expect(rang('hogA')).toBe(rang('hogB'));
    for (const namn of ['sent', ...LIKA, 'tidigt']) {
      expect(rang(namn), namn).toBe(rang('sent'));
      expect(rang(namn), namn).toBeLessThan(rang('hogA'));
    }

    // Den förväntade ordningen: högre rang först och där den senast skapade (hogB
    // timme 10 före hogA timme 9); sedan samma rang efter skapad (sent 13, de sex
    // lika 12, tidigt 8); de sex lika sinsemellan efter id fallande.
    const vantat = [
      roll.hogB!.identifier,
      roll.hogA!.identifier,
      roll.sent!.identifier,
      ...idFallande(LIKA.map((namn) => roll[namn]!)),
      roll.tidigt!.identifier,
    ];
    expect(forsta.map((t) => t.identifier)).toEqual(vantat);
    expect((await sok('ordningsprovet')).map((t) => t.identifier)).toEqual(vantat);
    expect((await sok('ordningsprovet', 5)).map((t) => t.identifier)).toEqual(vantat.slice(0, 5));
  });

  it('O2 (AK 1): den enda sökfrågan i src/ ordnar på rang, skapad och id, alla fallande', () => {
    // Kontroll först: mätningen slår ut gren för gren på påhittade filer, och hela
    // kommentarsrader räknas inte.
    const sokfraga = (ordning: string, anrop = 2): Fil => ({
      fil: SOKFIL,
      text: [
        'async function sokTraffar(',
        "       CROSS JOIN (SELECT plainto_tsquery('simple', $2) AS tsq) q",
        `      ${ordning}`,
        ...Array.from({ length: anrop }, () => '  return sokTraffar(client, tenantId, fraga, limit);'),
      ].join('\n'),
    });
    const total = sokfraga(TOTAL_ORDNING);
    const annan = (fil: string, rad: string): Fil => ({ fil, text: `  ${rad}` });
    const kommentarer = "\n  // ORDER BY rang DESC\n  /* plainto_tsquery('simple', $1) */\n   * sokTraffar(client)";
    const fall = (filer: Fil[], ...fynd: Fynd[]): Utslag => [[filer], fynd];
    provaUtslag(ordningsfel, ORDNINGSFYND, [
      fall([total]),
      fall([{ fil: SOKFIL, text: total.text + kommentarer }]),
      fall([sokfraga('LIMIT $3')], ['ordningar', 0]),
      fall([total, annan('services/annan.ts', TOTAL_ORDNING)], ['ordningar', 2], ['ordningIFil', 'services/annan.ts']),
      fall([sokfraga('ORDER BY rang DESC, i.skapad DESC')], ['inteTotal', 'ORDER BY rang DESC, i.skapad DESC']),
      fall([sokfraga('ORDER BY rang DESC, i.id DESC, i.skapad DESC')],
        ['inteTotal', 'ORDER BY rang DESC, i.id DESC, i.skapad DESC']),
      fall([sokfraga('ORDER BY rang DESC, i.skapad DESC, i.id')], ['inteTotal', 'ORDER BY rang DESC, i.skapad DESC, i.id']),
      fall([{ fil: SOKFIL, text: total.text.replace('plainto_tsquery(', 'to_tsquery(') }], ['fragor', 0]),
      fall([total, annan('services/annan.ts', "SELECT plainto_tsquery('simple', $1)")], ['fragor', 2]),
      fall([sokfraga(TOTAL_ORDNING, 1)], ['anrop', 2]),
      fall([sokfraga(TOTAL_ORDNING, 3)], ['anrop', 4]),
      fall([total, annan('http/routes/annan.ts', 'await sokTraffar(client);')], ['anropIFil', 'http/routes/annan.ts']),
    ]);
    // Fyndet som var rött före Uppgift 1, ordagrant.
    expect(ordningsfel([sokfraga('ORDER BY rang DESC, i.skapad DESC')]))
      .toEqual(['ordningen är inte total: ORDER BY rang DESC, i.skapad DESC']);

    const filer = kodfiler();
    expect(filer.map(({ fil }) => fil)).toContain(SOKFIL);
    expect(ordningsfel(filer)).toEqual([]);
  });
});

// PRD:ns kontrollfall (FR-2): samma ord i en titel och i en kommentar. Ingen viktning
// (AK 3), så rangen avgör när den skiljer sig och annars den senast skapade.
const KONTROLLFALL = [
  {
    ord: 'kontrollfallet',
    titeltraffen: { titel: 'Kontrollfallet i titeln', timme: 30 },
    kommentarstraffen: { titel: 'Ett ärende utan ordet', kommentar: 'Här nämns kontrollfallet en gång.', timme: 31 },
    ordning: ['kommentarstraffen', 'titeltraffen'],
    rangen: 'lika',
    varfor: 'lika rang, och kommentarsträffen är skapad senare, så den står först',
  },
  {
    ord: 'motfallet',
    titeltraffen: { titel: 'Motfallet i titeln', timme: 41 },
    kommentarstraffen: { titel: 'Ännu ett ärende utan ordet', kommentar: 'Här nämns motfallet en gång.', timme: 40 },
    ordning: ['titeltraffen', 'kommentarstraffen'],
    rangen: 'lika',
    varfor: 'lika rang, och titelträffen är skapad senare, så den står först',
  },
  {
    ord: 'tyngdfallet',
    titeltraffen: { titel: 'Tyngdfallet i titeln', timme: 51 },
    kommentarstraffen: {
      titel: 'Tredje ärendet utan ordet', kommentar: 'Tyngdfallet, tyngdfallet och tyngdfallet.', timme: 50,
    },
    ordning: ['kommentarstraffen', 'titeltraffen'],
    rangen: 'högre för kommentarstraffen',
    varfor: 'ordet tre gånger i kommentaren mot en gång i titeln ger kommentarsträffen högre rang, så den står först fast titelträffen är skapad senare',
  },
] as const;

/** Identifierarna ur varje sökkort i sidans ordning. */
function kortI(html: string): string[] {
  return [...html.matchAll(/<a class=kort href="\/vy\/arende\/([A-Z0-9-]+)">/g)].map((m) => m[1]!);
}

async function vyordning(fraga: string): Promise<{ status: number; kort: string[]; summering: string | null }> {
  const svar = await request(sokApp).get('/vy/sok').query({ q: fraga });
  return {
    status: svar.status,
    kort: kortI(svar.text),
    summering: /<p class=summering>(\d+ träffar\.)<\/p>/.exec(svar.text)?.[1] ?? null,
  };
}

describe('FR-2/B-18/Story 2.5 AK 2: PRD:ns kontrollfall', () => {
  const par: Record<string, { titeltraffen: Skapat; kommentarstraffen: Skapat }> = {};
  const likafallet: Skapat[] = [];

  beforeAll(async () => {
    for (const fall of KONTROLLFALL) {
      const titeltraffen = await skapa(fall.titeltraffen.titel);
      await sattSkapad(titeltraffen.id, fall.titeltraffen.timme);
      const kommentarstraffen = await skapa(fall.kommentarstraffen.titel, [fall.kommentarstraffen.kommentar]);
      await sattSkapad(kommentarstraffen.id, fall.kommentarstraffen.timme);
      par[fall.ord] = { titeltraffen, kommentarstraffen };
    }
    for (const titel of ['Likafallet ett', 'Likafallet två', 'Likafallet tre']) {
      const arende = await skapa(titel);
      await sattSkapad(arende.id, 60);
      likafallet.push(arende);
    }
  });

  it('O3 (AK 2): titelträffen och kommentarsträffen står i den utskrivna ordningen i search_issues', async () => {
    // Kontroll först: i kontrollfallet är träffplatserna olika och rangen lika, så
    // ordningen avgörs av skapad och inte av träffplatsen.
    const kontroll = await sok('kontrollfallet');
    expect(kontroll).toHaveLength(2);
    expect(kontroll.map((t) => t.traff_i).sort()).toEqual(['arende', 'kommentar']);
    expect(kontroll[0]!.rang).toBe(kontroll[1]!.rang);

    for (const fall of KONTROLLFALL) {
      const arenden = par[fall.ord]!;
      const traffar = await sok(fall.ord);
      expect(traffar.map((t) => t.identifier), `${fall.ord}: ${fall.varfor}`)
        .toEqual(fall.ordning.map((roll) => arenden[roll].identifier));
      expect(traffar.map((t) => t.traff_i), fall.ord)
        .toEqual(fall.ordning.map((roll) => (roll === 'titeltraffen' ? 'arende' : 'kommentar')));
      const rang = (roll: 'titeltraffen' | 'kommentarstraffen') =>
        traffar.find((t) => t.identifier === arenden[roll].identifier)!.rang;
      if (fall.rangen === 'lika') expect(rang('kommentarstraffen'), fall.ord).toBe(rang('titeltraffen'));
      else expect(rang('kommentarstraffen'), fall.ord).toBeGreaterThan(rang('titeltraffen'));
    }
  });

  it('O4 (AK 2): /vy/sok visar korten i samma ordning som search_issues', async () => {
    // Kontroll först: kortläsaren ger en påhittad sidas två kort i den ordning de står.
    expect(kortI(
      '<p class=summering>2 träffar.</p><a class=kort href="/vy/arende/LOC-2"><b>LOC-2 — B</b></a>' +
      '<a href="/vy/arende/LOC-3">länk</a><a class=kort href="/vy/arende/LOC-1"><b>LOC-1 — A</b></a>',
    )).toEqual(['LOC-2', 'LOC-1']);

    for (const fall of KONTROLLFALL) {
      const api = (await sok(fall.ord)).map((t) => t.identifier);
      expect(await vyordning(fall.ord), fall.ord).toEqual({ status: 200, kort: api, summering: '2 träffar.' });
    }
    const api = (await sok('likafallet')).map((t) => t.identifier);
    expect(api).toEqual(idFallande(likafallet));
    expect(await vyordning('likafallet')).toEqual({ status: 200, kort: api, summering: '3 träffar.' });
  });
});

/** Postgres egen ts_rank för en text, som vektorerna räknar den: 'simple' och inga vikter. */
async function forvantadRang(text: string, fraga: string): Promise<number> {
  const { rows } = await pool.query<{ rang: number }>(
    "SELECT ts_rank(to_tsvector('simple', $1), plainto_tsquery('simple', $2)) AS rang",
    [text, fraga],
  );
  return rows[0]!.rang;
}

const RANGFORMER = ['ts_rank(i.sokvektor, q.tsq)', 'ts_rank(c.sokvektor, q.tsq)'];

/** O5: varje fynd viktfel() kan ge, en mall per gren. */
const VIKTFYND = {
  rangar: (n: number) => `ts_rank( står ${n} gånger`,
  rangIFil: (fil: string) => `ts_rank( utanför ${SOKFIL}: ${fil}`,
  form: (uttryck: string) => `ts_rank med annan form: ${uttryck}`,
  setweight: (fil: string) => `setweight i ${fil}`,
};

/** O5: rangen har två ts_rank utan vikter i sökfrågan, och ingen vektor viktas. Tom lista när allt stämmer. */
function viktfel(filer: Fil[], migrationer: Fil[]): string[] {
  const fynd: string[] = [];
  const rangar = filer.flatMap(({ fil, text }) => {
    const kod = kodrader(text).join('\n');
    return [...kod.matchAll(/ts_rank\(/g)].map((m) => ({ fil, uttryck: kod.slice(m.index, kod.indexOf(')', m.index) + 1) }));
  });
  if (rangar.length !== 2) fynd.push(VIKTFYND.rangar(rangar.length));
  for (const { fil, uttryck } of rangar) {
    if (fil !== SOKFIL) fynd.push(VIKTFYND.rangIFil(fil));
    if (!RANGFORMER.includes(uttryck)) fynd.push(VIKTFYND.form(uttryck));
  }
  for (const { fil, text } of [...filer, ...migrationer]) {
    if (/setweight/i.test(text)) fynd.push(VIKTFYND.setweight(fil));
  }
  return fynd;
}

describe('FR-2/B-18/Story 2.5 AK 3: ingen viktning', () => {
  // Ordet i olika lägen; den sista kommentaren tas bort och hade annars gett högst rang.
  const VIKTFALL = [
    { roll: 'titelEn', titel: 'Viktprovet i titeln', kommentarer: [] },
    { roll: 'kommentarEn', titel: 'Utan ordet', kommentarer: ['Viktprovet i kommentaren.'] },
    { roll: 'kommentarBast', titel: 'Viktprovet en gång', kommentarer: ['viktprovet viktprovet viktprovet'] },
    { roll: 'titelBast', titel: 'Viktprovet viktprovet viktprovet', kommentarer: ['viktprovet'] },
    { roll: 'borttagen', titel: 'Viktprovet borttaget', kommentarer: ['viktprovet viktprovet viktprovet viktprovet'] },
  ] as const;
  const roll: Record<string, Skapat> = {};

  beforeAll(async () => {
    for (const fall of VIKTFALL) roll[fall.roll] = await skapa(fall.titel, [...fall.kommentarer]);
    const borttagning = await kor(sokApp, david, 'delete_comment', { kommentar_id: roll.borttagen!.kommentarer[0] });
    expect(borttagning.status, JSON.stringify(borttagning.body)).toBe(200);
  });

  it('O5 (AK 3): rangen är den största av ärendets och de kvarvarande kommentarernas ts_rank, utan vikter', async () => {
    // sok() prövar också varje träffs rang och träffplats (AK 4).
    const traffar = await sok('viktprovet');
    expect(traffar).toHaveLength(5);
    const rang = (namn: string) => traffar.find((t) => t.identifier === roll[namn]!.identifier)!.rang;

    // Kontroll först: tre förekomster ger högre rang än en, och den borttagna
    // kommentaren hade gett högre rang än det femte ärendet har.
    expect(await forvantadRang('viktprovet viktprovet viktprovet', 'viktprovet'))
      .toBeGreaterThan(await forvantadRang('viktprovet', 'viktprovet'));
    expect(await forvantadRang(VIKTFALL[4].kommentarer[0], 'viktprovet')).toBeGreaterThan(rang('borttagen'));

    for (const fall of VIKTFALL) {
      // Ärendets text är titeln, ett blanksteg och beskrivningen (tom), som i vektorn.
      const kvar = fall.roll === 'borttagen' ? [] : fall.kommentarer;
      const rangar: number[] = [];
      for (const text of [`${fall.titel} `, ...kvar]) rangar.push(await forvantadRang(text, 'viktprovet'));
      expect(rang(fall.roll), fall.roll).toBe(Math.max(...rangar));
    }
    expect(rang('titelEn')).toBe(rang('kommentarEn'));

    // Statiskt, med kontrollen först: mätningen slår ut gren för gren på påhittade filer.
    // ts_rank räknas inte i hela kommentarsrader, men setweight fälls också i en kommentar.
    const rangkod = (forsta: string, mer = ''): Fil =>
      ({ fil: SOKFIL, text: `  ${forsta},\n  max(ts_rank(c.sokvektor, q.tsq))${mer}` });
    const ratt = rangkod('ts_rank(i.sokvektor, q.tsq)');
    const kommentarer = "\n  // ts_rank('{1, 1, 1, 1}', i.sokvektor, q.tsq)\n  /* ts_rank(i.sokvektor, q.tsq, 32) */" +
      '\n   * ts_rank(c.sokvektor, q.tsq, 1)';
    const fall = (filer: Fil[], migrationer: Fil[], ...fynd: Fynd[]): Utslag => [[filer, migrationer], fynd];
    provaUtslag(viktfel, VIKTFYND, [
      fall([ratt], []),
      fall([rangkod('ts_rank(i.sokvektor, q.tsq)', kommentarer)], []),
      fall([], [], ['rangar', 0]),
      fall([{ fil: SOKFIL, text: '  ts_rank(i.sokvektor, q.tsq)' }], [], ['rangar', 1]),
      fall([ratt, { fil: 'services/annan.ts', text: '  ts_rank(c.sokvektor, q.tsq)' }], [],
        ['rangar', 3], ['rangIFil', 'services/annan.ts']),
      fall([rangkod("ts_rank('{0.1, 0.2, 0.4, 1.0}', i.sokvektor, q.tsq)")], [],
        ['form', "ts_rank('{0.1, 0.2, 0.4, 1.0}', i.sokvektor, q.tsq)"]),
      fall([rangkod('ts_rank(i.sokvektor, q.tsq, 32)')], [], ['form', 'ts_rank(i.sokvektor, q.tsq, 32)']),
      fall([ratt], [{ fil: 'migrations/9999_vikt.sql', text: "-- SETWEIGHT(to_tsvector('simple', title), 'A')" }],
        ['setweight', 'migrations/9999_vikt.sql']),
      fall([rangkod('ts_rank(i.sokvektor, q.tsq)', '\n  // titeln får setweight A')], [], ['setweight', SOKFIL]),
    ]);

    const migrationer = readdirSync(path.join(ROT, 'migrations'), { recursive: true }).map(String)
      .filter((f) => f.endsWith('.sql')).sort()
      .map((f) => ({ fil: `migrations/${f.split(path.sep).join('/')}`, text: readFileSync(path.join(ROT, 'migrations', f), 'utf8') }));
    expect(migrationer.map(({ fil }) => fil)).toContain('migrations/0005_sok.sql');
    expect(viktfel(kodfiler(), migrationer)).toEqual([]);
  });
});

/** Platserna i ett ärende ur get_issue där ordet står, utan hänsyn till skiftläge. */
function platser(
  resultat: { arende: { title: string; description: string | null }; kommentarer: { body: string }[] },
  ord: string,
): string[] {
  const har = (text: string | null) => (text ?? '').toLowerCase().includes(ord);
  return [
    ...(har(resultat.arende.title) ? ['titeln'] : []),
    ...(har(resultat.arende.description) ? ['beskrivningen'] : []),
    ...(resultat.kommentarer.some((k) => har(k.body)) ? ['kommentaren'] : []),
  ];
}

describe('FR-2/Story 2.5 AK 4: träffbilden står kvar', () => {
  // Varje träffplats som AK 4 räknar upp, för ett skapat och ett importerat ärende (LOC-88),
  // med den träffplats svaret ska ange: ett ord i titeln eller beskrivningen träffar
  // ärendet, ett ord bara i en kommentar träffar kommentaren.
  const TRAFFBILD = [
    { kalla: 'skapat', plats: 'titeln', ord: 'rubrikordet', traff_i: 'arende' },
    { kalla: 'skapat', plats: 'beskrivningen', ord: 'beskrivningsordet', traff_i: 'arende' },
    { kalla: 'skapat', plats: 'kommentaren', ord: 'kommentarsordet', traff_i: 'kommentar' },
    { kalla: 'importerat', plats: 'titeln', ord: 'global', traff_i: 'arende' },
    { kalla: 'importerat', plats: 'beskrivningen', ord: 'oklar', traff_i: 'arende' },
    { kalla: 'importerat', plats: 'kommentaren', ord: 'cowork', traff_i: 'kommentar' },
  ] as const;
  let radering: Skapat;
  let skapat: Skapat;

  beforeAll(async () => {
    radering = await skapa('Ärendet med den borttagna kommentaren', ['Raderingsordet står bara här.']);
    skapat = await skapa('Rubrikordet i titeln', ['Kommentarsordet bara i kommentaren.'],
      'Beskrivningsordet bara i beskrivningen.');
    // Importen sist i filen: de 28 skapade ärendena är LOC-1 till LOC-28, långt under
    // fixturernas nummer (LOC-88 och uppåt).
    await importeraArkiv(FIXTURER);
  });

  it('O6 (AK 4): ett ord bara i en borttagen kommentar ger ingen träff, och varje träff bär rang och träffplats', async () => {
    // Varje sökning genom sok() prövar varje träff med traffbildsfel(). Kontroll först:
    // den mätningen slår ut gren för gren på påhittade träffar.
    const fall = (traffar: Partial<Traff>[], ...fynd: Fynd[]): Utslag => [[traffar], fynd];
    provaUtslag(traffbildsfel, TRAFFBILDSFYND, [
      fall([]),
      fall([{ identifier: 'LOC-1', rang: 0.0607927, traff_i: 'arende' },
        { identifier: 'LOC-2', rang: 0.1, traff_i: 'kommentar' }]),
      fall([{ identifier: 'LOC-1', rang: 0, traff_i: 'arende' }], ['rang', 'LOC-1', 0]),
      fall([{ identifier: 'LOC-1', rang: -0.1, traff_i: 'kommentar' }], ['rang', 'LOC-1', -0.1]),
      fall([{ identifier: 'LOC-1', rang: Number.NaN, traff_i: 'arende' }], ['rang', 'LOC-1', Number.NaN]),
      fall([{ identifier: 'LOC-1', rang: '0.1' as never, traff_i: 'arende' }], ['rang', 'LOC-1', '0.1']),
      fall([{ identifier: 'LOC-1', traff_i: 'arende' }], ['rang', 'LOC-1', undefined]),
      fall([{ identifier: 'LOC-1', rang: 0.1, traff_i: 'titel' }], ['plats', 'LOC-1', 'titel']),
      fall([{ identifier: 'LOC-1', rang: 0.1 }], ['plats', 'LOC-1', undefined]),
      fall([{ identifier: 'LOC-1', rang: 0.1, traff_i: 'arende' }, { identifier: 'LOC-2', rang: 0, traff_i: 'beskrivning' }],
        ['rang', 'LOC-2', 0], ['plats', 'LOC-2', 'beskrivning']),
    ]);

    // Kontroll först: före borttagningen träffar ordet kommentaren, i API:t och i vyn.
    const fore = await sok('raderingsordet');
    expect(fore.map((t) => [t.identifier, t.traff_i])).toEqual([[radering.identifier, 'kommentar']]);
    expect(await vyordning('raderingsordet')).toEqual({ status: 200, kort: [radering.identifier], summering: '1 träffar.' });

    const borttagning = await kor(sokApp, david, 'delete_comment', { kommentar_id: radering.kommentarer[0] });
    expect(borttagning.status, JSON.stringify(borttagning.body)).toBe(200);
    expect(borttagning.body.result.andrad).toBe(true);
    expect(await sok('raderingsordet')).toEqual([]);
    expect(await vyordning('raderingsordet')).toEqual({ status: 200, kort: [], summering: '0 träffar.' });
  });

  it('O7 (AK 4): skapade och importerade ärenden träffas i titeln, i beskrivningen och bara i en kommentar', async () => {
    // Kontroll först: importen har körts, och varje ord står bara på den plats raden
    // säger, så att träffen bara kan komma därifrån.
    const loc88 = await kor(sokApp, hermes, 'get_issue', { identifier: 'LOC-88' });
    expect(loc88.status, JSON.stringify(loc88.body)).toBe(200);
    expect(loc88.body.result.arende.title).toContain('Global');
    const identifierFor = (kalla: string) => (kalla === 'skapat' ? skapat.identifier : 'LOC-88');
    for (const rad of TRAFFBILD) {
      const arende = await kor(sokApp, hermes, 'get_issue', { identifier: identifierFor(rad.kalla) });
      expect(arende.status, JSON.stringify(arende.body)).toBe(200);
      expect(platser(arende.body.result, rad.ord), `${rad.kalla}: ${rad.ord}`).toEqual([rad.plats]);
    }

    // sok() prövar dessutom varje träff i varje sökning med traffbildsfel().
    for (const rad of TRAFFBILD) {
      const traff = (await sok(rad.ord)).find((t) => t.identifier === identifierFor(rad.kalla));
      expect(traff, `${rad.kalla}: ${rad.ord}`).toBeDefined();
      expect(traff!.traff_i, `${rad.kalla}: ${rad.ord}`).toBe(rad.traff_i);
      expect(traff!.rang, `${rad.kalla}: ${rad.ord}`).toBeGreaterThan(0);
    }
  });
});
