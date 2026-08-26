import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// K-2, skälet till att prioriteterna brådskade: claim_next_issue ordnar kön
// `ORDER BY priority ASC NULLS LAST, skapad ASC`. Med NULL på samtliga 312
// importerade ärenden kollapsar hela ordningen till ren åldersordning — och
// ingenting felar. Kön ser ut att fungera; den plockar bara fel ärende.
//
// Egen testfil (färsk databas per fil, test/setup.ts) så att kön innehåller
// ENBART ärendena nedan. Ett claim-test mot en delad databas hade mätt vad
// tidigare testfall råkat lämna kvar.
describe('K-2: prioriteten styr agentkön', () => {
  let app: Express;
  let nyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  async function skapa(titel: string): Promise<string> {
    const svar = await kor(app, nyckel, 'create_issue', { title: titel, team_key: 'LOC' });
    expect(svar.status).toBe(200);
    return svar.body.result.identifier as string;
  }

  async function claima(): Promise<string | null> {
    const svar = await kor(app, nyckel, 'claim_next_issue', {});
    expect(svar.status).toBe(200);
    return svar.body.result === null ? null : (svar.body.result.identifier as string);
  }

  it('utan prioritet är kön ren åldersordning — och plockar alltså äldst, inte viktigast', async () => {
    const aldst = await skapa('Äldst, oviktigt');
    await skapa('Nyare, oviktigt');
    const yngst = await skapa('Yngst, men det brådskar');

    // Kontrollprovet: så här beter sig kön i dag, med NULL överallt.
    expect(await claima()).toBe(aldst);
    expect(yngst).not.toBe(aldst);
  });

  it('med prioritet plockas det brådskande först, hur ungt det än är', async () => {
    const gammalt = await skapa('Gammalt och oprioriterat');
    const bradskande = await skapa('Yngst av alla, men brådskande');

    // update_issue är K-2:s väg in — samma väg återläsningen använder.
    const satt = await kor(app, nyckel, 'update_issue', {
      identifier: bradskande,
      priority: 1,
    });
    expect(satt.status).toBe(200);
    expect(satt.body.result.arende.priority).toBe(1);

    // Kön innehåller nu äldre, oprioriterade ärenden OCH det här. Utan
    // prioritetsledet hade det äldsta kommit först.
    expect(await claima()).toBe(bradskande);
    expect(gammalt).not.toBe(bradskande);

    // …och när det brådskande är taget faller kön tillbaka på åldern.
    const nasta = await claima();
    expect(nasta).not.toBe(bradskande);
  });

  it('lägre siffra går före högre — Linears skala, inte tvärtom', async () => {
    // Töm kön först: bara de tre nedan ska stå i den.
    for (let i = 0; i < 20; i += 1) {
      if ((await claima()) === null) break;
    }

    const lag = await skapa('Låg prioritet');
    const hog = await skapa('Hög prioritet');
    const bradskande = await skapa('Brådskande');
    await kor(app, nyckel, 'update_issue', { identifier: lag, priority: 4 });
    await kor(app, nyckel, 'update_issue', { identifier: hog, priority: 2 });
    await kor(app, nyckel, 'update_issue', { identifier: bradskande, priority: 1 });

    expect(await claima()).toBe(bradskande);
    expect(await claima()).toBe(hog);
    expect(await claima()).toBe(lag);
  });
});
