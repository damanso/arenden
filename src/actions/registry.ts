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
  skapaArende,
  sokArenden,
  sokLabel,
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
import { laggTillKommentar, listaKommentarer } from '../services/kommentarer.js';
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
};

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
        bara_om_osatt: z.boolean().default(false),
      })
      .strict()
      .refine(
        (v) =>
          v.priority !== undefined ||
          v.due !== undefined ||
          v.milstolpe !== undefined ||
          v.parent !== undefined,
        { message: 'ange minst ett fält att uppdatera (priority, due, milstolpe eller parent)' },
      ),
    handler: async (ctx, input) => {
      const { arende, andringar } = await uppdateraArendeFalt(ctx.client, ctx.tenantId, input.identifier, {
        ...(input.priority !== undefined ? { priority: input.priority } : {}),
        ...(input.due !== undefined ? { due: input.due } : {}),
        ...(input.milstolpe !== undefined ? { milstolpe: input.milstolpe } : {}),
        ...(input.parent !== undefined ? { parent: input.parent } : {}),
        bara_om_osatt: input.bara_om_osatt,
      });

      // EN händelserad per FAKTISKT ändrat fält. Det är hela poängen med K-2:
      // arendehem.py ändrade 16 ärenden med rå SQL och lämnade tretton utan
      // spår. Går ändringen den här vägen är spåret inte valfritt — den som
      // skriver utan att logga får sin transaktion tillbakarullad av
      // executeAction.
      for (const a of andringar) {
        await ctx.skrivHandelse({
          issueId: arende.id,
          verb: VERB_FOR_FALT[a.falt],
          payload: { identifier: arende.identifier, falt: a.falt, fran: a.fran, till: a.till },
        });
      }
      if (andringar.length === 0) {
        // Ingen mutation skedde (värdet var redan satt, eller redan detsamma).
        // Samma mönster som tom_ko i claim_next_issue: vi loggar FÖRSÖKET, för
        // annars fälls ett korrekt no-op-svar av proveniens-tvånget.
        await ctx.skrivHandelse({
          issueId: arende.id,
          verb: 'arendet_oforandrat',
          payload: { identifier: arende.identifier },
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
];

const REGISTER = new Map<string, RegistreradAction>(ACTIONS.map((a) => [a.name, a]));

export function getAction(name: string): RegistreradAction | undefined {
  return REGISTER.get(name);
}

export function actionManifest(): { name: string; title: string; sensitivity: Sensitivity }[] {
  return ACTIONS.map((a) => ({ name: a.name, title: a.title, sensitivity: a.sensitivity }));
}
