// D-3, D-4, FR-12, B-24 och B-25 (Story 11.6 AK 1–7): historiken på ärendesidan visar vem, vad och när, med
// svaren ordagrant. För 21 verb står payloadfälten som den slutna tabellen DETALJFALT i src/http/vy/kort.ts
// anger under radens huvud, som etikett och värde i escapad ren text och med källan «händelse #<id>», och
// handelsensDetaljer i samma modul är den enda vägen från en händelse till dess detaljer.
//
// Fallistorna: AK 1 provets tabell VERBFALT med de 21 verben mot DETALJFALT och VERB, och varje slag i
// DETALJSLAG (HD1), ett fall per slag (HD2) och en rad per verb på fyra sidor, skriven genom actions (HD5); AK 2
// svaret med <script>, [[dokument]], LOC-1, en http-adress och en radbrytning på funktionsnivå (HD2) och på
// sidan, märkena på två rader och källraden med radens id ur databasen (HD6); AK 5 sex privata sökvägar i två
// bärare och journal-sökvägen i de femton positionerna i PRIVATA_BARARE (HD3), och på sidan en privat grund,
// ett privat underlag genom actionen och en äldre rad med det lagrade underlaget (HD7); AK 6 de 21 verben med
// fyra payloadformer och fyra payloader som inte är objekt (HD4), och på sidan tre äldre rader och en
// kontrollrad (HD8); AK 3 en andrade_status-rad och en andrade_prioritet-rad med skäl och en
// rattade_beskrivning-rad (HD9); AK 4 digesten och den statiska räkningen i ärenderutten (HD10); AK 7
// motprovets byggdel: HD5–HD8 skrevs före ärenderuttens ändring, och varje sidfall börjar med motkontrollen
// (200, rubriken och Historik (N) med radernas antal).
//
// Review-uppföljningen: AK 2 ett ärende i varje position där detaljerna visar en referens samlas som
// kandidat, och på sidan länkas fem ärenden som bara historiken nämner, vart och ett i en annan position och
// prövat att det inte står någon annanstans på sidan (HD11); AK 2 varje fält i nästa steg, villkoret, hindret,
// resultatet, avslutsskälet och det tidigare, läst ur domäntyperna i src/services/atagande.ts, syns i värdet,
// det som står utöver fälten står som «övrigt», och ett byte vars sidor skrivs lika står med raden om formen
// (HD12); AK 6 en tid bara i ISO-formen, i var och en av de fem positionerna där detaljerna visar en tid (HD13).
//
// Varje (R)-fall och varje frånvaro har en kontroll i samma fall som visar att mätningen kan slå ut.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import type { Dokumentindex } from '../src/http/vy/dokument.js';
import * as dokumentet from '../src/http/vy/dokument.js';
// Story 11.6: namnrymd och inga namngivna importer för det som berättelsen lägger till, så att ett fall som
// behöver en export som ännu saknas blir rött med «är inte en funktion» och inte fäller hela filen.
import * as kortmodulen from '../src/http/vy/kort.js';
import { datumtid, esc, proveniens, statusord, VERB } from '../src/http/vy/mall.js';
import { arendekandidater } from '../src/http/vy/markdown.js';
import { arendeSokvag, nummeruppslagSokvag } from '../src/lib/arendelank.js';
import { TEST_VY_PUBLIK_URL } from './env.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

let app: Express;
let hermes: string; // agent
let david: string; // människa

beforeAll(async () => {
  app = createApp();
  await seedaTeam();
  hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  // Uppgift 2: ärendena som sidfallen läser (Dev Notes → Fixturen).
  await byggFixturen();
});

// ---- Provets egna kopior (Dev Notes → DETALJFALT och Detaljslagen och markupen) ------------------------

/**
 * AK 1: provets egen tabell, avskriven ur Dev Notes → DETALJFALT: verb → fälten som [nyckel, etikett, slag] i
 * ordning. Slaget står med, så att HD4 kan bygga ett värde av rätt och av fel typ för varje verbs första fält.
 */
const VERBFALT: Record<string, [nyckel: string, etikett: string, slag: string][]> = {
  skapade_arende: [['title', 'Titel', 'text']],
  registrerade_atagande: [
    ['lage', 'Läge', 'lage'],
    ['tillhor', 'Tillhörighet', 'tillhor'],
    ['revision', 'Revision', 'tal'],
    ['grund', 'Grund', 'referenser'],
    ['andring', 'Ändring', 'andring'],
  ],
  atagandet_fanns_redan: [
    ['lage', 'Läge', 'lage'],
    ['tillhor', 'Tillhörighet', 'tillhor'],
    ['revision', 'Revision', 'tal'],
  ],
  tog_over_atagande: [
    ['utforare', 'Utförare', 'utforare'],
    ['nasta', 'Nästa steg', 'nasta'],
    ['revision', 'Revision', 'tal'],
    ['grund', 'Grund', 'referens'],
    ['andring', 'Ändring', 'andring'],
  ],
  andrade_atagande: [
    ['tillhor', 'Tillhörighet', 'tillhor'],
    ['nasta', 'Nästa steg', 'nasta'],
    ['revision', 'Revision', 'tal'],
    ['skal', 'Skäl', 'text'],
    ['andring', 'Ändring', 'andring'],
  ],
  hindrade_atagande: [
    ['orsak', 'Orsak', 'text'],
    ['revision', 'Revision', 'tal'],
    ['andring', 'Ändring', 'andring'],
  ],
  redovisade_resultat: [
    ['sammanfattning', 'Sammanfattning', 'text'],
    ['antal_belagg', 'Antal belägg', 'tal'],
    ['revision', 'Revision', 'tal'],
    ['andring', 'Ändring', 'andring'],
  ],
  avslutade_atagande: [
    ['skal', 'Skäl', 'text'],
    ['grund', 'Grund', 'referens'],
    ['revision', 'Revision', 'tal'],
    ['andring', 'Ändring', 'andring'],
  ],
  aterppnade_atagande: [
    ['grund', 'Grund', 'referens'],
    ['revision', 'Revision', 'tal'],
    ['tidigare', 'Tidigare', 'tidigare'],
    ['andring', 'Ändring', 'andring'],
  ],
  kopplade_beslut: [['beslut_id', 'Beslut', 'beslut']],
  beslutet_var_redan_kopplat: [['beslut_id', 'Beslut', 'beslut']],
  behandlade_svarsversion: [
    ['beslut_id', 'Beslut', 'beslut'],
    ['version', 'Version', 'tal'],
    ['svar_hash', 'Svarshash', 'kod'],
  ],
  svarsversionen_var_behandlad: [
    ['beslut_id', 'Beslut', 'beslut'],
    ['version', 'Version', 'tal'],
    ['svar_hash', 'Svarshash', 'kod'],
  ],
  registrerade_insats: [
    ['typ', 'Typ', 'insatstyp'],
    ['tillhor', 'Tillhörighet', 'tillhor'],
    ['stopp_id', 'Stopp', 'kod'],
    ['kallor', 'Antal källor', 'tal'],
    ['krockar', 'Krockar', 'krockar'],
  ],
  insatsen_fanns_redan: [
    ['typ', 'Typ', 'insatstyp'],
    ['tillhor', 'Tillhörighet', 'tillhor'],
    ['stopp_id', 'Stopp', 'kod'],
    ['kallor', 'Antal källor', 'tal'],
    ['krockar', 'Krockar', 'krockar'],
  ],
  besvarade_insats: [
    ['typ', 'Typ', 'insatstyp'],
    ['svar', 'Svar', 'svar'],
    ['handlingskontrakt', 'Handlingskontrakt', 'handlingskontrakt'],
  ],
  skot_upp_insats: [
    ['till', 'Till', 'tid'],
    ['skal', 'Skäl', 'text'],
  ],
  aterkallade_insats: [['skal', 'Skäl', 'text']],
  skrev_arbetsmoment: [
    ['moment', 'Moment', 'moment'],
    ['beslut_id', 'Beslut', 'beslut'],
    ['historisk', 'Historisk', 'janej'],
  ],
  kopplade_insats_till_arende: [
    ['insats_id', 'Insats', 'kod'],
    ['identifier', 'Ärende', 'kod'],
  ],
  insatsen_var_redan_kopplad: [
    ['insats_id', 'Insats', 'kod'],
    ['identifier', 'Ärende', 'kod'],
  ],
};

/** Slagen som provets tabell använder. */
const SLAGEN = [...new Set(Object.values(VERBFALT).flatMap((falt) => falt.map(([, , slag]) => slag)))].sort();

/** Kodens form av en tabell: verb → fält med nyckel, etikett och slag. */
type Kodtabell = Record<string, readonly { nyckel: string; etikett: string; slag: string }[]>;

/** Provets tabell i kodens form, för kontrollerna i HD1. */
function somKod(tabell: typeof VERBFALT): Kodtabell {
  return Object.fromEntries(
    Object.entries(tabell).map(([verb, falt]) => [verb, falt.map(([nyckel, etikett, slag]) => ({ nyckel, etikett, slag }))]),
  );
}

/**
 * Skillnaderna mellan provets tabell och kodens: samma verb, och per verb samma nycklar, etiketter och slag i
 * samma ordning. Tom lista = tabellerna är lika.
 */
function tabellfel(egen: typeof VERBFALT, kodens: Kodtabell): string[] {
  const fynd: string[] = [];
  for (const verb of new Set([...Object.keys(egen), ...Object.keys(kodens)])) {
    if (!Object.hasOwn(egen, verb)) {
      fynd.push(`${verb}: står i koden men inte i provet`);
      continue;
    }
    if (!Object.hasOwn(kodens, verb)) {
      fynd.push(`${verb}: saknas i koden`);
      continue;
    }
    const vantat = (egen[verb] ?? []).map(([nyckel, etikett, slag]) => `${nyckel} · ${etikett} · ${slag}`);
    const faktiskt = (kodens[verb] ?? []).map((f) => `${f.nyckel} · ${f.etikett} · ${f.slag}`);
    if (JSON.stringify(faktiskt) !== JSON.stringify(vantat)) {
      fynd.push(`${verb}: ${JSON.stringify(faktiskt)} i stället för ${JSON.stringify(vantat)}`);
    }
  }
  return fynd;
}

/** De fasta meningarna ordagrant. Provet har egna kopior och läser dem inte ur modulen. */
const PRIVAT = 'Källa i ett privat område — visas inte på kortet.';
const OKAND_FORM = 'Referens i en form som kortet inte läser — visas inte på kortet.';
const OKAND_DEL = 'Uppgift i en form som kortet inte läser — visas inte på kortet.';

/** Raden för ett fält i fel form, som felform i src/http/vy/kort.ts skriver den. */
function fel(etikett: string): string {
  return `<p>${esc(etikett)}: ${esc(OKAND_DEL)}</p>`;
}

/** Ett proveniensmärke som proveniens() i src/http/vy/mall.ts skriver det (som i test/arendekort.test.ts). */
const PROVENIENSMARKE = /<span class="prov [^"]*" title="[^"]*"><span aria-hidden=true>[^<]*<\/span>[^<]*<\/span>/g;

/**
 * AK 6: markupen utan proveniensmärkena och utan de tre fasta meningarna, som alla bär tankstrecket i sin
 * text. Ett «—» som står kvar är ett påhittat värde.
 */
function utanFastaTexter(html: string): string {
  let ut = html.replace(PROVENIENSMARKE, '');
  for (const text of [OKAND_DEL, OKAND_FORM, PRIVAT]) ut = ut.split(esc(text)).join('');
  return ut;
}

// ---- Funktionsnivån -------------------------------------------------------------------------------------

/** Händelsens id på funktionsnivå, och källraden som det ger. */
const ID = 4711;
const KALLRAD = `<p>Källa: händelse #${ID}</p>`;

/** En påhittad händelse. Aktören är den som svarade på en besvarad insats. */
function handelse(verb: string, payload: unknown) {
  return { id: ID, verb, payload, aktor_typ: 'manniska', aktor_namn: 'hd-david' };
}

/** Uppslaget och dokumentindexet i minnet, som K23 i test/arendekort.test.ts bygger dem. */
const UPPSLAGET = { team: new Set(['LOC']), arenden: new Set(['LOC-7']) };
const INDEX: Dokumentindex = { filnamn: new Map() };

function detaljerFor(verb: string, payload: unknown): string {
  return kortmodulen.handelsensDetaljer(handelse(verb, payload), INDEX, UPPSLAGET);
}

/** AK 2: svaret med de fyra formerna och en radbrytning, som ska stå ordagrant och som text. */
const SVAR = '<script>alert("hd")</script> [[dokument]] LOC-1 https://example.com/hd-svar\nandra raden';
/** En tid på funktionsnivå. */
const TID = '2026-11-02T09:30:00.000Z';
/** Ett härlett underlag, ärendets absoluta adress (Story 11.3). */
const UNDERLAG = `${TEST_VY_PUBLIK_URL}${arendeSokvag('LOC-7')}`;

/** Ändringen i HD2: varje fält i ANDRINGSDEL, ett byte i fel form och en nyckel som tabellen inte känner. */
const ANDRINGEN = {
  lage: { fran: 'registrerat', till: 'overtaget' },
  tillhor: { fran: 'hermes', till: 'agare' },
  utforare_typ: { fran: null, till: 'manniska' },
  utforare_namn: { fran: null, till: 'hd-david' },
  overtaget_nar: { fran: null, till: TID },
  foljs_upp: 'inget byte',
  grund: { fran: [], till: [{ typ: 'beslut', id: '153' }] },
  nasta: { fran: null, till: { handling: 'HD <nästa>', slag: 'riktning', grund: { typ: 'beslut', id: '172' } } },
  villkor: { fran: [{ text: 'HD villkor', kalla: { typ: 'beslut', id: '153' }, utfall: 'uppfyllt' }], till: [] },
  utfall_precisering: { fran: 'HD före', till: 'HD <efter>' },
  hinder: { fran: { orsak: 'HD hinder', belagg: { typ: 'beslut', id: '145' } }, till: null },
  resultat: {
    fran: null,
    till: { sammanfattning: 'HD resultat', belagg: [{ typ: 'prov', id: 'hd-p' }, { typ: 'commit', id: 'hd-c' }], kontrollerat: TID },
  },
  avslutsskal: { fran: { text: 'HD skäl', grund: { typ: 'beslut', id: '160' } }, till: null },
  okand_nyckel: { fran: 1, till: 2 },
};

/**
 * AK 1 och AK 2: ett fall per slag i DETALJSLAG, med verbet, payloaden och den väntade markupen ordagrant
 * (utan källraden). Nycklarna ska vara exakt slagen: ett slag utan fall fäller provet.
 */
const SLAGFALL: Record<string, [verb: string, payload: Record<string, unknown>, markup: string]> = {
  text: [
    'skapade_arende',
    { identifier: 'LOC-7', title: 'HD <titel> & "citat"' },
    `<div class=text><b>Titel:</b> ${esc('HD <titel> & "citat"')}</div>`,
  ],
  svar: [
    'besvarade_insats',
    { insats_id: 'hd-insats', svar: SVAR },
    `<div class=text><b>Svar:</b> ${esc(SVAR)}</div><p>Svarat av ${proveniens('manniska', 'hd-david')}</p>`,
  ],
  tal: ['redovisade_resultat', { antal_belagg: 2 }, '<p>Antal belägg: 2</p>'],
  tid: ['skot_upp_insats', { till: TID }, `<p>Till: ${esc(datumtid(new Date(TID)))}</p>`],
  lage: ['atagandet_fanns_redan', { lage: 'overtaget' }, '<p>Läge: övertaget</p>'],
  tillhor: ['andrade_atagande', { tillhor: 'hermes' }, '<p>Tillhörighet: Hermes</p>'],
  insatstyp: ['registrerade_insats', { typ: 'utathandling' }, '<p>Typ: utåthandling</p>'],
  moment: ['skrev_arbetsmoment', { moment: 'avgora_riktning' }, '<p>Moment: avgöra riktning</p>'],
  janej: ['skrev_arbetsmoment', { historisk: false }, '<p>Historisk: nej</p>'],
  kod: ['kopplade_insats_till_arende', { insats_id: 'hd-<insats>' }, `<p>Insats: <code>${esc('hd-<insats>')}</code></p>`],
  beslut: ['kopplade_beslut', { beslut_id: 145 }, '<p>Beslut: #145</p>'],
  referens: [
    'avslutade_atagande',
    { grund: { typ: 'beslut', id: '160', version: '2' } },
    '<p>Grund: <code>beslut</code> · <code>160</code> · version <code>2</code></p>',
  ],
  referenser: [
    'registrerade_atagande',
    { grund: [{ typ: 'beslut', id: '153' }, { typ: 'arende', id: 'LOC-7' }] },
    `<p>Grund: <code>beslut</code> · <code>153</code>; <code>arende</code> · <a href="${arendeSokvag('LOC-7')}">LOC-7</a></p>`,
  ],
  nasta: [
    'tog_over_atagande',
    { nasta: { handling: 'HD <gör> det', slag: 'riktning', grund: { typ: 'beslut', id: '172' } } },
    `<div class=text><b>Nästa steg (riktning):</b> ${esc('HD <gör> det')}</div>` +
      '<p>Nästa stegs grund: <code>beslut</code> · <code>172</code></p>',
  ],
  utforare: [
    'tog_over_atagande',
    { utforare_typ: 'agent', utforare_namn: 'hd-agent' },
    `<p>Utförare: ${proveniens('agent', 'hd-agent')}</p>`,
  ],
  handlingskontrakt: [
    'besvarade_insats',
    {
      handlingskontrakt: {
        system: 'arenden',
        kommando: 'beslutskoe --besvara',
        objekt: '#153',
        underlag: UNDERLAG,
        underlag_harlett: true,
        underlag_lagrat: 'docs/hd-lagrat.md',
      },
    },
    '<p>Handlingskontrakt: <code>arenden</code> · <code>beslutskoe --besvara</code> · <code>#153</code> · ' +
      `<code>${esc(UNDERLAG)}</code></p>`,
  ],
  krockar: [
    'registrerade_insats',
    {
      krockar: [
        { system: 'hd-crm', objekttyp: 'uppdrag', objekt_id: 'hd-k1' },
        { system: 'hd-crm', objekttyp: 'uppdrag', objekt_id: 'hd-k2', objekt_version: '3', lank: 'https://example.com/hd-k2' },
        'trasig krock',
      ],
    },
    '<p>Krockar: 3</p>' +
      '<p>Källa: <code>hd-crm</code> · <code>uppdrag</code> · <code>hd-k1</code></p>' +
      '<p>Källa: <code>hd-crm</code> · <code>uppdrag</code> · <code>hd-k2</code> · version <code>3</code> · ' +
      '<a href="https://example.com/hd-k2" rel="noreferrer noopener">länk</a></p>' +
      fel('Krock'),
  ],
  andring: [
    'andrade_atagande',
    { andring: ANDRINGEN },
    '<div class=text><b>Ändring, Läge:</b> registrerat → övertaget</div>' +
      '<div class=text><b>Ändring, Tillhörighet:</b> Hermes → ägaren</div>' +
      `<div class=text><b>Ändring, Utförare:</b> ingen → ${proveniens('manniska', 'hd-david')}</div>` +
      `<div class=text><b>Ändring, Tog över:</b> ingen → ${esc(datumtid(new Date(TID)))}</div>` +
      fel('Ändring, Följs upp') +
      '<div class=text><b>Ändring, Grund:</b> inga → <code>beslut</code> · <code>153</code></div>' +
      `<div class=text><b>Ändring, Nästa steg:</b> ingen → ${esc('HD <nästa>')} (riktning) · grund ` +
      '<code>beslut</code> · <code>172</code></div>' +
      '<div class=text><b>Ändring, Villkor:</b> HD villkor · källa <code>beslut</code> · <code>153</code> · ' +
      'utfall uppfyllt → inga</div>' +
      `<div class=text><b>Ändring, Precisering:</b> HD före → ${esc('HD <efter>')}</div>` +
      '<div class=text><b>Ändring, Hinder:</b> HD hinder · belägg <code>beslut</code> · <code>145</code> → ingen</div>' +
      '<div class=text><b>Ändring, Resultat:</b> ingen → HD resultat · belägg <code>prov</code> · <code>hd-p</code>; ' +
      `<code>commit</code> · <code>hd-c</code> · kontrollerat ${esc(datumtid(new Date(TID)))}</div>` +
      '<div class=text><b>Ändring, Avslutsskäl:</b> HD skäl · grund <code>beslut</code> · <code>160</code> → ingen</div>' +
      fel('Ändring, okand_nyckel'),
  ],
  tidigare: [
    'aterppnade_atagande',
    {
      tidigare: {
        resultat: {
          sammanfattning: 'HD <tidigare>',
          belagg: [{ typ: 'prov', id: 'hd-p' }, { typ: 'commit', id: 'hd-c' }],
          kontrollerat: TID,
        },
        avslutsskal: { text: 'HD avslut', grund: { typ: 'beslut', id: '160' } },
      },
    },
    `<div class=text><b>Tidigare resultat:</b> ${esc('HD <tidigare>')} · belägg <code>prov</code> · <code>hd-p</code>; ` +
      `<code>commit</code> · <code>hd-c</code> · kontrollerat ${esc(datumtid(new Date(TID)))}</div>` +
      '<div class=text><b>Tidigare avslutsskäl:</b> HD avslut · grund <code>beslut</code> · <code>160</code></div>',
  ],
};

describe('D-3/Story 11.6 AK 1: en sluten detaljtabell', () => {
  it('HD1 (AK 1): DETALJFALT är provets tabell, fryst, med verb ur VERB och slag ur DETALJSLAG', () => {
    expect(Object.keys(VERBFALT)).toHaveLength(21);
    // Kontroll först: tabellfel släpper provets tabell i kodens form och fäller en tabell där ett verb
    // saknas och en där två fält har bytt plats.
    expect(tabellfel(VERBFALT, somKod(VERBFALT))).toEqual([]);
    const utanVerb = somKod(VERBFALT);
    delete utanVerb.besvarade_insats;
    expect(tabellfel(VERBFALT, utanVerb)).toEqual(['besvarade_insats: saknas i koden']);
    const bytt = somKod(VERBFALT);
    const [typ, svar, kontrakt] = bytt.besvarade_insats!;
    bytt.besvarade_insats = [svar!, typ!, kontrakt!];
    expect(tabellfel(VERBFALT, bytt)).toHaveLength(1);

    // Kodens tabell. Object.keys kastar så länge DETALJFALT inte finns.
    expect(Object.keys(kortmodulen.DETALJFALT)).toHaveLength(21);
    expect(tabellfel(VERBFALT, kortmodulen.DETALJFALT)).toEqual([]);
    for (const verb of Object.keys(VERBFALT)) expect(Object.hasOwn(VERB, verb), verb).toBe(true);
    expect(Object.isFrozen(kortmodulen.DETALJFALT)).toBe(true);
    for (const [verb, lista] of Object.entries(kortmodulen.DETALJFALT)) {
      expect(Object.isFrozen(lista), verb).toBe(true);
    }

    // Varje fälts slag står i DETALJSLAG, och varje slag i DETALJSLAG används av minst ett fält.
    const slagen: readonly string[] = kortmodulen.DETALJSLAG;
    const anvanda = new Set(Object.values(kortmodulen.DETALJFALT).flatMap((lista) => lista.map((f) => f.slag)));
    expect([...anvanda].filter((slag) => !slagen.includes(slag))).toEqual([]);
    expect(slagen.filter((slag) => !anvanda.has(slag))).toEqual([]);
  });
});

describe('D-3/Story 11.6 AK 2: rendering och källa på funktionsnivå', () => {
  it('HD2 (AK 2): varje slag ger sin markup ordagrant, svaret står som text, och ett verb utanför tabellen ger inget', () => {
    // Ett fall per slag: ett slag utan fall fäller provet. Varje fall prövar ett fält som verbet har.
    expect(Object.keys(SLAGFALL).sort()).toEqual([...kortmodulen.DETALJSLAG].sort());
    expect(Object.keys(SLAGFALL).sort()).toEqual(SLAGEN);
    for (const [slag, [verb]] of Object.entries(SLAGFALL)) {
      expect(VERBFALT[verb]?.some(([, , s]) => s === slag), `${slag} på ${verb}`).toBe(true);
    }

    // Kontroll först: jämförelsen fäller en påhittad markup där svaret står oescapat.
    const [, , svarsmarkup] = SLAGFALL.svar!;
    expect(svarsmarkup.replace(esc(SVAR), SVAR)).not.toBe(svarsmarkup);
    expect(svarsmarkup.replace(esc(SVAR), SVAR)).toContain('<script');

    const fynd: string[] = [];
    for (const [slag, [verb, payload, markup]] of Object.entries(SLAGFALL)) {
      const html = detaljerFor(verb, payload);
      if (html !== `${markup}${KALLRAD}`) fynd.push(`${slag}: ${html}`);
    }
    expect(fynd).toEqual([]);

    // Svaret ordagrant med radbrytningen, som text: ingen av formerna blir ett element eller en länk.
    const svaret = detaljerFor('besvarade_insats', { svar: SVAR });
    expect(svaret).toBe(
      `<div class=text><b>Svar:</b> ${esc(SVAR)}</div><p>Svarat av ${proveniens('manniska', 'hd-david')}</p>${KALLRAD}`,
    );
    expect(svaret).toContain('\nandra raden');
    expect(svaret).not.toContain('<script');
    expect(svaret).not.toContain('<a');

    // Ärendenumret i en referens länkas genom referens() och samlas under insamlingen; numret i svaret gör inget.
    const referenser = handelse('registrerade_atagande', { grund: [{ typ: 'arende', id: 'LOC-7' }] });
    expect(kortmodulen.handelsensDetaljer(referenser, INDEX, UPPSLAGET)).toContain(`href="${arendeSokvag('LOC-7')}"`);
    const kandidater = arendekandidater((u) => {
      kortmodulen.handelsensDetaljer(referenser, INDEX, u);
      kortmodulen.handelsensDetaljer(handelse('besvarade_insats', { svar: SVAR }), INDEX, u);
    });
    expect(kandidater).toEqual(['LOC-7']);

    // Ett verb utanför tabellen ger tom sträng, också med ett skäl och ett byte i payloaden.
    expect(detaljerFor('andrade_status', { fran: 'Todo', till: 'Done', skal: 'HD skäl' })).toBe('');
    expect(detaljerFor('kommenterade', { kommentar_id: 'hd', title: 'HD' })).toBe('');

    // Statiskt: kroppen i handelsensDetaljer anropar inte markdown-renderaren.
    const kallan = readFileSync(fileURLToPath(new URL('../src/http/vy/kort.ts', import.meta.url)), 'utf8');
    const rader = kallan.split('\n');
    const start = rader.findIndex((rad) => rad.includes('export function handelsensDetaljer('));
    expect(start, 'handelsensDetaljer saknas i kort.ts').toBeGreaterThan(-1);
    const slut = rader.findIndex((rad, i) => i > start && rad.startsWith('}'));
    expect(slut).toBeGreaterThan(start);
    const kroppen = rader.slice(start, slut + 1).join('\n');
    expect(kroppen).not.toContain('renderaArendetext');
    expect(kroppen).not.toContain('renderaMarkdown');
  });
});

// ---- AK 5 på funktionsnivå --------------------------------------------------------------------------------

/** En exempelsökväg per post i PRIVATA (R5, PRD §5), som i test/arendekort.test.ts. */
const PRIVATA_FALL: Record<string, string> = {
  'jag.md': 'jag.md',
  'journal/': 'journal/2026-10-01.md',
  '02-Områden/hälsa/': '02-Områden/hälsa/x.md',
  '05-Dagligt/': '05-Dagligt/2026-10-01-morgonbrief.md',
  '.git/': '.git/config',
  '.obsidian/': '.obsidian/workspace.json',
};

/** Sökvägen ledvis kodad, som dokumentsidans adress (dokUrl i src/http/vy/markdown.ts). */
function ledvis(rel: string): string {
  return rel.split('/').map(encodeURIComponent).join('/');
}

/** Var sökvägen står i en markup: i klartext, kodad eller ledvis kodad. Tom lista = ingenstans. */
function privataTraffar(html: string, rel: string): string[] {
  const former: [string, string][] = [
    ['klartext', rel],
    ['kodad', encodeURIComponent(rel)],
    ['ledvis kodad', ledvis(rel)],
  ];
  return former.filter(([, text]) => html.includes(text)).map(([form]) => `${rel} (${form})`);
}

const JOURNAL = PRIVATA_FALL['journal/']!;
const JREF = { typ: 'dokument', id: JOURNAL };

/** En position där detaljerna visar en referens eller en källa: numret, namnet, verbet och payloaden. */
type Barare = [position: number, namn: string, verb: string, payload: Record<string, unknown>];

/**
 * Positionerna 1–11 och 15 i den slutna listan, varje ställe där detaljerna visar en referens (Dev Notes →
 * Detaljslagen och markupen, Ändringen och det tidigare), med `ref` i positionen. Position 15, belägget i ett
 * villkor i ändringen, kom till med review-uppföljningen, när villkorets alla delar kom med i värdet.
 */
function referensbarare(ref: Record<string, unknown>): Barare[] {
  const steg = { handling: 'HD steg', slag: 'internt', grund: ref };
  const resultat = { sammanfattning: 'HD resultat', belagg: [ref], kontrollerat: TID };
  const avslutsskal = { text: 'HD avslut', grund: ref };
  const villkor = (kalla: unknown, utfall: string, belagg?: unknown) => ({
    text: 'HD villkor',
    kalla,
    galler: 'HD',
    kontroll: 'HD',
    utfall,
    ...(belagg === undefined ? {} : { belagg }),
  });
  return [
    [1, 'grund på tog_over_atagande', 'tog_over_atagande', { grund: ref }],
    [1, 'grund på avslutade_atagande', 'avslutade_atagande', { grund: ref }],
    [1, 'grund på aterppnade_atagande', 'aterppnade_atagande', { grund: ref }],
    [2, 'en post i grund på registrerade_atagande', 'registrerade_atagande', { grund: [{ typ: 'beslut', id: '153' }, ref] }],
    [3, 'nasta.grund på tog_over_atagande', 'tog_over_atagande', { nasta: steg }],
    [3, 'nasta.grund på andrade_atagande', 'andrade_atagande', { nasta: steg }],
    [4, 'en post i andring.grund.till', 'andrade_atagande', { andring: { grund: { fran: [], till: [ref] } } }],
    [4, 'en post i andring.grund.fran', 'andrade_atagande', { andring: { grund: { fran: [ref], till: [] } } }],
    [5, 'andring.nasta.till.grund', 'andrade_atagande', { andring: { nasta: { fran: null, till: steg } } }],
    [
      6,
      'kalla i ett villkor i andring.villkor.till',
      'andrade_atagande',
      { andring: { villkor: { fran: [], till: [villkor(ref, 'okant')] } } },
    ],
    [
      7,
      'andring.hinder.fran.belagg',
      'andrade_atagande',
      { andring: { hinder: { fran: { orsak: 'HD hinder', belagg: ref }, till: null } } },
    ],
    [8, 'en post i andring.resultat.fran.belagg', 'andrade_atagande', { andring: { resultat: { fran: resultat, till: null } } }],
    [9, 'andring.avslutsskal.fran.grund', 'andrade_atagande', { andring: { avslutsskal: { fran: avslutsskal, till: null } } }],
    [10, 'en post i tidigare.resultat.belagg', 'aterppnade_atagande', { tidigare: { resultat, avslutsskal: null } }],
    [11, 'tidigare.avslutsskal.grund', 'aterppnade_atagande', { tidigare: { resultat: null, avslutsskal } }],
    [
      15,
      'belagg i ett villkor i andring.villkor.fran',
      'andrade_atagande',
      { andring: { villkor: { fran: [villkor({ typ: 'beslut', id: '153' }, 'uppfyllt', ref)], till: [] } } },
    ],
  ];
}

/** Positionernas nummer, en gång var och i ordning. */
function positionerna(bararna: readonly Barare[]): number[] {
  return [...new Set(bararna.map(([position]) => position))].sort((a, b) => a - b);
}

/**
 * AK 5: den slutna listan över var detaljerna visar en referens eller en källa (Dev Notes → Detaljslagen och
 * markupen, Ändringen och det tidigare), med journal-sökvägen i varje position. Positionerna är 1–15.
 */
const PRIVATA_BARARE: Barare[] = [
  ...referensbarare(JREF),
  [
    12,
    'lank i en krock',
    'registrerade_insats',
    { krockar: [{ system: 'valv', objekttyp: 'fil', objekt_id: 'hd-krock', lank: `https://example.com/fil/${JOURNAL}` }] },
  ],
  [13, 'objekt_id i en krock', 'registrerade_insats', { krockar: [{ system: 'valv', objekttyp: 'fil', objekt_id: JOURNAL }] }],
  [
    14,
    'system i handlingskontraktet',
    'besvarade_insats',
    { handlingskontrakt: { system: JOURNAL, kommando: 'k', objekt: 'o' } },
  ],
  [
    14,
    'kommando i handlingskontraktet',
    'besvarade_insats',
    { handlingskontrakt: { system: 's', kommando: JOURNAL, objekt: 'o' } },
  ],
  [
    14,
    'objekt i handlingskontraktet',
    'besvarade_insats',
    { handlingskontrakt: { system: 's', kommando: 'k', objekt: JOURNAL } },
  ],
];

describe('D-4/Story 11.6 AK 5: R5 på funktionsnivå', () => {
  it('HD3 (AK 5): en privat referens eller källa ger bara den fasta meningen, i varje position där detaljerna visar en', () => {
    // Varje post i PRIVATA har ett exempel, och listan har var och en av de femton positionerna.
    expect(Object.keys(PRIVATA_FALL).sort()).toEqual([...dokumentet.PRIVATA].sort());
    expect(positionerna(PRIVATA_BARARE)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // Varje bärare står på ett fält som verbet har.
    for (const [, namn, verb, payload] of PRIVATA_BARARE) {
      const nycklar = (VERBFALT[verb] ?? []).map(([nyckel]) => nyckel);
      expect(Object.keys(payload).every((nyckel) => nycklar.includes(nyckel)), namn).toBe(true);
    }

    // Kontroll först: sökningen hittar varje sökväg i en påhittad markup som innehåller den.
    for (const rel of Object.values(PRIVATA_FALL)) {
      expect(privataTraffar(`<code>${rel}</code>`, rel), rel).not.toEqual([]);
      expect(privataTraffar(`<a href="/vy/dok/${ledvis(rel)}">x</a>`, rel), rel).not.toEqual([]);
    }

    const fynd: string[] = [];
    // De sex sökvägarna som grund i avslutade_atagande och som underlag i besvarade_insats.
    for (const rel of Object.values(PRIVATA_FALL)) {
      const grund = detaljerFor('avslutade_atagande', { grund: { typ: 'dokument', id: rel } });
      if (grund !== `<p>Grund: ${esc(PRIVAT)}</p>${KALLRAD}`) fynd.push(`grund ${rel}: ${grund}`);
      const kontrakt = detaljerFor('besvarade_insats', {
        handlingskontrakt: { system: 's', kommando: 'k', objekt: 'o', underlag: rel },
      });
      if (kontrakt !== `<p>Handlingskontrakt: ${esc(PRIVAT)}</p>${KALLRAD}`) fynd.push(`underlag ${rel}: ${kontrakt}`);
      fynd.push(...privataTraffar(grund + kontrakt, rel));
    }
    // Journal-sökvägen i varje position.
    for (const [position, namn, verb, payload] of PRIVATA_BARARE) {
      const html = detaljerFor(verb, payload);
      if (!html.includes(esc(PRIVAT))) fynd.push(`(${position}) ${namn}: ingen fast mening i ${html}`);
      fynd.push(...privataTraffar(html, JOURNAL).map((t) => `(${position}) ${namn}: ${t}`));
    }
    expect(fynd).toEqual([]);
  });
});

// ---- AK 6 på funktionsnivå --------------------------------------------------------------------------------

/** Ett värde av rätt typ per slag och den väntade markupen för fältet under sin etikett. */
const GILTIGT: Record<string, [varde: unknown, markup: (etikett: string) => string]> = {
  text: ['HD text', (e) => `<div class=text><b>${e}:</b> HD text</div>`],
  svar: ['HD svar', (e) => `<div class=text><b>${e}:</b> HD svar</div><p>Svarat av ${proveniens('manniska', 'hd-david')}</p>`],
  tal: [3, (e) => `<p>${e}: 3</p>`],
  tid: [TID, (e) => `<p>${e}: ${esc(datumtid(new Date(TID)))}</p>`],
  lage: ['hindrat', (e) => `<p>${e}: hindrat</p>`],
  tillhor: ['agare', (e) => `<p>${e}: ägaren</p>`],
  insatstyp: ['agarbeslut', (e) => `<p>${e}: ägarbeslut</p>`],
  moment: ['folja_upp', (e) => `<p>${e}: följa upp</p>`],
  janej: [true, (e) => `<p>${e}: ja</p>`],
  kod: ['hd-kod', (e) => `<p>${e}: <code>hd-kod</code></p>`],
  beslut: [153, (e) => `<p>${e}: #153</p>`],
  referens: [{ typ: 'beslut', id: '153' }, (e) => `<p>${e}: <code>beslut</code> · <code>153</code></p>`],
  referenser: [[{ typ: 'beslut', id: '153' }], (e) => `<p>${e}: <code>beslut</code> · <code>153</code></p>`],
  nasta: [{ handling: 'HD steg', slag: 'internt' }, (e) => `<div class=text><b>${e} (internt):</b> HD steg</div>`],
  utforare: [['agent', 'hd-agent'], (e) => `<p>${e}: ${proveniens('agent', 'hd-agent')}</p>`],
  handlingskontrakt: [{ system: 's' }, (e) => `<p>${e}: <code>s</code></p>`],
  krockar: [[], (e) => `<p>${e}: inga</p>`],
  andring: [
    { lage: { fran: 'registrerat', till: 'hindrat' } },
    (e) => `<div class=text><b>${e}, Läge:</b> registrerat → hindrat</div>`,
  ],
  tidigare: [{ resultat: null, avslutsskal: { text: 'HD avslut' } }, (e) => `<div class=text><b>${e} avslutsskäl:</b> HD avslut</div>`],
};

/** AK 6: ett värde av fel typ per slag: ett objekt för en text, en text för ett tal och så vidare. */
const FEL_TYP: Record<string, unknown> = {
  text: { text: 'HD' },
  svar: 7,
  tal: 'tre',
  tid: 'inte en tid',
  lage: 'okant_lage',
  tillhor: 7,
  insatstyp: 'okand_typ',
  moment: 'okant_moment',
  janej: 'ja',
  kod: 7,
  beslut: -1,
  referens: 'en sträng',
  referenser: 'en sträng',
  nasta: 'en sträng',
  utforare: [7, 7],
  handlingskontrakt: 'en sträng',
  krockar: 'en sträng',
  andring: [],
  tidigare: 'en sträng',
};

/** Payloaden med bara ett fält. Slaget utforare bär sitt värde under <nyckel>_typ och <nyckel>_namn. */
function medFaltet(nyckel: string, slag: string, varde: unknown): Record<string, unknown> {
  if (slag !== 'utforare') return { [nyckel]: varde };
  const [typ, namn] = Array.isArray(varde) ? varde : [varde, varde];
  return { [`${nyckel}_typ`]: typ, [`${nyckel}_namn`]: namn };
}

describe('D-3/Story 11.6 AK 6: inga påhittade värden på funktionsnivå', () => {
  it('HD4 (AK 6): bara fälten som finns, raden om formen för fel typ, och inget för en tom eller felaktig payload', () => {
    expect(Object.keys(GILTIGT).sort()).toEqual(SLAGEN);
    expect(Object.keys(FEL_TYP).sort()).toEqual(SLAGEN);

    // Kontroll först: en fullständig payload för besvarade_insats ger alla tre fälten och källraden, och
    // tankstrecksprövningen fäller ett påhittat «—».
    const full = detaljerFor('besvarade_insats', {
      insats_id: 'hd-insats',
      typ: 'agarbeslut',
      svar: 'HD svar',
      handlingskontrakt: { system: 's', kommando: 'k', objekt: 'o' },
    });
    expect(full).toBe(
      '<p>Typ: ägarbeslut</p>' +
        `<div class=text><b>Svar:</b> HD svar</div><p>Svarat av ${proveniens('manniska', 'hd-david')}</p>` +
        `<p>Handlingskontrakt: <code>s</code> · <code>k</code> · <code>o</code></p>${KALLRAD}`,
    );
    expect(utanFastaTexter(`<p>Revision: —</p>${fel('Revision')}`)).toContain('—');
    expect(utanFastaTexter(fel('Revision'))).not.toContain('—');

    const fynd: string[] = [];
    const alla: string[] = [];
    for (const [verb, falten] of Object.entries(VERBFALT)) {
      const [nyckel, etikett, slag] = falten[0]!;
      const [varde, markup] = GILTIGT[slag]!;
      const utfall: [fall: string, html: string, vantat: string][] = [
        ['{}', detaljerFor(verb, {}), ''],
        ['bara det första fältet', detaljerFor(verb, medFaltet(nyckel, slag, varde)), `${markup(etikett)}${KALLRAD}`],
        ['null', detaljerFor(verb, medFaltet(nyckel, slag, slag === 'utforare' ? [null, null] : null)), ''],
        [
          'fel typ',
          detaljerFor(verb, medFaltet(nyckel, slag, FEL_TYP[slag])),
          (slag === 'referens' ? `<p>${etikett}: ${esc(OKAND_FORM)}</p>` : fel(etikett)) + KALLRAD,
        ],
      ];
      for (const [fall, html, vantat] of utfall) {
        alla.push(html);
        if (html !== vantat) fynd.push(`${verb} (${fall}): ${html}`);
      }
    }
    // Payloader som inte är objekt.
    for (const payload of [null, [], 'x', 7]) {
      const html = detaljerFor('besvarade_insats', payload);
      alla.push(html);
      if (html !== '') fynd.push(`besvarade_insats (${JSON.stringify(payload)}): ${html}`);
    }
    expect(fynd).toEqual([]);
    expect(alla.filter((html) => utanFastaTexter(html).includes('—'))).toEqual([]);
  });
});

// ---- Fixturen för sidorna (Uppgift 2; Dev Notes → Fixturen) -----------------------------------------------

const DAG = 24 * 60 * 60 * 1000;
const NU = Date.now();
// Alltid i framtiden, räknat från klockan när provet körs (som SEN i test/insats.test.ts).
const UPPFOLJNING = new Date(NU + 365 * DAG).toISOString();
const SENARE = new Date(NU + 400 * DAG).toISOString();
const UPPSKJUTEN_TILL = new Date(NU + 30 * DAG).toISOString();
const KONTROLLTID = new Date(NU + 45 * DAG).toISOString();

const GRUND_HD = { typ: 'beslut', id: 'hd-1', version: '1' };
const INTERNT = { handling: 'HD bygg klart', slag: 'internt', grund: GRUND_HD };
const RIKTNING = { handling: 'HD välj riktning', slag: 'riktning', grund: { typ: 'beslut', id: 'hd-2' } };
const HINDRET = { typ: 'beslut', id: 'hd-hinder' };
const BELAGG = [
  { typ: 'prov', id: 'hd-prov' },
  { typ: 'commit', id: 'hd-commit' },
];
const NY_GRUND = { typ: 'beslut', id: 'hd-ny', version: '2' };
const AVSLUTSGRUND = { typ: 'beslut', id: 'hd-avslut' };
/** Ett beslutsnummer som ingen annan del av fixturen använder. */
const BESLUT = 61106;
/** Svarsversionens hash: 16–64 små hexadecimala tecken, som registrera_svarsversion kräver. */
const SVAR_HASH = '6106aaaaaaaaaaaaaaaa';
/** Handlingskontraktet med det kommando som KOMMANDOTABELL tillåter för ett ägarbeslut. */
const KONTRAKT = { system: 'arenden', kommando: 'beslutskoe --besvara', objekt: '#153' };
/** AK 5: det privata underlaget på A.r5. */
const HALSA = PRIVATA_FALL['02-Områden/hälsa/']!;
/** Insatsen som de äldre raderna pekar på. Ingen insats har id:t. */
const ALDRE_INSATS = '00000000-0000-4000-8000-000000001106';

/** Fixturens ärenden, lästa ur svaren, och deras titlar. */
const A: Record<string, string> = {};
const TITEL: Record<string, string> = {
  annat: 'HD annat ärende',
  atg: 'HD åtagandet',
  res: 'HD resultatet',
  avsl: 'HD avslutet',
  ins: 'HD insatserna',
  r5: 'HD privata källor',
  aldre: 'HD äldre rader',
};
/** Insatsernas id, lästa ur svaren. */
const I: Record<string, string> = {};
/** Kontrolltiden i det redovisade resultatet, ur svaret från redovisa_resultat. */
let kontrollerat = '';

/** Ett anrop som MÅSTE lyckas (som steg i test/historik-yta.test.ts). */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

async function nytt(namn: string): Promise<string> {
  A[namn] = (await steg(hermes, 'create_issue', { title: TITEL[namn], team_key: 'LOC' })).identifier as string;
  return A[namn]!;
}

async function revisionNu(identifier: string): Promise<number> {
  return (await steg(hermes, 'get_atagande', { identifier })).revision as number;
}

/** En åtagandehandling med revisionen just före, som i test/atagande-handelser.test.ts. */
async function vidare(nyckel: string, action: string, identifier: string, input: Record<string, unknown>) {
  return steg(nyckel, action, { identifier, ...input, forvantad_revision: await revisionNu(identifier) });
}

/** registrera_insats som insats() i test/arendekort.test.ts: eget stopp, egen källa och tillåtet kommando. */
function insatsfalt(stopp: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stopp_id: stopp,
    typ: 'agarbeslut',
    tillhor: 'agare',
    utfall: 'HD riktningen är vald',
    begard_handling: 'HD välj mellan A och B',
    blockeringsgrund: 'HD tidigare besked avgör inte valet',
    handlingskontrakt: KONTRAKT,
    kallor: [{ system: 'arenden', objekttyp: 'beslut', objekt_id: stopp }],
    ...extra,
  };
}

async function insats(stopp: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await steg(hermes, 'registrera_insats', insatsfalt(stopp, extra))).insats.id as string;
}

async function arendetsId(identifier: string): Promise<string> {
  return (await steg(hermes, 'get_issue', { identifier })).arende.id as string;
}

/** Ägarrollen, som i test/historik-yta.test.ts (adminKlient). Anroparen stänger den i finally. */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/**
 * Äldre rader med ägarrollen, som H8 i test/historik-yta.test.ts: aktören system · hd äldre, en sats i taget,
 * så att varje rad får sin egen tidpunkt i insättningsordningen.
 */
async function aldreRader(identifier: string, rader: [verb: string, payload: Record<string, unknown>][]) {
  const issueId = await arendetsId(identifier);
  const admin = await adminKlient();
  try {
    for (const [verb, payload] of rader) {
      await admin.query(
        `INSERT INTO events (tenant_id, issue_id, aktor_typ, aktor_namn, verb, payload)
         VALUES ($1, $2, 'system', 'hd äldre', $3, $4::jsonb)`,
        [TENANT_ID, issueId, verb, JSON.stringify(payload)],
      );
    }
  } finally {
    await admin.end();
  }
}

/**
 * Fixturen (Dev Notes → Fixturen). Varje händelse skrivs genom en action i en tillåten ordning, utom de äldre
 * raderna på A.r5 och A.aldre, som bara ägarrollen kan skriva i den formen.
 */
async function byggFixturen(): Promise<void> {
  // Målet för en referens av typen arende.
  await nytt('annat');

  // A.atg: åtagandets verb från registreringen till hindret, besluten, svarsversionerna och arbetsmomentet.
  await nytt('atg');
  const registrering = {
    identifier: A.atg,
    grund: [GRUND_HD, { typ: 'arende', id: A.annat }],
    nasta: INTERNT,
    foljs_upp: UPPFOLJNING,
  };
  await steg(hermes, 'registrera_atagande', registrering);
  await steg(hermes, 'registrera_atagande', registrering);
  await vidare(david, 'ta_over_atagande', A.atg!, { nasta: INTERNT, foljs_upp: UPPFOLJNING });
  await vidare(hermes, 'andra_atagande', A.atg!, { nasta: RIKTNING, skal: 'HD skälet för ändringen' });
  await vidare(hermes, 'hindra_atagande', A.atg!, {
    orsak: 'HD hindret',
    belagg: HINDRET,
    nasta: INTERNT,
    foljs_upp: SENARE,
  });
  await steg(hermes, 'koppla_beslut', { beslut_id: BESLUT, identifier: A.atg });
  await steg(hermes, 'koppla_beslut', { beslut_id: BESLUT, identifier: A.atg });
  const svarsversion = { beslut_id: BESLUT, svar_hash: SVAR_HASH, identifier: A.atg, version: 1 };
  await steg(hermes, 'registrera_svarsversion', svarsversion);
  await steg(hermes, 'registrera_svarsversion', svarsversion);
  await steg(hermes, 'logga_moment', { moment: 'hitta_underlag', identifier: A.atg, beslut_id: BESLUT });

  // A.res: resultatet och återöppningen, som bär det tidigare resultatet.
  await nytt('res');
  await steg(hermes, 'registrera_atagande', { identifier: A.res, grund: [GRUND_HD], nasta: INTERNT, foljs_upp: UPPFOLJNING });
  await vidare(david, 'ta_over_atagande', A.res!, { nasta: INTERNT, foljs_upp: UPPFOLJNING });
  const redovisat = await vidare(hermes, 'redovisa_resultat', A.res!, { sammanfattning: 'HD resultatet', belagg: BELAGG });
  kontrollerat = redovisat.data.resultat.kontrollerat as string;
  await vidare(hermes, 'aterppna_atagande', A.res!, { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE });

  // A.avsl: avslutet med skäl och grund.
  await nytt('avsl');
  await steg(hermes, 'registrera_atagande', { identifier: A.avsl, grund: [GRUND_HD], nasta: INTERNT, foljs_upp: UPPFOLJNING });
  await vidare(hermes, 'avsluta_atagande', A.avsl!, { text: 'HD avslutsskälet', grund: AVSLUTSGRUND });

  // A.ins: insatsens verb. Svaret och uppskjutningen kräver en människa; hd-5 registreras utan ärende och
  // kopplas sedan, så att kopplingens två verb står på A.ins.
  await nytt('ins');
  const forsta = insatsfalt('hd-1', { identifier: A.ins });
  I.hd1 = (await steg(hermes, 'registrera_insats', forsta)).insats.id as string;
  await steg(hermes, 'registrera_insats', forsta);
  I.hd2 = await insats('hd-2', { identifier: A.ins });
  await steg(david, 'besvara_insats', { id: I.hd2, svar: SVAR });
  I.hd3 = await insats('hd-3', { identifier: A.ins });
  await steg(david, 'skjut_upp_insats', { id: I.hd3, till: UPPSKJUTEN_TILL, skal: 'HD uppskjuten' });
  I.hd4 = await insats('hd-4', { identifier: A.ins });
  await steg(hermes, 'aterkalla_insats', { id: I.hd4, skal: 'HD återkallad' });
  I.hd5 = await insats('hd-5');
  await steg(hermes, 'koppla_insats_till_arende', { id: I.hd5, identifier: A.ins });
  await steg(hermes, 'koppla_insats_till_arende', { id: I.hd5, identifier: A.ins });

  // A.r5 (AK 5): en privat grund i avslutet, ett privat lagrat underlag genom actionen, och en äldre rad
  // från före Story 11.3 som bär det lagrade underlaget under underlag.
  await nytt('r5');
  await steg(hermes, 'registrera_atagande', { identifier: A.r5, grund: [GRUND_HD], nasta: INTERNT, foljs_upp: UPPFOLJNING });
  await vidare(hermes, 'avsluta_atagande', A.r5!, { text: 'HD privat avslut', grund: JREF });
  I.r5 = await insats('hd-r5', { identifier: A.r5, handlingskontrakt: { ...KONTRAKT, underlag: HALSA } });
  await steg(david, 'besvara_insats', { id: I.r5, svar: 'HD privat svar' });
  await aldreRader(A.r5!, [
    [
      'besvarade_insats',
      {
        insats_id: ALDRE_INSATS,
        typ: 'agarbeslut',
        svar: 'HD äldre svar',
        handlingskontrakt: { system: 's', kommando: 'k', objekt: 'o', underlag: HALSA },
      },
    ],
  ]);

  // A.aldre (AK 6): tre äldre rader utan fälten eller med ett fält i fel form, och en kontrollrad.
  await nytt('aldre');
  await aldreRader(A.aldre!, [
    ['besvarade_insats', { insats_id: ALDRE_INSATS }],
    ['tog_over_atagande', { revision: 'tre' }],
    ['registrerade_insats', {}],
    ['skot_upp_insats', { till: KONTROLLTID, skal: 'HD kontroll' }],
  ]);
}

// ---- Sidorna -------------------------------------------------------------------------------------------------

/** Ärendesidan. Den måste svara 200. */
async function sidan(identifier: string): Promise<string> {
  const svar = await request(app).get(arendeSokvag(identifier));
  expect(svar.status, identifier).toBe(200);
  return svar.text;
}

/** Texten från första `start` till första `slut` efter den (som avsnitt i test/historik-yta.test.ts). */
function avsnitt(html: string, start: string, slut: string): string {
  const i = html.indexOf(start);
  expect(i, `hittade inte ${start}`).toBeGreaterThan(-1);
  const j = html.indexOf(slut, i + 1);
  expect(j, `hittade inte ${slut} efter ${start}`).toBeGreaterThan(-1);
  return html.slice(i, j);
}

/** Historiken: från rubriken till sidans slut. */
function historiken(html: string): string {
  return avsnitt(html, '<h2>Historik (', '</main>');
}

/** Raderna i ett avsnitt, kapade vid första `</li>` (som raderI i test/historik-yta.test.ts). */
function raderI(del: string): string[] {
  return del
    .split('<li class=rad>')
    .slice(1)
    .map((bit) => {
      const slut = bit.indexOf('</li>');
      return slut === -1 ? bit : bit.slice(0, slut);
    });
}

/** Radens huvud (som huvudet i test/historik-yta.test.ts). */
function huvudet(rad: string): string {
  const start = '<div class=huvud>';
  const i = rad.indexOf(start);
  expect(i, `raden saknar huvud: ${rad}`).toBeGreaterThan(-1);
  const j = rad.indexOf('</div>', i);
  expect(j, `huvudet är inte stängt: ${rad}`).toBeGreaterThan(-1);
  return rad.slice(i + start.length, j);
}

/** Radens detaljer: allt efter huvudets avslutande `</div>`. */
function detaljerI(rad: string): string {
  const i = rad.indexOf('<div class=huvud>');
  return rad.slice(rad.indexOf('</div>', i) + '</div>'.length);
}

/** Antalet proveniensmärken i en markup. */
function marken(html: string): number {
  return html.split('class="prov ').length - 1;
}

/** Antalet proveniensmärken i radens huvud (som markenIHuvudet i test/historik-yta.test.ts). */
function markenIHuvudet(rad: string): number {
  return marken(huvudet(rad));
}

/** De rader vars huvud bär verbets span ordagrant (som radMedVerb i test/historik-yta.test.ts). */
function radMedVerb(del: string, text: string): string[] {
  return raderI(del).filter((rad) => huvudet(rad).includes(`<span>${text}</span>`));
}

/** Den enda raden med verbets text, eller med texten och `bar` när verbet står flera gånger på sidan. */
function radFor(historik: string, verb: string, bar?: string): string {
  const rader = radMedVerb(historik, esc(VERB[verb])).filter((rad) => bar === undefined || rad.includes(bar));
  expect(rader, `${verb}${bar === undefined ? '' : ` med ${bar}`}`).toHaveLength(1);
  return rader[0]!;
}

/**
 * Motkontrollen (AK 7), först i varje sidfall: sidan svarar 200 med rubriken för ärendet och Historik (N),
 * där N är antalet händelser på ärendet och antalet rader i historiken. Den är grön före och efter
 * ärenderuttens ändring.
 */
async function sidanMedMotkontroll(namn: string): Promise<string> {
  const identifier = A[namn]!;
  const html = await sidan(identifier);
  const antal = ((await steg(hermes, 'get_issue', { identifier })).handelser as unknown[]).length;
  expect(antal, namn).toBeGreaterThan(0);
  expect(html).toContain(`<h1>${esc(identifier)} — ${esc(TITEL[namn])}</h1>`);
  expect(html).toContain(`<h2>Historik (${antal})</h2>`);
  expect(raderI(historiken(html)), namn).toHaveLength(antal);
  return html;
}

/** Händelseraden med id:t, läst med pool: verbet och payloaden. */
async function handelsenMedId(id: string): Promise<{ verb: string; payload: Record<string, unknown> }> {
  const { rows } = await pool.query<{ verb: string; payload: Record<string, unknown> }>(
    'SELECT verb, payload FROM events WHERE id = $1',
    [id],
  );
  expect(rows, `händelse #${id}`).toHaveLength(1);
  return rows[0]!;
}

/** Id:t för ärendets enda händelse med verbet, som text (pg ger bigint som sträng). */
async function idFor(identifier: string, verb: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'SELECT id::text AS id FROM events WHERE issue_id = $1 AND verb = $2',
    [await arendetsId(identifier), verb],
  );
  expect(rows, `${identifier}: ${verb}`).toHaveLength(1);
  return rows[0]!.id;
}

/** Källradens id i en rads detaljer, eller null. */
function kallid(detaljer: string): string | null {
  return /<p>Källa: händelse #(\d+)<\/p>$/.exec(detaljer)?.[1] ?? null;
}

/** Provets kopia av etiketterna i ANDRINGSDEL. Utförarens typ och namn delar en rad. */
const ANDRINGSETIKETT: Record<string, string> = {
  lage: 'Läge',
  tillhor: 'Tillhörighet',
  utforare_typ: 'Utförare',
  utforare_namn: 'Utförare',
  overtaget_nar: 'Tog över',
  foljs_upp: 'Följs upp',
  grund: 'Grund',
  nasta: 'Nästa steg',
  villkor: 'Villkor',
  utfall_precisering: 'Precisering',
  hinder: 'Hinder',
  resultat: 'Resultat',
  avslutsskal: 'Avslutsskäl',
};

/**
 * AK 1: ändringens rader mot händelsens payload.andring: exakt en rad «Ändring, ETIKETT» per etikett som
 * nycklarna ger, och inga andra. Tom lista = raderna stämmer.
 */
function andringsfel(detaljer: string, andring: unknown): string[] {
  if (typeof andring !== 'object' || andring === null || Array.isArray(andring)) return ['payloaden saknar andring'];
  const fynd: string[] = [];
  const etiketter = new Set<string>();
  for (const nyckel of Object.keys(andring)) {
    const etikett = ANDRINGSETIKETT[nyckel];
    if (etikett === undefined) fynd.push(`okänd nyckel ${nyckel}`);
    else etiketter.add(etikett);
  }
  if (etiketter.size === 0) fynd.push('ändringen är tom');
  for (const etikett of etiketter) {
    const antal = detaljer.split(`<b>Ändring, ${etikett}:</b>`).length - 1;
    if (antal !== 1) fynd.push(`Ändring, ${etikett}: ${antal} rader`);
  }
  const alla = detaljer.split('<b>Ändring, ').length - 1;
  if (alla !== etiketter.size) fynd.push(`${alla} ändringsrader för ${etiketter.size} etiketter`);
  return fynd;
}

/** Markörer i de väntade fälten: revisionen läses ur payloaden, och ändringen prövas med andringsfel. */
const SE_REVISION = '(revisionen ur händelsens payload)';
const SE_ANDRING = '(ändringen ur händelsens payload)';

/** En referens som referens() skriver den, med typ, id och version. */
function ref(typ: string, id: string, version?: string): string {
  return `<code>${typ}</code> · <code>${id}</code>${version === undefined ? '' : ` · version <code>${version}</code>`}`;
}

/**
 * AK 1: för varje verb sidan, värdet som skiljer raden från andra med samma verb, och varje fält i verbets
 * lista med sin väntade markup, byggd ur indatan: esc() av texten, proveniens för aktören, provets egna ord
 * och datumtid() av tiden ur svaret.
 */
function vantadeFalt(): Record<string, [sida: string, bar: string | undefined, falt: Record<string, string>]> {
  const grundHd = ref('beslut', 'hd-1', '1');
  const insatsens = (stopp: string): Record<string, string> => ({
    typ: '<p>Typ: ägarbeslut</p>',
    tillhor: '<p>Tillhörighet: ägaren</p>',
    stopp_id: `<p>Stopp: <code>${stopp}</code></p>`,
    kallor: '<p>Antal källor: 1</p>',
    krockar: '<p>Krockar: inga</p>',
  });
  const beslutet = { beslut_id: `<p>Beslut: #${BESLUT}</p>` };
  const svarsversionen = {
    beslut_id: `<p>Beslut: #${BESLUT}</p>`,
    version: '<p>Version: 1</p>',
    svar_hash: `<p>Svarshash: <code>${SVAR_HASH}</code></p>`,
  };
  const kopplingen = {
    insats_id: `<p>Insats: <code>${I.hd5}</code></p>`,
    identifier: `<p>Ärende: <code>${A.ins}</code></p>`,
  };
  return {
    skapade_arende: ['atg', undefined, { title: `<div class=text><b>Titel:</b> ${esc(TITEL.atg)}</div>` }],
    registrerade_atagande: [
      'atg',
      undefined,
      {
        lage: '<p>Läge: registrerat</p>',
        tillhor: '<p>Tillhörighet: Hermes</p>',
        revision: SE_REVISION,
        grund: `<p>Grund: ${grundHd}; <code>arende</code> · <a href="${arendeSokvag(A.annat!)}">${A.annat}</a></p>`,
        andring: SE_ANDRING,
      },
    ],
    atagandet_fanns_redan: [
      'atg',
      undefined,
      { lage: '<p>Läge: registrerat</p>', tillhor: '<p>Tillhörighet: Hermes</p>', revision: SE_REVISION },
    ],
    tog_over_atagande: [
      'atg',
      undefined,
      {
        utforare: `<p>Utförare: ${proveniens('manniska', 'david')}</p>`,
        nasta:
          `<div class=text><b>Nästa steg (internt):</b> ${esc(INTERNT.handling)}</div>` +
          `<p>Nästa stegs grund: ${grundHd}</p>`,
        revision: SE_REVISION,
        grund: `<p>Grund: ${grundHd}</p>`,
        andring: SE_ANDRING,
      },
    ],
    andrade_atagande: [
      'atg',
      undefined,
      {
        tillhor: '<p>Tillhörighet: ägaren</p>',
        nasta:
          `<div class=text><b>Nästa steg (riktning):</b> ${esc(RIKTNING.handling)}</div>` +
          `<p>Nästa stegs grund: ${ref('beslut', 'hd-2')}</p>`,
        revision: SE_REVISION,
        skal: `<div class=text><b>Skäl:</b> ${esc('HD skälet för ändringen')}</div>`,
        andring: SE_ANDRING,
      },
    ],
    hindrade_atagande: [
      'atg',
      undefined,
      { orsak: '<div class=text><b>Orsak:</b> HD hindret</div>', revision: SE_REVISION, andring: SE_ANDRING },
    ],
    redovisade_resultat: [
      'res',
      undefined,
      {
        sammanfattning: '<div class=text><b>Sammanfattning:</b> HD resultatet</div>',
        antal_belagg: '<p>Antal belägg: 2</p>',
        revision: SE_REVISION,
        andring: SE_ANDRING,
      },
    ],
    avslutade_atagande: [
      'avsl',
      undefined,
      {
        skal: '<div class=text><b>Skäl:</b> HD avslutsskälet</div>',
        grund: `<p>Grund: ${ref('beslut', 'hd-avslut')}</p>`,
        revision: SE_REVISION,
        andring: SE_ANDRING,
      },
    ],
    aterppnade_atagande: [
      'res',
      undefined,
      {
        grund: `<p>Grund: ${ref('beslut', 'hd-ny', '2')}</p>`,
        revision: SE_REVISION,
        tidigare:
          `<div class=text><b>Tidigare resultat:</b> HD resultatet · belägg ${ref('prov', 'hd-prov')}; ` +
          `${ref('commit', 'hd-commit')} · kontrollerat ${esc(datumtid(new Date(kontrollerat)))}</div>`,
        andring: SE_ANDRING,
      },
    ],
    kopplade_beslut: ['atg', undefined, beslutet],
    beslutet_var_redan_kopplat: ['atg', undefined, beslutet],
    behandlade_svarsversion: ['atg', undefined, svarsversionen],
    svarsversionen_var_behandlad: ['atg', undefined, svarsversionen],
    registrerade_insats: ['ins', '<code>hd-1</code>', insatsens('hd-1')],
    insatsen_fanns_redan: ['ins', undefined, insatsens('hd-1')],
    besvarade_insats: [
      'ins',
      undefined,
      {
        typ: '<p>Typ: ägarbeslut</p>',
        svar: `<div class=text><b>Svar:</b> ${esc(SVAR)}</div><p>Svarat av ${proveniens('manniska', 'david')}</p>`,
        handlingskontrakt:
          '<p>Handlingskontrakt: <code>arenden</code> · <code>beslutskoe --besvara</code> · <code>#153</code> · ' +
          `<code>${esc(`${TEST_VY_PUBLIK_URL}${arendeSokvag(A.ins!)}`)}</code></p>`,
      },
    ],
    skot_upp_insats: [
      'ins',
      undefined,
      {
        till: `<p>Till: ${esc(datumtid(new Date(UPPSKJUTEN_TILL)))}</p>`,
        skal: '<div class=text><b>Skäl:</b> HD uppskjuten</div>',
      },
    ],
    aterkallade_insats: ['ins', undefined, { skal: '<div class=text><b>Skäl:</b> HD återkallad</div>' }],
    skrev_arbetsmoment: [
      'atg',
      undefined,
      {
        moment: '<p>Moment: hitta underlag</p>',
        beslut_id: `<p>Beslut: #${BESLUT}</p>`,
        historisk: '<p>Historisk: nej</p>',
      },
    ],
    kopplade_insats_till_arende: ['ins', undefined, kopplingen],
    insatsen_var_redan_kopplad: ['ins', undefined, kopplingen],
  };
}

describe('D-3/Story 11.6 AK 1 och AK 7: detaljerna på ärendesidan', () => {
  it('HD5 (AK 1 och AK 7): varje verb i tabellen har en rad på sidorna, och varje fält står ordagrant i tabellens ordning', async () => {
    // Motkontrollen först, för var och en av de fyra sidorna.
    const historik: Record<string, string> = {};
    for (const namn of ['atg', 'res', 'avsl', 'ins']) historik[namn] = historiken(await sidanMedMotkontroll(namn));

    // Ett verb i VERBFALT utan rad, eller utan väntade fält, fäller provet.
    const vantat = vantadeFalt();
    expect(Object.keys(vantat).sort()).toEqual(Object.keys(VERBFALT).sort());
    const fynd: string[] = [];
    for (const [verb, falten] of Object.entries(VERBFALT)) {
      const [sida, bar, falt] = vantat[verb]!;
      expect(Object.keys(falt), verb).toEqual(falten.map(([nyckel]) => nyckel));
      const detaljer = detaljerI(radFor(historik[sida]!, verb, bar));
      const id = kallid(detaljer);
      if (id === null) {
        fynd.push(`${verb}: ingen källrad sist i detaljerna: ${detaljer}`);
        continue;
      }
      const handelsen = await handelsenMedId(id);
      if (handelsen.verb !== verb) fynd.push(`${verb}: källraden pekar på ${handelsen.verb}`);
      let senast = -1;
      for (const [nyckel, vantad] of Object.entries(falt)) {
        if (vantad === SE_ANDRING) {
          fynd.push(...andringsfel(detaljer, handelsen.payload.andring).map((f) => `${verb}: ${f}`));
          continue;
        }
        const revision = handelsen.payload.revision;
        if (vantad === SE_REVISION && typeof revision !== 'number') fynd.push(`${verb}: revisionen är inget tal`);
        const markup = vantad === SE_REVISION ? `<p>Revision: ${String(revision)}</p>` : vantad;
        const plats = detaljer.indexOf(markup);
        if (plats === -1) fynd.push(`${verb}, ${nyckel}: saknar ${markup} i ${detaljer}`);
        else if (plats < senast) fynd.push(`${verb}, ${nyckel}: står före fältet innan`);
        else senast = plats;
      }
    }
    expect(fynd).toEqual([]);

    // Övertagandets läge i ändringen, ordagrant.
    expect(detaljerI(radFor(historik.atg!, 'tog_over_atagande'))).toContain(
      '<div class=text><b>Ändring, Läge:</b> registrerat → övertaget</div>',
    );
  });

  it('HD6 (AK 2): ett märke i huvudet, utförarens och svarsaktörens i detaljerna, svaret som text och källan med radens id', async () => {
    // Kontroll först: räkningen ger 2 för en påhittad rad med två märken i huvudet.
    expect(
      markenIHuvudet(`<li class=rad><div class=huvud>${proveniens('agent', 'a')}${proveniens('manniska', 'b')}</div></li>`),
    ).toBe(2);

    // Den besvarade insatsen: ett märke i huvudet och svarsaktörens i detaljerna.
    const ins = historiken(await sidanMedMotkontroll('ins'));
    const svarsrad = radFor(ins, 'besvarade_insats');
    expect(markenIHuvudet(svarsrad)).toBe(1);
    const detaljer = detaljerI(svarsrad);
    expect(marken(detaljer)).toBe(1);
    expect(detaljer).toContain(`<p>Svarat av ${proveniens('manniska', 'david')}</p>`);
    // Svaret ordagrant och som text: ingen av formerna blir ett element eller en länk.
    const svaret = avsnitt(detaljer, '<div class=text><b>Svar:</b>', '</div>');
    expect(svaret).toBe(`<div class=text><b>Svar:</b> ${esc(SVAR)}`);
    expect(svaret).not.toContain('<a');
    expect(svaret).not.toContain('<script');
    // Källraden bär radens id ur databasen.
    expect(detaljer.endsWith(`<p>Källa: händelse #${await idFor(A.ins!, 'besvarade_insats')}</p>`)).toBe(true);

    // Övertagandet: ett märke i huvudet, och i detaljerna utföraren i fältet och efter pilen i ändringen.
    const atg = historiken(await sidanMedMotkontroll('atg'));
    const overtagande = radFor(atg, 'tog_over_atagande');
    expect(markenIHuvudet(overtagande)).toBe(1);
    const overtagandets = detaljerI(overtagande);
    expect(marken(overtagandets)).toBe(2);
    expect(overtagandets).toContain(`<p>Utförare: ${proveniens('manniska', 'david')}</p>`);
    expect(overtagandets).toContain(
      `<div class=text><b>Ändring, Utförare:</b> ingen → ${proveniens('manniska', 'david')}</div>`,
    );

    // Registreringens grund länkar till A.annat, som finns, och länken svarar 200.
    const lanken = `<a href="${arendeSokvag(A.annat!)}">${A.annat}</a>`;
    expect(detaljerI(radFor(atg, 'registrerade_atagande'))).toContain(lanken);
    expect((await request(app).get(arendeSokvag(A.annat!))).status).toBe(200);
  });
});

describe('D-4/Story 11.6 AK 5: R5 på sidan', () => {
  it('HD7 (AK 5): den privata grunden och det privata underlaget ger bara den fasta meningen, och historiken nämner ingen av sökvägarna', async () => {
    // Kontroll först: sökningen hittar de två sökvägarna i en påhittad markup, och det privata underlaget
    // står i den besvarade insatsens payload, så att frånvaron på sidan mäter något.
    for (const rel of [JOURNAL, HALSA]) {
      expect(privataTraffar(`<p>${rel}</p>`, rel), rel).not.toEqual([]);
      expect(privataTraffar(`<a href="/vy/dok/${ledvis(rel)}">x</a>`, rel), rel).not.toEqual([]);
    }
    const genomActionensId = (await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM events WHERE issue_id = $1 AND verb = 'besvarade_insats' AND aktor_typ = 'manniska'`,
      [await arendetsId(A.r5!)],
    )).rows;
    expect(genomActionensId).toHaveLength(1);
    const genomActionen = await handelsenMedId(genomActionensId[0]!.id);
    expect(genomActionen.payload.handlingskontrakt).toMatchObject({ underlag_lagrat: HALSA });

    const historik = historiken(await sidanMedMotkontroll('r5'));
    expect(detaljerI(radFor(historik, 'avslutade_atagande'))).toContain(`<p>Grund: ${esc(PRIVAT)}</p>`);

    const besvarade = radMedVerb(historik, esc(VERB.besvarade_insats));
    expect(besvarade).toHaveLength(2);
    const nya = besvarade.filter((rad) => huvudet(rad).includes(proveniens('manniska', 'david')));
    const aldre = besvarade.filter((rad) => huvudet(rad).includes(proveniens('system', 'hd äldre')));
    expect([nya.length, aldre.length]).toEqual([1, 1]);
    // Genom actionen: det härledda underlaget, ärendets adress, i code.
    expect(detaljerI(nya[0]!)).toContain(
      '<p>Handlingskontrakt: <code>arenden</code> · <code>beslutskoe --besvara</code> · <code>#153</code> · ' +
        `<code>${esc(`${TEST_VY_PUBLIK_URL}${arendeSokvag(A.r5!)}`)}</code></p>`,
    );
    // Den äldre raden, med det lagrade underlaget under underlag.
    expect(detaljerI(aldre[0]!)).toContain(`<p>Handlingskontrakt: ${esc(PRIVAT)}</p>`);

    expect([...privataTraffar(historik, JOURNAL), ...privataTraffar(historik, HALSA)]).toEqual([]);
  });
});

describe('D-3/Story 11.6 AK 6: inga påhittade värden på sidan', () => {
  it('HD8 (AK 6): äldre rader utan fälten står utan detaljer, ett fält i fel form med raden om formen, och visningen skriver inget', async () => {
    // Kontroll först: tankstrecksprövningen fäller ett påhittat «—» på en rad.
    expect(utanFastaTexter('<li class=rad><div class=huvud></div><p>Revision: —</p></li>')).toContain('—');

    const fore = await raknaRader('events');
    const historik = historiken(await sidanMedMotkontroll('aldre'));
    expect(await raknaRader('events')).toBe(fore);

    const aldre = (verb: string): string => {
      const rader = radMedVerb(historik, esc(VERB[verb])).filter((rad) =>
        huvudet(rad).includes(proveniens('system', 'hd äldre')),
      );
      expect(rader, verb).toHaveLength(1);
      return rader[0]!;
    };
    // Kontrollraden har alla fält och källraden, så att frånvaron nedan kan slå ut.
    expect(detaljerI(aldre('skot_upp_insats'))).toBe(
      `<p>Till: ${esc(datumtid(new Date(KONTROLLTID)))}</p>` +
        '<div class=text><b>Skäl:</b> HD kontroll</div>' +
        `<p>Källa: händelse #${await idFor(A.aldre!, 'skot_upp_insats')}</p>`,
    );
    expect(aldre('besvarade_insats')).not.toContain('Källa: händelse #');
    expect(aldre('registrerade_insats')).not.toContain('Källa: händelse #');
    expect(detaljerI(aldre('tog_over_atagande'))).toBe(
      `${fel('Revision')}<p>Källa: händelse #${await idFor(A.aldre!, 'tog_over_atagande')}</p>`,
    );
    expect(utanFastaTexter(historik)).not.toContain('—');
    expect(await raknaRader('events')).toBe(fore);
  });
});

// ---- Uppgift 3: övriga verb och digesten ---------------------------------------------------------------

/** Story 1.2:s block för en rättelse, ordagrant (tidigareText i test/historik-yta.test.ts). Argumenten är escapade. */
function tidigareText(fore: string, efter: string): string {
  return (
    '<details class=rattelse><summary>Visa tidigare text</summary><div class=text><h5>Före</h5><div class=text>' +
    fore +
    '</div><h5>Efter</h5><div class=text>' +
    efter +
    '</div></div></details>'
  );
}

describe('D-3/Story 11.6 AK 3: verb utanför tabellen som förut', () => {
  it('HD9 (AK 3) (R): verb, byte och skäl för verb utanför tabellen, och Story 1.2:s block, utan källrad', async () => {
    const G = 'HD9 <gammal> beskrivning';
    const N = 'HD9 ny beskrivning';
    const identifier = (await steg(hermes, 'create_issue', { title: 'HD9 övriga verb', team_key: 'LOC', description: G }))
      .identifier as string;
    A.ovriga = identifier;
    TITEL.ovriga = 'HD9 övriga verb';
    // Ett byte med skäl genom update_issue, och rättelsen av beskrivningen.
    await steg(david, 'update_issue', { identifier, priority: 2, skal: 'HD9 skälet för prioriteten' });
    await steg(david, 'update_issue', { identifier, description: N });
    // Ingen action skriver ett skäl på andrade_status, så den raden läggs in med ägarrollen, som H8.
    await aldreRader(identifier, [
      [
        'andrade_status',
        { identifier, fran: 'Todo', till: 'In Progress', typ: 'started', skal: 'HD9 skälet för statusbytet' },
      ],
    ]);
    const historik = historiken(await sidanMedMotkontroll('ovriga'));

    // Kontroll först: en rad för ett verb i tabellen på samma sida har källraden.
    expect(detaljerI(radFor(historik, 'skapade_arende'))).toMatch(/<p>Källa: händelse #\d+<\/p>$/);

    const status = radMedVerb(historik, `${esc(VERB.andrade_status)} ${esc(statusord('Todo'))} → ${esc(statusord('In Progress'))}`);
    expect(status).toHaveLength(1);
    expect(detaljerI(status[0]!)).toBe('<div class=text><b>Skäl:</b> HD9 skälet för statusbytet</div>');

    const prioritet = radMedVerb(historik, `${esc(VERB.andrade_prioritet)} ingen → 2`);
    expect(prioritet).toHaveLength(1);
    expect(detaljerI(prioritet[0]!)).toBe('<div class=text><b>Skäl:</b> HD9 skälet för prioriteten</div>');

    const rattelse = radFor(historik, 'rattade_beskrivning');
    expect(detaljerI(rattelse)).toBe(tidigareText(esc(G), esc(N)));
    expect(rattelse).not.toContain('Källa: händelse #');
  });
});

describe('D-3/Story 11.6 AK 4: digesten oförändrad', () => {
  it('HD10 (AK 4) (R): digesten visar verbet utan detaljerna, ingen GET skriver, och detaljerna byggs bara i ärenderutten', async () => {
    const fore = await raknaRader('events');
    // Kontroll först: ärendesidan för samma händelser bär svaret och svarsaktören.
    const sida = await sidan(A.ins!);
    expect(sida).toContain(esc(SVAR));
    expect(sida).toContain('Svarat av');

    const digest = await request(app).get('/vy/digest');
    expect(digest.status).toBe(200);
    expect(digest.text).toContain(`<span>${esc(VERB.besvarade_insats)}</span>`);
    for (const text of [esc(SVAR), 'Källa: händelse #', 'Svarat av']) expect(digest.text, text).not.toContain(text);
    expect(await raknaRader('events')).toBe(fore);

    // Statiskt: två anrop i ärenderuttens fil, båda i ärenderutten (kandidaterna och historiklistan).
    const kallan = readFileSync(fileURLToPath(new URL('../src/http/routes/vy.ts', import.meta.url)), 'utf8');
    expect(kallan.split('handelsensDetaljer(')).toHaveLength(3);
    const rader = kallan.split('\n');
    const start = rader.findIndex((rad) => rad.includes("vyRouter.get('/arende/:identifier'"));
    expect(start).toBeGreaterThan(-1);
    const slut = rader.findIndex((rad, i) => i > start && rad.includes('vyRouter.'));
    expect(slut).toBeGreaterThan(start);
    expect(rader.slice(start, slut).join('\n').split('handelsensDetaljer(')).toHaveLength(3);
  });
});

// ---- Review-uppföljningen ----------------------------------------------------------------------------------

/** Den fasta texten efter ett ärendenummer som inte finns (FINNS_INTE i src/http/vy/markdown.ts), provets kopia. */
const FINNS_INTE = '(finns inte)';
/** Ett ärende som finns i UPPSLAGET, som referens, och dess länk. */
const AREF = { typ: 'arende', id: 'LOC-7' };
const LANK_LOC7 = `<a href="${arendeSokvag('LOC-7')}">LOC-7</a>`;
/** Uppslaget utan ärendet: samma team, inga ärenden. */
const UPPSLAGET_UTAN = { team: new Set(['LOC']), arenden: new Set<string>() };
/** Ett nummer som inget ärende i fixturen har. */
const OKANT = 'LOC-999999';

/**
 * AK 2: varje position där detaljerna visar en referens, med ett ärende i den (1–11 och 15), och krockens
 * länk som en Linear-adress med ärendets nummer (12), som kortet skriver som ärendets nummer.
 */
const KANDIDATBARARE: Barare[] = [
  ...referensbarare(AREF),
  [
    12,
    'lank i en krock, en Linear-adress',
    'registrerade_insats',
    { krockar: [{ system: 'hd-linear', objekttyp: 'issue', objekt_id: 'hd-krock', lank: 'https://linear.app/hd/issue/LOC-7/hd' }] },
  ],
];

/**
 * På sidan: målet, raden (verbet och ett värde som bara den raden bär, när verbet står flera gånger) och
 * positionen. Varje mål nämns bara i historiken på A.kand.
 */
const SIDBARARE: [mal: string, verb: string, bar: string | undefined, position: string][] = [
  ['k1', 'tog_over_atagande', 'HD steg mot k1', 'grund och nästa stegs grund'],
  ['k1', 'hindrade_atagande', undefined, 'andring.nasta.fran.grund'],
  ['k2', 'hindrade_atagande', undefined, 'andring.hinder.till.belagg'],
  ['k2', 'tog_over_atagande', 'HD hinder mot k2', 'andring.hinder.fran.belagg'],
  ['k3', 'redovisade_resultat', undefined, 'andring.resultat.till.belagg'],
  ['k3', 'aterppnade_atagande', 'Tidigare resultat', 'tidigare.resultat.belagg'],
  ['k4', 'avslutade_atagande', undefined, 'grund'],
  ['k4', 'aterppnade_atagande', 'Tidigare avslutsskäl', 'tidigare.avslutsskal.grund'],
  ['k5', 'registrerade_insats', undefined, 'lank i en krock, en Linear-adress'],
];

describe('D-3/Story 11.6 AK 2: ärendenumren i historiken är kandidater', () => {
  it('HD11 (AK 2): ett ärende som bara historiken nämner länkas till ärendet, i varje position och på sidan', async () => {
    // Funktionsnivån: varje position samlar ärendet under insamlingen och länkar det med uppslaget.
    expect(positionerna(KANDIDATBARARE)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15]);
    const fynd: string[] = [];
    for (const [position, namn, verb, payload] of KANDIDATBARARE) {
      const h = handelse(verb, payload);
      const kandidater = arendekandidater((u) => kortmodulen.handelsensDetaljer(h, INDEX, u));
      if (JSON.stringify(kandidater) !== JSON.stringify(['LOC-7'])) {
        fynd.push(`(${position}) ${namn}: kandidaterna ${JSON.stringify(kandidater)}`);
      }
      const html = kortmodulen.handelsensDetaljer(h, INDEX, UPPSLAGET);
      if (!html.includes(LANK_LOC7) || html.includes(FINNS_INTE)) fynd.push(`(${position}) ${namn}: ${html}`);
      // Kontroll: utan ärendet i uppslaget står numret med «(finns inte)», så att mätningen kan slå ut.
      const utan = kortmodulen.handelsensDetaljer(h, INDEX, UPPSLAGET_UTAN);
      if (!utan.includes(`LOC-7</a> ${FINNS_INTE}`)) fynd.push(`(${position}) ${namn}, kontrollen: ${utan}`);
    }
    expect(fynd).toEqual([]);

    // Sidan: fem ärenden, vart och ett nämnt bara i historiken på A.kand. Varje handling tar bort referensen
    // ur åtagandet, så att den inte finns kvar i fältet Åtagande.
    for (const namn of ['k1', 'k2', 'k3', 'k4', 'k5']) {
      TITEL[namn] = `HD mål ${namn}`;
      await nytt(namn);
    }
    TITEL.kand = 'HD kandidaterna ur historiken';
    const kand = await nytt('kand');
    const mal = (namn: string) => ({ typ: 'arende', id: A[namn]! });
    await steg(hermes, 'registrera_atagande', { identifier: kand, grund: [GRUND_HD], nasta: INTERNT, foljs_upp: UPPFOLJNING });
    // k1: nästa stegs grund vid övertagandet; hindret byter nästa steg.
    await vidare(david, 'ta_over_atagande', kand, {
      nasta: { handling: 'HD steg mot k1', slag: 'internt', grund: mal('k1') },
      foljs_upp: UPPFOLJNING,
    });
    // k2: hindrets belägg; nästa övertagande tar bort hindret.
    await vidare(hermes, 'hindra_atagande', kand, {
      orsak: 'HD hinder mot k2',
      belagg: mal('k2'),
      nasta: INTERNT,
      foljs_upp: SENARE,
    });
    await vidare(david, 'ta_over_atagande', kand, { nasta: INTERNT, foljs_upp: UPPFOLJNING });
    // k3: resultatets belägg; återöppningen tar bort resultatet. Återöppningens grund är kontrollen, ett nummer
    // som inte finns.
    await vidare(hermes, 'redovisa_resultat', kand, { sammanfattning: 'HD resultat mot k3', belagg: [mal('k3')] });
    await vidare(hermes, 'aterppna_atagande', kand, { grund: { typ: 'arende', id: OKANT }, nasta: INTERNT, foljs_upp: SENARE });
    // k4: avslutsskälets grund; nästa återöppning tar bort avslutsskälet.
    await vidare(hermes, 'avsluta_atagande', kand, { text: 'HD avslut mot k4', grund: mal('k4') });
    await vidare(hermes, 'aterppna_atagande', kand, { grund: NY_GRUND, nasta: INTERNT, foljs_upp: SENARE });
    // k5: en krock vars länk är en Linear-adress med numret. Källan tillhör en insats utan ärende och följer
    // inte med till insatsen på A.kand.
    const linearkalla = {
      system: 'hd-linear',
      objekttyp: 'issue',
      objekt_id: 'hd-k5',
      lank: `https://linear.app/hd/issue/${A.k5}/hd`,
    };
    await insats('hd-k5-agare', { kallor: [linearkalla] });
    await insats('hd-k5', {
      identifier: kand,
      kallor: [{ system: 'arenden', objekttyp: 'beslut', objekt_id: 'hd-k5-egen' }, linearkalla],
    });

    const html = await sidanMedMotkontroll('kand');
    const historik = historiken(html);
    const utanfor = html.split(historik).join('');
    // Kontroll: numret som inte finns står med «(finns inte)» i samma historik.
    expect(historik).toContain(`<a href="${nummeruppslagSokvag(OKANT)}">${OKANT}</a> ${FINNS_INTE}`);
    for (const namn of ['k1', 'k2', 'k3', 'k4', 'k5']) {
      const nummer = A[namn]!;
      // Isoleringen: numret står ingen annanstans på sidan, så bara historiken kan göra det till en kandidat.
      expect(new RegExp(`${nummer}(?![0-9])`).test(utanfor), `${nummer} utanför historiken`).toBe(false);
      expect((await request(app).get(arendeSokvag(nummer))).status, nummer).toBe(200);
    }
    for (const [namn, verb, bar, position] of SIDBARARE) {
      const nummer = A[namn]!;
      const detaljer = detaljerI(radFor(historik, verb, bar === undefined ? undefined : esc(bar)));
      if (!detaljer.includes(`<a href="${arendeSokvag(nummer)}">${nummer}</a>`)) {
        fynd.push(`${namn} (${verb}, ${position}): ingen länk till ${nummer} i ${detaljer}`);
      }
      if (detaljer.includes(`${nummer}</a> ${FINNS_INTE}`)) fynd.push(`${namn} (${verb}, ${position}): ${FINNS_INTE}`);
    }
    expect(fynd).toEqual([]);
  });
});

/** Källtexten i en fil under src/, läst som HD2 och HD10 läser den. */
function kalltext(sokvag: string): string {
  return readFileSync(fileURLToPath(new URL(sokvag, import.meta.url)), 'utf8');
}

/** Fälten i ett block i en källtext: namnen före kolon, från `start` till blockets första `}`. */
function blocketsFalt(kalla: string, start: string): string[] {
  const i = kalla.indexOf(start);
  expect(i, `hittade inte ${start}`).toBeGreaterThan(-1);
  const kropp = kalla.slice(i + start.length, kalla.indexOf('}', i + start.length));
  return [...kropp.matchAll(/(\w+)\??:/g)].map((m) => m[1]!);
}

/** Bytets två sidor på raden «Ändring, ETIKETT», eller null när raden inte är ett byte. */
function bytet(html: string, etikett: string): [fore: string, efter: string] | null {
  const start = `<div class=text><b>Ändring, ${etikett}:</b> `;
  const i = html.indexOf(start);
  if (i === -1) return null;
  const delar = html.slice(i + start.length, html.indexOf('</div>', i)).split(' → ');
  return delar.length === 2 ? [delar[0]!, delar[1]!] : null;
}

const R1 = { typ: 'beslut', id: 'hd-r1' };
const R2 = { typ: 'beslut', id: 'hd-r2' };
const T1 = '2026-11-02T09:30:00.000Z';
const T2 = '2026-11-03T10:45:00.000Z';
/** Samma minut som T1, så att de två skrivs lika. */
const T1_SENARE = '2026-11-02T09:30:30.000Z';

/**
 * AK 2: objekten i ändringens värden. Blocket i src/services/atagande.ts ger domäntypens fält; provet har ett
 * fullständigt värde och för varje fält ett annat giltigt värde. Ett fält i domäntypen utan värden här fäller
 * provet.
 */
const VARDESLAG: { block: string; nyckel: string; etikett: string; lista: boolean; full: Record<string, unknown>; annat: Record<string, unknown> }[] = [
  {
    block: 'export interface Nasta {',
    nyckel: 'nasta',
    etikett: 'Nästa steg',
    lista: false,
    full: { handling: 'HD steg', slag: 'internt', grund: R1 },
    annat: { handling: 'HD annat steg', slag: 'riktning', grund: R2 },
  },
  {
    block: 'export interface Villkor {',
    nyckel: 'villkor',
    etikett: 'Villkor',
    lista: true,
    full: { text: 'HD villkor', kalla: R1, galler: 'HD gäller', kontroll: 'HD kontroll', utfall: 'uppfyllt', belagg: R1 },
    annat: {
      text: 'HD annat villkor',
      kalla: R2,
      galler: 'HD gäller annat',
      kontroll: 'HD annan kontroll',
      utfall: 'ej_uppfyllt',
      belagg: R2,
    },
  },
  {
    block: 'hinder?: {',
    nyckel: 'hinder',
    etikett: 'Hinder',
    lista: false,
    full: { orsak: 'HD hinder', belagg: R1 },
    annat: { orsak: 'HD annat hinder', belagg: R2 },
  },
  {
    block: 'resultat?: {',
    nyckel: 'resultat',
    etikett: 'Resultat',
    lista: false,
    full: { sammanfattning: 'HD resultat', belagg: [R1], kontrollerat: T1 },
    annat: { sammanfattning: 'HD annat resultat', belagg: [R2], kontrollerat: T2 },
  },
  {
    block: 'avslutsskal?: {',
    nyckel: 'avslutsskal',
    etikett: 'Avslutsskäl',
    lista: false,
    full: { text: 'HD avslut', grund: R1 },
    annat: { text: 'HD annat avslut', grund: R2 },
  },
];

/** Ordet efter «Tidigare» för varje fält i Tidigare. */
const TIDIGAREORD: Record<string, string> = { resultat: 'resultat', avslutsskal: 'avslutsskäl' };

describe('D-3/Story 11.6 AK 2: ändringens och det tidigares värden tappar ingen del', () => {
  it('HD12 (AK 2): varje fält i värdet syns, det som står utöver fälten står som övrigt, och ett byte skrivs aldrig med samma före och efter fast värdena skiljer sig', () => {
    const atagandet = kalltext('../src/services/atagande.ts');
    const insatsen = kalltext('../src/services/insats.ts');
    // Kontroll först: läsningen av källtexten ger villkorets fält, och bytet hittar ett byte som skrivs lika.
    expect(blocketsFalt(atagandet, 'export interface Villkor {')).toEqual([
      'text',
      'kalla',
      'galler',
      'kontroll',
      'utfall',
      'belagg',
    ]);
    expect(bytet('<div class=text><b>Ändring, Villkor:</b> X → X</div>', 'Villkor')).toEqual(['X', 'X']);

    const fynd: string[] = [];
    for (const slag of VARDESLAG) {
      const falt = blocketsFalt(atagandet, slag.block);
      expect(Object.keys(slag.full).sort(), slag.nyckel).toEqual([...falt].sort());
      expect(Object.keys(slag.annat).sort(), slag.nyckel).toEqual([...falt].sort());
      const somVarde = (v: unknown): unknown => (slag.lista ? [v] : v);
      // Ett byte där bara ett fält skiljer sig skrivs med olika före och efter, utan texten om formen.
      for (const f of falt) {
        const html = detaljerFor('andrade_atagande', {
          andring: { [slag.nyckel]: { fran: somVarde(slag.full), till: somVarde({ ...slag.full, [f]: slag.annat[f] }) } },
        });
        const sidor = bytet(html, slag.etikett);
        if (sidor === null) fynd.push(`${slag.nyckel}.${f}: inget byte i ${html}`);
        else if (sidor[0] === sidor[1]) fynd.push(`${slag.nyckel}.${f}: samma före och efter: ${sidor[0]}`);
        if (html.includes(esc(OKAND_DEL))) fynd.push(`${slag.nyckel}.${f}: texten om formen i ${html}`);
      }
      // Det som står utöver fälten står som «övrigt» med texten om formen.
      const ovrigt = detaljerFor('andrade_atagande', {
        andring: { [slag.nyckel]: { fran: null, till: somVarde({ ...slag.full, hd_okand: 'x' }) } },
      });
      if (!ovrigt.includes(`övrigt ${esc(OKAND_DEL)}`)) fynd.push(`${slag.nyckel}: inget övrigt i ${ovrigt}`);
    }

    // Granskarens fall ordagrant: villkorets alla delar, också gäller, kontroll och belägget.
    const villkoret = VARDESLAG.find((s) => s.nyckel === 'villkor')!.full;
    expect(detaljerFor('andrade_atagande', { andring: { villkor: { fran: [], till: [villkoret] } } })).toBe(
      `<div class=text><b>Ändring, Villkor:</b> inga → HD villkor · källa ${ref('beslut', 'hd-r1')} · ` +
        `gäller HD gäller · kontroll HD kontroll · utfall uppfyllt · belägg ${ref('beslut', 'hd-r1')}</div>${KALLRAD}`,
    );

    // Det tidigare: varje fält i Tidigare står på sin rad, och varje del av dess värde syns.
    const tidigaresFalt = blocketsFalt(atagandet, 'export interface Tidigare {');
    expect(Object.keys(TIDIGAREORD).sort()).toEqual([...tidigaresFalt].sort());
    for (const f of tidigaresFalt) {
      const slag = VARDESLAG.find((s) => s.nyckel === f);
      if (slag === undefined) {
        fynd.push(`tidigare.${f}: inget värde i VARDESLAG`);
        continue;
      }
      const html = detaljerFor('aterppnade_atagande', { tidigare: { [f]: slag.full } });
      if (!html.startsWith(`<div class=text><b>Tidigare ${TIDIGAREORD[f]}:</b> `)) fynd.push(`tidigare.${f}: ${html}`);
      for (const del of Object.keys(slag.full)) {
        const annat = detaljerFor('aterppnade_atagande', { tidigare: { [f]: { ...slag.full, [del]: slag.annat[del] } } });
        if (annat === html) fynd.push(`tidigare.${f}.${del}: skrivs som det fullständiga värdet`);
      }
    }
    expect(detaljerFor('aterppnade_atagande', { tidigare: { resultat: null, avslutsskal: null, hd_okand: 1 } })).toBe(
      `${fel('Tidigare, övrigt')}${KALLRAD}`,
    );

    // Nästa steg under raden, handlingskontraktet och en krock: det som står utöver fälten står som «övrigt»,
    // och slaget står också när handlingen saknas.
    expect(detaljerFor('tog_over_atagande', { nasta: { handling: 'HD steg', slag: 'internt', hd_okand: 1 } })).toBe(
      `<div class=text><b>Nästa steg (internt):</b> HD steg</div>${fel('Nästa steg, övrigt')}${KALLRAD}`,
    );
    expect(detaljerFor('tog_over_atagande', { nasta: { slag: 'riktning' } })).toBe(
      `<p>Nästa stegs slag: riktning</p>${KALLRAD}`,
    );
    expect(
      bytet(detaljerFor('andrade_atagande', { andring: { nasta: { fran: null, till: { slag: 'riktning', grund: R1 } } } }), 'Nästa steg'),
    ).toEqual(['ingen', `slag riktning · grund ${ref('beslut', 'hd-r1')}`]);
    expect(
      detaljerFor('besvarade_insats', {
        handlingskontrakt: { system: 's', underlag_harlett: true, underlag_lagrat: null, hd_okand: 1 },
      }),
    ).toBe(`<p>Handlingskontrakt: <code>s</code></p>${fel('Handlingskontrakt, övrigt')}${KALLRAD}`);
    // Kontroll: kontraktet med sina sex nycklar har inget övrigt.
    expect(
      detaljerFor('besvarade_insats', {
        handlingskontrakt: { system: 's', kommando: 'k', objekt: 'o', underlag: 'u', underlag_harlett: false, underlag_lagrat: 'u' },
      }),
    ).toBe(`<p>Handlingskontrakt: <code>s</code> · <code>k</code> · <code>o</code> · <code>u</code></p>${KALLRAD}`);
    const kallfalt = blocketsFalt(insatsen, 'export interface Kallreferens {');
    const krock = { system: 'hd', objekttyp: 'uppdrag', objekt_id: 'hd-k', objekt_version: '1', lank: null };
    expect(Object.keys(krock).sort()).toEqual([...kallfalt].sort());
    const kallan = '<p>Källa: <code>hd</code> · <code>uppdrag</code> · <code>hd-k</code> · version <code>1</code></p>';
    expect(detaljerFor('registrerade_insats', { krockar: [krock] })).toBe(`<p>Krockar: 1</p>${kallan}${KALLRAD}`);
    expect(detaljerFor('registrerade_insats', { krockar: [{ ...krock, hd_okand: 1 }] })).toBe(
      `<p>Krockar: 1</p>${kallan}${fel('Krock, övrigt')}${KALLRAD}`,
    );

    // Ett byte vars två sidor skrivs lika fast de lagrade värdena skiljer sig står med raden om formen: två
    // privata referenser, två tider i samma minut och två värden i fel form.
    const privA = { typ: 'dokument', id: JOURNAL };
    const privB = { typ: 'dokument', id: PRIVATA_FALL['jag.md']! };
    const resultatet = VARDESLAG.find((s) => s.nyckel === 'resultat')!.full;
    const LIKA_SKRIVNA: [etikett: string, andring: Record<string, unknown>][] = [
      ['Grund', { grund: { fran: [privA], till: [privB] } }],
      ['Villkor', { villkor: { fran: [{ ...villkoret, kalla: privA }], till: [{ ...villkoret, kalla: privB }] } }],
      ['Följs upp', { foljs_upp: { fran: T1, till: T1_SENARE } }],
      ['Resultat', { resultat: { fran: resultatet, till: { ...resultatet, kontrollerat: T1_SENARE } } }],
      ['Nästa steg', { nasta: { fran: 'trasig', till: 7 } }],
      ['Utförare', { utforare_typ: { fran: 7, till: 8 } }],
    ];
    for (const [etikett, andring] of LIKA_SKRIVNA) {
      const html = detaljerFor('andrade_atagande', { andring });
      if (html !== `${fel(`Ändring, ${etikett}`)}${KALLRAD}`) fynd.push(`lika skrivna, ${etikett}: ${html}`);
      fynd.push(...privataTraffar(html, privA.id), ...privataTraffar(html, privB.id));
    }
    // Kontroll: ett byte med lika lagrade värden står som det är lagrat.
    expect(detaljerFor('andrade_atagande', { andring: { lage: { fran: 'registrerat', till: 'registrerat' } } })).toBe(
      `<div class=text><b>Ändring, Läge:</b> registrerat → registrerat</div>${KALLRAD}`,
    );
    expect(fynd).toEqual([]);
  });
});

/** Tider i ISO-formen och ögonblicket de anger. */
const ISO_TIDER: [tid: string, ogonblick: number][] = [
  ['2026-11-02T09:30:00.000Z', Date.UTC(2026, 10, 2, 9, 30)],
  ['2026-11-02T09:30:00Z', Date.UTC(2026, 10, 2, 9, 30)],
  ['2026-11-02T09:30Z', Date.UTC(2026, 10, 2, 9, 30)],
  ['2026-11-02T10:30:00+01:00', Date.UTC(2026, 10, 2, 9, 30)],
  ['2026-11-02T10:30:00.123456+0100', Date.UTC(2026, 10, 2, 9, 30, 0, 123)],
  ['2026-11-02T04:30:00-05:00', Date.UTC(2026, 10, 2, 9, 30)],
  ['2028-02-29T23:59:59.999Z', Date.UTC(2028, 1, 29, 23, 59, 59, 999)],
];

/** Strängar som inte är en tid i ISO-formen. Flera av dem godtar datumtolken i JavaScript. */
const INTE_ISO = [
  '12',
  '0',
  '2026',
  '2026-11',
  '2026-11-02',
  '2026-11-02T09:30:00',
  '2026-11-02 09:30:00Z',
  '2026-11-02t09:30:00z',
  'November 2, 2026 09:30',
  'Mon, 02 Nov 2026 09:30:00 GMT',
  '2026/11/02 09:30',
  '+002026-11-02T09:30:00Z',
  ' 2026-11-02T09:30:00Z',
  '2026-11-02T09:30:00Z ',
  '2026-02-29T09:30:00Z',
  '2026-02-30T09:30:00Z',
  '2026-04-31T09:30:00Z',
  '2026-13-02T09:30:00Z',
  '2026-00-02T09:30:00Z',
  '2026-11-00T09:30:00Z',
  '2026-11-02T24:00:00Z',
  '2026-11-02T09:60:00Z',
  '2026-11-02T09:30:60Z',
  '2026-11-02T09:30:00+24:00',
  '2026-11-02T09:30:00+01:60',
  '2026-11-02T9:30:00Z',
  '2026-11-02T09:30:00.Z',
];

/** En tid som datumtid skriver den: datum och klockslag. */
const VISAD_TID = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

/** AK 6: varje position där detaljerna visar en tid, med tiden insatt. */
const TIDSBARARE: [namn: string, bygg: (tid: string) => [verb: string, payload: Record<string, unknown>]][] = [
  ['till på skot_upp_insats', (t) => ['skot_upp_insats', { till: t }]],
  ['andring.overtaget_nar', (t) => ['tog_over_atagande', { andring: { overtaget_nar: { fran: null, till: t } } }]],
  ['andring.foljs_upp', (t) => ['andrade_atagande', { andring: { foljs_upp: { fran: null, till: t } } }]],
  [
    'kontrollerat i andring.resultat',
    (t) => ['redovisade_resultat', { andring: { resultat: { fran: null, till: { sammanfattning: 'HD', kontrollerat: t } } } }],
  ],
  [
    'kontrollerat i tidigare.resultat',
    (t) => ['aterppnade_atagande', { tidigare: { resultat: { sammanfattning: 'HD', kontrollerat: t }, avslutsskal: null } }],
  ],
];

describe('D-3/Story 11.6 AK 6: en tid bara i ISO-formen', () => {
  it('HD13 (AK 6): en tid visas bara när den står i ISO-formen med ett datum och ett klockslag som finns, i varje position där detaljerna visar en tid', () => {
    // Kontroll först: datumtolken i JavaScript godtar flera av formerna, och mönstret för en visad tid hittar
    // en tid som den hade visats.
    const godtas = INTE_ISO.filter((s) => !Number.isNaN(new Date(s).getTime()));
    expect(godtas).toEqual(expect.arrayContaining(['2026', '2026-11', '2026-11-02', '2026-11-02T09:30:00']));
    expect(VISAD_TID.test(esc(datumtid(new Date('2026'))))).toBe(true);

    const fynd: string[] = [];
    for (const [namn, bygg] of TIDSBARARE) {
      for (const [tid, ogonblick] of ISO_TIDER) {
        const html = detaljerFor(...bygg(tid));
        if (!html.includes(esc(datumtid(new Date(ogonblick)))) || html.includes(esc(OKAND_DEL))) {
          fynd.push(`${namn}, ${tid}: ${html}`);
        }
      }
      for (const tid of INTE_ISO) {
        const html = detaljerFor(...bygg(tid));
        if (VISAD_TID.test(html) || !html.includes(esc(OKAND_DEL))) fynd.push(`${namn}, ${JSON.stringify(tid)}: ${html}`);
      }
    }
    expect(fynd).toEqual([]);

    // Statiskt: i detaljernas del av kort.ts blir ingen sträng en tid genom datumtolken; den enda tiden som
    // skapas där är nollan som giltigTid räknar fram ögonblicket från.
    const detaljdelen = avsnitt(kalltext('../src/http/vy/kort.ts'), '// ---- Historikens detaljer', '// ---- Kortet');
    expect(detaljdelen.match(/new Date\(/g)).toHaveLength(1);
    expect(detaljdelen).toContain('new Date(0)');
    expect(detaljdelen).not.toContain('Date.parse');
  });
});
