import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { createApp } from '../src/http/app.js';
import { pool } from '../src/db/pool.js';
import { withTransaction } from '../src/db/tx.js';
import { redovisaResultat } from '../src/services/atagande.js';
import { kor, nyNyckel, seedaTeam, TENANT_ID } from './helpers.js';

// Åtagandet (spec: Astra 2026-09-09). Ramen: ägaren ger riktning, användaren
// bär utgången till verkligheten, Hermes är bolaget och gör allt annat självt.
//
// Provet finns för att de fyra lögnerna i specen ska vara OMÖJLIGA, inte
// avrådda. Varje test nedan går rött om spärren tas bort — det är kravet på
// ett prov i det här huset.

const GRUND = [{ typ: 'beslut', id: '153', version: '1' }];
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND[0] };
const UTAT = { handling: 'Skicka svaret till Eva', slag: 'utathandling', grund: GRUND[0] };
const RIKTNING = { handling: 'Välj vilken leverans som går först', slag: 'riktning', grund: GRUND[0] };
const SEN = '2026-09-30T08:00:00Z';

async function nyttArende(app: Express, nyckel: string, titel: string): Promise<string> {
  const svar = await kor(app, nyckel, 'create_issue', { title: titel, team_key: 'LOC' });
  expect(svar.status).toBe(200);
  return svar.body.result.identifier as string;
}

describe('åtagandet: den beständiga länken', () => {
  let app: Express;
  let hermes: string;
  let david: string;

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  });

  // ---- 1. tillhör härleds, fylls aldrig i -------------------------------
  it('tillhor härleds ur nästa stegs slag — det finns inget fält att sätta', async () => {
    const fall: [Record<string, unknown>, string][] = [
      [INTERNT, 'hermes'],
      [RIKTNING, 'agare'],
      [UTAT, 'anvandare'],
    ];
    for (const [nasta, vantad] of fall) {
      const id = await nyttArende(app, hermes, `Härledning ${vantad}`);
      const svar = await kor(app, hermes, 'registrera_atagande', {
        identifier: id,
        grund: GRUND,
        nasta,
        foljs_upp: SEN,
      });
      expect(svar.status).toBe(200);
      expect(svar.body.result.atagande.tillhor).toBe(vantad);
    }

    // Motprovet: fältet går inte att skicka in. Strict-schemat avvisar det,
    // så "sätt tillhor=hermes" är ingen väg runt människospärren.
    const id = await nyttArende(app, hermes, 'Försök sätta tillhor');
    const nekad = await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: UTAT,
      foljs_upp: SEN,
      tillhor: 'hermes',
    });
    expect(nekad.status).toBe(400);
  });

  // ---- 2. övertaget kan inte påstås -------------------------------------
  it('utföraren tas ur nyckeln — en överlämning kan inte kvittera åt någon annan', async () => {
    const id = await nyttArende(app, hermes, 'Övertagande');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });

    // Försöket att ange en annan utförare avvisas av schemat.
    const pastatt = await kor(app, hermes, 'ta_over_atagande', {
      identifier: id,
      nasta: INTERNT,
      foljs_upp: SEN,
      utforare_namn: 'cto',
    });
    expect(pastatt.status).toBe(400);

    const svar = await kor(app, david, 'ta_over_atagande', {
      identifier: id,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    expect(svar.status).toBe(200);
    expect(svar.body.result.lage).toBe('overtaget');
    expect(svar.body.result.utforare_namn).toBe('david');
    expect(svar.body.result.utforare_typ).toBe('manniska');
    expect(svar.body.result.overtaget_nar).not.toBeNull();
  });

  // ---- 3. genomfört kräver ett resultat ---------------------------------
  it('genomfört utan belägg går inte att skriva', async () => {
    const id = await nyttArende(app, hermes, 'Resultat utan belägg');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    await kor(app, hermes, 'ta_over_atagande', { identifier: id, nasta: INTERNT, foljs_upp: SEN });

    const utan = await kor(app, hermes, 'redovisa_resultat', {
      identifier: id,
      sammanfattning: 'Det är gjort',
      belagg: [],
    });
    expect(utan.status).toBe(400);

    const med = await kor(app, hermes, 'redovisa_resultat', {
      identifier: id,
      sammanfattning: 'Det är gjort',
      belagg: [{ typ: 'prov', id: 'brieflankar', version: '2026-09-09' }],
    });
    expect(med.status).toBe(200);
    expect(med.body.result.lage).toBe('genomfort');
    expect(med.body.result.data.resultat.kontrollerat).toBeTruthy();
  });

  // ---- 4. ett hinder som blir gammalt är inget resultat ------------------
  it('hindrat kan inte bli genomfört — vägen tillbaka går via övertagande', async () => {
    const id = await nyttArende(app, hermes, 'Hinder');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    const hindrad = await kor(app, hermes, 'hindra_atagande', {
      identifier: id,
      orsak: 'DNS-ändringen är inte gjord',
      belagg: { typ: 'beslut', id: '145' },
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    expect(hindrad.status).toBe(200);
    expect(hindrad.body.result.lage).toBe('hindrat');

    const genvag = await kor(app, hermes, 'redovisa_resultat', {
      identifier: id,
      sammanfattning: 'Hindret är gammalt nu',
      belagg: [{ typ: 'prov', id: 'x' }],
    });
    expect(genvag.status).toBe(400);
    expect(genvag.body.error).toBe('otillaten_overgang');
  });

  // ---- 5. statusen kan inte sättas vid sidan av åtagandet ----------------
  it('update_issue_state kan inte stänga ett åtagande som inte är genomfört', async () => {
    const id = await nyttArende(app, hermes, 'Sidodörr till Done');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    const svar = await kor(app, hermes, 'update_issue_state', {
      identifier: id,
      state_typ: 'completed',
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('atagandet_styr_statusen');
  });

  // ---- 6. samma svar kan inte verkställas två gånger ---------------------
  it('en svarsversion kan bara behandlas en gång; ny text ger ny version', async () => {
    const forsta = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: 153,
      svar_hash: 'a1b2c3d4e5f60718',
    });
    expect(forsta.body.result.nyskapad).toBe(true);

    const andra = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: 153,
      svar_hash: 'a1b2c3d4e5f60718',
    });
    expect(andra.body.result.nyskapad).toBe(false);

    const komplettering = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: 153,
      svar_hash: 'ffffffffffffffff',
    });
    expect(komplettering.body.result.nyskapad).toBe(true);
  });

  // ---- 7. ett beslut har ett huvudåtagande ------------------------------
  it('beslutskopplingen är unik — en omkörning hittar samma åtagande', async () => {
    const ett = await nyttArende(app, hermes, 'Första');
    const tva = await nyttArende(app, hermes, 'Andra');

    const a = await kor(app, hermes, 'koppla_beslut', { beslut_id: 99, identifier: ett });
    expect(a.body.result.nyskapad).toBe(true);

    const b = await kor(app, hermes, 'koppla_beslut', { beslut_id: 99, identifier: tva });
    expect(b.body.result.nyskapad).toBe(false);
    expect(b.body.result.identifier).toBe(ett);
  });

  // ---- 8. utåthandlingen kan inte döpas om till internt ------------------
  it('att göra en utåthandling intern kräver ny grund', async () => {
    const id = await nyttArende(app, hermes, 'Utåthandling');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: UTAT,
      foljs_upp: SEN,
    });

    const utan = await kor(app, hermes, 'andra_atagande', { identifier: id, nasta: INTERNT });
    expect(utan.status).toBe(400);
    expect(utan.body.error).toBe('utathandling_kringgas');

    const med = await kor(app, hermes, 'andra_atagande', {
      identifier: id,
      nasta: INTERNT,
      grund: { typ: 'beslut', id: '160', version: '1' },
    });
    expect(med.status).toBe(200);
    expect(med.body.result.tillhor).toBe('hermes');
  });

  // ---- 9. en gammal revision får inte utföra ----------------------------
  it('ett anrop som utgår från en gammal revision avvisas', async () => {
    const id = await nyttArende(app, hermes, 'Revision');
    const skapad = await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    const gammal = skapad.body.result.atagande.revision as number;

    await kor(app, hermes, 'andra_atagande', { identifier: id, foljs_upp: SEN });

    const svar = await kor(app, hermes, 'ta_over_atagande', {
      identifier: id,
      nasta: INTERNT,
      foljs_upp: SEN,
      forvantad_revision: gammal,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('gammal_revision');
  });

  // ---- 10. villkoret överlever hela vägen -------------------------------
  it('ett villkor som inte är uppfyllt blockerar genomfört', async () => {
    const id = await nyttArende(app, hermes, 'Villkor');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
      villkor: [
        {
          text: 'Gör X endast om Y håller',
          kalla: { typ: 'beslut', id: '153' },
          galler: 'utfora',
          kontroll: 'kontrollera Y i redovisningen',
          utfall: 'okant',
        },
      ],
    });
    await kor(app, hermes, 'ta_over_atagande', { identifier: id, nasta: INTERNT, foljs_upp: SEN });

    const nekad = await kor(app, hermes, 'redovisa_resultat', {
      identifier: id,
      sammanfattning: 'Gjort',
      belagg: [{ typ: 'prov', id: 'y' }],
    });
    expect(nekad.status).toBe(400);
    expect(nekad.body.error).toBe('villkor_haller_inte');

    // Ett villkor som inte är okänt kräver belägg — även det är en spärr.
    const utanBelagg = await kor(app, hermes, 'andra_atagande', {
      identifier: id,
      villkor: [
        {
          text: 'Gör X endast om Y håller',
          kalla: { typ: 'beslut', id: '153' },
          galler: 'utfora',
          kontroll: 'kontrollera Y i redovisningen',
          utfall: 'uppfyllt',
        },
      ],
    });
    expect(utanBelagg.status).toBe(400);
  });

  // ---- 11. momentloggen mäter arbete, inte påståenden -------------------
  it('momentets aktör tas ur nyckeln, och historiska rader räknas inte', async () => {
    const id = await nyttArende(app, hermes, 'Moment');

    await kor(app, david, 'logga_moment', { moment: 'avgora_riktning', identifier: id });
    await kor(app, hermes, 'logga_moment', { moment: 'utfora', identifier: id });
    // Den historiska raden ligger MITT I mätfönstret. Det är avsiktligt: låg
    // den utanför skulle datumfiltret ensamt utesluta den, och provet hade
    // varit grönt även om historisk-filtret togs bort. (Motprovet 2026-09-09
    // visade precis det felet i en tidigare version av det här testet.)
    await kor(app, hermes, 'logga_moment', {
      moment: 'avgora_riktning',
      identifier: id,
      historisk: { aktor_typ: 'manniska', aktor_namn: 'david', tidpunkt: '2026-09-05T09:00:00Z' },
    });

    const { rows } = await pool.query<{ aktor_typ: string; aktor_namn: string; historisk: boolean }>(
      'SELECT aktor_typ, aktor_namn, historisk FROM arbetsmoment ORDER BY id',
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ aktor_typ: 'manniska', aktor_namn: 'david', historisk: false });
    expect(rows[1]).toMatchObject({ aktor_typ: 'agent', aktor_namn: 'hermes', historisk: false });
    expect(rows[2]!.historisk).toBe(true);

    const andel = await kor(app, hermes, 'arbetsandel', {
      fran: '2026-09-01T00:00:00Z',
      till: '2027-01-01T00:00:00Z',
    });
    // Två observerade moment, ett av dem mänskligt. Den historiska raden ligger
    // i augusti OCH är märkt historisk — den får inte räknas.
    expect(andel.body.result.moment_totalt).toBe(2);
    expect(andel.body.result.moment_manniska).toBe(1);
    expect(andel.body.result.andel_manniska).toBe(50);
  });

  it('ingen observation ger ingen siffra — noll vore ett påstående', async () => {
    const andel = await kor(app, hermes, 'arbetsandel', {
      fran: '2020-01-01T00:00:00Z',
      till: '2020-01-02T00:00:00Z',
    });
    expect(andel.body.result.moment_totalt).toBe(0);
    expect(andel.body.result.andel_manniska).toBeNull();
  });

  // ---- 12. ett åtagande utan uppföljning blir liggande ------------------
  it('ett oavslutat åtagande kräver uppföljningstid', async () => {
    const id = await nyttArende(app, hermes, 'Utan uppföljning');
    const svar = await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: null,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('uppfoljning_saknas');
  });

  // ---- 13. spärren i tjänstelagret, mätt för sig ------------------------
  //
  // "Genomfört utan belägg" hålls av TRE oberoende lager: zod-schemat i
  // registret, kontrollen i tjänsten och en CHECK i databasen. HTTP-provet
  // ovan mäter utfallet, och utfallet höll i motprovet 2026-09-09 även när
  // två av tre lager togs bort — bra för driften, men det betyder att provet
  // inte ensamt bevakar tjänstens spärr. Det här testet gör det: det kräver
  // den EXAKTA felkoden, så ett databasfel duger inte som grönt.
  it('tjänstens egen beläggsspärr svarar belagg_saknas — inte något annat fel', async () => {
    const id = await nyttArende(app, hermes, 'Tjänstelagrets spärr');
    await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: GRUND,
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    await kor(app, hermes, 'ta_over_atagande', { identifier: id, nasta: INTERNT, foljs_upp: SEN });

    const fel = await withTransaction(async (client) => {
      try {
        await redovisaResultat(client, TENANT_ID, {
          identifier: id,
          sammanfattning: 'Utan belägg',
          belagg: [],
        });
        return null;
      } catch (e) {
        return e as { code?: string; status?: number };
      }
    });
    expect(fel).not.toBeNull();
    expect(fel!.code).toBe('belagg_saknas');
    expect(fel!.status).toBe(400);
  });

  it('ett åtagande utan grund är en gissning och avvisas', async () => {
    const id = await nyttArende(app, hermes, 'Utan grund');
    const svar = await kor(app, hermes, 'registrera_atagande', {
      identifier: id,
      grund: [],
      nasta: INTERNT,
      foljs_upp: SEN,
    });
    expect(svar.status).toBe(400);
  });
});

// FR-3/FR-17, 0016: verklig åtgärd och migration, med negativa kontroller.
describe('svarsversion på löpnumret (FR-3, FR-17, 0016)', () => {
  let app: Express;
  let hermes: string;
  const anvandaBeslut = new Set<number>();
  const migrationsfil = new URL('../migrations/0016_svarsversion_lopnummer.sql', import.meta.url);
  const migrationsSql = () => readFileSync(migrationsfil, 'utf8');
  const hash = (text: string) => createHash('sha256').update(text.trim()).digest('hex').slice(0, 32);

  beforeAll(async () => {
    app = createApp();
    await seedaTeam();
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  });

  async function nyttBeslutId(): Promise<number> {
    for (;;) {
      const id = randomInt(1_000_000, 2_000_000_000);
      if (anvandaBeslut.has(id)) continue;
      const { rows } = await pool.query(
        'SELECT 1 FROM beslut_svarsversion WHERE tenant_id = $1 AND beslut_id = $2',
        [TENANT_ID, id],
      );
      if (rows.length) continue;
      anvandaBeslut.add(id);
      return id;
    }
  }

  async function rader(beslutId: number) {
    return (await pool.query(
      'SELECT * FROM beslut_svarsversion WHERE tenant_id = $1 AND beslut_id = $2 ORDER BY svar_hash, tillampad',
      [TENANT_ID, beslutId],
    )).rows;
  }

  async function katalog(client: pg.Client) {
    const columns = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default, is_identity, identity_generation
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'beslut_svarsversion'
      ORDER BY ordinal_position`);
    const constraints = await client.query(`
      SELECT conname, contype, pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE conrelid = 'public.beslut_svarsversion'::regclass ORDER BY conname`);
    const indexes = await client.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'beslut_svarsversion' ORDER BY indexname`);
    return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
  }

  it('schemat har nullbar integer-version, identitetsprimärnyckel och två partiella unika index', async () => {
    const columns = await pool.query(`
      SELECT column_name, data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'beslut_svarsversion'`);
    expect(columns.rows).toContainEqual({ column_name: 'version', data_type: 'integer', is_nullable: 'YES' });
    const primary = await pool.query(`
      SELECT a.attname, a.attidentity, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      WHERE c.conrelid = 'public.beslut_svarsversion'::regclass AND c.contype = 'p'`);
    expect(primary.rows).toEqual([{ attname: 'id', attidentity: 'a', definition: 'PRIMARY KEY (id)' }]);
    const indexes = await pool.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'beslut_svarsversion'`);
    const definitions = indexes.rows.map((r) => r.indexdef as string);
    expect(definitions.filter((d) => d.includes('UNIQUE') &&
      d.includes('(tenant_id, beslut_id, version) WHERE (version IS NOT NULL)'))).toHaveLength(1);
    expect(definitions.filter((d) => d.includes('UNIQUE') &&
      d.includes('(tenant_id, beslut_id, svar_hash) WHERE (version IS NULL)'))).toHaveLength(1);
  });

  it('app har exakt SELECT och INSERT; migrationen ändrar inga rättigheter', async () => {
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      const { rows } = await pool.query(
        "SELECT has_table_privilege('app', 'public.beslut_svarsversion', $1) AS tillaten", [privilege],
      );
      expect(rows[0].tillaten, privilege).toBe(['SELECT', 'INSERT'].includes(privilege));
    }
    expect(migrationsSql()).not.toMatch(/\b(?:GRANT|REVOKE)\b/i);
    // Åtgärderna går redan som app. Även ett direkt INSERT måste få identitet
    // utan uttryckligt id eller sekvensrättighet (allt rullas tillbaka).
    const client = new pg.Client({ connectionString: config.DATABASE_ADMIN_URL });
    await client.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app');
      const { rows } = await client.query(`
        INSERT INTO beslut_svarsversion (tenant_id, beslut_id, svar_hash)
        VALUES ($1, $2, $3) RETURNING id, version`, [TENANT_ID, await nyttBeslutId(), hash('rollprov')]);
      expect(rows[0].id).toBeTruthy();
      expect(rows[0].version).toBeNull();
    } finally {
      await client.query('ROLLBACK');
      await client.end();
    }
  });

  async function provaMigration(sql: string): Promise<string[]> {
    const avvikelser: string[] = [];
    const schema = `svarsversion_${randomUUID().replaceAll('-', '')}`;
    const client = new pg.Client({ connectionString: config.DATABASE_ADMIN_URL });
    await client.connect();
    const searchPath = (await client.query('SHOW search_path')).rows[0].search_path as string;
    try {
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`CREATE TABLE "${schema}".beslut_svarsversion
        (LIKE public.beslut_svarsversion INCLUDING DEFAULTS)`);
      await client.query(`ALTER TABLE "${schema}".beslut_svarsversion
        DROP COLUMN IF EXISTS id, DROP COLUMN IF EXISTS version,
        ADD CONSTRAINT beslut_svarsversion_unik PRIMARY KEY (tenant_id, beslut_id, svar_hash)`);
      const issueId = randomUUID();
      await client.query(`INSERT INTO "${schema}".beslut_svarsversion
        (tenant_id, beslut_id, svar_hash, issue_id, tillampad) VALUES
        ($1, 41, $2, $4, '2026-01-01T01:02:03Z'),
        ($1, 41, $3, $4, '2026-02-01T01:02:03Z'),
        ($1, 42, $2, $4, '2026-03-01T01:02:03Z')`, [TENANT_ID, hash('A'), hash('B'), issueId]);
      const fields = 'tenant_id, beslut_id, svar_hash, issue_id, tillampad';
      const before = (await client.query(`SELECT ${fields} FROM "${schema}".beslut_svarsversion
        ORDER BY beslut_id, svar_hash`)).rows;
      await client.query("SELECT set_config('search_path', $1, false)", [`"${schema}", public`]);
      const target = await client.query(`SELECT to_regclass('beslut_svarsversion')::oid =
        to_regclass($1)::oid AS ratt_tabell`, [`${schema}.beslut_svarsversion`]);
      if (target.rows[0].ratt_tabell !== true) throw new Error('search_path pekar på fel tabell');
      await client.query(sql); // Oförändrad filtext, endast mot engångsschemat.
      const after = (await client.query(`SELECT ${fields}, id, version FROM "${schema}".beslut_svarsversion
        ORDER BY beslut_id, svar_hash`)).rows;
      if (after.length !== before.length) avvikelser.push('antalet befintliga rader ändrades');
      const preserved = after.map(({ id, version, ...row }) => row);
      if (JSON.stringify(preserved) !== JSON.stringify(before)) avvikelser.push('befintliga fält ändrades');
      if (after.some((r) => r.version !== null)) avvikelser.push('historiken fick version');
      if (after.some((r) => r.id == null) || new Set(after.map((r) => r.id)).size !== after.length) {
        avvikelser.push('identitetsvärden saknas eller är inte unika');
      }
    } catch (error) {
      avvikelser.push(error instanceof Error ? error.message : String(error));
    } finally {
      try {
        await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        try {
          await client.query("SELECT set_config('search_path', $1, false)", [searchPath]);
        } finally {
          await client.end();
        }
      }
    }
    return avvikelser;
  }

  it('riktiga migrationen bevarar befintliga rader som historik med identitetsvärden', async () => {
    expect(await provaMigration(migrationsSql())).toEqual([]);
  });

  it('negativ kontroll: en migration som raderar historiken fälls av samma kontroll', async () => {
    const avvikelser = await provaMigration(`${migrationsSql()}\nDELETE FROM beslut_svarsversion;`);
    expect(avvikelser).toContain('antalet befintliga rader ändrades');
  });

  it('omkörning av migrationsrunnern lämnar logg, katalog och provets rader oförändrade', async () => {
    const beslutId = await nyttBeslutId();
    const svar = await kor(app, hermes, 'registrera_svarsversion', { beslut_id: beslutId, svar_hash: hash('omkörning') });
    expect(svar.status).toBe(200);
    const client = new pg.Client({ connectionString: config.DATABASE_ADMIN_URL });
    await client.connect();
    try {
      const logBefore = (await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
      const schemaBefore = await katalog(client);
      const rowsBefore = await rader(beslutId);
      const result = await migrate(config.DATABASE_ADMIN_URL!);
      expect(result.applied).toEqual([]);
      expect(result.alreadyApplied).toBe(logBefore.length);
      expect((await client.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(logBefore);
      expect(await katalog(client)).toEqual(schemaBefore);
      expect(await rader(beslutId)).toEqual(rowsBefore);
    } finally {
      await client.end();
    }
  });

  async function skrivningar(beslutId: number) {
    const events = await pool.query(
      "SELECT * FROM events WHERE tenant_id = $1 AND payload->>'beslut_id' = $2 ORDER BY id",
      [TENANT_ID, String(beslutId)],
    );
    return { versions: await rader(beslutId), events: events.rows };
  }

  it('serversonden version 0 ger validation_error med path version utan skrivning', async () => {
    const before = await skrivningar(1);
    const svar = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: 1, svar_hash: '0000000000000000', version: 0,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('validation_error');
    expect(svar.body.details).toContainEqual({ path: 'version', message: 'Number must be greater than 0' });
    expect(await skrivningar(1)).toEqual(before);
  });

  it.each([-1, 1.5, '1'])('ogiltig version %s avvisas med path version utan skrivning', async (version) => {
    const beslutId = await nyttBeslutId();
    const before = await skrivningar(beslutId);
    const svar = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: beslutId, svar_hash: hash('ogiltig'), version,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('validation_error');
    expect(svar.body.details).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'version' })]));
    expect(await skrivningar(beslutId)).toEqual(before);
  });

  it('okänt lopnummer avvisas fortfarande strikt med tom path utan skrivning', async () => {
    const beslutId = await nyttBeslutId();
    const before = await skrivningar(beslutId);
    const svar = await kor(app, hermes, 'registrera_svarsversion', {
      beslut_id: beslutId, svar_hash: hash('okänt fält'), lopnummer: 1,
    });
    expect(svar.status).toBe(400);
    expect(svar.body.error).toBe('validation_error');
    expect(svar.body.details).toEqual([{ path: '', message: "Unrecognized key(s) in object: 'lopnummer'" }]);
    expect(svar.body.details).not.toEqual(expect.arrayContaining([expect.objectContaining({ path: 'lopnummer' })]));
    expect(await skrivningar(beslutId)).toEqual(before);
  });


  interface Svarsindata {
    beslut_id: number;
    svar_hash: string;
    identifier?: string;
    version?: number;
  }
  type Registrera = (input: Svarsindata) => Promise<{
    status: number;
    body: { status?: string; action?: string; result?: { beslut_id: number; nyskapad: boolean }; error?: string };
  }>;
  const riktig: Registrera = async (input) => kor(app, hermes, 'registrera_svarsversion', input);

  async function scenarioABA(registrera: Registrera): Promise<string[]> {
    const avvikelser: string[] = [];
    const beslutId = await nyttBeslutId();
    const hashar = [hash(' A '), hash('B'), hash('A')];
    for (const [index, svarHash] of hashar.entries()) {
      const version = index + 1;
      try {
        const svar = await registrera({ beslut_id: beslutId, svar_hash: svarHash, version });
        if (svar.status !== 200 || svar.body.result?.nyskapad !== true) {
          avvikelser.push(`version ${version} gav inte nyskapad true`);
        }
      } catch (error) {
        avvikelser.push(`version ${version}: ${String(error)}`);
      }
    }
    const rows = (await rader(beslutId)).sort((a, b) => a.version - b.version);
    const identity = rows.map((r) => ({ version: r.version, svar_hash: r.svar_hash }));
    const expected = hashar.map((svar_hash, index) => ({ version: index + 1, svar_hash }));
    if (JSON.stringify(identity) !== JSON.stringify(expected)) avvikelser.push('inte tre rader med version 1, 2, 3');
    return avvikelser;
  }

  async function scenarioGamlaKlienten(registrera: Registrera): Promise<string[]> {
    const avvikelser: string[] = [];
    for (const medIdentifier of [false, true]) {
      const beslutId = await nyttBeslutId();
      const identifier = medIdentifier ? await nyttArende(app, hermes, 'Gamla klientens indata') : undefined;
      const input: Svarsindata = { beslut_id: beslutId, svar_hash: hash('klientens svar') };
      if (identifier !== undefined) input.identifier = identifier;
      let firstRows: unknown;
      for (const nyskapad of [true, false]) {
        try {
          const svar = await registrera(input);
          const expected = {
            status: 'ok', action: 'registrera_svarsversion', result: { beslut_id: beslutId, nyskapad },
          };
          try {
            expect(svar.status).toBe(200);
            expect(svar.body).toEqual(expected);
          } catch {
            avvikelser.push(`gamla klientens svar ändrat (identifier=${medIdentifier}, nyskapad=${nyskapad})`);
          }
        } catch (error) {
          avvikelser.push(`gamla klienten avvisades (identifier=${medIdentifier}): ${String(error)}`);
        }
        const rows = await rader(beslutId);
        if (rows.length !== 1 || rows[0]?.version !== null || rows[0]?.svar_hash !== input.svar_hash ||
          rows[0]?.tillampad == null) avvikelser.push('gamla klienten fick inte en historikrad');
        if (nyskapad) firstRows = rows;
        else if (JSON.stringify(rows) !== JSON.stringify(firstRows)) avvikelser.push('omkörning ändrade historikraden');
      }
      const events = (await skrivningar(beslutId)).events;
      const actual = events.map((e) => ({ verb: e.verb, payload: e.payload }));
      const expected = ['behandlade_svarsversion', 'svarsversionen_var_behandlad'].map((verb) => ({
        verb, payload: { beslut_id: beslutId, svar_hash: input.svar_hash },
      }));
      // jsonb har ingen nyckelordning: jämför strukturen, inte JSON-strängens ordning.
      try { expect(actual).toEqual(expected); }
      catch { avvikelser.push('gamla klientens händelseform ändrades'); }
      if (identifier !== undefined) {
        const issue = await kor(app, hermes, 'get_issue', { identifier });
        if (events.some((e) => e.issue_id !== issue.body.result.arende.id) ||
          (await rader(beslutId))[0]?.issue_id !== issue.body.result.arende.id) {
          avvikelser.push('identifier kopplades inte till ärendet');
        }
      } else if (events.some((e) => e.issue_id !== null) || (await rader(beslutId))[0]?.issue_id !== null) {
        avvikelser.push('utan identifier ska issue_id vara NULL');
      }
    }
    return avvikelser;
  }

  it('samma löpnummer/hash är idempotent; avvikande hash ger 400 utan rad eller ärendehändelse', async () => {
    const beslutId = await nyttBeslutId();
    const identifier = await nyttArende(app, hermes, 'Hashkontroll på löpnumret');
    const input = { beslut_id: beslutId, svar_hash: hash('A'), version: 1, identifier };
    const first = await riktig(input);
    expect(first.status).toBe(200);
    expect(first.body.result).toEqual({ beslut_id: beslutId, nyskapad: true });
    const rowsBefore = await rader(beslutId);
    expect(rowsBefore).toHaveLength(1);
    expect(rowsBefore[0]).toMatchObject({ version: 1, svar_hash: hash('A'), tenant_id: TENANT_ID });
    const again = await riktig(input);
    expect(again.status).toBe(200);
    expect(again.body.result).toEqual({ beslut_id: beslutId, nyskapad: false });
    expect(await rader(beslutId)).toEqual(rowsBefore);
    const issueBefore = await kor(app, hermes, 'get_issue', { identifier });
    expect(issueBefore.status).toBe(200);
    const events = issueBefore.body.result.handelser.filter((e: { verb: string }) =>
      ['behandlade_svarsversion', 'svarsversionen_var_behandlad'].includes(e.verb));
    expect(events.map((e: { verb: string; payload: unknown }) => ({ verb: e.verb, payload: e.payload }))).toEqual([
      { verb: 'behandlade_svarsversion', payload: { beslut_id: beslutId, version: 1, svar_hash: hash('A') } },
      { verb: 'svarsversionen_var_behandlad', payload: { beslut_id: beslutId, version: 1, svar_hash: hash('A') } },
    ]);
    expect(rowsBefore[0].issue_id).toBe(issueBefore.body.result.arende.id);
    expect(rowsBefore[0].tillampad).toBeInstanceOf(Date);
    const before = await skrivningar(beslutId);
    const rejected = await riktig({ ...input, svar_hash: hash('B') });
    expect(rejected.status).toBe(400);
    expect(rejected.body).toEqual({ error: 'svarsversion_hash_avviker' });
    expect(await skrivningar(beslutId)).toEqual(before);
    const issueAfter = await kor(app, hermes, 'get_issue', { identifier });
    expect(issueAfter.status).toBe(200);
    expect(issueAfter.body.result.handelser).toEqual(issueBefore.body.result.handelser);
  });

  it('A → B → A ger tre nya svarstillfällen och tre versionsrader', async () => {
    expect(await scenarioABA(riktig)).toEqual([]);
  });

  it('negativ kontroll: hash som identitet fälls av A → B → A-kontrollen', async () => {
    const avvikelser = await scenarioABA(async (input) => {
      const { version, ...utan } = input;
      return riktig(utan);
    });
    expect(avvikelser).toContain('version 3 gav inte nyskapad true');
  });

  it('gamla klientens exakta indata fungerar med och utan identifier och behåller svar/händelseform', async () => {
    expect(await scenarioGamlaKlienten(riktig)).toEqual([]);
  });

  it('negativ kontroll: server som kräver version fälls av gamla klientens kontroll', async () => {
    const avvikelser = await scenarioGamlaKlienten(async (input) => {
      if (input.version === undefined) {
        throw Object.assign(new Error('validation_error'), { status: 400, code: 'validation_error' });
      }
      return riktig(input);
    });
    expect(avvikelser.some((e) => e.includes('gamla klienten avvisades'))).toBe(true);
  });

});
