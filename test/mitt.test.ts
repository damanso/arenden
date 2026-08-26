import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { pool } from '../src/db/pool.js';
import { byggMittLage, type MittArende } from '../src/services/arenden.js';
import { kor, nyNyckel } from './helpers.js';

const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));

/**
 * K-9: ärendeplattformens egen ingång, "vad ligger på mig".
 *
 * Kravet är inte "en sida med mina ärenden" — plattformen har inget
 * ansvarigfält att bygga en sådan på. Kravet är en ingång som svarar ärligt på
 * frågan med det den faktiskt vet, och som säger vad den inte vet.
 */
describe('K-9: GET /vy/mitt', () => {
  let app: Express;
  let manniska: string;
  let agent: string;
  let bada: string;
  let bara_jag: string;

  beforeAll(async () => {
    app = createApp();
    await importeraArkiv(FIXTURER);
    manniska = await nyNyckel({ typ: 'manniska', namn: 'David Mancilla' });
    agent = await nyNyckel({ typ: 'agent', namn: 'hermes-skills' });

    // Ärende där MÄNNISKAN varit inne och AGENTEN skrev sist.
    const a = await kor(app, manniska, 'create_issue', { title: 'Väntar på svar', team_key: 'LOC' });
    bada = a.body.result.identifier;
    await kor(app, agent, 'add_comment', { identifier: bada, body: 'Agenten svarade sist.' });

    // Ärende där MÄNNISKAN skrev sist.
    const b = await kor(app, manniska, 'create_issue', { title: 'Jag skrev sist', team_key: 'LOC' });
    bara_jag = b.body.result.identifier;
  });

  it('KRAV: rutten finns, ger 200 och bär rubriken', async () => {
    const svar = await request(app).get('/vy/mitt');
    expect(svar.status).toBe(200);
    expect(svar.text).toContain('Vad ligger på mig');
  });

  it('sidan SÄGER att plattformen saknar ansvarigfält — den låtsas inte ha ett', async () => {
    const svar = await request(app).get('/vy/mitt?aktor=David%20Mancilla');
    expect(svar.text).toContain('Ingen rad nedan är en tilldelning');
    expect(svar.text).toContain('claimad_av');
  });

  it('"Någon annan skrev sist" innehåller ärendet där agenten svarade efter människan', async () => {
    const svar = await request(app).get('/vy/mitt?aktor=David%20Mancilla');
    const avsnitt = svar.text.split('Någon annan skrev sist')[1]!.split('<h2>')[0]!;
    expect(avsnitt).toContain(bada);
    expect(avsnitt).not.toContain(`>${bara_jag} —`);
  });

  it('"Du skrev sist" innehåller ärendet människan rörde senast', async () => {
    const svar = await request(app).get('/vy/mitt?aktor=David%20Mancilla');
    const avsnitt = svar.text.split('Du skrev sist')[1]!.split('<h2>')[0]!;
    expect(avsnitt).toContain(bara_jag);
    expect(avsnitt).not.toContain(`>${bada} —`);
  });

  it('sett från agenten byter ärendena hög — samma data, annan aktör', async () => {
    const svar = await request(app).get('/vy/mitt?aktor=hermes-skills');
    const skrevSist = svar.text.split('Du skrev sist')[1]!.split('<h2>')[0]!;
    expect(skrevSist).toContain(bada);
  });

  it('ingen vald aktör ⇒ sidan säger VARFÖR de personliga högarna är tomma', async () => {
    const svar = await request(app).get('/vy/mitt');
    expect(svar.text).toContain('Ingen aktör vald');
    expect(svar.text).toContain('inte för att ingenting ligger på dig');
  });
});

describe('K-9: högarnas regler mäter det de säger', () => {
  const grund: MittArende = {
    id: '00000000-0000-0000-0000-000000000001',
    identifier: 'LOC-1',
    team_key: 'LOC',
    title: 'grund',
    description: '',
    state_namn: 'Backlog',
    state_typ: 'backlog',
    projekt: null,
    labels: [],
    priority: null,
    due_date: null,
    milstolpe: null,
    claimad_av: null,
    source_ref: null,
    foralder_id: null,
    foralder_identifier: null,
    foralder_titel: null,
    antal_barn: 0,
    skapad: new Date('2026-08-01T00:00:00Z'),
    uppdaterad: new Date('2026-08-01T00:00:00Z'),
    sist_aktor_typ: null,
    sist_aktor_namn: null,
    sist_tidpunkt: null,
    jag_har_spar: false,
  };

  function hog(lage: ReturnType<typeof byggMittLage>, nyckel: string): MittArende[] {
    return lage.hogar.find((h) => h.nyckel === nyckel)!.arenden;
  }

  /**
   * NEGATIV KONTROLL för hela vyn: ett ärende vars enda spår är importens
   * systemrad får ALDRIG hamna i en personlig hög. Skulle systemrader räknas
   * som aktivitet blev "någon annan skrev sist" sant om 143 av 177 öppna
   * ärenden — och högen hade betytt "återläsningen kördes i natt".
   *
   * SQL:en filtrerar bort aktor_typ = 'system' redan i spar-CTE:n, så ett
   * systemrört ärende når byggMittLage med sist_aktor_namn = null. Raden nedan
   * är exakt det fallet.
   */
  it('NEGATIV KONTROLL: ett ärende med bara systemspår hamnar i "orört", aldrig i en personlig hög', () => {
    const lage = byggMittLage([grund], 'David Mancilla', [], '2026-08-26');
    expect(hog(lage, 'orort').map((a) => a.identifier)).toEqual(['LOC-1']);
    expect(hog(lage, 'vantar_pa_mig')).toEqual([]);
    expect(hog(lage, 'jag_rorde_sist')).toEqual([]);
    expect(hog(lage, 'plockat')).toEqual([]);
  });

  it('skiftläge viks ihop — "david mancilla" i proveniensen räknas som "David Mancilla"', () => {
    const rad: MittArende = {
      ...grund,
      sist_aktor_typ: 'manniska',
      sist_aktor_namn: 'david mancilla',
      sist_tidpunkt: new Date('2026-08-20T10:00:00Z'),
      jag_har_spar: true,
    };
    const lage = byggMittLage([rad], 'David Mancilla', [], '2026-08-26');
    // Skiftlägeskänslig jämförelse hade gett noll träffar och sett ut som ett
    // tomt läge. Det är exakt fällan i produktionen: nyckeln bär
    // "David Mancilla", de 183 kommentarerna bär "david mancilla".
    expect(hog(lage, 'jag_rorde_sist').map((a) => a.identifier)).toEqual(['LOC-1']);
    expect(hog(lage, 'vantar_pa_mig')).toEqual([]);
  });

  it('"någon annan skrev sist" kräver att JAG varit inne — inte bara att någon annan var det', () => {
    const utanMig: MittArende = {
      ...grund,
      sist_aktor_typ: 'agent',
      sist_aktor_namn: 'hermes',
      sist_tidpunkt: new Date('2026-08-20T10:00:00Z'),
      jag_har_spar: false,
    };
    const medMig: MittArende = { ...utanMig, identifier: 'LOC-2', jag_har_spar: true };
    const lage = byggMittLage([utanMig, medMig], 'David Mancilla', [], '2026-08-26');
    expect(hog(lage, 'vantar_pa_mig').map((a) => a.identifier)).toEqual(['LOC-2']);
  });

  it('deadlinehögen tar med passerade OCH de inom fönstret, aldrig senare', () => {
    const rader: MittArende[] = [
      { ...grund, identifier: 'LOC-passerad', due_date: '2026-08-20' },
      { ...grund, identifier: 'LOC-idag', due_date: '2026-08-26' },
      { ...grund, identifier: 'LOC-inom', due_date: '2026-09-02' },
      { ...grund, identifier: 'LOC-efter', due_date: '2026-09-03' },
      { ...grund, identifier: 'LOC-utan', due_date: null },
    ];
    const lage = byggMittLage(rader, null, [], '2026-08-26', 7);
    expect(hog(lage, 'forfaller').map((a) => a.identifier)).toEqual([
      'LOC-passerad',
      'LOC-idag',
      'LOC-inom',
    ]);
  });

  it('de opersonliga högarna är MÄRKTA som opersonliga', () => {
    const lage = byggMittLage([], 'David Mancilla', [], '2026-08-26');
    const personliga = lage.hogar.filter((h) => h.personlig).map((h) => h.nyckel);
    const opersonliga = lage.hogar.filter((h) => !h.personlig).map((h) => h.nyckel);
    expect(personliga).toEqual(['vantar_pa_mig', 'jag_rorde_sist', 'plockat']);
    expect(opersonliga).toEqual(['forfaller', 'orort']);
  });
});
