// FR-16 delkrav 2 och 6, B-07 (Story 5.1): ett öppet åtagande har alltid nästa steg och
// uppföljningstid, oavsett om det registreras eller ändras.
//
// Invarianten har en enda definition, kravOppetSteg i src/services/atagande.ts. Den står först
// i skriv(), den enda funktion som skriver ett åtagande, och i andraAtagande före skälet. Filen
// visar AK 1–7, var och en med prov som blir röda om regeln tas bort:
//   - registreringens krav, och koderna och vakten på ett ställe (AK 1: I7, I8);
//   - en giltig registrering utan beslut, med tillhor härlett ur slaget (AK 2: I1, I2);
//   - beslutskopplingen är en egen, idempotent handling (AK 3: I3);
//   - ändringen kan inte tömma uppföljningen, inte heller på en rad som redan bryter (AK 4: I4–I6);
//   - övergångarna som sätter nästa steg kräver båda (AK 5: I9);
//   - stängda åtaganden saknar båda, och det är tillåtet (AK 6: I10);
//   - den läsande mätningen av befintliga brott, utan CHECK och utan backfyllning (AK 7: I11–I13).
// "Noll rader" betyder att events- och issues-räkningen och ärendets åtagandekolumner är
// oförändrade (avtryck). För ett ärende utan åtagande ger get_atagande dessutom inget_atagande.
// Varje sådant fall har en motkontroll där ett giltigt anrop lyckas och ändrar räkningen.
// Anrop som ändrar ett befintligt åtagande skickar forvantad_revision, och andra_atagande utan
// grund och nasta skickar skal (Story 5.2), utom där provet gäller just ordningen mot skal_saknas.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
// Namnrymd och inga namngivna importer: filen laddas också innan kravOppetSteg och
// matAtagandebrott finns, och fallen som behöver dem blir röda med «är inte en funktion».
import * as tjansten from '../src/services/atagande.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const NY_GRUND = { typ: 'beslut', id: '171', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const RIKTNING = {
  handling: 'Välj vilken leverans som går först', slag: 'riktning', grund: { typ: 'beslut', id: '172' },
};
const UTAT = { handling: 'Skicka svaret till kunden', slag: 'utathandling', grund: GRUND[0] };
const HINDER = { typ: 'beslut', id: '145' };
const BELAGG = [{ typ: 'prov', id: 'atagande-invarianter', version: '2026-10-21' }];
const SKAL = 'Provet flyttar uppföljningen';
const V_OKANT = {
  text: 'Gör X endast om Y håller',
  kalla: { typ: 'beslut', id: '153' },
  galler: 'utfora',
  kontroll: 'kontrollera Y',
  utfall: 'okant',
};
const SEN = '2026-09-30T08:00:00Z';
const SENARE = '2026-10-30T08:00:00Z';
const ISO_SENARE = new Date(SENARE).toISOString();

const ROT = fileURLToPath(new URL('../', import.meta.url));
const SRC = path.join(ROT, 'src');

type Lage = 'registrerat' | 'overtaget' | 'hindrat' | 'genomfort' | 'avslutat';
type Svar = { status: number; body: { error?: string; details?: unknown } };

let app: Express;
let hermes: string; // agent
let david: string; // människa

/** Ett anrop som MÅSTE lyckas. Ett tyst 400 i ett förberedande steg får aldrig bära ett senare fall. */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

async function nyttArende(titel: string): Promise<string> {
  return (await steg(hermes, 'create_issue', { title: titel, team_key: 'LOC' })).identifier as string;
}

async function revisionNu(identifier: string): Promise<number> {
  return (await steg(hermes, 'get_atagande', { identifier })).revision as number;
}

/** Ett åtagande i det läge fallet behöver, byggt genom actions och aldrig med rå SQL. */
async function iLage(lage: Lage, titel: string): Promise<string> {
  const id = await nyttArende(titel);
  await steg(hermes, 'registrera_atagande', { identifier: id, grund: GRUND, nasta: INTERNT, foljs_upp: SEN });
  const vidare = async (action: string, input: Record<string, unknown>, nyckel = hermes) =>
    steg(nyckel, action, { identifier: id, ...input, forvantad_revision: await revisionNu(id) });
  if (lage === 'registrerat') return id;
  if (lage === 'hindrat') {
    await vidare('hindra_atagande', {
      orsak: 'DNS-ändringen är inte gjord', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN,
    });
    return id;
  }
  await vidare('ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN }, david);
  if (lage === 'overtaget') return id;
  if (lage === 'genomfort') {
    await vidare('redovisa_resultat', { sammanfattning: 'Klart enligt provet', belagg: BELAGG });
  } else {
    await vidare('avsluta_atagande', { text: 'Ersatt av ett annat åtagande', grund: NY_GRUND });
  }
  return id;
}

/** Räkningen av events och issues (epics.md:s Läsanvisning), för ett ärende som ännu saknar åtagande. */
async function rakningar() {
  return { events: await raknaRader('events'), issues: await raknaRader('issues') };
}

/** Radräkningen fångar INSERT, och kolumnerna fångar UPDATE: båda behövs för noll rader. */
async function avtryck(identifier: string) {
  const { issue_id } = await steg(hermes, 'get_atagande', { identifier });
  const { rows } = await pool.query(
    `SELECT atagande_lage, atagande_tillhor, atagande_revision, atagande, atagande_foljs_upp,
            atagande_utforare_typ, atagande_utforare_namn, atagande_overtaget_nar, state_id, uppdaterad
       FROM issues WHERE id = $1`,
    [issue_id],
  );
  return { ...(await rakningar()), rad: rows[0] };
}

async function sistaHandelse(identifier: string) {
  const { issue_id } = await steg(hermes, 'get_atagande', { identifier });
  const { rows } = await pool.query(
    'SELECT verb, payload FROM events WHERE issue_id = $1 ORDER BY id DESC LIMIT 1',
    [issue_id],
  );
  return rows[0];
}

/** Ägarrollen: bara för att lägga in brott förbi API:t (I6 och AK 7:s fixtur). */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/**
 * Ägarrollen bryter invarianten på ett åtagande som byggts genom API:t, som en rad skriven förbi
 * API:t. Helhetsvillkoret (grund ≥ 1) håller, så raden är just ett öppet åtagande som saknar ett fält.
 */
async function bryt(identifier: string, falt: 'nasta' | 'foljs_upp'): Promise<void> {
  const { issue_id } = await steg(hermes, 'get_atagande', { identifier });
  const admin = await adminKlient();
  try {
    const svar = await admin.query(
      falt === 'nasta'
        ? `UPDATE issues SET atagande = atagande || '{"nasta": null}'::jsonb WHERE id = $1`
        : 'UPDATE issues SET atagande_foljs_upp = NULL WHERE id = $1',
      [issue_id],
    );
    expect(svar.rowCount, `${identifier} ${falt}`).toBe(1);
  } finally {
    await admin.end();
  }
}

function avvisad(svar: Svar, kod: string, etikett = kod): void {
  expect([svar.status, svar.body.error], etikett).toEqual([400, kod]);
}

function schemafel(svar: Svar, path: string, etikett = path): void {
  avvisad(svar, 'validation_error', etikett);
  expect(svar.body.details, etikett).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
}

function okantFalt(svar: Svar, falt: string): void {
  avvisad(svar, 'validation_error', falt);
  expect(svar.body.details, falt).toContainEqual({
    path: '', message: `Unrecognized key(s) in object: '${falt}'`,
  });
}

/** Ett ärende utan åtagande: get_atagande svarar fortfarande inget_atagande. */
async function utanAtagande(identifier: string): Promise<void> {
  avvisad(await kor(app, hermes, 'get_atagande', { identifier }), 'inget_atagande', `${identifier} utan åtagande`);
}

/** I4: kör kravOppetSteg direkt och ger felkoden, eller null när inget kastades. Ett fel är alltid 400. */
function felkod(lage: Lage, nasta: unknown, foljsUpp: string | null | undefined): string | null {
  try {
    tjansten.kravOppetSteg(lage, nasta as tjansten.Nasta | null | undefined, foljsUpp);
  } catch (e) {
    const fel = e as { status?: number; code?: string };
    expect(fel.status, `${lage}: ${String(e)}`).toBe(400);
    return fel.code ?? null;
  }
  return null;
}

/** AK 7: mätningen i en egen transaktion, som skriptet gör den. */
async function brottNu(): Promise<tjansten.Atagandebrott[]> {
  return withTransaction((c) => tjansten.matAtagandebrott(c, TENANT_ID));
}

const korProcess = promisify(execFile);

/**
 * I12: npm-skriptets kommando, `tsx src/scripts/matAtagandebrott.ts`, som barnprocess i repots rot
 * (samma mönster som korNyckelskriptet i test/skrivvagar.test.ts). Barnprocessen ärver testmiljöns
 * DATABASE_URL, rollen app mot testdatabasen. DOTENV_CONFIG_PATH pekar på en fil som inte finns, så
 * att ingen .env kan rikta skriptet mot en annan databas. En avslutningskod kastar inte.
 */
async function korMatskriptet(
  env: Record<string, string> = {},
): Promise<{ kod: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'tsx'),
      ['src/scripts/matAtagandebrott.ts'],
      {
        cwd: ROT,
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: path.join(tmpdir(), 'atagande-invarianter-finns-inte.env'),
          ...env,
        },
      },
    );
    return { kod: 0, stdout, stderr };
  } catch (e) {
    const fel = e as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof fel.code !== 'number') throw e;
    return { kod: fel.code, stdout: fel.stdout ?? '', stderr: fel.stderr ?? '' };
  }
}

/** I8: varje .ts-fil under src/, med sökvägen relativt src/ ('services/atagande.ts'), som i test/skrivvagar.test.ts. */
function kallfilerISrc(): { fil: string; text: string }[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split(path.sep).join('/'))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(SRC, fil), 'utf8') }));
}

describe('FR-16/Story 5.1: ett öppet åtagande har alltid nästa steg och uppföljningstid', () => {
  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  describe('FR-16/Story 5.1 AK 2: en giltig registrering utan beslut', () => {
    it('I1 (AK 2): de tre slagen ger registrerat, tillhor ur slaget, titeln som utfall och unstarted', async () => {
      const SLAG = [[INTERNT, 'hermes'], [RIKTNING, 'agare'], [UTAT, 'anvandare']] as const;
      for (const [nasta, tillhor] of SLAG) {
        const titel = `I1 ${nasta.slag}`;
        const id = await nyttArende(titel);
        const svar = await steg(hermes, 'registrera_atagande', { identifier: id, grund: GRUND, nasta, foljs_upp: SEN });
        expect(svar.nyskapad, titel).toBe(true);
        expect(svar.atagande, titel).toMatchObject({ lage: 'registrerat', tillhor, utfall: titel });
        expect((await steg(hermes, 'get_issue', { identifier: id })).arende.state_typ, titel).toBe('unstarted');
        const registreringar = await pool.query(
          "SELECT count(*)::int AS n FROM events WHERE issue_id = $1 AND verb = 'registrerade_atagande'",
          [svar.atagande.issue_id],
        );
        expect(registreringar.rows[0].n, titel).toBe(1);
        // Registreringen kom utan beslut: ingen koppling pekar på ärendet.
        const kopplingar = await pool.query(
          'SELECT count(*)::int AS n FROM beslut_atagande WHERE tenant_id = $1 AND issue_id = $2',
          [TENANT_ID, svar.atagande.issue_id],
        );
        expect(kopplingar.rows[0].n, titel).toBe(0);
      }
    });

    it('I2 (AK 2): fältet tillhor avvisas med noll rader, och samma anrop utan det härleder anvandare', async () => {
      const id = await nyttArende('I2');
      const registrering = { identifier: id, grund: GRUND, nasta: UTAT, foljs_upp: SEN };
      const fore = await rakningar();
      okantFalt(await kor(app, hermes, 'registrera_atagande', { ...registrering, tillhor: 'hermes' }), 'tillhor');
      expect(await rakningar()).toEqual(fore);
      await utanAtagande(id);
      // Motkontroll: utan fältet lyckas registreringen, och tillhor kommer ur slaget.
      const svar = await steg(hermes, 'registrera_atagande', registrering);
      expect(svar.atagande.tillhor).toBe('anvandare');
      expect((await rakningar()).events).toBe(fore.events + 1);
    });
  });

  describe('FR-16/Story 5.1 AK 3: beslutskopplingen är en egen, idempotent handling', () => {
    it('I3 (AK 3): omregistreringen ger samma åtagande, och kopplingen två gånger ger en rad', async () => {
      const id = await nyttArende('I3');
      await steg(hermes, 'registrera_atagande', { identifier: id, grund: GRUND, nasta: INTERNT, foljs_upp: SEN });
      const last = await steg(hermes, 'get_atagande', { identifier: id });
      const issues = await raknaRader('issues');

      const igen = await steg(hermes, 'registrera_atagande', {
        identifier: id, grund: GRUND, nasta: RIKTNING, foljs_upp: SEN,
      });
      expect(igen.nyskapad).toBe(false);
      expect(igen.atagande).toEqual(last);
      expect(igen.atagande).toMatchObject({ revision: last.revision, tillhor: 'hermes', data: last.data });
      expect((await sistaHandelse(id)).verb).toBe('atagandet_fanns_redan');
      expect(await raknaRader('issues')).toBe(issues);

      const forsta = await steg(hermes, 'koppla_beslut', { beslut_id: 5101, identifier: id });
      expect(forsta).toMatchObject({ identifier: id, nyskapad: true });
      expect((await sistaHandelse(id)).verb).toBe('kopplade_beslut');
      const andra = await steg(hermes, 'koppla_beslut', { beslut_id: 5101, identifier: id });
      expect(andra).toMatchObject({ identifier: id, nyskapad: false });
      expect((await sistaHandelse(id)).verb).toBe('beslutet_var_redan_kopplat');
      const kopplingar = await pool.query(
        'SELECT count(*)::int AS n FROM beslut_atagande WHERE tenant_id = $1 AND beslut_id = $2',
        [TENANT_ID, 5101],
      );
      expect(kopplingar.rows[0].n).toBe(1);

      expect((await steg(hermes, 'atagande_for_beslut', { beslut_id: 5101 })).identifier).toBe(id);
    });
  });

  describe('FR-16/Story 5.1 AK 4: ändringen kan inte tömma uppföljningen', () => {
    it('I4 (AK 4): kravOppetSteg fäller varje öppet läge utan nästa steg eller uppföljningstid och släpper de stängda', () => {
      expect(tjansten.kravOppetSteg, 'kravOppetSteg exporteras ur tjänsten').toBeTypeOf('function');
      for (const lage of ['registrerat', 'overtaget', 'hindrat'] as const) {
        expect([
          felkod(lage, null, SEN),
          felkod(lage, undefined, SEN),
          felkod(lage, INTERNT, null),
          felkod(lage, INTERNT, undefined),
          felkod(lage, null, null),
          felkod(lage, INTERNT, SEN),
        ], lage).toEqual([
          'nasta_saknas',
          'nasta_saknas',
          'uppfoljning_saknas',
          'uppfoljning_saknas',
          'nasta_saknas',
          null,
        ]);
      }
      for (const lage of ['genomfort', 'avslutat'] as const) {
        expect(felkod(lage, null, null), lage).toBeNull();
      }
    });

    it.each(['registrerat', 'overtaget', 'hindrat'] as const)(
      'I5 (AK 4): andra_atagande i %s kan inte tömma uppföljningen eller nästa steg',
      async (lage) => {
        const id = await iLage(lage, `I5 ${lage}`);
        const n = await revisionNu(id);
        const fore = await avtryck(id);
        avvisad(await kor(app, hermes, 'andra_atagande', {
          identifier: id, foljs_upp: null, skal: SKAL, forvantad_revision: n,
        }), 'uppfoljning_saknas', 'foljs_upp: null med skal');
        // Utan skal: uppfoljning_saknas och inte skal_saknas, som prövas sist (Story 5.2 AK 3).
        avvisad(await kor(app, hermes, 'andra_atagande', {
          identifier: id, foljs_upp: null, forvantad_revision: n,
        }), 'uppfoljning_saknas', 'foljs_upp: null utan skal');
        schemafel(await kor(app, hermes, 'andra_atagande', {
          identifier: id, nasta: null, skal: SKAL, forvantad_revision: n,
        }), 'nasta');
        expect(await avtryck(id)).toEqual(fore);
        // Motkontroll: en ny uppföljningstid lyckas och ändrar avtrycket.
        const ratt = await steg(hermes, 'andra_atagande', {
          identifier: id, foljs_upp: SENARE, skal: SKAL, forvantad_revision: n,
        });
        expect(ratt.revision).toBe(n + 1);
        expect(ratt.foljs_upp).toBe(ISO_SENARE);
        expect((await avtryck(id)).events).toBe(fore.events + 1);
      },
    );

    it('I6 (AK 4): en rad som redan saknar nästa steg eller uppföljningstid ändras bara när fältet förs in', async () => {
      const a = await iLage('registrerat', 'I6 A');
      const b = await iLage('registrerat', 'I6 B');
      await bryt(a, 'nasta');
      await bryt(b, 'foljs_upp');
      const foreA = await avtryck(a);
      const foreB = await avtryck(b);
      for (const [id, kod] of [[a, 'nasta_saknas'], [b, 'uppfoljning_saknas']] as const) {
        const n = await revisionNu(id);
        avvisad(await kor(app, hermes, 'andra_atagande', {
          identifier: id, villkor: [V_OKANT], skal: SKAL, forvantad_revision: n,
        }), kod, `${id} med skal`);
        avvisad(await kor(app, hermes, 'andra_atagande', {
          identifier: id, villkor: [V_OKANT], forvantad_revision: n,
        }), kod, `${id} utan skal`);
      }
      expect(await avtryck(a)).toEqual(foreA);
      expect(await avtryck(b)).toEqual(foreB);
      // Motkontroll: ändringen som för in det saknade fältet lyckas, och båda raderna är därefter hela.
      const helA = await steg(hermes, 'andra_atagande', {
        identifier: a, nasta: INTERNT, foljs_upp: SENARE, forvantad_revision: await revisionNu(a),
      });
      expect(helA.data.nasta).toEqual(INTERNT);
      expect(helA.foljs_upp).toBe(ISO_SENARE);
      const helB = await steg(hermes, 'andra_atagande', {
        identifier: b, foljs_upp: SENARE, skal: SKAL, forvantad_revision: await revisionNu(b),
      });
      expect(helB.data.nasta).toEqual(INTERNT);
      expect(helB.foljs_upp).toBe(ISO_SENARE);
    });
  });

  describe('FR-16/Story 5.1 AK 1: registreringens krav', () => {
    it('I7 (AK 1): registreringen utan nästa steg, utan uppföljningstid eller utan grund avvisas med noll rader', async () => {
      const id = await nyttArende('I7');
      const fore = await rakningar();
      const fall: [string, Record<string, unknown>, (svar: Svar) => void][] = [
        ['båda null', { grund: GRUND, nasta: null, foljs_upp: null }, (s) => avvisad(s, 'nasta_saknas', 'båda null')],
        ['nasta null', { grund: GRUND, nasta: null, foljs_upp: SEN }, (s) => avvisad(s, 'nasta_saknas', 'nasta null')],
        [
          'foljs_upp null',
          { grund: GRUND, nasta: INTERNT, foljs_upp: null },
          (s) => avvisad(s, 'uppfoljning_saknas', 'foljs_upp null'),
        ],
        ['grund tom', { grund: [], nasta: INTERNT, foljs_upp: SEN }, (s) => schemafel(s, 'grund')],
      ];
      for (const [namn, indata, pruva] of fall) {
        pruva(await kor(app, hermes, 'registrera_atagande', { identifier: id, ...indata }));
        expect(await rakningar(), namn).toEqual(fore);
      }
      await utanAtagande(id);
      // Motkontroll: med grund, nästa steg och uppföljningstid lyckas registreringen och skriver sin rad.
      await steg(hermes, 'registrera_atagande', { identifier: id, grund: GRUND, nasta: INTERNT, foljs_upp: SEN });
      expect(await rakningar()).toEqual({ events: fore.events + 1, issues: fore.issues });
    });

    it('I8 (AK 1): felkoderna står på ett ställe i src/, och vakten står i skriv före dess UPDATE', () => {
      const forekomster = (strang: string): Record<string, number> =>
        Object.fromEntries(
          kallfilerISrc()
            .map(({ fil, text }) => [fil, text.split(strang).length - 1] as const)
            .filter(([, n]) => n > 0),
        );
      expect(forekomster("'nasta_saknas'")).toEqual({ 'services/atagande.ts': 1 });
      expect(forekomster("'uppfoljning_saknas'")).toEqual({ 'services/atagande.ts': 1 });

      const text = readFileSync(path.join(SRC, 'services', 'atagande.ts'), 'utf8');
      const borjan = text.indexOf('async function skriv(');
      expect(borjan, 'skriv finns').toBeGreaterThan(-1);
      const update = text.indexOf('UPDATE issues', borjan);
      expect(update, 'skriv har sin UPDATE').toBeGreaterThan(borjan);
      expect(text.slice(borjan, update)).toContain('kravOppetSteg(');
    });
  });

  describe('FR-16/Story 5.1 AK 5: övergångarna som sätter nästa steg kräver båda', () => {
    const SATTER_NASTA: { action: string; fran: Lage; indata: Record<string, unknown> }[] = [
      { action: 'ta_over_atagande', fran: 'registrerat', indata: { nasta: INTERNT, foljs_upp: SEN } },
      {
        action: 'hindra_atagande',
        fran: 'registrerat',
        indata: { orsak: 'Väntar på DNS', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN },
      },
      { action: 'aterppna_atagande', fran: 'genomfort', indata: { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE } },
    ];

    it.each(SATTER_NASTA)('I9 (AK 5): $action utan nasta eller foljs_upp, eller med null, avvisas med noll rader', async ({
      action, fran, indata,
    }) => {
      const id = await iLage(fran, `I9 ${action}`);
      const n = await revisionNu(id);
      const fore = await avtryck(id);
      const { nasta: _n, ...utanNasta } = indata;
      const { foljs_upp: _f, ...utanFoljsUpp } = indata;
      const former: [string, Record<string, unknown>, string][] = [
        ['utan nasta', utanNasta, 'nasta'],
        ['utan foljs_upp', utanFoljsUpp, 'foljs_upp'],
        ['nasta: null', { ...indata, nasta: null }, 'nasta'],
        ['foljs_upp: null', { ...indata, foljs_upp: null }, 'foljs_upp'],
      ];
      for (const [namn, varianten, falt] of former) {
        schemafel(await kor(app, hermes, action, { identifier: id, ...varianten, forvantad_revision: n }), falt, namn);
      }
      expect(await avtryck(id)).toEqual(fore);
      // Motkontroll: hela anropet lyckas och höjer revisionen.
      const ratt = await steg(hermes, action, { identifier: id, ...indata, forvantad_revision: n });
      expect(ratt.revision).toBe(n + 1);
      expect((await avtryck(id)).events).toBe(fore.events + 1);
    });
  });

  describe('FR-16/Story 5.1 AK 6: stängda åtaganden', () => {
    it('I10 (AK 6): ett genomfört och ett avslutat åtagande har nasta null och ingen uppföljningstid', async () => {
      // Båda byggs med 200 genom iLage, alltså godtog vakten i skriv de stängda lägena utan båda fälten.
      for (const lage of ['genomfort', 'avslutat'] as const) {
        const id = await iLage(lage, `I10 ${lage}`);
        const atagande = await steg(hermes, 'get_atagande', { identifier: id });
        expect(atagande.lage, lage).toBe(lage);
        expect(atagande.data.nasta, lage).toBeNull();
        expect(atagande.foljs_upp, lage).toBeNull();
      }
    });
  });

  describe('FR-16/Story 5.1 AK 7: mätning av befintliga brott, utan backfyllning', () => {
    // Fixturen: A och B bryts av ägarrollen, C–E är de rader mätningen inte ska se. A byggs
    // före B och har därför det lägre ärendenumret. I6:s två rader är hela igen.
    let A: string; // registrerat, utan nasta
    let B: string; // overtaget, utan uppföljningstid
    let C: string; // helt öppet åtagande
    let D: string; // genomfört
    let E: string; // ärende utan åtagande

    beforeAll(async () => {
      A = await iLage('registrerat', 'I11 A');
      B = await iLage('overtaget', 'I11 B');
      C = await iLage('registrerat', 'I11 C');
      D = await iLage('genomfort', 'I11 D');
      E = await nyttArende('I11 E');
      await bryt(A, 'nasta');
      await bryt(B, 'foljs_upp');
    });

    it('I11 (AK 7): tjänstefunktionen listar exakt A och B med fältet som saknas och skriver ingenting', async () => {
      const foreA = await avtryck(A);
      const foreB = await avtryck(B);
      const brott = await brottNu();
      expect(brott).toEqual([
        { identifier: A, lage: 'registrerat', saknas: ['nasta'] },
        { identifier: B, lage: 'overtaget', saknas: ['foljs_upp'] },
      ]);
      for (const id of [C, D, E]) expect(brott.map((b) => b.identifier)).not.toContain(id);
      expect(await avtryck(A)).toEqual(foreA);
      expect(await avtryck(B)).toEqual(foreB);
    });

    it('I12 (AK 7): skriptet, kört med npm-skriptets kommando, skriver listan och antalet och ingenting i databasen', async () => {
      const fore = await rakningar();
      const { kod, stdout, stderr } = await korMatskriptet();
      expect(kod, stderr).toBe(0);
      expect(stdout).toBe(`${A} registrerat saknar nasta\n${B} overtaget saknar foljs_upp\nAntal: 2\n`);
      expect(await rakningar()).toEqual(fore);

      // Kontroll: en mätning som inte kunde göras ser aldrig ut som noll brott.
      const finnsInte = new URL(process.env.DATABASE_URL!);
      finnsInte.pathname = '/arenden_finns_inte';
      const fel = await korMatskriptet({ DATABASE_URL: finnsInte.toString() });
      expect(fel.kod, fel.stderr).toBe(1);
      expect(fel.stderr).toMatch(/^FATAL:/);
      expect(fel.stdout).not.toContain('Antal:');
    });

    it('I13 (AK 7): ingen CHECK spärrar raden, och rättningen med andra_atagande tar den ur listan', async () => {
      await steg(hermes, 'update_issue', { identifier: A, title: 'A rättad titel' });
      expect((await sistaHandelse(A)).verb).toBe('andrade_titel');
      expect((await brottNu()).map((b) => b.identifier)).toEqual([A, B]);
      await steg(hermes, 'andra_atagande', {
        identifier: A, nasta: INTERNT, foljs_upp: SENARE, forvantad_revision: await revisionNu(A),
      });
      expect((await brottNu()).map((b) => b.identifier)).toEqual([B]);
    });
  });
});
