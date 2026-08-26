import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import {
  aterlasLinear,
  kontrolleraPrioritetsskalan,
  plattformensPrioritet,
  type LinearArende,
} from '../src/import/aterlasLinear.js';
import { kor, nyNyckel, TENANT_ID } from './helpers.js';

const ARKIVFIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));
const LINEARFIXTUR = fileURLToPath(new URL('./fixtures/linear/linear-prov.json', import.meta.url));

interface Handelse {
  verb: string;
  aktor_typ: string;
  aktor_namn: string;
  payload: { falt?: string; fran?: unknown; till?: unknown };
}
interface Arendesvar {
  arende: {
    identifier: string;
    priority: number | null;
    due_date: string | null;
    milstolpe: string | null;
    foralder_identifier: string | null;
    antal_barn: number;
  };
  handelser: Handelse[];
  barn: { identifier: string }[];
  relationer: { typ: string; riktning: string; motpart_identifier: string }[];
  bilagor: { titel: string; url: string; undertitel: string | null }[];
}

async function hamta(app: Express, nyckel: string, identifier: string): Promise<Arendesvar> {
  const svar = await kor(app, nyckel, 'get_issue', { identifier });
  expect(svar.status).toBe(200);
  return svar.body.result as Arendesvar;
}

describe('K-2/K-3: fälten Linear-importen tappade läses tillbaka', () => {
  let app: Express;
  let nyckel: string;

  beforeAll(async () => {
    app = createApp();
    // Teamet, states, projekt och labels skapas av importen själv.
    await importeraArkiv(ARKIVFIXTURER);
    nyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  // ---- K-2: prioritetsskalan ----------------------------------------------

  describe('K-2: prioritetskartan', () => {
    it('Linears 0 är INGEN prioritet, 1–4 är plattformens 1–4', () => {
      expect(plattformensPrioritet(0)).toBeNull();
      expect(plattformensPrioritet(null)).toBeNull();
      expect(plattformensPrioritet(undefined)).toBeNull();
      expect(plattformensPrioritet(1)).toBe(1);
      expect(plattformensPrioritet(2)).toBe(2);
      expect(plattformensPrioritet(3)).toBe(3);
      expect(plattformensPrioritet(4)).toBe(4);
    });

    it('en etikett som inte hör ihop med sitt värde stoppar HELA körningen', () => {
      const riktig: LinearArende[] = [
        { identifier: 'LOC-1', priority: 1, priorityLabel: 'Urgent' },
        { identifier: 'LOC-2', priority: 0, priorityLabel: 'No priority' },
      ];
      expect(() => kontrolleraPrioritetsskalan(riktig)).not.toThrow();

      // Skalan skjuten ett steg: 2 märkt "Low". Skriver vi ändå blir 46 ärenden
      // "Hög" som skulle ha varit "Låg" — och det syns inte på något av dem.
      const forskjuten: LinearArende[] = [{ identifier: 'LOC-3', priority: 2, priorityLabel: 'Low' }];
      expect(() => kontrolleraPrioritetsskalan(forskjuten)).toThrow(/prioritetsskalan/);

      const okant: LinearArende[] = [{ identifier: 'LOC-4', priority: 9, priorityLabel: 'Urgent' }];
      expect(() => kontrolleraPrioritetsskalan(okant)).toThrow(/okänt prioritetsvärde/);
    });
  });

  // ---- K-2: update_issue ---------------------------------------------------

  describe('K-2: update_issue lämnar spår', () => {
    it('sätter prioritet och deadline och skriver EN händelserad per ändrat fält', async () => {
      const skapat = await kor(app, nyckel, 'create_issue', { title: 'Prio och due', team_key: 'LOC' });
      const identifier = skapat.body.result.identifier as string;

      const svar = await kor(app, nyckel, 'update_issue', { identifier, priority: 2, due: '2026-09-04' });
      expect(svar.status).toBe(200);
      expect(svar.body.result.arende).toMatchObject({ priority: 2, due_date: '2026-09-04' });

      const data = await hamta(app, nyckel, identifier);
      const nya = data.handelser.filter((h) => h.verb.startsWith('andrade_'));
      expect(nya.map((h) => h.verb).sort()).toEqual(['andrade_deadline', 'andrade_prioritet']);
      // Aktören kommer ur nyckeln, aldrig ur anropet (KRAV-10).
      for (const h of nya) expect(h).toMatchObject({ aktor_typ: 'agent', aktor_namn: 'hermes' });
      const prio = nya.find((h) => h.verb === 'andrade_prioritet')!;
      expect(prio.payload).toMatchObject({ falt: 'priority', fran: null, till: 2 });
    });

    it('skriver INGEN händelserad för ett fält som inte ändrades', async () => {
      const skapat = await kor(app, nyckel, 'create_issue', {
        title: 'Bara due ändras',
        team_key: 'LOC',
        priority: 3,
      });
      const identifier = skapat.body.result.identifier as string;

      // priority=3 är redan värdet — bara due är en ändring.
      const svar = await kor(app, nyckel, 'update_issue', { identifier, priority: 3, due: '2026-10-01' });
      expect((svar.body.result.andringar as { falt: string }[]).map((a) => a.falt)).toEqual(['due_date']);

      const data = await hamta(app, nyckel, identifier);
      expect(data.handelser.filter((h) => h.verb === 'andrade_prioritet')).toHaveLength(0);
      expect(data.handelser.filter((h) => h.verb === 'andrade_deadline')).toHaveLength(1);
    });

    it('bara_om_osatt rör ALDRIG ett fält som redan bär ett värde', async () => {
      const skapat = await kor(app, nyckel, 'create_issue', {
        title: 'Prioriterat efter cutovern',
        team_key: 'LOC',
        priority: 1,
      });
      const identifier = skapat.body.result.identifier as string;

      const skyddat = await kor(app, nyckel, 'update_issue', {
        identifier,
        priority: 4,
        bara_om_osatt: true,
      });
      expect(skyddat.status).toBe(200);
      expect(skyddat.body.result.andringar).toEqual([]);
      expect(skyddat.body.result.arende.priority).toBe(1);

      // No-op:en loggas ändå — annars hade proveniens-tvånget fällt ett korrekt svar.
      const data = await hamta(app, nyckel, identifier);
      expect(data.handelser.filter((h) => h.verb === 'arendet_oforandrat')).toHaveLength(1);

      // Utan spärren ÄR det en ändring — spärren är alltså spärren, inte ett fel.
      const utan = await kor(app, nyckel, 'update_issue', { identifier, priority: 4 });
      expect(utan.body.result.arende.priority).toBe(4);
    });

    it('avvisar ett anrop utan fält och en prioritet utanför 1–4', async () => {
      const skapat = await kor(app, nyckel, 'create_issue', { title: 'Validering', team_key: 'LOC' });
      const identifier = skapat.body.result.identifier as string;
      expect((await kor(app, nyckel, 'update_issue', { identifier })).status).toBe(400);
      expect((await kor(app, nyckel, 'update_issue', { identifier, priority: 0 })).status).toBe(400);
      expect((await kor(app, nyckel, 'update_issue', { identifier, priority: 5 })).status).toBe(400);
      expect((await kor(app, nyckel, 'update_issue', { identifier, due: '2026-02-30' })).status).toBe(400);
    });
  });

  // ---- K-3: hierarki, relationer, bilagor ---------------------------------

  describe('K-3: hierarki', () => {
    it('förälder och delärenden syns från båda hållen', async () => {
      const f = await kor(app, nyckel, 'create_issue', { title: 'Sändkö', team_key: 'LOC' });
      const b = await kor(app, nyckel, 'create_issue', { title: 'Ett utskick', team_key: 'LOC' });
      const foralder = f.body.result.identifier as string;
      const barn = b.body.result.identifier as string;

      const satt = await kor(app, nyckel, 'update_issue', { identifier: barn, parent: foralder });
      expect(satt.status).toBe(200);
      expect(satt.body.result.arende.foralder_identifier).toBe(foralder);

      const barndata = await hamta(app, nyckel, barn);
      expect(barndata.arende.foralder_identifier).toBe(foralder);
      expect(barndata.handelser.filter((h) => h.verb === 'andrade_foralder')).toHaveLength(1);

      const foralderdata = await hamta(app, nyckel, foralder);
      expect(foralderdata.barn.map((x) => x.identifier)).toEqual([barn]);
      expect(foralderdata.arende.antal_barn).toBe(1);
    });

    it('databasen vägrar en cirkulär kedja och ett ärende under sig självt', async () => {
      const a = (await kor(app, nyckel, 'create_issue', { title: 'Cykel A', team_key: 'LOC' })).body.result
        .identifier as string;
      const b = (await kor(app, nyckel, 'create_issue', { title: 'Cykel B', team_key: 'LOC' })).body.result
        .identifier as string;

      expect((await kor(app, nyckel, 'update_issue', { identifier: b, parent: a })).status).toBe(200);
      // b ligger under a — då kan a inte läggas under b.
      const cykel = await kor(app, nyckel, 'update_issue', { identifier: a, parent: b });
      expect(cykel.status).toBe(409);
      expect(cykel.body.error).toBe('rule_violation');

      // Självfallet är kedjans kortaste cykel och fångas av samma trigger
      // (BEFORE-triggrar körs före CHECK-villkoret issues_ingen_sjalvforalder,
      // som står kvar som deklarativ botten).
      const sjalv = await kor(app, nyckel, 'update_issue', { identifier: a, parent: a });
      expect(sjalv.status).toBe(409);

      // Ingen av de fällda skrivningarna får ha ändrat något.
      expect((await hamta(app, nyckel, a)).arende.foralder_identifier).toBeNull();
    });

    it('CHECK-villkoret mot självförälder finns kvar i katalogen', async () => {
      const { rows } = await pool.query<{ conname: string }>(
        `SELECT conname FROM pg_constraint
          WHERE conrelid = 'issues'::regclass AND conname = 'issues_ingen_sjalvforalder'`,
      );
      expect(rows).toHaveLength(1);
    });

    it('okänd förälder ger 404, inte en främmandenyckelkrasch', async () => {
      const a = (await kor(app, nyckel, 'create_issue', { title: 'Föräldralös', team_key: 'LOC' })).body
        .result.identifier as string;
      expect((await kor(app, nyckel, 'update_issue', { identifier: a, parent: 'LOC-99999' })).status).toBe(
        404,
      );
    });
  });

  describe('K-3: relationer', () => {
    it('EN rad lagras och båda riktningarna läses ut', async () => {
      const a = (await kor(app, nyckel, 'create_issue', { title: 'Blockerare', team_key: 'LOC' })).body.result
        .identifier as string;
      const b = (await kor(app, nyckel, 'create_issue', { title: 'Blockerad', team_key: 'LOC' })).body.result
        .identifier as string;

      const lank = await kor(app, nyckel, 'link_issues', { fran: a, till: b, typ: 'blocks' });
      expect(lank.status).toBe(200);
      expect(lank.body.result.nyskapad).toBe(true);

      const framat = (await hamta(app, nyckel, a)).relationer;
      expect(framat).toHaveLength(1);
      expect(framat[0]).toMatchObject({ typ: 'blocks', riktning: 'fran', motpart_identifier: b });
      const bakat = (await hamta(app, nyckel, b)).relationer;
      expect(bakat).toHaveLength(1);
      expect(bakat[0]).toMatchObject({ typ: 'blocks', riktning: 'till', motpart_identifier: a });

      // Loggen: den som länkade syns.
      const handelser = (await hamta(app, nyckel, a)).handelser;
      expect(handelser.filter((h) => h.verb === 'lankade_arenden')).toHaveLength(1);
    });

    it("'related' är symmetrisk — det spegelvända paret blir en no-op, inte en dubblett", async () => {
      const a = (await kor(app, nyckel, 'create_issue', { title: 'Symmetrisk A', team_key: 'LOC' })).body
        .result.identifier as string;
      const b = (await kor(app, nyckel, 'create_issue', { title: 'Symmetrisk B', team_key: 'LOC' })).body
        .result.identifier as string;

      expect((await kor(app, nyckel, 'link_issues', { fran: a, till: b, typ: 'related' })).body.result
        .nyskapad).toBe(true);
      const spegel = await kor(app, nyckel, 'link_issues', { fran: b, till: a, typ: 'related' });
      expect(spegel.status).toBe(200);
      expect(spegel.body.result.nyskapad).toBe(false);

      expect((await hamta(app, nyckel, a)).relationer).toHaveLength(1);
      expect((await hamta(app, nyckel, b)).relationer).toHaveLength(1);
    });

    it('ett ärende kan inte relatera till sig självt', async () => {
      const a = (await kor(app, nyckel, 'create_issue', { title: 'Ensam', team_key: 'LOC' })).body.result
        .identifier as string;
      const svar = await kor(app, nyckel, 'link_issues', { fran: a, till: a, typ: 'related' });
      expect(svar.status).toBe(400);
      expect(svar.body.error).toBe('relation_till_sig_sjalv');
    });
  });

  describe('K-3: bilagor', () => {
    it('läggs till en gång, är idempotent och bär sin proveniens', async () => {
      const a = (await kor(app, nyckel, 'create_issue', { title: 'Personkort', team_key: 'LOC' })).body.result
        .identifier as string;
      const bilaga = {
        identifier: a,
        titel: 'Mötesprep — definitionslager',
        url: 'https://docs.google.com/document/d/PROV/edit',
        source_ref: 'prov:bilaga:1',
      };

      expect((await kor(app, nyckel, 'add_attachment', bilaga)).body.result.nyskapad).toBe(true);
      const igen = await kor(app, nyckel, 'add_attachment', bilaga);
      expect(igen.status).toBe(200);
      expect(igen.body.result.nyskapad).toBe(false);

      const data = await hamta(app, nyckel, a);
      expect(data.bilagor).toHaveLength(1);
      expect(data.bilagor[0]).toMatchObject({ titel: bilaga.titel, url: bilaga.url });
      expect(data.handelser.filter((h) => h.verb === 'lade_till_bilaga')).toHaveLength(1);
    });

    it('vägrar ett schema som inte är http/https', async () => {
      const a = (await kor(app, nyckel, 'create_issue', { title: 'Farlig länk', team_key: 'LOC' })).body
        .result.identifier as string;
      for (const url of ['javascript:alert(1)', 'data:text/html,<script>1</script>', 'inte-en-url']) {
        const svar = await kor(app, nyckel, 'add_attachment', { identifier: a, titel: 'Nej', url });
        expect(svar.status, url).toBe(400);
      }
      expect((await hamta(app, nyckel, a)).bilagor).toHaveLength(0);
    });
  });

  // ---- Återläsningen i sin helhet -----------------------------------------

  describe('återläsningen av Linear-källan', () => {
    it('K-2: fas "falt" sätter prioritet och deadline, hoppar över Linears 0', async () => {
      const resultat = await aterlasLinear(LINEARFIXTUR, 'falt');
      expect(resultat.arenden_i_kallan).toBe(3);
      expect(resultat.arenden_i_plattformen).toBe(3);
      expect(resultat.saknade).toEqual([]);
      // LOC-88 → 2, LOC-329 → 1. LOC-316 bär Linears 0 = ingen prioritet.
      expect(resultat.prioritet_satta).toBe(2);
      expect(resultat.deadline_satta).toBe(1);

      expect((await hamta(app, nyckel, 'LOC-88')).arende).toMatchObject({
        priority: 2,
        due_date: '2026-07-20',
      });
      expect((await hamta(app, nyckel, 'LOC-329')).arende.priority).toBe(1);
      expect((await hamta(app, nyckel, 'LOC-316')).arende.priority).toBeNull();
    });

    it('K-3: fas "allt" lägger tillbaka hierarki, relationer, bilagor och milstolpe', async () => {
      const resultat = await aterlasLinear(LINEARFIXTUR, 'allt');
      expect(resultat.foralder_satta).toBe(1);
      expect(resultat.relationer_nya).toBe(2);
      expect(resultat.bilagor_nya).toBe(2);
      expect(resultat.milstolpe_satta).toBe(1);
      // Fälten var redan satta av föregående fas — de rördes inte igen.
      expect(resultat.prioritet_satta).toBe(0);
      expect(resultat.prioritet_redan_satta).toBe(2);

      const attiatta = await hamta(app, nyckel, 'LOC-88');
      expect(attiatta.arende.milstolpe).toBe('M1 · G2 på näsan');
      expect(attiatta.barn.map((b) => b.identifier)).toEqual(['LOC-316']);
      expect(attiatta.bilagor).toHaveLength(2);
      expect(attiatta.bilagor.map((b) => b.url)).toContain(
        'https://docs.google.com/document/d/PROV-ETT/edit',
      );

      const trettonsexton = await hamta(app, nyckel, 'LOC-316');
      expect(trettonsexton.arende.foralder_identifier).toBe('LOC-88');
      expect(trettonsexton.relationer).toContainEqual(
        expect.objectContaining({ typ: 'blocks', riktning: 'fran', motpart_identifier: 'LOC-329' }),
      );
    });

    it('varje rad återläsningen skrev bär aktören linear-aterlasning', async () => {
      const { rows } = await pool.query<{ aktor_typ: string; verb: string; n: string }>(
        `SELECT aktor_typ, verb, count(*)::text AS n
           FROM events WHERE tenant_id = $1 AND aktor_namn = 'linear-aterlasning'
          GROUP BY aktor_typ, verb ORDER BY verb`,
        [TENANT_ID],
      );
      expect(rows.length).toBeGreaterThan(0);
      for (const rad of rows) expect(rad.aktor_typ).toBe('system');
      const verb = Object.fromEntries(rows.map((r) => [r.verb, Number(r.n)]));
      expect(verb['andrade_prioritet']).toBe(2);
      expect(verb['andrade_deadline']).toBe(1);
      expect(verb['andrade_foralder']).toBe(1);
      expect(verb['andrade_milstolpe']).toBe(1);
      expect(verb['lankade_arenden']).toBe(2);
      expect(verb['lade_till_bilaga']).toBe(2);
    });

    it('en omkörning ändrar noll rader och skriver inga nya ändringshändelser', async () => {
      const rakna = async (sql: string): Promise<string> =>
        (await pool.query<{ n: string }>(sql)).rows[0]!.n;
      const HANDELSER =
        "SELECT count(*)::text AS n FROM events WHERE aktor_namn = 'linear-aterlasning'";
      const RELATIONER = 'SELECT count(*)::text AS n FROM issue_relations';
      const BILAGOR = 'SELECT count(*)::text AS n FROM issue_attachments';
      const fore = {
        handelser: await rakna(HANDELSER),
        relationer: await rakna(RELATIONER),
        bilagor: await rakna(BILAGOR),
      };
      const resultat = await aterlasLinear(LINEARFIXTUR, 'allt');

      expect(resultat.prioritet_satta).toBe(0);
      expect(resultat.deadline_satta).toBe(0);
      expect(resultat.foralder_satta).toBe(0);
      expect(resultat.milstolpe_satta).toBe(0);
      expect(resultat.relationer_nya).toBe(0);
      expect(resultat.relationer_fanns_redan).toBe(2);
      expect(resultat.bilagor_nya).toBe(0);
      expect(resultat.bilagor_fanns_redan).toBe(2);

      // Radantalen i sig: en omkörning får inte skapa en enda dubblett, och
      // inte heller en enda ny händelserad (inte ens en 'arendet_oforandrat' —
      // skriptet hoppar över det som redan står rätt i stället för att fråga).
      expect(await rakna(HANDELSER)).toBe(fore.handelser);
      expect(await rakna(RELATIONER)).toBe(fore.relationer);
      expect(await rakna(BILAGOR)).toBe(fore.bilagor);
    });
  });

  // ---- Vyn -----------------------------------------------------------------

  describe('läsvyn visar det återlästa', () => {
    it('ärendesidan visar bilagor, delärenden, relationer, milstolpe och prio', async () => {
      const svar = await request(app).get('/vy/arende/LOC-88');
      expect(svar.status).toBe(200);

      expect(svar.text).toContain('Bilagor (2)');
      expect(svar.text).toContain('https://docs.google.com/document/d/PROV-ETT/edit');
      expect(svar.text).toContain('Mötesprep Ellie');
      expect(svar.text).toContain('skickad 26/6');
      expect(svar.text).toContain('Delärenden (1)');
      expect(svar.text).toContain('LOC-316');
      expect(svar.text).toContain('Relationer (1)');
      expect(svar.text).toContain('relaterat till');
      expect(svar.text).toContain('M1 · G2 på näsan');
      expect(svar.text).toContain('Hög');
      expect(svar.text).toContain('senast 2026-07-20');
    });

    it('delärendet visar sin förälder som länk och sin blockering åt rätt håll', async () => {
      const svar = await request(app).get('/vy/arende/LOC-316');
      expect(svar.status).toBe(200);
      expect(svar.text).toContain('Del av <a href="/vy/arende/LOC-88">LOC-88</a>');
      expect(svar.text).toContain('blockerar');
      expect(svar.text).not.toContain('blockeras av');

      // Andra änden av SAMMA rad betyder motsatsen.
      const andra = await request(app).get('/vy/arende/LOC-329');
      expect(andra.text).toContain('blockeras av');
    });

    it('överblicken märker hierarkin på korten', async () => {
      const svar = await request(app).get('/vy');
      expect(svar.status).toBe(200);
      expect(svar.text).toContain('del av LOC-88');
      expect(svar.text).toContain('1 delärenden');
    });

    it('digesten skriver ut de nya verben på svenska, inte som råa nycklar', async () => {
      const svar = await request(app).get('/vy/digest?dagar=alla');
      expect(svar.status).toBe(200);
      expect(svar.text).toContain('ändrade prioritet');
      expect(svar.text).toContain('lade till en dokumentlänk');
      expect(svar.text).toContain('linear-aterlasning');
      expect(svar.text).not.toContain('andrade_prioritet');
    });

    it('en bilaga med farligt schema i databasen renderas som TEXT, inte som länk', async () => {
      // Andra försvarslinjen: raden går förbi HttpUrlSchema (den skrivs rakt in
      // i tabellen). Vyn får ändå inte bygga ett klickbart javascript:-href.
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM issues WHERE tenant_id = $1 AND source_ref = 'linear-arkiv:LOC-88'",
        [TENANT_ID],
      );
      await pool.query(
        'INSERT INTO issue_attachments (tenant_id, issue_id, titel, url) VALUES ($1, $2, $3, $4)',
        [TENANT_ID, rows[0]!.id, 'Ful bilaga', 'javascript:alert(1)'],
      );

      const svar = await request(app).get('/vy/arende/LOC-88');
      expect(svar.status).toBe(200);
      expect(svar.text).toContain('Ful bilaga');
      expect(svar.text).toContain('ingen giltig adress');
      expect(svar.text).not.toContain('href="javascript:');
    });
  });
});
