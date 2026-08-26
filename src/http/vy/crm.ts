// CRM-kopplingen i vyn (Davids precisering 19/8). Enda modulen i ärendeplattformen
// som rör redovisningen — och den LÄSER bara, med två lässignaturer.
//
// TRE invarianter, som granskaren kan läsa av rakt här:
//   1. TOKENET STANNAR I PROCESSEN. Bas-URL, company-id och agent-token läses
//      server-side ur SAMMA konfigfil som crm_ingest.py använder
//      (~/.hermes/redovisning-mcp.json). Tokenet skrivs aldrig i HTML, i en
//      länk, i en logg eller i ett felmeddelande — felen kastas bort helt, bara
//      "gick inte" behålls (se hamtaCrm).
//   2. CRM FÅR ALDRIG SÄNKA ÄRENDESIDAN (KRAV-3). 3 s timeout per hämtning och
//      EN try/catch runt allt: saknad konfigfil, trasig JSON, stängd port,
//      HTTP-fel eller oparsebart svar ger samma sak — null, som blir
//      fallbacktexten i kortet. Inget fel propagerar till sidan.
//   3. INGEN SKRIVNING. Bara crm_relation_state och list_crm_commitments, båda
//      läsande. Vyn förblir ren läsyta; kortet är GET-renderat.
import { readFile } from 'node:fs/promises';
import { config } from '../../config.js';
import { esc } from './mall.js';

// Den hårdkodade tabellen projekt -> organisationsnamn är BORTA härifrån.
//
// Den löste 173 av 339 ärenden och fanns i två kopior på två språk, utan
// något prov som band ihop dem. Framför allt var den namnbaserad, och ett
// namn är en PROXY för identitet: en exakt namnmatchning projekt ->
// organisation ger 3 träffar av 3 i dagens data, och EN av dem är fel.
// CRM-posten Hermes är arkiverad, har noll interaktioner och noll personer;
// namnmatchningen hade knutit 33 ärenden till den tomma posten och aldrig
// sagt ett ord om saken.
//
// Kopplingen bor nu i projects.kund_id (migration 0012) och bär
// redovisningens customers.id. Vägen är därmed ett ID hela vägen:
//   ärende -> projects.kund_id -> relationsradens customer_id -> organisationen.
// Organisationens NAMN hämtas ur svaret; det gissas aldrig fram härifrån.

// ---- Konfiguration och anrop ----------------------------------------------

const TIMEOUT_MS = 3_000;
const TTL_OK_MS = 5 * 60_000;
const TTL_FEL_MS = 30_000;

/** Organisationens sida i redovisningens vy: /app/c/<companyId>/relations/<orgId>. */
const CRM_VY_BAS = 'https://david-brain.tail743706.ts.net:8444';

interface Konf {
  bas: string;
  bolag: string;
  token: string;
}

function strang(varde: unknown): string | null {
  return typeof varde === 'string' && varde !== '' ? varde : null;
}

function objekt(varde: unknown): Record<string, unknown> | null {
  return typeof varde === 'object' && varde !== null ? (varde as Record<string, unknown>) : null;
}

/** Samma tre värden och samma väg genom filen som crm_ingest.redovisning(). */
async function lasKonf(): Promise<Konf> {
  const rot = objekt(JSON.parse(await readFile(config.CRM_KONF_PATH, 'utf8')));
  const env = objekt(objekt(objekt(rot?.['mcpServers'])?.['redovisning'])?.['env']);
  const bas = strang(env?.['REDOVISNING_API_URL']);
  const bolag = strang(env?.['REDOVISNING_COMPANY_ID']);
  const token = strang(env?.['REDOVISNING_AGENT_TOKEN']);
  // Felet nämner bara VILKEN nyckel som fattas — aldrig något värde.
  if (!bas || !bolag || !token) throw new Error('ofullständig CRM-konfiguration');
  return { bas: bas.replace(/\/+$/, ''), bolag, token };
}

// Räknare för hämtningar (KRAV-6e). Ren instrumentering: testet kan se att
// cachen håller utan att någon HTTP-mock införs.
let anropsraknare = 0;

export function crmAnrop(): number {
  return anropsraknare;
}

/** POST <bas>/api/companies/<bolag>/actions/<action> — samma mönster som portfolj.py. */
async function anropa(konf: Konf, action: string, input: unknown): Promise<unknown> {
  const svar = await fetch(`${konf.bas}/api/companies/${konf.bolag}/actions/${action}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${konf.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!svar.ok) throw new Error(`HTTP ${svar.status}`);
  return objekt(await svar.json())?.['result'];
}

// ---- Läget ----------------------------------------------------------------

export interface Relation {
  organization_id: string;
  /** Organisationens namn SOM CRM SÄGER att det är. Aldrig vårt eget. */
  name: string;
  status: string;
  last_contact_at: string | null;
  days_silent: number | null;
}

export interface Atagande {
  direction: string;
  body: string;
  due_date: string | null;
}

export interface CrmLage {
  bolag: string;
  /** null = organisationen är mappad men finns ännu inte i CRM. */
  relation: Relation | null;
  ataganden: Atagande[];
}

function somRelation(rad: unknown, kundId: string): Relation | null {
  const r = objekt(rad);
  // ID mot ID. Raden med rätt customer_id är rätt rad även om namnet
  // stavas om i CRM i morgon.
  if (r === null || strang(r['customer_id']) !== kundId) return null;
  const id = strang(r['organization_id']);
  const namn = strang(r['name']);
  if (id === null || namn === null) return null;
  return {
    organization_id: id,
    name: namn,
    status: strang(r['status']) ?? 'okänd',
    last_contact_at: strang(r['last_contact_at']),
    days_silent: typeof r['days_silent'] === 'number' ? r['days_silent'] : null,
  };
}

function somAtaganden(ra: unknown, orgId: string): Atagande[] {
  if (!Array.isArray(ra)) return [];
  const ut: Atagande[] = [];
  for (const rad of ra) {
    const a = objekt(rad);
    if (a === null || strang(a['organization_id']) !== orgId) continue;
    const body = strang(a['body']);
    if (body === null) continue;
    ut.push({
      direction: strang(a['direction']) ?? '',
      body,
      due_date: strang(a['due_date']),
    });
  }
  return ut;
}

interface Post {
  tid: number;
  lage: CrmLage | null;
}

// KRAV-4: in-memory per organisation. Lyckat svar lever 5 min; ett FEL cachas i
// 30 s — annars kostar en nedlagd redovisning 3 s timeout på varje sidladdning,
// men återhämtningen prövas ändå snabbt igen. Ingen persistens.
const cache = new Map<string, Post>();

/** Nollställer cachen. Finns för testerna, precis som nollstallIndex() i dokument.ts. */
export function nollstallCrmCache(): void {
  cache.clear();
  anropsraknare = 0;
}

/**
 * KRAV-3: hämtar läget för EN organisation och kan aldrig kasta. `null` betyder
 * "gick inte just nu" — orsaken kastas medvetet bort, för den kan bära
 * konfigurationsdetaljer och hör inte hemma i en läsyta.
 */
export async function hamtaCrm(kundId: string): Promise<CrmLage | null> {
  const nu = Date.now();
  const post = cache.get(kundId);
  if (post && nu - post.tid < (post.lage === null ? TTL_FEL_MS : TTL_OK_MS)) return post.lage;

  let lage: CrmLage | null = null;
  try {
    anropsraknare += 1;
    const konf = await lasKonf();
    // Båda läsningarna samtidigt — sidan väntar på den långsammaste, inte på summan.
    const [relationer, ataganden] = await Promise.all([
      anropa(konf, 'crm_relation_state', {}),
      anropa(konf, 'list_crm_commitments', { status: 'open' }),
    ]);
    const relation =
      (Array.isArray(relationer) ? relationer : [])
        .map((rad) => somRelation(rad, kundId))
        .find((r): r is Relation => r !== null) ?? null;
    lage = {
      bolag: konf.bolag,
      relation,
      // Åtagandena filtreras på det organisations-id vi LÄRDE OSS ur
      // relationsraden - inte på ett namn vi hade med oss hemifrån.
      ataganden: relation === null ? [] : somAtaganden(ataganden, relation.organization_id),
    };
  } catch {
    lage = null;
  }
  cache.set(kundId, { tid: nu, lage });
  return lage;
}

// ---- Kortet ----------------------------------------------------------------

const RIKTNING: Record<string, string> = {
  we_owe: 'vi lovade',
  they_owe: 'de lovade',
};

/** KRAV-2: allt dynamiskt genom esc() (etapp 2a KRAV-6). Tokenet finns inte här. */
export function crmKort(lage: CrmLage | null): string {
  // Ingen rubrik med organisationsnamn innan vi VET namnet. Både felvägen
  // och den okopplade vägen säger bara 'CRM' - att skriva ut ett namn vi
  // hämtat ur en egen tabell vore att påstå något vi inte vet.
  if (lage === null) {
    return '<h2>CRM</h2><p class=notis>CRM-data ej tillgänglig just nu.</p>';
  }
  if (lage.relation === null) {
    return '<h2>CRM</h2><p class=notis>Kunden finns ännu inte i CRM.</p>';
  }
  const rubrik = `<h2>CRM — ${esc(lage.relation.name)}</h2>`;

  const r = lage.relation;
  const meta = [
    r.status,
    r.last_contact_at ? `senaste kontakt ${r.last_contact_at.slice(0, 10)}` : 'ingen kontakt noterad',
    r.days_silent === null ? null : `tyst i ${r.days_silent} dagar`,
  ]
    .filter((d): d is string => d !== null)
    .join(' · ');

  const ataganden = lage.ataganden
    .map(
      (a) =>
        '<li class=rad><div class=huvud>' +
        `<span>${esc(RIKTNING[a.direction] ?? a.direction)}</span>` +
        (a.due_date ? `<span>senast ${esc(a.due_date)}</span>` : '') +
        `</div><div class=text>${esc(a.body)}</div></li>`,
    )
    .join('');

  const lank =
    `${CRM_VY_BAS}/app/c/${encodeURIComponent(lage.bolag)}` +
    `/relations/${encodeURIComponent(r.organization_id)}`;

  return (
    rubrik +
    `<p class=summering>${esc(meta)}</p>` +
    (ataganden
      ? `<ul class=lista role=list>${ataganden}</ul>`
      : '<p class=notis>Inga öppna åtaganden.</p>') +
    `<p><a href="${esc(lank)}">Öppna i CRM</a></p>`
  );
}
