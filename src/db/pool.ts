import pg from 'pg';
import { config } from '../config.js';
import { APP_ROLL } from './migrate.js';

// API:t ansluter som den lågprivilegierade rollen "app" (KRAV-3). Migrationer
// använder DATABASE_ADMIN_URL separat (se db/migrate.ts).
export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
});

// Utan denna lyssnare blir ett fel på en VILANDE poolad anslutning (t.ex. när
// Postgres startar om) ett ohanterat 'error'-event som kraschar processen.
pool.on('error', (err) => {
  console.error('Oväntat fel på vilande DB-anslutning:', err.message);
});

/** Den form av `query` som rollkontrollen använder. Både `pg.Pool` och `pg.Client` uppfyller den. */
type Anslutning = {
  query<R extends pg.QueryResultRow>(text: string): Promise<pg.QueryResult<R>>;
};

/**
 * Fail-fast: appen kör bara som rollen "app" (FR-38, B-11, Story 7.1). SEX kontroller, alla lästa ur
 * databasen på anslutningen som prövas, och alla problem samlas innan felet kastas:
 *  1. `current_user` är `APP_ROLL` — en tillåtelselista med ett namn, så ingen annan roll godtas;
 *  2. `session_user` är också `APP_ROLL` — `current_user` kan sessionen sätta själv (SET ROLE,
 *     `-c role=…` i adressen, `ALTER ROLE … SET role`), och RESET ROLE tar den då tillbaka till
 *     inloggningsrollen, kanske en superuser;
 *  3. rollen är inte SUPERUSER;
 *  4. rollen har inte BYPASSRLS;
 *  5. rollen är inte medlem i någon annan roll — också en tillåtelselista: genom ett medlemskap når
 *     rollen den andra rollens rättigheter, ärvda eller med SET ROLE (en ägarroll, en roll med SUPERUSER
 *     eller BYPASSRLS, pg_write_all_data), så inget medlemskap godtas, och felet namnger rollerna med
 *     deras SUPERUSER och BYPASSRLS;
 *  6. rollen äger ingen tabell i `public`, själv eller genom medlemskap (`pg_has_role(…, 'MEMBER')`) —
 *     en fråga över pg_tables utan tabellista, så att en ny tabell i en senare migration omfattas utan
 *     att koden ändras.
 * Skälet: FR-8:s två linjer (42501 av GRANT för app, P0001 av triggern för ägaren) finns bara så länge
 * app inte äger tabellerna och inte når någon annan rolls rättigheter, eftersom ägaren kringgår
 * GRANT-nivån och kan stänga av triggern. Append-only-spärren på events hänger på det, och från Etapp 3
 * är det dessutom förutsättningen för RLS.
 *
 * Parametern finns för provet (test/schema.test.ts), som prövar andra roller och sessioner. Servern
 * anropar funktionen utan argument och prövar då poolen ur DATABASE_URL.
 */
export async function assertAppRollArBegransad(anslutning: Anslutning = pool): Promise<void> {
  const { rows } = await anslutning.query<{
    current_user: string;
    session_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    medlem_i: string[] | null;
    agda_tabeller: string[] | null;
  }>(`
    SELECT current_user,
           session_user,
           r.rolsuper,
           r.rolbypassrls,
           (
             SELECT array_agg(
                      m.rolname::text
                        || CASE WHEN m.rolsuper THEN ' (SUPERUSER)' ELSE '' END
                        || CASE WHEN m.rolbypassrls THEN ' (BYPASSRLS)' ELSE '' END
                      ORDER BY m.rolname)
             FROM pg_roles m
             WHERE m.rolname <> current_user AND pg_has_role(current_user, m.oid, 'MEMBER')
           ) AS medlem_i,
           (
             SELECT array_agg(t.tablename::text ORDER BY t.tablename)
             FROM pg_tables t
             WHERE t.schemaname = 'public' AND pg_has_role(current_user, t.tableowner, 'MEMBER')
           ) AS agda_tabeller
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);
  const info = rows[0];
  if (!info) throw new Error('kunde inte fastställa databasrollens rättigheter');

  const problem: string[] = [];
  if (info.current_user !== APP_ROLL) problem.push(`rollen är inte "${APP_ROLL}"`);
  if (info.session_user !== APP_ROLL) {
    problem.push(`inloggningsrollen (session_user) är "${info.session_user}" och inte "${APP_ROLL}"`);
  }
  if (info.rolsuper) problem.push('rollen är SUPERUSER');
  if (info.rolbypassrls) problem.push('rollen har BYPASSRLS');
  if (info.medlem_i && info.medlem_i.length > 0) {
    problem.push(`rollen är medlem i andra roller och kan nå deras rättigheter: ${info.medlem_i.join(', ')}`);
  }
  if (info.agda_tabeller && info.agda_tabeller.length > 0) {
    problem.push(
      `rollen äger tabeller i public: ${info.agda_tabeller.join(', ')} (ägaren kringgår GRANT-spärrarna)`,
    );
  }

  if (problem.length > 0) {
    throw new Error(
      `DATABASE_URL pekar på rollen "${info.current_user}", och API:t vägrar köra som den: ` +
        `${problem.join(', ')}. API:t måste ansluta som rollen "${APP_ROLL}". ` +
        'Använd DATABASE_ADMIN_URL enbart för migrationer.',
    );
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
