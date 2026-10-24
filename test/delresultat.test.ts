// FR-16 delkrav 5, B-07 (Story 5.5): huvudåtagandet spärras av märkta nödvändiga delresultat, och
// bara av dem. Davids svar 2026-10-16 kl. 13.21: ett delresultat märks som nödvändigt med en loggad
// handling, aldrig gissat ur titlar; ett avslut utan resultat spärrar fortfarande; märkningen tas
// bort med ett skäl i loggen.
//
// Filen visar AK 1–8 och AK 10 (AK 9 görs i drift), var och en med fall som blir röda om regeln tas bort:
//   - märkningen är data med spår: tabellen, rättigheterna och den enda skrivaren (AK 5, AK 10: N1–N5);
//   - borttagningen kräver skäl (AK 6: N6–N8);
//   - ett saknat märkt delresultat spärrar, och bara det (AK 1–4: N9–N13);
//   - spärren gäller på varje väg till genomfört (AK 5: N14, N15);
//   - barnräkningen är borta (AK 7: N16);
//   - mätningen av dagens spärrar läser bara issues och teams och skriver ingenting (AK 8: N17–N19).
// "Noll rader" betyder att räkningen av events, issues och nodvandiga_delresultat och huvudärendets
// åtagandekolumner är oförändrade (noll). Avtrycket tas först när allt förberedande är gjort, och
// varje avvisning har en motkontroll där ett giltigt anrop lyckas.
// D11 i test/atagande-kontrakt.test.ts (Story 5.3 AK 6, barnräkningen) är ersatt härifrån.
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
import { VERB } from '../src/http/vy/mall.js';
// Namnrymd och inga namngivna importer: filen laddas också innan matDelresultat finns, och fallen
// som behöver den blir röda med «är inte en funktion».
import * as tjansten from '../src/services/atagande.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const NY_GRUND = { typ: 'beslut', id: '171', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const HINDER = { typ: 'beslut', id: '145' };
const BELAGG = [{ typ: 'prov', id: 'delresultat', version: '2026-10-24' }];
const SEN = '2026-09-30T08:00:00Z';

const ROT = fileURLToPath(new URL('../', import.meta.url));
const SRC = path.join(ROT, 'src');

type Lage = 'registrerat' | 'overtaget' | 'hindrat' | 'genomfort' | 'avslutat';
type Svar = { status: number; body: { error?: string; details?: unknown; result?: Record<string, unknown> } };

let app: Express;
let hermes: string; // agent
let david: string; // människa

/** Ett tyst 400 i förberedelserna får aldrig bära ett senare fall. */
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

/** Provställningen byggs genom actions, aldrig med SQL (N1 prövar själva databasspärren). */
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

/** Radräkningen fångar INSERT, och kolumnerna fångar UPDATE: båda behövs för noll rader. */
async function avtryck(identifier: string) {
  const { issue_id } = await steg(hermes, 'get_atagande', { identifier });
  const { rows } = await pool.query(
    `SELECT atagande_lage, atagande_tillhor, atagande_revision, atagande, atagande_foljs_upp,
            atagande_utforare_typ, atagande_utforare_namn, atagande_overtaget_nar, state_id, uppdaterad
       FROM issues WHERE id = $1`,
    [issue_id],
  );
  return { events: await raknaRader('events'), issues: await raknaRader('issues'), rad: rows[0] };
}

/** Bara N1 behöver ägarrollen, för att visa databasens egna spärrar. */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

function avvisad(svar: Svar, kod: string, etikett = kod): void {
  expect([svar.status, svar.body.error], etikett).toEqual([400, kod]);
}

function schemafel(svar: Svar, falt: string, etikett = falt): void {
  avvisad(svar, 'validation_error', etikett);
  expect(svar.body.details, etikett).toEqual(expect.arrayContaining([expect.objectContaining({ path: falt })]));
}

function okantFalt(svar: Svar, falt: string): void {
  avvisad(svar, 'validation_error', falt);
  expect(svar.body.details, falt).toContainEqual({
    path: '', message: `Unrecognized key(s) in object: '${falt}'`,
  });
}

/** Ett delärende i läget (eller utan åtagande), med föräldern satt genom update_issue och parent. */
async function delarende(huvud: string, titel: string, lage: Lage | 'inget'): Promise<string> {
  const id = lage === 'inget' ? await nyttArende(titel) : await iLage(lage, titel);
  await steg(hermes, 'update_issue', { identifier: id, parent: huvud });
  return id;
}

function marka(nyckel: string, huvud: string, del: string) {
  return kor(app, nyckel, 'marka_nodvandigt_delresultat', { identifier: huvud, delarende: del });
}

/** "Noll rader": avtrycket på huvudärendet och räkningen av märkningarna. */
async function noll(huvud: string) {
  return { ...(await avtryck(huvud)), markningar: await raknaRader('nodvandiga_delresultat') };
}

/** Parets rader, äldst först, läst som app genom poolen. */
async function paret(huvud: string, del: string) {
  const { rows } = await pool.query(
    `SELECT n.markt_av_typ, n.markt_av_namn, n.markt, n.borttagen
       FROM nodvandiga_delresultat n
       JOIN issues h ON h.id = n.huvud_issue_id JOIN teams ht ON ht.id = h.team_id
       JOIN issues d ON d.id = n.del_issue_id JOIN teams dt ON dt.id = d.team_id
      WHERE ht.key || '-' || h.sequence_number = $1 AND dt.key || '-' || d.sequence_number = $2
      ORDER BY n.id`,
    [huvud, del],
  );
  return rows;
}

/** Den senaste händelseradens id, som utgångsläge för nyaHandelser. */
async function sistaHandelseId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM events');
  return rows[0]!.id;
}

/** Händelseraderna efter `sedan`, i ordning. skrivHandelse skriver payloaden som den är. */
async function nyaHandelser(sedan: string) {
  const { rows } = await pool.query(
    'SELECT verb, issue_id, aktor_typ, aktor_namn, payload FROM events WHERE id > $1 ORDER BY id',
    [sedan],
  );
  return rows;
}

async function issueId(identifier: string): Promise<string> {
  return (await steg(hermes, 'get_atagande', { identifier })).issue_id as string;
}

function taBort(nyckel: string, huvud: string, del: string, skal: string) {
  return kor(app, nyckel, 'ta_bort_nodvandigt_delresultat', { identifier: huvud, delarende: del, skal });
}

/** Hela kommentarsrader bort (samma regel som arKommentar i test/svenska-yta.test.ts); resten står kvar. */
function kodrader(text: string): string {
  return text.split('\n').filter((rad) => !/^\s*(\/\/|\/\*|\*)/.test(rad)).join('\n');
}

/** Varje .ts-fil under src/, med sökvägen relativt src/ ('services/atagande.ts'), som i test/skrivvagar.test.ts. */
function kallfilerISrc(): { fil: string; text: string }[] {
  return readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.split(path.sep).join('/'))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(SRC, fil), 'utf8') }));
}

/**
 * Träffar per fil på kodraderna, skiftlägesokänsligt och över radbrytningar, som traffar i
 * test/skrivvagar.test.ts (F14): en SQL-sats på flera rader räknas.
 */
function traffar(filer: { fil: string; text: string }[], monster: RegExp): Record<string, number> {
  const ut: Record<string, number> = {};
  for (const { fil, text } of filer) {
    const antal = kodrader(text).match(new RegExp(monster.source, 'gi'))?.length ?? 0;
    if (antal > 0) ut[fil] = antal;
  }
  return ut;
}

/** En text som mönster, tecken för tecken. */
function bokstavlig(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/**
 * Funktionens kropp: från raden `export async function <namn>(` till nästa rad som börjar med
 * `export`, eller till filens slut. `null` när funktionen saknas.
 */
function funktionskropp(text: string, namn: string): string | null {
  const rader = text.split('\n');
  const start = rader.findIndex((r) => r.startsWith(`export async function ${namn}(`));
  if (start === -1) return null;
  const slut = rader.findIndex((r, i) => i > start && r.startsWith('export'));
  return rader.slice(start, slut === -1 ? rader.length : slut).join('\n');
}

/** redovisa_resultat för huvudåtagandet, med aktuell revision. */
async function redovisa(huvud: string) {
  return kor(app, hermes, 'redovisa_resultat', {
    identifier: huvud, sammanfattning: 'Huvudet klart', belagg: BELAGG,
    forvantad_revision: await revisionNu(huvud),
  });
}

/** Delärendets åtagande får sitt resultat, från läget det står i (eller utan åtagande). */
async function geResultat(del: string, lage: Lage | 'inget'): Promise<void> {
  const vidare = async (action: string, input: Record<string, unknown>) =>
    steg(hermes, action, { identifier: del, ...input, forvantad_revision: await revisionNu(del) });
  if (lage === 'inget') {
    await steg(hermes, 'registrera_atagande', { identifier: del, grund: GRUND, nasta: INTERNT, foljs_upp: SEN });
  }
  if (lage === 'avslutat') await vidare('aterppna_atagande', { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SEN });
  if (lage !== 'overtaget') await vidare('ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN });
  await vidare('redovisa_resultat', { sammanfattning: 'Delen klar', belagg: BELAGG });
}

/** Spärren: 400 nodvandigt_delresultat_saknas med exakt de saknade delärendena i details, och noll rader. */
async function sparrad(huvud: string, details: { identifier: string; lage: Lage | null }[], etikett = huvud) {
  const fore = await noll(huvud);
  const svar = await redovisa(huvud);
  avvisad(svar, 'nodvandigt_delresultat_saknas', etikett);
  expect(svar.body.details, etikett).toEqual(details);
  expect(await noll(huvud), etikett).toEqual(fore);
}

/** AK 8: mätningen i en egen transaktion, som skriptet gör den. */
async function matNu() {
  return withTransaction((c) => tjansten.matDelresultat(c, TENANT_ID));
}

/** "Noll rader" för mätningen: räkningen av de tre tabellerna som AK 8 nämner. */
async function rakningar() {
  return {
    events: await raknaRader('events'),
    issues: await raknaRader('issues'),
    markningar: await raknaRader('nodvandiga_delresultat'),
  };
}

const korProcess = promisify(execFile);

/**
 * N18: npm-skriptets kommando, `tsx src/scripts/matDelresultat.ts`, som barnprocess i repots rot (samma
 * mönster som korMatskriptet i test/atagande-invarianter.test.ts). Barnprocessen ärver testmiljöns
 * DATABASE_URL, rollen app mot testdatabasen. DOTENV_CONFIG_PATH pekar på en fil som inte finns, så att
 * ingen .env kan rikta skriptet mot en annan databas. En avslutningskod kastar inte.
 */
async function korMatskriptet(
  env: Record<string, string> = {},
): Promise<{ kod: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'tsx'),
      ['src/scripts/matDelresultat.ts'],
      {
        cwd: ROT,
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: path.join(tmpdir(), 'delresultat-finns-inte.env'),
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

/** Redovisningen går igenom: 200, läget genomfört, en händelse och en revision till. */
async function genomford(huvud: string, etikett = huvud) {
  const fore = await noll(huvud);
  const svar = await redovisa(huvud);
  expect(svar.status, `${etikett}: ${JSON.stringify(svar.body)}`).toBe(200);
  expect(svar.body.result.lage, etikett).toBe('genomfort');
  const efter = await noll(huvud);
  expect(efter.events, etikett).toBe(fore.events + 1);
  expect(efter.rad.atagande_revision, etikett).toBe(fore.rad.atagande_revision + 1);
}

describe('FR-16/Story 5.5: huvudåtagandet spärras av märkta nödvändiga delresultat', () => {
  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  // Först i filen: databasen återskapas bara före varje provfil, så fixturen H1–H3 är de enda
  // hierarkierna när N17 och N18 körs. N19 lägger till H4 först efter N18.
  describe('FR-16/Story 5.5 AK 8: mätningen av dagens spärrar', () => {
    let H1: string; // övertaget: D11 registrerat, D12 hindrat — barnräkningen spärrar
    let D11: string;
    let D12: string;
    let H2: string; // registrerat: D21 övertaget — barnräkningen spärrar
    let D21: string;
    let H3: string; // övertaget: D31 genomfört, D32 avslutat, D33 utan åtagande — spärras inte

    beforeAll(async () => {
      // I den här ordningen, så att numren stiger.
      H1 = await iLage('overtaget', 'N17 H1');
      D11 = await delarende(H1, 'N17 D11', 'registrerat');
      D12 = await delarende(H1, 'N17 D12', 'hindrat');
      H2 = await iLage('registrerat', 'N17 H2');
      D21 = await delarende(H2, 'N17 D21', 'overtaget');
      H3 = await iLage('overtaget', 'N17 H3');
      await delarende(H3, 'N17 D31', 'genomfort');
      await delarende(H3, 'N17 D32', 'avslutat');
      await delarende(H3, 'N17 D33', 'inget');
    });

    it('N17 (AK 8): tjänstefunktionen listar exakt H1 och H2 med delärendena och deras lägen, och skriver ingenting', async () => {
      const fore = await rakningar();
      expect(await matNu()).toEqual([
        {
          identifier: H1, lage: 'overtaget',
          delarenden: [{ identifier: D11, lage: 'registrerat' }, { identifier: D12, lage: 'hindrat' }],
        },
        { identifier: H2, lage: 'registrerat', delarenden: [{ identifier: D21, lage: 'overtaget' }] },
      ]);
      expect(await rakningar()).toEqual(fore);

      // Källtexten: mätningen läser inte märkningen och skriver ingenting, så den ger samma lista före
      // migrationen 0018 som efter.
      // Tabellnamnet prövas i hela kroppen, kommentarer inräknade; skrivsatserna på kodraderna.
      const fynd = (kropp: string): string[] => {
        const kod = kodrader(kropp);
        const ut: string[] = [];
        if (/\bnodvandiga_delresultat\b/.test(kropp)) ut.push('nodvandiga_delresultat');
        for (const [namn, monster] of [
          ['INSERT INTO', /\bINSERT\s+INTO\b/i], ['UPDATE … SET', /\bUPDATE\s+\w+\s+SET\b/i],
          ['DELETE FROM', /\bDELETE\s+FROM\b/i], ['TRUNCATE', /\bTRUNCATE\b/i],
        ] as const) {
          if (monster.test(kod)) ut.push(namn);
        }
        return ut;
      };
      const kropp = funktionskropp(readFileSync(path.join(SRC, 'services', 'atagande.ts'), 'utf8'), 'matDelresultat');
      expect(kropp, 'matDelresultat finns').not.toBeNull();
      expect(fynd(kropp!)).toEqual([]);
      // Kontroll: samma läsning av en påhittad kropp som läser märkningen ger ett fynd.
      const pahittad = [
        'export async function matDelresultat(client) {',
        "  return client.query('SELECT * FROM nodvandiga_delresultat');",
        '}',
      ].join('\n');
      expect(fynd(funktionskropp(pahittad, 'matDelresultat')!)).toEqual(['nodvandiga_delresultat']);
    });

    it('N18 (AK 8): skriptet, kört med npm-skriptets kommando, skriver listan och antalet och ingenting i databasen', async () => {
      const fore = await rakningar();
      const { kod, stdout, stderr } = await korMatskriptet();
      expect(kod, stderr).toBe(0);
      expect(stdout).toBe(
        `${H1} overtaget: ${D11} registrerat, ${D12} hindrat\n${H2} registrerat: ${D21} overtaget\nAntal: 2\n`,
      );
      expect(await rakningar()).toEqual(fore);

      // Kontroll: en mätning som inte kunde göras ser aldrig ut som noll spärrar.
      const finnsInte = new URL(process.env.DATABASE_URL!);
      finnsInte.pathname = '/arenden_finns_inte';
      const fel = await korMatskriptet({ DATABASE_URL: finnsInte.toString() });
      expect(fel.kod, fel.stderr).toBe(1);
      expect(fel.stderr).toMatch(/^FATAL:/);
      expect(fel.stdout).not.toContain('Antal:');
    });

    it('N19 (AK 9, i bygget): mätningen efter driftsättningen listar ett huvudåtagande som redovisats efter spärrbytet, med läget genomfört', async () => {
      const H4 = await iLage('overtaget', 'N19 H4');
      const D41 = await delarende(H4, 'N19 D41', 'registrerat');
      const H1H2 = [
        {
          identifier: H1, lage: 'overtaget',
          delarenden: [{ identifier: D11, lage: 'registrerat' }, { identifier: D12, lage: 'hindrat' }],
        },
        { identifier: H2, lage: 'registrerat', delarenden: [{ identifier: D21, lage: 'overtaget' }] },
      ];
      // Motkontroll först: H4 står i listan medan det är öppet.
      expect(await matNu()).toEqual([
        ...H1H2,
        { identifier: H4, lage: 'overtaget', delarenden: [{ identifier: D41, lage: 'registrerat' }] },
      ]);

      // D41 är inte märkt, och barnräkningen finns inte längre: H4 redovisas.
      await genomford(H4);

      // Mätningen ser det: H4 står kvar, nu i läget genomfört, och mätningen skriver ingenting.
      const fore = await rakningar();
      expect(await matNu()).toEqual([
        ...H1H2,
        { identifier: H4, lage: 'genomfort', delarenden: [{ identifier: D41, lage: 'registrerat' }] },
      ]);
      expect(await rakningar()).toEqual(fore);
    });
  });

  describe('FR-16/Story 5.5 AK 5: märkningen är data med spår — tabellen', () => {
    it('N1 (AK 5, AK 10): åtta kolumner, app saknar DELETE och UPDATE utom på borttagen, och spärrarna håller', async () => {
      const kolumner = await pool.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'nodvandiga_delresultat'
          ORDER BY ordinal_position`,
      );
      expect(kolumner.rows).toEqual([
        { column_name: 'id', data_type: 'bigint', is_nullable: 'NO' },
        { column_name: 'tenant_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'huvud_issue_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'del_issue_id', data_type: 'uuid', is_nullable: 'NO' },
        { column_name: 'markt_av_typ', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'markt_av_namn', data_type: 'text', is_nullable: 'NO' },
        { column_name: 'markt', data_type: 'timestamp with time zone', is_nullable: 'NO' },
        { column_name: 'borttagen', data_type: 'timestamp with time zone', is_nullable: 'YES' },
      ]);

      // Rättigheterna: SELECT och INSERT på tabellen, UPDATE bara på borttagen, aldrig DELETE.
      const tabell = await pool.query<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.table_privileges
          WHERE table_name = 'nodvandiga_delresultat' AND grantee = 'app'`,
      );
      expect(tabell.rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
      const uppdaterbara = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
          WHERE table_name = 'nodvandiga_delresultat' AND grantee = 'app' AND privilege_type = 'UPDATE'`,
      );
      expect(uppdaterbara.rows.map((r) => r.column_name)).toEqual(['borttagen']);
      await expect(pool.query("UPDATE nodvandiga_delresultat SET markt_av_namn = 'x'"))
        .rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('DELETE FROM nodvandiga_delresultat')).rejects.toMatchObject({ code: '42501' });

      // Databasens spärrar, som ägaren i en transaktion som rullas tillbaka. Ett fel avbryter annars
      // hela transaktionen (25P02), så varje väntat fel står mellan SAVEPOINT och ROLLBACK TO.
      const huvud = await steg(hermes, 'create_issue', { title: 'N1 huvudärende', team_key: 'LOC' });
      const del = await steg(hermes, 'create_issue', { title: 'N1 delärende', team_key: 'LOC' });
      const admin = await adminKlient();
      try {
        await admin.query('BEGIN');
        await admin.query("SET LOCAL lock_timeout = '5s'");
        const markning = (h: unknown, d: unknown) => admin.query<{ id: string }>(
          `INSERT INTO nodvandiga_delresultat (tenant_id, huvud_issue_id, del_issue_id, markt_av_typ, markt_av_namn)
           VALUES ($1, $2, $3, 'agent', 'hermes') RETURNING id`,
          [TENANT_ID, h, d],
        );
        await admin.query('SAVEPOINT sjalv');
        const sjalv = await markning(huvud.id, huvud.id).then(() => null, (e: unknown) => e);
        expect(sjalv).toMatchObject({ code: '23514', constraint: 'nodvandiga_delresultat_inte_sig_sjalv' });
        await admin.query('ROLLBACK TO SAVEPOINT sjalv');

        const forsta = await markning(huvud.id, del.id);
        expect(forsta.rowCount).toBe(1);
        await admin.query('SAVEPOINT dubblett');
        const dubblett = await markning(huvud.id, del.id).then(() => null, (e: unknown) => e);
        expect(dubblett).toMatchObject({ code: '23505', constraint: 'nodvandiga_delresultat_aktiv' });
        await admin.query('ROLLBACK TO SAVEPOINT dubblett');

        // En borttagen rad står kvar som historik, och paret kan märkas på nytt.
        const bort = await admin.query('UPDATE nodvandiga_delresultat SET borttagen = now() WHERE id = $1', [
          forsta.rows[0]!.id,
        ]);
        expect(bort.rowCount).toBe(1);
        const igen = await markning(huvud.id, del.id);
        expect(igen.rowCount).toBe(1);
        const par = await admin.query(
          'SELECT borttagen IS NULL AS aktiv FROM nodvandiga_delresultat WHERE huvud_issue_id = $1 ORDER BY id',
          [huvud.id],
        );
        expect(par.rows).toEqual([{ aktiv: false }, { aktiv: true }]);
      } finally {
        try {
          await admin.query('ROLLBACK');
        } finally {
          await admin.end();
        }
      }
      expect(await raknaRader('nodvandiga_delresultat')).toBe(0);
    });
  });

  describe('FR-16/Story 5.5 AK 5: märkningen är data med spår', () => {
    it('N2 (AK 5, AK 7, AK 10): märkningen bär händelserad och nyckelns aktör, och en upprepning är ett eget no-op-verb', async () => {
      const H = await iLage('overtaget', 'N2 huvud');
      const D1 = await delarende(H, 'N2 D1', 'inget');
      const D2 = await delarende(H, 'N2 D2', 'inget');
      const hId = await issueId(H);
      const fore = await noll(H);

      const sedan = await sistaHandelseId();
      const svar = await marka(hermes, H, D1);
      expect(svar.status, JSON.stringify(svar.body)).toBe(200);
      expect(svar.body.result).toEqual({ identifier: H, delarende: D1, andrad: true });
      expect(await nyaHandelser(sedan)).toEqual([{
        verb: 'markte_nodvandigt_delresultat', issue_id: hId, aktor_typ: 'agent', aktor_namn: 'hermes',
        payload: { identifier: H, delarende: D1 },
      }]);
      const rader = await paret(H, D1);
      expect(rader).toEqual([
        { markt_av_typ: 'agent', markt_av_namn: 'hermes', markt: expect.any(Date), borttagen: null },
      ]);
      // Märkningen rör inte åtagandet: samma kolumner, samma revision, en händelse och en rad till.
      const efter = await noll(H);
      expect(efter).toEqual({ ...fore, events: fore.events + 1, markningar: fore.markningar + 1 });

      // Samma märkning igen: andrad false, eget no-op-verb med samma payload, ingen rad till.
      const sedanIgen = await sistaHandelseId();
      const igen = await marka(hermes, H, D1);
      expect(igen.status, JSON.stringify(igen.body)).toBe(200);
      expect(igen.body.result).toEqual({ identifier: H, delarende: D1, andrad: false });
      expect(await nyaHandelser(sedanIgen)).toEqual([{
        verb: 'delresultatet_var_redan_markt', issue_id: hId, aktor_typ: 'agent', aktor_namn: 'hermes',
        payload: { identifier: H, delarende: D1 },
      }]);
      expect(await noll(H)).toEqual({ ...efter, events: efter.events + 1 });
      expect(await paret(H, D1)).toEqual(rader);

      // Davids märkning bär människans aktör, i raden och i händelseraden.
      const sedanDavid = await sistaHandelseId();
      const davids = await marka(david, H, D2);
      expect(davids.status, JSON.stringify(davids.body)).toBe(200);
      expect(davids.body.result).toEqual({ identifier: H, delarende: D2, andrad: true });
      expect(await nyaHandelser(sedanDavid)).toEqual([{
        verb: 'markte_nodvandigt_delresultat', issue_id: hId, aktor_typ: 'manniska', aktor_namn: 'david',
        payload: { identifier: H, delarende: D2 },
      }]);
      expect(await paret(H, D2)).toEqual([
        { markt_av_typ: 'manniska', markt_av_namn: 'david', markt: expect.any(Date), borttagen: null },
      ]);

      expect(VERB['markte_nodvandigt_delresultat']).toBe('märkte ett delresultat som nödvändigt');
      expect(VERB['delresultatet_var_redan_markt']).toBe('delresultatet var redan märkt som nödvändigt');
    });

    it('N3 (AK 5): sju ogiltiga märkningar ger var sin kod och noll rader, och ett riktigt delärende märks', async () => {
      const H = await iLage('overtaget', 'N3 huvud');
      const D1 = await delarende(H, 'N3 D1', 'inget');
      const D3 = await delarende(H, 'N3 D3', 'inget');
      const fristaende = await nyttArende('N3 fristående');
      const barnbarn = await delarende(D1, 'N3 barnbarn', 'inget');
      const H2 = await iLage('registrerat', 'N3 annat huvud');
      const annatsBarn = await delarende(H2, 'N3 barn till H2', 'inget');
      const utan = await nyttArende('N3 ärende utan åtagande');
      const utansBarn = await delarende(utan, 'N3 barn till ärendet utan åtagande', 'inget');
      const fore = await noll(H);

      const fall: [string, () => PromiseLike<Svar>, (svar: Svar) => void][] = [
        ['(a) fristående', () => marka(hermes, H, fristaende), (s) => avvisad(s, 'inte_delarende', '(a)')],
        ['(b) barnbarn', () => marka(hermes, H, barnbarn), (s) => avvisad(s, 'inte_delarende', '(b)')],
        ['(c) huvudärendet självt', () => marka(hermes, H, H), (s) => avvisad(s, 'inte_delarende', '(c)')],
        ['(d) barn till H2', () => marka(hermes, H, annatsBarn), (s) => avvisad(s, 'inte_delarende', '(d)')],
        ['(e) huvud utan åtagande', () => marka(hermes, utan, utansBarn), (s) => avvisad(s, 'inget_atagande', '(e)')],
        [
          '(f) okänt delärende', () => marka(hermes, H, 'LOC-99999'),
          (s) => expect([s.status, s.body.error], '(f) delärende').toEqual([404, 'not_found']),
        ],
        [
          '(f) okänt huvudärende', () => marka(hermes, 'LOC-99999', D1),
          (s) => expect([s.status, s.body.error], '(f) huvudärende').toEqual([404, 'not_found']),
        ],
        [
          '(g) aktor_typ', () => kor(app, hermes, 'marka_nodvandigt_delresultat', {
            identifier: H, delarende: D1, aktor_typ: 'manniska',
          }),
          (s) => okantFalt(s, 'aktor_typ'),
        ],
        [
          '(g) utan delarende', () => kor(app, hermes, 'marka_nodvandigt_delresultat', { identifier: H }),
          (s) => schemafel(s, 'delarende'),
        ],
      ];
      for (const [namn, anrop, pruva] of fall) {
        pruva(await anrop());
        expect(await noll(H), namn).toEqual(fore);
      }

      // Motkontroll: ett riktigt delärende till H märks, med en händelse och en rad till.
      const ratt = await marka(hermes, H, D3);
      expect(ratt.status, JSON.stringify(ratt.body)).toBe(200);
      expect(ratt.body.result).toEqual({ identifier: H, delarende: D3, andrad: true });
      expect(await noll(H)).toEqual({ ...fore, events: fore.events + 1, markningar: fore.markningar + 1 });
    });

    it('N4 (AK 5): två samtidiga märkningar av samma par ger en rad och ett av varje verb', async () => {
      const H = await iLage('overtaget', 'N4 huvud');
      const D = await delarende(H, 'N4 delärende', 'inget');
      const sedan = await sistaHandelseId();
      const [a, b] = await Promise.all([marka(hermes, H, D), marka(david, H, D)]);
      expect([a.status, b.status], JSON.stringify([a.body, b.body])).toEqual([200, 200]);
      expect([a.body.result.andrad, b.body.result.andrad].sort()).toEqual([false, true]);
      const rader = await paret(H, D);
      expect(rader).toHaveLength(1);
      expect(rader[0]!.borttagen).toBeNull();
      expect((await nyaHandelser(sedan)).map((h) => h.verb).sort()).toEqual([
        'delresultatet_var_redan_markt',
        'markte_nodvandigt_delresultat',
      ]);
    });

    it('N5 (AK 5): i källtexten skrivs tabellen av en enda INSERT och en enda UPDATE, och aldrig raderas', () => {
      const filer = kallfilerISrc();
      expect(filer.map((f) => f.fil), 'hittade inga källfiler').toContain('services/atagande.ts');
      const INSERT = /\bINSERT\s+INTO\s+nodvandiga_delresultat\b/;
      expect(traffar(filer, INSERT)).toEqual({ 'services/atagande.ts': 1 });
      expect(traffar(filer, /\bUPDATE\s+nodvandiga_delresultat\s+SET\b/)).toEqual({ 'services/atagande.ts': 1 });
      expect(traffar(filer, /\bDELETE\s+FROM\s+nodvandiga_delresultat\b/)).toEqual({});
      expect(traffar(filer, /\bTRUNCATE\b[^;]*\bnodvandiga_delresultat\b/)).toEqual({});

      // Migrationerna: bara 0018 nämner tabellen, och den för inte in några rader.
      const katalog = path.join(ROT, 'migrations');
      const migrationer = readdirSync(katalog).filter((f) => f.endsWith('.sql')).sort();
      expect(migrationer, 'hittade inga migrationer').toContain('0001_grund.sql');
      const namner = migrationer.filter((f) => /\bnodvandiga_delresultat\b/.test(readFileSync(path.join(katalog, f), 'utf8')));
      expect(namner).toEqual(['0018_nodvandiga_delresultat.sql']);
      const sql = readFileSync(path.join(katalog, '0018_nodvandiga_delresultat.sql'), 'utf8');
      expect(sql).not.toMatch(new RegExp(INSERT.source, 'i'));

      // Kontroll: två satser, den ena med gemener och på två rader, ger två; en kommentarsrad räknas inte.
      const pahittad = [
        "await c.query('INSERT INTO nodvandiga_delresultat (id) VALUES (1)');",
        '// INSERT INTO nodvandiga_delresultat i en kommentar',
        "await c.query(`insert",
        '  into nodvandiga_delresultat (id) VALUES (2)`);',
      ].join('\n');
      expect(traffar([{ fil: 'pahittad.ts', text: pahittad }], INSERT)).toEqual({ 'pahittad.ts': 2 });
    });
  });

  describe('FR-16/Story 5.5 AK 6: märkningen tas bort med skäl', () => {
    it('N6 (AK 6): borttagningen av agent och av människa bär skälet ordagrant och bevarar raden', async () => {
      const H = await iLage('overtaget', 'N6 huvud');
      const D = await delarende(H, 'N6 delärende', 'inget');
      const hId = await issueId(H);
      await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: D });
      const markt = await paret(H, D);
      expect(markt).toHaveLength(1);
      const fore = await noll(H);

      const SKAL = 'N6 delresultatet behövs inte längre';
      const sedan = await sistaHandelseId();
      const svar = await taBort(hermes, H, D, SKAL);
      expect(svar.status, JSON.stringify(svar.body)).toBe(200);
      expect(svar.body.result).toEqual({ identifier: H, delarende: D, andrad: true });
      expect(await nyaHandelser(sedan)).toEqual([{
        verb: 'tog_bort_markning_av_delresultat', issue_id: hId, aktor_typ: 'agent', aktor_namn: 'hermes',
        payload: { identifier: H, delarende: D, skal: SKAL },
      }]);
      // Raden står kvar som historik, med samma aktör och tid, och ingen aktiv rad finns.
      expect(await paret(H, D)).toEqual([{ ...markt[0], borttagen: expect.any(Date) }]);
      expect(await noll(H)).toEqual({ ...fore, events: fore.events + 1 });

      // En ny märkning ger en ny aktiv rad bredvid den borttagna.
      const ny = await marka(hermes, H, D);
      expect(ny.status, JSON.stringify(ny.body)).toBe(200);
      expect(ny.body.result.andrad).toBe(true);
      expect((await paret(H, D)).map((r) => r.borttagen === null)).toEqual([false, true]);

      // Människan tar bort den nya märkningen.
      const DAVIDS_SKAL = 'N6 David tar bort märkningen';
      const sedanDavid = await sistaHandelseId();
      const davids = await taBort(david, H, D, DAVIDS_SKAL);
      expect(davids.status, JSON.stringify(davids.body)).toBe(200);
      expect(davids.body.result).toEqual({ identifier: H, delarende: D, andrad: true });
      expect(await nyaHandelser(sedanDavid)).toEqual([{
        verb: 'tog_bort_markning_av_delresultat', issue_id: hId, aktor_typ: 'manniska', aktor_namn: 'david',
        payload: { identifier: H, delarende: D, skal: DAVIDS_SKAL },
      }]);
      expect((await paret(H, D)).map((r) => r.borttagen === null)).toEqual([false, false]);

      expect(VERB['tog_bort_markning_av_delresultat']).toBe('tog bort märkningen av ett nödvändigt delresultat');
      expect(VERB['delresultatet_var_inte_markt']).toBe('delresultatet var inte märkt som nödvändigt');
    });

    it('N7 (AK 6): utan skäl, med tomt skäl och med NUL-tecken blir det validation_error på skal och noll rader', async () => {
      const H = await iLage('overtaget', 'N7 huvud');
      const D = await delarende(H, 'N7 delärende', 'inget');
      await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: D });
      const fore = await noll(H);
      const parFore = await paret(H, D);
      const fall: [string, Record<string, unknown>][] = [
        ['utan skal', { identifier: H, delarende: D }],
        ['tomt skal', { identifier: H, delarende: D, skal: '' }],
        ['NUL i skal', { identifier: H, delarende: D, skal: 'N7 skäl med \u0000 i' }],
      ];
      for (const [namn, input] of fall) {
        schemafel(await kor(app, hermes, 'ta_bort_nodvandigt_delresultat', input), 'skal', namn);
        expect(await noll(H), namn).toEqual(fore);
        expect(await paret(H, D), namn).toEqual(parFore);
      }
      // Motkontroll: samma anrop med skäl tar bort märkningen.
      const ratt = await taBort(hermes, H, D, 'N7 motkontroll');
      expect(ratt.status, JSON.stringify(ratt.body)).toBe(200);
      expect(ratt.body.result).toEqual({ identifier: H, delarende: D, andrad: true });
      expect(await noll(H)).toEqual({ ...fore, events: fore.events + 1 });
    });

    it('N8 (AK 6): en märkning som aldrig funnits eller redan är borttagen ger eget no-op-verb och ingen ändring', async () => {
      const H = await iLage('overtaget', 'N8 huvud');
      const aldrig = await delarende(H, 'N8 aldrig märkt', 'inget');
      const redan = await delarende(H, 'N8 redan borttagen', 'inget');
      const hId = await issueId(H);
      await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: redan });
      await steg(hermes, 'ta_bort_nodvandigt_delresultat', { identifier: H, delarende: redan, skal: 'N8 förberedelse' });
      const fore = await noll(H);
      const parFore = await paret(H, redan);
      for (const del of [aldrig, redan]) {
        const skal = `N8 ${del} är inte märkt`;
        const sedan = await sistaHandelseId();
        const svar = await taBort(hermes, H, del, skal);
        expect(svar.status, JSON.stringify(svar.body)).toBe(200);
        expect(svar.body.result).toEqual({ identifier: H, delarende: del, andrad: false });
        expect(await nyaHandelser(sedan)).toEqual([{
          verb: 'delresultatet_var_inte_markt', issue_id: hId, aktor_typ: 'agent', aktor_namn: 'hermes',
          payload: { identifier: H, delarende: del, skal },
        }]);
      }
      expect(await noll(H)).toEqual({ ...fore, events: fore.events + 2 });
      expect(await paret(H, redan)).toEqual(parFore);
      expect(await paret(H, aldrig)).toEqual([]);
    });
  });

  describe('FR-16/Story 5.5 AK 1–4: ett saknat märkt delresultat spärrar, och bara det', () => {
    const SAKNAR: { lage: Lage | 'inget' }[] = [
      { lage: 'registrerat' }, { lage: 'overtaget' }, { lage: 'hindrat' }, { lage: 'avslutat' }, { lage: 'inget' },
    ];
    it.each(SAKNAR)(
      'N9 (AK 1, AK 3, AK 4): delärendet i läget $lage spärrar — ett avslut utan resultat gör inte delresultatet onödigt; bara en borttagen märkning med skäl gör det',
      async ({ lage }) => {
        const H = await iLage('overtaget', `N9 huvud (${lage})`);
        const D = await delarende(H, `N9 delärende (${lage})`, lage);
        await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: D });
        await sparrad(H, [{ identifier: D, lage: lage === 'inget' ? null : lage }], lage);
        // Motkontroll: delärendet får sitt resultat, och exakt samma redovisning av huvudet går igenom.
        await geResultat(D, lage);
        await genomford(H, lage);
      },
    );

    it('N10 (AK 1, AK 3): ett delärende utan åtagande saknar resultat oavsett ärendets tillstånd', async () => {
      for (const tillstand of ['completed', 'canceled'] as const) {
        const H = await iLage('overtaget', `N10 huvud (${tillstand})`);
        const D = await delarende(H, `N10 märkt (${tillstand})`, 'inget');
        const syskon = await delarende(H, `N10 omärkt syskon (${tillstand})`, 'inget');
        await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: D });
        for (const id of [D, syskon]) {
          await steg(hermes, 'update_issue_state', { identifier: id, state_typ: tillstand });
          expect((await steg(hermes, 'get_issue', { identifier: id })).arende.state_typ, id).toBe(tillstand);
        }
        // Det omärkta syskonet i samma tillstånd står inte i listan.
        await sparrad(H, [{ identifier: D, lage: null }], tillstand);
      }

      // Källtexten: spärrens fråga läser aldrig ärendets tillstånd.
      const tillstandIKroppen = (kropp: string): string[] =>
        [...kodrader(kropp).matchAll(/\b(state_id|workflow_states)\b/g)].map((m) => m[1]!);
      const kropp = funktionskropp(readFileSync(path.join(SRC, 'services', 'atagande.ts'), 'utf8'), 'saknadeDelresultat');
      expect(kropp, 'saknadeDelresultat finns').not.toBeNull();
      expect(tillstandIKroppen(kropp!)).toEqual([]);
      // Kontroll: samma läsning av en påhittad kropp som läser tillståndet ger ett fynd.
      const pahittad = [
        'export async function saknadeDelresultat(client) {',
        "  return client.query('SELECT d.state_id FROM issues d');",
        '}',
        'export const efter = 1;',
      ].join('\n');
      expect(tillstandIKroppen(funktionskropp(pahittad, 'saknadeDelresultat')!)).toEqual(['state_id']);
    });

    it('N11 (AK 1): två saknade och ett befintligt delresultat — details bär exakt de två, i nummerordning', async () => {
      const H = await iLage('overtaget', 'N11 huvud');
      const D1 = await delarende(H, 'N11 D1 registrerat', 'registrerat');
      const D2 = await delarende(H, 'N11 D2 utan åtagande', 'inget');
      const D3 = await delarende(H, 'N11 D3 genomfört', 'genomfort');
      // Märkta i omvänd ordning, så att ordningen i details är numrens och inte märkningarnas.
      for (const del of [D3, D2, D1]) {
        await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: del });
      }
      await sparrad(H, [{ identifier: D1, lage: 'registrerat' }, { identifier: D2, lage: null }]);
    });

    it('N12 (AK 2, AK 7): delärende med öppet åtagande men utan märkning spärrar inte', async () => {
      const H = await iLage('overtaget', 'N12 huvud');
      const M1 = await delarende(H, 'N12 M1 märkt, genomfört', 'genomfort');
      const M2 = await delarende(H, 'N12 M2 märkt, registrerat', 'registrerat');
      const U1 = await delarende(H, 'N12 U1 omärkt, registrerat', 'registrerat');
      const U2 = await delarende(H, 'N12 U2 omärkt, övertaget', 'overtaget');
      const U3 = await delarende(H, 'N12 U3 omärkt, hindrat', 'hindrat');
      const U4 = await delarende(H, 'N12 U4 omärkt, utan åtagande', 'inget');
      for (const del of [M1, M2]) await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: del });

      // Motkontroll först: spärren är igång, och de fyra omärkta står inte i listan.
      await sparrad(H, [{ identifier: M2, lage: 'registrerat' }]);
      for (const omarkt of [U1, U2, U3, U4]) expect(await paret(H, omarkt), omarkt).toEqual([]);

      await geResultat(M2, 'registrerat');
      // Huvudet redovisas, fast U1–U3 har öppna åtaganden: barnräkningen finns inte längre.
      await genomford(H);
      for (const [omarkt, lage] of [[U1, 'registrerat'], [U2, 'overtaget'], [U3, 'hindrat']] as const) {
        expect((await steg(hermes, 'get_atagande', { identifier: omarkt })).lage, omarkt).toBe(lage);
      }
    });

    it('N13 (AK 6): efter borttagningen med skäl spärrar delresultatet inte längre', async () => {
      const H = await iLage('overtaget', 'N13 huvud');
      const D = await delarende(H, 'N13 delärende', 'registrerat');
      await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: D });
      await sparrad(H, [{ identifier: D, lage: 'registrerat' }]);
      await steg(hermes, 'ta_bort_nodvandigt_delresultat', {
        identifier: H, delarende: D, skal: 'N13 delresultatet ingår i ett annat åtagande',
      });
      await genomford(H);
      expect((await steg(hermes, 'get_atagande', { identifier: D })).lage).toBe('registrerat');
    });
  });

  describe('FR-16/Story 5.5 AK 5: spärren gäller på varje väg till genomfört', () => {
    it('N14 (AK 5): statusen, ändringen och källtexten når inte genomfört förbi spärren, och redovisningen spärras', async () => {
      const H = await iLage('overtaget', 'N14 huvud');
      const D = await delarende(H, 'N14 delärende', 'registrerat');
      await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H, delarende: D });
      const fore = await noll(H);

      // (a) Ärendets status kan inte stänga åtagandet (B-02, regression).
      avvisad(await kor(app, hermes, 'update_issue_state', { identifier: H, state_typ: 'completed' }),
        'atagandet_styr_statusen', '(a)');
      expect(await noll(H), '(a)').toEqual(fore);

      // (b) Ändringen har inget lägesfält.
      okantFalt(await kor(app, hermes, 'andra_atagande', {
        identifier: H, lage: 'genomfort', skal: 'N14 försöker sätta läget', forvantad_revision: await revisionNu(H),
      }), 'lage');
      expect(await noll(H), '(b)').toEqual(fore);

      // (c) I källtexten skrivs läget genomfört på ett enda ställe, i redovisaResultat, och läget
      // skrivs bara av en enda sats.
      const filer = kallfilerISrc();
      expect(filer.map((f) => f.fil), 'hittade inga källfiler').toContain('services/atagande.ts');
      const OVERGANG = bokstavlig("kravOvergang(fran, 'genomfort')");
      const LAGET = bokstavlig("lage: 'genomfort'");
      const SATS = /\bSET\s+atagande_lage\b/;
      expect(traffar(filer, OVERGANG), '(c) övergången').toEqual({ 'services/atagande.ts': 1 });
      expect(traffar(filer, LAGET), '(c) läget').toEqual({ 'services/atagande.ts': 1 });
      expect(traffar(filer, SATS), '(c) satsen').toEqual({ 'services/atagande.ts': 1 });
      const kropp = funktionskropp(readFileSync(path.join(SRC, 'services', 'atagande.ts'), 'utf8'), 'redovisaResultat');
      expect(kropp, 'redovisaResultat finns').not.toBeNull();
      expect(traffar([{ fil: 'redovisaResultat', text: kropp! }], OVERGANG)).toEqual({ redovisaResultat: 1 });
      expect(traffar([{ fil: 'redovisaResultat', text: kropp! }], LAGET)).toEqual({ redovisaResultat: 1 });
      // Kontroll: två förekomster i en påhittad text ger två, också när satsen bryts över raderna.
      const pahittad = [
        "kravOvergang(fran, 'genomfort');",
        "return skriv({ lage: 'genomfort' });",
        "kravOvergang(fran, 'genomfort');",
        "return skriv({ lage: 'genomfort' });",
        'UPDATE issues SET atagande_lage = $2',
        'UPDATE issues SET',
        '  atagande_lage = $3',
      ].join('\n');
      const text = [{ fil: 'pahittad.ts', text: pahittad }];
      expect([traffar(text, OVERGANG), traffar(text, LAGET), traffar(text, SATS)]).toEqual([
        { 'pahittad.ts': 2 }, { 'pahittad.ts': 2 }, { 'pahittad.ts': 2 },
      ]);

      // (d) Redovisningen själv spärras.
      await sparrad(H, [{ identifier: D, lage: 'registrerat' }], '(d)');
      expect(await noll(H), '(d)').toEqual(fore);
    });

    it('N15 (AK 2, AK 5): ett flyttat delärende släpper inte sitt gamla huvud och spärrar inte sitt nya', async () => {
      const H1 = await iLage('overtaget', 'N15 H1');
      const H2 = await iLage('overtaget', 'N15 H2');
      const D = await delarende(H1, 'N15 delärende', 'registrerat');
      await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: H1, delarende: D });
      await steg(hermes, 'update_issue', { identifier: D, parent: H2 });
      expect((await steg(hermes, 'get_issue', { identifier: D })).arende.foralder_identifier).toBe(H2);

      // Flytten släppte inte H1: märkningen gäller paret.
      await sparrad(H1, [{ identifier: D, lage: 'registrerat' }], 'H1');
      // D är öppet under H2 men inte märkt för H2, och barnräkningen finns inte längre.
      await genomford(H2, 'H2');
      // Bara borttagningen med skäl släpper H1.
      await steg(hermes, 'ta_bort_nodvandigt_delresultat', {
        identifier: H1, delarende: D, skal: 'N15 delärendet hör nu till H2',
      });
      await genomford(H1, 'H1');
    });
  });

  describe('FR-16/Story 5.5 AK 7: barnräkningen är borta', () => {
    it('N16 (AK 7): inget av barnräkningens namn finns i src/, och 5.3:s block för den är borttaget', () => {
      const filer = kallfilerISrc();
      // Kontroll: läsningen fick med filerna, så att en tom fillista inte ger ett grönt utfall.
      expect(filer.map((f) => f.fil)).toEqual(expect.arrayContaining(['services/atagande.ts', 'actions/registry.ts']));
      const fynd = filer.flatMap(({ fil, text }) =>
        [...text.matchAll(/\b(antal_oavslutade_barn|delarbete_aterstar)\b/g)].map((m) => `${fil}: ${m[1]}`));
      expect(fynd).toEqual([]);

      const kontrakt = readFileSync(path.join(ROT, 'test', 'atagande-kontrakt.test.ts'), 'utf8');
      expect(kontrakt).toContain("describe('FR-16/Story 5.3: åtagandets datakontrakt är provat i varje led'");
      expect(kontrakt).not.toMatch(/\bdelarbete_aterstar\b/);
      expect(kontrakt.split('\n').filter((rad) => rad.includes('AK 6: delresultatspärren i dagens form'))).toEqual([]);
    });
  });
});
