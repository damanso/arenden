// K-1: SKRIVVÄGEN i läsvyn. Davids beslut #64 — "vi bryter läsvy med avsikt så
// det går att fylla på med information när det behövs".
//
// Etapp 2a:s AVGRÄNSNING "inga POST-rutter under /vy" är alltså upphävd, och
// bara den. Allt annat i vyn står kvar oförändrat:
//
//   * GET-rutterna kräver fortfarande ingen nyckel (Etapp 2a KRAV-8). Att LÄSA
//     är oförändrat; det är att SKRIVA som fått ett krav.
//   * Ingen SQL i vylagret. Varje skrivning går via executeAction → actions →
//     tjänstelager, exakt som /api — samma transaktion, samma proveniens-tvång,
//     samma valideringsscheman.
//   * B-03, Story 3.1: bara en människonyckel föder en session i vyn.
//   * JS-fritt. Formulär + POST + redirect (post/redirect/get). CSP:n sätter
//     `script-src 'none'` (src/http/app.ts), så ett skript hade ändå inte kört.
//   * All dynamisk text genom esc() (KRAV-6) och varje aktör genom proveniens()
//     (KRAV-5).
//   * Felsidorna säger på svenska vad som hände (B-14, Story 2.2). Ett AppError
//     utom UnauthenticatedError blir felsida bara genom svaraMedFelbesked() och
//     den slutna tabellen FELBESKED; felkoden står aldrig ensam.
import express, { type Request, type Response, type Router } from 'express';
import { ZodError } from 'zod';
import { executeAction } from '../../actions/execute.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import type { Aktor } from '../../lib/aktor.js';
import { AppError, BadRequestError, UnauthenticatedError } from '../../lib/errors.js';
import { TENANT_ID } from '../../lib/tenant.js';
import { IdentifierSchema, StateTypSchema, type StateTyp } from '../../lib/validation.js';
import { listaEtikettnamn, listaProjektnamn, type Arende } from '../../services/arenden.js';
// Åtagande- och ärendemodulen importerar varandra: tabellen läses bara inne i tillatnaMal().
import { STATE_FOR_LAGE, type Lage } from '../../services/atagande.js';
import type { Kommentar } from '../../services/kommentarer.js';
import { listaNycklar, slaUppAktor, type NyckelIVy } from '../../services/nycklar.js';
import { datumtid, esc, proveniens, sida, statuschip, statusordForTyp } from './mall.js';
import {
  avslutaSession,
  kravManniska,
  kravSammaUrsprung,
  kravSessionsAktor,
  lasKaka,
  rensaSessionskaka,
  SESSIONSKAKA,
  sattSessionskaka,
  sessionsAktor,
  startaSession,
} from './session.js';

// ---- Indata ----------------------------------------------------------------

/** Ett formulärfält som enkel sträng. Array/objekt (dubblerade fält) blir "inte satt". */
export function falt(varde: unknown): string | undefined {
  if (typeof varde !== 'string') return undefined;
  const trimmad = varde.trim();
  return trimmad === '' ? undefined : trimmad;
}

/**
 * En ruttparameter som sträng. Express 5 typar dem `string | string[]` (samma
 * parser bär wildcards), och en array här hade blivit `[object Object]` i en
 * SQL-parameter i stället för ett fel.
 */
function ruttfalt(varde: unknown): string {
  return typeof varde === 'string' ? varde : '';
}

function kroppen(req: Request): Record<string, unknown> {
  const b: unknown = req.body;
  return typeof b === 'object' && b !== null ? (b as Record<string, unknown>) : {};
}

/**
 * Returadressen efter en skrivning. Får ENDAST peka in i vyn: en öppen redirect
 * hade gjort inloggningssidan till en språngbräda till en främmande sajt.
 * `//värd` och `/\värd` är protokollrelativa adresser och avvisas därför också,
 * liksom kontrolltecken (huvudinjektion i Location).
 */
export function sakerRetur(varde: unknown): string {
  const v = falt(varde);
  if (v === undefined || v.length > 300) return '/vy';
  if (!v.startsWith('/vy')) return '/vy';
  if (v.startsWith('//') || v.startsWith('/\\')) return '/vy';
  if (/[\u0000-\u001f\u007f\\]/.test(v)) return '/vy';
  return v;
}

// ---- Notiser ---------------------------------------------------------------
//
// Efter en skrivning omdirigerar vi (post/redirect/get) och lägger en KOD i
// URL:en — aldrig fri text. En fri notistext i query-strängen är en sträng som
// någon annan kan välja, renderad på Davids sida; koderna nedan är en sluten
// mängd och kan inte bära något annat.

const NOTISER: Record<string, string> = {
  inloggad: 'Du är inloggad. Dina ändringar bär din aktörsidentitet i händelseloggen.',
  utloggad: 'Du är utloggad. Vyn går fortfarande att läsa.',
  kommenterad: 'Kommentaren är sparad.',
  rattad: 'Kommentaren är rättad. Den gamla texten finns kvar i historiken.',
  oforandrad: 'Ingenting ändrades — värdet var redan det du angav.',
  borttagen: 'Kommentaren är borttagen. Den finns kvar i historiken och går att återställa.',
  aterstalld: 'Kommentaren är återställd.',
  etikett_borttagen: 'Etiketten är borttagen från ärendet.',
  namn_andrat: 'Namnet är rättat.',
  arendet_rattat: 'Ärendet är rättat. Den gamla texten finns kvar i historiken.',
  tillstand_bytt: 'Tillståndet är bytt. Det gamla står kvar i historiken.',
  nyckel_aterkallad: 'Nyckeln är återkallad och fungerar inte längre.',
};

export function notisrad(req: Request): string {
  const kod = falt(req.query['notis']);
  const text = kod === undefined ? undefined : NOTISER[kod];
  return text === undefined ? '' : `<p class="notis kvitto">${esc(text)}</p>`;
}

function medNotis(vag: string, kod: string): string {
  return `${vag}${vag.includes('?') ? '&' : '?'}notis=${encodeURIComponent(kod)}`;
}

// ---- Felsvar som HTML ------------------------------------------------------

// B-14 och UX-specifikationen: en felkod får stå i `code` efter meningen, aldrig
// ensam. `kod` är därför det enda sättet en kod når sidan, i ett eget stycke
// direkt efter p.notis, så att David kan citera den.
function felsida(rubrik: string, text: string, extra = '', kod?: string): string {
  const felkod = kod === undefined ? '' : `<p>Felkod: <code>${esc(kod)}</code></p>`;
  // Ingen aktör, alltså ett tyst hörn (mall.ts: "sidan vet inte"). En felsida vet
  // inte om sessionen gäller — 403 vid korsande ursprung kan komma från en
  // inloggad webbläsare — och då är tystnad bättre än ett påstående om
  // inloggningsläget.
  return sida(
    rubrik,
    `<h1>${esc(rubrik)}</h1><p class=notis>${esc(text)}</p>${felkod}${extra}` +
      '<p><a href="/vy">Till överblicken</a></p>',
  );
}

function svaraFel(
  res: Response,
  status: number,
  rubrik: string,
  text: string,
  extra = '',
  kod?: string,
): void {
  res.status(status).type('html').send(felsida(rubrik, text, extra, kod));
}

interface Felbeskrivning {
  rubrik: string;
  /** Ärendenumret ur adressen, eller null när adressen inte bär något giltigt. */
  mening: (nummer: string | null) => string;
  /** Sidan länkar tillbaka till ärendet när numret är känt. */
  tillArendet: boolean;
}

/**
 * B-14: den SLUTNA felkodstabellen, med UX-specifikationens rubriker och meningar
 * ("Spärr- och felbesked på svenska"). Tjänstelagrets meddelanden är skrivna för
 * /api och loggar, i ASCII och med API-namn; det är vyn som översätter. En ny
 * felkod som ytan kan möta läggs HÄR. Statusen står inte i tabellen: den är
 * felets egen, samma som /api svarar (FR-32).
 */
const FELBESKED: Record<string, Felbeskrivning> = {
  atagandet_styr_statusen: {
    rubrik: 'Tillståndet följer åtagandet',
    mening: (nummer) =>
      `${nummer ?? 'Ärendet'} bär ett åtagande, och då följer tillståndet åtagandets läge. ` +
      'Klart går när åtagandet är genomfört och Avbrutet när det är avslutat.',
    tillArendet: true,
  },
  kraver_manniska: {
    rubrik: 'Det här kräver en människa',
    mening: () => 'Handgreppet bokförs alltid som människa. Logga in med din människonyckel.',
    tillArendet: false,
  },
  cross_origin: {
    rubrik: 'Gick inte att utföra',
    mening: () => 'Begäran kom inte från vyns egna sidor och avvisades. Ingenting sparades.',
    tillArendet: false,
  },
  // B-04 (Story 3.3): ytans egna formulär ger aldrig koden, men en handskriven adress kan.
  okant_handgrepp: {
    rubrik: 'Okänt handgrepp',
    mening: () => 'Adressen anger ett handgrepp som ärendesidan inte har. Ingenting sparades.',
    tillArendet: true,
  },
};

/**
 * Ett AppError utan eget meddelande har koden som meddelande (src/lib/errors.ts).
 * Då hade koden stått ensam som mening, och det förbjuder B-14.
 */
const OKAND_KOD_MENING = 'Tjänsten avvisade ändringen utan en förklaring i klartext.';

/**
 * Rubrik, mening och det som står efter meningen för ett AppError. Ren. Uppslaget
 * går genom Object.hasOwn(): en objektliteral ärver `constructor` och `toString`,
 * och ett ärvt namn får aldrig tas för en post i tabellen. En kod utanför
 * tabellen visar tjänstens meddelande som förut.
 */
function felbesked(err: AppError, nummer: string | null): { rubrik: string; mening: string; extra: string } {
  const post = Object.hasOwn(FELBESKED, err.code) ? FELBESKED[err.code] : undefined;
  if (post === undefined) {
    const mening = err.message !== err.code ? err.message : OKAND_KOD_MENING;
    return { rubrik: 'Gick inte att utföra', mening, extra: '' };
  }
  const extra =
    post.tillArendet && nummer !== null
      ? `<p><a href="${esc(arendeUrlFor(nummer))}">Tillbaka till ${esc(nummer)}</a></p>`
      : '';
  return { rubrik: post.rubrik, mening: post.mening(nummer), extra };
}

/**
 * Fälten i de scheman som vyns skrivrutter skickar till (src/actions/registry.ts),
 * med sina svenska namn. Sluten: en nyckel utanför tabellen heter «Ett fält».
 */
const FALTNAMN: Record<string, string> = {
  title: 'Titel',
  description: 'Beskrivning',
  body: 'Kommentar',
  till: 'Nytt namn',
  fran: 'Nuvarande namn',
  label: 'Etikett',
  identifier: 'Ärendenummer',
  state_typ: 'Nytt tillstånd',
  kommentar_id: 'Kommentarens id',
  nyckel_id: 'Nyckelns id',
};

function faltnamn(nyckel: string | number | undefined): string {
  if (nyckel === undefined) return 'Formuläret';
  const namn = typeof nyckel === 'string' && Object.hasOwn(FALTNAMN, nyckel) ? FALTNAMN[nyckel] : undefined;
  return namn ?? 'Ett fält';
}

/**
 * B-14: valideringsfelet på svenska. Ur zods första fel läses bara slaget,
 * sökvägen och gränserna — ALDRIG `message`. Zods standardtexter är engelska, och
 * scheman med egna meningar kan bära API-namn; en regel utan undantag går att
 * visa genom konstruktion. Talet skrivs utan tusentalsavgränsare, så att texten
 * är densamma oavsett miljöns språkinställning.
 */
function ogiltigInmatning(err: ZodError): string {
  const fel = err.issues[0];
  const falt = faltnamn(fel?.path[0]);
  if (fel?.code === 'too_small' && fel.type === 'string' && fel.minimum === 1) {
    return `${falt} måste fyllas i.`;
  }
  if (fel?.code === 'too_big' && fel.type === 'string') {
    return `${falt} får vara högst ${String(fel.maximum)} tecken.`;
  }
  return `${falt} har ett värde som inte kan tas emot.`;
}

/**
 * Enda vägen från ett AppError (utom 401) till en felsida, för skrivrutt() och
 * ursprungOk(). Ärendenumret tas ur adressen och prövas mot IdentifierSchema —
 * aldrig ur tjänstens mening — så ett ogiltigt värde i adressen upprepas aldrig.
 */
function svaraMedFelbesked(req: Request, res: Response, err: AppError): void {
  const tolkat = IdentifierSchema.safeParse(ruttfalt(req.params['identifier']));
  const { rubrik, mening, extra } = felbesked(err, tolkat.success ? tolkat.data : null);
  svaraFel(res, err.status, rubrik, mening, extra, err.code);
}

/**
 * Skrivrutternas ram. Fyra saker i EXAKT den här ordningen, före varje skrivning:
 *
 *   1. Samma ursprung (CSRF).
 *   2. En session — alltså en aktör som härletts ur en API-nyckel.
 *   3. En människa (B-03, Story 3.1).
 *   4. Först därefter körs actionen.
 *
 * Fel blir HTML-sidor, inte API:ts JSON: det här är en yta en människa tittar på.
 *
 * Exporterad för provet (Story 2.2, AK 1): ingen vyrutt kastar ännu två av
 * felkoderna i FELBESKED, så provet monterar ramen med en hanterare som kastar dem.
 */
export function skrivrutt(
  hanterare: (req: Request, res: Response, aktor: Aktor) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      kravSammaUrsprung(req);
      const aktor = kravSessionsAktor(req);
      kravManniska(aktor);
      await hanterare(req, res, aktor);
    } catch (err) {
      if (res.headersSent) throw err;
      if (err instanceof UnauthenticatedError) {
        const retur = encodeURIComponent(sakerRetur(kroppen(req)['fran']));
        svaraFel(
          res,
          401,
          'Inloggning krävs',
          'Att läsa kräver ingen nyckel. Att ÄNDRA gör det: aktören i händelseloggen ' +
            'härleds alltid ur en nyckel, aldrig ur formuläret.',
          `<p><a href="/vy/logga-in?fran=${esc(retur)}">Logga in</a></p>`,
        );
        return;
      }
      if (err instanceof ZodError) {
        svaraFel(res, 400, 'Ogiltig inmatning', ogiltigInmatning(err));
        return;
      }
      if (err instanceof AppError) {
        svaraMedFelbesked(req, res, err);
        return;
      }
      throw err;
    }
  };
}

/** CSRF-kontroll i de två rutter som inte kan gå genom skrivrutt() (in-/utloggning). */
function ursprungOk(req: Request, res: Response): boolean {
  try {
    kravSammaUrsprung(req);
    return true;
  } catch (err) {
    if (err instanceof AppError) {
      svaraMedFelbesked(req, res, err);
      return false;
    }
    throw err;
  }
}

/** Enda vägen från vyn in i kärnan — samma som transportlagret på /api gör. */
async function kor(aktor: Aktor, actionName: string, input: unknown): Promise<unknown> {
  const utfall = await executeAction({ aktor, actionName, input });
  return utfall.result;
}

function andrad(resultat: unknown): boolean {
  return (
    typeof resultat === 'object' &&
    resultat !== null &&
    (resultat as { andrad?: unknown }).andrad === true
  );
}

// ---- Byggstenar som ärendesidan använder -----------------------------------

export function arendeUrlFor(identifier: string): string {
  return `/vy/arende/${encodeURIComponent(identifier)}`;
}

/** B-03: alla skrivformulär använder samma människokrav som skrivramen. */
export function kanSkriva(aktor: Aktor | null): aktor is Aktor {
  return aktor?.typ === 'manniska';
}

/**
 * Skrivläget, synligt på ärendesidan. Utan session visas INGA formulär — bara
 * varför, och vägen dit. Att visa knappar som säkert misslyckas är att ljuga
 * med gränssnittet.
 */
export function skrivlage(aktor: Aktor | null, retur: string): string {
  if (kanSkriva(aktor)) return '';
  return (
    '<p class=notis>Läsläge. ' +
    `<a href="/vy/logga-in?fran=${esc(encodeURIComponent(sakerRetur(retur)))}">Logga in</a>` +
    ' för att kommentera eller rätta — ändringarna bär då din aktörsidentitet.</p>'
  );
}

export function nyKommentarForm(aktor: Aktor | null, identifier: string): string {
  if (!kanSkriva(aktor)) return '';
  const typtext = aktor.typ === 'manniska' ? 'människa' : aktor.typ;
  return (
    `<form class=skrivform method=post action="${esc(arendeUrlFor(identifier))}/kommentar">` +
    '<label class=dold for=nykommentar>Ny kommentar</label>' +
    '<textarea id=nykommentar name=body rows=4 required ' +
    'placeholder="Fyll på med det som behövs"></textarea>' +
    '<div class=skrivrad><button type=submit>Kommentera</button>' +
    `<span class=meta>Sparas som ${esc(typtext)} · ${esc(aktor.namn)}</span></div></form>`
  );
}

/**
 * Rätta/ta bort under EN kommentar. `<details>` är HTML, inte skript — hela
 * ytan kör med `script-src 'none'` och rättelseformuläret får inte vara det
 * enda som kräver ett undantag.
 */
/**
 * Beslut #145: rätta ärendets titel och beskrivning.
 *
 * Hålet det stänger: `update_issue` kunde skriva prioritet, deadline,
 * milstolpe, förälder och projekt — men inte rubriken. En felstavad titel
 * gick bara att bli av med genom att makulera ärendet och skapa ett nytt,
 * vilket ger två rader i loggen för noll faktisk förändring.
 *
 * Formuläret är hopfällt (`details`) och står under beskrivningen det rättar.
 * Utan session visas det inte alls — att visa en knapp som säkert misslyckas
 * är att ljuga med gränssnittet (samma regel som skrivlage()).
 */
export function rattaArendeForm(
  aktor: Aktor | null,
  identifier: string,
  titel: string,
  beskrivning: string,
): string {
  if (!kanSkriva(aktor)) return '';
  const vag = `${arendeUrlFor(identifier)}/ratta`;
  return (
    '<details class=rattelse><summary>Rätta titel eller beskrivning</summary>' +
    `<form class=skrivform method=post action="${esc(vag)}">` +
    `<label for="titel-${esc(identifier)}">Titel</label>` +
    `<input type=text id="titel-${esc(identifier)}" name=titel required maxlength=300 ` +
    `value="${esc(titel)}">` +
    `<label for="beskrivning-${esc(identifier)}">Beskrivning</label>` +
    `<textarea id="beskrivning-${esc(identifier)}" name=beskrivning rows=10 ` +
    `maxlength=20000>${esc(beskrivning)}</textarea>` +
    '<div class=skrivrad><button type=submit>Spara rättelsen</button>' +
    '<span class=meta>Den gamla texten finns kvar i historiken. ' +
    'Ändringen bär din aktörsidentitet.</span></div></form></details>'
  );
}

/**
 * FR-32 (Story 3.3): lägesorden i tillståndsformulärets spärrmening. Sluten: Record över Lage gör
 * att tsc kräver alla fem, och ordet skrivs bara ur tabellen.
 */
const LAGESORD: Record<Lage, string> = {
  registrerat: 'registrerat',
  overtaget: 'övertaget',
  hindrat: 'hindrat',
  genomfort: 'genomfört',
  avslutat: 'avslutat',
};

/**
 * FR-32, B-02 och B-04 (Story 3.3): ytans ENDA källa till de mål tillståndsformuläret erbjuder.
 * Den läser samma tabell som tjänstens regel (STATE_FOR_LAGE, Story 3.2), så att ytan aldrig
 * erbjuder något som update_issue_state avvisar. Servern upprätthåller regeln ändå, oavsett vad
 * ytan visar (architecture.md, Cross-Component Dependencies).
 *
 * Utan åtagande: varje typ utom den nuvarande. Med åtagande: bara stängningsmålet — Klart när
 * åtagandet är genomfört och Avbrutet när det är avslutat — och bara när ärendet inte redan står
 * där. Lägets öppna mål erbjuds aldrig (AK 5). Exporterad för provet (T5).
 *
 * Tabellen läses här inne och aldrig på modulnivå, eftersom åtagande- och ärendemodulen
 * importerar varandra (samma regel som i src/services/arenden.ts).
 */
export function tillatnaMal(typ: StateTyp, lage: Lage | null): StateTyp[] {
  if (lage === null) return StateTypSchema.options.filter((t) => t !== typ);
  const mal = STATE_FOR_LAGE[lage];
  return (mal === 'completed' || mal === 'canceled') && mal !== typ ? [mal] : [];
}

/**
 * FR-32, B-04 (Story 3.3): byt tillstånd eller stäng ärendet från ärendesidan. Hopfällt som
 * rättelsen och placerat efter summeringen och föräldern (UX-specifikationen, Tillståndsformuläret).
 * Utan människosession visas inget — en knapp som säkert misslyckas ljuger med gränssnittet
 * (samma regel som skrivlage()).
 *
 * Valen kommer bara ur tillatnaMal() och läget ur läsmodellen, aldrig ur SQL i vyn. Det som inte
 * går förklaras i text: formuläret har inga inaktiverade kontroller och inget förval, så att ett
 * oavsiktligt tryck på knappen inte byter något. Adressen är tillståndsgrenen i rättelserutten
 * (?handgrepp=tillstand), och eftersom den inte slutar på /ratta förblir rättelseformuläret det
 * första formuläret med den adressen på sidan.
 */
export function tillstandForm(aktor: Aktor | null, a: Arende): string {
  if (!kanSkriva(aktor)) return '';
  const lage = a.atagande_lage;
  const nu = `<p class=summering>Nu: ${statuschip(a.state_typ, a.state_namn)}</p>`;
  const mal = tillatnaMal(a.state_typ, lage);
  const start = '<details class=rattelse><summary>Byt tillstånd</summary>';
  if (mal.length === 0 && lage !== null) {
    const sparr =
      `Tillståndet följer åtagandet, som står i läget ${LAGESORD[lage]}. ` +
      'Klart går när åtagandet är genomfört och Avbrutet när det är avslutat. ' +
      'Åtagandet redovisas med belägg av den som utför det — inte härifrån.';
    return `${start}${nu}<p class=notis>${esc(sparr)}</p></details>`;
  }
  const vag = `${arendeUrlFor(a.identifier)}/ratta?handgrepp=tillstand`;
  const mening =
    lage === 'genomfort'
      ? '<p class=notis>Åtagandet är genomfört — ärendet kan stängas som Klart.</p>'
      : lage === 'avslutat'
        ? '<p class=notis>Åtagandet är avslutat — ärendet kan stängas som Avbrutet.</p>'
        : '';
  const val = mal
    .map(
      (typ) =>
        `<label><input type=radio name=state_typ value="${esc(typ)}" required>` +
        `<span>${esc(statusordForTyp(typ))}</span></label>`,
    )
    .join('');
  return (
    start +
    `<form class=skrivform method=post action="${esc(vag)}">` +
    nu +
    mening +
    '<fieldset class=tillstand><legend>Nytt tillstånd</legend>' +
    val +
    '</fieldset>' +
    '<div class=skrivrad><button type=submit>Byt tillstånd</button>' +
    '<span class=meta>Det gamla tillståndet står kvar i historiken. ' +
    'Ändringen bär din aktörsidentitet.</span></div></form></details>'
  );
}

export function kommentarsverktyg(aktor: Aktor | null, kommentar: Kommentar, retur: string): string {
  if (!kanSkriva(aktor)) return '';
  const id = esc(kommentar.id);
  const returFalt = `<input type=hidden name=fran value="${esc(retur)}">`;
  return (
    '<details class=rattelse><summary>Rätta eller ta bort</summary>' +
    `<form class=skrivform method=post action="/vy/kommentar/${esc(kommentar.id)}/ratta">` +
    returFalt +
    `<label class=dold for="ratta-${id}">Rättad text</label>` +
    `<textarea id="ratta-${id}" name=body rows=6 required>${esc(kommentar.body)}</textarea>` +
    '<div class=skrivrad><button type=submit>Spara rättelsen</button>' +
    '<span class=meta>Den gamla texten sparas i historiken.</span></div></form>' +
    `<form class=skrivform method=post action="/vy/kommentar/${esc(kommentar.id)}/tabort">` +
    returFalt +
    '<div class=skrivrad><button class=mild type=submit>Ta bort kommentaren</button>' +
    '<span class=meta>Mjuk borttagning — raden finns kvar och går att återställa.</span>' +
    '</div></form></details>'
  );
}

/**
 * Varken texten eller den aktör som stod på den återges här. Sidan säger ATT
 * något togs bort; VAD som togs bort står i händelseraden, som är append-only.
 * Var det just aktörsuppgiften som var fel — LOC-255:s tre falska "personer" —
 * hade en återgivning här gjort borttagningen meningslös.
 */
export function borttagnaAvsnitt(
  aktor: Aktor | null,
  borttagna: { id: string; borttagen: Date }[],
  retur: string,
): string {
  if (borttagna.length === 0) return '';
  const rader = borttagna
    .map((b) => {
      const knapp = kanSkriva(aktor)
        ? `<form class=skrivform method=post action="/vy/kommentar/${esc(b.id)}/aterstall">` +
          `<input type=hidden name=fran value="${esc(retur)}">` +
          '<button class=mild type=submit>Återställ</button></form>'
        : '';
      return (
        '<li class=rad><div class=huvud>' +
        `<span>borttagen ${esc(datumtid(b.borttagen))}</span>${knapp}</div></li>`
      );
    })
    .join('');
  return (
    `<h2>Borttagna kommentarer (${esc(borttagna.length)})</h2>` +
    '<p class=notis>Innehållet och aktören står kvar i historiken nedan — inte här.</p>' +
    `<ul class=lista role=list>${rader}</ul>`
  );
}

/** Etiketterna, med en borttagningsknapp var när någon är inloggad. */
export function etikettrad(aktor: Aktor | null, identifier: string, labels: string[]): string {
  if (labels.length === 0) return '';
  if (!kanSkriva(aktor)) return `<p>${labels.map((l) => `<span class=tagg>${esc(l)}</span>`).join('')}</p>`;
  const rader = labels
    .map(
      (l) =>
        `<form class=taggform method=post action="${esc(arendeUrlFor(identifier))}/etikett/tabort">` +
        `<input type=hidden name=etikett value="${esc(l)}">` +
        `<button class=tagg type=submit title="Ta bort etiketten ${esc(l)} från ärendet">` +
        `${esc(l)} <span aria-hidden=true>×</span><span class=dold>ta bort</span>` +
        '</button></form>',
    )
    .join('');
  return `<div class=taggar>${rader}</div>`;
}

// ---- Rutterna --------------------------------------------------------------

export function monteraSkrivrutter(router: Router): void {
  // Formulärkroppar. ENDAST här — /api tar fortfarande bara JSON och är
  // oförändrat. `extended: false` ger platta strängvärden, inget objektdjup.
  router.use(express.urlencoded({ extended: false, limit: '64kb' }));

  // ---- Inloggning: hur en vyskrivning får en aktör -------------------------

  router.get('/logga-in', (req, res) => {
    const aktor = sessionsAktor(req);
    const fran = sakerRetur(req.query['fran']);
    const felkod = falt(req.query['fel']);

    const kropp = aktor
      ? '<h1>Inloggad</h1>' +
        `<p class=summering>Skrivningar från vyn bokförs som ${proveniens(aktor.typ, aktor.namn)}.</p>` +
        '<form class=skrivform method=post action="/vy/logga-ut">' +
        '<div class=skrivrad><button type=submit>Logga ut</button></div></form>' +
        '<p><a href="/vy">Till överblicken</a></p>'
      : '<h1>Logga in</h1>' +
        '<p class=summering>Att läsa vyn kräver ingen inloggning. Att ändra gör det: ' +
        'aktören i händelseloggen härleds alltid ur ett bevis — aldrig ur ett ' +
        'formulärfält — så att en agents skrivning aldrig kan bära en människas namn.</p>' +
        '<details class=rattelse open><summary>Logga in med människonyckel</summary>' +
        '<p class=summering>För dig som har en egen människonyckel. Agenterna bär nyckel ' +
        'mot API:t och loggar aldrig in här.</p>' +
        (felkod === 'agent'
          ? '<p class=notis>Nyckeln tillhör en agent eller ett system. Vyn tar bara emot människonycklar.</p>'
          : felkod !== undefined
            ? '<p class=notis>Nyckeln gick inte att känna igen, eller är återkallad.</p>'
            : '') +
        '<form class=skrivform method=post action="/vy/logga-in">' +
        `<input type=hidden name=fran value="${esc(fran)}">` +
        '<label for=nyckel>API-nyckel</label>' +
        '<input type=password id=nyckel name=nyckel required autocomplete=off ' +
        'spellcheck=false autocapitalize=off>' +
        '<div class=skrivrad><button type=submit>Logga in</button>' +
        '<span class=meta>Nyckeln lagras aldrig i sidan och skrivs aldrig i någon logg.</span>' +
        '</div></form></details>';

    res.type('html').send(sida('Logga in', notisrad(req) + kropp, undefined, aktor));
  });

  // Ingen session krävs här — det är den här rutten som SKAPAR en. CSRF-kravet
  // gäller ändå: en främmande sajt ska inte kunna logga in Davids webbläsare
  // som någon annan. B-03, Story 3.1: bara en människonyckel föder en session.
  router.post('/logga-in', async (req, res) => {
    if (!ursprungOk(req, res)) return;
    const kropp = kroppen(req);
    const fran = sakerRetur(kropp['fran']);
    const nyckel = falt(kropp['nyckel']);
    const aktor = nyckel === undefined ? null : await slaUppAktor(pool, nyckel);
    if (!aktor) {
      // Ingen upprepning av det inskrivna värdet, varken i sidan eller i URL:en.
      res.redirect(303, `/vy/logga-in?fel=1&fran=${encodeURIComponent(fran)}`);
      return;
    }
    if (aktor.typ !== 'manniska') {
      res.redirect(303, '/vy/logga-in?fel=agent&fran=' + encodeURIComponent(fran));
      return;
    }
    sattSessionskaka(res, startaSession(aktor));
    res.redirect(303, medNotis(fran, 'inloggad'));
  });

  router.post('/logga-ut', (req, res) => {
    if (!ursprungOk(req, res)) return;
    avslutaSession(lasKaka(req, SESSIONSKAKA));
    rensaSessionskaka(res);
    res.redirect(303, medNotis('/vy', 'utloggad'));
  });

  // ---- Kommentarer ---------------------------------------------------------

  router.post(
    '/arende/:identifier/kommentar',
    skrivrutt(async (req, res, aktor) => {
      const identifier = ruttfalt(req.params['identifier']);
      await kor(aktor, 'add_comment', { identifier, body: kroppen(req)['body'] });
      res.redirect(303, medNotis(arendeUrlFor(identifier), 'kommenterad'));
    }),
  );

  router.post(
    '/kommentar/:id/ratta',
    skrivrutt(async (req, res, aktor) => {
      const kropp = kroppen(req);
      const resultat = await kor(aktor, 'update_comment', {
        kommentar_id: ruttfalt(req.params['id']),
        body: kropp['body'],
      });
      const retur = sakerRetur(kropp['fran']);
      res.redirect(303, medNotis(retur, andrad(resultat) ? 'rattad' : 'oforandrad'));
    }),
  );

  router.post(
    '/kommentar/:id/tabort',
    skrivrutt(async (req, res, aktor) => {
      const resultat = await kor(aktor, 'delete_comment', { kommentar_id: ruttfalt(req.params['id']) });
      const retur = sakerRetur(kroppen(req)['fran']);
      res.redirect(303, medNotis(retur, andrad(resultat) ? 'borttagen' : 'oforandrad'));
    }),
  );

  router.post(
    '/kommentar/:id/aterstall',
    skrivrutt(async (req, res, aktor) => {
      const resultat = await kor(aktor, 'restore_comment', { kommentar_id: ruttfalt(req.params['id']) });
      const retur = sakerRetur(kroppen(req)['fran']);
      res.redirect(303, medNotis(retur, andrad(resultat) ? 'aterstalld' : 'oforandrad'));
    }),
  );

  // ---- Rätta ärendets titel och beskrivning (beslut #145) -----------------
  //
  // FR-32, B-04 (Story 3.3): rutten bär också tillståndsbytet, som en gren vald i
  // adressen. Ingen ny rutt: adresskontraktet bär redan den här, och dess kopia
  // skrivs bara av generatorn.

  router.post(
    '/arende/:identifier/ratta',
    skrivrutt(async (req, res, aktor) => {
      const identifier = ruttfalt(req.params['identifier']);
      const kropp = kroppen(req);
      // B-04: adressen väljer handgrepp ur en sluten mängd. Utan värde rättas titel och
      // beskrivning som förut (beslut #145, FR-29), med exakt `tillstand` byts tillståndet
      // (FR-32), och allt annat avvisas innan något körs. Valet står i adressen och inte i
      // ett dolt fält, så att rättelseformuläret förblir det första på sidan med adressen
      // till den här rutten. Värdet läses rått och inte med falt(): ett tomt eller upprepat
      // värde ska ge 400, inte rättelsen, som tömmer en beskrivning som inte skickas.
      const handgrepp = req.query['handgrepp'];
      if (handgrepp !== undefined) {
        if (handgrepp !== 'tillstand') throw new BadRequestError('okant_handgrepp');
        // Sluten fältmängd: state_id skickas aldrig från ytan. state_typ är alltid en
        // sträng, så att zods första fel står på fältet och felsidan nämner Nytt tillstånd.
        const resultat = await kor(aktor, 'update_issue_state', {
          identifier,
          state_typ: falt(kropp['state_typ']) ?? '',
        });
        res.redirect(
          303,
          medNotis(arendeUrlFor(identifier), andrad(resultat) ? 'tillstand_bytt' : 'oforandrad'),
        );
        return;
      }
      // falt() ger undefined för tom sträng. För titeln är det rätt (ett
      // ärende utan rubrik finns inte, och schemat fäller det). För
      // beskrivningen är tomt ett giltigt värde — därför null, som töms.
      const beskrivning = falt(kropp['beskrivning']);
      const resultat = await kor(aktor, 'update_issue', {
        identifier,
        title: kropp['titel'],
        description: beskrivning === undefined ? null : beskrivning,
      });
      // andrad() duger inte här: update_issue svarar med `andringar`, inte
      // `andrad`. Tom lista = ingenting ändrades, och det ska synas.
      const andringar = (resultat as { andringar?: unknown[] }).andringar;
      const nagot = Array.isArray(andringar) && andringar.length > 0;
      res.redirect(
        303,
        medNotis(arendeUrlFor(identifier), nagot ? 'arendet_rattat' : 'oforandrad'),
      );
    }),
  );

  // ---- Etikett på ett ärende ----------------------------------------------

  router.post(
    '/arende/:identifier/etikett/tabort',
    skrivrutt(async (req, res, aktor) => {
      const identifier = ruttfalt(req.params['identifier']);
      const resultat = await kor(aktor, 'remove_label', {
        identifier,
        label: kroppen(req)['etikett'],
      });
      res.redirect(
        303,
        medNotis(arendeUrlFor(identifier), andrad(resultat) ? 'etikett_borttagen' : 'oforandrad'),
      );
    }),
  );

  // ---- Namn och nycklar ----------------------------------------------------

  router.get('/rattelser', async (req, res) => {
    const aktor = sessionsAktor(req);
    const data = await withTransaction(async (client) => ({
      projekt: await listaProjektnamn(client, TENANT_ID),
      etiketter: await listaEtikettnamn(client, TENANT_ID),
      nycklar: await listaNycklar(client, TENANT_ID),
    }));

    const namnform = (vag: string, sort: string, namn: string, nr: number): string =>
      `<li class=rad><form class=namnform method=post action="${esc(vag)}">` +
      `<input type=hidden name=fran value="${esc(namn)}">` +
      `<label class=dold for="${esc(sort)}-${esc(nr)}">Nytt namn för ${esc(namn)}</label>` +
      `<input type=text id="${esc(sort)}-${esc(nr)}" name=till value="${esc(namn)}" required>` +
      '<button type=submit>Rätta</button></form></li>';

    const lasnotis = kanSkriva(aktor)
      ? ''
      : '<p class=notis>Läsläge — namnen visas men går inte att ändra. ' +
        '<a href="/vy/logga-in?fran=%2Fvy%2Frattelser">Logga in</a> för att rätta.</p>';

    const nyckelrad = (n: NyckelIVy): string =>
      '<li class=rad><div class=huvud>' +
      proveniens(n.aktor_typ, n.aktor_namn) +
      `<span>${n.aktiv ? 'aktiv' : 'återkallad'}</span>` +
      `<span>skapad ${esc(datumtid(n.skapad))}</span>` +
      (kanSkriva(aktor) && n.aktiv
        ? `<form class=skrivform method=post action="/vy/nyckel/${esc(n.id)}/aterkalla">` +
          '<button class=mild type=submit>Återkalla</button></form>'
        : '') +
      '</div></li>';

    const namnlista = (vag: string, sort: string, namn: string[]): string =>
      namn.length === 0
        ? '<p class=notis>Inga poster.</p>'
        : kanSkriva(aktor)
          ? `<ul class=lista role=list>${namn.map((n, i) => namnform(vag, sort, n, i)).join('')}</ul>`
          : `<p>${namn.map((n) => `<span class=tagg>${esc(n)}</span>`).join('')}</p>`;

    const kropp =
      '<h1>Rättelser</h1>' +
      '<p class=summering>Namn som stavats fel går att rätta här, och nycklar går att ' +
      'återkalla. Varje ändring skriver en händelserad med aktör och gammalt värde. ' +
      'Ingenting på den här sidan raderar historik.</p>' +
      notisrad(req) +
      lasnotis +
      `<h2>Projektnamn (${esc(data.projekt.length)})</h2>` +
      namnlista('/vy/namn/projekt', 'projekt', data.projekt) +
      `<h2>Etikettnamn (${esc(data.etiketter.length)})</h2>` +
      namnlista('/vy/namn/etikett', 'etikett', data.etiketter) +
      `<h2>Nycklar (${esc(data.nycklar.length)})</h2>` +
      '<p class=summering>Nyckeln själv finns inte här och kan inte visas igen — bara ' +
      'hashen lagras. Det som visas är identiteten den bär.</p>' +
      (data.nycklar.length === 0
        ? '<p class=notis>Inga nycklar.</p>'
        : `<ul class=lista role=list>${data.nycklar.map(nyckelrad).join('')}</ul>`);

    res.type('html').send(sida('Rättelser', kropp, 'rattelser', aktor));
  });

  router.post(
    '/namn/projekt',
    skrivrutt(async (req, res, aktor) => {
      const kropp = kroppen(req);
      const resultat = await kor(aktor, 'rename_project', {
        fran: kropp['fran'],
        till: kropp['till'],
      });
      res.redirect(303, medNotis('/vy/rattelser', andrad(resultat) ? 'namn_andrat' : 'oforandrad'));
    }),
  );

  router.post(
    '/namn/etikett',
    skrivrutt(async (req, res, aktor) => {
      const kropp = kroppen(req);
      const resultat = await kor(aktor, 'rename_label', {
        fran: kropp['fran'],
        till: kropp['till'],
      });
      res.redirect(303, medNotis('/vy/rattelser', andrad(resultat) ? 'namn_andrat' : 'oforandrad'));
    }),
  );

  router.post(
    '/nyckel/:id/aterkalla',
    skrivrutt(async (req, res, aktor) => {
      const resultat = await kor(aktor, 'revoke_api_key', { nyckel_id: ruttfalt(req.params['id']) });
      res.redirect(
        303,
        medNotis('/vy/rattelser', andrad(resultat) ? 'nyckel_aterkallad' : 'oforandrad'),
      );
    }),
  );
}
