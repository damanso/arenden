import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { parsaArkivfil } from '../src/import/parsaArkiv.js';
import { readFile } from 'node:fs/promises';
import { kor, nyNyckel, raknaRader } from './helpers.js';

const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));

// KRAV-20 (e): importen är idempotent. En omkörning får inte skapa en enda ny
// rad — annars dubbleras arkivet varje gång någon råkar köra skriptet igen.
describe('KRAV-14/15/16/20e: import av linear-arkivet', () => {
  let app: Express;
  let nyckel: string;

  beforeAll(async () => {
    // Teamet, states, projekt och labels skapas av importen själv — inget seedas.
    app = createApp();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  it('läser arkivet, hoppar över _las-mig.md och behåller LOC-numreringen', async () => {
    const resultat = await importeraArkiv(FIXTURER);

    expect(resultat.filer).toBe(3); // _las-mig.md räknas inte
    expect(resultat.nya_arenden).toBe(3);
    expect(resultat.oforandrade_arenden).toBe(0);
    expect(resultat.nya_kommentarer).toBe(3);
    expect(resultat.hogsta_nummer).toBe(329);

    const hamtat = await kor(app, nyckel, 'get_issue', { identifier: 'LOC-316' });
    expect(hamtat.status).toBe(200);

    // Stickprovet mot arkivfilen: titel, status, projekt och etikett ska matcha.
    const fil = parsaArkivfil('LOC-316.md', await readFile(path.join(FIXTURER, 'LOC-316.md'), 'utf8'));
    const arende = hamtat.body.result.arende;
    expect(arende.title).toBe(fil.titel);
    expect(arende.state_namn).toBe('Backlog');
    expect(arende.state_typ).toBe('backlog');
    expect(arende.projekt).toBe('ILT-Education');
    expect(arende.labels).toEqual(['Väntar-extern']);
    expect(arende.description).toContain('Väntar på:** Daniel');
    expect(arende.source_ref).toBe('linear-arkiv:LOC-316');
  });

  it('importerar kommentarerna med bevarad författare och ordning', async () => {
    const hamtat = await kor(app, nyckel, 'get_issue', { identifier: 'LOC-88' });
    const kommentarer = hamtat.body.result.kommentarer as {
      body: string;
      aktor_namn: string;
      source_ref: string;
    }[];

    expect(kommentarer).toHaveLength(2);
    expect(kommentarer[0]!.aktor_namn).toBe('david mancilla');
    expect(kommentarer[0]!.source_ref).toBe('linear-arkiv:LOC-88#1');
    expect(kommentarer[1]!.body).toContain('Send-redo klientdoc skickad till Ellie');
  });

  it('stämplar importens events som system/linear-import', async () => {
    const hamtat = await kor(app, nyckel, 'get_issue', { identifier: 'LOC-329' });
    const handelser = hamtat.body.result.handelser as { verb: string; aktor_typ: string; aktor_namn: string }[];
    expect(handelser).toHaveLength(1);
    expect(handelser[0]).toMatchObject({
      verb: 'importerade_arende',
      aktor_typ: 'system',
      aktor_namn: 'linear-import',
    });
  });

  it('mappar arkivets status till rätt workflow-state', async () => {
    const ipagang = await kor(app, nyckel, 'get_issue', { identifier: 'LOC-88' });
    expect(ipagang.body.result.arende.state_typ).toBe('started');

    const klart = await kor(app, nyckel, 'get_issue', { identifier: 'LOC-329' });
    expect(klart.body.result.arende.state_typ).toBe('completed');
    expect(klart.body.result.arende.labels).toEqual(['Admin', 'Hermes/Infra']);
  });

  it('en andra körning skapar NOLL nya rader och rapporterar 0 nya', async () => {
    const fore = {
      issues: await raknaRader('issues'),
      comments: await raknaRader('comments'),
      events: await raknaRader('events'),
      labels: await raknaRader('labels'),
      projects: await raknaRader('projects'),
      issue_labels: await raknaRader('issue_labels'),
    };

    const resultat = await importeraArkiv(FIXTURER);

    expect(resultat.nya_arenden).toBe(0);
    expect(resultat.oforandrade_arenden).toBe(3);
    expect(resultat.nya_kommentarer).toBe(0);
    expect(resultat.oforandrade_kommentarer).toBe(3);

    expect(await raknaRader('issues')).toBe(fore.issues);
    expect(await raknaRader('comments')).toBe(fore.comments);
    expect(await raknaRader('events')).toBe(fore.events);
    expect(await raknaRader('labels')).toBe(fore.labels);
    expect(await raknaRader('projects')).toBe(fore.projects);
    expect(await raknaRader('issue_labels')).toBe(fore.issue_labels);
  });

  it('nya ärenden fortsätter ovanför det högsta importerade numret', async () => {
    const skapat = await kor(app, nyckel, 'create_issue', {
      title: 'Första efter importen',
      team_key: 'LOC',
    });
    expect(skapat.status).toBe(200);
    expect(skapat.body.result.identifier).toBe('LOC-330');
  });
});
