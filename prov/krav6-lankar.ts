// Vad kostar KRAV-6 i FAKTISKT emitterade lankar?
//
// Kor grenens EGEN renderare over hela arendekorpusen, tva ganger:
//   A) texten som den ar            -> KRAV-6 galler, kod lankas inte
//   B) samma text med backticks bort -> ingenting ar "kod", allt far lankas
// Skillnaden ar exakt de lankar KRAV-6 undertrycker, EFTER att vitlistan och
// dokumentindexet sagt sitt. Bade min regexrakning (100/1438) och rapportens
// (98/405) var proxys: de raknade referenser, inte lankar.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { renderaArendetext } from '../src/http/vy/markdown.js';
import { hamtaIndex } from '../src/http/vy/dokument.js';

const ARKIV = path.join(process.env.HOME!, 'brain/02-Områden/linear-arkiv');

function raknaLankar(html: string): number {
  return (html.match(/href="\/vy\/dok\//g) || []).length;
}

const index = await hamtaIndex();
const filer = readdirSync(ARKIV).filter((f) => /^LOC-\d+\.md$/.test(f)).sort();

let medKrav6 = 0;
let utanKrav6 = 0;
const varst: Array<[number, string]> = [];

for (const f of filer) {
  const t = readFileSync(path.join(ARKIV, f), 'utf8');
  const a = raknaLankar(renderaArendetext(t, index));
  // ta bort backticks -> ingenting raknas som kod langre
  const b = raknaLankar(renderaArendetext(t.replace(/`/g, ''), index));
  medKrav6 += a;
  utanKrav6 += b;
  if (b > a) varst.push([b - a, f]);
}

const tappade = utanKrav6 - medKrav6;
console.log(`korpus: ${filer.length} arendefiler`);
console.log('');
console.log(`  lankar SOM EMITTERAS med KRAV-6:   ${medKrav6}`);
console.log(`  lankar utan KRAV-6 (backticks bort): ${utanKrav6}`);
console.log(`  KRAV-6 undertrycker:                ${tappade}`);
console.log(`  andel av vad som annars lankats:    ${utanKrav6 ? ((100 * tappade) / utanKrav6).toFixed(1) : '0'} %`);
console.log('');
console.log(`  arenden som tappar minst en lank: ${varst.length} av ${filer.length}`);
varst.sort((x, y) => y[0] - x[0]);
console.log('  varst: ' + varst.slice(0, 5).map(([n, f]) => `${n} st i ${f}`).join(', '));
