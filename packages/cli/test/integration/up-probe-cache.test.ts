/**
 * KAR-18.2 — step 4 of the boot sequence: probe providers, and do not do it
 * again for a binary that has not changed.
 *
 * The probe is the expensive half of the NF3 budget: an ACP `initialize`
 * handshake per installed vendor, each one a spawned process. The concession
 * that makes the eight-step boot fit inside three seconds is that the probe is
 * cached and refreshed **on a change to the binary, not on every start** — and
 * the cache is keyed on the sha256 of the resolved entry file as well as the
 * version string, because a locally-linked or nightly agent build is rebuilt
 * far more often than it is renumbered.
 *
 * The fake agent logs every invocation it receives, so "no handshake was
 * performed" is asserted from the agent's own record rather than from a timing.
 *
 * Verifies: EPIC-18-S17, EPIC-18-S15 (first scenario, integration half) ·
 * AC2, AC8
 */
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runUp, type UpResult } from '../../src/up.ts';
import { upEnv, writeFakeAgent } from './support/up-fixture.ts';

let tmp = '';
const started: UpResult[] = [];

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  for (const result of started.splice(0)) {
    if (result.kind === 'started') await result.stop();
  }
  await removeTempDir(tmp);
});

/** Every argv the fake agent was invoked with, in order. */
async function invocations(log: string): Promise<string[][]> {
  if (!existsSync(log)) return [];
  const text = await readFile(log, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

/** An ACP handshake is the invocation that is *not* the version read. */
const handshakes = (calls: readonly string[][]): string[][] =>
  calls.filter((argv) => !argv.includes('--version'));

const up = async (dataDir: string, binDir: string): Promise<UpResult> => {
  const result = await runUp({
    env: upEnv({ dataDir, binDirs: [binDir] }),
    port: 0,
    open: false,
    timings: true,
  });
  started.push(result);
  return result;
};

suite('an unchanged binary is not handshaken again (EPIC-18-S17 scenario 1)', () => {
  it('reads the cached row, performs no initialize, and costs almost nothing', async () => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    const log = join(tmp, 'agent.log');
    await writeFakeAgent(binDir, { version: '1.0.0', log });

    const first = await up(dataDir, binDir);
    expect(first.kind).toBe('started');
    if (first.kind !== 'started') return;
    expect(handshakes(await invocations(log))).toHaveLength(1);
    expect(first.providers.find((entry) => entry.provider === 'claude')?.status).toBe('detected');
    if (first.kind === 'started') await first.stop();

    const second = await up(dataDir, binDir);
    expect(second.kind).toBe('started');
    if (second.kind !== 'started') return;

    // Still exactly one handshake in the whole log: the second boot answered
    // from the manifest.
    expect(handshakes(await invocations(log))).toHaveLength(1);
    const claude = second.providers.find((entry) => entry.provider === 'claude');
    expect(claude?.status).toBe('cached');
    expect(claude?.version).toBe('1.0.0');

    // AC2 — and it is fast, which is the entire reason the cache exists.
    const probeStep = second.timings.find((timing) => timing.step === 'probe-providers');
    expect(probeStep?.ms).toBeLessThan(50);
  });
});

suite('a rebuilt binary is probed again (EPIC-18-S17 scenario 2)', () => {
  it('handshakes the new bytes and rewrites the manifest with the new version', async () => {
    const dataDir = join(tmp, 'data');
    const binDir = join(tmp, 'bin');
    const log = join(tmp, 'agent.log');
    await writeFakeAgent(binDir, { version: '1.0.0', log });

    const first = await up(dataDir, binDir);
    if (first.kind === 'started') await first.stop();
    expect(handshakes(await invocations(log))).toHaveLength(1);

    // The same path, different bytes and a different reported version — a
    // nightly build, or a `pnpm link` over the top.
    await writeFakeAgent(binDir, { version: '1.1.0', log });

    const second = await up(dataDir, binDir);
    expect(second.kind).toBe('started');
    if (second.kind !== 'started') return;

    expect(handshakes(await invocations(log))).toHaveLength(2);
    const claude = second.providers.find((entry) => entry.provider === 'claude');
    expect(claude?.status).toBe('detected');
    expect(claude?.version).toBe('1.1.0');
  });
});

suite('a machine with no agent CLI at all (EPIC-18-S15, AC8)', () => {
  it('starts anyway, reports zero providers and prints what to install', async () => {
    const dataDir = join(tmp, 'data');
    const emptyBin = join(tmp, 'empty-bin');

    const result = await runUp({
      env: upEnv({ dataDir, binDirs: [emptyBin] }),
      port: 0,
      open: false,
      timings: false,
    });
    started.push(result);

    expect(result.kind).toBe('started');
    if (result.kind !== 'started') return;

    expect(result.exitCode).toBe(0);
    expect(result.providers.every((entry) => entry.status === 'not-installed')).toBe(true);
    expect(result.stdout).toContain('0 providers available');
    // Every vendor named, each with the command that installs it.
    for (const entry of result.providers) {
      expect(result.stdout).toContain(entry.provider);
    }
    expect(result.stdout).toMatch(/npm install -g/);
    // …and what still works with nothing installed at all.
    expect(result.stdout).toContain('DeFlow-mock-agent');
    expect(result.stdout).toContain('DeFlow replay');
    expect(result.stderr).toBe('');
  });
});
