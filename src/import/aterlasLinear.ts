// K-2 och K-3: läser tillbaka de fält importen tappade.
//
//   npm run aterlas -- [--fil <sökväg>] [--fas falt|hierarki|relationer|bilagor|milstolpe|allt]
//
// Källan är en fullständig hämtning ur Linear (312 ärenden, 2026-08-26) med
// priority, dueDate, parent, relations, attachments och projectMilestone —
// allt som den markdown-baserade arkivimporten aldrig såg. Ett arkiv lästes en
// gång som om det VORE Linear; det var så fälten försvann.
//
// TRE egenskaper:
//  1. Varje skrivning går genom executeAction — plattformens enda väg in. Den
//     vägrar committa en write-action utan event-rad, så återläsningen KAN inte
//     bli den tysta väg förbi loggen som rå SQL blev.
//  2. Idempotent: fälten skrivs med bara_om_osatt, relationer och bilagor med
//     ON CONFLICT. En omkörning ändrar noll rader.
//  3. Prioritetsskalan KONTROLLERAS mot priorityLabel innan något skrivs. En
//     felmappad prioritet ser ut precis som en rätt, så gissningen får inte
//     finnas: stämmer inte en enda etikett avbryts hela körningen.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeAction } from '../actions/execute.js';
import { closePool } from '../db/pool.js';
import { withTransaction } from '../db/tx.js';
import type { Aktor } from '../lib/aktor.js';
import { TENANT_ID } from '../lib/tenant.js';
import { listaArendenMedSourceRef, type Arende } from '../services/arenden.js';
import { befintligaBilageRefs, befintligaRelationsRefs } from '../services/relationer.js';

export const DEFAULT_KALLA =
  '/home/hermes/brain/02-Områden/hermes/raddat/linear-fullstandig-2026-08-26.json';

const ATERLASAKTOR: Aktor = { typ: 'system', namn: 'linear-aterlasning' };

/** Samma nyckel som importen byggde (KRAV-16): 'linear-arkiv:LOC-316'. */
function sourceRef(identifier: string): string {
  return `linear-arkiv:${identifier}`;
}

// ---- Källans form ----------------------------------------------------------

interface Nodlista<T> {
  nodes?: T[] | null;
}

export interface LinearArende {
  identifier: string;
  title?: string;
  priority?: number | null;
  priorityLabel?: string | null;
  dueDate?: string | null;
  parent?: { identifier: string } | null;
  relations?: Nodlista<{ type: string; relatedIssue: { identifier: string } }> | null;
  attachments?: Nodlista<{
    title: string;
    url: string;
    subtitle?: string | null;
    createdAt?: string | null;
  }> | null;
  projectMilestone?: { name: string } | null;
}

function noder<T>(lista: Nodlista<T> | null | undefined): T[] {
  return lista?.nodes ?? [];
}

/**
 * Linears skala är 0–4 där 0 betyder "ingen prioritet"; plattformens CHECK är
 * 1–4. Kartan nedan är alltså identitet för 1–4 och "skriv ingenting" för 0 —
 * MEN bara om etiketterna stämmer. Sista kolumnen är plattformens egen text
 * (prioNamn i vy/mall.ts), som ligger här för att en läsare ska kunna se att
 * de två skalorna är samma skala och inte två som råkar ha samma siffror.
 */
const PRIORITETSKARTA: { linear: number; label: string; plattform: number | null; text: string }[] = [
  { linear: 0, label: 'No priority', plattform: null, text: 'ingen prio' },
  { linear: 1, label: 'Urgent', plattform: 1, text: 'Brådskande' },
  { linear: 2, label: 'High', plattform: 2, text: 'Hög' },
  { linear: 3, label: 'Medium', plattform: 3, text: 'Normal' },
  { linear: 4, label: 'Low', plattform: 4, text: 'Låg' },
];

/**
 * Kontrollerar HELA källan mot kartan innan en enda rad skrivs. Ett okänt
 * prioritetsvärde eller en etikett som inte hör ihop med sitt värde betyder att
 * skalan inte är den vi tror — och då är varje skriven prioritet en gissning.
 */
export function kontrolleraPrioritetsskalan(arenden: LinearArende[]): void {
  const kanda = new Map(PRIORITETSKARTA.map((p) => [p.linear, p.label]));
  const avvikande: string[] = [];
  for (const a of arenden) {
    const varde = a.priority ?? 0;
    const forvantad = kanda.get(varde);
    if (forvantad === undefined) {
      avvikande.push(`${a.identifier}: okänt prioritetsvärde ${JSON.stringify(a.priority)}`);
    } else if (a.priorityLabel !== undefined && a.priorityLabel !== null && a.priorityLabel !== forvantad) {
      avvikande.push(
        `${a.identifier}: priority=${varde} bär etiketten ${JSON.stringify(a.priorityLabel)}, ` +
          `förväntat ${JSON.stringify(forvantad)}`,
      );
    }
  }
  if (avvikande.length > 0) {
    throw new Error(
      `prioritetsskalan i källan stämmer inte med kartan — vägrar skriva ${arenden.length} ärenden ` +
        `på en gissning. Avvikelser (${avvikande.length}): ${avvikande.slice(0, 5).join('; ')}`,
    );
  }
}

/** Linears priority → plattformens priority. 0/saknad ⇒ null (skriv ingenting). */
export function plattformensPrioritet(linear: number | null | undefined): number | null {
  return PRIORITETSKARTA.find((p) => p.linear === (linear ?? 0))?.plattform ?? null;
}

// ---- Resultat --------------------------------------------------------------

export type Fas = 'falt' | 'hierarki' | 'relationer' | 'bilagor' | 'milstolpe' | 'allt';

export interface AterlasResultat {
  arenden_i_kallan: number;
  arenden_i_plattformen: number;
  /** Ärenden i källan utan motsvarighet i plattformen (dinglande referenser). */
  saknade: string[];
  prioritet_satta: number;
  prioritet_redan_satta: number;
  deadline_satta: number;
  deadline_redan_satta: number;
  foralder_satta: number;
  relationer_nya: number;
  relationer_fanns_redan: number;
  bilagor_nya: number;
  bilagor_fanns_redan: number;
  milstolpe_satta: number;
}

function tomtResultat(): AterlasResultat {
  return {
    arenden_i_kallan: 0,
    arenden_i_plattformen: 0,
    saknade: [],
    prioritet_satta: 0,
    prioritet_redan_satta: 0,
    deadline_satta: 0,
    deadline_redan_satta: 0,
    foralder_satta: 0,
    relationer_nya: 0,
    relationer_fanns_redan: 0,
    bilagor_nya: 0,
    bilagor_fanns_redan: 0,
    milstolpe_satta: 0,
  };
}

/** source_ref → ärendet i plattformen. Läses om inför varje fas. */
async function plattformskarta(sourceRefs: string[]): Promise<Map<string, Arende>> {
  const arenden = await withTransaction((client) =>
    listaArendenMedSourceRef(client, TENANT_ID, sourceRefs),
  );
  return new Map(arenden.map((a) => [a.source_ref!, a]));
}

async function kor(actionName: string, input: unknown): Promise<unknown> {
  const { result } = await executeAction({ aktor: ATERLASAKTOR, actionName, input });
  return result;
}

interface Andringssvar {
  andringar: { falt: string }[];
}

// ---- Faserna ---------------------------------------------------------------

export async function aterlasLinear(
  fil: string,
  fas: Fas = 'allt',
  log: (msg: string) => void = () => {},
): Promise<AterlasResultat> {
  const rot = JSON.parse(await readFile(fil, 'utf8')) as { arenden?: LinearArende[] };
  const kallan = rot.arenden ?? [];
  if (kallan.length === 0) throw new Error(`${fil} innehåller inga ärenden under nyckeln "arenden"`);

  // FÖRE allt annat: bevisa att skalan är den vi tror.
  kontrolleraPrioritetsskalan(kallan);

  const resultat = tomtResultat();
  resultat.arenden_i_kallan = kallan.length;

  const refs = kallan.map((a) => sourceRef(a.identifier));
  let karta = await plattformskarta(refs);
  resultat.arenden_i_plattformen = karta.size;
  resultat.saknade = kallan.filter((a) => !karta.has(sourceRef(a.identifier))).map((a) => a.identifier);
  if (resultat.saknade.length > 0) {
    log(`VARNING: ${resultat.saknade.length} ärenden i källan saknar motsvarighet i plattformen`);
  }

  const finns = (a: LinearArende): Arende | undefined => karta.get(sourceRef(a.identifier));
  const gor = (namn: Fas): boolean => fas === 'allt' || fas === namn;

  // ---- K-2: prioritet och deadline ----------------------------------------
  if (gor('falt')) {
    for (const kalla of kallan) {
      const arende = finns(kalla);
      if (!arende) continue;
      const prioritet = plattformensPrioritet(kalla.priority);
      const deadline = kalla.dueDate ?? null;

      // Ärenden som REDAN bär värdet rörs inte — och de räknas, så att
      // "hoppade över" är en mätning och inte ett antagande.
      const skrivPrio = prioritet !== null && arende.priority === null;
      const skrivDue = deadline !== null && arende.due_date === null;
      if (prioritet !== null && arende.priority !== null) resultat.prioritet_redan_satta += 1;
      if (deadline !== null && arende.due_date !== null) resultat.deadline_redan_satta += 1;
      if (!skrivPrio && !skrivDue) continue;

      const svar = (await kor('update_issue', {
        identifier: arende.identifier,
        ...(skrivPrio ? { priority: prioritet } : {}),
        ...(skrivDue ? { due: deadline } : {}),
        bara_om_osatt: true,
      })) as Andringssvar;
      for (const a of svar.andringar) {
        if (a.falt === 'priority') resultat.prioritet_satta += 1;
        if (a.falt === 'due_date') resultat.deadline_satta += 1;
      }
    }
    log(
      `falt: ${resultat.prioritet_satta} prioriteter satta ` +
        `(${resultat.prioritet_redan_satta} rördes inte), ` +
        `${resultat.deadline_satta} deadlines satta (${resultat.deadline_redan_satta} rördes inte)`,
    );
  }

  // ---- K-3: förälder/barn -------------------------------------------------
  if (gor('hierarki')) {
    karta = await plattformskarta(refs);
    for (const kalla of kallan) {
      const arende = karta.get(sourceRef(kalla.identifier));
      const foralder = kalla.parent ? karta.get(sourceRef(kalla.parent.identifier)) : undefined;
      if (!arende || !kalla.parent) continue;
      if (!foralder) {
        log(`VARNING: ${kalla.identifier} pekar på föräldern ${kalla.parent.identifier} som saknas`);
        continue;
      }
      if (arende.foralder_identifier !== null) continue;
      const svar = (await kor('update_issue', {
        identifier: arende.identifier,
        parent: foralder.identifier,
        bara_om_osatt: true,
      })) as Andringssvar;
      resultat.foralder_satta += svar.andringar.filter((a) => a.falt === 'foralder').length;
    }
    log(`hierarki: ${resultat.foralder_satta} föräldrakopplingar satta`);
  }

  // ---- K-3: relationer ----------------------------------------------------
  if (gor('relationer')) {
    karta = await plattformskarta(refs);
    const redan = await withTransaction((client) => befintligaRelationsRefs(client, TENANT_ID));
    for (const kalla of kallan) {
      const arende = karta.get(sourceRef(kalla.identifier));
      if (!arende) continue;
      for (const rel of noder(kalla.relations)) {
        const motpart = karta.get(sourceRef(rel.relatedIssue.identifier));
        if (!motpart) {
          log(`VARNING: ${kalla.identifier} relaterar till ${rel.relatedIssue.identifier} som saknas`);
          continue;
        }
        if (rel.type !== 'related' && rel.type !== 'blocks') {
          log(`VARNING: ${kalla.identifier} bär okänd relationstyp ${JSON.stringify(rel.type)} — hoppas över`);
          continue;
        }
        const ref = `linear-arkiv:${arende.identifier}|${rel.type}|${motpart.identifier}`;
        // Redan lagd: hoppa över UTAN att anropa actionen. Ett anrop hade
        // svarat "fanns redan" och skrivit en händelserad om det — och en
        // omkörning ska inte kosta loggen någonting.
        if (redan.has(ref)) {
          resultat.relationer_fanns_redan += 1;
          continue;
        }
        const svar = (await kor('link_issues', {
          fran: arende.identifier,
          till: motpart.identifier,
          typ: rel.type,
          source_ref: ref,
        })) as { nyskapad: boolean };
        if (svar.nyskapad) resultat.relationer_nya += 1;
        else resultat.relationer_fanns_redan += 1;
      }
    }
    log(
      `relationer: ${resultat.relationer_nya} nya, ` +
        `${resultat.relationer_fanns_redan} fanns redan`,
    );
  }

  // ---- K-3: bilagor -------------------------------------------------------
  if (gor('bilagor')) {
    karta = await plattformskarta(refs);
    const redan = await withTransaction((client) => befintligaBilageRefs(client, TENANT_ID));
    for (const kalla of kallan) {
      const arende = karta.get(sourceRef(kalla.identifier));
      if (!arende) continue;
      for (const bilaga of noder(kalla.attachments)) {
        const ref = `linear-arkiv:${arende.identifier}|bilaga|${bilaga.url}`;
        if (redan.has(ref)) {
          resultat.bilagor_fanns_redan += 1;
          continue;
        }
        const svar = (await kor('add_attachment', {
          identifier: arende.identifier,
          titel: bilaga.title,
          url: bilaga.url,
          ...(bilaga.subtitle ? { undertitel: bilaga.subtitle } : {}),
          source_ref: ref,
          ...(bilaga.createdAt ? { skapad: bilaga.createdAt } : {}),
        })) as { nyskapad: boolean };
        if (svar.nyskapad) resultat.bilagor_nya += 1;
        else resultat.bilagor_fanns_redan += 1;
      }
    }
    log(`bilagor: ${resultat.bilagor_nya} nya, ${resultat.bilagor_fanns_redan} fanns redan`);
  }

  // ---- K-3: milstolpe -----------------------------------------------------
  if (gor('milstolpe')) {
    karta = await plattformskarta(refs);
    for (const kalla of kallan) {
      const arende = karta.get(sourceRef(kalla.identifier));
      if (!arende || !kalla.projectMilestone) continue;
      if (arende.milstolpe !== null) continue;
      const svar = (await kor('update_issue', {
        identifier: arende.identifier,
        milstolpe: kalla.projectMilestone.name,
        bara_om_osatt: true,
      })) as Andringssvar;
      resultat.milstolpe_satta += svar.andringar.filter((a) => a.falt === 'milstolpe').length;
    }
    log(`milstolpe: ${resultat.milstolpe_satta} satta`);
  }

  return resultat;
}

// ---- CLI ----
const isCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

const GILTIGA_FASER: Fas[] = ['falt', 'hierarki', 'relationer', 'bilagor', 'milstolpe', 'allt'];

if (isCli) {
  const argv = process.argv.slice(2);
  const flagga = (namn: string): string | undefined => {
    const i = argv.indexOf(`--${namn}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const fil = flagga('fil') ?? DEFAULT_KALLA;
  const rafas = flagga('fas') ?? 'allt';
  if (!GILTIGA_FASER.includes(rafas as Fas)) {
    console.error(`FATAL: okänd fas ${rafas} (giltiga: ${GILTIGA_FASER.join(', ')})`);
    process.exit(1);
  }
  try {
    const resultat = await aterlasLinear(fil, rafas as Fas, (msg) => console.log(msg));
    console.log(JSON.stringify(resultat, null, 2));
  } catch (err) {
    console.error(`FATAL: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}
