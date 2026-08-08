/**
 * KAR-12.1 test plan #10 — evidence lives behind a handle, and content
 * addressing makes the repair loop's repeats free.
 *
 * Un-spilled tool output is what makes replay time explode
 * (docs/10-verification-gates.md §8): `event` is append-only and is re-read in
 * full by every replay for the life of the run, so a 5 MB test log written into
 * it is permanent *and* recurring cost.
 *
 * Verifies: EPIC-12-S9 · AC10
 */

import type { NodeId } from '@DeFlow/core';
import { canonicalJson } from '@DeFlow/core';
import { EXCERPT_BYTES, MAX_INLINE_PAYLOAD_BYTES } from '@DeFlow/ledger';
import { it, makeRepo, TestClock } from '@DeFlow/testkit';
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import { loadGateDefinition } from '../../src/definition.ts';
import { runGate } from '../../src/run-gate.ts';

const SPEC_HASH = `sha256-${'cd'.repeat(32)}`;

/**
 * A real producer of a 5 MB failing test log, written into the worktree and run
 * as a real child process.
 *
 * `process.exitCode` rather than `process.exit(1)`: exiting immediately after a
 * large `write` truncates the pipe, and a 64 KB log would make this spec pass
 * for the wrong reason.
 */
const FIVE_MB_PRODUCER = `const line = 'FAIL test/checkout.test.ts > refunds a cancelled order\\n';
let out = '';
while (out.length < 5 * 1024 * 1024) out += line;
process.stdout.write(out);
process.exitCode = 1;
`;

const RUN_PRODUCER = 'node emit-log.mjs';

const yamlFor = (command: string) => `id: unit
kind: deterministic
title: Unit tests
run: ${command}
cwd: worktree
timeout: 120s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: none
satisfies: [ac-1]
severityFloor: error
`;

async function runOnce(tmp: string, worktree: string, dataDir: string) {
  return runGate({
    definition: loadGateDefinition('.DeFlow/gates/unit.yaml', yamlFor(RUN_PRODUCER)),
    worktree,
    repoRoot: worktree,
    node: 'gate-unit' as NodeId,
    evaluatedNode: 'impl-1' as NodeId,
    specHash: SPEC_HASH,
    dataDir,
    clock: new TestClock(1_754_313_093_000),
    scrubbedEnv: [],
  });
}

/** Every published blob directory, `<dataDir>/blobs/<2 hex>/<sha256>`. */
function blobDirectories(dataDir: string): string[] {
  const root = join(dataDir, 'blobs');
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))
    .flatMap((entry) => readdirSync(join(root, entry.name)))
    .sort();
}

suite('a 5 MB test log (S9, first scenario)', () => {
  it('spills to the blob store and keeps the event payload under the bound', async ({ tmp }) => {
    const worktree = join(tmp, 'worktree');
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    await makeRepo({ dir: worktree });
    await writeFile(join(worktree, 'emit-log.mjs'), FIVE_MB_PRODUCER);

    const result = await runOnce(tmp, worktree, dataDir);

    expect(result.outcome).toBe('fail');
    const evidence = result.evidence;
    expect(evidence).not.toBeNull();
    expect(evidence?.spilled).toBe(true);
    expect(evidence?.bytes).toBeGreaterThan(5 * 1024 * 1024);
    expect(evidence?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence?.mime).toBe('text/plain');
    // ~2 KiB each end, which is what makes a preview free.
    expect(evidence?.head.length).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(evidence?.tail.length).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(evidence?.head.length).toBeGreaterThan(0);
    expect(evidence?.tail.length).toBeGreaterThan(0);

    // The `gate.evaluated` body — the verdict — stays far under the bound.
    const payload = canonicalJson({
      gate: result.verdict.gate,
      node: result.verdict.by.node,
      verdict: result.verdict,
    });
    expect(Buffer.byteLength(payload, 'utf8')).toBeLessThan(MAX_INLINE_PAYLOAD_BYTES);
  }, 60_000);
});

suite('content addressing dedupes across repair attempts (S9, second scenario)', () => {
  it('writes one blob for three byte-identical logs', async ({ tmp }) => {
    const worktree = join(tmp, 'worktree');
    const dataDir = join(tmp, 'data');
    await mkdir(dataDir, { recursive: true });
    await makeRepo({ dir: worktree });
    await writeFile(join(worktree, 'emit-log.mjs'), FIVE_MB_PRODUCER);

    const attempts = [
      await runOnce(tmp, worktree, dataDir),
      await runOnce(tmp, worktree, dataDir),
      await runOnce(tmp, worktree, dataDir),
    ];

    const digests = new Set(attempts.map((attempt) => attempt.evidence?.sha256));
    expect(digests.size).toBe(1);
    expect(blobDirectories(dataDir)).toHaveLength(1);
  }, 120_000);
});
