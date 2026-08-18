import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// KRAV-20 (b): agentkön. FOR UPDATE SKIP LOCKED måste ge två samtidiga
// claim_next_issue OLIKA ärenden — annars gör två agenter samma jobb.
describe('KRAV-12/20b: claim_next_issue med SKIP LOCKED', () => {
  let app: Express;
  let nyckelA: string;
  let nyckelB: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    nyckelA = await nyNyckel({ typ: 'agent', namn: 'agent-a' });
    nyckelB = await nyNyckel({ typ: 'agent', namn: 'agent-b' });
  });

  it('två samtidiga claim ger olika ärenden, och båda hamnar i started', async () => {
    for (const titel of ['Kö 1', 'Kö 2', 'Kö 3']) {
      await kor(app, nyckelA, 'create_issue', { title: titel, team_key: 'LOC' });
    }

    const [a, b] = await Promise.all([
      kor(app, nyckelA, 'claim_next_issue', {}),
      kor(app, nyckelB, 'claim_next_issue', {}),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.result).not.toBeNull();
    expect(b.body.result).not.toBeNull();
    expect(a.body.result.identifier).not.toBe(b.body.result.identifier);
    expect(a.body.result.state_typ).toBe('started');
    expect(b.body.result.state_typ).toBe('started');
    // Aktören kommer ur nyckeln — inte ur anropet (som var tomt).
    expect(a.body.result.claimad_av).toBe('agent-a');
    expect(b.body.result.claimad_av).toBe('agent-b');
  });

  it('tom kö returnerar null, inte fel', async () => {
    // Tömmer kön: allt som är kvar i backlog/unstarted claimas.
    for (let i = 0; i < 10; i += 1) {
      const svar = await kor(app, nyckelA, 'claim_next_issue', {});
      if (svar.body.result === null) break;
    }
    const tom = await kor(app, nyckelA, 'claim_next_issue', {});
    expect(tom.status).toBe(200);
    expect(tom.body.result).toBeNull();
  });
});
