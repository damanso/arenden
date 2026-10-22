// NFR-10, ADR-0001 känd avvikelse 1 (Story 7.7): repo-kopian av Python-klienten läser nyckeln på
// samma ställe som drift-klienten, ~/.hermes/arenden-nyckel med bindestreck.
//
// Provet kör repo-kopian adapter/arenden_klient.py som barnprocess med en tillfällig hemkatalog
// och prövar tre saker: nyckelvägen är bindestrecksformen (AK 1); list_issues och create_issue
// fungerar mot appen och testdatabasen med nyckeln ur filen, och händelseraden bär nyckelns aktör
// (AK 2); och en saknad nyckel ger ett fel som namnger sökvägen innan något anrop görs (AK 3).
//
// Provet läser aldrig drift-klienten eller den riktiga nyckeln: HOME är alltid en katalog under
// tmpdir(). Det prövar inte heller att drift-klienten har samma väg. Det står i PRD:n och mäts inte här.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/http/app.js';
import { kor, nyNyckel, raknaRader, seedaTeam } from './helpers.js';

// Barnprocessen och ROT som i test/rattelser.test.ts rad 21–22. Provfilerna exporterar inga
// hjälpare, så mönstret skrivs om här.
const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));
const ADAPTERN = path.join(ROT, 'adapter');
const KLIENTFILEN = path.join(ADAPTERN, 'arenden_klient.py');

// Drivrutinen ges till `python3 -I -B -c` med katalogen och operationen som argument, så att
// sys.argv[1] är katalogen och sys.argv[2] operationen. -I bortser från PYTHONPATH och användarens
// site-katalog, och -B skriver ingen __pycache__ i adapter/. Utdata är exakt en rad JSON, ren ASCII
// (json.dumps utan ensure_ascii=False), eftersom barnprocessen saknar LANG. Bara ArendeFel fångas:
// varje annat undantag ger en exitkod skild från 0, och execFile fäller då provet med stderr.
const DRIVER = [
  'import json',
  'import sys',
  '',
  'sys.path.insert(0, sys.argv[1])',
  'import arenden_klient as klient',
  '',
  'operation = sys.argv[2]',
  'if operation == "nyckelfil":',
  '    print(json.dumps({"nyckelfil": str(klient.NYCKELFIL)}))',
  'elif operation in ("list_issues", "create_issue"):',
  '    try:',
  '        if operation == "list_issues":',
  '            resultat = klient.list_issues()',
  '        else:',
  '            resultat = klient.create_issue("Pythonklienten 7.7", "LOC")',
  '        print(json.dumps({"ok": True, "resultat": resultat}))',
  '    except klient.ArendeFel as fel:',
  '        print(json.dumps({"ok": False, "status": fel.status, "kod": fel.kod, "text": str(fel)}))',
  'else:',
  '    sys.exit(2)',
].join('\n');

type Operation = 'nyckelfil' | 'list_issues' | 'create_issue';

type KlientUtfall =
  | { nyckelfil: string }
  | { ok: true; resultat: Record<string, unknown> }
  | { ok: false; status: number; kod: string; text: string };

/**
 * Barnprocessens HELA miljö, en tillåtelselista. Provprocessens miljö bär attrappen
 * ARENDEN_API_KEY ur test/env.ts, som klienten tar före filen, så att filen aldrig lästes; och den
 * riktiga hemkatalogen bär driftens nyckel, som provet aldrig får läsa. Därför sprids aldrig
 * process.env här, till skillnad från test/rattelser.test.ts, som gör det med avsikt.
 */
function barnmiljo(hem: string, bas?: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: hem,
    ...(bas !== undefined ? { ARENDEN_API_URL: bas } : {}),
    ...extra,
  };
}

async function korKlienten(
  hem: string,
  operation: Operation,
  bas?: string,
  extra?: Record<string, string>,
): Promise<KlientUtfall> {
  const { stdout } = await korProcess('python3', ['-I', '-B', '-c', DRIVER, ADAPTERN, operation], {
    cwd: ROT,
    env: barnmiljo(hem, bas, extra),
    timeout: 20_000,
  });
  return JSON.parse(stdout.trim()) as KlientUtfall;
}

// Varje tillfällig hemkatalog tas bort när filen är klar. Katalogen .hermes skapas inte här:
// F3 (a) behöver en hemkatalog utan den.
const hemkataloger: string[] = [];

async function nyttHem(): Promise<string> {
  const hem = await mkdtemp(path.join(tmpdir(), 'arenden-pythonklient-'));
  hemkataloger.push(hem);
  return hem;
}

afterAll(async () => {
  await Promise.all(hemkataloger.map((hem) => rm(hem, { recursive: true, force: true })));
});

/** Skriver nyckelfilen med rättigheterna 0600. chmod efteråt, eftersom en befintlig fil annars behåller sina. */
async function skrivNyckel(hem: string, filnamn: string, varde: string): Promise<string> {
  const katalog = path.join(hem, '.hermes');
  await mkdir(katalog, { recursive: true });
  const fil = path.join(katalog, filnamn);
  await writeFile(fil, varde, { mode: 0o600 });
  await chmod(fil, 0o600);
  return fil;
}

/** AK 1: en jämförelse mot två strängar, ingen svartlista. Fynden kommer i den här ordningen. */
function nyckelvagsfel(text: string): string[] {
  const fynd: string[] = [];
  if (!text.includes('.hermes/arenden-nyckel')) fynd.push('bindestrecksformen saknas');
  if (text.includes('arenden_nyckel')) fynd.push('understreckformen står kvar');
  return fynd;
}

/** AK 3: felets text tecken för tecken som i klientens _nyckel, utan å, ä och ö som resten av klientfilen. */
const SAKNAD = (sokvag: string): string =>
  `ingen nyckel: ${sokvag} finns inte eller gar inte att lasa, och ARENDEN_API_KEY ar inte satt`;

interface Raknare {
  server: Server;
  bas: string;
  antal: () => number;
  nollstall: () => void;
}

/**
 * AK 3: en egen HTTP-server som räknar varje begäran den tar emot och svarar 500 med
 * {"error":"raknaren"}. En räknare visar att inget anrop gjordes; en stängd port hade bara visat
 * att inget lyckades (docs/project-context.md, testreglerna).
 */
async function raknare(): Promise<Raknare> {
  let antal = 0;
  const server = createServer((req, res) => {
    antal += 1;
    req.resume();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":"raknaren"}');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((klar) => server.once('listening', klar));
  return {
    server,
    bas: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    antal: () => antal,
    nollstall: () => {
      antal = 0;
    },
  };
}

describe('NFR-10/Story 7.7 AK 1: nyckelvägen', () => {
  it('F1 (AK 1): standardvägen är ~/.hermes/arenden-nyckel, och understreckformen står ingenstans', async () => {
    const hem = await nyttHem();

    // (a) Utan ARENDEN_API_KEY_FIL är vägen hemkatalogen följd av bindestrecksformen.
    expect(await korKlienten(hem, 'nyckelfil')).toEqual({
      nyckelfil: path.join(hem, '.hermes', 'arenden-nyckel'),
    });
    // (b) Kontroll, skild bara i ARENDEN_API_KEY_FIL: variabeln pekar fortfarande om vägen.
    expect(
      await korKlienten(hem, 'nyckelfil', undefined, { ARENDEN_API_KEY_FIL: path.join(hem, 'egen-nyckel') }),
    ).toEqual({ nyckelfil: path.join(hem, 'egen-nyckel') });

    // (c) Klientfilen har bindestrecksformen och inte understreckformen, också i docstringen.
    const text = readFileSync(KLIENTFILEN, 'utf8');
    expect(nyckelvagsfel(text)).toEqual([]);
    // (d) Kontroll, skild bara i strängen: understreckformen fälls med båda fynden.
    expect(nyckelvagsfel(text.replaceAll('arenden-nyckel', 'arenden_nyckel'))).toEqual([
      'bindestrecksformen saknas',
      'understreckformen står kvar',
    ]);
  });
});

describe('NFR-10/Story 7.7 AK 2: kopian fungerar mot testservern', () => {
  let app: Express;
  let server: Server;
  let bas: string;
  let nyckel: string;
  let hem: string;
  let fil: string;

  // Testservern är appen startad i provet mot testdatabasen, på loopback med en port som
  // operativsystemet väljer, som i test/rattelser.test.ts rad 93–107.
  beforeAll(async () => {
    app = createApp();
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((klar) => server.once('listening', klar));
    bas = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await seedaTeam();
    nyckel = await nyNyckel({ typ: 'agent', namn: 'pythonklienten' });
    hem = await nyttHem();
    fil = await skrivNyckel(hem, 'arenden-nyckel', nyckel);
  });

  afterAll(async () => {
    await new Promise<void>((klar) => server.close(() => klar()));
  });

  it('F2 (AK 2): list_issues och create_issue svarar med nyckeln ur filen, och händelseraden bär nyckelns aktör', async () => {
    // (a) Nyckeln ligger i en fil med rättigheterna 0600 på bindestrecksvägen. Klienten skickar
    // ingen aktör: aktören tas ur nyckeln i servern (autentisera, ctx.aktor).
    expect(fil).toBe(path.join(hem, '.hermes', 'arenden-nyckel'));
    expect((await stat(fil)).mode & 0o777).toBe(0o600);
    const fore = await raknaRader('events');

    const skapat = await korKlienten(hem, 'create_issue', bas);
    expect(skapat).toMatchObject({ ok: true });
    if (!('ok' in skapat) || !skapat.ok) throw new Error(`create_issue misslyckades: ${JSON.stringify(skapat)}`);
    const { identifier } = skapat.resultat;
    if (typeof identifier !== 'string') throw new Error('create_issue gav inget nummer');
    expect(identifier).toMatch(/^LOC-\d+$/);
    expect(await raknaRader('events')).toBe(fore + 1);

    const hamtat = await kor(app, nyckel, 'get_issue', { identifier });
    expect(hamtat.status).toBe(200);
    // Fälten som HandelseRad i test/rattelser.test.ts rad 24–29.
    const handelser = hamtat.body.result.handelser as { verb: string; aktor_typ: string; aktor_namn: string }[];
    const skapade = handelser.filter((rad) => rad.verb === 'skapade_arende');
    expect(skapade).toHaveLength(1);
    expect(skapade[0]).toMatchObject({ aktor_typ: 'agent', aktor_namn: 'pythonklienten' });

    // (b) list_issues med samma hemkatalog svarar, och noderna har numret ur (a).
    const listat = await korKlienten(hem, 'list_issues', bas);
    expect(listat).toMatchObject({
      ok: true,
      resultat: { noder: expect.arrayContaining([expect.objectContaining({ identifier })]) },
    });

    // (c) Kontroll, skild bara i nyckelns värde: en fil på samma väg med ett värde som inte är någon
    // nyckel ger serverns 401, och ingen rad skrivs.
    const hem2 = await nyttHem();
    await skrivNyckel(hem2, 'arenden-nyckel', '0'.repeat(64));
    expect(await korKlienten(hem2, 'create_issue', bas)).toMatchObject({
      ok: false,
      status: 401,
      kod: 'unauthenticated',
    });
    expect(await raknaRader('events')).toBe(fore + 1);
  });
});

describe('NFR-10/Story 7.7 AK 3: saknad nyckel', () => {
  let rakna: Raknare;

  beforeAll(async () => {
    rakna = await raknare();
  });

  afterAll(async () => {
    await new Promise<void>((klar) => rakna.server.close(() => klar()));
  });

  it('F3 (AK 3): en saknad nyckel ger ett fel som namnger sökvägen, och inget anrop görs', async () => {
    // (a) En hemkatalog utan .hermes: felet namnger bindestrecksvägen, och räknaren står still.
    rakna.nollstall();
    const hem = await nyttHem();
    expect(await korKlienten(hem, 'list_issues', rakna.bas)).toEqual({
      ok: false,
      status: 401,
      kod: 'ingen_nyckel',
      text: SAKNAD(path.join(hem, '.hermes', 'arenden-nyckel')),
    });
    expect(rakna.antal()).toBe(0);

    // (b) Bara understreckformen finns: samma fel med den nya vägen, och den gamla nämns inte.
    rakna.nollstall();
    const hem2 = await nyttHem();
    await skrivNyckel(hem2, 'arenden_nyckel', 'a'.repeat(64));
    const utanNyckel = await korKlienten(hem2, 'create_issue', rakna.bas);
    expect(utanNyckel).toEqual({
      ok: false,
      status: 401,
      kod: 'ingen_nyckel',
      text: SAKNAD(path.join(hem2, '.hermes', 'arenden-nyckel')),
    });
    if (!('text' in utanNyckel)) throw new Error('create_issue gav inget fel');
    expect(utanNyckel.text).not.toContain('arenden_nyckel');
    expect(rakna.antal()).toBe(0);

    // (c) Kontroll, skild bara i att filen finns: samma hemkatalog med bindestrecksfilen gör exakt
    // ett anrop, och felet är räknarens 500.
    rakna.nollstall();
    await skrivNyckel(hem2, 'arenden-nyckel', 'b'.repeat(64));
    expect(await korKlienten(hem2, 'create_issue', rakna.bas)).toMatchObject({
      ok: false,
      status: 500,
      kod: 'raknaren',
    });
    expect(rakna.antal()).toBe(1);
  });
});
