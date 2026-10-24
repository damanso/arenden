// D-2, D-5, FR-13 (Story 11.2 AK 7 och AK 8): varje ärendelänk som appen visar svarar. Provet går igenom
// en sluten lista med sju sidtyper och varje ärendesida de når, följer varje href som börjar med
// /vy/arende/ och varje länk till nummeruppslaget, och kräver 200 efter högst en 308. Fallistan: L1.
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { kor, nyNyckel, raknaRader } from './helpers.js';

const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));
// Alltid i framtiden, räknat från klockan när provet körs (som SEN i test/insats.test.ts).
const UPPFOLJNING = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
const GRUND = { typ: 'beslut', id: '153', version: '1' };

// Sidtyperna: en sluten lista med sju poster. De sex startsidorna och ärendesidan, som nås från dem.
// /vy/mitt hämtas utan aktör och utan session: länkarna kommer då ur högen «Ingen har rört dem», där
// LOC-316 står (bara importens systemrader). Därför skriver ingen action i fixturen på LOC-316.
const STARTSIDOR = [
  '/vy',
  '/vy/mitt',
  '/vy/digest?dagar=alla',
  '/vy/sok?q=HubSpot',
  '/vy/sok?q=LOC-88',
  '/vy/sok?q=LOC-99999',
];
const ARENDESIDA = 'ärendesida';

let app: Express;
let hermes: string;
let david: string;

/** Ett anrop som MÅSTE lyckas (som i test/atagande-handelser.test.ts rad 60–64). */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

/**
 * Varje ärendelänk i en sida, i ordning: ett href som börjar med /vy/arende/, eller som är exakt
 * nummeruppslaget (/vy/sok?q= följt av ett ärendenummer). &amp; återställs till & först.
 */
function arendelankar(html: string): string[] {
  const ut: string[] = [];
  for (const m of html.matchAll(/href="([^"]*)"/g)) {
    const href = m[1]!.replace(/&amp;/g, '&');
    if (href.startsWith('/vy/arende/') || /^\/vy\/sok\?q=[A-Z][A-Z0-9]{0,9}-\d+$/.test(href)) ut.push(href);
  }
  return ut;
}

describe('D-2/Story 11.2 AK 7: varje ärendelänk i appen svarar', () => {
  beforeAll(async () => {
    app = createApp();
    // Teamet LOC, LOC-316, LOC-329 och LOC-88 skapas av importen. Inget annat team.
    await importeraArkiv(FIXTURER);
    hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
    david = await nyNyckel({ typ: 'manniska', namn: 'david' });

    const foralder = (await steg(hermes, 'create_issue', { title: 'Länkprovets förälder', team_key: 'LOC' }))
      .identifier as string;
    const del = (await steg(hermes, 'create_issue', { title: 'Länkprovets delärende', team_key: 'LOC' }))
      .identifier as string;
    await steg(hermes, 'update_issue', { identifier: del, parent: foralder });
    // Relationen går från föräldern till LOC-316: händelseraden skrivs på föräldern.
    await steg(hermes, 'link_issues', { fran: foralder, till: 'LOC-316', typ: 'related' });
    await steg(david, 'add_comment', {
      identifier: foralder,
      body: 'Hänger ihop med LOC-88 och loc-316, men LOC-99999 finns inte.',
    });
    await steg(hermes, 'add_attachment', {
      identifier: foralder, titel: 'Borttaget Linear-ärende', url: 'https://linear.app/locollabs/issue/LOC-99999/gamla',
    });
    // Granskningen: delärendet nämns i förälderns text BARA formaterat och i en bilageadress som
    // URL-tolken normaliserar. Saknas det bland kandidaterna blir länken nummeruppslaget, som svarar 303.
    await steg(david, 'add_comment', { identifier: foralder, body: `Formaterat: _${del}_ och **_${del}_**.` });
    await steg(hermes, 'add_attachment', {
      identifier: foralder,
      titel: 'Linear-länk med tabb',
      url: `https://linear.app/locollabs/issue/${del.slice(0, 2)}\t${del.slice(2)}/flik`,
    });
    await steg(hermes, 'registrera_atagande', {
      identifier: foralder,
      grund: [GRUND],
      nasta: { handling: 'Bygg klart', slag: 'internt', grund: GRUND },
      foljs_upp: UPPFOLJNING,
    });
    await steg(hermes, 'registrera_insats', {
      stopp_id: 'arendelankar-stopp-1',
      typ: 'agarbeslut',
      tillhor: 'agare',
      utfall: 'Riktningen är vald och arbetet kan fortsätta',
      begard_handling: 'Välj mellan A och B',
      blockeringsgrund: 'Tidigare besked avgör inte valet',
      handlingskontrakt: { system: 'hermes', kommando: 'beslutskoe --besvara', objekt: '#153' },
      kallor: [{ system: 'hermes', objekttyp: 'beslut', objekt_id: 'arendelankar-1' }],
      identifier: foralder,
    });
  });

  it('L1 (AK 7 och AK 8): varje ärendelänk på sju sidtyper svarar 200 efter högst en 308', async () => {
    // Kontroll: hjälparen plockar en ärendelänk och en sökning med nummer, men varken en sökning med
    // fasett eller en extern adress — mönstret kan slå ut åt båda hållen.
    expect(arendelankar(
      '<a href="/vy/arende/LOC-1">a</a><a href="/vy/sok?q=LOC-2">b</a>' +
        '<a href="/vy/sok?q=LOC-2&amp;status=started">c</a><a href="https://example.com/vy/arende/LOC-3">d</a>',
    )).toEqual(['/vy/arende/LOC-1', '/vy/sok?q=LOC-2']);

    const fore = await raknaRader('events');
    const perSidtyp = new Map<string, Set<string>>([...STARTSIDOR, ARENDESIDA].map((s) => [s, new Set<string>()]));
    const fynd: string[] = [];
    const sedda = new Set<string>();
    const ko: { lank: string; fran: string }[] = [];
    const notera = (sidtyp: string, lankar: string[], fran: string): void => {
      for (const lank of lankar) {
        perSidtyp.get(sidtyp)!.add(lank);
        if (sedda.has(lank)) continue;
        sedda.add(lank);
        ko.push({ lank, fran });
      }
    };

    for (const start of STARTSIDOR) {
      const svar = await request(app).get(start);
      const location = svar.headers['location'];
      // Sökningen på ett nummer som finns svarar 303 till ärendet; omdirigeringen är sidtypens länk.
      if (svar.status === 303 && start.startsWith('/vy/sok?q=') && typeof location === 'string') {
        notera(start, [location], start);
      } else if (svar.status === 200) {
        notera(start, arendelankar(svar.text), start);
      } else {
        fynd.push(`${start}: ${svar.status}`);
      }
    }

    // Varje unik länk hämtas en gång. En ärendesida läses i sin tur, tills inga nya länkar nås; det tar
    // alltid slut, eftersom fixturen är ändlig.
    for (let post = ko.shift(); post !== undefined; post = ko.shift()) {
      let svar = await request(app).get(post.lank);
      let adress = post.lank;
      if (svar.status === 308) {
        adress = svar.headers['location'] ?? '';
        svar = await request(app).get(adress);
      }
      if (svar.status !== 200) {
        fynd.push(`${post.lank} (på ${post.fran}): ${svar.status}`);
        continue;
      }
      if (adress.startsWith('/vy/arende/')) notera(ARENDESIDA, arendelankar(svar.text), post.lank);
    }

    console.log(`L1: ${[...perSidtyp].map(([sidtyp, lankar]) => `${sidtyp} ${lankar.size}`).join(' · ')}`);
    expect(fynd).toEqual([]);
    expect(perSidtyp.size).toBe(7);
    expect([...perSidtyp].filter(([, lankar]) => lankar.size === 0).map(([sidtyp]) => sidtyp)).toEqual([]);
    expect(await raknaRader('events')).toBe(fore);
  });
});
