// FR-37, B-14 (Story 2.2 AK 1–5): vyns felsidor säger på svenska vad som hände och varför.
//
// Provapparna monterar den riktiga skrivramen skrivrutt() med en hanterare som kastar en kod,
// eftersom ingen vyrutt ännu kastar `atagandet_styr_statusen` eller `kraver_manniska` (AK 1). De är
// inga mockar: ramen är produktionens, och sessionen är en riktig session ur en riktig inloggning.
//
// Valideringstexterna är svenska genom konstruktion: ogiltigInmatning() läser aldrig zods
// meddelande, bara felets slag, sökväg och gränser. Därför är fallen nedan en ändlig lista och ingen
// svartlista över engelska ord (Dev Notes → Avgränsade kriterier).
import { readFileSync } from 'node:fs';
import express, { type Express, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { pool } from '../src/db/pool.js';
import { createApp } from '../src/http/app.js';
import { glomAllaSessioner } from '../src/http/vy/session.js';
import { skrivrutt } from '../src/http/vy/skrivning.js';
import { BadRequestError, ForbiddenError } from '../src/lib/errors.js';
import { kor, nyNyckel, raknaRader, seedaTeam, TENANT_ID } from './helpers.js';

interface Kontext {
  identifier: string;
  kommentarId: string;
  kaka: string;
  manniskonyckel: string;
  agentnyckel: string;
}

interface Svar {
  status: number;
  text: string;
  headers: Record<string, unknown>;
}

interface Felfall {
  fall: string;
  namn: string;
  begaran: (k: Kontext) => Promise<Svar>;
  status: number;
  rubrik: string;
  /** Exakt innehåll i `p.notis`, escapat. */
  mening: string | ((k: Kontext) => string);
  /** Bara för ett AppError. */
  kod?: string;
  saknas: string[];
}

let app: Express;
let k: Kontext;

/**
 * Loggar in med en riktig nyckel och ger delen `arenden_vy=…` ur set-cookie. En misslyckad
 * inloggning svarar också 303 (till /vy/logga-in?fel=1…), så statusen räcker inte: kvittot och
 * kakan visar att en session föddes. Annars hade felet synts som en vilseledande 401 i varje fall.
 */
async function sessionskaka(nyckel: string): Promise<string> {
  const svar = await request(app).post('/vy/logga-in').type('form').send({ nyckel, fran: '/vy' });
  const kaka = [svar.headers['set-cookie'] ?? []].flat().map(String).find((c) => c.startsWith('arenden_vy='));
  if (svar.status !== 303 || svar.headers['location'] !== '/vy?notis=inloggad' || kaka === undefined) {
    throw new Error(`inloggningen misslyckades: ${svar.status} ${String(svar.headers['location'])}`);
  }
  return kaka.split(';')[0]!;
}

/** En app med en enda POST-rutt genom den riktiga skrivramen. Byggs i varje it, aldrig i beforeAll. */
function provapp(vag: string, hanterare: (req: Request, res: Response) => Promise<void>): Express {
  const prov = express();
  prov.post(vag, skrivrutt(hanterare));
  return prov;
}

/** Texterna i sidans h1, p.notis och code, hörnet, och sidan med varje code-element borttaget. */
function felsidan(html: string): { h1: string[]; notis: string[]; kod: string[]; hornet: string | null; utanKod: string } {
  const alla = (re: RegExp): string[] => [...html.matchAll(re)].map((m) => m[1]!);
  return {
    h1: alla(/<h1>([\s\S]*?)<\/h1>/g),
    notis: alla(/<p class=notis>([\s\S]*?)<\/p>/g),
    kod: alla(/<code>([\s\S]*?)<\/code>/g),
    hornet: /<div class=hornet>([\s\S]*?)<\/div>/.exec(html)?.[1] ?? null,
    utanKod: html.replace(/<code>[\s\S]*?<\/code>/g, ''),
  };
}

const meningen = (post: Felfall): string => (typeof post.mening === 'string' ? post.mening : post.mening(k));

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapa = (s: string): string => s.replace(/[&<>"']/g, (t) => ESCAPE[t]!);

/**
 * AK 2: avvikelserna från «koden står aldrig ensam». Exakt ett code-element med koden (escapad), i
 * stycket `<p>Felkod: <code>…</code></p>` direkt efter sidans enda p.notis; p.notis är inte koden,
 * och utanför code-elementet står koden ingenstans. Tom lista = sidan håller.
 */
function felkodsfel(html: string, kod: string): string[] {
  const fel: string[] = [];
  const sidan = felsidan(html);
  const kodtext = escapa(kod);
  if (sidan.kod.length !== 1 || sidan.kod[0] !== kodtext) fel.push(`code: [${sidan.kod.join(' | ')}]`);
  const notiser = [...html.matchAll(/<p class=notis>[\s\S]*?<\/p>/g)];
  if (notiser.length !== 1) {
    fel.push(`p.notis: ${notiser.length} stycken`);
  } else {
    const efter = notiser[0]!.index! + notiser[0]![0].length;
    if (!html.startsWith(`<p>Felkod: <code>${kodtext}</code></p>`, efter)) fel.push('Felkod-stycket står inte direkt efter p.notis');
  }
  if (sidan.notis.some((n) => n === kodtext || n === kod)) fel.push('p.notis är koden');
  if (sidan.utanKod.includes(kodtext) || sidan.utanKod.includes(kod)) fel.push('koden står utanför code');
  return fel;
}

/** Ärendets titel och beskrivning ur get_issue. Svaret är `{ arende, kommentarer, … }`. */
async function arendetsText(): Promise<{ title: unknown; description: unknown }> {
  const svar = await kor(app, k.agentnyckel, 'get_issue', { identifier: k.identifier });
  expect(svar.status, 'get_issue').toBe(200);
  return { title: svar.body.result.arende.title, description: svar.body.result.arende.description };
}

const FIXTURENS_TEXT = { title: 'F22 felbesked', description: 'Grundtext.' };

async function kommentarstext(): Promise<string | undefined> {
  const { rows } = await pool.query<{ body: string }>('SELECT body FROM comments WHERE tenant_id = $1 AND id = $2', [
    TENANT_ID,
    k.kommentarId,
  ]);
  return rows[0]?.body;
}

async function etikettnamn(): Promise<string[]> {
  const { rows } = await pool.query<{ namn: string }>(
    'SELECT namn FROM labels WHERE tenant_id = $1 AND namn = ANY($2) ORDER BY namn',
    [TENANT_ID, ['f22-a', 'f22-b']],
  );
  return rows.map((r) => r.namn);
}

/** Postens egen kontroll: status, rubrik, mening och saknas. Felkod-stycket prövas av F6–F9. */
function kontrollera(post: Felfall, svar: Svar): void {
  const sidan = felsidan(svar.text);
  expect(svar.status, post.namn).toBe(post.status);
  expect(sidan.h1, post.namn).toEqual([post.rubrik]);
  expect(sidan.notis, post.namn).toEqual([meningen(post)]);
  for (const text of post.saknas) expect(svar.text, `${post.namn}: ${text}`).not.toContain(text);
}

// ---- Tabellen över felsidorna ----------------------------------------------

const KORSANDE = 'Begäran kom inte från vyns egna sidor och avvisades. Ingenting sparades.';
const KORSANDE_SAKNAS = ['korsande ursprung nekas', 'ogiltig origin'];
const ATAGANDE_SLUT =
  ' bär ett åtagande, och då följer tillståndet åtagandets läge. Klart går när åtagandet är genomfört och ' +
  'Avbrutet när det är avslutat.';
const ATAGANDE_SAKNAS = ['statusen foljer atagandet', 'redovisa_resultat'];
const MANNISKA_TJANST = 'en insats besvaras av en människa — en agentnyckel kan inte bokföras som ett mänskligt svar';
const OKAND_KOD = 'Tjänsten avvisade ändringen utan en förklaring i klartext.';
const ESCAPEKOD = 'prov_<b>"kod"';
const ESCAPEMENING = 'Tjänsten säger <script>alert(1)</script> & "citat" \'enkel\'';

/** Tjänstelagrets mening i samma form som src/services/arenden.ts. */
const atagandeTjanst = (req: Request): string =>
  `${String(req.params['identifier'] ?? 'LOC-?')} bar ett atagande i laget "registrerat" — statusen foljer atagandet. ` +
  'Anvand redovisa_resultat (kraver belagg) eller avsluta_atagande (kraver grund).';

/** Utan räknare, så att F8 och F17 kan hämta sidan igen utan att röra F3:s räknare. */
const kastaAtagande = async (req: Request): Promise<void> => {
  throw new BadRequestError('atagandet_styr_statusen', atagandeTjanst(req));
};

async function kommentera(k: Kontext, huvuden: Record<string, string>): Promise<Svar> {
  let begaran = request(app).post(`/vy/arende/${k.identifier}/kommentar`).set('Cookie', k.kaka);
  for (const [namn, varde] of Object.entries(huvuden)) begaran = begaran.set(namn, varde);
  return begaran.type('form').send({ body: 'F22 korsande' });
}

const LANGD_SAKNAS = ['String must contain', 'character(s)', '<code>'];

/** Ett formulär-POST med sessionen. `kropp` är ett objekt eller en rå formulärkropp. */
async function posta(k: Kontext, vag: string, kropp: Record<string, string> | string): Promise<Svar> {
  return request(app).post(vag).set('Cookie', k.kaka).type('form').send(kropp);
}

/** En provapp vars hanterare kör en zod-parse som fäller, genom den riktiga skrivramen. */
async function zodprov(k: Kontext, vag: string, parse: () => unknown): Promise<Svar> {
  return request(
    provapp(vag, async () => {
      parse();
    }),
  )
    .post(vag)
    .set('Cookie', k.kaka)
    .type('form')
    .send({});
}

const FELFALL: Felfall[] = [
  {
    fall: 'F1',
    namn: 'F1 främmande Origin',
    begaran: (k) => kommentera(k, { Origin: 'https://elak.example' }),
    status: 403,
    rubrik: 'Gick inte att utföra',
    mening: KORSANDE,
    kod: 'cross_origin',
    saknas: KORSANDE_SAKNAS,
  },
  {
    fall: 'F1',
    namn: 'F1 Origin: null',
    begaran: (k) => kommentera(k, { Origin: 'null' }),
    status: 403,
    rubrik: 'Gick inte att utföra',
    mening: KORSANDE,
    kod: 'cross_origin',
    saknas: KORSANDE_SAKNAS,
  },
  {
    fall: 'F1',
    namn: 'F1 Sec-Fetch-Site: cross-site',
    begaran: (k) => kommentera(k, { 'Sec-Fetch-Site': 'cross-site' }),
    status: 403,
    rubrik: 'Gick inte att utföra',
    mening: KORSANDE,
    kod: 'cross_origin',
    saknas: KORSANDE_SAKNAS,
  },
  {
    fall: 'F2',
    namn: 'F2 inloggningen med Sec-Fetch-Site: cross-site',
    begaran: async (k) =>
      request(app)
        .post('/vy/logga-in')
        .set('Sec-Fetch-Site', 'cross-site')
        .type('form')
        .send({ nyckel: k.manniskonyckel, fran: '/vy' }),
    status: 403,
    rubrik: 'Gick inte att utföra',
    mening: KORSANDE,
    kod: 'cross_origin',
    saknas: KORSANDE_SAKNAS,
  },
  {
    fall: 'F2',
    namn: 'F2 utloggningen med främmande Origin',
    begaran: async () => request(app).post('/vy/logga-ut').set('Origin', 'https://elak.example').type('form').send({}),
    status: 403,
    rubrik: 'Gick inte att utföra',
    mening: KORSANDE,
    kod: 'cross_origin',
    saknas: KORSANDE_SAKNAS,
  },
  {
    fall: 'F3',
    namn: 'F3 atagandet_styr_statusen med ärendenummer',
    begaran: async (k) =>
      request(provapp('/vy/arende/:identifier/provfel', kastaAtagande))
        .post(`/vy/arende/${k.identifier}/provfel`)
        .set('Cookie', k.kaka)
        .type('form')
        .send({}),
    status: 400,
    rubrik: 'Tillståndet följer åtagandet',
    mening: (k) => `${k.identifier}${ATAGANDE_SLUT}`,
    kod: 'atagandet_styr_statusen',
    saknas: ATAGANDE_SAKNAS,
  },
  {
    fall: 'F4',
    namn: 'F4 kraver_manniska',
    begaran: async (k) =>
      request(
        provapp('/vy/provfel-manniska', async () => {
          throw new ForbiddenError('kraver_manniska', MANNISKA_TJANST);
        }),
      )
        .post('/vy/provfel-manniska')
        .set('Cookie', k.kaka)
        .type('form')
        .send({}),
    status: 403,
    rubrik: 'Det här kräver en människa',
    mening: 'Handgreppet bokförs alltid som människa. Logga in med din människonyckel.',
    kod: 'kraver_manniska',
    saknas: [MANNISKA_TJANST],
  },
  {
    fall: 'F5',
    namn: 'F5 atagandet_styr_statusen på en rutt utan nummer',
    begaran: async (k) =>
      request(provapp('/vy/provfel-utan-nummer', kastaAtagande))
        .post('/vy/provfel-utan-nummer')
        .set('Cookie', k.kaka)
        .type('form')
        .send({}),
    status: 400,
    rubrik: 'Tillståndet följer åtagandet',
    mening: `Ärendet${ATAGANDE_SLUT}`,
    kod: 'atagandet_styr_statusen',
    saknas: [...ATAGANDE_SAKNAS, 'Tillbaka till', '<b>'],
  },
  {
    fall: 'F5',
    namn: 'F5 atagandet_styr_statusen med ett ogiltigt nummer',
    begaran: async (k) =>
      request(provapp('/vy/arende/:identifier/provfel', kastaAtagande))
        .post('/vy/arende/LOC-1%22%3E%3Cb%3Eny/provfel')
        .set('Cookie', k.kaka)
        .type('form')
        .send({}),
    status: 400,
    rubrik: 'Tillståndet följer åtagandet',
    mening: `Ärendet${ATAGANDE_SLUT}`,
    kod: 'atagandet_styr_statusen',
    saknas: [...ATAGANDE_SAKNAS, 'Tillbaka till', '<b>'],
  },
  {
    fall: 'F6',
    namn: 'F6 namnet_upptaget genom etiketträttelsen',
    begaran: async (k) =>
      request(app).post('/vy/namn/etikett').set('Cookie', k.kaka).type('form').send({ fran: 'f22-a', till: 'f22-b' }),
    status: 400,
    rubrik: 'Gick inte att utföra',
    mening: 'ett annat objekt heter redan så',
    kod: 'namnet_upptaget',
    saknas: [],
  },
  {
    fall: 'F7',
    namn: 'F7 okänd kod utan eget meddelande',
    begaran: async (k) =>
      request(
        provapp('/vy/provfel-bara-kod', async () => {
          throw new BadRequestError('provkod_utan_mening');
        }),
      )
        .post('/vy/provfel-bara-kod')
        .set('Cookie', k.kaka)
        .type('form')
        .send({}),
    status: 400,
    rubrik: 'Gick inte att utföra',
    mening: OKAND_KOD,
    kod: 'provkod_utan_mening',
    saknas: [],
  },
  {
    fall: 'F9',
    namn: 'F9 HTML-tecken i meddelandet och koden',
    begaran: async (k) =>
      request(
        provapp('/vy/provfel-escape', async () => {
          throw new BadRequestError(ESCAPEKOD, ESCAPEMENING);
        }),
      )
        .post('/vy/provfel-escape')
        .set('Cookie', k.kaka)
        .type('form')
        .send({}),
    status: 400,
    rubrik: 'Gick inte att utföra',
    mening: 'Tjänsten säger &lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;citat&quot; &#39;enkel&#39;',
    kod: ESCAPEKOD,
    saknas: ['<script', '<b>'],
  },
  {
    fall: 'F10',
    namn: 'F10 titel över 300 tecken',
    begaran: (k) => posta(k, `/vy/arende/${k.identifier}/ratta`, { titel: 'T'.repeat(301), beskrivning: 'Grundtext.' }),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Titel får vara högst 300 tecken.',
    saknas: LANGD_SAKNAS,
  },
  {
    fall: 'F11',
    namn: 'F11 tom titel',
    begaran: (k) => posta(k, `/vy/arende/${k.identifier}/ratta`, { titel: '', beskrivning: 'Grundtext.' }),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Titel måste fyllas i.',
    saknas: LANGD_SAKNAS,
  },
  {
    fall: 'F12',
    namn: 'F12 beskrivning över 20 000 tecken',
    begaran: (k) =>
      posta(k, `/vy/arende/${k.identifier}/ratta`, { titel: 'F22 felbesked', beskrivning: 'B'.repeat(20001) }),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Beskrivning får vara högst 20000 tecken.',
    saknas: LANGD_SAKNAS,
  },
  {
    fall: 'F13',
    namn: 'F13 ny kommentar över 20 000 tecken',
    begaran: (k) => posta(k, `/vy/arende/${k.identifier}/kommentar`, { body: 'K'.repeat(20001) }),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Kommentar får vara högst 20000 tecken.',
    saknas: LANGD_SAKNAS,
  },
  {
    fall: 'F13',
    namn: 'F13 kommentarsrättelse över 20 000 tecken',
    begaran: (k) => posta(k, `/vy/kommentar/${k.kommentarId}/ratta`, { body: 'K'.repeat(20001), fran: '/vy' }),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Kommentar får vara högst 20000 tecken.',
    saknas: LANGD_SAKNAS,
  },
  {
    fall: 'F14',
    namn: 'F14 tomt nytt projektnamn',
    begaran: (k) => posta(k, '/vy/namn/projekt', { fran: 'F22 projekt som inte finns', till: '' }),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Nytt namn måste fyllas i.',
    saknas: LANGD_SAKNAS,
  },
  {
    fall: 'F14',
    namn: 'F14 för långt nytt etikettnamn',
    begaran: (k) => posta(k, '/vy/namn/etikett', { fran: 'f22-a', till: 'e'.repeat(101) }),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Nytt namn får vara högst 100 tecken.',
    saknas: LANGD_SAKNAS,
  },
  {
    fall: 'F15',
    namn: 'F15 ogiltigt kommentars-id i adressen',
    begaran: (k) => posta(k, '/vy/kommentar/inte-en-uuid/ratta', { body: 'x', fran: '/vy' }),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Kommentarens id har ett värde som inte kan tas emot.',
    saknas: ['Invalid uuid', '<code>'],
  },
  {
    fall: 'F15',
    namn: 'F15 dubblerat titelfält',
    begaran: (k) => posta(k, `/vy/arende/${k.identifier}/ratta`, 'titel=A&titel=B&beskrivning=C'),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Titel har ett värde som inte kan tas emot.',
    saknas: ['Expected string', '<code>'],
  },
  {
    fall: 'F16',
    namn: 'F16 zod-fel på ett fält utanför fälttabellen',
    begaran: (k) => zodprov(k, '/vy/provfel-zod-falt', () => z.object({ okant: z.string() }).strict().parse({})),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Ett fält har ett värde som inte kan tas emot.',
    saknas: ['Required', '<code>'],
  },
  {
    fall: 'F16',
    namn: 'F16 zod-fel utan sökväg',
    begaran: (k) => zodprov(k, '/vy/provfel-zod-tom', () => z.string().parse(5)),
    status: 400,
    rubrik: 'Ogiltig inmatning',
    mening: 'Formuläret har ett värde som inte kan tas emot.',
    saknas: ['Expected string', '<code>'],
  },
];

const posterna = (fall: string): Felfall[] => FELFALL.filter((p) => p.fall === fall);

// ---- Fixturen, på filnivå så att varje block har den ------------------------

beforeAll(async () => {
  app = createApp();
  glomAllaSessioner();
  await seedaTeam();
  const agentnyckel = await nyNyckel({ typ: 'agent', namn: 'f22 agent' });
  const manniskonyckel = await nyNyckel({ typ: 'manniska', namn: 'f22 människa' });

  const skapat = await kor(app, agentnyckel, 'create_issue', {
    title: 'F22 felbesked',
    team_key: 'LOC',
    description: 'Grundtext.',
  });
  expect(skapat.status, 'create_issue').toBe(200);
  const identifier = skapat.body.result.identifier as string;
  expect(identifier).toMatch(/^LOC-\d+$/);

  const kommentar = await kor(app, agentnyckel, 'add_comment', { identifier, body: 'F22 kommentar' });
  expect(kommentar.status, 'add_comment').toBe(200);

  for (const label of ['f22-a', 'f22-b']) {
    const svar = await kor(app, agentnyckel, 'add_label', { identifier, label });
    expect(svar.status, `add_label ${label}`).toBe(200);
  }

  k = {
    identifier,
    kommentarId: kommentar.body.result.id as string,
    kaka: await sessionskaka(manniskonyckel),
    manniskonyckel,
    agentnyckel,
  };
});

// ---- AK 1 och AK 5 ----------------------------------------------------------

describe('FR-37/Story 2.2 AK 1 och AK 5: felkodstabellen', () => {
  it('F1 (AK 1 och AK 5): cross_origin genom kommentarsrutten ger den svenska meningen och skriver ingenting', async () => {
    const handelser = await raknaRader('events');
    const kommentarer = await raknaRader('comments');

    const poster = posterna('F1');
    expect(poster).toHaveLength(3);
    for (const post of poster) kontrollera(post, await post.begaran(k));
    expect(await raknaRader('events')).toBe(handelser);
    expect(await raknaRader('comments')).toBe(kommentarer);

    // Kontroll: samma POST utan främmande huvud går igenom, och räkningen slår ut.
    const ok = await kommentera(k, {});
    expect(ok.status).toBe(303);
    expect(await raknaRader('comments')).toBe(kommentarer + 1);
    expect(await raknaRader('events')).toBe(handelser + 1);
  });

  it('F2 (AK 1 och AK 5): cross_origin genom ursprungOk() vid in- och utloggningen', async () => {
    const handelser = await raknaRader('events');
    const [inloggning, utloggning] = posterna('F2');

    const svarIn = await inloggning!.begaran(k);
    kontrollera(inloggning!, svarIn);
    const kakor = [svarIn.headers['set-cookie'] ?? []].flat().map(String);
    expect(kakor.filter((c) => c.startsWith('arenden_vy='))).toEqual([]);

    kontrollera(utloggning!, await utloggning!.begaran(k));
    expect(await raknaRader('events')).toBe(handelser);
  });

  it('F3 (AK 1): atagandet_styr_statusen genom skrivramen ger rubriken, ärendets nummer och vägen tillbaka', async () => {
    const handelser = await raknaRader('events');
    let anrop = 0;
    const prov = provapp('/vy/arende/:identifier/provfel', async (req) => {
      anrop += 1;
      throw new BadRequestError('atagandet_styr_statusen', atagandeTjanst(req));
    });
    const post = posterna('F3')[0]!;

    const svar = await request(prov)
      .post(`/vy/arende/${k.identifier}/provfel`)
      .set('Cookie', k.kaka)
      .type('form')
      .send({});
    kontrollera(post, svar);
    expect(svar.text).toContain(`<p><a href="/vy/arende/${k.identifier}">Tillbaka till ${k.identifier}</a></p>`);
    expect(anrop).toBe(1);

    // Länken leder till ärendesidan i den riktiga appen.
    expect((await request(app).get(`/vy/arende/${k.identifier}`)).status).toBe(200);
    expect(await raknaRader('events')).toBe(handelser);

    // Kontroll: ramens ordning är oförändrad. Utan session svarar ramen 401 innan hanteraren körs.
    const utan = await request(prov).post(`/vy/arende/${k.identifier}/provfel`).type('form').send({});
    expect(utan.status).toBe(401);
    expect(felsidan(utan.text).h1).toEqual(['Inloggning krävs']);
    expect(anrop).toBe(1);
  });

  it('F4 (AK 1): kraver_manniska genom skrivramen ger «Det här kräver en människa»', async () => {
    const post = posterna('F4')[0]!;
    kontrollera(post, await post.begaran(k));
  });

  it('F5 (AK 1): atagandet_styr_statusen utan giltigt ärendenummer i adressen säger «Ärendet» och länkar inte', async () => {
    const poster = posterna('F5');
    expect(poster).toHaveLength(2);
    for (const post of poster) kontrollera(post, await post.begaran(k));
  });
});

// ---- AK 2 -------------------------------------------------------------------

describe('FR-37/Story 2.2 AK 2: okänd kod och koden aldrig ensam', () => {
  it('F6 (AK 2 och AK 5): en okänd kod genom en riktig skrivrutt visar tjänstens mening och koden efter den', async () => {
    const handelser = await raknaRader('events');
    const post = posterna('F6')[0]!;

    const svar = await post.begaran(k);
    kontrollera(post, svar);
    expect(svar.text).toContain(
      '<p class=notis>ett annat objekt heter redan så</p><p>Felkod: <code>namnet_upptaget</code></p>',
    );
    expect(await raknaRader('events')).toBe(handelser);
    expect(await etikettnamn()).toEqual(['f22-a', 'f22-b']);
  });

  it('F7 (AK 2 och AK 1): en kod utan eget meddelande får en fast mening, och ett ärvt namn är ingen post', async () => {
    const post = posterna('F7')[0]!;
    const svar = await post.begaran(k);
    kontrollera(post, svar);
    expect(svar.text).toContain('<p>Felkod: <code>provkod_utan_mening</code></p>');

    // `constructor` ärvs av varje objekt; uppslaget i FELBESKED får inte ta det för en post.
    const arvt = await request(
      provapp('/vy/provfel-arvt-namn', async () => {
        throw new BadRequestError('constructor');
      }),
    )
      .post('/vy/provfel-arvt-namn')
      .set('Cookie', k.kaka)
      .type('form')
      .send({});
    expect(arvt.status).toBe(400);
    expect(felsidan(arvt.text).h1).toEqual(['Gick inte att utföra']);
    expect(felsidan(arvt.text).notis).toEqual([OKAND_KOD]);
    expect(arvt.text).toContain(`<p class=notis>${OKAND_KOD}</p><p>Felkod: <code>constructor</code></p>`);
  });

  it('F8 (AK 2): på de tolv sidorna som bär en kod står koden bara i code, efter meningen', async () => {
    // Kontroll: dagens form, där koden är hela meningen, fälls.
    expect(felkodsfel('<h1>Gick inte att utföra</h1><p class=notis>namnet_upptaget</p>', 'namnet_upptaget')).not.toEqual(
      [],
    );

    const medKod = FELFALL.filter((p) => p.kod !== undefined);
    expect(medKod).toHaveLength(12);
    for (const post of medKod) {
      const svar = await post.begaran(k);
      expect(felkodsfel(svar.text, post.kod!), post.namn).toEqual([]);
    }
  });

  it('F9 (AK 2 och AK 4): HTML-tecken i meddelandet och koden kommer ut escapade', async () => {
    const post = posterna('F9')[0]!;
    const svar = await post.begaran(k);
    kontrollera(post, svar);
    expect(svar.text).toContain('<p>Felkod: <code>prov_&lt;b&gt;&quot;kod&quot;</code></p>');
  });
});

// ---- AK 3 och AK 5 ----------------------------------------------------------

describe('FR-37/Story 2.2 AK 3: valideringsfel på svenska', () => {
  /** Ärendets rättelse: varje post avvisas, ingen rad skrivs och ärendet har kvar fixturens text. */
  async function rattelsenAvvisas(fall: string, antal: number): Promise<void> {
    const handelser = await raknaRader('events');
    const poster = posterna(fall);
    expect(poster).toHaveLength(antal);
    for (const post of poster) kontrollera(post, await post.begaran(k));
    expect(await raknaRader('events')).toBe(handelser);
    expect(await arendetsText()).toEqual(FIXTURENS_TEXT);
  }

  it('F10 (AK 3 och AK 5): titel över 300 tecken', async () => {
    await rattelsenAvvisas('F10', 1);
  });

  it('F11 (AK 3 och AK 5): tom titel', async () => {
    await rattelsenAvvisas('F11', 1);
  });

  it('F12 (AK 3 och AK 5): beskrivning över 20 000 tecken', async () => {
    await rattelsenAvvisas('F12', 1);
  });

  it('F13 (AK 3 och AK 5): kommentar och kommentarsrättelse över 20 000 tecken', async () => {
    const handelser = await raknaRader('events');
    const kommentarer = await raknaRader('comments');
    const poster = posterna('F13');
    expect(poster).toHaveLength(2);
    for (const post of poster) kontrollera(post, await post.begaran(k));
    expect(await raknaRader('comments')).toBe(kommentarer);
    expect(await raknaRader('events')).toBe(handelser);
    expect(await kommentarstext()).toBe('F22 kommentar');
  });

  it('F14 (AK 3 och AK 5): tomt och för långt nytt namn', async () => {
    const handelser = await raknaRader('events');
    const projekt = await raknaRader('projects');
    const poster = posterna('F14');
    expect(poster).toHaveLength(2);
    for (const post of poster) kontrollera(post, await post.begaran(k));
    expect(await raknaRader('events')).toBe(handelser);
    expect(await raknaRader('projects')).toBe(projekt);
    expect(await etikettnamn()).toContain('f22-a');
  });

  it('F15 (AK 3 och AK 5): fel som längdmallen inte täcker får reservmallen', async () => {
    await rattelsenAvvisas('F15', 2);
  });

  it('F16 (AK 3): ett fält utanför fälttabellen och en tom sökväg får reservnamnen', async () => {
    const poster = posterna('F16');
    expect(poster).toHaveLength(2);
    for (const post of poster) kontrollera(post, await post.begaran(k));
  });
});

// ---- AK 4 -------------------------------------------------------------------

describe('FR-37/Story 2.2 AK 4: felsidornas form', () => {
  it('F17 (AK 4 och AK 2): varje felsida har status, en h1, en mening, vägen tillbaka och ett tyst hörn', async () => {
    // Kontroll: på en vanlig sida utan session står «Logga in» i hörnet, så hörnkontrollen slår ut.
    const vanlig = await request(app).get('/vy/logga-in');
    expect(vanlig.status).toBe(200);
    expect(felsidan(vanlig.text).hornet).toContain('class=jag');

    expect(FELFALL).toHaveLength(23);
    const sidor: { namn: string; status: number; kod?: string; svar: Svar }[] = [];
    for (const post of FELFALL) {
      sidor.push({ namn: post.namn, status: post.status, kod: post.kod, svar: await post.begaran(k) });
    }
    const utanSession = await request(app)
      .post(`/vy/arende/${k.identifier}/kommentar`)
      .type('form')
      .send({ body: 'F22 utan session' });
    expect(felsidan(utanSession.text).h1).toEqual(['Inloggning krävs']);
    sidor.push({ namn: '401-sidan', status: 401, svar: utanSession });
    expect(sidor).toHaveLength(24);

    for (const { namn, status, kod, svar } of sidor) {
      const sidan = felsidan(svar.text);
      expect(svar.status, namn).toBe(status);
      expect(sidan.h1, namn).toHaveLength(1);
      expect(sidan.notis, namn).toHaveLength(1);
      expect(sidan.notis[0]!.trim(), namn).not.toBe('');
      expect(svar.text, namn).toContain('<a href="/vy">Till överblicken</a>');
      expect(sidan.hornet, `${namn}: hörnet`).not.toBeNull();
      expect(sidan.hornet, `${namn}: hörnet`).not.toContain('class=jag');
      expect(sidan.hornet, `${namn}: hörnet`).not.toContain('class="prov');
      for (const text of ['<script', 'node_modules', 'ZodError', 'BadRequestError', 'ForbiddenError', 'AppError']) {
        expect(svar.text, `${namn}: ${text}`).not.toContain(text);
      }
      if (kod === undefined) {
        for (const text of ['validation_error', 'unauthenticated', '<code>']) {
          expect(svar.text, `${namn}: ${text}`).not.toContain(text);
        }
      }
    }
  });
});

// ---- Dokumentationen --------------------------------------------------------

const README_RUBRIK = '### FR-37 — svenska felbesked i vyn (Story 2.2)';
const README_REGEL =
  '- Vyns felsidor (B-14, Story 2.2): ett `AppError` utom `UnauthenticatedError` i `skrivrutt()` eller ' +
  '`ursprungOk()` blir felsida bara genom `svaraMedFelbesked()` och den slutna felkodstabellen `FELBESKED` i ' +
  '`src/http/vy/skrivning.ts`, som ger svensk rubrik och mening. En ny felkod som ytan kan möta läggs i tabellen. ' +
  'En kod som inte står där visar tjänstens meddelande, eller en fast mening när meddelandet bara är koden, och ' +
  'felkoden står bara i ett `code`-element efter meningen, aldrig ensam. Ett valideringsfel visar fältets namn ur ' +
  '`FALTNAMN` och en fast mening, och zods `message` läses aldrig i vylagret. Felsidor anropar `sida()` utan ' +
  'aktör, så hörnet är tyst. Statusen är felets egen, som på `/api`.';

/** Avvikelserna i README:s FR-37-avsnitt: rubriken, regelns rad och de tre tabellraderna. Tom = avsnittet håller. */
function readmeFel(readme: string): string[] {
  const start = readme.indexOf(`\n${README_RUBRIK}\n`);
  if (start === -1) return ['rubriken saknas'];
  const efter = readme.slice(start + README_RUBRIK.length + 2);
  const slut = efter.search(/\n#{2,3} /);
  const rader = (slut === -1 ? efter : efter.slice(0, slut)).split('\n');
  const fel: string[] = [];
  const regler = rader.filter((r) => r.startsWith('- Vyns felsidor (B-14, Story 2.2):'));
  if (regler.length !== 1 || regler[0] !== README_REGEL) fel.push(`regelns rad: ${regler.length} rader, inte ordagrann`);
  const tabell = rader.filter((r) => r.startsWith('| FR-37'));
  if (tabell.length !== 3) fel.push(`${tabell.length} rader som börjar med | FR-37`);
  for (const rad of tabell) {
    if (!rad.includes('src/http/vy/skrivning.ts') || !rad.includes('test/felbesked-yta.test.ts')) fel.push(rad);
  }
  return fel;
}

describe('FR-37/Story 2.2: README bär felbeskeden', () => {
  it('F18 (dokumentationen): README:s FR-37-avsnitt bär regeln och tre rader krav → kod → test', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readmeFel(readme)).toEqual([]);

    // Kontroll: samma text utan avsnittet, från rubriken till nästa rubrik på nivå två eller tre, fälls.
    const utan = readme.replace(/\n### FR-37 — [^\n]*\n[\s\S]*?(?=\n#{2,3} )/, '');
    expect(utan).not.toBe(readme);
    expect(readmeFel(utan)).not.toEqual([]);
  });
});
