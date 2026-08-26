import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
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
import type { Aktor } from '../src/lib/aktor.js';
import { laggTillKommentar } from '../src/services/kommentarer.js';
import { glomAllaSessioner } from '../src/http/vy/session.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));

interface HandelseRad {
  verb: string;
  aktor_typ: string;
  aktor_namn: string;
  payload: Record<string, unknown>;
}

// K-1 (Davids beslut #64): läsvyns avgränsning bryts med avsikt. Det här är
// provet på att skrivvägen fick rätt egenskaper — och på att den INTE fick de
// egenskaper som hade gjort proveniensen värdelös.
describe('K-1: rättningsvägar, aktörsidentitet och skrivvägen i vyn', () => {
  let app: Express;
  let server: Server;
  /** Riktig lyssnande adress, så att Origin i CSRF-provet kan matcha Host exakt. */
  let bas: string;
  let agentnyckel: string;
  let manniskonyckel: string;

  async function adminKlient(): Promise<pg.Client> {
    const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await c.connect();
    return c;
  }

  /** Loggar in en supertest-agent med en riktig nyckel — samma väg David går. */
  async function inloggad(nyckel: string): Promise<ReturnType<typeof request.agent>> {
    const agent = request.agent(bas);
    const svar = await agent.post('/vy/logga-in').type('form').send({ nyckel, fran: '/vy' });
    expect(svar.status).toBe(303);
    return agent;
  }

  async function skapaArendeMedKommentar(
    titel: string,
    text: string,
    kommentarsnyckel?: string,
  ): Promise<{ identifier: string; kommentarId: string }> {
    const skapat = await kor(app, agentnyckel, 'create_issue', { title: titel, team_key: 'LOC' });
    const identifier = skapat.body.result.identifier as string;
    const kommentar = await kor(app, kommentarsnyckel ?? manniskonyckel, 'add_comment', {
      identifier,
      body: text,
    });
    return { identifier, kommentarId: kommentar.body.result.id as string };
  }

  /**
   * Skriver en kommentar EXAKT som importen gör: via tjänstelagret, utan att
   * någon händelserad skapas. Det är så LOC-255:s tre falska "personer" kom in
   * — sektionsrubriker som blev aktörsnamn — och därför har de spår ENBART i
   * comments, aldrig i events.
   */
  async function importeraKommentar(
    identifier: string,
    body: string,
    aktor: Aktor,
  ): Promise<string> {
    const hamtat = await kor(app, agentnyckel, 'get_issue', { identifier });
    const issueId = hamtat.body.result.arende.id as string;
    return withTransaction(
      async (client) => (await laggTillKommentar(client, TENANT_ID, issueId, body, aktor)).id,
    );
  }

  async function handelser(identifier: string): Promise<HandelseRad[]> {
    const svar = await kor(app, agentnyckel, 'get_issue', { identifier });
    return svar.body.result.handelser as HandelseRad[];
  }

  beforeAll(async () => {
    app = createApp();
    glomAllaSessioner();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((klar) => server.once('listening', klar));
    bas = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'david mancilla' });
  });

  afterAll(async () => {
    await new Promise<void>((klar) => server.close(() => klar()));
  });

  // ---- 1. Nyckelskriptet: rollen och spåret -------------------------------

  it('npm run nyckel: skapar som app-rollen, skriver en händelserad, läcker inget till stdout', async () => {
    const filvag = path.join(tmpdir(), `k1-nyckel-${Date.now()}.nyckel`);
    const fore = await raknaRader('events');

    const utfall = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'tsx'),
      [
        path.join(ROT, 'src', 'scripts', 'skapaNyckel.ts'),
        'manniska',
        'Test Person',
        '--fil',
        filvag,
      ],
      {
        cwd: ROT,
        env: {
          ...process.env,
          // Skriptet ansluter som app-rollen. Vi pekar den på TESTdatabasen och
          // stänger av .env-inläsningen (dotenv/config läser DOTENV_CONFIG_PATH):
          // en felriktad körning hade mintat en nyckel i produktionsdatabasen.
          DOTENV_CONFIG_PATH: path.join(tmpdir(), 'k1-finns-inte.env'),
        },
      },
    );

    // Nyckeln får ALDRIG stå i terminalutdata — den hamnar i skalhistorik,
    // loggar och agenttranskript.
    const nyckel = (await readFile(filvag, 'utf8')).trim();
    expect(nyckel).toMatch(/^[0-9a-f]{64}$/);
    expect(utfall.stdout).not.toContain(nyckel);
    expect(utfall.stderr).not.toContain(nyckel);
    expect(utfall.stdout).toContain(filvag);

    // Filen är läsbar bara av ägaren.
    const info = await stat(filvag);
    expect(info.mode & 0o077).toBe(0);

    // Nyckeln fungerar, och aktören är den som angavs.
    expect((await kor(app, nyckel, 'list_issues', {})).status).toBe(200);

    // Händelseraden: EN ny rad, aktör system/skapa-nyckel, identiteten i
    // payloaden — och varken nyckeln eller hashen någonstans i den.
    expect(await raknaRader('events')).toBe(fore + 1);
    const { rows } = await pool.query<HandelseRad>(
      `SELECT aktor_typ, aktor_namn, verb, payload FROM events
        WHERE verb = 'skapade_aktorsidentitet' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]).toMatchObject({
      aktor_typ: 'system',
      aktor_namn: 'skapa-nyckel',
      verb: 'skapade_aktorsidentitet',
    });
    expect(rows[0]!.payload).toMatchObject({
      ny_aktor_typ: 'manniska',
      ny_aktor_namn: 'Test Person',
    });
    const payloadtext = JSON.stringify(rows[0]!.payload);
    expect(payloadtext).not.toContain(nyckel);
    expect(payloadtext).not.toContain('hash');
  });

  // ---- 2. Rättningsvägarna -------------------------------------------------

  it('en kommentar går att rätta, och den gamla texten finns i händelseraden', async () => {
    const { identifier, kommentarId } = await skapaArendeMedKommentar(
      'Kommentar att rätta',
      'Fel siffra: 19 av 40.',
    );

    const svar = await kor(app, manniskonyckel, 'update_comment', {
      kommentar_id: kommentarId,
      body: 'Rättad siffra: 21 av 40.',
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.andrad).toBe(true);

    const rattelse = (await handelser(identifier)).find((x) => x.verb === 'rattade_kommentar');
    expect(rattelse).toBeDefined();
    expect(rattelse!.aktor_typ).toBe('manniska');
    expect(rattelse!.aktor_namn).toBe('david mancilla');
    expect(rattelse!.payload['gammal_text']).toBe('Fel siffra: 19 av 40.');
    expect(rattelse!.payload['ny_text']).toBe('Rättad siffra: 21 av 40.');

    const sida = await request(app).get(`/vy/arende/${identifier}`);
    expect(sida.text).toContain('Rättad siffra: 21 av 40.');
    expect(sida.text).not.toContain('Fel siffra: 19 av 40.');
  });

  it('proveniensen på en kommentar går ALDRIG att rätta — bara texten', async () => {
    const { kommentarId } = await skapaArendeMedKommentar('Proveniens', 'Skriven av en människa.');

    // Ingen action tar emot en aktör; zod .strict() avvisar fältet.
    const svar = await kor(app, agentnyckel, 'update_comment', {
      kommentar_id: kommentarId,
      body: 'Omskriven av en agent.',
      aktor_namn: 'david mancilla',
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('validation_error');

    const { rows } = await pool.query<{ aktor_typ: string; aktor_namn: string }>(
      'SELECT aktor_typ, aktor_namn FROM comments WHERE id = $1',
      [kommentarId],
    );
    expect(rows[0]).toMatchObject({ aktor_typ: 'manniska', aktor_namn: 'david mancilla' });
  });

  it('mjuk borttagning: borta ur vy, sök och aktörsfasett — kvar i historiken', async () => {
    // En kommentar med en aktör som bara finns här, skriven via importvägen —
    // formen som LOC-255:s tre sektionsrubriker fick när importens
    // kommentarsparser gjorde dem till "personer".
    const skapat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Falsk person',
      team_key: 'LOC',
    });
    const identifier = skapat.body.result.identifier as string;
    const kommentarId = await importeraKommentar(
      identifier,
      'Kommentar med hittepåförfattare: tigerbalsam.',
      { typ: 'manniska', namn: '5. Portfoljgrind' },
    );

    expect((await request(app).get('/vy/sok?q=tigerbalsam')).text).toContain(identifier);
    expect((await request(app).get('/vy/sok')).text).toContain('5. Portfoljgrind');

    const svar = await kor(app, manniskonyckel, 'delete_comment', { kommentar_id: kommentarId });
    expect(svar.status).toBe(200);
    expect(svar.body.result.andrad).toBe(true);

    // count(*) — inte n_live_tup: raden finns kvar, den är bara osynlig.
    const kvar = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM comments WHERE id = $1 AND borttagen IS NOT NULL',
      [kommentarId],
    );
    expect(Number(kvar.rows[0]!.n)).toBe(1);

    const sida = await request(app).get(`/vy/arende/${identifier}`);
    expect(sida.text).not.toContain('tigerbalsam');
    expect(sida.text).toContain('Borttagna kommentarer (1)');

    const hamtat = await kor(app, agentnyckel, 'get_issue', { identifier });
    expect((hamtat.body.result.kommentarer as unknown[]).length).toBe(0);

    expect((await request(app).get('/vy/sok?q=tigerbalsam')).text).toContain('Inga träffar.');
    // Aktören hade EN kommentar och inga händelser — nu är hon borta ur fasetten.
    expect((await request(app).get('/vy/sok')).text).not.toContain('5. Portfoljgrind');

    const borttagning = (await handelser(identifier)).find((x) => x.verb === 'tog_bort_kommentar');
    expect(borttagning).toBeDefined();
    expect(borttagning!.aktor_namn).toBe('david mancilla');
    expect(borttagning!.payload['gammal_text']).toContain('tigerbalsam');
    expect(borttagning!.payload['gammal_aktor_namn']).toBe('5. Portfoljgrind');
  });

  it('en borttagen kommentar går att återställa', async () => {
    const { identifier, kommentarId } = await skapaArendeMedKommentar(
      'Ångra',
      'Fel knapp: nyponsoppa.',
    );
    await kor(app, manniskonyckel, 'delete_comment', { kommentar_id: kommentarId });
    const svar = await kor(app, manniskonyckel, 'restore_comment', { kommentar_id: kommentarId });
    expect(svar.body.result.andrad).toBe(true);

    const sida = await request(app).get(`/vy/arende/${identifier}`);
    expect(sida.text).toContain('nyponsoppa');
    expect(sida.text).not.toContain('Borttagna kommentarer');
  });

  it('en etikett går att ta bort från ett ärende utan att etiketten försvinner', async () => {
    const skapat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Etikett att ta bort',
      team_key: 'LOC',
      labels: ['Vantar-extern', 'Behalls'],
    });
    const identifier = skapat.body.result.identifier as string;
    const annat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Annat ärende med samma etikett',
      team_key: 'LOC',
      labels: ['Vantar-extern'],
    });

    const svar = await kor(app, manniskonyckel, 'remove_label', {
      identifier,
      label: 'Vantar-extern',
    });
    expect(svar.body.result.andrad).toBe(true);

    const sida = await request(app).get(`/vy/arende/${identifier}`);
    expect(sida.text).toContain('Behalls');
    const annatSida = await request(app).get(`/vy/arende/${annat.body.result.identifier}`);
    expect(annatSida.text).toContain('Vantar-extern');

    const rad = (await handelser(identifier)).find((x) => x.verb === 'tog_bort_etikett');
    expect(rad).toBeDefined();
    expect(rad!.payload['etikett']).toBe('Vantar-extern');
    expect(rad!.aktor_namn).toBe('david mancilla');

    // Idempotent: en andra borttagning är inget fel, men loggas ändå.
    const igen = await kor(app, manniskonyckel, 'remove_label', {
      identifier,
      label: 'Vantar-extern',
    });
    expect(igen.body.result.andrad).toBe(false);
    expect((await handelser(identifier)).some((x) => x.verb === 'etiketten_fanns_inte')).toBe(true);
  });

  it('ett felstavat etikettnamn går att rätta, med gammalt namn i loggen', async () => {
    await kor(app, agentnyckel, 'create_issue', {
      title: 'Ärende med felstavad etikett',
      team_key: 'LOC',
      labels: ['Stavfeel'],
    });
    const svar = await kor(app, manniskonyckel, 'rename_label', {
      fran: 'Stavfeel',
      till: 'Stavfel',
    });
    expect(svar.body.result.andrad).toBe(true);

    const { rows } = await pool.query<HandelseRad>(
      `SELECT verb, aktor_typ, aktor_namn, payload FROM events
        WHERE verb = 'andrade_etikettnamn' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0]!.aktor_namn).toBe('david mancilla');
    expect(rows[0]!.payload['fran']).toBe('Stavfeel');
    expect(rows[0]!.payload['till']).toBe('Stavfel');

    const sok = await request(app).get('/vy/sok');
    expect(sok.text).toContain('Stavfel');
    expect(sok.text).not.toContain('Stavfeel');
  });

  it('ett projektnamn går att rätta, och ett upptaget namn avvisas begripligt', async () => {
    await pool.query(
      `INSERT INTO projects (tenant_id, namn) VALUES ($1, 'ILT-Educationn'), ($1, 'Hermes')
       ON CONFLICT DO NOTHING`,
      [TENANT_ID],
    );

    const svar = await kor(app, manniskonyckel, 'rename_project', {
      fran: 'ILT-Educationn',
      till: 'ILT-Education',
    });
    expect(svar.body.result.andrad).toBe(true);
    const sok = await request(app).get('/vy/sok');
    expect(sok.text).toContain('ILT-Education');
    expect(sok.text).not.toContain('ILT-Educationn');

    const krock = await kor(app, manniskonyckel, 'rename_project', {
      fran: 'Hermes',
      till: 'ILT-Education',
    });
    expect(krock.status).toBe(400);
    expect(krock.body.error).toBe('namnet_upptaget');
  });

  it('en nyckel går att återkalla — och slutar då fungera', async () => {
    const tillfallig = await nyNyckel({ typ: 'agent', namn: 'tillfallig-agent' });
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM api_keys WHERE aktor_namn = 'tillfallig-agent'",
    );
    const nyckelId = rows[0]!.id;

    expect((await kor(app, tillfallig, 'list_issues', {})).status).toBe(200);

    const svar = await kor(app, manniskonyckel, 'revoke_api_key', { nyckel_id: nyckelId });
    expect(svar.body.result.andrad).toBe(true);
    expect((await kor(app, tillfallig, 'list_issues', {})).status).toBe(401);

    const efter = await pool.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM api_keys WHERE id = $1 AND aktiv = false',
      [nyckelId],
    );
    expect(Number(efter.rows[0]!.n)).toBe(1);

    const logg = await pool.query<HandelseRad>(
      `SELECT aktor_typ, aktor_namn, verb, payload FROM events
        WHERE verb = 'aterkallade_nyckel' ORDER BY id DESC LIMIT 1`,
    );
    expect(logg.rows[0]!.aktor_namn).toBe('david mancilla');
    expect(logg.rows[0]!.payload['nyckelns_aktor_namn']).toBe('tillfallig-agent');
    expect(JSON.stringify(logg.rows[0]!.payload)).not.toContain('hash');
  });

  // ---- 3. Databasspärrarna (två OBEROENDE försvarslinjer) ------------------
  //
  // SQLSTATE, inte bara "kastar": 42501 är kolumn-GRANTen, P0001 är triggern.
  // Utan den skillnaden hade det ena provets grönhet kunnat bäras av det andra
  // skyddet — och en mutation som tog bort det ena hade mätt ingenting.

  it('app-rollen får 42501 på comments proveniens- och identitetskolumner (kolumn-GRANT)', async () => {
    const { kommentarId } = await skapaArendeMedKommentar('Spärr app', 'Orörd text.');
    await expect(
      pool.query("UPDATE comments SET aktor_namn = 'nagon annan' WHERE id = $1", [kommentarId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query("UPDATE comments SET aktor_typ = 'agent' WHERE id = $1", [kommentarId]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query('DELETE FROM comments WHERE id = $1', [kommentarId]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('ÄGARROLLEN får P0001 på samma kolumner (triggern, som GRANT inte gäller för)', async () => {
    const { kommentarId } = await skapaArendeMedKommentar('Spärr ägare', 'Orörd text.');
    const admin = await adminKlient();
    try {
      // Ett ANNAT namn än det som står där: triggern jämför med IS DISTINCT
      // FROM, så en skrivning av samma värde är ingen ändring och ska släppas
      // igenom. Ett prov som passerar på att ingenting hände mäter ingenting.
      await expect(
        admin.query("UPDATE comments SET aktor_namn = 'nagon annan' WHERE id = $1", [kommentarId]),
      ).rejects.toMatchObject({ code: 'P0001', message: expect.stringMatching(/oföränderlig/) });
      await expect(
        admin.query('UPDATE comments SET skapad = now() WHERE id = $1', [kommentarId]),
      ).rejects.toMatchObject({ code: 'P0001' });
      // Texten går däremot att skriva — det är hela poängen med rättelsen.
      await expect(
        admin.query("UPDATE comments SET body = 'rättad av ägaren' WHERE id = $1", [kommentarId]),
      ).resolves.toBeDefined();
    } finally {
      await admin.end();
    }
  });

  it('app-rollen får 42501 på api_keys utom kolumnen aktiv', async () => {
    const { rows } = await pool.query<{ id: string }>('SELECT id FROM api_keys LIMIT 1');
    const id = rows[0]!.id;
    await expect(
      pool.query("UPDATE api_keys SET aktor_namn = 'david mancilla' WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query("UPDATE api_keys SET nyckelhash = 'x' WHERE id = $1", [id]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('events är fortfarande orörd: ingen ny rättighet, ingen ny väg in', async () => {
    const { rows } = await pool.query<{ privilege_type: string }>(
      `SELECT privilege_type FROM information_schema.table_privileges
        WHERE table_name = 'events' AND grantee = 'app'`,
    );
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(['INSERT', 'SELECT']);
    await expect(pool.query("UPDATE events SET verb = 'omskrivet'")).rejects.toThrow();
    await expect(pool.query('DELETE FROM events')).rejects.toThrow();
  });

  // ---- 4. Skrivvägen i vyn -------------------------------------------------

  it('utan session skrivs ingenting — och sidan säger varför', async () => {
    const { identifier } = await skapaArendeMedKommentar('Utan session', 'Grundtext.');
    const fore = await raknaRader('comments');

    const svar = await request(bas)
      .post(`/vy/arende/${identifier}/kommentar`)
      .type('form')
      .send({ body: 'Skulle inte hamna här.' });

    expect(svar.status).toBe(401);
    expect(svar.text).toContain('Inloggning krävs');
    expect(await raknaRader('comments')).toBe(fore);

    // Läsning är oförändrat öppen (Etapp 2a KRAV-8).
    expect((await request(bas).get(`/vy/arende/${identifier}`)).status).toBe(200);
  });

  it('en inloggad människa kan kommentera från vyn, och raden bär HENNES namn', async () => {
    const { identifier } = await skapaArendeMedKommentar('Vyskrivning', 'Grundtext.');
    const agent = await inloggad(manniskonyckel);

    const svar = await agent
      .post(`/vy/arende/${identifier}/kommentar`)
      .type('form')
      .send({ body: 'Skrivet i webblasaren av David.' });
    expect(svar.status).toBe(303);
    expect(svar.headers['location']).toContain(`/vy/arende/${identifier}`);

    // Verifierat mot den RENDERADE sidan, inte mot statuskoden.
    const sida = await agent.get(`/vy/arende/${identifier}?notis=kommenterad`);
    expect(sida.text).toContain('Skrivet i webblasaren av David.');
    expect(sida.text).toContain('människa · david mancilla');
    expect(sida.text).toContain('Kommentaren är sparad.');
    // Formulären syns bara i skrivläge.
    expect(sida.text).toContain('Rätta eller ta bort');
    expect(sida.text).not.toContain('Läsläge.');

    const h = await handelser(identifier);
    expect(h[h.length - 1]).toMatchObject({
      verb: 'kommenterade',
      aktor_typ: 'manniska',
      aktor_namn: 'david mancilla',
    });
  });

  it('utan session visas inga formulär alls på ärendesidan', async () => {
    const { identifier } = await skapaArendeMedKommentar('Läsläge', 'Grundtext.');
    const sida = await request(bas).get(`/vy/arende/${identifier}`);
    expect(sida.text).toContain('Läsläge.');
    expect(sida.text).not.toContain('Rätta eller ta bort');
    expect(sida.text).not.toContain('<textarea');
  });

  it('aktören tas ur SESSIONENS nyckel — ett aktörsfält i formuläret ignoreras', async () => {
    const { identifier } = await skapaArendeMedKommentar('Stämpelförsök', 'Grundtext.');
    const agent = await inloggad(agentnyckel);

    await agent
      .post(`/vy/arende/${identifier}/kommentar`)
      .type('form')
      .send({ body: 'En agent skrev detta.', aktor_typ: 'manniska', aktor_namn: 'david mancilla' });

    const { rows } = await pool.query<{ aktor_typ: string; aktor_namn: string }>(
      "SELECT aktor_typ, aktor_namn FROM comments WHERE body = 'En agent skrev detta.'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ aktor_typ: 'agent', aktor_namn: 'hermes' });
  });

  it('CSRF: främmande Origin nekas med 403 och skriver ingenting', async () => {
    const { identifier } = await skapaArendeMedKommentar('CSRF-origin', 'Grundtext.');
    const agent = await inloggad(manniskonyckel);
    const fore = await raknaRader('comments');

    const svar = await agent
      .post(`/vy/arende/${identifier}/kommentar`)
      .set('Origin', 'https://elak.example')
      .type('form')
      .send({ body: 'Fran en frammande sajt.' });

    expect(svar.status).toBe(403);
    expect(await raknaRader('comments')).toBe(fore);

    // Vyns EGEN origin går igenom — kontrollen får inte fälla Davids formulär.
    const egen = await agent
      .post(`/vy/arende/${identifier}/kommentar`)
      .set('Origin', bas)
      .type('form')
      .send({ body: 'Fran vyns eget formular.' });
    expect(egen.status).toBe(303);
    expect((await agent.get(`/vy/arende/${identifier}`)).text).toContain('Fran vyns eget formular.');
  });

  it('CSRF: Sec-Fetch-Site som inte är same-origin nekas med 403', async () => {
    const { identifier } = await skapaArendeMedKommentar('CSRF-secfetch', 'Grundtext.');
    const agent = await inloggad(manniskonyckel);
    const fore = await raknaRader('comments');

    for (const varde of ['cross-site', 'same-site', 'none']) {
      const svar = await agent
        .post(`/vy/arende/${identifier}/kommentar`)
        .set('Sec-Fetch-Site', varde)
        .type('form')
        .send({ body: `Fran ${varde}.` });
      expect(svar.status, varde).toBe(403);
    }
    expect(await raknaRader('comments')).toBe(fore);

    const ok = await agent
      .post(`/vy/arende/${identifier}/kommentar`)
      .set('Sec-Fetch-Site', 'same-origin')
      .type('form')
      .send({ body: 'Fran vyns egen sida.' });
    expect(ok.status).toBe(303);
  });

  it('inloggningen släpper inte in en okänd nyckel, och ekar den aldrig', async () => {
    const agent = request.agent(bas);
    const svar = await agent
      .post('/vy/logga-in')
      .type('form')
      .send({ nyckel: 'sa-har-ser-en-pahittad-nyckel-ut', fran: '/vy' });

    expect(svar.status).toBe(303);
    expect(svar.headers['location']).toContain('/vy/logga-in?fel=1');
    expect(svar.headers['location']).not.toContain('pahittad');

    const sida = await agent.get('/vy/logga-in?fel=1');
    expect(sida.text).toContain('Nyckeln gick inte att känna igen');
    expect(sida.text).not.toContain('pahittad');
  });

  it('returadressen kan inte peka ut ur vyn (ingen öppen omdirigering)', async () => {
    const agent = request.agent(bas);
    const svar = await agent
      .post('/vy/logga-in')
      .type('form')
      .send({ nyckel: manniskonyckel, fran: 'https://elak.example/kapad' });

    expect(svar.status).toBe(303);
    expect(svar.headers['location']).toBe('/vy?notis=inloggad');
  });

  it('utloggning gör vyn läsbar men inte skrivbar igen', async () => {
    const { identifier } = await skapaArendeMedKommentar('Utloggning', 'Grundtext.');
    const agent = await inloggad(manniskonyckel);
    expect((await agent.get('/vy/logga-in')).text).toContain('Inloggad');

    expect((await agent.post('/vy/logga-ut').type('form').send({})).status).toBe(303);

    const efter = await agent
      .post(`/vy/arende/${identifier}/kommentar`)
      .type('form')
      .send({ body: 'Efter utloggning.' });
    expect(efter.status).toBe(401);
    expect((await agent.get(`/vy/arende/${identifier}`)).status).toBe(200);
  });

  it('vyn är JS-fri och CSP:n förbjuder skript', async () => {
    const agent = await inloggad(manniskonyckel);
    const { identifier } = await skapaArendeMedKommentar('CSP', 'Grundtext.');
    const sida = await agent.get(`/vy/arende/${identifier}`);

    expect(sida.headers['content-security-policy']).toContain("script-src 'none'");
    expect(sida.headers['content-security-policy']).toContain("form-action 'self'");
    // Referrer-Policy måste tillåta Origin på formulär-POST, annars nekar
    // CSRF-kontrollen vyns egna formulär (helmets default gör just det).
    expect(sida.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(sida.text).not.toContain('<script');
    expect(sida.text).not.toContain('onclick');
    expect(sida.text).toContain('<form');
  });

  it('sessionskakan är HttpOnly, SameSite=Strict och bunden till /vy', async () => {
    const agent = request.agent(bas);
    const svar = await agent
      .post('/vy/logga-in')
      .type('form')
      .send({ nyckel: manniskonyckel, fran: '/vy' });
    const kakor = svar.headers['set-cookie'] as unknown as string[];
    const kaka = kakor.find((k) => k.startsWith('arenden_vy='));
    expect(kaka).toBeDefined();
    expect(kaka).toContain('HttpOnly');
    expect(kaka).toContain('SameSite=Strict');
    expect(kaka).toContain('Path=/vy');
    // Kakan är ett slumpat bärarbevis, aldrig nyckeln själv.
    expect(kaka).not.toContain(manniskonyckel);
  });

  it('rättelsesidan visar identiteter men aldrig en nyckel eller hash', async () => {
    const agent = await inloggad(manniskonyckel);
    const sida = await agent.get('/vy/rattelser');
    expect(sida.status).toBe(200);
    expect(sida.text).toContain('Rättelser');
    expect(sida.text).toContain('människa · david mancilla');
    expect(sida.text).not.toContain(manniskonyckel);

    const { rows } = await pool.query<{ nyckelhash: string }>('SELECT nyckelhash FROM api_keys LIMIT 1');
    expect(sida.text).not.toContain(rows[0]!.nyckelhash);

    // Utloggad: samma sida läses, men utan knappar.
    const utan = await request(bas).get('/vy/rattelser');
    expect(utan.text).toContain('Läsläge');
    expect(utan.text).not.toContain('Återkalla');
  });

  // ---- 5. Läsytans gamla invariant står kvar för GET ----------------------

  it('GET skriver fortfarande aldrig en händelserad', async () => {
    const fore = await raknaRader('events');
    for (const vag of ['/vy', '/vy/digest', '/vy/sok?q=text', '/vy/rattelser', '/vy/logga-in']) {
      expect((await request(bas).get(vag)).status, vag).toBe(200);
    }
    expect(await raknaRader('events')).toBe(fore);
  });
});
