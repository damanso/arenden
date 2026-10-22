// FR-1, Story 7.5: kärnan är byggd sedan Etapp 1. Proven visar kravet genom
// hela stacken mot importfixturen; import.test.ts och sekvens-race.test.ts
// står kvar som regression. AK 1: F1–F2 (arkiv och historik); AK 2: F3
// (fortsatt numrering); AK 3: F4 (omkörning); AK 4: F5 (KRAV-20a);
// AK 5: F6–F8 (teamsekvenser, fem tillståndstyper och README).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { importeraArkiv, type ImportResultat } from '../src/import/importeraArkiv.js';
import { arArendefil, parsaArkivfil, type ArkivArende } from '../src/import/parsaArkiv.js';
import { pool } from '../src/db/pool.js';
import { StateTypSchema } from '../src/lib/validation.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

const ROT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));
const FEM_TYPER = ['backlog', 'unstarted', 'started', 'completed', 'canceled'];
const RUBRIKEN = '### FR-1 — kärnan bär Linears historik och numrering (Story 7.5)';
const GRANSER_2A = '## Gränser för Etapp 2a';
const PROVFILERNA = ['test/karnan.test.ts', 'test/import.test.ts', 'test/sekvens-race.test.ts'];
let app: Express;
let nyckel: string;
let forsta: ImportResultat;

function arkivfilerna(): string[] {
  return readdirSync(FIXTURER).filter(arArendefil).sort();
}

function facit(filnamn: string): ArkivArende {
  return parsaArkivfil(filnamn, readFileSync(path.join(FIXTURER, filnamn), 'utf8'));
}

async function arkivfynd(fil: ArkivArende): Promise<string[]> {
  const svar = await kor(app, nyckel, 'get_issue', { identifier: fil.identifier });
  if (svar.status !== 200) return [`get_issue ${fil.identifier} svarade ${svar.status}`];
  const { arende, kommentarer, handelser } = svar.body.result as {
    arende: {
      id: string; title: string; description: string; state_namn: string;
      projekt: string | null; labels: string[]; source_ref: string | null;
    };
    kommentarer: {
      id: string; source_ref: string | null; aktor_typ: string; aktor_namn: string; body: string;
    }[];
    handelser: {
      verb: string; aktor_typ: string; aktor_namn: string; payload: Record<string, unknown>;
    }[];
  };
  const fynd: string[] = [];
  if (arende.title !== fil.titel) fynd.push('titel avviker');
  if (arende.description !== fil.beskrivning) fynd.push('beskrivning avviker');
  if (arende.state_namn !== fil.status) fynd.push('tillstånd avviker');
  if (arende.projekt !== fil.projekt) fynd.push('projekt avviker');
  if (JSON.stringify([...arende.labels].sort()) !== JSON.stringify([...fil.labels].sort())) {
    fynd.push('etiketter avviker');
  }
  if (arende.source_ref !== fil.source_ref) fynd.push('källreferens avviker');
  // AK 1: samma typomvandling som importen, så att provets tidszon inte avgör.
  const tider = await pool.query<{ skapad: boolean; uppdaterad: boolean }>(
    `SELECT skapad = $2::timestamptz AS skapad, uppdaterad = $3::timestamptz AS uppdaterad
       FROM issues WHERE id = $1`,
    [arende.id, fil.skapad, fil.uppdaterad],
  );
  if (!tider.rows[0]!.skapad) fynd.push('skapad avviker');
  if (!tider.rows[0]!.uppdaterad) fynd.push('uppdaterad avviker');
  if (kommentarer.length !== fil.kommentarer.length) {
    fynd.push(`kommentarer: ${kommentarer.length} i plattformen, ${fil.kommentarer.length} i arkivfilen`);
  } else {
    for (const [i, k] of kommentarer.entries()) {
      const arkiv = fil.kommentarer[i]!;
      const prefix = `kommentar ${i + 1}: `;
      if (k.source_ref !== arkiv.source_ref) fynd.push(prefix + 'källreferens avviker');
      if (k.aktor_typ !== 'manniska' || k.aktor_namn !== arkiv.forfattare) {
        fynd.push(prefix + 'aktör avviker');
      }
      if (k.body !== arkiv.body) fynd.push(prefix + 'text avviker');
      const tid = await pool.query<{ lika: boolean }>(
        'SELECT skapad = $2::timestamptz AS lika FROM comments WHERE id = $1',
        [k.id, arkiv.tidpunkt],
      );
      if (!tid.rows[0]!.lika) fynd.push(prefix + 'tid avviker');
    }
  }
  const verb = ['importerade_arende', ...fil.kommentarer.map(() => 'importerade_kommentar')];
  if (JSON.stringify(handelser.map((h) => h.verb)) !== JSON.stringify(verb)) {
    fynd.push('historikens verb avviker');
  } else {
    for (const [i, h] of handelser.entries()) {
      const prefix = `historikrad ${i + 1}: `;
      if (h.aktor_typ !== 'system' || h.aktor_namn !== 'linear-import') {
        fynd.push(prefix + 'aktören avviker');
      }
      const p = h.payload;
      const arkiv = fil.kommentarer[i - 1];
      const lika = i === 0
        ? p.identifier === fil.identifier && p.source_ref === fil.source_ref && p.status === fil.status
        : p.identifier === fil.identifier && p.kommentar_id === kommentarer[i - 1]?.id
          && p.source_ref === arkiv!.source_ref && p.kommentarens_aktor_typ === 'manniska'
          && p.kommentarens_aktor_namn === arkiv!.forfattare;
      if (!lika) fynd.push(prefix + 'payload avviker');
    }
  }
  return fynd;
}

async function radantal(): Promise<{ issues: number; comments: number; events: number }> {
  return {
    issues: await raknaRader('issues'),
    comments: await raknaRader('comments'),
    events: await raknaRader('events'),
  };
}

async function teamnummer(key: string): Promise<number[]> {
  const { rows } = await pool.query<{ nummer: number }>(
    `SELECT i.sequence_number AS nummer FROM issues i JOIN teams t ON t.id = i.team_id
      WHERE t.key = $1 ORDER BY i.sequence_number`,
    [key],
  );
  return rows.map((r) => r.nummer);
}

function dubbletter(lista: string[]): string[] {
  const sedda = new Set<string>();
  const upprepade = new Set<string>();
  for (const varde of lista) {
    if (sedda.has(varde)) upprepade.add(varde);
    sedda.add(varde);
  }
  return [...upprepade];
}

function saknadeTyper(states: { typ: string }[]): string[] {
  return FEM_TYPER.filter((typ) => !states.some((s) => s.typ === typ));
}

// AK 5: avgränsa kravet till dess eget avsnitt, som de andra README-proven gör.
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return ['rubriken saknas'];
  const fel: string[] = [];
  const antal = rader.filter((r) => r === RUBRIKEN).length;
  if (antal > 1) fel.push(`rubriken står ${antal} gånger`);
  const etapp2a = rader.indexOf(GRANSER_2A);
  if (etapp2a === -1 || etapp2a < start) fel.push(`rubriken står inte före ${GRANSER_2A}`);
  const slut = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  const avsnitt = rader.slice(start + 1, slut === -1 ? rader.length : slut);
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-1 |'));
  if (tabell.length !== 1) {
    fel.push(`${tabell.length} rader börjar med | FR-1 |`);
    return fel;
  }
  const rad = tabell[0]!;
  for (const fil of PROVFILERNA) {
    if (!rad.includes(fil)) fel.push(`tabellraden saknar ${fil}`);
  }
  for (const fil of new Set(rad.match(/test\/[a-z0-9-]+\.test\.ts/g) ?? [])) {
    if (!existsSync(path.join(ROT, fil))) fel.push(`${fil} finns inte`);
  }
  return fel;
}

describe('FR-1/Story 7.5: kärnan bär Linears historik och numrering', () => {
  beforeAll(async () => {
    // AK 1: importen skapar LOC själv, så att inget seed döljer ett saknat led.
    app = createApp();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    forsta = await importeraArkiv(FIXTURER);
  });

  describe('FR-1/Story 7.5 AK 1: ett importerat ärende matchar arkivfilen', () => {
    it('F1 (AK 1): LOC-316 matchar arkivet och varje ändrat facit ger exakt sitt fynd', async () => {
      const fil = facit('LOC-316.md');
      const text = readFileSync(path.join(FIXTURER, 'LOC-316.md'), 'utf8');
      expect(await arkivfynd(fil)).toEqual([]);
      // AK 1: facit knyts till texten, så att parsern inte kan dölja sitt eget fel.
      expect(text.split(/\r?\n/)).toContain(`# LOC-316 — ${fil.titel}`);
      expect(text).toContain(`**Status:** ${fil.status}`);
      expect(text).toContain(fil.beskrivning);
      expect(fil.titel).toBe('[Väntar-extern] Daniel — Besked om ILT-konto + HubSpot-access för David');
      expect(fil.status).toBe('Backlog');
      expect(fil.projekt).toBe('ILT-Education');
      expect(fil.labels).toEqual(['Väntar-extern']);
      expect(fil.skapad).toBe('2026-08-13');
      expect(fil.kommentarer).toEqual([]);
      expect(await arkivfynd({ ...fil, titel: fil.titel + ' X' })).toEqual(['titel avviker']);
      expect(await arkivfynd({ ...fil, status: 'Done' })).toEqual([
        'tillstånd avviker', 'historikrad 1: payload avviker',
      ]);
      expect(await arkivfynd({ ...fil, skapad: '2026-08-14' })).toEqual(['skapad avviker']);
      expect(await arkivfynd({ ...fil, kommentarer: [{
        source_ref: 'linear-arkiv:LOC-316#1', tidpunkt: '2026-08-13',
        forfattare: 'david mancilla', body: 'Tillagd i kontrollen.',
      }] })).toEqual(['kommentarer: 0 i plattformen, 1 i arkivfilen', 'historikens verb avviker']);
      expect(await arkivfynd({ ...fil, beskrivning: fil.beskrivning + ' X' })).toEqual([
        'beskrivning avviker',
      ]);
      expect(await arkivfynd({ ...fil, identifier: 'LOC-317' })).toEqual([
        'get_issue LOC-317 svarade 404',
      ]);
    });

    it('F2 (AK 1): varje ärendefil, kommentar och historikrad matchar arkivet', async () => {
      const filer = arkivfilerna();
      expect(filer).toEqual(['LOC-316.md', 'LOC-329.md', 'LOC-88.md']);
      expect(filer).toHaveLength(forsta.filer);
      expect(filer).toHaveLength(forsta.nya_arenden);
      let kommentarer = 0;
      for (const filnamn of filer) {
        const fil = facit(filnamn);
        const text = readFileSync(path.join(FIXTURER, filnamn), 'utf8');
        expect(await arkivfynd(fil), filnamn).toEqual([]);
        kommentarer += fil.kommentarer.length;
        for (const k of fil.kommentarer) {
          expect(text.split(/\r?\n/)).toContain(`### ${k.tidpunkt} — ${k.forfattare}`);
          expect(text).toContain(k.body);
        }
      }
      expect(kommentarer).toBe(forsta.nya_kommentarer);
      const loc88 = facit('LOC-88.md');
      const loc329 = facit('LOC-329.md');
      expect(await arkivfynd({ ...loc88, kommentarer: loc88.kommentarer.map((k, i) =>
        i === 1 ? { ...k, body: k.body + ' X' } : k,
      ) })).toEqual(['kommentar 2: text avviker']);
      expect(await arkivfynd({ ...loc88, kommentarer: loc88.kommentarer.map((k, i) =>
        i === 0 ? { ...k, forfattare: 'david' } : k,
      ) })).toEqual(['kommentar 1: aktör avviker', 'historikrad 2: payload avviker']);
      expect(await arkivfynd({ ...loc88, kommentarer: loc88.kommentarer.map((k, i) =>
        i === 0 ? { ...k, tidpunkt: k.tidpunkt.replace('2026-06-24', '2026-06-25') } : k,
      ) })).toEqual(['kommentar 1: tid avviker']);
      expect(await arkivfynd({ ...loc329, labels: ['Admin'] })).toEqual(['etiketter avviker']);
      expect(await arkivfynd({ ...loc88, projekt: null })).toEqual(['projekt avviker']);
      expect(await arkivfynd({
        ...loc329, uppdaterad: loc329.uppdaterad.replace('2026-08-17', '2026-08-18'),
      })).toEqual(['uppdaterad avviker']);
      expect(await arkivfynd({ ...loc329, kommentarer: loc329.kommentarer.map((k, i) =>
        i === 0 ? { ...k, source_ref: 'linear-arkiv:LOC-329#2' } : k,
      ) })).toEqual(['kommentar 1: källreferens avviker', 'historikrad 2: payload avviker']);
      expect(await arkivfynd({ ...loc329, source_ref: 'linear-arkiv:LOC-329-X' })).toEqual([
        'källreferens avviker', 'historikrad 1: payload avviker',
      ]);
    });
  });

  describe('FR-1/Story 7.5 AK 2: numreringen fortsätter', () => {
    it('F3 (AK 2): nästa nummer fortsätter över arkivet även efter en omkörning', async () => {
      const hogsta = Math.max(...arkivfilerna().map((f) => facit(f).nummer));
      expect(hogsta).toBe(forsta.hogsta_nummer);
      expect(hogsta).toBe(329);
      const forst = await kor(app, nyckel, 'create_issue', {
        title: 'F3 första efter importen', team_key: 'LOC',
      });
      expect(forst.status).toBe(200);
      expect(forst.body.result.identifier).toBe(`LOC-${hogsta + 1}`);
      expect((await importeraArkiv(FIXTURER)).nya_arenden).toBe(0);
      const sedan = await kor(app, nyckel, 'create_issue', {
        title: 'F3 efter omkörningen', team_key: 'LOC',
      });
      expect(sedan.status).toBe(200);
      expect(sedan.body.result.identifier).toBe(`LOC-${hogsta + 2}`);
      const importerat = await kor(app, nyckel, 'get_issue', { identifier: `LOC-${hogsta}` });
      expect(importerat.status).toBe(200);
      expect(importerat.body.result.arende.title).toBe(facit('LOC-329.md').titel);
    });
  });

  describe('FR-1/Story 7.5 AK 3: omkörd import ger inga dubbletter', () => {
    it('F4 (AK 3): omkörningen ger noll nya rader och räkningen ser ett nytt ärende', async () => {
      const fore = await radantal();
      const resultat = await importeraArkiv(FIXTURER);
      expect(await radantal()).toEqual(fore);
      expect(resultat).toEqual({
        filer: forsta.filer,
        nya_arenden: 0,
        oforandrade_arenden: forsta.nya_arenden,
        nya_kommentarer: 0,
        oforandrade_kommentarer: forsta.nya_kommentarer,
        hogsta_nummer: forsta.hogsta_nummer,
      });
      for (const f of arkivfilerna()) expect(await arkivfynd(facit(f)), f).toEqual([]);
      const kontroll = await kor(app, nyckel, 'create_issue', { title: 'F4 kontroll', team_key: 'LOC' });
      expect(kontroll.status).toBe(200);
      expect(await radantal()).toEqual({
        issues: fore.issues + 1, comments: fore.comments, events: fore.events + 1,
      });
    });
  });

  describe('FR-1/Story 7.5 AK 4: samtidiga skapanden (KRAV-20a)', () => {
    it('F5 (AK 4): 25 varv med två samtidiga skapanden ger 50 olika, följande nummer', async () => {
      const fore = await teamnummer('LOC');
      const start = Math.max(...fore);
      const alla: string[] = [];
      for (let v = 1; v <= 25; v += 1) {
        const [a, b] = await Promise.all([
          kor(app, nyckel, 'create_issue', { title: `F5 varv ${v} A`, team_key: 'LOC' }),
          kor(app, nyckel, 'create_issue', { title: `F5 varv ${v} B`, team_key: 'LOC' }),
        ]);
        expect(a.status).toBe(200);
        expect(b.status).toBe(200);
        const identA = a.body.result.identifier as string;
        const identB = b.body.result.identifier as string;
        expect(identA).not.toBe(identB);
        alla.push(identA, identB);
      }
      expect(dubbletter(alla)).toEqual([]);
      expect([...alla].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))).toEqual(
        Array.from({ length: 50 }, (_, i) => `LOC-${start + i + 1}`),
      );
      const efter = await teamnummer('LOC');
      expect(efter).toHaveLength(fore.length + 50);
      expect(dubbletter(efter.map((n) => `LOC-${n}`))).toEqual([]);
      expect(dubbletter(['LOC-5', 'LOC-6', 'LOC-5', 'LOC-6', 'LOC-7'])).toEqual(['LOC-5', 'LOC-6']);
      expect(dubbletter([])).toEqual([]);
    });
  });

  describe('FR-1/Story 7.5 AK 5: team och tillstånd', () => {
    it('F6 (AK 5): två nya team har var sin sekvens och LOC fortsätter sin egen', async () => {
      await seedaTeam('KA', 'Kärnan A');
      await seedaTeam('KB', 'Kärnan B');
      const locFore = Math.max(...await teamnummer('LOC'));
      const vaxelvis: string[] = [];
      for (const [key, n] of [['KA', 1], ['KB', 1], ['KA', 2], ['KB', 2]] as const) {
        const svar = await kor(app, nyckel, 'create_issue', { title: `F6 ${key} ${n}`, team_key: key });
        expect(svar.status).toBe(200);
        vaxelvis.push(svar.body.result.identifier as string);
      }
      expect(vaxelvis).toEqual(['KA-1', 'KB-1', 'KA-2', 'KB-2']);
      const samtidigt = await Promise.all([
        kor(app, nyckel, 'create_issue', { title: 'F6 KA 3', team_key: 'KA' }),
        kor(app, nyckel, 'create_issue', { title: 'F6 KB 3', team_key: 'KB' }),
      ]);
      for (const svar of samtidigt) expect(svar.status).toBe(200);
      expect(samtidigt.map((s) => s.body.result.identifier)).toEqual(['KA-3', 'KB-3']);
      const loc = await kor(app, nyckel, 'create_issue', { title: 'F6 LOC', team_key: 'LOC' });
      expect(loc.status).toBe(200);
      expect(loc.body.result.identifier).toBe(`LOC-${locFore + 1}`);
      expect(await teamnummer('KA')).toEqual([1, 2, 3]);
      expect(await teamnummer('KB')).toEqual([1, 2, 3]);
      const team = await pool.query<{ key: string; sekvensnamn: string }>(
        'SELECT key, sekvensnamn FROM teams ORDER BY key',
      );
      expect(team.rows).toEqual([
        { key: 'KA', sekvensnamn: 'arende_nummer_ka' },
        { key: 'KB', sekvensnamn: 'arende_nummer_kb' },
        { key: 'LOC', sekvensnamn: 'arende_nummer_loc' },
      ]);
      const sekvenser = await pool.query<{ sequencename: string; last_value: number }>(
        `SELECT sequencename, last_value::int AS last_value FROM pg_sequences
          WHERE schemaname = 'public' AND sequencename = ANY($1::text[]) ORDER BY sequencename`,
        [team.rows.map((t) => t.sekvensnamn)],
      );
      expect(sekvenser.rows).toEqual([
        { sequencename: 'arende_nummer_ka', last_value: 3 },
        { sequencename: 'arende_nummer_kb', last_value: 3 },
        { sequencename: 'arende_nummer_loc', last_value: locFore + 1 },
      ]);
    });

    it('F7 (AK 5): varje team har exakt de fem typerna och kontrollerna ser luckorna', async () => {
      expect(FEM_TYPER).toEqual(StateTypSchema.options);
      let ka: { typ: string }[] = [];
      for (const key of ['KA', 'KB', 'LOC']) {
        const svar = await kor(app, nyckel, 'list_states', { team_key: key });
        expect(svar.status).toBe(200);
        const states = svar.body.result as { typ: string }[];
        expect(states.map((s) => s.typ), key).toEqual(FEM_TYPER);
        expect(saknadeTyper(states), key).toEqual([]);
        if (key === 'KA') ka = states;
      }
      const luckor = await pool.query<{ key: string }>(
        `SELECT t.key FROM teams t WHERE
          (SELECT count(DISTINCT s.typ) FROM workflow_states s WHERE s.team_id = t.id) <> 5
          ORDER BY t.key`,
      );
      expect(luckor.rows).toEqual([]);
      const antal = await pool.query<{ n: number }>('SELECT count(*)::int AS n FROM teams');
      expect(antal.rows[0]!.n).toBe(3);
      expect(saknadeTyper(ka.filter((s) => s.typ !== 'canceled'))).toEqual(['canceled']);
      expect(saknadeTyper([])).toEqual(FEM_TYPER);
      expect((await kor(app, nyckel, 'list_states', { team_key: 'KC' })).status).toBe(404);
    });
  });
});

describe('FR-1/Story 7.5 AK 5: README pekar på proven', () => {
  it('F8 (AK 5): avsnittet pekar på befintliga prov och varje kontroll ger exakt sitt fynd', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect(readmefel(readme)).toEqual([]);
    const rader = readme.split('\n');
    const start = rader.indexOf(RUBRIKEN);
    const slut = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
    const rad = rader.slice(start + 1, slut).filter((r) => r.startsWith('| FR-1 |'))[0]!;
    expect(readmefel(readme.replace(rad, rad.replace('test/karnan.test.ts', 'test/karna.test.ts')))).toEqual([
      'tabellraden saknar test/karnan.test.ts', 'test/karna.test.ts finns inte',
    ]);
    expect(readmefel(readme.replace(RUBRIKEN, '### FR-1 — annan rubrik'))).toEqual(['rubriken saknas']);
    expect(readmefel(readme.replace(rad, rad + '\n' + rad))).toEqual(['2 rader börjar med | FR-1 |']);
    const flyttad = [
      ...rader.slice(0, start), ...rader.slice(slut), ...rader.slice(start, slut),
    ].join('\n');
    expect(readmefel(flyttad)).toEqual(['rubriken står inte före ## Gränser för Etapp 2a']);
    expect(readmefel(readme + '\n' + RUBRIKEN + '\n')).toEqual(['rubriken står 2 gånger']);
  });
});
