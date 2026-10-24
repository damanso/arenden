// D-1, B-20: numret finns inte i sökindexet. Tolkning, nummeruppslag och den
// riktiga formulärvägen provas var för sig, utan mockar.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { PoolClient } from 'pg';
import pg from 'pg';
import request from 'supertest';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { MAX_ARENDENUMMER, tolkaArendenummer, tolkaArendenumrenIText } from '../src/lib/validation.js';
import { hittaArendenMedNummer, sattSekvens } from '../src/services/arenden.js';
import type { Team } from '../src/services/team.js';
import { kor, nyNyckel, seedaTeam, TENANT_ID } from './helpers.js';

const MED_PREFIX = [
  'LOC-503', 'loc-503', 'Loc-503', 'LOC 503', 'LOC - 503', 'loc -503', 'LOC503',
  'LOC\u2013503', 'LOC\u2014503', 'LOC\u2212503', 'LOC\u2011503', 'LOC-0503',
];
const UTAN_PREFIX = ['503', '#503', '0503'];
const FORMER = [...MED_PREFIX, ...UTAN_PREFIX];
const OMGIVNING = ['', ' ', '\t', '\u00a0'];
const INTE_NUMMER = ['LOC-503 faktura', 'LOC-', 'loc-5o3', '503-504', 'LOC-503-2', '-503', '', '   '];

const SOKNINGAR: { q: string; fasett: Record<string, string> }[] = [
  ...FORMER.flatMap((q) => [{ q, fasett: {} }, { q, fasett: { status: 'completed' } }]),
  ...['12', '7', '#7', '8', 'loc-99999', '99999', 'LOC-88888', 'LOC-99999999999',
    'LOC-503 faktura', 'faktura loc-12 LOC-99999', 'LOC-503 LOC-12'].map((q) => ({ q, fasett: {} })),
];

describe('D-1/Story 11.1 AK 1 och AK 5: den rena tolkningen', () => {
  it('F1 (AK 1): tolkar femton former i fyra omgivningar', () => {
    for (const form of FORMER) for (const o of OMGIVNING) {
      const q = `${o}${form}${o}`;
      const teamKey = MED_PREFIX.includes(form) ? 'LOC' : null;
      expect(tolkaArendenummer(q), JSON.stringify(q)).toEqual({
        slag: 'nummer', teamKey, nummer: 503, text: teamKey ? 'LOC-503' : '503',
      });
    }
  });

  it('F2 (AK 1): avvisar åtta strängar som inte är ett helt nummer', () => {
    for (const q of INTE_NUMMER) expect(tolkaArendenummer(q), JSON.stringify(q)).toBeNull();
  });

  it('F3 (AK 1): gränsen gäller värdet och inte antalet siffror', () => {
    expect(MAX_ARENDENUMMER).toBe(2147483647);
    const fall = [
      ['LOC-2147483647', { slag: 'nummer', teamKey: 'LOC', nummer: 2147483647, text: 'LOC-2147483647' }],
      ['LOC-2147483648', { slag: 'kan_inte_finnas', teamKey: 'LOC', text: 'LOC-2147483648' }],
      ['2147483648', { slag: 'kan_inte_finnas', teamKey: null, text: '2147483648' }],
      ['LOC-99999999999', { slag: 'kan_inte_finnas', teamKey: 'LOC', text: 'LOC-99999999999' }],
      ['LOC-0000000000007', { slag: 'nummer', teamKey: 'LOC', nummer: 7, text: 'LOC-7' }],
    ] as const;
    for (const [q, svar] of fall) expect(tolkaArendenummer(q), q).toEqual(svar);
  });

  it('F4 (AK 1): kräver avskiljare för teamnycklar med siffror', () => {
    for (const [q, teamKey, nummer] of [['ab1-5', 'AB1', 5], ['ab15', 'AB', 15], ['faktura 7', 'FAKTURA', 7]] as const) {
      expect(tolkaArendenummer(q), q).toEqual({ slag: 'nummer', teamKey, nummer, text: `${teamKey}-${nummer}` });
    }
  });

  it('F5 (AK 5 och AK 6): tolkar ord i ordning utan dubbletter och lämnar fritexten', () => {
    const nummer = (text: string, teamKey: string | null, n: number) => ({ slag: 'nummer', teamKey, nummer: n, text });
    expect(tolkaArendenumrenIText('faktura loc-12 LOC-99999')).toEqual([
      nummer('LOC-12', 'LOC', 12), nummer('LOC-99999', 'LOC', 99999),
    ]);
    expect(tolkaArendenumrenIText('LOC-503 faktura')).toEqual([nummer('LOC-503', 'LOC', 503)]);
    expect(tolkaArendenumrenIText('LOC-12 loc-12 #7')).toEqual([nummer('LOC-12', 'LOC', 12), nummer('7', null, 7)]);
    expect(tolkaArendenumrenIText('x LOC-99999999999')).toEqual([
      { slag: 'kan_inte_finnas', teamKey: 'LOC', text: 'LOC-99999999999' },
    ]);
    for (const q of ['faktura', 'HubSpot', 'klientdoc', 'citat', 'tigerbalsam', 'text', 'Leverans', 'zebrafinkarna']) {
      expect(tolkaArendenumrenIText(q), q).toEqual([]);
      expect(tolkaArendenummer(q), q).toBeNull();
    }
  });

  it('F6 (AK 1): tolkningen har bara zod som import och exporterar de rena funktionerna', () => {
    const kod = readFileSync(new URL('../src/lib/validation.ts', import.meta.url), 'utf8');
    const importer = kod.match(/^import\b[^;]+;/gm) ?? [];
    expect(importer).toHaveLength(1);
    expect(importer[0]).toMatch(/from 'zod';$/);
    expect(tolkaArendenummer).toBeTypeOf('function');
    expect(tolkaArendenumrenIText).toBeTypeOf('function');
    expect(MAX_ARENDENUMMER).toBe(2147483647);
  });
});

let app: Express;
let nyckel: string;

async function skapaMedNummer(team: Team, nummer: number, title: string, description?: string): Promise<void> {
  await withTransaction((client) => sattSekvens(client, team.sekvensnamn, nummer - 1));
  const svar = await kor(app, nyckel, 'create_issue', {
    title, team_key: team.key, ...(description !== undefined ? { description } : {}),
  });
  expect(svar.status, JSON.stringify(svar.body)).toBe(200);
  expect(svar.body.result.identifier).toBe(`${team.key}-${nummer}`);
}

/** Instrumentering: varje räknad fråga går vidare till riktig Postgres. */
function raknandeKlient(client: PoolClient): { klient: PoolClient; antal: () => number } {
  let antal = 0;
  const klient = new Proxy(client, {
    get(mal, namn) {
      const varde: unknown = Reflect.get(mal, namn, mal);
      if (namn === 'query' && typeof varde === 'function') {
        return (...args: unknown[]) => {
          antal += 1;
          return (varde as (...a: unknown[]) => unknown).apply(mal, args);
        };
      }
      return typeof varde === 'function' ? (varde as (...a: unknown[]) => unknown).bind(mal) : varde;
    },
  });
  return { klient, antal: () => antal };
}

async function sokformular(): Promise<{ action: string; falt: string }> {
  const sida = await request(app).get('/vy/sok');
  expect(sida.status).toBe(200);
  const action = /<form class=sok method=get action="([^"]+)">/.exec(sida.text)?.[1];
  const falt = /<input type=search\b[^>]*\bname="?([^"\s>]+)/.exec(sida.text)?.[1];
  expect(action, 'formulärets action').toBeDefined();
  expect(falt, 'sökfältets name').toBeDefined();
  return { action: action!, falt: falt! };
}

async function observera(action: string, falt: string, q: string, fasett: Record<string, string> = {}) {
  const svar = await request(app).get(action).query({ [falt]: q, ...fasett });
  return { q, fasett, status: svar.status, location: svar.headers['location'] ?? null, html: svar.text };
}

/** Nummerblocket ligger direkt efter formuläret, före aktiva filter och fasetter. */
function nummerblock(html: string): string {
  const start = html.indexOf('</form>', html.indexOf('<form class=sok')) + '</form>'.length;
  return html.slice(start, html.indexOf('<div class=fasetter>', start));
}

const SUMMERING = /<p class=summering>\d+ träffar\.<\/p>/;
const INGA_ANDRA = '<p class=notis>Inga andra ärenden nämner numret heller. <a href="/vy">Till överblicken</a></p>';

function kortI(block: string): string[] {
  return [...block.matchAll(/href="\/vy\/arende\/([A-Z0-9-]+)"/g)].map((m) => m[1]!);
}

/** Radantal och innehållsavtryck för alla tabeller, som ägaren; antal ensamt ser ingen UPDATE. */
async function raknaAllaTabeller(): Promise<Record<string, { n: number; avtryck: string }>> {
  const agare = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await agare.connect();
  try {
    const { rows } = await agare.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const ut: Record<string, { n: number; avtryck: string }> = {};
    for (const { tablename } of rows) {
      const r = await agare.query<{ n: number; avtryck: string }>(
        `SELECT count(*)::int AS n,
                coalesce(md5(string_agg(t::text, chr(10) ORDER BY t::text)), '') AS avtryck
           FROM public.${agare.escapeIdentifier(tablename)} t`,
      );
      ut[tablename] = r.rows[0]!;
    }
    return ut;
  } finally {
    await agare.end();
  }
}

describe('D-1/Story 11.1: genom hela stacken', () => {
  beforeAll(async () => {
    app = createApp();
    const loc = await seedaTeam();
    const abc = await seedaTeam('ABC', 'Abc');
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    await skapaMedNummer(loc, 7, 'Sjunde ärendet i Locollabs');
    await skapaMedNummer(abc, 7, 'Sjunde ärendet i Abc');
    await skapaMedNummer(loc, 12, 'Kvartalsavstämning med kunden');
    for (const body of ['Underlaget ligger i LOC-503 och skickas i veckan', 'Vi pratade om LOC-99999 på mötet']) {
      const svar = await kor(app, nyckel, 'add_comment', { identifier: 'LOC-12', body });
      expect(svar.status, JSON.stringify(svar.body)).toBe(200);
    }
    await skapaMedNummer(loc, 503, 'Fakturaunderlaget till kunden', 'Underlag inför fakturan.');
  });

  describe('D-1/Story 11.1 AK 5 och AK 3: ett samlat uppslag', () => {
    it('F7 (AK 5 och AK 3): tre frågor ger rätt listor och läsmodell med en databasfråga', async () => {
      const facit = await kor(app, nyckel, 'get_issue', { identifier: 'LOC-503' });
      expect(facit.status).toBe(200);
      const nycklar = Object.keys(facit.body.result.arende).sort();
      await withTransaction(async (client) => {
        const raknare = raknandeKlient(client);
        const svar = await hittaArendenMedNummer(raknare.klient, TENANT_ID, [
          { teamKey: 'LOC', nummer: 503 }, { teamKey: null, nummer: 7 }, { teamKey: 'LOC', nummer: 99999 },
        ]);
        expect(svar.map((lista) => lista.map((a) => a.identifier))).toEqual([['LOC-503'], ['ABC-7', 'LOC-7'], []]);
        expect(raknare.antal()).toBe(1);
        for (const a of svar.flat()) {
          expect(Object.keys(a).sort()).toEqual(nycklar);
          expect(a).not.toHaveProperty('nummer');
        }
      });
    });

    it('F8 (AK 1 och AK 4): tomt och för stort gör ingen fråga, gränsen gör en', async () => {
      await withTransaction(async (client) => {
        const raknare = raknandeKlient(client);
        expect(await hittaArendenMedNummer(raknare.klient, TENANT_ID, [])).toEqual([]);
        expect(raknare.antal()).toBe(0);
        expect(await hittaArendenMedNummer(raknare.klient, TENANT_ID, [{ teamKey: 'LOC', nummer: 2147483648 }])).toEqual([[]]);
        expect(raknare.antal()).toBe(0);
        expect(await hittaArendenMedNummer(raknare.klient, TENANT_ID, [{ teamKey: 'LOC', nummer: 2147483647 }])).toEqual([[]]);
        expect(raknare.antal()).toBe(1);
      });
    });
  });

  describe('D-1/Story 11.1 AK 2: den riktiga formulärvägen öppnar numret', () => {
    it('F9 (AK 2 och AK 8): femton former öppnar ärendet även med fel fasett', async () => {
      const { action, falt } = await sokformular();
      // Motkontroll först: den oförändrade fritextvägen gav före berättelsen
      // samma 200 utan omdirigering för varje sökning, också ärendenummer.
      expect(tolkaArendenumrenIText('Fakturaunderlaget')).toEqual([]);
      const kontroll = await observera(action, falt, 'Fakturaunderlaget');
      expect({ status: kontroll.status, location: kontroll.location }).toEqual({ status: 200, location: null });
      expect(kontroll.html).toContain('href="/vy/arende/LOC-503"');
      expect(kontroll.html).toMatch(SUMMERING);
      expect(nummerblock(kontroll.html)).toBe('');

      const obs = [];
      for (const q of FORMER) for (const fasett of [{}, { status: 'completed' }] as Record<string, string>[]) {
        const { html: _, ...o } = await observera(action, falt, q, fasett);
        obs.push(o);
      }
      expect(obs).toEqual(obs.map((o) => ({ ...o, status: 303, location: '/vy/arende/LOC-503' })));
      for (const o of obs) {
        const sida = await request(app).get(o.location!);
        expect(sida.status, o.q).toBe(200);
        expect(sida.text, o.q).toContain('<h1>LOC-503 — Fakturaunderlaget till kunden</h1>');
      }
    });
  });

  describe('D-1/Story 11.1 AK 3: nummer utan teamnyckel', () => {
    it('F10 (AK 3): ett nummer i bara ett team öppnas', async () => {
      const { action, falt } = await sokformular();
      const { html: _, ...o } = await observera(action, falt, '12');
      expect([o]).toEqual([{ q: '12', fasett: {}, status: 303, location: '/vy/arende/LOC-12' }]);
    });

    it('F11 (AK 3): två team ger kort i teamordning och ingen fritextsummering', async () => {
      const { action, falt } = await sokformular();
      const rubrik = '<h2>Ärenden med nummer 7 (2)</h2>';
      const obs = [];
      for (const q of ['7', '#7']) {
        const o = await observera(action, falt, q);
        const block = nummerblock(o.html);
        obs.push({ q, status: o.status, location: o.location, borjan: block.slice(0, rubrik.length),
          kort: kortI(block), summering: SUMMERING.test(o.html) });
      }
      expect(obs).toEqual(['7', '#7'].map((q) => ({ q, status: 200, location: null, borjan: rubrik,
        kort: ['ABC-7', 'LOC-7'], summering: false })));
    });

    it('F12 (AK 3): ett nummer i inget team får besked och överblickslänk', async () => {
      const { action, falt } = await sokformular();
      const o = await observera(action, falt, '8');
      expect([{ q: o.q, status: o.status, location: o.location, block: nummerblock(o.html),
        summering: SUMMERING.test(o.html) }]).toEqual([{
        q: '8', status: 200, location: null,
        block: '<p class=notis>Inget ärende har nummer 8.</p><h2>Ärenden som nämner 8</h2>' + INGA_ANDRA,
        summering: false,
      }]);
    });
  });

  describe('D-1/Story 11.1 AK 4: saknade nummer ger klara besked', () => {
    it('F13 (AK 4 och AK 8): beskedet står först och fritexten motsvarar API:t', async () => {
      const { action, falt } = await sokformular();
      // Motkontrollen körs före egna jämförelser, också under rödfasen.
      const kontroll = await observera(action, falt, 'Fakturaunderlaget');
      expect({ status: kontroll.status, location: kontroll.location }).toEqual({ status: 200, location: null });
      expect(nummerblock(kontroll.html)).toBe('');
      expect(kontroll.html).toMatch(SUMMERING);
      expect(kontroll.html).toContain('href="/vy/arende/LOC-503"');
      const obs = [];
      const vantat = [];
      for (const [q, text, ord] of [
        ['loc-99999', 'LOC-99999', 'numret'], ['99999', '99999', 'nummer'],
        ['LOC-88888', 'LOC-88888', 'numret'], ['LOC-99999999999', 'LOC-99999999999', 'numret'],
      ] as const) {
        const o = await observera(action, falt, q);
        const facit = await kor(app, nyckel, 'search_issues', { fraga: q });
        expect(facit.status).toBe(200);
        const identifierare = (facit.body.result as { identifier: string }[]).map((a) => a.identifier);
        if (q === 'loc-99999') expect(identifierare).toContain('LOC-12');
        if (q === 'LOC-88888' || q === 'LOC-99999999999') expect(identifierare).toEqual([]);
        const borjan = `<p class=notis>Inget ärende har ${ord} ${text}.</p><h2>Ärenden som nämner ${text}</h2>`;
        const block = nummerblock(o.html);
        obs.push({ q, status: o.status, location: o.location, borjan: block.slice(0, borjan.length),
          kort: kortI(block), ingaAndra: block.includes(INGA_ANDRA), summering: SUMMERING.test(o.html) });
        vantat.push({ q, status: 200, location: null, borjan, kort: identifierare,
          ingaAndra: identifierare.length === 0, summering: false });
      }
      expect(obs).toEqual(vantat);
    });
  });

  describe('D-1/Story 11.1 AK 5: nummer i längre sökningar', () => {
    it('F14 (AK 5): ett nummer och annan text visar kortet överst', async () => {
      const { action, falt } = await sokformular();
      const o = await observera(action, falt, 'LOC-503 faktura');
      const block = nummerblock(o.html);
      expect({ status: o.status, location: o.location }).toEqual({ status: 200, location: null });
      expect(block.startsWith('<h2>Ärendenumret i sökningen</h2>')).toBe(true);
      expect(kortI(block)).toEqual(['LOC-503']);
      expect(o.html.slice(o.html.indexOf('<div class=fasetter>'))).toMatch(SUMMERING);
    });

    it('F15 (AK 5): ett befintligt och ett saknat nummer visas i sökningens ordning', async () => {
      const { action, falt } = await sokformular();
      const o = await observera(action, falt, 'faktura loc-12 LOC-99999');
      const block = nummerblock(o.html);
      expect({ status: o.status, location: o.location }).toEqual({ status: 200, location: null });
      expect(block.startsWith('<h2>Ärendenumret i sökningen</h2>')).toBe(true);
      const kort = 'href="/vy/arende/LOC-12"';
      const besked = '<p class=notis>Inget ärende har numret LOC-99999.</p>';
      expect(block).toContain(kort);
      expect(block).toContain(besked);
      expect(block.indexOf(kort)).toBeLessThan(block.indexOf(besked));
      expect(o.html.slice(o.html.indexOf('<div class=fasetter>'))).toMatch(SUMMERING);
    });

    it('F16 (AK 5): två nummer utan annan text ger två kort utan omdirigering', async () => {
      const { action, falt } = await sokformular();
      const o = await observera(action, falt, 'LOC-503 LOC-12');
      expect({ status: o.status, location: o.location }).toEqual({ status: 200, location: null });
      const block = nummerblock(o.html);
      expect(block.startsWith('<h2>Ärendenumret i sökningen</h2>')).toBe(true);
      expect(kortI(block)).toEqual(['LOC-503', 'LOC-12']);
    });
  });

  describe('D-1/Story 11.1 AK 6: tomläget och det oförändrade API:t', () => {
    it('F17 (AK 6): tomläget beskriver fritexten och vägen till nummeruppslaget', async () => {
      const { action, falt } = await sokformular();
      const o = await observera(action, falt, 'zebrafinkarna');
      expect(o.status).toBe(200);
      expect(o.html).toContain('<div class=tomt><b>Inga träffar.</b>' +
        'Sökningen läser ärendetext och kommentarer. Skriv ett ärendenummer, t.ex. LOC-503, för att öppna ärendet direkt. ' +
        '<a href="/vy">Bläddra i stället →</a></div>');
      expect(o.html).not.toContain('Prova ett ärendenummer');
    });

    it('F18 (AK 6): search_issues förblir fritext och get_issue slår upp numret (R)', async () => {
      const svar = await kor(app, nyckel, 'search_issues', { fraga: 'LOC-503' });
      expect(svar.status).toBe(200);
      expect(Array.isArray(svar.body.result)).toBe(true);
      const traffar = svar.body.result as { identifier: string }[];
      for (const traff of traffar) {
        expect(Object.keys(traff).sort()).toEqual(['id', 'identifier', 'lank', 'rang', 'state_typ', 'title', 'traff_i']);
      }
      expect(traffar.map((t) => t.identifier)).toContain('LOC-12');
      expect(traffar.map((t) => t.identifier)).not.toContain('LOC-503');
      // Kontroll: numret finns, men det hittas av get_issue och inte av fritexten.
      const kontroll = await kor(app, nyckel, 'get_issue', { identifier: 'LOC-503' });
      expect(kontroll.status).toBe(200);
      expect(kontroll.body.result.arende.identifier).toBe('LOC-503');
    });
  });

  describe('D-1/Story 11.1 AK 7: sökningarna skriver ingenting', () => {
    it('F19 (AK 7): alla tabellers antal och innehåll står stilla under 41 sökningar (R)', async () => {
      // All förberedelse före före-räkningen; däremellan görs bara GET-sökningar.
      const { action, falt } = await sokformular();
      expect(SOKNINGAR).toHaveLength(41);
      const fore = await raknaAllaTabeller();
      expect(Object.keys(fore)).toEqual(expect.arrayContaining(['events', 'issues', 'comments']));
      const statusar = [];
      for (const s of SOKNINGAR) statusar.push((await observera(action, falt, s.q, s.fasett)).status);
      const efter = await raknaAllaTabeller();
      expect(efter).toEqual(fore);
      expect(statusar.every((s) => s === 200 || s === 303)).toBe(true);

      // Kontroll i samma fall: mätningen ser både nya rader och ändrat innehåll.
      const kontroll = await kor(app, nyckel, 'add_comment', { identifier: 'LOC-7', body: 'Kontroll av räkningen.' });
      expect(kontroll.status).toBe(200);
      const andrat = await raknaAllaTabeller();
      expect(andrat.events!.n).toBe(fore.events!.n + 1);
      expect(andrat.comments!.n).toBe(fore.comments!.n + 1);
      expect(andrat.issues!.avtryck).not.toBe(fore.issues!.avtryck);
    });
  });
});
