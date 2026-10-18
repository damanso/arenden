// FR-16 delkrav 3 och 6, B-07 (Story 5.2): åtagandets händelserader bär skäl och
// revision, och återöppningen bär det den tar bort.
//
// Filen visar fyra saker, var och en med prov som blir röda om regeln tas bort:
//   - varje åtgärd som ändrar ett befintligt åtagande kräver forvantad_revision
//     (AK 5–7: F1–F4, F11);
//   - andra_atagande utan grund och nasta kräver skal, och skal_saknas prövas
//     sist (AK 3: F7–F11);
//   - andrade_atagande bär andring och aterppnade_atagande bär tidigare
//     (AK 2 och AK 4: F12–F15);
//   - varje rad bär sitt skäl och revisionen efter åtgärden, och inga gamla fält
//     försvinner (AK 1 och AK 8: F5, F16).
// "Noll rader" betyder att events- och issues-räkningen och ärendets
// åtagandekolumner är oförändrade (avtryck). Varje sådant fall har en kontroll
// där ett giltigt anrop ändrar dem, så att mätningen visas kunna slå ut.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const NY_GRUND = { typ: 'beslut', id: '171', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const RIKTNING = {
  handling: 'Välj vilken leverans som går först',
  slag: 'riktning',
  grund: { typ: 'beslut', id: '172' },
};
const HINDER = { typ: 'beslut', id: '145' };
const BELAGG = [
  { typ: 'prov', id: 'atagande-handelser', version: '2026-10-17' },
  { typ: 'commit', id: 'abc1234' },
];
const SKAL = 'Uppföljningen flyttas: väntar på "svar" från <Eva> & co';
const V_OKANT = {
  text: 'Gör X endast om Y håller',
  kalla: { typ: 'beslut', id: '153' },
  galler: 'utfora',
  kontroll: 'kontrollera Y',
  utfall: 'okant',
};
const V_UPPFYLLT = { ...V_OKANT, utfall: 'uppfyllt', belagg: { typ: 'prov', id: 'y' } };
const SEN = '2026-09-30T08:00:00Z';
const SENARE = '2026-10-30T08:00:00Z';

type Lage = 'registrerat' | 'overtaget' | 'hindrat' | 'genomfort' | 'avslutat';

let app: Express;
let hermes: string; // agent
let david: string; // människa

async function nyttArende(titel: string): Promise<string> {
  const svar = await kor(app, hermes, 'create_issue', { title: titel, team_key: 'LOC' });
  expect(svar.status).toBe(200);
  return svar.body.result.identifier as string;
}

/** Ett anrop som MÅSTE lyckas. Ett tyst 400 i ett förberedande steg får aldrig bära ett senare fall. */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
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
      orsak: 'DNS-ändringen är inte gjord',
      belagg: HINDER,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    return id;
  }
  await vidare('ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN }, david);
  if (lage === 'overtaget') return id;
  if (lage === 'genomfort') {
    await vidare('redovisa_resultat', { sammanfattning: 'Klart enligt provet', belagg: BELAGG });
    return id;
  }
  await vidare('avsluta_atagande', { text: 'Ersatt av ett annat åtagande', grund: { typ: 'beslut', id: '160' } });
  return id;
}

/**
 * "Noll rader": events- och issues-räkningen (epics.md:s Läsanvisning) och ärendets
 * åtagandekolumner. Åtgärderna gör UPDATE, aldrig INSERT, så det är kolumnerna som ser en skrivning.
 */
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

async function handelser(identifier: string) {
  const { issue_id } = await steg(hermes, 'get_atagande', { identifier });
  const { rows } = await pool.query(
    'SELECT id, verb, payload, aktor_typ, aktor_namn, tidpunkt FROM events WHERE issue_id = $1 ORDER BY id',
    [issue_id],
  );
  return rows;
}

async function sistaHandelse(identifier: string) {
  const rader = await handelser(identifier);
  return rader[rader.length - 1];
}

/** Databasens klocka, samma klocka som events.tidpunkt (DEFAULT now()). */
async function klocka(): Promise<Date> {
  const { rows } = await pool.query<{ t: Date }>('SELECT clock_timestamp() AS t');
  return rows[0]!.t;
}

describe('FR-16/Story 5.2: åtagandehändelserna bär skäl och revision', () => {
  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  describe('FR-16/Story 5.2 AK 6: revisionskontroll på varje uppdatering', () => {
    it('F1 (AK 6): aterppna_atagande kräver forvantad_revision — n − 1 och utan fält ändrar ingenting, n lyckas', async () => {
      const id = await iLage('genomfort', 'F1');
      const n = await revisionNu(id);
      const ny = { identifier: id, grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE };
      const fore = await avtryck(id);
      const gammal = await kor(app, hermes, 'aterppna_atagande', { ...ny, forvantad_revision: n - 1 });
      expect([gammal.status, gammal.body.error]).toEqual([400, 'gammal_revision']);
      const utan = await kor(app, hermes, 'aterppna_atagande', ny);
      expect([utan.status, utan.body.error]).toEqual([400, 'revision_saknas']);
      expect(await avtryck(id)).toEqual(fore);
      // Kontroll: samma anrop med n ändrar räkningen och raden, så mätningen kan slå ut.
      const ratt = await steg(hermes, 'aterppna_atagande', { ...ny, forvantad_revision: n });
      expect(ratt).toMatchObject({ lage: 'registrerat', revision: n + 1 });
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(n + 1);
    });

    const UPPDATERINGAR: {
      action: string;
      fran: Lage;
      avvisad: Record<string, unknown>;
      lyckad: Record<string, unknown>;
    }[] = [
      {
        action: 'ta_over_atagande',
        fran: 'registrerat',
        avvisad: { nasta: INTERNT, foljs_upp: SEN },
        lyckad: { nasta: INTERNT, foljs_upp: SEN },
      },
      // Utan grund, nasta och skal: revisionsfelet ska komma före skal_saknas (AK 6). Det
      // lyckade anropet skickar nasta och är giltigt både före och efter Uppgift 2.
      { action: 'andra_atagande', fran: 'registrerat', avvisad: { foljs_upp: SENARE }, lyckad: { nasta: RIKTNING } },
      {
        action: 'hindra_atagande',
        fran: 'overtaget',
        avvisad: { orsak: 'Väntar', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN },
        lyckad: { orsak: 'Väntar', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN },
      },
      {
        action: 'redovisa_resultat',
        fran: 'overtaget',
        avvisad: { sammanfattning: 'Klart', belagg: BELAGG },
        lyckad: { sammanfattning: 'Klart', belagg: BELAGG },
      },
      {
        action: 'avsluta_atagande',
        fran: 'registrerat',
        avvisad: { text: 'Behövs inte', grund: NY_GRUND },
        lyckad: { text: 'Behövs inte', grund: NY_GRUND },
      },
    ];

    it.each(UPPDATERINGAR)('F2 (AK 6): $action kräver forvantad_revision', async ({ action, fran, avvisad, lyckad }) => {
      const id = await iLage(fran, `F2 ${action}`);
      const n = await revisionNu(id);
      const fore = await avtryck(id);
      const gammal = await kor(app, hermes, action, { identifier: id, ...avvisad, forvantad_revision: n - 1 });
      expect([gammal.status, gammal.body.error]).toEqual([400, 'gammal_revision']);
      const utan = await kor(app, hermes, action, { identifier: id, ...avvisad });
      expect([utan.status, utan.body.error]).toEqual([400, 'revision_saknas']);
      expect(await avtryck(id)).toEqual(fore);
      // Kontroll: med n lyckas samma åtgärd och avtrycket ändras.
      const ratt = await steg(hermes, action, { identifier: id, ...lyckad, forvantad_revision: n });
      expect(ratt.revision).toBe(n + 1);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(n + 1);
    });
  });

  describe('FR-16/Story 5.2 AK 5: återöppning bara från stängt läge', () => {
    it('F3 (AK 5): aterppna_atagande från registrerat, övertaget och hindrat ger otillaten_overgang och noll rader', async () => {
      const ny = { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE };
      const oppna: Record<string, string> = {};
      for (const lage of ['registrerat', 'overtaget', 'hindrat'] as const) {
        const id = await iLage(lage, `F3 ${lage}`);
        oppna[lage] = id;
        const fore = await avtryck(id);
        const svar = await kor(app, hermes, 'aterppna_atagande', {
          identifier: id,
          ...ny,
          forvantad_revision: await revisionNu(id),
        });
        expect([svar.status, svar.body.error], lage).toEqual([400, 'otillaten_overgang']);
        expect(await avtryck(id), lage).toEqual(fore);
      }
      // Kontroll: det övertagna åtagandet redovisas, och därefter lyckas samma återöppning.
      const id = oppna.overtaget!;
      await steg(hermes, 'redovisa_resultat', {
        identifier: id,
        sammanfattning: 'Klart enligt provet',
        belagg: BELAGG,
        forvantad_revision: await revisionNu(id),
      });
      const n = await revisionNu(id);
      const fore = await avtryck(id);
      const ratt = await steg(hermes, 'aterppna_atagande', { identifier: id, ...ny, forvantad_revision: n });
      expect(ratt).toMatchObject({ lage: 'registrerat', revision: n + 1 });
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(n + 1);
    });
  });

  describe('FR-16/Story 5.2 AK 7: samtidiga åtgärder från samma revision', () => {
    it('F4 (AK 7): två samtidiga ta_over_atagande från revision n — exakt ett lyckas, en rad skrivs', async () => {
      for (let varv = 0; varv < 10; varv++) {
        const id = await iLage('registrerat', `F4 varv ${varv}`);
        const n = await revisionNu(id);
        const indata = { identifier: id, nasta: INTERNT, foljs_upp: SEN, forvantad_revision: n };
        const svar = await Promise.all([
          kor(app, hermes, 'ta_over_atagande', indata),
          kor(app, david, 'ta_over_atagande', indata),
        ]);
        expect(svar.map((s) => s.status).sort(), `varv ${varv}`).toEqual([200, 400]);
        expect(svar.find((s) => s.status === 400)!.body.error, `varv ${varv}`).toBe('gammal_revision');
        expect((await handelser(id)).filter((h) => h.verb === 'tog_over_atagande'), `varv ${varv}`).toHaveLength(1);
        expect(await revisionNu(id), `varv ${varv}`).toBe(n + 1);
      }
      // Kontroll: två övertaganden i följd, vart och ett med aktuell revision, ger två rader.
      const id = await iLage('registrerat', 'F4 kontroll');
      for (const nyckel of [hermes, david]) {
        await steg(nyckel, 'ta_over_atagande', {
          identifier: id,
          nasta: INTERNT,
          foljs_upp: SEN,
          forvantad_revision: await revisionNu(id),
        });
      }
      expect((await handelser(id)).filter((h) => h.verb === 'tog_over_atagande')).toHaveLength(2);
    });
  });

  describe('FR-16/Story 5.2 AK 8: inga befintliga fält försvinner', () => {
    it('F5 (AK 8): alla åtta verben behåller sina tidigare nycklar med samma betydelse', async () => {
      const id = await nyttArende('F5');
      const registrering = { identifier: id, grund: GRUND, nasta: INTERNT, foljs_upp: SEN };
      await steg(hermes, 'registrera_atagande', registrering);
      await steg(hermes, 'registrera_atagande', registrering);
      const vidare = async (nyckel: string, action: string, input: Record<string, unknown>) =>
        steg(nyckel, action, { identifier: id, ...input, forvantad_revision: await revisionNu(id) });
      await vidare(david, 'ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN });
      await vidare(hermes, 'andra_atagande', { nasta: RIKTNING });
      await vidare(hermes, 'hindra_atagande', {
        orsak: 'DNS-ändringen är inte gjord',
        belagg: HINDER,
        nasta: INTERNT,
        foljs_upp: SEN,
      });
      await vidare(hermes, 'ta_over_atagande', { nasta: INTERNT, foljs_upp: SEN });
      await vidare(hermes, 'redovisa_resultat', { sammanfattning: 'Klart enligt provet', belagg: BELAGG });
      await vidare(hermes, 'aterppna_atagande', { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE });
      await vidare(hermes, 'avsluta_atagande', {
        text: 'Ersatt av ett annat åtagande',
        grund: { typ: 'beslut', id: '160' },
      });

      const alla = (await handelser(id)).filter((h) => h.verb !== 'skapade_arende');
      const rader = alla.map((h) => [h.verb, h.payload]);
      expect(rader).toHaveLength(9);
      expect(rader).toMatchObject([
        ['registrerade_atagande', { identifier: id, lage: 'registrerat', tillhor: 'hermes', revision: 1 }],
        ['atagandet_fanns_redan', { identifier: id, lage: 'registrerat', tillhor: 'hermes', revision: 1 }],
        [
          'tog_over_atagande',
          { identifier: id, utforare_typ: 'manniska', utforare_namn: 'david', nasta: INTERNT, revision: 2 },
        ],
        ['andrade_atagande', { identifier: id, tillhor: 'agare', nasta: RIKTNING, revision: 3 }],
        ['hindrade_atagande', { identifier: id, orsak: 'DNS-ändringen är inte gjord', revision: 4 }],
        [
          'tog_over_atagande',
          { identifier: id, utforare_typ: 'agent', utforare_namn: 'hermes', nasta: INTERNT, revision: 5 },
        ],
        ['redovisade_resultat', { identifier: id, sammanfattning: 'Klart enligt provet', antal_belagg: 2, revision: 6 }],
        ['aterppnade_atagande', { identifier: id, grund: NY_GRUND, revision: 7 }],
        [
          'avslutade_atagande',
          { identifier: id, skal: 'Ersatt av ett annat åtagande', grund: { typ: 'beslut', id: '160' }, revision: 8 },
        ],
      ]);
      // No-op-raden är ingen uppdatering och förblir oförändrad: den får inget skäl.
      const fannsRedan = alla.find((h) => h.verb === 'atagandet_fanns_redan')!;
      expect(Object.hasOwn(fannsRedan.payload, 'grund')).toBe(false);
    });
  });

  describe('FR-16/Story 5.2 AK 3: skälet krävs när ändringen inte bär sitt eget', () => {
    it('F7 (AK 3): andra_atagande utan grund, nasta och skal ger skal_saknas och noll rader', async () => {
      const id = await iLage('registrerat', 'F7');
      const n = await revisionNu(id);
      const fore = await avtryck(id);
      const utan = await kor(app, hermes, 'andra_atagande', { identifier: id, foljs_upp: SENARE, forvantad_revision: n });
      expect([utan.status, utan.body.error]).toEqual([400, 'skal_saknas']);
      expect(await avtryck(id)).toEqual(fore);
      // Kontroll: samma anrop med skal lyckas och ändrar avtrycket.
      const med = await steg(hermes, 'andra_atagande', {
        identifier: id,
        foljs_upp: SENARE,
        skal: SKAL,
        forvantad_revision: n,
      });
      expect(med.revision).toBe(n + 1);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(n + 1);
    });

    it('F8 (AK 3, AK 1): skal står ordagrant i andrade_atagande, och nyckeln grund saknas', async () => {
      const id = await iLage('registrerat', 'F8');
      await steg(hermes, 'andra_atagande', {
        identifier: id,
        foljs_upp: SENARE,
        skal: SKAL,
        forvantad_revision: await revisionNu(id),
      });
      const rad = await sistaHandelse(id);
      expect(rad.verb).toBe('andrade_atagande');
      expect(rad.payload.skal).toBe(SKAL);
      expect(Object.hasOwn(rad.payload, 'grund')).toBe(false);
    });

    it('F9 (AK 3, AK 1): skälkällorna går i ordningen grund, nästa steg, skal', async () => {
      const fall: [string, Record<string, unknown>, (payload: Record<string, unknown>) => void][] = [
        [
          '(a) grund',
          { grund: NY_GRUND },
          (p) => {
            expect(p.grund).toEqual(NY_GRUND);
            expect(Object.hasOwn(p, 'skal')).toBe(false);
          },
        ],
        [
          '(b) nasta',
          { nasta: RIKTNING },
          (p) => {
            expect(p.grund).toEqual(RIKTNING.grund);
            expect(Object.hasOwn(p, 'skal')).toBe(false);
          },
        ],
        [
          '(c) grund och nasta',
          { grund: NY_GRUND, nasta: RIKTNING },
          (p) => {
            expect(p.grund).toEqual(NY_GRUND);
            expect(Object.hasOwn(p, 'skal')).toBe(false);
          },
        ],
        [
          '(d) grund och skal',
          { grund: NY_GRUND, skal: SKAL },
          (p) => {
            expect(p.grund).toEqual(NY_GRUND);
            expect(p.skal).toBe(SKAL);
          },
        ],
      ];
      for (const [namn, indata, pruva] of fall) {
        const id = await iLage('registrerat', `F9 ${namn}`);
        await steg(hermes, 'andra_atagande', { identifier: id, ...indata, forvantad_revision: await revisionNu(id) });
        const rad = await sistaHandelse(id);
        expect(rad.verb, namn).toBe('andrade_atagande');
        pruva(rad.payload);
      }
    });

    it('F10 (AK 3): indatavalidering, revisionen och atagandet_ar_stangt kommer före skal_saknas', async () => {
      // (e) skrivs inte: Story 5.1 har inte lagt uppfoljning_saknas i andraAtagande (Uppgift 1.1).
      // Båda åtagandena byggs innan något avtryck tas: räkningen är hela tabellens, så ett
      // förberedande steg efter avtrycket skulle synas som rader från de avvisade anropen.
      const id = await iLage('registrerat', 'F10 öppet');
      const stangt = await iLage('genomfort', 'F10 stängt');
      const n = await revisionNu(id);
      const fore = await avtryck(id);
      const foreStangt = await avtryck(stangt);

      // (a) ett uppfyllt villkor utan belägg, med rätt revision: indatavalideringen.
      const { belagg: _utan, ...uppfylltUtanBelagg } = V_UPPFYLLT;
      const a = await kor(app, hermes, 'andra_atagande', {
        identifier: id,
        villkor: [uppfylltUtanBelagg],
        forvantad_revision: n,
      });
      expect([a.status, a.body.error], '(a)').toEqual([400, 'validation_error']);

      // (b) utan revision och (c) med n − 1.
      const b = await kor(app, hermes, 'andra_atagande', { identifier: id, foljs_upp: SENARE });
      expect([b.status, b.body.error], '(b)').toEqual([400, 'revision_saknas']);
      const c = await kor(app, hermes, 'andra_atagande', { identifier: id, foljs_upp: SENARE, forvantad_revision: n - 1 });
      expect([c.status, c.body.error], '(c)').toEqual([400, 'gammal_revision']);
      expect(await avtryck(id)).toEqual(fore);

      // (d) ett genomfört åtagande med rätt revision: atagandet_ar_stangt.
      const d =await kor(app, hermes, 'andra_atagande', {
        identifier: stangt,
        foljs_upp: SENARE,
        forvantad_revision: await revisionNu(stangt),
      });
      expect([d.status, d.body.error], '(d)').toEqual([400, 'atagandet_ar_stangt']);
      expect(await avtryck(stangt)).toEqual(foreStangt);

      // Kontroll på det öppna åtagandet: (1) samma anrop med rätt revision ger skal_saknas,
      // alltså fick (a)–(d) sina egna felkoder; (2) med skal lyckas det och avtrycket ändras.
      const utanSkal = await kor(app, hermes, 'andra_atagande', { identifier: id, foljs_upp: SENARE, forvantad_revision: n });
      expect([utanSkal.status, utanSkal.body.error]).toEqual([400, 'skal_saknas']);
      expect(await avtryck(id)).toEqual(fore);
      await steg(hermes, 'andra_atagande', { identifier: id, foljs_upp: SENARE, skal: SKAL, forvantad_revision: n });
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(n + 1);
    });

    it('F11 (AK 6): andra_atagande med skal kräver också forvantad_revision', async () => {
      const id = await iLage('registrerat', 'F11');
      const n = await revisionNu(id);
      const indata = { identifier: id, foljs_upp: SENARE, skal: SKAL };
      const fore = await avtryck(id);
      const gammal = await kor(app, hermes, 'andra_atagande', { ...indata, forvantad_revision: n - 1 });
      expect([gammal.status, gammal.body.error]).toEqual([400, 'gammal_revision']);
      const utan = await kor(app, hermes, 'andra_atagande', indata);
      expect([utan.status, utan.body.error]).toEqual([400, 'revision_saknas']);
      expect(await avtryck(id)).toEqual(fore);
      // Kontroll: med n lyckas samma anrop och avtrycket ändras.
      const ratt = await steg(hermes, 'andra_atagande', { ...indata, forvantad_revision: n });
      expect(ratt.revision).toBe(n + 1);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(n + 1);
    });
  });

  describe('FR-16/Story 5.2 AK 2: ändringen syns', () => {
    it('F12 (AK 2): andring har exakt de ändrade fälten med värdena före och efter', async () => {
      const id = await nyttArende('F12');
      await steg(hermes, 'registrera_atagande', {
        identifier: id,
        grund: GRUND,
        nasta: INTERNT,
        foljs_upp: SEN,
        villkor: [V_OKANT],
      });
      await steg(hermes, 'andra_atagande', {
        identifier: id,
        foljs_upp: SENARE,
        villkor: [V_UPPFYLLT],
        skal: SKAL,
        forvantad_revision: await revisionNu(id),
      });
      const rad = await sistaHandelse(id);
      expect(rad.verb).toBe('andrade_atagande');
      expect(rad.payload.andring).toEqual({
        foljs_upp: { fran: '2026-09-30T08:00:00.000Z', till: '2026-10-30T08:00:00.000Z' },
        villkor: { fran: [V_OKANT], till: [V_UPPFYLLT] },
      });
      expect(Object.keys(rad.payload.andring).sort()).toEqual(['foljs_upp', 'villkor']);
    });

    it('F13 (AK 2): oförändrade värden ger {}, och ett byte av slag syns som nasta och tillhor', async () => {
      const id = await iLage('registrerat', 'F13');
      // (a) Samma steg och samma ögonblick, tiden i en annan tidszonsform.
      const n = await revisionNu(id);
      await steg(hermes, 'andra_atagande', {
        identifier: id,
        nasta: INTERNT,
        foljs_upp: '2026-09-30T10:00:00+02:00',
        forvantad_revision: n,
      });
      const a = await sistaHandelse(id);
      expect(a.verb, '(a)').toBe('andrade_atagande');
      expect(a.payload.andring, '(a)').toEqual({});
      expect(a.payload.grund, '(a)').toEqual(INTERNT.grund);

      // (b) Nästa steg byter slag från internt till riktning.
      await steg(hermes, 'andra_atagande', { identifier: id, nasta: RIKTNING, forvantad_revision: n + 1 });
      const b = await sistaHandelse(id);
      expect(Object.keys(b.payload.andring).sort(), '(b)').toEqual(['nasta', 'tillhor']);
      expect(b.payload.andring.tillhor, '(b)').toEqual({ fran: 'hermes', till: 'agare' });
      expect(b.payload.andring.nasta, '(b)').toEqual({ fran: INTERNT, till: RIKTNING });
    });
  });

  describe('FR-16/Story 5.2 AK 4: återöppningen bevarar det den tar bort', () => {
    /** Återöppnar och prövar det som gäller både F14 och F15; returnerar den nya raden. */
    async function aterppnaOchPruva(id: string) {
      const n = await revisionNu(id);
      const foreHandelser = await handelser(id);
      const svar = await steg(hermes, 'aterppna_atagande', {
        identifier: id,
        grund: NY_GRUND,
        nasta: INTERNT,
        foljs_upp: SENARE,
        forvantad_revision: n,
      });
      expect(svar).toMatchObject({
        lage: 'registrerat',
        revision: n + 1,
        utforare_typ: null,
        utforare_namn: null,
        overtaget_nar: null,
      });
      expect(svar.data.grund).toEqual([...GRUND, NY_GRUND]);
      expect(Object.hasOwn(svar.data, 'resultat')).toBe(false);
      expect(Object.hasOwn(svar.data, 'avslutsskal')).toBe(false);
      const arende = await steg(hermes, 'get_issue', { identifier: id });
      expect(arende.arende.state_typ).toBe('unstarted');

      // Alla tidigare rader är oförändrade, och exakt en ny har tillkommit.
      const efterHandelser = await handelser(id);
      expect(efterHandelser).toHaveLength(foreHandelser.length + 1);
      expect(efterHandelser.slice(0, foreHandelser.length)).toEqual(foreHandelser);
      const ny = efterHandelser[efterHandelser.length - 1];
      expect(ny.verb).toBe('aterppnade_atagande');
      expect(ny.payload.grund).toEqual(NY_GRUND);
      return ny;
    }

    it('F14 (AK 4): ett genomfört åtagande återöppnas, och tidigare bär resultatet som togs bort', async () => {
      const id = await iLage('genomfort', 'F14');
      const R = (await steg(hermes, 'get_atagande', { identifier: id })).data.resultat;
      expect(R).toMatchObject({ sammanfattning: 'Klart enligt provet', belagg: BELAGG });
      const ny = await aterppnaOchPruva(id);
      expect(ny.payload.tidigare).toStrictEqual({ resultat: R, avslutsskal: null });
    });

    it('F15 (AK 4): ett avslutat åtagande återöppnas, och tidigare bär avslutsskälet som togs bort', async () => {
      const id = await iLage('avslutat', 'F15');
      const fore = await steg(hermes, 'get_atagande', { identifier: id });
      const A = fore.data.avslutsskal;
      expect(A).toEqual({ text: 'Ersatt av ett annat åtagande', grund: { typ: 'beslut', id: '160' } });
      // iLage tar över innan det avslutar: utföraren står kvar tills återöppningen nollställer den.
      expect(fore).toMatchObject({ utforare_typ: 'manniska', utforare_namn: 'david' });
      const ny = await aterppnaOchPruva(id);
      expect(ny.payload.tidigare).toStrictEqual({ resultat: null, avslutsskal: A });
    });
  });

  describe('FR-16/Story 5.2 AK 1: skälet på varje rad', () => {
    /** Ett steg: raden bär stegets nyckel, en tid inom steget och svarets revision. */
    async function stegMedRad(nyckel: string, aktor: string, action: string, input: Record<string, unknown>) {
      const fore = await klocka();
      const svar = await steg(nyckel, action, input);
      const efter = await klocka();
      const rad = await sistaHandelse(input.identifier as string);
      expect(`${rad.aktor_typ} · ${rad.aktor_namn}`, action).toBe(aktor);
      expect(rad.tidpunkt.getTime(), action).toBeGreaterThanOrEqual(fore.getTime());
      expect(rad.tidpunkt.getTime(), action).toBeLessThanOrEqual(efter.getTime());
      expect(rad.payload.revision, action).toBe((svar.atagande ?? svar).revision);
      return { svar, rad };
    }

    it('F16 (AK 1): de sju åtgärderna med två nycklar — verb, skäl, revision, aktör och tid', async () => {
      const id = await nyttArende('F16');
      const HERMES = 'agent · hermes';
      const DAVID = 'manniska · david';

      // 1. registrering: grunden.
      const r1 = (
        await stegMedRad(hermes, HERMES, 'registrera_atagande', {
          identifier: id,
          grund: GRUND,
          nasta: INTERNT,
          foljs_upp: SEN,
        })
      ).rad;
      expect(r1.verb).toBe('registrerade_atagande');
      expect(r1.payload.grund).toEqual(GRUND);

      // 2. övertagande (david): nästa stegs grund.
      const r2 = (
        await stegMedRad(david, DAVID, 'ta_over_atagande', {
          identifier: id,
          nasta: INTERNT,
          foljs_upp: SEN,
          forvantad_revision: await revisionNu(id),
        })
      ).rad;
      expect(r2.verb).toBe('tog_over_atagande');
      expect(r2.payload.grund).toEqual(INTERNT.grund);

      // 3. ändring utan grund och nasta: skal, ingen grund, andring med exakt foljs_upp.
      const r3 = (
        await stegMedRad(hermes, HERMES, 'andra_atagande', {
          identifier: id,
          foljs_upp: SENARE,
          skal: SKAL,
          forvantad_revision: await revisionNu(id),
        })
      ).rad;
      expect(r3.verb).toBe('andrade_atagande');
      expect(r3.payload.skal).toEqual(SKAL);
      expect(Object.hasOwn(r3.payload, 'grund')).toBe(false);
      expect(Object.keys(r3.payload.andring)).toEqual(['foljs_upp']);

      // 4. hinder: orsaken och dess belägg.
      const r4 = (
        await stegMedRad(hermes, HERMES, 'hindra_atagande', {
          identifier: id,
          orsak: 'DNS-ändringen är inte gjord',
          belagg: HINDER,
          nasta: INTERNT,
          foljs_upp: SENARE,
          forvantad_revision: await revisionNu(id),
        })
      ).rad;
      expect(r4.verb).toBe('hindrade_atagande');
      expect(r4.payload.orsak).toEqual('DNS-ändringen är inte gjord');
      expect(r4.payload.belagg).toEqual(HINDER);

      // 5. övertagande (hermes) ur hindret: nästa stegs grund.
      const r5 = (
        await stegMedRad(hermes, HERMES, 'ta_over_atagande', {
          identifier: id,
          nasta: INTERNT,
          foljs_upp: SENARE,
          forvantad_revision: await revisionNu(id),
        })
      ).rad;
      expect(r5.verb).toBe('tog_over_atagande');
      expect(r5.payload.grund).toEqual(INTERNT.grund);

      // 6. resultat: sammanfattningen, hela beläggslistan och kontrolltiden.
      const r6 = (
        await stegMedRad(hermes, HERMES, 'redovisa_resultat', {
          identifier: id,
          sammanfattning: 'Klart enligt provet',
          belagg: BELAGG,
          forvantad_revision: await revisionNu(id),
        })
      ).rad;
      expect(r6.verb).toBe('redovisade_resultat');
      expect(r6.payload.sammanfattning).toEqual('Klart enligt provet');
      expect(r6.payload.belagg).toEqual(BELAGG);
      expect(r6.payload.kontrollerat).toEqual(
        (await steg(hermes, 'get_atagande', { identifier: id })).data.resultat.kontrollerat,
      );

      // 7. återöppning (david): den nya grunden (tidigare prövas i F14).
      const r7 = (
        await stegMedRad(david, DAVID, 'aterppna_atagande', {
          identifier: id,
          grund: NY_GRUND,
          nasta: INTERNT,
          foljs_upp: SENARE,
          forvantad_revision: await revisionNu(id),
        })
      ).rad;
      expect(r7.verb).toBe('aterppnade_atagande');
      expect(r7.payload.grund).toEqual(NY_GRUND);

      // 8. avslut: skälet och grunden.
      const r8 = (
        await stegMedRad(hermes, HERMES, 'avsluta_atagande', {
          identifier: id,
          text: 'Ersatt av ett annat åtagande',
          grund: { typ: 'beslut', id: '160' },
          forvantad_revision: await revisionNu(id),
        })
      ).rad;
      expect(r8.verb).toBe('avslutade_atagande');
      expect(r8.payload.skal).toEqual('Ersatt av ett annat åtagande');
      expect(r8.payload.grund).toEqual({ typ: 'beslut', id: '160' });
    });
  });
});
