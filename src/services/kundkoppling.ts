// K-4: kopplingen mellan ett projekt i ärendeplattformen och en kund i
// redovisningen — med ID, inte med namn.
//
// Varför inte namn: en exakt namnmatchning projects.namn -> organisationens
// namn ger 3 träffar av 3 i dagens data, och EN av dem är fel. "Hermes" finns
// i båda systemen, men CRM-posten är arkiverad, har noll interaktioner och
// noll personer. Namnmatchningen hade knutit 33 ärenden till en tom post och
// aldrig sagt ett ord om det. Ett namn är en PROXY för identitet; det här
// registret bär identiteten själv.
import type { PoolClient } from 'pg';
import { BadRequestError, NotFoundError } from '../lib/errors.js';

export type KopplingStatus = 'kopplad' | 'intern' | 'oavgjord';

export interface Kundkoppling {
  projekt_id: string;
  projekt: string;
  kund_id: string | null;
  kund_kalla: string | null;
  koppling_status: KopplingStatus;
  kund_kopplad_at: Date | null;
}

const KOLUMNER = `id AS projekt_id, namn AS projekt, kund_id, kund_kalla,
                  koppling_status, kund_kopplad_at`;

/** Läser kopplingen för ETT projekt. null = projektet finns inte. */
export async function hamtaKundkoppling(
  client: PoolClient,
  tenantId: string,
  projekt: string,
): Promise<Kundkoppling | null> {
  const { rows } = await client.query<Kundkoppling>(
    `SELECT ${KOLUMNER} FROM projects WHERE tenant_id = $1 AND namn = $2`,
    [tenantId, projekt],
  );
  return rows[0] ?? null;
}

/** Hela registret — underlaget för avstämningsprovet och för vyn. */
export async function listaKundkopplingar(
  client: PoolClient,
  tenantId: string,
): Promise<Kundkoppling[]> {
  const { rows } = await client.query<Kundkoppling>(
    `SELECT ${KOLUMNER} FROM projects WHERE tenant_id = $1 ORDER BY namn`,
    [tenantId],
  );
  return rows;
}

export interface KopplingsVal {
  status: KopplingStatus;
  /** Krävs och tillåts ENDAST när status = 'kopplad'. */
  kund_id?: string | null;
  /** Vilket system kund_id hör hemma i. Default 'redovisning'. */
  kund_kalla?: string | null;
}

export interface KopplingsResultat {
  projekt_id: string;
  projekt: string;
  fore: { kund_id: string | null; koppling_status: KopplingStatus };
  efter: { kund_id: string | null; koppling_status: KopplingStatus };
  /** false = anropet var en no-op. Verbet i händelseraden skiljer på det. */
  andrad: boolean;
}

/**
 * Sätter kopplingen för ett projekt.
 *
 * Skriver ALDRIG själv någon händelserad — anroparen (registry.ts) gör det på
 * ctx.client, alltså i SAMMA transaktion som den här uppdateringen. Det är den
 * ordningen som gör KRAV-10 sann: verkan och proveniens lever och dör ihop.
 *
 * Projektet måste finnas. Ett okänt projektnamn blir 404 och ALDRIG ett nytt
 * projekt: den som kopplar en kund ska koppla till något som finns, och ett
 * stavfel ska smälla, inte tyst skapa ett tomt projekt med en kund på.
 */
export async function sattKundkoppling(
  client: PoolClient,
  tenantId: string,
  projekt: string,
  val: KopplingsVal,
): Promise<KopplingsResultat> {
  const fore = await hamtaKundkoppling(client, tenantId, projekt);
  if (fore === null) throw new NotFoundError('projekt');

  // Regeln finns i databasen som CHECK-villkor också. Den finns HÄR för att
  // felet ska bli begripligt i stället för en constraint-överträdelse.
  if (val.status === 'kopplad') {
    if (val.kund_id === undefined || val.kund_id === null) {
      throw new BadRequestError('kund_id krävs när status är kopplad');
    }
  } else if (val.kund_id !== undefined && val.kund_id !== null) {
    throw new BadRequestError(`kund_id får inte anges när status är ${val.status}`);
  }

  const kundId = val.status === 'kopplad' ? (val.kund_id as string) : null;
  const kalla = val.status === 'kopplad' ? (val.kund_kalla ?? 'redovisning') : null;

  const { rows } = await client.query<Kundkoppling>(
    `UPDATE projects
        SET kund_id = $3,
            kund_kalla = $4,
            koppling_status = $5,
            kund_kopplad_at = CASE WHEN $5 = 'kopplad' THEN now() ELSE NULL END
      WHERE tenant_id = $1 AND namn = $2
      RETURNING ${KOLUMNER}`,
    [tenantId, projekt, kundId, kalla, val.status],
  );
  const efter = rows[0]!;

  return {
    projekt_id: efter.projekt_id,
    projekt: efter.projekt,
    fore: { kund_id: fore.kund_id, koppling_status: fore.koppling_status },
    efter: { kund_id: efter.kund_id, koppling_status: efter.koppling_status },
    andrad: fore.kund_id !== efter.kund_id || fore.koppling_status !== efter.koppling_status,
  };
}
