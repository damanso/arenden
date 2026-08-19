import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// KRAV-11/13: hela actions-ytan genom HTTP-lagret — filter, paginering, states,
// och att transporten inte har någon egen logik (allt går via executeAction).
describe('KRAV-11/13: actions-API:t', () => {
  let app: Express;
  let nyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  it('GET /health svarar utan nyckel', async () => {
    const svar = await request(app).get('/health');
    expect(svar.status).toBe(200);
    expect(svar.body).toEqual({ status: 'ok' });
  });

  it('list_states ger teamets fem standardstatusar i ordning', async () => {
    const svar = await kor(app, nyckel, 'list_states', { team_key: 'LOC' });
    expect(svar.status).toBe(200);
    const states = svar.body.result as { namn: string; typ: string }[];
    expect(states.map((s) => s.namn)).toEqual(['Backlog', 'Todo', 'In Progress', 'Done', 'Canceled']);
    expect(states.map((s) => s.typ)).toEqual([
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ]);
  });

  it('create_issue tar labels, prioritet och due — och list_issues filtrerar på dem', async () => {
    await kor(app, nyckel, 'create_issue', {
      title: 'Med etikett och prio',
      description: 'Beskrivning.',
      team_key: 'LOC',
      labels: ['Admin'],
      priority: 2,
      due: '2026-09-04',
    });
    await kor(app, nyckel, 'create_issue', { title: 'Utan etikett', team_key: 'LOC' });

    const medLabel = await kor(app, nyckel, 'list_issues', { label: 'Admin' });
    expect(medLabel.status).toBe(200);
    const arenden = medLabel.body.result.arenden as { title: string; priority: number; due_date: string }[];
    expect(arenden).toHaveLength(1);
    expect(arenden[0]).toMatchObject({ title: 'Med etikett och prio', priority: 2, due_date: '2026-09-04' });

    const felTeam = await kor(app, nyckel, 'list_issues', { team_key: 'XYZ' });
    expect(felTeam.body.result.arenden).toEqual([]);
  });

  it('list_issues filtrerar på state-typ', async () => {
    const skapat = await kor(app, nyckel, 'create_issue', { title: 'Ska bli klar', team_key: 'LOC' });
    await kor(app, nyckel, 'update_issue_state', {
      identifier: skapat.body.result.identifier,
      state_typ: 'completed',
    });

    const klara = await kor(app, nyckel, 'list_issues', { state_typer: ['completed'] });
    const titlar = (klara.body.result.arenden as { title: string }[]).map((a) => a.title);
    expect(titlar).toEqual(['Ska bli klar']);
  });

  it('list_issues är cursor-paginerad utan dubbletter', async () => {
    for (let i = 0; i < 5; i += 1) {
      await kor(app, nyckel, 'create_issue', { title: `Sida ${i}`, team_key: 'LOC' });
    }

    const sedda: string[] = [];
    let cursor: string | undefined;
    for (let varv = 0; varv < 20; varv += 1) {
      const svar = await kor(app, nyckel, 'list_issues', {
        limit: 2,
        ...(cursor ? { cursor } : {}),
      });
      const sida = svar.body.result as {
        arenden: { identifier: string }[];
        pageInfo: { har_nasta: boolean; slut_cursor: string | null };
      };
      sedda.push(...sida.arenden.map((a) => a.identifier));
      if (!sida.pageInfo.har_nasta) break;
      cursor = sida.pageInfo.slut_cursor ?? undefined;
    }

    expect(sedda.length).toBeGreaterThanOrEqual(5);
    expect(new Set(sedda).size).toBe(sedda.length);
  });

  it('update_issue_state accepterar både state-typ och state-id', async () => {
    const states = await kor(app, nyckel, 'list_states', { team_key: 'LOC' });
    const todo = (states.body.result as { id: string; typ: string }[]).find((s) => s.typ === 'unstarted')!;

    const skapat = await kor(app, nyckel, 'create_issue', { title: 'Flyttas', team_key: 'LOC' });
    const identifier = skapat.body.result.identifier as string;

    const viaId = await kor(app, nyckel, 'update_issue_state', { identifier, state_id: todo.id });
    expect(viaId.body.result.state_typ).toBe('unstarted');

    const viaTyp = await kor(app, nyckel, 'update_issue_state', { identifier, state_typ: 'completed' });
    expect(viaTyp.body.result.state_typ).toBe('completed');

    const bada = await kor(app, nyckel, 'update_issue_state', {
      identifier,
      state_typ: 'completed',
      state_id: todo.id,
    });
    expect(bada.status).toBe(400);
  });

  it('sok_label ger id eller null', async () => {
    await kor(app, nyckel, 'create_issue', { title: 'Etikettbärare', team_key: 'LOC', labels: ['Privat'] });

    const finns = await kor(app, nyckel, 'sok_label', { namn: 'Privat' });
    expect(finns.body.result.id).toMatch(/^[0-9a-f-]{36}$/);

    const saknas = await kor(app, nyckel, 'sok_label', { namn: 'Finns-inte' });
    expect(saknas.body.result.id).toBeNull();
  });

  // Beslut #24 KRAV-1: spegeln (arenden_arkiv.py) hittar ärenden med nya
  // kommentarer via vattenmärket issues.uppdaterad. Rörde add_comment inte
  // ärendet måste spegeln läsa SAMTLIGA ärenden varje körning och slog i
  // rate-limiten.
  it('add_comment höjer ärendets uppdaterad (vattenmärket fångar kommentaren)', async () => {
    const skapat = await kor(app, nyckel, 'create_issue', { title: 'Vattenmärke', team_key: 'LOC' });
    const identifier = skapat.body.result.identifier as string;
    const fore = new Date(skapat.body.result.arende.uppdaterad as string);

    const kommenterat = await kor(app, nyckel, 'add_comment', { identifier, body: 'Ny kommentar.' });
    expect(kommenterat.status).toBe(200);

    const hamtat = await kor(app, nyckel, 'get_issue', { identifier });
    const efter = new Date(hamtat.body.result.arende.uppdaterad as string);
    expect(efter.getTime()).toBeGreaterThan(fore.getTime());
  });

  it('okänt ärende ger 404 och ogiltig identifier ger 400', async () => {
    expect((await kor(app, nyckel, 'get_issue', { identifier: 'LOC-99999' })).status).toBe(404);
    expect((await kor(app, nyckel, 'get_issue', { identifier: 'inte-en-identifier' })).status).toBe(400);
  });
});
