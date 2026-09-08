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

  /**
   * Astras fynd 2: provet postade forut till en HARDKODAD adress med
   * hardkodade faltnamn. Byter titelfaltet namn — eller forsvinner det — kan
   * bade synlighetsprovet och POST-provet forbli grona samtidigt som David
   * inte langre kan ratta titeln i vyn. Adressen och faltnamnen lases darfor
   * ur det RENDERADE formularet. Attributen skrivs bade citerade
   * (action="...") och ociterade (name=titel), sa bada formerna matchas.
   */
  function rattningsformular(html: string): {
    action: string;
    falt: string[];
    dolda: Record<string, string>;
  } {
    const trafft = html.indexOf('/ratta"');
    expect(trafft, 'hittade inget rattningsformular pa sidan').toBeGreaterThan(-1);
    const start = html.lastIndexOf('<form', trafft);
    const slut = html.indexOf('</form>', trafft);
    expect(start, 'formularets start hittades inte').toBeGreaterThan(-1);
    expect(slut).toBeGreaterThan(start);
    const form = html.slice(start, slut);

    const action = /action="([^"]+)"/.exec(form)?.[1];
    expect(action, 'formularet saknar action').toBeTruthy();

    const falt: string[] = [];
    for (const m of form.matchAll(/name=(?:"([^"]+)"|([\w-]+))/g)) {
      falt.push((m[1] ?? m[2]) as string);
    }

    const dolda: Record<string, string> = {};
    for (const m of form.matchAll(/<input[^>]*type=hidden[^>]*>/g)) {
      const namn = /name=(?:"([^"]+)"|([\w-]+))/.exec(m[0]);
      const varde = /value="([^"]*)"/.exec(m[0]);
      if (namn) dolda[(namn[1] ?? namn[2]) as string] = varde?.[1] ?? '';
    }

    return { action: action as string, falt, dolda };
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

    // EXAKT en rad, inte "minst en". `find` slapp igenom tva likadana
    // handelser for samma andring, och kravet ar en handelse per FAKTISKT
    // andrat falt. Astras fynd 3.
    const rader = (await handelser(id)).filter((h) => h.verb === 'andrade_titel');
    expect(rader, 'fel antal andrade_titel-rader').toHaveLength(1);
    const rad = rader[0];
    expect(rad.payload['fran']).toBe('Lar mig mer om aktier');
    expect(rad.payload['till']).toBe('Lär mig mer om aktier');
    // Aktören härleds ur nyckeln, aldrig ur indatat.
    expect(rad.aktor_typ).toBe('manniska');
    expect(rad.aktor_namn).toBe('David');
    // Beskrivningen rordes inte — da far ingen beskrivningshandelse skrivas.
    expect(
      (await handelser(id)).filter((h) => h.verb === 'rattade_beskrivning'),
      'en beskrivningshandelse skrevs for en andring som bara gallde titeln',
    ).toHaveLength(0);
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

    // POSITIV KONTROLL först: utan den bevisar ett saknat fran/till ingenting -
    // det kunde lika gärna betyda att ingen händelse skrevs alls. EXAKT en
    // rad, av samma skal som i titelprovet ovan.
    const rader = (await handelser(id)).filter((h) => h.verb === 'rattade_beskrivning');
    expect(rader, 'fel antal rattade_beskrivning-rader').toHaveLength(1);
    const rad = rader[0];
    expect(rad.payload['gammal_text']).toBe('Första versionen.');
    expect(rad.payload['ny_text']).toBe(lang);
    expect(rad.payload).not.toHaveProperty('fran');
    expect(rad.payload).not.toHaveProperty('till');
    // Titeln rordes inte — da far ingen titelhandelse skrivas.
    expect(
      (await handelser(id)).filter((h) => h.verb === 'andrade_titel'),
      'en titelhandelse skrevs for en andring som bara gallde beskrivningen',
    ).toHaveLength(0);
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
    const rader = await handelser(id);
    expect(rader.some((h) => h.verb === 'arendet_oforandrat')).toBe(true);
    // Att 'arendet_oforandrat' finns utesluter inte att en falsk
    // faltandringshandelse OCKSA skrevs. Astras fynd 3, andra halvan.
    expect(
      rader.filter((h) => h.verb === 'andrade_titel'),
      'en titelhandelse skrevs trots att titeln var oforandrad',
    ).toHaveLength(0);
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

    // Adressen och faltnamnen kommer ur SIDAN, inte ur provet.
    const sida = await agent.get(`/vy/arende/${id}`);
    expect(sida.status).toBe(200);
    const form = rattningsformular(sida.text);
    expect(form.falt, 'titelfaltet saknas i det renderade formularet').toContain('titel');
    expect(form.falt, 'beskrivningsfaltet saknas i det renderade formularet').toContain(
      'beskrivning',
    );

    const kropp: Record<string, string> = { ...form.dolda };
    kropp['titel'] = 'Rätt stavning här';
    kropp['beskrivning'] = 'Ny text.';

    const svar = await agent.post(form.action).type('form').send(kropp);
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

  /**
   * Astras fynd 1. Provet ovan sade sig bevisa att beskrivningen halls utanfor
   * BYTESVERB. Det gjorde det inte: handelseDetalj() returnerar '' om
   * payloaden saknar `fran`/`till`, och beskrivningens payload bar
   * gammal_text/ny_text. Verbet kunde alltsa laggas i BYTESVERB utan att en
   * enda assertion foll — en negativ assertion utan mojlighet att bli rod.
   *
   * Det som FAKTISKT skyddar brodtexten ar payloadformen. Det har provet visar
   * varfor det raknas: renderaren skriver ut hela varden, hur langa de an ar,
   * for ett verb som ar i BYTESVERB och bar fran/till. Utan den har raden ar
   * frånvaron i provet ovan lika garna renderarens blyghet som ett skydd.
   */
  it('renderaren skriver ut HELA fran/till — darfor ar payloadformen skyddet', async () => {
    const langTitel = 'T'.repeat(300);
    const id = await nyttArende('Kort titel');
    const svar = await kor(app, manniskonyckel, 'update_issue', {
      identifier: id,
      title: langTitel,
    });
    expect(svar.status).toBe(200);

    const sida = await request(bas).get(`/vy/arende/${id}`);
    const start = sida.text.indexOf('<h2>Historik');
    expect(start, 'historikblocket hittades inte').toBeGreaterThan(-1);
    const historik = sida.text.slice(start);

    // 'andrade_titel' AR i BYTESVERB och bar fran/till: hela vardet skrivs ut,
    // 300 tecken och allt. Renderaren kapar alltsa ingenting av sig sjalv.
    expect(historik).toContain(`Kort titel → ${langTitel}`);
  });
});
