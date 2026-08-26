import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { parsaArkivfil, type ArkivArende } from '../src/import/parsaArkiv.js';
import { kor, nyNyckel } from './helpers.js';

const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));

// Etapp 2a KRAV-10 (a–f): läsvyn körs genom hela stacken mot testdatabasen med
// importfixturerna inlästa — samma väg David själv går i webbläsaren.
describe('Etapp 2a KRAV-1..10: Davids läsvy', () => {
  let app: Express;
  let agentnyckel: string;
  let manniskonyckel: string;
  let fixtur: ArkivArende;
  /** Ärende med BÅDE ett agentspår och ett människospår (KRAV-5). */
  let blandat: string;
  /** Ärende vars titel är ren HTML-injektion (KRAV-6). */
  let fult: string;

  const FUL_TITEL = `<script>alert("xss")</script> & 'citat'`;

  beforeAll(async () => {
    app = createApp();
    // Teamet, states, projekt och labels skapas av importen själv.
    await importeraArkiv(FIXTURER);
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'david' });
    fixtur = parsaArkivfil('LOC-316.md', await readFile(path.join(FIXTURER, 'LOC-316.md'), 'utf8'));

    const skapat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Ärende för proveniensmärkningen',
      description: 'Skapat av en agent.',
      team_key: 'LOC',
    });
    blandat = skapat.body.result.identifier;
    await kor(app, manniskonyckel, 'add_comment', {
      identifier: blandat,
      body: 'Den här kommentaren skrev en människa.',
    });

    const injektion = await kor(app, agentnyckel, 'create_issue', {
      title: FUL_TITEL,
      description: '<img src=x onerror="alert(1)">',
      team_key: 'LOC',
    });
    fult = injektion.body.result.identifier;
  });

  // ---- (a) överblicken -----------------------------------------------------

  it('KRAV-1/10a: GET /vy ger 200, rubriken "Ärenden" och känd importdata', async () => {
    const svar = await request(app).get('/vy');

    expect(svar.status).toBe(200);
    expect(svar.headers['content-type']).toMatch(/text\/html/);
    expect(svar.text).toContain('<h1>Ärenden</h1>');

    // Öppna ärenden ur fixturerna: LOC-316 (Backlog) och LOC-88 (In Progress).
    expect(svar.text).toContain('LOC-316');
    expect(svar.text).toContain('LOC-88');
    expect(svar.text).toContain(fixtur.titel);
    // LOC-329 är Done och hör inte hemma i överblicken över ÖPPNA ärenden.
    expect(svar.text).not.toContain('LOC-329');

    // Grupperingen per projekt/team med räknare.
    expect(svar.text).toContain('ILT-Education · LOC');
    expect(svar.text).toMatch(/öppna ärenden i \d+ grupper/);
    // Status, prio och due syns på korten.
    expect(svar.text).toContain('Backlog');
    expect(svar.text).toContain('ingen prio');
  });

  // ---- digesten ------------------------------------------------------------

  it('KRAV-2: GET /vy/digest grupperar händelser per dag och källa, med proveniens', async () => {
    const svar = await request(app).get('/vy/digest');

    expect(svar.status).toBe(200);
    expect(svar.text).toContain('<h1>Vad hände</h1>');
    // Importens händelser är system/linear-import, våra egna agent/hermes.
    expect(svar.text).toContain('importerade ärendet');
    expect(svar.text).toContain('linear-import');
    expect(svar.text).toContain('prov-system');
    expect(svar.text).toContain('prov-agent');
    expect(svar.text).toContain('<h3>System');
    // Länk till ärendet och länk att visa äldre.
    expect(svar.text).toContain('href="/vy/arende/LOC-316"');
    expect(svar.text).toContain('/vy/digest?dagar=alla');
  });

  // ---- (b) ärendesidan -----------------------------------------------------

  it('KRAV-4/10b: GET /vy/arende/LOC-316 ger 200 och matchar arkivfilen', async () => {
    const svar = await request(app).get('/vy/arende/LOC-316');

    expect(svar.status).toBe(200);
    expect(svar.text).toContain(fixtur.titel);
    expect(svar.text).toContain('Backlog');
    expect(svar.text).toContain('ILT-Education');
    expect(svar.text).toContain('Väntar-extern');
    expect(svar.text).toContain('<strong>Väntar på:</strong> Daniel');
    expect(svar.text).toContain('importerade ärendet');
  });

  it('KRAV-4: ärendesidan visar alla kommentarer och hela historiken', async () => {
    const svar = await request(app).get('/vy/arende/LOC-88');

    expect(svar.status).toBe(200);
    expect(svar.text).toContain('<h2>Kommentarer (2)</h2>');
    expect(svar.text).toContain('Send-redo klientdoc skickad till Ellie');
    expect(svar.text).toContain('david mancilla');
    expect(svar.text).toContain('<h2>Historik (1)</h2>');
  });

  // ---- (c) söket -----------------------------------------------------------

  it('KRAV-3/10c: GET /vy/sok hittar ord i ärendetexten', async () => {
    const svar = await request(app).get('/vy/sok?q=HubSpot');

    expect(svar.status).toBe(200);
    expect(svar.text).toContain('LOC-316');
    expect(svar.text).toContain('träff i ärendetexten');
  });

  it('KRAV-3/10c: söket hittar ord som BARA finns i en kommentar', async () => {
    const svar = await request(app).get('/vy/sok?q=klientdoc');

    expect(svar.status).toBe(200);
    expect(svar.text).toContain('LOC-88');
    expect(svar.text).toContain('träff i kommentar');
  });

  it('KRAV-3: utan q visas formulär och fasettlänkar, ingen träfflista', async () => {
    const svar = await request(app).get('/vy/sok');

    expect(svar.status).toBe(200);
    expect(svar.text).toContain('<form class=sok method=get action="/vy/sok">');
    expect(svar.text).toContain('href="/vy/sok?status=backlog"');
    expect(svar.text).toContain('href="/vy/sok?projekt=ILT-Education"');
    expect(svar.text).toContain('Skriv ett sökord eller välj en fasett');
    expect(svar.text).not.toContain('träffar.');
  });

  it('KRAV-3: fasetterna är rena länkparametrar och kan tas bort', async () => {
    const svar = await request(app).get('/vy/sok?q=HubSpot&projekt=ILT-Education');

    expect(svar.status).toBe(200);
    expect(svar.text).toContain('LOC-316');
    // Aktiv fasett visas och länken tillbaka saknar just den parametern.
    expect(svar.text).toContain('projekt: ILT-Education ×');
    expect(svar.text).toContain('href="/vy/sok?q=HubSpot"');

    // Samma sökord med ett projekt som inte har ärendet ger noll träffar.
    const tomt = await request(app).get('/vy/sok?q=HubSpot&status=completed');
    expect(tomt.text).toContain('Inga träffar.');
  });

  it('KRAV-3: aktör-fasetten filtrerar på AKTIVITET (händelser/kommentarer)', async () => {
    const david = await request(app).get('/vy/sok?aktor=david');
    expect(david.status).toBe(200);
    // david har bara kommenterat på ett ärende — inte de importerade.
    expect(david.text).toContain(blandat);
    expect(david.text).not.toContain('LOC-316');

    const hermes = await request(app).get('/vy/sok?aktor=hermes');
    expect(hermes.text).toContain(blandat);
  });

  // ---- (d) okänt ärende ----------------------------------------------------

  it('KRAV-4/10d: okänt ärende ger 404 som vanlig HTML-sida', async () => {
    const svar = await request(app).get('/vy/arende/LOC-99999');

    expect(svar.status).toBe(404);
    expect(svar.headers['content-type']).toMatch(/text\/html/);
    expect(svar.text).toContain('Hittades inte');
    expect(svar.text).toContain('finns inte');
  });

  it('KRAV-4: trasigt ärendenummer och okänd /vy-sökväg ger också HTML-404', async () => {
    const trasigt = await request(app).get('/vy/arende/inte-ett-nummer');
    expect(trasigt.status).toBe(404);
    expect(trasigt.headers['content-type']).toMatch(/text\/html/);

    const okand = await request(app).get('/vy/finns-inte');
    expect(okand.status).toBe(404);
    expect(okand.headers['content-type']).toMatch(/text\/html/);
  });

  // ---- (e) proveniens ------------------------------------------------------

  it('KRAV-5/10e: agent-rad bär agent-märkningen, människo-rad gör det inte', async () => {
    const svar = await request(app).get(`/vy/arende/${blandat}`);
    expect(svar.status).toBe(200);

    const rader = svar.text.split('<li class=rad>').slice(1);
    expect(rader.length).toBeGreaterThanOrEqual(3); // 1 kommentar + 2 händelser

    // INGEN rad är omärkt (KRAV-5).
    for (const rad of rader) expect(rad).toContain('class="prov ');

    const manniskorad = rader.find((r) => r.includes('Den här kommentaren skrev en människa.'));
    expect(manniskorad).toBeDefined();
    expect(manniskorad).toContain('prov-manniska');
    expect(manniskorad).toContain('människa · david');
    expect(manniskorad).not.toContain('prov-agent');

    const agentrad = rader.find((r) => r.includes('skapade ärendet'));
    expect(agentrad).toBeDefined();
    expect(agentrad).toContain('prov-agent');
    expect(agentrad).toContain('agent · hermes');
    // AI Act art. 50: AI-genererat är uttryckligen utmärkt.
    expect(agentrad).toContain('AI-genererat');
    expect(agentrad).not.toContain('prov-manniska');
  });

  // ---- (f) nyckelmodellen --------------------------------------------------

  it('KRAV-8/10f: /vy svarar utan nyckel medan skrivande /api utan nyckel ger 401', async () => {
    for (const vag of ['/vy', '/vy/digest', '/vy/sok?q=HubSpot', '/vy/arende/LOC-316']) {
      const svar = await request(app).get(vag);
      expect(svar.status, vag).toBe(200);
    }

    const skrivning = await request(app)
      .post('/api/actions/create_issue')
      .send({ title: 'Anonymt försök via vyn', team_key: 'LOC' });
    expect(skrivning.status).toBe(401);
    expect(skrivning.body.error).toBe('unauthenticated');

    // Läsande /api-anrop är fortsatt skyddat på exakt samma sätt.
    const lasning = await request(app).post('/api/actions/list_issues').send({});
    expect(lasning.status).toBe(401);
  });

  // ---- escaping ------------------------------------------------------------

  it('KRAV-6: all dynamisk text escapas — arkivdata blir aldrig injicerad HTML', async () => {
    const svar = await request(app).get(`/vy/arende/${fult}`);

    expect(svar.status).toBe(200);
    expect(svar.text).not.toContain('<script>alert');
    expect(svar.text).not.toContain('<img src=x');
    expect(svar.text).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(svar.text).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');

    // Samma sak i listorna, inte bara på ärendesidan.
    const oversikt = await request(app).get('/vy');
    expect(oversikt.text).not.toContain('<script>alert');
    const sok = await request(app).get('/vy/sok?q=citat');
    expect(sok.text).not.toContain('<script>alert');
  });

  // ---- läsytan skriver inget ----------------------------------------------

  it('KRAV: vyn är ren läsyta — inga event-rader skrivs av en genomläsning', async () => {
    const fore = await kor(app, agentnyckel, 'get_issue', { identifier: 'LOC-316' });
    const antalFore = (fore.body.result.handelser as unknown[]).length;

    for (const vag of ['/vy', '/vy/digest', '/vy/sok?q=HubSpot', '/vy/arende/LOC-316']) {
      await request(app).get(vag);
    }

    const efter = await kor(app, agentnyckel, 'get_issue', { identifier: 'LOC-316' });
    expect((efter.body.result.handelser as unknown[]).length).toBe(antalFore);
  });

  // K-1 (Davids beslut #64): Etapp 2a:s avgränsning "inga POST-rutter under
  // /vy" är medvetet upphävd. Det som ERSATTE den kontrolleras här och i
  // test/rattelser.test.ts: en okänd POST-sökväg finns fortfarande inte, och en
  // POST mot en RIKTIG skrivrutt utan session skriver ingenting.
  it('K-1: okänd POST-sökväg under /vy finns fortfarande inte', async () => {
    const svar = await request(app).post('/vy/arende/LOC-316').send({ title: 'nej' });
    expect(svar.status).toBe(404);
  });

  it('K-1: POST mot en riktig skrivrutt utan session avvisas', async () => {
    const svar = await request(app)
      .post('/vy/arende/LOC-316/kommentar')
      .type('form')
      .send({ body: 'Utan inloggning ska detta inte gå.' });

    expect(svar.status).toBe(401);
    const efter = await request(app).get('/vy/arende/LOC-316');
    expect(efter.text).not.toContain('Utan inloggning ska detta inte gå.');
  });
});
