import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// Insatsen: EN kö, inte fem. Spec: Astra 2026-09-09 §4.
//
// David skickade två skärmbilder med två olika köer som båda krävde hans svar
// och sa: "Dessa ska vara samlade." Astras varning i samma andetag: "Om
// sammanställningen bara gör dem till likadana kort har vi byggt en ny inkorg
// ovanpå de gamla."
//
// Provet finns för att de två felen ska vara OMÖJLIGA, inte avrådda:
// samma stopp får inte bli två insatser, och en agentnyckel får inte kunna
// bokföras som Davids svar.

const KONTRAKT = { system: 'hermes', kommando: 'beslutskoe --besvara', objekt: '#153' };
// Alltid i framtiden, räknat från klockan när provet körs — ett fast datum passerar.
const SEN = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

function grund(stopp: string, extra: Record<string, unknown> = {}) {
  return {
    stopp_id: stopp,
    typ: 'agarbeslut',
    tillhor: 'agare',
    utfall: 'Riktningen är vald och arbetet kan fortsätta',
    begard_handling: 'Välj mellan A och B',
    blockeringsgrund: 'Tidigare besked avgör inte valet',
    handlingskontrakt: KONTRAKT,
    kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '153' }],
    ...extra,
  };
}

describe('insatsen: en kö, inte fem', () => {
  let app: Express;
  let hermes: string;
  let david: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  // ---- 1. samma fråga från fyra håll blir EN insats ----------------------
  it('fyra källor som beskriver samma stopp ger EN insats, inte fyra kort', async () => {
    const a = await kor(app, hermes, 'registrera_insats', grund('beslut:200'));
    expect(a.status).toBe(200);
    expect(a.body.result.nyskapad).toBe(true);

    // Samma stopp, nu med löftet och briefraden som ytterligare källor.
    const b = await kor(app, hermes, 'registrera_insats', {
      ...grund('beslut:200'),
      kallor: [
        { system: 'hermes', objekttyp: 'beslut', objekt_id: '153' },
        { system: 'redovisning', objekttyp: 'commitment', objekt_id: 'c-1' },
        { system: 'hermes', objekttyp: 'briefpunkt', objekt_id: '2026-09-09:rad3' },
      ],
    });
    expect(b.status).toBe(200);
    expect(b.body.result.nyskapad).toBe(false);
    expect(b.body.result.insats.id).toBe(a.body.result.insats.id);
    expect(b.body.result.insats.kallor).toHaveLength(3);
    expect(b.body.result.krockar).toEqual([]);

    // Och kön innehåller den EN gång.
    const ko = await kor(app, hermes, 'list_insatser', {});
    const traffar = ko.body.result.filter(
      (i: { stopp_id: string }) => i.stopp_id === 'beslut:200',
    );
    expect(traffar).toHaveLength(1);
  });

  // ---- 2. en källa kan inte tillhöra två insatser ------------------------
  it('en källa som redan hör till en annan insats flyttas ALDRIG i tysthet', async () => {
    const forsta = await kor(app, hermes, 'registrera_insats', {
      ...grund('beslut:201'),
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '201' }],
    });
    expect(forsta.body.result.nyskapad).toBe(true);

    // Ett annat stopp gör anspråk på SAMMA källa.
    const andra = await kor(app, hermes, 'registrera_insats', {
      ...grund('lofte:201'),
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '201' }],
    });
    expect(andra.status).toBe(200);
    expect(andra.body.result.krockar).toHaveLength(1);
    expect(andra.body.result.insats.kallor).toHaveLength(0);

    // Uppslagningen pekar fortfarande på den FÖRSTA insatsen.
    const upp = await kor(app, hermes, 'insats_for_kalla', {
      system: 'hermes', objekttyp: 'beslut', objekt_id: '201',
    });
    expect(upp.body.result.id).toBe(forsta.body.result.insats.id);
  });

  // ---- 3. ett svar kräver en människa -----------------------------------
  it('en agentnyckel kan inte bokföras som Davids svar', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:202', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '202' }],
    }));
    const id = i.body.result.insats.id;

    const agent = await kor(app, hermes, 'besvara_insats', { id, svar: 'ja' });
    expect(agent.status).toBe(403);
    expect(agent.body.error).toBe('kraver_manniska');

    const manniska = await kor(app, david, 'besvara_insats', { id, svar: 'ja, kör A' });
    expect(manniska.status).toBe(200);
    expect(manniska.body.result.lage).toBe('svar_mottaget');
    expect(manniska.body.result.svar_aktor).toBe('david');
    expect(manniska.body.result.svar_nar).not.toBeNull();
  });

  it('samma insats kan inte besvaras två gånger', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:203', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '203' }],
    }));
    const id = i.body.result.insats.id;
    await kor(app, david, 'besvara_insats', { id, svar: 'ja' });
    const igen = await kor(app, david, 'besvara_insats', { id, svar: 'ja igen' });
    expect(igen.status).toBe(400);
    expect(igen.body.error).toBe('redan_besvarad');
  });

  it('ett svar som utgår från en gammal version avvisas', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:204', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '204' }],
    }));
    const id = i.body.result.insats.id;
    const gammal = i.body.result.insats.version as number;
    await kor(app, david, 'skjut_upp_insats', { id, till: SEN, skal: 'i morgon' });
    const svar = await kor(app, david, 'besvara_insats', {
      id, svar: 'ja', forvantad_version: gammal,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('gammal_version');
  });

  // ---- 4. uppskjutet är inte bortglömt ----------------------------------
  it('uppskjutet ändrar väckningstiden — fristen står kvar', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:205', {
      frist: '2026-09-20T00:00:00Z',
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '205' }],
    }));
    const id = i.body.result.insats.id;
    const svar = await kor(app, david, 'skjut_upp_insats', {
      id, till: SEN, skal: 'väntar på Eva',
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.lage).toBe('uppskjuten');
    expect(String(svar.body.result.frist)).toContain('2026-09-20');
    expect(svar.body.result.vackningstid).not.toBeNull();

    // Ur kön nu...
    const ko = await kor(app, hermes, 'list_insatser', {});
    expect(ko.body.result.map((x: { id: string }) => x.id)).not.toContain(id);
  });

  it('en uppskjuten insats vars väckningstid passerat är tillbaka i kön', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:206', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '206' }],
    }));
    const id = i.body.result.insats.id;
    await kor(app, david, 'skjut_upp_insats', {
      id, till: '2020-01-01T00:00:00Z', skal: 'väckningstiden har redan passerat',
    });
    const ko = await kor(app, hermes, 'list_insatser', {});
    expect(ko.body.result.map((x: { id: string }) => x.id)).toContain(id);
  });

  // ---- 5. ett mottaget svar är Davids arbete ----------------------------
  it('ett besvarat stopp kan inte återkallas — svaret ska följas till sin fortsättning', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:207', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '207' }],
    }));
    const id = i.body.result.insats.id;
    await kor(app, david, 'besvara_insats', { id, svar: 'ja' });
    const svar = await kor(app, hermes, 'aterkalla_insats', { id, skal: 'inte aktuell' });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('redan_besvarad');
  });

  // ---- 6. formen på en insats -------------------------------------------
  it('en insats utan källa avvisas — den går inte att följa tillbaka', async () => {
    const svar = await kor(app, hermes, 'registrera_insats', {
      ...grund('beslut:208'), kallor: [],
    });
    expect(svar.status).toBe(400);
  });

  it('tillhor kan inte vara hermes — det som inte kräver en människa är inte en insats', async () => {
    const svar = await kor(app, hermes, 'registrera_insats', {
      ...grund('beslut:209'), tillhor: 'hermes',
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '209' }],
    });
    expect(svar.status).toBe(400);
  });

  it('kön lägger ägarfrågor före användarhandlingar', async () => {
    await kor(app, hermes, 'registrera_insats', grund('anv:210', {
      typ: 'utathandling', tillhor: 'anvandare',
      handlingskontrakt: { system: 'arenden', kommando: 'redovisa_resultat', objekt: 'LOC-210' },
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '210' }],
    }));
    await kor(app, hermes, 'registrera_insats', grund('agare:211', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '211' }],
    }));
    const ko = await kor(app, hermes, 'list_insatser', {});
    const roller = ko.body.result.map((x: { tillhor: string }) => x.tillhor);
    expect(roller.indexOf('agare')).toBeLessThan(roller.lastIndexOf('anvandare'));
  });
});

// ==== FR-27/Story 6.2: samma stopp blir alltid samma insats, också samtidigt =====================
//
// B-09: registreraInsats skapar raden med INSERT … ON CONFLICT (tenant_id, stopp_id) DO NOTHING
// RETURNING och läser om den befintliga raden. Den gamla formen, SELECT … FOR UPDATE före INSERT,
// såg inte en rad som en annan transaktion ännu inte hade committat. Två samtidiga registreringar
// av samma nya stopp gick då båda till INSERT, och den andra fick unikhetsfelet och svaret 409.
// Fallen nedan är berättelsens F1–F11. De elva fallen ovan, KONTRAKT, SEN och grund() är orörda.

import { readFileSync } from 'node:fs';
import pg from 'pg';
import { pool } from '../src/db/pool.js';
import { raknaRader, TENANT_ID } from './helpers.js';

const INSATS_TS = new URL('../src/services/insats.ts', import.meta.url);

/** Källan hermes/beslut/<objektId>. Varje nytt fall har egna källor med fallets nummer i id:t. */
const kalla = (objektId: string) => ({ system: 'hermes', objekttyp: 'beslut', objekt_id: objektId });

interface Handelse {
  verb: string;
  aktor_typ: string;
  aktor_namn: string;
}

// Samtidighetshjälparna är skrivna efter test/samtidighet.test.ts (vanta, adminKlient,
// vantaTillsNagonVantarPaLas och medOkommitteradAndring). Provfilerna exporterar inga hjälpare,
// och den filen ska stå orörd.

const vanta = (ms: number): Promise<void> => new Promise((klar) => setTimeout(klar, ms));

/** Ägarrollen (postgres), samma anslutning som i test/samtidighet.test.ts. */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/**
 * Väntar tills någon backend i testdatabasen står och väntar på ett lås. Anropas med en EGEN
 * anslutning utan öppen transaktion: pg_stat_activity läses som en ögonblicksbild per transaktion,
 * så den klient som håller låset ser aldrig att någon börjat vänta.
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

/**
 * Mönstret "okommitterad ändring hos en annan transaktion". Ägarrollen kör `sql` i en öppen
 * transaktion, `anrop` startas och ska fastna, ägarrollen committar, och anropets svar returneras.
 * I F1 är ändringen en ny rad med samma stopp, och anropet fastnar på den unika nyckeln
 * insatser_stopp_unik. En SELECT före INSERT hade redan sett tomt när anropet fastnade — därför
 * är F1 deterministiskt rött mot den formen.
 */
async function medOkommitteradAndring<T>(
  sql: string,
  parametrar: unknown[],
  anrop: () => PromiseLike<T>,
): Promise<T> {
  const agare = await adminKlient();
  const vakt = await adminKlient();
  try {
    await agare.query('BEGIN');
    await agare.query(sql, parametrar);
    // Promise.resolve anropar .then() — det är då en supertest-Test skickas.
    const pagaende = Promise.resolve(anrop());
    // Fäller provet innan anropet är besvarat ska dess fel inte bli ett
    // ohanterat löfte; felet syns ändå när pagaende awaitas nedan.
    pagaende.catch(() => undefined);
    await vantaTillsNagonVantarPaLas(vakt);
    await agare.query('COMMIT');
    return await pagaende;
  } finally {
    // Bara en varning om transaktionen redan är committad.
    await agare.query('ROLLBACK').catch(() => undefined);
    await agare.end();
    await vakt.end();
  }
}

/** Händelserna vars payload bär stoppet, i insättningsordning (events.id). */
async function handelserForStopp(stopp: string): Promise<Handelse[]> {
  const { rows } = await pool.query<Handelse>(
    `SELECT verb, aktor_typ, aktor_namn FROM events WHERE payload->>'stopp_id' = $1 ORDER BY id`,
    [stopp],
  );
  return rows;
}

/** Id:na på raderna i insatser med stoppet. Fallen kräver att listan har exakt en rad. */
async function radenForStopp(stopp: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id FROM insatser WHERE tenant_id = $1 AND stopp_id = $2',
    [TENANT_ID, stopp],
  );
  return rows.map((r) => r.id);
}

/** insats_id på raderna i insats_kallor för källan hermes/beslut/<objektId>. */
async function agareForKalla(objektId: string): Promise<string[]> {
  const { rows } = await pool.query<{ insats_id: string }>(
    `SELECT insats_id FROM insats_kallor
      WHERE tenant_id = $1 AND system = 'hermes' AND objekttyp = 'beslut' AND objekt_id = $2`,
    [TENANT_ID, objektId],
  );
  return rows.map((r) => r.insats_id);
}

// ---- F3: det statiska provet på registreraInsats ------------------------------------------------

const INSERT_INSATSER = 'INSERT INTO insatser';
const ON_CONFLICT_STOPP = 'ON CONFLICT (tenant_id, stopp_id) DO NOTHING RETURNING';
const ATERLASNINGEN = 'FROM insatser WHERE tenant_id = $1 AND stopp_id = $2';

/**
 * Den slutna listan läsvägar mot insatser i modulen: tabellen och modulens egna läsfunktioner.
 * Anropen räknas som hela ord (ordgräns före namnet).
 */
const LASVAGAR: { monster: string; traff: RegExp }[] = [
  { monster: 'FROM insatser', traff: /FROM insatser/ },
  { monster: 'las(', traff: /\blas\(/ },
  { monster: 'insatsForKalla(', traff: /\binsatsForKalla\(/ },
  { monster: 'hamtaInsats(', traff: /\bhamtaInsats\(/ },
  { monster: 'listaInsatser(', traff: /\blistaInsatser\(/ },
];

/**
 * Fynden i funktionskroppen för registreraInsats (AK 2). Kroppen är texten från
 * `export async function registreraInsats(` till nästa rad som börjar med `export `, utan
 * kommentarsrader och med varje följd av blanktecken ihopslagen till ett blanksteg.
 *   (a) INSERT INTO insatser står exakt en gång, annars görs (b)–(d) inte;
 *   (b) satsen slutar, till och med sitt första RETURNING, på ON CONFLICT (tenant_id, stopp_id) DO NOTHING RETURNING;
 *   (c) ingen läsväg ur LASVAGAR står före INSERT;
 *   (d) återläsningen står efter INSERT.
 * Provet känner inte igen alla tänkbara läsformer. Det beteendemässiga beviset är F1.
 */
function registreringsfel(kalltext: string): string[] {
  const borjan = kalltext.indexOf('export async function registreraInsats(');
  if (borjan === -1) return ['funktionen saknas'];
  const nasta = kalltext.indexOf('\nexport ', borjan);
  const kropp = kalltext
    .slice(borjan, nasta === -1 ? undefined : nasta)
    .split('\n')
    .filter((rad) => !/^\s*(\/\/|\/\*|\*)/.test(rad))
    .join('\n')
    .replace(/\s+/g, ' ');

  const antal = kropp.split(INSERT_INSATSER).length - 1;
  if (antal !== 1) return [`${INSERT_INSATSER} står ${antal} gånger`];

  const fel: string[] = [];
  const plats = kropp.indexOf(INSERT_INSATSER);
  const fore = kropp.slice(0, plats);
  const fran = kropp.slice(plats);
  const retur = fran.indexOf('RETURNING');
  const satsen = retur === -1 ? fran : fran.slice(0, retur + 'RETURNING'.length);
  if (!satsen.endsWith(ON_CONFLICT_STOPP)) fel.push(`${ON_CONFLICT_STOPP} saknas`);
  for (const { monster, traff } of LASVAGAR) {
    if (traff.test(fore)) fel.push(`läsning före INSERT: ${monster}`);
  }
  if (!kropp.slice(plats + INSERT_INSATSER.length).includes(ATERLASNINGEN)) fel.push('återläsningen saknas');
  return fel;
}

/** Kontrollen för F3: dagens form före Story 6.2, SELECT … FOR UPDATE före en INSERT utan ON CONFLICT. */
const GAMMAL_FORM = [
  'export async function registreraInsats(client, tenantId, input) {',
  "  const { rows: befintlig } = await client.query('SELECT id FROM insatser WHERE tenant_id = $1 AND stopp_id = $2 FOR UPDATE', [tenantId, input.stopp_id]);",
  "  const { rows } = await client.query('INSERT INTO insatser (tenant_id, stopp_id) VALUES ($1, $2) RETURNING id', [tenantId, input.stopp_id]);",
  '  const id = befintlig[0]?.id ?? rows[0].id;',
  '  return las(client, tenantId, id);',
  '}',
  '',
  'export async function besvaraInsats(client, tenantId, aktor, input) {',
  '}',
].join('\n');

/** Kontrollen för F3: ON CONFLICT och återläsning, men fortfarande en SELECT före INSERT. */
const ON_CONFLICT_EFTER_SELECT = [
  'export async function registreraInsats(client, tenantId, input) {',
  "  const { rows: befintlig } = await client.query('SELECT id FROM insatser WHERE tenant_id = $1 AND stopp_id = $2 FOR UPDATE', [tenantId, input.stopp_id]);",
  "  const { rows } = await client.query('INSERT INTO insatser (tenant_id, stopp_id) VALUES ($1, $2) ON CONFLICT (tenant_id, stopp_id) DO NOTHING RETURNING id', [tenantId, input.stopp_id]);",
  "  const { rows: igen } = await client.query('SELECT id FROM insatser WHERE tenant_id = $1 AND stopp_id = $2', [tenantId, input.stopp_id]);",
  '  const id = befintlig[0]?.id ?? rows[0]?.id ?? igen[0].id;',
  '  return las(client, tenantId, id);',
  '}',
  '',
  'export async function besvaraInsats(client, tenantId, aktor, input) {',
  '}',
].join('\n');

describe('FR-27/Story 6.2 AK 1 och AK 2: samma stopp blir samma insats', () => {
  let app: Express;
  let hermes: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  it('F1 (AK 1): en konkurrent som ägarrollen håller okommitterad med samma stopp ger 200 och samma insats', async () => {
    const stopp = 'F1:konkurrent';
    const svar = await medOkommitteradAndring(
      `INSERT INTO insatser (tenant_id, stopp_id, typ, tillhor, utfall, begard_handling, blockeringsgrund)
       VALUES ($1, $2, 'agarbeslut', 'agare', 'F1 utfallet', 'F1 den begärda handlingen', 'F1 blockeringsgrunden')`,
      [TENANT_ID, stopp],
      () => kor(app, hermes, 'registrera_insats', grund(stopp, { kallor: [kalla('F1-1')] })),
    );

    // Mot SELECT-före-INSERT: 409 (conflict), eftersom SELECT:en inte såg den okommitterade raden
    // och INSERT:en fick 23505 när ägarrollen committade.
    expect(svar.status).toBe(200);
    expect(svar.body.result.nyskapad).toBe(false);
    expect(svar.body.result.krockar).toEqual([]);
    const rader = await radenForStopp(stopp);
    expect(rader).toHaveLength(1);
    expect(svar.body.result.insats.id).toBe(rader[0]);
    expect(svar.body.result.insats.kallor.map((k: { objekt_id: string }) => k.objekt_id)).toEqual(['F1-1']);
    expect((await handelserForStopp(stopp)).map((h) => h.verb)).toEqual(['insatsen_fanns_redan']);
  });

  it('F2 (AK 1): sex samtidiga anrop med samma nya stopp ger alla 200 och samma insats, fem varv', async () => {
    for (let varv = 1; varv <= 5; varv++) {
      const stopp = `F2:varv${varv}`;
      const kallId = `F2-${varv}`;
      const svar = await Promise.all(
        Array.from({ length: 6 }, () =>
          kor(app, hermes, 'registrera_insats', grund(stopp, { kallor: [kalla(kallId)] })),
        ),
      );

      const statusar = svar.map((s) => s.status);
      expect(statusar).not.toContain(409);
      expect(statusar).toEqual([200, 200, 200, 200, 200, 200]);
      const idn = new Set(svar.map((s) => s.body.result.insats.id as string));
      expect(idn.size).toBe(1);
      expect(svar.filter((s) => s.body.result.nyskapad === true)).toHaveLength(1);
      for (const s of svar) expect(s.body.result.krockar).toEqual([]);

      const rader = await radenForStopp(stopp);
      expect(rader).toHaveLength(1);
      expect([...idn]).toEqual(rader);
      expect(await agareForKalla(kallId)).toEqual(rader);
      expect((await handelserForStopp(stopp)).map((h) => h.verb).sort()).toEqual([
        'insatsen_fanns_redan',
        'insatsen_fanns_redan',
        'insatsen_fanns_redan',
        'insatsen_fanns_redan',
        'insatsen_fanns_redan',
        'registrerade_insats',
      ]);
    }
  });

  it('F3 (AK 2): registreraInsats skapar raden med ON CONFLICT och läser om den, utan läsning före INSERT', () => {
    expect(registreringsfel(readFileSync(INSATS_TS, 'utf8'))).toEqual([]);

    // Kontrollen: samma kontroll fäller dagens form och en form med ON CONFLICT men en SELECT före.
    expect(registreringsfel(GAMMAL_FORM)).toEqual([
      `${ON_CONFLICT_STOPP} saknas`,
      'läsning före INSERT: FROM insatser',
      'återläsningen saknas',
    ]);
    expect(registreringsfel(ON_CONFLICT_EFTER_SELECT)).toEqual(['läsning före INSERT: FROM insatser']);
  });
});

/** De tre räkningarna som en avvisad registrering inte får ändra. */
async function insatsrader(): Promise<{ events: number; insatser: number; insats_kallor: number }> {
  return {
    events: await raknaRader('events'),
    insatser: await raknaRader('insatser'),
    insats_kallor: await raknaRader('insats_kallor'),
  };
}

describe('FR-27/Story 6.2 AK 5: tillhörighet och källa', () => {
  let app: Express;
  let hermes: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  it('F4 (AK 5): en registrering utan källor, med tom eller utelämnad lista, får kalla_saknas och noll rader', async () => {
    const fore = await insatsrader();

    const tom = await kor(app, hermes, 'registrera_insats', { ...grund('F4:tom'), kallor: [] });
    const utan: Record<string, unknown> = grund('F4:utan');
    delete utan.kallor;
    const utelamnad = await kor(app, hermes, 'registrera_insats', utan);

    // Före Story 6.2 fällde zods .min(1) den tomma listan och det saknade fältet med validation_error.
    expect([tom.status, tom.body.error]).toEqual([400, 'kalla_saknas']);
    expect([utelamnad.status, utelamnad.body.error]).toEqual([400, 'kalla_saknas']);
    expect(await insatsrader()).toEqual(fore);
  });

  it('F5 (AK 5): tillhor hermes avvisas med validation_error på tillhor och noll rader', async () => {
    const fore = await insatsrader();
    const svar = await kor(
      app,
      hermes,
      'registrera_insats',
      grund('F5:hermes', { tillhor: 'hermes', kallor: [kalla('F5-1')] }),
    );
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('validation_error');
    // Tillhörigheten är det enda som fäller: ingen annan post i details.
    expect(svar.body.details.map((d: { path: string }) => d.path)).toEqual(['tillhor']);
    expect(await insatsrader()).toEqual(fore);

    // Kontrollen: samma indata med tillhor agare går igenom, så det är tillhörigheten som fäller.
    const agare = await kor(
      app,
      hermes,
      'registrera_insats',
      grund('F5:agare', { tillhor: 'agare', kallor: [kalla('F5-1')] }),
    );
    expect(agare.status).toBe(200);
    const efter = await insatsrader();
    expect(efter.insatser).toBe(fore.insatser + 1);
    expect(efter.events).toBe(fore.events + 1);
  });
});

/** Felet som satsen ger, med SQLSTATE och villkorets namn; null när satsen går igenom. */
async function pgFel(
  klient: pg.Client,
  sql: string,
  parametrar: unknown[],
): Promise<{ code: unknown; constraint: unknown } | null> {
  try {
    await klient.query(sql, parametrar);
    return null;
  } catch (e) {
    const fel = e as { code?: unknown; constraint?: unknown };
    return { code: fel.code, constraint: fel.constraint };
  }
}

const KALLAN_TILL_INSATS = `INSERT INTO insats_kallor (tenant_id, insats_id, system, objekttyp, objekt_id)
  VALUES ($1, $2, 'hermes', 'beslut', $3)`;

describe('FR-27/Story 6.2 AK 3: ett källobjekt hör till en insats', () => {
  let app: Express;
  let hermes: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  it('F6 (AK 3): en källa som redan hör till en insats stannar där, och den andra registreringen får en krock', async () => {
    const a = await kor(app, hermes, 'registrera_insats', grund('F6:forsta', { kallor: [kalla('F6-1')] }));
    expect(a.status).toBe(200);
    const b = await kor(app, hermes, 'registrera_insats', grund('F6:andra', { kallor: [kalla('F6-1')] }));
    expect(b.status).toBe(200);
    expect(b.body.result.nyskapad).toBe(true);
    expect(b.body.result.krockar).toEqual([kalla('F6-1')]);
    expect(b.body.result.insats.kallor).toEqual([]);

    const upp = await kor(app, hermes, 'insats_for_kalla', kalla('F6-1'));
    expect(upp.status).toBe(200);
    expect(upp.body.result.id).toBe(a.body.result.insats.id);
    expect(await agareForKalla('F6-1')).toEqual([a.body.result.insats.id]);

    // Kontrollen: en fri källa kopplas utan krock, så mätningen kan slå ut åt andra hållet.
    const c = await kor(app, hermes, 'registrera_insats', grund('F6:tredje', { kallor: [kalla('F6-2')] }));
    expect(c.status).toBe(200);
    expect(c.body.result.krockar).toEqual([]);
    expect(c.body.result.insats.kallor.map((k: { objekt_id: string }) => k.objekt_id)).toEqual(['F6-2']);
  });

  it('F7 (AK 3): två samtidiga registreringar med samma nya källa — exakt en bär den, fem varv', async () => {
    for (let varv = 1; varv <= 5; varv++) {
      const kallId = `F7-${varv}`;
      const svar = await Promise.all([
        kor(app, hermes, 'registrera_insats', grund(`F7:a${varv}`, { kallor: [kalla(kallId)] })),
        kor(app, hermes, 'registrera_insats', grund(`F7:b${varv}`, { kallor: [kalla(kallId)] })),
      ]);
      expect(svar.map((s) => s.status)).toEqual([200, 200]);

      const harKallan = (lista: { objekt_id: string }[]): boolean => lista.some((k) => k.objekt_id === kallId);
      // Prövas åt båda hållen: bär båda källan, eller ingen av dem, fälls fallet.
      const barare = svar.filter((s) => harKallan(s.body.result.insats.kallor));
      const krockande = svar.filter((s) => harKallan(s.body.result.krockar));
      expect(barare).toHaveLength(1);
      expect(krockande).toHaveLength(1);
      expect(barare[0]).not.toBe(krockande[0]);
      expect(barare[0]!.body.result.krockar).toEqual([]);
      expect(krockande[0]!.body.result.insats.kallor).toEqual([]);

      const bararensId = barare[0]!.body.result.insats.id as string;
      const upp = await kor(app, hermes, 'insats_for_kalla', kalla(kallId));
      expect(upp.body.result.id).toBe(bararensId);
      expect(await agareForKalla(kallId)).toEqual([bararensId]);
    }
  });

  it('F8 (AK 3): ägarrollens direkta INSERT av en källa till en annan insats fälls av insats_kallor_unik', async () => {
    const [aId] = await radenForStopp('F6:forsta');
    const [bId] = await radenForStopp('F6:andra');
    expect(aId).toBeDefined();
    expect(bId).toBeDefined();

    const agare = await adminKlient();
    try {
      expect(await pgFel(agare, KALLAN_TILL_INSATS, [TENANT_ID, bId, 'F6-1'])).toEqual({
        code: '23505',
        constraint: 'insats_kallor_unik',
      });
      expect(await agareForKalla('F6-1')).toEqual([aId]);

      // Kontrollen: samma INSERT med en ny källa går igenom, så det är nyckeln som fäller, inte rättigheterna.
      await agare.query('BEGIN');
      try {
        expect(await pgFel(agare, KALLAN_TILL_INSATS, [TENANT_ID, bId, 'F8-1'])).toBeNull();
      } finally {
        await agare.query('ROLLBACK');
      }
    } finally {
      await agare.end();
    }
  });
});

/** Händelserna vars payload bär insatsens id, i insättningsordning (events.id). */
async function handelserForInsats(id: string): Promise<Handelse[]> {
  const { rows } = await pool.query<Handelse>(
    `SELECT verb, aktor_typ, aktor_namn FROM events WHERE payload->>'insats_id' = $1 ORDER BY id`,
    [id],
  );
  return rows;
}

/** Fyra av fälten som ett svar eller en uppskjutning ändrar, lästa direkt ur tabellen. */
async function svarsfalten(id: string): Promise<Record<string, unknown> | undefined> {
  const { rows } = await pool.query(
    'SELECT lage, version, svar_aktor, vackningstid FROM insatser WHERE tenant_id = $1 AND id = $2',
    [TENANT_ID, id],
  );
  return rows[0];
}

// F10: CHECK-villkoret insatser_svar_har_aktor har två led, svar_aktor och svar_nar, och felet
// (23514 med villkorets namn) säger inte vilket av dem som fällde. Därför bär varje sats som ska
// fällas allt som ett svar sätter utom aktören, och kontrollen är SAMMA sats med en aktör: de skiljer
// sig bara i svar_aktor, så ett villkor som bara krävde svar_nar hade släppt igenom satsen.
const SVARET_UTOM_AKTOREN = "lage = 'svar_mottaget', svar_text = 'F10 svaret', svar_nar = now()";
/** Svaret med aktören utelämnad. */
const SVAR_UTAN_AKTOR = `UPDATE insatser SET ${SVARET_UTOM_AKTOREN} WHERE tenant_id = $1 AND id = $2`;
/** Svaret med aktören som parameter $3. */
const SVAR_MED_AKTOR = `UPDATE insatser SET ${SVARET_UTOM_AKTOREN}, svar_aktor = $3 WHERE tenant_id = $1 AND id = $2`;
/** Byter bara aktören på raden, för ett svar som redan är mottaget. */
const BYT_SVARETS_AKTOR = 'UPDATE insatser SET svar_aktor = $3 WHERE tenant_id = $1 AND id = $2';
const AKTORSLEDET = { code: '23514', constraint: 'insatser_svar_har_aktor' };

describe('FR-27/Story 6.2 AK 4: svaret kräver en människa', () => {
  let app: Express;
  let hermes: string;
  let david: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  it('F9 (AK 4): agentnyckeln får kraver_manniska och noll rader; människonyckeln besvarar med sin aktör', async () => {
    const reg = await kor(app, hermes, 'registrera_insats', grund('F9:svar', { kallor: [kalla('F9-1')] }));
    expect(reg.status).toBe(200);
    const id = reg.body.result.insats.id as string;
    const fore = { events: await raknaRader('events'), insatser: await raknaRader('insatser') };

    const besvara = await kor(app, hermes, 'besvara_insats', { id, svar: 'F9 ja' });
    expect([besvara.status, besvara.body.error]).toEqual([403, 'kraver_manniska']);
    const skjutUpp = await kor(app, hermes, 'skjut_upp_insats', { id, till: SEN, skal: 'F9 senare' });
    expect([skjutUpp.status, skjutUpp.body.error]).toEqual([403, 'kraver_manniska']);
    expect({ events: await raknaRader('events'), insatser: await raknaRader('insatser') }).toEqual(fore);
    expect(await svarsfalten(id)).toEqual({ lage: 'vantande', version: 1, svar_aktor: null, vackningstid: null });

    // Kontrollen: människonyckeln besvarar samma insats, och händelseraden bär nyckelns aktör.
    const manniska = await kor(app, david, 'besvara_insats', { id, svar: 'F9 ja, kör' });
    expect(manniska.status).toBe(200);
    expect(manniska.body.result.lage).toBe('svar_mottaget');
    expect(manniska.body.result.svar_aktor).toBe('david');
    expect(await raknaRader('events')).toBe(fore.events + 1);
    expect((await handelserForInsats(id)).at(-1)).toEqual({
      verb: 'besvarade_insats',
      aktor_typ: 'manniska',
      aktor_namn: 'david',
    });
    // Svarets händelserad bär insats_id men inget stopp_id, därav handelserForInsats.
    expect((await handelserForStopp('F9:svar')).map((h) => h.verb)).toEqual(['registrerade_insats']);
  });

  it('F10 (AK 4): CHECK-villkoret insatser_svar_har_aktor fäller ägarrollens svar utan aktör', async () => {
    const reg = await kor(app, hermes, 'registrera_insats', grund('F10:check', { kallor: [kalla('F10-1')] }));
    expect(reg.status).toBe(200);
    const id = reg.body.result.insats.id as string;

    const agare = await adminKlient();
    try {
      // Svar utan aktör, med svar_text och svar_nar satta: aktören utelämnad och aktören satt till null.
      expect(await pgFel(agare, SVAR_UTAN_AKTOR, [TENANT_ID, id]), 'aktören utelämnad').toEqual(AKTORSLEDET);
      expect(await pgFel(agare, SVAR_MED_AKTOR, [TENANT_ID, id, null]), 'aktören null').toEqual(AKTORSLEDET);
      expect(await svarsfalten(id)).toEqual({ lage: 'vantande', version: 1, svar_aktor: null, vackningstid: null });

      await agare.query('BEGIN');
      try {
        // Kontrollen: samma sats med en aktör går igenom, så det är aktören som fäller, inte svar_nar.
        expect(await pgFel(agare, SVAR_MED_AKTOR, [TENANT_ID, id, 'F10 provaktör'])).toBeNull();

        // Ett mottaget svar som tappar sin aktör fälls också.
        await agare.query('SAVEPOINT utan_aktor');
        expect(await pgFel(agare, BYT_SVARETS_AKTOR, [TENANT_ID, id, null]), 'aktören borttagen').toEqual(
          AKTORSLEDET,
        );
        await agare.query('ROLLBACK TO SAVEPOINT utan_aktor');
        // Kontrollen: samma sats med en annan aktör går igenom.
        expect(await pgFel(agare, BYT_SVARETS_AKTOR, [TENANT_ID, id, 'F10 annan aktör'])).toBeNull();
      } finally {
        await agare.query('ROLLBACK');
      }
      expect((await svarsfalten(id))?.lage).toBe('vantande');
    } finally {
      await agare.end();
    }
  });
});

// ---- F11: README (krav → kod → test), efter mönstret i test/linear-lankar.test.ts ---------------

const RUBRIKEN = '### FR-27 — samma stopp blir samma insats, också samtidigt (Story 6.2)';
const GRANSER_2A = '## Gränser för Etapp 2a';
const REGELNS_BORJAN = '- Skapa-om-inte-finns (FR-27, B-09, Story 6.2):';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN =
  '- Skapa-om-inte-finns (FR-27, B-09, Story 6.2): en rad med en unik nyckel skapas med ' +
  '`INSERT … ON CONFLICT (<nyckeln>) DO NOTHING RETURNING` och läses om när ingen rad kom tillbaka; ' +
  'ingen SELECT före INSERT avgör om raden finns. `registreraInsats` i `src/services/insats.ts` gör så ' +
  'för `(tenant_id, stopp_id)`, så att samtidiga registreringar av samma stopp ger samma insats och ' +
  'aldrig 409.';

/** Avsnittets gränser: från rubriken till nästa rad som börjar med '## ' eller '### '. */
function avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/**
 * Fynden för F11: rubriken en gång och före Etapp 2a:s gränser, regelns rad exakt en gång och
 * fyra tabellrader, var och en med provfilen.
 */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const fel: string[] = [];
  const rubriker = rader.filter((r) => r === RUBRIKEN).length;
  if (rubriker !== 1) fel.push(`rubriken står ${rubriker} gånger`);
  const etapp2a = rader.indexOf(GRANSER_2A);
  if (etapp2a === -1 || etapp2a < granser.start) fel.push(`rubriken står inte före ${GRANSER_2A}`);
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const regler = avsnitt.filter((r) => r.startsWith(REGELNS_BORJAN));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regeln avviker');
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-27'));
  if (tabell.length !== 4) fel.push(`${tabell.length} rader börjar med | FR-27`);
  for (const r of tabell) if (!r.includes('test/insats.test.ts')) fel.push(`rad utan provfilen: ${r}`);
  return fel;
}

/** Texten utan avsnittet: raderna från rubriken till nästa rubrik på nivå två eller tre tas bort. */
function utanAvsnittet(text: string): string {
  const rader = text.split('\n');
  const granser = avsnittet(rader.map((r) => r.replace(/\r$/, '')));
  if (!granser) return text;
  return [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
}

describe('FR-27/Story 6.2: README bär regeln', () => {
  it('F11 (AK 1–5): avsnittet bär regeln och fyra rader krav → kod → test', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readmefel(readme)).toEqual([]);

    // Kontrollen: samma kontroll på texten utan avsnittet fälls.
    expect(readmefel(utanAvsnittet(readme))).toEqual(['rubriken saknas']);
  });
});

// ==== FR-27/Story 6.3: insatstypen styr vilka kommandon som får utföras ==========================
//
// B-09: en sluten tabell, KOMMANDOTABELL i src/services/insats.ts, binder varje insatstyp till de
// kommandon i handlingskontraktet som typen tillåter, och registreraInsats prövar varje registrering
// mot den med kommandotTillats() före varje skrivning. Fallen nedan är berättelsens T1–T10. De elva
// första fallen, F1–F11, grund(), SEN och Story 6.2:s hjälpare är orörda. Bara kommandot i KONTRAKT och
// handlingskontraktet i fallet med utathandling är bytta till tillåtna kombinationer (AK 3).

// Namnrymd och inga namngivna importer: filen laddas också innan KOMMANDOTABELL, kommandotTillats och
// matInsatskombinationer finns, och fallen som behöver dem blir röda med «är inte en funktion».
import * as insatsTjansten from '../src/services/insats.js';
import { withTransaction } from '../src/db/tx.js';

const TYPERNA_63 = ['agarbeslut', 'utathandling', 'kundkontakt', 'godkannande', 'intygande'] as const;
type Typ63 = (typeof TYPERNA_63)[number];

type Orakelrad =
  | { lage: 'harledd'; kommandon: readonly string[]; svar: string; citat: string }
  | { lage: 'vantar' };

/**
 * Provets förväntan på KOMMANDOTABELL (AK 1). Koden läser den aldrig. De tre citaten och de två
 * datumen är dem i AK 1:s Given, utan citattecknen « och », och code-review prövar dem där.
 */
const ORAKLET: Record<Typ63, Orakelrad> = {
  agarbeslut: {
    lage: 'harledd',
    kommandon: ['beslutskoe --besvara'],
    svar: 'Davids svar 2026-10-16',
    citat: 'ägarbeslut ger ett svar på beslutet',
  },
  utathandling: {
    lage: 'harledd',
    kommandon: ['redovisa_resultat'],
    svar: 'Davids svar 2026-10-16',
    citat: 'att godkänna ett utkast är ett annat kommando än att registrera att något faktiskt har skickats',
  },
  kundkontakt: {
    lage: 'harledd',
    kommandon: ['set_crm_commitment_status', 'snooze_crm_commitment', 'log_contact'],
    svar: 'Davids svar 2026-10-23',
    citat:
      'Typen får därför bara set_crm_commitment_status (klart kräver belägg), snooze_crm_commitment och log_contact',
  },
  godkannande: { lage: 'vantar' },
  intygande: { lage: 'vantar' },
};

/** Oraklets härledda rader, i typernas ordning. T2 och T4 itererar dem, aldrig den importerade konstanten. */
function harleddaIOraklet(): { typ: Typ63; kommandon: readonly string[] }[] {
  return TYPERNA_63.flatMap((typ) => {
    const rad = ORAKLET[typ];
    return rad.lage === 'harledd' ? [{ typ, kommandon: rad.kommandon }] : [];
  });
}

/** En rad som kontrollfunktionen läser: läget, kommandona för en härledd rad och grunden. */
interface Tabellrad {
  lage: string;
  kommandon?: readonly string[];
  grund: string;
}

/**
 * Fynden för T1 (a)–(i): nycklarna, varje rad mot oraklet, grunden med §4 och, för en rad som oraklet
 * har härledd, svarets datum och kortets citat; därefter regel 1 och regel 2. Fynden kommer i den ordningen.
 */
function tabellfel(tabell: unknown): string[] {
  if (typeof tabell !== 'object' || tabell === null) return ['tabellen saknas'];
  if (JSON.stringify(Object.keys(tabell).sort()) !== JSON.stringify([...TYPERNA_63].sort())) {
    return ['nycklarna avviker'];
  }
  const rader = tabell as Record<string, Partial<Tabellrad> | undefined>;
  const fel: string[] = [];
  for (const typ of TYPERNA_63) {
    const rad: Partial<Tabellrad> = rader[typ] ?? {};
    const vantad = ORAKLET[typ];
    const grund = typeof rad.grund === 'string' ? rad.grund : '';
    const kommandon = vantad.lage === 'harledd' ? vantad.kommandon : undefined;
    if (rad.lage !== vantad.lage || JSON.stringify(rad.kommandon) !== JSON.stringify(kommandon)) {
      fel.push(`${typ} avviker från oraklet`);
    }
    if (!grund.includes('§4')) fel.push(`${typ}: grunden saknar §4`);
    if (vantad.lage === 'harledd') {
      if (!grund.includes(vantad.svar)) fel.push(`${typ}: grunden saknar ${vantad.svar}`);
      if (!grund.includes(vantad.citat)) fel.push(`${typ}: grunden saknar citatet`);
    }
  }
  const agar: Partial<Tabellrad> = rader.agarbeslut ?? {};
  if (agar.lage === 'harledd' && agar.kommandon?.length !== 1) {
    fel.push(`regel 1: agarbeslut har ${agar.kommandon?.length ?? 0} kommandon`);
  }
  const godk: Partial<Tabellrad> = rader.godkannande ?? {};
  if (godk.lage === 'harledd') {
    const utskick = rader.utathandling?.kommandon ?? [];
    for (const kommando of godk.kommandon ?? []) {
      if (utskick.includes(kommando)) fel.push(`regel 2: godkannande delar ${kommando} med utathandling`);
    }
  }
  return fel;
}

/** T1 (j): delarna som inte är frysta, i ordningen tabellen och sedan varje typs rad och dess lista. */
function ofrysta(tabell: unknown): string[] {
  if (typeof tabell !== 'object' || tabell === null) return ['tabellen saknas'];
  const fynd: string[] = [];
  if (!Object.isFrozen(tabell)) fynd.push('tabellen');
  const rader = tabell as Record<string, unknown>;
  for (const typ of TYPERNA_63) {
    const rad = rader[typ];
    if (!Object.isFrozen(rad)) fynd.push(typ);
    const kommandon = typeof rad === 'object' && rad !== null ? (rad as { kommandon?: unknown }).kommandon : undefined;
    if (kommandon !== undefined && !Object.isFrozen(kommandon)) fynd.push(`${typ}.kommandon`);
  }
  return fynd;
}

/** Oraklets rader med påhittade grunder, byggda utan Object.freeze på någon nivå. Kontrollen i T1. */
const GILTIG_TABELL: Record<string, Tabellrad> = Object.fromEntries(
  TYPERNA_63.map((typ): [string, Tabellrad] => {
    const rad = ORAKLET[typ];
    return [
      typ,
      rad.lage === 'harledd'
        ? { lage: 'harledd', kommandon: [...rad.kommandon], grund: `påhittad grund: §4 enligt ${rad.svar}: ${rad.citat}` }
        : { lage: 'vantar', grund: 'påhittad grund: §4 enligt Davids svar 2026-10-16' },
    ];
  }),
);

/** Ett andra kommando för agarbeslut: fälls av oraklet och av regel 1. */
const MED_TVA_SVAR = {
  ...GILTIG_TABELL,
  agarbeslut: { ...GILTIG_TABELL.agarbeslut!, kommandon: ['beslutskoe --besvara', 'besvara_beslut'] },
};
/** godkannande härledd med utathandlings registreringskommando: fälls av oraklet och av regel 2. */
const MED_DELAT_UTSKICK = {
  ...GILTIG_TABELL,
  godkannande: { lage: 'harledd', kommandon: ['redovisa_resultat'], grund: GILTIG_TABELL.godkannande!.grund },
};
/** Tabellen utan typen intygande: fälls av nycklarna. */
const UTAN_INTYGANDE: Record<string, Tabellrad> = { ...GILTIG_TABELL };
delete UTAN_INTYGANDE.intygande;
/** Grunden för agarbeslut utan kortets citat: fälls av citatledet. */
const UTAN_CITAT = {
  ...GILTIG_TABELL,
  agarbeslut: { ...GILTIG_TABELL.agarbeslut!, grund: 'påhittad grund: §4 enligt Davids svar 2026-10-16' },
};

/** Avvisningslistan i AK 3: fyra kommandon per härledd typ som typen inte tillåter (T2 och T3). */
const AVVISADE: Record<'agarbeslut' | 'utathandling' | 'kundkontakt', readonly string[]> = {
  agarbeslut: ['redovisa_resultat', 'besvara_beslut', 'BESLUTSKOE --BESVARA', 'beslutskoe --besvara 153'],
  utathandling: ['beslutskoe --besvara', 'besvara_beslut', 'REDOVISA_RESULTAT', 'redovisa_resultat T3'],
  kundkontakt: ['beslutskoe --besvara', 'redovisa_resultat', 'LOG_CONTACT', 'log_contact T3'],
};

describe('FR-27/Story 6.3 AK 1: kommandotabellen är härledd och sluten', () => {
  it('T1 (AK 1): tabellen har fem rader med grund ur §4, bär svarets två regler och är djupfryst', () => {
    expect(tabellfel(insatsTjansten.KOMMANDOTABELL)).toEqual([]);
    expect(ofrysta(insatsTjansten.KOMMANDOTABELL)).toEqual([]);

    // Kontrollen: den giltiga tabellen går igenom, och fyra påhittade tabeller fälls med sina fynd.
    expect(tabellfel(GILTIG_TABELL)).toEqual([]);
    expect(tabellfel(MED_TVA_SVAR)).toEqual(['agarbeslut avviker från oraklet', 'regel 1: agarbeslut har 2 kommandon']);
    expect(tabellfel(MED_DELAT_UTSKICK)).toEqual([
      'godkannande avviker från oraklet',
      'regel 2: godkannande delar redovisa_resultat med utathandling',
    ]);
    expect(tabellfel(UTAN_INTYGANDE)).toEqual(['nycklarna avviker']);
    expect(tabellfel(UTAN_CITAT)).toEqual(['agarbeslut: grunden saknar citatet']);

    // Kontrollen för frysprovet: den ofrysta tabellen fälls på varje nivå.
    expect(ofrysta(GILTIG_TABELL)).toEqual([
      'tabellen',
      'agarbeslut',
      'agarbeslut.kommandon',
      'utathandling',
      'utathandling.kommandon',
      'kundkontakt',
      'kundkontakt.kommandon',
      'godkannande',
      'intygande',
    ]);
  });
});

describe('FR-27/Story 6.3 AK 3: predikatet', () => {
  it('T2 (AK 3): kommandotTillats() godtar exakt radens kommandon, och en väntande rad godtar allt', () => {
    for (const { typ, kommandon } of harleddaIOraklet()) {
      for (const kommando of kommandon) {
        expect(insatsTjansten.kommandotTillats(typ, kommando), `${typ}: ${kommando}`).toBe(true);
      }
    }

    // Prövas åt båda hållen: varje härledd typ har också kommandon som avvisas, och en härledd rad
    // godtar aldrig ett kommando som inte är en sträng (listan fäller ett predikat som gör om till text).
    for (const [typ, kommandon] of Object.entries(AVVISADE)) {
      for (const kommando of [...kommandon, undefined, null, 153, ['beslutskoe --besvara']]) {
        expect(insatsTjansten.kommandotTillats(typ, kommando), `${typ}: ${JSON.stringify(kommando)}`).toBe(false);
      }
    }

    for (const typ of ['godkannande', 'intygande']) {
      for (const kommando of ['beslutskoe --besvara', 'redovisa_resultat', 'besvara_beslut', 'T2 valfritt kommando']) {
        expect(insatsTjansten.kommandotTillats(typ, kommando), `${typ}: ${kommando}`).toBe(true);
      }
    }

    // En typ som inte är en egen nyckel i tabellen godtas aldrig, inte heller ett ärvt namn.
    for (const typ of ['constructor', 'toString', 'okand_typ']) {
      expect(insatsTjansten.kommandotTillats(typ, 'beslutskoe --besvara'), typ).toBe(false);
    }
    expect(insatsTjansten.kommandotTillats('agarbeslut', 'constructor')).toBe(false);
  });
});

/** Raden i insatser för stoppet, med handlingskontraktets kommando; undefined när raden saknas. */
async function kommandotForStopp(stopp: string): Promise<string | null | undefined> {
  const { rows } = await pool.query<{ kommando: string | null }>(
    `SELECT handlingskontrakt->>'kommando' AS kommando FROM insatser WHERE tenant_id = $1 AND stopp_id = $2`,
    [TENANT_ID, stopp],
  );
  return rows[0]?.kommando;
}

describe('FR-27/Story 6.3 AK 3: otillåten kombination genom hela stacken', () => {
  let app: Express;
  let hermes: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  /** Registreringen med typen och kommandot i handlingskontraktet, i övrigt grund(). */
  const registrera = (stopp: string, typ: string, kommando: string, kallId: string) =>
    kor(app, hermes, 'registrera_insats', grund(stopp, {
      typ,
      handlingskontrakt: { ...KONTRAKT, kommando },
      kallor: [kalla(kallId)],
    }));

  it('T3 (AK 3): varje otillåten kombination får otillatet_kommando och noll rader, också för ett befintligt stopp', async () => {
    for (const [typ, kommandon] of Object.entries(AVVISADE)) {
      for (const [i, kommando] of kommandon.entries()) {
        const fore = await insatsrader();
        const svar = await registrera(`T3:${typ}:${i + 1}`, typ, kommando, `T3-${typ}-${i + 1}`);
        expect([svar.status, svar.body.error], `${typ}: ${kommando}`).toEqual([400, 'otillatet_kommando']);
        expect(await insatsrader(), `${typ}: ${kommando}`).toEqual(fore);
      }
    }

    // Omregistreringen: grinden prövar den inkommande kombinationen, och den befintliga raden står orörd.
    const ny = await registrera('T3:befintlig', 'agarbeslut', 'beslutskoe --besvara', 'T3-befintlig');
    expect(ny.status, ny.text).toBe(200);
    const fore = await insatsrader();
    const igen = await registrera('T3:befintlig', 'agarbeslut', 'redovisa_resultat', 'T3-befintlig');
    expect([igen.status, igen.body.error]).toEqual([400, 'otillatet_kommando']);
    expect(await insatsrader()).toEqual(fore);
    expect(await kommandotForStopp('T3:befintlig')).toBe('beslutskoe --besvara');

    // Kontrollen: samma indata som det första avvisade anropet, med typens tillåtna kommando, skrivs.
    const foreKontroll = await insatsrader();
    const kontroll = await registrera('T3:agarbeslut:1', 'agarbeslut', 'beslutskoe --besvara', 'T3-agarbeslut-1');
    expect(kontroll.status, kontroll.text).toBe(200);
    const efter = await insatsrader();
    expect(efter.insatser).toBe(foreKontroll.insatser + 1);
    expect(efter.events).toBe(foreKontroll.events + 1);
  });

  it('T4 (AK 3): varje kommando i varje härledd rad godtas och registreras', async () => {
    for (const { typ, kommandon } of harleddaIOraklet()) {
      for (const kommando of kommandon) {
        const stopp = `T4:${typ}:${kommando}`;
        const fore = await insatsrader();
        const svar = await registrera(stopp, typ, kommando, `T4-${typ}-${kommando}`);
        expect(svar.status, `${typ}: ${kommando}: ${svar.text}`).toBe(200);
        expect(svar.body.result.nyskapad, `${typ}: ${kommando}`).toBe(true);
        const efter = await insatsrader();
        expect(efter.insatser, `${typ}: ${kommando}`).toBe(fore.insatser + 1);
        expect(efter.events, `${typ}: ${kommando}`).toBe(fore.events + 1);
        expect((await handelserForStopp(stopp)).at(-1)?.verb, `${typ}: ${kommando}`).toBe('registrerade_insats');
      }
    }

    // Kontrollen: ett kommando som raden inte har avvisas.
    const fore = await insatsrader();
    const kontroll = await registrera('T4:kontroll', 'agarbeslut', 'besvara_beslut', 'T4-kontroll');
    expect([kontroll.status, kontroll.body.error]).toEqual([400, 'otillatet_kommando']);
    expect(await insatsrader()).toEqual(fore);
  });

  it('T5 (AK 3): typerna utan beslutad rad godtar varje kommando, som före tabellen', async () => {
    const kommandon = ['beslutskoe --besvara', 'redovisa_resultat', 'besvara_beslut', 'T5 valfritt kommando'];
    for (const typ of ['godkannande', 'intygande']) {
      for (const [i, kommando] of kommandon.entries()) {
        const svar = await registrera(`T5:${typ}:${i + 1}`, typ, kommando, `T5-${typ}-${i + 1}`);
        expect(svar.status, `${typ}: ${kommando}: ${svar.text}`).toBe(200);
        expect(svar.body.result.nyskapad, `${typ}: ${kommando}`).toBe(true);
      }
    }

    // Kontrollen: samma fria kommando avvisas för en typ med härledd rad.
    const fore = await insatsrader();
    const kontroll = await registrera('T5:kontroll', 'agarbeslut', 'T5 valfritt kommando', 'T5-kontroll');
    expect([kontroll.status, kontroll.body.error]).toEqual([400, 'otillatet_kommando']);
    expect(await insatsrader()).toEqual(fore);
  });
});

// ---- T6: det statiska provet på tabellens plats ------------------------------------------------

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROT_63 = fileURLToPath(new URL('../', import.meta.url));
const SRC_63 = path.join(ROT_63, 'src');
const TJANSTEFILEN_63 = 'services/insats.ts';

/** Texten utan kommentarsrader, med samma regel som registreringsfel(). */
function utanKommentarsrader63(text: string): string {
  return text
    .split('\n')
    .filter((rad) => !/^\s*(\/\/|\/\*|\*)/.test(rad))
    .join('\n');
}

/**
 * Funktionskroppen från `borjan` till nästa rad som börjar med `export ` eller filens slut, utan
 * kommentarsrader och med varje följd av blanktecken ihopslagen till ett blanksteg. Tom när funktionen saknas.
 */
function kroppen63(kalltext: string, borjan: string): string {
  const start = kalltext.indexOf(borjan);
  if (start === -1) return '';
  const nasta = kalltext.indexOf('\nexport ', start);
  return utanKommentarsrader63(kalltext.slice(start, nasta === -1 ? undefined : nasta)).replace(/\s+/g, ' ');
}

/**
 * Fynden för T6 (AK 2) över `filer`, med sökvägen relativt src/:
 *   (a) `const KOMMANDOTABELL` står i exakt en fil, tjänstefilen, och där exakt en gång;
 *   (b) `otillatet_kommando` står i exakt en fil, och i tjänstefilen exakt en gång;
 *   (c) i kroppen för registreraInsats står `kommandotTillats(` före `INSERT INTO insatser`.
 * Kommentarsrader räknas inte. Provet känner inte igen alla sätt att skriva en andra tabell; det
 * beteendemässiga beviset är T3–T5.
 */
function tabellplatsfel(filer: { fil: string; text: string }[]): string[] {
  const kod = filer.map(({ fil, text }) => ({ fil, text: utanKommentarsrader63(text) }));
  const tjansten = kod.find(({ fil }) => fil === TJANSTEFILEN_63)?.text ?? '';
  const fel: string[] = [];

  const definierar = kod.filter(({ text }) => /\bconst KOMMANDOTABELL\b/.test(text));
  if (definierar.length !== 1) {
    fel.push(`KOMMANDOTABELL definieras i ${definierar.length} filer`);
  } else if (definierar[0]!.fil !== TJANSTEFILEN_63) {
    fel.push(`KOMMANDOTABELL definieras i ${definierar[0]!.fil}`);
  } else {
    const ganger = tjansten.match(/\bconst KOMMANDOTABELL\b/g)?.length ?? 0;
    if (ganger !== 1) fel.push(`KOMMANDOTABELL definieras ${ganger} gånger`);
  }

  const medKoden = kod.filter(({ text }) => text.includes('otillatet_kommando'));
  if (medKoden.length !== 1) {
    fel.push(`otillatet_kommando står i ${medKoden.length} filer`);
  } else {
    const ganger = tjansten.split('otillatet_kommando').length - 1;
    if (ganger !== 1) fel.push(`otillatet_kommando står ${ganger} gånger`);
  }

  const kropp = kroppen63(tjansten, 'export async function registreraInsats(');
  const grinden = kropp.indexOf('kommandotTillats(');
  const insert = kropp.indexOf('INSERT INTO insatser');
  if (grinden === -1 || insert === -1 || grinden > insert) {
    fel.push('kommandotTillats( står inte före INSERT INTO insatser');
  }
  return fel;
}

/** En giltig tjänstefil i miniatyr: tabellen, felkoden och grinden före INSERT. */
const GILTIG_TJANST_63 = [
  'export const KOMMANDOTABELL = Object.freeze({});',
  '',
  'export async function registreraInsats(client, tenantId, input) {',
  "  if (!kommandotTillats(input.typ, input.handlingskontrakt.kommando)) throw new BadRequestError('otillatet_kommando');",
  "  await client.query('INSERT INTO insatser (tenant_id, stopp_id) VALUES ($1, $2) ON CONFLICT (tenant_id, stopp_id) DO NOTHING RETURNING id', [tenantId, input.stopp_id]);",
  '}',
  '',
  'export async function besvaraInsats(client, tenantId, aktor, input) {',
  '}',
].join('\n');

/** Kontrollen för (a): konstanten definieras också i en annan fil. */
const TVA_TABELLER = [
  { fil: TJANSTEFILEN_63, text: GILTIG_TJANST_63 },
  { fil: 'services/annanTabell.ts', text: 'export const KOMMANDOTABELL = Object.freeze({});\n' },
];
/** Kontrollen för (b): felkoden står också i en annan fil. */
const FELKODEN_I_TVA_FILER = [
  { fil: TJANSTEFILEN_63, text: GILTIG_TJANST_63 },
  { fil: 'http/vy/annanFelkod.ts', text: "export const KOD = 'otillatet_kommando';\n" },
];
/** Kontrollen för (c): anropet står efter INSERT. */
const GRINDEN_EFTER_INSERT = [
  {
    fil: TJANSTEFILEN_63,
    text: [
      'export const KOMMANDOTABELL = Object.freeze({});',
      '',
      'export async function registreraInsats(client, tenantId, input) {',
      "  await client.query('INSERT INTO insatser (tenant_id, stopp_id) VALUES ($1, $2) ON CONFLICT (tenant_id, stopp_id) DO NOTHING RETURNING id', [tenantId, input.stopp_id]);",
      "  if (!kommandotTillats(input.typ, input.handlingskontrakt.kommando)) throw new BadRequestError('otillatet_kommando');",
      '}',
    ].join('\n'),
  },
];

describe('FR-27/Story 6.3 AK 2: en sluten tabell', () => {
  it('T6 (AK 2): tabellen och felkoden står bara i tjänstefilen, och grinden står före INSERT', () => {
    const filer = readdirSync(SRC_63, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.split(path.sep).join('/'))
      .sort()
      .map((fil) => ({ fil, text: readFileSync(path.join(SRC_63, fil), 'utf8') }));
    expect(filer.map(({ fil }) => fil)).toContain(TJANSTEFILEN_63);
    expect(tabellplatsfel(filer)).toEqual([]);

    // Kontrollen: tre påhittade källuppsättningar fälls med var sitt fynd.
    expect(tabellplatsfel(TVA_TABELLER)).toEqual(['KOMMANDOTABELL definieras i 2 filer']);
    expect(tabellplatsfel(FELKODEN_I_TVA_FILER)).toEqual(['otillatet_kommando står i 2 filer']);
    expect(tabellplatsfel(GRINDEN_EFTER_INSERT)).toEqual(['kommandotTillats( står inte före INSERT INTO insatser']);
  });
});

// ---- T7–T9: den läsande mätningen ---------------------------------------------------------------

import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

/**
 * Åtta rader som ägarrollen lägger in direkt, i den här ordningen: fyra med en kombination som tabellen
 * avvisar och fyra som den godtar. Kommandot `undefined` ger handlingskontraktet {} (kommandot saknas).
 */
const T7_RADER: { stopp: string; typ: string; kommando: string | undefined }[] = [
  { stopp: 'T7:agarbeslut-utskick', typ: 'agarbeslut', kommando: 'redovisa_resultat' },
  { stopp: 'T7:utathandling-provkommando', typ: 'utathandling', kommando: 'besvara_beslut' },
  { stopp: 'T7:agarbeslut-utan', typ: 'agarbeslut', kommando: undefined },
  { stopp: 'T7:agarbeslut-radbrytning', typ: 'agarbeslut', kommando: 'beslutskoe\n--besvara\t1' },
  { stopp: 'T7:agarbeslut-svar', typ: 'agarbeslut', kommando: 'beslutskoe --besvara' },
  { stopp: 'T7:utathandling-utskick', typ: 'utathandling', kommando: 'redovisa_resultat' },
  { stopp: 'T7:kundkontakt-kontakt', typ: 'kundkontakt', kommando: 'log_contact' },
  { stopp: 'T7:intygande-provkommando', typ: 'intygande', kommando: 'besvara_beslut' },
];

/** En sats per rad och skapad = clock_timestamp(), så att insättningsordningen är mätningens ordning. */
const T7_INSERT = `INSERT INTO insatser
  (tenant_id, stopp_id, typ, tillhor, utfall, begard_handling, blockeringsgrund, handlingskontrakt, skapad)
  VALUES ($1, $2, $3, 'agare', 'T7 utfallet', 'T7 den begärda handlingen', 'T7 blockeringsgrunden',
          $4::jsonb, clock_timestamp())`;

/** Mätningens fynd bland raderna i T7_RADER: exakt de fyra som tabellen avvisar, i insättningsordning. */
const T7_FYNDEN = [
  { stopp_id: 'T7:agarbeslut-utskick', typ: 'agarbeslut', lage: 'vantande', kommando: 'redovisa_resultat' },
  { stopp_id: 'T7:utathandling-provkommando', typ: 'utathandling', lage: 'vantande', kommando: 'besvara_beslut' },
  { stopp_id: 'T7:agarbeslut-utan', typ: 'agarbeslut', lage: 'vantande', kommando: null },
  { stopp_id: 'T7:agarbeslut-radbrytning', typ: 'agarbeslut', lage: 'vantande', kommando: 'beslutskoe\n--besvara\t1' },
];

const baraT7 = (fynd: { stopp_id: string }[]) => fynd.filter((f) => f.stopp_id.startsWith('T7:'));

/** md5 över varje rad i insatser för tenanten, som text: ändras om någon kolumn i någon rad skrivs om. */
async function insatsavtryck(): Promise<string | null> {
  const { rows } = await pool.query<{ avtryck: string | null }>(
    `SELECT md5(string_agg(i::text, '|' ORDER BY i.id)) AS avtryck FROM insatser i WHERE i.tenant_id = $1`,
    [TENANT_ID],
  );
  return rows[0]?.avtryck ?? null;
}

const korProcess63 = promisify(execFile);

/**
 * T9: mätskriptet med kommandot ur dess huvud, `npx tsx src/scripts/matInsatskombinationer.ts`, som
 * barnprocess i repots rot (samma mönster som korMatskriptet i test/atagande-invarianter.test.ts).
 * Barnprocessen ärver testmiljöns DATABASE_URL, rollen app mot testdatabasen. DOTENV_CONFIG_PATH pekar
 * på en fil som inte finns, så att ingen .env kan rikta skriptet mot en annan databas. En
 * avslutningskod kastar inte.
 */
async function korInsatsmatningen(
  env: Record<string, string> = {},
): Promise<{ kod: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await korProcess63(
      path.join(ROT_63, 'node_modules', '.bin', 'tsx'),
      ['src/scripts/matInsatskombinationer.ts'],
      {
        cwd: ROT_63,
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: path.join(tmpdir(), 'insats-matning-finns-inte.env'),
          ...env,
        },
        timeout: 20_000,
      },
    );
    return { kod: 0, stdout, stderr };
  } catch (e) {
    const fel = e as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof fel.code !== 'number') throw e;
    return { kod: fel.code, stdout: fel.stdout ?? '', stderr: fel.stderr ?? '' };
  }
}

describe('FR-27/Story 6.3 AK 4: den läsande mätningen', () => {
  it('T7 (AK 4): mätningen listar exakt de fyra kombinationerna som tabellen avvisar, i insättningsordning', async () => {
    const agare = await adminKlient();
    try {
      for (const r of T7_RADER) {
        const kontrakt = r.kommando === undefined ? {} : { ...KONTRAKT, kommando: r.kommando };
        await agare.query(T7_INSERT, [TENANT_ID, r.stopp, r.typ, JSON.stringify(kontrakt)]);
      }
    } finally {
      await agare.end();
    }

    // Kontrollen är fallistan själv: de fyra raderna som tabellen godtar står i samma data, och exakt
    // likhet fäller en mätning som listar för mycket eller för lite.
    const fynd = await withTransaction((c) => insatsTjansten.matInsatskombinationer(c, TENANT_ID));
    expect(baraT7(fynd)).toEqual(T7_FYNDEN);
  });

  it('T8 (AK 4): mätningen i en READ ONLY-transaktion skriver ingenting, och dess kropp bara läser', async () => {
    const fore = { rader: await insatsrader(), avtryck: await insatsavtryck() };
    const fynd = await withTransaction(async (c) => {
      await c.query('SET TRANSACTION READ ONLY');
      return insatsTjansten.matInsatskombinationer(c, TENANT_ID);
    });
    expect(baraT7(fynd)).toEqual(T7_FYNDEN);
    expect({ rader: await insatsrader(), avtryck: await insatsavtryck() }).toEqual(fore);

    // Kontrollen: en skrivning i en likadan transaktion fälls av Postgres, så det är transaktionen
    // som hindrar skrivningen.
    await expect(
      withTransaction(async (c) => {
        await c.query('SET TRANSACTION READ ONLY');
        await c.query('UPDATE insatser SET uppdaterad = uppdaterad WHERE false');
      }),
    ).rejects.toMatchObject({ code: '25006' });

    // Statiskt: kroppen anropar predikatet och har inget av de tre skrivorden som hela ord.
    const kropp = kroppen63(readFileSync(INSATS_TS, 'utf8'), 'export async function matInsatskombinationer(');
    expect(kropp).toContain('kommandotTillats(');
    expect(kropp.match(/\b(?:INSERT|UPDATE|DELETE)\b/g)).toBeNull();
  });

  it('T9 (AK 4): skriptet skriver en rad per fynd och antalet, och ingenting i databasen', async () => {
    const hela = await withTransaction((c) => insatsTjansten.matInsatskombinationer(c, TENANT_ID));
    const fore = { rader: await insatsrader(), avtryck: await insatsavtryck() };
    const { kod, stdout, stderr } = await korInsatsmatningen();
    expect(kod, stderr).toBe(0);

    const rader = stdout.split('\n');
    expect(rader.pop()).toBe('');
    expect(rader.pop()).toBe(`Antal: ${hela.length}`);
    // Fyra fält åtskilda av tabbtecken; radbrytningen och tabben i ett fält skrivs som blanksteg, så
    // att fyndet med dem står på en rad.
    expect(rader.filter((r) => r.startsWith('T7:'))).toEqual([
      'T7:agarbeslut-utskick\tagarbeslut\tvantande\tredovisa_resultat',
      'T7:utathandling-provkommando\tutathandling\tvantande\tbesvara_beslut',
      'T7:agarbeslut-utan\tagarbeslut\tvantande\t(saknas)',
      'T7:agarbeslut-radbrytning\tagarbeslut\tvantande\tbeslutskoe --besvara 1',
    ]);
    expect({ rader: await insatsrader(), avtryck: await insatsavtryck() }).toEqual(fore);

    // Statiskt: transaktionen börjar med SET TRANSACTION READ ONLY, en gång och på en kodrad.
    const skript = utanKommentarsrader63(
      readFileSync(path.join(ROT_63, 'src', 'scripts', 'matInsatskombinationer.ts'), 'utf8'),
    );
    expect(skript.split('SET TRANSACTION READ ONLY').length - 1).toBe(1);

    // Kontroll: en mätning som inte kunde göras ser aldrig ut som noll fynd.
    const finnsInte = new URL(process.env.DATABASE_URL!);
    finnsInte.pathname = '/arenden_finns_inte';
    const fel = await korInsatsmatningen({ DATABASE_URL: finnsInte.toString() });
    expect(fel.kod, fel.stderr).toBe(1);
    expect(fel.stderr).toMatch(/^FATAL:/);
    expect(fel.stdout).not.toContain('Antal:');
  });
});

// ---- T10: README (krav → kod → test), efter mönstret i F11 ovan --------------------------------

const RUBRIKEN_63 = '### FR-27 — insatstypen styr vilka kommandon som får utföras (Story 6.3)';
const REGELNS_BORJAN_63 = '- Kommandotabellen (FR-27, B-09, Story 6.3):';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN_63 =
  '- Kommandotabellen (FR-27, B-09, Story 6.3): vilka kommandon en insatstyp får bära står i en enda ' +
  'sluten konstant, `KOMMANDOTABELL` i `src/services/insats.ts`, och prövas bara genom ' +
  '`kommandotTillats()`. `registreraInsats` anropar predikatet före varje skrivning och avvisar en ' +
  'otillåten kombination med 400 `otillatet_kommando`; en typ vars rad väntar godtar varje kommando ' +
  'tills raden förs in.';

/** Avsnittets gränser: från rubriken till nästa rad som börjar med '## ' eller '### '. */
function avsnittet63(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN_63);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/**
 * Fynden för T10: rubriken en gång och före Etapp 2a:s gränser, regelns rad exakt en gång och tre
 * tabellrader, var och en med provfilen.
 */
function readmefel63(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet63(rader);
  if (!granser) return ['rubriken saknas'];
  const fel: string[] = [];
  const rubriker = rader.filter((r) => r === RUBRIKEN_63).length;
  if (rubriker !== 1) fel.push(`rubriken står ${rubriker} gånger`);
  const etapp2a = rader.indexOf(GRANSER_2A);
  if (etapp2a === -1 || etapp2a < granser.start) fel.push(`rubriken står inte före ${GRANSER_2A}`);
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const regler = avsnitt.filter((r) => r.startsWith(REGELNS_BORJAN_63));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== REGELN_63) fel.push('regeln avviker');
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-27'));
  if (tabell.length !== 3) fel.push(`${tabell.length} rader börjar med | FR-27`);
  for (const r of tabell) if (!r.includes('test/insats.test.ts')) fel.push(`rad utan provfilen: ${r}`);
  return fel;
}

/** Texten utan avsnittet: raderna från rubriken till nästa rubrik på nivå två eller tre tas bort. */
function utanAvsnittet63(text: string): string {
  const rader = text.split('\n');
  const granser = avsnittet63(rader.map((r) => r.replace(/\r$/, '')));
  if (!granser) return text;
  return [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
}

describe('FR-27/Story 6.3: README bär regeln', () => {
  it('T10 (AK 1–4): avsnittet bär regeln och tre rader krav → kod → test', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readmefel63(readme)).toEqual([]);

    // Kontrollen: samma kontroll på texten utan avsnittet fälls.
    expect(readmefel63(utanAvsnittet63(readme))).toEqual(['rubriken saknas']);
  });
});
