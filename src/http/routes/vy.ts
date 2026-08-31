// Davids läsvy (Etapp 2a). Serverrenderad HTML under /vy i samma process och på
// samma port som API:t.
//
// TRE invarianter, som granskaren kan läsa av rakt här:
//   1. REN LÄSYTA: bara GET, inga mutationer, ingen event-rad skrivs. Vyn är
//      därför undantagen från nyckelkravet — loopback/tailnet är gränsen,
//      precis som för ytor_server (KRAV-8).
//   2. INGEN SQL i det här lagret. All datahämtning går via tjänstelagret
//      (src/services/) — samma funktioner som actions-API:t använder.
//   3. ALL dynamisk text går genom esc() i ../vy/mall.js (KRAV-6), och varje
//      kommentar/händelse skrivs ut med proveniens() (KRAV-5).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import { config } from '../../config.js';
import { withTransaction } from '../../db/tx.js';
import { NotFoundError } from '../../lib/errors.js';
import { TENANT_ID } from '../../lib/tenant.js';
import { IdentifierSchema, StateTypSchema, safeText, type StateTyp } from '../../lib/validation.js';
import {
  aktorerMedSpar,
  barnFor,
  byggMittLage,
  hamtaArende,
  listaArenden,
  listaEtikettnamn,
  listaProjektnamn,
  oppnaMedSpar,
  sokArenden,
  type Arende,
  type Hog,
  type MittArende,
  type Soktraff,
} from '../../services/arenden.js';
import {
  bilagorFor,
  relationerFor,
  type Bilaga,
  type Relation,
} from '../../services/relationer.js';
import {
  arendenMedAktivitetAv,
  listaAktorer,
  listaHandelser,
  listaSenasteHandelser,
  type HandelseIVy,
} from '../../services/handelser.js';
import { listaBorttagnaKommentarer, listaKommentarer } from '../../services/kommentarer.js';
import { crmKort, hamtaCrm } from '../vy/crm.js';
import { hamtaIndex, lasDokument, sakerSokvag } from '../vy/dokument.js';
import { renderaArendetext, renderaMarkdown } from '../vy/markdown.js';
import {
  brodsmula,
  datum,
  datumtid,
  esc,
  klockslag,
  prioNamn,
  proveniens,
  relationText,
  sakerUrl,
  sida,
  statuschip,
  tomtLage,
  verbText,
} from '../vy/mall.js';
import { sessionsAktor } from '../vy/session.js';
import {
  borttagnaAvsnitt,
  etikettrad,
  kommentarsverktyg,
  monteraSkrivrutter,
  notisrad,
  nyKommentarForm,
  skrivlage,
} from '../vy/skrivning.js';

export const vyRouter = Router();

// K-1 (Davids beslut #64): Etapp 2a:s avgränsning "inga POST-rutter under /vy"
// är MEDVETET bruten — vyn ska gå att fylla på och rätta i. Invariant 1 ovan
// gäller därför inte längre ordagrant: GET skriver fortfarande aldrig något,
// men POST gör det, genom executeAction precis som /api och först efter
// CSRF-kontroll och en session som härletts ur en API-nyckel.
//
// Monteras FÖRST: formulärparsern (express.urlencoded) ligger i
// monteraSkrivrutter och måste registreras före rutterna som läser en
// formulärkropp.
monteraSkrivrutter(vyRouter);

// Öppet = allt som inte är avslutat eller avbrutet (KRAV-1).
const OPPNA: StateTyp[] = ['backlog', 'unstarted', 'started'];

// Arkivet är 312 ärenden — hela mängden ryms i EN läsning, så överblicken
// slipper paginering. Taken är medvetet högt satta och rapporteras i sidan om
// de någonsin slår i taket: ingen tyst avkapning.
const TAK_ARENDEN = 5000;
const TAK_SOK = 200;
const TAK_DIGEST = 500;
const TAK_FASETTER = 40;

const STATE_TEXT: Record<StateTyp, string> = {
  backlog: 'Backlog',
  unstarted: 'Todo',
  started: 'Pågår',
  completed: 'Klart',
  canceled: 'Avbrutet',
};

// ---- Indata ---------------------------------------------------------------

/**
 * Query-parametrar är otillförlitlig indata: express kan ge sträng, array eller
 * objekt (?q=a&q=b). Vi accepterar ENBART en enkel, icke-tom sträng — allt
 * annat blir "inte satt" i stället för att välta vyn.
 */
function param(varde: unknown): string | undefined {
  if (typeof varde !== 'string') return undefined;
  const trimmad = varde.trim();
  return trimmad === '' ? undefined : trimmad;
}

/** Samma valideringsregler som actions-API:t — annars är fasetterna inte samma filter. */
function giltigText(varde: string | undefined, max: number): string | undefined {
  if (varde === undefined) return undefined;
  return safeText(max).safeParse(varde).success ? varde : undefined;
}

function giltigStateTyp(varde: string | undefined): StateTyp | undefined {
  if (varde === undefined) return undefined;
  const parsad = StateTypSchema.safeParse(varde);
  return parsad.success ? parsad.data : undefined;
}

const FASETTNYCKLAR = ['q', 'status', 'etikett', 'projekt', 'aktor'] as const;
type Fasettnyckel = (typeof FASETTNYCKLAR)[number];
type Val = Partial<Record<Fasettnyckel, string>>;

/**
 * KRAV-3: fasetterna är RENA länkparametrar. Den här bygger länken — inget
 * skript, ingen POST. `nyttVarde: undefined` tar bort filtret.
 */
function sokLank(val: Val, nyckel?: Fasettnyckel, nyttVarde?: string): string {
  const parametrar = new URLSearchParams();
  for (const n of FASETTNYCKLAR) {
    const varde = n === nyckel ? nyttVarde : val[n];
    if (varde !== undefined && varde !== '') parametrar.set(n, varde);
  }
  const fraga = parametrar.toString();
  return `/vy/sok${fraga ? `?${fraga}` : ''}`;
}

function arendeUrl(identifier: string): string {
  return `/vy/arende/${encodeURIComponent(identifier)}`;
}

// ---- Byggstenar ------------------------------------------------------------

function metarad(delar: (string | null)[]): string {
  const texter = delar.filter((d): d is string => d !== null && d !== '');
  return texter.length === 0 ? '' : `<span class=meta>${texter.map(esc).join(' · ')}</span>`;
}

function arendeKort(a: Arende): string {
  const etiketter = a.labels.map((l) => `<span class=tagg>${esc(l)}</span>`).join('');
  return (
    `<a class=kort href="${esc(arendeUrl(a.identifier))}">` +
    `<b>${esc(a.identifier)} — ${esc(a.title)}</b>` +
    `<span class=meta>${statuschip(a.state_typ, a.state_namn)}</span>` +
    metarad([
      prioNamn(a.priority),
      a.due_date ? `senast ${a.due_date}` : null,
      a.milstolpe,
      // K-3: hierarkin syns redan i överblicken — annars ser sändköns 21 barn
      // ut som 21 lösa ärenden.
      a.foralder_identifier ? `del av ${a.foralder_identifier}` : null,
      a.antal_barn > 0 ? `${a.antal_barn} delärenden` : null,
      a.claimad_av ? `plockat av ${a.claimad_av}` : null,
      `uppdaterat ${datum(a.uppdaterad)}`,
    ]) +
    (etiketter ? `<span class=meta>${etiketter}</span>` : '') +
    '</a>'
  );
}

function traffKort(t: Soktraff): string {
  return (
    `<a class=kort href="${esc(arendeUrl(t.identifier))}">` +
    `<b>${esc(t.identifier)} — ${esc(t.title)}</b>` +
    `<span class=meta>${statuschip(t.state_typ, STATE_TEXT[t.state_typ])}</span>` +
    metarad([
      t.traff_i === 'kommentar' ? 'träff i kommentar' : 'träff i ärendetexten',
    ]) +
    '</a>'
  );
}

// Verb vars payload bär ett värdebyte (fran → till). 'andrade_status' fanns
// sedan Etapp 2a; K-2/K-3 lägger till fältändringarna, som skrivs med samma
// payloadform och därför kan visas med samma kod.
const BYTESVERB = new Set([
  'andrade_status',
  'andrade_prioritet',
  'andrade_deadline',
  'andrade_milstolpe',
  'andrade_foralder',
  // K-1. Kommentarsrättelsen står MEDVETET inte här: dess payload bär
  // gammal_text/ny_text, inte fran/till, just för att en 5 000 teckens
  // kommentar inte ska renderas som "A → B" på en digestrad.
  'andrade_projektnamn',
  'andrade_etikettnamn',
  // K-10: ärendets projekt. Skiljs från 'andrade_projektnamn', som byter namn
  // PÅ ett projekt — det här flyttar ett ärende mellan två.
  'andrade_projekt',
]);

/**
 * K-10: skälet, när raden bär ett. Frivilligt fält, så de allra flesta rader
 * (och ALLA historiska) saknar det — och en rad utan skäl renderas som förr,
 * inte som "skäl: —". Ett tomt skäl på varje rad hade lärt läsaren att hoppa
 * över fältet.
 */
function handelseSkal(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null || !('skal' in payload)) return '';
  const skal = (payload as { skal?: unknown }).skal;
  if (typeof skal !== 'string' || skal === '') return '';
  return `<div class=text><b>Skäl:</b> ${esc(skal)}</div>`;
}

/** Ett payloadvärde som text — null blir det uttryckliga "ingen", inte tomt. */
function bytesvarde(varde: unknown): string | null {
  if (varde === null) return 'ingen';
  if (typeof varde === 'string') return varde;
  if (typeof varde === 'number') return String(varde);
  return null;
}

/** Detaljer ur payloaden (jsonb) — läses typsäkert och skrivs alltid escapat. */
function handelseDetalj(verb: string, payload: unknown): string {
  if (!BYTESVERB.has(verb) || typeof payload !== 'object' || payload === null) return '';
  const p = payload as { fran?: unknown; till?: unknown };
  // 'fran' saknas helt (inte null) ⇒ payloaden bär inget byte att visa.
  if (!('fran' in p) || !('till' in p)) return '';
  const fran = bytesvarde(p.fran);
  const till = bytesvarde(p.till);
  if (fran === null || till === null) return '';
  return ` ${esc(fran)} → ${esc(till)}`;
}

// ---- K-3: bilagor, delärenden och relationer -------------------------------

/**
 * Dokumentlänken. url:en går genom sakerUrl() FÖRE esc(): esc gör en farlig
 * adress ofarlig att visa men inte ofarlig att klicka på, och det är klicket
 * som betyder något här. Utan giltigt http/https-schema blir raden ren text.
 */
function bilageRad(b: Bilaga): string {
  const url = sakerUrl(b.url);
  const titel = esc(b.titel);
  const huvud = url
    ? `<a href="${esc(url)}" rel="noopener noreferrer" target=_blank>${titel}</a>`
    : titel;
  return (
    '<li class=rad><div class=huvud>' +
    huvud +
    (url ? `<span>${esc(new URL(url).hostname)}</span>` : '<span>ingen giltig adress</span>') +
    '</div>' +
    (b.undertitel ? `<div class=text>${esc(b.undertitel)}</div>` : '') +
    '</li>'
  );
}

/** Relationen sedd från det ärende sidan visar (relationText avgör riktningen). */
function relationRad(r: Relation): string {
  return (
    '<li class=rad><div class=huvud>' +
    `<span>${esc(relationText(r.typ, r.riktning))}</span>` +
    `<a href="${esc(arendeUrl(r.motpart_identifier))}">${esc(r.motpart_identifier)}</a>` +
    '</div>' +
    `<div class=text>${esc(r.motpart_titel)}</div></li>`
  );
}

/** KRAV-5: varje händelserad bär aktor_typ + aktor_namn ur databasen. */
function handelseRad(h: HandelseIVy): string {
  const lank = h.identifier
    ? `<a href="${esc(arendeUrl(h.identifier))}">${esc(h.identifier)}</a>`
    : '';
  return (
    '<li class=rad><div class=huvud>' +
    `<span>${esc(klockslag(h.tidpunkt))}</span>` +
    proveniens(h.aktor_typ, h.aktor_namn) +
    `<span>${esc(verbText(h.verb))}${handelseDetalj(h.verb, h.payload)}</span>` +
    lank +
    '</div>' +
    (h.arende_titel ? `<div class=text>${esc(h.arende_titel)}</div>` : '') +
    handelseSkal(h.payload) +
    '</li>'
  );
}

// ---- KRAV-1: överblicken ---------------------------------------------------

interface Grupp {
  rubrik: string;
  arenden: Arende[];
  senast: number;
}

/** Grupperar per projekt OCH team; färskast aktivitet överst, både i och mellan grupper. */
function gruppera(arenden: Arende[]): Grupp[] {
  const grupper = new Map<string, Grupp>();
  for (const a of arenden) {
    const nyckel = `${a.projekt ?? ''}\u0000${a.team_key}`;
    let grupp = grupper.get(nyckel);
    if (!grupp) {
      grupp = { rubrik: `${a.projekt ?? 'Utan projekt'} · ${a.team_key}`, arenden: [], senast: 0 };
      grupper.set(nyckel, grupp);
    }
    grupp.arenden.push(a);
    grupp.senast = Math.max(grupp.senast, a.uppdaterad.getTime());
  }
  for (const grupp of grupper.values()) {
    grupp.arenden.sort((a, b) => b.uppdaterad.getTime() - a.uppdaterad.getTime());
  }
  return [...grupper.values()].sort((a, b) => b.senast - a.senast);
}

vyRouter.get('/', async (req, res) => {
  const resultat = await withTransaction((client) =>
    listaArenden(client, TENANT_ID, { stateTyper: OPPNA, limit: TAK_ARENDEN }),
  );
  const grupper = gruppera(resultat.arenden);

  const perTyp = new Map<string, number>();
  for (const a of resultat.arenden) perTyp.set(a.state_typ, (perTyp.get(a.state_typ) ?? 0) + 1);
  const summering = OPPNA.filter((t) => perTyp.has(t))
    .map((t) => `${STATE_TEXT[t]}: ${perTyp.get(t) ?? 0}`)
    .join(' · ');

  const kropp =
    '<h1>Ärenden</h1>' +
    `<p class=summering>${esc(resultat.arenden.length)} öppna ärenden i ` +
    `${esc(grupper.length)} grupper${summering ? ` — ${esc(summering)}` : ''}.</p>` +
    (resultat.pageInfo.har_nasta
      ? `<p class=notis>Visar ${esc(TAK_ARENDEN)} öppna ärenden — det finns fler.</p>`
      : '') +
    (grupper.length === 0
      ? tomtLage(
          'Ingenting öppet just nu',
          'Alla ärenden i plattformen är stängda eller avbrutna.',
          '/vy/digest',
          'Se vad som hänt →',
        )
      : grupper
          .map(
            (g) =>
              `<h2>${esc(g.rubrik)} <span class=summering>(${esc(g.arenden.length)})</span></h2>` +
              g.arenden.map(arendeKort).join(''),
          )
          .join(''));

  res.type('html').send(sida('Ärenden', notisrad(req) + kropp, 'vy', sessionsAktor(req)));
});

// ---- KRAV-2: digesten "vad hände" -----------------------------------------

const FONSTER: { varde: string; dagar: number | null; text: string }[] = [
  { varde: '7', dagar: 7, text: '7 dagar' },
  { varde: '30', dagar: 30, text: '30 dagar' },
  { varde: '90', dagar: 90, text: '90 dagar' },
  { varde: 'alla', dagar: null, text: 'allt' },
];

const KALLORDNING = ['agent', 'manniska', 'system'];
const KALLRUBRIK: Record<string, string> = {
  agent: 'Agenter',
  manniska: 'Människor',
  system: 'System',
};

vyRouter.get('/digest', async (req, res) => {
  const valt = FONSTER.find((f) => f.varde === param(req.query['dagar'])) ?? FONSTER[0]!;
  const handelser = await withTransaction((client) =>
    listaSenasteHandelser(client, TENANT_ID, { dagar: valt.dagar, limit: TAK_DIGEST }),
  );

  // Händelserna kommer nyaste först — Map:en bevarar den ordningen per dag.
  const perDag = new Map<string, HandelseIVy[]>();
  for (const h of handelser) {
    const dag = datum(h.tidpunkt);
    const rader = perDag.get(dag);
    if (rader) rader.push(h);
    else perDag.set(dag, [h]);
  }

  const dagar = [...perDag.entries()]
    .map(([dag, rader]) => {
      // Inom dagen: en rubrik per källa (agent/människa/system). Okända typer
      // hamnar sist i stället för att tappas bort.
      const ordning = (typ: string): number => {
        const i = KALLORDNING.indexOf(typ);
        return i === -1 ? KALLORDNING.length : i;
      };
      const typer = [...new Set(rader.map((h) => h.aktor_typ))].sort(
        (a, b) => ordning(a) - ordning(b) || a.localeCompare(b),
      );
      const avsnitt = typer
        .map((typ) => {
          const iTyp = rader.filter((h) => h.aktor_typ === typ);
          return (
            `<h3>${esc(KALLRUBRIK[typ] ?? typ)} (${esc(iTyp.length)})</h3>` +
            `<ul class=lista role=list>${iTyp.map(handelseRad).join('')}</ul>`
          );
        })
        .join('');
      return `<h2>${esc(dag)} <span class=summering>(${esc(rader.length)})</span></h2>${avsnitt}`;
    })
    .join('');

  // KRAV-5: den valda fönsterlängden bär aria-current — inte bara en färg.
  const fonsterlankar = FONSTER.map(
    (f) =>
      `<a class="fasett${f.varde === valt.varde ? ' aktiv' : ''}"` +
      `${f.varde === valt.varde ? ' aria-current=true' : ''} ` +
      `href="/vy/digest?dagar=${esc(f.varde)}">${esc(f.text)}</a>`,
  ).join('');

  const kropp =
    '<h1>Vad hände</h1>' +
    `<p class=summering>${esc(handelser.length)} händelser — fönster: ${esc(valt.text)}.</p>` +
    '<div class=fasetter><div class=grupp><span class=namn>Visa äldre</span>' +
    `<div class=chips>${fonsterlankar}</div></div></div>` +
    (handelser.length >= TAK_DIGEST
      ? `<p class=notis>Taket ${esc(TAK_DIGEST)} händelser är nått — äldre rader i fönstret visas inte.</p>`
      : '') +
    (handelser.length === 0
      ? tomtLage(
          'Tyst i fönstret',
          'Ingen har rört ett ärende under perioden. Loggen är'
            + ' komplett — det står stilla, det saknas inte.',
          '/vy',
          'Till alla ärenden →',
        )
      : dagar);

  res.type('html').send(sida('Vad hände', kropp, 'digest', sessionsAktor(req)));
});

// ---- K-9: ärendeplattformens EGEN ingång -----------------------------------
//
// "Vad ligger på mig". Ärendeplattformen hade fem läsrutter och ingen som
// svarade på den frågan; redovisningens dashboard var den enda överblicken och
// visar bara redovisning.
//
// OBEROENDET ÄR EGENSKAPEN, inte en bieffekt. Rutten läser ENBART den här
// plattformens egen databas. Den slår inte upp något på 3001 (redovisningen)
// eller 8650 (Hermes-ytan), varken för data eller för en länk. Går någon av
// dem ner svarar den här sidan exakt likadant — och det är mätt, inte påstått
// (~/.hermes/prov/systemoberoende.py).
//
// Högarnas REGLER står utskrivna bredvid rubrikerna. Skälet är att ingen av
// dem är en tilldelning: plattformen har inget ansvarigfält, och en hög som
// bara hette "Mitt" hade läst som ett ansvar den inte kan belägga.

const TAK_HOG = 40;

function mittKort(a: MittArende): string {
  const spar =
    a.sist_aktor_namn === null || a.sist_aktor_typ === null
      ? '<span class=meta>inget spår från en människa eller en agent</span>'
      : '<span class=meta>senaste spåret: ' +
        proveniens(a.sist_aktor_typ, a.sist_aktor_namn) +
        (a.sist_tidpunkt === null ? '' : ` ${esc(datum(a.sist_tidpunkt))}`) +
        '</span>';
  return (
    `<a class=kort href="${esc(arendeUrl(a.identifier))}">` +
    `<b>${esc(a.identifier)} — ${esc(a.title)}</b>` +
    `<span class=meta>${statuschip(a.state_typ, a.state_namn)}</span>` +
    metarad([
      a.projekt ?? 'utan projekt',
      prioNamn(a.priority),
      a.due_date === null ? null : `senast ${a.due_date}`,
    ]) +
    spar +
    '</a>'
  );
}

function hogAvsnitt(h: Hog): string {
  const visade = h.arenden.slice(0, TAK_HOG);
  const kapat =
    h.arenden.length > visade.length
      ? `<p class=notis>Listan visar ${esc(visade.length)} av ${esc(h.arenden.length)}. ` +
        'Talet i rubriken är hela högen — det är listan som är kapad, inte mätningen.</p>'
      : '';
  return (
    `<h2>${esc(h.rubrik)} <span class=summering>(${esc(h.arenden.length)})</span></h2>` +
    `<p class=summering>${esc(h.regel)}</p>` +
    (h.arenden.length === 0
      ? '<p class=notis>Ingen rad uppfyller regeln ovan.</p>'
      : visade.map(mittKort).join('') + kapat)
  );
}

vyRouter.get('/mitt', async (req, res) => {
  const inloggad = sessionsAktor(req);
  // ?aktor= vinner över sessionen: David ska kunna se vad som ligger på Hermes
  // utan att logga ut. Namnet valideras som allt annat i query-strängen.
  const valdAktor = giltigText(param(req.query['aktor']), 200) ?? inloggad?.namn ?? null;
  // Dagens datum tas EN gång och skickas in — byggMittLage kallar aldrig
  // new Date() själv, så provet kan mäta deadlinegränsen utan att vänta.
  const idag = new Date().toISOString().slice(0, 10);

  const lage = await withTransaction(async (client) =>
    byggMittLage(
      await oppnaMedSpar(client, TENANT_ID, valdAktor),
      valdAktor,
      await aktorerMedSpar(client, TENANT_ID),
      idag,
    ),
  );

  const aktorlankar = lage.aktorer_med_spar
    .slice(0, TAK_FASETTER)
    .map((x) => {
      const aktiv = x.aktor_namn === lage.aktor;
      return (
        `<a class="fasett${aktiv ? ' aktiv' : ''}"${aktiv ? ' aria-current=true' : ''} ` +
        `href="/vy/mitt?aktor=${encodeURIComponent(x.aktor_namn)}">` +
        `${esc(x.aktor_namn)} <span class=summering>${esc(x.antal)}</span></a>`
      );
    })
    .join('');

  const stavningsnotis =
    lage.andra_stavningar.length === 0
      ? ''
      : '<p class=notis><b>Två stavningar av samma namn.</b> Spåren bär också ' +
        lage.andra_stavningar.map((n) => `<code>${esc(n)}</code>`).join(', ') +
        `, medan du är inloggad som <code>${esc(lage.aktor ?? '')}</code>. ` +
        'Högarna nedan viker ihop dem — en skiftlägeskänslig jämförelse hade ' +
        'gett noll träffar och sett ut som ett tomt läge. Proveniensen är ' +
        'oföränderlig (migration 0011), så namnen går inte att slå ihop i ' +
        'efterhand; de viks ihop vid läsning, och det står här.</p>';

  const ingenAktor =
    lage.aktor !== null
      ? ''
      : '<p class=notis>Ingen aktör vald. De tre personliga högarna är därför ' +
        'tomma av den anledningen — inte för att ingenting ligger på dig. ' +
        'Logga in, eller välj ett namn ovan.</p>';

  const kropp =
    '<h1>Vad ligger på mig</h1>' +
    `<p class=summering>${esc(lage.oppna)} öppna ärenden i ärendeplattformen` +
    (lage.aktor === null ? '' : `, sett från <b>${esc(lage.aktor)}</b>`) +
    '.</p>' +
    '<div class=fasetter><div class=grupp><span class=namn>Sett från</span>' +
    `<div class=chips>${aktorlankar}</div></div></div>` +
    stavningsnotis +
    ingenAktor +
    '<p class=notis><b>Ingen rad nedan är en tilldelning.</b> ' +
    'Ärendeplattformen har inget ansvarigfält: det finns <code>claimad_av</code>, ' +
    'och den är agentköns och NULL på samtliga ärenden. Varje hög är därför ett ' +
    'påstående om ett <i>fält</i> eller om <i>ordningen i händelseloggen</i>, och ' +
    'regeln står utskriven under rubriken. Importens och återläsningens ' +
    'systemrader räknas inte som spår — annars hade "någon annan skrev sist" ' +
    'betytt "cronen kördes i natt".</p>' +
    '<p class=notis>Sidan läser bara ärendeplattformens egen databas. ' +
    'Redovisningen och Hermes-ytan frågas inte — den här sidan svarar likadant ' +
    'när de är nere.</p>' +
    lage.hogar.map(hogAvsnitt).join('');

  res.type('html').send(sida('Vad ligger på mig', kropp, 'mitt', inloggad));
});

// ---- KRAV-3: sök med fasetter ---------------------------------------------

function fasettgrupp(
  namn: string,
  nyckel: Fasettnyckel,
  alternativ: { varde: string; text: string }[],
  val: Val,
  totalt: number,
): string {
  if (alternativ.length === 0) return '';
  const lankar = alternativ
    .map((alt) => {
      const aktiv = val[nyckel] === alt.varde;
      // En aktiv fasett länkar till samma sida MINUS filtret — så tas den bort.
      const href = sokLank(val, nyckel, aktiv ? undefined : alt.varde);
      // KRAV-5: aktiv fasett märks för uppläsning, inte bara med accentfärgen.
      return (
        `<a class="fasett${aktiv ? ' aktiv' : ''}"${aktiv ? ' aria-current=true' : ''} ` +
        `href="${esc(href)}">${esc(alt.text)}${aktiv ? ' ×' : ''}</a>`
      );
    })
    .join('');
  const kapat =
    totalt > alternativ.length
      ? ` <span class=summering>(visar ${esc(alternativ.length)} av ${esc(totalt)})</span>`
      : '';
  return (
    `<div class=grupp><span class=namn>${esc(namn)}</span>${kapat}` +
    `<div class=chips>${lankar}</div></div>`
  );
}

const AKTIVA_NAMN: { nyckel: Fasettnyckel; namn: string }[] = [
  { nyckel: 'q', namn: 'fritext' },
  { nyckel: 'status', namn: 'status' },
  { nyckel: 'etikett', namn: 'etikett' },
  { nyckel: 'projekt', namn: 'projekt' },
  { nyckel: 'aktor', namn: 'aktör' },
];

vyRouter.get('/sok', async (req, res) => {
  const raQ = param(req.query['q']);
  const val: Val = {};
  const q = giltigText(raQ, 200);
  const status = giltigStateTyp(param(req.query['status']));
  const etikett = giltigText(param(req.query['etikett']), 100);
  const projekt = giltigText(param(req.query['projekt']), 200);
  const aktor = giltigText(param(req.query['aktor']), 200);
  if (q !== undefined) val.q = q;
  if (status !== undefined) val.status = status;
  if (etikett !== undefined) val.etikett = etikett;
  if (projekt !== undefined) val.projekt = projekt;
  if (aktor !== undefined) val.aktor = aktor;

  const harArendefilter = status !== undefined || etikett !== undefined || projekt !== undefined;
  // Listan behövs när ärendefasetterna ska tillämpas — och när aktörsfasetten
  // står ensam utan fritext (då är den träffmängden). Bar /vy/sok listar inget:
  // då visas formuläret och fasettlänkarna.
  const behoverLista = harArendefilter || (q === undefined && aktor !== undefined);

  const data = await withTransaction(async (client) => ({
    traffar: q === undefined ? null : await sokArenden(client, TENANT_ID, q, TAK_SOK),
    // Status/etikett/projekt är SAMMA filter som list_issues.
    filtrerade: behoverLista
      ? (
          await listaArenden(client, TENANT_ID, {
            ...(status ? { stateTyper: [status] } : {}),
            ...(etikett ? { label: etikett } : {}),
            ...(projekt ? { projekt } : {}),
            limit: TAK_ARENDEN,
          })
        ).arenden
      : null,
    // KRAV-3: aktör filtrerar på AKTIVITET (händelser/kommentarer) — ärenden
    // har ingen aktör, och det är aktiviteten David vill kunna söka i.
    aktivaFor: aktor === undefined ? null : new Set(await arendenMedAktivitetAv(client, TENANT_ID, aktor)),
    projektnamn: await listaProjektnamn(client, TENANT_ID),
    etikettnamn: await listaEtikettnamn(client, TENANT_ID),
    aktorer: await listaAktorer(client, TENANT_ID, TAK_FASETTER),
  }));

  let resultat = '';
  let antal = 0;
  if (data.traffar) {
    const tillatna = data.filtrerade ? new Set(data.filtrerade.map((a) => a.id)) : null;
    const kvar = data.traffar.filter(
      (t) => (!tillatna || tillatna.has(t.id)) && (!data.aktivaFor || data.aktivaFor.has(t.id)),
    );
    antal = kvar.length;
    resultat = kvar.map(traffKort).join('');
  } else if (data.filtrerade) {
    const kvar = data.filtrerade.filter((a) => !data.aktivaFor || data.aktivaFor.has(a.id));
    antal = kvar.length;
    resultat = kvar.map(arendeKort).join('');
  }

  const aktiva = AKTIVA_NAMN.filter(({ nyckel }) => val[nyckel] !== undefined)
    .map(({ nyckel, namn }) => {
      const varde = nyckel === 'status' ? STATE_TEXT[status!] : val[nyckel]!;
      return (
        `<a class="fasett aktiv" aria-current=true ` +
        `href="${esc(sokLank(val, nyckel, undefined))}">${esc(namn)}: ${esc(varde)} ×</a>`
      );
    })
    .join('');

  // Fasetterna följer med när man söker på nytt ord (formuläret är GET).
  const doldaFalt = FASETTNYCKLAR.filter((n) => n !== 'q' && val[n] !== undefined)
    .map((n) => `<input type=hidden name="${esc(n)}" value="${esc(val[n])}">`)
    .join('');

  const kropp =
    '<h1>Sök</h1>' +
    '<form class=sok method=get action="/vy/sok">' +
    // Etiketten är osynlig men uppläst — platshållaren är ingen etikett (WCAG 3.3.2).
    '<label class=dold for=q>Sök i titlar, beskrivningar och kommentarer</label>' +
    `<input type=search id=q name=q value="${esc(val.q)}" ` +
    'placeholder="Sök i titlar, beskrivningar och kommentarer">' +
    `${doldaFalt}<button type=submit>Sök</button></form>` +
    (raQ !== undefined && q === undefined
      ? '<p class=notis>Sökordet kunde inte tolkas (för långt eller otillåtna tecken) och ignorerades.</p>'
      : '') +
    (aktiva
      ? '<div class=fasetter><div class=grupp><span class=namn>Aktiva filter</span>' +
        `<div class=chips>${aktiva}</div></div></div>`
      : '') +
    '<div class=fasetter>' +
    fasettgrupp(
      'Status',
      'status',
      StateTypSchema.options.map((t) => ({ varde: t, text: STATE_TEXT[t] })),
      val,
      StateTypSchema.options.length,
    ) +
    fasettgrupp(
      'Projekt',
      'projekt',
      data.projektnamn.slice(0, TAK_FASETTER).map((p) => ({ varde: p, text: p })),
      val,
      data.projektnamn.length,
    ) +
    fasettgrupp(
      'Etikett',
      'etikett',
      data.etikettnamn.slice(0, TAK_FASETTER).map((l) => ({ varde: l, text: l })),
      val,
      data.etikettnamn.length,
    ) +
    fasettgrupp(
      'Aktör (aktivitet)',
      'aktor',
      data.aktorer.map((a) => ({ varde: a.aktor_namn, text: `${a.aktor_namn} (${a.antal})` })),
      val,
      data.aktorer.length,
    ) +
    '</div>' +
    (data.traffar === null && data.filtrerade === null
      ? '<p class=notis>Skriv ett sökord eller välj en fasett ovan.</p>'
      : `<p class=summering>${esc(antal)} träffar.</p>` +
        (data.traffar !== null && data.traffar.length >= TAK_SOK
          ? `<p class=notis>Taket ${esc(TAK_SOK)} träffar är nått — förfina sökningen.</p>`
          : '') +
        (antal === 0
        ? tomtLage(
            'Inga träffar.',
            'Sökningen läser ärendetext och kommentarer. Prova ett'
              + ' ärendenummer, ett kundnamn eller ett kortare ord.',
            '/vy',
            'Bläddra i stället →',
          )
        : resultat));

  res.type('html').send(sida('Sök', kropp, 'sok', sessionsAktor(req)));
});

// ---- KRAV-4: ärendesidan ---------------------------------------------------

function ickeFunnen(vad: string): string {
  return sida(
    'Hittades inte',
    '<h1>Hittades inte</h1>' +
      `<p class=notis>${esc(vad)}</p>` +
      '<p><a href="/vy">Till överblicken</a></p>',
  );
}

vyRouter.get('/arende/:identifier', async (req, res) => {
  const ra = req.params.identifier ?? '';
  const parsad = IdentifierSchema.safeParse(ra);
  if (!parsad.success) {
    res
      .status(404)
      .type('html')
      .send(ickeFunnen(`"${ra}" är inte ett ärendenummer (de ser ut som LOC-316).`));
    return;
  }
  const identifier = parsad.data;

  // Autolänkningen läser bara cachen (KRAV-5) — inga filsystemssökningar här.
  const index = await hamtaIndex();
  const data = await withTransaction(async (client) => {
    const arende = await hamtaArende(client, TENANT_ID, identifier);
    return {
      arende,
      kommentarer: await listaKommentarer(client, TENANT_ID, arende.id),
      handelser: await listaHandelser(client, TENANT_ID, arende.id),
      // K-3: strukturen runt ärendet — delärenden, relationer och de
      // dokumentlänkar som annars inte finns någon annanstans.
      barn: await barnFor(client, TENANT_ID, arende.id),
      relationer: await relationerFor(client, TENANT_ID, arende.id),
      bilagor: await bilagorFor(client, TENANT_ID, arende.id),
      // K-1: de mjukt borttagna — endast id och tidpunkt, aldrig text/aktör.
      borttagna: await listaBorttagnaKommentarer(client, TENANT_ID, arende.id),
    };
  }).catch((err: unknown) => {
    // Okänt ärende ska bli en vanlig HTML-sida, inte API:ts JSON-404.
    if (err instanceof NotFoundError) return null;
    throw err;
  });

  if (!data) {
    res.status(404).type('html').send(ickeFunnen(`Ärendet ${identifier} finns inte.`));
    return;
  }

  const a = data.arende;
  // K-1: skrivläget. Aktören kommer ur sessionen, som i sin tur kommer ur en
  // API-nyckel (src/http/vy/session.ts) — aldrig ur ett formulärfält.
  const aktor = sessionsAktor(req);
  const retur = arendeUrl(a.identifier);
  const etiketter = etikettrad(aktor, a.identifier, a.labels);

  // CRM KRAV-1/5: ENDAST här, och bara när ärendet mappar till en organisation.
  // hamtaCrm() kan aldrig kasta (KRAV-3) — värsta utfallet är fallbacktexten.
  // K-4: kortet visas när ärendets PROJEKT är kopplat till en kund med id.
  // Ingen namnmatchning och ingen gissning ur titeln: är kopplingen inte
  // gjord visas inget kort alls, och det är ett ärligare svar än fel kund.
  const crm = a.kund_id === null ? '' : crmKort(await hamtaCrm(a.kund_id));

  // KRAV-5: varje kommentar bär aktor_typ + aktor_namn ur comments-tabellen.
  const kommentarer = data.kommentarer
    .map(
      (k) =>
        '<li class=rad><div class=huvud>' +
        `<span>${esc(datumtid(k.skapad))}</span>` +
        proveniens(k.aktor_typ, k.aktor_namn) +
        '</div>' +
        `<div class=text>${renderaArendetext(k.body, index)}</div>` +
        kommentarsverktyg(aktor, k, retur) +
        '</li>',
    )
    .join('');

  const historik = data.handelser
    .map(
      (h) =>
        '<li class=rad><div class=huvud>' +
        `<span>${esc(datumtid(h.tidpunkt))}</span>` +
        proveniens(h.aktor_typ, h.aktor_namn) +
        `<span>${esc(verbText(h.verb))}${handelseDetalj(h.verb, h.payload)}</span>` +
        '</div>' +
        handelseSkal(h.payload) +
        '</li>',
    )
    .join('');

  // K-3: föräldern är en LÄNK och kan därför inte ligga i den escapade
  // summeringssträngen — den får en egen rad ovanför beskrivningen.
  const foralderrad =
    a.foralder_identifier === null
      ? ''
      : `<p class=summering>Del av <a href="${esc(arendeUrl(a.foralder_identifier))}">` +
        `${esc(a.foralder_identifier)}</a> — ${esc(a.foralder_titel ?? '')}</p>`;

  const kropp =
    `<h1>${esc(a.identifier)} — ${esc(a.title)}</h1>` +
    `<p class=summering>${statuschip(a.state_typ, a.state_namn)} ${esc(
      [
        prioNamn(a.priority),
        a.due_date ? `senast ${a.due_date}` : null,
        a.milstolpe,
        a.projekt ?? 'utan projekt',
        `team ${a.team_key}`,
        a.claimad_av ? `plockat av ${a.claimad_av}` : null,
        `skapat ${datum(a.skapad)}`,
        `uppdaterat ${datum(a.uppdaterad)}`,
      ]
        .filter((d): d is string => d !== null)
        .join(' · '),
    )}</p>` +
    foralderrad +
    etiketter +
    notisrad(req) +
    skrivlage(aktor, retur) +
    crm +
    '<h2>Beskrivning</h2>' +
    (a.description.trim()
      ? `<div class=text>${renderaArendetext(a.description, index)}</div>`
      : '<p class=notis>Ingen beskrivning.</p>') +
    // Bilagorna står FÖRE kommentarerna: det är dokumentlänkarna David letade
    // efter 19/8, och trettio av dem finns ingen annanstans i systemet.
    (data.bilagor.length > 0
      ? `<h2>Bilagor (${esc(data.bilagor.length)})</h2>` +
        `<ul class=lista role=list>${data.bilagor.map(bilageRad).join('')}</ul>`
      : '') +
    (data.barn.length > 0
      ? `<h2>Delärenden (${esc(data.barn.length)})</h2>` + data.barn.map(arendeKort).join('')
      : '') +
    (data.relationer.length > 0
      ? `<h2>Relationer (${esc(data.relationer.length)})</h2>` +
        `<ul class=lista role=list>${data.relationer.map(relationRad).join('')}</ul>`
      : '') +
    `<h2>Kommentarer (${esc(data.kommentarer.length)})</h2>` +
    (kommentarer ? `<ul class=lista role=list>${kommentarer}</ul>` : '<p class=notis>Ingen har kommenterat det här ärendet ännu.</p>') +
    nyKommentarForm(aktor, a.identifier) +
    borttagnaAvsnitt(aktor, data.borttagna, retur) +
    `<h2>Historik (${esc(data.handelser.length)})</h2>` +
    (historik ? `<ul class=lista role=list>${historik}</ul>` : '<p class=notis>Ärendet har inte ändrats sedan det kom in.</p>');

  res.type('html').send(
    sida(a.identifier, kropp, undefined, aktor, [
      ['Alla', '/vy'],
      [a.identifier, null],
    ]),
  );
});

// ---- Dokumentlänkar KRAV-1/2: dokumentsidan --------------------------------

/**
 * KRAV-2: ETT svar för allt som inte serveras — utanför vitlistan, path
 * traversal, symlink ut ur vaulten, eller helt enkelt en fil som inte finns.
 * Svaret bär varken filinnehåll, katalognamn eller den begärda sökvägen: det
 * bekräftar aldrig att ett dokument utanför området existerar.
 */
function utanforOmradet(): string {
  return sida(
    'Hittades inte',
    '<h1>Hittades inte</h1>' +
      '<p class=notis>Dokumentet är utanför vyns dokumentområde.</p>' +
      '<p><a href="/vy">Till överblicken</a></p>',
  );
}

vyRouter.get('/dok/*sokvag', async (req, res) => {
  // Express 5 ger wildcard-parametern som segmentlista; ta emot båda formerna.
  const ra: unknown = req.params['sokvag'];
  const begard = Array.isArray(ra) ? ra.join('/') : typeof ra === 'string' ? ra : '';

  const rel = sakerSokvag(begard);
  const innehall = rel === null ? null : await lasDokument(rel);
  if (rel === null || innehall === null) {
    res.status(404).type('html').send(utanforOmradet());
    return;
  }

  const index = await hamtaIndex();
  const namn = rel.slice(rel.lastIndexOf('/') + 1);
  const obsidian =
    `obsidian://open?vault=${encodeURIComponent(path.basename(config.VAULT_PATH))}` +
    `&file=${encodeURIComponent(rel.slice(0, -'.md'.length))}`;

  const kropp =
    `<h1>${esc(namn)}</h1>` +
    `<p class=summering>${esc(rel)} · ` +
    `<a href="${esc(obsidian)}">öppna i Obsidian</a></p>` +
    `<div class=dok>${renderaMarkdown(innehall, index)}</div>`;

  res.type('html').send(
    sida(namn, kropp, undefined, sessionsAktor(req), [
      ['Alla', '/vy'],
      ['Dokument', null],
      [namn, null],
    ]),
  );
});

// Okänd /vy-sökväg svarar HTML — inte API:ts JSON-404 (KRAV-7).
// Designkontraktet. Vyns EGNA typsnittsfiler: samma woff2-innehall som
// redovisningens och Hermes-ytans, men en egen kopia pa en egen rutt. En delad
// sokvag mellan systemen hade varit precis den bindning K-9 forbjuder.
// Listan ar en TILLATELSELISTA, inte ett filter: bara dessa sju namn nas, sa
// ingen sokvag kan pekas nagon annanstans. Rutten ligger fore 404-fangaren.
// Sokvagen harleds ur MODULENS egen plats, inte ur arbetskatalogen: src/ och
// dist/ ligger lika djupt, sa samma tre steg upp traffar ratt i bada — och
// provet kor mot src medan tjansten kor mot dist.
const TYPSNITT_KAT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../assets/typsnitt',
);
const TYPSNITT_FILER = new Set([
  'public-sans-latin-400-normal.woff2',
  'public-sans-latin-600-normal.woff2',
  'public-sans-latin-700-normal.woff2',
  'ibm-plex-mono-latin-400-normal.woff2',
  'ibm-plex-mono-latin-600-normal.woff2',
  'LICENSE-public-sans.txt',
  'LICENSE-ibm-plex-mono.txt',
]);

vyRouter.get('/typsnitt/:fil', (req, res, next) => {
  const fil = req.params.fil;
  if (!TYPSNITT_FILER.has(fil)) return next();
  res.type(fil.endsWith('.woff2') ? 'font/woff2' : 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.sendFile(path.join(TYPSNITT_KAT, fil), (fel) => {
    if (fel) next();
  });
});

vyRouter.use((_req, res) => {
  res.status(404).type('html').send(ickeFunnen('Sidan finns inte.'));
});
