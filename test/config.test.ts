// D-2, B-21 (Story 11.2 AK 2): VY_PUBLIK_URL är en https-adress som är exakt sin egen origin, med
// driftens adress som standardvärde. Fallistorna: C1 nio ogiltiga former, C2 tre giltiga (två satta och
// den saknade) och konstanten mot README:n, C3 två barnprocesser.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { config, EnvSchema, VY_PUBLIK_URL_STANDARD } from '../src/config.js';
import { TEST_VY_PUBLIK_URL } from './env.js';

const korProcess = promisify(execFile);
const ROT = fileURLToPath(new URL('..', import.meta.url));

const OGILTIGA = [
  '',
  'http://arenden-prov.invalid',
  'https://arenden-prov.invalid/',
  'https://arenden-prov.invalid/vy',
  'https://arenden-prov.invalid?x=1',
  'https://arenden-prov.invalid#x',
  'https://arenden-prov.invalid?',
  'https://arenden-prov.invalid#',
  'inte en adress',
];
const GILTIGA = ['https://arenden-prov.invalid', 'https://arenden-prov.invalid:8446'];

/**
 * Barnprocessens miljö: en kopia av provets miljö, med ändringarna och utan nycklarna i `utan`.
 * DOTENV_CONFIG_PATH pekar på en fil som inte finns, så att ingen .env kan rikta barnprocessen mot en
 * annan databas (samma skydd som test/schema.test.ts rad 212–225).
 */
function barnmiljo(andringar: Record<string, string>, utan: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_PATH: path.join(tmpdir(), 'config-prov-finns-inte.env'),
    ...andringar,
  };
  for (const nyckel of utan) delete env[nyckel];
  return env;
}

interface Barnutfall {
  kod: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Kör `fil` med tsx under repots rot och kastar aldrig: `kod` är 0 när processen lyckas, annars dess
 * exitkod, och null för en process som dödats. Tidsgränsen och SIGKILL fäller en server som startar i
 * stället för att stoppas av konfigurationen (som test/schema.test.ts rad 233–255).
 */
async function korBarnprocess(fil: string, env: NodeJS.ProcessEnv): Promise<Barnutfall> {
  try {
    const { stdout, stderr } = await korProcess(
      path.join(ROT, 'node_modules', '.bin', 'tsx'),
      [path.join(ROT, fil)],
      { cwd: ROT, env, timeout: 15_000, killSignal: 'SIGKILL' },
    );
    return { kod: 0, stdout, stderr };
  } catch (err) {
    const fel: Record<string, unknown> = typeof err === 'object' && err !== null ? { ...err } : {};
    return {
      kod: typeof fel['code'] === 'number' ? fel['code'] : null,
      stdout: typeof fel['stdout'] === 'string' ? fel['stdout'] : '',
      stderr: typeof fel['stderr'] === 'string' ? fel['stderr'] : '',
    };
  }
}

describe('D-2/Story 11.2 AK 2: den publika adressen är konfiguration, med driftens adress som standardvärde', () => {
  it('C1 (AK 2): nio ogiltiga former fälls med ett fel som namnger VY_PUBLIK_URL', () => {
    const obs = OGILTIGA.map((form) => {
      const svar = EnvSchema.safeParse({ DATABASE_URL: 'postgres://c1@prov/prov', VY_PUBLIK_URL: form });
      return {
        form,
        ok: svar.success,
        sokvagar: svar.success ? [] : svar.error.issues.map((i) => i.path.join('.')),
      };
    });
    expect(obs).toEqual(OGILTIGA.map((form) => ({ form, ok: false, sokvagar: ['VY_PUBLIK_URL'] })));
  });

  it('C2 (AK 2): en https-adress utan sökväg godtas, och utan variabeln gäller driftens adress', () => {
    const obs = GILTIGA.map((form) => {
      const svar = EnvSchema.safeParse({ DATABASE_URL: 'postgres://c2@prov/prov', VY_PUBLIK_URL: form });
      return { form, ok: svar.success, varde: svar.success ? svar.data.VY_PUBLIK_URL : null };
    });
    const utan = EnvSchema.safeParse({ DATABASE_URL: 'postgres://c2@prov/prov' });
    obs.push({ form: '(saknas)', ok: utan.success, varde: utan.success ? utan.data.VY_PUBLIK_URL : null });
    const readme = readFileSync(path.join(ROT, 'README.md'), 'utf8');
    expect({
      obs,
      https: VY_PUBLIK_URL_STANDARD.startsWith('https://'),
      iReadme: readme.includes(VY_PUBLIK_URL_STANDARD + '/vy'),
    }).toEqual({
      obs: [
        ...GILTIGA.map((form) => ({ form, ok: true, varde: form })),
        { form: '(saknas)', ok: true, varde: VY_PUBLIK_URL_STANDARD },
      ],
      https: true,
      iReadme: true,
    });
    // Kontroll: sviten kör med provets värde, inte med standardvärdet, eftersom test/env.ts sätter det.
    expect(config.VY_PUBLIK_URL).toBe(TEST_VY_PUBLIK_URL);
    expect(config.VY_PUBLIK_URL).not.toBe(VY_PUBLIK_URL_STANDARD);
  });

  it('C3 (AK 2): servern startar inte med ett ogiltigt värde, och felraden namnger variabeln', async () => {
    const ogiltig = await korBarnprocess('src/server.ts', barnmiljo({ VY_PUBLIK_URL: 'http://arenden-prov.invalid' }));
    expect({
      kod: ogiltig.kod,
      vagrar: ogiltig.stderr.includes('vägrar starta'),
      namnger: ogiltig.stderr.includes('VY_PUBLIK_URL'),
    }, ogiltig.stderr).toEqual({ kod: 1, vagrar: true, namnger: true });
    // Kontroll: felraden skiljer variablerna åt — en saknad DATABASE_URL namnger bara den.
    const utanDatabas = await korBarnprocess('src/server.ts', barnmiljo({}, ['DATABASE_URL']));
    expect({
      kod: utanDatabas.kod,
      databas: utanDatabas.stderr.includes('DATABASE_URL'),
      adress: utanDatabas.stderr.includes('VY_PUBLIK_URL'),
    }, utanDatabas.stderr).toEqual({ kod: 1, databas: true, adress: false });
  });
});
