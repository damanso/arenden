// Angreppstester för ärendetextens markdown-rendering (KRAV-13).
//
// Filen är NY (KRAV-14): inget befintligt testfall rörs.
//
// Varför den här filen skrevs FÖRE renderaren: innehållet i databasen skrivs av
// agenter som läser mail, transkript och Drive-dokument. Angriparen behöver
// alltså inte komma åt databasen — det räcker att hen kommer åt ett mail som en
// agent sammanfattar. Angreppsytan är den normala driftvägen, inte ett
// undantag, och därför är invarianterna nedan skrivna som en GRIND som varje
// utdata måste passera, inte som punktvisa strängjämförelser.
import { describe, expect, it } from 'vitest';

import type { Dokumentindex } from '../src/http/vy/dokument.js';
import { autolanka, renderaArendetext } from '../src/http/vy/markdown.js';

const index: Dokumentindex = {
  filnamn: new Map<string, readonly string[]>([
    ['plan.md', ['01-Projekt/ilt/plan.md']],
    ['dubbel.md', ['01-Projekt/dubbel.md', '03-Resurser/dubbel.md']],
  ]),
};

const rendera = (text: string): string => renderaArendetext(text, index);

// ---- Grinden ---------------------------------------------------------------

// Taggarna renderaren SJÄLV får bygga. Allt annat i utdatan är ett fynd.
const TILLATNA = new Set([
  'p',
  'strong',
  'em',
  'code',
  'h3',
  'h4',
  'h5',
  'blockquote',
  'ul',
  'ol',
  'li',
  'hr',
  'a',
]);
const TOMMA = new Set(['hr']);
// De ENDA attribut renderaren själv sätter. Ser granskningen ett annat är det
// per definition innehåll som blivit markup.
const TILLATNA_ATTR = new Set(['href', 'rel']);
// Och de enda mål en href får peka på.
const TILLATET_MAL = /^(?:\/vy\/(?:dok|arende)\/|https?:\/\/)/;

/**
 * Kärnan i KRAV-13. Grinden tittar INTE efter förbjudna strängar i utdatan —
 * `onerror=` och `javascript:` är fullt lagliga som TEXT, och en grind som
 * förbjöd dem hade mätt fel sak. Den tittar i stället på det som faktiskt
 * avgör: vilka taggar och vilka ATTRIBUT renderaren har skrivit ut.
 *
 * Kastar med en läsbar orsak så att ett fynd pekar på VAD som gick fel.
 */
function granska(html: string): void {
  const kort = html.length > 200 ? `${html.slice(0, 200)}…` : html;
  const stack: string[] = [];

  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^>]*)?)>/g)) {
    const stangd = m[1] === '/';
    const namn = m[2]!.toLowerCase();
    const attr = m[3] ?? '';

    // (1) Bara taggar renderaren själv bygger.
    expect(TILLATNA.has(namn), `otillåten tagg <${namn}> i: ${kort}`).toBe(true);

    // (2) Bara attribut renderaren själv sätter — inget onerror, onclick,
    //     onmouseover, style eller srcdoc kan ha smugit in via innehållet.
    for (const a of attr.matchAll(/([a-zA-Z:_-]+)\s*=/g)) {
      expect(TILLATNA_ATTR.has(a[1]!.toLowerCase()), `attribut ${a[1]} på <${namn}> i: ${kort}`)
        .toBe(true);
    }
    const kvar = attr.replace(/\s+(?:href|rel)="[^"]*"/g, '').trim();
    expect(kvar, `oväntad attributtext på <${namn}${attr}> i: ${kort}`).toBe('');

    // (3) href pekar bara dit renderaren själv kan peka — aldrig javascript:,
    //     data: eller vbscript: som attributvärde.
    const href = /href="([^"]*)"/.exec(attr);
    if (href !== null) {
      expect(href[1]!, `href-mål i: ${kort}`).toMatch(TILLATET_MAL);
    }

    // (4) Balans.
    if (TOMMA.has(namn)) continue;
    if (stangd) {
      expect(stack.pop(), `obalanserad </${namn}> i: ${kort}`).toBe(namn);
    } else {
      stack.push(namn);
    }
  }
  expect(stack, `oöppnade/ostängda taggar: ${stack.join(',')} i: ${kort}`).toEqual([]);

  // (5) Inget rått '<' ur innehållet slinker igenom: varje '<' i utdatan måste
  //     inleda en av renderarens egna taggar. Det här är testet som fångar
  //     halvbyggd markup som ingen av kontrollerna ovan ser.
  const rakna = (re: RegExp): number => (html.match(re) ?? []).length;
  expect(rakna(/</g), `rått '<' i: ${kort}`).toBe(
    rakna(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*)?>/g),
  );
}

/** Kör grinden och returnera den EXAKTA utmatade strängen för rapporten. */
function utfall(text: string): string {
  const html = rendera(text);
  granska(html);
  return html;
}

describe('KRAV-13: angreppstester, en per tillåten konstruktion', () => {
  // ---- de åtta tillåtna konstruktionerna, var och en med injektion i sig ----

  it('fetstil som innehåller < (och en hel tagg)', () => {
    const html = utfall('**<script>alert(1)</script>**');
    expect(html).toContain('<strong>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('kursiv med citattecken och taggförsök', () => {
    const html = utfall('*<b onclick="x">hej</b>*');
    expect(html).toContain('<em>');
    expect(html).toContain('&lt;b onclick=&quot;x&quot;&gt;');
  });

  it('kod inline som innehåller ``` och </code>', () => {
    const html = utfall('`` `x` `` och `` ```</code><script>alert(1)</script> ``');
    expect(html).toContain('&lt;/code&gt;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('rubrik som innehåller " och >', () => {
    const html = utfall('## Rubrik med " och > och <img src=x onerror=alert(1)>');
    expect(html).toContain('<h3>');
    expect(html).toContain('&quot;');
    expect(html).toContain('&gt;');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('blockcitat som innehåller javascript:', () => {
    const html = utfall('> javascript:alert(1) och <a href="javascript:alert(1)">klick</a>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('javascript:alert(1)');
    expect(html).toContain('&lt;a href=&quot;javascript:alert(1)&quot;&gt;');
  });

  it('punktlista med injektion i punkten', () => {
    const html = utfall('- <img src=x onerror=alert(1)>\n- <script>alert(1)</script>');
    expect(html).toContain('<ul>');
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it('numrerad lista med injektion i punkten', () => {
    const html = utfall('1. <svg/onload=alert(1)>\n2. </ol><script>alert(1)</script>');
    expect(html).toContain('<ol>');
    expect(html).toContain('&lt;/ol&gt;');
  });

  it('horisontell linje kan inte bära nyttolast', () => {
    const html = utfall('a\n\n---\n\nb');
    expect(html).toContain('<hr>');
  });

  // ---- de namngivna angreppen i KRAV-13 ------------------------------------

  it('<script>alert(1)</script> i brödtext', () => {
    const html = utfall('Före <script>alert(1)</script> efter');
    expect(html).toBe('<p>Före &lt;script&gt;alert(1)&lt;/script&gt; efter</p>');
  });

  it('<img src=x onerror=alert(1)> i brödtext', () => {
    const html = utfall('<img src=x onerror=alert(1)>');
    expect(html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
  });

  it('en punktlista där en punkt är 50 000 tecken', () => {
    const stor = 'A'.repeat(50_000);
    const html = utfall(`- ${stor}\n- kort`);
    expect(html).toContain(`<li>${stor}</li>`);
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  it('50 000 tecken injektionstext i en punkt escapas i sin helhet', () => {
    const bit = '<img src=x onerror=alert(1)>';
    const html = utfall(`- ${bit.repeat(2000)}`);
    expect(html).not.toContain('<img');
    expect(html.match(/&lt;img src=x onerror=alert\(1\)&gt;/g)).toHaveLength(2000);
  });

  it('200 nästlade blockcitat plattas till högst 6 nivåer och kastar aldrig', () => {
    const html = utfall(`${'>'.repeat(200)} djupt`);
    expect(html.match(/<blockquote>/g)!.length).toBeLessThanOrEqual(6);
    expect(html.match(/<blockquote>/g)!.length).toBe(
      html.match(/<\/blockquote>/g)!.length,
    );
    expect(html).toContain('djupt');
  });

  it('200 nästlade blockcitat rad för rad, 200 rader djupt', () => {
    const rader = Array.from({ length: 200 }, (_, n) => `${'>'.repeat(n + 1)} rad ${n}`);
    const html = utfall(rader.join('\n'));
    expect(html.match(/<blockquote>/g)!.length).toBe(html.match(/<\/blockquote>/g)!.length);
  });
});

describe('KRAV-3: escape sker FÖRE omvandlingen', () => {
  // Det här är testet som skiljer en renderare som escapar före från en som
  // escapar efter. En efter-escapare kan inte skilja innehållets '>' från sin
  // egen markup, och en efter-escapare som lärt sig undanta sina egna taggar
  // släpper förr eller senare igenom en konstruktion den inte kände till.
  it('råa entiteter i källtexten blir literal text, inte markup', () => {
    // Skrev agenten '&gt;' i klartext ska det SES som '&gt;' — inte tolkas som
    // ett blockcitat, vilket det skulle göra om escapen kom efteråt.
    const html = utfall('&gt; inte ett blockcitat');
    expect(html).toBe('<p>&amp;gt; inte ett blockcitat</p>');
    expect(html).not.toContain('<blockquote>');
  });

  it('&lt;script&gt; i källtexten dubbelescapas i stället för att bli en tagg', () => {
    const html = utfall('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toBe('<p>&amp;lt;script&amp;gt;alert(1)&amp;lt;/script&amp;gt;</p>');
  });

  it('inget innehåll kan stänga renderarens egna taggar', () => {
    for (const angrepp of [
      '**fet</strong><script>alert(1)</script>**',
      '## rubrik</h3><img src=x onerror=alert(1)>',
      '- punkt</li></ul><script>alert(1)</script>',
      '> citat</blockquote><script>alert(1)</script>',
      '`kod</code><script>alert(1)</script>`',
      '*kursiv</em><script>alert(1)</script>*',
    ]) {
      const html = utfall(angrepp);
      expect(html, angrepp).not.toContain('<script');
    }
  });

  it('attributinjektion mot autolänkarens href går inte', () => {
    // Citattecknet kan inte bryta ur href:et — dels för att det escapades i
    // steg 1, dels för att referensen med citattecken i inte finns i indexet
    // och därför aldrig blir en länk alls (KRAV-3). granska() ovan har redan
    // slagit fast att inget onmouseover-ATTRIBUT finns; här kontrolleras att
    // strängen i stället står kvar som text.
    const html = utfall('[[plan.md" onmouseover="alert(1)]] och [[plan]]');
    expect(html).toContain('[[plan.md&quot; onmouseover=&quot;alert(1)]]');
    expect(html.match(/<a /g)).toHaveLength(1);
  });
});

describe('KRAV-6 efter beslut #42: kod fredas från FORMATERING, inte från länkning', () => {
  it('LOC-339 i en kodsnutt LÄNKAS (beslut #42) men formateras inte', () => {
    const html = utfall('Se `LOC-339` i loggen');
    expect(html).toBe(
      '<p>Se <code><a href="/vy/arende/LOC-339">LOC-339</a></code> i loggen</p>',
    );
  });

  it('markdown inne i kod sker ALDRIG, inte ens efter beslut #42', () => {
    // Det är den halvan av gamla KRAV-6 som står kvar: en asterisk i ett
    // kodexempel ska stå kvar som asterisk.
    expect(utfall('Kör `**inte fet**` i skalet')).not.toContain('<strong>');
    expect(utfall('Skriv `*stjärna*` exakt så')).not.toContain('<em>');
  });

  it('R5-sökvägar länkas inte heller i kod', () => {
    // Vitlistan i dokument.ts gäller oförändrat: beslut #42 vidgade vad som
    // FÅR länkas, aldrig vad som får nås.
    const html = utfall('Se `jag.md` och `journal/x.md`');
    expect(html).not.toContain('href="/vy/dok/');
  });

  it('LOC-339 i en rubrik blir en länk', () => {
    const html = utfall('## Om LOC-339');
    expect(html).toContain('<a href="/vy/arende/LOC-339">LOC-339</a>');
  });

  it('LOC-339 i fetstil och i blockcitat blir en länk', () => {
    expect(utfall('**LOC-339**')).toContain('<a href="/vy/arende/LOC-339">LOC-339</a>');
    expect(utfall('> LOC-339')).toContain('<a href="/vy/arende/LOC-339">LOC-339</a>');
    expect(utfall('- LOC-339')).toContain('<a href="/vy/arende/LOC-339">LOC-339</a>');
  });

  it('markdown inne i kod inline renderas inte', () => {
    const html = utfall('`**inte fet** och *inte kursiv*`');
    expect(html).toBe('<p><code>**inte fet** och *inte kursiv*</code></p>');
  });

  it('dokumentreferens i kod inline länkas (beslut #42)', () => {
    const html = utfall('`plan.md` men plan.md');
    expect(html).toContain('<code><a href=');
    // Bägge länkas nu — före beslut #42 var det en. Mätt över hela korpusen
    // gav regeln tillbaka 55 av 291 länkar (18,9 %).
    expect(html.match(/<a /g)).toHaveLength(2);
  });
});

describe('KRAV-2: en konstruktion som inte stöds ser ut som sin källtext', () => {
  it('tabellrader är text, inte en tabell', () => {
    const html = utfall('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(html).not.toContain('<table');
    expect(html).toContain('| a | b |');
  });

  it('markdown-länk är text — autolänkaren äger länkar (KRAV-4)', () => {
    const html = utfall('[text](https://example.com)');
    expect(html).toBe('<p>[text](https://example.com)</p>');
  });

  it('bild, fotnot, genomstrykning och uppgiftslista är text', () => {
    expect(utfall('![alt](x.png)')).toContain('![alt](x.png)');
    expect(utfall('~~struken~~')).toContain('~~struken~~');
    expect(utfall('en fotnot[^1]')).toContain('[^1]');
  });

  it('oavslutade konstruktioner blir sin källtext, inte trasig markup', () => {
    expect(utfall('**oavslutad')).toBe('<p>**oavslutad</p>');
    expect(utfall('`oavslutad')).toBe('<p>`oavslutad</p>');
    expect(utfall('*oavslutad')).toBe('<p>*oavslutad</p>');
  });

  it('understreck mitt i ett ord blir inte kursiv', () => {
    const html = utfall('Konsultavtal_NVR_Locollabs och 01_Kunder/Fas_1');
    expect(html).not.toContain('<em>');
    expect(html).toContain('Konsultavtal_NVR_Locollabs');
  });

  it('rubriknivå 1 är inte med i KRAV-1:s delmängd och visas som text', () => {
    const html = utfall('# Rubrik');
    expect(html).toBe('<p># Rubrik</p>');
  });
});

describe('KRAV-7: rubriknivåer — sidan äger h1 och h2', () => {
  it('nivå 2→h3, 3→h4, 4 och djupare→h5', () => {
    expect(utfall('## två')).toBe('<h3>två</h3>');
    expect(utfall('### tre')).toBe('<h4>tre</h4>');
    expect(utfall('#### fyra')).toBe('<h5>fyra</h5>');
    expect(utfall('##### fem')).toBe('<h5>fem</h5>');
    expect(utfall('###### sex')).toBe('<h5>sex</h5>');
  });

  it('ingen h1 eller h2 kan produceras ur innehåll', () => {
    for (const t of ['# ett', '## två', '###### sex', 'text\n===\n', 'text\n---\n']) {
      const html = rendera(t);
      expect(html, t).not.toMatch(/<h[12][\s>]/);
    }
  });
});

describe('KRAV-11: gränser, aldrig ett kastat undantag', () => {
  it('indata över 200 000 tecken returneras som escapad text med en kommentar', () => {
    const html = rendera(`**fet**<script>alert(1)</script>${'x'.repeat(200_001)}`);
    expect(html).toContain('<!--');
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('**fet**');
  });

  it('renderaren kastar aldrig, oavsett indata', () => {
    const konstiga = [
      '',
      '\n\n\n',
      ' �',
      '\r\n\r\n- a\r\n',
      '*'.repeat(5000),
      '`'.repeat(5000),
      '#'.repeat(5000),
      '>'.repeat(5000),
      '-'.repeat(5000),
      `${'> '.repeat(500)}x`,
      '‮​**fet**',
      '💥`kod`💥**fet**',
      '1.'.repeat(3000),
      '[['.repeat(3000),
    ];
    for (const t of konstiga) {
      expect(() => rendera(t), JSON.stringify(t.slice(0, 40))).not.toThrow();
      granska(rendera(t));
    }
  });
});

describe('KRAV-5: autolänkningen är oförändrad', () => {
  // Ordningen är escape → markdown → autolänkning. Det sista steget ska ge
  // samma <a>-element som före bygget för en text utan markdownkonstruktioner.
  const utanMarkdown = [
    'Full sökväg: 01-Projekt/ilt/plan.md.',
    'Rent filnamn: plan.md.',
    'Tvetydigt filnamn: dubbel.md.',
    'Wikilänk: [[plan.md]] och [[plan.md|planen]].',
    'Relaterat ärende: LOC-316.',
    'Injektion: <img src=x onerror="alert(1)">',
  ];

  it('samma ankare som autolanka() gav före bygget', () => {
    for (const rad of utanMarkdown) {
      const fore = autolanka(rad, index);
      const efter = rendera(rad);
      const ankare = (h: string): string[] => h.match(/<a [^>]*>[^<]*<\/a>/g) ?? [];
      expect(ankare(efter), rad).toEqual(ankare(fore));
    }
  });

  it('tvetydig referens förblir ren text, ingen markering', () => {
    const html = utfall('Tvetydigt filnamn: dubbel.md.');
    expect(html).toBe('<p>Tvetydigt filnamn: dubbel.md.</p>');
  });
});

describe('KRAV-12: renderingen kostar högst 5 ms per 10 000 tecken', () => {
  it('mäter på en realistisk blandning', () => {
    const block = [
      '## Sammanfattning',
      'Ett stycke med **fetstil**, *kursiv* och `kod inline` samt LOC-316.',
      '',
      '- punkt med [[plan.md]]',
      '- punkt med 01-Projekt/ilt/plan.md',
      '',
      '1. första',
      '2. andra',
      '',
      '> ett blockcitat med **fetstil**',
      '',
      '---',
      '',
    ].join('\n');
    const text = block.repeat(Math.ceil(100_000 / block.length));
    const tecken = text.length;

    rendera(text.slice(0, 10_000)); // uppvärmning
    const start = process.hrtime.bigint();
    rendera(text);
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    const perTiotusen = (ms / tecken) * 10_000;

    // Talet skrivs ut oavsett utfall — KRAV-12 kräver siffran i rapporten.
    console.log(
      `KRAV-12: ${tecken} tecken på ${ms.toFixed(1)} ms = ` +
        `${perTiotusen.toFixed(3)} ms per 10 000 tecken`,
    );
    expect(perTiotusen).toBeLessThan(5);
  });
});
