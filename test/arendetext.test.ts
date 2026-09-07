import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { glomAllaSessioner } from '../src/http/vy/session.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

interface HandelseRad {
  verb: string;
  aktor_typ: string;
  aktor_namn: string;
  payload: Record<string, unknown>;
}

/**
 * Beslut #145. Hålet: `update_issue` kunde skriva prioritet, deadline,
 * milstolpe, förälder och projekt — men INTE titeln. En felstavad rubrik gick
 * bara att bli av med genom att makulera ärendet och skapa ett nytt. Fyra
 * ärenden makulerades så den 2026-09-07 innan hålet syntes.
 *
 * Kommentarer har haft rättningsvägen sedan K-1. Det här provet håller samma
 * väg öppen för ärendets EGEN text — och håller isär de två payloadformerna,
 * som är hela skälet till att en 20 000 teckens beskrivning inte får renderas
 * som "A → B" på en digestrad.
 */
describe('#145: ärendets titel och beskrivning går att rätta', () => {
  let app: Express;
  let server: Server;
  let bas: string;
  let agentnyckel: string;
  let manniskonyckel: string;

  async function handelser(identifier: string): Promise<HandelseRad[]> {
    const svar = await kor(app, agentnyckel, 'get_issue', { identifier });
    return svar.body.result.handelser as HandelseRad[];
  }

  async function nyttArende(titel: string, beskrivning?: string): Promise<string> {
    const svar = await kor(app, agentnyckel, 'create_issue', {
      title: titel,
      team_key: 'LOC',
      ...(beskrivning === undefined ? {} : { description: beskrivning }),
    });
    expect(svar.status).toBe(200);
    return svar.body.result.identifier as string;
  }

  async function las(identifier: string): Promise<{ title: string; description: string }> {
    const svar = await kor(app, agentnyckel, 'get_issue', { identifier });
    return svar.body.result.arende as { title: string; description: string };
  }

  async function inloggad(nyckel: string): Promise<ReturnType<typeof request.agent>> {
    const agent = request.agent(bas);
    const svar = await agent.post('/vy/logga-in').type('form').send({ nyckel, fran: '/vy' });
    expect(svar.status).toBe(303);
    return agent;
  }

  beforeAll(async () => {
    app = createApp();
    glomAllaSessioner();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((klar) => server.once('listening', klar));
    bas = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'provagent' });
    manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'David' });
  });

  afterAll(async () => {
    // Poolen stangs av test/setup.ts (closePool). Gor vi det ocksa blir
    // filen rod i teardown trots att varje prov gatt igenom.
    await new Promise<void>((klar) => server.close(() => klar()));
  });

  // ---- API:t ---------------------------------------------------------------

  it('rättar en titel och skriver en händelserad med gammalt och nytt värde', async () => {
    const id = await nyttArende('Lar mig mer om aktier');

    const svar = await kor(app, manniskonyckel, 'update_issue', {
      identifier: id,
      title: 'Lär mig mer om aktier',
    });
    expect(svar.status).toBe(200);

    expect((await las(id)).title).toBe('Lär mig mer om aktier');

    const rad = (await handelser(id)).find((h) => h.verb === 'andrade_titel');
    expect(rad, 'ingen andrade_titel-rad skrevs').toBeDefined();
    expect(rad!.payload['fran']).toBe('Lar mig mer om aktier');
    expect(rad!.payload['till']).toBe('Lär mig mer om aktier');
    // Aktören härleds ur nyckeln, aldrig ur indatat.
    expect(rad!.aktor_typ).toBe('manniska');
    expect(rad!.aktor_namn).toBe('David');
  });

  it('rättar en beskrivning — och dess händelserad bär gammal_text, ALDRIG fran/till', async () => {
    const id = await nyttArende('Ärende med text', 'Första versionen.');
    const lang = 'x'.repeat(15_000);

    const svar = await kor(app, manniskonyckel, 'update_issue', {
      identifier: id,
      description: lang,
    });
    expect(svar.status).toBe(200);
    expect((await las(id)).description).toBe(lang);

    const rad = (await handelser(id)).find((h) => h.verb === 'rattade_beskrivning');
    // POSITIV KONTROLL först: utan den bevisar ett saknat fran/till ingenting -
    // det kunde lika gärna betyda att ingen händelse skrevs alls.
    expect(rad, 'ingen rattade_beskrivning-rad skrevs').toBeDefined();
    expect(rad!.payload['gammal_text']).toBe('Första versionen.');
    expect(rad!.payload['ny_text']).toBe(lang);
    expect(rad!.payload).not.toHaveProperty('fran');
    expect(rad!.payload).not.toHaveProperty('till');
  });

  it('tömmer beskrivningen med null, och lämnar titeln orörd', async () => {
    const id = await nyttArende('Titel som ska stå kvar', 'Text som ska bort.');
    await kor(app, manniskonyckel, 'update_issue', { identifier: id, description: null });
    const efter = await las(id);
    expect(efter.description).toBe('');
    expect(efter.title).toBe('Titel som ska stå kvar');
  });

  it('samma titel igen ändrar ingenting, men loggar försöket', async () => {
    const id = await nyttArende('Oförändrad');
    const svar = await kor(app, manniskonyckel, 'update_issue', {
      identifier: id,
      title: 'Oförändrad',
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.andringar).toHaveLength(0);
    expect((await handelser(id)).some((h) => h.verb === 'arendet_oforandrat')).toBe(true);
  });

  it('vägrar en tom titel — ett ärende utan rubrik finns inte', async () => {
    const id = await nyttArende('Har en rubrik');
    const svar = await kor(app, manniskonyckel, 'update_issue', { identifier: id, title: '' });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('validation_error');
    // Negativ kontroll: titeln står kvar orörd efter det avvisade anropet.
    expect((await las(id)).title).toBe('Har en rubrik');
  });

  it('bara_om_osatt skriver ALDRIG över en titel — återläsningen får inte rätta tillbaka', async () => {
    const id = await nyttArende('Rättad av en människa');
    const svar = await kor(app, agentnyckel, 'update_issue', {
      identifier: id,
      title: 'Rå titel ur arkivet',
      bara_om_osatt: true,
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.andringar).toHaveLength(0);
    expect((await las(id)).title).toBe('Rättad av en människa');
  });

  // ---- Vyn -----------------------------------------------------------------

  it('visar INTE rättningsformuläret i läsläge, men visar det för den inloggade', async () => {
    const id = await nyttArende('Synlighetsprovet');

    const utan = await request(bas).get(`/vy/arende/${id}`);
    expect(utan.status).toBe(200);
    // POSITIV KONTROLL: sidan renderades verkligen, så frånvaron nedan betyder
    // "formuläret saknas" och inte "sidan blev tom".
    expect(utan.text).toContain('Synlighetsprovet');
    expect(utan.text).not.toContain(`/vy/arende/${id}/ratta`);

    const agent = await inloggad(manniskonyckel);
    const med = await agent.get(`/vy/arende/${id}`);
    expect(med.text).toContain(`/vy/arende/${id}/ratta`);
    expect(med.text).toContain('Rätta titel eller beskrivning');
  });

  it('rättar från vyns formulär och kvitterar', async () => {
    const id = await nyttArende('Fel stavning har', 'Gammal text.');
    const agent = await inloggad(manniskonyckel);

    const svar = await agent
      .post(`/vy/arende/${id}/ratta`)
      .type('form')
      .send({ titel: 'Rätt stavning här', beskrivning: 'Ny text.' });
    expect(svar.status).toBe(303);
    expect(svar.headers['location']).toContain('notis=arendet_rattat');

    const efter = await las(id);
    expect(efter.title).toBe('Rätt stavning här');
    expect(efter.description).toBe('Ny text.');
  });

  it('kräver session för att rätta — läsning är fri, ändring är det inte', async () => {
    const id = await nyttArende('Skyddad');
    const svar = await request(bas)
      .post(`/vy/arende/${id}/ratta`)
      .type('form')
      .send({ titel: 'Kapad titel', beskrivning: '' });
    expect(svar.status).toBe(401);
    // Negativ kontroll: 401 räcker inte som bevis - titeln ska stå kvar.
    expect((await las(id)).title).toBe('Skyddad');
  });

  it('en tom beskrivning i formuläret tömmer texten i stället för att fälla', async () => {
    const id = await nyttArende('Töm mig', 'Text som ska bort.');
    const agent = await inloggad(manniskonyckel);
    const svar = await agent
      .post(`/vy/arende/${id}/ratta`)
      .type('form')
      .send({ titel: 'Töm mig', beskrivning: '' });
    expect(svar.status).toBe(303);
    expect((await las(id)).description).toBe('');
  });

  it('renderar titelbytet som A → B i historiken, men inte beskrivningen', async () => {
    const id = await nyttArende('Före', 'Kort text.');
    await kor(app, manniskonyckel, 'update_issue', {
      identifier: id,
      title: 'Efter',
      description: 'y'.repeat(9_000),
    });

    const sida = await request(bas).get(`/vy/arende/${id}`);
    expect(sida.status).toBe(200);

    // Assertionen MÅSTE gälla historikblocket, inte hela sidan: beskrivningen
    // ska ju synas under rubriken Beskrivning. Första skrivningen av det här
    // provet läste HELA sidan som proxy för historikraden och blev röd av att
    // systemet gjorde rätt. Exakt det fel provet finns för att fånga.
    const start = sida.text.indexOf('<h2>Historik');
    expect(start, 'historikblocket hittades inte').toBeGreaterThan(-1);
    const historik = sida.text.slice(start);

    expect(historik).toContain('Före → Efter');
    // POSITIV KONTROLL: raden finns. Utan den bevisar frånvaron nedan inget.
    expect(historik).toContain('rattade beskrivning');
    // Det som hålet handlar om: brödtexten får inte hamna på en historikrad.
    expect(historik).not.toContain('Kort text. → ');
    expect(historik).not.toContain('y'.repeat(200));
  });
});
