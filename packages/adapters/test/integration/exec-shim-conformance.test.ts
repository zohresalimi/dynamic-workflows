/**
 * KAR-19.8 AC7 — the F3.4 battery's new row: **the vendor accepts the argv this
 * registry entry builds.**
 *
 * Every other exec-shim spec in the tree asserts something about the argv as a
 * *string* — that it contains `--verbose`, that it refuses a format the vendor
 * has not got. None of them asserts that a process handed the whole thing
 * survives it, and that gap is exactly where the 2026-08-13 failure lived: the
 * argv was well-formed, every unit test agreed with it, and Claude Code 2.1.220
 * exited 1 on the value DeFlow put on `--session-id`.
 *
 * So this is one row per exec-shim vendor, and it spawns. Three of them run
 * against `@DeFlow/testkit`'s fake vendor CLI — which, since KAR-19.8, enforces
 * the vendor's own argument rules rather than accepting whatever it is handed —
 * and the bundled agent runs against its real binary. A vendor no double
 * impersonates is **reported as skipped, with the reason**, because a row that
 * quietly does not run is indistinguishable from one that passed (the same rule
 * `conformance.ts` is built on).
 *
 * The half that needs a real, installed, authenticated CLI is opt-in and lives
 * in `test/exec-shim-argv.manual.test.ts` behind `DeFlow_MANUAL_VENDOR_CLI=1`.
 * This file is what runs on every commit.
 *
 * Verifies: EPIC-19-S52, EPIC-19-S56 (the automatable half) · KAR-19.8 AC7
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { DIALECT_ENV, type Dialect, it, linkFakeAgent, SCENARIO_ENV } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import { PROVIDER_SPECS, type ProviderSpec, shimPlan, vendorSessionId } from '../../src/index.ts';
import { MOCK_AGENT_BIN } from './support/harness.ts';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));
const DRAFT_SCHEMA = join(SCHEMAS_DIR, 'DeFlow.taskspecdraft.v1.json');
const SCENARIO = fileURLToPath(
  new URL('../../../testkit/scenarios/claude-turn.json', import.meta.url),
);

const RUN = RunIdSchema.parse('run_20260813T110608Z_379fc8');
const NODE = NodeIdSchema.parse('framing');

/** Which fake dialect impersonates which vendor's CLI. A vendor absent from
 * this table has no double, and its row says so rather than not existing. */
const DOUBLES: Readonly<Record<string, Dialect>> = {
  claude: 'claude-stream-json',
  codex: 'codex-jsonl',
  copilot: 'copilot-json',
};

/** The words a CLI uses when it is refusing an argument rather than working. */
const REFUSAL = /\b(invalid|unknown|unrecognised|unrecognized|unsupported|unexpected)\b/i;

interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(
  binary: string,
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<Ran> {
  const child = spawn(binary, [...argv], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
  });
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  child.stdout.on('data', (bytes: Buffer) => out.push(bytes));
  child.stderr.on('data', (bytes: Buffer) => err.push(bytes));
  child.stdin.end();
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve({
        code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/** The argv the entry itself builds for a schema-bearing framing turn —
 * assembled by the registry, never by this file. */
function argvFor(spec: ProviderSpec, binary: string, worktree: string): readonly string[] {
  return shimPlan(spec, {
    resolved: { provider: spec.id, path: binary },
    worktree,
    prompt: 'Frame this task.',
    sessionId: vendorSessionId({ runId: RUN, nodeId: NODE, attempt: 0 }),
    permission: 'read',
    schemaPath: DRAFT_SCHEMA,
  }).argv;
}

const specs = Object.values(PROVIDER_SPECS) as readonly ProviderSpec[];

suite('KAR-19.8 AC7 — every exec-shim vendor accepts the argv its entry builds', () => {
  // One `it` per registry entry, generated from the table rather than listed —
  // a vendor added later gets its row without anyone remembering to write one.
  for (const spec of specs) {
    const id = spec.id;
    it(`${id} runs the invocation DeFlow would send it`, async ({ tmp, skip }) => {
      const worktree = join(tmp, id);
      await mkdir(worktree, { recursive: true });

      if (id === 'mock') {
        // The bundled agent, against its real binary: no double is needed
        // because DeFlow ships the thing itself.
        const turn = await run(MOCK_AGENT_BIN, argvFor(spec, MOCK_AGENT_BIN, worktree), {});

        expect(turn.code).toBe(0);
        expect(turn.stderr).not.toMatch(REFUSAL);
        return;
      }

      const dialect = DOUBLES[id];
      if (dialect === undefined) {
        // A skip is a result, not an absence — and the reason is the row.
        skip(
          `no double impersonates ${id}'s CLI; its argv is checked by the real-binary row, ` +
            'which is opt-in (DeFlow_MANUAL_VENDOR_CLI=1)',
        );
        return;
      }

      const agent = await linkFakeAgent(worktree, spec.shim.bin);
      const turn = await run(agent.binary, argvFor(spec, agent.binary, worktree), {
        [DIALECT_ENV]: dialect,
        [SCENARIO_ENV]: SCENARIO,
      });

      // Exit 0 is the whole claim: the vendor's own argument parser was handed
      // the registry's argv and did not refuse any part of it.
      expect(turn.stderr).not.toMatch(REFUSAL);
      expect(turn.code).toBe(0);
    });
  }
});
