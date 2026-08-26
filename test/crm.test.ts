import { rm, writeFile } from 'node:fs/promises';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { withTransaction } from '../src/db/tx.js';
import { crmAnrop, nollstallCrmCache } from '../src/http/vy/crm.js';
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

async function kopplaKund(projekt: string, kundId: string | null): Promise<void> {
  await withTransaction(async (client) => {
    await sattKundkoppling(
      client,
      TENANT_ID,
      projekt,
      kundId === null ? { status: 'intern' } : { status: 'kopplad', kund_id: kundId },
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

describe('CRM-koppling KRAV-1..6', () => {
  let app: Express;
  /** Ärende i projekt NVR-001 — mappar till Nordic Vision Retail AB. */
  let mappat: string;
  /** Ärende i ett internt projekt och med neutral titel — mappar aldrig. */
  let omappat: string;

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
    const agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });

    const ett = await kor(app, agentnyckel, 'create_issue', {
      title: 'Leverans av butiksdata',
      description: 'Underlaget ska levereras före månadsskiftet.',
      team_key: 'LOC',
    });
    mappat = ett.body.result.identifier;
    await sattProjekt(mappat, 'NVR-001');
    await kopplaKund('NVR-001', TESTKUND);
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
    await kopplaKund('Hermes', null);
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
    expect(utan.text).not.toContain('CRM');
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

    const arende = await request(app).get(`/vy/arende/${omappat}`);
    expect(arende.status).toBe(200);
    expect(arende.text).toContain('Städa upp byggkedjan');
    expect(arende.text).not.toContain('CRM');

    for (const vag of ['/vy', '/vy/digest', '/vy/sok?q=Leverans', '/vy/dok/01-Projekt/plan.md']) {
      const svar = await request(app).get(vag);
      expect(svar.text, vag).not.toContain('CRM');
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
});
