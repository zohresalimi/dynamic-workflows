/**
 * KAR-19.11 / EPIC-19-S71, EPIC-19-S74, EPIC-19-S76 — the double refuses what
 * the real CLI refuses, so a wrong argument shape is red here rather than on an
 * operator's machine.
 *
 * **This is the half of the story worth more than the fix.** Both of the
 * defects found on 2026-08-13 — the `run_…`-shaped `--session-id` at 19:57 and
 * the file path on `--json-schema` at 19:59 — passed every level of the suite
 * and failed on the first real invocation, for one reason: the argv was
 * asserted against fixtures and against fakes that accepted whatever they were
 * handed. So the claim here is not that the argv contains a flag; it is that a
 * process which validates its arguments the way the vendor does was handed the
 * whole thing and exited 0.
 *
 * It runs everywhere: no vendor CLI, no credential, no network. The rows that
 * need a real, installed, authenticated CLI are opt-in and live in
 * `test/exec-shim-argv.manual.test.ts` behind `DeFlow_MANUAL_VENDOR_CLI=1`.
 *
 * Verifies: EPIC-19-S71, EPIC-19-S74, EPIC-19-S76 · KAR-19.11 AC1, AC5, AC7
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { DIALECT_ENV, it, linkFakeAgent, SCENARIO_ENV } from '@DeFlow/testkit';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, describe as suite } from 'vitest';
import {
  argumentRefused,
  PROVIDER_SPECS,
  rejectedArgument,
  shimPlan,
  vendorSessionId,
} from '../../src/index.ts';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../../schemas/', import.meta.url));
const DRAFT_ID = 'DeFlow.taskspecdraft.v1';
const DRAFT_PATH = join(SCHEMAS_DIR, `${DRAFT_ID}.json`);
const DRAFT_DOCUMENT = readFileSync(DRAFT_PATH, 'utf8');
/** What actually goes on the flag: the emitted document minus the one key
 * claude's own validator cannot resolve (`stripKeys` on its entry). */
const SENT_DOCUMENT = ((): string => {
  const { $schema: _dialect, ...rest } = JSON.parse(DRAFT_DOCUMENT) as Record<string, unknown>;
  return JSON.stringify(rest);
})();
const SCENARIO = fileURLToPath(
  new URL('../../../testkit/scenarios/claude-turn.json', import.meta.url),
);

const RUN = RunIdSchema.parse('run_20260813T110608Z_379fc8');

/** The four turn kinds that reach the shim (EPIC-19-S71's Examples table). */
const TURNS = ['framing', 'recon', 'planner', 'implement'] as const;

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

const FAKE_ENV = { [DIALECT_ENV]: 'claude-stream-json', [SCENARIO_ENV]: SCENARIO } as const;

/** The argv the registry itself builds. Never assembled here: an invocation
 * this file put together is a different one from the product's. */
function framingArgv(binary: string, worktree: string, turn: string): readonly string[] {
  return shimPlan(PROVIDER_SPECS.claude, {
    resolved: { provider: 'claude', path: binary },
    worktree,
    prompt: 'Frame this task.',
    sessionId: vendorSessionId({ runId: RUN, nodeId: NodeIdSchema.parse(turn), attempt: 0 }),
    permission: 'read',
    schemaPath: DRAFT_PATH,
    schemaDocument: DRAFT_DOCUMENT,
  }).argv;
}

suite('EPIC-19-S71 — the framing turn survives the vendor’s own parse of --json-schema', () => {
  for (const turn of TURNS) {
    it(`${turn}: the child parses the schema argument and exits 0`, async ({ tmp }) => {
      const worktree = join(tmp, turn);
      await mkdir(worktree, { recursive: true });
      const agent = await linkFakeAgent(worktree, 'claude');

      const argv = framingArgv(agent.binary, worktree, turn);
      const at = argv.indexOf('--json-schema');
      expect(at).toBeGreaterThanOrEqual(0);

      // The assertion parses the argv value rather than matching a substring
      // of it — the vendor's refusal was a `JSON.parse` failure, so this has to
      // be the same operation.
      expect(JSON.parse(argv[at + 1] ?? '')).toEqual(JSON.parse(SENT_DOCUMENT));
      expect(argv).not.toContain(DRAFT_PATH);

      const turned = await run(agent.binary, argv, FAKE_ENV);

      expect(turned.stderr).toBe('');
      expect(turned.code).toBe(0);
    });
  }
});

suite('EPIC-19-S74 — the fakes refuse what the real CLIs refuse', () => {
  it('a filesystem path on --json-schema exits non-zero, naming the flag', async ({ tmp }) => {
    const worktree = join(tmp, 'path-on-json-schema');
    await mkdir(worktree, { recursive: true });
    const agent = await linkFakeAgent(worktree, 'claude');

    // The exact invocation of 2026-08-13 19:59, reconstructed: the argv the
    // registry builds with the *path* substituted back onto the flag.
    const argv = framingArgv(agent.binary, worktree, 'framing').map((element) =>
      element === SENT_DOCUMENT ? DRAFT_PATH : element,
    );

    const turned = await run(agent.binary, argv, FAKE_ENV);

    expect(turned.code).not.toBe(0);
    expect(turned.stderr).toContain('--json-schema');
    expect(turned.stderr).toContain('is not valid JSON');
    // The vendor's own words: it fails on the leading '/' of the path.
    expect(turned.stderr).toContain("Unrecognized token '/'");
  });

  it('a non-uuid --session-id exits non-zero the same way', async ({ tmp }) => {
    const worktree = join(tmp, 'run-shaped-session-id');
    await mkdir(worktree, { recursive: true });
    const agent = await linkFakeAgent(worktree, 'claude');

    const argv = framingArgv(agent.binary, worktree, 'framing');
    const at = argv.indexOf('--session-id');
    const wrong = [...argv];
    wrong[at + 1] = `${RUN}-framing`;

    const turned = await run(agent.binary, wrong, FAKE_ENV);

    expect(turned.code).not.toBe(0);
    expect(turned.stderr).toContain('Invalid session ID');
  });

  it('an inline document on codex’s --output-schema exits non-zero', async ({ tmp }) => {
    // The inverse mistake, and the one the fix could easily introduce: Codex
    // CLI documents `--output-schema <FILE>` and would refuse a document.
    const worktree = join(tmp, 'document-on-output-schema');
    await mkdir(worktree, { recursive: true });
    const agent = await linkFakeAgent(worktree, 'codex');

    const argv = shimPlan(PROVIDER_SPECS.codex, {
      resolved: { provider: 'codex', path: agent.binary },
      worktree,
      prompt: 'Frame this task.',
      sessionId: vendorSessionId({
        runId: RUN,
        nodeId: NodeIdSchema.parse('framing'),
        attempt: 0,
      }),
      permission: 'read',
      schemaPath: DRAFT_PATH,
      schemaDocument: DRAFT_DOCUMENT,
    }).argv.map((element) => (element === DRAFT_PATH ? SENT_DOCUMENT : element));

    const turned = await run(agent.binary, argv, {
      [DIALECT_ENV]: 'codex-jsonl',
      [SCENARIO_ENV]: SCENARIO,
    });

    expect(turned.code).not.toBe(0);
    expect(turned.stderr).toContain('--output-schema');
  });
});

suite('EPIC-19-S76 — a second refused argument is still named, quoted and not retried', () => {
  it('names --json-schema, quotes the child’s stderr and classifies it permanent', async ({
    tmp,
  }) => {
    const worktree = join(tmp, 'refusal-reporting');
    await mkdir(worktree, { recursive: true });
    const agent = await linkFakeAgent(worktree, 'claude');

    const argv = framingArgv(agent.binary, worktree, 'framing').map((element) =>
      element === SENT_DOCUMENT ? DRAFT_PATH : element,
    );
    const turned = await run(agent.binary, argv, FAKE_ENV);

    const rejected = rejectedArgument({
      argv,
      stderr: turned.stderr,
      spec: PROVIDER_SPECS.claude,
    });

    expect(rejected?.flag).toBe('--json-schema');
    expect(rejected?.value).toBe(DRAFT_PATH);

    const failure = argumentRefused({
      provider: 'claude',
      rejected: rejected ?? { flag: '?', value: null },
      stderr: turned.stderr,
      code: turned.code,
      signal: null,
    });

    // The three properties KAR-19.8 established, asserted on a *second* flag so
    // that they are a property of argument refusals rather than a special case
    // of `--session-id`.
    expect(failure.deflowFailure.class).toBe('permanent');
    expect(failure.deflowFailure.detail).toMatchObject({
      flag: '--json-schema',
      value: DRAFT_PATH,
    });
    // The child's own words, trimmed and not paraphrased.
    expect(String(failure.deflowFailure.detail?.['stderr'])).toBe(turned.stderr.trim());
    expect(failure.message).toContain('--json-schema');
    expect(failure.message).toContain('is not valid JSON');
  });

  it('reduces an inline schema document to its schema id wherever argv is recorded', async ({
    tmp,
  }) => {
    // AC8: what the vendor is handed changes, what an operator can read
    // afterwards does not — and a failure payload the ledger keeps for ever
    // must not become a paste of the whole schema.
    const worktree = join(tmp, 'redacted-argv');
    await mkdir(worktree, { recursive: true });
    const agent = await linkFakeAgent(worktree, 'claude');

    const argv = framingArgv(agent.binary, worktree, 'framing');
    const stderr = 'Error: --json-schema is unsupported without --print';

    const rejected = rejectedArgument({ argv, stderr, spec: PROVIDER_SPECS.claude });
    expect(rejected?.flag).toBe('--json-schema');
    expect(rejected?.value).toContain(DRAFT_ID);
    expect(rejected?.value?.length).toBeLessThan(SENT_DOCUMENT.length);

    const failure = argumentRefused({
      provider: 'claude',
      rejected: rejected ?? { flag: '?', value: null },
      stderr,
      code: 1,
      signal: null,
    });
    expect(failure.message).not.toContain('"properties"');
  });
});
