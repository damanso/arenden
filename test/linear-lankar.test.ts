import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { nollstallIndex } from '../src/http/vy/dokument.js';
import { esc } from '../src/http/vy/mall.js';
import {
  AVVECKLAD_LINEAR_LANK,
  linearAdress,
  TIDIGARE_LINEAR_LANK,
} from '../src/http/vy/markdown.js';
import { TEST_VAULT } from './env.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

// FR-37, B-14 (Story 2.3 AK 1–5): Linear är avvecklat, och en adress vars värd är
// linear.app eller en underdomän blir aldrig en utåtlänk i vyn. Med ett ärendenummer i
// sökvägen blir den en intern länk till ärendet, utan nummer ren text med metan.
//
// Omskrivningen sker bara vid visning. Provet jämför därför databasen och valvet före och
// efter att sidorna har visats (F9), i stället för att lita på att ingen skriver.
//
// Målärendets nummer läses ur svaret och skrivs aldrig in. Story 11.2 skickar ett nummer
// som inte finns till nummeruppslaget, och provet ska förbli grönt då utan att ändras.
//
// Adresslistan i F1, bilagorna i fixturen och sidorna i sidor() är slutna listor: provet
// söker aldrig igenom en adress efter ordet Linear och försöker inte känna igen alla
// tänkbara sidor (Dev Notes → Avgränsade kriterier).

let app: Express;
let agent: string;
/** Målärendet, {M} i berättelsen: varje Linear-adress med nummer bär det. */
let malnummer: string;
/** Ärendet som bär de elva bilagorna. */
let bilagenummer: string;
/** Ärendet vars beskrivning och kommentar bär markdownlänkarna (Uppgift 3). */
let textnummer: string;

/** Kör en åtgärd, kräver 200 och ger svarets result. */
async function steg(action: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const svar = await kor(app, agent, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result as Record<string, unknown>;
}

/** Bilagornas avsnitt på ärendesidan: från rubriken till första </ul> därefter. */
function bilagorna(html: string): string {
  const start = html.indexOf('<h2>Bilagor (');
  if (start === -1) throw new Error('bilagornas rubrik saknas på sidan');
  const slut = html.indexOf('</ul>', start);
  return html.slice(start, slut === -1 ? html.length : slut);
}

/** Den enda bilageraden som bär titeln mellan '>' och '<'. */
function bilagerad(html: string, titel: string): string {
  const rader = bilagorna(html)
    .split('<li class=rad>')
    .slice(1)
    .map((bit) => `<li class=rad>${bit.slice(0, bit.indexOf('</li>') + '</li>'.length)}`);
  const traffar = rader.filter((rad) => rad.includes(`>${titel}<`));
  if (traffar.length !== 1) throw new Error(`${traffar.length} bilagerader bär titeln ${titel}`);
  return traffar[0]!;
}

const ENTITETER: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

/** Värdar som räknas som Linears: linear.app eller en underdomän, utan avslutande punkt. */
function arLinearvard(vard: string): boolean {
  const utan = vard.toLowerCase().replace(/\.$/, '');
  return utan === 'linear.app' || utan.endsWith('.linear.app');
}

/**
 * Varje href på sidan vars värd är Linears, och varje href som provet inte kan läsa: ett
 * värde utan dubbla citattecken eller ett som URL-tolken inte tolkar.
 */
function linearHrefs(html: string): string[] {
  const fynd: string[] = [];
  for (const m of html.matchAll(/href=/gi)) {
    const start = m.index + m[0].length;
    if (html[start] !== '"') {
      const slut = html.indexOf('>', start);
      fynd.push(`utan citattecken: ${html.slice(start, slut === -1 ? html.length : slut)}`);
      continue;
    }
    const slut = html.indexOf('"', start + 1);
    const ra = html.slice(start + 1, slut === -1 ? html.length : slut);
    const varde = ra.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITETER[e]!);
    let vard: string;
    try {
      vard = new URL(varde, 'http://f23.invalid/').hostname;
    } catch {
      fynd.push(`går inte att tolka: ${ra}`);
      continue;
    }
    if (arLinearvard(vard)) fynd.push(ra);
  }
  return fynd;
}

/** Bilagorna på bilageärendet, i den ordning de läggs till (Dev Notes → Provfilens uppbyggnad). */
function bilagelistan(): { titel: string; url: string; undertitel?: string }[] {
  const m = malnummer;
  return [
    { titel: 'F23 med nummer', url: `https://linear.app/locollabs/issue/${m}/f23-malet`, undertitel: 'F23 undertitel' },
    { titel: 'F23 utan nummer', url: 'https://linear.app/locollabs/project/f23-projektet' },
    { titel: 'F23 värd www', url: `https://www.linear.app/locollabs/issue/${m}/www` },
    { titel: 'F23 värd uploads', url: 'https://uploads.linear.app/f23/bild.png' },
    { titel: 'F23 versaler', url: `https://LINEAR.APP/locollabs/issue/${m}/versaler` },
    { titel: 'F23 schema http', url: `http://linear.app/locollabs/issue/${m}/http` },
    { titel: 'F23 avslutande punkt', url: `https://linear.app./locollabs/issue/${m}/punkt` },
    { titel: 'F23 användarnamn', url: `https://f23@linear.app/locollabs/issue/${m}/anvandare` },
    { titel: 'F23 notlinear', url: 'https://notlinear.app/f23' },
    { titel: 'F23 example', url: 'https://linear.app.example.com/f23' },
    { titel: 'F23 escapad adress', url: 'https://example.com/f23?a=1&b="2"' },
  ];
}

beforeAll(async () => {
  app = createApp();
  await seedaTeam();
  agent = await nyNyckel({ typ: 'agent', namn: 'f23 agent' });

  malnummer = String((await steg('create_issue', { team_key: 'LOC', title: 'F23 målet f23linear' })).identifier);
  bilagenummer = String(
    (await steg('create_issue', { team_key: 'LOC', title: 'F23 bilagorna f23linear' })).identifier,
  );
  for (const bilaga of bilagelistan()) {
    await steg('add_attachment', { identifier: bilagenummer, ...bilaga });
  }

  // Uppgift 3: samma två markdownlänkar i en beskrivning, en kommentar och ett valvdokument.
  textnummer = String(
    (await steg('create_issue', { team_key: 'LOC', title: 'F23 texterna f23linear', description: text() }))
      .identifier,
  );
  await steg('add_comment', { identifier: textnummer, body: text() });
  await mkdir(path.dirname(DOKUMENTET), { recursive: true });
  await writeFile(DOKUMENTET, doktext(), 'utf8');
  nollstallIndex();
});

/** Valvdokumentet i testvalvet; katalogen och namnet står i ingen annan provfil. */
const DOKREL = '01-Projekt/f23-linear/lankar.md';
const DOKUMENTET = path.join(TEST_VAULT, '01-Projekt', 'f23-linear', 'lankar.md');

/** Beskrivningens och kommentarens rad: en Linear-länk med nummer och en utan. */
function text(): string {
  return (
    `Se [ärendet](https://linear.app/locollabs/issue/${malnummer}/malet) och ` +
    '[inställningarna](https://linear.app/locollabs/settings/f23).'
  );
}

/** Dokumentets fyra stycken, åtskilda av en tom rad. */
function doktext(): string {
  return [
    text(),
    `Med versaler i värden [versaler](https://LINEAR.APP/locollabs/issue/${malnummer}/versaler).`,
    'Andra värdar [notlinear](https://notlinear.app/f23) och [exempel](https://linear.app.example.com/f23).',
    'En fråga [frågan](https://example.com/f23?a=1&b=2).',
  ].join('\n\n');
}

/** Bilageärendets sida, med status 200 först. */
async function bilagesidan(): Promise<string> {
  const svar = await request(app).get(`/vy/arende/${bilagenummer}`);
  expect(svar.status).toBe(200);
  return svar.text;
}

/** En bilagerad med en intern länk till målärendet, titeln och eventuellt undertiteln. */
function internRad(titel: string, undertitel?: string): string {
  return (
    `<li class=rad><div class=huvud><a href="/vy/arende/${malnummer}">${malnummer}</a>` +
    `<span>tidigare Linear-länk</span></div><div class=text>${titel}</div>` +
    (undertitel === undefined ? '' : `<div class=text>${undertitel}</div>`) +
    '</li>'
  );
}

/** En bilagerad utan länk, med metan för en avvecklad Linear-länk. */
function avveckladRad(titel: string): string {
  return `<li class=rad><div class=huvud>${titel}<span>Linear-länk — Linear är avvecklat</span></div></li>`;
}

/** Antalet förekomster av nal i text. */
function antal(text: string, nal: string): number {
  return text.split(nal).length - 1;
}

// ---- AK 3: klassningen ------------------------------------------------------------------

/** AK 3:s fallista (F1), sexton adresser med sina svar. */
const ADRESSER: [adress: string, svar: { nummer: string | null } | null][] = [
  ['https://linear.app/locollabs/issue/LOC-5/titel', { nummer: 'LOC-5' }],
  ['https://linear.app/locollabs/issue/LOC-5', { nummer: 'LOC-5' }],
  ['https://www.linear.app/locollabs/issue/LOC-5/titel', { nummer: 'LOC-5' }],
  ['https://LINEAR.APP/locollabs/issue/LOC-5/titel', { nummer: 'LOC-5' }],
  ['http://linear.app/locollabs/issue/LOC-5/titel', { nummer: 'LOC-5' }],
  ['https://linear.app./locollabs/issue/LOC-5/titel', { nummer: 'LOC-5' }],
  ['https://f23@linear.app/locollabs/issue/LOC-5', { nummer: 'LOC-5' }],
  ['https://uploads.linear.app/f23/bild.png', { nummer: null }],
  ['https://linear.app/locollabs/project/f23-projektet', { nummer: null }],
  ['https://linear.app/locollabs/issue/loc-5/titel', { nummer: null }],
  ['https://linear.app/locollabs?issue=LOC-5', { nummer: null }],
  ['https://notlinear.app/f23', null],
  ['https://linear.app.example.com/f23', null],
  ['https://example.com/linear.app/LOC-5', null],
  ['ftp://linear.app/locollabs/issue/LOC-5', null],
  ['inte en adress', null],
];

describe('FR-37/Story 2.3 AK 3: vilka värdar som räknas', () => {
  it('F1 (AK 3): linearAdress() klassar de sexton adresserna, och metatexterna är exakta', () => {
    expect(ADRESSER).toHaveLength(16);
    for (const [adress, svar] of ADRESSER) {
      if (svar === null) expect(linearAdress(adress), adress).toBeNull();
      else expect(linearAdress(adress), adress).toEqual(svar);
    }
    expect(ADRESSER.filter(([, s]) => s?.nummer === 'LOC-5')).toHaveLength(7);
    expect(ADRESSER.filter(([, s]) => s !== null && s.nummer === null)).toHaveLength(4);
    expect(ADRESSER.filter(([, s]) => s === null)).toHaveLength(5);

    expect(TIDIGARE_LINEAR_LANK).toBe('tidigare Linear-länk');
    expect(AVVECKLAD_LINEAR_LANK).toBe('Linear-länk — Linear är avvecklat');
    // esc() lämnar båda, så markdown.ts kan skriva dem som de är i redan escapad text.
    expect(esc(TIDIGARE_LINEAR_LANK)).toBe(TIDIGARE_LINEAR_LANK);
    expect(esc(AVVECKLAD_LINEAR_LANK)).toBe(AVVECKLAD_LINEAR_LANK);
  });
});

// ---- AK 1 och AK 2: bilagorna -----------------------------------------------------------

describe('FR-37/Story 2.3 AK 1 och AK 2: bilagor med och utan ärendenummer', () => {
  it('F2 (AK 1): en bilaga med ärendenummer blir en intern länk med metan, och sidan har inget href till Linear', async () => {
    // Kontrollerna: linearHrefs() fäller Linears värdar i alla former och släpper andra.
    for (const fals of [
      '<a href="https://uploads.linear.app/x">',
      '<a href="HTTPS://LINEAR.APP/y">',
      '<a href="https://linear.app./z">',
      '<a href=https://linear.app/w>',
    ]) {
      expect(linearHrefs(fals), fals).toHaveLength(1);
    }
    for (const slapp of [
      '<a href="https://notlinear.app/">',
      '<a href="/vy/arende/LOC-1">',
      '<a href="obsidian://open?vault=x&amp;file=y">',
      '<a href="https://example.com/?u=https://linear.app/x">',
    ]) {
      expect(linearHrefs(slapp), slapp).toEqual([]);
    }

    const sidan = await bilagesidan();
    expect(bilagerad(sidan, 'F23 med nummer')).toBe(internRad('F23 med nummer', 'F23 undertitel'));
    expect(linearHrefs(sidan)).toEqual([]);
  });

  it('F3 (AK 2): en bilaga utan ärendenummer blir titeln som ren text med metan, utan a-element', async () => {
    const sidan = await bilagesidan();
    const rad = bilagerad(sidan, 'F23 utan nummer');
    expect(rad).toBe(avveckladRad('F23 utan nummer'));
    expect(rad).not.toContain('<a');
  });
});

// ---- AK 3 och AK 5: värdarna och de vanliga utåtlänkarna i bilagor ----------------------

describe('FR-37/Story 2.3 AK 3 och AK 5: värdarna och de vanliga utåtlänkarna i bilagor', () => {
  it('F4 (AK 3): varje Linear-värd och schema klassas, och andra värdar är utåtlänkar som i dag', async () => {
    const sidan = await bilagesidan();
    for (const titel of [
      'F23 värd www',
      'F23 versaler',
      'F23 schema http',
      'F23 avslutande punkt',
      'F23 användarnamn',
    ]) {
      expect(bilagerad(sidan, titel), titel).toBe(internRad(titel));
    }
    expect(bilagerad(sidan, 'F23 värd uploads')).toBe(avveckladRad('F23 värd uploads'));
    expect(bilagerad(sidan, 'F23 notlinear')).toBe(
      '<li class=rad><div class=huvud><a href="https://notlinear.app/f23" rel="noopener noreferrer" ' +
        'target=_blank>F23 notlinear</a><span>notlinear.app</span></div></li>',
    );
    expect(bilagerad(sidan, 'F23 example')).toBe(
      '<li class=rad><div class=huvud><a href="https://linear.app.example.com/f23" rel="noopener noreferrer" ' +
        'target=_blank>F23 example</a><span>linear.app.example.com</span></div></li>',
    );

    expect(sidan).toContain('Bilagor (11)');
    const avsnitt = bilagorna(sidan);
    expect(antal(avsnitt, `href="/vy/arende/${malnummer}"`)).toBe(6);
    expect(antal(avsnitt, 'tidigare Linear-länk')).toBe(6);
    expect(antal(avsnitt, 'Linear-länk — Linear är avvecklat')).toBe(2);
    expect(linearHrefs(sidan)).toEqual([]);
  });

  it('F5 (AK 5): en bilaga som blir en utåtlänk går fortfarande genom sakerUrl() och sedan esc()', async () => {
    const sidan = await bilagesidan();
    const rad = bilagerad(sidan, 'F23 escapad adress');
    expect(rad).toBe(
      '<li class=rad><div class=huvud><a href="https://example.com/f23?a=1&amp;b=%222%22" ' +
        'rel="noopener noreferrer" target=_blank>F23 escapad adress</a><span>example.com</span></div></li>',
    );
    // Kontrollen: esc() av den råa adressen, utan sakerUrl(), hade gett en annan rad.
    expect(rad).not.toContain(esc('https://example.com/f23?a=1&b="2"'));
  });
});

// ---- AK 4 och AK 5: texterna, varje sida och datat -----------------------------------------

/** AK 4:s fallista (F8): elva sidor under /vy som svarar 200 utan session. */
function sidor(): string[] {
  return [
    '/vy',
    '/vy/mitt',
    '/vy/digest',
    '/vy/digest?dagar=alla',
    '/vy/sok?q=f23linear',
    `/vy/arende/${malnummer}`,
    `/vy/arende/${bilagenummer}`,
    `/vy/arende/${textnummer}`,
    `/vy/dok/${DOKREL}`,
    '/vy/rattelser',
    '/vy/logga-in',
  ];
}

/** Bilagorna, beskrivningarna, kommentarerna och antalet händelser, för jämförelse före och efter. */
async function ogonblick(): Promise<unknown[]> {
  const bilagor = await pool.query('SELECT id, titel, url, undertitel FROM issue_attachments ORDER BY id');
  const arenden = await pool.query('SELECT id, description FROM issues ORDER BY id');
  const kommentarer = await pool.query('SELECT id, body FROM comments ORDER BY id');
  return [bilagor.rows, arenden.rows, kommentarer.rows, await raknaRader('events')];
}

describe('FR-37/Story 2.3 AK 4: text i ärenden, kommentarer och dokument', () => {
  it('F6 (AK 4 och AK 3): en markdownlänk till Linear på dokumentsidan blir intern länk eller ren text', async () => {
    const svar = await request(app).get(`/vy/dok/${DOKREL}`);
    expect(svar.status).toBe(200);
    const sidan = svar.text;
    const m = malnummer;
    expect(sidan).toContain(`ärendet (<a href="/vy/arende/${m}">${m}</a>, tidigare Linear-länk)`);
    expect(sidan).toContain('inställningarna (Linear-länk — Linear är avvecklat)');
    expect(sidan).not.toContain('>inställningarna</a>');
    expect(sidan).toContain(`versaler (<a href="/vy/arende/${m}">${m}</a>, tidigare Linear-länk)`);
    expect(sidan).toContain('<a href="https://notlinear.app/f23" rel="noreferrer noopener">notlinear</a>');
    expect(sidan).toContain(
      '<a href="https://linear.app.example.com/f23" rel="noreferrer noopener">exempel</a>',
    );
    // AK 5: en markdownlänk som blir en utåtlänk är escapad som förut.
    expect(sidan).toContain('<a href="https://example.com/f23?a=1&amp;b=2" rel="noreferrer noopener">frågan</a>');
    expect(antal(sidan, `href="/vy/arende/${m}"`)).toBe(2);
    expect(linearHrefs(sidan)).toEqual([]);
  });

  it('F7 (AK 4): i beskrivningen och kommentaren är markdownlänkar text, och autolänkaren tar numret', async () => {
    const svar = await request(app).get(`/vy/arende/${textnummer}`);
    expect(svar.status).toBe(200);
    const sidan = svar.text;
    const m = malnummer;
    expect(
      antal(sidan, `[ärendet](https://linear.app/locollabs/issue/<a href="/vy/arende/${m}">${m}</a>/malet)`),
    ).toBe(2);
    expect(antal(sidan, '[inställningarna](https://linear.app/locollabs/settings/f23)')).toBe(2);
    expect(linearHrefs(sidan)).toEqual([]);
    // Kontrollen: adressen står på sidan som text, så den tomma listan betyder att den inte är ett href.
    expect(sidan).toContain('https://linear.app/locollabs/settings/f23');
  });

  it('F8 (AK 4): ingen av de elva sidorna under /vy har ett href med Linears värd', async () => {
    const fynd: string[] = [];
    const html = new Map<string, string>();
    for (const vag of sidor()) {
      const svar = await request(app).get(vag);
      if (svar.status !== 200) {
        fynd.push(`${vag}: status ${svar.status}`);
        continue;
      }
      html.set(vag, svar.text);
      for (const f of linearHrefs(svar.text)) fynd.push(`${vag}: ${f}`);
    }
    expect(sidor()).toHaveLength(11);
    expect(fynd, fynd.join('\n')).toEqual([]);

    // Kontrollen: de interna länkarna finns, så den tomma listan betyder något.
    const lank = `href="/vy/arende/${malnummer}"`;
    expect(antal(html.get(`/vy/arende/${bilagenummer}`) ?? '', lank)).toBe(6);
    // D-3 (Story 11.4): den tredje är fältet Nämner, eftersom beskrivningen och kommentaren nämner målärendet
    // genom Linear-adressen.
    expect(antal(html.get(`/vy/arende/${textnummer}`) ?? '', lank)).toBe(3);
    expect(antal(html.get(`/vy/dok/${DOKREL}`) ?? '', lank)).toBe(2);
  });
});

describe('FR-37/Story 2.3 AK 5: datat rörs inte', () => {
  it('F9 (AK 5): databasen och valvet är oförändrade efter att sidorna har visats', async () => {
    const fore = await ogonblick();
    const dokFore = await readFile(DOKUMENTET, 'utf8');

    for (const vag of sidor()) {
      const svar = await request(app).get(vag);
      expect(svar.status, vag).toBe(200);
    }

    expect(await ogonblick()).toEqual(fore);
    expect(await readFile(DOKUMENTET, 'utf8')).toBe(dokFore);
    const adresser = (fore[0] as { url: string }[]).map((b) => b.url);
    expect(adresser).toContain(`https://LINEAR.APP/locollabs/issue/${malnummer}/versaler`);

    // Kontrollen: en skrivning syns i jämförelsen.
    await steg('add_attachment', {
      identifier: malnummer,
      titel: 'F23 kontroll',
      url: `https://linear.app/locollabs/issue/${malnummer}/kontroll`,
    });
    expect(await ogonblick()).not.toEqual(fore);
  });
});

// ---- Uppgift 4: README (krav → kod → test) --------------------------------------------

const RUBRIKEN = '### FR-37 — inga utåtlänkar till Linear (Story 2.3)';
const RUBRIKEN_2_1 = '### FR-37 — statusord och händelseverb på svenska (Story 2.1)';
const REGELNS_BORJAN = '- Linear-adresser i vyn (FR-37, B-14, Story 2.3):';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN =
  '- Linear-adresser i vyn (FR-37, B-14, Story 2.3): en adress vars värd är `linear.app` eller en underdomän ' +
  'blir aldrig ett `href` i vylagret. `linearAdress()` i `src/http/vy/markdown.ts` är den enda klassningen: ' +
  'värden läses ur URL-tolkens `hostname` utan avslutande punkt, bara http och https räknas, och ärendenumret ' +
  'är det första hela segmentet i sökvägen som är `LOC-` följt av siffror. Varje ställe som bygger ett `href` ' +
  'ur en adress i data, i dag `bilageRad()` i `src/http/routes/vy.ts` och markdownlänkarna i `ersatt()` i ' +
  '`src/http/vy/markdown.ts`, frågar `linearAdress()` före sitt `href`, och ett nytt sådant ställe frågar den ' +
  'i samma diff. Med nummer blir adressen en intern länk till ärendet, skriven genom `esc()`, med metan ' +
  '«tidigare Linear-länk». Utan nummer blir den ren text med metan «Linear-länk — Linear är avvecklat». ' +
  'Omskrivningen sker bara vid visning, och data i databasen och valvet ändras aldrig för den. ' +
  '`test/linear-lankar.test.ts` läser varje sida i sin lista och fäller ett `href` med Linears värd.';

/** Avsnittets gränser: från rubriken till nästa rad som börjar med '## ' eller '### '. */
function avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/** Fynden för F10: rubriken och dess plats, regelns rad exakt en gång och tre tabellrader. */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const fel: string[] = [];
  const forra = rader.indexOf(RUBRIKEN_2_1);
  if (forra === -1 || forra > granser.start) fel.push('rubriken står före Story 2.1:s avsnitt');
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const regler = avsnitt.filter((r) => r.startsWith(REGELNS_BORJAN));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regeln avviker');
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-37'));
  if (tabell.length !== 3) fel.push(`${tabell.length} rader börjar med | FR-37`);
  for (const r of tabell) if (!r.includes('test/linear-lankar.test.ts')) fel.push(`rad utan provfilen: ${r}`);
  return fel;
}

/** Texten utan avsnittet: raderna från rubriken till nästa rubrik på nivå två eller tre tas bort. */
function utanAvsnittet(text: string): string {
  const rader = text.split('\n');
  const granser = avsnittet(rader.map((r) => r.replace(/\r$/, '')));
  if (!granser) return text;
  return [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
}

describe('FR-37/Story 2.3: README bär regeln', () => {
  it('F10 (dokumentationen): avsnittet bär regeln och tre rader krav → kod → test', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readmefel(readme)).toEqual([]);

    // Kontrollen: samma kontroll på texten utan avsnittet fälls.
    expect(readmefel(utanAvsnittet(readme))).toEqual(['rubriken saknas']);
  });
});
