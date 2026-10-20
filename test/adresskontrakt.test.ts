// FR-32, FR-15, B-04 (Story 2.6 AK 1–2): tillståndsrutten står i adresskontraktet.
//
// Kopian kontrakt/navigation.v1.json är genererad i valvet och redigeras aldrig här (kontrakt/README.md).
// Provet läser den bara genom kontraktet() i src/http/vy/navigation.ts.
//
// Grinden läser appens egna routerobjekt, alltså det som faktiskt betjänar, och inte källtexten. Då behövs
// ingen lista över skrivsätt, och en sådan lista saknar alltid en form (Story 2.4:s granskning).
//
// Monteringarna (montering()) och de väntande rutterna (VANTANDE) är slutna listor: en router utanför
// listan fäller F1, och en rutt som kopian bär före koden måste stå i VANTANDE.
//
// Andra tjänsters halva av kopian läses med flit inte (K-9). Den och de tre kopiornas likhet prövar provet
// adresskontraktet i provvakten.
//
// vi.mock används inte (docs/project-context.md, Testregler): modell() och produktmeny() får sin kopia
// respektive modell som parameter.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { Router } from 'express';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { actionsRouter } from '../src/http/routes/actions.js';
import { vyRouter } from '../src/http/routes/vy.js';
import { produktmeny } from '../src/http/vy/mall.js';
import type { Kontrakt, KontraktRutt } from '../src/http/vy/navigation.js';
import { kontraktet, modell } from '../src/http/vy/navigation.js';
import { nyNyckel, seedaTeam } from './helpers.js';

let app: Express;

beforeAll(async () => {
  app = createApp();
  await seedaTeam();
});

// ---- Typerna ------------------------------------------------------------------

/** En rutt som appen registrerar. */
type Kodrutt = { method: string; router_pattern: string; public_pattern: string };

/** En plats där tjänstens rutter registreras. */
type Montering = { namn: string; router: unknown; prefix: string };

// ---- Monteringarna och routerläsningen ----------------------------------------

/**
 * Sluten lista över var tjänstens rutter registreras. Den speglar src/http/app.ts: `app.get('/health', …)`
 * direkt på appen (rad 51), `app.use('/vy', vyRouter)` (rad 76) och `actionsRouter` sist i
 * `app.use('/api', …)` (rad 78–94). En router som monteras utan en post här fäller F1.
 */
function montering(a: Express): Montering[] {
  return [
    { namn: 'app', router: a.router, prefix: '' },
    { namn: 'vy', router: vyRouter, prefix: '/vy' },
    { namn: 'api', router: actionsRouter, prefix: '/api' },
  ];
}

const arObjekt = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Routerns lager, eller `null` när värdet inte bär en lista `stack`. */
function stacken(v: unknown): unknown[] | null {
  if ((typeof v !== 'function' && typeof v !== 'object') || v === null) return null;
  const stack: unknown = Reflect.get(v, 'stack');
  return Array.isArray(stack) ? stack : null;
}

const jamfor = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Den publika adressen: under ett prefix blir `/` prefixet självt. */
function publik(prefix: string, monster: string): string {
  if (prefix === '') return monster;
  return monster === '/' ? prefix : prefix + monster;
}

function nyckel(r: { method: string; public_pattern: string; router_pattern: string }): string {
  return `${r.method} ${r.public_pattern} (${r.router_pattern})`;
}

/**
 * Varje rutt i monteringarnas routrar, sorterad på nyckel(). Mellanlager har ingen `route` och räknas inte.
 * En rutt för alla metoder (`router.all()`) kan kontraktet inte bära, och den får inte försvinna i tysthet.
 */
function kodrutter(monteringar: Montering[]): Kodrutt[] {
  const ut: Kodrutt[] = [];
  for (const { namn, router, prefix } of monteringar) {
    for (const lager of stacken(router) ?? []) {
      if (!arObjekt(lager) || !arObjekt(lager['route'])) continue;
      const route = lager['route'];
      const path = route['path'];
      if (typeof path !== 'string') {
        throw new Error(`${namn}: routermönstret är inte en sträng: ${String(path)}`);
      }
      const metoder = arObjekt(route['methods']) ? route['methods'] : {};
      if ('_all' in metoder) {
        throw new Error(`${namn}: ${path} registreras för alla metoder (router.all()), som kontraktet inte bär`);
      }
      for (const metod of Object.keys(metoder)) {
        if (metod.startsWith('_')) continue;
        ut.push({ method: metod.toUpperCase(), router_pattern: path, public_pattern: publik(prefix, path) });
      }
    }
  }
  return ut.sort((a, b) => jamfor(nyckel(a), nyckel(b)));
}

/**
 * De routrar som är monterade i `router`: lager utan `route` vars `handle` bär en lista `stack`. En underapp
 * ur express() och en router inlindad i en funktion har ingen, och dem ser hjälparen inte (README).
 */
function routerlager(router: unknown): unknown[] {
  return (stacken(router) ?? []).flatMap((lager) => {
    if (!arObjekt(lager) || lager['route']) return [];
    const handle = lager['handle'];
    return stacken(handle) ? [handle] : [];
  });
}

function utanKodrutt(kod: Kodrutt[], method: string, router_pattern: string): Kodrutt[] {
  return kod.filter((r) => !(r.method === method && r.router_pattern === router_pattern));
}

// ---- Tillståndsrutten -----------------------------------------------------------

/**
 * Den rad generatorn i valvet ska ge för tillståndsrutten (FR-32, B-04; berättelsens *Förkrav i drift*).
 * Fälten är syskonets, `POST /arende/:identifier/ratta`, som är samma slag av skrivrutt; F4 prövar det.
 */
const TILLSTANDSRUTTEN: KontraktRutt = {
  service: 'arenden',
  method: 'POST',
  router_pattern: '/arende/:identifier/tillstand',
  public_pattern: '/vy/arende/:identifier/tillstand',
  category: 'c',
  owner_id: 'cases_all',
  verification: 'source',
};

function kodrutt(p: KontraktRutt): Kodrutt {
  return { method: p.method, router_pattern: p.router_pattern, public_pattern: p.public_pattern };
}

/** En klon av kopian med posterna sist i `routes`. Kopian ändras aldrig. */
function medRutter(k: Kontrakt, ...poster: KontraktRutt[]): Kontrakt {
  return structuredClone({ ...k, routes: [...k.routes, ...poster] });
}

/** En klon av kopian utan arenden-posterna med metoden och routermönstret. Kopian ändras aldrig. */
function utanRutt(k: Kontrakt, method: string, router_pattern: string): Kontrakt {
  return structuredClone({
    ...k,
    routes: k.routes.filter(
      (r) => !(r.service === 'arenden' && r.method === method && r.router_pattern === router_pattern),
    ),
  });
}

// ---- Grinden ------------------------------------------------------------------

// Sluten lista: rutter som kopian får bära innan koden registrerar dem (FR-32, Story 2.6).
// Posten kommer in i kopian genom generatorn och lämnar listan i samma diff som rutten byggs (Story 3.3).
// Står en byggd rutt kvar här fäller F2 (regel c) och F4 den. F3 fall 5 visar regel (c) på en konstruerad kopia.
const VANTANDE: KontraktRutt[] = [TILLSTANDSRUTTEN];

/** Fälten som en väntande post bär exakt, i fyndens ordning. */
const VANTADE_FALT = ['category', 'owner_id', 'verification'] as const;

const nycklarna = (p: object): string => JSON.stringify(Object.keys(p).sort());

/**
 * Fynden när kopians rutter för tjänsten arenden jämförs med koden. Två poster är samma rutt när nyckel()
 * är densamma. Fynden kommer i regelordning och inom en regel sorterade på nyckeln:
 *   (a) en rutt i koden som kopian inte bär;
 *   (b) en post i kopian som varken finns i koden eller bland de väntande;
 *   (c) en väntande rutt som redan är byggd;
 *   (d) en post med en väntande posts nyckel men andra fält eller nycklar än den;
 *   (e) en nyckel som står mer än en gång i kopian.
 */
function ruttfel(kopia: Kontrakt, kod: Kodrutt[], vantande: KontraktRutt[] = []): string[] {
  const poster = kopia.routes.filter((r) => r.service === 'arenden');
  const iKopian = new Set(poster.map(nyckel));
  const iKoden = new Set(kod.map(nyckel));
  const vantar = new Map(vantande.map((p) => [nyckel(p), p]));
  const sorterade = (s: Iterable<string>): string[] => [...s].sort(jamfor);

  const a = sorterade(iKoden)
    .filter((n) => !iKopian.has(n))
    .map((n) => `saknas i kontraktet: ${n}`);
  const b = sorterade(iKopian)
    .filter((n) => !iKoden.has(n) && !vantar.has(n))
    .map((n) => `saknas i koden: ${n}`);
  const c = sorterade(vantar.keys())
    .filter((n) => iKoden.has(n))
    .map((n) => `byggd men står kvar i VANTANDE: ${n}`);
  const d = poster
    .flatMap((p) => {
      const v = vantar.get(nyckel(p));
      if (!v) return [];
      const falt: string[] = VANTADE_FALT.filter((f) => p[f] !== v[f]);
      if (nycklarna(p) !== nycklarna(v)) falt.push('nycklar');
      return falt.length > 0 ? [`avviker från den väntade posten: ${nyckel(p)} (${falt.join(', ')})`] : [];
    })
    .sort(jamfor);
  const antal = new Map<string, number>();
  for (const n of poster.map(nyckel)) antal.set(n, (antal.get(n) ?? 0) + 1);
  const e = sorterade(antal.keys())
    .filter((n) => antal.get(n)! > 1)
    .map((n) => `dubblett i kontraktet: ${n}`);
  return [...a, ...b, ...c, ...d, ...e];
}

describe('FR-32/Story 2.6 AK 1–2: rutterna i koden och i kopian', () => {
  it('F1 (AK 1 och 2): grinden läser varje rutt som tjänsten betjänar', async () => {
    // Kontrollerna: mellanlagret räknas inte, `/` under ett prefix blir prefixet, och router.all() fälls.
    const prov = Router();
    prov.use(() => {});
    prov.get('/', () => {});
    prov.get('/x', () => {});
    prov.post('/y/:id', () => {});
    expect(kodrutter([{ namn: 'prov', router: prov, prefix: '/p' }]).map(nyckel)).toEqual([
      'GET /p (/)',
      'GET /p/x (/x)',
      'POST /p/y/:id (/y/:id)',
    ]);
    const provAll = Router();
    provAll.all('/z', () => {});
    expect(() => kodrutter([{ namn: 'prov-all', router: provAll, prefix: '/p' }])).toThrow(
      /prov-all.*\/z|\/z.*prov-all/,
    );

    // Ingen router är monterad utanför montering(), och ingen ligger inuti en annan.
    const lagren = routerlager(app.router);
    expect(lagren).toHaveLength(2);
    expect(lagren[0]).toBe(vyRouter);
    expect(lagren[1]).toBe(actionsRouter);
    expect(routerlager(vyRouter)).toEqual([]);
    expect(routerlager(actionsRouter)).toEqual([]);

    // De tre monteringarna svarar genom hela stacken.
    expect((await request(app).get('/vy')).status).toBe(200);
    const nyckeln = await nyNyckel({ typ: 'agent', namn: 'f26 adresskontrakt' });
    const actions = await request(app).get('/api/actions').set('Authorization', `Bearer ${nyckeln}`);
    expect(actions.status).toBe(200);
    const kroppen: unknown = actions.body;
    expect(arObjekt(kroppen) && Array.isArray(kroppen['actions'])).toBe(true);
    expect((await request(app).get('/health')).status).toBe(200);

    const nycklar = kodrutter(montering(app)).map(nyckel);
    for (const n of [
      'GET /vy (/)',
      'GET /vy/arende/:identifier (/arende/:identifier)',
      'POST /vy/arende/:identifier/kommentar (/arende/:identifier/kommentar)',
      'GET /api/actions (/actions)',
      'POST /api/actions/:name (/actions/:name)',
      'GET /health (/health)',
    ]) {
      expect(nycklar, n).toContain(n);
    }
    for (const m of montering(app)) {
      expect(kodrutter([m]).length, m.namn).toBeGreaterThan(0);
    }
  });

  it('F2 (AK 1 och 2): dagens kopia och koden stämmer åt båda hållen', () => {
    const kod = kodrutter(montering(app));

    // Kontrollerna, en per riktning.
    expect(ruttfel(kontraktet(), utanKodrutt(kod, 'GET', '/mitt'), VANTANDE)).toEqual([
      'saknas i koden: GET /vy/mitt (/mitt)',
    ]);
    const utan = structuredClone(kontraktet());
    utan.routes = utan.routes.filter(
      (r) => !(r.service === 'arenden' && r.method === 'GET' && r.router_pattern === '/mitt'),
    );
    expect(ruttfel(utan, kod, VANTANDE)).toEqual(['saknas i kontraktet: GET /vy/mitt (/mitt)']);

    const fel = ruttfel(kontraktet(), kod, VANTANDE);
    expect(fel, fel.join('\n')).toEqual([]);
  });
});

describe('FR-32/Story 2.6 AK 1: tillståndsrutten före koden', () => {
  it('F3 (AK 1 och 2): grinden mot fjorton kopior och kodlistor', () => {
    // Basen saknar tillståndsrutten i både kopian och koden. Fallen ger därför samma utfall med dagens
    // kopia, med generatorns kopia och efter Story 3.3.
    const k = utanRutt(kontraktet(), 'POST', '/arende/:identifier/tillstand');
    const kod = utanKodrutt(kodrutter(montering(app)), 'POST', '/arende/:identifier/tillstand');
    const T = TILLSTANDSRUTTEN;
    const Tn = nyckel(T);

    const syskon = k.routes.find(
      (r) => r.service === 'arenden' && r.method === 'POST' && r.router_pattern === '/arende/:identifier/ratta',
    );
    expect(syskon).toBeDefined();

    // Fall 11: den första posten i en annan tjänst får en annan adress, och tjänsten får en ny post.
    const andra = structuredClone(k);
    const A = andra.routes.find((r) => r.service !== 'arenden');
    expect(A).toBeDefined();
    andra.routes.push({ ...A!, method: 'GET', router_pattern: '/ny-prov', public_pattern: '/ny-prov' });
    A!.public_pattern = `${A!.public_pattern}2`;

    const medExtra = { ...T, extra: 'x' };
    type Fall = { fall: number; kopia: Kontrakt; kod: Kodrutt[]; vantande: KontraktRutt[]; vantat: string[] };
    const fall: Fall[] = [
      { fall: 1, kopia: k, kod, vantande: [T], vantat: [] },
      { fall: 2, kopia: medRutter(k, T), kod, vantande: [T], vantat: [] },
      { fall: 3, kopia: medRutter(k, T), kod, vantande: [], vantat: [`saknas i koden: ${Tn}`] },
      { fall: 4, kopia: k, kod: [...kod, kodrutt(T)], vantande: [], vantat: [`saknas i kontraktet: ${Tn}`] },
      {
        fall: 5,
        kopia: medRutter(k, T),
        kod: [...kod, kodrutt(T)],
        vantande: [T],
        vantat: [`byggd men står kvar i VANTANDE: ${Tn}`],
      },
      {
        fall: 6,
        kopia: medRutter(k, { ...T, category: 'a' }),
        kod,
        vantande: [T],
        vantat: [`avviker från den väntade posten: ${Tn} (category)`],
      },
      {
        fall: 7,
        kopia: medRutter(k, { ...T, owner_id: null, verification: 'source_and_live' }),
        kod,
        vantande: [T],
        vantat: [`avviker från den väntade posten: ${Tn} (owner_id, verification)`],
      },
      {
        fall: 8,
        kopia: utanRutt(k, 'POST', '/arende/:identifier/kommentar'),
        kod,
        vantande: [T],
        vantat: ['saknas i kontraktet: POST /vy/arende/:identifier/kommentar (/arende/:identifier/kommentar)'],
      },
      {
        fall: 9,
        kopia: medRutter(k, {
          service: 'arenden',
          method: 'GET',
          router_pattern: '/okand',
          public_pattern: '/vy/okand',
          category: 'a',
          owner_id: null,
          verification: 'source',
        }),
        kod,
        vantande: [T],
        vantat: ['saknas i koden: GET /vy/okand (/okand)'],
      },
      {
        fall: 10,
        kopia: medRutter(k, { ...syskon! }),
        kod,
        vantande: [T],
        vantat: ['dubblett i kontraktet: POST /vy/arende/:identifier/ratta (/arende/:identifier/ratta)'],
      },
      { fall: 11, kopia: andra, kod, vantande: [T], vantat: [] },
      {
        fall: 12,
        kopia: medRutter(k, {
          ...T,
          router_pattern: '/arende/:id/tillstand',
          public_pattern: '/vy/arende/:id/tillstand',
        }),
        kod,
        vantande: [T],
        vantat: ['saknas i koden: POST /vy/arende/:id/tillstand (/arende/:id/tillstand)'],
      },
      {
        fall: 13,
        kopia: medRutter(k, medExtra),
        kod,
        vantande: [T],
        vantat: [`avviker från den väntade posten: ${Tn} (nycklar)`],
      },
      { fall: 14, kopia: medRutter(k, T), kod: [...kod, kodrutt(T)], vantande: [], vantat: [] },
    ];

    const avvikande = fall.flatMap((f) => {
      const utfall = ruttfel(f.kopia, f.kod, f.vantande);
      return JSON.stringify(utfall) === JSON.stringify(f.vantat) ? [] : [{ fall: f.fall, utfall, vantat: f.vantat }];
    });
    expect(avvikande).toEqual([]);
  });

  it('F4 (AK 1): posten är generatorns och väntar tills den byggs', () => {
    // Kontrollen: kopian har exakt ett syskon att jämföra med.
    const syskonen = kontraktet().routes.filter(
      (r) => r.service === 'arenden' && r.method === 'POST' && r.router_pattern === '/arende/:identifier/ratta',
    );
    expect(syskonen).toHaveLength(1);
    const syskon = syskonen[0]!;
    const T = TILLSTANDSRUTTEN;

    expect(T.service).toBe('arenden');
    expect(T.method).toBe('POST');
    expect(T.router_pattern).toBe('/arende/:identifier/tillstand');
    expect(T.public_pattern).toBe(publik('/vy', T.router_pattern));

    expect(T.category).toBe(syskon.category);
    expect(T.owner_id).toBe(syskon.owner_id);
    expect(T.verification).toBe(syskon.verification);
    expect(Object.keys(T).sort()).toEqual(Object.keys(syskon).sort());

    const iVantande = VANTANDE.some((p) => nyckel(p) === nyckel(T));
    const iKoden = kodrutter(montering(app)).some((r) => nyckel(r) === nyckel(T));
    const lage =
      iVantande && iKoden
        ? 'står både i VANTANDE och i koden'
        : !iVantande && !iKoden
          ? 'står varken i VANTANDE eller i koden'
          : 'i exakt ett av VANTANDE och koden';
    expect(lage).toBe('i exakt ett av VANTANDE och koden');

    const prefixen = montering(app).map((m) => m.prefix);
    for (const p of VANTANDE) {
      expect(p.service, nyckel(p)).toBe('arenden');
      expect(
        prefixen.some((prefix) => p.public_pattern === publik(prefix, p.router_pattern)),
        nyckel(p),
      ).toBe(true);
    }
  });
});

describe('FR-15/Story 2.6 AK 2: menyn är densamma med den nya kopian', () => {
  /** En klon av kopian med en annan etikett på första gruppen. Det laddade objektet ändras inte. */
  function kopiaMedAnnanGrupp() {
    const kAnnan = structuredClone(kontraktet());
    kAnnan.groups[0]!.label = 'Provgrupp 2.6';
    return kAnnan;
  }

  it('F5 (AK 2): modell() räknar på kopian den får', () => {
    const kAnnan = kopiaMedAnnanGrupp();
    const id = kAnnan.groups[0]!.id;

    expect(modell(undefined, null, kAnnan).groups.find((g) => g.id === id)?.label).toBe('Provgrupp 2.6');

    const laddad = kontraktet().groups[0]!.label;
    expect(laddad).not.toBe('Provgrupp 2.6');
    expect(modell().groups.find((g) => g.id === id)?.label).toBe(laddad);
  });

  it('F6 (AK 2): samma meny med och utan rutter', () => {
    // Kontrollen: en annan kopia ger en annan modell, så likheterna nedan kan slå ut.
    expect(modell(undefined, null, kopiaMedAnnanGrupp())).not.toEqual(modell());

    const k = kontraktet();
    for (const beslut of [undefined, 'pending', 'yes', 'no']) {
      for (const bolag of [null, '1']) {
        const vantad = modell(beslut, bolag, k);
        const fall = `beslut ${String(beslut)}, bolag ${String(bolag)}`;
        expect(modell(beslut, bolag, medRutter(k, TILLSTANDSRUTTEN)), `${fall}, med tillståndsrutten`).toEqual(
          vantad,
        );
        expect(modell(beslut, bolag, { ...k, routes: [] }), `${fall}, utan rutter`).toEqual(vantad);
      }
    }

    expect(produktmeny('/vy', modell(undefined, null, medRutter(k, TILLSTANDSRUTTEN)))).toBe(
      produktmeny('/vy', modell()),
    );
  });
});

// ---- README (krav → kod → test) -----------------------------------------------

const README = fileURLToPath(new URL('../README.md', import.meta.url));
const RUBRIKEN = '### FR-32 — tillståndsrutten står i adresskontraktet (Story 2.6)';
/** Ordagrant som i regelkällan (berättelsens Dev Notes → Till regelkällan). */
const REGELN =
  '- Rutter och adresskontraktet (FR-32, FR-15, Story 2.6): varje rutt som tjänsten registrerar, i ' +
  '`vyRouter` under `/vy`, i `actionsRouter` under `/api` och direkt på appen, står i ' +
  '`kontrakt/navigation.v1.json` med samma metod, routermönster och publika adress, och varje rutt för ' +
  'tjänsten arenden i kopian registreras i koden, utom posterna i den slutna listan `VANTANDE` i ' +
  '`test/adresskontrakt.test.ts`. En ny rutt kommer in i kopian bara genom generatorn i valvet, aldrig för ' +
  'hand, och före koden: berättelsen som förbereder kontraktet lägger posten i `VANTANDE`, och berättelsen ' +
  'som bygger rutten tar bort den i samma diff. En ny router monteras bara med en post i provets lista ' +
  '`montering()`. `modell()` läser aldrig kontraktets rutter.';

/** Avsnittets rader, från rubriken till nästa rubrik på nivå två eller tre, och dess gränser. */
function avsnittet(rader: string[]): { start: number; slut: number } | null {
  const start = rader.indexOf(RUBRIKEN);
  if (start === -1) return null;
  const nasta = rader.findIndex((r, i) => i > start && /^#{2,3} /.test(r));
  return { start, slut: nasta === -1 ? rader.length : nasta };
}

/** Fynden för README:s avsnitt: rubriken, regelns rad exakt en gång och tre tabellrader för FR-32. */
function readmefel(text: string): string[] {
  const rader = text.split('\n').map((r) => r.replace(/\r$/, ''));
  const granser = avsnittet(rader);
  if (!granser) return ['rubriken saknas'];
  const avsnitt = rader.slice(granser.start + 1, granser.slut);
  const fel: string[] = [];
  const regler = avsnitt.filter((r) => r.startsWith('- Rutter och adresskontraktet (FR-32, FR-15, Story 2.6):'));
  if (regler.length !== 1) fel.push(`regelns rad står ${regler.length} gånger`);
  else if (regler[0] !== REGELN) fel.push('regelns rad är inte ordagrant densamma som i regelkällan');
  const tabell = avsnitt.filter((r) => r.startsWith('| FR-32'));
  if (tabell.length !== 3) fel.push(`${tabell.length} tabellrader för FR-32, inte 3`);
  for (const r of tabell) if (!r.includes('test/adresskontrakt.test.ts')) fel.push(`utan provfilen: ${r}`);
  return fel;
}

describe('FR-32/Story 2.6: README bär regeln', () => {
  it('F7 (dokumentationen): avsnittet för FR-32 bär regeln och tre rader krav → kod → test', () => {
    // Kontrollerna: en text utan rubriken och en text med ändrad regel och en rad utan provfilen fälls.
    expect(readmefel('annan text')).toEqual(['rubriken saknas']);
    const andrad = [
      RUBRIKEN,
      '',
      REGELN.slice(0, -1),
      '',
      '| FR-32 a | x | y | test/adresskontrakt.test.ts |',
      '| FR-32 b | x | y | test/adresskontrakt.test.ts |',
      '| FR-32 c | x | y | annat prov |',
    ].join('\n');
    expect(readmefel(andrad)).toEqual([
      'regelns rad är inte ordagrant densamma som i regelkällan',
      'utan provfilen: | FR-32 c | x | y | annat prov |',
    ]);

    expect(readmefel(readFileSync(README, 'utf8'))).toEqual([]);
  });
});
