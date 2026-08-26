import { renderaArendetext } from '../src/http/vy/markdown.js';
import { hamtaIndex } from '../src/http/vy/dokument.js';
const index = await hamtaIndex();
const fall: Array<[string, string]> = [
  ['sökväg i kod', 'Se `02-Områden/ledningsgrupp/rytm-kalender.md` för detta.'],
  ['ärende i kod', 'Blockeras av `LOC-339` sedan i går.'],
  ['fetstil i kod', 'Kör `**inte fet**` i skalet.'],
  ['kursiv i kod', 'Skriv `*stjärna*` exakt så.'],
  ['R5 i kod', 'Se `jag.md` och `journal/x.md`.'],
  ['utanför kod', 'Se 02-Områden/ledningsgrupp/rytm-kalender.md och LOC-339.'],
];
for (const [vad, text] of fall) {
  const h = renderaArendetext(text, index);
  const lankar = (h.match(/href="\/vy\/(dok|arende)\//g) || []).length;
  const fet = (h.match(/<strong>/g) || []).length;
  const em = (h.match(/<em>/g) || []).length;
  console.log(`  ${vad.padEnd(16)} länkar=${lankar}  <strong>=${fet}  <em>=${em}`);
}
