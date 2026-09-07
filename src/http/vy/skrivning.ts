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
//   * JS-fritt. Formulär + POST + redirect (post/redirect/get). CSP:n sätter
//     `script-src 'none'` (src/http/app.ts), så ett skript hade ändå inte kört.
//   * All dynamisk text genom esc() (KRAV-6) och varje aktör genom proveniens()
//     (KRAV-5).
import express, { type Request, type Response, type Router } from 'express';
import { ZodError } from 'zod';
import { executeAction } from '../../actions/execute.js';
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import type { Aktor } from '../../lib/aktor.js';
import { AppError, UnauthenticatedError } from '../../lib/errors.js';
import { TENANT_ID } from '../../lib/tenant.js';
import { listaEtikettnamn, listaProjektnamn } from '../../services/arenden.js';
import type { Kommentar } from '../../services/kommentarer.js';
import { listaNycklar, slaUppAktor, type NyckelIVy } from '../../services/nycklar.js';
import { datumtid, esc, proveniens, sida } from './mall.js';
import {
  avslutaSession,
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

// Redovisningen ager identiteten. Adressen byts har nar ingangen flyttar
// modulerna till vagar bakom en gemensam /.
const REDOVISNINGENS_LOGIN = 'https://david-brain.tail743706.ts.net:8444/app/login';

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

function felsida(rubrik: string, text: string, extra = ''): string {
  return sida(
    rubrik,
    `<h1>${esc(rubrik)}</h1><p class=notis>${esc(text)}</p>${extra}` +
      '<p><a href="/vy">Till överblicken</a></p>',
    undefined,
    null,
  );
}

function svaraFel(res: Response, status: number, rubrik: string, text: string, extra = ''): void {
  res.status(status).type('html').send(felsida(rubrik, text, extra));
}

/**
 * Skrivrutternas ram. Tre saker i EXAKT den här ordningen, före varje skrivning:
 *
 *   1. Samma ursprung (CSRF).
 *   2. En session — alltså en aktör som härletts ur en API-nyckel.
 *   3. Först därefter körs actionen.
 *
 * Fel blir HTML-sidor, inte API:ts JSON: det här är en yta en människa tittar på.
 */
function skrivrutt(
  hanterare: (req: Request, res: Response, aktor: Aktor) => Promise<void>,
): (req: Request, res: Response) => Promise<void> {
  return async (req, res) => {
    try {
      kravSammaUrsprung(req);
      const aktor = kravSessionsAktor(req);
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
          `<p><a href="/vy/logga-in?fran=${retur}">Logga in</a></p>`,
        );
        return;
      }
      if (err instanceof ZodError) {
        svaraFel(res, 400, 'Ogiltig inmatning', err.issues[0]?.message ?? 'fältet kunde inte tolkas');
        return;
      }
      if (err instanceof AppError) {
        svaraFel(res, err.status, 'Gick inte att utföra', err.message);
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
      svaraFel(res, err.status, 'Gick inte att utföra', err.message);
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

/**
 * Skrivläget, synligt på ärendesidan. Utan session visas INGA formulär — bara
 * varför, och vägen dit. Att visa knappar som säkert misslyckas är att ljuga
 * med gränssnittet.
 */
export function skrivlage(aktor: Aktor | null, retur: string): string {
  if (aktor) return '';
  return (
    '<p class=notis>Läsläge. ' +
    `<a href="/vy/logga-in?fran=${encodeURIComponent(sakerRetur(retur))}">Logga in</a>` +
    ' för att kommentera eller rätta — ändringarna bär då din aktörsidentitet.</p>'
  );
}

export function nyKommentarForm(aktor: Aktor | null, identifier: string): string {
  if (!aktor) return '';
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
  if (!aktor) return '';
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

export function kommentarsverktyg(aktor: Aktor | null, kommentar: Kommentar, retur: string): string {
  if (!aktor) return '';
  const id = esc(kommentar.id);
  const returFalt = `<input type=hidden name=fran value="${esc(retur)}">`;
  return (
    '<details class=rattelse><summary>Rätta eller ta bort</summary>' +
    `<form class=skrivform method=post action="/vy/kommentar/${id}/ratta">` +
    returFalt +
    `<label class=dold for="ratta-${id}">Rättad text</label>` +
    `<textarea id="ratta-${id}" name=body rows=6 required>${esc(kommentar.body)}</textarea>` +
    '<div class=skrivrad><button type=submit>Spara rättelsen</button>' +
    '<span class=meta>Den gamla texten sparas i historiken.</span></div></form>' +
    `<form class=skrivform method=post action="/vy/kommentar/${id}/tabort">` +
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
      const knapp = aktor
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
  if (!aktor) return `<p>${labels.map((l) => `<span class=tagg>${esc(l)}</span>`).join('')}</p>`;
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
    const fel = falt(req.query['fel']) !== undefined;

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
        // Davids vag star forst, som det den ar. Sidan visade tidigare BARA
        // API-nyckeln, aven efter att den gemensamma sessionen byggts - en vag
        // som inte star pa skylten finns inte for den som laser skylten.
        '<h2>Logga in med ditt Locollabs-konto</h2>' +
        '<p class=summering>Samma användarnamn och lösenord som i redovisningen. ' +
        'Loggar du in där är du inloggad här också — det är samma system.</p>' +
        '<p><a class=btn href="' + REDOVISNINGENS_LOGIN + '">Till inloggningen</a></p>' +
        '<p class=notis>Har du redan loggat in i redovisningen och ändå ser den här ' +
        'sidan: logga <b>ut</b> där och in igen. Sessioner som skapades före ' +
        '2026-09-07 18:46 gällde bara redovisningen och når inte hit.</p>' +
        '<details class=rattelse><summary>API-nyckel — för agenter</summary>' +
        '<p class=summering>Agenterna bär nyckel, aldrig session. Som människa ' +
        'behöver du ingen.</p>' +
        (fel ? '<p class=notis>Nyckeln gick inte att känna igen, eller är återkallad.</p>' : '') +
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
  // som någon annan.
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

  router.post(
    '/arende/:identifier/ratta',
    skrivrutt(async (req, res, aktor) => {
      const identifier = ruttfalt(req.params['identifier']);
      const kropp = kroppen(req);
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

    const lasnotis = aktor
      ? ''
      : '<p class=notis>Läsläge — namnen visas men går inte att ändra. ' +
        '<a href="/vy/logga-in?fran=%2Fvy%2Frattelser">Logga in</a> för att rätta.</p>';

    const nyckelrad = (n: NyckelIVy): string =>
      '<li class=rad><div class=huvud>' +
      proveniens(n.aktor_typ, n.aktor_namn) +
      `<span>${n.aktiv ? 'aktiv' : 'återkallad'}</span>` +
      `<span>skapad ${esc(datumtid(n.skapad))}</span>` +
      (aktor && n.aktiv
        ? `<form class=skrivform method=post action="/vy/nyckel/${esc(n.id)}/aterkalla">` +
          '<button class=mild type=submit>Återkalla</button></form>'
        : '') +
      '</div></li>';

    const namnlista = (vag: string, sort: string, namn: string[]): string =>
      namn.length === 0
        ? '<p class=notis>Inga poster.</p>'
        : aktor
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
