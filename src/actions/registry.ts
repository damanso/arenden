import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Aktor } from '../lib/aktor.js';
import {
  AktorTypSchema,
  HttpUrlSchema,
  IdentifierSchema,
  IsoDateSchema,
  PrioritySchema,
  RelationTypSchema,
  StateTypSchema,
  TeamKeySchema,
  UuidSchema,
  safeText,
} from '../lib/validation.js';
import {
  barnFor,
  claimaNastaArende,
  hamtaArende,
  listaArenden,
  rorArende,
  dopOmEtikett,
  dopOmProjekt,
  skapaArende,
  sokArenden,
  sokLabel,
  laggTillEtikettPaArende,
  taBortEtikettFranArende,
  uppdateraArendeFalt,
  uppdateraArendeState,
  type Falt,
} from '../services/arenden.js';
import {
  bilagorFor,
  laggTillBilaga,
  laggTillRelation,
  relationerFor,
} from '../services/relationer.js';
import { listaHandelser } from '../services/handelser.js';
import {
  aterkallaInsats,
  besvaraInsats,
  hamtaInsats,
  insatsForKalla,
  listaInsatser,
  registreraInsats,
  skjutUppInsats,
} from '../services/insats.js';
import {
  andraAtagande,
  arbetsandel,
  atagandeForBeslut,
  aterppnaAtagande,
  avslutaAtagande,
  hamtaAtagande,
  hindraAtagande,
  kopplaBeslut,
  listaAtaganden,
  loggaMoment,
  overtaAtagande,
  redovisaResultat,
  registreraAtagande,
  registreraSvarsversion,
} from '../services/atagande.js';
import {
  listaKundkopplingar,
  sattKundkoppling,
  type KopplingStatus,
} from '../services/kundkoppling.js';
import {
  aterstallKommentar,
  hamtaKommentar,
  laggTillKommentar,
  listaKommentarer,
  rattaKommentar,
  taBortKommentar,
} from '../services/kommentarer.js';
import { aterkallaNyckel } from '../services/nycklar.js';
import { listaStates } from '../services/team.js';

export interface ActionContext {
  client: PoolClient;
  tenantId: string;
  /** Kommer ALLTID ur API-nyckeln — aldrig ur indata. */
  aktor: Aktor;
  /**
   * Skriver en rad i den append-only loggen i SAMMA transaktion som mutationen
   * (KRAV-8). executeAction räknar anropen och vägrar committa en write-action
   * som inte lämnat proveniens efter sig.
   */
  skrivHandelse: (handelse: { issueId: string | null; verb: string; payload?: unknown }) => Promise<void>;
}

// read = ingen mutation. write = muterar och MÅSTE skriva minst en event-rad.
export type Sensitivity = 'read' | 'write';

export interface ActionDef<I> {
  name: string;
  title: string;
  sensitivity: Sensitivity;
  /**
   * ALLTID ett zod-schema med .strict() — okända fält avvisas, inte ignoreras.
   * Indatatypen är `unknown` (inte I) eftersom scheman med .default()/.coerce()
   * har olika in- och utdatatyp; I är det som handlern får EFTER parse.
   */
  inputSchema: z.ZodType<I, z.ZodTypeDef, unknown>;
  handler: (ctx: ActionContext, input: I) => Promise<unknown>;
}

/**
 * Registrerad (typraderad) action. Generiken lever i def() och konsumeras där;
 * registret lagrar en form utan typparameter så att alla actions kan ligga i
 * samma array utan `any`.
 */
export interface RegistreradAction {
  name: string;
  title: string;
  sensitivity: Sensitivity;
  parse: (input: unknown) => unknown;
  handler: (ctx: ActionContext, input: unknown) => Promise<unknown>;
}

function def<I>(d: ActionDef<I>): RegistreradAction {
  return {
    name: d.name,
    title: d.title,
    sensitivity: d.sensitivity,
    parse: (input) => d.inputSchema.parse(input),
    // Säker: executeAction skickar ALLTID utdatat från parse() hit.
    handler: (ctx, input) => d.handler(ctx, input as I),
  };
}

const LimitSchema = z.coerce.number().int().min(1).max(100).default(50);

/**
 * Ett verb per fält, inte ett gemensamt 'andrade_falt'. Digesten och
 * ärendehistoriken ska kunna läsas utan att öppna payloaden — "ändrade
 * prioritet" säger något, "ändrade fält" gör det inte.
 */
const VERB_FOR_FALT: Record<Falt, string> = {
  priority: 'andrade_prioritet',
  due_date: 'andrade_deadline',
  milstolpe: 'andrade_milstolpe',
  foralder: 'andrade_foralder',
  projekt: 'andrade_projekt',
  // Beslut #145. Titeln ar kort och renderas som "A -> B" i digesten.
  title: 'andrade_titel',
  // Beskrivningen gor det INTE: den kan vara 20 000 tecken. Samma skal som
  // for kommentarsrattelsen, och darfor samma payloadform (gammal_text).
  description: 'rattade_beskrivning',
};

/**
 * K-10, "varför". Ingen payload i plattformen bar ett skäl — historiken kunde
 * berätta VAD som ändrades och AV VEM, aldrig varför. Fältet är FRIVILLIGT och
 * skrivs bara när anroparen faktiskt anger det: ett obligatoriskt skäl hade
 * fyllts med "uppdatering" inom en vecka, och ett skäl som alltid står där och
 * aldrig betyder något är sämre än inget skäl.
 *
 * Det gäller BARA nya rader. Historiska rader får inget påhittat varför — en
 * historik med uppdiktade skäl är värre än en historik utan.
 */
const SkalSchema = safeText(500);

// Åtagandets sammansatta fält. En referens pekar på en BESTÄMD post — inte på
// en länk. Visningslänken härleds ur referensen och kanalregistret; att spara
// länken i stället för posten är precis den proxy som ljuger tyst när en
// adress ändras.
const ReferensSchema = z
  .object({ typ: safeText(60), id: safeText(300), version: safeText(120).optional() })
  .strict();

const NastaSchema = z
  .object({
    handling: safeText(2000),
    // Slaget avgör vem åtagandet tillhör — därför härleds `tillhor` av det och
    // fylls aldrig i för hand. En utåthandling kan inte döpas om till internt
    // utan ny grund (se andra_atagande).
    slag: z.enum(['internt', 'riktning', 'utathandling']),
    grund: ReferensSchema,
  })
  .strict();

const VillkorSchema = z
  .object({
    text: safeText(2000),
    kalla: ReferensSchema,
    galler: safeText(500),
    kontroll: safeText(1000),
    utfall: z.enum(['okant', 'uppfyllt', 'ej_uppfyllt']),
    belagg: ReferensSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.utfall === 'okant' || (v.belagg !== undefined && v.belagg !== null), {
    message: 'ett villkor som inte är okänt kräver belägg',
  });

export const ACTIONS: RegistreradAction[] = [
  def({
    name: 'list_issues',
    title: 'Lista ärenden',
    sensitivity: 'read',
    inputSchema: z
      .object({
        state_typer: z.array(StateTypSchema).min(1).max(5).optional(),
        team_key: TeamKeySchema.optional(),
        label: safeText(100).optional(),
        projekt: safeText(200).optional(),
        kund_id: UuidSchema.optional(),
        cursor: z.string().min(1).max(200).optional(),
        limit: LimitSchema,
      })
      .strict(),
    handler: (ctx, input) =>
      listaArenden(ctx.client, ctx.tenantId, {
        ...(input.state_typer ? { stateTyper: input.state_typer } : {}),
        ...(input.team_key ? { teamKey: input.team_key } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.projekt ? { projekt: input.projekt } : {}),
        ...(input.kund_id ? { kundId: input.kund_id } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
        limit: input.limit,
      }),
  }),

  def({
    name: 'get_issue',
    title: 'Hämta ärende med kommentarer och händelser',
    sensitivity: 'read',
    inputSchema: z.object({ identifier: IdentifierSchema }).strict(),
    handler: async (ctx, input) => {
      const arende = await hamtaArende(ctx.client, ctx.tenantId, input.identifier);
      return {
        arende,
        kommentarer: await listaKommentarer(ctx.client, ctx.tenantId, arende.id),
        handelser: await listaHandelser(ctx.client, ctx.tenantId, arende.id),
        // K-3: strukturen runt ärendet. Föräldern ligger redan på arende
        // (foralder_identifier); barn, relationer och bilagor läses här.
        barn: await barnFor(ctx.client, ctx.tenantId, arende.id),
        relationer: await relationerFor(ctx.client, ctx.tenantId, arende.id),
        bilagor: await bilagorFor(ctx.client, ctx.tenantId, arende.id),
      };
    },
  }),

  def({
    name: 'list_states',
    title: 'Lista arbetsflödesstatusar för ett team',
    sensitivity: 'read',
    inputSchema: z.object({ team_key: TeamKeySchema }).strict(),
    handler: (ctx, input) => listaStates(ctx.client, ctx.tenantId, input.team_key),
  }),

  def({
    name: 'search_issues',
    title: 'Fritextsök över ärenden och kommentarer',
    sensitivity: 'read',
    inputSchema: z.object({ fraga: safeText(200), limit: LimitSchema }).strict(),
    handler: (ctx, input) => sokArenden(ctx.client, ctx.tenantId, input.fraga, input.limit),
  }),

  def({
    name: 'sok_label',
    title: 'Slå upp en etikett',
    sensitivity: 'read',
    inputSchema: z.object({ namn: safeText(100) }).strict(),
    handler: async (ctx, input) => ({ id: await sokLabel(ctx.client, ctx.tenantId, input.namn) }),
  }),

  def({
    name: 'create_issue',
    title: 'Skapa ärende',
    sensitivity: 'write',
    inputSchema: z
      .object({
        title: safeText(300),
        description: safeText(20_000).optional(),
        team_key: TeamKeySchema,
        labels: z.array(safeText(100)).max(20).optional(),
        priority: PrioritySchema.optional(),
        due: IsoDateSchema.optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const arende = await skapaArende(ctx.client, ctx.tenantId, {
        title: input.title,
        team_key: input.team_key,
        ...(input.description ? { description: input.description } : {}),
        ...(input.labels ? { labels: input.labels } : {}),
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.due ? { due: input.due } : {}),
      });
      await ctx.skrivHandelse({
        issueId: arende.id,
        verb: 'skapade_arende',
        payload: { identifier: arende.identifier, title: arende.title },
      });
      return { id: arende.id, identifier: arende.identifier, arende };
    },
  }),

  def({
    name: 'update_issue_state',
    title: 'Uppdatera ärendets status',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        state_typ: StateTypSchema.optional(),
        state_id: UuidSchema.optional(),
      })
      .strict()
      .refine((v) => (v.state_typ === undefined) !== (v.state_id === undefined), {
        message: 'ange antingen state_typ eller state_id — inte båda och inte ingen',
      }),
    handler: async (ctx, input) => {
      const { arende, fran, till } = await uppdateraArendeState(ctx.client, ctx.tenantId, input.identifier, {
        ...(input.state_typ ? { state_typ: input.state_typ } : {}),
        ...(input.state_id ? { state_id: input.state_id } : {}),
      });
      await ctx.skrivHandelse({
        issueId: arende.id,
        verb: 'andrade_status',
        payload: { identifier: arende.identifier, fran, till: till.namn, typ: till.typ },
      });
      return arende;
    },
  }),

  def({
    name: 'update_issue',
    title: 'Uppdatera ärendets fält (titel, beskrivning, prioritet, deadline, milstolpe, förälder)',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        // null nollställer fältet, undefined (utelämnat) rör det inte.
        priority: PrioritySchema.nullable().optional(),
        due: IsoDateSchema.nullable().optional(),
        milstolpe: safeText(200).nullable().optional(),
        parent: IdentifierSchema.nullable().optional(),
        // K-10: projektets NAMN. null tar bort ärendet ur projektet. Ett okänt
        // namn ger 404 — den här vägen skapar aldrig ett projekt.
        projekt: safeText(200).nullable().optional(),
        // Beslut #145. Titeln kan inte nollställas — ett ärende utan rubrik
        // finns inte. Beskrivningen kan: null tömmer den till ''.
        title: safeText(300).optional(),
        description: safeText(20_000).nullable().optional(),
        skal: SkalSchema.optional(),
        bara_om_osatt: z.boolean().default(false),
      })
      .strict()
      .refine(
        (v) =>
          v.priority !== undefined ||
          v.due !== undefined ||
          v.milstolpe !== undefined ||
          v.parent !== undefined ||
          v.projekt !== undefined ||
          v.title !== undefined ||
          v.description !== undefined,
        {
          message:
            'ange minst ett fält att uppdatera (title, description, priority, due, milstolpe, parent eller projekt)',
        },
      ),
    handler: async (ctx, input) => {
      const { arende, andringar } = await uppdateraArendeFalt(ctx.client, ctx.tenantId, input.identifier, {
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.due !== undefined ? { due: input.due } : {}),
        ...(input.milstolpe !== undefined ? { milstolpe: input.milstolpe } : {}),
        ...(input.parent !== undefined ? { parent: input.parent } : {}),
        ...(input.projekt !== undefined ? { projekt: input.projekt } : {}),
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        bara_om_osatt: input.bara_om_osatt,
      });
      // Skälet skrivs bara när det ANGES. `...(x ? {skal} : {})` i stället för
      // `skal: input.skal ?? null` — en payload med "skal": null på varenda rad
      // hade sett ut som ett besvarat fält med tomt svar.
      const skal = input.skal === undefined ? {} : { skal: input.skal };

      // EN händelserad per FAKTISKT ändrat fält. Det är hela poängen med K-2:
      // arendehem.py ändrade 16 ärenden med rå SQL och lämnade tretton utan
      // spår. Går ändringen den här vägen är spåret inte valfritt — den som
      // skriver utan att logga får sin transaktion tillbakarullad av
      // executeAction.
      for (const a of andringar) {
        // Beslut #145: beskrivningen bar gammal_text/ny_text, inte fran/till.
        // BYTESVERB i vyn renderar fran/till som "A -> B" pa EN rad, och en
        // 20 000 teckens brodtext hor inte hemma dar. Samma undantag som
        // kommentarsrattelsen redan har.
        const varden =
          a.falt === 'description'
            ? { gammal_text: a.fran, ny_text: a.till }
            : { fran: a.fran, till: a.till };
        await ctx.skrivHandelse({
          issueId: arende.id,
          verb: VERB_FOR_FALT[a.falt],
          payload: {
            identifier: arende.identifier,
            falt: a.falt,
            ...varden,
            ...skal,
          },
        });
      }
      if (andringar.length === 0) {
        // Ingen mutation skedde (värdet var redan satt, eller redan detsamma).
        // Samma mönster som tom_ko i claim_next_issue: vi loggar FÖRSÖKET, för
        // annars fälls ett korrekt no-op-svar av proveniens-tvånget.
        await ctx.skrivHandelse({
          issueId: arende.id,
          verb: 'arendet_oforandrat',
          payload: { identifier: arende.identifier, ...skal },
        });
      }
      return { arende, andringar };
    },
  }),

  def({
    name: 'link_issues',
    title: 'Länka två ärenden (relaterat eller blockerar)',
    sensitivity: 'write',
    inputSchema: z
      .object({
        fran: IdentifierSchema,
        till: IdentifierSchema,
        typ: RelationTypSchema,
        source_ref: safeText(300).optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const fran = await hamtaArende(ctx.client, ctx.tenantId, input.fran);
      const till = await hamtaArende(ctx.client, ctx.tenantId, input.till);
      const { relation, nyskapad } = await laggTillRelation(ctx.client, ctx.tenantId, {
        fran_issue_id: fran.id,
        till_issue_id: till.id,
        typ: input.typ,
        ...(input.source_ref ? { source_ref: input.source_ref } : {}),
      });
      await ctx.skrivHandelse({
        issueId: fran.id,
        verb: nyskapad ? 'lankade_arenden' : 'lank_fanns_redan',
        payload: { identifier: fran.identifier, till: till.identifier, typ: input.typ },
      });
      return { relation, nyskapad };
    },
  }),

  def({
    name: 'add_attachment',
    title: 'Lägg till en dokumentlänk på ett ärende',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        titel: safeText(300),
        url: HttpUrlSchema,
        undertitel: safeText(300).nullable().optional(),
        source_ref: safeText(2400).optional(),
        skapad: z.string().datetime({ offset: true }).optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const arende = await hamtaArende(ctx.client, ctx.tenantId, input.identifier);
      const { bilaga, nyskapad } = await laggTillBilaga(ctx.client, ctx.tenantId, {
        issue_id: arende.id,
        titel: input.titel,
        url: input.url,
        ...(input.undertitel !== undefined ? { undertitel: input.undertitel } : {}),
        ...(input.source_ref ? { source_ref: input.source_ref } : {}),
        ...(input.skapad ? { skapad: input.skapad } : {}),
      });
      await ctx.skrivHandelse({
        issueId: arende.id,
        verb: nyskapad ? 'lade_till_bilaga' : 'bilagan_fanns_redan',
        payload: { identifier: arende.identifier, titel: bilaga.titel, url: bilaga.url },
      });
      return { bilaga, nyskapad };
    },
  }),

  def({
    name: 'add_comment',
    title: 'Kommentera ärende',
    sensitivity: 'write',
    inputSchema: z.object({ identifier: IdentifierSchema, body: safeText(20_000) }).strict(),
    handler: async (ctx, input) => {
      const arende = await hamtaArende(ctx.client, ctx.tenantId, input.identifier);
      const kommentar = await laggTillKommentar(ctx.client, ctx.tenantId, arende.id, input.body, ctx.aktor);
      // Beslut #24 KRAV-1: kommentaren rör moderärendet i SAMMA transaktion, så
      // att vattenmärket (issues.uppdaterad) fångar den. Events-loggen är
      // oförändrad — proveniensen skrivs som förr nedan.
      await rorArende(ctx.client, ctx.tenantId, arende.id);
      await ctx.skrivHandelse({
        issueId: arende.id,
        verb: 'kommenterade',
        payload: { identifier: arende.identifier, kommentar_id: kommentar.id },
      });
      return kommentar;
    },
  }),

  def({
    name: 'claim_next_issue',
    title: 'Plocka nästa ärende ur agentkön',
    sensitivity: 'write',
    inputSchema: z.object({}).strict(),
    handler: async (ctx) => {
      const arende = await claimaNastaArende(ctx.client, ctx.tenantId, ctx.aktor.namn);
      if (!arende) {
        // Tom kö är ett giltigt svar, inte ett fel (KRAV-12). Ingen mutation har
        // skett, så vi loggar FÖRSÖKET — annars skulle proveniens-tvånget i
        // executeAction slå till på ett korrekt no-op-svar.
        await ctx.skrivHandelse({ issueId: null, verb: 'tom_ko' });
        return null;
      }
      await ctx.skrivHandelse({
        issueId: arende.id,
        verb: 'claimade_arende',
        payload: { identifier: arende.identifier, state: arende.state_namn },
      });
      return arende;
    },
  }),

  // ---- K-1: rättningsvägarna ----------------------------------------------
  //
  // Gemensamt för alla sex: de RÄTTAR, de raderar inte historik. Varje av dem
  // skriver en händelserad med aktören (ur nyckeln, aldrig ur indata) och det
  // GAMLA värdet — annars hade vi bytt ett permanent fel mot en osynlig ändring.
  // Även no-op-fallen loggas, av samma skäl som tom_ko: ett korrekt svar får
  // inte fällas av proveniens-tvånget i executeAction.

  def({
    name: 'update_comment',
    title: 'Rätta en kommentars text',
    sensitivity: 'write',
    inputSchema: z.object({ kommentar_id: UuidSchema, body: safeText(20_000) }).strict(),
    handler: async (ctx, input) => {
      const fore = await hamtaKommentar(ctx.client, ctx.tenantId, input.kommentar_id);
      if (fore.borttagen === null && fore.body === input.body) {
        await ctx.skrivHandelse({
          issueId: fore.issue_id,
          verb: 'kommentaren_oforandrad',
          payload: { kommentar_id: fore.id },
        });
        return { kommentar: fore, andrad: false };
      }
      const { kommentar, gammalText } = await rattaKommentar(
        ctx.client,
        ctx.tenantId,
        input.kommentar_id,
        input.body,
      );
      await ctx.skrivHandelse({
        issueId: kommentar.issue_id,
        verb: 'rattade_kommentar',
        // gammal_text/ny_text — inte fran/till. Fältnamnen fran/till renderas
        // som "A → B" i digesten, och en 5 000 teckens kommentar hör inte hemma
        // på en rad där. Hela värdet finns här; vyn visar det inte.
        payload: { kommentar_id: kommentar.id, gammal_text: gammalText, ny_text: kommentar.body },
      });
      return { kommentar, andrad: true };
    },
  }),

  def({
    name: 'delete_comment',
    title: 'Ta bort en kommentar (mjuk radering)',
    sensitivity: 'write',
    inputSchema: z.object({ kommentar_id: UuidSchema }).strict(),
    handler: async (ctx, input) => {
      const fore = await hamtaKommentar(ctx.client, ctx.tenantId, input.kommentar_id);
      const { kommentar, andrad } = await taBortKommentar(
        ctx.client,
        ctx.tenantId,
        input.kommentar_id,
      );
      await ctx.skrivHandelse({
        issueId: kommentar.issue_id,
        verb: andrad ? 'tog_bort_kommentar' : 'kommentaren_var_redan_borttagen',
        // HELA den borttagna raden bevaras här: texten OCH proveniensen den bar.
        // Det är den enda platsen den syns efter borttagningen, och det är rätt
        // plats — events är append-only.
        payload: andrad
          ? {
              kommentar_id: kommentar.id,
              gammal_text: fore.body,
              gammal_aktor_typ: fore.aktor_typ,
              gammal_aktor_namn: fore.aktor_namn,
            }
          : { kommentar_id: kommentar.id },
      });
      return { kommentar_id: kommentar.id, andrad };
    },
  }),

  def({
    name: 'restore_comment',
    title: 'Återställ en borttagen kommentar',
    sensitivity: 'write',
    inputSchema: z.object({ kommentar_id: UuidSchema }).strict(),
    handler: async (ctx, input) => {
      const { kommentar, andrad } = await aterstallKommentar(
        ctx.client,
        ctx.tenantId,
        input.kommentar_id,
      );
      await ctx.skrivHandelse({
        issueId: kommentar.issue_id,
        verb: andrad ? 'aterstallde_kommentar' : 'kommentaren_var_inte_borttagen',
        payload: { kommentar_id: kommentar.id },
      });
      return { kommentar_id: kommentar.id, andrad };
    },
  }),

  def({
    name: 'add_label',
    title: 'Sätt en etikett på ett ärende',
    sensitivity: 'write',
    inputSchema: z.object({ identifier: IdentifierSchema, label: safeText(100) }).strict(),
    handler: async (ctx, input) => {
      const arende = await hamtaArende(ctx.client, ctx.tenantId, input.identifier);
      const lades = await laggTillEtikettPaArende(
        ctx.client,
        ctx.tenantId,
        arende.id,
        input.label,
      );
      await ctx.skrivHandelse({
        issueId: arende.id,
        verb: lades ? 'satte_etikett' : 'etiketten_fanns_redan',
        payload: { identifier: arende.identifier, etikett: input.label },
      });
      return { identifier: arende.identifier, etikett: input.label, andrad: lades };
    },
  }),

  def({
    name: 'remove_label',
    title: 'Ta bort en etikett från ett ärende',
    sensitivity: 'write',
    inputSchema: z.object({ identifier: IdentifierSchema, label: safeText(100) }).strict(),
    handler: async (ctx, input) => {
      const arende = await hamtaArende(ctx.client, ctx.tenantId, input.identifier);
      const togsBort = await taBortEtikettFranArende(
        ctx.client,
        ctx.tenantId,
        arende.id,
        input.label,
      );
      await ctx.skrivHandelse({
        issueId: arende.id,
        verb: togsBort ? 'tog_bort_etikett' : 'etiketten_fanns_inte',
        payload: { identifier: arende.identifier, etikett: input.label },
      });
      return { identifier: arende.identifier, etikett: input.label, andrad: togsBort };
    },
  }),

  // ---- K-4: kund <-> ärende -------------------------------------------------

  def({
    name: 'list_project_customers',
    title: 'Projektens kundkopplingar',
    sensitivity: 'read',
    inputSchema: z.object({}).strict(),
    handler: (ctx) => listaKundkopplingar(ctx.client, ctx.tenantId),
  }),

  def({
    name: 'set_project_customer',
    title: 'Koppla ett projekt till en kund i redovisningen',
    sensitivity: 'write',
    // kund_id är ETT UUID, aldrig ett namn. Det är hela poängen: ett namn hade
    // matchat "Hermes" mot en arkiverad, tom CRM-post och knutit 33 ärenden
    // till den utan att någon sett det.
    inputSchema: z
      .object({
        projekt: safeText(200),
        status: z.enum(['kopplad', 'intern', 'oavgjord']),
        kund_id: UuidSchema.nullable().optional(),
        kund_kalla: safeText(50).nullable().optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const resultat = await sattKundkoppling(ctx.client, ctx.tenantId, input.projekt, {
        status: input.status as KopplingStatus,
        kund_id: input.kund_id ?? null,
        kund_kalla: input.kund_kalla ?? null,
      });
      // KRAV-10: samma transaktion som mutationen, och aktören kommer ur
      // nyckeln - aldrig ur indata. Vem som knöt en kund till ett projekt är
      // precis den sortens beslut som måste gå att läsa i efterhand.
      await ctx.skrivHandelse({
        issueId: null,
        verb: resultat.andrad ? 'andrade_kundkoppling' : 'kundkoppling_oforandrad',
        payload: {
          projekt_id: resultat.projekt_id,
          projekt: resultat.projekt,
          fore: resultat.fore,
          efter: resultat.efter,
        },
      });
      return resultat;
    },
  }),

  def({
    name: 'rename_project',
    title: 'Rätta ett projektnamn',
    sensitivity: 'write',
    inputSchema: z.object({ fran: safeText(200), till: safeText(200) }).strict(),
    handler: async (ctx, input) => {
      const resultat = await dopOmProjekt(ctx.client, ctx.tenantId, input.fran, input.till);
      const andrad = input.fran !== input.till;
      await ctx.skrivHandelse({
        issueId: null,
        verb: andrad ? 'andrade_projektnamn' : 'namnet_oforandrat',
        payload: { projekt_id: resultat.id, fran: resultat.fran, till: resultat.till },
      });
      return { ...resultat, andrad };
    },
  }),

  def({
    name: 'rename_label',
    title: 'Rätta ett etikettnamn',
    sensitivity: 'write',
    inputSchema: z.object({ fran: safeText(100), till: safeText(100) }).strict(),
    handler: async (ctx, input) => {
      const resultat = await dopOmEtikett(ctx.client, ctx.tenantId, input.fran, input.till);
      const andrad = input.fran !== input.till;
      await ctx.skrivHandelse({
        issueId: null,
        verb: andrad ? 'andrade_etikettnamn' : 'namnet_oforandrat',
        payload: { etikett_id: resultat.id, fran: resultat.fran, till: resultat.till },
      });
      return { ...resultat, andrad };
    },
  }),

  def({
    name: 'revoke_api_key',
    title: 'Återkalla en API-nyckel',
    sensitivity: 'write',
    inputSchema: z.object({ nyckel_id: UuidSchema }).strict(),
    handler: async (ctx, input) => {
      const { nyckel, andrad } = await aterkallaNyckel(ctx.client, ctx.tenantId, input.nyckel_id);
      await ctx.skrivHandelse({
        issueId: null,
        verb: andrad ? 'aterkallade_nyckel' : 'nyckeln_var_redan_aterkallad',
        // Identiteten som återkallades — ALDRIG hashen, aldrig nyckeln.
        payload: {
          nyckel_id: nyckel.id,
          nyckelns_aktor_typ: nyckel.aktor_typ,
          nyckelns_aktor_namn: nyckel.aktor_namn,
        },
      });
      return { nyckel_id: nyckel.id, aktiv: nyckel.aktiv, andrad };
    },
  }),

  // ---- Åtagandet: den beständiga länken genom hela systemet ---------------
  //
  // Spec: Astra 2026-09-09. Ram: ägaren ger riktning, användaren bär utgången
  // till verkligheten, Hermes är bolaget och gör allt annat självt.
  //
  // Två saker är medvetet omöjliga här: att ange vem som tog över (utföraren
  // tas ur nyckeln) och att redovisa ett resultat utan belägg.

  def({
    name: 'registrera_atagande',
    title: 'Registrera ett åtagande på ett ärende',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        grund: z.array(ReferensSchema).min(1),
        nasta: NastaSchema.nullable(),
        foljs_upp: z.string().datetime({ offset: true }).nullable(),
        villkor: z.array(VillkorSchema).optional(),
        utfall_precisering: safeText(2000).optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const { atagande, nyskapad } = await registreraAtagande(ctx.client, ctx.tenantId, input);
      await ctx.skrivHandelse({
        issueId: atagande.issue_id,
        verb: nyskapad ? 'registrerade_atagande' : 'atagandet_fanns_redan',
        payload: {
          identifier: atagande.identifier,
          lage: atagande.lage,
          tillhor: atagande.tillhor,
          revision: atagande.revision,
        },
      });
      return { atagande, nyskapad };
    },
  }),

  def({
    name: 'ta_over_atagande',
    title: 'Ta över ett åtagande (utföraren tas ur nyckeln)',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        nasta: NastaSchema,
        foljs_upp: z.string().datetime({ offset: true }),
        forvantad_revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const atagande = await overtaAtagande(ctx.client, ctx.tenantId, ctx.aktor, input);
      await ctx.skrivHandelse({
        issueId: atagande.issue_id,
        verb: 'tog_over_atagande',
        payload: {
          identifier: atagande.identifier,
          utforare_typ: atagande.utforare_typ,
          utforare_namn: atagande.utforare_namn,
          nasta: atagande.data.nasta,
          revision: atagande.revision,
        },
      });
      return atagande;
    },
  }),

  def({
    name: 'andra_atagande',
    title: 'Ändra nästa steg, uppföljning eller villkor',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        nasta: NastaSchema.optional(),
        foljs_upp: z.string().datetime({ offset: true }).nullable().optional(),
        villkor: z.array(VillkorSchema).optional(),
        grund: ReferensSchema.optional(),
        forvantad_revision: z.number().int().nonnegative().optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.nasta !== undefined ||
          v.foljs_upp !== undefined ||
          v.villkor !== undefined ||
          v.grund !== undefined,
        { message: 'ange minst en ändring (nasta, foljs_upp, villkor eller grund)' },
      ),
    handler: async (ctx, input) => {
      const atagande = await andraAtagande(ctx.client, ctx.tenantId, input);
      await ctx.skrivHandelse({
        issueId: atagande.issue_id,
        verb: 'andrade_atagande',
        payload: {
          identifier: atagande.identifier,
          tillhor: atagande.tillhor,
          nasta: atagande.data.nasta,
          revision: atagande.revision,
        },
      });
      return atagande;
    },
  }),

  def({
    name: 'hindra_atagande',
    title: 'Registrera ett konkret hinder',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        orsak: safeText(2000),
        belagg: ReferensSchema,
        nasta: NastaSchema,
        foljs_upp: z.string().datetime({ offset: true }),
        forvantad_revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const atagande = await hindraAtagande(ctx.client, ctx.tenantId, input);
      await ctx.skrivHandelse({
        issueId: atagande.issue_id,
        verb: 'hindrade_atagande',
        payload: {
          identifier: atagande.identifier,
          orsak: input.orsak,
          revision: atagande.revision,
        },
      });
      return atagande;
    },
  }),

  def({
    name: 'redovisa_resultat',
    title: 'Redovisa ett genomfört resultat (kräver belägg)',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        sammanfattning: safeText(4000),
        belagg: z.array(ReferensSchema).min(1),
        forvantad_revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const atagande = await redovisaResultat(ctx.client, ctx.tenantId, input);
      await ctx.skrivHandelse({
        issueId: atagande.issue_id,
        verb: 'redovisade_resultat',
        payload: {
          identifier: atagande.identifier,
          sammanfattning: input.sammanfattning,
          antal_belagg: input.belagg.length,
          revision: atagande.revision,
        },
      });
      return atagande;
    },
  }),

  def({
    name: 'avsluta_atagande',
    title: 'Avsluta ett åtagande med belagt skäl',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        text: safeText(2000),
        grund: ReferensSchema,
        forvantad_revision: z.number().int().nonnegative().optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const atagande = await avslutaAtagande(ctx.client, ctx.tenantId, input);
      await ctx.skrivHandelse({
        issueId: atagande.issue_id,
        verb: 'avslutade_atagande',
        payload: {
          identifier: atagande.identifier,
          skal: input.text,
          grund: input.grund,
          revision: atagande.revision,
        },
      });
      return atagande;
    },
  }),

  def({
    name: 'aterppna_atagande',
    title: 'Återöppna ett stängt åtagande med nytt belägg',
    sensitivity: 'write',
    inputSchema: z
      .object({
        identifier: IdentifierSchema,
        grund: ReferensSchema,
        nasta: NastaSchema,
        foljs_upp: z.string().datetime({ offset: true }),
      })
      .strict(),
    handler: async (ctx, input) => {
      const atagande = await aterppnaAtagande(ctx.client, ctx.tenantId, input);
      await ctx.skrivHandelse({
        issueId: atagande.issue_id,
        verb: 'aterppnade_atagande',
        payload: {
          identifier: atagande.identifier,
          grund: input.grund,
          revision: atagande.revision,
        },
      });
      return atagande;
    },
  }),

  def({
    name: 'atagande_for_beslut',
    title: 'Slå upp ett besluts huvudåtagande',
    sensitivity: 'read',
    inputSchema: z.object({ beslut_id: z.number().int().positive() }).strict(),
    handler: (ctx, input) => atagandeForBeslut(ctx.client, ctx.tenantId, input.beslut_id),
  }),

  def({
    name: 'get_atagande',
    title: 'Läs ett åtagande',
    sensitivity: 'read',
    inputSchema: z.object({ identifier: IdentifierSchema }).strict(),
    handler: (ctx, input) => hamtaAtagande(ctx.client, ctx.tenantId, input.identifier),
  }),

  def({
    name: 'list_ataganden',
    title: 'Lista åtaganden (det som kräver en människa först)',
    sensitivity: 'read',
    inputSchema: z
      .object({
        tillhor: z.enum(['agare', 'anvandare', 'hermes']).optional(),
        lage: z
          .enum(['registrerat', 'overtaget', 'hindrat', 'genomfort', 'avslutat'])
          .optional(),
        oavslutade: z.boolean().default(false),
      })
      .strict(),
    handler: (ctx, input) => listaAtaganden(ctx.client, ctx.tenantId, input),
  }),

  def({
    name: 'koppla_beslut',
    title: 'Koppla ett beslut till sitt huvudåtagande',
    sensitivity: 'write',
    inputSchema: z
      .object({ beslut_id: z.number().int().positive(), identifier: IdentifierSchema })
      .strict(),
    handler: async (ctx, input) => {
      const resultat = await kopplaBeslut(ctx.client, ctx.tenantId, input);
      await ctx.skrivHandelse({
        issueId: resultat.issue_id,
        verb: resultat.nyskapad ? 'kopplade_beslut' : 'beslutet_var_redan_kopplat',
        payload: { beslut_id: input.beslut_id, identifier: resultat.identifier },
      });
      return resultat;
    },
  }),

  def({
    name: 'registrera_svarsversion',
    title: 'Registrera att en svarsversion behandlats (spärr mot dubbelarbete)',
    sensitivity: 'write',
    inputSchema: z
      .object({
        beslut_id: z.number().int().positive(),
        svar_hash: z.string().regex(/^[0-9a-f]{16,64}$/, 'svar_hash anges som hex'),
        identifier: IdentifierSchema.optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const issueId = input.identifier
        ? (await hamtaArende(ctx.client, ctx.tenantId, input.identifier)).id
        : null;
      const { nyskapad } = await registreraSvarsversion(ctx.client, ctx.tenantId, {
        beslut_id: input.beslut_id,
        svar_hash: input.svar_hash,
        issue_id: issueId,
      });
      await ctx.skrivHandelse({
        issueId,
        verb: nyskapad ? 'behandlade_svarsversion' : 'svarsversionen_var_behandlad',
        payload: { beslut_id: input.beslut_id, svar_hash: input.svar_hash },
      });
      return { beslut_id: input.beslut_id, nyskapad };
    },
  }),

  def({
    name: 'logga_moment',
    title: 'Skriv ett arbetsmoment (aktören tas ur nyckeln)',
    sensitivity: 'write',
    inputSchema: z
      .object({
        moment: z.enum([
          'hitta_underlag',
          'avgora_riktning',
          'forbereda',
          'utfora',
          'kontrollera',
          'folja_upp',
        ]),
        identifier: IdentifierSchema.optional(),
        beslut_id: z.number().int().positive().optional(),
        belagg: z.record(z.unknown()).optional(),
        // Backfill av gammal data. Historiska rader räknas ALDRIG in i
        // mätningen efter införandet — de är påstådda, inte observerade.
        historisk: z
          .object({
            aktor_typ: AktorTypSchema,
            aktor_namn: safeText(200),
            tidpunkt: z.string().datetime({ offset: true }),
          })
          .strict()
          .optional(),
      })
      .strict()
      .refine((v) => v.identifier !== undefined || v.beslut_id !== undefined, {
        message: 'ett moment måste höra till ett ärende eller ett beslut',
      }),
    handler: async (ctx, input) => {
      const issueId = input.identifier
        ? (await hamtaArende(ctx.client, ctx.tenantId, input.identifier)).id
        : null;
      const rad = await loggaMoment(ctx.client, ctx.tenantId, ctx.aktor, {
        moment: input.moment,
        issue_id: issueId,
        beslut_id: input.beslut_id ?? null,
        belagg: input.belagg ?? {},
        ...(input.historisk ? { historisk: input.historisk } : {}),
      });
      await ctx.skrivHandelse({
        issueId,
        verb: 'skrev_arbetsmoment',
        payload: {
          moment_id: rad.id,
          moment: input.moment,
          beslut_id: input.beslut_id ?? null,
          historisk: Boolean(input.historisk),
        },
      });
      return rad;
    },
  }),

  def({
    name: 'arbetsandel',
    title: 'Davids arbetsandel, mätt på skrivna moment (aldrig på en proxy)',
    sensitivity: 'read',
    inputSchema: z
      .object({
        fran: z.string().datetime({ offset: true }),
        till: z.string().datetime({ offset: true }),
      })
      .strict(),
    handler: (ctx, input) => arbetsandel(ctx.client, ctx.tenantId, input.fran, input.till),
  }),


  // ---- Insatsen: EN kö, inte fem -----------------------------------------
  //
  // Spec: Astra 2026-09-09 §4. David: "exempel på två av tre olika ställen som
  // kräver mina svar ... Dessa ska vara samlade."
  //
  // Två saker är omöjliga här, inte avrådda: att koppla samma källobjekt till
  // två insatser, och att bokföra ett mänskligt svar med en agentnyckel.

  def({
    name: 'registrera_insats',
    title: 'Registrera ett mänskligt stopp i den gemensamma kön',
    sensitivity: 'write',
    inputSchema: z
      .object({
        stopp_id: safeText(300),
        typ: z.enum(['agarbeslut', 'utathandling', 'kundkontakt', 'godkannande', 'intygande']),
        tillhor: z.enum(['agare', 'anvandare']),
        utfall: safeText(300),
        begard_handling: safeText(2000),
        blockeringsgrund: safeText(2000),
        belagg: z.array(ReferensSchema).optional(),
        frist: z.string().datetime({ offset: true }).nullable().optional(),
        identifier: IdentifierSchema.nullable().optional(),
        handlingskontrakt: z
          .object({
            system: safeText(60),
            kommando: safeText(120),
            objekt: safeText(300),
            underlag: safeText(600).optional(),
          })
          .strict(),
        kallor: z
          .array(
            z
              .object({
                system: safeText(60),
                objekttyp: safeText(60),
                objekt_id: safeText(300),
                objekt_version: safeText(120).nullable().optional(),
                lank: safeText(600).nullable().optional(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    handler: async (ctx, input) => {
      const { insats, nyskapad, krockar } = await registreraInsats(ctx.client, ctx.tenantId, {
        ...input,
        frist: input.frist ?? null,
        identifier: input.identifier ?? null,
      });
      await ctx.skrivHandelse({
        issueId: insats.issue_id,
        verb: nyskapad ? 'registrerade_insats' : 'insatsen_fanns_redan',
        payload: {
          insats_id: insats.id,
          stopp_id: insats.stopp_id,
          typ: insats.typ,
          tillhor: insats.tillhor,
          kallor: insats.kallor.length,
          // En krock ar ett FYND: kallan hor redan till en annan insats. Den
          // flyttas aldrig i tysthet -- det ar sa en tappad koppling blir
          // osynlig, och tappade kopplingar ar hela problemet.
          krockar,
        },
      });
      return { insats, nyskapad, krockar };
    },
  }),

  def({
    name: 'besvara_insats',
    title: 'Svara på en insats (kräver en mänsklig nyckel)',
    sensitivity: 'write',
    inputSchema: z
      .object({
        id: UuidSchema,
        svar: safeText(4000),
        forvantad_version: z.number().int().positive().optional(),
      })
      .strict(),
    handler: async (ctx, input) => {
      const insats = await besvaraInsats(ctx.client, ctx.tenantId, ctx.aktor, input);
      await ctx.skrivHandelse({
        issueId: insats.issue_id,
        verb: 'besvarade_insats',
        payload: {
          insats_id: insats.id,
          typ: insats.typ,
          svar: input.svar,
          // Handlingskontraktet sager vem som ska UTFORA. Svaret utfor inget.
          handlingskontrakt: insats.handlingskontrakt,
        },
      });
      return insats;
    },
  }),

  def({
    name: 'skjut_upp_insats',
    title: 'Skjut upp en insats (ändrar väckningstid, aldrig fristen)',
    sensitivity: 'write',
    inputSchema: z
      .object({
        id: UuidSchema,
        till: z.string().datetime({ offset: true }),
        skal: safeText(500),
      })
      .strict(),
    handler: async (ctx, input) => {
      const insats = await skjutUppInsats(ctx.client, ctx.tenantId, ctx.aktor, input);
      await ctx.skrivHandelse({
        issueId: insats.issue_id,
        verb: 'skot_upp_insats',
        payload: { insats_id: insats.id, till: input.till, skal: input.skal },
      });
      return insats;
    },
  }),

  def({
    name: 'aterkalla_insats',
    title: 'Återkalla en insats som inte längre är aktuell',
    sensitivity: 'write',
    inputSchema: z.object({ id: UuidSchema, skal: safeText(500) }).strict(),
    handler: async (ctx, input) => {
      const insats = await aterkallaInsats(ctx.client, ctx.tenantId, input);
      await ctx.skrivHandelse({
        issueId: insats.issue_id,
        verb: 'aterkallade_insats',
        payload: { insats_id: insats.id, skal: input.skal },
      });
      return insats;
    },
  }),

  def({
    name: 'get_insats',
    title: 'Läs en insats',
    sensitivity: 'read',
    inputSchema: z.object({ id: UuidSchema }).strict(),
    handler: (ctx, input) => hamtaInsats(ctx.client, ctx.tenantId, input.id),
  }),

  def({
    name: 'insats_for_kalla',
    title: 'Slå upp insatsen för ett källobjekt (spärren mot dubbletter)',
    sensitivity: 'read',
    inputSchema: z
      .object({ system: safeText(60), objekttyp: safeText(60), objekt_id: safeText(300) })
      .strict(),
    handler: (ctx, input) => insatsForKalla(ctx.client, ctx.tenantId, input),
  }),

  def({
    name: 'list_insatser',
    title: 'Kön: allt som väntar på en människa, ägarfrågor först',
    sensitivity: 'read',
    inputSchema: z
      .object({
        lage: z
          .enum(['vantande', 'uppskjuten', 'svar_mottaget', 'aterkallad', 'avslutad'])
          .optional(),
        tillhor: z.enum(['agare', 'anvandare']).optional(),
        inklusive_stangda: z.boolean().default(false),
      })
      .strict(),
    handler: (ctx, input) => listaInsatser(ctx.client, ctx.tenantId, input),
  }),

];

const REGISTER = new Map<string, RegistreradAction>(ACTIONS.map((a) => [a.name, a]));

export function getAction(name: string): RegistreradAction | undefined {
  return REGISTER.get(name);
}

export function actionManifest(): { name: string; title: string; sensitivity: Sensitivity }[] {
  return ACTIONS.map((a) => ({ name: a.name, title: a.title, sensitivity: a.sensitivity }));
}
