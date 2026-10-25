import { rm, writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { withTransaction } from '../src/db/tx.js';
import { crmAnrop, hamtaCrm, nollstallCrmCache } from '../src/http/vy/crm.js';
import { hamtaEllerSkapaProjekt } from '../src/services/arenden.js';
import { sattKundkoppling } from '../src/services/kundkoppling.js';
import { TEST_CRM_KONF } from './env.js';
import { kor, nyNyckel, seedaTeam, TENANT_ID } from './helpers.js';

// CRM-koppling KRAV-6: hela stacken (vitest + supertest), ingen HTTP-mock.
// Felvägen är på riktigt — testkonfigurationen pekar på en STÄNGD port, precis
// som en nedlagd redovisning ser ut för vyn.
const STANGD_PORT = 'http://127.0.0.1:1';
const TESTTOKEN = 'TESTTOKEN-FAR-ALDRIG-SYNAS-I-HTML';
const TESTBOLAG = '00000000-0000-4000-8000-000000000000';

/**
 * Kundens id i redovisningen. Ett UUID och inget annat - testet ska inte
 * kunna passera med ett namn ens av misstag.
 */
const TESTKUND = '11111111-2222-4333-8444-555555555555';

/** B-08 (Story 6.1): ett kund-id i en annan källa än redovisningen. CRM-uppslaget kan inte tolka det. */
const ANNAN_KUND = '66666666-7777-4888-9999-aaaaaaaaaaaa';

/**
 * B-08 (Story 6.1): källan är en obligatorisk parameter och skickas som den är. Hjälparen har ingen
 * standardkälla, av samma skäl som tjänsten inte har någon.
 */
async function kopplaKund(projekt: string, kundId: string | null, kalla: string | null): Promise<void> {
  await withTransaction(async (client) => {
    await sattKundkoppling(
      client,
      TENANT_ID,
      projekt,
      kundId === null ? { status: 'intern' } : { status: 'kopplad', kund_id: kundId, kund_kalla: kalla },
    );
  });
}

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

/**
 * Sidan utan sidhuvudet: 'CRM' står i huvudmenyn på varje sida, så markören prövas på innehållet.
 * Avskriven ur fallet «KRAV-1/5/6d» nedan.
 */
function utanKrom(s: string): string {
  const i = s.indexOf('</header>');
  return i === -1 ? s : s.slice(i);
}

describe('CRM-koppling KRAV-1..6', () => {
  let app: Express;
  /** Ärende i projekt NVR-001 — mappar till Nordic Vision Retail AB. */
  let mappat: string;
  /** Ärende i ett internt projekt och med neutral titel — mappar aldrig. */
  let omappat: string;
  /** Ärende i ett projekt kopplat i en annan källa än redovisningen (Story 6.1) — inget uppslag. */
  let annan: string;
  let agentnyckel: string;

  beforeAll(async () => {
    await rm(TEST_CRM_KONF, { force: true });
    await writeFile(
      TEST_CRM_KONF,
      JSON.stringify({
        mcpServers: {
          redovisning: {
            env: {
              REDOVISNING_API_URL: STANGD_PORT,
              REDOVISNING_COMPANY_ID: TESTBOLAG,
              REDOVISNING_AGENT_TOKEN: TESTTOKEN,
            },
          },
        },
      }),
      'utf8',
    );
    nollstallCrmCache();

    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });

    const ett = await kor(app, agentnyckel, 'create_issue', {
      title: 'Leverans av butiksdata',
      description: 'Underlaget ska levereras före månadsskiftet.',
      team_key: 'LOC',
    });
    mappat = ett.body.result.identifier;
    await sattProjekt(mappat, 'NVR-001');
    await kopplaKund('NVR-001', TESTKUND, 'redovisning');
    await kor(app, agentnyckel, 'add_comment', {
      identifier: mappat,
      body: 'Avstämning bokad.',
    });

    const tva = await kor(app, agentnyckel, 'create_issue', {
      title: 'Städa upp byggkedjan',
      description: 'Internt arbete utan kund.',
      team_key: 'LOC',
    });
    omappat = tva.body.result.identifier;
    await sattProjekt(omappat, 'Hermes');
    // Hermes ar INTERNT. Det ar ocksa namnet pa en arkiverad, tom
    // CRM-organisation - fallan en namnmatchning gar rakt i.
    await kopplaKund('Hermes', null, null);

    // Story 6.1: kopplat med ett id, men i en annan källa. Varken projektnamnet eller titeln
    // innehåller ordet CRM, eftersom KRAV-1/5/6d prövar att /vy och /vy/sok saknar det.
    const tre = await kor(app, agentnyckel, 'create_issue', {
      title: 'Ärende i ett projekt med en annan källa',
      team_key: 'LOC',
    });
    annan = tre.body.result.identifier;
    await sattProjekt(annan, 'K-annan-kalla');
    await kopplaKund('K-annan-kalla', ANNAN_KUND, 'annat-system');
  });

  // ---- (a) mappningen ------------------------------------------------------

  it('K-4/6a: kortet följer kund_id — aldrig namnet', async () => {
    nollstallCrmCache();

    // Projektet Hermes har SAMMA NAMN som en organisation i CRM. Den posten är
    // arkiverad, har noll interaktioner och noll personer, och en namnmatchning
    // hade knutit ärendet till den utan ett ord. Utan kund_id: inget kort, och
    // framför allt INGEN hämtning.
    const utan = await request(app).get(`/vy/arende/${omappat}`);
    expect(utan.status).toBe(200);
    // Kortets rubrik, inte ordet: 'CRM' star i huvudmenyn pa varje sida
    // sedan omradena blev jamlika (2026-09-09). En markor som traffar
    // kromet mater navigationen, inte kundkopplingen.
    expect(utan.text).not.toContain('<h2>CRM</h2>');
    expect(crmAnrop()).toBe(0);

    // Samma sida, samma sorts ärende — men projektet har ett kund_id. Först då
    // hämtas CRM över huvud taget.
    const med = await request(app).get(`/vy/arende/${mappat}`);
    expect(med.status).toBe(200);
    expect(med.text).toContain('<h2>CRM</h2>');
    expect(crmAnrop()).toBe(1);
  });

  // ---- (b) felvägen på riktigt ---------------------------------------------

  it('KRAV-3/6b: stängd port sänker inte sidan — 200 med fallbacktext och allt övrigt', async () => {
    const svar = await request(app).get(`/vy/arende/${mappat}`);

    expect(svar.status).toBe(200);
    expect(svar.headers['content-type']).toMatch(/text\/html/);
    // Ingen organisationsrubrik nar vi inte natt CRM: namnet hamtas ur
    // svaret, och nagot svar finns inte. Att skriva ut ett namn har vore
    // att pasta nagot vi inte vet.
    expect(svar.text).toContain('<h2>CRM</h2>');
    expect(svar.text).not.toContain('CRM — ');
    expect(svar.text).toContain('CRM-data ej tillgänglig just nu');

    // Sidans övriga innehåll renderas FULLSTÄNDIGT: titel, beskrivning,
    // kommentarer och historik.
    expect(svar.text).toContain('Leverans av butiksdata');
    expect(svar.text).toContain('Underlaget ska levereras före månadsskiftet.');
    expect(svar.text).toContain('Avstämning bokad.');
    expect(svar.text).toContain('<h2>Historik (2)</h2>');
    // Inget stackspår, ingen konfigurationsdetalj.
    expect(svar.text).not.toContain('ECONNREFUSED');
    expect(svar.text).not.toContain('127.0.0.1:1');
  });

  // ---- (c) tokenet lämnar aldrig processen ---------------------------------

  it('KRAV-3/6c: agent-tokenet finns inte i någon renderad HTML', async () => {
    const sidor = [
      `/vy/arende/${mappat}`,
      `/vy/arende/${omappat}`,
      '/vy',
      '/vy/digest',
      '/vy/sok?projekt=NVR-001',
    ];
    for (const vag of sidor) {
      const svar = await request(app).get(vag);
      expect(svar.status, vag).toBe(200);
      expect(svar.text, vag).not.toContain(TESTTOKEN);
      expect(svar.text, vag).not.toContain('Bearer');
      expect(svar.text, vag).not.toContain('REDOVISNING_AGENT_TOKEN');
    }
  });

  // ---- (d) ingen mappning → inget kort, och (KRAV-5) ingen hämtning --------

  it('KRAV-1/5/6d: omappat ärende och överblicken ger varken kort eller CRM-anrop', async () => {
    const fore = crmAnrop();

    // "CRM" star i huvudmenyn pa varje sida sedan omradena blev jamlika
    // (2026-09-09). Kravet galler INNEHALLET, inte kromet: darfor klipps
    // sidhuvudet bort innan markoren provas. Det som fortfarande maste vara
    // sant ar att inget CRM-kort renderas och att CRM inte anropas.
    const utanKrom = (s: string) => {
      const i = s.indexOf('</header>');
      return i === -1 ? s : s.slice(i);
    };

    const arende = await request(app).get(`/vy/arende/${omappat}`);
    expect(arende.status).toBe(200);
    expect(arende.text).toContain('Städa upp byggkedjan');
    expect(utanKrom(arende.text)).not.toContain('CRM');

    for (const vag of ['/vy', '/vy/digest', '/vy/sok?q=Leverans', '/vy/dok/01-Projekt/plan.md']) {
      const svar = await request(app).get(vag);
      expect(utanKrom(svar.text), vag).not.toContain('CRM');
    }

    expect(crmAnrop()).toBe(fore);
  });

  // ---- (e) felcachen -------------------------------------------------------

  it('KRAV-4/6e: två sidladdningar i följd ger bara ETT anrop inom TTL:n', async () => {
    nollstallCrmCache();

    const forsta = await request(app).get(`/vy/arende/${mappat}`);
    expect(forsta.status).toBe(200);
    expect(crmAnrop()).toBe(1);

    const andra = await request(app).get(`/vy/arende/${mappat}`);
    expect(andra.status).toBe(200);
    expect(andra.text).toContain('CRM-data ej tillgänglig just nu');
    // Felet är cachat (TTL 30 s) — ingen ny 3-sekundersväg per sidladdning.
    expect(crmAnrop()).toBe(1);
  });

  // ---- läsytan är oförändrad ----------------------------------------------

  it('KRAV: CRM-kortet är GET-renderat — ingen mutation finns', async () => {
    const post = await request(app).post(`/vy/arende/${mappat}`).send({ text: 'nej' });
    expect(post.status).toBe(404);
  });

  describe('FR-26/Story 6.1 AK 4: ärendets läsmodell bär kund_kalla', () => {
    it('KC2 (AK 4): get_issue ger källan och id:t för redovisningens, en annan källas och ett internt ärende', async () => {
      const fall: [string, string | null, string | null][] = [
        [mappat, 'redovisning', TESTKUND],
        [annan, 'annat-system', ANNAN_KUND],
        [omappat, null, null],
      ];
      for (const [identifier, kalla, kundId] of fall) {
        const svar = await kor(app, agentnyckel, 'get_issue', { identifier });
        expect(svar.status, identifier).toBe(200);
        expect(svar.body.result.arende.kund_kalla, identifier).toBe(kalla);
        expect(svar.body.result.arende.kund_id, identifier).toBe(kundId);
      }
    });
  });

  describe('FR-26/Story 6.1 AK 4: kundkortet läses bara ur det system id:t hör till (B-08)', () => {
    it('KC1 (AK 4): bara redovisningens koppling slås upp; en annan källa visas med källa och id, utan kort', async () => {
      nollstallCrmCache();

      const andra = await request(app).get(`/vy/arende/${annan}`);
      const tredje = await request(app).get(`/vy/arende/${omappat}`);
      expect(andra.status).toBe(200);
      expect(tredje.status).toBe(200);
      // Varken den andra källans id eller det interna projektet nådde uppslaget.
      expect(crmAnrop()).toBe(0);
      expect(utanKrom(andra.text)).not.toContain('CRM');
      expect(andra.text).toMatch(
        new RegExp(`<p>annat-system · kund-id ${ANNAN_KUND} · kopplad \\d{4}-\\d{2}-\\d{2}</p>`),
      );
      expect(utanKrom(tredje.text)).not.toContain('CRM');

      // Kontroll: det första ärendet skiljer sig från det andra bara i källan, och det slås upp.
      const forsta = await request(app).get(`/vy/arende/${mappat}`);
      expect(forsta.status).toBe(200);
      expect(forsta.text).toContain('<h2>CRM</h2>');
      expect(forsta.text).toContain('CRM-data ej tillgänglig just nu.');
      expect(crmAnrop()).toBe(1);
    });

    it('KC3 (AK 4): hamtaCrm slår upp en koppling bara när källan är exakt redovisningen', async () => {
      nollstallCrmCache();
      const utanUppslag = [
        { kund_id: null, kund_kalla: null },
        { kund_id: TESTKUND, kund_kalla: 'annat-system' },
        // Exakt jämförelse: inget skiftläge viks ihop.
        { kund_id: TESTKUND, kund_kalla: 'Redovisning' },
      ];
      for (const koppling of utanUppslag) {
        const namn = JSON.stringify(koppling);
        expect(await hamtaCrm(koppling), namn).toBeUndefined();
        expect(crmAnrop(), namn).toBe(0);
      }

      // Kontroll: samma id med källan redovisningen slås upp. Porten är stängd, så svaret är null.
      expect(await hamtaCrm({ kund_id: TESTKUND, kund_kalla: 'redovisning' })).toBeNull();
      expect(crmAnrop()).toBe(1);
    });
  });
});
