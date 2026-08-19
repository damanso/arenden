import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';

// Beslut #24 KRAV-2: rate-limiterns 429 nådde klienten som `okant_fel` eftersom
// express-rate-limits standardhandler svarar med bibliotekets egen textkropp.
// Svaret ska följa API:ts felkuvert — samma form som errorHandler ger.
//
// RATE_LIMIT_PER_MINUTE läses i config.ts vid import, så gränsen sänks här och
// modulgrafen laddas om. Filen kör isolerat (vitest isolerar per testfil), så
// resten av sviten påverkas inte av den sänkta gränsen.
describe('KRAV-2 (beslut #24): 429 följer API:ts felkuvert', () => {
  const GRANS = 2;
  let app: Express;

  beforeAll(async () => {
    process.env.RATE_LIMIT_PER_MINUTE = String(GRANS);
    vi.resetModules();
    // Poolen som denna modulgraf skapar stängs av setup.ts:s afterAll.
    const { createApp } = await import('../src/http/app.js');
    app = createApp();
  });

  afterAll(() => {
    process.env.RATE_LIMIT_PER_MINUTE = '100000';
  });

  it('över gränsen: 429 med felkod rate_limited och kvar satta rate-limit-headers', async () => {
    // Anropen under gränsen släpps igenom till autentiseringen (401 utan
    // nyckel) — de räknas, men rate-limitern stoppar dem inte.
    for (let i = 0; i < GRANS; i += 1) {
      const under = await request(app).post('/api/actions/list_issues').send({});
      expect(under.status).toBe(401);
      expect(under.body).toEqual({ error: 'unauthenticated' });
    }

    const over = await request(app).post('/api/actions/list_issues').send({});
    expect(over.status).toBe(429);
    // Exakt samma kuvert som errorHandler skickar: {"error": "<kod>"}.
    expect(over.body).toEqual({ error: 'rate_limited' });
    expect(over.headers['content-type']).toMatch(/application\/json/);

    // standardHeaders: true ska fortsätta gälla.
    expect(over.headers['retry-after']).toMatch(/^\d+$/);
    expect(over.headers['ratelimit-limit']).toBe(String(GRANS));
  });
});
