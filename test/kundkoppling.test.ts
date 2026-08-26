import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { hamtaEllerSkapaProjekt } from '../src/services/arenden.js';
import { hamtaKundkoppling, sattKundkoppling } from '../src/services/kundkoppling.js';
import { kor, nyNyckel, seedaTeam, TENANT_ID } from './helpers.js';

// K-4: kopplingen projekt -> kund.
//
// Provet mäter REGELN — "kopplingen bärs av ett id, aldrig av ett namn" — och
// inte de enskilda fel som redan hittats. Sista testet är den negativa
// kontrollen: samma påstående ställs mot den trasiga (namnmatchande) versionen,
// och den ska falla. Ett prov som inte kan fälla något mäter ingenting.

/** Redovisningens customers.id för Nordic Vision Retail AB i produktion. */
const NVR_KUND = '475842f4-8072-4bd9-9394-478817ca5af9';
const ILT_KUND = '92babad9-0a3d-4d13-9616-393c9887cd56';

/**
 * Satter ett arendes projekt DIREKT. Medvetet inte via update_issue: det
 * faltet hor till en annan story, och ett prov som lutar sig mot en
 * grannfunktion matter tva saker och sager inte vilken som gick sonder.
 */
async function sattProjekt(identifier: string, projekt: string): Promise<void> {
  await withTransaction(async (client) => {
    const projektId = await hamtaEllerSkapaProjekt(client, TENANT_ID, projekt);
    const [teamKey, nummer] = identifier.split('-');
    await client.query(
      `UPDATE issues i SET project_id = $1
         FROM teams t
        WHERE t.id = i.team_id AND i.tenant_id = $2 AND t.key = $3 AND i.sequence_number = $4`,
      [projektId, TENANT_ID, teamKey, Number(nummer)],
    );
  });
}

describe('K-4 kundkoppling', () => {
  let app: Express;
  let agentnyckel: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    await withTransaction(async (client) => {
      for (const namn of ['NVR-001', 'ILT-Education', 'Hermes']) {
        await hamtaEllerSkapaProjekt(client, TENANT_ID, namn);
      }
    });
  });

  // ---- regeln ---------------------------------------------------------------

  it('startläget är oavgjord — inte "ingen kund"', async () => {
    const k = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'ILT-Education'));
    // Skillnaden är hela poängen: "vi vet inte än" är inte samma sak som
    // "hör inte till någon kund". Ett fält som betyder båda ljuger tyst.
    expect(k?.koppling_status).toBe('oavgjord');
    expect(k?.kund_id).toBeNull();
  });

  it('en koppling bärs av ett id och en källa', async () => {
    const svar = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'NVR-001',
      status: 'kopplad',
      kund_id: NVR_KUND,
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.andrad).toBe(true);

    const k = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'NVR-001'));
    expect(k?.kund_id).toBe(NVR_KUND);
    expect(k?.koppling_status).toBe('kopplad');
    // Ett id utan sitt system är inte ett id.
    expect(k?.kund_kalla).toBe('redovisning');
    expect(k?.kund_kopplad_at).not.toBeNull();
  });

  it('kopplad KRÄVER ett id, och intern FÖRBJUDER ett', async () => {
    const utan = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'ILT-Education',
      status: 'kopplad',
    });
    expect(utan.status).toBe(400);

    const bade = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'ILT-Education',
      status: 'intern',
      kund_id: ILT_KUND,
    });
    expect(bade.status).toBe(400);

    // Ingen av de avvisade anropen fick lämna något efter sig.
    const k = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'ILT-Education'));
    expect(k?.koppling_status).toBe('oavgjord');
    expect(k?.kund_id).toBeNull();
  });

  it('ett okänt projektnamn blir 404 — aldrig ett nytt projekt', async () => {
    const fore = await pool.query('SELECT count(*)::int AS n FROM projects');
    const svar = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'Projekt som inte finns',
      status: 'intern',
    });
    expect(svar.status).toBe(404);
    const efter = await pool.query('SELECT count(*)::int AS n FROM projects');
    expect(efter.rows[0].n).toBe(fore.rows[0].n);
  });

  it('databasen håller regeln även om någon går förbi koden', async () => {
    // Constraint-nivån, inte bara tjänstelagret: ett halvfyllt par ska vara
    // omöjligt att lägga in med rå SQL också.
    await expect(
      pool.query(
        `UPDATE projects SET koppling_status = 'kopplad', kund_id = NULL, kund_kalla = NULL
          WHERE tenant_id = $1 AND namn = 'Hermes'`,
        [TENANT_ID],
      ),
    ).rejects.toThrow(/projects_koppling_komplett_check/);

    await expect(
      pool.query(
        `UPDATE projects SET koppling_status = 'kopplad', kund_id = $2,
                             kund_kalla = 'redovisning', kund_kopplad_at = now()
          WHERE tenant_id = $1 AND namn = 'Hermes'`,
        [TENANT_ID, NVR_KUND],
      ),
    ).resolves.toBeTruthy();

    // Städa upp efter oss: Hermes ska vara internt när nästa test kör.
    await withTransaction((c) => sattKundkoppling(c, TENANT_ID, 'Hermes', { status: 'intern' }));
  });

  // ---- KRAV-10: aktören ur nyckeln, händelsen i samma transaktion ----------

  it('KRAV-10: kopplingen lämnar en händelserad med aktören ur NYCKELN', async () => {
    const davidsnyckel = await nyNyckel({ typ: 'manniska', namn: 'david' });
    await kor(app, davidsnyckel, 'set_project_customer', {
      projekt: 'ILT-Education',
      status: 'kopplad',
      kund_id: ILT_KUND,
    });

    const { rows } = await pool.query(
      `SELECT aktor_typ, aktor_namn, verb, payload FROM events
        WHERE verb = 'andrade_kundkoppling' ORDER BY id DESC LIMIT 1`,
    );
    expect(rows[0].aktor_typ).toBe('manniska');
    expect(rows[0].aktor_namn).toBe('david');
    expect(rows[0].payload.efter.kund_id).toBe(ILT_KUND);
    expect(rows[0].payload.fore.kund_id).toBeNull();
  });

  it('KRAV-10: aktören kan inte sättas ur indata', async () => {
    const svar = await kor(app, agentnyckel, 'set_project_customer', {
      projekt: 'ILT-Education',
      status: 'intern',
      aktor_namn: 'david',
    });
    // .strict() — okända fält avvisas, de ignoreras inte.
    expect(svar.status).toBe(400);
  });

  // ---- åt andra hållet: från kunden till ärendena ---------------------------

  it('K-4 baklänges: kundens id ger kundens ärenden', async () => {
    await withTransaction((c) =>
      sattKundkoppling(c, TENANT_ID, 'NVR-001', { status: 'kopplad', kund_id: NVR_KUND }),
    );
    const skapat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Leverans av butiksdata',
      team_key: 'LOC',
    });
    await sattProjekt(skapat.body.result.identifier, 'NVR-001');

    const traff = await kor(app, agentnyckel, 'list_issues', { kund_id: NVR_KUND });
    expect(traff.status).toBe(200);
    expect(traff.body.result.arenden.map((a: { identifier: string }) => a.identifier)).toContain(
      skapat.body.result.identifier,
    );

    // En annan kunds id ger inte det här ärendet.
    const bom = await kor(app, agentnyckel, 'list_issues', { kund_id: ILT_KUND });
    expect(bom.body.result.arenden.map((a: { identifier: string }) => a.identifier)).not.toContain(
      skapat.body.result.identifier,
    );
  });

  // ---- negativ kontroll ----------------------------------------------------

  it('NEGATIV KONTROLL: samma påstående fäller den namnmatchande versionen', async () => {
    // Påståendet som ska gälla: ett INTERNT projekt knyts aldrig till en
    // organisation. Hermes är internt.
    await withTransaction((c) => sattKundkoppling(c, TENANT_ID, 'Hermes', { status: 'intern' }));

    // (1) Den riktiga regeln — id:t avgör.
    const riktig = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'Hermes'));
    expect(riktig?.kund_id).toBeNull();

    // (2) Den TRASIGA versionen: exakt namnmatchning projekt -> organisation.
    // Mängden nedan är organisationsnamnen som de faktiskt ser ut i
    // redovisningen i dag — inklusive den arkiverade, tomma posten "Hermes".
    const ORGANISATIONER = new Set([
      'Hermes',
      'NVR-001',
      'ILT-Education',
      'Synologen AB',
      'IAMAI AB',
    ]);
    const namnmatchning = (projekt: string): string | null =>
      ORGANISATIONER.has(projekt) ? projekt : null;

    // Samma påstående, ställt mot den trasiga versionen: den FALLER. Hade
    // plattformen matchat på namn hade 33 Hermes-ärenden knutits till en
    // arkiverad post med noll interaktioner och noll personer.
    expect(namnmatchning('Hermes')).not.toBeNull();

    // Och provet är inte en tautologi: för ett projekt som VERKLIGEN har en
    // kund ger båda vägarna svar — skillnaden ligger just i fallgropen.
    const nvr = await withTransaction((c) => hamtaKundkoppling(c, TENANT_ID, 'NVR-001'));
    expect(nvr?.kund_id).toBe(NVR_KUND);
    expect(namnmatchning('NVR-001')).not.toBeNull();
  });
});
