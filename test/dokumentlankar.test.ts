import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { nollstallIndex } from '../src/http/vy/dokument.js';
import { TEST_VAULT } from './env.js';
import { kor, nyNyckel, seedaTeam } from './helpers.js';

// Dokumentlänkar KRAV-6: hela stacken (vitest + supertest) mot en testvault som
// speglar den riktiga — vitlistade kataloger, hemligheter utanför dem, och en
// symlink som pekar rakt ut ur vaulten.
const UTANFOR = path.join(tmpdir(), 'arenden-test-utanfor-vaulten.md');

const BESLUTSFLODE = '02-Områden/ledningsgrupp/beslutsflode.md';
const MOTESANALYS = '02-Områden/hermes/motesanalys-zeynep-2026-08-12.md';
const SPEGEL_NVR = '03-Resurser/kunddokument/Nordic Vision Retail/Konsultavtal_NVR_Locollabs.md';

/** URL till dokumentsidan, kodad som en webbläsare gör. */
function dokvag(rel: string): string {
  return `/vy/dok/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

async function skrivFil(rel: string, innehall: string): Promise<void> {
  const abs = path.join(TEST_VAULT, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, innehall, 'utf8');
}

describe('Dokumentlänkar KRAV-1..6', () => {
  let app: Express;
  let agentnyckel: string;
  /** Ärende vars beskrivning bär alla fyra referensmönstren. */
  let refererande: string;
  /** Ärende vars beskrivning bär originaländelser (.docx) — speglade och inte. */
  let kunddokument: string;

  beforeAll(async () => {
    await rm(TEST_VAULT, { recursive: true, force: true });
    await rm(UTANFOR, { force: true });

    // Vitlistat innehåll.
    await skrivFil(
      '01-Projekt/ilt/plan.md',
      [
        '---',
        'typ: plan',
        '---',
        '# ILT-planen',
        '',
        'Se [[02-Områden/ledningsgrupp/beslutsflode|beslutsflödet]] och LOC-316.',
        '',
        '- punkt med **fetstil**',
        '- punkt två',
        '',
        '```',
        "<script>alert('kod')</script>",
        '```',
        '',
        'Farligt: <script>alert("xss")</script>',
      ].join('\n'),
    );
    await skrivFil(BESLUTSFLODE, '# Beslutsflöde\n\nLedningsgruppens beslutsgång.\n');
    await skrivFil(MOTESANALYS, '# Mötesanalys Zeynep\n\nAnteckningar.\n');
    // Samma filnamn på två vitlistade ställen = tvetydigt (KRAV-3d).
    await skrivFil('01-Projekt/dubbel.md', 'ett\n');
    await skrivFil('03-Resurser/dubbel.md', 'två\n');

    // Speglade kunddokument: dokument_index.py lägger Drive-filerna som
    // 03-Resurser/kunddokument/<kund>/<stam>.md.
    await skrivFil(SPEGEL_NVR, '# Konsultavtal_NVR_Locollabs.docx\n\nSpegel av Drive-filen.\n');
    // Samma stam speglad hos TVÅ kunder = tvetydigt.
    await skrivFil(
      '03-Resurser/kunddokument/Nordic Vision Retail/Prislista_2026.md',
      'NVR:s prislista\n',
    );
    await skrivFil('03-Resurser/kunddokument/Acme AB/Prislista_2026.md', 'Acmes prislista\n');

    // Utanför vitlistan — får aldrig serveras eller bekräftas.
    await skrivFil('jag.md', 'HEMLIGT-JAG\n');
    await skrivFil('journal/2026-08-19.md', 'HEMLIGT-JOURNAL\n');
    await skrivFil('02-Områden/hälsa/prover.md', 'HEMLIGT-HALSA\n');
    await skrivFil('05-Dagligt/2026-08-07-morgonbrief.md', 'HEMLIGT-DAGLIGT\n');

    // Symlink som pekar UT ur vaulten, placerad i en vitlistad katalog.
    await writeFile(UTANFOR, 'HEMLIGT-UTANFOR\n', 'utf8');
    await symlink(UTANFOR, path.join(TEST_VAULT, '01-Projekt', 'lank-ut.md'));

    nollstallIndex();

    app = createApp();
    await seedaTeam();
    agentnyckel = await nyNyckel({ typ: 'agent', namn: 'hermes' });

    const skapat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Ärende med dokumentreferenser',
      description: [
        'Wikilänk med alias: [[02-Områden/ledningsgrupp/beslutsflode|beslutsflödet]].',
        'Wikilänk utan sökväg: [[motesanalys-zeynep-2026-08-12]].',
        'Full sökväg: 01-Projekt/ilt/plan.md.',
        'Rent filnamn: motesanalys-zeynep-2026-08-12.md.',
        'Tvetydigt filnamn: dubbel.md.',
        'Ej vitlistat: jag.md och 05-Dagligt/2026-08-07-morgonbrief.md och docs/KRAVSPEC-ETAPP-2A.md.',
        'Relaterat ärende: LOC-316.',
        'Injektion: <img src=x onerror="alert(1)">',
      ].join('\n'),
      team_key: 'LOC',
    });
    refererande = skapat.body.result.identifier;

    const kundskapat = await kor(app, agentnyckel, 'create_issue', {
      title: 'Ärende med kunddokument',
      description: [
        'Konsultavtal_NVR_Locollabs.docx',
        'Drive 01_Kunder/Nordic Vision Retail/Fas 1/Avtal/Konsultavtal_NVR_Locollabs.docx',
        'Ospeglat: hemlig-rapport.docx',
        'Tvetydigt: Prislista_2026.docx',
      ].join('\n'),
      team_key: 'LOC',
    });
    kunddokument = kundskapat.body.result.identifier;

    await kor(app, agentnyckel, 'add_comment', {
      identifier: refererande,
      body: 'Skickat till personen: [[02-Områden/hermes/motesanalys-zeynep-2026-08-12]] — se även LOC-316.',
    });
  });

  // ---- (a) vitlistan och path traversal ------------------------------------

  it('KRAV-2/6a: allt utanför vitlistan ger 404 utan innehåll eller katalognamn', async () => {
    // Vägar som FAKTISKT når dokumentrutten — de får dokumentruttens egen text.
    const narDokrutten = [
      '/vy/dok/jag.md',
      '/vy/dok/journal/2026-08-19.md',
      `/vy/dok/${encodeURIComponent('02-Områden')}/${encodeURIComponent('hälsa')}/prover.md`,
      '/vy/dok/05-Dagligt/2026-08-07-morgonbrief.md',
      // Path traversal med kodat snedstreck: %2f avkodas INTE av
      // URL-normaliseringen, så hela '..%2f..%2fjag.md' kommer fram som ETT
      // segment och avvisas av sakerSokvag().
      '/vy/dok/01-Projekt/..%2f..%2fjag.md',
      // Symlink ut ur vaulten, från en vitlistad katalog.
      '/vy/dok/01-Projekt/lank-ut.md',
      // Vitlistad katalog, men filen finns inte — SAMMA svar.
      '/vy/dok/01-Projekt/finns-inte.md',
    ];

    // Path traversal med kodad punkt. Dessa når ALDRIG dokumentrutten: '%2e' är
    // per URL-specen bara ett annat sätt att skriva '.', så '%2e%2e' ÄR ett
    // '..'-segment och plockas bort av dot-segment-normaliseringen redan när
    // URL:en tolkas — före routingen, precis som en webbläsare gör innan den
    // ens skickar requesten. Servern ser '/vy/etc/passwd': ingen /dok/-sökväg
    // alls, utan en vanlig okänd /vy-sida, som svarar med vyns generella 404.
    //
    // Vi tvingar INTE fram dokumentruttens text här. Det skulle kräva att vyns
    // generella fallback påstod "utanför vyns dokumentområde" för varje
    // feltryckt /vy-adress — ett sämre och osannare svar. Kravets kärna gäller
    // ändå för båda sidorna, och det är den vi mäter nedan: 404, HTML, inget
    // filinnehåll, inget katalognamn, ingen bekräftelse på att något finns.
    const normaliseradeAvUrltolkningen = [
      '/vy/dok/%2e%2e/etc/passwd',
      '/vy/dok/01-Projekt/%2e%2e/%2e%2e/etc/passwd',
    ];

    for (const vag of [...narDokrutten, ...normaliseradeAvUrltolkningen]) {
      const svar = await request(app).get(vag);
      expect(svar.status, vag).toBe(404);
      expect(svar.headers['content-type'], vag).toMatch(/text\/html/);
      expect(svar.text, vag).toContain('Hittades inte');
      expect(svar.text, vag).not.toContain('HEMLIGT');
      // Varken filinnehåll eller katalognamn läcker ut.
      for (const ord of ['journal', 'hälsa', 'Dagligt', 'passwd', 'jag.md', 'root:']) {
        expect(svar.text, `${vag} läckte ${ord}`).not.toContain(ord);
      }
    }

    for (const vag of narDokrutten) {
      const svar = await request(app).get(vag);
      expect(svar.text, vag).toContain('utanför vyns dokumentområde');
    }
  });

  // ---- (e) vitlistat dokument renderas escapat ------------------------------

  it('KRAV-1/6e: vitlistat dokument renderas — och innehållet escapas', async () => {
    const svar = await request(app).get(dokvag('01-Projekt/ilt/plan.md'));

    expect(svar.status).toBe(200);
    expect(svar.headers['content-type']).toMatch(/text\/html/);
    expect(svar.text).toContain('<h2>ILT-planen</h2>');
    expect(svar.text).toContain('<li>punkt med <b>fetstil</b></li>');
    expect(svar.text).toContain('<pre>');
    // Frontmatter hör till filen, inte till läsningen.
    expect(svar.text).not.toContain('typ: plan');

    // KRAV-6 (etapp 2a) gäller även här: ingen injicerad HTML, varken i texten
    // eller i kodblocket.
    expect(svar.text).not.toContain('<script>alert');
    expect(svar.text).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(svar.text).toContain('&lt;script&gt;alert(&#39;kod&#39;)&lt;/script&gt;');

    // Wikilänk och LOC-referens inuti dokumentet är också klickbara.
    expect(svar.text).toContain(`href="${dokvag(BESLUTSFLODE)}"`);
    expect(svar.text).toContain('href="/vy/arende/LOC-316"');
  });

  // ---- (d) obsidian-länken --------------------------------------------------

  it('KRAV-1/6d: obsidian-länken är korrekt URL-enkodad och saknar .md', async () => {
    const svar = await request(app).get(dokvag(BESLUTSFLODE));

    expect(svar.status).toBe(200);
    expect(svar.text).toContain('Beslutsflöde');
    expect(svar.text).toContain('Ledningsgruppens beslutsgång.');
    expect(svar.text).toContain(
      `&amp;file=${encodeURIComponent('02-Områden/ledningsgrupp/beslutsflode')}`,
    );
    expect(svar.text).toContain('obsidian://open?vault=');
    expect(svar.text).not.toContain('beslutsflode.md&');
  });

  // ---- (b) autolänkning av alla fyra mönstren ------------------------------

  it('KRAV-3/6b: alla fyra referensmönstren blir länkar i ärendebeskrivningen', async () => {
    const svar = await request(app).get(`/vy/arende/${refererande}`);
    expect(svar.status).toBe(200);

    // (a) [[sökväg|alias]] → länk med aliastexten.
    expect(svar.text).toContain(`<a href="${dokvag(BESLUTSFLODE)}">beslutsflödet</a>`);
    // (b) [[fil]] → länk via filnamnsindexet.
    expect(svar.text).toContain(
      `<a href="${dokvag(MOTESANALYS)}">motesanalys-zeynep-2026-08-12</a>`,
    );
    // (c) full sökväg som slutar på .md.
    expect(svar.text).toContain(`href="${dokvag('01-Projekt/ilt/plan.md')}"`);
    // (d) rent filnamn med EXAKT en träff i indexet.
    expect(svar.text).toContain(
      `<a href="${dokvag(MOTESANALYS)}">motesanalys-zeynep-2026-08-12.md</a>`,
    );
  });

  it('KRAV-3/6b: tvetydigt filnamn och ej vitlistad referens förblir ren text', async () => {
    const svar = await request(app).get(`/vy/arende/${refererande}`);

    // Tvetydigt: två träffar i indexet → ingen länk åt något håll.
    expect(svar.text).not.toContain(dokvag('01-Projekt/dubbel.md'));
    expect(svar.text).not.toContain(dokvag('03-Resurser/dubbel.md'));
    expect(svar.text).toContain('Tvetydigt filnamn: dubbel.md.');

    // Ej vitlistat: ren text, ingen länk och ingen markering som avslöjar att
    // dokumentet finns.
    expect(svar.text).not.toContain('/vy/dok/jag.md');
    expect(svar.text).not.toContain('/vy/dok/05-Dagligt');
    expect(svar.text).not.toContain('/vy/dok/docs');
    expect(svar.text).toContain('Ej vitlistat: jag.md och 05-Dagligt/2026-08-07-morgonbrief.md');

    // KRAV-6e: autolänkningen ersätter esc() — injektionen är fortsatt escapad.
    expect(svar.text).not.toContain('<img src=x');
    expect(svar.text).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  });

  // ---- speglade kunddokument (A1..A3) --------------------------------------

  it('A1: originalnamn med .docx länkar till spegeln — även sist i en Drive-sökväg', async () => {
    const svar = await request(app).get(`/vy/arende/${kunddokument}`);
    expect(svar.status).toBe(200);

    // Båda raderna ger EXAKT samma länk: bara sista segmentet matchas, så
    // Drive-sökvägens katalogdel blir kvar som (escapad) text.
    const lank = `<a href="${dokvag(SPEGEL_NVR)}">Konsultavtal_NVR_Locollabs.docx</a>`;
    expect(svar.text.split(lank).length - 1).toBe(2);
    expect(svar.text).toContain(`Avtal/${lank}`);
  });

  it('A2: ospeglat .docx-namn förblir ren text — ingen länk, ingen markering', async () => {
    const svar = await request(app).get(`/vy/arende/${kunddokument}`);

    expect(svar.text).toContain('Ospeglat: hemlig-rapport.docx');
    expect(svar.text).not.toContain('hemlig-rapport.md');
    expect(svar.text).not.toContain('>hemlig-rapport.docx</a>');
  });

  it('A3: samma stam speglad hos två kunder är tvetydig — ingen av dem länkas', async () => {
    const svar = await request(app).get(`/vy/arende/${kunddokument}`);

    expect(svar.text).toContain('Tvetydigt: Prislista_2026.docx');
    expect(svar.text).not.toContain(
      dokvag('03-Resurser/kunddokument/Nordic Vision Retail/Prislista_2026.md'),
    );
    expect(svar.text).not.toContain(dokvag('03-Resurser/kunddokument/Acme AB/Prislista_2026.md'));
  });

  // ---- (c) LOC-N och kommentarer -------------------------------------------

  it('KRAV-4/6c: LOC-N blir intern länk, i både beskrivning och kommentar', async () => {
    const svar = await request(app).get(`/vy/arende/${refererande}`);

    expect(svar.text).toContain('<a href="/vy/arende/LOC-316">LOC-316</a>');
    // Kommentaren autolänkas i samma renderingssteg.
    expect(svar.text).toContain(`<a href="${dokvag(MOTESANALYS)}">`);
    expect(svar.text).toContain('Skickat till personen:');
  });

  // ---- läsytan är oförändrad -----------------------------------------------

  it('KRAV: dokumentsidan är ren läsyta utan nyckel — POST finns inte', async () => {
    const utan = await request(app).get(dokvag(BESLUTSFLODE));
    expect(utan.status).toBe(200);

    const post = await request(app).post(dokvag(BESLUTSFLODE)).send({ text: 'nej' });
    expect(post.status).toBe(404);
  });
});
