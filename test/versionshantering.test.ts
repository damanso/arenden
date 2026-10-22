// FR-22, Story 7.6: koden ligger privat under Davids GitHub-konto.
//
// Provet håller repots halva av kravet, den som går att visa i en kopia:
//   AK 1  `.gitignore` är en sluten lista (TILLATNA) och repots enda ignorefil, så att en tom
//         `git status --porcelain` i drift betyder att allt annat är versionshanterat (F1);
//   AK 2  README-avsnittet för FR-22 bär remoten, regelns rad och mätningarna i drift (F2);
//   AK 3  README:ns stycke om låsfilen säger att `package-lock.json` är incheckad (F3).
// Remoten, historiken, grenarna och synligheten prövas INTE här. De mäts i /opt/arenden och på
// GitHub, med kommandona i README-avsnittet, och utfallen antecknas i berättelsefilen.
//
// Provet läser två filer och repots katalogträd och når ingen tjänst. De skrivande funktionerna
// används bara i F1 (f), mot en egen tillfällig katalog som tas bort efteråt.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROT = fileURLToPath(new URL('..', import.meta.url));

// ---- AK 1: .gitignore ------------------------------------------------------------------------------

/**
 * Tillåtelselistan: det maskinen själv skapar (`npm ci`, `npm run build`), driftens konfiguration med
 * hemligheter, loggar och säkerhetskopior (NFR-12, Story 7.8). Allt annat ska vara versionshanterat
 * (FR-22, Story 7.6 AK 4). Ett nytt mönster läggs till här i samma diff som i `.gitignore`.
 */
const TILLATNA: readonly string[] = ['node_modules/', 'dist/', '.env', '*.log', '*.fore-design', '*.fore-*'];

/** Utan dem syns byggets utdata och beroendena i `git status --porcelain`, och `.env` kan nå remoten. */
const KRAVDA: readonly string[] = ['node_modules/', 'dist/', '.env'];

/** Git läser ingen `.gitignore` inne i en ignorerad katalog, och `.git` är gits egen. */
const HOPPA_OVER: readonly string[] = ['.git', 'node_modules', 'dist'];

/**
 * Fynden för AK 1: varje mönster utanför TILLATNA, i filens ordning, och sedan varje mönster i KRAVDA
 * som saknas. Tomma rader och kommentarer räknas inte; varje annan rad jämförs exakt, utan trim.
 */
function gitignorefel(text: string): string[] {
  const monster = text
    .split('\n')
    .map((r) => r.replace(/\r$/, ''))
    .filter((r) => r.trim() !== '' && !r.startsWith('#'));
  const fel: string[] = [];
  for (const r of monster) if (!TILLATNA.includes(r)) fel.push(`otillåtet mönster: ${r}`);
  for (const k of KRAVDA) if (!monster.includes(k)) fel.push(`${k} saknas`);
  return fel;
}

/** Texten utan de rader som är exakt lika med mönstret (för F1 (c)). */
function utan(text: string, monster: string): string {
  return text
    .split('\n')
    .filter((r) => r.replace(/\r$/, '') !== monster)
    .join('\n');
}

/**
 * Varje fil som heter `.gitignore` under katalogen, som relativ sökväg med `/`, sorterad. Katalogerna
 * i HOPPA_OVER gås inte igenom, och en symbolisk länk är aldrig en katalog för `isDirectory()`, så den
 * följs inte.
 */
function gitignorefiler(katalog: string): string[] {
  const funna: string[] = [];
  const ga = (relativ: string): void => {
    for (const post of readdirSync(path.join(katalog, relativ), { withFileTypes: true })) {
      const sokvag = relativ === '' ? post.name : path.posix.join(relativ, post.name);
      if (post.isDirectory()) {
        if (!HOPPA_OVER.includes(post.name)) ga(sokvag);
      } else if (post.isFile() && post.name === '.gitignore') {
        funna.push(sokvag);
      }
    }
  };
  ga('');
  return funna.sort();
}

describe('FR-22/Story 7.6 AK 1: .gitignore är en sluten lista och den enda', () => {
  it('F1 (AK 1): varje mönster står i tillåtelselistan, de krävda finns och ingen annan .gitignore', () => {
    const text = readFileSync(path.join(ROT, '.gitignore'), 'utf8');
    // (a) repots fil
    expect(gitignorefel(text)).toEqual([]);
    // (b) kontroll: ett mönster utanför listan fälls med sitt namn
    expect(gitignorefel(text + '\nmigrations/\n')).toEqual(['otillåtet mönster: migrations/']);
    // (c) kontroll: en saknad .env fälls med sitt namn
    expect(gitignorefel(utan(text, '.env'))).toEqual(['.env saknas']);
    // (d) kontroll: kommentarer och tomma rader räknas inte
    expect(gitignorefel(text + '\n# kommentar\n\n')).toEqual([]);
    // (e) repots träd har bara rotens fil
    expect(gitignorefiler(ROT)).toEqual(['.gitignore']);
    // (f) kontroll: genomgången ser en fil i en underkatalog och hoppar över just node_modules och dist
    const katalog = mkdtempSync(path.join(tmpdir(), 'versionshantering-'));
    try {
      for (const del of ['src', 'node_modules/x', 'dist']) {
        mkdirSync(path.join(katalog, del), { recursive: true });
      }
      for (const fil of ['.gitignore', 'src/.gitignore', 'node_modules/x/.gitignore', 'dist/.gitignore']) {
        writeFileSync(path.join(katalog, fil), '');
      }
      expect(gitignorefiler(katalog)).toEqual(['.gitignore', 'src/.gitignore']);
    } finally {
      rmSync(katalog, { recursive: true, force: true });
    }
  });
});

// ---- AK 2: README (krav → kod → test) --------------------------------------------------------------
//
// Provfilerna exporterar inga hjälpare, så mönstret skrivs om här, efter README-hjälparna i
// test/schema.test.ts (rad 308–360).

const RUBRIKEN = '### FR-22 — koden ligger privat under Davids GitHub-konto (Story 7.6)';
const GRANSER_2A = '## Gränser för Etapp 2a';
const REGELNS_BORJAN = '- Versionshanteringen (FR-22, Story 7.6):';
/** Ordagrant som i regelkällan (Dev Notes → Till regelkällan). */
const REGELN =
  '- Versionshanteringen (FR-22, Story 7.6): koden ligger i git med remoten ' +
  '`git@github.com:damanso/arenden.git`, ett privat repo under Davids eget GitHub-konto. Repot har en ' +
  'enda `.gitignore`, i roten, och den bär bara mönster ur tillåtelselistan i ' +
  '`test/versionshantering.test.ts`; ett nytt mönster läggs till i båda i samma ändring. En lokal gren i ' +
  'driftkopian `/opt/arenden` utan fjärrgren under `origin/`, före sin fjärrgren eller med sin fjärrgren ' +
  'borttagen är ett fynd och pushas med `git -C /opt/arenden push -u origin <gren>`, aldrig med `--force`; ' +
  'avvisas pushen för att grenen och fjärrgrenen har gått isär, går fyndet till David. Byggkedjans ' +
  'arbetsgrenar, vars namn börjar med `bmad/arendena-`, är inga fynd, eftersom det som godkänns i dem når ' +
  '`main` genom driftsättningen. En ospårad eller okommittad fil i driftkopian, och en fil som git döljer ' +
  'där utan ett mönster ur tillåtelselistan, är ett fynd: dess ägare committar och pushar den bara om den ' +
  'är kod, prov, migration, kontrakt eller dokumentation, och allt annat committas inte utan tas bort ur ' +
  'driftkopian eller får ett mönster i `.gitignore` och i tillåtelselistan. Till kod räknas också ' +
  'konfigurationen utan hemligheter och appens tillgångar, som `package-lock.json`, `tsconfig.json`, ' +
  'compose-filerna och typsnitten under `assets/`. En fil med hemligheter, också en kopia av `.env`, och ' +
  'en säkerhetskopia `*.fore-*` committas aldrig.';
const REMOTE = 'git@github.com:damanso/arenden.git';

/**
 * Mätningarna i drift, en sluten lista med åtta kommandon. De körs i /opt/arenden och mot GitHub,
 * aldrig här; provet läser bara att README-avsnittet bär vart och ett.
 */
const MATNINGAR = [
  'git -C /opt/arenden remote get-url origin',
  'git -C /opt/arenden fetch --prune',
  "git -C /opt/arenden for-each-ref --format='%(refname:short) %(upstream:short) %(upstream:track)' refs/heads",
  'gh api repos/damanso/arenden --jq .private',
  'git -C /opt/arenden status --porcelain',
  'git -C /opt/arenden log -1 --format=%H -- migrations/0016_svarsversion_lopnummer.sql',
  'git -C /opt/arenden branch -r --contains',
  'git -C /opt/arenden ls-files --others --ignored --exclude-standard --directory',
] as const;

/** Avsnittets gränser: från rubriken till nästa rad som börjar med '## ' eller '### '. */
function avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/**
 * Fynden för F2: rubriken en gång och före Etapp 2a:s gränser, regelns rad exakt en gång och
 * ordagrant, remoten, vart och ett av kommandona i MATNINGAR och två tabellrader med provfilen.
 */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const fel: string[] = [];
  const rubriker = rader.filter((r) => r === RUBRIKEN).length;
  if (rubriker !== 1) fel.push(`rubriken står ${rubriker} gånger`);
  const etapp2a = rader.indexOf(GRANSER_2A);
  if (etapp2a === -1 || etapp2a < granser.start) fel.push(`rubriken står inte före ${GRANSER_2A}`);
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const regler = avsnitt.filter((r) => r.startsWith(REGELNS_BORJAN));
  if (regler.length !== 1) fel.push(`regeln står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regeln avviker');
  const avsnittstext = avsnitt.join('\n');
  if (!avsnittstext.includes(REMOTE)) fel.push('remoten saknas');
  for (const kommando of MATNINGAR) {
    if (!avsnittstext.includes(kommando)) fel.push(`mätningen saknas: ${kommando}`);
  }
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-22'));
  if (tabell.length !== 2) fel.push(`${tabell.length} rader börjar med | FR-22`);
  for (const r of tabell) if (!r.includes('test/versionshantering.test.ts')) fel.push(`rad utan provfilen: ${r}`);
  return fel;
}

/** Texten utan avsnittet: raderna från rubriken till nästa rubrik på nivå två eller tre tas bort. */
function utanAvsnittet(text: string): string {
  const rader = text.split('\n');
  const granser = avsnittet(rader.map((r) => r.replace(/\r$/, '')));
  if (!granser) return text;
  return [...rader.slice(0, granser.start), ...rader.slice(granser.slut)].join('\n');
}

describe('FR-22/Story 7.6 AK 2: README bär FR-22 och mätningarna i drift', () => {
  it('F2 (AK 2): avsnittet bär rubriken, regelns rad, remoten, de åtta mätningarna och två tabellrader', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    // (a) README:n
    expect(readmefel(readme)).toEqual([]);
    // (b) kontroll: utan avsnittet
    expect(readmefel(utanAvsnittet(readme))).toEqual(['rubriken saknas']);
    // (c) kontroll: utan 0016-kommandot, och bara det
    expect(readmefel(readme.replace(MATNINGAR[5], ''))).toEqual([`mätningen saknas: ${MATNINGAR[5]}`]);
    // (d) kontroll: regelns rad med ett tillägg
    expect(readmefel(readme.replace(REGELN, REGELN + ' Tillägg.'))).toEqual(['regeln avviker']);
  });
});

// ---- AK 3: README:ns stycke om låsfilen ------------------------------------------------------------
//
// FR-22:s regel räknar `package-lock.json` till koden som versionshanteras, och arkitekturen säger
// «incheckad → npm ci». README:n får då inte på ett annat ställe säga att låsfilen inte är incheckad.

/** Ordagrant som i Dev Notes → Låsfilen i README:n. */
const LASFILEN =
  'Lockfilen `package-lock.json` är incheckad, och `npm ci` är kommandot på en ren klon (FR-22, Story 7.6).';
/** Tio blanksteg efter `npm ci`, så att `#` står i samma kolumn som förut. */
const INSTALLATIONEN = 'npm ci          # installerar exakt det som package-lock.json anger';

/** De fyra rader som byts ut (kodraden och stycket på tre rader), ordagrant. En sluten lista. */
const GAMLA_RADER = [
  'npm install     # första gången i det här repot: skapar package-lock.json',
  'Lockfilen är inte incheckad ännu (den skapas av kommandot ovan). **När den är',
  'incheckad är `npm ci` kommandot** på en ren klon — det är den formen acceptansen',
  'avser.',
] as const;

/**
 * Fynden för F3: den nya raden och kodraden exakt en gång var, och ingen av de gamla raderna kvar.
 * Raderna jämförs exakt; provet söker inte efter andra formuleringar om låsfilen.
 */
function lasfilsfel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const antal = (rad: string): number => rader.filter((r) => r === rad).length;
  const fel: string[] = [];
  const lasfilen = antal(LASFILEN);
  if (lasfilen !== 1) fel.push(`låsfilens rad står ${lasfilen} gånger`);
  const installationen = antal(INSTALLATIONEN);
  if (installationen !== 1) fel.push(`installationsraden står ${installationen} gånger`);
  for (const gammal of GAMLA_RADER) if (antal(gammal) > 0) fel.push(`gamla raden står kvar: ${gammal}`);
  return fel;
}

describe('FR-22/Story 7.6 AK 3: README säger att låsfilen är incheckad', () => {
  it('F3 (AK 3): låsfilens rad och kodraden står en gång var, och inga gamla rader står kvar', () => {
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    // (a) README:n
    expect(lasfilsfel(readme)).toEqual([]);
    // (b) kontroll: utan den nya raden
    expect(lasfilsfel(readme.replace(LASFILEN, ''))).toEqual(['låsfilens rad står 0 gånger']);
    // (c) kontroll: en gammal rad tillagd som egen rad
    expect(lasfilsfel(readme + '\n' + GAMLA_RADER[1] + '\n')).toEqual([
      `gamla raden står kvar: ${GAMLA_RADER[1]}`,
    ]);
  });
});
