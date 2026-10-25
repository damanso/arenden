// D-3, D-5, B-23 (Story 11.4): ärendekortets läsmodell. Allt som kortet på ärendesidan visar hämtas här,
// i den transaktion som anroparen har öppnat. Ärenderutten hämtar kortets data bara genom den här
// funktionen, och vylagret har ingen SQL.
//
// TRE invarianter, som granskaren kan läsa av rakt här:
//   1. ETT FAST ANTAL FRÅGOR. Varje del av kortet hämtas med en fråga per uppsättning rader, aldrig en
//      per rad: de befintliga tjänstefunktionerna och sex egna läsfrågor (märkningarna av nödvändiga
//      delresultat, åtagandet, alla insatser på ärendet, insatsernas källor, beslutskopplingarna och
//      svarsversionerna). Källorna hämtas med en fråga över alla insatsers id (= ANY), också när ärendet
//      inte har någon insats (D-3, D-4, Story 11.5). Den enda fråga som beror på datat är kundkopplingen,
//      som bara slås upp när ärendet har ett projekt. Antalet kommentarer, händelser, delärenden,
//      relationer, bilagor, insatser, källor, beslut, svarsversioner, villkor eller märkningar ändrar
//      aldrig antalet frågor (K1 och K20 i test/arendekort.test.ts).
//   2. BARA LÄSNING. Ingen fråga skriver, och ingen händelserad skrivs: en GET skriver aldrig något.
//      Ägaren, fristen och ursprunget härleds vid läsning och lagras inte. Mätningen matReferenstyper
//      läser också bara, och dess skript kör den i en transaktion som är READ ONLY.
//   3. INGA LÅS. Ingen fråga tar ett radlås, så kortet svarar också medan en annan transaktion håller
//      ärendets rad (F15 och F30 i test/samtidighet.test.ts).
//
// Kandidaterna till befintligaArenden tas fram av sidans egen rendering (Story 11.2): ett eget mönsterpass
// hade missat de nummer som renderaren delar upp eller normaliserar. Anroparen lämnar därför renderingen
// som funktionen `kandidater`, som anropas exakt en gång, och tjänstelagret importerar aldrig vylagret.
// Sedan Story 11.5 får renderingen också åtagandet och insatserna, eftersom deras referenser och källor
// kan länka till ett ärende; uppslaget står därför efter frågorna som hämtar dem. Sedan Story 11.6 får den
// också händelserna, eftersom historikens detaljer kan länka till ett ärende.
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
import type { AtagandeJson, Lage, Referens, Tillhor } from './atagande.js';
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

/**
 * Det som sidans rendering behöver för att ta fram kandidaterna: samma texter, referenser och källor som
 * sidan visar.
 */
export interface Korttexter {
  arende: Arende;
  kommentarer: readonly Kommentar[];
  bilagor: readonly Bilaga[];
  atagande: Kortatagande | null;
  insatser: readonly Kortinsats[];
  /** D-3 (Story 11.6): historikens detaljer, vars referenser kan länka till ett ärende. */
  handelser: readonly Handelse[];
}

/** Åtagandets fält som kortet visar. `Arende` bär bara läget; resten läser åtagandefrågan. */
export interface Kortatagande {
  lage: Lage;
  tillhor: Tillhor;
  utforare_typ: string | null;
  utforare_namn: string | null;
  overtaget_nar: Date | null;
  foljs_upp: Date | null;
  revision: number;
  /**
   * Jsonb-kolumnen som den står. Kortet läser den med typvakter: en äldre rad, eller en rad som ägarrollen
   * skrivit, behöver inte följa AtagandeJson i src/services/atagande.ts.
   */
  data: unknown;
}

/** En källa till en insats, som insats_kallor bär den (migration 0015). */
export interface Kortkalla {
  system: string;
  objekttyp: string;
  objekt_id: string;
  objekt_version: string | null;
  lank: string | null;
}

/**
 * En insats på ärendet, i varje läge, med sina källor. `belagg` och `handlingskontrakt` är jsonb som de
 * står och läses med typvakter.
 */
export interface Kortinsats {
  id: string;
  typ: InsatsTyp;
  tillhor: InsatsTillhor;
  lage: InsatsLage;
  frist: Date | null;
  vackningstid: Date | null;
  utfall: string;
  begard_handling: string;
  blockeringsgrund: string;
  belagg: unknown;
  version: number;
  handlingskontrakt: unknown;
  svar_text: string | null;
  svar_aktor: string | null;
  svar_nar: Date | null;
  skapad: Date;
  kallor: Kortkalla[];
}

/** Ett beslut som är kopplat till ärendet (beslut_atagande), och när det kopplades. */
export interface Kortbeslut {
  beslut_id: number;
  kopplad: Date;
}

/** En behandlad svarsversion (beslut_svarsversion); version är null för den äldre klientens hashidentitet. */
export interface Kortsvarsversion {
  beslut_id: number;
  version: number | null;
  svar_hash: string;
  tillampad: Date;
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
  /** Alla insatser på ärendet, i fristens ordning. */
  insatser: Kortinsats[];
  /** De öppna insatserna (vantande och uppskjuten): `insatser` filtrerad, i samma ordning. */
  oppnaInsatser: Kortinsats[];
  beslut: Kortbeslut[];
  /** Svarsversionerna för ärendets kopplade beslut och de som registrerats på ärendet. */
  svarsversioner: Kortsvarsversion[];
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
  revision: number;
  data: unknown;
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
  // Den enda fråga som beror på datat: utan projekt finns ingen koppling att läsa.
  const kundkoppling =
    arende.projekt === null ? null : await hamtaKundkoppling(client, tenantId, arende.projekt);

  // Åtagandets fält, revisionen och jsonb-datan (grunden, nästa steg, villkoren, hindret, resultatet och
  // avslutsskälet). Frågan ställs alltid, så att antalet frågor inte beror på om ärendet bär ett.
  const { rows: atagandesrader } = await client.query<Atagandesrad>(
    `SELECT atagande_lage AS lage, atagande_tillhor AS tillhor,
            atagande_utforare_typ AS utforare_typ, atagande_utforare_namn AS utforare_namn,
            atagande_overtaget_nar AS overtaget_nar, atagande_foljs_upp AS foljs_upp,
            atagande_revision AS revision, atagande AS data
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
          revision: rad.revision,
          data: rad.data,
        };

  // D-3, D-4 (Story 11.5): alla insatser på ärendet, i varje läge och oberoende av väckningstid, i samma
  // ordning som de öppna hade förut. Kortet visar också en besvarad, återkallad eller avslutad insats.
  const { rows: insatsrader } = await client.query<Omit<Kortinsats, 'kallor'>>(
    `SELECT id, typ, tillhor, lage, frist, vackningstid, utfall, begard_handling, blockeringsgrund,
            belagg, version, handlingskontrakt, svar_text, svar_aktor, svar_nar, skapad
       FROM insatser
      WHERE tenant_id = $1 AND issue_id = $2
      ORDER BY frist NULLS LAST, skapad, id`,
    [tenantId, arende.id],
  );
  // Källorna för alla insatser i EN fråga (samma form som medKallor i src/services/insats.ts). Den ställs
  // också med en tom lista, så att antalet frågor inte beror på om ärendet har insatser; källorna
  // fördelas på insatserna här.
  const { rows: kallrader } = await client.query<Kortkalla & { insats_id: string }>(
    `SELECT insats_id, system, objekttyp, objekt_id, objekt_version, lank
       FROM insats_kallor
      WHERE tenant_id = $1 AND insats_id = ANY($2::uuid[])
      ORDER BY insats_id, system, objekttyp, objekt_id`,
    [tenantId, insatsrader.map((i) => i.id)],
  );
  const kallorPer = new Map<string, Kortkalla[]>();
  for (const k of kallrader) {
    const lista = kallorPer.get(k.insats_id) ?? [];
    lista.push({
      system: k.system,
      objekttyp: k.objekttyp,
      objekt_id: k.objekt_id,
      objekt_version: k.objekt_version ?? null,
      lank: k.lank ?? null,
    });
    kallorPer.set(k.insats_id, lista);
  }
  const insatser: Kortinsats[] = insatsrader.map((i) => ({ ...i, kallor: kallorPer.get(i.id) ?? [] }));
  // Ägare och Frist (Story 11.4) läser de öppna: väntande och uppskjutna, i samma ordning.
  const oppnaInsatser = insatser.filter((i) => i.lage === 'vantande' || i.lage === 'uppskjuten');

  // Besluten som är kopplade till ärendet. Ett beslut hör till ett ärende (primärnyckeln i migration 0014).
  const { rows: beslut } = await client.query<Kortbeslut>(
    `SELECT beslut_id, skapad AS kopplad
       FROM beslut_atagande
      WHERE tenant_id = $1 AND issue_id = $2
      ORDER BY skapad, beslut_id`,
    [tenantId, arende.id],
  );
  // Svarsversionerna: de som registrerats på ärendet och de för ärendets kopplade beslut, i en fråga.
  // En version som registrerats på ärendet för ett beslut som inte är kopplat dit hämtas också, och kortet
  // visar den i stället för att tappa en hämtad rad.
  const { rows: svarsversioner } = await client.query<Kortsvarsversion>(
    `SELECT beslut_id, version, svar_hash, tillampad
       FROM beslut_svarsversion
      WHERE tenant_id = $1
        AND (issue_id = $2
             OR beslut_id IN (SELECT beslut_id FROM beslut_atagande WHERE tenant_id = $1 AND issue_id = $2))
      ORDER BY beslut_id, tillampad, id`,
    [tenantId, arende.id],
  );

  // D-2 (Story 11.2): varje nummer som sidan renderar slås upp i ETT anrop, och renderingen får nu också
  // åtagandet och insatserna, vars referenser och källor kan länka till ett ärende (Story 11.5).
  const befintliga = await befintligaArenden(
    client,
    tenantId,
    kandidater({ arende, kommentarer, bilagor, atagande, insatser, handelser }),
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
    insatser,
    oppnaInsatser,
    beslut,
    svarsversioner,
    namnsI: omnamnanden.namnsI,
    namnsIKapat: omnamnanden.kapat,
  };
}

// ---- D-4, B-25 (Story 11.5 AK 1): mätningen av referenstyperna --------------------------------------------

/** Formen på en del av åtagandets jsonb: en lista eller ett ensamt objekt. */
export type Jsonform = 'lista' | 'objekt';

/** En referensbärare i åtagandets jsonb: delen den står i (eller åtagandet självt), nyckeln och formen. */
export interface Referensbarare {
  readonly del: { readonly nyckel: string; readonly form: Jsonform } | null;
  readonly nyckel: string;
  readonly form: Jsonform;
}

/**
 * D-4, B-25 (Story 11.5, granskningsfynd 8): den slutna listan över var i åtagandets jsonb en referens står,
 * i fältets ordning. Mätningen (matReferenstyper) och kortets fält Mail (atagandetsReferenser i
 * src/http/vy/kort.ts) läser bärarna bara härifrån, och tsc binder listan till AtagandeJson åt båda hållen
 * (Bararkontroll nedan): en ny referensbärare i AtagandeJson utan post här, eller en post som inte är någon
 * bärare, fäller bygget. Fältet Åtagande visar varje bärare; K38 i test/arendekort.test.ts prövar det.
 */
export const REFERENSBARARE = [
  { del: null, nyckel: 'grund', form: 'lista' },
  { del: { nyckel: 'nasta', form: 'objekt' }, nyckel: 'grund', form: 'objekt' },
  { del: { nyckel: 'villkor', form: 'lista' }, nyckel: 'kalla', form: 'objekt' },
  { del: { nyckel: 'villkor', form: 'lista' }, nyckel: 'belagg', form: 'objekt' },
  { del: { nyckel: 'hinder', form: 'objekt' }, nyckel: 'belagg', form: 'objekt' },
  { del: { nyckel: 'resultat', form: 'objekt' }, nyckel: 'belagg', form: 'lista' },
  { del: { nyckel: 'avslutsskal', form: 'objekt' }, nyckel: 'grund', form: 'objekt' },
] as const satisfies readonly Referensbarare[];

/** Bärarens namn i mätningen: nyckeln, eller delen och nyckeln med en punkt emellan (nasta.grund). */
export function bararnamn(b: Referensbarare): string {
  return b.del === null ? b.nyckel : `${b.del.nyckel}.${b.nyckel}`;
}

/** Ett värde ur AtagandeJson utan null: elementet när det är en lista, annars värdet. */
type Elementet<T> = NonNullable<T> extends readonly (infer E)[] ? E : NonNullable<T>;
/** Bär värdet en referens, ensam eller i en lista? */
type BarReferens<T> = [Elementet<T>] extends [Referens] ? true : false;
/** Bärarnas namn som AtagandeJson ger dem: en nyckel som bär referenser, eller del.nyckel ett steg ned. */
type Bararnamn = {
  [K in keyof AtagandeJson & string]-?: BarReferens<AtagandeJson[K]> extends true
    ? K
    : Elementet<AtagandeJson[K]> extends object
      ? {
          [N in keyof Elementet<AtagandeJson[K]> & string]-?: BarReferens<Elementet<AtagandeJson[K]>[N]> extends true
            ? `${K}.${N}`
            : never;
        }[keyof Elementet<AtagandeJson[K]> & string]
      : never;
}[keyof AtagandeJson & string];
/** Namnet som bararnamn ger en post i listan, som typ. */
type Postnamn<B> = B extends {
  readonly del: { readonly nyckel: infer D extends string };
  readonly nyckel: infer N extends string;
}
  ? `${D}.${N}`
  : B extends { readonly nyckel: infer N extends string }
    ? N
    : never;
type Listade = Postnamn<(typeof REFERENSBARARE)[number]>;
/** Godtar bara never. */
type Tom<T extends never> = T;
/** tsc fäller en bärare i AtagandeJson som REFERENSBARARE saknar, och en post i listan som inte är en bärare. */
export type Bararkontroll = Tom<Exclude<Bararnamn, Listade> | Exclude<Listade, Bararnamn>>;

/** Mätningens svar: varje typ per bärare med antal, och varje par av system och objekttyp med antal. */
export interface Referenstyper {
  referenser: { barare: string; typ: string | null; antal: number }[];
  kallor: { system: string; objekttyp: string; antal: number }[];
}

/**
 * D-4, B-25 (Story 11.5 AK 1): läsande mätning av referenstyperna, underlaget för den slutna tabellen
 * REFERENSLANK i src/http/vy/kort.ts. Varje typ räknas per bärare: åtagandets bärare i REFERENSBARARE
 * (grunden, nästa stegs grund, villkorens källa och belägg, hindrets belägg, resultatets belägg och
 * avslutsskälets grund) och insatsernas belägg. Källorna räknas per par av system och objekttyp. Två
 * frågor, en per källa, och båda filtrerar tenanten i varje gren.
 *
 * Åtagandets bärare kommer in som parametrar ur REFERENSBARARE, en rad per bärare (unnest), så att frågan
 * och kortet läser samma slutna lista. En del och en bärare läses i sin form: en lista med
 * jsonb_array_elements bara när jsonb_typeof säger array, och ett ensamt objekt bara när det säger object,
 * så att en äldre rad med en annan form inte fäller mätningen; jsonb_array_elements kastar för något annat
 * än en lista. Typen läses med ->>, och en referens utan typ räknas med typen null. Inget radlås och ingen
 * skrivning; skriptet src/scripts/matReferenstyper.ts kör funktionen i en transaktion som är READ ONLY.
 */
export async function matReferenstyper(client: PoolClient, tenantId: string): Promise<Referenstyper> {
  const { rows: referenser } = await client.query<{ barare: string; typ: string | null; antal: number }>(
    `SELECT barare, typ, count(*)::int AS antal
       FROM (
         SELECT b.barare, r->>'typ' AS typ
           FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
                  AS b(barare, delnyckel, delform, nyckel, form)
           JOIN issues i ON i.tenant_id = $1 AND i.atagande_lage IS NOT NULL
          CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                  WHEN b.delnyckel IS NULL THEN jsonb_build_array(i.atagande)
                  WHEN b.delform = 'lista' AND jsonb_typeof(i.atagande->b.delnyckel) = 'array'
                    THEN i.atagande->b.delnyckel
                  WHEN b.delform = 'objekt' AND jsonb_typeof(i.atagande->b.delnyckel) = 'object'
                    THEN jsonb_build_array(i.atagande->b.delnyckel)
                  ELSE '[]'::jsonb
                END) d
          CROSS JOIN LATERAL jsonb_array_elements(
                CASE
                  WHEN b.form = 'lista' AND jsonb_typeof(d->b.nyckel) = 'array' THEN d->b.nyckel
                  WHEN b.form = 'objekt' AND jsonb_typeof(d->b.nyckel) = 'object' THEN jsonb_build_array(d->b.nyckel)
                  ELSE '[]'::jsonb
                END) r
         UNION ALL
         SELECT 'insats.belagg', r->>'typ'
           FROM insatser s
          CROSS JOIN LATERAL jsonb_array_elements(
                CASE WHEN jsonb_typeof(s.belagg) = 'array' THEN s.belagg ELSE '[]'::jsonb END) r
          WHERE s.tenant_id = $1
       ) referenser
      GROUP BY barare, typ
      ORDER BY barare, typ`,
    [
      tenantId,
      REFERENSBARARE.map((b) => bararnamn(b)),
      REFERENSBARARE.map((b) => b.del?.nyckel ?? null),
      REFERENSBARARE.map((b) => b.del?.form ?? null),
      REFERENSBARARE.map((b) => b.nyckel),
      REFERENSBARARE.map((b) => b.form),
    ],
  );
  const { rows: kallor } = await client.query<{ system: string; objekttyp: string; antal: number }>(
    `SELECT system, objekttyp, count(*)::int AS antal
       FROM insats_kallor
      WHERE tenant_id = $1
      GROUP BY system, objekttyp
      ORDER BY system, objekttyp`,
    [tenantId],
  );
  return { referenser, kallor };
}
