import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// Insatsen: EN kö, inte fem. Spec: Astra 2026-09-09 §4.
//
// David skickade två skärmbilder med två olika köer som båda krävde hans svar
// och sa: "Dessa ska vara samlade." Astras varning i samma andetag: "Om
// sammanställningen bara gör dem till likadana kort har vi byggt en ny inkorg
// ovanpå de gamla."
//
// Provet finns för att de två felen ska vara OMÖJLIGA, inte avrådda:
// samma stopp får inte bli två insatser, och en agentnyckel får inte kunna
// bokföras som Davids svar.

const KONTRAKT = { system: 'hermes', kommando: 'besvara_beslut', objekt: '#153' };
const SEN = '2026-09-30T08:00:00Z';

function grund(stopp: string, extra: Record<string, unknown> = {}) {
  return {
    stopp_id: stopp,
    typ: 'agarbeslut',
    tillhor: 'agare',
    utfall: 'Riktningen är vald och arbetet kan fortsätta',
    begard_handling: 'Välj mellan A och B',
    blockeringsgrund: 'Tidigare besked avgör inte valet',
    handlingskontrakt: KONTRAKT,
    kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '153' }],
    ...extra,
  };
}

describe('insatsen: en kö, inte fem', () => {
  let app: Express;
  let hermes: string;
  let david: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  // ---- 1. samma fråga från fyra håll blir EN insats ----------------------
  it('fyra källor som beskriver samma stopp ger EN insats, inte fyra kort', async () => {
    const a = await kor(app, hermes, 'registrera_insats', grund('beslut:200'));
    expect(a.status).toBe(200);
    expect(a.body.result.nyskapad).toBe(true);

    // Samma stopp, nu med löftet och briefraden som ytterligare källor.
    const b = await kor(app, hermes, 'registrera_insats', {
      ...grund('beslut:200'),
      kallor: [
        { system: 'hermes', objekttyp: 'beslut', objekt_id: '153' },
        { system: 'redovisning', objekttyp: 'commitment', objekt_id: 'c-1' },
        { system: 'hermes', objekttyp: 'briefpunkt', objekt_id: '2026-09-09:rad3' },
      ],
    });
    expect(b.status).toBe(200);
    expect(b.body.result.nyskapad).toBe(false);
    expect(b.body.result.insats.id).toBe(a.body.result.insats.id);
    expect(b.body.result.insats.kallor).toHaveLength(3);
    expect(b.body.result.krockar).toEqual([]);

    // Och kön innehåller den EN gång.
    const ko = await kor(app, hermes, 'list_insatser', {});
    const traffar = ko.body.result.filter(
      (i: { stopp_id: string }) => i.stopp_id === 'beslut:200',
    );
    expect(traffar).toHaveLength(1);
  });

  // ---- 2. en källa kan inte tillhöra två insatser ------------------------
  it('en källa som redan hör till en annan insats flyttas ALDRIG i tysthet', async () => {
    const forsta = await kor(app, hermes, 'registrera_insats', {
      ...grund('beslut:201'),
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '201' }],
    });
    expect(forsta.body.result.nyskapad).toBe(true);

    // Ett annat stopp gör anspråk på SAMMA källa.
    const andra = await kor(app, hermes, 'registrera_insats', {
      ...grund('lofte:201'),
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '201' }],
    });
    expect(andra.status).toBe(200);
    expect(andra.body.result.krockar).toHaveLength(1);
    expect(andra.body.result.insats.kallor).toHaveLength(0);

    // Uppslagningen pekar fortfarande på den FÖRSTA insatsen.
    const upp = await kor(app, hermes, 'insats_for_kalla', {
      system: 'hermes', objekttyp: 'beslut', objekt_id: '201',
    });
    expect(upp.body.result.id).toBe(forsta.body.result.insats.id);
  });

  // ---- 3. ett svar kräver en människa -----------------------------------
  it('en agentnyckel kan inte bokföras som Davids svar', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:202', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '202' }],
    }));
    const id = i.body.result.insats.id;

    const agent = await kor(app, hermes, 'besvara_insats', { id, svar: 'ja' });
    expect(agent.status).toBe(403);
    expect(agent.body.error).toBe('kraver_manniska');

    const manniska = await kor(app, david, 'besvara_insats', { id, svar: 'ja, kör A' });
    expect(manniska.status).toBe(200);
    expect(manniska.body.result.lage).toBe('svar_mottaget');
    expect(manniska.body.result.svar_aktor).toBe('david');
    expect(manniska.body.result.svar_nar).not.toBeNull();
  });

  it('samma insats kan inte besvaras två gånger', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:203', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '203' }],
    }));
    const id = i.body.result.insats.id;
    await kor(app, david, 'besvara_insats', { id, svar: 'ja' });
    const igen = await kor(app, david, 'besvara_insats', { id, svar: 'ja igen' });
    expect(igen.status).toBe(400);
    expect(igen.body.error).toBe('redan_besvarad');
  });

  it('ett svar som utgår från en gammal version avvisas', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:204', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '204' }],
    }));
    const id = i.body.result.insats.id;
    const gammal = i.body.result.insats.version as number;
    await kor(app, david, 'skjut_upp_insats', { id, till: SEN, skal: 'i morgon' });
    const svar = await kor(app, david, 'besvara_insats', {
      id, svar: 'ja', forvantad_version: gammal,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('gammal_version');
  });

  // ---- 4. uppskjutet är inte bortglömt ----------------------------------
  it('uppskjutet ändrar väckningstiden — fristen står kvar', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:205', {
      frist: '2026-09-20T00:00:00Z',
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '205' }],
    }));
    const id = i.body.result.insats.id;
    const svar = await kor(app, david, 'skjut_upp_insats', {
      id, till: SEN, skal: 'väntar på Eva',
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.lage).toBe('uppskjuten');
    expect(String(svar.body.result.frist)).toContain('2026-09-20');
    expect(svar.body.result.vackningstid).not.toBeNull();

    // Ur kön nu...
    const ko = await kor(app, hermes, 'list_insatser', {});
    expect(ko.body.result.map((x: { id: string }) => x.id)).not.toContain(id);
  });

  it('en uppskjuten insats vars väckningstid passerat är tillbaka i kön', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:206', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '206' }],
    }));
    const id = i.body.result.insats.id;
    await kor(app, david, 'skjut_upp_insats', {
      id, till: '2020-01-01T00:00:00Z', skal: 'väckningstiden har redan passerat',
    });
    const ko = await kor(app, hermes, 'list_insatser', {});
    expect(ko.body.result.map((x: { id: string }) => x.id)).toContain(id);
  });

  // ---- 5. ett mottaget svar är Davids arbete ----------------------------
  it('ett besvarat stopp kan inte återkallas — svaret ska följas till sin fortsättning', async () => {
    const i = await kor(app, hermes, 'registrera_insats', grund('beslut:207', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '207' }],
    }));
    const id = i.body.result.insats.id;
    await kor(app, david, 'besvara_insats', { id, svar: 'ja' });
    const svar = await kor(app, hermes, 'aterkalla_insats', { id, skal: 'inte aktuell' });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('redan_besvarad');
  });

  // ---- 6. formen på en insats -------------------------------------------
  it('en insats utan källa avvisas — den går inte att följa tillbaka', async () => {
    const svar = await kor(app, hermes, 'registrera_insats', {
      ...grund('beslut:208'), kallor: [],
    });
    expect(svar.status).toBe(400);
  });

  it('tillhor kan inte vara hermes — det som inte kräver en människa är inte en insats', async () => {
    const svar = await kor(app, hermes, 'registrera_insats', {
      ...grund('beslut:209'), tillhor: 'hermes',
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '209' }],
    });
    expect(svar.status).toBe(400);
  });

  it('kön lägger ägarfrågor före användarhandlingar', async () => {
    await kor(app, hermes, 'registrera_insats', grund('anv:210', {
      typ: 'utathandling', tillhor: 'anvandare',
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '210' }],
    }));
    await kor(app, hermes, 'registrera_insats', grund('agare:211', {
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: '211' }],
    }));
    const ko = await kor(app, hermes, 'list_insatser', {});
    const roller = ko.body.result.map((x: { tillhor: string }) => x.tillhor);
    expect(roller.indexOf('agare')).toBeLessThan(roller.lastIndexOf('anvandare'));
  });
});
