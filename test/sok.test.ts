import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// KRAV-20 (d): söket måste träffa både ord i titeln OCH ord som bara finns i en
// kommentar — annars tappar man halva historiken när man letar.
describe('KRAV-9/11/20d: search_issues över ärenden och kommentarer', () => {
  let app: Express;
  let nyckel: string;
  let medOrdetITiteln: string;
  let medOrdetIKommentaren: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });

    const a = await kor(app, nyckel, 'create_issue', {
      title: 'Kvartalsrapporten till styrelsen',
      description: 'Sammanställning inför mötet.',
      team_key: 'LOC',
    });
    medOrdetITiteln = a.body.result.identifier;

    const b = await kor(app, nyckel, 'create_issue', {
      title: 'Ett helt orelaterat ärende',
      description: 'Ingenting om ekonomi här.',
      team_key: 'LOC',
    });
    medOrdetIKommentaren = b.body.result.identifier;
    await kor(app, nyckel, 'add_comment', {
      identifier: medOrdetIKommentaren,
      body: 'Det visade sig höra ihop med kvartalsrapporten ändå.',
    });
  });

  it('hittar ord i titeln', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'styrelsen' });
    expect(svar.status).toBe(200);
    const traffar = svar.body.result as { identifier: string }[];
    expect(traffar.map((t) => t.identifier)).toContain(medOrdetITiteln);
  });

  it('hittar ord i beskrivningen', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'sammanställning' });
    const traffar = svar.body.result as { identifier: string }[];
    expect(traffar.map((t) => t.identifier)).toContain(medOrdetITiteln);
  });

  it('hittar ord som BARA finns i en kommentar', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'kvartalsrapporten' });
    const identifierare = (svar.body.result as { identifier: string }[]).map((t) => t.identifier);
    expect(identifierare).toContain(medOrdetITiteln);
    expect(identifierare).toContain(medOrdetIKommentaren);
  });

  it('rankar träffarna och markerar var träffen satt', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'kvartalsrapporten' });
    const traffar = svar.body.result as { rang: number; traff_i: string }[];
    expect(traffar.length).toBeGreaterThanOrEqual(2);
    for (const t of traffar) expect(t.rang).toBeGreaterThan(0);
    expect(traffar.map((t) => t.traff_i)).toContain('kommentar');
  });

  it('ord som inte finns ger noll träffar', async () => {
    const svar = await kor(app, nyckel, 'search_issues', { fraga: 'zebrafinkarna' });
    expect(svar.body.result).toEqual([]);
  });
});
