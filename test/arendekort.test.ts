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
import { readFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { withTransaction } from '../src/db/tx.js';
import { createApp } from '../src/http/app.js';
import { crmAnrop, nollstallCrmCache } from '../src/http/vy/crm.js';
import type { Dokumentindex } from '../src/http/vy/dokument.js';
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
import { datumtid, esc, proveniens } from '../src/http/vy/mall.js';
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
import { hamtaKundkoppling, sattKundkoppling } from '../src/services/kundkoppling.js';
import { kravTeam, stateAvTyp } from '../src/services/team.js';
import { TEST_CRM_KONF } from './env.js';
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

const GRUND = { typ: 'beslut', id: '153', version: '1' };
const INTERNT = { handling: 'Bygg klart', slag: 'internt', grund: GRUND };

// AK 8: tecknen <script>, " och & i varje bärare.
const FULT = '<script>alert(1)</script> "citat" & co';
const FULT_TITEL = `K fult ärende ${FULT}`;
const FULT_PROJEKT = `K-fult ${FULT}`;
const FULT_ETIKETT = `K-fult ${FULT}`;
const FULT_FORALDER = `K fult förälder ${FULT}`;
const FULT_DEL = `K fult delärende ${FULT}`;
const FULT_MOTPART = `K fult motpart ${FULT}`;
const FULT_NAMNARE = `K fult nämnare ${FULT}`;

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
/** Insatserna på huvudärendet: I1 väntande, I2 uppskjuten och I3 återkallad. */
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
};

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
  bilagor: { varde: () => [A.h!, 'K bilaga'], tomt: () => [A.tom!, TEXT.bilagor] },
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
    const bilagor = KORTFALT.find((f) => f.id === 'bilagor')!;
    expect(renderaFalt(beskrivning, varde('<p>värdet</p>'), 0)).toBe(
      '<section id="falt-beskrivning"><h2>Beskrivning</h2><p>värdet</p></section>',
    );
    for (const lage of ['inga', 'saknas', 'finns_inte', 'kunde_inte'] as const) {
      expect(renderaFalt(bilagor, tomt(lage, 'a < b & "c"'), 3), lage).toBe(
        '<section id="falt-bilagor"><h2>Bilagor (3)</h2><p class=notis>a &lt; b &amp; &quot;c&quot;</p></section>',
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
    expect(falt(h, 'bilagor')).toContain('<h2>Bilagor (1)</h2><ul class=lista role=list>');
    expect(falt(h, 'bilagor')).toContain('K bilaga');
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
      bilagor: lagestext(falt(tom, 'bilagor')),
      foralder: lagestext(falt(tom, 'foralder')),
      delarenden: lagestext(falt(tom, 'delarenden')),
      relationer: lagestext(falt(tom, 'relationer')),
    }).toEqual({
      beskrivning: TEXT.beskrivning,
      bilagor: TEXT.bilagor,
      foralder: TEXT.foralder,
      delarenden: TEXT.delarenden,
      relationer: TEXT.relationer,
    });
    expect(tom).toContain('<h2>Bilagor (0)</h2>');
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

/** KORTFALT efter Story 11.4, ordagrant och i ordning. */
const SEXTON = [
  'frist', 'agare', 'projekt', 'kund', 'uppdrag', 'ursprung', 'beskrivning', 'bilagor',
  'foralder', 'delarenden', 'relationer', 'namner', 'namns-i', 'dubbletter', 'kommentarer', 'historik',
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
    expect(KORTFALT.map((f) => f.id)).toEqual(SEXTON);
    // Motkontroll först: sidorna svarar 200 med rubriken för ärendet.
    const tom = await sida(A.tom!);
    const full = await sida(A.full!);
    expect(tom).toContain(`<h1>${A.tom} — K tomt ärende</h1>`);
    expect(full).toContain(`<h1>${A.full} — K fullt ärende</h1>`);

    const lagestexter = new Set([
      ...Object.entries(TEXT).filter(([nyckel]) => nyckel !== 'kundInternt').map(([, text]) => text),
      namnsIInga(A.tom!),
      namnsIInga(A.full!),
    ]);
    const fynd: string[] = [];
    const tommaPaFull: string[] = [];
    for (const [namn, html] of [['tom', tom], ['full', full]] as const) {
      for (const id of SEXTON) {
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
    expect(SEXTON.filter((id) => lagestext(falt(tom, id)) === null).sort()).toEqual(['historik', 'ursprung']);

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
    expect([...new Set(klasser)].sort()).toEqual(['lista', 'notis', 'summering']);

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

/** Aktörsnamnen som står utanför ett proveniensmärke. Tom lista = varje aktör bär sitt märke. */
function aktorerUtanMarke(html: string): string[] {
  const utan = html.replace(PROVENIENSMARKE, '');
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
