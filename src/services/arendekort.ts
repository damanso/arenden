// D-3, D-5, B-23 (Story 11.4): ärendekortets läsmodell. Allt som kortet på ärendesidan visar hämtas här,
// i den transaktion som anroparen har öppnat. Ärenderutten hämtar kortets data bara genom den här
// funktionen, och vylagret har ingen SQL.
//
// TRE invarianter, som granskaren kan läsa av rakt här:
//   1. ETT FAST ANTAL FRÅGOR. Varje del av kortet hämtas med en fråga per uppsättning rader, aldrig en
//      per rad: de befintliga tjänstefunktionerna och tre egna läsfrågor (åtagandet, de öppna insatserna
//      och märkningarna av nödvändiga delresultat). Den enda fråga som beror på datat är kundkopplingen,
//      som bara slås upp när ärendet har ett projekt. Antalet kommentarer, händelser, delärenden,
//      relationer, bilagor, insatser eller märkningar ändrar aldrig antalet frågor (K1 i
//      test/arendekort.test.ts).
//   2. BARA LÄSNING. Ingen fråga skriver, och ingen händelserad skrivs: en GET skriver aldrig något.
//      Ägaren, fristen och ursprunget härleds vid läsning och lagras inte.
//   3. INGA LÅS. Ingen fråga tar ett radlås, så kortet svarar också medan en annan transaktion håller
//      ärendets rad (F15 och F30 i test/samtidighet.test.ts).
//
// Kandidaterna till befintligaArenden tas fram av sidans egen rendering (Story 11.2): ett eget mönsterpass
// hade missat de nummer som renderaren delar upp eller normaliserar. Anroparen lämnar därför renderingen
// som funktionen `kandidater`, som anropas exakt en gång, och tjänstelagret importerar aldrig vylagret.
import type { PoolClient } from 'pg';
import type { Befintliga } from '../lib/arendelank.js';
import {
  barnFor,
  befintligaArenden,
  hamtaArende,
  sokArendenIVy,
  type Arende,
  type SoktraffIVy,
} from './arenden.js';
import type { Lage, Tillhor } from './atagande.js';
import { listaHandelser, type Handelse } from './handelser.js';
import type { InsatsLage, InsatsTillhor, InsatsTyp } from './insats.js';
import {
  listaBorttagnaKommentarer,
  listaKommentarer,
  type BorttagenKommentar,
  type Kommentar,
} from './kommentarer.js';
import { hamtaKundkoppling, type Kundkoppling } from './kundkoppling.js';
import { bilagorFor, relationerFor, type Bilaga, type Relation } from './relationer.js';

/** Taket för «Nämns i». Når listan taket säger kortet det (ingen tyst avkapning). */
export const TAK_NAMNS_I = 200;

/**
 * Sökfrågans gräns för «Nämns i»: taket plus två. En plats för ärendet självt, som filtreras bort, och en
 * som visar att taket är nått. Med taket plus ett hade ärendet självt kunnat ta den platsen, och listan
 * hade sagt att taket inte är nått fast fler ärenden nämner numret.
 */
export const NAMNS_I_GRANS = TAK_NAMNS_I + 2;

/**
 * «Nämns i» ur sökfrågans träffar, som är högst NAMNS_I_GRANS: ärendet självt bortfiltrerat, listan kapad
 * vid taket, och `kapat` sant exakt när fler andra ärenden än taket finns.
 */
export function namnsIUrTraffar<T extends { id: string }>(
  traffar: readonly T[],
  arendeId: string,
): { namnsI: T[]; kapat: boolean } {
  const andra = traffar.filter((t) => t.id !== arendeId);
  return { namnsI: andra.slice(0, TAK_NAMNS_I), kapat: andra.length > TAK_NAMNS_I };
}

/** Det som sidans rendering behöver för att ta fram kandidaterna: samma texter som sidan visar. */
export interface Korttexter {
  arende: Arende;
  kommentarer: readonly Kommentar[];
  bilagor: readonly Bilaga[];
}

/** Åtagandets fält som kortet visar. `Arende` bär bara läget; resten läser åtagandefrågan. */
export interface Kortatagande {
  lage: Lage;
  tillhor: Tillhor;
  utforare_typ: string | null;
  utforare_namn: string | null;
  overtaget_nar: Date | null;
  foljs_upp: Date | null;
}

/** En öppen insats på ärendet: läget vantande eller uppskjuten. */
export interface Kortinsats {
  id: string;
  typ: InsatsTyp;
  tillhor: InsatsTillhor;
  lage: InsatsLage;
  frist: Date | null;
  vackningstid: Date | null;
}

/**
 * En aktiv märkning av ett nödvändigt delresultat (Story 5.5), med den som märkte och när. Märkningen hör
 * till paret och står kvar när delärendet flyttas (migration 0018), så den bär delärendets eget nummer:
 * kortet visar den också när delärendet inte längre är barn till huvudärendet.
 */
export interface Markning {
  del_issue_id: string;
  del_identifier: string;
  markt_av_typ: string;
  markt_av_namn: string;
  markt: Date;
}

export interface Arendekort {
  arende: Arende;
  kommentarer: Kommentar[];
  handelser: Handelse[];
  barn: Arende[];
  markningar: Markning[];
  relationer: Relation[];
  bilagor: Bilaga[];
  borttagna: BorttagenKommentar[];
  befintliga: Befintliga;
  kundkoppling: Kundkoppling | null;
  atagande: Kortatagande | null;
  oppnaInsatser: Kortinsats[];
  namnsI: SoktraffIVy[];
  namnsIKapat: boolean;
}

interface Atagandesrad {
  lage: Lage | null;
  tillhor: Tillhor | null;
  utforare_typ: string | null;
  utforare_namn: string | null;
  overtaget_nar: Date | null;
  foljs_upp: Date | null;
}

/**
 * Hela kortet för ett ärende. Kastar NotFoundError när ärendet inte finns (hamtaArende), och anroparen
 * gör det till sidans 404. Frågorna ställs i en bestämd ordning, alla parametriserade och ordnade.
 */
export async function hamtaArendekort(
  client: PoolClient,
  tenantId: string,
  identifier: string,
  kandidater: (texter: Korttexter) => readonly string[],
): Promise<Arendekort> {
  const arende = await hamtaArende(client, tenantId, identifier);
  const kommentarer = await listaKommentarer(client, tenantId, arende.id);
  const handelser = await listaHandelser(client, tenantId, arende.id);
  const barn = await barnFor(client, tenantId, arende.id);
  // FR-16 delkrav 5 (Story 5.5): de aktiva märkningarna. saknadeDelresultat ger bara de märkta som
  // saknar resultat, och kortet visar varje märkt delärende. Spärren utgår från märkningen och inte från
  // hierarkin, så frågan gör det också: delärendets nummer joinas in i samma fråga, och en märkning vars
  // delärende har flyttats följer med.
  const { rows: markningar } = await client.query<Markning>(
    `SELECT n.del_issue_id, t.key || '-' || d.sequence_number AS del_identifier,
            n.markt_av_typ, n.markt_av_namn, n.markt
       FROM nodvandiga_delresultat n
       JOIN issues d ON d.id = n.del_issue_id
       JOIN teams t ON t.id = d.team_id
      WHERE n.tenant_id = $1 AND n.huvud_issue_id = $2 AND n.borttagen IS NULL
      ORDER BY n.markt, n.id`,
    [tenantId, arende.id],
  );
  const relationer = await relationerFor(client, tenantId, arende.id);
  const bilagor = await bilagorFor(client, tenantId, arende.id);
  const borttagna = await listaBorttagnaKommentarer(client, tenantId, arende.id);
  // D-2 (Story 11.2): varje nummer som sidan renderar slås upp i ETT anrop.
  const befintliga = await befintligaArenden(client, tenantId, kandidater({ arende, kommentarer, bilagor }));
  // Den enda fråga som beror på datat: utan projekt finns ingen koppling att läsa.
  const kundkoppling =
    arende.projekt === null ? null : await hamtaKundkoppling(client, tenantId, arende.projekt);

  // Åtagandets fält. Frågan ställs alltid, så att antalet frågor inte beror på om ärendet bär ett.
  const { rows: atagandesrader } = await client.query<Atagandesrad>(
    `SELECT atagande_lage AS lage, atagande_tillhor AS tillhor,
            atagande_utforare_typ AS utforare_typ, atagande_utforare_namn AS utforare_namn,
            atagande_overtaget_nar AS overtaget_nar, atagande_foljs_upp AS foljs_upp
       FROM issues
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, arende.id],
  );
  const rad = atagandesrader[0];
  const atagande: Kortatagande | null =
    rad === undefined || rad.lage === null || rad.tillhor === null
      ? null
      : {
          lage: rad.lage,
          tillhor: rad.tillhor,
          utforare_typ: rad.utforare_typ,
          utforare_namn: rad.utforare_namn,
          overtaget_nar: rad.overtaget_nar,
          foljs_upp: rad.foljs_upp,
        };

  // De öppna insatserna oberoende av väckningstid: kortet visar vem en väntande insats tillhör också före
  // väckningen. En återkallad, besvarad eller avslutad insats syns inte.
  const { rows: oppnaInsatser } = await client.query<Kortinsats>(
    `SELECT id, typ, tillhor, lage, frist, vackningstid
       FROM insatser
      WHERE tenant_id = $1 AND issue_id = $2 AND lage IN ('vantande', 'uppskjuten')
      ORDER BY frist NULLS LAST, skapad, id`,
    [tenantId, arende.id],
  );

  // «Nämns i» är sökningens fråga med ärendets nummer (Story 11.1), aldrig en egen fulltextfråga.
  const traffar = await sokArendenIVy(client, tenantId, arende.identifier, NAMNS_I_GRANS);
  const omnamnanden = namnsIUrTraffar(traffar, arende.id);

  return {
    arende,
    kommentarer,
    handelser,
    barn,
    markningar,
    relationer,
    bilagor,
    borttagna,
    befintliga,
    kundkoppling,
    atagande,
    oppnaInsatser,
    namnsI: omnamnanden.namnsI,
    namnsIKapat: omnamnanden.kapat,
  };
}
