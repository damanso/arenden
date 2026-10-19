// FR-34, B-15, KRAV-6 (Story 2.4 AK 1–3): en escape-funktion, också för menyns adresser.
//
// produktmeny() får sin modell som parameter: en modell med farliga adresser kan inte komma ur den
// genererade kontraktsfilen, och vi.mock används inte i kodbasen (docs/project-context.md, Testregler).
// Provet ger därför funktionen en egen modell och läser den riktiga menyn, och F3 visar att dagens
// kontrakt ger samma meny genom hela stacken.
//
// Källtextprovet (AK 2) läser en sluten lista skrivsätt och har en sluten undantagslista, så att
// fallen är ändliga. Andra skrivsätt läser det inte; där gäller regeln och granskningen
// (Dev Notes → Avgränsade kriterier).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { esc, produktmeny } from '../src/http/vy/mall.js';
import { modell } from '../src/http/vy/navigation.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

let app: Express;

beforeAll(async () => {
  app = createApp();
  await seedaTeam();
});

// ---- Modellerna (AK 1) ------------------------------------------------------

/** Varje farlig adress bär `"`, `<`, `>` och `&`. */
const FARLIG_GRUPP = '/prov-g?a=1&b=2"><script>alert(1)</script><a x="';
const FARLIG_SIDA = `/prov-s" onfocus="alert(2)" data-x='<b>&amp;</b>'`;
const FARLIG_SNABB = '/prov-q"><img src=x onerror=alert(3)>&';

/** En grupp med ingång, en sida med adress och en utan. Fälten är de produktmeny() läser. */
function provModell(grupp: string, sidan: string) {
  return {
    contract_version: 'prov',
    decision_157: 'pending',
    global: [],
    account: [],
    quick: [],
    groups: [
      {
        id: 'prov_grupp',
        label: 'Provgrupp',
        hint: 'Provets grupp',
        entry_id: 'prov_ingang',
        entry: { id: 'prov_ingang', label: 'Provingång', hint: '', href: grupp },
        items: [
          { id: 'prov_sida', label: 'Provsida', hint: '', href: sidan },
          { id: 'prov_utan', label: 'Utan adress', hint: '', href: null },
        ],
      },
    ],
  };
}

const farligModell = () => provModell(FARLIG_GRUPP, FARLIG_SIDA);
const ofarligModell = () => provModell('/prov-g', '/prov-s');

/** Redovisningens grupp utan ingång: snabbraden byggs då ur `quick`. */
function snabbModell(adress: string) {
  return {
    contract_version: 'prov',
    decision_157: 'pending',
    global: [],
    account: [],
    quick: [{ id: 'prov_q', label: 'Provsnabb', hint: '', href: adress }],
    groups: [
      {
        id: 'accounting',
        label: 'Provredovisning',
        hint: 'Prov',
        entry_id: null,
        entry: null,
        items: [{ id: 'prov_a', label: 'Prov A', hint: '', href: '/prov-a' }],
      },
    ],
  };
}

/** Antalet förekomster av `del` i `text`. */
const antal = (text: string, del: string): number => text.split(del).length - 1;

/** `text` med varje förekomst av `fran` utbytt mot `till`. */
const byt = (text: string, fran: string, till: string): string => text.split(fran).join(till);

describe('FR-34/Story 2.4 AK 1: menyns fyra adresser', () => {
  it('F1 (AK 1): gruppens rubrik, panelens länkar, området och snabbraden går genom esc()', () => {
    const meny = produktmeny(FARLIG_SIDA, farligModell());

    // Rubriken och området bär gruppens adress, panelen och snabbraden sidans.
    expect(antal(meny, `href="${esc(FARLIG_GRUPP)}"`)).toBe(2);
    expect(antal(meny, `href="${esc(FARLIG_SIDA)}"`)).toBe(2);
    expect(antal(meny, 'href="#"')).toBe(2);

    expect(meny).not.toContain(FARLIG_GRUPP);
    expect(meny).not.toContain(FARLIG_SIDA);
    expect(meny).not.toContain('<script');
    expect(meny).not.toContain('<b>');
    expect(antal(meny, '<a ')).toBe(6);

    // Samma element, samma attribut, samma ordning: adressen står där den ofarliga stod.
    const tillbaka = byt(byt(meny, esc(FARLIG_GRUPP), '/prov-g'), esc(FARLIG_SIDA), '/prov-s');
    expect(tillbaka).toBe(produktmeny('/prov-s', ofarligModell()));
  });

  it('F2 (AK 1): snabbraden ur quick går genom esc()', () => {
    const meny = produktmeny('/prov-a', snabbModell(FARLIG_SNABB));

    expect(antal(meny, `href="${esc(FARLIG_SNABB)}"`)).toBe(1);
    expect(meny).not.toContain(FARLIG_SNABB);
    expect(meny).not.toContain('<img');
    expect(meny).not.toContain('<script');
    // Gruppen saknar ingång: rubriken och området är text, inte länkar.
    expect(meny).toContain('<span class=eyebrow>Provredovisning</span>');
    expect(meny).toContain('<span class=nav__omrade>Provredovisning</span>');

    const tillbaka = byt(meny, esc(FARLIG_SNABB), '/prov-q');
    expect(tillbaka).toBe(produktmeny('/prov-a', snabbModell('/prov-q')));
  });

  it('F3 (AK 1): dagens kontrakt ger samma meny genom hela stacken', async () => {
    // Kontrollen: esc() ändrar en adress med &, så likheten nedan kan slå ut.
    expect(esc('/a&b')).not.toBe('/a&b');

    for (const beslut of ['pending', 'yes', 'no']) {
      const m = modell(beslut);
      const poster = [
        ...m.groups.flatMap((g) => [...(g.entry ? [g.entry] : []), ...g.items]),
        ...m.quick,
      ];
      for (const p of poster) {
        const v = p.href ?? '#';
        expect(esc(v), `${beslut}: ${p.id}`).toBe(v);
      }
    }

    // En ingång utan adress blir en span utan href och prövas inte här; dagens kontrakt har ingen.
    const m = modell();
    const vantade = [
      ...m.groups.flatMap((g) => (g.entry && g.entry.href !== null ? [g.entry.href] : [])),
      ...m.groups.flatMap((g) => g.items.map((p) => p.href ?? '#')),
    ];
    for (const vag of ['/vy', '/vy/mitt', '/vy/digest', '/vy/sok']) {
      const svar = await request(app).get(vag);
      expect(svar.status, vag).toBe(200);
      for (const adress of vantade) {
        expect(svar.text, `${vag}: ${adress}`).toContain(`href="${adress}"`);
      }
    }
  });
});

// ---- Källtexten (AK 2) --------------------------------------------------------

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** Varje .ts-fil under src/http/, med sökvägen relativt src/ och '/' som avskiljare ('http/vy/mall.ts'). */
function kallfiler(): { fil: string; text: string }[] {
  return readdirSync(path.join(SRC, 'http'), { recursive: true })
    .map(String)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.posix.join('http', f.split(path.sep).join('/')))
    .sort()
    .map((fil) => ({ fil, text: readFileSync(path.join(SRC, fil), 'utf8') }));
}

/**
 * Textens rader med radnummer, utan hela kommentarsrader (första tecknet utom blanksteg är `//`,
 * `/*` eller `*`). Kommentarer i app.ts och markdown.ts nämner esc() och entiteter utan att vara kod.
 */
function kodrader(text: string): { nr: number; rad: string }[] {
  return text
    .split('\n')
    .map((rad, i) => ({ nr: i + 1, rad }))
    .filter(({ rad }) => !/^\s*(\/\/|\/\*|\*)/.test(rad));
}

const ESCAPENAMN = /\b(function|const|let|var)\s+(esc|escape|escapeHtml|escapeHTML|htmlEscape|escHtml|escAttr|escapeAttr)\b/g;
const ENTITET = '&(?:amp|lt|gt|quot|#39|#x27|#34|#x22);';
/** En entitet i en strängliteral direkt efter `:` eller `,`: en ersättning, alltså en egen escape. */
const ERSATTNING = new RegExp(
  `[:,]\\s*(?:'[^']*${ENTITET}[^']*'|"[^"]*${ENTITET}[^"]*"|\`[^\`]*${ENTITET}[^\`]*\`)`,
);
/** En importsats i sin helhet, också över flera rader. */
const IMPORTSATS = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*'([^']+)';/g;
const MALLMODULEN = new Set(['./mall.js', '../vy/mall.js']);

/** Fynden för «ingen annan HTML-escapefunktion än esc()» (AK 2, formerna (a)–(c) i F4). */
function escapefel(fil: string, text: string): string[] {
  const fynd: string[] = [];
  const arMall = fil === 'http/vy/mall.ts';
  const rader = kodrader(text);
  let escIMall = 0;
  for (const { nr, rad } of rader) {
    // (a) en deklaration med ett escapenamn; bara function esc i mall.ts, och där en gång.
    for (const t of rad.matchAll(ESCAPENAMN)) {
      if (arMall && t[1] === 'function' && t[2] === 'esc' && ++escIMall === 1) continue;
      fynd.push(`${fil}:${nr}: deklarationen ${t[1]} ${t[2]}`);
    }
    // (b) en entitet som ersättning; bara ERSATTNING i mall.ts.
    if (!arMall && ERSATTNING.test(rad)) fynd.push(`${fil}:${nr}: en HTML-entitet som ersättning`);
  }
  // (c) den som anropar esc() importerar den ur mall-modulen. Satsen läses hel, eftersom den kan
  // gå över flera rader (src/http/routes/vy.ts).
  const anrop = arMall ? undefined : rader.find(({ rad }) => /\besc\(/.test(rad));
  if (anrop) {
    const kod = rader.map(({ rad }) => rad).join('\n');
    const importerar = [...kod.matchAll(IMPORTSATS)].some(
      ([, namn, kalla]) => MALLMODULEN.has(kalla!) && namn!.split(',').some((n) => n.trim() === 'esc'),
    );
    if (!importerar) fynd.push(`${fil}:${anrop.nr}: esc( utan import ur mall-modulen`);
  }
  return fynd;
}

/**
 * UNDANTAGEN ÄR EN SLUTEN LISTA. En ny post kräver fil, uttryck och ett skäl, och fallet F5 kräver
 * att skälet inte är tomt. Bara fragment som redan gått genom esc() hör hit. En post som inte längre
 * träffar något fäller inte provet, så att Story 2.3 och 11.2 kan ändra raderna i markdown.ts utan
 * att röra den här filen.
 */
const UNDANTAG: { fil: string; uttryck: string; skal: string }[] = [
  {
    fil: 'http/vy/markdown.ts',
    uttryck: 'url',
    skal:
      'mdurl ur text som redan gått genom esc() i renderaMarkdown(); ett esc() till hade gjort &amp; ' +
      'till &amp;amp; (markdown.ts rad 1–24 och 118–124)',
  },
  {
    fil: 'http/vy/markdown.ts',
    uttryck: "g['arende']",
    skal:
      'LOC-N ur text som redan gått genom esc(); mönstret LOC-\\d+ har inget tecken som esc() ändrar ' +
      '(markdown.ts rad 131–134)',
  },
];

/** Fynden för «varje href- och action-värde genom esc()» (AK 2, formerna (a)–(d) i F5). */
function adressfel(fil: string, text: string): string[] {
  const fynd: string[] = [];
  const tillaten = (uttryck: string): boolean => {
    const u = uttryck.trim();
    return u.startsWith('esc(') || UNDANTAG.some((x) => x.fil === fil && x.uttryck === u);
  };
  for (const { nr, rad } of kodrader(text)) {
    for (const t of rad.matchAll(/\b(href|action)=/g)) {
      const start = t.index! + t[0].length;
      // (a) attributet följs direkt av ett dubbelt citattecken.
      if (rad[start] !== '"') {
        fynd.push(`${fil}:${nr}: ${t[1]}= utan dubbla citattecken`);
        continue;
      }
      // (b) värdet slutar på samma rad.
      const slut = rad.indexOf('"', start + 1);
      if (slut === -1) {
        fynd.push(`${fil}:${nr}: ${t[1]}-värdet slutar inte på raden`);
        continue;
      }
      const varde = rad.slice(start + 1, slut);
      // (c) varje ${…} slutar inom värdet och börjar med esc( eller står i UNDANTAG.
      let utanMallar = '';
      let i = 0;
      while (i < varde.length) {
        const borjan = varde.indexOf('${', i);
        if (borjan === -1) {
          utanMallar += varde.slice(i);
          break;
        }
        utanMallar += varde.slice(i, borjan);
        let djup = 1;
        let j = borjan + 2;
        while (j < varde.length && djup > 0) {
          if (varde[j] === '{') djup++;
          else if (varde[j] === '}') djup--;
          j++;
        }
        if (djup > 0) {
          fynd.push(`${fil}:${nr}: ${varde.slice(borjan)} (uttrycket slutar inte i värdet)`);
          break;
        }
        const uttryck = varde.slice(borjan + 2, j - 1);
        if (!tillaten(uttryck)) fynd.push(`${fil}:${nr}: ${uttryck.trim()}`);
        i = j;
      }
      // (d) varje sammanfogat uttryck mellan ' + och + ' följer samma regel.
      for (const s of utanMallar.matchAll(/'\s*\+(.*?)\+\s*'/g)) {
        if (!tillaten(s[1]!)) fynd.push(`${fil}:${nr}: ${s[1]!.trim()}`);
      }
    }
  }
  return fynd;
}

describe('FR-34/Story 2.4 AK 2: en escape-funktion', () => {
  const ANNAN = 'http/vy/annan.ts';
  const textI = (fil: string): string => {
    const hittad = kallfiler().find((f) => f.fil === fil);
    if (!hittad) throw new Error(`${fil} saknas bland källfilerna`);
    return hittad.text;
  };

  it('F4 (AK 2): esc() i mall.ts är den enda HTML-escapefunktionen under src/http/', () => {
    // Kontrollerna: varje form fälls, och de riktiga texterna med entiteter och flerradsimport släpps.
    expect(
      escapefel(ANNAN, "export function escapeHtml(s: string): string { return s.replace(/</g, '&lt;'); }"),
    ).toHaveLength(2);
    expect(escapefel(ANNAN, 'const x = esc(y);')).toHaveLength(1);
    expect(escapefel(ANNAN, "const T = { '<': '&lt;' };")).toHaveLength(1);
    expect(escapefel('http/vy/markdown.ts', textI('http/vy/markdown.ts'))).toEqual([]);
    expect(escapefel('http/routes/vy.ts', textI('http/routes/vy.ts'))).toEqual([]);

    const fynd = kallfiler().flatMap(({ fil, text }) => escapefel(fil, text));
    expect(fynd, fynd.join('\n')).toEqual([]);
    expect(kodrader(textI('http/vy/mall.ts')).filter(({ rad }) => /\bfunction esc\b/.test(rad))).toHaveLength(1);

    // esc():s eget kontrakt.
    expect(esc('&<>"\'')).toBe('&amp;&lt;&gt;&quot;&#39;');
    expect(esc(null)).toBe('');
    expect(esc(undefined)).toBe('');
  });

  it('F5 (AK 2): varje dynamisk del av ett href- eller action-värde går genom esc()', () => {
    const filer = kallfiler().map(({ fil }) => fil);
    for (const fil of [
      'http/vy/mall.ts',
      'http/vy/skrivning.ts',
      'http/routes/vy.ts',
      'http/vy/markdown.ts',
      'http/vy/crm.ts',
    ]) {
      expect(filer).toContain(fil);
    }

    // Kontrollraderna: varje form (a)–(d) fälls, och de tillåtna släpps.
    const KONTROLLRADER: [fil: string, rad: string, fynd: number][] = [
      [ANNAN, '`<a href="${p.href}">`', 1],
      [ANNAN, '`<a href="${esc(p.href)}">`', 0],
      [ANNAN, '`<a href="${sakerUrl(u) ?? \'\'}">`', 1],
      [ANNAN, '`<a href="${esc(sakerUrl(u) ?? \'\')}">`', 0],
      [ANNAN, '`<a href="/x/${a}/${esc(b)}">`', 1],
      [ANNAN, '`<a href="${x ? "a" : "b"}">`', 1],
      [ANNAN, '\'<a href="\' + vag + \'">\'', 1],
      [ANNAN, '\'<a href="\' + esc(vag) + \'">\'', 0],
      [ANNAN, '`<form action=${x}>`', 1],
      [ANNAN, '`<a href="/x\n  ${esc(y)}">`', 1],
      [ANNAN, '`<a href="${url}">`', 1],
      ['http/vy/markdown.ts', '`<a href="${url}">`', 0],
      [ANNAN, '// <a href="${p.href}">', 0],
    ];
    for (const [fil, rad, vantat] of KONTROLLRADER) {
      expect(adressfel(fil, rad), `${fil}: ${rad}`).toHaveLength(vantat);
    }
    for (const post of UNDANTAG) {
      expect(post.skal.trim(), `${post.fil}: ${post.uttryck}`).not.toBe('');
    }

    const fynd = kallfiler().flatMap(({ fil, text }) => adressfel(fil, text));
    expect(fynd, fynd.join('\n')).toEqual([]);
  });

  it('F6 (AK 2): ett enkelt citattecken i adressen blir &#39;, och adressen är densamma', async () => {
    // Aktörsfasetten i /vy/mitt: namnet är data ur databasen.
    const nyckel = await nyNyckel({ typ: 'agent', namn: "f24 o'neil" });
    const skapat = await kor(app, nyckel, 'create_issue', { title: 'F24 fasett', team_key: 'LOC' });
    expect(skapat.status).toBe(200);
    const identifier: string = skapat.body.result.identifier;

    const mitt = await request(app).get('/vy/mitt');
    expect(mitt.status).toBe(200);
    expect(mitt.text).toContain('href="/vy/mitt?aktor=f24%20o&#39;neil"');
    expect(mitt.text).not.toContain('href="/vy/mitt?aktor=f24%20o\'neil"');
    const avkodad = await request(app).get("/vy/mitt?aktor=f24%20o'neil");
    expect(avkodad.status).toBe(200);
    expect(avkodad.text).toContain('sett från <b>f24 o&#39;neil</b>');

    // Inloggningslänken på 401-sidan: returadressen ur formuläret.
    const fore = await raknaRader('comments');
    const svar = await request(app)
      .post(`/vy/arende/${identifier}/kommentar`)
      .type('form')
      .send({ body: 'F24 utan session', fran: "/vy/sok?q=o'neil" });
    expect(svar.status).toBe(401);
    expect(svar.text).toContain('<a href="/vy/logga-in?fran=%2Fvy%2Fsok%3Fq%3Do&#39;neil">Logga in</a>');
    expect(svar.text).not.toContain('%3Do\'neil"');
    expect(await raknaRader('comments')).toBe(fore);
  });
});

// ---- Sidorna (AK 3) -------------------------------------------------------------

/**
 * Fynden för «inget skript eller element ur datat» på en sida: `<script`, `<img` och `<iframe`, en
 * tagg med ett attribut vars namn börjar med `on` (sökt sedan citerade värden tagits bort), ett
 * `href` som börjar med `javascript:`, och den råa strängen `<b>ny</b>`.
 */
function injektionsfel(html: string): string[] {
  const fynd: string[] = [];
  for (const m of html.matchAll(/<(script|img|iframe)\b/gi)) fynd.push(`<${m[1]}`);
  for (const tagg of html.matchAll(/<[a-z][^>]*>/gi)) {
    const utanVarden = tagg[0].replace(/"[^"]*"|'[^']*'/g, '');
    for (const a of utanVarden.matchAll(/\s(on[\w-]*)(?=[\s=/>])/gi)) fynd.push(`${a[1]} i ${tagg[0]}`);
  }
  for (const m of html.matchAll(/\bhref\s*=\s*["']?\s*javascript:/gi)) fynd.push(m[0]);
  if (html.includes('<b>ny</b>')) fynd.push('<b>ny</b>');
  return fynd;
}

describe('FR-34/Story 2.4 AK 3: arkivdata förblir text', () => {
  it('F7 (AK 3): injektioner i titel, beskrivning, kommentar och skäl blir text på fyra sidor', async () => {
    // Kontrollen: mätningen fäller en sida med inskjutna element och släpper den escapade formen.
    expect(
      injektionsfel(
        '<p><img src=x onerror=alert(1)></p><script>x</script><a href="javascript:x">l</a><b>ny</b>',
      ).length,
    ).toBeGreaterThanOrEqual(5);
    expect(injektionsfel('<p>&lt;script&gt; &lt;img src=x onerror=1&gt;</p>')).toEqual([]);

    const nyckel = await nyNyckel({ typ: 'agent', namn: 'f24 injektion' });
    const skapat = await kor(app, nyckel, 'create_issue', {
      title: 'F24injektion <script>alert("f24-titel")</script> " onmouseover="alert(2)" \'x\' **fet**',
      team_key: 'LOC',
      description: [
        '<img src=x onerror="alert(1)">',
        '**fet** och [länk](javascript:alert(3))',
        '- punkt <iframe src=//example.com></iframe>',
        '> citat "<b>ny</b>"',
        '[[Avtal & bilagor]]',
      ].join('\n\n'),
    });
    expect(skapat.status).toBe(200);
    const identifier: string = skapat.body.result.identifier;
    const kommentar = await kor(app, nyckel, 'add_comment', {
      identifier,
      body: '<script>alert("f24-kommentar")</script> [x](https://example.com/"><b>ny</b>) LOC-1"><b>',
    });
    expect(kommentar.status).toBe(200);
    const andrat = await kor(app, nyckel, 'update_issue', {
      identifier,
      priority: 2,
      skal: '<script>alert("f24-skal")</script>',
    });
    expect(andrat.status).toBe(200);

    const TITEL = '&lt;script&gt;alert(&quot;f24-titel&quot;)&lt;/script&gt;';
    const sidor: Record<string, string> = {};
    for (const vag of ['/vy', '/vy/sok?q=f24injektion', '/vy/digest', `/vy/arende/${identifier}`]) {
      const svar = await request(app).get(vag);
      expect(svar.status, vag).toBe(200);
      const fynd = injektionsfel(svar.text);
      expect(fynd, `${vag}: ${fynd.join(' | ')}`).toEqual([]);
      expect(svar.text, vag).toContain(TITEL);
      sidor[vag] = svar.text;
    }

    // Ärendesidan bär beskrivningen och kommentaren, och markdown renderas med husets element.
    const arendet = sidor[`/vy/arende/${identifier}`]!;
    expect(arendet).toContain('&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    expect(arendet).toContain('&lt;script&gt;alert(&quot;f24-kommentar&quot;)&lt;/script&gt;');
    expect(arendet).toContain('<strong>fet</strong>');
    expect(sidor['/vy/digest']).toContain('&lt;script&gt;alert(&quot;f24-skal&quot;)&lt;/script&gt;');
  });
});

// ---- README (krav → kod → test) -----------------------------------------------

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const RUBRIKEN = '### FR-34 — en escape-funktion, också för menyns adresser (Story 2.4)';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN =
  '- Adresser i vyn (FR-34, B-15, Story 2.4): `esc()` i `src/http/vy/mall.ts` är den enda ' +
  'HTML-escapefunktionen under `src/http/`. Varje dynamisk del av ett `href`- eller `action`-värde, i en ' +
  'mall eller i en sammanfogning, börjar med `esc(`, också för adresser ur `kontrakt/navigation.v1.json`. ' +
  'En adress ur data går genom `sakerUrl()` inuti `esc()`, som `esc(sakerUrl(…))`. Värdet står inom ' +
  'dubbla citattecken och på samma rad som attributet. Ett fragment som redan gått genom `esc()` står i ' +
  'undantagslistan `UNDANTAG` i `test/escape-yta.test.ts` med fil, uttryck och skäl, och listan är sluten.';

/** Avsnittets rader, från rubriken till nästa rubrik på nivå två eller tre, och dess gränser. */
function avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/** Fynden för README:s avsnitt: rubriken, regelns rad exakt en gång och tre tabellrader för FR-34. */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const fel: string[] = [];
  const regler = avsnitt.filter((r) => r.startsWith('- Adresser i vyn (FR-34, B-15, Story 2.4):'));
  if (regler.length !== 1) fel.push(`regelns rad står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regelns rad är inte ordagrant densamma som i regelkällan');
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-34'));
  if (tabell.length !== 3) fel.push(`${tabell.length} tabellrader för FR-34, inte 3`);
  for (const r of tabell) if (!r.includes('test/escape-yta.test.ts')) fel.push(`utan provfilen: ${r}`);
  return fel;
}

describe('FR-34/Story 2.4: README bär regeln', () => {
  it('F8 (dokumentationen): avsnittet för FR-34 bär regeln och tre rader krav → kod → test', () => {
    const text = readFileSync(README, 'utf8');
    expect(readmefel(text)).toEqual([]);

    // Kontrollen: samma kontroll på texten utan avsnittet fälls.
    const rader = text.split('\n');
    const granser = avsnittet(rader.map((r) => r.replace(/\r$/, '')))!;
    const utan = [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
    expect(readmefel(utan)).not.toEqual([]);
  });
});
