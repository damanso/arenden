// FR-24 (d), B-19, Story 4.2: verktygen som en Claude-session når genom MCP-gatewayen.
//
// FYRA invarianter, som granskaren kan läsa av rakt här:
//  1. Listan är SLUTEN. VERKTYGSNAMN har de sju namnen i B-19 och växer inte av att registret växer.
//     byggVerktyg() kastar om registret saknar ett av dem, så listan kan heller aldrig bli kortare i
//     tysthet.
//  2. Namn, titel och läs/skriv kommer ur actionManifest(), aldrig ur en egen kopia, så att verktyget
//     och actionen inte kan glida isär.
//  3. Indata är en TILLÅTELSELISTA: varje verktyg har exakt registrets indatafält, och inget av dem är
//     ett aktörsfält. Aktören tar API:t ur sessionens nyckel, som för varje annan klient (FR-4).
//     Typer, mönster och gränser prövar API:t med registrets strikta scheman; här står bara det Claude
//     behöver för att skicka rätt fält.
//  4. API:t anropas BARA härifrån, av postaAction(), med ett av de sju namnen (genom anropaApi(), den
//     funna postens namn) eller vem_ar_jag (genom fragaVemArJag(), Story 4.3).
import { actionManifest } from '../actions/registry.js';

/** B-19:s slutna lista, i B-19:s ordning. */
export const VERKTYGSNAMN = [
  'get_issue',
  'list_issues',
  'search_issues',
  'create_issue',
  'add_comment',
  'update_issue',
  'update_issue_state',
] as const;

export type Verktygsnamn = (typeof VERKTYGSNAMN)[number];

/** Ett handskrivet JSON-schema för en egenskap. zod 3 kan inte skriva ut JSON-schema själv. */
type Egenskap = Readonly<Record<string, unknown>>;

interface Indataschema {
  type: 'object';
  properties: Readonly<Record<string, Egenskap>>;
  required: readonly string[];
  additionalProperties: false;
}

export interface Verktyg {
  name: Verktygsnamn;
  title: string;
  description: string;
  inputSchema: Indataschema;
  annotations: { readOnlyHint: boolean };
}

// Byggstenarna följer registrets typer: sträng, heltal med gränser, boolesk, enum för tillståndstypen
// och null där registret tar nullable.
const STRANG: Egenskap = { type: 'string' };
const STRANG_ELLER_NULL: Egenskap = { type: ['string', 'null'] };
const GRANS: Egenskap = { type: 'integer', minimum: 1, maximum: 100 };
const PRIORITET: Egenskap = { type: 'integer', minimum: 1, maximum: 4 };
const STATE_TYP: Egenskap = {
  type: 'string',
  enum: ['backlog', 'unstarted', 'started', 'completed', 'canceled'],
};

interface Indata {
  egenskaper: Record<string, Egenskap>;
  kravs: readonly string[];
}

/** Varje verktygs egenskaper, i registrets ordning, och de som krävs (src/actions/registry.ts). */
const INDATA: Readonly<Record<Verktygsnamn, Indata>> = {
  get_issue: { egenskaper: { identifier: STRANG }, kravs: ['identifier'] },
  list_issues: {
    egenskaper: {
      state_typer: { type: 'array', items: STATE_TYP, minItems: 1, maxItems: 5 },
      team_key: STRANG,
      label: STRANG,
      projekt: STRANG,
      kund_id: STRANG,
      cursor: STRANG,
      limit: GRANS,
    },
    kravs: [],
  },
  search_issues: { egenskaper: { fraga: STRANG, limit: GRANS }, kravs: ['fraga'] },
  create_issue: {
    egenskaper: {
      title: STRANG,
      description: STRANG,
      team_key: STRANG,
      labels: { type: 'array', items: STRANG, maxItems: 20 },
      priority: PRIORITET,
      due: STRANG,
      projekt: STRANG,
    },
    kravs: ['title', 'team_key'],
  },
  add_comment: { egenskaper: { identifier: STRANG, body: STRANG }, kravs: ['identifier', 'body'] },
  update_issue: {
    egenskaper: {
      identifier: STRANG,
      priority: { type: ['integer', 'null'], minimum: 1, maximum: 4 },
      due: STRANG_ELLER_NULL,
      milstolpe: STRANG_ELLER_NULL,
      parent: STRANG_ELLER_NULL,
      projekt: STRANG_ELLER_NULL,
      title: STRANG,
      description: STRANG_ELLER_NULL,
      skal: STRANG,
      bara_om_osatt: { type: 'boolean' },
    },
    kravs: ['identifier'],
  },
  update_issue_state: {
    egenskaper: { identifier: STRANG, state_typ: STATE_TYP, state_id: STRANG },
    kravs: ['identifier'],
  },
};

/**
 * Verktygen ur registrets manifest, i VERKTYGSNAMN:s ordning. Ett namn som saknas i manifestet är ett
 * fel och inte ett verktyg mindre (invariant 1). Listan och varje post är frysta.
 */
export function byggVerktyg(manifest: ReturnType<typeof actionManifest>): readonly Verktyg[] {
  return Object.freeze(
    VERKTYGSNAMN.map((namn): Verktyg => {
      const post = manifest.find((a) => a.name === namn);
      if (!post) throw new Error(`verktyget ${namn} saknas i registret`);
      const indata = INDATA[namn];
      return Object.freeze({
        name: namn,
        title: post.title,
        description: post.title,
        inputSchema: Object.freeze({
          type: 'object' as const,
          properties: Object.freeze({ ...indata.egenskaper }),
          required: Object.freeze([...indata.kravs]),
          additionalProperties: false as const,
        }),
        annotations: Object.freeze({ readOnlyHint: post.sensitivity === 'read' }),
      });
    }),
  );
}

export const VERKTYG: readonly Verktyg[] = byggVerktyg(actionManifest());

const UPPSLAG: Readonly<Record<string, Verktyg>> = Object.freeze(
  Object.fromEntries(VERKTYG.map((v): [string, Verktyg] => [v.name, v])),
);

/**
 * AK 4: den enda vägen in. Posten när `namn` är en sträng och tabellen har den som EGEN egenskap, så att
 * ett ärvt namn (`toString`, `__proto__`) aldrig blir ett verktyg; annars undefined.
 */
export function hittaVerktyg(namn: unknown): Verktyg | undefined {
  return typeof namn === 'string' && Object.hasOwn(UPPSLAG, namn) ? UPPSLAG[namn] : undefined;
}

/** AK 3: nycklarna i `args` som inte står i verktygets egenskaper, i ordning. Tom lista = indata godtas. */
export function otillatnaFalt(verktyg: Verktyg, args: Record<string, unknown>): string[] {
  return Object.keys(args).filter((nyckel) => !Object.hasOwn(verktyg.inputSchema.properties, nyckel));
}

// ---- Anropet och svaret (Uppgift 3) -----------------------------------------------------------------

/** Ett verktygsresultat. Ett fel i verktygets utförande är ett resultat med isError (MCP), inget JSON-RPC-fel. */
export interface Verktygsresultat {
  content: { type: 'text'; text: string }[];
  isError: boolean;
}

/** Formen av API:ts felkoder (snake_case). Något annat förs aldrig vidare som felkod. */
const FELKOD = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_DETALJER = 20;
const MAX_MEDDELANDE = 300;
const TIDSGRANS_MS = 10_000;
const SVARADE_INTE = 'Ärende-API:t svarade inte. Försök igen senare.';

const resultat = (text: string, isError: boolean): Verktygsresultat => ({
  content: [{ type: 'text', text }],
  isError,
});

const arObjekt = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * AK 5: verktygsresultatet ur API:ts svar. Vid 2xx är texten kroppens `result` som JSON. Annars byggs
 * texten av en fast mall med bara fyra värden: HTTP-statusen, felkoden ur `error` (bara när den har
 * felkodens form, annars okant_fel), `details` (bara `path` och `message`, som API:ts felhanterare redan
 * begränsar till zods sökväg och meddelande) och siffrorna i Retry-After. Inget annat ur svaret, och
 * aldrig något ur ett fångat fel, når sessionen. `kropp` är undefined när svaret inte var JSON.
 */
export function tolkaSvar(status: number, retryAfter: string | null, kropp: unknown): Verktygsresultat {
  const svar: Record<string, unknown> = arObjekt(kropp) ? kropp : {};
  if (status >= 200 && status < 300) {
    return Object.hasOwn(svar, 'result')
      ? resultat(JSON.stringify(svar['result']) ?? 'null', false)
      : resultat(SVARADE_INTE, true);
  }

  const felet = svar['error'];
  const kod = typeof felet === 'string' && FELKOD.test(felet) ? felet : 'okant_fel';
  let text = `Ärende-API:t svarade ${status} med felkoden ${kod}.`;
  // Uppgift 4: API:ts gräns. Bara ett Retry-After av siffror blir ett antal sekunder; ett datum eller
  // inget huvud ger inget tillägg.
  if (status === 429 && retryAfter !== null && /^\d+$/.test(retryAfter)) {
    text += ` Försök igen om ${retryAfter} sekunder.`;
  }

  const detaljer = svar['details'];
  if (kod === 'validation_error' && Array.isArray(detaljer) && detaljer.length > 0) {
    const rader = detaljer.slice(0, MAX_DETALJER).map((post: unknown) => {
      const sokvag = arObjekt(post) ? post['path'] : undefined;
      const meddelande = arObjekt(post) ? post['message'] : undefined;
      const falt = typeof sokvag === 'string' && sokvag !== '' ? sokvag : '(indata)';
      return `- ${falt}: ${typeof meddelande === 'string' ? meddelande.slice(0, MAX_MEDDELANDE) : ''}`;
    });
    text += `\nFält som inte godtogs:\n${rader.join('\n')}`;
  }
  return resultat(text, true);
}

/** Svaret ur API:t: statusen, Retry-After och kroppen (undefined när den inte var JSON). */
interface Apisvar {
  status: number;
  retryAfter: string | null;
  kropp: unknown;
}

/**
 * Den ENDA funktionen som anropar plattformen (invariant 4): POST mot /api/actions/ följt av namnet,
 * med nyckeln som bearer. Namnet är ett av de sju eller vem_ar_jag, aldrig strängen i en begäran, och
 * nyckeln hamnar aldrig i adressen. Ett kastat fel (nätet, tidsgränsen) ger 'svarade_inte', och inget ur
 * felet förs vidare (docs/project-context.md rad 93).
 */
async function postaAction(
  apiUrl: string,
  nyckel: string,
  namn: Verktygsnamn | 'vem_ar_jag',
  indata: Record<string, unknown>,
): Promise<Apisvar | 'svarade_inte'> {
  try {
    const svar = await fetch(`${apiUrl}/api/actions/${namn}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${nyckel}` },
      body: JSON.stringify(indata),
      signal: AbortSignal.timeout(TIDSGRANS_MS),
    });
    let kropp: unknown;
    try {
      kropp = await svar.json();
    } catch {
      kropp = undefined;
    }
    return { status: svar.status, retryAfter: svar.headers.get('retry-after'), kropp };
  } catch {
    return 'svarade_inte';
  }
}

/**
 * Utfallet av ett verktygsanrop: ett verktygsresultat, eller 'nyckeln_avvisad' när API:t svarade 401 för
 * sessionens nyckel (Story 4.3 AK 4). Det senare är inget verktygsfel utan sessionens slut.
 */
export type Anropsutfall = Verktygsresultat | 'nyckeln_avvisad';

/**
 * Verktygsanropet: den funna postens namn med sessionens nyckel, genom postaAction(). Ett API som inte
 * svarar ger alltid samma fasta text, och en oläsbar kropp vid 2xx likaså (tolkaSvar() utan result).
 */
export async function anropaApi(anrop: {
  apiUrl: string;
  nyckel: string;
  namn: Verktygsnamn;
  indata: Record<string, unknown>;
}): Promise<Anropsutfall> {
  const svar = await postaAction(anrop.apiUrl, anrop.nyckel, anrop.namn, anrop.indata);
  if (svar === 'svarade_inte') return resultat(SVARADE_INTE, true);
  // Story 4.3 AK 4: API:t svarar 401 bara ur autentiseringen, när nyckeln är okänd eller återkallad. Den
  // signalen prövas före tolkaSvar(), så att den aldrig blir ett verktygsresultat.
  if (svar.status === 401) return 'nyckeln_avvisad';
  return tolkaSvar(svar.status, svar.retryAfter, svar.kropp);
}

/** Nyckelns aktör, som vem_ar_jag ger den. */
export interface NyckelnsAktor {
  aktor_typ: 'manniska' | 'agent' | 'system';
  aktor_namn: string;
}

const arAktorstyp = (v: unknown): v is NyckelnsAktor['aktor_typ'] =>
  v === 'manniska' || v === 'agent' || v === 'system';

/**
 * Story 4.3, B-19 punkt 2: vem nyckeln är, enligt API:t. 200 med ett `result` som har exakt aktor_typ och
 * aktor_namn ger aktören; 401 (nyckeln är okänd eller återkallad) ger 'okand'; allt annat, också ett API
 * som inte svarar, ger 'svarade_inte'. Gatewayen avgör alltså aldrig själv vem en nyckel tillhör.
 */
export async function fragaVemArJag(
  apiUrl: string,
  nyckel: string,
): Promise<NyckelnsAktor | 'okand' | 'svarade_inte'> {
  const svar = await postaAction(apiUrl, nyckel, 'vem_ar_jag', {});
  if (svar === 'svarade_inte') return 'svarade_inte';
  if (svar.status === 401) return 'okand';
  const result = svar.status === 200 && arObjekt(svar.kropp) ? svar.kropp['result'] : undefined;
  // Exakt de två fälten: ett svar med något mer eller mindre godtas inte.
  if (!arObjekt(result) || Object.keys(result).sort().join(',') !== 'aktor_namn,aktor_typ') {
    return 'svarade_inte';
  }
  const typ = result['aktor_typ'];
  const namn = result['aktor_namn'];
  if (!arAktorstyp(typ) || typeof namn !== 'string') return 'svarade_inte';
  return { aktor_typ: typ, aktor_namn: namn };
}
