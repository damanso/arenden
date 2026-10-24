// FR-16 (Story 5.3): åtagandets datakontrakt, ett prov per regel.
// Regelns egen felkod och details krävs; varje avvisning mäts med avtryck efter
// förberedelserna och har en giltig motkontroll. D8:s tillåtna celler kontrollerar
// samma åtgärder som de förbjudna. Motproven M1–M15 redovisas i berättelsen.
// Befintliga åtaganden ändras med aktuell revision och, när så krävs, skal (5.2).
// AK 6 (barnräkningen) är borttaget: Story 5.5 prövar märkta nödvändiga delresultat i test/delresultat.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import type { Atagande } from '../src/services/atagande.js';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const NY_GRUND = { typ: 'beslut', id: '171', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const RIKTNING = {
  handling: 'Välj vilken leverans som går först', slag: 'riktning', grund: { typ: 'beslut', id: '172' },
};
const UTAT = { handling: 'Skicka svaret till kunden', slag: 'utathandling', grund: GRUND[0] };
const HINDER = { typ: 'beslut', id: '145' };
const BELAGG = [{ typ: 'prov', id: 'atagande-kontrakt', version: '2026-10-18' }];
const SKAL = 'Provet byter villkoren';
const PRECISERING = 'Klart när kunden har fått offerten och svaret står som belägg på åtagandet.';
const V_OKANT = {
  text: 'Gör X endast om Y håller',
  kalla: { typ: 'beslut', id: '153' },
  galler: 'utfora',
  kontroll: 'kontrollera Y',
  utfall: 'okant',
};
const V_UPPFYLLT = { ...V_OKANT, utfall: 'uppfyllt', belagg: { typ: 'prov', id: 'y' } };
const V_EJ = { ...V_OKANT, utfall: 'ej_uppfyllt', belagg: { typ: 'prov', id: 'z' } };
const SEN = '2026-09-30T08:00:00Z';
const SENARE = '2026-10-30T08:00:00Z';

type Lage = 'registrerat' | 'overtaget' | 'hindrat' | 'genomfort' | 'avslutat';
let app: Express;
let hermes: string;
let david: string;

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

/** Provställningen byggs genom actions, aldrig med SQL (D6 prövar själva databasspärren). */
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

/** Bara D6 behöver ägarrollen, för att visa att CHECK gäller även den. */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

function avvisad(svar: { status: number; body: { error?: string } }, kod: string, etikett = kod): void {
  expect([svar.status, svar.body.error], etikett).toEqual([400, kod]);
}

function schemafel(
  svar: { status: number; body: { error?: string; details?: unknown } }, path: string, etikett = path,
): void {
  avvisad(svar, 'validation_error', etikett);
  expect(svar.body.details, etikett).toEqual(expect.arrayContaining([expect.objectContaining({ path })]));
}

function okantFalt(
  svar: { status: number; body: { error?: string; details?: unknown } }, falt: string,
): void {
  avvisad(svar, 'validation_error', falt);
  expect(svar.body.details, falt).toContainEqual({
    path: '', message: `Unrecognized key(s) in object: '${falt}'`,
  });
}

describe('FR-16/Story 5.3: åtagandets datakontrakt är provat i varje led', () => {
  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  describe('FR-16/Story 5.3 AK 1: villkoren', () => {
    it('D1 (AK 1): känt utfall kräver belägg med rätt details, medan okant utan belägg sparas', async () => {
      const id = await iLage('registrerat', 'D1');
      const { belagg: _u, ...uppfylltUtan } = V_UPPFYLLT;
      const { belagg: _e, ...ejUtan } = V_EJ;
      const avvisade = [uppfylltUtan, ejUtan, { ...uppfylltUtan, belagg: null }, { ...ejUtan, belagg: null }];
      const fore = await avtryck(id);
      for (const villkor of avvisade) {
        const svar = await kor(app, hermes, 'andra_atagande', {
          identifier: id, villkor: [villkor], skal: SKAL, forvantad_revision: await revisionNu(id),
        });
        avvisad(svar, 'validation_error', villkor.utfall);
        expect(svar.body.details).toContainEqual({
          path: 'villkor.0', message: 'ett villkor som inte är okänt kräver belägg',
        });
        expect(await avtryck(id)).toEqual(fore);
      }
      const okant = await steg(hermes, 'andra_atagande', {
        identifier: id, villkor: [V_OKANT], skal: SKAL, forvantad_revision: await revisionNu(id),
      });
      expect(okant.data.villkor).toEqual([V_OKANT]);
      // Samma kända utfall MED belägg sparas; det var just belägget som saknades.
      const med = await steg(hermes, 'andra_atagande', {
        identifier: id, villkor: [V_UPPFYLLT, V_EJ], skal: SKAL, forvantad_revision: await revisionNu(id),
      });
      expect(med.data.villkor).toEqual([V_UPPFYLLT, V_EJ]);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 2);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 2);
    });

    it('D2 (AK 1): varje ouppfyllt villkor spärrar resultatet, två uppfyllda släpper igenom det', async () => {
      const id = await iLage('overtaget', 'D2');
      const redovisning = { identifier: id, sammanfattning: 'Klart enligt provet', belagg: BELAGG };
      for (const villkor of [[V_OKANT], [V_EJ], [V_UPPFYLLT, V_OKANT]]) {
        await steg(hermes, 'andra_atagande', {
          identifier: id, villkor, skal: SKAL, forvantad_revision: await revisionNu(id),
        });
        const fore = await avtryck(id);
        avvisad(await kor(app, hermes, 'redovisa_resultat', {
          ...redovisning, forvantad_revision: await revisionNu(id),
        }), 'villkor_haller_inte');
        expect(await avtryck(id)).toEqual(fore);
      }
      await steg(hermes, 'andra_atagande', {
        identifier: id, villkor: [V_UPPFYLLT, V_UPPFYLLT], skal: SKAL,
        forvantad_revision: await revisionNu(id),
      });
      const fore = await avtryck(id);
      const med = await steg(hermes, 'redovisa_resultat', {
        ...redovisning, forvantad_revision: await revisionNu(id),
      });
      expect(med.lage).toBe('genomfort');
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 1);
    });

    it('D3 (AK 1): vart och ett av villkorets fem obligatoriska fält krävs', async () => {
      const id = await iLage('registrerat', 'D3');
      const fore = await avtryck(id);
      for (const falt of ['text', 'kalla', 'galler', 'kontroll', 'utfall']) {
        const villkor: Record<string, unknown> = { ...V_UPPFYLLT };
        delete villkor[falt];
        schemafel(await kor(app, hermes, 'andra_atagande', {
          identifier: id, villkor: [villkor], skal: SKAL, forvantad_revision: await revisionNu(id),
        }), `villkor.0.${falt}`);
        expect(await avtryck(id)).toEqual(fore);
      }
      const med = await steg(hermes, 'andra_atagande', {
        identifier: id, villkor: [V_UPPFYLLT], skal: SKAL, forvantad_revision: await revisionNu(id),
      });
      expect(med.data.villkor).toEqual([V_UPPFYLLT]);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 1);
    });
  });

  describe('FR-16/Story 5.3 AK 2: hinder och avslut kräver sitt skäl', () => {
    it('D4 (AK 2): hinder utan orsak, med tom orsak eller utan belägg skriver ingenting', async () => {
      const id = await iLage('overtaget', 'D4');
      const giltig = { orsak: 'Väntar på DNS', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN };
      const { orsak: _o, ...utanOrsak } = giltig;
      const { belagg: _b, ...utanBelagg } = giltig;
      const fore = await avtryck(id);
      const fall: [string, Record<string, unknown>][] = [
        ['orsak', utanOrsak], ['orsak', { ...giltig, orsak: '' }], ['belagg', utanBelagg],
      ];
      for (const [path, input] of fall) {
        schemafel(await kor(app, hermes, 'hindra_atagande', {
          identifier: id, ...input, forvantad_revision: await revisionNu(id),
        }), path);
        expect(await avtryck(id)).toEqual(fore);
      }
      const med = await steg(hermes, 'hindra_atagande', {
        identifier: id, ...giltig, forvantad_revision: await revisionNu(id),
      });
      expect(med.lage).toBe('hindrat');
      expect(med.data.hinder).toEqual({ orsak: giltig.orsak, belagg: HINDER });
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 1);
    });

    it('D5 (AK 2): avslut utan text, med tom text eller utan grund skriver ingenting', async () => {
      const id = await iLage('overtaget', 'D5');
      const giltig = { text: 'Behövs inte längre', grund: NY_GRUND };
      const { text: _t, ...utanText } = giltig;
      const { grund: _g, ...utanGrund } = giltig;
      const fore = await avtryck(id);
      const fall: [string, Record<string, unknown>][] = [
        ['text', utanText], ['text', { ...giltig, text: '' }], ['grund', utanGrund],
      ];
      for (const [path, input] of fall) {
        schemafel(await kor(app, hermes, 'avsluta_atagande', {
          identifier: id, ...input, forvantad_revision: await revisionNu(id),
        }), path);
        expect(await avtryck(id)).toEqual(fore);
      }
      const med = await steg(hermes, 'avsluta_atagande', {
        identifier: id, ...giltig, forvantad_revision: await revisionNu(id),
      });
      expect(med.lage).toBe('avslutat');
      expect(med.data.avslutsskal).toEqual(giltig);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 1);
    });

    it('D6 (AK 2): ägarrollens UPDATE utan hinder eller avslutsskal fälls av just CHECK-villkoret', async () => {
      const id = await iLage('overtaget', 'D6');
      const { issue_id } = await steg(hermes, 'get_atagande', { identifier: id });
      const fall = [
        {
          lage: 'hindrat', villkor: 'issues_atagande_hinder',
          falt: { hinder: { orsak: 'Väntar på DNS', belagg: HINDER } },
        },
        {
          lage: 'avslutat', villkor: 'issues_atagande_avslut',
          falt: { avslutsskal: { text: 'Behövs inte', grund: NY_GRUND } },
        },
      ];
      const fore = await avtryck(id);
      const admin = await adminKlient();
      try {
        await admin.query('BEGIN');
        await admin.query("SET LOCAL lock_timeout = '5s'");
        for (const { lage, villkor, falt } of fall) {
          await admin.query('SAVEPOINT fore');
          const fel = await admin.query('UPDATE issues SET atagande_lage = $2 WHERE id = $1', [issue_id, lage])
            .then(() => null, (e: unknown) => e);
          expect(fel, lage).toMatchObject({ code: '23514', constraint: villkor });
          await admin.query('ROLLBACK TO SAVEPOINT fore');
          // Samma UPDATE med fältet lyckas: ingen annan spärr orsakar avvisningen.
          const med = await admin.query(
            'UPDATE issues SET atagande_lage = $2, atagande = atagande || $3::jsonb WHERE id = $1',
            [issue_id, lage, JSON.stringify(falt)],
          );
          expect(med.rowCount, lage).toBe(1);
          await admin.query('ROLLBACK TO SAVEPOINT fore');
          // Negativ kontroll som kedjan ser. Bara de två fasta villkorsnamnen interpoleras.
          await admin.query(`ALTER TABLE issues DROP CONSTRAINT ${villkor}`);
          const utanRegel = await admin.query(
            'UPDATE issues SET atagande_lage = $2 WHERE id = $1', [issue_id, lage],
          );
          expect(utanRegel.rowCount, lage).toBe(1);
          await admin.query('ROLLBACK TO SAVEPOINT fore');
        }
      } finally {
        try {
          await admin.query('ROLLBACK');
        } finally {
          await admin.end();
        }
      }
      expect(await avtryck(id)).toEqual(fore);
    });
  });

  describe('FR-16/Story 5.3 AK 3: resultatet', () => {
    it('D7 (AK 3): belägg krävs och kontrolltiden sätts av servern utan att kunna anges', async () => {
      const id = await iLage('overtaget', 'D7');
      const giltig = { sammanfattning: 'Klart enligt provet', belagg: BELAGG };
      const fore = await avtryck(id);
      for (const input of [{ ...giltig, belagg: [] }, { sammanfattning: giltig.sammanfattning }]) {
        schemafel(await kor(app, hermes, 'redovisa_resultat', {
          identifier: id, ...input, forvantad_revision: await revisionNu(id),
        }), 'belagg');
        expect(await avtryck(id)).toEqual(fore);
      }
      okantFalt(await kor(app, hermes, 'redovisa_resultat', {
        identifier: id, ...giltig, kontrollerat: '2000-01-01T00:00:00.000Z',
        forvantad_revision: await revisionNu(id),
      }), 'kontrollerat');
      expect(await avtryck(id)).toEqual(fore);
      const n = await revisionNu(id);
      const innan = Date.now();
      const med = await steg(hermes, 'redovisa_resultat', { identifier: id, ...giltig, forvantad_revision: n });
      const efterTid = Date.now();
      expect(med.lage).toBe('genomfort');
      expect(med.data.resultat).toMatchObject(giltig);
      const k = med.data.resultat.kontrollerat;
      expect(typeof k).toBe('string');
      expect(new Date(k).toISOString()).toBe(k);
      expect(Date.parse(k)).toBeGreaterThanOrEqual(innan);
      expect(Date.parse(k)).toBeLessThanOrEqual(efterTid);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 1);
      expect(efter.rad.atagande_revision).toBe(n + 1);
    });
  });

  describe('FR-16/Story 5.3 AK 4: övergångstabellen, alla fall', () => {
    const LAGEN: Lage[] = ['registrerat', 'overtaget', 'hindrat', 'genomfort', 'avslutat'];
    // Handskriven regel: import av OVERGANGAR skulle låta provet följa med en felaktig ändring.
    const TILLATET: Record<Lage, Lage[]> = {
      registrerat: ['overtaget', 'hindrat', 'avslutat'],
      overtaget: ['overtaget', 'hindrat', 'genomfort', 'avslutat'],
      hindrat: ['overtaget', 'avslutat'],
      genomfort: ['registrerat'],
      avslutat: ['registrerat'],
    };
    const ATGARD: Record<Lage, { action: string; input: Record<string, unknown> }> = {
      overtaget: { action: 'ta_over_atagande', input: { nasta: INTERNT, foljs_upp: SEN } },
      hindrat: {
        action: 'hindra_atagande',
        input: { orsak: 'Väntar på DNS', belagg: HINDER, nasta: INTERNT, foljs_upp: SEN },
      },
      genomfort: {
        action: 'redovisa_resultat', input: { sammanfattning: 'Klart enligt provet', belagg: BELAGG },
      },
      avslutat: { action: 'avsluta_atagande', input: { text: 'Behövs inte längre', grund: NY_GRUND } },
      registrerat: {
        action: 'aterppna_atagande', input: { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE },
      },
    };
    const CELLER = LAGEN.flatMap((fran) => LAGEN.map((till) => ({
      fran, till, tillaten: TILLATET[fran].includes(till),
    })));

    it.each(CELLER)('D8 (AK 4): $fran → $till (tillåten: $tillaten)', async ({ fran, till, tillaten }) => {
      const id = await iLage(fran, `D8 ${fran} → ${till}`);
      const { action, input } = ATGARD[till];
      const n = await revisionNu(id);
      const fore = await avtryck(id);
      const svar = await kor(app, hermes, action, { identifier: id, ...input, forvantad_revision: n });
      if (tillaten) {
        expect(svar.status, JSON.stringify(svar.body)).toBe(200);
        expect(svar.body.result).toMatchObject({ lage: till, revision: n + 1 });
        const efter = await avtryck(id);
        expect(efter.events).toBe(fore.events + 1);
        expect(efter.issues).toBe(fore.issues);
        expect(efter.rad.atagande_revision).toBe(n + 1);
      } else {
        avvisad(svar, 'otillaten_overgang');
        expect(await avtryck(id)).toEqual(fore);
      }
    });

    it('D9 (AK 4): hindrat kräver nytt övertagande före genomfört', async () => {
      const id = await iLage('hindrat', 'D9');
      const redovisning = { identifier: id, sammanfattning: 'Klart enligt provet', belagg: BELAGG };
      const fore = await avtryck(id);
      avvisad(await kor(app, hermes, 'redovisa_resultat', {
        ...redovisning, forvantad_revision: await revisionNu(id),
      }), 'otillaten_overgang');
      expect(await avtryck(id)).toEqual(fore);
      await steg(hermes, 'ta_over_atagande', {
        identifier: id, nasta: INTERNT, foljs_upp: SEN, forvantad_revision: await revisionNu(id),
      });
      const med = await steg(hermes, 'redovisa_resultat', {
        ...redovisning, forvantad_revision: await revisionNu(id),
      });
      expect(med.lage).toBe('genomfort');
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 2);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 2);
    });
  });

  describe('FR-16/Story 5.3 AK 5: ett stängt åtagande skrivs inte om', () => {
    it('D10 (AK 5): ändring av uppföljning eller nästa steg avvisas i båda stängda lägena', async () => {
      const genomfort = await iLage('genomfort', 'D10 genomfört');
      const avslutat = await iLage('avslutat', 'D10 avslutat');
      const oppet = await iLage('overtaget', 'D10 övertaget');
      const andringar = [{ foljs_upp: SENARE, skal: SKAL }, { nasta: RIKTNING }];
      // Alla provställningar finns innan avtrycken: räkningen gäller hela tabellen.
      const stangda = await Promise.all([genomfort, avslutat].map(async (id) => ({
        id, fore: await avtryck(id),
      })));
      for (const { id } of stangda) {
        for (const input of andringar) {
          avvisad(await kor(app, hermes, 'andra_atagande', {
            identifier: id, ...input, forvantad_revision: await revisionNu(id),
          }), 'atagandet_ar_stangt');
          for (const stangt of stangda) expect(await avtryck(stangt.id)).toEqual(stangt.fore);
        }
      }
      const fore = await avtryck(oppet);
      for (const input of andringar) {
        await steg(hermes, 'andra_atagande', {
          identifier: oppet, ...input, forvantad_revision: await revisionNu(oppet),
        });
      }
      const efter = await avtryck(oppet);
      expect(efter.events).toBe(fore.events + 2);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 2);
    });
  });

  describe('FR-16/Story 5.3 AK 7: utfallet och utföraren', () => {
    it('D12 (AK 7): rättad titel läses som utfall, preciseringen sparas och utföraren är nyckelns aktör', async () => {
      const id = await nyttArende('Titel före rättelsen');
      await steg(hermes, 'registrera_atagande', {
        identifier: id, grund: GRUND, nasta: INTERNT, foljs_upp: SEN, utfall_precisering: PRECISERING,
      });
      const fore = await steg(hermes, 'get_atagande', { identifier: id });
      expect(fore.utfall).toBe('Titel före rättelsen');
      expect(fore.data.utfall_precisering).toBe(PRECISERING);
      await steg(hermes, 'update_issue', { identifier: id, title: 'Rättad titel' });
      for (const [nyckel, typ, namn] of [[david, 'manniska', 'david'], [hermes, 'agent', 'hermes']] as const) {
        await steg(nyckel, 'ta_over_atagande', {
          identifier: id, nasta: INTERNT, foljs_upp: SEN, forvantad_revision: await revisionNu(id),
        });
        const efter = await steg(hermes, 'get_atagande', { identifier: id });
        expect(efter).toMatchObject({
          utfall: 'Rättad titel', lage: 'overtaget', utforare_typ: typ, utforare_namn: namn,
        });
        expect(efter.data.utfall_precisering).toBe(PRECISERING);
        expect(efter.overtaget_nar).toBeTruthy();
      }
    });

    it('D13 (AK 7): utförarfält avvisas i övertagande, registrering och ändring utan någon skrivning', async () => {
      const id = await iLage('registrerat', 'D13 registrerat');
      const utan = await nyttArende('D13 utan åtagande');
      const registrering = { identifier: utan, grund: GRUND, nasta: INTERNT, foljs_upp: SEN };
      const overtagande = { identifier: id, nasta: INTERNT, foljs_upp: SEN };
      const fore = await avtryck(id);
      const falska: Record<string, unknown> = {
        utforare_typ: 'manniska', utforare_namn: 'annan', utforare: { typ: 'manniska', namn: 'annan' },
      };
      for (const [falt, varde] of Object.entries(falska)) {
        const svar = await kor(app, hermes, 'ta_over_atagande', {
          ...overtagande, [falt]: varde, forvantad_revision: await revisionNu(id),
        });
        okantFalt(svar, falt);
        expect(await avtryck(id)).toEqual(fore);
      }
      okantFalt(await kor(app, hermes, 'registrera_atagande', {
        ...registrering, utforare_namn: 'annan',
      }), 'utforare_namn');
      expect(await avtryck(id)).toEqual(fore);
      okantFalt(await kor(app, hermes, 'andra_atagande', {
        identifier: id, nasta: RIKTNING, utforare_namn: 'annan', forvantad_revision: await revisionNu(id),
      }), 'utforare_namn');
      expect(await avtryck(id)).toEqual(fore);
      avvisad(await kor(app, hermes, 'get_atagande', { identifier: utan }), 'inget_atagande');
      // En motkontroll per åtgärd, med samma indata utan det främmande fältet.
      const overtog = await steg(hermes, 'ta_over_atagande', {
        ...overtagande, forvantad_revision: await revisionNu(id),
      });
      expect(overtog).toMatchObject({ utforare_typ: 'agent', utforare_namn: 'hermes' });
      const andrat = await steg(hermes, 'andra_atagande', {
        identifier: id, nasta: RIKTNING, forvantad_revision: await revisionNu(id),
      });
      expect(andrat.tillhor).toBe('agare');
      expect((await steg(hermes, 'registrera_atagande', registrering)).nyskapad).toBe(true);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 3);
      expect(efter.issues).toBe(fore.issues);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 2);
    });
  });

  describe('FR-16/Story 5.3 AK 8: utåthandling kan inte göras intern utan ny grund', () => {
    it('D14 (AK 8): byte från utåthandling till internt eller riktning kräver ny grund', async () => {
      const id = await nyttArende('D14');
      await steg(hermes, 'registrera_atagande', {
        identifier: id, grund: GRUND, nasta: UTAT, foljs_upp: SEN,
      });
      const fore = await avtryck(id);
      for (const nasta of [INTERNT, RIKTNING]) {
        avvisad(await kor(app, hermes, 'andra_atagande', {
          identifier: id, nasta, forvantad_revision: await revisionNu(id),
        }), 'utathandling_kringgas');
        expect(await avtryck(id)).toEqual(fore);
      }
      const nyHandling = { ...UTAT, handling: 'Ring kunden i stället' };
      const utat = await steg(hermes, 'andra_atagande', {
        identifier: id, nasta: nyHandling, forvantad_revision: await revisionNu(id),
      });
      expect(utat.data.nasta).toEqual(nyHandling);
      // Ny grund gör samma byte till internt tillåtet och sparas sist i grundlistan.
      const med = await steg(hermes, 'andra_atagande', {
        identifier: id, nasta: INTERNT, grund: NY_GRUND, forvantad_revision: await revisionNu(id),
      });
      expect(med.tillhor).toBe('hermes');
      expect(med.data.nasta).toEqual(INTERNT);
      expect(med.data.grund).toEqual([...GRUND, NY_GRUND]);
      const efter = await avtryck(id);
      expect(efter.events).toBe(fore.events + 2);
      expect(efter.rad.atagande_revision).toBe(fore.rad.atagande_revision + 2);
    });
  });

  describe('FR-16/Story 5.3 AK 10: utfallet är begripligt (läsunderlaget)', () => {
    // Granskaren i code-review har inte skrivit fixturen och läser bara dessa två fält.
    const UTFALL_FIXTUR: { titel: string; precisering?: string }[] = [
      {
        titel: 'Spegeln levererar ändrade LOC-ärenden till valvet varje natt',
        precisering: 'Klart när nattkörningen har pushat varje ändrad LOC-fil och vattenmärket flyttas först efter en lyckad push.',
      },
      {
        titel: 'Kundkortet på ärendesidan läses ur redovisningen med kundens id',
        precisering: 'Ett projekt som är kopplat till en kund visar kundkortet ur redovisningen; ett okopplat projekt visar inget kundkort och ingen gissning.',
      },
      {
        titel: 'Svaret om leveransdatum går till kunden först efter Davids godkännande',
        precisering: 'David godkänner utkastet i Din insats, därefter skickas svaret, och åtagandet bär det skickade svaret som belägg.',
      },
      { titel: 'Nattsviten skiljer en utebliven körning från fallerade prov' },
    ];

    it('D15 (AK 10): get och list ger fixturens exakta utfall och precisering, eller saknad nyckel', async () => {
      const poster: { id: string; titel: string; precisering?: string }[] = [];
      for (const post of UTFALL_FIXTUR) {
        const id = await nyttArende(post.titel);
        await steg(hermes, 'registrera_atagande', {
          identifier: id, grund: GRUND, nasta: INTERNT, foljs_upp: SEN,
          ...(post.precisering !== undefined ? { utfall_precisering: post.precisering } : {}),
        });
        poster.push({ id, ...post });
      }
      const lista: Atagande[] = await steg(hermes, 'list_ataganden', { oavslutade: true });
      for (const { id, titel, precisering } of poster) {
        const hamtat = await steg(hermes, 'get_atagande', { identifier: id });
        const listrader = lista.filter((rad) => rad.identifier === id);
        expect(listrader).toHaveLength(1);
        for (const rad of [hamtat, listrader[0]]) {
          expect(rad.utfall).toBe(titel);
          expect(rad.lage).toBe('registrerat');
          if (precisering !== undefined) {
            expect(rad.data.utfall_precisering).toBe(precisering);
          } else {
            expect(Object.hasOwn(rad.data, 'utfall_precisering')).toBe(false);
          }
        }
      }
    });
  });
});
