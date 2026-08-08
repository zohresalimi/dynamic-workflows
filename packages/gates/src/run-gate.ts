/**
 * KAR-12.1 — the deterministic gate runner
 * (docs/10-verification-gates.md §1, §2, §8).
 *
 * Runs one gate definition's command as a real child process in a real
 * worktree, turns what it printed into typed findings, and seals the result as
 * a `Verdict`. Four properties are the story:
 *
 * **The deny list applies before spawn.** Gate commands are code from the
 * repository and get no special treatment (§2): a gate that wants to run a
 * migration is an infrastructure action wearing a gate's clothing. The refusal
 * is a *node failure* rather than a `fail` verdict — nothing was checked, so
 * there is nothing to have a verdict about.
 *
 * **Its own tooling failing is not the work being wrong.** A missing binary, a
 * timeout, or a non-zero exit that printed nothing parseable all produce
 * `needs-human`, never `fail`. Conflating them sends work into a repair loop
 * that no amount of repair will fix — the fix node would be asked to repair a
 * missing binary.
 *
 * **The timeout kills the process group.** `detached: true` means the child
 * leads a group, so a wedged `bash -c 'sleep 300 & …'` and everything it went
 * on to spawn are reachable with one signal. `process.kill(pid)` and
 * `process.kill(-pid)` differ by one character and by the entire behaviour, and
 * `killTree` is the one place that difference lives.
 *
 * **Evidence never travels inline.** Output goes to the content-addressed blob
 * store and the verdict carries a handle. Un-spilled tool output is what makes
 * replay time explode (§8), and the most common large artifact in DeFlow — the
 * same failing test log on attempts 2 and 3 of a repair loop — costs one blob
 * because the store is addressed by content.
 *
 * Time enters through the injected `Clock` (NF9). Nothing here reads
 * `Date.now()` or calls `setTimeout`.
 */
import {
  awaitGroupDrained,
  type GroupMember,
  killTree,
  SWEEP_KILL_GRACE_MS,
} from '@DeFlow/adapters';
import {
  type Clock,
  destructiveCommand,
  type Handle,
  type NodeId,
  reasonCode,
  type VerdictOutcome,
  type VerdictV2,
} from '@DeFlow/core';
import { EXCERPT_BYTES, MAX_INLINE_PAYLOAD_BYTES, spillBytes } from '@DeFlow/ledger';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { GateDefinition } from './definition.ts';
import type { GateFinding } from './finding.ts';
import { gateOutcome } from './outcome.ts';
import { parseFindings } from './parsers.ts';
import { sealVerdict } from './verdict-of.ts';

/**
 * The three ways a gate cannot answer at all (S6).
 *
 * Each is a different operator action — install the tool, look at what wedged,
 * look at what the command printed — which is why they are three values rather
 * than one `gate-error`.
 */
export const GATE_TOOL_REASONS = ['gate-tool-missing', 'gate-timeout', 'gate-no-output'] as const;

export type GateToolReason = (typeof GATE_TOOL_REASONS)[number];

/** The mime a gate's captured output carries. */
export const GATE_OUTPUT_MIME = 'text/plain';

/**
 * A gate command the execution boundary refused.
 *
 * A thrown error rather than a returned verdict: the node fails, and a failed
 * node is not a gate that said something about the work.
 */
export class GateExecutionRefused extends Error {
  readonly reason = 'safety.execution-boundary';
  /** The rule that matched — `terraform-apply`, `psql-remote`, `kubectl-delete`. */
  readonly rule: string;
  readonly gate: string;

  constructor(gate: string, rule: string, detail: string) {
    super(`gate ${gate} refused before spawn: ${detail}`);
    this.name = 'GateExecutionRefused';
    this.rule = rule;
    this.gate = gate;
  }
}

/** What a gate's captured output became. */
export interface GateEvidence {
  readonly handle: Handle;
  readonly sha256: string;
  readonly bytes: number;
  readonly mime: string;
  /** First ~2 KiB, so a preview costs no disk read. */
  readonly head: string;
  /** Last ~2 KiB. Empty when the output is shorter than one excerpt. */
  readonly tail: string;
  /** Whether the payload was over the inline bound and therefore had to spill. */
  readonly spilled: boolean;
}

export interface RunGateOptions {
  readonly definition: GateDefinition;
  /** The node's worktree, absolute. `cwd: worktree` runs here. */
  readonly worktree: string;
  /** The repository root, absolute. `cwd: repo` runs here, and findings are
   * made relative to it. */
  readonly repoRoot: string;
  /** The gate's own node. */
  readonly node: NodeId;
  /** Whose work is being judged. */
  readonly evaluatedNode: NodeId;
  /** The pinned spec this verdict is about. */
  readonly specHash: string;
  /** The data directory whose `blobs/` receives the captured output. */
  readonly dataDir: string;
  readonly clock: Clock;
  /** Variable names KAR-08.4 removed from the child environment. */
  readonly scrubbedEnv: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** Called with the child's pid the moment it exists. Observability for the
   * process-group assertions; nothing in the runner reads it back. */
  readonly onSpawn?: (pid: number) => void;
}

export interface GateRun {
  readonly gate: string;
  readonly outcome: VerdictOutcome;
  /** Why the gate could not answer, or `null` when it did. */
  readonly reason: GateToolReason | null;
  /** `null` when the command never ran or was killed before exiting. */
  readonly exitCode: number | null;
  readonly findings: readonly GateFinding[];
  readonly evidence: GateEvidence | null;
  readonly durationMs: number;
  /** Non-`Z` members of the process group still alive after a timeout kill.
   * Empty on every path but a failed kill. */
  readonly survivors: readonly GroupMember[];
  readonly verdict: VerdictV2;
}

// ── argv ─────────────────────────────────────────────────────────────────────

/**
 * A `run:` line as argv.
 *
 * Quote-aware and nothing else: no expansion, no globbing, no substitution, no
 * operators. §10.4 is explicit that static analysis of shell strings is
 * undecidable and gives false confidence, and this is not that — it is the
 * smallest reading that turns one documented YAML field into the `(command,
 * args)` pair the permission layer already judges. A command that needs a shell
 * says so by naming one, and is then judged as `sh`.
 */
export function splitCommandLine(line: string): readonly string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of line) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

// ── the child ────────────────────────────────────────────────────────────────

interface ChildResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly toolMissing: boolean;
  readonly timedOut: boolean;
  readonly survivors: readonly GroupMember[];
}

function runChild(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly clock: Clock;
    readonly onSpawn?: (pid: number) => void;
  },
): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    // `detached` buys a process group led by the child, so a wedged gate *and
    // everything it went on to spawn* are reachable with a single signal — and
    // stops that signal from also reaching DeFlowd.
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let toolMissing = false;
    let timedOut = false;
    let settled = false;
    let survivors: readonly GroupMember[] = [];

    // Non-null because `stdio` above asks for pipes on both; the typings widen
    // them to `null` for the `'inherit'` and `'ignore'` shapes this never uses.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });

    const pid = child.pid;
    if (pid !== undefined) options.onSpawn?.(pid);

    const timer = options.clock.setTimer(options.timeoutMs, () => {
      if (settled || pid === undefined) return;
      timedOut = true;
      // Stage 2 → 3 of §11.1's ladder, on the injected clock: SIGTERM to the
      // group, then SIGKILL after the grace, then verify the group emptied.
      killTree(pid, 'SIGTERM');
      options.clock.setTimer(SWEEP_KILL_GRACE_MS, () => {
        killTree(pid, 'SIGKILL');
        void awaitGroupDrained(pid, { clock: options.clock }).then((left) => {
          survivors = left;
        });
      });
    });

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      if (error.code === 'ENOENT') {
        toolMissing = true;
        resolve({ exitCode: null, stdout, stderr, toolMissing, timedOut, survivors });
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      timer.cancel();
      if (!timedOut) {
        resolve({ exitCode: code, stdout, stderr, toolMissing, timedOut, survivors });
        return;
      }
      // The child is gone; the group may not be. Wait for the verification the
      // timeout path started before answering, so `survivors` is the truth
      // rather than whatever had been observed by the time the pipe closed.
      void awaitGroupDrained(pid ?? 0, { clock: options.clock }).then((left) => {
        resolve({ exitCode: code, stdout, stderr, toolMissing, timedOut, survivors: left });
      });
    });
  });
}

// ── evidence ─────────────────────────────────────────────────────────────────

/**
 * Captured output, content-addressed.
 *
 * Everything is stored, not only what is over the bound: `parser: none`'s whole
 * evidence is the output, and a handle that only exists for large outputs is a
 * handle the diff view cannot rely on. `spilled` records whether the payload
 * *had* to leave the event, which is the assertion §8 cares about.
 */
function storeEvidence(dataDir: string, text: string): GateEvidence | null {
  if (text === '') return null;
  const bytes = Buffer.from(text, 'utf8');
  const descriptor = spillBytes(dataDir, bytes, GATE_OUTPUT_MIME);
  return {
    handle: `artifact://${descriptor.sha256}` as Handle,
    sha256: descriptor.sha256,
    bytes: descriptor.bytes,
    mime: descriptor.mime,
    head: descriptor.head.slice(0, EXCERPT_BYTES),
    tail: descriptor.tail.slice(0, EXCERPT_BYTES),
    spilled: descriptor.bytes > MAX_INLINE_PAYLOAD_BYTES,
  };
}

// ── the runner ───────────────────────────────────────────────────────────────

const summarise = (
  definition: GateDefinition,
  outcome: VerdictOutcome,
  reason: GateToolReason | null,
  findings: readonly GateFinding[],
): string => {
  if (reason !== null) return `${definition.id} could not answer: ${reason}`;
  if (outcome === 'pass') return `${definition.id} passed`;
  return `${definition.id} failed with ${findings.length} finding(s)`;
};

export async function runGate(options: RunGateOptions): Promise<GateRun> {
  const { definition, clock } = options;
  const cwd = definition.cwd === 'repo' ? options.repoRoot : options.worktree;
  const [command, ...args] = splitCommandLine(definition.run);
  if (command === undefined) {
    throw new GateExecutionRefused(definition.id, 'empty-run', 'its `run` line is empty');
  }

  // §2: the F5.6 deny list applies unchanged, and it applies *before* spawn.
  const refusal = destructiveCommand(command, args, {
    worktree: options.worktree,
    cwd,
    scrubbedEnv: options.scrubbedEnv,
  });
  if (refusal !== null) {
    throw new GateExecutionRefused(
      definition.id,
      refusal.detail ?? refusal.code,
      `${reasonCode(refusal)} — a gate is not a licence to run infrastructure actions`,
    );
  }

  const startedAt = clock.now();
  const child = await runChild(command, args, {
    cwd,
    env: options.env ?? process.env,
    timeoutMs: definition.timeoutMs,
    clock,
    ...(options.onSpawn === undefined ? {} : { onSpawn: options.onSpawn }),
  });
  const durationMs = clock.now() - startedAt;

  const captured = `${child.stdout}${child.stderr}`;
  const evidence = storeEvidence(options.dataDir, captured);
  const evidenceHandles: readonly Handle[] = evidence === null ? [] : [evidence.handle];

  const findings = child.toolMissing
    ? []
    : parseFindings(definition.findings.parser, {
        gate: definition.id,
        repoRoot: cwd,
        stdout: child.stdout,
        stderr: child.stderr,
        ...(definition.findings.path === undefined ? {} : { path: definition.findings.path }),
      });

  // The three ways a gate cannot answer, in the order they can be told apart.
  // `gate-no-output` is last because it is the residual: the command ran, it
  // did not exit as expected, and it printed nothing anybody can act on.
  const reason: GateToolReason | null = child.toolMissing
    ? 'gate-tool-missing'
    : child.timedOut
      ? 'gate-timeout'
      : findings.length === 0 &&
          child.exitCode !== definition.expect.exitCode &&
          captured.trim() === ''
        ? 'gate-no-output'
        : null;

  const outcome: VerdictOutcome =
    reason !== null
      ? 'needs-human'
      : gateOutcome({
          gate: definition.id,
          exitCode: child.exitCode ?? -1,
          expectExitCode: definition.expect.exitCode,
          findings,
          severityFloor: definition.severityFloor,
        });

  // A gate that could not answer has no findings to report: whatever it printed
  // is about its own failure, and attaching it as evidence of the work being
  // wrong is the conflation this outcome exists to prevent.
  const reported = reason === null ? findings : [];

  return {
    gate: definition.id,
    outcome,
    reason,
    exitCode: child.exitCode,
    findings: reported,
    evidence,
    durationMs,
    survivors: child.survivors,
    verdict: sealVerdict({
      gate: definition.id,
      node: options.node,
      evaluatedNode: options.evaluatedNode,
      outcome,
      specHash: options.specHash,
      criteria: definition.satisfies,
      findings: reported,
      evidence: evidenceHandles,
      summary: summarise(definition, outcome, reason, reported),
    }),
  };
}

/** Where a run's artifacts live, for the reader who expects §8's path shape. */
export const runArtifactDir = (dataDir: string, sha256: string): string =>
  join(dataDir, 'blobs', sha256.slice(0, 2), sha256);
