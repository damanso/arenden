// FR-16 delkrav 4 och 6, FR-32, B-01/B-02/B-05 (Story 3.2): statusen följer
// åtagandet på alla vägar. S1–S6 visar AK 1–6, S7 mätningen (AK 7), S8 klienterna
// (AK 8) och S9 den slutna listan över skrivställen och agentköns urval.
// Noll rader betyder oförändrade events/ issues-räkningar och ärendets avtryck.
// Befintliga åtaganden ändras alltid med forvantad_revision (Story 5.2).
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { VERB } from '../src/http/vy/mall.js';
import { updateIssueState, AdapterError } from '../src/adapter/index.js';
// Namnrymden låter regressionerna laddas innan berättelsens nya exporter finns.
import * as tjansten from '../src/services/atagande.js';
import type { StateTyp } from '../src/lib/validation.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const NY_GRUND = { typ: 'beslut', id: '171', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const HINDER = { typ: 'beslut', id: '145' };
const BELAGG = [{ typ: 'prov', id: 'statusharledning', version: '2026-10-23' }];
const SEN = '2026-09-30T08:00:00Z';
const SENARE = '2026-10-30T08:00:00Z';
const ROT = fileURLToPath(new URL('../', import.meta.url));
const MAL = {
  registrerat: 'unstarted', overtaget: 'started', hindrat: 'started',
  genomfort: 'completed', avslutat: 'canceled',
} as const;
type Lage = keyof typeof MAL;
const LAGEN = ['registrerat', 'overtaget', 'hindrat', 'genomfort', 'avslutat'] as const;
const TYPER = ['backlog', 'unstarted', 'started', 'completed', 'canceled'] as const;
type Svar = { status: number; body: { error?: string } };
let app: Express;
let hermes: string;
let david: string;
const stateId = {} as Record<StateTyp, string>;
const stateNamn = {} as Record<StateTyp, string>;
const korProcess = promisify(execFile);

// pythonklient.test.ts:s isolerade drivrutin. Endast det avsedda API-felet fångas.
const DRIVER = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'import arenden_klient as klient',
  'try:',
  '    resultat = klient.update_issue_state(sys.argv[2], sys.argv[3])',
  '    print(json.dumps({"ok": True, "resultat": resultat}))',
  'except klient.ArendeFel as fel:',
  '    print(json.dumps({"ok": False, "status": fel.status, "kod": fel.kod}))',
].join('\n');

async function korKlienten(hem: string, basUrl: string, identifier: string, mal: string) {
  const { stdout } = await korProcess('python3', [
    '-I', '-B', '-c', DRIVER, path.join(ROT, 'adapter'), identifier, mal,
  ], {
    cwd: ROT,
    env: { PATH: process.env.PATH, HOME: hem, ARENDEN_API_URL: basUrl, ARENDEN_API_KEY: hermes },
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim()) as {
    ok: boolean; resultat?: Record<string, unknown>; status?: number; kod?: string;
  };
}

// Samma barnprocessmönster som i atagande-invarianter.test.ts, utan laddning av en .env-fil.
async function korMatskriptet(env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await korProcess(path.join(ROT, 'node_modules', '.bin', 'tsx'),
      ['src/scripts/matStatusavvikelser.ts'], {
        cwd: ROT,
        env: { ...process.env, DOTENV_CONFIG_PATH: path.join(tmpdir(), 'status-finns-inte.env'), ...env },
        timeout: 20_000,
      });
    return { kod: 0, stdout, stderr };
  } catch (e) {
    const fel = e as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof fel.code !== 'number') throw e;
    return { kod: fel.code, stdout: fel.stdout ?? '', stderr: fel.stderr ?? '' };
  }
}

// Hjälparna följer atagande-invarianter.test.ts, med get_issue även utan åtagande.
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

async function nyttArende(titel: string): Promise<string> {
  return (await steg(hermes, 'create_issue', { title: titel, team_key: 'LOC' })).identifier;
}

async function revisionNu(identifier: string): Promise<number> {
  return (await steg(hermes, 'get_atagande', { identifier })).revision;
}

async function iLage(lage: Lage, titel: string): Promise<string> {
  const id = await nyttArende(titel);
  await steg(hermes, 'registrera_atagande', { identifier: id, grund: GRUND, nasta: INTERNT, foljs_upp: SEN });
  const vidare = async (action: string, input: Record<string, unknown>, nyckel = hermes) =>
    steg(nyckel, action, { identifier: id, ...input, forvantad_revision: await revisionNu(id) });
  if (lage === 'registrerat') return id;
  if (lage === 'hindrat') {
    await vidare('hindra_atagande', { orsak: 'Väntar på DNS', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN });
    return id;
  }
  await vidare('ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN }, david);
  if (lage === 'overtaget') return id;
  if (lage === 'genomfort') {
    await vidare('redovisa_resultat', { sammanfattning: 'Klart enligt provet', belagg: BELAGG });
  } else {
    await vidare('avsluta_atagande', { text: 'Ersatt av annat åtagande', grund: NY_GRUND });
  }
  return id;
}

// Baslinjen 23/10: S3 föll på tidsgränsen (30 s) när varje avtryck slog upp samma id över API:t igen.
// Ett ärendes id ändras aldrig och inget fall här byter team, så id:t slås upp en gång per ärende.
const ARENDE_ID = new Map<string, string>();
async function arendeId(identifier: string): Promise<string> {
  const sparat = ARENDE_ID.get(identifier);
  if (sparat !== undefined) return sparat;
  const id: string = (await steg(hermes, 'get_issue', { identifier })).arende.id;
  ARENDE_ID.set(identifier, id);
  return id;
}

async function rakningar() {
  return { events: await raknaRader('events'), issues: await raknaRader('issues') };
}

async function avtryck(identifier: string) {
  const { rows } = await pool.query(
    `SELECT state_id, uppdaterad::text, atagande_lage, atagande_tillhor, atagande_revision,
            atagande, atagande_foljs_upp::text, atagande_utforare_typ, atagande_utforare_namn,
            atagande_overtaget_nar::text FROM issues WHERE tenant_id = $1 AND id = $2`,
    [TENANT_ID, await arendeId(identifier)],
  );
  return { ...(await rakningar()), rad: rows[0] };
}

async function radNu(identifier: string) {
  const { rows } = await pool.query(
    'SELECT state_id, uppdaterad::text FROM issues WHERE tenant_id = $1 AND id = $2',
    [TENANT_ID, await arendeId(identifier)],
  );
  return rows[0];
}

async function sistaHandelse(identifier: string) {
  const { rows } = await pool.query(
    `SELECT verb, payload, aktor_typ, aktor_namn FROM events
      WHERE tenant_id = $1 AND issue_id = $2 ORDER BY id DESC LIMIT 1`,
    [TENANT_ID, await arendeId(identifier)],
  );
  return rows[0];
}

async function antalHandelser(identifier: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'SELECT count(*)::int AS n FROM events WHERE tenant_id = $1 AND issue_id = $2',
    [TENANT_ID, await arendeId(identifier)],
  );
  return rows[0]!.n;
}

async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

async function sattStateSomAgare(identifier: string, typ: StateTyp): Promise<void> {
  const id = await arendeId(identifier);
  const admin = await adminKlient();
  try {
    const svar = await admin.query('UPDATE issues SET state_id = $1 WHERE tenant_id = $2 AND id = $3',
      [stateId[typ], TENANT_ID, id]);
    expect(svar.rowCount).toBe(1);
  } finally {
    await admin.end();
  }
}

function avvisad(svar: Svar, kod: string): void {
  expect([svar.status, svar.body.error]).toEqual([400, kod]);
}

// Kopior av samtidighet.test.ts: observera låsväntan med en egen anslutning.
const vanta = (ms: number): Promise<void> => new Promise((klar) => setTimeout(klar, ms));
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

async function medOkommitteradAndring<T>(
  sql: string, parametrar: unknown[], anrop: () => PromiseLike<T>,
): Promise<T> {
  const agare = await adminKlient();
  const vakt = await adminKlient();
  try {
    await agare.query('BEGIN');
    await agare.query(sql, parametrar);
    const pagaende = Promise.resolve(anrop());
    pagaende.catch(() => undefined);
    await vantaTillsNagonVantarPaLas(vakt);
    await agare.query('COMMIT');
    return await pagaende;
  } finally {
    await agare.query('ROLLBACK').catch(() => undefined);
    await agare.end();
    await vakt.end();
  }
}

describe('FR-16/FR-32/Story 3.2: ärendets tillstånd följer åtagandet på alla vägar', () => {
  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
    const states = await steg(hermes, 'list_states', { team_key: 'LOC' });
    for (const state of states) {
      stateId[state.typ as StateTyp] = state.id;
      stateNamn[state.typ as StateTyp] = state.namn;
    }
  });

  describe('FR-16/Story 3.2 AK 5: åtagandets egna övergångar sätter statusen', () => {
    it('S5 (AK 5): de sju övergångarna ger rätt typ och läsningen ser ägarens motkontroll', async () => {
      const id = await nyttArende('S5 övergångarna');
      const steglista = [
        ['registrera_atagande', { grund: GRUND, nasta: INTERNT, foljs_upp: SEN }, 'unstarted', hermes],
        ['ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN }, 'started', david],
        ['hindra_atagande', { orsak: 'Väntar på DNS', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN }, 'started', hermes],
        ['ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN }, 'started', david],
        ['redovisa_resultat', { sammanfattning: 'Klart', belagg: BELAGG }, 'completed', hermes],
        ['aterppna_atagande', { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE }, 'unstarted', hermes],
        ['avsluta_atagande', { text: 'Ersatt', grund: NY_GRUND }, 'canceled', hermes],
      ] as const;
      for (const [action, input, typ, nyckel] of steglista) {
        await steg(nyckel, action, {
          identifier: id, ...input,
          ...(action === 'registrera_atagande' ? {} : { forvantad_revision: await revisionNu(id) }),
        });
        expect((await steg(hermes, 'get_issue', { identifier: id })).arende.state_typ, action).toBe(typ);
      }
      try {
        await sattStateSomAgare(id, 'backlog');
        expect((await steg(hermes, 'get_issue', { identifier: id })).arende.state_typ).toBe('backlog');
      } finally {
        await sattStateSomAgare(id, 'canceled');
      }
    });
  });

  describe('FR-32/Story 3.2 AK 1: ärende utan åtagande', () => {
    it('S1 (AK 1): alla fem typer via typ och id ger exakt payload, aktör och ärendet plus andrad', async () => {
      for (const vag of ['state_typ', 'state_id'] as const) {
        const id = await nyttArende(`S1 ${vag}`);
        for (const typ of ['unstarted', 'started', 'completed', 'canceled', 'backlog'] as const) {
          const fore = await steg(hermes, 'get_issue', { identifier: id });
          const n = await raknaRader('events');
          const { andrad, ...arende } = await steg(hermes, 'update_issue_state', {
            identifier: id, [vag]: vag === 'state_typ' ? typ : stateId[typ],
          });
          expect(andrad).toBe(true);
          expect(arende).toEqual((await steg(hermes, 'get_issue', { identifier: id })).arende);
          expect(arende.state_typ).toBe(typ);
          expect(await raknaRader('events')).toBe(n + 1);
          expect(await sistaHandelse(id)).toEqual({
            verb: 'andrade_status',
            payload: { identifier: id, fran: fore.arende.state_namn, till: stateNamn[typ], typ },
            aktor_typ: 'agent', aktor_namn: 'hermes',
          });
        }
      }
    });
  });

  describe('FR-32/Story 3.2 AK 2: samma tillstånd igen', () => {
    it('S2 (AK 2): fyra no-op lämnar raden orörd och visar det egna verbet i historiken', async () => {
      const utan = await nyttArende('S2 utan åtagande');
      const registrerat = await iLage('registrerat', 'S2 registrerat');
      const genomfort = await iLage('genomfort', 'S2 genomfort');
      const fall = [
        [utan, { state_typ: 'backlog' }], [utan, { state_id: stateId.backlog }],
        [registrerat, { state_typ: 'unstarted' }], [genomfort, { state_id: stateId.completed }],
      ] as const;
      for (const [id, mal] of fall) {
        const fore = await radNu(id);
        const n = await raknaRader('events');
        const { andrad, ...arende } = await steg(hermes, 'update_issue_state', { identifier: id, ...mal });
        expect(andrad).toBe(false);
        expect(await radNu(id)).toEqual(fore);
        expect(arende).toEqual((await steg(hermes, 'get_issue', { identifier: id })).arende);
        expect(await raknaRader('events')).toBe(n + 1);
        expect(await sistaHandelse(id)).toEqual({
          verb: 'status_oforandrad', payload: { identifier: id }, aktor_typ: 'agent', aktor_namn: 'hermes',
        });
      }
      expect(VERB.status_oforandrad).toBe('lämnade statusen oförändrad');
      const sida = await request(app).get(`/vy/arende/${utan}`);
      expect(sida.status).toBe(200);
      expect(sida.text).toContain('lämnade statusen oförändrad');
    });
  });

  describe('FR-16/Story 3.2 AK 3: ärende med åtagande, hela matrisen', () => {
    it.each(LAGEN)('S3 (AK 3): %s godtar bara sin härledda typ via typ och id', async (lage) => {
      expect(tjansten.STATE_FOR_LAGE).toEqual(MAL);
      const id = await iLage(lage, `S3 ${lage}`);
      const fore = await avtryck(id);
      for (const typ of TYPER.filter((t) => t !== MAL[lage])) {
        for (const mal of [{ state_typ: typ }, { state_id: stateId[typ] }]) {
          avvisad(await kor(app, hermes, 'update_issue_state', { identifier: id, ...mal }), 'atagandet_styr_statusen');
          expect(await avtryck(id)).toEqual(fore);
        }
      }
      for (const mal of [{ state_typ: MAL[lage] }, { state_id: stateId[MAL[lage]] }]) {
        const rad = await radNu(id);
        const n = await raknaRader('events');
        expect((await steg(hermes, 'update_issue_state', { identifier: id, ...mal })).andrad).toBe(false);
        expect(await radNu(id)).toEqual(rad);
        expect(await raknaRader('events')).toBe(n + 1);
        expect((await sistaHandelse(id)).verb).toBe('status_oforandrad');
      }
      // Motkontroll: samma mål godtas också när det innebär ett verkligt byte.
      await sattStateSomAgare(id, 'backlog');
      const n = await raknaRader('events');
      expect((await steg(hermes, 'update_issue_state', { identifier: id, state_typ: MAL[lage] })).andrad).toBe(true);
      expect(await raknaRader('events')).toBe(n + 1);
      expect(await sistaHandelse(id)).toMatchObject({
        verb: 'andrade_status', payload: { identifier: id, fran: 'Backlog', till: stateNamn[MAL[lage]], typ: MAL[lage] },
      });
      expect((await steg(hermes, 'get_issue', { identifier: id })).arende.state_typ).toBe(MAL[lage]);
    });
  });

  describe('FR-16/Story 3.2 AK 4: låset gör regeln sann vid samtidighet', () => {
    it('S4a (AK 4): statusbytet väntar in en okommitterad återöppning och avvisas', async () => {
      const id = await iLage('genomfort', 'S4a genomfort');
      const issue = await arendeId(id);
      const n = await antalHandelser(id);
      const svar = await medOkommitteradAndring(
        `UPDATE issues SET atagande_lage = 'registrerat', atagande = atagande - 'resultat',
                           state_id = $2, uppdaterad = now() WHERE id = $1`,
        [issue, stateId.unstarted],
        () => kor(app, hermes, 'update_issue_state', { identifier: id, state_typ: 'completed' }),
      );
      avvisad(svar, 'atagandet_styr_statusen');
      expect((await steg(hermes, 'get_issue', { identifier: id })).arende.state_typ).toBe('unstarted');
      expect(await antalHandelser(id)).toBe(n);
    });

    it('S4b (AK 4): tio samtidiga återöppningar och statusförsök lämnar härledningen intakt', async () => {
      // Varvfallet bevisar ingenting ensamt; S4a framtvingar just den farliga ordningen.
      for (let varv = 0; varv < 10; varv++) {
        const id = await iLage('genomfort', `S4b ${varv}`);
        const revision = await revisionNu(id);
        const [ateroppning, status] = await Promise.all([
          kor(app, hermes, 'aterppna_atagande', {
            identifier: id, grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE, forvantad_revision: revision,
          }),
          kor(app, hermes, 'update_issue_state', { identifier: id, state_typ: 'completed' }),
        ]);
        expect(ateroppning.status, JSON.stringify(ateroppning.body)).toBe(200);
        if (status.status === 200) expect(status.body.result.andrad).toBe(false);
        else avvisad(status, 'atagandet_styr_statusen');
        const atagande = await steg(hermes, 'get_atagande', { identifier: id });
        expect(atagande.lage).toBe('registrerat');
        expect((await steg(hermes, 'get_issue', { identifier: id })).arende.state_typ).toBe(MAL[atagande.lage as Lage]);
      }
    });

    it('S4c (AK 4): funktionen tar radlåset före sin första UPDATE och gör ingen olåst läsning', () => {
      const text = readFileSync(path.join(ROT, 'src/services/arenden.ts'), 'utf8');
      const start = text.indexOf('export async function uppdateraArendeState(');
      expect(start).toBeGreaterThan(-1);
      const slut = text.indexOf('export async function ', start + 1);
      const kod = text.slice(start, slut).split('\n')
        .filter((rad) => !/^(\/\/|\/\*|\*)/.test(rad.trimStart())).join('\n');
      expect(kod.indexOf('hamtaArendeForAndring(')).toBeGreaterThan(-1);
      expect(kod.indexOf('UPDATE issues')).toBeGreaterThan(kod.indexOf('hamtaArendeForAndring('));
      expect(kod).not.toContain('hamtaArende(');
    });
  });

  describe('FR-16/FR-32/Story 3.2 AK 6: samma regel för alla nycklar', () => {
    it('S6 (AK 6): agent och människa får exakt samma utfall med sin egen aktör på statusraderna', async () => {
      async function foljd(nyckel: string, typ: string, namn: string) {
        const utfall: unknown[] = [];
        const vantat: unknown[] = [];
        let nr = 0;
        async function prova(id: string, mal: StateTyp, status: number, andrad: boolean | null, verb: string) {
          const fore = await raknaRader('events');
          const svar = await kor(app, nyckel, 'update_issue_state', { identifier: id, state_typ: mal });
          const handelse = await sistaHandelse(id);
          const stegnummer = ++nr;
          utfall.push([stegnummer, svar.status, svar.body.error ?? null, svar.body.result?.andrad ?? null, handelse.verb]);
          vantat.push([stegnummer, status, status === 400 ? 'atagandet_styr_statusen' : null, andrad, verb]);
          expect(await raknaRader('events')).toBe(fore + (status === 200 ? 1 : 0));
          if (status === 200) expect(handelse).toMatchObject({ aktor_typ: typ, aktor_namn: namn });
        }
        const id = await nyttArende(`S6 ${typ}`);
        for (const mal of ['unstarted', 'started', 'completed', 'canceled', 'backlog'] as const) {
          await prova(id, mal, 200, true, 'andrade_status');
        }
        await prova(id, 'backlog', 200, false, 'status_oforandrad');
        const klart = await iLage('genomfort', `S6 ${typ} genomfort`);
        const resultatverb = (await sistaHandelse(klart)).verb;
        await prova(klart, 'started', 400, null, resultatverb);
        await prova(klart, 'completed', 200, false, 'status_oforandrad');
        const registrerat = await iLage('registrerat', `S6 ${typ} registrerat`);
        await prova(registrerat, 'completed', 400, null, (await sistaHandelse(registrerat)).verb);
        expect(utfall).toEqual(vantat);
        return utfall;
      }
      expect(await foljd(hermes, 'agent', 'hermes')).toEqual(await foljd(david, 'manniska', 'david'));
    });
  });

  describe('FR-16/Story 3.2: tillståndet skrivs på exakt fem ställen', () => {
    let G: string;
    let H: string;
    beforeAll(async () => {
      G = await iLage('registrerat', 'S9a G med åtagande');
      await steg(hermes, 'update_issue', { identifier: G, priority: 1 });
      H = await nyttArende('S9a H utan åtagande');
      await steg(hermes, 'update_issue', { identifier: H, priority: 1 });
    });

    it('S9a: agentkön hoppar över åtagandet och lämnar dess status, utförare och historik orörda', async () => {
      const n = await antalHandelser(G);
      const claim = await steg(hermes, 'claim_next_issue', {});
      expect(claim.identifier).toBe(H);
      expect((await steg(hermes, 'get_issue', { identifier: G })).arende).toMatchObject({
        state_typ: 'unstarted', claimad_av: null,
      });
      expect(await antalHandelser(G)).toBe(n);
      expect((await steg(hermes, 'get_atagande', { identifier: G })).lage).toBe('registrerat');
      const text = readFileSync(path.join(ROT, 'src/services/arenden.ts'), 'utf8');
      const start = text.indexOf('export async function claimaNastaArende(');
      expect(start).toBeGreaterThan(-1);
      const slut = text.indexOf('export async function ', start + 1);
      const kod = text.slice(start, slut).split('\n')
        .filter((rad) => !/^(\/\/|\/\*|\*)/.test(rad.trimStart())).join('\n');
      expect(kod).toContain('atagande_lage IS NULL');
    });

    it('S9b: den slutna listan räknar två skapanden och tre tilldelningar av state_id', () => {
      const src = path.join(ROT, 'src');
      const filer = readdirSync(src, { recursive: true }).map(String).filter((f) => f.endsWith('.ts')).sort();
      expect(filer).toContain(path.join('services', 'arenden.ts'));
      const poster: string[] = [];
      for (const fil of filer) {
        let funktion = '(filhuvud)';
        for (const rad of readFileSync(path.join(src, fil), 'utf8').split('\n')) {
          const definition = /^(?:export )?(?:async )?function (\w+)/.exec(rad);
          if (definition) funktion = definition[1]!;
          if (/^(\/\/|\/\*|\*)/.test(rad.trimStart())) continue;
          for (const m of rad.matchAll(/state_id = \$|INSERT INTO issues/g)) {
            poster.push(`src/${fil.split(path.sep).join('/')} · ${funktion} · ${m[0]}`);
          }
        }
      }
      const forvantat = [
        'src/services/arenden.ts · claimaNastaArende · state_id = $',
        'src/services/arenden.ts · importeraArende · INSERT INTO issues',
        'src/services/arenden.ts · skapaArende · INSERT INTO issues',
        'src/services/arenden.ts · uppdateraArendeState · state_id = $',
        'src/services/atagande.ts · synkaState · state_id = $',
      ];
      const ovantade = poster.filter((p) => !forvantat.includes(p));
      const saknade = forvantat.filter((p) => !poster.includes(p));
      expect(poster.sort(), `oväntade: ${ovantade.join('; ') || 'inga'} — saknade: ${saknade.join('; ') || 'inga'}`)
        .toEqual(forvantat);
    });
  });

  describe('FR-33/Story 3.2 AK 8: klienterna påverkas inte', () => {
    let server: Server | undefined;
    let basUrl: string;
    let hem: string | undefined;
    beforeAll(async () => {
      hem = await mkdtemp(path.join(tmpdir(), 'arenden-status-klient-'));
      server = await new Promise<Server>((klar, fel) => {
        const s = app.listen(0, '127.0.0.1', () => klar(s));
        s.once('error', fel);
      });
      basUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
      try {
        if (server) await new Promise<void>((klar, fel) => server!.close((e) => e ? fel(e) : klar()));
      } finally {
        if (hem) await rm(hem, { recursive: true, force: true });
      }
    });

    it('S8a (AK 8): TS-adaptern behåller fälten och förmedlar andrad och domänfelet', async () => {
      const id = await nyttArende('S8a TS-adaptern');
      const options = { basUrl, nyckel: hermes };
      const nycklar = Object.keys((await steg(hermes, 'get_issue', { identifier: id })).arende).concat('andrad').sort();
      const byt = await updateIssueState(id, 'started', options);
      expect(Object.keys(byt).sort()).toEqual(nycklar);
      expect(byt).toMatchObject({ andrad: true, state_typ: 'started' });
      const samma = await updateIssueState(id, 'started', options);
      expect(Object.keys(samma).sort()).toEqual(nycklar);
      expect(samma).toMatchObject({ andrad: false, state_typ: 'started' });
      const viaId = await updateIssueState(id, stateId.unstarted, options);
      expect(Object.keys(viaId).sort()).toEqual(nycklar);
      expect(viaId).toMatchObject({ andrad: true, state_typ: 'unstarted' });
      const registrerat = await iLage('registrerat', 'S8a motkontroll');
      const fel = await updateIssueState(registrerat, 'completed', options).then(() => null, (e: unknown) => e);
      expect(fel).toBeInstanceOf(AdapterError);
      expect(fel).toMatchObject({
        status: 400, kod: 'atagandet_styr_statusen',
      });
    });

    it('S8b (AK 8): Python-klienten behåller fälten och förmedlar andrad och domänfelet', async () => {
      const id = await nyttArende('S8b Python-klienten');
      const nycklar = Object.keys((await steg(hermes, 'get_issue', { identifier: id })).arende).concat('andrad').sort();
      for (const [mal, andrad, typ] of [
        ['started', true, 'started'], ['started', false, 'started'], [stateId.unstarted, true, 'unstarted'],
      ] as const) {
        const svar = await korKlienten(hem!, basUrl, id, mal);
        expect(svar.ok).toBe(true);
        expect(Object.keys(svar.resultat!).sort()).toEqual(nycklar);
        expect(svar.resultat).toMatchObject({ andrad, state_typ: typ });
      }
      const registrerat = await iLage('registrerat', 'S8b motkontroll');
      expect(await korKlienten(hem!, basUrl, registrerat, 'completed')).toEqual({
        ok: false, status: 400, kod: 'atagandet_styr_statusen',
      });
    });
  });

  describe('FR-16/Story 3.2 AK 7: mätning av befintliga avvikelser före driftsättning', () => {
    let A: string;
    let B: string;
    let foreA: Awaited<ReturnType<typeof avtryck>>;
    let foreB: Awaited<ReturnType<typeof avtryck>>;
    const matning = () => withTransaction((c) => tjansten.matStatusavvikelser(c, TENANT_ID));
    beforeAll(async () => {
      // Egen kontrollpunkt: tidigare fall ska ha lämnat konsistenta rader.
      expect(await matning()).toEqual([]);
      A = await iLage('genomfort', 'S7 A');
      await sattStateSomAgare(A, 'started');
      B = await iLage('registrerat', 'S7 B');
      await sattStateSomAgare(B, 'completed');
      await iLage('hindrat', 'S7 C konsistent');
      const D = await nyttArende('S7 D utan åtagande');
      await steg(hermes, 'update_issue_state', { identifier: D, state_typ: 'canceled' });
      await iLage('avslutat', 'S7 E konsistent');
      // Alla förberedelser är klara innan avtrycket med hela tabellernas räkning tas.
      foreA = await avtryck(A);
      foreB = await avtryck(B);
    });

    it('S7a (AK 7): tjänsten listar exakt A och B i nummerordning och skriver ingenting', async () => {
      expect(await matning()).toEqual([
        { identifier: A, lage: 'genomfort', state_typ: 'started', mal: 'completed' },
        { identifier: B, lage: 'registrerat', state_typ: 'completed', mal: 'unstarted' },
      ]);
      expect(await avtryck(A)).toEqual(foreA);
      expect(await avtryck(B)).toEqual(foreB);
    });

    it('S7b (AK 7): skriptets exakta lista och antal, och ett fel ser aldrig ut som noll fynd', async () => {
      const fore = await rakningar();
      const svar = await korMatskriptet();
      expect(svar.kod, svar.stderr).toBe(0);
      expect(svar.stdout).toBe(`${A} genomfort started ska vara completed\n${B} registrerat completed ska vara unstarted\nAntal: 2\n`);
      expect(await rakningar()).toEqual(fore);
      expect(await avtryck(A)).toEqual(foreA);
      expect(await avtryck(B)).toEqual(foreB);
      const finnsInte = new URL(process.env.DATABASE_URL!);
      finnsInte.pathname = '/arenden_finns_inte';
      const fel = await korMatskriptet({ DATABASE_URL: finnsInte.toString() });
      expect(fel.kod, fel.stderr).toBe(1);
      expect(fel.stderr).toMatch(/^FATAL:/);
      expect(fel.stdout).not.toContain('Antal:');
    });

    it('S7c (AK 7): bara härledda mål kan rätta avvikelser, med en ärlig händelserad', async () => {
      const n = await raknaRader('events');
      const a = await steg(hermes, 'update_issue_state', { identifier: A, state_typ: 'completed' });
      expect(a).toMatchObject({ andrad: true, state_typ: 'completed' });
      expect(await raknaRader('events')).toBe(n + 1);
      expect(await sistaHandelse(A)).toEqual({
        verb: 'andrade_status',
        payload: { identifier: A, fran: 'In Progress', till: 'Done', typ: 'completed' },
        aktor_typ: 'agent', aktor_namn: 'hermes',
      });
      const fore = await avtryck(B);
      avvisad(await kor(app, hermes, 'update_issue_state', { identifier: B, state_typ: 'completed' }),
        'atagandet_styr_statusen');
      expect(await avtryck(B)).toEqual(fore);
      const b = await steg(hermes, 'update_issue_state', { identifier: B, state_typ: 'unstarted' });
      expect(b).toMatchObject({ andrad: true, state_typ: 'unstarted' });
      expect(await raknaRader('events')).toBe(n + 2);
      expect((await sistaHandelse(B)).verb).toBe('andrade_status');
      expect(await matning()).toEqual([]);
    });
  });
});
