// Autolänkning och enkel markdown för vyn (Dokumentlänkar).
//
// TVÅ regler, och de är samma som resten av vylagret vilar på:
//   1. KRAV-6 (etapp 2a): ALL text som kommer från databasen eller vaulten går
//      genom esc() i mall.js. Funktionerna här producerar HTML, så escapen sker
//      per textbit: varje råtextfragment escapas, och den enda HTML som slipper
//      förbi är taggar den här filen själv bygger.
//   2. KRAV-3: en referens till ett dokument UTANFÖR vitlistan — eller ett
//      filnamn som finns på flera ställen — lämnas som ren text. Ingen
//      markering, ingen titel, inget som avslöjar att dokumentet finns.
//
// Autolänkningen sker i RENDERINGSSTEGET. Beskrivningar, kommentarer och
// databasen rörs inte.
import { vitlistad, type Dokumentindex } from './dokument.js';
import { esc } from './mall.js';

// Mönstren delas mellan de två lägena och plockas isär via namngivna grupper.
const WIKI = String.raw`\[\[(?<mal>[^\[\]|#]+)(?:#[^\[\]|]*)?(?:\|(?<alias>[^\[\]]*))?\]\]`;
const SOKVAG = String.raw`(?<sokvag>[\p{L}\p{N}_][\p{L}\p{N}_.\-/]*\.md)\b`;
const ARENDE = String.raw`\b(?<arende>LOC-\d+)\b`;
const KOD = String.raw`\x60(?<kod>[^\x60\n]+)\x60`;
const FET = String.raw`\*\*(?<fet>[^*\n]+)\*\*`;
const MDLANK = String.raw`\[(?<mdtext>[^\[\]]+)\]\((?<mdurl>[^()\s]+)\)`;

// Ärendetexter: BARA länkar. Ingen fetstil — ärendebeskrivningarna visas som de
// är skrivna (pre-wrap), precis som i etapp 2a.
const LANKAR = new RegExp(`${WIKI}|${SOKVAG}|${ARENDE}`, 'gu');
// Dokumentsidan: samma länkar plus den lilla markdownen.
const MARKDOWN = new RegExp(`${KOD}|${FET}|${WIKI}|${MDLANK}|${SOKVAG}|${ARENDE}`, 'gu');

export function dokUrl(rel: string): string {
  return `/vy/dok/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

/** KRAV-3/4: ärendebeskrivningar och kommentarer — escapad text med länkar. */
export function autolanka(text: string, index: Dokumentindex): string {
  return lankaText(text, index, LANKAR);
}

/**
 * En traversering, aldrig två: matchningarna byggs till HTML och texten mellan
 * dem escapas. Genererad HTML skannas därför aldrig om.
 */
function lankaText(text: string, index: Dokumentindex, monster: RegExp): string {
  let ut = '';
  let sist = 0;
  monster.lastIndex = 0;
  for (let m = monster.exec(text); m !== null; m = monster.exec(text)) {
    ut += esc(text.slice(sist, m.index));
    ut += ersatt(m.groups ?? {}, m[0], index);
    sist = m.index + m[0].length;
  }
  return ut + esc(text.slice(sist));
}

function ersatt(
  g: Record<string, string | undefined>,
  hel: string,
  index: Dokumentindex,
): string {
  if (g['kod'] !== undefined) return `<code>${esc(g['kod'])}</code>`;
  if (g['fet'] !== undefined) return `<b>${esc(g['fet'])}</b>`;
  if (g['mal'] !== undefined) {
    const alias = g['alias']?.trim();
    return dokumentlank(g['mal'], alias === undefined || alias === '' ? g['mal'] : alias, hel, index);
  }
  if (g['mdurl'] !== undefined) {
    const url = g['mdurl'];
    const text = g['mdtext'] ?? url;
    // Bara http(s) släpps ut som extern länk — aldrig javascript:/data:.
    if (/^https?:\/\//i.test(url)) {
      return `<a href="${esc(url)}" rel="noreferrer noopener">${esc(text)}</a>`;
    }
    return dokumentlank(url, text, hel, index);
  }
  if (g['sokvag'] !== undefined) return dokumentlank(g['sokvag'], g['sokvag'], hel, index);
  if (g['arende'] !== undefined) {
    return `<a href="/vy/arende/${esc(g['arende'])}">${esc(g['arende'])}</a>`;
  }
  return esc(hel);
}

function dokumentlank(
  mal: string,
  text: string,
  hel: string,
  index: Dokumentindex,
): string {
  const rel = losUpp(mal, index);
  // KRAV-3: utanför vitlistan eller tvetydigt → ren text, oskiljaktigt från
  // vilken annan text som helst.
  if (rel === null) return esc(hel);
  return `<a href="${esc(dokUrl(rel))}">${esc(text)}</a>`;
}

/** Referens → vaultrelativ sökväg, eller null när den inte får länkas. */
function losUpp(ra: string, index: Dokumentindex): string | null {
  const utan = ra.split('#')[0]!.trim().replace(/^\.\//, '');
  if (utan === '' || utan.split('/').some((d) => d === '' || d === '.' || d === '..')) return null;
  const rel = (utan.toLowerCase().endsWith('.md') ? utan : `${utan}.md`).normalize('NFC');
  if (rel.includes('/')) return vitlistad(rel) ? rel : null;
  // (d) Rent filnamn: bara EN träff i indexet får bli länk. Indexet innehåller
  // enbart vitlistade kataloger, så en träff är alltid tillåten.
  const traffar = index.filnamn.get(rel.toLowerCase());
  return traffar !== undefined && traffar.length === 1 ? traffar[0]! : null;
}

// ---- KRAV-1: enkel markdown ------------------------------------------------

/**
 * Rubriker, listor, fetstil, kod och länkar — inget mer. Ingen markdownmotor,
 * inga nya beroenden; radbaserat och förutsägbart.
 */
export function renderaMarkdown(text: string, index: Dokumentindex): string {
  const rader = text.split(/\r?\n/);
  const ut: string[] = [];
  let stycke: string[] = [];
  let lista: 'ul' | 'ol' | null = null;
  let kod: string[] | null = null;

  const inline = (rad: string): string => lankaText(rad, index, MARKDOWN);
  const stangStycke = (): void => {
    if (stycke.length > 0) {
      ut.push(`<p>${inline(stycke.join('\n'))}</p>`);
      stycke = [];
    }
  };
  const stangLista = (): void => {
    if (lista !== null) {
      ut.push(`</${lista}>`);
      lista = null;
    }
  };
  const oppnaLista = (typ: 'ul' | 'ol'): void => {
    if (lista !== typ) {
      stangLista();
      ut.push(`<${typ}>`);
      lista = typ;
    }
  };

  let i = 0;
  // Frontmatter hör till filen, inte till läsningen.
  if (rader[0]?.trim() === '---') {
    const slut = rader.findIndex((r, n) => n > 0 && r.trim() === '---');
    if (slut > 0) i = slut + 1;
  }

  for (; i < rader.length; i++) {
    const rad = rader[i]!;
    if (kod !== null) {
      if (/^\s*```/.test(rad)) {
        ut.push(`<pre>${esc(kod.join('\n'))}</pre>`);
        kod = null;
      } else {
        kod.push(rad);
      }
      continue;
    }
    if (/^\s*```/.test(rad)) {
      stangStycke();
      stangLista();
      kod = [];
      continue;
    }
    if (rad.trim() === '') {
      stangStycke();
      stangLista();
      continue;
    }

    const rubrik = /^(#{1,6})\s+(.*)$/.exec(rad);
    if (rubrik !== null) {
      stangStycke();
      stangLista();
      // Sidans egen h1 är dokumentnamnet — filens rubriker börjar på h2.
      const niva = Math.min(rubrik[1]!.length + 1, 4);
      ut.push(`<h${niva}>${inline(rubrik[2]!.trim())}</h${niva}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(rad)) {
      stangStycke();
      stangLista();
      ut.push('<hr>');
      continue;
    }

    const punkt = /^\s*[-*+]\s+(.*)$/.exec(rad);
    if (punkt !== null) {
      stangStycke();
      oppnaLista('ul');
      ut.push(`<li>${inline(punkt[1]!)}</li>`);
      continue;
    }
    const numrerad = /^\s*\d+[.)]\s+(.*)$/.exec(rad);
    if (numrerad !== null) {
      stangStycke();
      oppnaLista('ol');
      ut.push(`<li>${inline(numrerad[1]!)}</li>`);
      continue;
    }

    stangLista();
    stycke.push(rad);
  }

  if (kod !== null) ut.push(`<pre>${esc(kod.join('\n'))}</pre>`);
  stangStycke();
  stangLista();
  return ut.join('');
}
