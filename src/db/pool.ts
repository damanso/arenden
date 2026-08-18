import pg from 'pg';
import { config } from '../config.js';

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

/**
 * Fail-fast: appen får inte köra som superuser eller som tabellägaren. I Etapp 1
 * är det append-only-spärren på events som hänger på det (ägaren kringgår
 * GRANT-nivån), och från Etapp 3 är det dessutom förutsättningen för RLS.
 */
export async function assertAppRollArBegransad(): Promise<void> {
  const { rows } = await pool.query<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
    ager_tabeller: boolean;
  }>(`
    SELECT current_user,
           r.rolsuper,
           r.rolbypassrls,
           EXISTS (
             SELECT 1 FROM pg_tables
             WHERE tablename = 'events' AND tableowner = current_user
           ) AS ager_tabeller
    FROM pg_roles r
    WHERE r.rolname = current_user
  `);
  const info = rows[0];
  if (!info) throw new Error('kunde inte fastställa databasrollens rättigheter');

  const problem: string[] = [];
  if (info.rolsuper) problem.push('rollen är SUPERUSER');
  if (info.rolbypassrls) problem.push('rollen har BYPASSRLS');
  if (info.ager_tabeller) problem.push('rollen äger tabellerna (ägaren kringgår GRANT-spärrarna)');

  if (problem.length > 0) {
    throw new Error(
      `DATABASE_URL pekar på rollen "${info.current_user}" som är för privilegierad: ` +
        `${problem.join(', ')}. API:t måste ansluta som rollen "app". ` +
        'Använd DATABASE_ADMIN_URL enbart för migrationer.',
    );
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
