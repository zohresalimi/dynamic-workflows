/**
 * KAR-22.2 AC2 — `doctor`, admission and the composer's picker, over one staged
 * machine.
 *
 * The epic that shipped the week before this one exists because those three
 * could disagree: `doctor` said a provider's adapter was missing, the run
 * selected the provider anyway, and both sentences were true of different
 * questions. KAR-19.10 collapsed them onto one producer. This story adds a
 * *fourth* reader — a picker in a browser — and the only way that addition is
 * safe is if it is a read of the same answer rather than a probe of its own.
 *
 * So the spec stages one `PATH`, asks all three, and compares them. A unit test
 * over a resolution proves the reducer; only this proves the three surfaces are
 * looking at one machine — and only this would have gone red on 2026-08-13.
 *
 * It lives in `@DeFlow/cli` because that is the one package allowed to depend on
 * `@DeFlow/daemon` (`test/dependency-direction.test.ts`), and `doctor` and the
 * daemon both have to be in the room for the comparison to mean anything.
 *
 * Verifies: EPIC-22-S21, EPIC-22-S22 · KAR-22.2 AC2 · test plan #4
 */
import { admitRun, providerRoutes, resolveProviderStates } from '@DeFlow/adapters';
import { type Booted, boot, probeProvidersOnBoot } from '@DeFlow/daemon';
import {
  authorizedFetch,
  makeRepo,
  makeTempDir,
  removeTempDir,
  TEST_DAEMON_TOKEN,
  TestClock,
} from '@DeFlow/testkit';
import { chmodSync, writeFileSync } from 'node:fs';
import { mkdir, symlink } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import type { DoctorCheck } from '../../src/doctor/report.ts';
import { type DoctorOptions, runDoctor } from '../../src/doctor/run.ts';
import { doctorEnv } from './support/doctor-fixture.ts';

const fetch = authorizedFetch();

/** The bundled mock agent's source entry — a real ACP agent as a subprocess,
 * and the only way to stage an ACP route that actually opens. */
const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

/** One row of `GET /api/providers/routes` — the picker's own wire shape. */
interface PickerRow {
  readonly id: string;
  readonly available: boolean;
  readonly route: 'acp' | 'shim' | null;
  readonly routes: { readonly acp: string; readonly shim: string };
  readonly reason: string;
  readonly action: string | null;
  readonly limitation: string | null;
}

interface CreatedBody {
  readonly runId: string;
  readonly provider?: { readonly provider: string; readonly route: string };
}

function executable(path: string, source: string): void {
  writeFileSync(path, source, { mode: 0o755 });
  chmodSync(path, 0o755);
}

/**
 * A `PATH` holding a `node` and a vendor CLI that answers `--version`.
 *
 * The `node` symlink is what keeps the spec hermetic: every fake here is a
 * `#!/usr/bin/env node` script, and appending the host's own bin directory to
 * `PATH` instead would find the author's real `claude-agent-acp` — at which
 * point the staged machine is not the staged machine.
 */
async function vendorCliOnly(binDir: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await symlink(process.execPath, join(binDir, 'node'));
  executable(
    join(binDir, 'claude'),
    '#!/usr/bin/env node\nprocess.stdout.write("2.1.220\\n");\nprocess.exit(0);\n',
  );
}

interface Daemon {
  readonly origin: string;
  readonly stop: () => Promise<void>;
}

async function bootAgainst(dataDir: string, binDir: string): Promise<Daemon> {
  const env = { ...process.env, PATH: binDir } satisfies NodeJS.ProcessEnv;
  const booted: Booted = await boot({
    dataDir,
    port: 0,
    dev: false,
    token: TEST_DAEMON_TOKEN,
    providerRoots: [binDir],
    probeProviders: ({ db, dataDir: dir }) =>
      probeProvidersOnBoot({
        db,
        clock: {
          now: () => Date.now(),
          setTimer: (ms: number, fire: () => void) => {
            const handle = setTimeout(fire, ms);
            handle.unref();
            return { cancel: () => clearTimeout(handle) };
          },
          sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref()),
        },
        dataDir: dir,
        env,
        randomHex: () => 'aaaaaa',
      }),
  });
  const address = booted.http.server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${address.port}`,
    stop: () => booted.shutdown(),
  };
}

/** `doctor`'s answer about one provider, over the same `PATH`. */
async function doctorRow(binDir: string, name: string, provider: string): Promise<DoctorCheck> {
  const repo = await makeRepo({ dir: join(tmp, `${name}-repo`) });
  await mkdir(join(repo.dir, '.DeFlow'), { recursive: true });
  const options: DoctorOptions = {
    cwd: repo.dir,
    env: doctorEnv({ dataDir: join(tmp, `${name}-doctor-data`), binDirs: [binDir], realGit: true }),
    clock: new TestClock(1_755_000_000_000),
    conformance: false,
    capabilityFixtureDir: join(tmp, `${name}-fixtures`),
  };
  const result = await runDoctor(options);
  const checks = result.report.sections.flatMap((section) => section.checks);
  const found = checks.find((check) => check.id === `agents.${provider}`);
  if (found === undefined) throw new Error(`doctor said nothing about ${provider}`);
  return found;
}

async function pickerRows(origin: string): Promise<readonly PickerRow[]> {
  const response = await fetch(`${origin}/api/providers/routes`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { providers: PickerRow[] }).providers;
}

suite('EPIC-22-S21 — three readers, one answer', () => {
  it('names the same availability and the same route as doctor and admission', async () => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    await vendorCliOnly(binDir);
    const daemon = await bootAgainst(dataDir, binDir);

    try {
      // 1. The picker, over HTTP, exactly as the browser asks it.
      const rows = await pickerRows(daemon.origin);
      const picked = rows.find((row) => row.id === 'claude');
      expect(picked).toBeDefined();
      expect(picked?.available).toBe(true);
      expect(picked?.route).toBe('shim');
      expect(picked?.routes).toEqual({ acp: 'missing', shim: 'available' });

      // 2. Admission, asked the way a submission asks it. A machine with a
      //    vendor CLI and no bridge can frame, so it is admitted — on the shim.
      const response = await fetch(`${daemon.origin}/api/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          input: { kind: 'text', text: 'Migrate the checkout module' },
          cwd: process.cwd(),
          permission: 'read',
        }),
      });
      expect(response.status).toBe(201);
      const created = (await response.json()) as CreatedBody;
      expect(created.provider?.provider).toBe(picked?.id);
      expect(created.provider?.route).toBe(picked?.route);

      // 3. `doctor`, over the same staged `PATH`.
      const doctor = await doctorRow(binDir, 'agree', 'claude');
      expect(doctor.data?.routes).toEqual(picked?.routes);
      // And the sentence, byte-identical: the picker renders `providerVerdict`'s
      // detail, and `doctor` prints the route report and then the same detail.
      // A browser wording of its own is how the same machine comes to describe
      // itself two ways.
      expect(String(doctor.detail)).toContain(picked?.reason ?? '<no reason>');
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  it('changes with the machine, because none of the three remembers its own answer', async () => {
    const dataDir = join(tmp, 'data2');
    const binDir = join(tmp, 'bin2');
    await vendorCliOnly(binDir);

    const before = await bootAgainst(dataDir, binDir);
    let shimOnly: PickerRow | undefined;
    try {
      shimOnly = (await pickerRows(before.origin)).find((row) => row.id === 'claude');
    } finally {
      await before.stop();
    }
    expect(shimOnly?.routes).toEqual({ acp: 'missing', shim: 'available' });
    expect(shimOnly?.action).toContain('npm install -g');

    // The adapter arrives — a real one, which is the whole point: an ACP route
    // is open only when something answers `initialize`, and a bridge that
    // merely *exists* is `handshake-failed` rather than available. The producer
    // is re-run at the next boot, which is exactly what the refusal sentence
    // tells the operator to do, and all three move together because none of
    // them holds an answer of its own.
    const grown = join(tmp, 'bin3');
    await vendorCliOnly(grown);
    await symlink(MOCK_AGENT_BIN, join(grown, 'claude-agent-acp'));

    const after = await bootAgainst(join(tmp, 'data3'), grown);
    try {
      const row = (await pickerRows(after.origin)).find((entry) => entry.id === 'claude');
      expect(row?.routes).toEqual({ acp: 'available', shim: 'available' });
      expect(row?.action).toBeNull();
      expect(row?.limitation).toBeNull();

      const resolutions = resolveProviderStates([grown]);
      const claude = resolutions.find((entry) => entry.provider === 'claude');
      expect(claude).toBeDefined();
      if (claude === undefined) return;
      expect(providerRoutes(claude)).toEqual(row?.routes);
      const admission = admitRun(resolutions, { provider: 'claude' });
      expect(admission.outcome).toBe('admitted');
    } finally {
      await after.stop();
    }
  }, 60_000);
});

suite('EPIC-22-S21 — the picker probes nothing', () => {
  it('answers a machine with nothing installed without spawning anything', async () => {
    // A `PATH` with a `node` and no agent at all. Every row is unavailable,
    // every row carries a reason and a command, and the endpoint answers
    // immediately: a picker that handshook with five adapters to build its list
    // would put a second of latency on opening a compose box.
    const binDir = join(tmp, 'empty-bin');
    await mkdir(binDir, { recursive: true });
    await symlink(process.execPath, join(binDir, 'node'));
    const daemon = await bootAgainst(join(tmp, 'empty-data'), binDir);

    try {
      const rows = await pickerRows(daemon.origin);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.available).toBe(false);
        expect(row.route).toBeNull();
        expect(row.reason).not.toBe('');
        expect(row.action).not.toBeNull();
      }
    } finally {
      await daemon.stop();
    }
  }, 60_000);
});
