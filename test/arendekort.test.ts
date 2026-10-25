// D-3, D-5 (Story 11.4): ärendekortet har en sluten lista fält, och inget fält står tyst tomt. Kortets data
// hämtas av hamtaArendekort() i ett fast antal frågor, och kortet renderas ur KORTFALT, där varje fält står i
// exakt ett av fem lägen och ett tomt läge säger varför och var uppgiften sätts.
// Fallistorna: K1 tre ärenden (tunt, tjockt och med projekt) och ett ensamt hamtaArende (AK 7); K2 datat för
// huvudärendet och det tomma ärendet (AK 2–5 och 7); K3 de fem lägena, fyra tomma konstruktörsfall och en
// rendering per läge (AK 1); K4 tabellen FALLEN med en rad per fält i KORTFALT, ett värdefall och ett tomt
// fall, och ankarnas ordning (AK 1); K5 ramens fem fält med och utan poster (AK 5 och 6); K6 ärenderutten och
// kortets modul som text och tre visningar utan skrivning (AK 7); K7 fyra fall för Frist och fyra för Ägare
// (AK 2); K8 två projektfall, fem kundfall och Uppdrag (AK 3); K9 tre ursprung och ett utan skapanderad (AK 4);
// K10 Nämner, Nämns i (synlig kommentar, borttagen kommentar och beskrivning), Dubbletter, ett märkt och ett
// omärkt delärende och de nio länkarna under Kopplade ärenden (AK 5); K11 två kort × 16 avsnitt och fem tomma
// former (AK 6 och AK 1); K12 sju bärare av tecknen <script>, " och & (AK 8); K13 ordningen överst, ingen
// script och inga nya komponentnamn (AK 9); K14 README:s avsnitt för D-3 (AK 11).
// Ur code-review: K15 märkningar på delärenden som flyttats, två kort och sex kombinationer av barn och
// märkningar (AK 5); K16 aktörerna på sexton kort och arkivärendets egna fält, och plockningens tre fall
// (AK 8); K17 taket för Nämns i, fyra antal × fyra platser för ärendet självt och 200/201 i databasen
// (AK 5); K18 tio skrivsätt för ett omnämnande, exemplen i fältets text och Nämns i:s tre former (AK 5).
// D-3, D-4 (Story 11.5): K19 läsmodellens nya delar för fyra ärenden (AK 2–4 och 9); K20 1 mot 10 insatser,
// beslut och villkor med samma antal frågor (AK 9); K21 mätningen av referenstyperna som delta och som
// barnprocess (AK 1); K22 sex privata poster i tretton former och sex motexempel (AK 6); K23 en referens per
// typ i REFERENSLANK, den okända typen, tre felformade, en privat och sex källor (AK 1, 4 och 6); K24 tio
// texter genom autolänkarens egen rendering och den statiska läsningen av markdown.ts (AK 5); K25 åtagandets
// fem lägen och ärendet utan (AK 2); K26 två ärenden med och utan beslut, och en version för ett okopplat
// beslut (AK 3); K27 fyra insatslägen och ärendet utan, med svaret ordagrant (AK 4); K28 de fula tecknen i
// åtagandet och insatserna och tre visningar utan skrivning (AK 9); K29 tre referensformer och två spegelfall
// (AK 5); K30 sex privata sökvägar i fyra bärare på kortet (AK 6); K31 två mailbärare, ärendet utan och två
// privata mailreferenser (AK 7); K32 kortets och läsmodellens källtext och konfigurationens nycklar (AK 8).
// Ur code-review (Story 11.5): K22 också de former som en läsare, URL-tolken eller Obsidian läser som en privat
// sökväg (lastaFormer, 23 per post) och motexemplen i nio av dem; K23 sju referenser och fem källor i sådana
// former; K30 åtta bärare till på kortet (PRIVATA_TRASIGA); K34 varje väg in som frågar privatKalla, 21 bärare
// (AK 6); K35 mailens rubrik i sex former (AK 7); K36 beslutstexten i fyra fall (AK 3); K37 delar i fel form i
// åtagandet och insatsen (AK 2 och 4); K38 den slutna listan REFERENSBARARE mot Åtagande, Mail och mätningen
// (AK 1, 2 och 7).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { EnvSchema } from '../src/config.js';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { crmAnrop, nollstallCrmCache } from '../src/http/vy/crm.js';
import type { Dokumentindex } from '../src/http/vy/dokument.js';
// Story 11.5: namnrymder för det som berättelsen lägger till i vylagret (se importen av läsmodellen nedan).
import * as dokumentet from '../src/http/vy/dokument.js';
import * as kortmodulen from '../src/http/vy/kort.js';
import * as markdownen from '../src/http/vy/markdown.js';
import {
  agareLage,
  delarendenLage,
  fristLage,
  KORTFALT,
  kundLage,
  LAGEN,
  namnsILage,
  renderaFalt,
  tomt,
  varde,
} from '../src/http/vy/kort.js';
import { datumtid, esc, proveniens, sakerUrl } from '../src/http/vy/mall.js';
import { arendekandidater, renderaArendetext } from '../src/http/vy/markdown.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { hamtaArende, hamtaEllerSkapaProjekt, importeraArende, skapaArende } from '../src/services/arenden.js';
import {
  hamtaArendekort,
  NAMNS_I_GRANS,
  namnsIUrTraffar,
  TAK_NAMNS_I,
  type Markning,
} from '../src/services/arendekort.js';
// Story 11.5: namnrymd och inga namngivna importer för det som berättelsen lägger till, så att ett fall
// som behöver en export som ännu saknas blir rött med «är inte en funktion» och inte fäller hela filen.
import * as arendekortet from '../src/services/arendekort.js';
import { hamtaKundkoppling, sattKundkoppling } from '../src/services/kundkoppling.js';
import { kravTeam, stateAvTyp } from '../src/services/team.js';
import { TEST_CRM_KONF, TEST_VAULT } from './env.js';
import { kor, nyNyckel, raknaRader, TENANT_ID } from './helpers.js';

const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));

// CRM-uppslaget går mot en stängd port på loopback, som i test/crm.test.ts: ingen tjänst nås (B-48).
const STANGD_PORT = 'http://127.0.0.1:1';
const TESTTOKEN = 'TESTTOKEN-ARENDEKORTET-FAR-ALDRIG-SYNAS';
const TESTBOLAG = '00000000-0000-4000-8000-000000000114';
const TESTKUND = '11400000-0000-4000-8000-000000000114';

// Alltid i framtiden, räknat från klockan när provet körs (som SEN i test/insats.test.ts).
const DAG = 24 * 60 * 60 * 1000;
const NU = Date.now();
const UPPFOLJNING = new Date(NU + 365 * DAG).toISOString();
const SENARE_UPPFOLJNING = new Date(NU + 400 * DAG).toISOString();
const FRIST_I1 = new Date(NU + 10 * DAG).toISOString();
const FRIST_I2 = new Date(NU + 20 * DAG).toISOString();
const VACKNING_I2 = new Date(NU + 5 * DAG).toISOString();
const FRIST_I3 = new Date(NU + 30 * DAG).toISOString();
const DEADLINE = '2026-12-01';
// Story 11.5: J1:s frist och J3:s väckningstid på ärendet med fyra insatser.
const FRIST_J1 = new Date(NU + 15 * DAG).toISOString();
const VACKNING_J3 = new Date(NU + 7 * DAG).toISOString();

const GRUND = { typ: 'beslut', id: '153', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND };

// Story 11.5: svarsversionernas hashar, gemen hex med 16–64 tecken som registrera_svarsversion kräver, och
// med olika första tolv tecken, som kortet visar för en version utan löpnummer.
const HASH_54_V1 = '5401aaaaaaaaaaaaaaaa';
const HASH_54 = '5402bbbbbbbbbbbbbbbb';
const HASH_61 = '6101cccccccccccccccc';

/** Villkor med utfallet okänt, som inte kräver belägg (VillkorSchema i src/actions/registry.ts). */
function villkoren(antal: number): Record<string, unknown>[] {
  return Array.from({ length: antal }, (_, i) => ({
    text: `K villkor ${i + 1}`,
    kalla: GRUND,
    galler: 'K gäller tills vidare',
    kontroll: 'K kontrolleras vid uppföljningen',
    utfall: 'okant',
  }));
}

// AK 8: tecknen <script>, " och & i varje bärare.
const FULT = '<script>alert(1)</script> "citat" & co';
const FULT_TITEL = `K fult ärende ${FULT}`;
const FULT_PROJEKT = `K-fult ${FULT}`;
const FULT_ETIKETT = `K-fult ${FULT}`;
const FULT_FORALDER = `K fult förälder ${FULT}`;
const FULT_DEL = `K fult delärende ${FULT}`;
const FULT_MOTPART = `K fult motpart ${FULT}`;
const FULT_NAMNARE = `K fult nämnare ${FULT}`;
/** Story 11.5 AK 4: svaret på J2, med tecknen och en radbrytning som ska stå kvar ordagrant. */
const SVARET = `${FULT}\nandra raden`;

/**
 * Vad fältet Nämns i påstår om ett skrivsätt, och inget annat (review-fynd 4 och kedjans körning): 'hittas'
 * (numret som eget ord, som fältet säger att sökningen hittar), 'exempel' (fältets text nämner skrivsättet
 * som exempel på det sökningen inte läser som numret, med frasen ordagrant) eller null (fältet påstår
 * ingenting, och provet kräver inget av sökningen). Hur sökindexet delar upp en text i ord avgör Postgres och
 * inte kortet: «LOC-N-uppföljningen» ger en träff, fast det är ihopskrivet. Därför påstår fältet bara det
 * som provet här visar.
 */
type Utsaga = 'hittas' | 'exempel' | null;

/**
 * Skrivsätten för ett omnämnande av ett nummer och var de står. Nämner läser sidans egen rendering av
 * beskrivningen och de synliga kommentarerna och tar med vart och ett av dem (Dev Notes → Tolkningar,
 * punkt 6); titeln läser bara sökningen. För ett skrivsätt i titeln är texten hela titeln.
 */
const SKRIVSATTEN: {
  namn: string;
  i: 'kommentar' | 'beskrivning' | 'titel';
  text: (identifier: string) => string;
  utsaga: Utsaga;
  fras?: string;
}[] = [
  { namn: 'eget ord', i: 'kommentar', text: (id) => `Se ${id}.`, utsaga: 'hittas' },
  { namn: 'gemener', i: 'kommentar', text: (id) => `se ${id.toLowerCase()} också.`, utsaga: 'hittas' },
  { namn: 'inom parentes', i: 'kommentar', text: (id) => `Hänger ihop (${id}) med det här.`, utsaga: 'hittas' },
  { namn: 'fetstil', i: 'kommentar', text: (id) => `**${id}** gäller.`, utsaga: 'hittas' },
  {
    namn: 'först på en rad',
    i: 'kommentar',
    text: (id) => `Första raden.\n${id} står först på andra raden.`,
    utsaga: 'hittas',
  },
  { namn: 'i beskrivningen', i: 'beskrivning', text: (id) => `Bygger på ${id}.`, utsaga: 'hittas' },
  { namn: 'i titeln', i: 'titel', text: (id) => `K skrivsätt i titeln följer upp ${id}`, utsaga: 'hittas' },
  {
    namn: 'Linear-adress',
    i: 'kommentar',
    text: (id) => `Se https://linear.app/locollabs/issue/${id}/k-adress`,
    utsaga: 'exempel',
    fras: 'inne i en Linear-adress',
  },
  {
    namn: 'inledande nolla',
    i: 'kommentar',
    text: (id) => `Se ${id.replace('-', '-0')}.`,
    utsaga: 'exempel',
    fras: 'med inledande nollor',
  },
  { namn: 'ihopskrivet med bindestreck', i: 'kommentar', text: (id) => `Se ${id}-uppföljningen.`, utsaga: null },
];

/** Fixturens ärenden, lästa ur svaren. Inget nummer skrivs in i förväg utom det importerade LOC-316. */
const A: Record<string, string> = {};
/**
 * Insatserna på huvudärendet: I1 väntande, I2 uppskjuten och I3 återkallad. Story 11.5: J1 väntande, J2
 * besvarad, J3 uppskjuten och J4 återkallad på ärendet med fyra insatser.
 */
const I: Record<string, string> = {};

let app: Express;
let hermes: string; // agent
let david: string; // människa

/** Ett anrop som MÅSTE lyckas (som i test/atagande-handelser.test.ts rad 60–64). */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

async function nytt(titel: string, extra: Record<string, unknown> = {}): Promise<string> {
  return (await steg(hermes, 'create_issue', { title: titel, team_key: 'LOC', ...extra })).identifier as string;
}

async function foralder(identifier: string, parent: string): Promise<void> {
  await steg(hermes, 'update_issue', { identifier, parent });
}

async function atagande(identifier: string): Promise<void> {
  await steg(hermes, 'registrera_atagande', { identifier, grund: [GRUND], nasta: INTERNT, foljs_upp: UPPFOLJNING });
}

/** registrera_insats som grund() i test/insats.test.ts rad 21–33, med eget stopp och egen källa. */
async function insats(stopp: string, identifier: string, extra: Record<string, unknown>): Promise<string> {
  const svar = await steg(hermes, 'registrera_insats', {
    stopp_id: stopp,
    typ: 'agarbeslut',
    tillhor: 'agare',
    utfall: 'Riktningen är vald och arbetet kan fortsätta',
    begard_handling: 'Välj mellan A och B',
    blockeringsgrund: 'Tidigare besked avgör inte valet',
    handlingskontrakt: { system: 'hermes', kommando: 'beslutskoe --besvara', objekt: '#153' },
    kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: stopp }],
    identifier,
    ...extra,
  });
  return svar.insats.id as string;
}

/** Instrumentering (som i test/djuplank.test.ts rad 259–275): varje räknad fråga går vidare till riktig Postgres. */
function raknandeKlient(client: PoolClient): { klient: PoolClient; antal: () => number } {
  let antal = 0;
  const klient = new Proxy(client, {
    get(mal, namn) {
      const varde: unknown = Reflect.get(mal, namn, mal);
      if (namn === 'query' && typeof varde === 'function') {
        return (...args: unknown[]) => {
          antal += 1;
          return (varde as (...a: unknown[]) => unknown).apply(mal, args);
        };
      }
      return typeof varde === 'function' ? (varde as (...a: unknown[]) => unknown).bind(mal) : varde;
    },
  });
  return { klient, antal: () => antal };
}

const INDEX: Dokumentindex = { filnamn: new Map() };
const ROT = fileURLToPath(new URL('../', import.meta.url));

/** Lägestexterna ordagrant (Dev Notes → Texterna). Provet har egna kopior och läser dem inte ur modulen. */
const TEXT = {
  frist: 'Saknas — ingen deadline satt (update_issue, fältet due).',
  agare:
    'Finns inte i plattformen — ärendeplattformen har inget ansvarigfält. Ägaren härleds ur åtagandet när ärendet bär ett.',
  projekt: 'Saknas — ärendet har inget projekt (update_issue, fältet projekt).',
  kundOavgjord: 'Saknas — kundkopplingen är inte avgjord (set_project_customer).',
  kundUtanProjekt: 'Saknas — ärendet har inget projekt att koppla kunden genom.',
  kundCrmNere: 'Kunde inte läsas just nu — CRM-data ej tillgänglig.',
  kundInternt: 'Internt projekt — ska aldrig kopplas till en kund.',
  uppdrag:
    'Finns inte i plattformen — föreslagen källa: redovisningens uppdrag för projektets kund (David har sagt ja ' +
    'till kopplingen, som byggs i Story 11.8).',
  ursprung: 'Saknas — ingen skapanderad i händelseloggen.',
  beskrivning:
    'Saknas — ingen beskrivning (update_issue, fältet description; i ytan under Rätta titel eller beskrivning).',
  bilagor: 'Inga bilagor (add_attachment).',
  foralder: 'Inga — ärendet ligger överst i sin hierarki.',
  delarenden: 'Inga delärenden (update_issue, fältet parent).',
  relationer: 'Inga relationer (link_issues).',
  namner:
    'Inga — beskrivningen och de synliga kommentarerna nämner inget annat ärende som finns (ett nummer skrivs ' +
    'in med add_comment eller update_issue, fältet description).',
  dubbletter:
    'Finns inte i plattformen — relationstyperna är relaterat och blockerar (migration 0008). Föreslagen källa: ' +
    'en relationstyp för dubbletter i link_issues.',
  kommentarer: 'Ingen har kommenterat det här ärendet ännu.',
  historik: 'Ärendet har inte ändrats sedan det kom in.',
  // Story 11.5 (Dev Notes → Texterna). beslutstext står sist i Besluts värde, inte som lägestext.
  atagande: 'Inga — inget åtagande registrerat (registrera_atagande).',
  beslut: 'Inga — inget beslut kopplat (koppla_beslut).',
  beslutstext:
    'Finns inte i plattformen — texten finns i beslutskön. Föreslagen källa: Story 11.9 (David har valt att ' +
    'Beslutskön skickar texten med svarsversionen och att kortet länkar till beslutet).',
  insatser: 'Inga — ingen insats registrerad på ärendet (registrera_insats).',
  // ingaDokument står i dokumentdelen och mailrad sist i Mails värde, inte som lägestexter.
  ingaDokument: 'Inget dokument i dokumentområdet nämns i beskrivningen eller i de synliga kommentarerna.',
  mail:
    'Finns inte i plattformen — plattformen bär inga mail. Föreslagen källa: redovisningens mailtrådar för ' +
    'projektets kund (David har sagt ja till kopplingen, som byggs i Story 11.8).',
  mailrad:
    'Länk och rubrik ur mailen kräver kopplingen till redovisningens mailtrådar — David har sagt ja till den, ' +
    'och den byggs i Story 11.8.',
};

/** Dokument och underlag utan spegel (Story 11.5); LOC-N är ärendets eget nummer. */
function spegeltext(identifier: string): string {
  return `Saknas — spegeln (arenden_arkiv.py) har inte skrivit ${identifier}.md än.`;
}

/**
 * Vad «Nämns i» räknar (review-fynd 4): sökningens träffar. Fältet påstår att numret som eget ord hittas och
 * nämner exemplen i SKRIVSATTEN med utsagan 'exempel', och inget mer. Står i båda lägena, i notisen och
 * efter listan; LOC-N är ärendets eget nummer.
 */
function namnsIOmfang(identifier: string): string {
  return (
    `Ett annat ärende räknas här när sökningen efter ${identifier} hittar det, och sökningen hittar numret ` +
    'skrivet som ett eget ord i ett ärendes titel, beskrivning eller synliga kommentarer. Ett omnämnande som ' +
    'sökningen inte läser som numret, till exempel inne i en Linear-adress eller med inledande nollor, räknas ' +
    'inte här men kan stå under Nämner på det andra ärendet.'
  );
}

/** Exemplen som fältets text nämner på det sökningen inte läser som numret, i textens ordning. */
function exempelIText(text: string): string[] {
  const m = /till exempel (.+?), räknas inte här/.exec(text);
  return m === null ? [] : m[1]!.split(/, | eller /);
}

/** «Nämns i» utan träffar; LOC-N är ärendets eget nummer. */
function namnsIInga(identifier: string): string {
  return (
    `Inga — inget annat ärende nämner ${identifier} i sin text eller i en synlig kommentar ` +
    `(add_comment på det andra ärendet). ${namnsIOmfang(identifier)}`
  );
}

/**
 * En rad per fält i KORTFALT: ett värdefall (ärendet och en delsträng i fältets avsnitt) och ett tomt fall
 * (ärendet och lägestexten). Luckorna har inget värdefall (Dev Notes → Tolkningar, punkt 3). Raderna är
 * funktioner, eftersom ärendenas nummer läses ur fixturens svar.
 */
type Fall = { varde: (() => [string, string]) | null; tomt: () => [string, string] };
const FALLEN: Record<string, Fall> = {
  frist: { varde: () => [A.deadline!, `<p>senast ${DEADLINE}</p>`], tomt: () => [A.tom!, TEXT.frist] },
  agare: {
    varde: () => [A.claim!, `<p>plockat av ${proveniens('agent', 'hermes')}</p>`],
    tomt: () => [A.tom!, TEXT.agare],
  },
  projekt: { varde: () => [A.k_oavgjort!, '<p>K-oavgjort</p>'], tomt: () => [A.tom!, TEXT.projekt] },
  kund: { varde: () => [A.k_internt!, `<p>${TEXT.kundInternt}</p>`], tomt: () => [A.tom!, TEXT.kundUtanProjekt] },
  uppdrag: { varde: null, tomt: () => [A.h!, TEXT.uppdrag] },
  ursprung: { varde: () => [A.tom!, '<p>skapat i plattformen</p>'], tomt: () => [A.utan!, TEXT.ursprung] },
  beskrivning: { varde: () => [A.h!, 'Hänger ihop med'], tomt: () => [A.tom!, TEXT.beskrivning] },
  atagande: { varde: () => [A.h!, '<p>Läge: övertaget · tillhör Hermes</p>'], tomt: () => [A.tom!, TEXT.atagande] },
  beslut: { varde: () => [A.beslut!, '<p>beslut #54 · kopplat '], tomt: () => [A.tom!, TEXT.beslut] },
  insatser: {
    varde: () => [A.h!, '<h3>ägarbeslut · väntande · tillhör ägaren</h3>'],
    tomt: () => [A.tom!, TEXT.insatser],
  },
  // Story 11.5: Bilagor står under Dokument och underlag, och Dokument och underlag saknas utan spegel.
  dokument: { varde: () => [A.dok!, 'Spegeln i valvet'], tomt: () => [A.tom!, spegeltext(A.tom!)] },
  mail: { varde: () => [A.mail!, 'mail · <code>k-mail-1</code> · i åtagandet'], tomt: () => [A.tom!, TEXT.mail] },
  foralder: { varde: () => [A.h!, `${A.p}</a> — K föräldern`], tomt: () => [A.tom!, TEXT.foralder] },
  delarenden: { varde: () => [A.h!, `${A.c1} — K delärende ett`], tomt: () => [A.tom!, TEXT.delarenden] },
  relationer: { varde: () => [A.h!, '<span>blockeras av</span>'], tomt: () => [A.tom!, TEXT.relationer] },
  namner: {
    varde: () => [A.h!, `<p><a href="/vy/arende/${A.n1}">${A.n1}</a></p>`],
    tomt: () => [A.tom!, TEXT.namner],
  },
  'namns-i': {
    varde: () => [A.h!, `${A.m}</a> — K nämner i kommentar · träff i kommentar</p>`],
    tomt: () => [A.tom!, namnsIInga(A.tom!)],
  },
  dubbletter: { varde: null, tomt: () => [A.h!, TEXT.dubbletter] },
  kommentarer: { varde: () => [A.h!, 'själv.'], tomt: () => [A.tom!, TEXT.kommentarer] },
  historik: { varde: () => [A.h!, 'skapade ärendet'], tomt: () => [A.utan!, TEXT.historik] },
};
/** Fälten som bara har läget finns inte i plattformen. */
const LUCKOR: string[] = ['dubbletter', 'uppdrag'];

const sidor = new Map<string, string>();

/** Ärendesidan som text, med status 200. Cachad per ärende och kaka: fixturen ändras inte efter beforeAll. */
async function sida(identifier: string, kaka?: string): Promise<string> {
  const nyckel = `${identifier} ${kaka ?? ''}`;
  const cachad = sidor.get(nyckel);
  if (cachad !== undefined) return cachad;
  const begaran = request(app).get(`/vy/arende/${identifier}`);
  const svar = await (kaka === undefined ? begaran : begaran.set('Cookie', kaka));
  expect(svar.status, `/vy/arende/${identifier}`).toBe(200);
  sidor.set(nyckel, svar.text);
  return svar.text;
}

/** Fältets avsnitt, från ankaret till och med nästa </section>. Fäller fallet när ankaret inte står exakt en gång. */
function falt(html: string, id: string): string {
  const ankare = `<section id="falt-${id}">`;
  expect(html.split(ankare).length - 1, `ankaret falt-${id}`).toBe(1);
  const start = html.indexOf(ankare);
  const slut = html.indexOf('</section>', start);
  expect(slut, `avsnittet falt-${id} stängs inte`).toBeGreaterThan(-1);
  return html.slice(start, slut + '</section>'.length);
}

/** Lägestexten när avsnittet slutar med en notis (ett tomt läge), annars null (ett värde). */
function lagestext(avsnitt: string): string | null {
  return /<p class=notis>([^<]*)<\/p><\/section>$/.exec(avsnitt)?.[1] ?? null;
}

beforeAll(async () => {
  // CRM-konfigurationen som i test/crm.test.ts rad 57–74, med eget bolag och egen token.
  await rm(TEST_CRM_KONF, { force: true });
  await writeFile(
    TEST_CRM_KONF,
    JSON.stringify({
      mcpServers: {
        redovisning: {
          env: {
            REDOVISNING_API_URL: STANGD_PORT,
            REDOVISNING_COMPANY_ID: TESTBOLAG,
            REDOVISNING_AGENT_TOKEN: TESTTOKEN,
          },
        },
      },
    }),
    'utf8',
  );
  nollstallCrmCache();

  app = createApp();
  // Teamet LOC och LOC-88, LOC-316 och LOC-329 skapas av importen; ingen seedaTeam().
  await importeraArkiv(FIXTURER);
  hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
  david = await nyNyckel({ typ: 'manniska', namn: 'david' });

  await withTransaction(async (client) => {
    for (const namn of ['K-oavgjort', 'K-kopplat', 'K-internt', FULT_PROJEKT]) {
      await hamtaEllerSkapaProjekt(client, TENANT_ID, namn);
    }
    await sattKundkoppling(client, TENANT_ID, 'K-kopplat', { status: 'kopplad', kund_id: TESTKUND });
    await sattKundkoppling(client, TENANT_ID, 'K-internt', { status: 'intern' });
  });

  // LOC-329 säger i sin beskrivning att nästa ärende blir LOC-330, så det första skapade ärendet har
  // LOC-329 under Nämns i. Det används därför inte där Nämns i ska vara tomt.
  A.forsta = await nytt('K första ärendet');
  A.tom = await nytt('K tomt ärende');
  A.n1 = await nytt('K nämnt ärende');
  A.p = await nytt('K föräldern');

  // Huvudärendet: allt utom kundkopplingen har ett värde.
  A.h = await nytt('K huvudärendet', {
    description: `Hänger ihop med ${A.n1}.`,
    projekt: 'K-oavgjort',
    due: DEADLINE,
    priority: 2,
    labels: ['K-etikett'],
  });
  await foralder(A.h, A.p);
  await atagande(A.h);
  const revision = (await steg(hermes, 'get_atagande', { identifier: A.h })).revision as number;
  await steg(david, 'ta_over_atagande', {
    identifier: A.h,
    nasta: INTERNT,
    foljs_upp: SENARE_UPPFOLJNING,
    forvantad_revision: revision,
  });
  await steg(hermes, 'add_comment', { identifier: A.h, body: `Se ${A.h} själv.` });
  await steg(hermes, 'add_attachment', { identifier: A.h, titel: 'K bilaga', url: 'https://example.com/k-bilaga' });
  I.i1 = await insats('arendekort-i1', A.h, { tillhor: 'agare', frist: FRIST_I1 });
  I.i2 = await insats('arendekort-i2', A.h, { tillhor: 'anvandare', frist: FRIST_I2 });
  await steg(david, 'skjut_upp_insats', { id: I.i2, till: VACKNING_I2, skal: 'Väntar på svaret' });
  I.i3 = await insats('arendekort-i3', A.h, { tillhor: 'agare', frist: FRIST_I3 });
  await steg(hermes, 'aterkalla_insats', { id: I.i3, skal: 'Inte längre aktuell' });

  A.c1 = await nytt('K delärende ett');
  A.c2 = await nytt('K delärende två');
  await foralder(A.c1, A.h);
  await foralder(A.c2, A.h);
  await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: A.h, delarende: A.c1 });
  await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: A.h, delarende: A.c2 });
  await steg(hermes, 'ta_bort_nodvandigt_delresultat', {
    identifier: A.h,
    delarende: A.c2,
    skal: 'Delresultatet behövs inte för huvudåtagandet',
  });

  A.r1 = await nytt('K motpart ett');
  A.r2 = await nytt('K motpart två');
  A.r3 = await nytt('K motpart tre');
  await steg(hermes, 'link_issues', { fran: A.h, till: A.r1, typ: 'related' });
  await steg(hermes, 'link_issues', { fran: A.h, till: A.r2, typ: 'blocks' });
  await steg(hermes, 'link_issues', { fran: A.r3, till: A.h, typ: 'blocks' });

  A.m = await nytt('K nämner i kommentar');
  await steg(hermes, 'add_comment', { identifier: A.m, body: `Påverkar ${A.h}.` });
  A.d = await nytt('K borttagen nämnare');
  const borttagen = await steg(hermes, 'add_comment', { identifier: A.d, body: `Gammalt om ${A.h}.` });
  await steg(hermes, 'delete_comment', { kommentar_id: borttagen.id });
  A.b = await nytt('K nämner i beskrivningen', { description: `Bygger på ${A.h}.` });

  // Läget, ett fält i taget.
  A.deadline = await nytt('K bara deadline', { due: DEADLINE });
  A.uppfoljning = await nytt('K deadline och uppföljning', { due: DEADLINE });
  await atagande(A.uppfoljning);
  A.insats = await nytt('K bara en öppen insats');
  await insats('arendekort-insats', A.insats, { tillhor: 'anvandare' });
  // Kön ordnar på prioritet bland oplockade ärenden utan åtagande; inget annat ärende har prioritet 1.
  A.claim = await nytt('K plockat ur kön', { priority: 1 });
  expect((await steg(hermes, 'claim_next_issue', {})).identifier).toBe(A.claim);

  A.k_kopplat = await nytt('K i kopplat projekt', { projekt: 'K-kopplat' });
  A.k_internt = await nytt('K i internt projekt', { projekt: 'K-internt' });
  A.k_oavgjort = await nytt('K i oavgjort projekt', { projekt: 'K-oavgjort' });

  // Ärenden utan skapanderad, i provets egen transaktion: tjänsterna skriver ingen händelserad själva.
  await withTransaction(async (client) => {
    const team = await kravTeam(client, TENANT_ID, 'LOC');
    const backlog = await stateAvTyp(client, team.id, 'backlog');
    A.extern = (
      await importeraArende(client, TENANT_ID, {
        team_id: team.id,
        team_key: 'LOC',
        sequence_number: 9001,
        source_ref: 'k:extern-1',
        state_id: backlog.id,
        project_id: null,
        title: 'K externt ärende',
        description: '',
        labels: [],
        skapad: null,
        uppdaterad: null,
      })
    ).identifier;
    A.utan = (await skapaArende(client, TENANT_ID, { title: 'K utan skapanderad', team_key: 'LOC' })).identifier;
  });

  // AK 7: ett tunt och ett tjockt ärende, inget av dem med projekt, åtagande eller insats.
  A.tunt = await nytt('K tunt ärende');
  A.tjockt = await nytt('K tjockt ärende');
  for (let n = 1; n <= 30; n++) await steg(hermes, 'add_comment', { identifier: A.tjockt, body: `Kommentar ${n}` });
  for (let n = 1; n <= 21; n++) await foralder(await nytt(`K tjockt delärende ${n}`), A.tjockt);
  for (let n = 1; n <= 10; n++) {
    await steg(hermes, 'link_issues', { fran: A.tjockt, till: await nytt(`K tjock motpart ${n}`), typ: 'related' });
  }

  // AK 6: det fulla kortet, där varje fält utom de två luckorna har ett värde.
  A.full = await nytt('K fullt ärende', {
    description: `Bygger vidare på ${A.n1}.`,
    due: '2026-12-15',
    projekt: 'K-internt',
  });
  await atagande(A.full);
  await foralder(A.full, A.p);
  await foralder(await nytt('K fullt delärende'), A.full);
  await steg(hermes, 'link_issues', { fran: A.full, till: await nytt('K full motpart'), typ: 'related' });
  await steg(hermes, 'add_attachment', { identifier: A.full, titel: 'K full bilaga', url: 'https://example.com/k-full' });
  await steg(hermes, 'add_comment', { identifier: A.full, body: 'En kommentar på det fulla ärendet.' });
  A.fullnamnare = await nytt('K nämner det fulla ärendet');
  await steg(hermes, 'add_comment', { identifier: A.fullnamnare, body: `Se ${A.full}.` });

  // AK 8: tecknen i titel, förälder, delärende, motpart, nämnare, projekt och etikett.
  A.fultforalder = await nytt(FULT_FORALDER);
  A.fult = await nytt(FULT_TITEL, { projekt: FULT_PROJEKT, labels: [FULT_ETIKETT] });
  await foralder(A.fult, A.fultforalder);
  await foralder(await nytt(FULT_DEL), A.fult);
  await steg(hermes, 'link_issues', { fran: A.fult, till: await nytt(FULT_MOTPART), typ: 'related' });
  A.fultnamnare = await nytt(FULT_NAMNARE);
  await steg(hermes, 'add_comment', { identifier: A.fultnamnare, body: `Nämner ${A.fult}.` });

  // Review-fynd 1 (Story 5.5): märkningen hör till paret och står kvar när delärendet flyttas
  // (migration 0018). A.mh har ett märkt delärende kvar och ett märkt som flyttats till en annan
  // förälder; A.mh0 har haft ett enda märkt delärende, märkt av en människa och sedan lyft till toppen.
  A.mny = await nytt('K ny förälder');
  A.mh = await nytt('K märkt och flyttat');
  await atagande(A.mh);
  A.mc1 = await nytt('K märkt och kvar');
  A.mc2 = await nytt('K märkt och flyttat delärende');
  for (const del of [A.mc1, A.mc2]) {
    await foralder(del, A.mh);
    await steg(hermes, 'marka_nodvandigt_delresultat', { identifier: A.mh, delarende: del });
  }
  await foralder(A.mc2, A.mny);
  A.mh0 = await nytt('K alla märkta flyttade');
  await atagande(A.mh0);
  A.mc3 = await nytt('K märkt och lyft');
  await foralder(A.mc3, A.mh0);
  await steg(david, 'marka_nodvandigt_delresultat', { identifier: A.mh0, delarende: A.mc3 });
  await steg(hermes, 'update_issue', { identifier: A.mc3, parent: null });

  // Review-fynd 4: ett ärende som nämns i vart och ett av skrivsätten, ett ärende per skrivsätt med
  // omnämnandet där skrivsättet anger, och ett ärende som bara nämns inne i en adress.
  A.formmal = await nytt('K mål för skrivsätten');
  for (const [i, skrivsatt] of SKRIVSATTEN.entries()) {
    const text = skrivsatt.text(A.formmal);
    if (skrivsatt.i === 'titel') {
      A[`form${i}`] = await nytt(text);
    } else if (skrivsatt.i === 'beskrivning') {
      A[`form${i}`] = await nytt(`K skrivsätt ${skrivsatt.namn}`, { description: text });
    } else {
      A[`form${i}`] = await nytt(`K skrivsätt ${skrivsatt.namn}`);
      await steg(hermes, 'add_comment', { identifier: A[`form${i}`], body: text });
    }
  }
  A.formtom = await nytt('K nämnt bara i en adress');
  A.formadress = await nytt('K nämner i en adress');
  const adress = SKRIVSATTEN.find((s) => s.namn === 'Linear-adress')!;
  await steg(hermes, 'add_comment', { identifier: A.formadress, body: adress.text(A.formtom) });

  // Story 11.5, Uppgift 1: läsmodellens nya delar. Varje insats har ett eget stopp och varje källa ett eget
  // objekt-id, eftersom källan är unik i tenanten. Besluten har nummer som inget annat fall använder:
  // koppla_beslut lämnar ett beslut som redan är kopplat där det var, utan fel.
  A.p1 = await nytt('K ett av varje');
  await steg(hermes, 'registrera_atagande', {
    identifier: A.p1,
    grund: [GRUND],
    nasta: INTERNT,
    foljs_upp: UPPFOLJNING,
    villkor: villkoren(1),
  });
  await steg(hermes, 'koppla_beslut', { beslut_id: 5101, identifier: A.p1 });
  await insats('k-p1-1', A.p1, {});
  A.p10 = await nytt('K tio av varje');
  await steg(hermes, 'registrera_atagande', {
    identifier: A.p10,
    grund: [GRUND],
    nasta: INTERNT,
    foljs_upp: UPPFOLJNING,
    villkor: villkoren(10),
  });
  for (let n = 0; n < 5; n++) await steg(hermes, 'koppla_beslut', { beslut_id: 5102 + n, identifier: A.p10 });
  for (let n = 1; n <= 10; n++) await insats(`k-p10-${n}`, A.p10, {});
  // #54 och #60 kopplade, två svarsversioner för #54 (registrerade utan ärende, så de nås genom kopplingen)
  // och en för #61, som registreras på ärendet utan att #61 kopplas dit.
  A.beslut = await nytt('K beslut och svar');
  await atagande(A.beslut);
  await steg(hermes, 'koppla_beslut', { beslut_id: 54, identifier: A.beslut });
  await steg(hermes, 'koppla_beslut', { beslut_id: 60, identifier: A.beslut });
  await steg(hermes, 'registrera_svarsversion', { beslut_id: 54, svar_hash: HASH_54_V1, version: 1 });
  await steg(hermes, 'registrera_svarsversion', { beslut_id: 54, svar_hash: HASH_54 });
  await steg(hermes, 'registrera_svarsversion', { beslut_id: 61, svar_hash: HASH_61, identifier: A.beslut });

  // Story 11.5, Uppgift 3: åtagandets lägen (A.h är det övertagna), insatsernas fyra lägen, det fulla kortet
  // och de fula tecknen. Varje ändring av ett åtagande skickar revisionen ur get_atagande just före, och ett
  // oavslutat åtagande har alltid nästa steg och uppföljning.
  const revisionen = async (identifier: string): Promise<number> =>
    (await steg(hermes, 'get_atagande', { identifier })).revision as number;
  // En grund länkar till ett befintligt ärende och en till ett nummer som inte finns. Referenserna står inte
  // i sökindexet, så A.n1:s Nämns i ändras inte.
  A.ag_reg = await nytt('K registrerat åtagande');
  await steg(hermes, 'registrera_atagande', {
    identifier: A.ag_reg,
    grund: [
      { typ: 'arende', id: A.n1 },
      { typ: 'arende', id: 'LOC-99998' },
    ],
    nasta: INTERNT,
    foljs_upp: UPPFOLJNING,
    utfall_precisering: 'K preciseringen av utfallet',
    villkor: [
      {
        text: 'K villkoret som är okänt',
        kalla: { typ: 'beslut', id: '9301' },
        galler: 'K gäller hela året',
        kontroll: 'K kontrolleras i december',
        utfall: 'okant',
      },
      {
        text: 'K villkoret som är uppfyllt',
        kalla: { typ: 'beslut', id: '9302' },
        galler: 'K gäller till hösten',
        kontroll: 'K kontrolleras i augusti',
        utfall: 'uppfyllt',
        belagg: { typ: 'prov', id: 'k-villkor-belagg' },
      },
    ],
  });
  A.ag_hind = await nytt('K hindrat åtagande');
  await atagande(A.ag_hind);
  await steg(hermes, 'hindra_atagande', {
    identifier: A.ag_hind,
    orsak: 'K orsaken till hindret',
    belagg: { typ: 'beslut', id: '9303' },
    nasta: INTERNT,
    foljs_upp: UPPFOLJNING,
    forvantad_revision: await revisionen(A.ag_hind),
  });
  // Registrerat → genomfört är ingen tillåten övergång, så övertagandet kommer först.
  A.ag_genom = await nytt('K genomfört åtagande');
  await atagande(A.ag_genom);
  await steg(david, 'ta_over_atagande', {
    identifier: A.ag_genom,
    nasta: INTERNT,
    foljs_upp: UPPFOLJNING,
    forvantad_revision: await revisionen(A.ag_genom),
  });
  await steg(hermes, 'redovisa_resultat', {
    identifier: A.ag_genom,
    sammanfattning: 'K sammanfattningen av resultatet',
    belagg: [
      { typ: 'prov', id: 'k-resultat-prov' },
      { typ: 'commit', id: 'k-resultat-commit' },
    ],
    forvantad_revision: await revisionen(A.ag_genom),
  });
  A.ag_avsl = await nytt('K avslutat åtagande');
  await atagande(A.ag_avsl);
  await steg(hermes, 'avsluta_atagande', {
    identifier: A.ag_avsl,
    text: 'K skälet till avslutet',
    grund: { typ: 'beslut', id: '9304' },
    forvantad_revision: await revisionen(A.ag_avsl),
  });

  // Fyra insatser: J1 väntande med frist, belägg och källornas fem former (utan länk, en https-adress, en
  // Linear-adress med numret A.n1, en javascript:-adress och objekttypen mail); J2 besvarad av en
  // människa; J3 uppskjuten av en människa; J4 återkallad.
  A.ins = await nytt('K fyra insatser');
  I.j1 = await insats('k-ins-j1', A.ins, {
    frist: FRIST_J1,
    belagg: [{ typ: 'beslut', id: '9401' }],
    kallor: [
      { system: 'arenden', objekttyp: 'atagande', objekt_id: 'k-ins-k1' },
      { system: 'arenden', objekttyp: 'atagande', objekt_id: 'k-ins-k2', lank: 'https://example.com/k-kalla' },
      {
        system: 'arenden',
        objekttyp: 'atagande',
        objekt_id: 'k-ins-k3',
        lank: `https://linear.app/locollabs/issue/${A.n1}/k-kalla`,
      },
      { system: 'arenden', objekttyp: 'atagande', objekt_id: 'k-ins-k4', lank: 'javascript:alert(1)' },
      { system: 'redovisning', objekttyp: 'mail', objekt_id: 'k-ins-k5', lank: 'https://example.com/k-mail' },
    ],
  });
  I.j2 = await insats('k-ins-j2', A.ins, {});
  await steg(david, 'besvara_insats', { id: I.j2, svar: SVARET });
  I.j3 = await insats('k-ins-j3', A.ins, {});
  await steg(david, 'skjut_upp_insats', { id: I.j3, till: VACKNING_J3, skal: 'K väntar på underlaget' });
  I.j4 = await insats('k-ins-j4', A.ins, {});
  await steg(hermes, 'aterkalla_insats', { id: I.j4, skal: 'K inte längre aktuell' });

  // Story 11.4 AK 6: det fulla kortet får ett eget beslut och en insats, så att Beslut och Insatser har värden.
  await steg(hermes, 'koppla_beslut', { beslut_id: 5107, identifier: A.full });
  await insats('k-full', A.full, {});

  // AK 9: tecknen <script>, " och & i nästa steg, i ett villkor, i en insats utfall och i en källas objekt-id.
  A.fultkort = await nytt('K fult kort');
  await steg(hermes, 'registrera_atagande', {
    identifier: A.fultkort,
    grund: [GRUND],
    nasta: { ...INTERNT, handling: FULT },
    foljs_upp: UPPFOLJNING,
    villkor: [{ text: FULT, kalla: GRUND, galler: 'K gäller', kontroll: 'K kontroll', utfall: 'okant' }],
  });
  await insats('k-fult', A.fultkort, {
    utfall: FULT,
    kallor: [{ system: 'arenden', objekttyp: 'atagande', objekt_id: FULT }],
  });

  // Story 11.5, Uppgift 4: dokumenten, R5 på kortet och mailen. Beskrivningen nämner avtalet som wikilänk,
  // planen som sökväg och kunddokumentets originalnamn; kommentaren nämner avtalet igen med full sökväg.
  // Planen ligger under 02-Områden/ledningsgrupp: ingen text i tilläggen innehåller ett aktörsnamn ur
  // fixturen, och en sökväg under 02-Områden/hermes hade gjort det (K16).
  A.dok = await nytt('K dokument och underlag', {
    description:
      'Avtalet: [[01-Projekt/k-kort/avtal]]. Planen: 02-Områden/ledningsgrupp/k-kort-plan.md. ' +
      'Kundens original: K_avtal.docx.',
  });
  await steg(hermes, 'add_comment', { identifier: A.dok, body: 'Avtalet igen: 01-Projekt/k-kort/avtal.md.' });
  await steg(hermes, 'add_attachment', { identifier: A.dok, titel: 'K dokumentbilaga ett', url: 'https://example.com/k-dok-1' });
  await steg(hermes, 'add_attachment', { identifier: A.dok, titel: 'K dokumentbilaga två', url: 'https://example.com/k-dok-2' });
  A.dok2 = await nytt('K dokument utan spegel', { description: 'Samma avtal: [[01-Projekt/k-kort/avtal]].' });

  // De sex privata sökvägarna (PRIVATA_FALL) i en kommentar, i åtagandets grund, i tolv insatskällor (https-
  // formen med /fil/ och obsidian-formen) och i sex bilagor. Ingen av dem är mail. Granskningsfynd 2 och 3:
  // därtill bärarna i PRIVATA_TRASIGA, tre i grunden, tre källor och två bilagor, i former som URL-tolken
  // eller en läsare läser som en privat sökväg fast texten inte är den.
  const privata = Object.values(PRIVATA_FALL);
  A.privat = await nytt('K privata källor');
  await steg(hermes, 'add_comment', { identifier: A.privat, body: `Privata sökvägar: ${privata.join(', ')}.` });
  await steg(hermes, 'registrera_atagande', {
    identifier: A.privat,
    grund: [...privata.map((rel) => ({ typ: 'dokument', id: rel })), ...PRIVATA_TRASIGA.grund],
    nasta: INTERNT,
    foljs_upp: UPPFOLJNING,
  });
  await insats('k-privat', A.privat, {
    kallor: [
      ...privata.flatMap((rel, i) => [
        { system: 'valv', objekttyp: 'fil', objekt_id: `k-privat-${2 * i + 1}`, lank: `https://example.com/fil/${ledvis(rel)}` },
        { system: 'valv', objekttyp: 'fil', objekt_id: `k-privat-${2 * i + 2}`, lank: obsidianform(rel) },
      ]),
      ...PRIVATA_TRASIGA.lankar.map((lank, i) => ({
        system: 'valv',
        objekttyp: 'fil',
        objekt_id: `k-privat-${2 * privata.length + i + 1}`,
        lank,
      })),
    ],
  });
  for (const [i, url] of [...privata.map((rel) => `https://example.com/fil/${ledvis(rel)}`), ...PRIVATA_TRASIGA.bilagor].entries()) {
    await steg(hermes, 'add_attachment', { identifier: A.privat, titel: `K privat bilaga ${i + 1}`, url });
  }

  // Mail: en mailreferens i åtagandets grund och en mailkälla på en insats.
  A.mail = await nytt('K mailreferenser');
  await steg(hermes, 'registrera_atagande', {
    identifier: A.mail,
    grund: [{ typ: 'mail', id: 'k-mail-1' }],
    nasta: INTERNT,
    foljs_upp: UPPFOLJNING,
  });
  await insats('k-mail', A.mail, { kallor: [{ system: 'redovisning', objekttyp: 'mail', objekt_id: 'k-mail-2' }] });

  // Story 11.4 AK 6: det fulla kortet får en mailkälla, så att Mail har ett värde (spegeln skrivs nedan).
  await insats('k-full-mail', A.full, {
    kallor: [{ system: 'redovisning', objekttyp: 'mail', objekt_id: 'k-full-mail' }],
  });

  // Testvalvet, aldrig den riktiga vaulten: dokumenten och speglarna för A.dok och A.full. Ingen sida har
  // hämtats än, så dokumentindexet byggs ur det här valvet vid första sidan.
  await rm(TEST_VAULT, { recursive: true, force: true });
  for (const rel of [
    '01-Projekt/k-kort/avtal.md',
    '02-Områden/ledningsgrupp/k-kort-plan.md',
    '03-Resurser/kunddokument/K Kund/K_avtal.md',
    `02-Områden/linear-arkiv/${A.dok}.md`,
    `02-Områden/linear-arkiv/${A.full}.md`,
  ]) {
    const abs = path.join(TEST_VAULT, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, '# K testvalvets dokument\n', 'utf8');
  }
  dokumentet.nollstallIndex();
});

describe('D-3/Story 11.4 AK 7: läsmodellen ställer ett fast antal frågor', () => {
  it('K1 (AK 7): hamtaArendekort() ställer lika många frågor för ett tunt och ett tjockt ärende, en till med projekt', async () => {
    const fore = await raknaRader('events');
    const obs: { fall: string; fragor: number; kandidatanrop: number }[] = [];
    let tjockt: Awaited<ReturnType<typeof hamtaArendekort>> | null = null;
    let ensamt = 0;
    await withTransaction(async (client) => {
      for (const [fall, identifier] of [['tunt', A.tunt!], ['tjockt', A.tjockt!], ['projekt', A.k_oavgjort!]]) {
        const raknare = raknandeKlient(client);
        let kandidatanrop = 0;
        const kort = await hamtaArendekort(raknare.klient, TENANT_ID, identifier!, () => {
          kandidatanrop += 1;
          return [];
        });
        if (fall === 'tjockt') tjockt = kort;
        obs.push({ fall: fall!, fragor: raknare.antal(), kandidatanrop });
      }
      // Kontroll: den räknande klienten ger exakt en fråga för ett ensamt hamtaArende().
      const raknare = raknandeKlient(client);
      await hamtaArende(raknare.klient, TENANT_ID, A.tunt!);
      ensamt = raknare.antal();
    });
    expect(ensamt).toBe(1);
    const [tunt, tjock, projekt] = obs;
    expect(obs.map((o) => o.kandidatanrop)).toEqual([1, 1, 1]);
    expect(tjock!.fragor).toBe(tunt!.fragor);
    expect(projekt!.fragor).toBe(tunt!.fragor + 1);
    expect(tjockt).not.toBeNull();
    const k = tjockt!;
    expect([k.kommentarer.length, k.barn.length, k.relationer.length]).toEqual([30, 21, 10]);
    expect(await raknaRader('events')).toBe(fore);
  });
});

describe('D-3/Story 11.4 AK 2–5 och 7: kortets data', () => {
  it('K2 (AK 2–5 och 7): huvudärendets åtagande, öppna insatser, märkningar, koppling och omnämnanden', async () => {
    const fore = await raknaRader('events');
    const texter: { identifier: string; kommentarer: number; bilagor: number }[] = [];
    const [h, tom] = await withTransaction(async (client) => {
      const kort = [];
      for (const identifier of [A.h!, A.tom!]) {
        kort.push(
          await hamtaArendekort(client, TENANT_ID, identifier, (t) => {
            texter.push({ identifier: t.arende.identifier, kommentarer: t.kommentarer.length, bilagor: t.bilagor.length });
            // Kandidaterna ur sidans egen rendering, som i ärenderutten (Story 11.2).
            return arendekandidater((uppslag) => {
              renderaArendetext(t.arende.description, INDEX, uppslag);
              for (const k of t.kommentarer) renderaArendetext(k.body, INDEX, uppslag);
            });
          }),
        );
      }
      return kort;
    });
    // kandidater får ärendet, de synliga kommentarerna och bilagorna, en gång per anrop.
    expect(texter).toEqual([
      { identifier: A.h, kommentarer: 1, bilagor: 1 },
      { identifier: A.tom, kommentarer: 0, bilagor: 0 },
    ]);

    const c1 = h!.barn.find((b) => b.identifier === A.c1);
    expect(c1).toBeDefined();
    expect({
      lage: h!.atagande?.lage,
      tillhor: h!.atagande?.tillhor,
      utforare: [h!.atagande?.utforare_typ, h!.atagande?.utforare_namn],
      overtaget: h!.atagande?.overtaget_nar instanceof Date,
      foljsUpp: h!.atagande?.foljs_upp instanceof Date,
      insatser: h!.oppnaInsatser.map((i) => [i.id, i.lage, i.tillhor]),
      vackning: h!.oppnaInsatser.map((i) => i.vackningstid instanceof Date),
      markningar: h!.markningar.map((m) => [m.del_issue_id, m.markt_av_typ, m.markt_av_namn]),
      koppling: h!.kundkoppling?.koppling_status,
      namnsI: [...new Set(h!.namnsI.map((t) => t.identifier))].sort(),
      kapat: h!.namnsIKapat,
      n1Finns: h!.befintliga.arenden.has(A.n1!),
    }).toEqual({
      lage: 'overtaget',
      tillhor: 'hermes',
      utforare: ['manniska', 'david'],
      overtaget: true,
      foljsUpp: true,
      insatser: [[I.i1, 'vantande', 'agare'], [I.i2, 'uppskjuten', 'anvandare']],
      vackning: [false, true],
      markningar: [[c1!.id, 'agent', 'hermes']],
      koppling: 'oavgjord',
      namnsI: [A.m!, A.b!].sort(),
      kapat: false,
      n1Finns: true,
    });
    // Ärendet självt och den borttagna kommentaren räknas aldrig under Nämns i.
    expect(h!.namnsI.map((t) => t.identifier)).not.toContain(A.h);
    expect(h!.namnsI.map((t) => t.identifier)).not.toContain(A.d);

    expect({
      atagande: tom!.atagande,
      insatser: tom!.oppnaInsatser,
      markningar: tom!.markningar,
      namnsI: tom!.namnsI,
      koppling: tom!.kundkoppling,
    }).toEqual({ atagande: null, insatser: [], markningar: [], namnsI: [], koppling: null });
    expect(await raknaRader('events')).toBe(fore);
  });
});

describe('D-3/Story 11.4 AK 1: den slutna listan och de fem lägena', () => {
  it('K3 (AK 1): fem lägen, konstruktörer som kastar för en tom text och en rendering per läge', () => {
    expect([...LAGEN]).toEqual(['varde', 'inga', 'saknas', 'finns_inte', 'kunde_inte']);
    expect(() => varde('')).toThrow();
    expect(() => varde('  ')).toThrow();
    expect(() => tomt('inga', '')).toThrow();
    expect(() => tomt('saknas', 'x', '')).toThrow();
    // Kontroll: med innehåll kastar konstruktörerna inte, så de fyra fallen ovan mäter tomheten.
    expect(() => varde('<p>x</p>')).not.toThrow();
    expect(() => tomt('saknas', 'x', '<p>y</p>')).not.toThrow();

    const beskrivning = KORTFALT.find((f) => f.id === 'beskrivning')!;
    // Story 11.5: Bilagor står inte längre i KORTFALT; Kommentarer är ett räknat fält med h2 som förut.
    const kommentarer = KORTFALT.find((f) => f.id === 'kommentarer')!;
    expect(renderaFalt(beskrivning, varde('<p>värdet</p>'), 0)).toBe(
      '<section id="falt-beskrivning"><h2>Beskrivning</h2><p>värdet</p></section>',
    );
    for (const lage of ['inga', 'saknas', 'finns_inte', 'kunde_inte'] as const) {
      expect(renderaFalt(kommentarer, tomt(lage, 'a < b & "c"'), 3), lage).toBe(
        '<section id="falt-kommentarer"><h2>Kommentarer (3)</h2><p class=notis>a &lt; b &amp; &quot;c&quot;</p></section>',
      );
    }
    // Det som ändå lästes står före notisen.
    expect(renderaFalt(beskrivning, tomt('kunde_inte', 'Texten.', '<p>det som lästes</p>'), 0)).toBe(
      '<section id="falt-beskrivning"><h2>Beskrivning</h2><p>det som lästes</p><p class=notis>Texten.</p></section>',
    );
  });

  it('K4 (AK 1): varje fält i KORTFALT har ett värdefall och ett tomt fall, och ankarna står i listans ordning', async () => {
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet, före och efter koden.
    const h = await sida(A.h!);
    expect(h).toContain(`<h1>${A.h} — K huvudärendet</h1>`);

    expect(Object.keys(FALLEN).sort()).toEqual(KORTFALT.map((f) => f.id).sort());
    expect(Object.entries(FALLEN).filter(([, f]) => f.varde === null).map(([id]) => id).sort()).toEqual(LUCKOR);
    const fynd: string[] = [];
    for (const [id, fall] of Object.entries(FALLEN)) {
      if (fall.varde !== null) {
        const [identifier, delstrang] = fall.varde();
        const avsnitt = falt(await sida(identifier), id);
        if (!avsnitt.includes(delstrang)) fynd.push(`${id}: värdet saknar ${delstrang}`);
        if (lagestext(avsnitt) !== null) fynd.push(`${id}: värdefallet slutar med en notis`);
      }
      const [identifier, text] = fall.tomt();
      const notis = lagestext(falt(await sida(identifier), id));
      if (notis !== text) fynd.push(`${id}: det tomma fallet ger ${String(notis)}`);
    }
    expect(fynd).toEqual([]);

    // Varje ankare exakt en gång (falt() fäller annars) och i KORTFALT:s ordning.
    const platser = KORTFALT.map((f) => {
      falt(h, f.id);
      return h.indexOf(`<section id="falt-${f.id}">`);
    });
    expect(platser).toEqual([...platser].sort((x, y) => x - y));
  });
});

describe('D-3/Story 11.4 AK 5 och 6: ramens fält med och utan poster', () => {
  it('K5 (AK 5 och 6): Beskrivning, Bilagor, Förälder, Delärenden och Relationer säger «inga» i stället för att saknas', async () => {
    const fore = await raknaRader('events');
    // Motkontroll först: sidorna svarar 200 med rubriken för ärendet.
    const h = await sida(A.h!);
    const tom = await sida(A.tom!);
    expect(h).toContain(`<h1>${A.h} — K huvudärendet</h1>`);
    expect(tom).toContain(`<h1>${A.tom} — K tomt ärende</h1>`);

    expect(falt(h, 'beskrivning')).toContain('<h2>Beskrivning</h2><div class=text>');
    expect(falt(h, 'beskrivning')).toContain('Hänger ihop med');
    // Story 11.5: bilagorna står under Dokument och underlag, med rubriken som h3.
    expect(falt(h, 'dokument')).toContain('<h3>Bilagor (1)</h3><ul class=lista role=list>');
    expect(falt(h, 'dokument')).toContain('K bilaga');
    expect(falt(h, 'foralder')).toContain(`<p><a href="/vy/arende/${A.p}">${A.p}</a> — K föräldern</p>`);
    const delarenden = falt(h, 'delarenden');
    expect(delarenden).toContain('<h3>Delärenden (2)</h3>');
    expect(delarenden.split('<a class=kort ').length - 1).toBe(2);
    expect(delarenden).toContain(`${A.c1} — K delärende ett`);
    expect(delarenden).toContain(`${A.c2} — K delärende två`);
    const relationer = falt(h, 'relationer');
    expect(relationer).toContain('<h3>Relationer (3)</h3>');
    for (const [typ, motpart] of [['relaterat till', A.r1], ['blockerar', A.r2], ['blockeras av', A.r3]]) {
      expect(relationer).toContain(`<span>${typ}</span><a href="/vy/arende/${motpart}">${motpart}</a>`);
    }

    expect({
      beskrivning: lagestext(falt(tom, 'beskrivning')),
      foralder: lagestext(falt(tom, 'foralder')),
      delarenden: lagestext(falt(tom, 'delarenden')),
      relationer: lagestext(falt(tom, 'relationer')),
    }).toEqual({
      beskrivning: TEXT.beskrivning,
      foralder: TEXT.foralder,
      delarenden: TEXT.delarenden,
      relationer: TEXT.relationer,
    });
    // Bilagornas mening står under Dokument och underlag, före fältets egen lägestext.
    expect(falt(tom, 'dokument')).toContain(`<h3>Bilagor (0)</h3><p>${TEXT.bilagor}</p>`);
    expect(tom).toContain('<h3>Bilagor (0)</h3>');
    expect(tom).toContain('<h3>Delärenden (0)</h3>');
    expect(tom).toContain('<h3>Relationer (0)</h3>');
    expect(tom).not.toContain('Ingen beskrivning.');

    const utan = await sida(A.utan!);
    expect(utan).toContain('<h2>Historik (0)</h2>');
    expect(lagestext(falt(utan, 'historik'))).toBe(TEXT.historik);
    expect(await raknaRader('events')).toBe(fore);
  });
});

/** De sju tjänstefunktioner som ärenderutten anropade före Story 11.4. */
const GAMLA_ANROP = [
  'hamtaArende(',
  'listaKommentarer(',
  'listaHandelser(',
  'barnFor(',
  'relationerFor(',
  'bilagorFor(',
  'listaBorttagnaKommentarer(',
];

/** Fynden i ruttens text: hamtaArendekort( exakt en gång och inget av de sju gamla anropen. */
function ruttfel(text: string): string[] {
  const fel: string[] = [];
  const antal = text.split('hamtaArendekort(').length - 1;
  if (antal !== 1) fel.push(`hamtaArendekort( står ${antal} gånger`);
  for (const anrop of GAMLA_ANROP) if (text.includes(anrop)) fel.push(`anropar ${anrop}`);
  return fel;
}

/** D18:s former i test/djuplank.test.ts och de hämtningar som kortets modul aldrig gör. Kommentarer räknas. */
const KORTETS_FORBUD: RegExp[] = [
  /\.query\(/,
  /\bSELECT\b/,
  /\bINSERT\s+INTO\b/,
  /\bDELETE\s+FROM\b/,
  /\bUPDATE\s+\w+\s+SET\b/,
  /^import\s+(?!type\b)[^;]*\bfrom\s+['"]pg['"]/m,
  /\bfetch\(/,
  /readFile/,
  /process\.env/,
];

describe('D-3/Story 11.4 AK 7: ärenderutten hämtar kortet genom läsmodellen', () => {
  it('K6 (AK 7): rutten anropar hamtaArendekort() och inget av de sju, kortet hämtar inget, och GET skriver inget', async () => {
    const rutt = readFileSync(path.join(ROT, 'src/http/routes/vy.ts'), 'utf8');
    const kort = readFileSync(path.join(ROT, 'src/http/vy/kort.ts'), 'utf8');
    expect(ruttfel(rutt)).toEqual([]);
    expect(KORTETS_FORBUD.filter((m) => m.test(kort)).map(String)).toEqual([]);
    // Kontroll: en påhittad ruttext som anropar listaKommentarer( fälls, och en påhittad modul med en fråga.
    expect(ruttfel('await hamtaArendekort(client); await listaKommentarer(client);')).toEqual([
      'anropar listaKommentarer(',
    ]);
    expect(KORTETS_FORBUD.filter((m) => m.test('await client.query(fraga);')).map(String)).toEqual(['/\\.query\\(/']);

    const fore = await raknaRader('events');
    for (let n = 0; n < 3; n++) expect((await request(app).get(`/vy/arende/${A.h}`)).status).toBe(200);
    expect(await raknaRader('events')).toBe(fore);
  });
});

describe('D-3/Story 11.4 AK 2: frist och ägare', () => {
  it('K7 (AK 2): Frist visar varje uppgift med sin källa, och Ägare åtagandet, utföraren, insatserna och claimad_av', async () => {
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet.
    const h = await sida(A.h!);
    expect(h).toContain(`<h1>${A.h} — K huvudärendet</h1>`);

    // Frist: inget, bara deadline, deadline och uppföljning, och insatser med frist och väckningstid.
    expect(lagestext(falt(await sida(A.tom!), 'frist'))).toBe(TEXT.frist);
    const deadline = falt(await sida(A.deadline!), 'frist');
    expect(deadline).toContain(`<p>senast ${DEADLINE}</p>`);
    expect(lagestext(deadline)).toBeNull();
    const uppfoljning = falt(await sida(A.uppfoljning!), 'frist');
    expect(uppfoljning).toContain(
      `<p>senast ${DEADLINE}</p><p>åtagandet följs upp ${datumtid(new Date(UPPFOLJNING))}</p>`,
    );
    expect(lagestext(uppfoljning)).toBeNull();
    const frist = falt(h, 'frist');
    for (const rad of [
      `<p>senast ${DEADLINE}</p>`,
      `<p>åtagandet följs upp ${datumtid(new Date(SENARE_UPPFOLJNING))}</p>`,
      `<p>insatsens frist ${datumtid(new Date(FRIST_I1))}</p>`,
      `<p>insatsens frist ${datumtid(new Date(FRIST_I2))}</p>`,
      `<p>insatsens väckningstid ${datumtid(new Date(VACKNING_I2))}</p>`,
    ]) {
      expect(frist).toContain(rad);
    }
    // Den återkallade insatsen syns inte.
    expect(frist).not.toContain(datumtid(new Date(FRIST_I3)));
    expect(lagestext(frist)).toBeNull();
    // Funktionsnivå: väckningstiden ensam för en uppskjuten insats är också ett värde.
    expect(
      fristLage({ due_date: null }, null, [{ frist: null, vackningstid: new Date(VACKNING_I2) }]),
    ).toEqual({ lage: 'varde', html: `<p>insatsens väckningstid ${datumtid(new Date(VACKNING_I2))}</p>` });

    // Ägare: inget, bara claimad_av, åtagande med utförare och en öppen insats.
    expect(lagestext(falt(await sida(A.tom!), 'agare'))).toBe(TEXT.agare);
    const claim = falt(await sida(A.claim!), 'agare');
    // Aktören som plockade ärendet bär sitt proveniensmärke (AK 8), med typen ur claimade_arende.
    expect(claim).toContain(`<p>plockat av ${proveniens('agent', 'hermes')}</p>`);
    expect(lagestext(claim)).toBeNull();
    const agare = falt(h, 'agare');
    expect(agare).toContain('<p>åtagandet tillhör Hermes</p>');
    expect(agare).toContain(`<p>utförare ${proveniens('manniska', 'david')} tog över `);
    expect(agare).toContain('<p>öppen insats (ägarbeslut) tillhör ägaren</p>');
    expect(agare).toContain('<p>öppen insats (ägarbeslut) tillhör användaren</p>');
    // I1 och I2, inte den återkallade I3.
    expect(agare.split('<p>öppen insats ').length - 1).toBe(2);
    expect(lagestext(agare)).toBeNull();
    const insats = falt(await sida(A.insats!), 'agare');
    expect(insats).toContain('<p>öppen insats (ägarbeslut) tillhör användaren</p>');
    expect(lagestext(insats)).toBeNull();
  });
});

/** Sidan utan sidhuvudet: 'CRM' står i huvudmenyn på varje sida (som utanKrom i test/crm.test.ts rad 183–186). */
function utanKrom(html: string): string {
  const i = html.indexOf('</header>');
  return i === -1 ? html : html.slice(i);
}

describe('D-3/Story 11.4 AK 3: projekt, kund och uppdrag', () => {
  it('K8 (AK 3): projektets namn, kundkopplingens fem lägen och uppdragets lucka, och CRM bara för det kopplade', async () => {
    // crmAnrop() räknar varje anrop som inte är cachat, och ett misslyckat uppslag cachas i 30 s: fallet
    // nollställer därför cachen och hämtar sina sidor själv, inte ur sida()-cachen.
    nollstallCrmCache();
    const hamta = async (identifier: string): Promise<string> => {
      const svar = await request(app).get(`/vy/arende/${identifier}`);
      expect(svar.status, identifier).toBe(200);
      return svar.text;
    };
    const internt = await hamta(A.k_internt!);
    const oavgjort = await hamta(A.k_oavgjort!);
    const tom = await hamta(A.tom!);
    const kopplat = await hamta(A.k_kopplat!);
    // Motkontroll: sidan för det kopplade projektet renderas fast CRM inte svarar.
    expect(kopplat).toContain(`<h1>${A.k_kopplat} — K i kopplat projekt</h1>`);

    // Projekt.
    expect(falt(oavgjort, 'projekt')).toContain('<p>K-oavgjort</p>');
    expect(lagestext(falt(oavgjort, 'projekt'))).toBeNull();
    expect(lagestext(falt(tom, 'projekt'))).toBe(TEXT.projekt);

    // Kund: internt, oavgjort, utan projekt och kopplat med CRM nere.
    expect(falt(internt, 'kund')).toContain(`<p>${TEXT.kundInternt}</p>`);
    expect(lagestext(falt(internt, 'kund'))).toBeNull();
    expect(lagestext(falt(oavgjort, 'kund'))).toBe(TEXT.kundOavgjord);
    expect(lagestext(falt(tom, 'kund'))).toBe(TEXT.kundUtanProjekt);
    const kund = falt(kopplat, 'kund');
    expect(kund).toMatch(new RegExp(`<p>redovisning · kund-id ${TESTKUND} · kopplad \\d{4}-\\d{2}-\\d{2}</p><p class=notis>`));
    expect(lagestext(kund)).toBe(TEXT.kundCrmNere);
    expect(kopplat).toContain('<h2>CRM</h2>');

    // CRM slås upp en gång, bara för det kopplade projektet, och nämns inte på de okopplade sidorna.
    expect(crmAnrop()).toBe(1);
    for (const [namn, html] of [['internt', internt], ['oavgjort', oavgjort], ['tom', tom]]) {
      expect(utanKrom(html!), namn).not.toContain('CRM');
    }

    // Funktionsnivå: grenen där CRM svarar, utan något HTTP-anrop.
    const koppling = await withTransaction((client) => hamtaKundkoppling(client, TENANT_ID, 'K-kopplat'));
    expect(koppling?.koppling_status).toBe('kopplad');
    const svarade = kundLage(koppling, 'svarade');
    expect(svarade.lage).toBe('varde');
    expect(svarade).toMatchObject({ html: expect.stringContaining(`kund-id ${TESTKUND}`) });
    expect(kundLage(null, 'okopplat')).toEqual({ lage: 'saknas', text: TEXT.kundUtanProjekt, delvis: null });

    // Uppdrag är en lucka med föreslagen källa.
    expect(lagestext(falt(await sida(A.h!), 'uppdrag'))).toBe(TEXT.uppdrag);
    expect(crmAnrop()).toBe(1);
  });
});

describe('D-3/Story 11.4 AK 4: ursprung', () => {
  it('K9 (AK 4): importerat, skapat och annan källa, med skaparen, och «saknas» utan skapanderad', async () => {
    const fore = await raknaRader('events');
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet.
    const arkivsidan = await sida('LOC-316');
    expect(arkivsidan).toContain('<h1>LOC-316 — ');

    const arkiv = falt(arkivsidan, 'ursprung');
    expect(arkiv).toContain('<p>importerat ur Linear-arkivet (arkivfilen LOC-316)</p>');
    expect(arkiv).toContain(`<p>importerade ärendet ${proveniens('system', 'linear-import')} `);
    expect(lagestext(arkiv)).toBeNull();

    const skapat = falt(await sida(A.tom!), 'ursprung');
    expect(skapat).toContain('<p>skapat i plattformen</p>');
    expect(skapat).toContain(`<p>skapade ärendet ${proveniens('agent', 'hermes')} `);
    expect(lagestext(skapat)).toBeNull();

    // Utan skapanderad: det som finns står kvar som delvis, och ingenting fylls i efterhand.
    const extern = falt(await sida(A.extern!), 'ursprung');
    expect(extern).toContain('<p>källa: k:extern-1</p><p class=notis>');
    expect(lagestext(extern)).toBe(TEXT.ursprung);
    const utan = falt(await sida(A.utan!), 'ursprung');
    expect(utan).toContain('<p>skapat i plattformen</p><p class=notis>');
    expect(lagestext(utan)).toBe(TEXT.ursprung);
    expect(await raknaRader('events')).toBe(fore);
  });
});

/** Fälten under «Kopplade ärenden», i KORTFALT:s ordning. */
const KOPPLADE = ['foralder', 'delarenden', 'relationer', 'namner', 'namns-i', 'dubbletter'];

describe('D-3/Story 11.4 AK 5: kopplade ärenden åt båda hållen', () => {
  it('K10 (AK 5): Nämner, Nämns i, Dubbletter och märkningen, och varje länk under Kopplade ärenden svarar 200', async () => {
    const fore = await raknaRader('events');
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet.
    const h = await sida(A.h!);
    expect(h).toContain(`<h1>${A.h} — K huvudärendet</h1>`);
    expect(h).toContain('<h2>Kopplade ärenden</h2><section id="falt-foralder">');

    // Nämner: det nämnda ärendet som finns, aldrig ärendet självt (kommentaren «Se <A.h> själv.»).
    const namner = falt(h, 'namner');
    expect(namner).toContain(`<p><a href="/vy/arende/${A.n1}">${A.n1}</a></p>`);
    expect(namner).not.toContain(`href="/vy/arende/${A.h}"`);
    expect(lagestext(namner)).toBeNull();

    // Nämns i: en synlig kommentar och en beskrivning, inte den borttagna kommentaren och inte ärendet självt.
    const namnsI = falt(h, 'namns-i');
    expect(namnsI).toContain(
      `<p><a href="/vy/arende/${A.m}">${A.m}</a> — K nämner i kommentar · träff i kommentar</p>`,
    );
    expect(namnsI).toContain(
      `<p><a href="/vy/arende/${A.b}">${A.b}</a> — K nämner i beskrivningen · träff i ärendetexten</p>`,
    );
    expect(namnsI).not.toContain(`href="/vy/arende/${A.d}"`);
    expect(namnsI).not.toContain(`href="/vy/arende/${A.h}"`);
    expect(lagestext(namnsI)).toBeNull();

    expect(lagestext(falt(h, 'dubbletter'))).toBe(TEXT.dubbletter);

    // Märkningen (Story 5.5): det märkta delärendet följs av raden, det omärkta (märkningen borttagen) inte.
    const kortdata = await withTransaction((client) => hamtaArendekort(client, TENANT_ID, A.h!, () => []));
    const markning = kortdata.markningar[0]!;
    const rad =
      `<p class=summering>nödvändigt delresultat — märkt ${datumtid(markning.markt)} av ` +
      `${proveniens('agent', 'hermes')}</p>`;
    const delarenden = falt(h, 'delarenden');
    const bitar = delarenden.split('<a class=kort ').slice(1);
    const c1 = bitar.find((b) => b.includes(`${A.c1} — K delärende ett`));
    const c2 = bitar.find((b) => b.includes(`${A.c2} — K delärende två`));
    expect(c1).toContain(`</a>${rad}`);
    expect(c2).not.toContain('nödvändigt delresultat');
    expect(delarenden.split('nödvändigt delresultat').length - 1).toBe(1);

    // Det tomma ärendet: Nämner, Nämns i med ärendets eget nummer och Dubbletter.
    const tom = await sida(A.tom!);
    expect({
      namner: lagestext(falt(tom, 'namner')),
      namnsI: lagestext(falt(tom, 'namns-i')),
      dubbletter: lagestext(falt(tom, 'dubbletter')),
    }).toEqual({ namner: TEXT.namner, namnsI: namnsIInga(A.tom!), dubbletter: TEXT.dubbletter });

    // Varje länk under Kopplade ärenden: förälder, två delärenden, tre relationer, ett nämnt ärende och två
    // som nämner det. Varje adress följs och svarar 200.
    const lankar = KOPPLADE.flatMap((id) => [...falt(h, id).matchAll(/href="([^"]*)"/g)].map((m) => m[1]!));
    expect(lankar).toHaveLength(9);
    for (const lank of new Set(lankar)) {
      expect(lank.startsWith('/vy/arende/'), lank).toBe(true);
      expect((await request(app).get(lank)).status, lank).toBe(200);
    }
    expect(await raknaRader('events')).toBe(fore);
  });
});

/** KORTFALT efter Story 11.5, ordagrant och i ordning: tjugo fält, och Bilagor under Dokument och underlag. */
const KORTFALTEN = [
  'frist', 'agare', 'projekt', 'kund', 'uppdrag', 'ursprung', 'beskrivning', 'atagande', 'beslut', 'insatser',
  'dokument', 'mail', 'foralder', 'delarenden', 'relationer', 'namner', 'namns-i', 'dubbletter', 'kommentarer',
  'historik',
];

/** De fem tomma formerna på en sida (Dev Notes → Avgränsade kriterier, AK 6). Tom lista = inga. */
function tommaFormer(html: string): string[] {
  const fynd: string[] = [];
  if (html.includes('<ul class=lista role=list></ul>')) fynd.push('tomt ul');
  if (html.includes('<p class=notis></p>')) fynd.push('tom notis');
  if (html.includes('<div class=text></div>')) fynd.push('tom text');
  for (const m of html.matchAll(/<h2>([^<]*)<\/h2>(?=<h2>|<\/main>)/g)) fynd.push(`h2 utan innehåll: ${m[1]}`);
  for (const m of html.matchAll(/<section id="falt-([^"]+)"><h[23]>[^<]*<\/h[23]><\/section>/g)) {
    fynd.push(`avsnitt utan innehåll: ${m[1]}`);
  }
  return fynd;
}

describe('D-3/Story 11.4 AK 6 och AK 1: tomt mot fullt ärende', () => {
  it('K11 (AK 6 och AK 1) (R): varje fält i KORTFALT står på båda korten, med värde eller med sin lägestext', async () => {
    expect(KORTFALT.map((f) => f.id)).toEqual(KORTFALTEN);
    // Motkontroll först: sidorna svarar 200 med rubriken för ärendet.
    const tom = await sida(A.tom!);
    const full = await sida(A.full!);
    expect(tom).toContain(`<h1>${A.tom} — K tomt ärende</h1>`);
    expect(full).toContain(`<h1>${A.full} — K fullt ärende</h1>`);

    const lagestexter = new Set([
      ...Object.entries(TEXT).filter(([nyckel]) => nyckel !== 'kundInternt').map(([, text]) => text),
      namnsIInga(A.tom!),
      namnsIInga(A.full!),
      spegeltext(A.tom!),
    ]);
    const fynd: string[] = [];
    const tommaPaFull: string[] = [];
    for (const [namn, html] of [['tom', tom], ['full', full]] as const) {
      for (const id of KORTFALTEN) {
        const avsnitt = falt(html, id);
        const text = lagestext(avsnitt);
        if (text !== null && !lagestexter.has(text)) fynd.push(`${namn} ${id}: okänd lägestext ${text}`);
        if (text !== null && namn === 'full') tommaPaFull.push(id);
      }
      for (const f of tommaFormer(html)) fynd.push(`${namn}: ${f}`);
    }
    expect(fynd).toEqual([]);
    // Det fulla kortet visar varje fält med värde utom de två luckorna.
    expect(tommaPaFull.sort()).toEqual(['dubbletter', 'uppdrag']);
    // Det tomma kortet säger något i varje fält: lägestext, eller ett värde som Historik och Ursprung.
    expect(KORTFALTEN.filter((id) => lagestext(falt(tom, id)) === null).sort()).toEqual(['historik', 'ursprung']);

    // Kontroll: en påhittad sida med ett avsnitt utan innehåll och ett tomt ul ger två fynd.
    expect(
      tommaFormer('<main><section id="falt-x"><h3>X</h3></section><ul class=lista role=list></ul></main>'),
    ).toEqual(['tomt ul', 'avsnitt utan innehåll: x']);
  });
});

/** Det som inte får uppstå ur datat: ett oescapat script-element och ett händelseattribut i en tagg. */
function oescapat(html: string): string[] {
  const fynd: string[] = [];
  if (/<script/i.test(html)) fynd.push('<script');
  for (const m of html.matchAll(/<[^>]*\son[a-z]+=/gi)) fynd.push(m[0]);
  return fynd;
}

describe('D-3/Story 11.4 AK 8: escaping och proveniens', () => {
  it('K12 (AK 8) (R): tecknen <script>, " och & står escapade i sju bärare, och inget nytt element uppstår', async () => {
    const html = await sida(A.fult!);
    // Motkontroll först: sidan svarar 200, och titeln står escapad i rubriken.
    expect(html).toContain(`<h1>${A.fult} — ${esc(FULT_TITEL)}</h1>`);
    expect(esc(FULT)).toBe('&lt;script&gt;alert(1)&lt;/script&gt; &quot;citat&quot; &amp; co');

    expect(oescapat(html)).toEqual([]);
    expect({
      titel: html.includes(`<h1>${A.fult} — ${esc(FULT_TITEL)}</h1>`),
      foralder: falt(html, 'foralder').includes(`</a> — ${esc(FULT_FORALDER)}</p>`),
      delarende: falt(html, 'delarenden').includes(`— ${esc(FULT_DEL)}</b>`),
      motpart: falt(html, 'relationer').includes(`<div class=text>${esc(FULT_MOTPART)}</div>`),
      namnsI: falt(html, 'namns-i').includes(`</a> — ${esc(FULT_NAMNARE)} · träff i kommentar</p>`),
      projekt: falt(html, 'projekt').includes(`<p>${esc(FULT_PROJEKT)}</p>`),
      etikett: html.includes(`<span class=tagg>${esc(FULT_ETIKETT)}</span>`),
    }).toEqual({
      titel: true,
      foralder: true,
      delarende: true,
      motpart: true,
      namnsI: true,
      projekt: true,
      etikett: true,
    });
    // Varje aktör på kortet skrivs med proveniens(): skaparen under Ursprung.
    expect(falt(html, 'ursprung')).toContain(`<p>skapade ärendet ${proveniens('agent', 'hermes')} `);

    // Kontroll: hjälparen fäller en påhittad sida med ett oescapat script och ett händelseattribut.
    expect(oescapat('<p>ok</p><script>alert(1)</script><img src=x onerror=alert(1)>')).toEqual([
      '<script',
      '<img src=x onerror=',
    ]);
  });
});

/**
 * Kopia av manniskokaka() i test/tillstand-yta.test.ts rad 221–228, bunden till david. En misslyckad
 * inloggning svarar också 303, så kvittot och kakan visar att en session föddes.
 */
async function manniskokaka(): Promise<string> {
  const svar = await request(app).post('/vy/logga-in').type('form').send({ nyckel: david, fran: '/vy' });
  const kaka = [svar.headers['set-cookie'] ?? []].flat().map(String).find((c) => c.startsWith('arenden_vy='));
  if (svar.status !== 303 || svar.headers['location'] !== '/vy?notis=inloggad' || kaka === undefined) {
    throw new Error(`inloggningen misslyckades: ${svar.status} ${String(svar.headers['location'])}`);
  }
  return kaka.split(';')[0]!;
}

/** Sidans överdel och kortets början, i den ordning de ska stå (AK 9). */
const ORDNINGEN: [string, string][] = [
  ['summeringsraden', '<p class=summering><span class="chip'],
  ['föräldraraden', '<p class=summering>Del av '],
  ['Byt tillstånd', '<details class=rattelse><summary>Byt tillstånd</summary>'],
  ['etiketterna', '<div class=taggar>'],
  ['Läget', '<h2>Läget</h2>'],
  ['Beskrivning', '<h2>Beskrivning</h2>'],
  ['rättelseformuläret', '<summary>Rätta titel eller beskrivning</summary>'],
];

/** Fynden i ordningen: en markör som saknas eller som står före den förra. Tom lista = ordningen håller. */
function ordningsfel(html: string): string[] {
  const fel: string[] = [];
  let forra = -1;
  let forraNamn = 'sidans början';
  for (const [namn, markor] of ORDNINGEN) {
    const plats = html.indexOf(markor);
    if (plats === -1) {
      fel.push(`${namn} saknas`);
    } else if (plats < forra) {
      fel.push(`${namn} står före ${forraNamn}`);
    } else {
      forra = plats;
      forraNamn = namn;
    }
  }
  return fel;
}

describe('D-3/Story 11.4 AK 9: det befintliga står kvar', () => {
  it('K13 (AK 9) (R): överdelen i samma ordning, kortet utan script och utan nya komponentnamn', async () => {
    const html = await sida(A.h!, await manniskokaka());
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet, och sessionen syns (Byt tillstånd).
    expect(html).toContain(`<h1>${A.h} — K huvudärendet</h1>`);
    expect(ordningsfel(html)).toEqual([]);
    expect(html).not.toContain('<script');

    const kallan = readFileSync(path.join(ROT, 'src/http/vy/kort.ts'), 'utf8');
    expect(kallan).not.toContain('<style');
    expect(kallan).not.toContain('<form');
    const klasser = [...kallan.matchAll(/class=("?)([^\s">]+)/g)].map((m) => m[2]!);
    // Story 11.5: div.text är den befintliga komponenten för fri text med radbrytningar, och den privata
    // bilageraden skriver de befintliga li.rad och div.huvud.
    expect([...new Set(klasser)].sort()).toEqual(['huvud', 'lista', 'notis', 'rad', 'summering', 'text']);

    // Kontroll: ordningsprövningen fäller en påhittad sida där Läget står före summeringsraden.
    const fel = ordningsfel(
      '<h2>Läget</h2><p class=summering><span class="chip"></span></p><p class=summering>Del av ' +
        '<details class=rattelse><summary>Byt tillstånd</summary><div class=taggar><h2>Beskrivning</h2>' +
        '<summary>Rätta titel eller beskrivning</summary>',
    );
    expect(fel).toEqual(['Läget står före etiketterna']);
  });
});

const D2_RUBRIK = '### D-2 — varje ärende har en stabil adress som alltid svarar (Story 11.2)';
const D3_RUBRIK = '### D-3 — ärendekortet har en sluten lista fält och inget fält står tyst tomt (Story 11.4)';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const D3_REGELN =
  '- Kortets fält är en sluten lista med fem lägen. Ett nytt fält kräver ett provfall för värde och för sitt ' +
  'tomma läge.';
const D3_REGELNS_BORJAN = '- Kortets fält är en sluten lista';

/** Avsnittets gränser: från rubriken till nästa rad som börjar med '## ' eller '### '. */
function d3Avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(D3_RUBRIK);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/** Fynden för K14 (mönstret i D19 i test/djuplank.test.ts): rubriken, regelns rad och två tabellrader. */
function d3Readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = d3Avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const fel: string[] = [];
  if (rader.filter((r) => r === D3_RUBRIK).length !== 1) fel.push('rubriken står inte exakt en gång');
  const d2 = rader.indexOf(D2_RUBRIK);
  if (d2 === -1 || d2 > granser.start) fel.push('rubriken står inte efter avsnittet för D-2');
  const granserna = rader.indexOf('## Gränser för Etapp 2a');
  if (granserna === -1 || granserna < granser.start) fel.push('rubriken står inte före gränserna för Etapp 2a');
  const regler = rader.filter((r) => r.startsWith(D3_REGELNS_BORJAN));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== D3_REGELN) fel.push('regeln avviker');
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  if (!avsnitt.includes(D3_REGELN)) fel.push('regeln står inte i avsnittet');
  const tabell = avsnitt.filter((r) => r.startsWith('| D-3'));
  if (tabell.length !== 2) fel.push(`${tabell.length} rader börjar med | D-3`);
  for (const r of tabell) if (!r.includes('test/arendekort.test.ts')) fel.push(`rad utan provfilen: ${r}`);
  return fel;
}

describe('D-3/Story 11.4 AK 11: README bär regeln (krav → kod → test)', () => {
  it('K14 (AK 11): avsnittet för D-3 bär regeln ordagrant och två rader krav → kod → test', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect(d3Readmefel(readme)).toEqual([]);
    // Kontroll: samma prövning på texten utan avsnittet fälls.
    const rader = readme.split('\n');
    const granser = d3Avsnittet(rader.map((r) => r.replace(/\r$/, '')));
    const utan = granser === null ? readme : [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
    expect(d3Readmefel(utan)).toEqual(['rubriken saknas']);
  });
});

/** En märkning på funktionsnivå: delärendet med id och nummer, märkt av hermes. */
function markning(id: string, identifier: string): Markning {
  return {
    del_issue_id: id,
    del_identifier: identifier,
    markt_av_typ: 'agent',
    markt_av_namn: 'hermes',
    markt: new Date(NU),
  };
}

/** Allt som fältet visar: värdet, eller det som ändå lästes och lägestexten. */
function faltinnehall(lage: ReturnType<typeof delarendenLage>): string {
  return lage.lage === 'varde' ? lage.html : `${lage.delvis ?? ''}${lage.text}`;
}

/** Fynden i Delärenden: en märkningsrad per märkning, och numret för varje märkning vars delärende inte är barn. */
function markningsfel(barn: string[], markningar: Markning[], html: string): string[] {
  const fel: string[] = [];
  const rader = html.split('nödvändigt delresultat').length - 1;
  if (rader !== markningar.length) fel.push(`${rader} rader för ${markningar.length} märkningar`);
  for (const m of markningar) {
    if (!barn.includes(m.del_issue_id) && !html.includes(`<a href="/vy/arende/${m.del_identifier}">`)) {
      fel.push(`${m.del_identifier} saknas`);
    }
  }
  return fel;
}

describe('D-3/Story 11.4 AK 5: en märkning står kvar på kortet när delärendet flyttas', () => {
  it('K15 (AK 5): varje aktiv märkning står exakt en gång, under sitt delärende eller med delärendets nummer', async () => {
    const fore = await raknaRader('events');
    // Motkontroll först: sidorna svarar 200 med rubriken för ärendet.
    const mh = await sida(A.mh!);
    const mh0 = await sida(A.mh0!);
    expect(mh).toContain(`<h1>${A.mh} — K märkt och flyttat</h1>`);
    expect(mh0).toContain(`<h1>${A.mh0} — K alla märkta flyttade</h1>`);

    // Läsmodellen bär delärendets nummer för varje märkning, också när delärendet inte längre är barn.
    const [kmh, kmh0] = await withTransaction(async (client) => [
      await hamtaArendekort(client, TENANT_ID, A.mh!, () => []),
      await hamtaArendekort(client, TENANT_ID, A.mh0!, () => []),
    ]);
    expect(kmh!.barn.map((b) => b.identifier)).toEqual([A.mc1]);
    expect(kmh!.markningar.map((m) => m.del_identifier)).toEqual([A.mc1, A.mc2]);
    expect(kmh0!.barn).toEqual([]);
    expect(kmh0!.markningar.map((m) => [m.del_identifier, m.markt_av_typ, m.markt_av_namn])).toEqual([
      [A.mc3, 'manniska', 'david'],
    ]);

    const markt = (m: Markning): string =>
      `märkt ${datumtid(m.markt)} av ${proveniens(m.markt_av_typ, m.markt_av_namn)}`;
    const flyttad = (m: Markning): string =>
      `<p class=summering><a href="/vy/arende/${m.del_identifier}">${m.del_identifier}</a> är inte längre ` +
      `delärende — nödvändigt delresultat, ${markt(m)}. Märkningen står kvar tills den tas bort ` +
      '(ta_bort_nodvandigt_delresultat).</p>';

    // Ett märkt delärende kvar och ett flyttat: kortet med sin rad och det flyttade med sitt nummer.
    const [m1, m2] = kmh!.markningar;
    const delarenden = falt(mh, 'delarenden');
    expect(delarenden).toContain('<h3>Delärenden (1)</h3>');
    expect(delarenden).toContain(`</a><p class=summering>nödvändigt delresultat — ${markt(m1!)}</p>`);
    expect(delarenden).toContain(flyttad(m2!));
    expect(delarenden.split('nödvändigt delresultat').length - 1).toBe(kmh!.markningar.length);
    expect(lagestext(delarenden)).toBeNull();

    // Alla märkta delärenden flyttade: inga delärenden, och märkningen står ändå där, före notisen.
    const tomma = falt(mh0, 'delarenden');
    expect(tomma).toContain('<h3>Delärenden (0)</h3>');
    expect(tomma).toContain(`${flyttad(kmh0!.markningar[0]!)}<p class=notis>`);
    expect(lagestext(tomma)).toBe(TEXT.delarenden);
    expect(tomma.split('nödvändigt delresultat').length - 1).toBe(1);

    // De flyttade delärendenas länkar svarar 200.
    for (const id of [A.mc2!, A.mc3!]) expect((await request(app).get(`/vy/arende/${id}`)).status, id).toBe(200);

    // Funktionsnivå: varje kombination av barn och märkningar ger exakt en rad per märkning, och varje
    // märkning vars delärende inte är barn står med sitt nummer.
    const kort = (id: string): string => `<a class=kort href="#${id}">${id}</a>`;
    const fynd: string[] = [];
    const kombinationer: [string, string[], Markning[]][] = [
      ['två barn, ett märkt', ['a', 'b'], [markning('a', 'LOC-9101')]],
      ['ett barn märkt, ett flyttat', ['a'], [markning('a', 'LOC-9101'), markning('x', 'LOC-9102')]],
      ['inga barn, två flyttade', [], [markning('x', 'LOC-9102'), markning('y', 'LOC-9103')]],
      ['barn utan märkning', ['a'], []],
      ['inga barn och inga märkningar', [], []],
      ['blandat i annan ordning', ['a', 'b'], [markning('b', 'LOC-9104'), markning('x', 'LOC-9102'), markning('a', 'LOC-9101')]],
    ];
    for (const [namn, barn, markningar] of kombinationer) {
      const lage = delarendenLage(barn.map((id) => ({ id })), barn.map(kort), markningar);
      for (const fel of markningsfel(barn, markningar, faltinnehall(lage))) fynd.push(`${namn}: ${fel}`);
      if (barn.length === 0 && (lage.lage !== 'inga' || lage.text !== TEXT.delarenden)) fynd.push(`${namn}: ${lage.lage}`);
      if (barn.length > 0 && lage.lage !== 'varde') fynd.push(`${namn}: ${lage.lage}`);
    }
    expect(fynd).toEqual([]);
    // Ett kort per delärende: avviker antalet kort kastar fältet i stället för att tappa ett kort.
    expect(() => delarendenLage([{ id: 'a' }, { id: 'b' }], [kort('a')], [])).toThrow();
    // Kontroll: en rendering som bara visar märkningarna under barnens kort fälls för den flyttade.
    expect(
      markningsfel(
        ['a'],
        [markning('a', 'LOC-9101'), markning('x', 'LOC-9102')],
        `${kort('a')}<p class=summering>nödvändigt delresultat — märkt</p>`,
      ),
    ).toEqual(['1 rader för 2 märkningar', 'LOC-9102 saknas']);
    expect(await raknaRader('events')).toBe(fore);
  });
});

/** Fixturens aktörer: nycklarna och importen. Namnen står med gemener; tillhörigheten «Hermes» är inget namn. */
const AKTORER = ['hermes', 'david', 'linear-import'];
/** Ett proveniensmärke som proveniens() i src/http/vy/mall.ts skriver det. */
const PROVENIENSMARKE = /<span class="prov [^"]*" title="[^"]*"><span aria-hidden=true>[^<]*<\/span>[^<]*<\/span>/g;

/**
 * Aktörsnamnen som står utanför ett proveniensmärke. Tom lista = varje aktör bär sitt märke. Story 11.5:
 * maskinnamn i code (handlingskontraktets och källornas system, kommandon och id:n) är data och inga
 * aktörer, så de tas bort innan namnen söks (Dev Notes → Tolkningar, punkt 7).
 */
function aktorerUtanMarke(html: string): string[] {
  const utan = html.replace(PROVENIENSMARKE, '').replace(/<code>[^<]*<\/code>/g, '');
  return [...utan.matchAll(new RegExp(`\\b(?:${AKTORER.join('|')})\\b`, 'g'))].map((m) => m[0]);
}

/**
 * Kortet på sidan: från gruppen Läget till sidans slut, utan delärendenas kort. Summeringsraden ovanför hör
 * inte till kortet, och delärendenas kort byggs av arendeKort i ärenderutten, som berättelsen inte ändrar
 * (Dev Notes → Får inte röras); dess metarad skriver plockningen som förut.
 */
function kortdelen(html: string): string {
  const start = html.indexOf('<h2>Läget</h2>');
  expect(start, 'kortet börjar inte').toBeGreaterThan(-1);
  const slut = html.indexOf('</main>', start);
  return html.slice(start, slut === -1 ? html.length : slut).replace(/<a class=kort [^>]*>.*?<\/a>/gs, '');
}

describe('D-3/Story 11.4 AK 8: varje aktör på kortet bär sitt proveniensmärke', () => {
  it('K16 (AK 8): ingen aktör står omärkt i kortets fält, också den som plockade ärendet', async () => {
    // Motkontroll först: sidan för det plockade ärendet svarar 200 med rubriken för ärendet.
    const claim = await sida(A.claim!);
    expect(claim).toContain(`<h1>${A.claim} — K plockat ur kön</h1>`);

    // Varje kort i fixturen där en aktör kan stå: åtagande och utförare, plockning, insatser, skapare,
    // märkningar (kvar och flyttade), kommentarer och historik.
    const fynd: string[] = [];
    const korten = [
      A.h, A.tom, A.claim, A.insats, A.uppfoljning, A.deadline, A.full, A.fult, A.utan, A.extern,
      A.k_kopplat, A.k_internt, A.mh, A.mh0, A.c1, A.m,
      // Story 11.5: insatserna med svaret, åtagandet med utföraren och dokumenten med kommentarens skribent.
      A.ins, A.ag_genom, A.dok,
    ];
    for (const identifier of korten) {
      for (const namn of aktorerUtanMarke(kortdelen(await sida(identifier!)))) fynd.push(`${identifier}: ${namn}`);
    }
    // Arkivärendet: bara kortets egna fält, eftersom arkivets text kan nämna människor vid namn.
    const arkiv = await sida('LOC-316');
    for (const id of ['ursprung', 'agare']) {
      for (const namn of aktorerUtanMarke(falt(arkiv, id))) fynd.push(`LOC-316 ${id}: ${namn}`);
    }
    expect(fynd).toEqual([]);

    // Den som plockade ärendet: typen ur händelsen claimade_arende.
    expect(falt(claim, 'agare')).toContain(`<p>plockat av ${proveniens('agent', 'hermes')}</p>`);
    // Funktionsnivå: den senaste plockningen av samma aktör ger typen, en plockning av en annan aktör
    // gör det inte, och utan plockning märks typen som okänd i stället för att aktören står omärkt.
    const plockning = (aktor_typ: string, aktor_namn: string) => ({ verb: 'claimade_arende', aktor_typ, aktor_namn });
    expect(
      agareLage({ claimad_av: 'hermes' }, null, [], [plockning('manniska', 'david'), plockning('agent', 'hermes')]),
    ).toEqual({ lage: 'varde', html: `<p>plockat av ${proveniens('agent', 'hermes')}</p>` });
    expect(agareLage({ claimad_av: 'hermes' }, null, [], [plockning('manniska', 'david')])).toEqual({
      lage: 'varde',
      html: `<p>plockat av ${proveniens('okänd', 'hermes')}</p>`,
    });
    expect(agareLage({ claimad_av: 'hermes' }, null, [], [])).toEqual({
      lage: 'varde',
      html: `<p>plockat av ${proveniens('okänd', 'hermes')}</p>`,
    });

    // Kontroll: en påhittad rad med namnet utan märke fälls, och samma rad med märket inte; kortdelen()
    // tar bort delärendenas kort men inte fältens egna rader.
    expect(aktorerUtanMarke('<p>plockat av hermes</p><p>utförare david</p>')).toEqual(['hermes', 'david']);
    expect(aktorerUtanMarke(`<p>plockat av ${proveniens('agent', 'hermes')}</p>`)).toEqual([]);
    // Story 11.5: ett maskinnamn i code räknas inte, men samma namn utanför code fälls fortfarande.
    expect(aktorerUtanMarke('<p>Källa: <code>hermes</code> · hermes</p>')).toEqual(['hermes']);
    expect(
      aktorerUtanMarke(kortdelen('<h2>Läget</h2><a class=kort href="#">plockat av hermes</a><p>david</p></main>')),
    ).toEqual(['david']);
  });
});

/** Raden som säger att taket för «Nämns i» är nått (Dev Notes → Markup). */
const TAKRAD = `<p class=summering>Taket ${TAK_NAMNS_I} är nått — fler ärenden nämner numret än listan visar.</p>`;

/**
 * Fynden för taket: sökfrågan ger de första `grans` träffarna i rangordning, och kortet ska ändå visa
 * min(andra, taket) ärenden, aldrig ärendet självt, och säga att taket är nått exakt när fler andra ärenden
 * än taket finns. Ärendet självt prövas utanför träffarna och på första, mittersta och sista platsen.
 */
function takfel(grans: number): string[] {
  const fel: string[] = [];
  for (const andra of [TAK_NAMNS_I - 1, TAK_NAMNS_I, TAK_NAMNS_I + 1, TAK_NAMNS_I + 2]) {
    for (const plats of [null, 0, Math.floor(andra / 2), andra]) {
      const alla = Array.from({ length: andra }, (_, i) => ({ id: `andra-${i}` }));
      if (plats !== null) alla.splice(plats, 0, { id: 'sjalv' });
      const { namnsI, kapat } = namnsIUrTraffar(alla.slice(0, grans), 'sjalv');
      const fall = `${andra} andra, ärendet självt ${plats === null ? 'utan träff' : `på plats ${plats}`}`;
      if (kapat !== andra > TAK_NAMNS_I) fel.push(`${fall}: kapat ${String(kapat)}`);
      if (namnsI.length !== Math.min(andra, TAK_NAMNS_I)) fel.push(`${fall}: ${namnsI.length} visade`);
      if (namnsI.some((t) => t.id === 'sjalv')) fel.push(`${fall}: ärendet självt visas`);
    }
  }
  return fel;
}

describe('D-3/Story 11.4 AK 5: taket för Nämns i', () => {
  it('K17 (AK 5): taket säger när det är nått, också när ärendet självt är bland sökträffarna', async () => {
    // Funktionsnivå: raden om taket står när listan är kapad, och bara då.
    const traff = { identifier: 'LOC-9201', title: 'K träff', traff_i: 'arende' };
    const kapad = namnsILage({ identifier: 'LOC-9200' }, [traff], true);
    const hel = namnsILage({ identifier: 'LOC-9200' }, [traff], false);
    expect(kapad.lage === 'varde' ? kapad.html : kapad.text).toContain(TAKRAD);
    expect(hel.lage === 'varde' ? hel.html : hel.text).not.toContain('Taket');

    // Gränsen 200/201: med läsmodellens gräns avgörs taket rätt var ärendet självt än står.
    expect(takfel(NAMNS_I_GRANS)).toEqual([]);
    // Kontroll: med taket plus ett som gräns hade ärendet självt på en tidig plats dolt att taket är nått.
    expect(takfel(TAK_NAMNS_I + 1)).toContain(`${TAK_NAMNS_I + 1} andra, ärendet självt på plats 0: kapat false`);

    // Databasen: ärendet nämner sig självt, och 200 respektive 201 andra ärenden nämner det. Alla
    // träffar ryms inom gränsen, så ärendet självt är bland sökträffarna i båda fallen.
    const mal = await nytt('K taket');
    await steg(hermes, 'add_comment', { identifier: mal, body: `Det här är ${mal}.` });
    const fler = (antal: number, fran: number) =>
      withTransaction(async (client) => {
        for (let n = fran; n < fran + antal; n++) {
          await skapaArende(client, TENANT_ID, {
            title: `K nämner taket ${n}`,
            team_key: 'LOC',
            description: `Nämner ${mal}.`,
          });
        }
      });
    const las = () => withTransaction((client) => hamtaArendekort(client, TENANT_ID, mal, () => []));
    const utfall = (k: Awaited<ReturnType<typeof las>>) => ({
      visade: k.namnsI.length,
      kapat: k.namnsIKapat,
      sjalv: k.namnsI.some((t) => t.identifier === mal),
    });

    await fler(TAK_NAMNS_I, 0);
    expect(utfall(await las())).toEqual({ visade: TAK_NAMNS_I, kapat: false, sjalv: false });
    const vid = falt((await request(app).get(`/vy/arende/${mal}`)).text, 'namns-i');
    expect(vid).not.toContain(TAKRAD);

    await fler(1, TAK_NAMNS_I);
    expect(utfall(await las())).toEqual({ visade: TAK_NAMNS_I, kapat: true, sjalv: false });
    const over = falt((await request(app).get(`/vy/arende/${mal}`)).text, 'namns-i');
    expect(over).toContain(TAKRAD);
    expect(over.split('<p><a href="/vy/arende/').length - 1).toBe(TAK_NAMNS_I);
    expect(over).not.toContain(`<p><a href="/vy/arende/${mal}">`);
  });
});

/**
 * Fynden för skrivsätten, ett per påstående som inte stämmer: Nämner tar med varje skrivsätt i beskrivningen
 * eller en kommentar, Nämns i listar varje skrivsätt som fältet säger hittas, och inget som fältet nämner
 * som exempel på det sökningen inte läser. Om ett skrivsätt utan utsaga kräver provet inget av Nämns i.
 */
function skrivsattsfel(mal: string, namnsI: string, namnerPer: string[]): string[] {
  const fel: string[] = [];
  for (const [i, skrivsatt] of SKRIVSATTEN.entries()) {
    if (skrivsatt.i !== 'titel' && !namnerPer[i]!.includes(`<a href="/vy/arende/${mal}">`)) {
      fel.push(`${skrivsatt.namn}: Nämner saknar ${mal}`);
    }
    const listad = namnsI.includes(`<a href="/vy/arende/${A[`form${i}`]}">`);
    if (skrivsatt.utsaga === 'hittas' && !listad) fel.push(`${skrivsatt.namn}: hittas enligt fältet, men saknas`);
    if (skrivsatt.utsaga === 'exempel' && listad) fel.push(`${skrivsatt.namn}: exempel i fältet, men listas`);
  }
  return fel;
}

describe('D-3/Story 11.4 AK 5: Nämns i säger vilka skrivsätt som räknas', () => {
  it('K18 (AK 5): fältet påstår i båda lägena bara det som stämmer för tio skrivsätt, och varje exempel i texten är prövat', async () => {
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet.
    const malsida = await sida(A.formmal!);
    expect(malsida).toContain(`<h1>${A.formmal} — K mål för skrivsätten</h1>`);

    // Det som fältet säger om skrivsätten stämmer: Nämner på det nämnande ärendet tar med varje skrivsätt i
    // beskrivningen eller en kommentar, Nämns i listar varje skrivsätt med numret som eget ord (i en
    // kommentar, i beskrivningen och i titeln) och inget av exemplen.
    const namnsI = falt(malsida, 'namns-i');
    const namnerPer: string[] = [];
    for (const i of SKRIVSATTEN.keys()) namnerPer.push(falt(await sida(A[`form${i}`]!), 'namner'));
    expect(skrivsattsfel(A.formmal!, namnsI, namnerPer)).toEqual([]);
    // Värdeläget säger efter listan vad som räknas, så att listan inte läses som fullständig.
    expect(namnsI).toContain(`<p class=summering>${namnsIOmfang(A.formmal!)}</p></section>`);
    expect(lagestext(namnsI)).toBeNull();

    // Varje exempel som fältets text nämner är ett prövat skrivsätt med utsagan 'exempel', och tvärtom: ett
    // exempel i texten utan prövat skrivsätt fälls här (som den förra textens «ihopskrivet med andra ord», fast
    // sökningen hittar «LOC-N-uppföljningen»).
    const provadeExempel = SKRIVSATTEN.filter((s) => s.utsaga === 'exempel').map((s) => s.fras);
    expect(exempelIText(namnsIOmfang(A.formmal!))).toEqual(provadeExempel);
    const medOprovat = namnsIOmfang(A.formmal!).replace(
      ' eller med inledande nollor',
      ', ihopskrivet med andra ord eller med inledande nollor',
    );
    expect(exempelIText(medOprovat)).not.toEqual(provadeExempel);

    // Det tomma läget, när ärendet bara nämns inne i en adress: notisen säger att det inte räknas, och
    // det nämnande ärendet har det under Nämner.
    expect(lagestext(falt(await sida(A.formtom!), 'namns-i'))).toBe(namnsIInga(A.formtom!));
    expect(namnsIInga(A.formtom!)).toContain(namnsIOmfang(A.formtom!));
    expect(falt(await sida(A.formadress!), 'namner')).toContain(`<a href="/vy/arende/${A.formtom}">`);

    // Funktionsnivå: fältets alla former bär omfånget (inga träffar, träffar, träffar vid taket).
    const traff = { identifier: 'LOC-9301', title: 'K träff', traff_i: 'kommentar' };
    for (const [traffar, kapat] of [[[], false], [[traff], false], [[traff], true]] as const) {
      const lage = namnsILage({ identifier: 'LOC-9300' }, traffar, kapat);
      const innehall = lage.lage === 'varde' ? lage.html : lage.text;
      expect(innehall, `${traffar.length} träffar, kapat ${String(kapat)}`).toContain(namnsIOmfang('LOC-9300'));
    }

    // Kontroll: om Nämns i hade listat alla skrivsätten hade varje exempel gett ett fynd, om Nämns i hade
    // varit tomt hade varje skrivsätt som hittas gett ett fynd, och om Nämner hade saknat målet hade varje
    // skrivsätt i beskrivningen eller en kommentar gett ett fynd.
    const antal = (villkor: (s: (typeof SKRIVSATTEN)[number]) => boolean) => SKRIVSATTEN.filter(villkor).length;
    expect([antal((s) => s.utsaga === 'hittas'), antal((s) => s.utsaga === 'exempel')]).toEqual([7, 2]);
    const allaListade = SKRIVSATTEN.map((_, i) => `<a href="/vy/arende/${A[`form${i}`]}">`).join('');
    expect(skrivsattsfel(A.formmal!, allaListade, namnerPer)).toHaveLength(2);
    expect(skrivsattsfel(A.formmal!, '', namnerPer)).toHaveLength(7);
    expect(skrivsattsfel(A.formmal!, namnsI, SKRIVSATTEN.map(() => ''))).toHaveLength(antal((s) => s.i !== 'titel'));
  });
});

// ---- Story 11.5, Uppgift 1: läsmodellen och mätningen av referenstyperna ----------------------------------

describe('D-3/Story 11.5 AK 2–4 och 9: läsmodellen hämtar åtagandet, besluten och alla insatser', () => {
  it('K19 (AK 2–4 och 9): åtagandets data, alla insatser med sina källor, besluten och svarsversionerna', async () => {
    const fore = await raknaRader('events');
    // Vad kandidaterna fick, per ärende: åtagandet och antalet insatser (sidans rendering behöver båda).
    const fick: Record<string, { atagande: unknown; insatser: number }> = {};
    const [h, beslut, p1, tom] = await withTransaction(async (client) => {
      const kort = [];
      for (const identifier of [A.h!, A.beslut!, A.p1!, A.tom!]) {
        kort.push(
          await hamtaArendekort(client, TENANT_ID, identifier, (t) => {
            fick[identifier] = { atagande: t.atagande, insatser: t.insatser.length };
            return [];
          }),
        );
      }
      return kort;
    });

    // Huvudärendet: åtagandets revision och data, alla tre insatser i läsmodellens ordning (också den
    // återkallade), de öppna som förut och den första insatsens källa.
    expect(typeof h!.atagande?.revision).toBe('number');
    expect(h!.atagande?.data).toMatchObject({ grund: [GRUND], nasta: INTERNT });
    expect(h!.insatser.map((i) => [i.id, i.lage, i.version])).toEqual([
      [I.i1, 'vantande', 1],
      [I.i2, 'uppskjuten', 2],
      [I.i3, 'aterkallad', 2],
    ]);
    expect(h!.insatser[2]!.blockeringsgrund).toBe('Tidigare besked avgör inte valet\nÅterkallad: Inte längre aktuell');
    expect(h!.oppnaInsatser.map((i) => i.id)).toEqual([I.i1, I.i2]);
    expect(h!.insatser[0]!.kallor).toEqual([
      { system: 'hermes', objekttyp: 'beslut', objekt_id: 'arendekort-i1', objekt_version: null, lank: null },
    ]);
    expect(fick[A.h!]).toEqual({ atagande: h!.atagande, insatser: 3 });

    // Besluten: de två kopplade i kopplingens ordning, och svarsversionerna för #54 och för #61, som
    // registrerats på ärendet utan att vara kopplat dit.
    expect(beslut!.beslut.map((b) => [b.beslut_id, b.kopplad instanceof Date])).toEqual([
      [54, true],
      [60, true],
    ]);
    expect(beslut!.svarsversioner.map((v) => [v.beslut_id, v.version, v.svar_hash, v.tillampad instanceof Date])).toEqual([
      [54, 1, HASH_54_V1, true],
      [54, null, HASH_54, true],
      [61, null, HASH_61, true],
    ]);

    // Ett av varje: en insats med en källa och ett beslut.
    expect([p1!.insatser.length, p1!.insatser[0]?.kallor.length, p1!.beslut.map((b) => b.beslut_id)]).toEqual([
      1,
      1,
      [5101],
    ]);

    // Det tomma ärendet: inget av det nya, och kandidaterna fick inget åtagande och inga insatser.
    expect({ atagande: tom!.atagande, insatser: tom!.insatser, beslut: tom!.beslut, svar: tom!.svarsversioner }).toEqual({
      atagande: null,
      insatser: [],
      beslut: [],
      svar: [],
    });
    expect(fick[A.tom!]).toEqual({ atagande: null, insatser: 0 });
    expect(await raknaRader('events')).toBe(fore);
  });

  it('K20 (AK 9): lika många frågor med 1 och 10 insatser, 1 och 5 beslut och 1 och 10 villkor', async () => {
    const fore = await raknaRader('events');
    const fragor: Record<string, number> = {};
    const kort: Record<string, Awaited<ReturnType<typeof hamtaArendekort>>> = {};
    let medSlinga = 0;
    await withTransaction(async (client) => {
      for (const [fall, identifier] of [['tunt', A.tunt!], ['p1', A.p1!], ['p10', A.p10!]]) {
        const raknare = raknandeKlient(client);
        kort[fall!] = await hamtaArendekort(raknare.klient, TENANT_ID, identifier!, () => []);
        fragor[fall!] = raknare.antal();
      }
      // Kontroll: en påhittad läsning som ställer en fråga till per insats ger fler frågor, så räkningen
      // kan slå ut.
      const raknare = raknandeKlient(client);
      const tio = await hamtaArendekort(raknare.klient, TENANT_ID, A.p10!, () => []);
      for (const i of tio.insatser) await raknare.klient.query('SELECT $1::uuid AS id', [i.id]);
      medSlinga = raknare.antal();
    });

    // Datat först: tio insatser med en källa var, fem beslut och tio villkor i åtagandets data.
    const p10 = kort.p10!;
    expect({
      insatser: p10.insatser.length,
      kallor: p10.insatser.map((i) => i.kallor.length),
      beslut: p10.beslut.length,
      villkor: (p10.atagande?.data as { villkor?: unknown[] } | undefined)?.villkor?.length,
    }).toEqual({ insatser: 10, kallor: Array.from({ length: 10 }, () => 1), beslut: 5, villkor: 10 });
    expect([kort.p1!.insatser.length, kort.p1!.beslut.length]).toEqual([1, 1]);

    // Sedan frågorna: lika många för det tunna ärendet, ett av varje och tio av varje.
    expect(fragor.p1).toBe(fragor.tunt);
    expect(fragor.p10).toBe(fragor.tunt);
    expect(medSlinga).toBeGreaterThan(fragor.p1!);
    expect(await raknaRader('events')).toBe(fore);
  });
});

const korProcess = promisify(execFile);

/**
 * Skriptet, `tsx src/scripts/matReferenstyper.ts`, som barnprocess i repots rot (mönstret i N18 i
 * test/delresultat.test.ts). Barnprocessen ärver testmiljöns databasadress, rollen app mot testdatabasen.
 * DOTENV_CONFIG_PATH pekar på en fil som inte finns, så att ingen .env kan rikta skriptet mot en annan
 * databas. En avslutningskod kastar inte. Provet läser inte package.json: skriptraden är ett förkrav i drift.
 */
async function korMatskriptet(env: Record<string, string> = {}): Promise<{ kod: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'tsx'),
      ['src/scripts/matReferenstyper.ts'],
      {
        cwd: ROT,
        env: {
          ...process.env,
          DOTENV_CONFIG_PATH: path.join(tmpdir(), 'arendekort-finns-inte.env'),
          ...env,
        },
      },
    );
    return { kod: 0, stdout, stderr };
  } catch (e) {
    const fel = e as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof fel.code !== 'number') throw e;
    return { kod: fel.code, stdout: fel.stdout ?? '', stderr: fel.stderr ?? '' };
  }
}

type Matning = {
  referenser: { barare: string; typ: string | null; antal: number }[];
  kallor: { system: string; objekttyp: string; antal: number }[];
};

/** Mätningen som karta: en nyckel per post, i samma form som skriptets rader, till antalet. */
function matkarta(m: Matning): Map<string, number> {
  const karta = new Map<string, number>();
  for (const r of m.referenser) karta.set(`referens\t${r.barare}\t${r.typ ?? '(saknas)'}`, r.antal);
  for (const k of m.kallor) karta.set(`kalla\t${k.system}\t${k.objekttyp}`, k.antal);
  return karta;
}

/** Skillnaden mellan två mätningar, bara poster som ändrats. */
function skillnad(fore: Map<string, number>, efter: Map<string, number>): Record<string, number> {
  const ut: Record<string, number> = {};
  for (const nyckel of new Set([...fore.keys(), ...efter.keys()])) {
    const delta = (efter.get(nyckel) ?? 0) - (fore.get(nyckel) ?? 0);
    if (delta !== 0) ut[nyckel] = delta;
  }
  return ut;
}

describe('D-4/Story 11.5 AK 1: referenstyperna mäts', () => {
  it('K21 (AK 1): mätningen listar typerna per bärare och källornas par i en READ ONLY-transaktion och skriver ingenting', async () => {
    const mat = (): Promise<Matning> =>
      withTransaction(async (client) => {
        // Första satsen efter BEGIN, som i skriptet: Postgres avvisar därefter varje skrivning.
        await client.query('SET TRANSACTION READ ONLY');
        return arendekortet.matReferenstyper(client, TENANT_ID);
      });
    const fore = matkarta(await mat());

    // Fallets eget ärende: ett åtagande med fem kända typer och den okända kvitto i grunden, och en insats
    // med ett belägg och två källor. Inget av fixturens ärenden ändras, och ärendenumret finns inte.
    const mal = await nytt('K mätningens ärende');
    await steg(hermes, 'registrera_atagande', {
      identifier: mal,
      grund: [
        { typ: 'beslut', id: '9201' },
        { typ: 'arende', id: 'LOC-99997' },
        { typ: 'dokument', id: '01-Projekt/k-kort/avtal.md' },
        { typ: 'url', id: 'https://example.com/k-matning' },
        { typ: 'mail', id: 'k-matning-mail' },
        { typ: 'kvitto', id: 'K-7' },
      ],
      nasta: INTERNT,
      foljs_upp: UPPFOLJNING,
    });
    await insats('k-matning', mal, {
      belagg: [{ typ: 'prov', id: 'k-matning-prov' }],
      kallor: [
        { system: 'redovisning', objekttyp: 'mail', objekt_id: 'k-matning-k1' },
        { system: 'hermes', objekttyp: 'beslut', objekt_id: 'k-matning-k2' },
      ],
    });

    const handelser = await raknaRader('events');
    const insatser = await raknaRader('insatser');
    const efter = matkarta(await mat());
    expect([await raknaRader('events'), await raknaRader('insatser')]).toEqual([handelser, insatser]);
    // Exakt de tillagda posterna och inga andra: sex typer i grunden, nästa stegs grund (INTERNT har grunden
    // GRUND av typen beslut), insatsens belägg och de två paren.
    expect(skillnad(fore, efter)).toEqual({
      'referens\tgrund\tbeslut': 1,
      'referens\tgrund\tarende': 1,
      'referens\tgrund\tdokument': 1,
      'referens\tgrund\turl': 1,
      'referens\tgrund\tmail': 1,
      'referens\tgrund\tkvitto': 1,
      'referens\tnasta.grund\tbeslut': 1,
      'referens\tinsats.belagg\tprov': 1,
      'kalla\tredovisning\tmail': 1,
      'kalla\thermes\tbeslut': 1,
    });

    // Skriptet: samma poster som rader, sist antalet rader, kod 0 och ingen skrivning.
    const { kod, stdout, stderr } = await korMatskriptet();
    expect(kod, stderr).toBe(0);
    const rader = stdout.split('\n').filter((r) => r !== '');
    const poster = rader.filter((r) => r.startsWith('referens\t') || r.startsWith('kalla\t'));
    expect(poster).toContain(`referens\tgrund\tkvitto\t${efter.get('referens\tgrund\tkvitto')}`);
    expect(poster).toContain(`kalla\tredovisning\tmail\t${efter.get('kalla\tredovisning\tmail')}`);
    expect(poster).toHaveLength(efter.size);
    expect(rader.at(-1)).toBe(`Antal: ${poster.length}`);
    expect([await raknaRader('events'), await raknaRader('insatser')]).toEqual([handelser, insatser]);

    // Kontroll: en mätning som inte kunde göras ser aldrig ut som noll referenser.
    const finnsInte = new URL(process.env.DATABASE_URL!);
    finnsInte.pathname = '/arenden_finns_inte';
    const fel = await korMatskriptet({ DATABASE_URL: finnsInte.toString() });
    expect(fel.kod, fel.stderr).toBe(1);
    expect(fel.stderr).toMatch(/^FATAL:/);
    expect(fel.stdout).not.toContain('Antal:');
  });
});

// ---- Story 11.5, Uppgift 2: R5 och referenserna på funktionsnivå ------------------------------------------

/** En exempelsökväg per post i PRIVATA (R5, PRD §5). Nycklarna ska vara exakt PRIVATA:s poster. */
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

/** Obsidian-formen: file-värdet utan .md och kodat, som dokumentsidans länk till Obsidian. */
function obsidianform(rel: string): string {
  return `obsidian://open?vault=brain&file=${encodeURIComponent(rel.replace(/\.md$/, ''))}`;
}

/**
 * De tretton formerna av en sökväg (Dev Notes → Testmönster, K22). Den trasiga procentföljden står sist,
 * efter den kodade sökvägen: `%E2` går inte att avkoda och står kvar.
 */
function privataFormer(rel: string): [string, string][] {
  return [
    ['som den är', rel],
    ['./ före', `./${rel}`],
    ['/fil/ före', `/fil/${rel}`],
    ['/katalog/ före', `/katalog/${rel}`],
    ['/vy/dok/ före', `/vy/dok/${ledvis(rel)}`],
    ['https-adress', `https://example.com/fil/${ledvis(rel)}`],
    ['absolut sökväg i testvalvet', path.join(TEST_VAULT, rel)],
    ['obsidian-form', obsidianform(rel)],
    ['procentkodad', encodeURIComponent(rel)],
    ['dubbelkodad', encodeURIComponent(encodeURIComponent(rel))],
    ['NFD', rel.normalize('NFD')],
    ['versaler', rel.toUpperCase()],
    ['trasig procentföljd sist', `${encodeURIComponent(rel)}%E2%8`],
  ];
}

/** Sökvägen utan .md, som wikilänken och obsidian-formen skriver den. */
function utanAndelse(rel: string): string {
  return rel.replace(/\.md$/, '');
}

/** Sökvägen med `tecken` efter det första tecknet, alltså inne i det första ledet. */
function inneIForstaLedet(rel: string, tecken: string): string {
  return `${rel.slice(0, 1)}${tecken}${rel.slice(1)}`;
}

/** ASCII-tecknen i fullbredd (U+FF01–U+FF5E), som NFKC läser som de vanliga. */
function fullbredd(text: string): string {
  return text.replace(/[!-~]/g, (t) => String.fromCodePoint(t.codePointAt(0)! + 0xfee0));
}

/**
 * Granskningsfynd 2 och 3 (Story 11.5): formerna som en läsare, URL-tolken, Obsidian eller autolänkaren läser
 * som sökvägen fast texten inte är den. Varje grupp är en klass: tecken som URL-tolken tar bort (tabb,
 * radbrytning, vagnretur, blanksteg först och sist), tecken som inte syns, tecken intill sökvägen (blanksteg,
 * skiljetecken, citattecken, parenteser), länkformerna (wikilänk, markdownlänk, målet utan ändelse),
 * punktleden och fullbreddstecknen, som text och som adress.
 */
function lastaFormer(rel: string): [string, string][] {
  const adress = `https://example.com/fil/${ledvis(rel)}`;
  return [
    ['tabb inne i ett led', inneIForstaLedet(rel, '\t')],
    ['radbrytning inne i ett led', inneIForstaLedet(rel, '\n')],
    ['vagnretur inne i ett led', inneIForstaLedet(rel, '\r')],
    ['nollbrett mellanrum inne i ett led', inneIForstaLedet(rel, '​')],
    ['mjukt bindestreck inne i ett led', inneIForstaLedet(rel, '­')],
    ['blanksteg sist', `${rel} `],
    ['blanksteg först', ` ${rel}`],
    ['i en mening', `Källa: ${rel}, se där.`],
    ['med punkt sist', `Se ${rel}.`],
    ['inom citattecken', `"${rel}"`],
    ['inom parentes', `(${rel})`],
    ['wikilänk', `[[${utanAndelse(rel)}]]`],
    ['wikilänk med rubrik och alias', `[[${utanAndelse(rel)}#Rubrik|alias]]`],
    ['markdownlänk', `[se här](${ledvis(rel)})`],
    ['utan ändelse', utanAndelse(rel)],
    ['punktled', rel.replace('/', '/./')],
    ['tillbakaled', rel.replace('/', '/k-led/../')],
    ['fullbredd', fullbredd(rel)],
    ['https-adress med tabb', `https://example.com/fil/${inneIForstaLedet(ledvis(rel), '\t')}`],
    ['https-adress med radbrytning', `https://example.com/fil/${inneIForstaLedet(ledvis(rel), '\n')}`],
    ['https-adress med blanksteg sist', `${adress} `],
    ['https-adress med tillbakaled', `https://example.com/fil/k-led/../${ledvis(rel)}`],
    ['obsidian-form med blanksteg sist', `${obsidianform(rel)} `],
  ];
}

/** Formerna ur lastaFormer som också prövas på motexemplen, som ska förbli inte privata. */
const MOTFORMER = [
  'tabb inne i ett led',
  'blanksteg sist',
  'i en mening',
  'med punkt sist',
  'wikilänk',
  'utan ändelse',
  'tillbakaled',
  'fullbredd',
  'https-adress med tabb',
];

/**
 * Granskningsfynd 2 och 3 på kortet (K30): bärarna på A.privat som URL-tolken eller en läsare läser som en
 * privat sökväg fast texten inte är den. Tabb och radbrytning inne i ett led tar URL-tolken bort, ett blanksteg
 * sist tar den bort och en läsare ser det inte, och wikilänken är Obsidians egen form.
 */
const PRIVATA_TRASIGA = {
  grund: [
    { typ: 'url', id: 'https://example.com/fil/jo\turnal/2026-10-01.md' },
    { typ: 'url', id: 'https://example.com/fil/jag.md ' },
    { typ: 'dokument', id: '[[journal/2026-10-01]]' },
  ],
  lankar: [
    'https://example.com/fil/jo\turnal/2026-10-01.md',
    'https://example.com/fil/05-Dag\nligt/2026-10-01-morgonbrief.md',
    'https://example.com/fil/jag.md ',
  ],
  bilagor: ['https://example.com/fil/jag.md ', 'https://example.com/fil/jo\turnal/2026-10-01.md'],
};
/** Det som en läcka av bärarna ovan skriver i klartext: texten som den står och wikilänkens mål. */
const TRASIGA_DELAR = ['jo\turnal', '05-Dag\nligt', 'journal/2026-10-01'];

/** Två vitlistade dokument, spegelfilen och tre namn som bara liknar en privat post. */
const INTE_PRIVATA = [
  '01-Projekt/k-kort/avtal.md',
  '02-Områden/hermes/k-kort-plan.md',
  '02-Områden/linear-arkiv/LOC-1.md',
  'journalist/x.md',
  '05-Dagligtvis/x.md',
  '02-Områden/hälsning/x.md',
];
/** Fri text i en bärare som prövas (titlar och undertitlar) där inget led är en privat post. */
const INTE_PRIVAT_TEXT = ['K dokumentbilaga ett', 'Jag skrev sist', 'Journalisten ringde om hälsningen', 'Plan för 05-Dagligtvis'];

/** Delningen före granskningsfynd 3: bara vid / \ ? & = # : %, utan avkodning. Kontrollen i K22 läser den. */
function gammalDelning(ref: string): boolean {
  const led = ref.normalize('NFC').toLowerCase().split(/[/\\?&=#:%]/).filter((d) => d !== '');
  return Object.keys(PRIVATA_FALL).some((post) => {
    const delar = post.normalize('NFC').toLowerCase().split('/').filter((d) => d !== '');
    return led.some((_, start) => delar.every((d, i) => led[start + i] === d));
  });
}

/** De fyra .md-exemplen och det katalognamn som 404-svaret aldrig får nämna. */
const PRIVATA_DOKUMENT: [string, string][] = [
  ['jag.md', 'jag.md'],
  ['journal/2026-10-01.md', 'journal'],
  ['02-Områden/hälsa/x.md', 'hälsa'],
  ['05-Dagligt/2026-10-01-morgonbrief.md', 'Dagligt'],
];

describe('D-4/Story 11.5 AK 6: R5 på funktionsnivå', () => {
  it('K22 (AK 6): privatKalla känner igen varje post i PRIVATA i varje form som en läsare, URL-tolken eller Obsidian läser som sökvägen, och släpper det som inte är privat', async () => {
    // Varje post i PRIVATA har ett exempel: en post utan fall fäller provet.
    expect(Object.keys(PRIVATA_FALL).sort()).toEqual([...dokumentet.PRIVATA].sort());
    const missade: string[] = [];
    for (const rel of Object.values(PRIVATA_FALL)) {
      // De tretton formerna och, ur granskningsfynd 2 och 3, de former som en läsare eller URL-tolken läser
      // som sökvägen fast texten inte är den.
      for (const [form, ref] of [...privataFormer(rel), ...lastaFormer(rel)]) {
        if (dokumentet.privatKalla(ref) !== true) missade.push(`${rel} (${form}): ${JSON.stringify(ref)}`);
      }
    }
    expect(missade).toEqual([]);

    // Motexemplen, som de är, de två dokumenten som https-adress, motexemplen i formerna ur granskningsfynd 2
    // och 3, och fri text där inget led är en privat post.
    const motformer = INTE_PRIVATA.flatMap((rel) =>
      lastaFormer(rel)
        .filter(([form]) => MOTFORMER.includes(form))
        .map(([, ref]) => ref),
    );
    const motexempel = [
      ...INTE_PRIVATA,
      ...INTE_PRIVATA.slice(0, 2).map((rel) => `https://example.com/fil/${ledvis(rel)}`),
      ...motformer,
      ...INTE_PRIVAT_TEXT,
    ];
    expect(motformer).toHaveLength(INTE_PRIVATA.length * MOTFORMER.length);
    expect(motexempel.filter((ref) => dokumentet.privatKalla(ref) !== false).map((ref) => JSON.stringify(ref))).toEqual([]);

    // Kontroll för granskningsfynd 2 och 3: delningen före rättelsen missar tabben, blanksteget sist och
    // wikilänken, som privatKalla känner igen, och URL-tolken lägger den privata sökvägen i ett href.
    for (const ref of ['https://example.com/fil/jo\turnal/2026-10-01.md', 'jag.md ', '[[journal/2026-10-01]]']) {
      expect([gammalDelning(ref), dokumentet.privatKalla(ref)], JSON.stringify(ref)).toEqual([false, true]);
    }
    expect(sakerUrl('https://example.com/fil/jo\turnal/2026-10-01.md')).toBe('https://example.com/fil/journal/2026-10-01.md');

    // VITLISTA är de fem katalogerna som förut, och /vy/dok svarar samma innehållslösa 404 för de privata.
    expect([...dokumentet.VITLISTA].map((k) => k.normalize('NFC'))).toEqual(
      ['01-Projekt', '02-Områden/ledningsgrupp', '02-Områden/hermes', '02-Områden/linear-arkiv', '03-Resurser'].map(
        (k) => k.normalize('NFC'),
      ),
    );
    for (const [rel, katalog] of PRIVATA_DOKUMENT) {
      const svar = await request(app).get(`/vy/dok/${ledvis(rel)}`);
      expect(svar.status, rel).toBe(404);
      expect(svar.text, rel).toContain('utanför vyns dokumentområde');
      expect(svar.text, rel).not.toContain(katalog);
    }

    // Kontroll: en jämförelse som inte avkodar missar den dubbelkodade formen, som privatKalla känner igen.
    const rak = (ref: string): boolean => Object.values(PRIVATA_FALL).some((rel) => ref.includes(rel));
    const dubbelkodad = encodeURIComponent(encodeURIComponent(PRIVATA_FALL['journal/']!));
    expect([rak(dubbelkodad), dokumentet.privatKalla(dubbelkodad)]).toEqual([false, true]);
  });
});

/** K23:s index i minnet: ett dokument med ett unikt filnamn. */
const REFINDEX: Dokumentindex = { filnamn: new Map([['avtal.md', ['01-Projekt/k-kort/avtal.md']]]) };
/** K23:s befintliga nummer: ett ärende som finns och teamet LOC. */
const REFBEFINTLIGA = { team: new Set(['LOC']), arenden: new Set(['LOC-5']) };
const LINEARADRESS = 'https://linear.app/locollabs/issue/LOC-5/k-adress';
const PRIVAT = 'Källa i ett privat område — visas inte på kortet.';
const OKAND_FORM = 'Referens i en form som kortet inte läser — visas inte på kortet.';

/**
 * Ett fall per typ i REFERENSLANK, referensen och den väntade markupen. Nycklarna ska vara exakt tabellens:
 * en typ utan fall fäller provet.
 */
const REFERENSFALL: Record<string, [unknown, string][]> = {
  arende: [
    [{ typ: 'arende', id: 'LOC-5' }, '<code>arende</code> · <a href="/vy/arende/LOC-5">LOC-5</a>'],
    [
      { typ: 'arende', id: 'LOC-99998' },
      '<code>arende</code> · <a href="/vy/sok?q=LOC-99998">LOC-99998</a> (finns inte)',
    ],
    [{ typ: 'arende', id: 'ABC-1' }, '<code>arende</code> · <code>ABC-1</code>'],
  ],
  dokument: [
    [
      { typ: 'dokument', id: '01-Projekt/k-kort/avtal.md' },
      '<code>dokument</code> · <a href="/vy/dok/01-Projekt/k-kort/avtal.md">01-Projekt/k-kort/avtal.md</a>',
    ],
    [{ typ: 'dokument', id: 'avtal.md' }, '<code>dokument</code> · <a href="/vy/dok/01-Projekt/k-kort/avtal.md">avtal.md</a>'],
    [{ typ: 'dokument', id: 'docs/k-spec.md' }, '<code>dokument</code> · <code>docs/k-spec.md</code>'],
  ],
  url: [
    [
      { typ: 'url', id: 'https://example.com/k-kalla' },
      '<code>url</code> · <a href="https://example.com/k-kalla" rel="noreferrer noopener">https://example.com/k-kalla</a>',
    ],
    [{ typ: 'url', id: LINEARADRESS }, '<code>url</code> · <a href="/vy/arende/LOC-5">LOC-5</a> (tidigare Linear-länk)'],
    [
      { typ: 'url', id: 'https://linear.app/locollabs/project/k-projekt' },
      '<code>url</code> · Linear-länk — Linear är avvecklat',
    ],
    [{ typ: 'url', id: 'javascript:alert(1)' }, '<code>url</code> · <code>javascript:alert(1)</code>'],
  ],
  mail: [[{ typ: 'mail', id: 'k-mail-1' }, '<code>mail</code> · <code>k-mail-1</code>']],
  beslut: [[{ typ: 'beslut', id: '153', version: '1' }, '<code>beslut</code> · <code>153</code> · version <code>1</code>']],
  prov: [[{ typ: 'prov', id: 'k-prov' }, '<code>prov</code> · <code>k-prov</code>']],
  commit: [[{ typ: 'commit', id: 'k-commit' }, '<code>commit</code> · <code>k-commit</code>']],
};

/** En källa med standardvärden för det som fallet inte anger. */
function kalla(falt: Record<string, unknown>): Record<string, unknown> {
  return { system: 'arenden', objekttyp: 'atagande', objekt_id: 'k-kalla', objekt_version: null, lank: null, ...falt };
}

/** Källornas fem former på J1 (AK 4) och en privat, med den väntade markupen. */
const KALLFALL: [Record<string, unknown>, string][] = [
  [kalla({ objekt_id: 'k-k1' }), '<p>Källa: <code>arenden</code> · <code>atagande</code> · <code>k-k1</code></p>'],
  [
    kalla({ objekt_id: 'k-k2', objekt_version: '2', lank: 'https://example.com/k-kalla' }),
    '<p>Källa: <code>arenden</code> · <code>atagande</code> · <code>k-k2</code> · version <code>2</code> · ' +
      '<a href="https://example.com/k-kalla" rel="noreferrer noopener">länk</a></p>',
  ],
  [
    kalla({ objekt_id: 'k-k3', lank: LINEARADRESS }),
    '<p>Källa: <code>arenden</code> · <code>atagande</code> · <code>k-k3</code> · ' +
      '<a href="/vy/arende/LOC-5">LOC-5</a> (tidigare Linear-länk)</p>',
  ],
  [
    kalla({ objekt_id: 'k-k4', lank: 'javascript:alert(1)' }),
    '<p>Källa: <code>arenden</code> · <code>atagande</code> · <code>k-k4</code> · <code>javascript:alert(1)</code></p>',
  ],
  [
    kalla({ system: 'redovisning', objekttyp: 'mail', objekt_id: 'k-k5', lank: 'https://example.com/k-mail' }),
    '<p>Källa: <code>redovisning</code> · <code>mail</code> · <code>k-k5</code></p>',
  ],
  [kalla({ system: 'valv', objekttyp: 'fil', objekt_id: 'k-k6', lank: 'https://example.com/fil/jag.md' }), `<p>Källa: ${PRIVAT}</p>`],
];

describe('D-4/Story 11.5 AK 1, 4 och 6: REFERENSLANK, referens och kallrad', () => {
  it('K23 (AK 1, AK 4, AK 6): varje typ i tabellen har ett fall, en okänd typ blir text, och en privat referens ersätts', () => {
    // Tabellen är sluten och har ett fall per typ.
    expect(Object.keys(REFERENSFALL).sort()).toEqual(Object.keys(kortmodulen.REFERENSLANK).sort());
    expect(kortmodulen.REFERENSLANK).toEqual({
      arende: 'arende',
      dokument: 'dokument',
      url: 'url',
      mail: 'mail',
      beslut: 'text',
      prov: 'text',
      commit: 'text',
    });
    expect(Object.isFrozen(kortmodulen.REFERENSLANK)).toBe(true);
    expect([kortmodulen.PRIVAT_TEXT, [...kortmodulen.MAILTYPER]]).toEqual([PRIVAT, ['mail']]);

    const fynd: string[] = [];
    for (const [typ, fall] of Object.entries(REFERENSFALL)) {
      for (const [ref, vantat] of fall) {
        const html = kortmodulen.referens(ref, REFINDEX, REFBEFINTLIGA);
        if (html !== vantat) fynd.push(`${typ}: ${JSON.stringify(ref)} gav ${html}`);
      }
    }
    expect(fynd).toEqual([]);

    // En okänd typ visas som text och utelämnas aldrig; tre felformade referenser säger att formen inte läses.
    const okand = kortmodulen.referens({ typ: 'kvitto', id: 'K-7' }, REFINDEX, REFBEFINTLIGA);
    expect(okand).toBe('<code>kvitto</code> · <code>K-7</code>');
    expect(okand).not.toContain('<a');
    for (const ref of ['en sträng', { typ: 'beslut' }, null]) {
      expect(kortmodulen.referens(ref, REFINDEX, REFBEFINTLIGA), JSON.stringify(ref)).toBe(OKAND_FORM);
    }
    // En privat referens, i id:t och i en adress, ersätts med den fasta meningen.
    for (const ref of [
      { typ: 'dokument', id: 'jag.md' },
      { typ: 'url', id: 'https://example.com/fil/journal/2026-10-01.md' },
      { typ: 'arende', id: 'LOC-5', version: '05-Dagligt/x.md' },
    ]) {
      expect(kortmodulen.referens(ref, REFINDEX, REFBEFINTLIGA), JSON.stringify(ref)).toBe(PRIVAT);
    }
    // Granskningsfynd 2 och 3: adresser som URL-tolken gör till en privat adress (tabb, radbrytning,
    // blanksteg sist, punktled) och referenser i Obsidians och en läsares form. Ingen ger ett href.
    for (const ref of [
      { typ: 'url', id: 'https://example.com/fil/jo\turnal/2026-10-01.md' },
      { typ: 'url', id: 'https://example.com/fil/05-Dag\nligt/x.md' },
      { typ: 'url', id: 'https://example.com/fil/jag.md ' },
      { typ: 'url', id: 'https://example.com/fil/k-led/../.git/config' },
      { typ: 'dokument', id: '[[journal/2026-10-01]]' },
      { typ: 'dokument', id: 'jag' },
      { typ: 'dokument', id: 'Källa: jag.md' },
    ]) {
      expect(kortmodulen.referens(ref, REFINDEX, REFBEFINTLIGA), JSON.stringify(ref)).toBe(PRIVAT);
    }
    for (const lank of [
      'https://example.com/fil/jo\turnal/2026-10-01.md',
      'https://example.com/fil/05-Dag\nligt/x.md',
      'https://example.com/fil/jag.md ',
      ' https://example.com/fil/.obsidian/workspace.json',
      'https://example.com/fil/k-led/../02-Omr%C3%A5den/h%C3%A4lsa/x.md',
    ]) {
      expect(kortmodulen.kallrad(kalla({ lank }), REFBEFINTLIGA), JSON.stringify(lank)).toBe(`<p>Källa: ${PRIVAT}</p>`);
    }
    // Kontroll: URL-tolken tar bort blanksteget sist och löser upp punktledet, så ett href hade gått dit.
    expect(sakerUrl('https://example.com/fil/jag.md ')).toBe('https://example.com/fil/jag.md');
    expect(sakerUrl('https://example.com/fil/k-led/../.git/config')).toBe('https://example.com/fil/.git/config');

    // Källorna: länk bara för en http(s)-adress som inte går till Linear, numret för Linear, aldrig för mail.
    const kallfynd: string[] = [];
    for (const [k, vantat] of KALLFALL) {
      const html = kortmodulen.kallrad(k, REFBEFINTLIGA);
      if (html !== vantat) kallfynd.push(`${String(k.objekt_id)} gav ${html}`);
      if (/href="javascript:/i.test(html)) kallfynd.push(`${String(k.objekt_id)}: href med javascript:`);
    }
    expect(kallfynd).toEqual([]);

    // Under insamlingen samlas numret ur en ärendereferens och en Linear-källa, men inte ur en privat.
    const kandidater = arendekandidater((u) => {
      kortmodulen.referens({ typ: 'arende', id: 'LOC-77' }, REFINDEX, u);
      kortmodulen.referens({ typ: 'arende', id: 'journal/LOC-78' }, REFINDEX, u);
      kortmodulen.kallrad(kalla({ lank: 'https://linear.app/locollabs/issue/LOC-79/k' }), u);
    });
    expect(kandidater).toEqual(['LOC-77', 'LOC-79']);
  });
});

/** K24:s index i minnet: tre unika filnamn, kunddokumentets spegel och ett tvetydigt namn. */
const DOKINDEX: Dokumentindex = {
  filnamn: new Map<string, string[]>([
    ['avtal.md', ['01-Projekt/k-kort/avtal.md']],
    ['k-unik.md', ['01-Projekt/k-kort/k-unik.md']],
    ['k_avtal.md', ['03-Resurser/kunddokument/K Kund/K_avtal.md']],
    ['k-dubbel.md', ['01-Projekt/k-dubbel.md', '03-Resurser/k-dubbel.md']],
  ]),
};
/** Inget ärende finns, men teamet gör det: ett nummer blir aldrig en ärendelänk i K24. */
const INGA_BEFINTLIGA = { team: new Set(['LOC']), arenden: new Set<string>() };

/** De tio texterna och antalet dokumentposter som var och en ger. */
const DOKTEXTER: [string, string, number][] = [
  ['wikilänk', 'Se [[01-Projekt/k-kort/avtal]].', 1],
  ['wikilänk med alias', 'Se [[02-Områden/ledningsgrupp/k-kort-plan|planen]].', 1],
  ['full sökväg', 'Se 01-Projekt/k-kort/avtal.md här.', 1],
  ['rent filnamn med en träff', 'Se k-unik.md här.', 1],
  ['kunddokumentets originalnamn med spegel', 'Se K_avtal.docx här.', 1],
  ['tvetydigt filnamn', 'Se k-dubbel.md här.', 0],
  ['ej vitlistad sökväg', 'Se docs/k-spec.md här.', 0],
  ['privat sökväg', 'Se journal/2026-10-01.md här.', 0],
  ['sökväg i kod inline', 'Se `01-Projekt/k-kort/avtal.md` här.', 1],
  ['sökväg i kursiv med understreck', 'Se _01-Projekt/k-kort/avtal.md_ här.', 1],
];

/** Dokumentsidans adresser i en markup, sorterade och utan dubbletter. */
function dokumentlankarI(html: string): string[] {
  return [...new Set([...html.matchAll(/href="(\/vy\/dok\/[^"]*)"/g)].map((m) => m[1]!))].sort();
}

/** Dokumentposternas adresser, sorterade, som renderaren skriver dem. */
function postlankar(poster: { slag: string; rel?: string }[]): string[] {
  return poster.flatMap((p) => (p.slag === 'dokument' ? [esc(markdownen.dokUrl(p.rel!))] : [])).sort();
}

/** Läsningen av markdown.ts: kroppen från funktionens rad till nästa rad som börjar med `}`. */
function funktionskroppen(text: string, namn: string): string | null {
  const rader = text.split('\n');
  const start = rader.findIndex((r) => r.startsWith(`export function ${namn}(`));
  if (start === -1) return null;
  const slut = rader.findIndex((r, i) => i > start && r.startsWith('}'));
  return rader.slice(start, slut === -1 ? rader.length : slut + 1).join('\n');
}

/** Fynden i dokumentreferensernas kropp: ett eget mönster, eller ingen körning av renderingen. */
function egetMonster(kropp: string): string[] {
  const fynd: string[] = [];
  if (kropp.includes('RegExp')) fynd.push('RegExp');
  const kod = kropp
    .split('\n')
    .filter((r) => !/^\s*(\/\/|\/\*|\*)/.test(r))
    .join('\n');
  if (/(^|[=(,:!&|?;{}\s])\/(?![/*\s])(?:\\.|[^/\\\n])+\/[dgimsuy]*/.test(kod)) fynd.push('reguljärt uttryck');
  if (!kropp.includes('rendera(')) fynd.push('anropar inte rendera(');
  return fynd;
}

describe('D-3/Story 11.5 AK 5: dokumentreferenserna är autolänkarens egna', () => {
  it('K24 (AK 5): varje dokumentlänk i renderarens utdata är en post, och tvärtom, för tio texter', () => {
    const fynd: string[] = [];
    for (const [namn, text, antal] of DOKTEXTER) {
      const html = renderaArendetext(text, DOKINDEX, INGA_BEFINTLIGA);
      const poster = markdownen.dokumentreferenser((u) => renderaArendetext(text, DOKINDEX, u));
      const lankar = dokumentlankarI(html);
      if (JSON.stringify(lankar) !== JSON.stringify(postlankar(poster))) {
        fynd.push(`${namn}: länkarna ${JSON.stringify(lankar)}, posterna ${JSON.stringify(poster)}`);
      }
      if (postlankar(poster).length !== antal) fynd.push(`${namn}: ${postlankar(poster).length} dokumentposter`);
    }
    expect(fynd).toEqual([]);

    // Den privata texten ger en privat post och ingen dokumentpost; samma dokument två gånger ger en post.
    const privat = DOKTEXTER.find(([namn]) => namn === 'privat sökväg')![1];
    expect(markdownen.dokumentreferenser((u) => renderaArendetext(privat, DOKINDEX, u))).toEqual([{ slag: 'privat' }]);
    const tvaGanger = 'Se 01-Projekt/k-kort/avtal.md och [[01-Projekt/k-kort/avtal]].';
    expect(markdownen.dokumentreferenser((u) => renderaArendetext(tvaGanger, DOKINDEX, u))).toEqual([
      { slag: 'dokument', rel: '01-Projekt/k-kort/avtal.md' },
    ]);
    // Spegeln är kunddokumentets sökväg, och renderaren länkar dit.
    const spegel = DOKTEXTER.find(([namn]) => namn === 'kunddokumentets originalnamn med spegel')![1];
    expect(markdownen.dokumentreferenser((u) => renderaArendetext(spegel, DOKINDEX, u))).toEqual([
      { slag: 'dokument', rel: '03-Resurser/kunddokument/K Kund/K_avtal.md' },
    ]);

    // Statiskt: mönsterkonstanterna står en gång, och dokumentreferensernas kropp har inget eget mönster.
    const kallan = readFileSync(path.join(ROT, 'src/http/vy/markdown.ts'), 'utf8');
    expect(['WIKI', 'SOKVAG', 'FILNAMN'].map((namn) => kallan.split(`const ${namn} `).length - 1)).toEqual([1, 1, 1]);
    const kropp = funktionskroppen(kallan, 'dokumentreferenser');
    expect(kropp, 'dokumentreferenser finns').not.toBeNull();
    expect(egetMonster(kropp!)).toEqual([]);

    // Kontroll: likhetsprövningen fäller en påhittad lista utan wikilänkens dokument, och läsningen fäller en
    // påhittad kropp med ett eget mönster.
    const wiki = renderaArendetext(DOKTEXTER[0]![1], DOKINDEX, INGA_BEFINTLIGA);
    expect(dokumentlankarI(wiki)).not.toEqual(postlankar([]));
    expect(
      egetMonster(['export function dokumentreferenser(text) {', '  return [...text.matchAll(/\\[\\[x\\]\\]/g)];', '}'].join('\n')),
    ).toEqual(['reguljärt uttryck', 'anropar inte rendera(']);
    expect(egetMonster('export function dokumentreferenser(rendera) {\n  rendera(new RegExp(WIKI));\n}')).toEqual(['RegExp']);
  });
});

// ---- Story 11.5, Uppgift 3: Åtagande, Beslut och Insatser på kortet ---------------------------------------

/** Ärendena i K25 med sina titlar, i lägenas ordning och sist ärendet utan åtagande. */
const ATAGANDEKORT: [string, string][] = [
  ['ag_reg', 'K registrerat åtagande'],
  ['h', 'K huvudärendet'],
  ['ag_hind', 'K hindrat åtagande'],
  ['ag_genom', 'K genomfört åtagande'],
  ['ag_avsl', 'K avslutat åtagande'],
  ['tom', 'K tomt ärende'],
];

/** Åtagandet som get_atagande ger det: tiderna som ISO-text och jsonb-datan. */
type Atagandesvar = {
  revision: number;
  foljs_upp: string | null;
  overtaget_nar: string | null;
  data: { resultat?: { kontrollerat: string } };
};

describe('D-3/Story 11.5 AK 2: åtagandet på kortet', () => {
  it('K25 (AK 2): åtagandets fem lägen och ärendet utan, med varje delfält ordagrant', async () => {
    const fore = await raknaRader('events');
    // Motkontroll först: sidorna svarar 200 med rubriken för ärendet, före och efter koden.
    const falten: Record<string, string> = {};
    for (const [namn, titel] of ATAGANDEKORT) {
      const html = await sida(A[namn]!);
      expect(html).toContain(`<h1>${A[namn]} — ${titel}</h1>`);
      falten[namn] = falt(html, 'atagande');
    }
    const svar = async (namn: string): Promise<Atagandesvar> =>
      (await steg(hermes, 'get_atagande', { identifier: A[namn] })) as Atagandesvar;

    // Registrerat: läget och tillhörigheten, uppföljningen och revisionen, utfallet och preciseringen,
    // grunden med ärendelänken och nummeruppslaget, nästa steg och båda villkoren med sina fem delar.
    const reg = await svar('ag_reg');
    const nasta =
      '<div class=text><b>Nästa steg (internt):</b> Bygg klart</div>' +
      '<p>Nästa stegs grund: <code>beslut</code> · <code>153</code> · version <code>1</code></p>';
    for (const rad of [
      '<p>Läge: registrerat · tillhör Hermes</p>',
      `<p>Följs upp: ${datumtid(new Date(reg.foljs_upp!))}</p><p>Revision: ${reg.revision}</p>`,
      '<div class=text><b>Utfall:</b> K registrerat åtagande</div>',
      '<div class=text><b>Precisering:</b> K preciseringen av utfallet</div>',
      `<p>Grund: <code>arende</code> · <a href="/vy/arende/${A.n1}">${A.n1}</a>; ` +
        '<code>arende</code> · <a href="/vy/sok?q=LOC-99998">LOC-99998</a> (finns inte)</p>',
      nasta,
      '<div class=text><b>Villkor 1:</b> K villkoret som är okänt</div>' +
        '<p>Villkorets källa: <code>beslut</code> · <code>9301</code></p>' +
        '<div class=text><b>Gäller:</b> K gäller hela året</div>' +
        '<div class=text><b>Kontroll:</b> K kontrolleras i december</div><p>Utfall: okänt</p>',
      '<div class=text><b>Villkor 2:</b> K villkoret som är uppfyllt</div>' +
        '<p>Villkorets källa: <code>beslut</code> · <code>9302</code></p>' +
        '<div class=text><b>Gäller:</b> K gäller till hösten</div>' +
        '<div class=text><b>Kontroll:</b> K kontrolleras i augusti</div><p>Utfall: uppfyllt</p>' +
        '<p>Villkorets belägg: <code>prov</code> · <code>k-villkor-belagg</code></p>',
    ]) {
      expect(falten.ag_reg, rad).toContain(rad);
    }
    expect(falten.ag_reg).not.toContain('Utförare:');
    expect(lagestext(falten.ag_reg!)).toBeNull();

    // Övertaget: utföraren med proveniens och när den tog över, och grunden av typen beslut.
    const h = await svar('h');
    expect(falten.h).toContain('<p>Läge: övertaget · tillhör Hermes</p>');
    expect(falten.h).toContain(
      `<p>Utförare: ${proveniens('manniska', 'david')} · tog över ${datumtid(new Date(h.overtaget_nar!))}</p>`,
    );
    expect(falten.h).toContain(`<p>Följs upp: ${datumtid(new Date(h.foljs_upp!))}</p><p>Revision: ${h.revision}</p>`);
    expect(falten.h).toContain('<p>Grund: <code>beslut</code> · <code>153</code> · version <code>1</code></p>');
    expect(falten.h).toContain(nasta);

    // Hindrat: orsaken och hindrets belägg.
    expect(falten.ag_hind).toContain('<p>Läge: hindrat · tillhör Hermes</p>');
    expect(falten.ag_hind).toContain(
      '<div class=text><b>Hinder:</b> K orsaken till hindret</div>' +
        '<p>Hindrets belägg: <code>beslut</code> · <code>9303</code></p>',
    );

    // Genomfört: utföraren, resultatet med båda beläggen och kontrolltiden ordagrant, ingen uppföljning.
    const genom = await svar('ag_genom');
    expect(falten.ag_genom).toContain('<p>Läge: genomfört · tillhör Hermes</p>');
    expect(falten.ag_genom).toContain(`<p>Utförare: ${proveniens('manniska', 'david')} · tog över `);
    expect(falten.ag_genom).toContain(
      '<div class=text><b>Resultat:</b> K sammanfattningen av resultatet</div>' +
        '<p>Resultatets belägg: <code>prov</code> · <code>k-resultat-prov</code>; ' +
        '<code>commit</code> · <code>k-resultat-commit</code></p>' +
        `<p>Kontrollerat: ${genom.data.resultat!.kontrollerat}</p>`,
    );
    expect(falten.ag_genom).not.toContain('Följs upp:');

    // Avslutat: avslutsskälet och dess grund.
    expect(falten.ag_avsl).toContain('<p>Läge: avslutat · tillhör Hermes</p>');
    expect(falten.ag_avsl).toContain(
      '<div class=text><b>Avslutsskäl:</b> K skälet till avslutet</div>' +
        '<p>Avslutsskälets grund: <code>beslut</code> · <code>9304</code></p>',
    );

    // Utan åtagande: lägestexten.
    expect(lagestext(falten.tom!)).toBe(TEXT.atagande);

    // Länken till det befintliga ärendet och nummeruppslaget svarar.
    for (const lank of [`/vy/arende/${A.n1}`, '/vy/sok?q=LOC-99998']) {
      expect((await request(app).get(lank)).status, lank).toBe(200);
    }
    expect(await raknaRader('events')).toBe(fore);
  });
});

describe('D-3/Story 11.5 AK 3: besluten på kortet', () => {
  it('K26 (AK 3): kopplade beslut med svarsversionerna, en version för ett okopplat beslut, och beslutstexten som lucka', async () => {
    // Motkontroll först: sidorna svarar 200 med rubriken för ärendet.
    const html = await sida(A.beslut!);
    expect(html).toContain(`<h1>${A.beslut} — K beslut och svar</h1>`);
    const tom = await sida(A.tom!);
    expect(tom).toContain(`<h1>${A.tom} — K tomt ärende</h1>`);

    const kd = await withTransaction((client) => hamtaArendekort(client, TENANT_ID, A.beslut!, () => []));
    const kopplad = (id: number): string => datumtid(kd.beslut.find((b) => b.beslut_id === id)!.kopplad);
    const tillampad = (hash: string): string => datumtid(kd.svarsversioner.find((v) => v.svar_hash === hash)!.tillampad);
    const beslut = falt(html, 'beslut');
    expect(beslut).toContain(
      '<h2>Beslut (2)</h2>' +
        `<p>beslut #54 · kopplat ${kopplad(54)}</p>` +
        `<p>svarsversion 1 · tillämpad ${tillampad(HASH_54_V1)}</p>` +
        `<p>svarsversion med hashen <code>${HASH_54.slice(0, 12)}</code> · tillämpad ${tillampad(HASH_54)}</p>` +
        `<p>beslut #60 · kopplat ${kopplad(60)}</p>` +
        '<p>beslut #61 · inte kopplat till ärendet (koppla_beslut)</p>' +
        `<p>svarsversion med hashen <code>${HASH_61.slice(0, 12)}</code> · tillämpad ${tillampad(HASH_61)}</p>` +
        `<p class=summering>${TEXT.beslutstext}</p></section>`,
    );
    expect(lagestext(beslut)).toBeNull();

    // Utan beslut: lägestexten och antalet noll.
    const ingen = falt(tom, 'beslut');
    expect(ingen).toContain('<h2>Beslut (0)</h2>');
    expect(lagestext(ingen)).toBe(TEXT.beslut);

    // Funktionsnivå: utan kopplat beslut men med en version står versionen som det som ändå lästes, och efter
    // den raden om beslutets text och Davids svar (granskningsfynd 6; K36 prövar klassen).
    const utanKoppling = kortmodulen.beslutLage([], [{ beslut_id: 61, version: null, svar_hash: HASH_61, tillampad: new Date(NU) }]);
    expect(utanKoppling).toEqual({
      lage: 'inga',
      text: TEXT.beslut,
      delvis:
        '<p>beslut #61 · inte kopplat till ärendet (koppla_beslut)</p>' +
        `<p>svarsversion med hashen <code>${HASH_61.slice(0, 12)}</code> · tillämpad ${datumtid(new Date(NU))}</p>` +
        `<p class=summering>${TEXT.beslutstext}</p>`,
    });
  });
});

describe('D-3/Story 11.5 AK 4: insatserna och svaret på kortet', () => {
  it('K27 (AK 4): fyra insatser i sina lägen med källorna, och svaret ordagrant med den som svarade', async () => {
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet.
    const html = await sida(A.ins!);
    expect(html).toContain(`<h1>${A.ins} — K fyra insatser</h1>`);
    const kd = await withTransaction((client) => hamtaArendekort(client, TENANT_ID, A.ins!, () => []));
    const j2 = kd.insatser.find((i) => i.id === I.j2)!;
    const insatser = falt(html, 'insatser');
    expect(insatser).toContain('<h2>Insatser (4)</h2>');
    for (const rad of [
      '<h3>ägarbeslut · väntande · tillhör ägaren</h3>',
      '<h3>ägarbeslut · svar mottaget · tillhör ägaren</h3>',
      '<h3>ägarbeslut · uppskjuten · tillhör ägaren</h3>',
      '<h3>ägarbeslut · återkallad · tillhör ägaren</h3>',
      `<p>Insats <code>${I.j1}</code> · registrerad `,
      '<div class=text><b>Utfall:</b> Riktningen är vald och arbetet kan fortsätta</div>',
      '<div class=text><b>Begärd handling:</b> Välj mellan A och B</div>',
      '<div class=text><b>Blockeringsgrund:</b> Tidigare besked avgör inte valet</div>',
      '<div class=text><b>Blockeringsgrund:</b> Tidigare besked avgör inte valet\nUppskjuten: K väntar på underlaget</div>',
      '<div class=text><b>Blockeringsgrund:</b> Tidigare besked avgör inte valet\nÅterkallad: K inte längre aktuell</div>',
      `<p>Frist: ${datumtid(new Date(FRIST_J1))}</p>`,
      `<p>Väckningstid: ${datumtid(new Date(VACKNING_J3))}</p>`,
      '<p>Belägg: <code>beslut</code> · <code>9401</code></p>',
      '<p>Handlingskontrakt: <code>hermes</code> · <code>beslutskoe --besvara</code> · <code>#153</code></p>',
      '<p>Källa: <code>arenden</code> · <code>atagande</code> · <code>k-ins-k1</code></p>',
      '<p>Källa: <code>arenden</code> · <code>atagande</code> · <code>k-ins-k2</code> · ' +
        '<a href="https://example.com/k-kalla" rel="noreferrer noopener">länk</a></p>',
      '<p>Källa: <code>arenden</code> · <code>atagande</code> · <code>k-ins-k3</code> · ' +
        `<a href="/vy/arende/${A.n1}">${A.n1}</a> (tidigare Linear-länk)</p>`,
      '<p>Källa: <code>arenden</code> · <code>atagande</code> · <code>k-ins-k4</code> · <code>javascript:alert(1)</code></p>',
      '<p>Källa: <code>redovisning</code> · <code>mail</code> · <code>k-ins-k5</code></p>',
      `<div class=text><b>Svar:</b> ${esc(SVARET)}</div>`,
      `<p>Svarat av ${proveniens('manniska', 'david')} ${datumtid(j2.svar_nar!)} · ` +
        `källa: svar på insats ${I.j2}, version 2</p>`,
    ]) {
      expect(insatser, rad).toContain(rad);
    }
    // Svaret står escapat med radbrytningen kvar, och inget skript och ingen javascript:-länk uppstår.
    expect(esc(SVARET)).toContain('\nandra raden');
    expect(insatser).not.toContain('<script');
    expect(insatser).not.toMatch(/href\s*=\s*["']?\s*javascript:/i);
    expect(lagestext(insatser)).toBeNull();

    // Utan insatser: lägestexten och antalet noll.
    const tom = falt(await sida(A.tom!), 'insatser');
    expect(tom).toContain('<h2>Insatser (0)</h2>');
    expect(lagestext(tom)).toBe(TEXT.insatser);
  });
});

describe('D-3/Story 11.5 AK 9: escaping och läsning', () => {
  it('K28 (AK 9): tecknen <script>, " och & står escapade i åtagandet och insatserna, och ingen visning skriver', async () => {
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet.
    const html = await sida(A.fultkort!);
    expect(html).toContain(`<h1>${A.fultkort} — K fult kort</h1>`);
    expect(oescapat(html)).toEqual([]);
    expect(html).not.toContain('<script');
    const atagandet = falt(html, 'atagande');
    expect(atagandet).toContain(`<div class=text><b>Nästa steg (internt):</b> ${esc(FULT)}</div>`);
    expect(atagandet).toContain(`<div class=text><b>Villkor 1:</b> ${esc(FULT)}</div>`);
    const insatserna = falt(html, 'insatser');
    expect(insatserna).toContain(`<div class=text><b>Utfall:</b> ${esc(FULT)}</div>`);
    expect(insatserna).toContain(`<code>${esc(FULT)}</code>`);

    // Ingen GET skriver: tre sidor visade två gånger var.
    const fore = await raknaRader('events');
    for (const identifier of [A.ag_reg!, A.beslut!, A.ins!]) {
      for (let n = 0; n < 2; n++) expect((await request(app).get(`/vy/arende/${identifier}`)).status, identifier).toBe(200);
    }
    expect(await raknaRader('events')).toBe(fore);
  });
});

// ---- Story 11.5, Uppgift 4: Dokument och underlag, Mail och R5 på kortet -----------------------------------

/** Länken till dokumentsidan som kortet skriver den: adressen ur dokUrl och sökvägen som länktext. */
function dokumentlank(rel: string, text = rel): string {
  return `<a href="${esc(markdownen.dokUrl(rel))}">${esc(text)}</a>`;
}

describe('D-3/Story 11.5 AK 5: dokument och underlag på kortet', () => {
  it('K29 (AK 5): dokumenten i texterna en gång var med platserna, bilagorna och spegeln, eller saknas-texten', async () => {
    const fore = await raknaRader('events');
    // Motkontroll först: sidorna svarar 200 med rubriken för ärendet.
    const html = await sida(A.dok!);
    expect(html).toContain(`<h1>${A.dok} — K dokument och underlag</h1>`);
    const dok2 = await sida(A.dok2!);
    expect(dok2).toContain(`<h1>${A.dok2} — K dokument utan spegel</h1>`);

    // Avtalet en gång, nämnt i beskrivningen och i kommentaren med skribentens proveniens; planen och
    // kunddokumentets spegel ur beskrivningen; två bilagor; spegeln i valvet.
    const kd = await withTransaction((client) => hamtaArendekort(client, TENANT_ID, A.dok!, () => []));
    const kommentaren = kd.kommentarer[0]!;
    const avtal = '01-Projekt/k-kort/avtal.md';
    const spegel = `02-Områden/linear-arkiv/${A.dok}.md`;
    const falten = falt(html, 'dokument');
    expect(falten).toContain('<h2>Dokument och underlag</h2>');
    for (const rad of [
      `<p>${dokumentlank(avtal)} · nämns i beskrivningen · i kommentar ${datumtid(kommentaren.skapad)} av ` +
        `${proveniens('agent', 'hermes')}</p>`,
      `<p>${dokumentlank('02-Områden/ledningsgrupp/k-kort-plan.md')} · nämns i beskrivningen</p>`,
      `<p>${dokumentlank('03-Resurser/kunddokument/K Kund/K_avtal.md')} · nämns i beskrivningen</p>`,
      '<h3>Bilagor (2)</h3><ul class=lista role=list>',
      `<p>${dokumentlank(spegel, 'Spegeln i valvet')} · ${spegel}</p>`,
    ]) {
      expect(falten, rad).toContain(rad);
    }
    expect(falten.split(esc(markdownen.dokUrl(avtal))).length - 1).toBe(1);
    expect(falten.split('<li class=rad>').length - 1).toBe(2);
    expect(lagestext(falten)).toBeNull();
    // Varje länk till dokumentsidan i fältet svarar 200.
    const lankar = [...falten.matchAll(/href="(\/vy\/dok\/[^"]*)"/g)].map((m) => m[1]!);
    expect(lankar).toHaveLength(4);
    for (const lank of lankar) expect((await request(app).get(lank)).status, lank).toBe(200);

    // Utan spegel: det som ändå lästes, avtalets rad, står före notisen med ärendets eget nummer.
    const utanSpegel = falt(dok2, 'dokument');
    expect(utanSpegel).toContain(`<p>${dokumentlank(avtal)} · nämns i beskrivningen</p>`);
    expect(lagestext(utanSpegel)).toBe(spegeltext(A.dok2!));
    expect(utanSpegel.indexOf(avtal)).toBeLessThan(utanSpegel.indexOf('<p class=notis>'));

    // Utan något: dokumentdelens mening, bilagornas mening och spegeltexten.
    const tom = falt(await sida(A.tom!), 'dokument');
    expect(tom).toContain(
      `<p>${TEXT.ingaDokument}</p><h3>Bilagor (0)</h3><p>${TEXT.bilagor}</p>` +
        `<p class=notis>${spegeltext(A.tom!)}</p></section>`,
    );
    expect(await raknaRader('events')).toBe(fore);
  });
});

/**
 * K30: var en privat sökväg står i en markup, i klartext, kodad, ledvis kodad eller som obsidian-formens
 * kodade värde. Tom lista = ingen av sökvägarna står där.
 */
function privataTraffar(html: string): string[] {
  const fynd: string[] = [];
  for (const rel of Object.values(PRIVATA_FALL)) {
    const former: [string, string][] = [
      ['klartext', rel],
      ['kodad', encodeURIComponent(rel)],
      ['ledvis kodad', ledvis(rel)],
      ['obsidian-formens värde', `file=${encodeURIComponent(rel.replace(/\.md$/, ''))}`],
    ];
    for (const [form, text] of former) if (html.includes(text)) fynd.push(`${rel} (${form})`);
  }
  // Granskningsfynd 2 och 3: bärarna i PRIVATA_TRASIGA som de står, och wikilänkens mål.
  for (const del of TRASIGA_DELAR) if (html.includes(del)) fynd.push(`${JSON.stringify(del)} (som bäraren står)`);
  return fynd;
}

describe('D-4/Story 11.5 AK 6: R5 på kortet', () => {
  it('K30 (AK 6): inget fält utom kommentarens egen text nämner eller länkar en privat sökväg', async () => {
    const fore = await raknaRader('events');
    // Motkontroll först: sidan svarar 200, och kommentarens text står kvar med sökvägarna som text, utan
    // länk till dokumentsidan.
    const html = await sida(A.privat!);
    expect(html).toContain(`<h1>${A.privat} — K privata källor</h1>`);
    const kommentarer = falt(html, 'kommentarer');
    for (const rel of Object.values(PRIVATA_FALL)) expect(kommentarer, rel).toContain(rel);
    expect(kommentarer).not.toContain('/vy/dok/');

    // Den fasta meningen: sex gånger i åtagandets grund och tre för PRIVATA_TRASIGA, tolv och tre i insatsens
    // källor, och i Dokument och underlag för kommentaren, de sex bilagorna och två ur PRIVATA_TRASIGA. Mail har
    // ingen referens på ärendet.
    const antal = (avsnitt: string): number => avsnitt.split(PRIVAT).length - 1;
    expect({
      atagande: antal(falt(html, 'atagande')),
      insatser: antal(falt(html, 'insatser')),
      dokument: antal(falt(html, 'dokument')),
      mail: lagestext(falt(html, 'mail')),
    }).toEqual({
      atagande: 6 + PRIVATA_TRASIGA.grund.length,
      insatser: 12 + PRIVATA_TRASIGA.lankar.length,
      dokument: 7 + PRIVATA_TRASIGA.bilagor.length,
      mail: TEXT.mail,
    });

    // Kortet utom fältet Kommentarer nämner ingen av sökvägarna i någon form, och dokumentsidan svarar 404.
    const kortet = kortdelen(html).replace(kommentarer, '');
    expect(privataTraffar(kortet)).toEqual([]);
    for (const [rel] of PRIVATA_DOKUMENT) {
      expect((await request(app).get(`/vy/dok/${ledvis(rel)}`)).status, rel).toBe(404);
    }

    // Kontroll: samma sökning i hela sidan, med Kommentarer kvar, hittar varje sökväg, och sökningen hittar
    // varje bärare ur PRIVATA_TRASIGA som den står.
    const hela = privataTraffar(html);
    for (const rel of Object.values(PRIVATA_FALL)) {
      expect(hela.some((t) => t.startsWith(`${rel} (`)), rel).toBe(true);
    }
    for (const del of TRASIGA_DELAR) expect(privataTraffar(`<code>x ${del} y</code>`), JSON.stringify(del)).not.toEqual([]);
    expect(await raknaRader('events')).toBe(fore);
  });
});

/** Står en länk i markupen? Mail får aldrig någon. */
function harLank(html: string): boolean {
  return html.includes('<a');
}

describe('D-4/Story 11.5 AK 7: mail bara som referens', () => {
  it('K31 (AK 7): mailreferenserna som «mail · id» utan länk, luckan utan referenser, och privata mailreferenser ersätts', async () => {
    // Motkontroll först: sidan svarar 200 med rubriken för ärendet.
    const html = await sida(A.mail!);
    expect(html).toContain(`<h1>${A.mail} — K mailreferenser</h1>`);
    const kd = await withTransaction((client) => hamtaArendekort(client, TENANT_ID, A.mail!, () => []));
    const insatsen = kd.insatser[0]!.id;
    const mail = falt(html, 'mail');
    expect(mail).toContain(
      '<h2>Mail</h2><p>mail · <code>k-mail-1</code> · i åtagandet</p>' +
        `<p>mail · <code>k-mail-2</code> · på insats <code>${insatsen}</code></p>` +
        `<p class=summering>${TEXT.mailrad}</p></section>`,
    );
    expect(harLank(mail)).toBe(false);

    // Utan mailreferenser: luckan, utan länk.
    const tom = falt(await sida(A.tom!), 'mail');
    expect(lagestext(tom)).toBe(TEXT.mail);
    expect(harLank(tom)).toBe(false);

    // Funktionsnivå: en privat mailreferens i åtagandets grund och en mailkälla med ett privat objekt-id.
    const lage = kortmodulen.mailLage(
      {
        lage: 'registrerat',
        tillhor: 'hermes',
        utforare_typ: null,
        utforare_namn: null,
        overtaget_nar: null,
        foljs_upp: null,
        revision: 1,
        data: { grund: [{ typ: 'mail', id: 'journal/2026-10-01.md' }], nasta: INTERNT, villkor: [] },
      },
      [
        {
          id: 'k-mailinsats',
          belagg: [],
          kallor: [{ system: 'redovisning', objekttyp: 'mail', objekt_id: 'jag.md', objekt_version: null, lank: null }],
        },
      ],
    );
    expect(lage.lage).toBe('varde');
    const innehall = lage.lage === 'varde' ? lage.html : '';
    expect(innehall).toContain(`<p>${PRIVAT} · i åtagandet</p>`);
    expect(innehall).toContain(`<p>${PRIVAT} · på insats <code>k-mailinsats</code></p>`);
    expect(harLank(innehall)).toBe(false);
    expect([innehall.includes('journal/2026-10-01.md'), innehall.includes('jag.md')]).toEqual([false, false]);

    // Kontroll: länkprövningen fäller en påhittad mailrad med en länk.
    expect(harLank('<p>mail · <a href="https://example.com/k-mail">k-mail-1</a> · i åtagandet</p>')).toBe(true);
  });
});

// ---- Story 11.5, Uppgift 5: inga nya åtkomster ----------------------------------------------------------

/** Det som kortets modul och läsmodellen aldrig gör: hämtar, läser en fil eller läser miljön. Kommentarer räknas. */
const ATKOMSTER: [string, RegExp][] = [
  ['fetch(', /\bfetch\(/],
  ['readFile', /readFile/],
  ['process.env', /process\.env/],
];

/** Fynden i en källtext: en av formerna ovan, eller en importsats ur konfigurationen eller ett node:-paket. */
function atkomstfel(text: string): string[] {
  const fel = ATKOMSTER.filter(([, monster]) => monster.test(text)).map(([namn]) => namn);
  for (const sats of text.match(/^import\b[^;]+;/gm) ?? []) {
    const kalla = /['"]([^'"]+)['"];$/.exec(sats)?.[1] ?? '';
    if (kalla.startsWith('node:') || /(^|\/)config\.js$/.test(kalla)) fel.push(`importerar ${kalla}`);
  }
  return fel;
}

/** EnvSchema:s nycklar, avskrivna när provet skrevs: berättelsen lägger ingen konfigurationsvariabel. */
const MILJONYCKLAR = [
  'NODE_ENV',
  'PORT',
  'HOST',
  'DATABASE_URL',
  'DATABASE_ADMIN_URL',
  'RATE_LIMIT_PER_MINUTE',
  'VAULT_PATH',
  'CRM_KONF_PATH',
  'VY_PUBLIK_URL',
  'ARENDEN_API_URL',
  'ARENDEN_API_KEY',
];

describe('D-4/Story 11.5 AK 8: inga nya åtkomster', () => {
  it('K32 (AK 8) (R): kortet och läsmodellen hämtar inget, läser ingen fil och ingen miljö, och konfigurationen är oförändrad', () => {
    for (const fil of ['src/http/vy/kort.ts', 'src/services/arendekort.ts']) {
      expect(atkomstfel(readFileSync(path.join(ROT, fil), 'utf8')), fil).toEqual([]);
    }
    expect(Object.keys(EnvSchema.shape).sort()).toEqual([...MILJONYCKLAR].sort());

    // Kontroll: hjälparen fäller en påhittad hämtning, en import ur node:fs/promises och en ur konfigurationen.
    expect(atkomstfel('const svar = await fetch(adress);')).toEqual(['fetch(']);
    expect(atkomstfel("import { readFile } from 'node:fs/promises';\n")).toEqual([
      'readFile',
      'importerar node:fs/promises',
    ]);
    expect(atkomstfel("import { config } from '../../config.js';\n")).toEqual(['importerar ../../config.js']);
  });
});

// ---- Story 11.5, ur code-review: varje väg in, mailens rubrik, beslutstexten, delar i fel form och bärarna ----

/** Ett fälts markup i varje läge: värdet, eller det som ändå lästes och lägestexten. */
function lagesmarkup(lage: { lage: string; html?: string; text?: string; delvis?: string | null }): string {
  return lage.lage === 'varde' ? (lage.html ?? '') : `${lage.delvis ?? ''}<p class=notis>${esc(lage.text)}</p>`;
}

/** Ett åtagande på funktionsnivå med jsonb-datan `data`. */
function atagandeobjekt(data: unknown): Record<string, unknown> {
  return {
    lage: 'registrerat',
    tillhor: 'hermes',
    utforare_typ: null,
    utforare_namn: null,
    overtaget_nar: null,
    foljs_upp: null,
    revision: 1,
    data,
  };
}

/** En insats på funktionsnivå med standardvärden för det som fallet inte anger. */
function insatsobjekt(falt: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'k-funktionsinsats',
    typ: 'agarbeslut',
    tillhor: 'agare',
    lage: 'vantande',
    frist: null,
    vackningstid: null,
    utfall: 'K utfallet',
    begard_handling: 'K den begärda handlingen',
    blockeringsgrund: 'K blockeringsgrunden',
    belagg: [],
    version: 1,
    handlingskontrakt: { system: 'arenden', kommando: 'beslutskoe --besvara', objekt: '#153' },
    svar_text: null,
    svar_aktor: null,
    svar_nar: null,
    skapad: new Date(NU),
    kallor: [],
    ...falt,
  };
}

/** K34:s privata sökväg och ett vitlistat dokument vars sökväg har ett privat led. */
const BARARPRIVAT = 'journal/2026-10-01.md';
const HEMLIGT_INDEX: Dokumentindex = { filnamn: new Map([['k-hemlig.md', ['01-Projekt/journal/k-hemlig.md']]]) };

/** Fynden för en bärare: den fasta meningen saknas, eller sökvägen står kvar. Tom lista = rätt. */
function bararfynd(namn: string, html: string): string[] {
  const fynd: string[] = [];
  if (!html.includes(PRIVAT)) fynd.push(`${namn}: ingen fast mening`);
  if (/journal|k-hemlig/.test(html)) fynd.push(`${namn}: sökvägen står kvar`);
  return fynd;
}

describe('D-4/Story 11.5 AK 6: varje väg in frågar privatKalla', () => {
  it('K34 (AK 6): varje bärare som visar en referens, en källa, ett kontrakt, en bilaga, en mailreferens eller ett dokument ersätter en privat sökväg', () => {
    const fall: [string, string][] = [];
    // referens(): typen, id:t, versionen och dokumentmålet som id:t slås upp till.
    for (const [namn, ref] of [
      ['referensens typ', { typ: BARARPRIVAT, id: 'k-1' }],
      ['referensens id', { typ: 'beslut', id: BARARPRIVAT }],
      ['referensens version', { typ: 'beslut', id: 'k-1', version: BARARPRIVAT }],
      ['referensens dokumentmål', { typ: 'dokument', id: 'k-hemlig.md' }],
    ] as const) {
      fall.push([namn, kortmodulen.referens(ref, HEMLIGT_INDEX, REFBEFINTLIGA)]);
    }
    // kallrad(): vart och ett av källans fem fält.
    for (const f of ['system', 'objekttyp', 'objekt_id', 'objekt_version', 'lank']) {
      fall.push([`källans ${f}`, kortmodulen.kallrad(kalla({ [f]: BARARPRIVAT }), REFBEFINTLIGA)]);
    }
    // Handlingskontraktets rad i insatserLage(): system, kommando och objekt, var för sig.
    for (const d of ['system', 'kommando', 'objekt']) {
      const kontrakt = { system: 'arenden', kommando: 'beslutskoe --besvara', objekt: '#153', [d]: BARARPRIVAT };
      const html = lagesmarkup(kortmodulen.insatserLage([insatsobjekt({ handlingskontrakt: kontrakt })], INDEX, REFBEFINTLIGA));
      fall.push([`handlingskontraktets ${d}`, html]);
      expect(html, d).toContain(`<p>Handlingskontrakt: ${PRIVAT}</p>`);
    }
    // Bilageraden i dokumentLage(): adressen, titeln och undertiteln, var för sig med neutrala andra fält.
    // Ruttens rad bär bilagans fält, så att en rad som inte ersätts syns i fynden.
    for (const [f, bilaga] of [
      ['adress', { url: `https://example.com/fil/${BARARPRIVAT}`, titel: 'K neutral bilaga', undertitel: null }],
      ['titel', { url: 'https://example.com/k-neutral', titel: `Ur ${BARARPRIVAT}`, undertitel: null }],
      ['undertitel', { url: 'https://example.com/k-neutral', titel: 'K neutral bilaga', undertitel: BARARPRIVAT }],
    ] as const) {
      const rad = `<li class=rad><div class=huvud>${esc(bilaga.titel)} ${esc(bilaga.url)}</div><div class=text>${esc(bilaga.undertitel)}</div></li>`;
      const html = lagesmarkup(kortmodulen.dokumentLage({ identifier: 'LOC-1', description: '' }, [], [bilaga], [rad], INDEX));
      fall.push([`bilagans ${f}`, html]);
      expect(html, f).toContain(`<li class=rad><div class=huvud><span>${PRIVAT}</span></div></li>`);
    }
    // mailrad() i mailLage(): mailreferensens id och rubrik i åtagandet, ett mailbelägg och en mailkällas objekt-id.
    fall.push([
      'mailreferensens id',
      lagesmarkup(kortmodulen.mailLage(atagandeobjekt({ grund: [{ typ: 'mail', id: BARARPRIVAT }] }), [])),
    ]);
    fall.push([
      'mailreferensens rubrik',
      lagesmarkup(
        kortmodulen.mailLage(atagandeobjekt({ grund: [{ typ: 'mail', id: 'k-mail-r', rubrik: `Ur ${BARARPRIVAT}` }] }), []),
      ),
    ]);
    fall.push([
      'mailbelägget på en insats',
      lagesmarkup(kortmodulen.mailLage(null, [insatsobjekt({ belagg: [{ typ: 'mail', id: BARARPRIVAT }] })])),
    ]);
    fall.push([
      'mailkällans objekt-id',
      lagesmarkup(kortmodulen.mailLage(null, [insatsobjekt({ kallor: [kalla({ objekttyp: 'mail', objekt_id: BARARPRIVAT })] })])),
    ]);
    // dokumentreferenser() genom dokumentLage(): ett mål som är privat, och ett vitlistat mål vars sökväg har
    // ett privat led.
    for (const [namn, beskrivning] of [
      ['dokumentets mål', `Se ${BARARPRIVAT} här.`],
      ['dokumentets sökväg', 'Se k-hemlig.md här.'],
    ] as const) {
      fall.push([
        namn,
        lagesmarkup(kortmodulen.dokumentLage({ identifier: 'LOC-1', description: beskrivning }, [], [], [], HEMLIGT_INDEX)),
      ]);
    }

    expect(fall).toHaveLength(4 + 5 + 3 + 3 + 4 + 2);
    expect(fall.flatMap(([namn, html]) => bararfynd(namn, html))).toEqual([]);

    // Kontroll: fynden fäller en rad där sökvägen står kvar och en rad utan den fasta meningen.
    expect(bararfynd('påhittad', `<p>${PRIVAT}</p><p>${BARARPRIVAT}</p>`)).toEqual(['påhittad: sökvägen står kvar']);
    expect(bararfynd('påhittad', '<p>Källa: <code>valv</code></p>')).toEqual(['påhittad: ingen fast mening']);
  });
});

describe('D-4/Story 11.5 AK 7: mailens rubrik', () => {
  it('K35 (AK 7): en mailreferens som själv bär en rubrik visar den escapad och utan länk, och utan rubrik står raden som förut', () => {
    const lage = kortmodulen.mailLage(
      atagandeobjekt({
        grund: [
          { typ: 'mail', id: 'k-mail-r1', rubrik: `K offerten ${FULT}` },
          { typ: 'mail', id: 'k-mail-r2', rubrik: 7 },
          { typ: 'mail', id: 'k-mail-r3', rubrik: '  ' },
          { typ: 'mail', id: 'k-mail-r4' },
        ],
      }),
      [
        insatsobjekt({
          id: 'k-mailinsats',
          belagg: [{ typ: 'mail', id: 'k-mail-r5', rubrik: 'K svaret på offerten' }],
          kallor: [kalla({ system: 'redovisning', objekttyp: 'mail', objekt_id: 'k-mail-r6' })],
        }),
      ],
    );
    expect(lage.lage).toBe('varde');
    const html = lagesmarkup(lage);
    for (const rad of [
      `<p>mail · <code>k-mail-r1</code> · ${esc(`K offerten ${FULT}`)} · i åtagandet</p>`,
      '<p>mail · <code>k-mail-r2</code> · i åtagandet</p>',
      '<p>mail · <code>k-mail-r3</code> · i åtagandet</p>',
      '<p>mail · <code>k-mail-r4</code> · i åtagandet</p>',
      '<p>mail · <code>k-mail-r5</code> · K svaret på offerten · på insats <code>k-mailinsats</code></p>',
      '<p>mail · <code>k-mail-r6</code> · på insats <code>k-mailinsats</code></p>',
      `<p class=summering>${TEXT.mailrad}</p>`,
    ]) {
      expect(html, rad).toContain(rad);
    }
    expect(harLank(html)).toBe(false);
    expect(oescapat(html)).toEqual([]);
    // Kontroll: rubriken står bara där referensen bär en som text.
    expect(html.split(' · K ').length - 1).toBe(2);
  });
});

describe('D-3/Story 11.5 AK 3: beslutstexten står efter varje beslut som visas', () => {
  it('K36 (AK 3): raden om beslutets text och Davids svar står en gång efter besluten, kopplade eller inte, och inte utan beslut', () => {
    const tid = new Date(NU);
    const kopplat = [{ beslut_id: 71, kopplad: tid }];
    const okopplat = [{ beslut_id: 72, version: 1, svar_hash: HASH_61, tillampad: tid }];
    const summering = `<p class=summering>${TEXT.beslutstext}</p>`;
    const fall: [string, ReturnType<typeof kortmodulen.beslutLage>, number][] = [
      ['ett kopplat beslut', kortmodulen.beslutLage(kopplat, []), 1],
      ['bara en version för ett okopplat beslut', kortmodulen.beslutLage([], okopplat), 1],
      ['ett kopplat och ett okopplat', kortmodulen.beslutLage(kopplat, okopplat), 1],
      ['inget beslut', kortmodulen.beslutLage([], []), 0],
    ];
    for (const [namn, lage, antal] of fall) {
      const html = lagesmarkup(lage);
      expect(html.split(summering).length - 1, namn).toBe(antal);
      // Raden står efter det sista beslutet som visas.
      if (antal > 0) expect(html.indexOf(summering), namn).toBeGreaterThan(html.lastIndexOf('<p>beslut #'));
    }
    expect(fall.map(([, lage]) => lage.lage)).toEqual(['varde', 'inga', 'varde', 'inga']);
  });
});

/** Raden för en del i fel form (Dev Notes → Texterna har ingen; texten följer OKAND_FORM). */
const OKAND_DEL = 'Uppgift i en form som kortet inte läser — visas inte på kortet.';

describe('D-3/Story 11.5 AK 2 och 4: en del i fel form tappas aldrig i tysthet', () => {
  it('K37 (AK 2 och AK 4): varje del av åtagandet och insatsen som finns men har fel form står med sin etikett och raden om formen', () => {
    const fel = (etikett: string): string => `<p>${etikett}: ${OKAND_DEL}</p>`;
    const villkor = (n: number): Record<string, unknown> => ({
      text: `K villkor ${n}`,
      kalla: GRUND,
      galler: 'K gäller',
      kontroll: 'K kontroll',
      utfall: 'okant',
    });
    const fall: [string, unknown, string[]][] = [
      ['uppgifterna är inget objekt', 'en text', [fel('Åtagandets uppgifter')]],
      [
        'varje del i fel form',
        {
          utfall_precisering: 42,
          grund: { typ: 'beslut', id: '1' },
          nasta: 'i morgon',
          villkor: [villkor(1), 'inte ett villkor', { ...villkor(3), utfall: 'kanske' }],
          hinder: ['inte', 'ett', 'objekt'],
          resultat: { sammanfattning: 'K resultatet', belagg: 'inte en lista', kontrollerat: 7 },
          avslutsskal: 3,
        },
        [
          fel('Precisering'),
          fel('Grund'),
          fel('Nästa steg'),
          '<div class=text><b>Villkor 1:</b> K villkor 1</div>',
          fel('Villkor 2'),
          '<div class=text><b>Villkor 3:</b> K villkor 3</div>',
          fel('Utfall'),
          fel('Hinder'),
          '<div class=text><b>Resultat:</b> K resultatet</div>',
          fel('Resultatets belägg'),
          fel('Kontrollerat'),
          fel('Avslutsskäl'),
        ],
      ],
      [
        'villkoren är ingen lista och nästa stegs slag är okänt',
        { nasta: { handling: 'K nästa', slag: 'snart', grund: GRUND }, villkor: { text: 'K ensamt villkor' } },
        ['<div class=text><b>Nästa steg:</b> K nästa</div>', fel('Nästa stegs slag'), fel('Villkor')],
      ],
    ];
    const fynd: string[] = [];
    for (const [namn, data, rader] of fall) {
      const html = lagesmarkup(kortmodulen.atagandeLage({ title: 'K titeln' }, atagandeobjekt(data), INDEX, REFBEFINTLIGA));
      for (const rad of rader) if (!html.includes(rad)) fynd.push(`${namn}: ${rad}`);
    }
    // Insatsen: belägg som inte är en lista, ett kontrakt som inte är ett objekt och ett med en del som inte är text.
    for (const [namn, falt, rad] of [
      ['belägg', { belagg: { typ: 'beslut', id: '1' } }, fel('Belägg')],
      ['kontrakt', { handlingskontrakt: 'beslutskoe --besvara' }, fel('Handlingskontrakt')],
      ['kontraktets del', { handlingskontrakt: { system: 'arenden', kommando: 5, objekt: '#1' } }, fel('Handlingskontrakt')],
    ] as const) {
      const html = lagesmarkup(kortmodulen.insatserLage([insatsobjekt(falt)], INDEX, REFBEFINTLIGA));
      if (!html.includes(rad)) fynd.push(`insatsens ${namn}: ${rad}`);
    }
    expect(fynd).toEqual([]);

    // Kontroll: ett åtagande och en insats i rätt form har ingen rad om formen.
    const ratt = lagesmarkup(
      kortmodulen.atagandeLage(
        { title: 'K titeln' },
        atagandeobjekt({ grund: [GRUND], nasta: INTERNT, villkor: villkoren(2) }),
        INDEX,
        REFBEFINTLIGA,
      ),
    );
    expect(ratt).toContain('<div class=text><b>Villkor 2:</b> K villkor 2</div>');
    expect(ratt).not.toContain(OKAND_DEL);
    expect(lagesmarkup(kortmodulen.insatserLage([insatsobjekt({})], INDEX, REFBEFINTLIGA))).not.toContain(OKAND_DEL);
  });
});

/** Ett åtagandes jsonb med referensen ref(namn) i varje bärare i REFERENSBARARE, i bärarens form. */
function dataMedReferenser(ref: (namn: string) => unknown): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const b of arendekortet.REFERENSBARARE) {
    const namn = arendekortet.bararnamn(b);
    const varde = b.form === 'lista' ? [ref(namn)] : ref(namn);
    if (b.del === null) {
      data[b.nyckel] = varde;
      continue;
    }
    const fore = data[b.del.nyckel] as Record<string, unknown> | Record<string, unknown>[] | undefined;
    const del = (Array.isArray(fore) ? fore[0] : fore) ?? {};
    del[b.nyckel] = varde;
    data[b.del.nyckel] = b.del.form === 'lista' ? [del] : del;
  }
  return data;
}

describe('D-4/Story 11.5 AK 1, 2 och 7: den slutna listan över åtagandets referensbärare', () => {
  it('K38 (AK 1, AK 2 och AK 7): varje bärare i REFERENSBARARE visas i Åtagande, står i Mail och räknas av mätningen under sitt namn', async () => {
    const namn = arendekortet.REFERENSBARARE.map((b) => arendekortet.bararnamn(b));
    expect(namn).toEqual([
      'grund',
      'nasta.grund',
      'villkor.kalla',
      'villkor.belagg',
      'hinder.belagg',
      'resultat.belagg',
      'avslutsskal.grund',
    ]);

    // Funktionsnivå: ett åtagande med en mailreferens i varje bärare, byggt ur listan. Åtagande visar var och
    // en exakt en gång och i rätt form, och Mail listar var och en.
    const data = dataMedReferenser((n) => ({ typ: 'mail', id: `kb-${n}` }));
    const atagandet = lagesmarkup(kortmodulen.atagandeLage({ title: 'K titeln' }, atagandeobjekt(data), INDEX, REFBEFINTLIGA));
    const mail = lagesmarkup(kortmodulen.mailLage(atagandeobjekt(data), []));
    const fynd: string[] = [];
    for (const n of namn) {
      if (atagandet.split(`<code>mail</code> · <code>kb-${n}</code>`).length - 1 !== 1) fynd.push(`Åtagande: ${n}`);
      if (!mail.includes(`<p>mail · <code>kb-${n}</code> · i åtagandet</p>`)) fynd.push(`Mail: ${n}`);
    }
    expect(fynd).toEqual([]);
    expect([atagandet.includes(OKAND_DEL), atagandet.includes(OKAND_FORM)]).toEqual([false, false]);

    // I databasen: ärenden med en referens av typen kb-<bärare> i varje bärare, genom actions. Mätningen räknar
    // varje sådan typ under exakt sin bärare, och kortet visar den i fältet Åtagande.
    const mat = (): Promise<Matning> =>
      withTransaction(async (client) => {
        await client.query('SET TRANSACTION READ ONLY');
        return arendekortet.matReferenstyper(client, TENANT_ID);
      });
    const revisionen = async (identifier: string): Promise<number> =>
      (await steg(hermes, 'get_atagande', { identifier })).revision as number;
    const ref = (n: string): Record<string, string> => ({ typ: `kb-${n}`, id: `k-${n}` });
    const fore = matkarta(await mat());

    const reg = await nytt('K bärarna i registreringen');
    await steg(hermes, 'registrera_atagande', {
      identifier: reg,
      grund: [ref('grund')],
      nasta: { handling: 'K nästa steg', slag: 'internt', grund: ref('nasta.grund') },
      foljs_upp: UPPFOLJNING,
      villkor: [
        {
          text: 'K villkoret',
          kalla: ref('villkor.kalla'),
          galler: 'K gäller',
          kontroll: 'K kontroll',
          utfall: 'uppfyllt',
          belagg: ref('villkor.belagg'),
        },
      ],
    });
    const hind = await nytt('K bäraren i hindret');
    await atagande(hind);
    await steg(hermes, 'hindra_atagande', {
      identifier: hind,
      orsak: 'K orsaken',
      belagg: ref('hinder.belagg'),
      nasta: INTERNT,
      foljs_upp: UPPFOLJNING,
      forvantad_revision: await revisionen(hind),
    });
    const genom = await nytt('K bäraren i resultatet');
    await atagande(genom);
    await steg(david, 'ta_over_atagande', {
      identifier: genom,
      nasta: INTERNT,
      foljs_upp: UPPFOLJNING,
      forvantad_revision: await revisionen(genom),
    });
    await steg(hermes, 'redovisa_resultat', {
      identifier: genom,
      sammanfattning: 'K sammanfattningen',
      belagg: [ref('resultat.belagg')],
      forvantad_revision: await revisionen(genom),
    });
    const avsl = await nytt('K bäraren i avslutet');
    await atagande(avsl);
    await steg(hermes, 'avsluta_atagande', {
      identifier: avsl,
      text: 'K skälet',
      grund: ref('avslutsskal.grund'),
      forvantad_revision: await revisionen(avsl),
    });

    const delta = skillnad(fore, matkarta(await mat()));
    const kb = Object.fromEntries(Object.entries(delta).filter(([nyckel]) => nyckel.split('\t')[2]?.startsWith('kb-')));
    expect(kb).toEqual(Object.fromEntries(namn.map((n) => [`referens\t${n}\tkb-${n}`, 1])));

    const pa: Record<string, string> = {
      grund: reg,
      'nasta.grund': reg,
      'villkor.kalla': reg,
      'villkor.belagg': reg,
      'hinder.belagg': hind,
      'resultat.belagg': genom,
      'avslutsskal.grund': avsl,
    };
    expect(Object.keys(pa).sort()).toEqual([...namn].sort());
    for (const n of namn) {
      expect(falt(await sida(pa[n]!), 'atagande'), n).toContain(`<code>kb-${n}</code> · <code>k-${n}</code>`);
    }
  });
});
