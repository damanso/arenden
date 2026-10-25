import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { hamtaEllerSkapaProjekt } from '../src/services/arenden.js';
import { hamtaKundkoppling, sattKundkoppling, type KopplingsVal } from '../src/services/kundkoppling.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

// K-4: kopplingen projekt -> kund.
//
// Provet mäter REGELN — "kopplingen bärs av ett id, aldrig av ett namn" — och
// inte de enskilda fel som redan hittats. Sista testet är den negativa
// kontrollen: samma påstående ställs mot den trasiga (namnmatchande) versionen,
// och den ska falla. Ett prov som inte kan fälla något mäter ingenting.

/** Redovisningens customers.id för Nordic Vision Retail AB i produktion. */
const NVR_KUND = '475842f4-8072-4bd9-9394-478817ca5af9';
const ILT_KUND = '92babad9-0a3d-4d13-9616-393c9887cd56';

/**
 * Satter ett arendes projekt DIREKT. Medvetet inte via update_issue: det
 * faltet hor till en annan story, och ett prov som lutar sig mot en
 * grannfunktion matter tva saker och sager inte vilken som gick sonder.
 */
async function sattProjekt(identifier: string, projekt: string): Promise<void> {
  await withTransaction(async (client) => {
    const projektId = await hamtaEllerSkapaProjekt(client, TENANT_ID, projekt);
    const [teamKey, nummer] = identifier.split('-');
    await client.query(
      `UPDATE issues i SET project_id = $1
         FROM teams t
        WHERE t.id = i.team_id AND i.tenant_id = $2 AND t.key = $3 AND i.sequence_number = $4`,
      [projektId, TENANT_ID, teamKey, Number(nummer)],
    );
  });
}

describe('K-4 kundkoppling', () => {
  let app: Express;
  let agentnyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    await withTransaction(async (client) => {
      for (const namn of ['NVR-001', 'ILT-Education', 'Hermes']) {
        await hamtaEllerSkapaProjekt(client, TENANT_ID, namn);
      }
    });
  });

  // ---- regeln ---------------------------------------------------------------

  it('startläget är oavgjord — inte "ingen kund"', async () => {
    const k = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'ILT-Education'));
    // Skillnaden är hela poängen: "vi vet inte än" är inte samma sak som
    // "hör inte till någon kund". Ett fält som betyder båda ljuger tyst.
    expect(k?.koppling_status).toBe('oavgjord');
    expect(k?.kund_id).toBeNull();
  });

  it('en koppling bärs av ett id och en källa', async () => {
    const svar = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'NVR-001',
      status: 'kopplad',
      kund_id: NVR_KUND,
      kund_kalla: 'redovisning',
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.andrad).toBe(true);

    const k = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'NVR-001'));
    expect(k?.kund_id).toBe(NVR_KUND);
    expect(k?.koppling_status).toBe('kopplad');
    // Ett id utan sitt system är inte ett id.
    expect(k?.kund_kalla).toBe('redovisning');
    expect(k?.kund_kopplad_at).not.toBeNull();
  });

  it('kopplad KRÄVER ett id, och intern FÖRBJUDER ett', async () => {
    const utan = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'ILT-Education',
      status: 'kopplad',
    });
    expect(utan.status).toBe(400);

    const bade = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'ILT-Education',
      status: 'intern',
      kund_id: ILT_KUND,
    });
    expect(bade.status).toBe(400);

    // Ingen av de avvisade anropen fick lämna något efter sig.
    const k = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'ILT-Education'));
    expect(k?.koppling_status).toBe('oavgjord');
    expect(k?.kund_id).toBeNull();
  });

  it('ett okänt projektnamn blir 404 — aldrig ett nytt projekt', async () => {
    const fore = await pool.query('SELECT count(*)::int AS n FROM projects');
    const svar = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'Projekt som inte finns',
      status: 'intern',
    });
    expect(svar.status).toBe(404);
    const efter = await pool.query('SELECT count(*)::int AS n FROM projects');
    expect(efter.rows[0].n).toBe(fore.rows[0].n);
  });

  it('databasen håller regeln även om någon går förbi koden', async () => {
    // Constraint-nivån, inte bara tjänstelagret: ett halvfyllt par ska vara
    // omöjligt att lägga in med rå SQL också.
    await expect(
      pool.query(
        `UPDATE projects SET koppling_status = 'kopplad', kund_id = NULL, kund_kalla = NULL
          WHERE tenant_id = $1 AND namn = 'Hermes'`,
        [TENANT_ID],
      ),
    ).rejects.toThrow(/projects_koppling_komplett_check/);

    await expect(
      pool.query(
        `UPDATE projects SET koppling_status = 'kopplad', kund_id = $2,
                             kund_kalla = 'redovisning', kund_kopplad_at = now()
          WHERE tenant_id = $1 AND namn = 'Hermes'`,
        [TENANT_ID, NVR_KUND],
      ),
    ).resolves.toBeTruthy();

    // Städa upp efter oss: Hermes ska vara internt när nästa test kör.
    await withTransaction((c) => sattKundkoppling(c, TENANT_ID, 'Hermes', { status: 'intern' }));
  });

  // ---- KRAV-10: aktören ur nyckeln, händelsen i samma transaktion ----------

  it('KRAV-10: kopplingen lämnar en händelserad med aktören ur NYCKELN', async () => {
    const davidsnyckel = await nyNyckel({ typ: 'manniska', namn: 'david' });
    await kor(app, davidsnyckel, 'set_project_customer', {
      projekt: 'ILT-Education',
      status: 'kopplad',
      kund_id: ILT_KUND,
      kund_kalla: 'redovisning',
    });

    const { rows } = await pool.query(
      `SELECT aktor_typ, aktor_namn, verb, payload FROM events
        WHERE verb = 'andrade_kundkoppling' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0].aktor_typ).toBe('manniska');
    expect(rows[0].aktor_namn).toBe('david');
    expect(rows[0].payload.efter.kund_id).toBe(ILT_KUND);
    expect(rows[0].payload.fore.kund_id).toBeNull();
  });

  it('KRAV-10: aktören kan inte sättas ur indata', async () => {
    const svar = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'ILT-Education',
      status: 'intern',
      aktor_namn: 'david',
    });
    // .strict() — okända fält avvisas, de ignoreras inte.
    expect(svar.status).toBe(400);
  });

  // ---- åt andra hållet: från kunden till ärendena ---------------------------

  it('K-4 baklänges: kundens id ger kundens ärenden', async () => {
    await withTransaction((c) =>
      sattKundkoppling(c, TENANT_ID, 'NVR-001', {
        status: 'kopplad',
        kund_id: NVR_KUND,
        kund_kalla: 'redovisning',
      }),
    );
    const skapat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Leverans av butiksdata',
      team_key: 'LOC',
    });
    await sattProjekt(skapat.body.result.identifier, 'NVR-001');

    const traff = await kor(app, agentnyckel, 'list_issues', { kund_id: NVR_KUND });
    expect(traff.status).toBe(200);
    expect(traff.body.result.arenden.map((a: { identifier: string }) => a.identifier)).toContain(
      skapat.body.result.identifier,
    );

    // En annan kunds id ger inte det här ärendet.
    const bom = await kor(app, agentnyckel, 'list_issues', { kund_id: ILT_KUND });
    expect(bom.body.result.arenden.map((a: { identifier: string }) => a.identifier)).not.toContain(
      skapat.body.result.identifier,
    );
  });

  // ---- negativ kontroll ----------------------------------------------------

  it('NEGATIV KONTROLL: samma påstående fäller den namnmatchande versionen', async () => {
    // Påståendet som ska gälla: ett INTERNT projekt knyts aldrig till en
    // organisation. Hermes är internt.
    await withTransaction((c) => sattKundkoppling(c, TENANT_ID, 'Hermes', { status: 'intern' }));

    // (1) Den riktiga regeln — id:t avgör.
    const riktig = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'Hermes'));
    expect(riktig?.kund_id).toBeNull();

    // (2) Den TRASIGA versionen: exakt namnmatchning projekt -> organisation.
    // Mängden nedan är organisationsnamnen som de faktiskt ser ut i
    // redovisningen i dag — inklusive den arkiverade, tomma posten "Hermes".
    const ORGANISATIONER = new Set([
      'Hermes',
      'NVR-001',
      'ILT-Education',
      'Synologen AB',
      'IAMAI AB',
    ]);
    const namnmatchning = (projekt: string): string | null =>
      ORGANISATIONER.has(projekt) ? projekt : null;

    // Samma påstående, ställt mot den trasiga versionen: den FALLER. Hade
    // plattformen matchat på namn hade 33 Hermes-ärenden knutits till en
    // arkiverad post med noll interaktioner och noll personer.
    expect(namnmatchning('Hermes')).not.toBeNull();

    // Och provet är inte en tautologi: för ett projekt som VERKLIGEN har en
    // kund ger båda vägarna svar — skillnaden ligger just i fallgropen.
    const nvr = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'NVR-001'));
    expect(nvr?.kund_id).toBe(NVR_KUND);
    expect(namnmatchning('NVR-001')).not.toBeNull();
  });
});

// ---- FR-26/Story 6.1: källan krävs och källbytet är en ändring (B-08, B-01) -----
//
// Fallen nedan rör inte projekten NVR-001, ILT-Education och Hermes ovan. Varje fall skapar
// egna projekt med prefixet KK<n>, eftersom fallen i filen delar databasen.

/** Repots rot: källtexten läses därifrån (KK8, KK10). */
const ROT = fileURLToPath(new URL('..', import.meta.url));

/** Tre kund-id i samma form som NVR_KUND. Inget av dem finns i någon annan provfil. */
const K1 = '3f6c1d2e-8a4b-4c5d-9e6f-0a1b2c3d4e5f';
const K2 = '7b8a9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const ANNAN = 'd4c3b2a1-0f9e-4d8c-b7a6-958473625140';

const KOPPLINGSVERB = ['andrade_kundkoppling', 'kundkoppling_oforandrad'];

/**
 * Källor som schemat godtar (minst ett tecken, inga förbjudna kontrolltecken) men som inte namnger
 * något system: blanktecken, tabb och radbrytningar, NBSP, U+3000, U+2028 och de osynliga
 * formattecknen U+FEFF, U+200B och U+200E, ensamma och blandade.
 */
const BLANKA_KALLOR = [
  ' ',
  '   ',
  '\t',
  '\n',
  '\r\n',
  ' \t\r\n ',
  ' ',
  '　',
  ' ',
  '﻿',
  '​',
  '‎',
  ' ​ ﻿\t',
];

interface Kopplingsrad {
  kund_id: string | null;
  kund_kalla: string | null;
  koppling_status: string;
  kund_kopplad_at: string | null;
}

interface Kopplingshandelse {
  id: string;
  verb: string;
  payload: {
    projekt_id: string;
    projekt: string;
    fore: Record<string, unknown>;
    efter: Record<string, unknown>;
  };
}

/** Skapar projektet (startläget oavgjord) och ger dess id. */
async function nyttProjekt(namn: string): Promise<string> {
  return withTransaction((c) => hamtaEllerSkapaProjekt(c, TENANT_ID, namn));
}

/** Projektets kopplingskolumner som de står i databasen; tiden som text, så att två läsningar kan jämföras. */
async function kopplingsrad(namn: string): Promise<Kopplingsrad> {
  const { rows } = await pool.query<Kopplingsrad>(
    `SELECT kund_id, kund_kalla, koppling_status, kund_kopplad_at::text AS kund_kopplad_at
       FROM projects WHERE tenant_id = $1 AND namn = $2`,
    [TENANT_ID, namn],
  );
  const rad = rows[0];
  if (!rad) throw new Error(`projektet ${namn} finns inte`);
  return rad;
}

/** Projektets händelserader för kopplingen, i insättningsordning (events.id). */
async function kopplingshandelser(projektId: string): Promise<Kopplingshandelse[]> {
  const { rows } = await pool.query<Kopplingshandelse>(
    `SELECT id, verb, payload FROM events
      WHERE verb = ANY ($1::text[]) AND payload->>'projekt_id' = $2
      ORDER BY id`,
    [KOPPLINGSVERB, projektId],
  );
  return rows;
}

/** Ägarrollen (postgres). Avskriven ur test/samtidighet.test.ts (Story 1.1). */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/** Avskriven ur test/samtidighet.test.ts (Story 1.1). */
const vanta = (ms: number): Promise<void> => new Promise((klar) => setTimeout(klar, ms));

/** Svaret, eller 'tidsgräns' om det inte kommit inom 2 s. Avskriven ur test/samtidighet.test.ts (Story 1.1). */
const svarInom = <T>(p: PromiseLike<T>): Promise<T | 'tidsgräns'> =>
  Promise.race([Promise.resolve(p), vanta(2_000).then(() => 'tidsgräns' as const)]);

/**
 * Väntar tills någon backend i testdatabasen står och väntar på ett lås. Anropas med en EGEN
 * anslutning utan öppen transaktion. Avskriven ur test/samtidighet.test.ts (Story 1.1).
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

/** Raderna utan kommentarsrader (som börjar med //, /* eller * efter blanktecken). */
function utanKommentarer(text: string): string[] {
  return text.split('\n').filter((rad) => !/^\s*(\/\/|\/\*|\*)/.test(rad));
}

/** En funktions kropp: från raden som exporterar den till nästa rad som börjar med "export ". null = saknas. */
function kropp(rader: string[], namn: string): string | null {
  const start = rader.findIndex(
    (rad) => rad.startsWith(`export async function ${namn}(`) || rad.startsWith(`export function ${namn}(`),
  );
  if (start === -1) return null;
  const slut = rader.findIndex((rad, i) => i > start && rad.startsWith('export '));
  return rader.slice(start, slut === -1 ? rader.length : slut).join('\n');
}

/**
 * B-01 och B-08 i källtexten för src/services/kundkoppling.ts: skrivvägen läser med radlås,
 * läsvägen utan, och ingen standardkälla står i valet eller skrivningen. Fynden är fasta texter.
 */
function kopplingsfel(text: string): string[] {
  const rader = utanKommentarer(text);
  const satt = kropp(rader, 'sattKundkoppling') ?? '';
  const lasande = kropp(rader, 'hamtaProjektForAndring');
  const olast = kropp(rader, 'hamtaKundkoppling') ?? '';
  const prova = kropp(rader, 'provaKopplingsVal') ?? '';
  const fynd: string[] = [];
  if (!satt.includes('hamtaProjektForAndring(')) fynd.push('hamtaProjektForAndring( saknas i sattKundkoppling');
  if (satt.includes('hamtaKundkoppling(')) fynd.push('sattKundkoppling läser olåst');
  if (lasande === null || !lasande.includes('FOR UPDATE')) fynd.push('FOR UPDATE saknas i hamtaProjektForAndring');
  if (olast.includes('FOR UPDATE')) fynd.push('hamtaKundkoppling låser');
  for (const [namn, funktion] of [['sattKundkoppling', satt], ['provaKopplingsVal', prova]] as const) {
    if (funktion.includes('redovisning')) fynd.push(`en standardkälla står i ${namn}`);
  }
  return fynd;
}

/** Den korta rätta filen för kontrollerna i KK8: de fyra funktionerna och inget mer. */
const KORT_RATT = [
  'export async function hamtaKundkoppling(client, tenantId, projekt) {',
  "  return client.query('SELECT namn FROM projects');",
  '}',
  'export async function hamtaProjektForAndring(client, tenantId, projekt) {',
  "  return client.query('SELECT namn FROM projects FOR UPDATE');",
  '}',
  'export function provaKopplingsVal(val) {',
  "  if (val.kund_kalla === undefined) throw new Error('kalla_saknas');",
  '  return { kund_kalla: val.kund_kalla };',
  '}',
  'export async function sattKundkoppling(client, tenantId, projekt, val) {',
  '  // En kommentarsrad som nämner hamtaKundkoppling( och redovisning räknas inte.',
  '  const fore = await hamtaProjektForAndring(client, tenantId, projekt);',
  '  return { fore, varden: provaKopplingsVal(val) };',
  '}',
].join('\n');

describe('FR-26/Story 6.1 AK 1: källan krävs, och ingen standardkälla fylls i', () => {
  let app: Express;
  let agentnyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  it('KK1 (AK 1): kopplad utan kund_kalla, eller med en källa av bara blanka eller osynliga tecken, avvisas med kalla_saknas och lämnar noll rader', async () => {
    await nyttProjekt('KK1-projekt');
    const rakning = await raknaRader('events');
    const fore = await kopplingsrad('KK1-projekt');

    // (a) fältet utelämnat.
    const utelamnad = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK1-projekt',
      status: 'kopplad',
      kund_id: K1,
    });
    expect(utelamnad.status).toBe(400);
    expect(utelamnad.body.error).toBe('kalla_saknas');
    expect(await raknaRader('events')).toBe(rakning);
    expect(await kopplingsrad('KK1-projekt')).toEqual(fore);

    // (b) fältet null.
    const nollvarde = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK1-projekt',
      status: 'kopplad',
      kund_id: K1,
      kund_kalla: null,
    });
    expect(nollvarde.status).toBe(400);
    expect(nollvarde.body.error).toBe('kalla_saknas');
    expect(await raknaRader('events')).toBe(rakning);
    expect(await kopplingsrad('KK1-projekt')).toEqual(fore);

    // (c) tjänsten direkt, förbi registret: regeln bor i tjänstelagret, inte i schemat.
    await expect(
      withTransaction((c) => sattKundkoppling(c, TENANT_ID, 'KK1-projekt', { status: 'kopplad', kund_id: K1 })),
    ).rejects.toMatchObject({ code: 'kalla_saknas' });
    expect(await kopplingsrad('KK1-projekt')).toEqual(fore);

    // (d) en källa som schemat godtar men som inte är något system: bara blanktecken, radbrytningar
    // eller osynliga formattecken. Var och en är ett id utan system och avvisas som en saknad källa.
    for (const blank of BLANKA_KALLOR) {
      const namn = `(d) ${JSON.stringify(blank)}`;
      const svar = await kor(app, agentnyckel, 'set_project_customer', {
        projekt: 'KK1-projekt',
        status: 'kopplad',
        kund_id: K1,
        kund_kalla: blank,
      });
      expect(svar.status, namn).toBe(400);
      expect(svar.body.error, namn).toBe('kalla_saknas');
      expect(await raknaRader('events'), namn).toBe(rakning);
      expect(await kopplingsrad('KK1-projekt'), namn).toEqual(fore);
    }

    // (e) tjänsten direkt med en tom och en blank källa, förbi schemats min(1).
    for (const blank of ['', '   ']) {
      await expect(
        withTransaction((c) =>
          sattKundkoppling(c, TENANT_ID, 'KK1-projekt', { status: 'kopplad', kund_id: K1, kund_kalla: blank }),
        ),
        `(e) ${JSON.stringify(blank)}`,
      ).rejects.toMatchObject({ code: 'kalla_saknas' });
      expect(await kopplingsrad('KK1-projekt')).toEqual(fore);
    }

    // Kontroll: samma anrop som (a), med källan. Det skiljer sig bara i källan och går igenom.
    const med = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK1-projekt',
      status: 'kopplad',
      kund_id: K1,
      kund_kalla: 'redovisning',
    });
    expect(med.status).toBe(200);
    expect(await raknaRader('events')).toBe(rakning + 1);
    expect(await kopplingsrad('KK1-projekt')).toMatchObject({
      kund_id: K1,
      kund_kalla: 'redovisning',
      koppling_status: 'kopplad',
    });
  });
});

describe('FR-26/Story 6.1 AK 2: källbytet är en ändring, och samma värden igen är det inte', () => {
  let app: Express;
  let agentnyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  it('KK2 (AK 2): fore och efter bär id, källa och läge; källbytet loggas och no-op:en rör ingenting', async () => {
    const projektId = await nyttProjekt('KK2-projekt');

    // (1) Den första kopplingen.
    const forsta = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK2-projekt',
      status: 'kopplad',
      kund_id: K1,
      kund_kalla: 'redovisning',
    });
    expect(forsta.status).toBe(200);
    expect(forsta.body.result.andrad).toBe(true);

    // (2) Samma id, en annan källa.
    const byte = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK2-projekt',
      status: 'kopplad',
      kund_id: K1,
      kund_kalla: 'annat-system',
    });
    expect(byte.status).toBe(200);
    expect(byte.body.result.andrad).toBe(true);
    const efterByte = await kopplingsrad('KK2-projekt');

    // (3) Exakt samma värden som (2): ingen ändring, och tidsstämpeln står kvar.
    const igen = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK2-projekt',
      status: 'kopplad',
      kund_id: K1,
      kund_kalla: 'annat-system',
    });
    expect(igen.status).toBe(200);
    expect(igen.body.result.andrad).toBe(false);
    expect((await kopplingsrad('KK2-projekt')).kund_kopplad_at).toBe(efterByte.kund_kopplad_at);

    const rader = await kopplingshandelser(projektId);
    expect(rader.map((r) => r.verb)).toEqual([
      'andrade_kundkoppling',
      'andrade_kundkoppling',
      'kundkoppling_oforandrad',
    ]);
    const [r1, r2] = rader;
    expect(r1!.payload.fore).toEqual({ kund_id: null, kund_kalla: null, koppling_status: 'oavgjord' });
    expect(r1!.payload.efter).toEqual({ kund_id: K1, kund_kalla: 'redovisning', koppling_status: 'kopplad' });
    expect(r2!.payload.fore.kund_kalla).toBe('redovisning');
    expect(r2!.payload.efter.kund_kalla).toBe('annat-system');
    expect(r2!.payload.fore.kund_id).toBe(K1);
    expect(r2!.payload.efter.kund_id).toBe(K1);
    for (const rad of rader) {
      expect(Object.keys(rad.payload.fore).sort(), `fore i ${rad.id}`).toEqual([
        'koppling_status',
        'kund_id',
        'kund_kalla',
      ]);
      expect(Object.keys(rad.payload.efter).sort(), `efter i ${rad.id}`).toEqual([
        'koppling_status',
        'kund_id',
        'kund_kalla',
      ]);
    }
  });

  it('KK11 (AK 2): samma koppling i en annan skrivform är ingen ändring, och andrad är att raden skrevs', async () => {
    const projektId = await nyttProjekt('KK11-projekt');
    const LAGRAD = { kund_id: K1, kund_kalla: 'redovisning', koppling_status: 'kopplad' };
    const forsta = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK11-projekt',
      status: 'kopplad',
      kund_id: K1,
      kund_kalla: 'redovisning',
    });
    expect(forsta.status).toBe(200);
    const lagrad = await kopplingsrad('KK11-projekt');
    expect(lagrad).toMatchObject(LAGRAD);

    // Genom API:t: skrivformer som schemat godtar. Var och en är samma koppling som den lagrade.
    const BLANDAT = '3F6C1D2E-8a4b-4C5D-9e6f-0a1B2c3D4e5F';
    expect(BLANDAT.toLowerCase()).toBe(K1);
    const viaApi: [string, string, string][] = [
      ['(a) id:t i versaler', K1.toUpperCase(), 'redovisning'],
      ['(b) id:t i blandat skiftläge', BLANDAT, 'redovisning'],
      ['(c) källan med blanka kanter', K1, ' redovisning\t'],
      ['(d) källan med osynliga kanter', K1, '​redovisning﻿ '],
      ['(e) id:t i versaler och källan med kanter', K1.toUpperCase(), '\nredovisning '],
    ];
    for (const [namn, kundId, kalla] of viaApi) {
      const antal = (await kopplingshandelser(projektId)).length;
      const svar = await kor(app, agentnyckel, 'set_project_customer', {
        projekt: 'KK11-projekt',
        status: 'kopplad',
        kund_id: kundId,
        kund_kalla: kalla,
      });
      expect(svar.status, namn).toBe(200);
      expect(svar.body.result.andrad, namn).toBe(false);
      expect(svar.body.result.fore, namn).toEqual(LAGRAD);
      expect(svar.body.result.efter, namn).toEqual(LAGRAD);
      // Raden är orörd, också kund_kopplad_at: ingen skrivning bakom en oförändrad händelserad.
      expect(await kopplingsrad('KK11-projekt'), namn).toEqual(lagrad);
      const nya = (await kopplingshandelser(projektId)).slice(antal);
      expect(nya.map((r) => r.verb), namn).toEqual(['kundkoppling_oforandrad']);
      expect(nya[0]?.payload.efter, namn).toEqual(LAGRAD);
    }

    // Tjänsten direkt: skrivformer som schemat avvisar men som Postgres läser som samma uuid.
    const viaTjansten: [string, string][] = [
      ['(f) id:t med klamrar', `{${K1}}`],
      ['(g) id:t utan bindestreck', K1.replace(/-/g, '')],
      ['(h) id:t med klamrar och i versaler', `{${K1.toUpperCase()}}`],
      ['(i) id:t med blanka kanter', ` ${K1}\n`],
    ];
    for (const [namn, kundId] of viaTjansten) {
      const resultat = await withTransaction((c) =>
        sattKundkoppling(c, TENANT_ID, 'KK11-projekt', { status: 'kopplad', kund_id: kundId, kund_kalla: 'redovisning' }),
      );
      expect(resultat.andrad, namn).toBe(false);
      expect(resultat.efter, namn).toEqual(LAGRAD);
      expect(await kopplingsrad('KK11-projekt'), namn).toEqual(lagrad);
    }

    // Kontroll 1: samma anrop i gemener, alltså exakt det lagrade, är också en no-op.
    const gemener = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK11-projekt',
      status: 'kopplad',
      kund_id: K1,
      kund_kalla: 'redovisning',
    });
    expect(gemener.status).toBe(200);
    expect(gemener.body.result.andrad).toBe(false);
    expect(await kopplingsrad('KK11-projekt')).toEqual(lagrad);

    // Kontroll 2: mätningen kan slå ut. Ett annat id i versaler, som skiljer sig från (a) bara i id:t,
    // är en ändring: raden skrivs med id:t i gemener och en ny tidsstämpel.
    const annat = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK11-projekt',
      status: 'kopplad',
      kund_id: K2.toUpperCase(),
      kund_kalla: 'redovisning',
    });
    expect(annat.status).toBe(200);
    expect(annat.body.result.andrad).toBe(true);
    expect(annat.body.result.efter).toEqual({ kund_id: K2, kund_kalla: 'redovisning', koppling_status: 'kopplad' });
    const efterAnnat = await kopplingsrad('KK11-projekt');
    expect(efterAnnat).toMatchObject({ kund_id: K2, kund_kalla: 'redovisning', koppling_status: 'kopplad' });
    expect(efterAnnat.kund_kopplad_at).not.toBe(lagrad.kund_kopplad_at);

    // Kontroll 3: tillbaka till K1 genom tjänsten, med klamrar och versaler, är också en ändring,
    // och fore/efter står i lagrad form, så kedjan i historiken går att följa.
    const tillbaka = await withTransaction((c) =>
      sattKundkoppling(c, TENANT_ID, 'KK11-projekt', {
        status: 'kopplad',
        kund_id: `{${K1.toUpperCase()}}`,
        kund_kalla: 'redovisning',
      }),
    );
    expect(tillbaka.andrad).toBe(true);
    expect(tillbaka.fore).toEqual({ kund_id: K2, kund_kalla: 'redovisning', koppling_status: 'kopplad' });
    expect(tillbaka.efter).toEqual(LAGRAD);
    expect(await kopplingsrad('KK11-projekt')).toMatchObject(LAGRAD);
  });
});

describe('FR-26/Story 6.1 AK 3: tre lägen och inga halvfyllda par', () => {
  let app: Express;
  let agentnyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  it('KK3 (AK 3): varje halvfyllt val avvisas med 400, sin kod och noll rader', async () => {
    await nyttProjekt('KK3-projekt');
    const rakning = await raknaRader('events');
    const fore = await kopplingsrad('KK3-projekt');

    const fall: [string, Record<string, unknown>, string][] = [
      ['(a) intern med kund_id', { status: 'intern', kund_id: K1 }, 'kund_id_utan_koppling'],
      ['(b) intern med kund_kalla', { status: 'intern', kund_kalla: 'redovisning' }, 'kalla_utan_koppling'],
      ['(c) oavgjord med kund_id', { status: 'oavgjord', kund_id: ANNAN }, 'kund_id_utan_koppling'],
      ['(d) oavgjord med kund_kalla', { status: 'oavgjord', kund_kalla: 'redovisning' }, 'kalla_utan_koppling'],
      [
        '(e) kopplad med ett namn som kund_id',
        { status: 'kopplad', kund_id: 'Nordic Vision Retail AB', kund_kalla: 'redovisning' },
        'validation_error',
      ],
      ['(f) kopplad med källa men utan kund_id', { status: 'kopplad', kund_kalla: 'redovisning' }, 'kund_id_saknas'],
      // En blank källa är ingen källa, men fältet är angivet: det avvisas och ignoreras aldrig tyst.
      ['(g) intern med en blank kund_kalla', { status: 'intern', kund_kalla: ' ' }, 'kalla_utan_koppling'],
      ['(h) oavgjord med en osynlig kund_kalla', { status: 'oavgjord', kund_kalla: '​\n' }, 'kalla_utan_koppling'],
    ];
    for (const [namn, val, kod] of fall) {
      const svar = await kor(app, agentnyckel, 'set_project_customer', { projekt: 'KK3-projekt', ...val });
      expect(svar.status, namn).toBe(400);
      expect(svar.body.error, namn).toBe(kod);
      expect(await raknaRader('events'), namn).toBe(rakning);
      expect(await kopplingsrad('KK3-projekt'), namn).toEqual(fore);
    }

    // Tjänsten direkt, förbi schemats uuid-kontroll: ett tomt eller blankt kund_id är inget id.
    const tjanstfall: [string, KopplingsVal, string][] = [
      ['(i) kopplad med ett tomt kund_id', { status: 'kopplad', kund_id: '', kund_kalla: 'redovisning' }, 'kund_id_saknas'],
      ['(j) kopplad med ett blankt kund_id', { status: 'kopplad', kund_id: ' \t​', kund_kalla: 'redovisning' }, 'kund_id_saknas'],
      ['(k) intern med ett blankt kund_id', { status: 'intern', kund_id: ' ' }, 'kund_id_utan_koppling'],
    ];
    for (const [namn, val, kod] of tjanstfall) {
      await expect(
        withTransaction((c) => sattKundkoppling(c, TENANT_ID, 'KK3-projekt', val)),
        namn,
      ).rejects.toMatchObject({ code: kod });
      expect(await kopplingsrad('KK3-projekt'), namn).toEqual(fore);
    }

    // Kontroll: intern utan id och källa skiljer sig från (a) och (b) bara i fälten, och går igenom.
    const intern = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK3-projekt',
      status: 'intern',
    });
    expect(intern.status).toBe(200);
    expect(await raknaRader('events')).toBe(rakning + 1);
  });

  it('KK4 (AK 3): ägarrollens UPDATE som lämnar ett halvfyllt par fälls av CHECK-villkoret', async () => {
    await nyttProjekt('KK4-kopplat');
    const kopplat = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'KK4-kopplat',
      status: 'kopplad',
      kund_id: K1,
      kund_kalla: 'redovisning',
    });
    expect(kopplat.status).toBe(200);
    await nyttProjekt('KK4-oavgjort');
    const foreKopplat = await kopplingsrad('KK4-kopplat');
    const foreOavgjort = await kopplingsrad('KK4-oavgjort');

    const agare = await adminKlient();
    try {
      const satser: [string, string][] = [
        [
          '(a) källan borttagen, id:t kvar',
          `UPDATE projects SET kund_kalla = NULL WHERE tenant_id = $1 AND namn = 'KK4-kopplat'`,
        ],
        [
          '(b) intern med id och källa kvar',
          `UPDATE projects SET koppling_status = 'intern' WHERE tenant_id = $1 AND namn = 'KK4-kopplat'`,
        ],
        [
          '(c) källa utan id på ett oavgjort projekt',
          `UPDATE projects SET kund_kalla = 'redovisning' WHERE tenant_id = $1 AND namn = 'KK4-oavgjort'`,
        ],
      ];
      for (const [namn, sats] of satser) {
        await expect(agare.query(sats, [TENANT_ID]), namn).rejects.toMatchObject({
          code: '23514',
          message: expect.stringContaining('projects_koppling_komplett_check'),
        });
      }

      // Kontroll: ett komplett par godtas av samma roll, i en transaktion som rullas tillbaka.
      await agare.query('BEGIN');
      const komplett = await agare.query(
        `UPDATE projects SET koppling_status = 'kopplad', kund_id = $2, kund_kalla = 'redovisning',
                             kund_kopplad_at = now()
          WHERE tenant_id = $1 AND namn = 'KK4-oavgjort'`,
        [TENANT_ID, K2],
      );
      expect(komplett.rowCount).toBe(1);
      await agare.query('ROLLBACK');
    } finally {
      await agare.query('ROLLBACK').catch(() => undefined);
      await agare.end();
    }
    expect(await kopplingsrad('KK4-kopplat')).toEqual(foreKopplat);
    expect(await kopplingsrad('KK4-oavgjort')).toEqual(foreOavgjort);
  });
});

const VARV = Array.from({ length: 10 }, (_, i) => i + 1);

describe('FR-26/Story 6.1 AK 7: samtidiga kopplingar loggar det som faktiskt ersattes (B-01)', () => {
  let app: Express;
  let agentnyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  /** Kopplar projektet genom API:t och kräver att det gick. */
  async function koppla(projekt: string, kundId: string, kalla: string): Promise<void> {
    const svar = await kor(app, agentnyckel, 'set_project_customer', {
      projekt,
      status: 'kopplad',
      kund_id: kundId,
      kund_kalla: kalla,
    });
    expect(svar.status, `${projekt}: ${JSON.stringify(svar.body)}`).toBe(200);
  }

  it('KK5 (AK 7): anropet väntar på radlåset och loggar värdet som den andra transaktionen committade', async () => {
    const projektId = await nyttProjekt('KK5-projekt');
    await koppla('KK5-projekt', K1, 'redovisning');
    const anrop = () =>
      kor(app, agentnyckel, 'set_project_customer', {
        projekt: 'KK5-projekt',
        status: 'kopplad',
        kund_id: K1,
        kund_kalla: 'tredje-system',
      });

    const x = await adminKlient();
    const vakt = await adminKlient();
    try {
      await x.query('BEGIN');
      await x.query('SELECT id FROM projects WHERE tenant_id = $1 AND namn = $2 FOR UPDATE', [
        TENANT_ID,
        'KK5-projekt',
      ]);
      await x.query(`UPDATE projects SET kund_kalla = 'annat-system' WHERE tenant_id = $1 AND namn = $2`, [
        TENANT_ID,
        'KK5-projekt',
      ]);
      // supertest skickar ingenting förrän .then anropas (mönstret i test/samtidighet.test.ts).
      const pagaende = anrop().then((r) => r);
      pagaende.catch(() => undefined);
      await vantaTillsNagonVantarPaLas(vakt);
      await x.query('COMMIT');

      const svar = await pagaende;
      expect(svar.status).toBe(200);
      expect(svar.body.result.andrad).toBe(true);
      const sista = (await kopplingshandelser(projektId)).at(-1);
      expect(sista?.verb).toBe('andrade_kundkoppling');
      // Läsningen skedde EFTER låset: fore är det X committade, inte det som stod före X.
      expect(sista?.payload.fore.kund_kalla).toBe('annat-system');
      expect(sista?.payload.efter.kund_kalla).toBe('tredje-system');

      // Kontroll: samma anrop igen, när ingen håller låset, svarar genast och ändrar ingenting.
      const igen = await svarInom(anrop().then((r) => r));
      expect(igen).not.toBe('tidsgräns');
      expect(igen === 'tidsgräns' ? null : igen.body.result.andrad).toBe(false);
    } finally {
      await x.query('ROLLBACK').catch(() => undefined);
      await x.end();
      await vakt.end();
    }
  });

  it.each(VARV)('KK6 (AK 7): två anrop med samma nya värden ger en ändring och en no-op, varv %i', async (varv) => {
    const namn = `KK6-${varv}`;
    const projektId = await nyttProjekt(namn);
    await koppla(namn, K1, 'redovisning');
    const antal = (await kopplingshandelser(projektId)).length;

    const nytt = { projekt: namn, status: 'kopplad', kund_id: K2, kund_kalla: 'redovisning' };
    const svar = await Promise.all([
      kor(app, agentnyckel, 'set_project_customer', nytt),
      kor(app, agentnyckel, 'set_project_customer', nytt),
    ]);
    expect(svar.map((s) => s.status)).toEqual([200, 200]);

    const nya = (await kopplingshandelser(projektId)).slice(antal);
    expect(nya.map((r) => r.verb).sort()).toEqual(['andrade_kundkoppling', 'kundkoppling_oforandrad']);
    expect(await kopplingsrad(namn)).toMatchObject({
      kund_id: K2,
      kund_kalla: 'redovisning',
      koppling_status: 'kopplad',
    });
  });

  it.each(VARV)('KK7 (AK 7): två anrop med olika källor bildar en obruten kedja, varv %i', async (varv) => {
    const namn = `KK7-${varv}`;
    const projektId = await nyttProjekt(namn);
    await koppla(namn, K1, 'redovisning');
    const antal = (await kopplingshandelser(projektId)).length;

    const svar = await Promise.all([
      kor(app, agentnyckel, 'set_project_customer', {
        projekt: namn,
        status: 'kopplad',
        kund_id: K1,
        kund_kalla: 'kalla-a',
      }),
      kor(app, agentnyckel, 'set_project_customer', {
        projekt: namn,
        status: 'kopplad',
        kund_id: K1,
        kund_kalla: 'kalla-b',
      }),
    ]);
    expect(svar.map((s) => s.status)).toEqual([200, 200]);

    const nya = (await kopplingshandelser(projektId)).slice(antal);
    expect(nya.map((r) => r.verb)).toEqual(['andrade_kundkoppling', 'andrade_kundkoppling']);
    const [forsta, andra] = nya;
    expect(forsta?.payload.fore).toEqual({ kund_id: K1, kund_kalla: 'redovisning', koppling_status: 'kopplad' });
    expect(forsta?.payload.efter).toEqual(andra?.payload.fore);
    const lagrad = await kopplingsrad(namn);
    expect(andra?.payload.efter).toEqual({
      kund_id: lagrad.kund_id,
      kund_kalla: lagrad.kund_kalla,
      koppling_status: lagrad.koppling_status,
    });
  });

  it('KK8 (AK 7, AK 1): skrivvägen läser med radlås, läsvägen utan, och ingen standardkälla står i koden', () => {
    // Kontroller först, på påhittade källtexter: varje form ger exakt sina fynd.
    expect(kopplingsfel(KORT_RATT)).toEqual([]);
    expect(
      kopplingsfel(
        KORT_RATT.replace(
          'await hamtaProjektForAndring(client, tenantId, projekt);',
          'await hamtaKundkoppling(client, tenantId, projekt);',
        ),
      ),
    ).toEqual(['hamtaProjektForAndring( saknas i sattKundkoppling', 'sattKundkoppling läser olåst']);
    expect(kopplingsfel(KORT_RATT.replace(' FOR UPDATE', ''))).toEqual([
      'FOR UPDATE saknas i hamtaProjektForAndring',
    ]);
    expect(kopplingsfel(KORT_RATT.replace("FROM projects');", "FROM projects FOR UPDATE');"))).toEqual([
      'hamtaKundkoppling låser',
    ]);
    expect(
      kopplingsfel(
        KORT_RATT.replace(
          'return { kund_kalla: val.kund_kalla };',
          "return { kund_kalla: val.kund_kalla ?? 'redovisning' };",
        ),
      ),
    ).toEqual(['en standardkälla står i provaKopplingsVal']);

    const kalla = readFileSync(path.join(ROT, 'src', 'services', 'kundkoppling.ts'), 'utf8');
    expect(kopplingsfel(kalla)).toEqual([]);
  });
});

/** Katalogens främmande nycklar på projects vars kolumner innehåller kund_id. */
const FRAMMANDE_NYCKLAR_PA_KUND_ID = `
  SELECT c.conname FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
   WHERE c.conrelid = 'projects'::regclass AND c.contype = 'f' AND a.attname = 'kund_id'
   ORDER BY 1`;

describe('FR-26/Story 6.1 AK 5: kund_id är oberoende av redovisningens databas', () => {
  it('KK9 (AK 5): kund_id på projects har ingen främmande nyckel', async () => {
    const { rows } = await pool.query<{ conname: string }>(FRAMMANDE_NYCKLAR_PA_KUND_ID);
    expect(rows.map((r) => r.conname)).toEqual([]);

    // Kontroll: med en främmande nyckel på kolumnen ger samma fråga exakt den. Rullas tillbaka.
    const agare = await adminKlient();
    try {
      await agare.query('BEGIN');
      const utan = await agare.query<{ conname: string }>(FRAMMANDE_NYCKLAR_PA_KUND_ID);
      expect(utan.rows.map((r) => r.conname)).toEqual([]);
      await agare.query(
        'ALTER TABLE projects ADD CONSTRAINT kk9_kontroll FOREIGN KEY (kund_id) REFERENCES tenants(id) NOT VALID',
      );
      const med = await agare.query<{ conname: string }>(FRAMMANDE_NYCKLAR_PA_KUND_ID);
      expect(med.rows.map((r) => r.conname)).toEqual(['kk9_kontroll']);
      await agare.query('ROLLBACK');
    } finally {
      await agare.query('ROLLBACK').catch(() => undefined);
      await agare.end();
    }
  });
});

/**
 * AK 6 i kopplingsskriptets text: det anropar inte set_project_customer, och dess tre utfall står
 * kvar (utfallsraden exakt en gång, KUNDE_INTE returneras). Fynden är fasta texter.
 */
function skriptfel(text: string): string[] {
  const fynd: string[] = [];
  const anrop = text.split('set_project_customer').length - 1;
  if (anrop > 0) fynd.push(`set_project_customer står ${anrop} gånger`);
  const utfallsrader = text.split('\n').filter((rad) => rad.trim() === 'GRON, ROD, KUNDE_INTE = 0, 1, 2').length;
  if (utfallsrader !== 1) fynd.push(`utfallsraden står ${utfallsrader} gånger`);
  if (!text.includes('return KUNDE_INTE')) fynd.push('KUNDE_INTE returneras inte');
  return fynd;
}

describe('FR-26/Story 6.1 AK 6: repots kopplingsskript följer kontraktet', () => {
  it('KK10 (AK 6): scripts/prov_kundkoppling.py anropar inte set_project_customer, och utfallen står kvar', () => {
    const skript = readFileSync(path.join(ROT, 'scripts', 'prov_kundkoppling.py'), 'utf8');
    expect(skriptfel(skript)).toEqual([]);

    // Kontroll: samma text med ett anrop av actionen tillagt sist ger exakt det fyndet.
    const medAnrop = `${skript}\nurlopen(BAS + "/api/actions/set_project_customer", data)\n`;
    expect(skriptfel(medAnrop)).toEqual(['set_project_customer står 1 gånger']);
  });
});
