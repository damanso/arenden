/**
 * Ärendeplattformens navigationsadapter — menyn HÄRLEDS ur kontraktet.
 *
 * Astras steg 5: "Renderarna ska läsa registret." Före det här fanns
 * produktmenyn som tre handskrivna listor i tre kodbaser, identiska tills
 * någon rörde en av dem — och ingenting mätte att de fortfarande var det.
 *
 * K-9: den här kodbasen läser sin EGNA kopia (`kontrakt/navigation.v1.json`),
 * aldrig någon annans fil. `~/.hermes/prov/adresskontraktet.py` kräver att de
 * tre kopiorna är identiska med referensen och att de tre adaptrarna räknar
 * fram samma modell — en adapter som fortsätter använda sin gamla inbyggda
 * lista faller där.
 *
 * Ikoner står INTE i kontraktet. De är lokal presentation; kontraktet äger id,
 * etikett, ordning och adress.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type KontraktUrl =
  | { kind: 'path'; value: string }
  | { kind: 'company'; template: string; resolver: string }
  | { kind: 'unresolved'; reason: string };

type Destination = {
  id: string;
  label: string;
  group_id: string;
  order: number;
  hint: string;
  canonical_url: KontraktUrl;
};

type Grupp = {
  id: string;
  label: string;
  order: number;
  hint: string;
  entry_id: string | null;
};

type Kontrakt = {
  contract_version: string;
  decision_157: 'pending' | 'yes' | 'no';
  groups: Grupp[];
  destinations: Destination[];
  surfaces: Record<string, string[]>;
};

export type Post = { id: string; label: string; hint: string; href: string | null };
export type Modell = {
  contract_version: string;
  decision_157: string;
  global: Post[];
  account: Post[];
  quick: Post[];
  groups: {
    id: string;
    label: string;
    hint: string;
    entry_id: string | null;
    entry: Post | null;
    items: Post[];
  }[];
};

// dist/http/vy -> /opt/arenden ; src/http/vy -> /opt/arenden. Samma tre steg.
const KONTRAKTSFIL = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../kontrakt/navigation.v1.json',
);

let cache: Kontrakt | null = null;

/**
 * En saknad kontraktsfil stoppar tjänsten. Det är med flit: alternativet vore
 * en tyst reservlista, och en tyst reservlista är precis det motprovet finns
 * för att fånga.
 */
export function kontraktet(): Kontrakt {
  if (!cache) {
    try {
      cache = JSON.parse(readFileSync(KONTRAKTSFIL, 'utf8')) as Kontrakt;
    } catch (e) {
      throw new Error(
        `navigationskontraktet gick inte att läsa (${KONTRAKTSFIL}): ${String(e)}` +
          ' — kör ~/.hermes/bin/sprid_kontraktet.sh',
      );
    }
  }
  return cache;
}

/**
 * Adressen för en destination. Utan bolag blir en bolagsbunden destination
 * `/app/?destination=<id>` — aldrig mallen, aldrig ett gissat bolags-id.
 */
export function adress(d: Destination, bolag?: string | null): string | null {
  const u = d.canonical_url;
  if (u.kind === 'path') return u.value;
  if (u.kind === 'company') {
    return bolag ? u.template.replace(':companyId', String(bolag)) : `/app/?destination=${d.id}`;
  }
  return null;
}

function post(d: Destination, bolag?: string | null): Post {
  return { id: d.id, label: d.label, hint: d.hint, href: adress(d, bolag) };
}

export function modell(beslut?: string | null, bolag?: string | null): Modell {
  const k = kontraktet();
  const b = beslut ?? k.decision_157;
  const perId = new Map(k.destinations.map((d) => [d.id, d]));
  // #157: vid JA lämnar Idag och Att göra den grupperade menyn. Sidorna
  // avvecklas inte — bara menyposterna. "pending beter sig som no."
  const dolda = b === 'yes' ? new Set(['crm_today', 'approvals']) : new Set<string>();

  const groups = [...k.groups]
    .sort((a, c) => a.order - c.order)
    .map((g) => ({
      id: g.id,
      label: g.label,
      hint: g.hint,
      entry_id: g.entry_id,
      // Gruppens ingang som en fardig post: rubriken ar vagen dit sedan
      // huvudraden togs bort.
      entry: g.entry_id && perId.has(g.entry_id) ? post(perId.get(g.entry_id)!, bolag) : null,
      items: k.destinations
        .filter((d) => d.group_id === g.id && d.id !== g.entry_id && !dolda.has(d.id))
        .sort((a, c) => a.order - c.order)
        .map((d) => post(d, bolag)),
    }));

  const snabb = k.surfaces[b === 'yes' ? 'accounting_quick_yes' : 'accounting_quick_pending_or_no']!;
  const ur = (ids: string[]): Post[] => ids.map((i) => post(perId.get(i)!, bolag));

  return {
    contract_version: k.contract_version,
    decision_157: b,
    global: ur(k.surfaces.global!),
    account: ur(k.surfaces.account!),
    quick: ur(snabb),
    groups,
  };
}
