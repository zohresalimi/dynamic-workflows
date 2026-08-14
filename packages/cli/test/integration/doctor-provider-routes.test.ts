/**
 * KAR-19.10 AC6 — `doctor` and admission answer the provider question through
 * one function, and the answer is one per route.
 *
 * The red is the 2026-08-13 afternoon, staged: a machine with `claude` on
 * `PATH` and no `claude-agent-acp`. `doctor` reported that machine as
 * `adapter-missing` — one word, which every reader takes to mean *unusable* —
 * and the run selected `claude` anyway, through `spec.shim.bin`, and spawned
 * the vendor CLI. Neither half was lying and both were read as contradicting
 * each other, because one word per provider cannot say *"usable on one route,
 * not the other"*.
 *
 * Integration rather than unit for the same reason KAR-18.8's own specs are:
 * every claim here is a claim about a machine, and the two views have to be
 * shown agreeing about **the same staged `PATH`** rather than about the same
 * literal. A unit test over a resolution proves the reducer; only this proves
 * that `doctor` and `admitRun` are looking at one.
 *
 * Verifies: EPIC-19-S69 · AC6, AC7
 */
import { admitRun, providerRoutes, resolveProviderStates } from '@DeFlow/adapters';
import { makeRepo, makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import type { DoctorCheck } from '../../src/doctor/report.ts';
import { type DoctorOptions, runDoctor } from '../../src/doctor/run.ts';
import { doctorEnv, fakeBin } from './support/doctor-fixture.ts';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

interface Machine {
  readonly binDir: string;
  readonly options: DoctorOptions;
}

/** A repository, a data directory and a `PATH` holding exactly these binaries. */
async function machine(name: string, bins: readonly string[]): Promise<Machine> {
  const repo = await makeRepo({ dir: join(tmp, name) });
  await mkdir(join(repo.dir, '.DeFlow'), { recursive: true });
  const dataDir = join(tmp, `${name}-data`);
  const binDir = join(tmp, `${name}-bin`);
  await mkdir(binDir, { recursive: true });
  for (const bin of bins) await fakeBin(binDir, bin);

  return {
    binDir,
    options: {
      cwd: repo.dir,
      env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
      clock: new TestClock(1_755_000_000_000),
      conformance: false,
      capabilityFixtureDir: join(tmp, `${name}-fixtures`),
    },
  };
}

const check = (checks: readonly DoctorCheck[], id: string): DoctorCheck | undefined =>
  checks.find((entry) => entry.id === id);

const allChecks = (report: {
  readonly sections: readonly { readonly checks: readonly DoctorCheck[] }[];
}) => report.sections.flatMap((section) => section.checks);

suite('doctor reports both routes per provider (AC6)', () => {
  it('calls the exec-shim route available for a vendor CLI with no ACP bridge', async () => {
    const host = await machine('routes-shim-only', ['claude']);

    const result = await runDoctor(host.options);
    const claude = check(allChecks(result.report), 'agents.claude');

    // The data half, which is what a machine reads.
    expect(claude?.data?.routes).toEqual({ acp: 'missing', shim: 'available' });
    // And the prose half, which is what stopped this being noticed for a day:
    // the report has to say out loud that something here *works*, or the next
    // reader concludes the machine can do nothing and starts installing.
    expect(claude?.detail).toContain('exec shim');
    expect(claude?.detail).toContain(join(host.binDir, 'claude'));
    // KAR-18.8's install sentence is unchanged and still attached to the ACP
    // route, because agent-node execution still needs the bridge.
    expect(claude?.detail).toContain('npm install -g @agentclientprotocol/claude-agent-acp');
  });

  it('calls neither route available when nothing resolves', async () => {
    const host = await machine('routes-empty', []);

    const result = await runDoctor(host.options);

    expect(check(allChecks(result.report), 'agents.claude')?.data?.routes).toEqual({
      acp: 'missing',
      shim: 'missing',
    });
  });

  it('calls the ACP route available when the bridge resolves over its vendor CLI', async () => {
    const host = await machine('routes-both', ['claude', 'claude-agent-acp']);

    const result = await runDoctor(host.options);

    expect(check(allChecks(result.report), 'agents.claude')?.data?.routes).toEqual({
      acp: 'available',
      shim: 'available',
    });
  });
});

suite('the reported mismatch is unreachable (AC6)', () => {
  it('never lets a run take a route doctor did not report as available', async () => {
    // The staged 2026-08-13 machine. Both views are asked about *this* `PATH`,
    // and the assertion is that they answer the same thing — which is what the
    // afternoon was spent discovering they did not.
    const host = await machine('routes-agree', ['claude']);

    const reported = check(allChecks((await runDoctor(host.options)).report), 'agents.claude');
    const admission = admitRun(resolveProviderStates([host.binDir]));

    expect(admission.outcome).toBe('admitted');
    if (admission.outcome !== 'admitted') return;
    const chosen = admission.chosen;
    expect(chosen?.provider).toBe('claude');
    // The route the run will take is one `doctor` printed as available.
    expect(reported?.data?.routes).toMatchObject({ [chosen?.route ?? '']: 'available' });
    expect(chosen?.binaryPath).toBe(join(host.binDir, 'claude'));
    // And the whole structure is the same structure, not a second reduction
    // that happens to agree today.
    expect(reported?.data?.routes).toEqual(
      providerRoutes(
        resolveProviderStates([host.binDir]).find((entry) => entry.provider === 'claude') as never,
      ),
    );
  });
});
