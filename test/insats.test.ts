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

const KONTRAKT = { system: 'hermes', kommando: 'besvara_beslut', objekt: '#153' };
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
