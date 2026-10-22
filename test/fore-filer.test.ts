// NFR-12, ADR-0004 (känd avvikelse i PRD §5), Story 7.8: inga säkerhetskopior `*.fore-*` i repot.
//
// Provet håller repots halva av kravet:
//   AK 1  inga namn som matchar `*.fore-*` under `src/`, `test/` och `dist/` (F1, F3), och `.gitignore`
//         täcker mönstret, så att git aldrig visar eller checkar in en säkerhetskopia (F4); README-avsnittet
//         för NFR-12 bär regelns rad (F5);
//   AK 2  en ny säkerhetskopia under `src/` eller `test/` fälls med sin sökväg (F1, F2).
// Provet läser katalogträdet direkt och frågar aldrig git, så en fil som `.gitignore` döljer syns ändå.
// Driftkopian /opt/arenden prövas inte här. Den mäts efter driftsättningen med kommandot i
// README-avsnittet för NFR-12.
//
// Provet når ingen tjänst. De skrivande funktionerna används bara i F2, mot en egen tillfällig katalog
// under tmpdir() som tas bort efteråt, så att en avbruten körning aldrig lämnar en säkerhetskopia i repot.
//
// Provfilerna exporterar inga hjälpare, så mönstret skrivs om här, efter test/versionshantering.test.ts
// (`gitignorefiler` och det tillfälliga trädet i F1 (f)).

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROT = fileURLToPath(new URL('..', import.meta.url));

// ---- AK 1 och AK 2: sökningen ----------------------------------------------------------------------

/**
 * Ett namn matchar git-mönstret `*.fore-*` precis när det innehåller den här delen, eftersom `*` står för
 * vilken följd av tecken som helst inom ett namn, också en tom följd och en inledande punkt. Jämförelsen
 * skiljer på stora och små bokstäver, som git gör på Linux.
 */
const DELEN = '.fore-';

/**
 * Katalogerna som prövas, en sluten lista: epics.md:s (AK 1) och arkitekturens (rad 446). `dist` är
 * byggets utdata, som finns först efter `npm run build`, och en saknad `dist` är därför inget fynd.
 */
const KATALOGER: readonly string[] = ['src', 'test', 'dist'];
const VALFRIA: readonly string[] = ['dist'];

/** Sant precis när namnet på en fil eller katalog matchar `*.fore-*`. Ingen annan regel. */
function arForefil(namn: string): boolean {
  return namn.includes(DELEN);
}

/**
 * Fynden för AK 1 och AK 2: först `katalogen saknas: <katalog>` för varje katalog i KATALOGER som inte
 * finns och inte står i VALFRIA, i listans ordning; sedan, sorterade, `säkerhetskopia: <sökväg>` för
 * varje fil eller katalog vars namn matchar, relativ `rot` och med `/` som avgränsare. Genomgången går
 * ned också i en katalog som själv är ett fynd. En symbolisk länk är aldrig en katalog för
 * `isDirectory()`, så den följs inte, men dess namn prövas.
 */
function forefynd(rot: string): string[] {
  const saknade: string[] = [];
  const funna: string[] = [];
  const ga = (relativ: string): void => {
    for (const post of readdirSync(path.join(rot, relativ), { withFileTypes: true })) {
      const sokvag = path.posix.join(relativ, post.name);
      if (arForefil(post.name)) funna.push(`säkerhetskopia: ${sokvag}`);
      if (post.isDirectory()) ga(sokvag);
    }
  };
  for (const katalog of KATALOGER) {
    if (existsSync(path.join(rot, katalog))) ga(katalog);
    else if (!VALFRIA.includes(katalog)) saknade.push(`katalogen saknas: ${katalog}`);
  }
  return [...saknade, ...funna.sort()];
}

describe('NFR-12/Story 7.8 AK 2: nya säkerhetskopior fälls med sitt namn', () => {
  it('F1 (AK 1, AK 2): predikatet är sant precis för de namn som matchar *.fore-*', () => {
    const namn: readonly [string, boolean][] = [
      ['mall.ts.fore-navmeny', true],
      ['mall.ts.fore-meny-20260924-1240', true],
      ['mall.ts.fore-design', true],
      ['.fore-x', true],
      ['fore-filer.test.ts', false],
      ['mall.ts', false],
      ['mall.fore', false],
      ['mallfore-x', false],
      ['mall.fore_x', false],
      ['mall.ts.FORE-x', false],
      ['x-fran-fore-sparren', false],
    ];
    expect(namn.map(([n]): [string, boolean] => [n, arForefil(n)])).toEqual(namn);
  });

  it('F2 (AK 2): en säkerhetskopia under src/ eller test/ fälls med sin sökväg', () => {
    const katalog = mkdtempSync(path.join(tmpdir(), 'fore-filer-'));
    try {
      for (const del of ['src/http/vy', 'src/gammal.fore-1', 'test/fixtures', 'migrations']) {
        mkdirSync(path.join(katalog, del), { recursive: true });
      }
      for (const fil of [
        'src/http/vy/mall.ts.fore-navmeny',
        'src/http/vy/mall.ts',
        'src/gammal.fore-1/x.ts',
        'src/gammal.fore-1/inre.ts.fore-2',
        'test/vy.test.ts.fore-20260924',
        'test/fixtures/fore-x',
        'migrations/0001.sql.fore-x',
      ]) {
        writeFileSync(path.join(katalog, fil), '');
      }
      // (a) fyra säkerhetskopior, en av dem inne i en katalog som själv är ett fynd; tre namn som inte
      //     fälls (ett utan `.fore-`, ett med `fore-` utan punkt, ett utanför KATALOGER), och ingen dist
      expect(forefynd(katalog)).toEqual([
        'säkerhetskopia: src/gammal.fore-1',
        'säkerhetskopia: src/gammal.fore-1/inre.ts.fore-2',
        'säkerhetskopia: src/http/vy/mall.ts.fore-navmeny',
        'säkerhetskopia: test/vy.test.ts.fore-20260924',
      ]);
      // (b) kontroll: samma träd med en säkerhetskopia under dist/
      mkdirSync(path.join(katalog, 'dist'));
      writeFileSync(path.join(katalog, 'dist/server.js.fore-x'), '');
      expect(forefynd(katalog)).toEqual([
        'säkerhetskopia: dist/server.js.fore-x',
        'säkerhetskopia: src/gammal.fore-1',
        'säkerhetskopia: src/gammal.fore-1/inre.ts.fore-2',
        'säkerhetskopia: src/http/vy/mall.ts.fore-navmeny',
        'säkerhetskopia: test/vy.test.ts.fore-20260924',
      ]);
      // (c) kontroll: samma träd utan katalogen test
      rmSync(path.join(katalog, 'test'), { recursive: true, force: true });
      expect(forefynd(katalog)).toEqual([
        'katalogen saknas: test',
        'säkerhetskopia: dist/server.js.fore-x',
        'säkerhetskopia: src/gammal.fore-1',
        'säkerhetskopia: src/gammal.fore-1/inre.ts.fore-2',
        'säkerhetskopia: src/http/vy/mall.ts.fore-navmeny',
      ]);
    } finally {
      rmSync(katalog, { recursive: true, force: true });
    }
  });
});

describe('NFR-12/Story 7.8 AK 1: repot är rent', () => {
  it('F3 (AK 1): inga säkerhetskopior under src/, test/ eller dist/ i repot', () => {
    expect(forefynd(ROT)).toEqual([]);
  });
});

// ---- AK 1: .gitignore och README (krav → kod → test) ------------------------------------------------
//
// Att `.gitignore` inte bär några andra mönster, och ingen rad som häver det här (`!…`), prövas redan av
// test/versionshantering.test.ts F1 (TILLATNA) och prövas inte här.

const MONSTRET = '*.fore-*';
/** Det smala mönstret som `*.fore-*` ersätter; det breda täcker det, så att regeln står på ett ställe. */
const DET_SMALA = '*.fore-design';

/**
 * Fynden för F4: `*.fore-*` exakt en gång och `*.fore-design` inte alls. Varje rad jämförs exakt, efter
 * att ett avslutande `\r` tagits bort.
 */
function foremonsterfel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const monstret = rader.filter((r) => r === MONSTRET).length;
  const smala = rader.filter((r) => r === DET_SMALA).length;
  const fel: string[] = [];
  if (monstret === 0) fel.push(`${MONSTRET} saknas`);
  else if (monstret > 1) fel.push(`${MONSTRET} står ${monstret} gånger`);
  if (smala > 0) fel.push(`${DET_SMALA} står kvar`);
  return fel;
}

const RUBRIKEN = '### NFR-12 — inga säkerhetskopior `*.fore-*` i repot (Story 7.8)';
const GRANSER_2A = '## Gränser för Etapp 2a';
const REGELNS_BORJAN = '- Säkerhetskopiorna (NFR-12, Story 7.8):';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN =
  '- Säkerhetskopiorna (NFR-12, Story 7.8): lämna inga säkerhetskopior `*.fore-*` i repot. `.gitignore` ' +
  'täcker mönstret, så att git varken visar eller checkar in en sådan fil, och provet ' +
  '`test/fore-filer.test.ts` fäller varje fil eller katalog under `src/`, `test/` och `dist/` vars namn ' +
  'innehåller `.fore-`, med dess sökväg. Behövs det gamla innehållet finns det i git-historiken.';

/**
 * Fynden för F5: rubriken en gång och före Etapp 2a:s gränser, regelns rad exakt en gång och ordagrant och
 * en tabellrad med provfilen. Avsnittet går från rubriken till nästa rad som börjar med '## ' eller '### ',
 * som `avsnittet` i test/versionshantering.test.ts.
 */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return ['rubriken saknas'];
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  const avsnitt = rader.slice(start + 1, nasta === -1 ? rader.length : nasta);
  const fel: string[] = [];
  const rubriker = rader.filter((r) => r === RUBRIKEN).length;
  if (rubriker !== 1) fel.push(`rubriken står ${rubriker} gånger`);
  const etapp2a = rader.indexOf(GRANSER_2A);
  if (etapp2a === -1 || etapp2a < start) fel.push(`rubriken står inte före ${GRANSER_2A}`);
  const regler = avsnitt.filter((r) => r.startsWith(REGELNS_BORJAN));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regeln avviker');
  const tabell = avsnitt.filter((r) => r.startsWith('| NFR-12'));
  if (tabell.length !== 1) fel.push(`${tabell.length} rader börjar med | NFR-12`);
  else if (!tabell[0]?.includes('test/fore-filer.test.ts')) fel.push('tabellraden saknar provfilen');
  return fel;
}

describe('NFR-12/Story 7.8 AK 1: .gitignore och README', () => {
  it('F4 (AK 1): .gitignore bär *.fore-* exakt en gång och inte *.fore-design', () => {
    const text = readFileSync(path.join(ROT, '.gitignore'), 'utf8');
    // (a) repots fil
    expect(foremonsterfel(text)).toEqual([]);
    // (b) kontroll: samma text utan raden *.fore-*
    const utanMonstret = text
      .split('\n')
      .filter((r) => r.replace(/\r$/, '') !== MONSTRET)
      .join('\n');
    expect(foremonsterfel(utanMonstret)).toEqual(['*.fore-* saknas']);
    // (c) kontroll: samma text med det smala mönstret tillbaka, sist
    expect(foremonsterfel(text + '\n' + DET_SMALA + '\n')).toEqual(['*.fore-design står kvar']);
  });

  it('F5 (AK 1): README-avsnittet för NFR-12 bär rubriken, regelns rad och tabellraden', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    // (a) README:n
    expect(readmefel(readme)).toEqual([]);
    // (b) kontroll: regelns rad med ett tillägg
    expect(readmefel(readme.replace(REGELN, REGELN + ' Tillägg.'))).toEqual(['regeln avviker']);
  });
});
