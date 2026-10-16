import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg, { type PoolClient } from 'pg';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { hamtaArende, hamtaArendeForAndring } from '../src/services/arenden.js';
import { hamtaKommentar, hamtaKommentarForAndring } from '../src/services/kommentarer.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

/**
 * B-01 (FR-8, FR-29, FR-19): samtidiga rättelser loggar alltid det värde som
 * faktiskt ersattes. Transaktionerna är READ COMMITTED: en olåst SELECT före
 * en UPDATE på samma rad lät två samtidiga skrivningar läsa samma gamla värde,
 * och båda händelseraderna bar det. Proven här visar att läsningen före varje
 * rättelse är en låsande läsning — och att läsvägarna inte är det.
 *
 * Två slags fall. De deterministiska ("okommitterad ändring hos en annan
 * transaktion") ställer upp kapplöpningen för hand: ägarrollen ändrar raden
 * utan att committa, anropet startas och fastnar på låset, ägarrollen
 * committar. De är röda mot en olåst läsning varje gång. Tio-varvsfallen med
 * Promise.all är AK:s egna och bevisar ingenting ensamma — en kapplöpning utan
 * lås slår inte till i varje körning.
 */

interface Handelse {
  verb: string;
  payload: Record<string, unknown>;
  aktor_typ: string;
  aktor_namn: string;
}

const vanta = (ms: number): Promise<void> => new Promise((klar) => setTimeout(klar, ms));

/** Svaret, eller 'tidsgräns' om det inte kommit inom 2 s (mönstret för F15/F30). */
const svarInom = <T>(p: PromiseLike<T>): Promise<T | 'tidsgräns'> =>
  Promise.race([Promise.resolve(p), vanta(2_000).then(() => 'tidsgräns' as const)]);

/** Ägarrollen (postgres) — samma anslutning som i test/rattelser.test.ts. */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/**
 * Väntar tills någon backend i testdatabasen står och väntar på ett lås. Anropas
 * med en EGEN anslutning utan öppen transaktion: pg_stat_activity läses som en
 * ögonblicksbild per transaktion, så den klient som håller låset ser aldrig att
 * någon börjat vänta.
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

/** Ärendets händelser i insättningsordning (events.id), valfritt ett verb. */
async function handelserForArende(identifier: string, verb?: string): Promise<Handelse[]> {
  const { rows } = await pool.query<Handelse>(
    `SELECT e.verb, e.payload, e.aktor_typ, e.aktor_namn
       FROM events e JOIN issues i ON i.id = e.issue_id
       JOIN teams t ON t.id = i.team_id
      WHERE t.key || '-' || i.sequence_number = $1 AND ($2::text IS NULL OR e.verb = $2)
      ORDER BY e.id`,
    [identifier, verb ?? null],
  );
  return rows;
}

/** Kommentarens händelser i insättningsordning (events.id). */
async function handelserForKommentar(kommentarId: string): Promise<Handelse[]> {
  const { rows } = await pool.query<Handelse>(
    `SELECT e.verb, e.payload, e.aktor_typ, e.aktor_namn
       FROM events e
      WHERE e.payload->>'kommentar_id' = $1
      ORDER BY e.id`,
    [kommentarId],
  );
  return rows;
}

/**
 * Mönstret "okommitterad ändring hos en annan transaktion". Ägarrollen kör
 * `sql` i en öppen transaktion (och tar därmed radlåset), `anrop` startas och
 * ska fastna på låset, ägarrollen committar, och anropets utfall returneras.
 * Den olåsta läsningen hade skett innan anropet fastnade — därför är fallen
 * deterministiskt röda mot den.
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

/**
 * Mönstret "håll en egen transaktion öppen": `las` körs i en transaktion som
 * hålls öppen medan `prova` körs. Kastar `las` (t.ex. TypeError innan
 * funktionen finns) syns felet direkt i stället för som en tidsgräns.
 */
async function medEgenOppenTransaktion(
  las: (client: PoolClient) => Promise<unknown>,
  prova: () => Promise<void>,
): Promise<void> {
  let slapp!: () => void;
  const halls = new Promise<void>((r) => {
    slapp = r;
  });
  let markeraLast!: () => void;
  const harLast = new Promise<void>((r) => {
    markeraLast = r;
  });
  const tx = withTransaction(async (client) => {
    await las(client);
    markeraLast();
    await halls;
  });
  try {
    await Promise.race([harLast, tx]);
    await prova();
  } finally {
    slapp();
    await tx;
  }
}

let app: Express;
let agentnyckel: string;
let manniskonyckel: string;

async function nyttArende(titel: string, beskrivning?: string): Promise<{ identifier: string; id: string }> {
  const svar = await kor(app, agentnyckel, 'create_issue', {
    title: titel,
    team_key: 'LOC',
    ...(beskrivning === undefined ? {} : { description: beskrivning }),
  });
  expect(svar.status).toBe(200);
  return { identifier: svar.body.result.identifier as string, id: svar.body.result.id as string };
}

beforeAll(async () => {
  app = createApp();
  await seedaTeam();
  agentnyckel = await nyNyckel({ typ: 'agent', namn: 'samtidighetsagent' });
  manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'David' });
});

describe('B-01: hamtaArendeForAndring låser ärendet och läser det färskt', () => {
  it('F1 (AK 7): utan konkurrens ger den låsande läsningen samma rad som den olåsta', async () => {
    const { identifier } = await nyttArende('F1 samma rad', 'Beskrivning för F1.');
    const last = await withTransaction((c) => hamtaArendeForAndring(c, TENANT_ID, identifier));
    const olast = await withTransaction((c) => hamtaArende(c, TENANT_ID, identifier));
    expect(last).toEqual(olast);
    expect(last.identifier).toBe(identifier);
  });

  it('F2 (AK 10): ett okänt ärendenummer ger NotFoundError', async () => {
    await expect(
      withTransaction((c) => hamtaArendeForAndring(c, TENANT_ID, 'LOC-99999')),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('F3 (AK 7): funktionen tar radlåset — en annan anslutnings NOWAIT får 55P03', async () => {
    const { identifier, id } = await nyttArende('F3 låset tas');
    const agare = await adminKlient();
    try {
      await medEgenOppenTransaktion(
        (c) => hamtaArendeForAndring(c, TENANT_ID, identifier),
        async () => {
          await expect(
            agare.query('SELECT id FROM issues WHERE id = $1 FOR UPDATE NOWAIT', [id]),
          ).rejects.toMatchObject({ code: '55P03' });
        },
      );
      // Kontroll: den olåsta läsningen tar inget lås, så samma NOWAIT går igenom.
      // Utan den hade 55P03 ovan kunnat komma av något annat än funktionen.
      await medEgenOppenTransaktion(
        (c) => hamtaArende(c, TENANT_ID, identifier),
        async () => {
          await expect(
            agare.query('SELECT id FROM issues WHERE id = $1 FOR UPDATE NOWAIT', [id]),
          ).resolves.toBeDefined();
        },
      );
    } finally {
      await agare.end();
    }
  });

  it('F4 (AK 1/7): läsningen väntar in en okommitterad ändring och ger den committade raden, också i joinerna', async () => {
    const { identifier, id } = await nyttArende('F4 före');
    await pool.query(
      "INSERT INTO projects (tenant_id, namn) VALUES ($1, 'F4 projekt') ON CONFLICT DO NOTHING",
      [TENANT_ID],
    );
    const projekt = await pool.query<{ id: string }>(
      "SELECT id FROM projects WHERE tenant_id = $1 AND namn = 'F4 projekt'",
      [TENANT_ID],
    );
    // Ärenden skapas i backlog; det nya tillståndet är teamets 'started'.
    const tillstand = await pool.query<{ id: string; namn: string; typ: string }>(
      `SELECT id, namn, typ FROM workflow_states
        WHERE team_id = (SELECT team_id FROM issues WHERE id = $1) AND typ = 'started'
        LIMIT 1`,
      [id],
    );
    const nyttTillstand = tillstand.rows[0]!;
    const fore = await withTransaction((c) => hamtaArende(c, TENANT_ID, identifier));
    expect(fore.state_typ).not.toBe('started');
    expect(fore.projekt).toBeNull();

    const efter = await medOkommitteradAndring(
      'UPDATE issues SET title = $2, state_id = $3, project_id = $4 WHERE id = $1',
      [id, 'F4 efter', nyttTillstand.id, projekt.rows[0]!.id],
      () => withTransaction((c) => hamtaArendeForAndring(c, TENANT_ID, identifier)),
    );

    expect(efter.title).toBe('F4 efter');
    expect(efter.state_namn).toBe(nyttTillstand.namn);
    expect(efter.state_typ).toBe('started');
    expect(efter.projekt).toBe('F4 projekt');
  });
});

/** Det lagrade värdet, läst direkt ur tabellen — inte ur actionens svar. */
async function lagratArende(
  id: string,
): Promise<{ title: string; description: string; priority: number | null }> {
  const { rows } = await pool.query<{ title: string; description: string; priority: number | null }>(
    'SELECT title, description, priority FROM issues WHERE id = $1',
    [id],
  );
  return rows[0]!;
}

/**
 * Kedjekontrollen för tio-varvsfallen: raderna i events.id-ordning ska börja i
 * startvärdet, varje rads gamla värde ska vara föregående rads nya, och ingen
 * rad får ha gammalt lika med nytt. Returnerar kedjans slutvärde. Felet säger
 * vilket varv och vilken rad som bröt kedjan.
 */
function provaKedja(
  rader: Handelse[],
  start: unknown,
  gammaltVardeNyckel: string,
  nyttVardeNyckel: string,
  varv: number,
): unknown {
  let forvantat = start;
  rader.forEach((rad, i) => {
    expect(
      rad.payload[gammaltVardeNyckel],
      `varv ${varv}, rad ${i}: ${gammaltVardeNyckel} är inte det lagrade värdet`,
    ).toBe(forvantat);
    expect(
      rad.payload[nyttVardeNyckel],
      `varv ${varv}, rad ${i}: ${gammaltVardeNyckel} === ${nyttVardeNyckel}`,
    ).not.toBe(rad.payload[gammaltVardeNyckel]);
    forvantat = rad.payload[nyttVardeNyckel];
  });
  return forvantat;
}

describe('B-01/FR-29/FR-19: update_issue läser det värde som faktiskt ersätts', () => {
  // ---- Deterministiska fall: okommitterad ändring hos en annan transaktion --

  it('F5 (AK 1): titelrättelsen loggar det värde en annan transaktion just committat', async () => {
    const { identifier, id } = await nyttArende('A');
    const svar = await medOkommitteradAndring(
      'UPDATE issues SET title = $2 WHERE id = $1',
      [id, 'B'],
      () => kor(app, manniskonyckel, 'update_issue', { identifier, title: 'C' }),
    );
    expect(svar.status).toBe(200);
    const rader = await handelserForArende(identifier, 'andrade_titel');
    expect(rader).toHaveLength(1);
    expect(rader[0]!.payload['fran']).toBe('B');
    expect(rader[0]!.payload['till']).toBe('C');
    expect((await lagratArende(id)).title).toBe('C');
  });

  it('F6 (AK 2): samma titel som en annan transaktion just satt är ingen ändring', async () => {
    const { identifier, id } = await nyttArende('A');
    const svar = await medOkommitteradAndring(
      'UPDATE issues SET title = $2 WHERE id = $1',
      [id, 'B'],
      () => kor(app, manniskonyckel, 'update_issue', { identifier, title: 'B' }),
    );
    expect(svar.status).toBe(200);
    expect(svar.body.result.andringar).toEqual([]);
    expect(await handelserForArende(identifier, 'arendet_oforandrat')).toHaveLength(1);
    expect(await handelserForArende(identifier, 'andrade_titel')).toHaveLength(0);
    expect((await lagratArende(id)).title).toBe('B');
  });

  it('F7 (AK 3): beskrivningsrättelsen loggar den text en annan transaktion just committat', async () => {
    const { identifier, id } = await nyttArende('F7 beskrivning', 'X');
    const svar = await medOkommitteradAndring(
      'UPDATE issues SET description = $2 WHERE id = $1',
      [id, 'Y'],
      () => kor(app, manniskonyckel, 'update_issue', { identifier, description: 'Z' }),
    );
    expect(svar.status).toBe(200);
    const rader = await handelserForArende(identifier, 'rattade_beskrivning');
    expect(rader).toHaveLength(1);
    expect(rader[0]!.payload['gammal_text']).toBe('Y');
    expect(rader[0]!.payload['ny_text']).toBe('Z');
    expect(Object.hasOwn(rader[0]!.payload, 'fran')).toBe(false);
    expect(Object.hasOwn(rader[0]!.payload, 'till')).toBe(false);
    expect((await lagratArende(id)).description).toBe('Z');
  });

  it('F8 (AK 6): bara_om_osatt skriver inte över en prioritet som en annan transaktion just satt', async () => {
    const { identifier, id } = await nyttArende('F8 utan prioritet');
    expect((await lagratArende(id)).priority).toBeNull();
    const svar = await medOkommitteradAndring(
      'UPDATE issues SET priority = $2 WHERE id = $1',
      [id, 2],
      () => kor(app, agentnyckel, 'update_issue', { identifier, priority: 3, bara_om_osatt: true }),
    );
    expect(svar.status).toBe(200);
    expect(svar.body.result.andringar).toEqual([]);
    expect(await handelserForArende(identifier, 'arendet_oforandrat')).toHaveLength(1);
    expect(await handelserForArende(identifier, 'andrade_prioritet')).toHaveLength(0);
    expect((await lagratArende(id)).priority).toBe(2);
  });

  // ---- AK:s egna fall: Promise.all, tio varv ---------------------------------

  it('F9 (AK 1): två samtidiga titelrättelser bildar en obruten kedja, tio varv', async () => {
    for (let n = 0; n < 10; n++) {
      const { identifier, id } = await nyttArende('A');
      const svar = await Promise.all([
        kor(app, manniskonyckel, 'update_issue', { identifier, title: `B${n}` }),
        kor(app, agentnyckel, 'update_issue', { identifier, title: `C${n}` }),
      ]);
      expect(svar.map((s) => s.status), `varv ${n}`).toEqual([200, 200]);
      const rader = await handelserForArende(identifier, 'andrade_titel');
      expect(rader, `varv ${n}`).toHaveLength(2);
      expect(rader[0]!.payload['fran'], `varv ${n}`).toBe('A');
      const sist = provaKedja(rader, 'A', 'fran', 'till', n);
      expect((await lagratArende(id)).title, `varv ${n}`).toBe(sist);
      expect(new Set(rader.map((r) => r.payload['till'])), `varv ${n}`).toEqual(new Set([`B${n}`, `C${n}`]));
    }
  });

  it('F10 (AK 2): två samtidiga likadana titelrättelser ger en ändring och ett oförändrat, tio varv', async () => {
    for (let n = 0; n < 10; n++) {
      const { identifier, id } = await nyttArende('A');
      const svar = await Promise.all([
        kor(app, manniskonyckel, 'update_issue', { identifier, title: `B${n}` }),
        kor(app, agentnyckel, 'update_issue', { identifier, title: `B${n}` }),
      ]);
      expect(svar.map((s) => s.status), `varv ${n}`).toEqual([200, 200]);
      const rader = await handelserForArende(identifier, 'andrade_titel');
      expect(rader, `varv ${n}: fel antal andrade_titel`).toHaveLength(1);
      expect(rader[0]!.payload['fran'], `varv ${n}`).toBe('A');
      expect(rader[0]!.payload['till'], `varv ${n}`).toBe(`B${n}`);
      expect(await handelserForArende(identifier, 'arendet_oforandrat'), `varv ${n}`).toHaveLength(1);
      expect((await lagratArende(id)).title, `varv ${n}`).toBe(`B${n}`);
    }
  });

  it('F11 (AK 3): två samtidiga beskrivningsrättelser bildar en obruten kedja utan fran/till, tio varv', async () => {
    for (let n = 0; n < 10; n++) {
      const { identifier, id } = await nyttArende('F11 beskrivning', 'X');
      const svar = await Promise.all([
        kor(app, manniskonyckel, 'update_issue', { identifier, description: `Y${n}` }),
        kor(app, agentnyckel, 'update_issue', { identifier, description: `Z${n}` }),
      ]);
      expect(svar.map((s) => s.status), `varv ${n}`).toEqual([200, 200]);
      const rader = await handelserForArende(identifier, 'rattade_beskrivning');
      expect(rader, `varv ${n}`).toHaveLength(2);
      expect(rader[0]!.payload['gammal_text'], `varv ${n}`).toBe('X');
      const sist = provaKedja(rader, 'X', 'gammal_text', 'ny_text', n);
      expect((await lagratArende(id)).description, `varv ${n}`).toBe(sist);
      for (const rad of rader) {
        expect(Object.hasOwn(rad.payload, 'fran'), `varv ${n}`).toBe(false);
        expect(Object.hasOwn(rad.payload, 'till'), `varv ${n}`).toBe(false);
      }
    }
  });

  it('F12 (AK 6): två samtidiga bara_om_osatt ger exakt en prioritet och ett oförändrat, tio varv', async () => {
    for (let n = 0; n < 10; n++) {
      const { identifier, id } = await nyttArende('F12 utan prioritet');
      const svar = await Promise.all([
        kor(app, manniskonyckel, 'update_issue', { identifier, priority: 2, bara_om_osatt: true }),
        kor(app, agentnyckel, 'update_issue', { identifier, priority: 3, bara_om_osatt: true }),
      ]);
      expect(svar.map((s) => s.status), `varv ${n}`).toEqual([200, 200]);
      const rader = await handelserForArende(identifier, 'andrade_prioritet');
      expect(rader, `varv ${n}: fel antal andrade_prioritet`).toHaveLength(1);
      const lagrad = (await lagratArende(id)).priority;
      expect(rader[0]!.payload['fran'], `varv ${n}`).toBeNull();
      expect(rader[0]!.payload['till'], `varv ${n}`).toBe(lagrad);
      expect(await handelserForArende(identifier, 'arendet_oforandrat'), `varv ${n}`).toHaveLength(1);
    }
  });

  // ---- Regression ------------------------------------------------------------

  it('F13 (AK 6): bara_om_osatt skriver aldrig över ett satt värde — fem fält', async () => {
    await pool.query(
      "INSERT INTO projects (tenant_id, namn) VALUES ($1, 'F13 projekt 1'), ($1, 'F13 projekt 2') ON CONFLICT DO NOTHING",
      [TENANT_ID],
    );
    const foralder1 = (await nyttArende('F13 förälder 1')).identifier;
    const foralder2 = (await nyttArende('F13 förälder 2')).identifier;

    const fall: { falt: string; kolumn: string; forsta: unknown; andra: unknown }[] = [
      { falt: 'priority', kolumn: 'priority', forsta: 1, andra: 4 },
      { falt: 'due', kolumn: 'due_date', forsta: '2026-11-01', andra: '2026-12-01' },
      { falt: 'milstolpe', kolumn: 'milstolpe', forsta: 'F13 milstolpe 1', andra: 'F13 milstolpe 2' },
      { falt: 'parent', kolumn: 'foralder_identifier', forsta: foralder1, andra: foralder2 },
      { falt: 'projekt', kolumn: 'projekt', forsta: 'F13 projekt 1', andra: 'F13 projekt 2' },
    ];

    const lasFalt = async (identifier: string, kolumn: string): Promise<unknown> =>
      (await kor(app, agentnyckel, 'get_issue', { identifier })).body.result.arende[kolumn];
    const faltandringar = async (identifier: string): Promise<number> =>
      (await handelserForArende(identifier)).filter((h) => h.verb.startsWith('andrade_')).length;

    for (const f of fall) {
      const { identifier } = await nyttArende(`F13 ${f.falt}`);
      const satt = await kor(app, manniskonyckel, 'update_issue', { identifier, [f.falt]: f.forsta });
      expect(satt.status, f.falt).toBe(200);
      expect(await lasFalt(identifier, f.kolumn), f.falt).toBe(f.forsta);
      const foreAndringar = await faltandringar(identifier);

      const sparrad = await kor(app, agentnyckel, 'update_issue', {
        identifier,
        [f.falt]: f.andra,
        bara_om_osatt: true,
      });
      expect(sparrad.status, f.falt).toBe(200);
      expect(sparrad.body.result.andringar, f.falt).toEqual([]);
      expect((await handelserForArende(identifier)).at(-1)!.verb, f.falt).toBe('arendet_oforandrat');
      expect(await faltandringar(identifier), f.falt).toBe(foreAndringar);
      expect(await lasFalt(identifier, f.kolumn), f.falt).toBe(f.forsta);

      // Kontroll: utan spärren hade samma anrop ändrat värdet — det var alltså
      // en verklig ändring som spärren stoppade.
      const utan = await kor(app, agentnyckel, 'update_issue', { identifier, [f.falt]: f.andra });
      expect(utan.status, f.falt).toBe(200);
      expect(utan.body.result.andringar, f.falt).toHaveLength(1);
      expect(await lasFalt(identifier, f.kolumn), f.falt).toBe(f.andra);
    }
  });

  it('F14 (AK 6): ett angivet skäl står ordagrant i varje rad, och utan skäl saknas nyckeln', async () => {
    const S = 'Titeltaggen [Hermes] — bevis nivå 2, «ordagrant».';
    const { identifier } = await nyttArende('F14 med skäl');
    const fore = (await handelserForArende(identifier)).length;

    const forsta = await kor(app, agentnyckel, 'update_issue', {
      identifier,
      priority: 2,
      due: '2026-11-02',
      bara_om_osatt: true,
      skal: S,
    });
    expect(forsta.status).toBe(200);
    const nya = (await handelserForArende(identifier)).slice(fore);
    expect(nya.map((h) => h.verb)).toEqual(['andrade_prioritet', 'andrade_deadline']);
    for (const rad of nya) expect(rad.payload['skal'], rad.verb).toBe(S);

    const igen = await kor(app, agentnyckel, 'update_issue', {
      identifier,
      priority: 2,
      due: '2026-11-02',
      bara_om_osatt: true,
      skal: S,
    });
    expect(igen.status).toBe(200);
    const noop = (await handelserForArende(identifier)).slice(fore + 2);
    expect(noop.map((h) => h.verb)).toEqual(['arendet_oforandrat']);
    expect(noop[0]!.payload['skal']).toBe(S);

    const annat = (await nyttArende('F14 utan skäl')).identifier;
    const foreAnnat = (await handelserForArende(annat)).length;
    const utan = await kor(app, agentnyckel, 'update_issue', {
      identifier: annat,
      priority: 3,
      due: '2026-11-03',
    });
    expect(utan.status).toBe(200);
    const raderUtan = (await handelserForArende(annat)).slice(foreAnnat);
    expect(raderUtan.map((h) => h.verb)).toEqual(['andrade_prioritet', 'andrade_deadline']);
    for (const rad of raderUtan) expect(Object.hasOwn(rad.payload, 'skal'), rad.verb).toBe(false);
  });

  it('F15 (AK 7): get_issue och ärendesidan svarar medan en annan transaktion håller ärendets radlås', async () => {
    const { identifier, id } = await nyttArende('F15 läses under lås');
    const agare = await adminKlient();
    try {
      await agare.query('BEGIN');
      await agare.query('SELECT id FROM issues WHERE id = $1 FOR UPDATE', [id]);
      const [api, vy] = await Promise.all([
        svarInom(kor(app, agentnyckel, 'get_issue', { identifier }).then((r) => r.status)),
        svarInom(request(app).get(`/vy/arende/${identifier}`).then((r) => r.status)),
      ]);
      expect(api).toBe(200);
      expect(vy).toBe(200);

      // Kontroll: låset är verkligt — en skrivning på samma rad väntar.
      let klar = false;
      const skrivning = kor(app, manniskonyckel, 'update_issue', { identifier, priority: 1 }).then((r) => {
        klar = true;
        return r;
      });
      await vanta(500);
      expect(klar).toBe(false);
      await agare.query('ROLLBACK');
      expect((await skrivning).status).toBe(200);
    } finally {
      await agare.query('ROLLBACK').catch(() => undefined);
      await agare.end();
    }
  });

  it('F16 (AK 10): update_issue på ett okänt ärende ger 404 och skriver ingenting', async () => {
    const foreEvents = await raknaRader('events');
    const foreIssues = await raknaRader('issues');
    const svar = await kor(app, manniskonyckel, 'update_issue', {
      identifier: 'LOC-99999',
      title: 'Finns inte',
    });
    expect(svar.status).toBe(404);
    expect(svar.body.error).toBe('not_found');
    expect(await raknaRader('events')).toBe(foreEvents);
    expect(await raknaRader('issues')).toBe(foreIssues);

    // Kontroll: mot ett befintligt ärende ändras räkningen — den kan slå ut.
    const { identifier } = await nyttArende('F16 finns');
    const foreKontroll = await raknaRader('events');
    const ok = await kor(app, manniskonyckel, 'update_issue', { identifier, title: 'Finns inte' });
    expect(ok.status).toBe(200);
    expect(await raknaRader('events')).toBe(foreKontroll + 1);
  });
});

/** Ett nytt ärende med en kommentar, skriven med människonyckeln. */
async function nyKommentar(text: string): Promise<{ identifier: string; kommentarId: string }> {
  const { identifier } = await nyttArende('Ärende med kommentar');
  const svar = await kor(app, manniskonyckel, 'add_comment', { identifier, body: text });
  expect(svar.status).toBe(200);
  return { identifier, kommentarId: svar.body.result.id as string };
}

describe('B-01: hamtaKommentarForAndring låser kommentaren och läser den färskt', () => {
  it('F18 (AK 7): utan konkurrens ger den låsande läsningen samma rad som den olåsta', async () => {
    const { kommentarId } = await nyKommentar('F18 text');
    const last = await withTransaction((c) => hamtaKommentarForAndring(c, TENANT_ID, kommentarId));
    const olast = await withTransaction((c) => hamtaKommentar(c, TENANT_ID, kommentarId));
    expect(last).toEqual(olast);
    expect(last.body).toBe('F18 text');
  });

  it('F19 (AK 10): ett okänt kommentar-id ger NotFoundError', async () => {
    await expect(
      withTransaction((c) => hamtaKommentarForAndring(c, TENANT_ID, randomUUID())),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('F20 (AK 7): funktionen tar radlåset — en annan anslutnings NOWAIT får 55P03', async () => {
    const { kommentarId } = await nyKommentar('F20 text');
    const agare = await adminKlient();
    try {
      await medEgenOppenTransaktion(
        (c) => hamtaKommentarForAndring(c, TENANT_ID, kommentarId),
        async () => {
          await expect(
            agare.query('SELECT id FROM comments WHERE id = $1 FOR UPDATE NOWAIT', [kommentarId]),
          ).rejects.toMatchObject({ code: '55P03' });
        },
      );
      // Kontroll: den olåsta läsningen tar inget lås.
      await medEgenOppenTransaktion(
        (c) => hamtaKommentar(c, TENANT_ID, kommentarId),
        async () => {
          await expect(
            agare.query('SELECT id FROM comments WHERE id = $1 FOR UPDATE NOWAIT', [kommentarId]),
          ).resolves.toBeDefined();
        },
      );
    } finally {
      await agare.end();
    }
  });

  it('F21 (AK 4/7): läsningen väntar in en okommitterad ändring och ger den committade raden', async () => {
    const { kommentarId } = await nyKommentar('A');
    const efter = await medOkommitteradAndring(
      'UPDATE comments SET body = $2, borttagen = now() WHERE id = $1',
      [kommentarId, 'B'],
      () => withTransaction((c) => hamtaKommentarForAndring(c, TENANT_ID, kommentarId)),
    );
    expect(efter.body).toBe('B');
    expect(efter.borttagen).not.toBeNull();
  });
});

/** Kommentarsraden, läst direkt ur tabellen. */
async function lagradKommentar(
  kommentarId: string,
): Promise<{ body: string; aktor_typ: string; aktor_namn: string; borttagen: Date | null }> {
  const { rows } = await pool.query<{ body: string; aktor_typ: string; aktor_namn: string; borttagen: Date | null }>(
    'SELECT body, aktor_typ, aktor_namn, borttagen FROM comments WHERE id = $1',
    [kommentarId],
  );
  return rows[0]!;
}

/** Kommentarens händelser utom 'kommenterade' (som skrevs när den lades till). */
async function rattelserForKommentar(kommentarId: string): Promise<Handelse[]> {
  return (await handelserForKommentar(kommentarId)).filter((h) => h.verb !== 'kommenterade');
}

const antalMedVerb = (rader: Handelse[], verb: string): number => rader.filter((h) => h.verb === verb).length;

describe('B-01/FR-8: kommentarsvägarna läser det värde som faktiskt ersätts', () => {
  // ---- Deterministiska fall: okommitterad ändring hos en annan transaktion --

  it('F22 (AK 4): kommentarsrättelsen loggar den text en annan transaktion just committat', async () => {
    const { kommentarId } = await nyKommentar('A');
    const svar = await medOkommitteradAndring(
      'UPDATE comments SET body = $2 WHERE id = $1',
      [kommentarId, 'B'],
      () => kor(app, manniskonyckel, 'update_comment', { kommentar_id: kommentarId, body: 'C' }),
    );
    expect(svar.status).toBe(200);
    const rader = (await rattelserForKommentar(kommentarId)).filter((h) => h.verb === 'rattade_kommentar');
    expect(rader).toHaveLength(1);
    expect(rader[0]!.payload['gammal_text']).toBe('B');
    expect(rader[0]!.payload['ny_text']).toBe('C');
    expect((await lagradKommentar(kommentarId)).body).toBe('C');
  });

  it('F23 (AK 4): borttagningen bevarar den text och aktör kommentaren hade när den togs bort', async () => {
    const { kommentarId } = await nyKommentar('A');
    const svar = await medOkommitteradAndring(
      'UPDATE comments SET body = $2 WHERE id = $1',
      [kommentarId, 'B'],
      () => kor(app, manniskonyckel, 'delete_comment', { kommentar_id: kommentarId }),
    );
    expect(svar.status).toBe(200);
    expect(svar.body.result.andrad).toBe(true);
    const rad = await lagradKommentar(kommentarId);
    const rader = (await rattelserForKommentar(kommentarId)).filter((h) => h.verb === 'tog_bort_kommentar');
    expect(rader).toHaveLength(1);
    expect(rader[0]!.payload['gammal_text']).toBe('B');
    expect(rader[0]!.payload['gammal_aktor_typ']).toBe(rad.aktor_typ);
    expect(rader[0]!.payload['gammal_aktor_namn']).toBe(rad.aktor_namn);
  });

  it('F24 (AK 4): hann borttagningen först svarar rättelsen 404 och skriver ingenting', async () => {
    const { kommentarId } = await nyKommentar('A');
    const fore = await raknaRader('events');
    const svar = await medOkommitteradAndring(
      'UPDATE comments SET borttagen = now() WHERE id = $1',
      [kommentarId],
      () => kor(app, manniskonyckel, 'update_comment', { kommentar_id: kommentarId, body: 'C' }),
    );
    expect(svar.status).toBe(404);
    expect(svar.body.error).toBe('not_found');
    expect(await raknaRader('events')).toBe(fore);
    expect((await lagradKommentar(kommentarId)).body).toBe('A');
  });

  it('F25 (AK 5): en borttagning som en annan transaktion just gjort tas inte bort igen', async () => {
    const { kommentarId } = await nyKommentar('F25 synlig');
    const svar = await medOkommitteradAndring(
      'UPDATE comments SET borttagen = now() WHERE id = $1',
      [kommentarId],
      () => kor(app, manniskonyckel, 'delete_comment', { kommentar_id: kommentarId }),
    );
    expect(svar.status).toBe(200);
    expect(svar.body.result.andrad).toBe(false);
    const rader = await rattelserForKommentar(kommentarId);
    expect(rader.map((h) => h.verb)).toEqual(['kommentaren_var_redan_borttagen']);
    expect(antalMedVerb(rader, 'tog_bort_kommentar')).toBe(0);
  });

  it('F26 (AK 5): en återställning som en annan transaktion just gjort återställs inte igen', async () => {
    const { kommentarId } = await nyKommentar('F26 borttagen');
    expect((await kor(app, manniskonyckel, 'delete_comment', { kommentar_id: kommentarId })).status).toBe(200);
    const svar = await medOkommitteradAndring(
      'UPDATE comments SET borttagen = NULL WHERE id = $1',
      [kommentarId],
      () => kor(app, manniskonyckel, 'restore_comment', { kommentar_id: kommentarId }),
    );
    expect(svar.status).toBe(200);
    expect(svar.body.result.andrad).toBe(false);
    const rader = await rattelserForKommentar(kommentarId);
    expect(rader.map((h) => h.verb)).toEqual(['tog_bort_kommentar', 'kommentaren_var_inte_borttagen']);
    expect(antalMedVerb(rader, 'aterstallde_kommentar')).toBe(0);
  });

  // ---- AK:s egna fall: Promise.all, tio varv ---------------------------------

  it('F27 (AK 4): två samtidiga kommentarsrättelser bildar en obruten kedja, tio varv', async () => {
    for (let n = 0; n < 10; n++) {
      const { kommentarId } = await nyKommentar('A');
      const svar = await Promise.all([
        kor(app, manniskonyckel, 'update_comment', { kommentar_id: kommentarId, body: `B${n}` }),
        kor(app, manniskonyckel, 'update_comment', { kommentar_id: kommentarId, body: `C${n}` }),
      ]);
      expect(svar.map((s) => s.status), `varv ${n}`).toEqual([200, 200]);
      const rader = (await rattelserForKommentar(kommentarId)).filter((h) => h.verb === 'rattade_kommentar');
      expect(rader, `varv ${n}`).toHaveLength(2);
      expect(rader[0]!.payload['gammal_text'], `varv ${n}`).toBe('A');
      const sist = provaKedja(rader, 'A', 'gammal_text', 'ny_text', n);
      expect((await lagradKommentar(kommentarId)).body, `varv ${n}`).toBe(sist);
    }
  });

  it('F28 (AK 4): samtidig rättelse och borttagning ger ett av två hela utfall, tio varv', async () => {
    for (let n = 0; n < 10; n++) {
      const { kommentarId } = await nyKommentar('A');
      const [rattelse, borttagning] = await Promise.all([
        kor(app, manniskonyckel, 'update_comment', { kommentar_id: kommentarId, body: `B${n}` }),
        kor(app, manniskonyckel, 'delete_comment', { kommentar_id: kommentarId }),
      ]);
      expect(borttagning.status, `varv ${n}`).toBe(200);
      const rad = await lagradKommentar(kommentarId);
      const rader = await rattelserForKommentar(kommentarId);

      if (rattelse.status === 200) {
        // (i) Rättelsen hann först: borttagningen bär den rättade texten.
        expect(rader.map((h) => h.verb), `varv ${n}`).toEqual(['rattade_kommentar', 'tog_bort_kommentar']);
        expect(rader[0]!.payload['gammal_text'], `varv ${n}`).toBe('A');
        expect(rader[0]!.payload['ny_text'], `varv ${n}`).toBe(`B${n}`);
        expect(rader[1]!.payload['gammal_text'], `varv ${n}`).toBe(`B${n}`);
      } else {
        // (ii) Borttagningen hann först: rättelsen svarar 404 och skriver inget.
        expect(rattelse.status, `varv ${n}`).toBe(404);
        expect(rattelse.body.error, `varv ${n}`).toBe('not_found');
        expect(rader.map((h) => h.verb), `varv ${n}`).toEqual(['tog_bort_kommentar']);
        expect(rader[0]!.payload['gammal_text'], `varv ${n}`).toBe('A');
        expect(rad.body, `varv ${n}`).toBe('A');
      }
      const tog = rader.at(-1)!;
      expect(tog.payload['gammal_aktor_typ'], `varv ${n}`).toBe(rad.aktor_typ);
      expect(tog.payload['gammal_aktor_namn'], `varv ${n}`).toBe(rad.aktor_namn);
    }
  });

  it('F29 (AK 5): samtidiga borttagningar och återställningar ger en ändring och ett no-op var, tio varv', async () => {
    for (let n = 0; n < 10; n++) {
      const { kommentarId } = await nyKommentar(`F29 ${n}`);
      const borttagningar = await Promise.all([
        kor(app, manniskonyckel, 'delete_comment', { kommentar_id: kommentarId }),
        kor(app, manniskonyckel, 'delete_comment', { kommentar_id: kommentarId }),
      ]);
      expect(borttagningar.map((s) => s.status), `varv ${n}`).toEqual([200, 200]);
      let rader = await rattelserForKommentar(kommentarId);
      expect(antalMedVerb(rader, 'tog_bort_kommentar'), `varv ${n}`).toBe(1);
      expect(antalMedVerb(rader, 'kommentaren_var_redan_borttagen'), `varv ${n}`).toBe(1);

      const aterstallningar = await Promise.all([
        kor(app, manniskonyckel, 'restore_comment', { kommentar_id: kommentarId }),
        kor(app, manniskonyckel, 'restore_comment', { kommentar_id: kommentarId }),
      ]);
      expect(aterstallningar.map((s) => s.status), `varv ${n}`).toEqual([200, 200]);
      rader = await rattelserForKommentar(kommentarId);
      expect(antalMedVerb(rader, 'aterstallde_kommentar'), `varv ${n}`).toBe(1);
      expect(antalMedVerb(rader, 'kommentaren_var_inte_borttagen'), `varv ${n}`).toBe(1);
      expect(rader, `varv ${n}`).toHaveLength(4);
    }
  });

  // ---- Regression ------------------------------------------------------------

  it('F30 (AK 7): get_issue och ärendesidan svarar medan en annan transaktion håller kommentarens radlås', async () => {
    const text = 'F30 texten syns under låset';
    const { identifier, kommentarId } = await nyKommentar(text);
    const agare = await adminKlient();
    try {
      await agare.query('BEGIN');
      await agare.query('SELECT id FROM comments WHERE id = $1 FOR UPDATE', [kommentarId]);
      const [api, vy] = await Promise.all([
        svarInom(kor(app, agentnyckel, 'get_issue', { identifier }).then((r) => r)),
        svarInom(request(app).get(`/vy/arende/${identifier}`).then((r) => r)),
      ]);
      expect(api, 'get_issue väntade på låset').not.toBe('tidsgräns');
      expect(vy, 'ärendesidan väntade på låset').not.toBe('tidsgräns');
      if (api === 'tidsgräns' || vy === 'tidsgräns') return;
      expect(api.status).toBe(200);
      expect((api.body.result.kommentarer as { body: string }[]).map((k) => k.body)).toContain(text);
      expect(vy.status).toBe(200);
      expect(vy.text).toContain(text);

      // Kontroll: låset är verkligt — en rättelse av samma kommentar väntar.
      let klar = false;
      const skrivning = kor(app, manniskonyckel, 'update_comment', {
        kommentar_id: kommentarId,
        body: 'F30 rättad efter låset',
      }).then((r) => {
        klar = true;
        return r;
      });
      await vanta(500);
      expect(klar).toBe(false);
      await agare.query('ROLLBACK');
      expect((await skrivning).status).toBe(200);
    } finally {
      await agare.query('ROLLBACK').catch(() => undefined);
      await agare.end();
    }
  });

  it('F31 (AK 10): rättelse, borttagning och återställning av en okänd kommentar ger 404 och skriver ingenting', async () => {
    const okand = randomUUID();
    const foreEvents = await raknaRader('events');
    const foreComments = await raknaRader('comments');
    for (const [action, input] of [
      ['update_comment', { kommentar_id: okand, body: 'x' }],
      ['delete_comment', { kommentar_id: okand }],
      ['restore_comment', { kommentar_id: okand }],
    ] as const) {
      const svar = await kor(app, manniskonyckel, action, input);
      expect(svar.status, action).toBe(404);
      expect(svar.body.error, action).toBe('not_found');
    }
    expect(await raknaRader('events')).toBe(foreEvents);
    expect(await raknaRader('comments')).toBe(foreComments);

    // Kontroll: mot en befintlig kommentar ändras räkningen — den kan slå ut.
    const { kommentarId } = await nyKommentar('F31 finns');
    const foreKontroll = await raknaRader('events');
    const ok = await kor(app, manniskonyckel, 'update_comment', {
      kommentar_id: kommentarId,
      body: 'F31 ny text',
    });
    expect(ok.status).toBe(200);
    expect(await raknaRader('events')).toBe(foreKontroll + 1);
  });
});

describe('B-01: låsningen bor i två namngivna funktioner och anropas bara från skrivvägen', () => {
  it('F33 (AK 7): de låsande läsningarna anropas från exakt sex ställen, inget i src/http/', () => {
    const rot = fileURLToPath(new URL('../src', import.meta.url));
    const filer = readdirSync(rot, { recursive: true })
      .map(String)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => `src/${f.split(path.sep).join('/')}`)
      .sort();
    expect(filer, 'hittade inga källfiler').toContain('src/services/arenden.ts');

    const anrop: string[] = [];
    const forUpdateIHttp: string[] = [];
    for (const fil of filer) {
      const text = readFileSync(path.join(rot, fil.slice('src/'.length)), 'utf8');
      if (fil.startsWith('src/http/') && text.includes('FOR UPDATE')) forUpdateIHttp.push(fil);

      // Avsnitt: registret delas vid varje def({ (namnet är actionens name),
      // övriga filer vid varje export async function (namnet är funktionens).
      const arRegistret = fil === 'src/actions/registry.ts';
      const avsnitt = text.split(arRegistret ? 'def({' : 'export async function ');
      avsnitt.forEach((del, i) => {
        const namn =
          i === 0
            ? '(filhuvud)'
            : ((arRegistret ? /name:\s*'([^']+)'/.exec(del) : /^(\w+)/.exec(del))?.[1] ?? '(namnlöst)');
        // Avsnittets första rad är definitionen själv, inte ett anrop.
        const rader = del.split('\n').slice(i === 0 ? 0 : 1);
        for (const rad of rader) {
          const indragen = rad.trimStart();
          if (indragen.startsWith('//') || indragen.startsWith('/*') || indragen.startsWith('*')) continue;
          for (const m of rad.matchAll(/\bhamta(Arende|Kommentar)ForAndring\(/g)) {
            anrop.push(`${fil} · ${namn} · hamta${m[1]}ForAndring`);
          }
        }
      });
    }

    const forvantat = [
      'src/actions/registry.ts · delete_comment · hamtaKommentarForAndring',
      'src/actions/registry.ts · update_comment · hamtaKommentarForAndring',
      'src/services/arenden.ts · uppdateraArendeFalt · hamtaArendeForAndring',
      'src/services/kommentarer.ts · aterstallKommentar · hamtaKommentarForAndring',
      'src/services/kommentarer.ts · rattaKommentar · hamtaKommentarForAndring',
      'src/services/kommentarer.ts · taBortKommentar · hamtaKommentarForAndring',
    ];
    const ovantade = anrop.filter((a) => !forvantat.includes(a));
    const saknade = forvantat.filter((a) => !anrop.includes(a));
    expect(
      anrop.sort(),
      `oväntade anrop: ${ovantade.join('; ') || 'inga'} — saknade: ${saknade.join('; ') || 'inga'}`,
    ).toEqual(forvantat);
    expect(forUpdateIHttp, 'FOR UPDATE under src/http/').toEqual([]);
  });
});
