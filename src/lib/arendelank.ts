// Ärendets adress (D-2, B-21, Story 11.2).
//
// TVÅ invarianter, som granskaren kan läsa av rakt här:
//   1. BARA HÄR byggs en ärendeadress. arendeSokvag ger sökvägen inom huset,
//      nummeruppslagSokvag sökningen på ett nummer som inte finns och
//      arendeLank den absoluta adressen. Ingen annan fil under src/ skriver
//      prefixet (test/djuplank.test.ts D16).
//   2. VÄRDET LÄMNAS HIT, modulen hämtar det inte. src/config.ts anropar
//      sattVyPublikUrl direkt efter att VY_PUBLIK_URL validerats. Modulen
//      importerar aldrig konfigurationen: tjänstelagret bygger läsmodellernas
//      `lank` med arendeLank, och MCP-gatewayens importgraf når tjänstelagret
//      men får aldrig nå src/config.ts (Story 4.2, F6 i test/mcp.test.ts).
//      Utan värde kastar arendeLank, så en länk blir aldrig relativ eller fel
//      i tysthet.
import { kanoniskIdentifier } from './validation.js';

export const ARENDEPREFIX = '/vy/arende/';

/**
 * Tenantens teamnycklar och de kandidater som finns, båda i kanonisk form. Typen står här, så att
 * renderaren i src/http/vy/markdown.ts inte behöver importera tjänstelagret.
 */
export type Befintliga = { readonly team: ReadonlySet<string>; readonly arenden: ReadonlySet<string> };

let publikUrl: string | null = null;

function kanonisk(identifier: string): string {
  const k = kanoniskIdentifier(identifier);
  // Anroparna skickar bara identifierare ur databasen, ur tolkningen av ett nummer, ur autolänkarens
  // mönster eller en ruttparameter som redan prövats — ett fel här är ett programmeringsfel.
  if (k === null) throw new Error(`ogiltig identifier: ${identifier}`);
  return k;
}

/** Sökvägen inom huset. Svaret har bara A–Z, 0–9 och bindestreck och behöver ingen URL-kodning. */
export function arendeSokvag(identifier: string): string {
  return ARENDEPREFIX + kanonisk(identifier);
}

/** Nummeruppslaget i /vy/sok för ett nummer som inte finns (Story 11.1 AK 4). */
export function nummeruppslagSokvag(identifier: string): string {
  return `/vy/sok?q=${encodeURIComponent(kanonisk(identifier))}`;
}

/** Anropas bara av src/config.ts, när konfigurationen laddas (D5 i test/djuplank.test.ts). */
export function sattVyPublikUrl(url: string): void {
  publikUrl = url;
}

/** Den absoluta adressen: VY_PUBLIK_URL följd av sökvägen. Härleds vid läsning och lagras aldrig. */
export function arendeLank(identifier: string): string {
  if (publikUrl === null) {
    throw new Error('VY_PUBLIK_URL är inte laddad: src/config.ts lämnar adressen hit när konfigurationen laddas');
  }
  return publikUrl + arendeSokvag(identifier);
}
