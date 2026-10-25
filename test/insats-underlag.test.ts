// D-2, B-22 (Story 11.3): handlingskontraktets underlag för en insats på ett ärende är ärendets adress. Underlaget
// härleds vid läsning ur ärendet, som joinas in i insatsfrågan, och raden i insatser skrivs aldrig om.
// Fallistorna: U1 den rena härledningen, fall a–h (AK 1 och AK 2); U2 tre läsvägar, `arende` och raden byte för
// byte, och U3 frågeräkningen 2, 2 och 3 (AK 1 och AK 8); U4 två insatser utan ärende (AK 2); U5 händelseraden
// för besvarade_insats (AK 3); U6 (R) registreringen sparar kontraktet som det skickades (AK 6); U7 kopplingens
// fem fall med radräkning och radlåset, och U8 de två verbens texter (AK 4); U9 mätningens fyra grupper, U10 READ
// ONLY och en kropp utan skrivord, och U11 skriptets utskrift och felväg (AK 5). Ur granskningen: U12 varje skrivväg
// som väntat på insatsens radlås svarar med ärendet som det är committat, och U13 vakten i kopplingens UPDATE
// (AK 3 och AK 4).
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import type { PoolClient } from 'pg';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { VERB } from '../src/http/vy/mall.js';
import { arendeLank, arendeSokvag } from '../src/lib/arendelank.js';
import { sattSekvens } from '../src/services/arenden.js';
// Namnrymd och inga namngivna importer: filen laddas också innan de nya funktionerna finns, och fallen som
// behöver dem blir röda med «är inte en funktion» (som i test/insats.test.ts).
import * as insatsTjansten from '../src/services/insats.js';
import { TEST_VY_PUBLIK_URL } from './env.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

/** Handlingskontraktet utan underlag, som KONTRAKT i test/insats.test.ts. */
const K = { system: 'hermes', kommando: 'beslutskoe --besvara', objekt: '#153' };
const UPPFOLJNING = '/uppfoljning';

// ---- AK 1 och AK 2: den rena härledningen ----------------------------------------------------------------

describe('D-2/Story 11.3 AK 1 och AK 2: den rena härledningen', () => {
  it('U1 (AK 1 och AK 2): harledHandlingskontrakt ger fall a–h och ändrar inte sitt indata', () => {
    // Konfigurationen är laddad och har lämnat adressen till arendeLank (src/config.ts).
    expect(config.VY_PUBLIK_URL).toBe(TEST_VY_PUBLIK_URL);
    const harled = insatsTjansten.harledHandlingskontrakt;
    const lank = arendeLank('LOC-503');
    const a = Object.freeze({ ...K, underlag: UPPFOLJNING });

    const obs = {
      a: harled(a, 'LOC-503'),
      b: harled(K, 'LOC-503'),
      c: harled({ ...K, underlag: UPPFOLJNING }, null),
      d: harled(K, null),
      e: harled({ ...K, underlag_harlett: true, underlag_lagrat: 'x' }, null),
      f: harled([], 'LOC-503'),
      g: harled('text', null),
      h: harled(null, 'LOC-503'),
    };
    expect(obs).toEqual({
      a: { ...K, underlag: lank, underlag_harlett: true, underlag_lagrat: UPPFOLJNING },
      b: { ...K, underlag: lank, underlag_harlett: true, underlag_lagrat: null },
      c: { ...K, underlag: UPPFOLJNING, underlag_harlett: false, underlag_lagrat: UPPFOLJNING },
      d: { ...K, underlag: null, underlag_harlett: false, underlag_lagrat: null },
      e: { ...K, underlag: null, underlag_harlett: false, underlag_lagrat: null },
      f: [],
      g: 'text',
      h: null,
    });

    // Indata i a är fryst och lika efter anropet, och svaret är ett nytt objekt.
    expect(a).toEqual({ ...K, underlag: UPPFOLJNING });
    expect(obs.a).not.toBe(a);
    // Den absoluta adressen: testmiljöns VY_PUBLIK_URL följd av sökvägen för LOC-503.
    expect((obs.a as { underlag: unknown }).underlag).toBe(TEST_VY_PUBLIK_URL + arendeSokvag('LOC-503'));

    // Kontroll: a och c skiljer sig bara i ärendet och ger olika underlag, så fallet kan slå ut.
    expect((obs.a as { underlag: unknown }).underlag).not.toBe((obs.c as { underlag: unknown }).underlag);
  });
});

// ---- Genom hela stacken ---------------------------------------------------------------------------------

const TITEL_503 = 'Underlagsprovet huvudärende';

let app: Express;
let hermes: string;
let david: string;
/** Fixturens tre ärenden, identifierare → id. */
const ARENDEN = new Map<string, string>();

/** Ett anrop som MÅSTE lyckas (som steg() i test/arendekort.test.ts), bundet till filens app. */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

/** Ärendets id ur fixturen. */
function arendeId(identifier: string): string {
  const id = ARENDEN.get(identifier);
  if (id === undefined) throw new Error(`${identifier} står inte i fixturen`);
  return id;
}

/** registrera_insats som insats() i test/djuplank.test.ts rad 245–257, med egen källa. */
function insats(stopp: string, objektId: string, extra: Record<string, unknown> = {}) {
  return {
    stopp_id: stopp,
    typ: 'agarbeslut',
    tillhor: 'agare',
    utfall: 'Riktningen är vald och arbetet kan fortsätta',
    begard_handling: 'Välj mellan A och B',
    blockeringsgrund: 'Tidigare besked avgör inte valet',
    handlingskontrakt: K,
    kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: objektId }],
    ...extra,
  };
}

/** Ägarrollen (postgres), som adminKlient() i test/insats.test.ts rad 249–253. */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/** Instrumentering (som i test/djuplank.test.ts rad 259–275): varje räknad fråga går vidare till riktig Postgres. */
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

/** md5 över varje rad i insatser för tenanten, som text (test/insats.test.ts rad 1303–1309). */
async function insatsavtryck(): Promise<string | null> {
  const { rows } = await pool.query<{ avtryck: string | null }>(
    `SELECT md5(string_agg(i::text, '|' ORDER BY i.id)) AS avtryck FROM insatser i WHERE i.tenant_id = $1`,
    [TENANT_ID],
  );
  return rows[0]?.avtryck ?? null;
}

/** Raden läst med ägarrollen: handlingskontraktet som text och md5 över hela raden. */
async function radenMedAgaren(id: string): Promise<{ kontrakt: string; md5: string }> {
  const agare = await adminKlient();
  try {
    const { rows } = await agare.query<{ kontrakt: string; md5: string }>(
      `SELECT r.handlingskontrakt::text AS kontrakt, md5(r::text) AS md5 FROM insatser r
        WHERE r.tenant_id = $1 AND r.id = $2`,
      [TENANT_ID, id],
    );
    const rad = rows[0];
    if (!rad) throw new Error(`insatsen ${id} saknas`);
    return rad;
  } finally {
    await agare.end();
  }
}

// Filnivån: det som de tre databasblocken delar. Varje block registrerar sina egna insatser.
beforeAll(async () => {
  app = createApp();
  const team = await seedaTeam();
  hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  // Som test/djuplank.test.ts rad 342: första create_issue blir LOC-503.
  await withTransaction((client) => sattSekvens(client, team.sekvensnamn, 502));
  for (const [title, vantat] of [
    [TITEL_503, 'LOC-503'],
    ['Underlagsprovet andra ärendet', 'LOC-504'],
    ['Underlagsprovet tredje ärendet', 'LOC-505'],
  ] as const) {
    const skapat = await steg(hermes, 'create_issue', { title, team_key: 'LOC' });
    expect(skapat.identifier).toBe(vantat);
    ARENDEN.set(vantat, skapat.id as string);
  }
});

// ---- AK 1–3: läsvägarna --------------------------------------------------------------------------------

describe('D-2/Story 11.3 AK 1–3: läsvägarna', () => {
  /** Insatserna A–F: ärendet (eller null) och det lagrade underlaget (eller null för inget). */
  const FIXTUR: [namn: string, identifier: string | null, underlag: string | null][] = [
    ['A', 'LOC-503', UPPFOLJNING],
    ['B', null, UPPFOLJNING],
    ['C', null, null],
    ['D', 'LOC-504', UPPFOLJNING],
    ['E', 'LOC-505', null],
    ['F', 'LOC-504', null],
  ];
  const id: Record<string, string> = {};
  const KALLA_A = { system: 'hermes', objekttyp: 'beslut', objekt_id: 'U2-A' };

  beforeAll(async () => {
    for (const [namn, identifier, underlag] of FIXTUR) {
      const svar = await steg(hermes, 'registrera_insats', insats(`U2:${namn}`, `U2-${namn}`, {
        handlingskontrakt: underlag === null ? K : { ...K, underlag },
        ...(identifier === null ? {} : { identifier }),
      }));
      id[namn] = svar.insats.id as string;
    }
  });

  it('U2 (AK 1 och AK 8): tre läsvägar härleder underlaget ur ärendet, och raden står orörd', async () => {
    // Motkontroll först: lank är ärendets adress sedan Story 11.2, grön före och efter koden.
    expect((await steg(hermes, 'get_insats', { id: id.A })).lank).toBe(arendeLank('LOC-503'));

    const fore = await radenMedAgaren(id.A!);
    const hamtad = await steg(hermes, 'get_insats', { id: id.A });
    const forKalla = await steg(hermes, 'insats_for_kalla', KALLA_A);
    const listan = (await steg(hermes, 'list_insatser', { inklusive_stangda: true })) as { id: string }[];
    const listad = listan.find((i) => i.id === id.A);
    const efter = await radenMedAgaren(id.A!);

    // De tre läsvägarna ger samma svar.
    expect(forKalla).toEqual(hamtad);
    expect(listad).toEqual(hamtad);
    // Underlaget är ärendets adress (fall a i U1), och ärendet står i svaret.
    expect(hamtad.handlingskontrakt).toEqual({
      ...K, underlag: arendeLank('LOC-503'), underlag_harlett: true, underlag_lagrat: UPPFOLJNING,
    });
    expect(hamtad.arende).toEqual({ identifier: 'LOC-503', titel: TITEL_503, lank: arendeLank('LOC-503') });
    // De inkopplade kolumnerna står aldrig kvar i svaret.
    for (const svar of [hamtad, forKalla, listad ?? {}]) {
      expect(Object.keys(svar).filter((n) => n.startsWith('arende_'))).toEqual([]);
    }

    // Raden: samma text och samma md5 före och efter läsningarna, och den lagrade texten är det skickade.
    expect(efter).toEqual(fore);
    expect(JSON.parse(fore.kontrakt)).toEqual({ ...K, underlag: UPPFOLJNING });
  });

  it('U3 (AK 1 och AK 8): ärendet läses i insatsfrågan, så frågorna är 2, 2 och 3', async () => {
    const obs = await withTransaction(async (client) => {
      const hamta = raknandeKlient(client);
      await insatsTjansten.hamtaInsats(hamta.klient, TENANT_ID, id.A!);
      const lista = raknandeKlient(client);
      const listan = await insatsTjansten.listaInsatser(lista.klient, TENANT_ID, { inklusive_stangda: true });
      const kalla = raknandeKlient(client);
      await insatsTjansten.insatsForKalla(kalla.klient, TENANT_ID, KALLA_A);
      const fragor = { hamtaInsats: hamta.antal(), listaInsatser: lista.antal(), insatsForKalla: kalla.antal() };
      return { fragor, listan };
    });
    expect(obs.fragor).toEqual({ hamtaInsats: 2, listaInsatser: 2, insatsForKalla: 3 });

    // Kontroll: listan bär A–F, fyra på tre olika ärenden och två utan ärende. Med en separat ärendefråga
    // (Story 11.2) hade listan gett 3 frågor, så räkningen kan slå ut.
    const fixturen = obs.listan.filter((i) => Object.values(id).includes(i.id));
    expect(fixturen.map((i) => i.id).sort()).toEqual(Object.values(id).sort());
    const arenden = fixturen.map((i) => (i as { arende?: { identifier: string } | null }).arende);
    expect(new Set(arenden.flatMap((a) => (a ? [a.identifier] : []))))
      .toEqual(new Set(['LOC-503', 'LOC-504', 'LOC-505']));
    expect(arenden.filter((a) => a)).toHaveLength(4);
    expect(arenden.filter((a) => a === null)).toHaveLength(2);
  });

  it('U4 (AK 2): en insats utan ärende bär det lagrade underlaget, underlag_harlett false och arende null', async () => {
    const b = await steg(hermes, 'get_insats', { id: id.B });
    const c = await steg(hermes, 'get_insats', { id: id.C });
    expect({ handlingskontrakt: b.handlingskontrakt, arende: b.arende, lank: b.lank }).toEqual({
      handlingskontrakt: { ...K, underlag: UPPFOLJNING, underlag_harlett: false, underlag_lagrat: UPPFOLJNING },
      arende: null,
      lank: null,
    });
    // Utan underlag: null, aldrig en påhittad adress.
    expect({ handlingskontrakt: c.handlingskontrakt, arende: c.arende, lank: c.lank }).toEqual({
      handlingskontrakt: { ...K, underlag: null, underlag_harlett: false, underlag_lagrat: null },
      arende: null,
      lank: null,
    });
    expect(Object.keys(b)).toContain('arende');
    expect(Object.keys(c)).toContain('arende');
  });

  it('U5 (AK 3): händelseraden besvarade_insats bär samma härledda kontrakt som get_insats', async () => {
    await steg(david, 'besvara_insats', { id: id.D, svar: 'U5 ja, kör A' });
    const { rows } = await pool.query<{ payload: { handlingskontrakt?: unknown } }>(
      `SELECT payload FROM events WHERE verb = 'besvarade_insats' AND payload->>'insats_id' = $1`,
      [id.D],
    );
    expect(rows).toHaveLength(1);
    const hamtad = await steg(hermes, 'get_insats', { id: id.D });
    expect(rows[0]!.payload.handlingskontrakt).toEqual(hamtad.handlingskontrakt);
    expect(hamtad.handlingskontrakt).toEqual({
      ...K, underlag: arendeLank('LOC-504'), underlag_harlett: true, underlag_lagrat: UPPFOLJNING,
    });
  });
});

// ---- AK 6: registreringen är oförändrad ------------------------------------------------------------------

describe('D-2/Story 11.3 AK 6: registreringen sparar kontraktet som det skickades', () => {
  it('U6 (AK 6) (R): ett kontrakt med underlag på ett ärende står i raden exakt som det skickades', async () => {
    const skickat = { ...K, underlag: UPPFOLJNING };
    const med = await steg(hermes, 'registrera_insats', insats('U6:med', 'U6-med', {
      identifier: 'LOC-503', handlingskontrakt: skickat,
    }));
    const raden = JSON.parse((await radenMedAgaren(med.insats.id as string)).kontrakt) as Record<string, unknown>;
    expect(raden).toEqual(skickat);
    expect(Object.keys(raden)).toHaveLength(4);

    // Kontroll: utan underlag har raden ingen nyckel underlag, så likheten är exakt och ingen delmängd.
    const utan = await steg(hermes, 'registrera_insats', insats('U6:utan', 'U6-utan', { identifier: 'LOC-503' }));
    const radenUtan = JSON.parse((await radenMedAgaren(utan.insats.id as string)).kontrakt) as Record<string, unknown>;
    expect(radenUtan).toEqual(K);
    expect(Object.hasOwn(radenUtan, 'underlag')).toBe(false);
  });
});

// ---- AK 4: koppla en insats till sitt ärende -------------------------------------------------------------

const INSATS_TS = new URL('../src/services/insats.ts', import.meta.url);
const KOPPLINGENS_BORJAN = 'export async function kopplaInsatsTillArende(';

/** Texten utan kommentarsrader (som utanKommentarsrader63 i test/insats.test.ts). */
function utanKommentarsrader(text: string): string {
  return text
    .split('\n')
    .filter((rad) => !/^\s*(\/\/|\/\*|\*)/.test(rad))
    .join('\n');
}

/**
 * Funktionskroppen från `borjan` till nästa rad som börjar med `export ` eller filens slut, utan
 * kommentarsrader och med varje följd av blanktecken ihopslagen till ett blanksteg (som kroppen63 i
 * test/insats.test.ts). Tom när funktionen saknas.
 */
function kroppen(kalltext: string, borjan: string): string {
  const start = kalltext.indexOf(borjan);
  if (start === -1) return '';
  const nasta = kalltext.indexOf('\nexport ', start);
  return utanKommentarsrader(kalltext.slice(start, nasta === -1 ? undefined : nasta)).replace(/\s+/g, ' ');
}

/** U7:s statiska led: ett las(-anrop med true som sista argument står före UPDATE insatser. */
function lasetForeSkrivningen(kropp: string): boolean {
  const laset = /\blas\([^()]*,\s*true\s*\)/.exec(kropp);
  const skrivningen = kropp.indexOf('UPDATE insatser');
  return laset !== null && skrivningen !== -1 && laset.index < skrivningen;
}

/** Kontrollen för det statiska ledet: skrivningen står före den låsande läsningen. */
const SKRIVNING_FORE_LASET = [
  'export async function kopplaInsatsTillArende(client, tenantId, input) {',
  "  await client.query('UPDATE insatser SET issue_id = $3 WHERE tenant_id = $1 AND id = $2',",
  '    [tenantId, input.id, input.issue_id]);',
  '  return { insats: await las(client, tenantId, input.id, true), andrad: true };',
  '}',
].join('\n');

/** Det som ett anrop kan ändra: raderna i events och insatser, och avtrycket av insatser. */
async function lage(): Promise<{ events: number; insatser: number; avtryck: string | null }> {
  return {
    events: await raknaRader('events'),
    insatser: await raknaRader('insatser'),
    avtryck: await insatsavtryck(),
  };
}

/** Den senast skrivna händelseraden. */
async function senasteHandelse(): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query(
    'SELECT verb, issue_id, payload, aktor_typ, aktor_namn FROM events ORDER BY id DESC LIMIT 1',
  );
  return rows[0];
}

describe('D-2/Story 11.3 AK 4: koppla en insats till sitt ärende', () => {
  const id: Record<string, string> = {};

  beforeAll(async () => {
    // X och Y har inget ärende, och var sin källa och sitt stopp.
    for (const namn of ['X', 'Y']) {
      const svar = await steg(hermes, 'registrera_insats', insats(`U7:${namn}`, `U7-${namn}`, {
        handlingskontrakt: { ...K, underlag: UPPFOLJNING },
      }));
      id[namn] = svar.insats.id as string;
    }
  });

  const koppla = (insatsId: string, identifier: string) =>
    kor(app, hermes, 'koppla_insats_till_arende', { id: insatsId, identifier });

  it('U7 (AK 4): fem fall med radräkning, och kopplingen läser insatsen under radlås före skrivningen', async () => {
    const payload = { insats_id: id.X, identifier: 'LOC-503' };

    // 1. Första kopplingen: X utan ärende till LOC-503.
    const fore1 = await lage();
    const forsta = await koppla(id.X!, 'LOC-503');
    expect([forsta.status, forsta.body.result?.andrad], JSON.stringify(forsta.body)).toEqual([200, true]);
    const kopplad = forsta.body.result.insats;
    expect({
      issue_id: kopplad.issue_id,
      arende: kopplad.arende?.identifier,
      underlag: kopplad.handlingskontrakt?.underlag,
      harlett: kopplad.handlingskontrakt?.underlag_harlett,
    }).toEqual({
      issue_id: arendeId('LOC-503'), arende: 'LOC-503', underlag: arendeLank('LOC-503'), harlett: true,
    });
    const efter1 = await lage();
    expect({ events: efter1.events, insatser: efter1.insatser })
      .toEqual({ events: fore1.events + 1, insatser: fore1.insatser });
    expect(efter1.avtryck).not.toBe(fore1.avtryck);
    expect(await senasteHandelse()).toEqual({
      verb: 'kopplade_insats_till_arende', issue_id: arendeId('LOC-503'), payload,
      aktor_typ: 'agent', aktor_namn: 'hermes',
    });

    // 2. Samma anrop igen: no-op med eget namn och samma payload, och raden står orörd.
    const fore2 = await lage();
    const igen = await koppla(id.X!, 'LOC-503');
    expect([igen.status, igen.body.result?.andrad], JSON.stringify(igen.body)).toEqual([200, false]);
    expect(await lage()).toEqual({ ...fore2, events: fore2.events + 1 });
    expect(await senasteHandelse()).toEqual({
      verb: 'insatsen_var_redan_kopplad', issue_id: arendeId('LOC-503'), payload,
      aktor_typ: 'agent', aktor_namn: 'hermes',
    });

    // 3. Ett annat ärende: en insats flyttas aldrig i tysthet.
    const fore3 = await lage();
    const annat = await koppla(id.X!, 'LOC-504');
    expect([annat.status, annat.body.error]).toEqual([400, 'insatsen_hor_till_annat_arende']);
    expect(await lage()).toEqual(fore3);

    // 4. Ett okänt ärende: Y står kvar utan ärende.
    const fore4 = await lage();
    const okantArende = await koppla(id.Y!, 'LOC-99999');
    expect([okantArende.status, okantArende.body.error]).toEqual([404, 'not_found']);
    expect(await lage()).toEqual(fore4);
    expect((await steg(hermes, 'get_insats', { id: id.Y })).issue_id).toBeNull();

    // 5. En okänd insats.
    const fore5 = await lage();
    const okandInsats = await koppla(randomUUID(), 'LOC-503');
    expect([okandInsats.status, okandInsats.body.error]).toEqual([404, 'not_found']);
    expect(await lage()).toEqual(fore5);

    // Statiskt: i kroppen för kopplaInsatsTillArende står den låsande läsningen före skrivningen.
    const kropp = kroppen(readFileSync(INSATS_TS, 'utf8'), KOPPLINGENS_BORJAN);
    expect(kropp).not.toBe('');
    expect(lasetForeSkrivningen(kropp)).toBe(true);
    // Kontroll: samma regel fäller en påhittad kropp där skrivningen står före låset.
    expect(lasetForeSkrivningen(kroppen(SKRIVNING_FORE_LASET, KOPPLINGENS_BORJAN))).toBe(false);
  });

  it('U8 (AK 4): de två verben har sina svenska texter ordagrant', () => {
    expect({
      kopplade_insats_till_arende: VERB.kopplade_insats_till_arende,
      insatsen_var_redan_kopplad: VERB.insatsen_var_redan_kopplad,
    }).toEqual({
      kopplade_insats_till_arende: 'kopplade en insats till ärendet',
      insatsen_var_redan_kopplad: 'insatsen var redan kopplad till ärendet',
    });
  });
});

// ---- AK 3 och AK 4: skrivningar som väntat på radlåset ---------------------------------------------------

const vanta = (ms: number): Promise<void> => new Promise((klar) => setTimeout(klar, ms));

/**
 * Väntar tills någon backend i testdatabasen står och väntar på ett lås (som i test/samtidighet.test.ts). Anropas
 * med en EGEN anslutning utan öppen transaktion: pg_stat_activity läses som en ögonblicksbild per transaktion, så
 * den klient som håller låset ser aldrig att någon börjat vänta.
 */
async function vantaTillsNagonVantarPaLas(vakt: pg.Client, tidsgransMs = 5_000): Promise<void> {
  const slut = Date.now() + tidsgransMs;
  while (Date.now() < slut) {
    const { rows } = await vakt.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0`,
    );
    if ((rows[0]?.n ?? 0) > 0) return;
    await vanta(25);
  }
  throw new Error('ingen transaktion väntade på låset inom tidsgränsen');
}

type Koppling = Awaited<ReturnType<typeof insatsTjansten.kopplaInsatsTillArende>>;

/**
 * Mönstret "okommitterad ändring hos en annan transaktion" (test/samtidighet.test.ts), med en koppling som
 * ändringen. Insatsen kopplas till `identifier` i en transaktion som hålls öppen och håller insatsens radlås.
 * `anrop` startas och ska fastna på låset, kopplingen committas, och båda svaren returneras. Anropets första
 * ögonblicksbild är alltså tagen före kopplingen, och det som anropet svarar med efter väntan är det som provas.
 */
async function medOkommitteradKoppling<T>(
  insatsId: string,
  identifier: string,
  anrop: () => PromiseLike<T>,
): Promise<{ forsta: Koppling; andra: T }> {
  const vakt = await adminKlient();
  let slapp!: () => void;
  const halls = new Promise<void>((r) => {
    slapp = r;
  });
  let markeraKopplad!: (svar: Koppling) => void;
  const kopplad = new Promise<Koppling>((r) => {
    markeraKopplad = r;
  });
  const tx = withTransaction(async (client) => {
    markeraKopplad(
      await insatsTjansten.kopplaInsatsTillArende(client, TENANT_ID, { id: insatsId, issue_id: arendeId(identifier) }),
    );
    await halls;
  });
  try {
    // Kastar kopplingen syns felet direkt och inte som en tidsgräns.
    const forsta = await Promise.race([kopplad, tx.then(() => kopplad)]);
    // Promise.resolve anropar .then(), och det är då en supertest-Test skickas.
    const pagaende = Promise.resolve(anrop());
    // Fäller provet innan anropet är besvarat ska dess fel inte bli ett ohanterat löfte.
    pagaende.catch(() => undefined);
    await vantaTillsNagonVantarPaLas(vakt);
    slapp();
    await tx;
    return { forsta, andra: await pagaende };
  } finally {
    slapp();
    await tx.catch(() => undefined);
    await vakt.end();
  }
}

/** Insatsens händelserader med verbet, i insättningsordning (events.id). */
async function handelserFor(
  insatsId: string,
  verb: string,
): Promise<{ issue_id: string | null; payload: Record<string, unknown> }[]> {
  const { rows } = await pool.query<{ issue_id: string | null; payload: Record<string, unknown> }>(
    `SELECT issue_id, payload FROM events WHERE verb = $1 AND payload->>'insats_id' = $2 ORDER BY id`,
    [verb, insatsId],
  );
  return rows;
}

/**
 * Instrumentering som raknandeKlient: varje fråga går vidare till riktig Postgres, och före kopplingens UPDATE körs
 * `skrivning` på samma anslutning, alltså i samma transaktion och förbi radlåset. Den står för en skrivning som
 * vakten i UPDATE (issue_id IS NULL) ska fälla.
 */
function medSkrivningForeKopplingen(
  client: PoolClient,
  skrivning: (riktig: PoolClient) => Promise<unknown>,
): PoolClient {
  return new Proxy(client, {
    get(mal, namn) {
      const varde: unknown = Reflect.get(mal, namn, mal);
      if (namn === 'query' && typeof varde === 'function') {
        return async (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes('UPDATE insatser SET issue_id')) await skrivning(mal);
          return (varde as (...a: unknown[]) => unknown).apply(mal, args);
        };
      }
      return typeof varde === 'function' ? (varde as (...a: unknown[]) => unknown).bind(mal) : varde;
    },
  });
}

describe('D-2/Story 11.3 AK 3 och AK 4: en skrivning som väntat på radlåset svarar med ärendet som det är committat', () => {
  const id: Record<string, string> = {};
  /** Registreringen av en insats utan ärende med «/uppfoljning», eget stopp och egen källa. */
  const grund = (fall: string, namn: string) =>
    insats(`${fall}:${namn}`, `${fall}-${namn}`, { handlingskontrakt: { ...K, underlag: UPPFOLJNING } });

  beforeAll(async () => {
    for (const [fall, namn] of [
      ['U12', 'samma'],
      ['U12', 'annat'],
      ['U12', 'besvara'],
      ['U12', 'skjut'],
      ['U12', 'aterkalla'],
      ['U12', 'registrera'],
      ['U12', 'kontroll'],
      ['U13', 'vakt'],
    ] as const) {
      const svar = await steg(hermes, 'registrera_insats', grund(fall, namn));
      id[namn] = svar.insats.id as string;
    }
  });

  it('U12 (AK 3 och AK 4): varje skrivväg som väntat på en samtidig koppling svarar med ärendet och det härledda underlaget', async () => {
    const lank = arendeLank('LOC-503');
    const arende = { identifier: 'LOC-503', titel: TITEL_503, lank };
    const harlett = { ...K, underlag: lank, underlag_harlett: true, underlag_lagrat: UPPFOLJNING };

    // Skrivvägarna som läser insatsen under radlås: verbet var och en skriver, anropet och fälten bredvid insatsen.
    const vagar: [
      namn: string,
      verb: string,
      anrop: (insatsId: string) => ReturnType<typeof kor>,
      falt: Record<string, unknown>,
    ][] = [
      ['samma', 'insatsen_var_redan_kopplad',
        (i) => kor(app, hermes, 'koppla_insats_till_arende', { id: i, identifier: 'LOC-503' }), { andrad: false }],
      ['besvara', 'besvarade_insats', (i) => kor(app, david, 'besvara_insats', { id: i, svar: 'U12 ja, kör A' }), {}],
      ['skjut', 'skot_upp_insats',
        (i) => kor(app, david, 'skjut_upp_insats', { id: i, till: '2030-01-01T09:00:00Z', skal: 'U12 senare' }), {}],
      ['aterkalla', 'aterkallade_insats',
        (i) => kor(app, hermes, 'aterkalla_insats', { id: i, skal: 'U12 inte aktuell' }), {}],
      ['registrera', 'insatsen_fanns_redan',
        () => kor(app, hermes, 'registrera_insats', grund('U12', 'registrera')), { nyskapad: false, krockar: [] }],
    ];
    for (const [namn, verb, anrop, falt] of vagar) {
      const insatsId = id[namn]!;
      const { forsta, andra } = await medOkommitteradKoppling(insatsId, 'LOC-503', () => anrop(insatsId));
      // Den första kopplingen ändrade insatsen och bär ärendet.
      expect([forsta.andrad, forsta.insats.arende], namn).toEqual([true, arende]);
      expect(andra.status, `${namn}: ${JSON.stringify(andra.body)}`).toBe(200);
      expect(andra.body.result, namn).toMatchObject(falt);
      // Kopplingen och registreringen svarar { insats, … }, de övriga med insatsen själv.
      const svaret = andra.body.result.insats ?? andra.body.result;
      expect({ arende: svaret.arende, lank: svaret.lank, handlingskontrakt: svaret.handlingskontrakt }, namn)
        .toEqual({ arende, lank, handlingskontrakt: harlett });
      // Svaret är insatsen som den står efteråt, och händelseraden står på ärendet.
      expect(svaret, namn).toEqual(await steg(hermes, 'get_insats', { id: insatsId }));
      const handelser = await handelserFor(insatsId, verb);
      expect(handelser.map((h) => h.issue_id), namn).toEqual([arendeId('LOC-503')]);
      // AK 3: händelseraden besvarade_insats bär samma härledda kontrakt som svaret.
      if (verb === 'besvarade_insats') expect(handelser[0]?.payload.handlingskontrakt, namn).toEqual(harlett);
    }

    // Ett annat ärende medan kopplingen till LOC-503 väntar: den andra ser den förstas issue_id och avvisas, och
    // insatsen flyttas inte.
    const annat = await medOkommitteradKoppling(id.annat!, 'LOC-503', () =>
      kor(app, hermes, 'koppla_insats_till_arende', { id: id.annat, identifier: 'LOC-504' }));
    expect([annat.forsta.andrad, annat.andra.status, annat.andra.body.error])
      .toEqual([true, 400, 'insatsen_hor_till_annat_arende']);
    expect((await steg(hermes, 'get_insats', { id: id.annat })).arende).toEqual(arende);
    expect([
      ...(await handelserFor(id.annat!, 'kopplade_insats_till_arende')),
      ...(await handelserFor(id.annat!, 'insatsen_var_redan_kopplad')),
    ]).toEqual([]);

    // Kontroll: i samma kapplöpning ger EN låsande sats med joinen insatsens nya issue_id men ärendet ur den gamla
    // ögonblicksbilden (B-01 i src/services/arenden.ts). Fällan finns alltså i provet, och svaren ovan är rätta
    // därför att insatsen läses efter låset.
    const fallan = await medOkommitteradKoppling(id.kontroll!, 'LOC-503', () =>
      withTransaction(async (c) => {
        const { rows } = await c.query(
          `SELECT ins.issue_id, t.key || '-' || i.sequence_number AS arende_identifier
             FROM insatser ins
             LEFT JOIN issues i ON i.id = ins.issue_id AND i.tenant_id = ins.tenant_id
             LEFT JOIN teams t ON t.id = i.team_id AND t.tenant_id = i.tenant_id
            WHERE ins.tenant_id = $1 AND ins.id = $2 FOR UPDATE OF ins`,
          [TENANT_ID, id.kontroll],
        );
        return rows[0];
      }));
    expect(fallan.andra).toEqual({ issue_id: arendeId('LOC-503'), arende_identifier: null });
  });

  it('U13 (AK 4): en koppling som vakten i UPDATE fäller kastar och svarar aldrig andrad: true', async () => {
    const insatsId = id.vakt!;
    const fore = await lage();
    /** Kopplingen till LOC-503 i en egen transaktion, med `skrivning` mellan radlåset och UPDATE. */
    const koppla = (skrivning: (riktig: PoolClient) => Promise<unknown>) =>
      withTransaction((c) =>
        insatsTjansten.kopplaInsatsTillArende(medSkrivningForeKopplingen(c, skrivning), TENANT_ID, {
          id: insatsId,
          issue_id: arendeId('LOC-503'),
        }));

    // Raden får ett ärende förbi radlåset, ett annat eller samma, och vakten träffar då ingen rad.
    for (const identifier of ['LOC-504', 'LOC-503']) {
      let skrivna = 0;
      await expect(
        koppla(async (riktig) => {
          skrivna += 1;
          await riktig.query('UPDATE insatser SET issue_id = $3 WHERE tenant_id = $1 AND id = $2', [
            TENANT_ID,
            insatsId,
            arendeId(identifier),
          ]);
        }),
        identifier,
      ).rejects.toThrow('radlåset');
      expect(skrivna, identifier).toBe(1);
      // Transaktionen är tillbakarullad: raderna, händelserna och avtrycket står som före.
      expect(await lage(), identifier).toEqual(fore);
    }

    // Kontroll: samma instrumentering med en skrivning som lämnar issue_id orört ger kopplingen, så det är vakten och
    // inte instrumenteringen som fäller fallen ovan.
    let skrivna = 0;
    const svar = await koppla(async (riktig) => {
      skrivna += 1;
      await riktig.query('UPDATE insatser SET uppdaterad = now() WHERE tenant_id = $1 AND id = $2', [
        TENANT_ID,
        insatsId,
      ]);
    });
    expect([skrivna, svar.andrad, svar.insats.arende?.identifier]).toEqual([1, true, 'LOC-503']);
  });
});

// ---- AK 5: mätningen före rättningen ---------------------------------------------------------------------

const ROT = fileURLToPath(new URL('../', import.meta.url));
const SKRIPTET = 'src/scripts/matInsatsunderlag.ts';
const korProcess = promisify(execFile);

/** Mätningens fyra grupper, i tabellens ordning (Dev Notes → Mätningen). */
const GRUPPERNA = ['arende_uppfoljning', 'arende_eget', 'arendekalla', 'utan_arende'] as const;

interface Matning {
  arende_uppfoljning: string[];
  arende_eget: string[];
  arendekalla: { id: string; arenden: string[] }[];
  utan_arende: string[];
}

/** Mätningen begränsad till `idn`, med gruppernas ordning orörd. */
function bara(matning: Matning, idn: string[]): Matning {
  const med = (id: string) => idn.includes(id);
  return {
    arende_uppfoljning: matning.arende_uppfoljning.filter(med),
    arende_eget: matning.arende_eget.filter(med),
    arendekalla: matning.arendekalla.filter((k) => med(k.id)),
    utan_arende: matning.utan_arende.filter(med),
  };
}

/** Varje id i mätningen, grupp för grupp. */
function allaIdn(matning: Matning): string[] {
  return [
    ...matning.arende_uppfoljning,
    ...matning.arende_eget,
    ...matning.arendekalla.map((k) => k.id),
    ...matning.utan_arende,
  ];
}

/** Antalet rader i insatser för tenanten. */
async function insatserITenanten(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM insatser WHERE tenant_id = $1',
    [TENANT_ID],
  );
  return rows[0]?.n ?? -1;
}

/**
 * Mätskriptet som barnprocess i repots rot, efter korInsatsmatningen() i test/insats.test.ts rad 1320–1343.
 * Barnprocessen ärver testmiljöns DATABASE_URL, rollen app mot testdatabasen. DOTENV_CONFIG_PATH pekar på
 * en fil som inte finns, så att ingen .env kan rikta skriptet mot en annan databas. En avslutningskod kastar inte.
 */
async function korMatningen(
  env: Record<string, string> = {},
): Promise<{ kod: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await korProcess(path.join(ROT, 'node_modules', '.bin', 'tsx'), [SKRIPTET], {
      cwd: ROT,
      env: {
        ...process.env,
        DOTENV_CONFIG_PATH: path.join(tmpdir(), 'insats-underlag-finns-inte.env'),
        ...env,
      },
      timeout: 20_000,
    });
    return { kod: 0, stdout, stderr };
  } catch (e) {
    const fel = e as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof fel.code !== 'number') throw e;
    return { kod: fel.code, stdout: fel.stdout ?? '', stderr: fel.stderr ?? '' };
  }
}

describe('D-2/Story 11.3 AK 5: mätningen före rättningen', () => {
  const g: Record<string, string> = {};
  /** Ärendekällorna: systemet arenden och objekttypen arende, som ingen annan fixtur i filen använder. */
  const arendekalla = (objektId: string) => ({ system: 'arenden', objekttyp: 'arende', objekt_id: objektId });

  beforeAll(async () => {
    const fixtur: [namn: string, extra: Record<string, unknown>][] = [
      ['G1', { identifier: 'LOC-503', handlingskontrakt: { ...K, underlag: UPPFOLJNING } }],
      ['G2', { identifier: 'LOC-504', handlingskontrakt: { ...K, underlag: 'beslut #153 i beslutskön' } }],
      ['G3', { kallor: [arendekalla('LOC-503'), arendekalla('loc-503')] }],
      ['G4', { kallor: [arendekalla('LOC-99999')] }],
    ];
    for (const [namn, extra] of fixtur) {
      const svar = await steg(hermes, 'registrera_insats', insats(`U9:${namn}`, `U9-${namn}`, extra));
      expect(svar.krockar).toEqual([]);
      g[namn] = svar.insats.id as string;
    }
  });

  const fixturensIdn = () => ['G1', 'G2', 'G3', 'G4'].map((namn) => g[namn]!);

  it('U9 (AK 5): varje insats står i exakt en av fyra grupper, och ärendekällan pekar ut sitt ärende', async () => {
    const matning: Matning = await withTransaction((c) => insatsTjansten.matInsatsunderlag(c, TENANT_ID));
    expect(bara(matning, fixturensIdn())).toEqual({
      arende_uppfoljning: [g.G1],
      arende_eget: [g.G2],
      // loc-503 är inte ärendets identifierare tecken för tecken och räknas inte; LOC-99999 finns inte.
      arendekalla: [{ id: g.G3, arenden: ['LOC-503'] }],
      utan_arende: [g.G4],
    });

    // Kontroll av partitionen: varje insats i tenanten står i exakt en grupp.
    const idn = allaIdn(matning);
    expect(idn.length).toBe(await insatserITenanten());
    expect(new Set(idn).size).toBe(idn.length);
  });

  it('U10 (AK 5): mätningen i en READ ONLY-transaktion skriver ingenting, och dess kropp bara läser', async () => {
    const fore = await lage();
    const utan: Matning = await withTransaction((c) => insatsTjansten.matInsatsunderlag(c, TENANT_ID));
    const med: Matning = await withTransaction(async (c) => {
      await c.query('SET TRANSACTION READ ONLY');
      return insatsTjansten.matInsatsunderlag(c, TENANT_ID);
    });
    expect(med).toEqual(utan);
    // raknaRader('events'), raknaRader('insatser') och insatsavtrycket är oförändrade.
    expect(await lage()).toEqual(fore);

    // Kontrollen: en skrivning i en likadan transaktion fälls av Postgres, så det är transaktionen som hindrar den.
    await expect(
      withTransaction(async (c) => {
        await c.query('SET TRANSACTION READ ONLY');
        await c.query('UPDATE insatser SET uppdaterad = uppdaterad WHERE false');
      }),
    ).rejects.toMatchObject({ code: '25006' });

    // Statiskt: kroppen till nästa export eller filens slut har inget av de tre skrivorden som hela ord.
    const kropp = kroppen(readFileSync(INSATS_TS, 'utf8'), 'export async function matInsatsunderlag(');
    expect(kropp).not.toBe('');
    expect(kropp.match(/\b(?:INSERT|UPDATE|DELETE)\b/g)).toBeNull();
  });

  it('U11 (AK 5): skriptet skriver en rad per insats och gruppernas antal, och ingenting i databasen', async () => {
    const hela: Matning = await withTransaction((c) => insatsTjansten.matInsatsunderlag(c, TENANT_ID));
    const fore = { events: await raknaRader('events'), avtryck: await insatsavtryck() };
    const { kod, stdout, stderr } = await korMatningen();
    expect(kod, stderr).toBe(0);

    const rader = stdout.split('\n');
    expect(rader.pop()).toBe('');
    const summa = allaIdn(hela).length;
    // Sist de fyra antalen i tabellens ordning, också när ett antal är 0, och summan.
    expect(rader.slice(-5)).toEqual([
      ...GRUPPERNA.map((grupp) => `${grupp}: ${hela[grupp].length}`),
      `Antal: ${summa}`,
    ]);
    // Dessförinnan en rad per insats, grupperna i tabellens ordning.
    expect(rader.slice(0, -5)).toEqual([
      ...hela.arende_uppfoljning.map((id) => `arende_uppfoljning\t${id}`),
      ...hela.arende_eget.map((id) => `arende_eget\t${id}`),
      ...hela.arendekalla.map((k) => `arendekalla\t${k.id}\t${k.arenden.join(',')}`),
      ...hela.utan_arende.map((id) => `utan_arende\t${id}`),
    ]);
    // Fixturens fyra rader står exakt som i Dev Notes → Mätningen.
    expect(rader.filter((r) => fixturensIdn().includes(r.split('\t')[1] ?? ''))).toEqual([
      `arende_uppfoljning\t${g.G1}`,
      `arende_eget\t${g.G2}`,
      `arendekalla\t${g.G3}\tLOC-503`,
      `utan_arende\t${g.G4}`,
    ]);
    expect({ events: await raknaRader('events'), avtryck: await insatsavtryck() }).toEqual(fore);

    // Statiskt: transaktionen börjar med SET TRANSACTION READ ONLY, en gång och på en kodrad.
    const skript = utanKommentarsrader(readFileSync(path.join(ROT, SKRIPTET), 'utf8'));
    expect(skript.split('SET TRANSACTION READ ONLY').length - 1).toBe(1);

    // Kontroll: en mätning som inte kunde göras ser aldrig ut som noll insatser.
    const finnsInte = new URL(process.env.DATABASE_URL!);
    finnsInte.pathname = '/arenden_finns_inte';
    const fel = await korMatningen({ DATABASE_URL: finnsInte.toString() });
    expect(fel.kod, fel.stderr).toBe(1);
    expect(fel.stderr).toMatch(/^FATAL:/);
    expect(fel.stdout).not.toContain('Antal:');
  });
});
