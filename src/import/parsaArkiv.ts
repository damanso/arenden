// Parsar linear-arkivets markdown (KRAV-14). Ren funktion utan databas — den
// testas därför direkt mot fixturfiler.
//
// Filformatet (stickprov LOC-316.md):
//
//   ---
//   typ: linear-arkiv
//   arende: LOC-316
//   status: Backlog
//   uppdaterad: '2026-08-13 14:02'
//   skapad: '2026-08-13'
//   ---
//
//   # LOC-316 — [Väntar-extern] Daniel — Besked om ILT-konto
//
//   > **Derivat — redigera inte.** ...
//
//   **Status:** Backlog · **Projekt:** [[01-Projekt/ILT-Education/README|ILT-Education]] · **Labels:** Väntar-extern
//
//   ## Beskrivning
//   ...
//   ## Kommentarer (2)
//   ### 2026-06-24 11:39 — david mancilla
//   ...

export interface ArkivKommentar {
  /** Deterministisk idempotensnyckel: 'linear-arkiv:LOC-316#1'. */
  source_ref: string;
  tidpunkt: string;
  forfattare: string;
  body: string;
}

export interface ArkivArende {
  nummer: number;
  identifier: string;
  /** 'linear-arkiv:LOC-316' — idempotensnyckeln ur CRM-kontraktet (KRAV-16). */
  source_ref: string;
  titel: string;
  status: string;
  skapad: string;
  uppdaterad: string;
  projekt: string | null;
  labels: string[];
  beskrivning: string;
  kommentarer: ArkivKommentar[];
}

const FILNAMN = /^(LOC)-(\d+)\.md$/;

/** Filer som inte är ärenden (t.ex. `_las-mig.md`) hoppas över. */
export function arArendefil(filnamn: string): boolean {
  return FILNAMN.test(filnamn);
}

function frontmatter(text: string): Record<string, string> {
  const traff = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!traff) return {};
  const falt: Record<string, string> = {};
  for (const rad of traff[1]!.split(/\r?\n/)) {
    const m = /^([a-zA-ZåäöÅÄÖ_]+):\s*(.*)$/.exec(rad);
    if (!m) continue;
    falt[m[1]!] = m[2]!.trim().replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
  return falt;
}

/**
 * Metadataraden är den FÖRSTA raden som börjar med `**Status:**` — beskrivningar
 * kan innehålla egna "**Status:** COMPLETED"-rader (t.ex. LOC-16), och de får
 * inte förväxlas med ärendets metadata.
 */
function metadatarad(text: string): Record<string, string> {
  const rad = text.split(/\r?\n/).find((r) => r.startsWith('**Status:**'));
  if (!rad) return {};
  const falt: Record<string, string> = {};
  for (const del of rad.split(' · ')) {
    const m = /^\*\*([^:*]+):\*\*\s*(.+)$/.exec(del.trim());
    if (m) falt[m[1]!.trim()] = m[2]!.trim();
  }
  return falt;
}

/** '[[01-Projekt/ILT-Education/README|ILT-Education]]' → 'ILT-Education'. */
function projektnamn(varde: string | undefined): string | null {
  if (!varde) return null;
  const wiki = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(varde);
  if (wiki) return (wiki[2] ?? wiki[1]!.split('/').filter((d) => d !== 'README').pop() ?? '').trim() || null;
  return varde.trim() || null;
}

function avsnitt(text: string, rubrik: string): string {
  const start = new RegExp(`^## ${rubrik}\\s*$`, 'm').exec(text);
  if (!start) return '';
  const efter = text.slice(start.index + start[0].length);
  const nasta = /^## /m.exec(efter);
  return (nasta ? efter.slice(0, nasta.index) : efter).trim();
}

function parsaKommentarer(text: string, identifier: string): ArkivKommentar[] {
  const start = /^## Kommentarer.*$/m.exec(text);
  if (!start) return [];
  const kropp = text.slice(start.index + start[0].length);
  const delar = kropp.split(/^### /m).slice(1);
  const kommentarer: ArkivKommentar[] = [];
  for (const [i, del] of delar.entries()) {
    const radslut = del.indexOf('\n');
    const rubrik = (radslut === -1 ? del : del.slice(0, radslut)).trim();
    const body = (radslut === -1 ? '' : del.slice(radslut + 1)).trim();
    const m = /^(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2})?)\s+—\s+(.+)$/.exec(rubrik);
    kommentarer.push({
      source_ref: `linear-arkiv:${identifier}#${i + 1}`,
      tidpunkt: m ? m[1]! : '',
      forfattare: m ? m[2]!.trim() : rubrik,
      body: body || rubrik,
    });
  }
  return kommentarer;
}

export function parsaArkivfil(filnamn: string, innehall: string): ArkivArende {
  const namnTraff = FILNAMN.exec(filnamn);
  if (!namnTraff) throw new Error(`inte en ärendefil: ${filnamn}`);
  const nummer = Number(namnTraff[2]!);
  const identifier = `LOC-${nummer}`;

  const fm = frontmatter(innehall);
  const meta = metadatarad(innehall);

  // KRAV-14: H1-titeln efter 'LOC-N — '.
  const h1 = new RegExp(`^# ${identifier}\\s+—\\s+(.+)$`, 'm').exec(innehall);
  const titel = (h1?.[1] ?? /^# (.+)$/m.exec(innehall)?.[1] ?? identifier).trim();

  const labels = (meta['Labels'] ?? '')
    .split(',')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  return {
    nummer,
    identifier,
    source_ref: `linear-arkiv:${identifier}`,
    titel,
    status: (meta['Status'] ?? fm['status'] ?? 'Backlog').trim(),
    skapad: fm['skapad'] ?? '',
    uppdaterad: fm['uppdaterad'] ?? fm['skapad'] ?? '',
    projekt: projektnamn(meta['Projekt']),
    labels,
    beskrivning: avsnitt(innehall, 'Beskrivning'),
    kommentarer: parsaKommentarer(innehall, identifier),
  };
}
