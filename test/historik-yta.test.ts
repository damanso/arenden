// FR-12 («ingen rad är omärkt») och FR-8 («ursprungsversionen går att se»), B-13 (Story 1.2 AK 1–7): historiken på
// ärendesidan är fullständig och ingen rad är omärkt. H1–H2 håller LOC-88 och 404-sidorna (AK 6), H3–H4 den som tog
// bort under Borttagna kommentarer (AK 4), H5 märket i varje rads huvud (AK 5), H6–H8 historikens detaljer (AK 1–3)
// och H9 digesten och läsningen (AK 7).
//
// Fallistorna: AK 1 två verb och i den gamla texten <script>, [[dokument]], LOC-1 och en http-adress (H6); AK 2 de
// tre avsnitten (H7); AK 3 sex äldre rader och en kontrollrad (H8); AK 4 sju kommentarer i tjänsten (H3), bland dem
// tre där en tidigare borttagning har en händelse men borttagningen som gäller nu har en annan aktör eller ingen
// händelse, och tre rader på sidan (H4); AK 5 tre avsnitt utan och med session, fyra radslag och den okända typen (H5, H4); AK 6 två
// avsnitt och tre adresser (H1, H2); AK 7 två sidor, två verb, två tabeller och en statisk räkning (H9).
//
// Varje (R)-fall och varje frånvaro har en kontroll i samma fall som visar att mätningen kan slå ut.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import pg from 'pg';
import request from 'supertest';
import { createApp } from '../src/http/app.js';
import { withTransaction } from '../src/db/tx.js';
import { esc, proveniens } from '../src/http/vy/mall.js';
import { glomAllaSessioner } from '../src/http/vy/session.js';
import { importeraArkiv } from '../src/import/importeraArkiv.js';
import { listaBorttagnaKommentarer } from '../src/services/kommentarer.js';
import { kor, nyNyckel, raknaRader, TENANT_ID } from './helpers.js';

const FIXTURER = fileURLToPath(new URL('./fixtures/arkiv/', import.meta.url));

let app: Express;
let david: string;
let hermes: string;

beforeAll(async () => {
  app = createApp();
  glomAllaSessioner();
  // Teamet LOC och LOC-88, LOC-316 och LOC-329, alla händelser som system · linear-import.
  await importeraArkiv(FIXTURER);
  david = await nyNyckel({ typ: 'manniska', namn: 'david' });
  hermes = await nyNyckel({ typ: 'agent', namn: 'hermes' });
});

// ---- Hjälpare ------------------------------------------------------------------------------------------------

/** Ett anrop som MÅSTE lyckas. Ett tyst 400 i ett förberedande steg får aldrig bära ett senare fall. */
async function steg(nyckel: string, action: string, input: Record<string, unknown>) {
  const svar = await kor(app, nyckel, action, input);
  expect(svar.status, `${action}: ${JSON.stringify(svar.body)}`).toBe(200);
  return svar.body.result;
}

/** Ärendesidan, utan eller med sessionskaka. Den måste svara 200. */
async function sidan(identifier: string, kaka?: string): Promise<string> {
  const fraga = request(app).get(`/vy/arende/${identifier}`);
  const svar = await (kaka === undefined ? fraga : fraga.set('Cookie', kaka));
  expect(svar.status, identifier).toBe(200);
  return svar.text;
}

/** Ägarrollen, som i test/rattelser.test.ts rad 42–46. Anroparen stänger den i finally. */
async function adminKlient(): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: process.env.DATABASE_ADMIN_URL });
  await c.connect();
  return c;
}

/** Texten från första `start` till första `slut` efter den. Saknas någon av dem fälls fallet. */
function avsnitt(html: string, start: string, slut: string): string {
  const i = html.indexOf(start);
  expect(i, `hittade inte ${start}`).toBeGreaterThan(-1);
  const j = html.indexOf(slut, i + 1);
  expect(j, `hittade inte ${slut} efter ${start}`).toBeGreaterThan(-1);
  return html.slice(i, j);
}

/** Raderna i ett avsnitt: varje bit efter `<li class=rad>`, kapad vid första `</li>`. */
function raderI(del: string): string[] {
  return del
    .split('<li class=rad>')
    .slice(1)
    .map((bit) => {
      const slut = bit.indexOf('</li>');
      return slut === -1 ? bit : bit.slice(0, slut);
    });
}

/** Radens huvud: texten mellan `<div class=huvud>` och första `</div>` efter den. */
function huvudet(rad: string): string {
  const start = '<div class=huvud>';
  const i = rad.indexOf(start);
  expect(i, `raden saknar huvud: ${rad}`).toBeGreaterThan(-1);
  const j = rad.indexOf('</div>', i);
  expect(j, `huvudet är inte stängt: ${rad}`).toBeGreaterThan(-1);
  return rad.slice(i + start.length, j);
}

/** Antalet proveniensmärken i radens huvud. Märken efter huvudet, i radens detaljer, räknas inte. */
function markenIHuvudet(rad: string): number {
  return huvudet(rad).split('class="prov ').length - 1;
}

/** De rader vars huvud bär verbets span ordagrant. */
function radMedVerb(del: string, text: string): string[] {
  return raderI(del).filter((rad) => huvudet(rad).includes(`<span>${text}</span>`));
}

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

/** Radens detaljer: från `<details class=rattelse>` till och med `</details>`, eller null om raden saknar dem. */
function detaljerna(rad: string): string | null {
  const i = rad.indexOf('<details class=rattelse>');
  if (i === -1) return null;
  const j = rad.indexOf('</details>', i);
  return j === -1 ? null : rad.slice(i, j + '</details>'.length);
}

/** AK 1: blocket för en rättelse, ordagrant. Argumenten är redan escapade. */
function tidigareText(fore: string, efter: string): string {
  return (
    '<details class=rattelse><summary>Visa tidigare text</summary><div class=text><h5>Före</h5><div class=text>' +
    fore +
    '</div><h5>Efter</h5><div class=text>' +
    efter +
    '</div></div></details>'
  );
}

/** AK 2: blocket för en borttagen kommentar, ordagrant. Märket kommer ur proveniens(), texten är escapad. */
function borttagenKommentar(marke: string, text: string): string {
  return (
    '<details class=rattelse><summary>Visa den borttagna kommentaren</summary>' +
    '<p class=notis>Borttagen — visas bara här i historiken.</p><p>' +
    marke +
    '</p><div class=text>' +
    text +
    '</div></details>'
  );
}

/** AK 4: avsnittstexten under Borttagna kommentarer, ordagrant. */
const AVSNITTSTEXT =
  "<p class=notis>Innehållet och aktören står i historiken nedan, under 'Visa den borttagna kommentaren'.</p>";

// ---- AK 6------------------------------------------------------------------------------------------------------

describe('FR-12/FR-8/Story 1.2 AK 6: hela historiken och 404 (regression)', () => {
  it('H1 (AK 6): LOC-88 visar Kommentarer (2) och Historik (3) i tidsordning med alla rader', async () => {
    const html = await sidan('LOC-88');
    expect(html).toContain('<h2>Kommentarer (2)</h2>');
    expect(html).toContain('<h2>Historik (3)</h2>');

    const kommentarer = raderI(avsnitt(html, '<h2>Kommentarer (', '<h2>'));
    const historik = raderI(avsnitt(html, '<h2>Historik (', '</main>'));
    expect(kommentarer).toHaveLength(2);
    expect(historik).toHaveLength(3);

    // Tidsstämpeln är texten i huvudets första <span>; proveniensens span bär attribut och räknas inte.
    const stamplar = (rader: string[]): string[] =>
      rader.map((rad) => /<span>([^<]*)<\/span>/.exec(huvudet(rad))?.[1] ?? '');
    const ickeFallande = (s: string[]): boolean => s.every((x, i) => i === 0 || s[i - 1]! <= x);
    const k = stamplar(kommentarer);
    const h = stamplar(historik);
    for (const s of [...k, ...h]) expect(s).toMatch(/^\d{4}-\d{2}-\d{2} /);

    // Kontroll: de två kommentarerna har olika stämplar, och samma prövning fäller dem i omvänd ordning.
    expect(k[0]).not.toBe(k[1]);
    expect(ickeFallande([...k].reverse())).toBe(false);

    expect(ickeFallande(k)).toBe(true);
    expect(ickeFallande(h)).toBe(true);
  });

  it('H2 (AK 6): okänt ärende, trasigt ärendenummer och okänd /vy-sökväg ger 404 som HTML-sida', async () => {
    // Kontroll: ett ärende som finns svarar 200, så 404 nedan är inte allt sidan kan svara.
    expect((await request(app).get('/vy/arende/LOC-88')).status).toBe(200);

    for (const vag of ['/vy/arende/LOC-99999', '/vy/arende/inte-ett-nummer', '/vy/finns-inte']) {
      const svar = await request(app).get(vag);
      expect(svar.status, vag).toBe(404);
      expect(String(svar.headers['content-type']), vag).toMatch(/^text\/html/);
      expect(svar.text, vag).toContain('Hittades inte');
    }
  });
});

// ---- AK 4 ------------------------------------------------------------------------------------------------------

describe('FR-12/FR-8/Story 1.2 AK 4: borttagna-raderna bär den som tog bort', () => {
  it('H3 (AK 4): tjänsten lämnar ut aktören för den borttagning som gäller nu men aldrig texten eller originalets aktör', async () => {
    const forfattare = await nyNyckel({ typ: 'agent', namn: 'h3 författare' });
    const h3david = await nyNyckel({ typ: 'manniska', namn: 'h3 david' });
    const stadare = await nyNyckel({ typ: 'agent', namn: 'h3 städare' });
    const { identifier } = await steg(forfattare, 'create_issue', { title: 'H3 borttagna i tjänsten', team_key: 'LOC' });
    const issueId = (await steg(forfattare, 'get_issue', { identifier })).arende.id as string;
    const ids: string[] = [];
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      ids.push((await steg(forfattare, 'add_comment', { identifier, body: `h3 kommentarstext ${n}` })).id);
    }
    const [k1, k2, k3, k4, k5, k6, k7] = ids as [string, string, string, string, string, string, string];

    // K1: borttagen av människan. K2: borttagen, återställd och borttagen igen av en annan aktör.
    await steg(h3david, 'delete_comment', { kommentar_id: k1 });
    await steg(h3david, 'delete_comment', { kommentar_id: k2 });
    await steg(h3david, 'restore_comment', { kommentar_id: k2 });
    await steg(stadare, 'delete_comment', { kommentar_id: k2 });
    // K5: borttagen och återställd genom API:t. K6: borttagen genom API:t. Båda får sedan nedan en borttagning
    // förbi API:t, så att borttagningen som gäller nu saknar händelse fast en tidigare borttagning har en.
    await steg(h3david, 'delete_comment', { kommentar_id: k5 });
    await steg(h3david, 'restore_comment', { kommentar_id: k5 });
    await steg(h3david, 'delete_comment', { kommentar_id: k6 });

    // K7: samtidigheten. Borttagningen som gäller nu (h3 gällande) började först och bär därför den lägsta
    // tidpunkten, men fick radlåset efter en borttagning och en återställning som började senare (h3 ångrad).
    // Ägarrollen skriver händelserna i den ordning transaktionerna committade, med var sin tidpunkt.
    const nu = Date.now();
    const gallande = new Date(nu - 60_000);
    const angrad = new Date(nu - 59_000);
    const aterstalld = new Date(nu - 58_000);
    const admin = await adminKlient();
    try {
      // K3: borttagen förbi API:t, utan någon händelserad alls. K4 står kvar.
      await admin.query('UPDATE comments SET borttagen = now() WHERE id = $1', [k3]);
      await admin.query('UPDATE comments SET borttagen = now() WHERE id = $1', [k5]);
      await admin.query("UPDATE comments SET borttagen = borttagen + interval '1 second' WHERE id = $1", [k6]);
      await admin.query('UPDATE comments SET borttagen = $2 WHERE id = $1', [k7, gallande]);
      const k7handelser: [typ: string, namn: string, verb: string, tid: Date][] = [
        ['agent', 'h3 ångrad', 'tog_bort_kommentar', angrad],
        ['agent', 'h3 ångrad', 'aterstallde_kommentar', aterstalld],
        ['manniska', 'h3 gällande', 'tog_bort_kommentar', gallande],
      ];
      for (const [typ, namn, verb, tid] of k7handelser) {
        await admin.query(
          `INSERT INTO events (tenant_id, issue_id, aktor_typ, aktor_namn, verb, payload, tidpunkt)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [TENANT_ID, issueId, typ, namn, verb, JSON.stringify({ kommentar_id: k7 }), tid],
        );
      }
    } finally {
      await admin.end();
    }

    // Kontroll först: K5–K7 har var sin händelse tog_bort_kommentar, och den senaste efter tidpunkt (listaHandelser
    // ordnar på tidpunkt och id) är en annan aktör än den som tog bort nu. Null och h3 gällande nedan är alltså
    // inte en tom mätning.
    const handelser = (await steg(forfattare, 'get_issue', { identifier })).handelser as {
      verb: string;
      aktor_namn: string;
      payload: Record<string, unknown>;
    }[];
    const senasteEfterTid = (id: string): string | undefined =>
      handelser.filter((h) => h.verb === 'tog_bort_kommentar' && h.payload['kommentar_id'] === id).at(-1)?.aktor_namn;
    expect(senasteEfterTid(k5)).toBe('h3 david');
    expect(senasteEfterTid(k6)).toBe('h3 david');
    expect(senasteEfterTid(k7)).toBe('h3 ångrad');

    const lista = await withTransaction((c) => listaBorttagnaKommentarer(c, TENANT_ID, issueId));
    const idn = lista.map((b) => b.id);

    // Kontroll: den levande K4 saknas, så listan är inte bara ärendets alla kommentarer.
    expect(idn).not.toContain(k4);
    expect([...idn].sort()).toEqual([k1, k2, k3, k5, k6, k7].sort());

    for (const b of lista) {
      expect(Object.keys(b).sort()).toEqual(['borttagen', 'borttagen_av_namn', 'borttagen_av_typ', 'id']);
    }
    const post = (id: string): Record<string, unknown> =>
      lista.find((b) => b.id === id) as unknown as Record<string, unknown>;
    expect(post(k1)).toMatchObject({ borttagen_av_typ: 'manniska', borttagen_av_namn: 'h3 david' });
    expect(post(k2)).toMatchObject({ borttagen_av_typ: 'agent', borttagen_av_namn: 'h3 städare' });
    expect(post(k3)).toMatchObject({ borttagen_av_typ: null, borttagen_av_namn: null });
    expect(post(k5), 'K5: borttagen, återställd, borttagen utan händelse').toMatchObject({
      borttagen_av_typ: null,
      borttagen_av_namn: null,
    });
    expect(post(k6), 'K6: borttagen, borttagen satt om utan händelse').toMatchObject({
      borttagen_av_typ: null,
      borttagen_av_namn: null,
    });
    expect(post(k7), 'K7: samtidig borttagning med lägre tidpunkt').toMatchObject({
      borttagen_av_typ: 'manniska',
      borttagen_av_namn: 'h3 gällande',
    });

    const json = JSON.stringify(lista);
    expect(json).not.toContain('h3 kommentarstext');
    expect(json).not.toContain('h3 författare');
  });

  it('H4 (AK 4): raden under Borttagna kommentarer bär den som tog bort, och avsnittet aldrig originalet', async () => {
    const original = await nyNyckel({ typ: 'agent', namn: 'h4 originalet' });
    const h4david = await nyNyckel({ typ: 'manniska', namn: 'h4 david' });
    const stadare = await nyNyckel({ typ: 'agent', namn: 'h4 städare' });
    const { identifier } = await steg(original, 'create_issue', { title: 'H4 borttagna på sidan', team_key: 'LOC' });
    const ids: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      ids.push((await steg(original, 'add_comment', { identifier, body: 'h4 originaltext tallkott' })).id);
    }
    const [a, b, c] = ids as [string, string, string];

    await steg(h4david, 'delete_comment', { kommentar_id: a });
    await steg(h4david, 'delete_comment', { kommentar_id: b });
    await steg(h4david, 'restore_comment', { kommentar_id: b });
    await steg(stadare, 'delete_comment', { kommentar_id: b });
    const admin = await adminKlient();
    try {
      await admin.query('UPDATE comments SET borttagen = now() WHERE id = $1', [c]);
    } finally {
      await admin.end();
    }

    // Kontroll först: originalets text och aktör finns i händelsens payload, så frånvaron i avsnittet mäter något.
    const handelser = (await steg(original, 'get_issue', { identifier })).handelser as {
      verb: string;
      payload: Record<string, unknown>;
    }[];
    const borttagning = handelser.find((h) => h.verb === 'tog_bort_kommentar');
    expect(borttagning?.payload['gammal_text']).toContain('tallkott');
    expect(borttagning?.payload['gammal_aktor_namn']).toBe('h4 originalet');

    // Med människosession bär varje rad Återställ-formuläret, och raden känns igen på dess action.
    const html = await sidan(identifier, await manniskokaka());
    const borttagna = avsnitt(html, '<h2>Borttagna kommentarer (', '<h2>Historik (');
    expect(borttagna).toContain(AVSNITTSTEXT);
    expect(borttagna).not.toContain('står kvar i historiken nedan — inte här');

    const rader = raderI(borttagna);
    const radFor = (id: string): string => {
      const traffar = rader.filter((rad) => rad.includes(`action="/vy/kommentar/${id}/aterstall"`));
      expect(traffar, id).toHaveLength(1);
      return traffar[0]!;
    };
    expect(huvudet(radFor(a))).toContain(` av</span>${proveniens('manniska', 'h4 david')}`);
    expect(huvudet(radFor(b))).toContain(proveniens('agent', 'h4 städare'));
    expect(huvudet(radFor(b))).not.toContain('h4 david');
    expect(huvudet(radFor(c))).toContain(proveniens('okänd', 'ingen händelserad'));
    expect(huvudet(radFor(c))).toContain('prov-okand');

    expect(borttagna).not.toContain('tallkott');
    expect(borttagna).not.toContain('h4 originalet');
  });
});

// ---- AK 5 ------------------------------------------------------------------------------------------------------

describe('FR-12/FR-8/Story 1.2 AK 5: ingen rad är omärkt', () => {
  it('H5 (AK 5): varje li.rad i Kommentarer, Borttagna kommentarer och Historik har exakt ett märke i huvudet', async () => {
    // Kontroll först: räknaren fäller en rad utan märke och en med två märken i huvudet.
    expect(markenIHuvudet('<li class=rad><div class=huvud><span>x</span></div></li>')).toBe(0);
    expect(
      markenIHuvudet(
        `<li class=rad><div class=huvud>${proveniens('agent', 'a')}${proveniens('manniska', 'b')}</div></li>`,
      ),
    ).toBe(2);

    await steg(david, 'add_comment', { identifier: 'LOC-316', body: 'h5 människotext' });
    await steg(hermes, 'add_comment', { identifier: 'LOC-316', body: 'h5 agenttext' });
    const borttagen = await steg(hermes, 'add_comment', { identifier: 'LOC-316', body: 'h5 borttagen text' });
    await steg(david, 'delete_comment', { kommentar_id: borttagen.id });

    for (const kaka of [undefined, await manniskokaka()]) {
      const lage = kaka === undefined ? 'utan session' : 'med session';
      const html = await sidan('LOC-316', kaka);
      const delar: [string, string][] = [
        ['Kommentarer', avsnitt(html, '<h2>Kommentarer (', '<h2>')],
        ['Borttagna kommentarer', avsnitt(html, '<h2>Borttagna kommentarer (', '<h2>Historik (')],
        ['Historik', avsnitt(html, '<h2>Historik (', '</main>')],
      ];
      for (const [namn, del] of delar) {
        const rader = raderI(del);
        expect(rader.length, `${lage}, ${namn}`).toBeGreaterThan(0);
        for (const rad of rader) {
          expect(markenIHuvudet(rad), `${lage}, ${namn}: ${rad}`).toBe(1);
          expect(huvudet(rad), `${lage}, ${namn}`).toMatch(/class="prov prov-(manniska|agent|system|okand)"/);
        }
      }

      const kommentarer = raderI(delar[0]![1]);
      const manniskorad = kommentarer.filter((rad) => rad.includes('h5 människotext'));
      expect(manniskorad, lage).toHaveLength(1);
      expect(huvudet(manniskorad[0]!)).toContain('människa · david');
      expect(huvudet(manniskorad[0]!)).toContain('prov-manniska');
      expect(huvudet(manniskorad[0]!)).not.toContain('AI-genererat');

      const agentrad = kommentarer.filter((rad) => rad.includes('h5 agenttext'));
      expect(agentrad, lage).toHaveLength(1);
      expect(huvudet(agentrad[0]!)).toContain('agent · hermes');
      expect(huvudet(agentrad[0]!)).toContain('prov-agent');
      expect(huvudet(agentrad[0]!)).toContain('AI-genererat innehåll — skrivet av en agent (AI Act art. 50)');

      const importrad = radMedVerb(delar[2]![1], 'importerade ärendet');
      expect(importrad, lage).toHaveLength(1);
      expect(huvudet(importrad[0]!)).toContain('system · linear-import');
      expect(huvudet(importrad[0]!)).toContain('prov-system');
    }

    // Den okända typen kan inte komma ur databasen (CHECK), så den prövas på funktionen; på sidan i H4.
    expect(proveniens('robot', 'h5 okänd')).toContain('prov-okand');
    expect(proveniens('robot', 'h5 okänd')).toContain('robot · h5 okänd');
  });
});

// ---- AK 1 ------------------------------------------------------------------------------------------------------

describe('FR-12/FR-8/Story 1.2 AK 1: tidigare text vid rättelse', () => {
  it('H6 (AK 1): rättelsernas historikrad bär Före och Efter som escapad ren text, aldrig element eller länkar', async () => {
    const G = '<script>alert("h6")</script> [[dokument]] LOC-1 https://example.com/h6-fore';
    const N = 'Rättad: LOC-1 och https://example.com/h6-efter';
    const { identifier } = await steg(hermes, 'create_issue', {
      title: 'H6 tidigare text',
      team_key: 'LOC',
      description: G,
    });
    const kommentar = await steg(hermes, 'add_comment', { identifier, body: G });
    await steg(david, 'update_comment', { kommentar_id: kommentar.id, body: N });
    await steg(david, 'update_issue', { identifier, description: N });

    const html = await sidan(identifier);
    // Kontroll först: samma LOC-1 i den levande kommentaren går genom autolänkaren och blir en länk, så
    // mätningen av «ingen länk» i blocket kan slå ut.
    expect(avsnitt(html, '<h2>Kommentarer (', '<h2>')).toContain('href="/vy/sok?q=LOC-1"');

    const historik = avsnitt(html, '<h2>Historik (', '</main>');
    for (const verb of ['rättade en kommentar', 'rättade beskrivningen']) {
      const rader = radMedVerb(historik, verb);
      expect(rader, verb).toHaveLength(1);
      const block = detaljerna(rader[0]!);
      // Exakt markup: hopfällt (inget open), Före före den gamla texten och Efter före den nya.
      expect(block, verb).toBe(tidigareText(esc(G), esc(N)));
      expect(block, verb).not.toContain('<script');
      expect(block, verb).not.toContain('<a ');
      expect(block, verb).toContain('&lt;script&gt;');
    }
  });
});

// ---- AK 2 ------------------------------------------------------------------------------------------------------

describe('FR-12/FR-8/Story 1.2 AK 2: den borttagna kommentaren syns i historiken', () => {
  it('H7 (AK 2): historikraden bär originalets märke och text i blocket, och texten står bara där', async () => {
    const h7agent = await nyNyckel({ typ: 'agent', namn: 'h7 agent' });
    const h7david = await nyNyckel({ typ: 'manniska', namn: 'h7 david' });
    const T = '<script>alert("h7")</script> h7 borttagen text';
    const { identifier } = await steg(h7agent, 'create_issue', { title: 'H7 borttagen kommentar', team_key: 'LOC' });
    const kommentar = await steg(h7agent, 'add_comment', { identifier, body: T });
    await steg(h7david, 'delete_comment', { kommentar_id: kommentar.id });

    const html = await sidan(identifier);
    const rader = radMedVerb(avsnitt(html, '<h2>Historik (', '</main>'), 'tog bort en kommentar');
    expect(rader).toHaveLength(1);
    const rad = rader[0]!;
    expect(markenIHuvudet(rad)).toBe(1);
    expect(huvudet(rad)).toContain(proveniens('manniska', 'h7 david'));

    const block = detaljerna(rad);
    expect(block).toBe(borttagenKommentar(proveniens('agent', 'h7 agent'), esc(T)));
    expect(block).toContain('AI-genererat innehåll');

    // Kontroll: huvudets märke (den som tog bort) och blockets märke (originalet) har olika klasser.
    const klass = (text: string): string | undefined => /class="prov (prov-[a-z]+)"/.exec(text)?.[1];
    expect(klass(huvudet(rad))).toBe('prov-manniska');
    expect(klass(block ?? '')).toBe('prov-agent');

    expect(avsnitt(html, '<h2>Kommentarer (', '<h2>')).not.toContain('h7 borttagen text');
    expect(avsnitt(html, '<h2>Borttagna kommentarer (', '<h2>Historik (')).not.toContain('h7 borttagen text');
    expect(html.split('h7 borttagen text')).toHaveLength(2);
  });
});

// ---- AK 3 ------------------------------------------------------------------------------------------------------

describe('FR-12/FR-8/Story 1.2 AK 3: äldre rader utan fälten', () => {
  it('H8 (AK 3): en äldre rad utan fälten visas med tid, märke och verb men utan details, och sidan fälls inte', async () => {
    const { identifier } = await steg(hermes, 'create_issue', { title: 'H8 äldre rader', team_key: 'LOC' });
    const issueId = (await steg(hermes, 'get_issue', { identifier })).arende.id as string;
    const kommentarId = '00000000-0000-4000-8000-000000000008';

    // Fallistan under AK 3, och sist kontrollraden med alla fält.
    const rader: [verb: string, verbtext: string, payload: Record<string, unknown>][] = [
      ['rattade_kommentar', 'rättade en kommentar', {}],
      ['rattade_beskrivning', 'rättade beskrivningen', { kommentar_id: kommentarId }],
      ['tog_bort_kommentar', 'tog bort en kommentar', { kommentar_id: kommentarId }],
      ['rattade_kommentar', 'rättade en kommentar', { kommentar_id: kommentarId, gammal_text: 'h8 utan ny text' }],
      ['tog_bort_kommentar', 'tog bort en kommentar', { kommentar_id: kommentarId, gammal_text: 'h8 utan aktör' }],
      [
        'tog_bort_kommentar',
        'tog bort en kommentar',
        { kommentar_id: kommentarId, gammal_text: 8, gammal_aktor_typ: 'agent', gammal_aktor_namn: 'h8 tal' },
      ],
      ['rattade_beskrivning', 'rättade beskrivningen', { gammal_text: 'h8 före', ny_text: 'h8 efter' }],
    ];
    // En sats i taget, så att varje rad får sin egen tidpunkt i insättningsordningen.
    const admin = await adminKlient();
    try {
      for (const [verb, , payload] of rader) {
        await admin.query(
          `INSERT INTO events (tenant_id, issue_id, aktor_typ, aktor_namn, verb, payload)
           VALUES ($1, $2, 'system', $3, $4, $5::jsonb)`,
          [TENANT_ID, issueId, 'h8 äldre', verb, JSON.stringify(payload)],
        );
      }
    } finally {
      await admin.end();
    }

    const fore = await raknaRader('events');
    const html = await sidan(identifier);
    expect(await raknaRader('events')).toBe(fore);

    const aldre = raderI(avsnitt(html, '<h2>Historik (', '</main>')).filter((rad) =>
      huvudet(rad).includes('system · h8 äldre'),
    );
    expect(aldre).toHaveLength(7);
    aldre.forEach((rad, i) => expect(huvudet(rad), `rad ${i + 1}`).toContain(`<span>${rader[i]![1]}</span>`));

    // Kontroll först: den sjunde raden har alla fält och får blocket, så att frånvaron nedan kan slå ut.
    const kontroll = detaljerna(aldre[6]!);
    expect(kontroll).toContain('h8 före');
    expect(kontroll).toContain('h8 efter');

    for (const [i, rad] of aldre.slice(0, 6).entries()) {
      expect(huvudet(rad), `rad ${i + 1}`).toMatch(/^<span>\d{4}-\d{2}-\d{2} /);
      expect(markenIHuvudet(rad), `rad ${i + 1}`).toBe(1);
      expect(rad, `rad ${i + 1}`).not.toContain('<details');
    }
  });
});

// ---- AK 7 ------------------------------------------------------------------------------------------------------

describe('FR-12/FR-8/Story 1.2 AK 7: digesten och läsningen är oförändrade', () => {
  it('H9 (AK 7): digesten visar verbet utan details, ingen GET skriver, och blocket byggs bara i ärenderutten', async () => {
    const { identifier } = await steg(hermes, 'create_issue', { title: 'H9 digestprovet', team_key: 'LOC' });
    const kommentar = await steg(hermes, 'add_comment', { identifier, body: 'h9 gammal' });
    await steg(david, 'update_comment', { kommentar_id: kommentar.id, body: 'h9 ny' });
    await steg(david, 'delete_comment', { kommentar_id: kommentar.id });

    const rakna = async (): Promise<{ events: number; comments: number }> => ({
      events: await raknaRader('events'),
      comments: await raknaRader('comments'),
    });
    const fore = await rakna();

    // Kontroll först: ärendesidan för samma händelser bär blocket och den gamla texten.
    const html = await sidan(identifier);
    expect(html).toContain('Visa tidigare text');
    expect(html).toContain('h9 gammal');
    expect(await rakna()).toEqual(fore);

    const digest = await request(app).get('/vy/digest');
    expect(digest.status).toBe(200);
    expect(await rakna()).toEqual(fore);
    expect(digest.text).toContain('H9 digestprovet');
    expect(digest.text).toContain('<span>rättade en kommentar</span>');
    expect(digest.text).toContain('<span>tog bort en kommentar</span>');
    for (const text of ['Visa tidigare text', 'Visa den borttagna kommentaren', '<details class=rattelse>', 'h9 gammal']) {
      expect(digest.text, text).not.toContain(text);
    }

    // Statiskt: definitionen och ett anrop, i ärenderuttens historiklista.
    const kallan = readFileSync(fileURLToPath(new URL('../src/http/routes/vy.ts', import.meta.url)), 'utf8');
    expect(kallan.split('historikDetaljer(')).toHaveLength(3);
  });
});
