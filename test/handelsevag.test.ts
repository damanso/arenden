import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { pool } from '../src/db/pool.js';
import { kor, nyNyckel } from './helpers.js';

const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));

/**
 * K-10: tre vägar förbi händelseloggen.
 *
 * Väg 1 — `arendehem.py` satte project_id med rå SQL som superuser. Sexton
 *   ärenden ändrades den vägen och INGEN händelserad i hela loggen säger att
 *   ett ärende bytt projekt. Fixen är inte att skriva om historien, den är att
 *   plattformen får en egen skrivväg för fältet så att skriptet kan sluta gå
 *   förbi.
 * Väg 2 — `skapaNyckel.ts` mintade nycklar utan händelse. Löst i K-1 (78293f7);
 *   verifieras i test/rattelser.test.ts, byggs inte om här.
 * Väg 3 — 186 av 207 kommentarer saknade händelserad. De kom in via importen.
 *   Raderna backfylls ALDRIG; vägen framåt stängs.
 *
 * Och "varför": ingen payload bar ett skäl. Nu kan en ändring bära ett, men
 * bara när anroparen anger det — och bara nya rader.
 */
describe('K-10: skrivvägen förbi händelseloggen är stängd', () => {
  let app: Express;
  let nyckel: string;
  let arende: string;

  beforeAll(async () => {
    app = createApp();
    await importeraArkiv(FIXTURER);
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes-prov' });
    const skapat = await kor(app, nyckel, 'create_issue', {
      title: 'Ärende som ska byta projekt',
      team_key: 'LOC',
    });
    arende = skapat.body.result.identifier;
  });

  async function handelser(identifier: string, verb: string): Promise<
    { verb: string; payload: Record<string, unknown>; aktor_typ: string; aktor_namn: string }[]
  > {
    const { rows } = await pool.query(
      `SELECT e.verb, e.payload, e.aktor_typ, e.aktor_namn
         FROM events e JOIN issues i ON i.id = e.issue_id
         JOIN teams t ON t.id = i.team_id
        WHERE t.key || '-' || i.sequence_number = $1 AND e.verb = $2
        ORDER BY e.id`,
      [identifier, verb],
    );
    return rows;
  }

  // ---- Väg 1: projektet är ett fält i plattformen, inte rå SQL -------------

  it('K-10.1: update_issue sätter projektet OCH skriver andrade_projekt med fran/till', async () => {
    const projekt = await pool.query<{ namn: string }>('SELECT namn FROM projects ORDER BY namn LIMIT 1');
    const namn = projekt.rows[0]!.namn;

    const svar = await kor(app, nyckel, 'update_issue', { identifier: arende, projekt: namn });
    expect(svar.status).toBe(200);
    expect(svar.body.result.arende.projekt).toBe(namn);

    const rader = await handelser(arende, 'andrade_projekt');
    expect(rader).toHaveLength(1);
    expect(rader[0]!.payload).toMatchObject({ falt: 'projekt', fran: null, till: namn });
    // Aktören kommer ur nyckeln — aldrig ur indatat.
    expect(rader[0]!.aktor_typ).toBe('agent');
    expect(rader[0]!.aktor_namn).toBe('hermes-prov');
  });

  it('K-10.1: ett okänt projektnamn ger 404 och SKAPAR INGET projekt', async () => {
    const fore = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM projects');
    const svar = await kor(app, nyckel, 'update_issue', {
      identifier: arende,
      projekt: 'Projekt som inte finns',
    });
    expect(svar.status).toBe(404);
    const efter = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM projects');
    // Hade vägen skapat projektet hade ett stavfel i en titeltagg blivit en ny
    // rad i registret i stället för ett fel.
    expect(efter.rows[0]!.n).toBe(fore.rows[0]!.n);
  });

  it('K-10.1: projektet går att nollställa, och nollställningen får också en rad', async () => {
    const svar = await kor(app, nyckel, 'update_issue', { identifier: arende, projekt: null });
    expect(svar.status).toBe(200);
    expect(svar.body.result.arende.projekt).toBeNull();
    const rader = await handelser(arende, 'andrade_projekt');
    expect(rader).toHaveLength(2);
    expect(rader[1]!.payload).toMatchObject({ falt: 'projekt', till: null });
  });
});

describe('K-10: "varför" — skälet är frivilligt, men det bärs', () => {
  let app: Express;
  let nyckel: string;
  let arende: string;

  beforeAll(async () => {
    app = createApp();
    await importeraArkiv(FIXTURER);
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes-skal' });
    const skapat = await kor(app, nyckel, 'create_issue', {
      title: 'Ärende för skälet',
      team_key: 'LOC',
    });
    arende = skapat.body.result.identifier;
  });

  async function sistaPayload(identifier: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT e.payload FROM events e JOIN issues i ON i.id = e.issue_id
         JOIN teams t ON t.id = i.team_id
        WHERE t.key || '-' || i.sequence_number = $1
        ORDER BY e.id DESC LIMIT 1`,
      [identifier],
    );
    return rows[0]!.payload;
  }

  it('skälet hamnar i payloaden när det anges', async () => {
    const svar = await kor(app, nyckel, 'update_issue', {
      identifier: arende,
      priority: 2,
      skal: 'Deadline flyttades av kunden på mötet 26 augusti.',
    });
    expect(svar.status).toBe(200);
    expect(await sistaPayload(arende)).toMatchObject({
      falt: 'priority',
      skal: 'Deadline flyttades av kunden på mötet 26 augusti.',
    });
  });

  it('payloaden bär INGET skal-fält när skäl inte anges — inte null, inte tom sträng', async () => {
    await kor(app, nyckel, 'update_issue', { identifier: arende, priority: 3 });
    const payload = await sistaPayload(arende);
    // Ett "skal": null på varenda rad hade sett ut som ett besvarat fält med
    // tomt svar, och lärt läsaren att hoppa över fältet.
    expect(Object.hasOwn(payload, 'skal')).toBe(false);
  });

  it('skälet gäller även no-op-raden arendet_oforandrat', async () => {
    await kor(app, nyckel, 'update_issue', {
      identifier: arende,
      priority: 3,
      skal: 'Kontrollerade att den redan var satt.',
    });
    expect(await sistaPayload(arende)).toMatchObject({
      skal: 'Kontrollerade att den redan var satt.',
    });
  });

  it('skalet ar fritext med samma sparrar som all annan fritext', async () => {
    // safeText() avvisar C0-kontrolltecken. NUL i jsonb hade annars blivit
    // ett omappat databasfel — alltsa en 500 i stallet for ett begripligt 400.
    const medNul = await kor(app, nyckel, 'update_issue', {
      identifier: arende,
      priority: 4,
      skal: `ett${String.fromCharCode(0)}skal`,
    });
    expect(medNul.status).toBe(400);

    const ok = await kor(app, nyckel, 'update_issue', {
      identifier: arende,
      priority: 4,
      skal: 'ett giltigt skal med mellanslag',
    });
    expect(ok.status).toBe(200);
  });
});

describe('K-10.3: varje NY kommentar får sin händelserad', () => {
  let app: Express;
  let nyckel: string;

  beforeAll(async () => {
    app = createApp();
    nyckel = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  /**
   * MÄTNINGEN, ordagrant den som körs mot produktionen i
   * ~/.hermes/prov/handelsevag.py: en kommentar räknas som spårad när NÅGON
   * händelserad namnger just den kommentarens id i sin payload. Verbet spelar
   * ingen roll — `kommenterade` (skrivvägen) och `importerade_kommentar`
   * (importen) duger båda. Att räkna verb i stället för koppling hade varit att
   * mäta en proxy igen.
   */
  async function utanHandelserad(): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM comments c
        WHERE NOT EXISTS (
          SELECT 1 FROM events e
           WHERE e.issue_id = c.issue_id
             AND e.payload->>'kommentar_id' = c.id::text)`,
    );
    return Number(rows[0]!.n);
  }

  async function rakna(sql: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(sql);
    return Number(rows[0]!.n);
  }

  it('importen: varje importerad kommentar har en rad, och en omkorning ger noll nya', async () => {
    await importeraArkiv(FIXTURER);

    const kommentarer = await rakna(
      'SELECT count(*)::text AS n FROM comments WHERE source_ref IS NOT NULL',
    );
    const rader = await rakna(
      "SELECT count(*)::text AS n FROM events WHERE verb = 'importerade_kommentar'",
    );
    expect(kommentarer).toBeGreaterThan(0);
    expect(rader).toBe(kommentarer);
    expect(await utanHandelserad()).toBe(0);

    // KRAV-16: omkorningen ar idempotent — det galler nu aven i events.
    const andra = await importeraArkiv(FIXTURER);
    expect(andra.nya_kommentarer).toBe(0);
    expect(
      await rakna("SELECT count(*)::text AS n FROM events WHERE verb = 'importerade_kommentar'"),
    ).toBe(rader);
    expect(await utanHandelserad()).toBe(0);
  });

  it('skrivvägen: add_comment ger kommentaren en rad som namnger den', async () => {
    const skapat = await kor(app, nyckel, 'create_issue', {
      title: 'Ärende att kommentera',
      team_key: 'LOC',
    });
    const svar = await kor(app, nyckel, 'add_comment', {
      identifier: skapat.body.result.identifier,
      body: 'En kommentar som ska synas i loggen.',
    });
    expect(svar.status).toBe(200);
    expect(await utanHandelserad()).toBe(0);
  });

  /**
   * NEGATIV KONTROLL — utan den bevisar mätningen ovan ingenting.
   *
   * En kommentar som smugits in vid sidan av skrivvägen (rå INSERT, precis som
   * `arendehem.py` gjorde med project_id) MÅSTE få talet att stiga. Faller inte
   * den här mätningen på en förbismugen rad är noll-siffran ovan bara ett
   * påstående om att vi inte tittade.
   */
  it('NEGATIV KONTROLL: en rå INSERT förbi skrivvägen får mätningen att FÄLLA', async () => {
    expect(await utanHandelserad()).toBe(0);

    const { rows } = await pool.query<{ id: string }>('SELECT id FROM issues LIMIT 1');
    await pool.query(
      `INSERT INTO comments (tenant_id, issue_id, body, aktor_typ, aktor_namn)
       SELECT tenant_id, $1, 'smugen förbi skrivvägen', 'agent', 'smygaren'
         FROM issues WHERE id = $1`,
      [rows[0]!.id],
    );

    expect(await utanHandelserad()).toBe(1);
  });
});

describe('K-10.1: NEGATIV KONTROLL — rå SQL förbi plattformen syns i mätningen', () => {
  let app: Express;
  let nyckel: string;

  beforeAll(async () => {
    app = createApp();
    await importeraArkiv(FIXTURER);
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes-drift' });
  });

  /**
   * SPÄRRKLINKAN, samma regel som ~/.hermes/prov/handelsevag.py kör mot
   * produktionen: ta en ögonblicksbild av (ärende → projekt); varje ärende vars
   * projekt SEDAN skiljer sig från bilden måste ha en `andrade_projekt`-rad
   * yngre än bilden. Utan rad = ändringen gick förbi loggen.
   *
   * Regeln säger ingenting om historiska rader och kräver inget backfill: den
   * mäter bara ändringar som sker EFTER att bilden togs.
   */
  async function bild(): Promise<Map<string, string | null>> {
    const { rows } = await pool.query<{ id: string; project_id: string | null }>(
      'SELECT id, project_id FROM issues',
    );
    return new Map(rows.map((r) => [r.id, r.project_id]));
  }

  async function osparadeAndringar(fore: Map<string, string | null>, sedan: Date): Promise<string[]> {
    const { rows } = await pool.query<{ id: string; project_id: string | null; spar: string }>(
      `SELECT i.id, i.project_id,
              (SELECT count(*)::text FROM events e
                WHERE e.issue_id = i.id AND e.verb = 'andrade_projekt'
                  AND e.tidpunkt >= $1) AS spar
         FROM issues i`,
      [sedan],
    );
    return rows
      .filter((r) => (fore.get(r.id) ?? null) !== r.project_id && r.spar === '0')
      .map((r) => r.id);
  }

  it('ändring VIA plattformen lämnar spår — mätningen är tyst', async () => {
    const fore = await bild();
    const sedan = new Date();
    const projekt = await pool.query<{ namn: string }>('SELECT namn FROM projects LIMIT 1');
    const skapat = await kor(app, nyckel, 'create_issue', { title: 'Via plattformen', team_key: 'LOC' });
    await kor(app, nyckel, 'update_issue', {
      identifier: skapat.body.result.identifier,
      projekt: projekt.rows[0]!.namn,
      skal: 'Titeltaggen pekar dit — samma bevis arendehem.py använder.',
    });
    expect(await osparadeAndringar(fore, sedan)).toEqual([]);
  });

  it('samma ändring med rå SQL (arendehem.py:s gamla väg) FÄLLER mätningen', async () => {
    const fore = await bild();
    const sedan = new Date();
    const projekt = await pool.query<{ id: string }>('SELECT id FROM projects LIMIT 1');
    const mal = await pool.query<{ id: string }>(
      'SELECT id FROM issues WHERE project_id IS DISTINCT FROM $1 LIMIT 1',
      [projekt.rows[0]!.id],
    );
    // Exakt formen ur skriv_projectid(): update issues set project_id = ...
    await pool.query('UPDATE issues SET project_id = $1, uppdaterad = now() WHERE id = $2', [
      projekt.rows[0]!.id,
      mal.rows[0]!.id,
    ]);

    expect(await osparadeAndringar(fore, sedan)).toEqual([mal.rows[0]!.id]);
  });
});
