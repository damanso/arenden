import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Aktor } from '../lib/aktor.js';
import {
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
    title: 'Uppdatera ärendets fält (prioritet, deadline, milstolpe, förälder)',
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
          v.projekt !== undefined,
        {
          message:
            'ange minst ett fält att uppdatera (priority, due, milstolpe, parent eller projekt)',
        },
      ),
    handler: async (ctx, input) => {
      const { arende, andringar } = await uppdateraArendeFalt(ctx.client, ctx.tenantId, input.identifier, {
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.due !== undefined ? { due: input.due } : {}),
        ...(input.milstolpe !== undefined ? { milstolpe: input.milstolpe } : {}),
        ...(input.parent !== undefined ? { parent: input.parent } : {}),
        ...(input.projekt !== undefined ? { projekt: input.projekt } : {}),
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
        await ctx.skrivHandelse({
          issueId: arende.id,
          verb: VERB_FOR_FALT[a.falt],
          payload: {
            identifier: arende.identifier,
            falt: a.falt,
            fran: a.fran,
            till: a.till,
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
];

const REGISTER = new Map<string, RegistreradAction>(ACTIONS.map((a) => [a.name, a]));

export function getAction(name: string): RegistreradAction | undefined {
  return REGISTER.get(name);
}

export function actionManifest(): { name: string; title: string; sensitivity: Sensitivity }[] {
  return ACTIONS.map((a) => ({ name: a.name, title: a.title, sensitivity: a.sensitivity }));
}
