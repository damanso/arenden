// K-4: kopplingen mellan ett projekt i ärendeplattformen och en kund i ett
// källsystem — med ID och källa, inte med namn. kund_id är id:t i det system
// som kund_kalla anger (B-08); utan källan går id:t inte att tolka.
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

/**
 * B-01 (FR-26, Story 6.1 AK 7): samma läsning som hamtaKundkoppling, men med radlås. Bara
 * skrivvägen (sattKundkoppling) använder den, i samma transaktion som UPDATE och händelseraden.
 * Den andra av två samtidiga skrivningar väntar här och läser den förstas committade värde, så
 * fore i händelseraden är alltid det som faktiskt ersattes. Kortet läser olåst och tar aldrig lås.
 */
export async function hamtaProjektForAndring(
  client: PoolClient,
  tenantId: string,
  projekt: string,
): Promise<Kundkoppling | null> {
  const { rows } = await client.query<Kundkoppling>(
    `SELECT ${KOLUMNER} FROM projects WHERE tenant_id = $1 AND namn = $2 FOR UPDATE`,
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
  /**
   * Krävs när status = kopplad (kalla_saknas) och förbjuden annars (kalla_utan_koppling).
   * Ingen standardkälla (B-08). En källa som är tom utan sina osynliga kanter är ingen källa.
   */
  kund_kalla?: string | null;
}

/**
 * FR-26, B-08 (Story 6.1): de tre fält som tillsammans ÄR kopplingen. Jämförelsen och händelseradens
 * fore/efter bär exakt dem, så att ett källbyte syns som en ändring och inte som en no-op.
 */
export interface KopplingsVarden {
  kund_id: string | null;
  kund_kalla: string | null;
  koppling_status: KopplingStatus;
}

export interface KopplingsResultat {
  projekt_id: string;
  projekt: string;
  fore: KopplingsVarden;
  efter: KopplingsVarden;
  /** false = anropet var en no-op. Verbet i händelseraden skiljer på det. */
  andrad: boolean;
}

function somVarden(k: Kundkoppling): KopplingsVarden {
  return { kund_id: k.kund_id, kund_kalla: k.kund_kalla, koppling_status: k.koppling_status };
}

/**
 * Osynliga kanter: blanktecken (också NBSP, U+3000 och radbrytningar) och osynliga formattecken
 * (Unicode-kategorin Cf: U+200B, U+FEFF, riktningsmärken …).
 */
const OSYNLIG_KANT = /^[\s\p{Cf}]+|[\s\p{Cf}]+$/gu;

/** Värdet utan osynliga kanter. null och utelämnat blir null; ett värde som bara var kanter blir ''. */
function utanKanter(varde: string | null | undefined): string | null {
  return varde === undefined || varde === null ? null : varde.replace(OSYNLIG_KANT, '');
}

/**
 * FR-26, B-08 (Story 6.1): prövar valet och ger de värden som ska skrivas, i lagrad form, eller kastar
 * den första av fyra felkoder. Ren: ingen databas, och samma val ger alltid samma svar.
 *
 *   kopplad utan kund_id               -> kund_id_saknas
 *   kopplad med kund_id men utan källa -> kalla_saknas
 *   intern/oavgjord med kund_id        -> kund_id_utan_koppling
 *   intern/oavgjord med källa          -> kalla_utan_koppling
 *
 * null och utelämnat betyder samma sak här, "inte angiven". Det är inte regeln om delvisa
 * uppdateringar: varje anrop sätter alla tre fälten, så inget lagrat värde ska få stå kvar.
 * Ett värde som är tomt utan sina osynliga kanter är inget värde: vid kopplad saknas det, och vid
 * intern och oavgjord är fältet ändå angivet och avvisas. Inget fält ignoreras tyst, och ingen
 * blank källa blir ett källsystem.
 * Värdena ges i lagrad form: utan osynliga kanter, och id:t med gemener så som Postgres skriver
 * ut ett uuid. Synliga tecken i källan ändras aldrig, inte heller skiftläget. Det finns ingen
 * standardkälla att falla tillbaka på — ett id vars system gissats fram är samma sorts tysta lögn
 * som namnmatchningen ovan.
 */
export function provaKopplingsVal(val: KopplingsVal): KopplingsVarden {
  const kundId = utanKanter(val.kund_id);
  const kalla = utanKanter(val.kund_kalla);
  if (val.status === 'kopplad') {
    if (!kundId) {
      throw new BadRequestError('kund_id_saknas', 'kund_id krävs när status är kopplad');
    }
    if (!kalla) {
      throw new BadRequestError('kalla_saknas', 'kund_kalla krävs när status är kopplad');
    }
    return { kund_id: kundId.toLowerCase(), kund_kalla: kalla, koppling_status: val.status };
  }
  if (kundId !== null) {
    throw new BadRequestError('kund_id_utan_koppling', `kund_id får inte anges när status är ${val.status}`);
  }
  if (kalla !== null) {
    throw new BadRequestError('kalla_utan_koppling', `kund_kalla får inte anges när status är ${val.status}`);
  }
  return { kund_id: null, kund_kalla: null, koppling_status: val.status };
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
 *
 * B-08 (FR-26, Story 6.1): källan krävs vid kopplad, och ingen reserv fyller i
 * den. Valet prövas i provaKopplingsVal efter läsningen av projektets rad och
 * före varje skrivning. Jämförelsen gäller id, källa och läge, så ett källbyte
 * är en ändring. Samma värden igen skriver ingenting: kund_kopplad_at står kvar,
 * annars hade tidsstämpeln bytts utan någon ändringsrad i historiken (som B-05).
 *
 * Det är databasen som avgör om något ändras, inte en jämförelse av texter här:
 * UPDATE rör raden bara när den lagrade trippeln skiljer sig från den nya, jämförd
 * i kolumnernas egna typer (ett uuid i versaler, med klamrar eller utan bindestreck
 * är samma uuid). andrad är att raden skrevs. Skrivningen och andrad är alltså samma
 * fakta, vilken skrivform värdena än kom i, och en no-op kan aldrig byta tidsstämpeln.
 *
 * B-01 (FR-26, Story 6.1 AK 7): projektets rad läses med radlås (hamtaProjektForAndring)
 * först, sedan prövas valet, sedan UPDATE och händelserad, allt i anroparens transaktion.
 * Två samtidiga anrop kan därför aldrig båda logga samma gamla värde. Bara projektets rad
 * låses, så skrivningen kan inte hamna i ett dödläge med ärendenas lås.
 */
export async function sattKundkoppling(
  client: PoolClient,
  tenantId: string,
  projekt: string,
  val: KopplingsVal,
): Promise<KopplingsResultat> {
  const fore = await hamtaProjektForAndring(client, tenantId, projekt);
  if (fore === null) throw new NotFoundError('projekt');

  // Regeln finns i databasen som CHECK-villkor också. Den finns HÄR för att
  // felet ska få en egen kod i stället för en constraint-överträdelse.
  const varden = provaKopplingsVal(val);
  const foreVarden = somVarden(fore);

  // Ingen rad tillbaka = den lagrade trippeln var redan den nya: inget skrevs.
  const { rows } = await client.query<Kundkoppling>(
    `UPDATE projects
        SET kund_id = $3,
            kund_kalla = $4,
            koppling_status = $5,
            kund_kopplad_at = CASE WHEN $5 = 'kopplad' THEN now() ELSE NULL END
      WHERE tenant_id = $1 AND namn = $2
        AND (kund_id, kund_kalla, koppling_status) IS DISTINCT FROM ($3::uuid, $4::text, $5::text)
      RETURNING ${KOLUMNER}`,
    [tenantId, projekt, varden.kund_id, varden.kund_kalla, varden.koppling_status],
  );
  const efter = rows[0];

  return {
    projekt_id: fore.projekt_id,
    projekt: fore.projekt,
    fore: foreVarden,
    efter: efter === undefined ? foreVarden : somVarden(efter),
    andrad: efter !== undefined,
  };
}
