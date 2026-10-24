// FR-17, B-06 (Story 5.4): arbetsmomenten bär alltid aktören ur nyckeln. Momentradens aktor_typ och
// aktor_namn är nyckelns aktör och dess tidpunkt skrivtiden, också på den historiska vägen; ett påstående
// om en annan aktör eller tid står bara i radens belagg, under nyckeln historisk, på en rad märkt
// historisk = true, och arbetsandel räknar bara observationer.
//
// Filen visar AK 1–4, var och en med fall som blir röda om regeln tas bort:
//   - vanlig loggning bär nyckelns aktör, och aktören går inte att skicka in (AK 1: M1, M2);
//   - app-rollen kan inte skriva om en momentrad, och historisk godtas i dagens form (AK 4: M3, M4);
//   - den historiska vägen tar aktören och tiden ur nyckeln och skrivningen, i en enda skrivare
//     (AK 2: M5, M6);
//   - arbetsandel räknar observationer, aldrig påståenden, och utan observation ingen siffra (AK 3: M7);
//   - README bär regeln (M8).
// "Noll rader" betyder att räkningen av events och arbetsmoment är oförändrad. Varje regressionsfall har
// en motkontroll i samma it, som visar att mätningen kan slå ut. Databasen återskapas bara före varje
// provfil, så varje fall läser bara rader över sitt eget utgångsläge och mäter bara sina egna fönster.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

/** Den påstådda tiden: 2026-09-05 kl. 09.00 UTC, och samma dag kl. 11.00 med zonen plus två timmar. */
const PASTADD_TID = '2026-09-05T09:00:00Z';
const PASTADD_TID_ZON = '2026-09-05T11:00:00+02:00';

const ROT = fileURLToPath(new URL('../', import.meta.url));
const SRC = path.join(ROT, 'src');
const README = path.join(ROT, 'README.md');
const RUBRIKEN = '### FR-17 — arbetsmomenten bär aktören ur nyckeln (Story 5.4)';
/** Ordagrant som i regelkällan (berättelsens Dev Notes → Till regelkällan). */
const REGELN =
  '- Arbetsmomenten (FR-17, B-06, Story 5.4): `loggaMoment` i `src/services/atagande.ts` är den enda som ' +
  'skriver `arbetsmoment`, och momentradens `aktor_typ`, `aktor_namn` och `tidpunkt` är alltid nyckelns ' +
  'aktör och skrivtiden, aldrig indata. `logga_moment` behåller fältet `historisk` i samma form för ' +
  'Åtagandenas anropare, men den påstådda aktören och tiden sparas bara som påstående i `belagg.historisk` ' +
  '(`pastadd_aktor_typ`, `pastadd_aktor_namn`, `pastadd_tidpunkt`), och raden märks `historisk = true`. ' +
  '`arbetsandel` räknar bara rader med `historisk = false` och ger `andel_manniska` null när fönstret ' +
  'saknar observationer.';

type Svar = { status: number; body: { error?: string; details?: unknown; result?: Record<string, unknown> } };

let app: Express;
let hermes: string; // agent
let david: string; // människa
let systemet: string; // system
let identifier: string; // provets ärende
let issueId: string; // ärendets uuid, som momentraden och händelseraden bär

/** Ett tyst 400 i förberedelserna får aldrig bära ett senare fall. */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
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

/** Den senaste händelseradens id, som utgångsläge för nyaHandelser. */
async function sistaHandelseId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM events');
  return rows[0]!.id;
}

/** Händelseraderna efter `sedan`, i ordning. Payloaden står som den skrevs. */
async function nyaHandelser(sedan: string) {
  const { rows } = await pool.query(
    'SELECT verb, issue_id, aktor_typ, aktor_namn, payload FROM events WHERE id > $1 ORDER BY id',
    [sedan],
  );
  return rows;
}

/**
 * Databasens klocka som text i UTC med mikrosekunder: tidsstämplarna har mikrosekunder, och JavaScripts
 * Date bara millisekunder. T och Z står inom citattecken, eftersom to_char annars läser DDTH som dagen
 * med ordningsändelse, och AT TIME ZONE 'UTC' behövs, eftersom to_char skriver sessionens tidszon.
 */
async function klockan(): Promise<string> {
  const { rows } = await pool.query<{ t: string }>(
    `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`,
  );
  return rows[0]!.t;
}

/** Den senaste momentradens id, som utgångsläge för nyaMoment. */
async function sistaMomentId(): Promise<string> {
  const { rows } = await pool.query<{ id: string }>('SELECT coalesce(max(id), 0)::text AS id FROM arbetsmoment');
  return rows[0]!.id;
}

/** Momentraderna efter `sedan`, i ordning; i_fonstret är om tidpunkt ligger i [fran, till], jämfört i Postgres. */
async function nyaMoment(sedan: string, fran: string, till: string) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, issue_id, aktor_typ, aktor_namn, historisk, belagg,
            tidpunkt BETWEEN $2::timestamptz AND $3::timestamptz AS i_fonstret
       FROM arbetsmoment
      WHERE id > $1
      ORDER BY id`,
    [sedan, fran, till],
  );
  return rows;
}

/** M3:s ögonblicksbild: hela tabellen, med tiden som text så att mikrosekunderna jämförs. */
async function momentbild() {
  const { rows } = await pool.query(
    `SELECT id::text AS id, aktor_typ, aktor_namn, historisk, belagg, tidpunkt::text AS tidpunkt
       FROM arbetsmoment
      ORDER BY id`,
  );
  return rows;
}

/** logga_moment på provets ärende. */
function logga(nyckel: string, input: Record<string, unknown>) {
  return kor(app, nyckel, 'logga_moment', { identifier, ...input });
}

/** "Noll rader": räkningen av events och arbetsmoment. */
async function noll() {
  return { events: await raknaRader('events'), moment: await raknaRader('arbetsmoment') };
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

/** arbetsandel över fönstret [fran, till), genom API:t. */
async function andel(fran: string, till: string) {
  return steg(hermes, 'arbetsandel', { fran, till });
}

/** Avsnittets rader, från rubriken till nästa rubrik på nivå två eller tre, och dess gränser. */
function avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/** Fynden för README:s avsnitt: rubriken, regelns rad exakt en gång och tre tabellrader för FR-17. */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const fel: string[] = [];
  const regler = avsnitt.filter((r) => r.startsWith('- Arbetsmomenten (FR-17, B-06, Story 5.4):'));
  if (regler.length !== 1) fel.push(`regelns rad står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regeln avviker');
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-17'));
  if (tabell.length !== 3) fel.push(`${tabell.length} tabellrader för FR-17, inte 3`);
  for (const r of tabell) if (!r.includes('test/arbetsmoment.test.ts')) fel.push(`utan provfilen: ${r}`);
  return fel;
}

describe('FR-17/Story 5.4: arbetsmomenten bär alltid aktören ur nyckeln', () => {
  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
    systemet = await nyNyckel({ typ: 'system', namn: 'momentprov' });
    const arendet = await steg(hermes, 'create_issue', { title: 'Story 5.4 arbetsmomenten', team_key: 'LOC' });
    identifier = arendet.identifier as string;
    issueId = arendet.id as string;
  });

  describe('FR-17/Story 5.4 AK 1: vanlig loggning (regression)', () => {
    it('M1 (AK 1): utan historisk bär momentraden och händelseraden nyckelns aktör, beläggen som de skickades och skrivtiden', async () => {
      const BELAGG = { kalla: 'prov', id: 'arbetsmoment' };
      const anrop: {
        etikett: string; nyckel: string; typ: string; namn: string; belagg?: Record<string, unknown>;
      }[] = [
        { etikett: 'agenten med belägg', nyckel: hermes, typ: 'agent', namn: 'hermes', belagg: BELAGG },
        { etikett: 'agenten utan belägg', nyckel: hermes, typ: 'agent', namn: 'hermes' },
        { etikett: 'människan med belägg', nyckel: david, typ: 'manniska', namn: 'david', belagg: BELAGG },
        { etikett: 'människan utan belägg', nyckel: david, typ: 'manniska', namn: 'david' },
        // Tolkning 2: på en observerad rad står belagg som det skickades, också en egen nyckel historisk.
        {
          etikett: 'agenten med belagg.historisk men utan fältet historisk',
          nyckel: hermes, typ: 'agent', namn: 'hermes', belagg: { historisk: 'klientens text' },
        },
      ];
      const start = await sistaMomentId();
      for (const a of anrop) {
        const handelser = await sistaHandelseId();
        const moment = await sistaMomentId();
        const fran = await klockan();
        const svar = await logga(a.nyckel, { moment: 'utfora', ...(a.belagg ? { belagg: a.belagg } : {}) });
        const till = await klockan();
        expect(svar.status, `${a.etikett}: ${JSON.stringify(svar.body)}`).toBe(200);
        expect(svar.body.result, a.etikett).toEqual({ id: expect.stringMatching(/^\d+$/) });
        const id = svar.body.result.id as string;
        expect(await nyaMoment(moment, fran, till), a.etikett).toEqual([{
          id, issue_id: issueId, aktor_typ: a.typ, aktor_namn: a.namn, historisk: false,
          belagg: a.belagg ?? {}, i_fonstret: true,
        }]);
        expect(await nyaHandelser(handelser), a.etikett).toEqual([{
          verb: 'skrev_arbetsmoment', issue_id: issueId, aktor_typ: a.typ, aktor_namn: a.namn,
          payload: { moment_id: id, moment: 'utfora', beslut_id: null, historisk: false },
        }]);
      }

      // Kontroll: mätningen kan slå ut. Ett fönster före anropen ger false för varje rad, och
      // aktörerna skiljer sig åt mellan nycklarna, så likheterna ovan säger något.
      const utanfor = await nyaMoment(start, '2020-01-01T00:00:00Z', '2020-01-02T00:00:00Z');
      expect(utanfor.map((r) => r.i_fonstret)).toEqual([false, false, false, false, false]);
      expect(utanfor.map((r) => `${r.aktor_typ} · ${r.aktor_namn}`)).toEqual([
        'agent · hermes', 'agent · hermes', 'manniska · david', 'manniska · david', 'agent · hermes',
      ]);
    });

    it('M2 (AK 1): aktor_typ eller aktor_namn i indata avvisas med noll rader, och utan fältet går anropet igenom', async () => {
      for (const [falt, varde] of [['aktor_typ', 'manniska'], ['aktor_namn', 'david']] as const) {
        const fore = await noll();
        const svar = await logga(hermes, { moment: 'utfora', [falt]: varde });
        okantFalt(svar, falt);
        expect(await noll(), falt).toEqual(fore);
      }

      // Motkontroll: samma anrop utan fältet ger 200 och en rad till, med agentens aktör.
      const moment = await sistaMomentId();
      const fore = await noll();
      const fran = await klockan();
      const svar = await logga(hermes, { moment: 'utfora' });
      const till = await klockan();
      expect(svar.status, JSON.stringify(svar.body)).toBe(200);
      expect(await noll()).toEqual({ events: fore.events + 1, moment: fore.moment + 1 });
      expect(await nyaMoment(moment, fran, till)).toEqual([
        expect.objectContaining({ aktor_typ: 'agent', aktor_namn: 'hermes', historisk: false, i_fonstret: true }),
      ]);
    });
  });

  describe('FR-17/Story 5.4 AK 4: bakåtkompatibelt och append-only', () => {
    it('M3 (AK 4): app-rollen får 42501 på UPDATE och DELETE av arbetsmoment, och raderna är oförändrade', async () => {
      const s0 = await momentbild();
      await steg(hermes, 'logga_moment', { identifier, moment: 'kontrollera' });
      const s1 = await momentbild();
      // Kontroll: ögonblicksbilden kan röra sig, så likheten nedan säger något.
      expect(s1).not.toEqual(s0);

      await expect(pool.query("UPDATE arbetsmoment SET aktor_namn = 'omskriven'"))
        .rejects.toMatchObject({ code: '42501' });
      await expect(pool.query('DELETE FROM arbetsmoment')).rejects.toMatchObject({ code: '42501' });

      expect(await momentbild()).toEqual(s1);
    });

    it('M4 (AK 4): historisk i dagens form godtas för varje aktörstyp och tid, och schemat avvisar som förut', async () => {
      const PASTADDA = { manniska: 'david', agent: 'hermes', system: 'arkivet' } as const;
      const fore = await noll();
      for (const aktor_typ of ['manniska', 'agent', 'system'] as const) {
        for (const tidpunkt of [PASTADD_TID, PASTADD_TID_ZON]) {
          const etikett = `${aktor_typ} ${tidpunkt}`;
          const moment = await sistaMomentId();
          const fran = await klockan();
          const svar = await logga(hermes, {
            moment: 'hitta_underlag',
            historisk: { aktor_typ, aktor_namn: PASTADDA[aktor_typ], tidpunkt },
          });
          const till = await klockan();
          expect(svar.status, `${etikett}: ${JSON.stringify(svar.body)}`).toBe(200);
          // M4 prövar bara att anropet godtas och raden är historisk; radens aktör prövar M5.
          const rader = await nyaMoment(moment, fran, till);
          expect(rader.map((r) => ({ id: r.id, historisk: r.historisk })), etikett).toEqual([
            { id: svar.body.result.id, historisk: true },
          ]);
        }
      }
      // Kontroll: räkningen rör sig för de sex godtagna anropen, så noll rader nedan säger något.
      expect(await noll()).toEqual({ events: fore.events + 6, moment: fore.moment + 6 });

      const GILTIG = { aktor_typ: 'manniska', aktor_namn: 'david', tidpunkt: PASTADD_TID };
      const avvisningar: { etikett: string; historisk: Record<string, unknown>; path: string; message?: string }[] = [
        {
          etikett: 'okänt fält i historisk', historisk: { ...GILTIG, kalla: 'arkiv' },
          path: 'historisk', message: "Unrecognized key(s) in object: 'kalla'",
        },
        {
          etikett: 'historisk utan tidpunkt', historisk: { aktor_typ: 'manniska', aktor_namn: 'david' },
          path: 'historisk.tidpunkt',
        },
        {
          etikett: 'en tid utan zon', historisk: { ...GILTIG, tidpunkt: '2026-09-05T09:00:00' },
          path: 'historisk.tidpunkt',
        },
        {
          etikett: 'en okänd aktörstyp', historisk: { ...GILTIG, aktor_typ: 'robot' },
          path: 'historisk.aktor_typ',
        },
      ];
      for (const a of avvisningar) {
        const fore = await noll();
        const svar = await logga(hermes, { moment: 'hitta_underlag', historisk: a.historisk });
        schemafel(svar, a.path, a.etikett);
        if (a.message) expect(svar.body.details, a.etikett).toContainEqual({ path: a.path, message: a.message });
        expect(await noll(), a.etikett).toEqual(fore);
      }
    });
  });

  describe('FR-17/Story 5.4 AK 2: den historiska vägen tar inte aktören ur indata', () => {
    it('M5 (AK 2): den historiska raden bär nyckelns aktör och skrivtiden, och påståendet står i belagg.historisk', async () => {
      const pastadd = (typ: string, namn: string, tid = PASTADD_TID) => ({
        pastadd_aktor_typ: typ, pastadd_aktor_namn: namn, pastadd_tidpunkt: tid,
      });
      const varianter: {
        etikett: string; nyckel: string; typ: string; namn: string;
        historisk: { aktor_typ: string; aktor_namn: string; tidpunkt: string };
        belagg?: Record<string, unknown>; vantat: Record<string, unknown>;
      }[] = [
        {
          etikett: '(a) agenten påstår manniska · david, med belägg',
          nyckel: hermes, typ: 'agent', namn: 'hermes',
          historisk: { aktor_typ: 'manniska', aktor_namn: 'david', tidpunkt: PASTADD_TID },
          belagg: { kalla: 'arkiv', rad: 12 },
          vantat: { kalla: 'arkiv', rad: 12, historisk: pastadd('manniska', 'david') },
        },
        {
          // Tolkning 3: den påstådda tiden står ordagrant, med zonen kvar och inte omräknad till UTC.
          etikett: '(b) människan påstår agent · hermes, utan belägg och med zonen plus två timmar',
          nyckel: david, typ: 'manniska', namn: 'david',
          historisk: { aktor_typ: 'agent', aktor_namn: 'hermes', tidpunkt: PASTADD_TID_ZON },
          vantat: { historisk: pastadd('agent', 'hermes', PASTADD_TID_ZON) },
        },
        {
          etikett: '(c) systemnyckeln påstår manniska · david',
          nyckel: systemet, typ: 'system', namn: 'momentprov',
          historisk: { aktor_typ: 'manniska', aktor_namn: 'david', tidpunkt: PASTADD_TID },
          vantat: { historisk: pastadd('manniska', 'david') },
        },
        {
          etikett: '(d) agenten påstår sig själv',
          nyckel: hermes, typ: 'agent', namn: 'hermes',
          historisk: { aktor_typ: 'agent', aktor_namn: 'hermes', tidpunkt: PASTADD_TID },
          vantat: { historisk: pastadd('agent', 'hermes') },
        },
        {
          // Tolkning 2: påståendet vinner över en skickad belagg.historisk, och de övriga beläggen står kvar.
          etikett: '(e) de skickade beläggen har redan nyckeln historisk',
          nyckel: hermes, typ: 'agent', namn: 'hermes',
          historisk: { aktor_typ: 'manniska', aktor_namn: 'david', tidpunkt: PASTADD_TID },
          belagg: { kalla: 'arkiv', historisk: 'klientens text' },
          vantat: { kalla: 'arkiv', historisk: pastadd('manniska', 'david') },
        },
        {
          etikett: '(f) agenten påstår system · arkivet',
          nyckel: hermes, typ: 'agent', namn: 'hermes',
          historisk: { aktor_typ: 'system', aktor_namn: 'arkivet', tidpunkt: PASTADD_TID },
          vantat: { historisk: pastadd('system', 'arkivet') },
        },
      ];
      for (const v of varianter) {
        const handelser = await sistaHandelseId();
        const moment = await sistaMomentId();
        const fran = await klockan();
        const svar = await logga(v.nyckel, {
          moment: 'hitta_underlag',
          historisk: v.historisk,
          ...(v.belagg ? { belagg: v.belagg } : {}),
        });
        const till = await klockan();
        expect(svar.status, `${v.etikett}: ${JSON.stringify(svar.body)}`).toBe(200);
        const id = svar.body.result.id as string;
        expect(await nyaMoment(moment, fran, till), v.etikett).toEqual([{
          id, issue_id: issueId, aktor_typ: v.typ, aktor_namn: v.namn, historisk: true,
          belagg: v.vantat, i_fonstret: true,
        }]);
        expect(await nyaHandelser(handelser), v.etikett).toEqual([{
          verb: 'skrev_arbetsmoment', issue_id: issueId, aktor_typ: v.typ, aktor_namn: v.namn,
          payload: { moment_id: id, moment: 'hitta_underlag', beslut_id: null, historisk: true },
        }]);
      }
    });

    it('M6 (AK 2): arbetsmoment har en enda skrivare, och den anropas på ett enda ställe, med ctx.aktor', () => {
      const INSERT = /\binsert\s+into\s+arbetsmoment\b/;
      const ANROP = /\bloggaMoment\(/;
      // Kontroll: räkningen slår ut på en påhittad fil med två satser, den ena delad över två rader.
      const pahittad = [{
        fil: 'pahittad.ts',
        text: "await c.query('INSERT INTO arbetsmoment (moment) VALUES ($1)', [m]);\n" +
          'await c.query(`insert into\n     arbetsmoment (moment) VALUES ($1)`, [m]);',
      }];
      expect(traffar(pahittad, INSERT)).toEqual({ 'pahittad.ts': 2 });

      const filer = kallfilerISrc();
      expect(filer.map((f) => f.fil), 'hittade inga källfiler').toEqual(
        expect.arrayContaining(['services/atagande.ts', 'actions/registry.ts']),
      );
      expect(traffar(filer, INSERT)).toEqual({ 'services/atagande.ts': 1 });
      expect(traffar(filer, ANROP)).toEqual({ 'actions/registry.ts': 1, 'services/atagande.ts': 1 });
      expect(readFileSync(path.join(SRC, 'actions', 'registry.ts'), 'utf8'))
        .toContain('loggaMoment(ctx.client, ctx.tenantId, ctx.aktor,');
    });
  });

  describe('FR-17/Story 5.4 AK 3: mätningen påverkas inte av påståenden', () => {
    it('M7 (AK 3): arbetsandel räknar bara observerade moment, och ett fönster utan observationer ger null', async () => {
      // De historiska radernas påstådda tid är fönstrets början, så att raderna ligger i fönstret både med
      // koden före Story 5.4, som skrev den påstådda tiden, och efter, som skriver skrivtiden. Bara
      // villkoret historisk = false håller dem utanför mätningen.
      const pastar = (nyckel: string, moment: string, aktor_typ: string, aktor_namn: string, tidpunkt: string) =>
        steg(nyckel, 'logga_moment', { identifier, moment, historisk: { aktor_typ, aktor_namn, tidpunkt } });

      // W1: bara historiska rader.
      const w1fran = await klockan();
      await pastar(hermes, 'avgora_riktning', 'manniska', 'david', w1fran);
      await pastar(hermes, 'avgora_riktning', 'manniska', 'david', w1fran);
      await pastar(david, 'utfora', 'agent', 'hermes', w1fran);
      const w1till = await klockan();
      expect(await andel(w1fran, w1till), 'W1').toEqual({
        fran: w1fran, till: w1till, moment_totalt: 0, moment_manniska: 0, andel_manniska: null, per_moment: [],
      });

      // W2: en observerad människa, en observerad agent och två historiska rader som påstår människa.
      const w2fran = await klockan();
      await steg(david, 'logga_moment', { identifier, moment: 'avgora_riktning' });
      await steg(hermes, 'logga_moment', { identifier, moment: 'utfora' });
      await pastar(hermes, 'avgora_riktning', 'manniska', 'david', w2fran);
      await pastar(hermes, 'avgora_riktning', 'manniska', 'david', w2fran);
      const w2till = await klockan();
      expect(await andel(w2fran, w2till), 'W2').toEqual({
        fran: w2fran, till: w2till, moment_totalt: 2, moment_manniska: 1, andel_manniska: 50,
        per_moment: [
          { moment: 'avgora_riktning', manniska: 1, agent: 0, system: 0 },
          { moment: 'utfora', manniska: 0, agent: 1, system: 0 },
        ],
      });

      // W3, motkontrollen: en observerad människa till flyttar mätningen, vilket påståendena inte gjorde.
      await steg(david, 'logga_moment', { identifier, moment: 'kontrollera' });
      const w3till = await klockan();
      expect(await andel(w2fran, w3till), 'W2 + W3').toEqual(expect.objectContaining({
        fran: w2fran, till: w3till, moment_totalt: 3, moment_manniska: 2, andel_manniska: 66.7,
      }));

      // Ett fönster utan rader: ingen siffra, aldrig noll eller en gissning.
      const fran = '2020-01-01T00:00:00Z';
      const till = '2020-01-02T00:00:00Z';
      const tomt = await kor(app, hermes, 'arbetsandel', { fran, till });
      expect(tomt.status, JSON.stringify(tomt.body)).toBe(200);
      expect(tomt.body).toEqual({
        status: 'ok',
        action: 'arbetsandel',
        result: { fran, till, moment_totalt: 0, moment_manniska: 0, andel_manniska: null, per_moment: [] },
      });
    });
  });

  describe('FR-17/Story 5.4: README bär regeln', () => {
    it('M8 (README): avsnittet för FR-17 bär regeln och tre rader krav → kod → test', () => {
      // Kontrollerna: en text utan rubriken och en text med ändrad regel och en rad utan provfilen fälls.
      expect(readmefel('annan text')).toEqual(['rubriken saknas']);
      const andrad = [
        RUBRIKEN,
        '',
        REGELN.slice(0, -1),
        '',
        '| FR-17 a | x | y | test/arbetsmoment.test.ts |',
        '| FR-17 b | x | y | test/arbetsmoment.test.ts |',
        '| FR-17 c | x | y | annat prov |',
      ].join('\n');
      expect(readmefel(andrad)).toEqual(['regeln avviker', 'utan provfilen: | FR-17 c | x | y | annat prov |']);

      expect(readmefel(readFileSync(README, 'utf8'))).toEqual([]);
    });
  });
});
