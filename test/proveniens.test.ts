import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

// KRAV-20 (c): proveniens-tvånget. Tre saker bevisas: ingen anonym skrivning,
// varje lyckad mutation lämnar en event-rad med RÄTT aktör, och events går inte
// att ändra eller radera i efterhand.
describe('KRAV-8/10/20c: proveniens och append-only', () => {
  let app: Express;
  let agentnyckel: string;
  let manniskonyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  it('skrivning utan nyckel ger 401 och skriver ingen rad', async () => {
    const fore = await raknaRader('issues');
    const svar = await request(app)
      .post('/api/actions/create_issue')
      .send({ title: 'Anonymt försök', team_key: 'LOC' });

    expect(svar.status).toBe(401);
    expect(svar.body.error).toBe('unauthenticated');
    expect(await raknaRader('issues')).toBe(fore);
    expect(await raknaRader('events')).toBe(0);
  });

  it('skrivning med ogiltig nyckel ger 401 och skriver ingen rad', async () => {
    const fore = await raknaRader('issues');
    const svar = await request(app)
      .post('/api/actions/create_issue')
      .set('Authorization', 'Bearer sa-har-ser-en-pahittad-nyckel-ut')
      .send({ title: 'Fejkat försök', team_key: 'LOC' });

    expect(svar.status).toBe(401);
    expect(await raknaRader('issues')).toBe(fore);
    expect(await raknaRader('events')).toBe(0);
  });

  it('inaktiverad nyckel ger 401', async () => {
    const nyckel = await nyNyckel({ typ: 'agent', namn: 'avstangd' });
    // K-1 gav app-rollen UPDATE (aktiv) på api_keys, så deaktivering går numera
    // via actionen revoke_api_key (test/rattelser.test.ts). Här görs den som
    // ägaren, eftersom det här provet handlar om NYCKELUPPSLAGET och inte om
    // vägen dit — en 401 ska bli 401 oavsett hur nyckeln stängdes av.
    const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await admin.connect();
    await admin.query("UPDATE api_keys SET aktiv = false WHERE aktor_namn = 'avstangd'");
    await admin.end();

    const svar = await kor(app, nyckel, 'create_issue', { title: 'Nej', team_key: 'LOC' });
    expect(svar.status).toBe(401);
  });

  it('varje lyckad mutation får en event-rad med aktören ur NYCKELN', async () => {
    const skapat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Proveniensspår',
      team_key: 'LOC',
    });
    expect(skapat.status).toBe(200);
    const identifier = skapat.body.result.identifier as string;

    const kommentar = await kor(app, manniskonyckel, 'add_comment', {
      identifier,
      body: 'En människa skrev detta.',
    });
    expect(kommentar.status).toBe(200);
    expect(kommentar.body.result.aktor_typ).toBe('manniska');
    expect(kommentar.body.result.aktor_namn).toBe('david');

    const status = await kor(app, agentnyckel, 'update_issue_state', {
      identifier,
      state_typ: 'completed',
    });
    expect(status.status).toBe(200);

    const hamtat = await kor(app, agentnyckel, 'get_issue', { identifier });
    const handelser = hamtat.body.result.handelser as {
      verb: string;
      aktor_typ: string;
      aktor_namn: string;
    }[];

    expect(handelser.map((h) => h.verb)).toEqual([
      'skapade_arende',
      'kommenterade',
      'andrade_status',
    ]);
    expect(handelser[0]).toMatchObject({ aktor_typ: 'agent', aktor_namn: 'hermes' });
    expect(handelser[1]).toMatchObject({ aktor_typ: 'manniska', aktor_namn: 'david' });
    expect(handelser[2]).toMatchObject({ aktor_typ: 'agent', aktor_namn: 'hermes' });
  });

  it('aktören kan inte sättas ur request-body (zod .strict())', async () => {
    const svar = await kor(app, agentnyckel, 'create_issue', {
      title: 'Försöker stämpla David',
      team_key: 'LOC',
      aktor_namn: 'david',
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('validation_error');
  });

  it('UPDATE och DELETE på events avvisas av databasen — för app-rollen', async () => {
    await kor(app, agentnyckel, 'create_issue', { title: 'Lämnar spår', team_key: 'LOC' });
    expect(await raknaRader('events')).toBeGreaterThan(0);

    await expect(pool.query("UPDATE events SET verb = 'omskrivet'")).rejects.toThrow();
    await expect(pool.query('DELETE FROM events')).rejects.toThrow();
    expect(await raknaRader('events')).toBeGreaterThan(0);
  });

  it('UPDATE, DELETE och TRUNCATE på events avvisas även för tabellägaren', async () => {
    await kor(app, agentnyckel, 'create_issue', { title: 'Lämnar spår igen', team_key: 'LOC' });

    const admin = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
    await admin.connect();
    try {
      await expect(admin.query("UPDATE events SET verb = 'omskrivet'")).rejects.toThrow(/append-only/);
      await expect(admin.query('DELETE FROM events')).rejects.toThrow(/append-only/);
      await expect(admin.query('TRUNCATE events')).rejects.toThrow(/append-only/);
    } finally {
      await admin.end();
    }
    expect(await raknaRader('events')).toBeGreaterThan(0);
  });

  it('okänd action ger 404 utan att röra databasen', async () => {
    const fore = await raknaRader('events');
    const svar = await kor(app, agentnyckel, 'radera_allt', {});
    expect(svar.status).toBe(404);
    expect(await raknaRader('events')).toBe(fore);
  });
});
