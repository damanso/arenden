import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// KRAV-20 (a): sekvensracet. Numret kommer ur teamets dedikerade sekvens med
// nextval i create-transaktionen — aldrig MAX+1. Två samtidiga create_issue
// måste därför få två OLIKA nummer.
describe('KRAV-5/20a: ärendenummer ur sekvens', () => {
  let app: Express;
  let nyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  it('två samtidiga create_issue ger två olika nummer', async () => {
    const [a, b] = await Promise.all([
      kor(app, nyckel, 'create_issue', { title: 'Samtidig A', team_key: 'LOC' }),
      kor(app, nyckel, 'create_issue', { title: 'Samtidig B', team_key: 'LOC' }),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const identA = a.body.result.identifier as string;
    const identB = b.body.result.identifier as string;
    expect(identA).not.toBe(identB);
    expect(identA).toMatch(/^LOC-\d+$/);
    expect(identB).toMatch(/^LOC-\d+$/);
  });

  it('tio samtidiga create_issue ger tio unika nummer', async () => {
    const svar = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        kor(app, nyckel, 'create_issue', { title: `Parallell ${i}`, team_key: 'LOC' }),
      ),
    );
    const nummer = svar.map((s) => s.body.result.identifier as string);
    expect(svar.every((s) => s.status === 200)).toBe(true);
    expect(new Set(nummer).size).toBe(10);
  });

  it('identifier är <key>-<nummer> och ärendet går att hämta med den', async () => {
    const skapat = await kor(app, nyckel, 'create_issue', { title: 'Hämtbart', team_key: 'LOC' });
    const identifier = skapat.body.result.identifier as string;

    const hamtat = await kor(app, nyckel, 'get_issue', { identifier });
    expect(hamtat.status).toBe(200);
    expect(hamtat.body.result.arende.title).toBe('Hämtbart');
    expect(hamtat.body.result.arende.identifier).toBe(identifier);
  });
});
