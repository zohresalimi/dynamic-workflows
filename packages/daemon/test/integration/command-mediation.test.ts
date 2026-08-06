/**
 * KAR-08.3 — the command boundary, against a real agent and real processes.
 *
 * The unit suite (../../src/services/command-mediation.test.ts) proves the
 * mediator decides. What only a process boundary can prove is the claim the
 * whole story rests on: **the command shown is the command run**. The fake
 * binaries below record the argv they were actually given, and the assertion
 * holds that against the JSON the `human.requested` event put in front of the
 * operator. An approval queue that renders a normalised or shell-quoted form
 * and then spawns a different string is an approval of something the operator
 * did not see, and no amount of unit testing sees it.
 *
 * The second thing only this level can prove is the *negative* one: while a
 * gate is outstanding, **no process exists**. The fake binaries append to a
 * log as their first act, so "nothing was spawned" is a fact about the
 * filesystem rather than about what the mediator says it did.
 *
 * Fake binaries rather than the real `pnpm`, and invoked by absolute path:
 * allowlist matching is on the resolved binary *name*, so `<tmp>/bin/pnpm` is
 * `pnpm` — which is the same mechanism `./node_modules/.bin/vitest` needs, and
 * it keeps a thirty-command budget run to a few hundred milliseconds. Nothing
 * of the machine's is touched: a tmpdir, its own shell scripts, its own
 * ledger.
 *
 * Verifies: EPIC-08-S12, EPIC-08-S13, EPIC-08-S15 · AC1, AC2, AC7, AC8
 */

import type { EventRecord, IoRecord, LedgerSink } from '@DeFlow/adapters';
import { runAcpNode } from '@DeFlow/adapters';
import {
  type CommandsConfig,
  type EventSeq,
  type Handle,
  HandleSchema,
  HumanRequestedSchema,
  type NodeId,
  NodeIdSchema,
  type PermissionLevel,
  type PermissionScope,
  type ProviderId,
  ProviderIdSchema,
  permissionScopeFrom,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunk,
  blobHandle,
  openLedger,
  readEpoch,
  readRange,
  spillBytes,
} from '@DeFlow/ledger';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  acpFsHandlers,
  acpTerminalHandlers,
  type CommandApproval,
  type CommandDecision,
  type CommandDenial,
  type CommandGate,
  type CommandGatePayload,
  createCommandMediator,
  createFsService,
  createPathMediator,
  createTerminalService,
  humanCommandGate,
  permissionDeniedPayload,
  worktreeCommandPolicy,
  worktreePathPolicy,
} from '../../src/index.ts';

const MOCK_AGENT_BIN = fileURLToPath(
  new URL('../../../mock-agent/bin/mock-agent.ts', import.meta.url),
);

const RUN_ID: RunId = RunIdSchema.parse('run_20260806T101500Z_ac0803');
const NODE_ID: NodeId = NodeIdSchema.parse('n1');
const PROVIDER: ProviderId = ProviderIdSchema.parse('mock');

/**
 * The fixture repository's `DeFlow.config.ts` — its actual verbs, which is
 * what §10.3 says the allowlist is. The budget assertion is only meaningful
 * because this list was written from what the run does, not adjusted until the
 * run passed.
 */
const COMMANDS: CommandsConfig = {
  allow: ['pnpm', 'node', 'git', 'eslint', 'tsc', 'vitest'],
  readOnly: ['git status'],
  allowDomains: [],
};

let dir = '';
let worktree = '';
let binDir = '';
let spawnLog = '';
let db: ReturnType<typeof openLedger>;
let sink: LedgerSink;
let captureEvidence: (text: string) => Handle;

/**
 * A binary that records the argv it was given, one element per line, and then
 * says `ok`.
 *
 * A real executable, not a double: this is what makes "the argv that reached
 * `spawn`" an observation rather than an assertion about DeFlow's own memory.
 */
async function fakeBinary(name: string): Promise<void> {
  const path = join(binDir, name);
  await writeFile(
    path,
    [
      '#!/bin/sh',
      `{ printf '%s\\n' "$0" "$@"; printf -- '---\\n'; } >> ${spawnLog}`,
      'echo ok',
    ].join('\n'),
    'utf8',
  );
  await chmod(path, 0o755);
}

/** Every invocation the fake binaries recorded, as `[argv0, ...args]`. */
async function spawned(): Promise<string[][]> {
  const text = await readFile(spawnLog, 'utf8').catch(() => '');
  return text
    .split('---\n')
    .filter((block) => block !== '')
    .map((block) => block.split('\n').filter((line) => line !== ''));
}

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  binDir = join(dir, 'bin');
  spawnLog = join(dir, 'spawned.log');
  await mkdir(join(worktree, 'src'), { recursive: true });
  await mkdir(join(dir, 'outside'), { recursive: true });
  await mkdir(binDir, { recursive: true });
  for (const name of ['pnpm', 'node', 'git', 'eslint', 'tsc', 'vitest', 'rsync', 'terraform']) {
    await fakeBinary(name);
  }
  db = openLedger(dir);
  const epoch = readEpoch(db);
  sink = {
    append: (event: EventRecord) =>
      Promise.resolve(
        appendEvents(db, [
          {
            runId: RUN_ID,
            ts: event.ts,
            kind: event.kind,
            v: event.v,
            epoch,
            nodeId: event.nodeId,
            attempt: event.attempt,
            ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
            payload: event.payload,
          },
        ])[0] as EventSeq,
      ),
    appendIo: (chunk: IoRecord) =>
      Promise.resolve(
        appendIoChunk(db, {
          runId: RUN_ID,
          nodeId: chunk.nodeId,
          attempt: chunk.attempt + 1,
          stream: chunk.stream,
          ts: chunk.ts,
          data: chunk.data,
        }),
      ),
  };
  captureEvidence = (text: string): Handle =>
    HandleSchema.parse(blobHandle(spillBytes(dir, Buffer.from(text, 'utf8'), 'text/plain').sha256));
});

afterEach(async () => {
  db.close();
  await removeTempDir(dir);
});

const scopeFor = (commands: CommandsConfig = COMMANDS): PermissionScope =>
  permissionScopeFrom(commands, { worktree, scrubbedEnv: [] });

// ── the wiring under test ────────────────────────────────────────────────────

interface Observed {
  readonly gates: CommandGatePayload[];
  readonly decisions: CommandDecision[];
  readonly denials: CommandDenial[];
}

interface RunOptions {
  readonly level?: PermissionLevel;
  readonly commands?: CommandsConfig;
  /** Consumed in order, one per gate. `null` means nobody ever answers. */
  readonly answers?: readonly (CommandApproval | null)[];
}

async function runScenario(
  steps: readonly unknown[],
  options: RunOptions = {},
): Promise<{ outcome: Awaited<ReturnType<typeof runAcpNode>>; observed: Observed }> {
  const level = options.level ?? 'worktree';
  const scope = scopeFor(options.commands);
  const clock = new TestClock();
  const observed: Observed = { gates: [], decisions: [], denials: [] };
  const answers = [...(options.answers ?? [])];

  const mediator = createCommandMediator({
    level,
    scope,
    record: (decision) => observed.decisions.push(decision),
    escalate: humanCommandGate({
      node: NODE_ID,
      // AC1/AC8 — the escalation is a ledger event with a structured reason,
      // appended before anybody is asked.
      emit: (payload) => {
        observed.gates.push(payload);
        void sink.append({
          kind: 'human.requested',
          v: 1,
          ts: clock.now(),
          nodeId: NODE_ID,
          payload,
        });
      },
      // EPIC-13 owns the queue; this is what it will do — record the answer as
      // `human.responded` and hand it back.
      ask: (gate: CommandGate) => {
        const answer = answers.shift() ?? 'reject';
        if (answer !== null) {
          void sink.append({
            kind: 'human.responded',
            v: 1,
            ts: clock.now(),
            nodeId: NODE_ID,
            payload: {
              node: NODE_ID,
              optionId: answer,
              at: new Date(clock.now()).toISOString(),
            },
          });
        }
        void gate;
        return Promise.resolve(answer);
      },
    }),
  });

  const terminal = createTerminalService({
    root: worktree,
    policy: worktreeCommandPolicy(mediator, {
      onDenied: (denial) => {
        observed.denials.push(denial);
        void sink.append({
          kind: 'permission.denied',
          v: 1,
          ts: clock.now(),
          nodeId: NODE_ID,
          attempt: 0,
          payload: permissionDeniedPayload(denial, { node: NODE_ID, attempt: 0 }),
        });
      },
    }),
  });
  const fs = createFsService({
    root: worktree,
    policy: worktreePathPolicy(createPathMediator({ level, scope })),
  });

  const scenarioPath = join(dir, 'commands.json');
  await writeFile(
    scenarioPath,
    JSON.stringify({ name: 'commands', steps, stopReason: 'end_turn' }),
  );

  const outcome = await runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: level,
      worktree,
      binary: { path: MOCK_AGENT_BIN, version: '0.0.0', sha256: 'd'.repeat(64) },
      argv: ['--seed', '42', '--scenario', scenarioPath],
      mcpServers: [],
      prompt: 'go',
    },
    {
      clock,
      ledger: sink,
      captureEvidence,
      handlers: { ...acpFsHandlers(fs), ...acpTerminalHandlers(terminal) },
    },
  );

  return { outcome, observed };
}

/** One `terminal/create` plus the rest of the lifecycle, as the flow file
 * writes it. */
const runCommand = (
  command: string,
  args: readonly string[] = [],
  cwd: string | null = null,
): unknown[] => [
  {
    type: 'clientCall',
    method: 'terminal/create',
    params: cwd === null ? { command, args } : { command, args, cwd },
    onError: { steps: [{ type: 'message', text: `refused: {{error}}` }] },
  },
  { type: 'clientCall', method: 'terminal/wait_for_exit', params: {} },
  { type: 'clientCall', method: 'terminal/output', params: {} },
  { type: 'clientCall', method: 'terminal/release', params: {} },
];

const bin = (name: string): string => join(binDir, name);

const events = (kind: string): { readonly payload: unknown }[] =>
  readRange(db, RUN_ID, 0, 2000).events.filter((event) => event.kind === kind);

const transcript = (outcome: Awaited<ReturnType<typeof runAcpNode>>): string =>
  outcome.status === 'completed' ? ((outcome.result.output as { text: string }).text ?? '') : '';

// ── EPIC-08-S12 ──────────────────────────────────────────────────────────────

suite('EPIC-08-S12 — an allowlisted command runs free inside the worktree', () => {
  it('runs pnpm test through the whole terminal lifecycle and asks nobody', async () => {
    const { outcome, observed } = await runScenario(runCommand(bin('pnpm'), ['test']));

    expect(outcome.status).toBe('completed');
    expect(transcript(outcome)).not.toContain('refused:');
    // AC2 — no escalation and no human event.
    expect(observed.gates).toEqual([]);
    expect(events('human.requested')).toEqual([]);
    expect(observed.decisions.map((decision) => decision.outcome)).toEqual(['allow']);
    // And the command really ran, in the worktree.
    expect(await spawned()).toEqual([[bin('pnpm'), 'test']]);
    expect(observed.decisions[0]?.cwd).toBe(worktree);
  });

  it('matches the allowlist on the resolved binary, not the raw string', async () => {
    // `<tmp>/bin/vitest` is `vitest`, exactly as `./node_modules/.bin/vitest`
    // is: a raw string comparison gates the test runner, and a gated test
    // runner is the fastest possible way to blow the budget.
    const { observed } = await runScenario(runCommand(bin('vitest'), ['run']));

    expect(observed.gates).toEqual([]);
    expect(await spawned()).toEqual([[bin('vitest'), 'run']]);
  });

  it('refuses a cwd outside the worktree even for an allowlisted binary', async () => {
    const { outcome, observed } = await runScenario(
      runCommand(bin('git'), ['status'], join(dir, 'outside')),
    );

    // A rejection the agent survives, not a teardown.
    expect(outcome.status).toBe('completed');
    expect(transcript(outcome)).toContain('path-escape:cwd');
    expect(observed.denials.map((denial) => denial.reason)).toEqual([
      { code: 'path-escape', detail: 'cwd' },
    ]);
    // Nothing ran, and nobody was asked: a path escape is refused, not
    // negotiated.
    expect(await spawned()).toEqual([]);
    expect(observed.gates).toEqual([]);

    // AC8 — recorded as a code plus a detail, never a sentence.
    const [denied] = events('permission.denied');
    expect(denied?.payload).toMatchObject({
      permission: 'worktree',
      method: 'terminal/create',
      reason: { code: 'path-escape', detail: 'cwd' },
    });
  });
});

// ── EPIC-08-S13 ──────────────────────────────────────────────────────────────

suite('EPIC-08-S13 — a command not on the allowlist routes to a human gate', () => {
  it('emits human.requested with the whole request before anything is run', async () => {
    const { outcome, observed } = await runScenario(
      runCommand(bin('rsync'), ['-av', '/', '/backup']),
      { answers: ['approve'] },
    );

    expect(outcome.status).toBe('completed');
    expect(observed.decisions[0]?.outcome).toBe('gate');
    expect(observed.gates).toHaveLength(1);

    // AC1 — the event carries the full `{command, args, cwd}` rendered, and it
    // is a valid `human.requested` payload with a structured reason.
    const payload = observed.gates[0];
    expect(HumanRequestedSchema.safeParse(payload).success).toBe(true);
    expect(payload?.reason).toEqual({ code: 'not-allowlisted', detail: 'rsync' });
    expect(JSON.parse(payload?.prompt.split('\n').at(-1) ?? '')).toEqual({
      command: bin('rsync'),
      args: ['-av', '/', '/backup'],
      cwd: worktree,
    });

    // The event was in the ledger before the answer was, and the command ran
    // only after both. The half of "no terminal is created until the operator
    // responds" that a *timed* snapshot cannot prove — process startup is
    // milliseconds, so an empty log a moment after an optimistic spawn would
    // be a race rather than an observation — is proved by the rejection case
    // below: there, the command never runs at all, which no
    // create-then-kill-it implementation can satisfy.
    expect(
      readRange(db, RUN_ID, 0, 2000)
        .events.map((event) => event.kind)
        .filter((kind) => kind === 'human.requested' || kind === 'human.responded'),
    ).toEqual(['human.requested', 'human.responded']);
    expect(await spawned()).toEqual([[bin('rsync'), '-av', '/', '/backup']]);
  });

  it('runs exactly the command that was shown, byte for byte', async () => {
    // The argument a shell rendering would quote, split or mangle. What the
    // operator read has to be what `execve` got, and the only way to know is
    // to ask the process.
    const args = ['--exclude', 'a b "c"', '-av', '/', '/backup'];
    const { observed } = await runScenario(runCommand(bin('rsync'), args), {
      answers: ['approve'],
    });

    const shown = JSON.parse(observed.gates[0]?.prompt.split('\n').at(-1) ?? '') as {
      command: string;
      args: string[];
    };
    expect(await spawned()).toEqual([[shown.command, ...shown.args]]);
    expect(shown.args).toEqual(args);
  });

  it('spawns nothing when the operator rejects, and the agent carries on', async () => {
    const { outcome, observed } = await runScenario(
      [...runCommand(bin('rsync'), ['-av', '/', '/backup']), ...runCommand(bin('pnpm'), ['test'])],
      { answers: ['reject'] },
    );

    expect(outcome.status).toBe('completed');
    expect(transcript(outcome)).toContain('not-allowlisted:rsync');
    // The rejected command never ran; the legal one that followed it did.
    expect(await spawned()).toEqual([[bin('pnpm'), 'test']]);
    expect(observed.denials.map((denial) => denial.reason)).toEqual([
      { code: 'not-allowlisted', detail: 'rsync' },
    ]);
    // AC8 — a rejected gate is a `permission.denied` carrying the gate's own
    // code, because that is the only information in it.
    expect(events('permission.denied')[0]?.payload).toMatchObject({
      method: 'terminal/create',
      reason: { code: 'not-allowlisted', detail: 'rsync' },
    });
  });

  it('refuses, rather than hanging, when nobody will ever answer', async () => {
    const { outcome } = await runScenario(runCommand(bin('rsync')), { answers: [null] });

    expect(outcome.status).toBe('completed');
    expect(await spawned()).toEqual([]);
  });
});

// ── EPIC-08-S15 ──────────────────────────────────────────────────────────────

/**
 * The representative run: thirty commands and forty file writes, all of them
 * things this repository actually does.
 *
 * Written from the fixture's own verbs rather than adjusted until it passed —
 * which is the only way the budget assertion below means anything.
 */
function representativeRun(): unknown[] {
  const commands = [
    ...Array.from({ length: 10 }, (_unused, index) => ['pnpm', ['run', `task-${index}`]] as const),
    ...Array.from(
      { length: 6 },
      (_unused, index) => ['node', [`scripts/step-${index}.mjs`]] as const,
    ),
    ...Array.from({ length: 5 }, (_unused, index) => ['git', ['add', `src/f${index}.ts`]] as const),
    ...Array.from({ length: 4 }, () => ['eslint', ['.', '--fix']] as const),
    ...Array.from({ length: 3 }, () => ['tsc', ['--noEmit']] as const),
    ...Array.from({ length: 2 }, () => ['vitest', ['run']] as const),
  ];
  const writes = Array.from({ length: 40 }, (_unused, index) => ({
    type: 'clientCall',
    method: 'fs/write_text_file',
    params: {
      path: join(worktree, 'src', `f${index}.ts`),
      content: `export const f${index} = 1;\n`,
    },
    onError: { steps: [{ type: 'message', text: `write refused: {{error}}` }] },
  }));

  return [...writes, ...commands.flatMap(([command, args]) => runCommand(bin(command), args))];
}

/** The commands a run gated, named — so a failing budget says what to add to
 * the allowlist rather than "expected 0 to be 4". */
const gatedCommands = (observed: Observed): string[] =>
  observed.decisions
    .filter((decision) => decision.outcome === 'gate')
    .map((decision) => `${decision.command} ${decision.args.join(' ')}`.trim());

suite('EPIC-08-S15 — the gate budget: 200 gates is worse than no gate', () => {
  it('a representative run at worktree level produces exactly zero gates', async () => {
    const { outcome, observed } = await runScenario(representativeRun());

    expect(outcome.status).toBe('completed');
    // The assertion the story exists for. If this fails, the allowlist is the
    // bug — not the operator, and not this number.
    expect(gatedCommands(observed)).toEqual([]);
    expect(events('human.requested')).toEqual([]);
    expect(observed.decisions).toHaveLength(30);
    expect((await spawned()).length).toBe(30);
  }, 60_000);

  it('a deliberately narrow allowlist blows the budget, and names what it gated', async () => {
    const narrowed: CommandsConfig = {
      ...COMMANDS,
      allow: COMMANDS.allow.filter((verb) => verb !== 'pnpm'),
    };
    const { observed } = await runScenario(representativeRun(), {
      commands: narrowed,
      answers: Array.from({ length: 10 }, () => 'reject' as const),
    });

    // Ten questions in one run, from removing one verb. That is the shape of
    // the failure §10.5 is about, and the fix is to the allowlist.
    const gated = gatedCommands(observed);
    expect(gated).toHaveLength(10);
    expect(gated[0]).toBe(`${bin('pnpm')} run task-0`);
    expect(observed.decisions.filter((decision) => decision.outcome === 'gate')).toHaveLength(10);
  }, 60_000);

  it('the one gate that matters is the only one that fires', async () => {
    const { observed } = await runScenario(
      [...representativeRun(), ...runCommand(bin('terraform'), ['destroy'])],
      { answers: ['reject'] },
    );

    expect(gatedCommands(observed)).toEqual([`${bin('terraform')} destroy`]);
    const gates = events('human.requested');
    expect(gates).toHaveLength(1);
    // "distinguishable in the approval queue without scrolling": it carries
    // the rule that fired, not just the fact that something did.
    expect(gates[0]?.payload).toMatchObject({
      reason: { code: 'destructive-command', detail: 'terraform-destroy' },
    });
    // And `terraform destroy` never ran.
    expect((await spawned()).some((argv) => argv[0] === bin('terraform'))).toBe(false);
  }, 60_000);
});
