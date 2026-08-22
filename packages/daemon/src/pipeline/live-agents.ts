/**
 * KAR-19.3 — the three pre-execution agent ports, over a real vendor process.
 *
 * `run-chain.ts` has taken a `FramingAgent`, a `ReconAgent` and a
 * `PlannerAgent` since it shipped, and every spec that drove it supplied
 * scripted ones. **Nothing in `src/` implemented one**, so `deflow up` had
 * nothing to hand `createRunChain` and an operator's run parked on its framing
 * wake — the 2026-08-12 failure this epic exists to remove. This file is the
 * missing implementation and nothing else: it spawns one child, hands it a
 * schema, and reads back one document.
 *
 * **The exec-shim path, not ACP, and the reason is the contract.** Every turn
 * here carries a `returns` contract, and `admitFraming` (KAR-10.2 AC3) admits a
 * schema-bearing turn only onto an adapter that can take a schema *file* —
 * which is a property of how the vendor's own CLI is invoked
 * (`structured-output.ts`), not of anything an ACP `initialize` advertises. So
 * the invocation is the shim's: `PROVIDER_SPECS`'s own `shim.argv` builder
 * assembles it, including the `structuredOutputFlag` and the path, and this
 * file assembles no argv of its own. A turn that lost the schema flag fails
 * here rather than passing by construction.
 *
 * **Two dialects, both real.** `document` is one JSON document on stdout — what
 * the bundled `deflow-mock-agent` writes, and what a machine with no vendor CLI
 * has. `stream-json` / `jsonl` carry the return inside a result line, which is
 * `@DeFlow/adapters`' own `parseShimLine` + `shimStructuredOutput` and is not
 * re-implemented here. Both branches are exercised against real binaries in
 * `test/integration/live-agents.test.ts`; a branch that ships unexercised is
 * this epic's own failure mode one level down.
 *
 * **A session is one process, and the file says so.** There is no live session
 * on this path: `steerable` is `false`, so `answerFramingQuestion` replays the
 * exchange into a fresh packet rather than steering, and `repair` opens a
 * second process with the repair prompt. Claiming a session DeFlow does not
 * hold would make the UI's *"the answer was sent into the live session"* a
 * sentence about something that never happened (docs/11 §7.5).
 *
 * **Nothing here reads a credential.** The child's environment is handed in,
 * built by `buildChildEnv()` (KAR-08.4) at the composition root, and this
 * module never reads `process.env`.
 *
 * Verifies: EPIC-19-S16 · KAR-19.3 AC1, AC2
 */
import {
  agentExited,
  argumentRefused,
  killTree,
  parseShimLine,
  providerSpec,
  rejectedArgument,
  shimStructuredOutput,
} from '@DeFlow/adapters';
import type { StructuredOutput } from '@DeFlow/core';
import { NodeFailureError } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FramingAgent, FramingSession, FramingTurn } from '../framing/interview.ts';
import { log } from '../logging.ts';
import type { PlannerAgent, PlannerRequest, PlannerTurn } from '../plan/compile.ts';
import type { ReconAgent, ReconTurn } from '../recon/recon.ts';

const agents = log.child({ mod: 'live-agent' });

/**
 * The most a pre-execution turn may write before DeFlow stops reading it.
 *
 * A `TaskSpec` draft, a survey and a `PlanGraph` are all small documents; a
 * child that writes 64 MiB of them is a child that has gone wrong, and holding
 * all of it in memory to find that out is how one bad turn takes the daemon
 * with it. The same reason `frameGuard` exists on the streaming path, at the
 * only granularity this path has.
 */
export const MAX_TURN_BYTES = 8 * 1024 * 1024;

/** The schema file for a registered document id, inside a run's own copy. */
export const schemaPathFor = (schemasDir: string, schemaId: string): string =>
  join(schemasDir, `${schemaId}.json`);

/**
 * KAR-19.11 AC1 — the emitted schema's own bytes.
 *
 * Claude Code 2.1.220 wants the **document** on `--json-schema`, not a path: it
 * `JSON.parse`s the value and, on 2026-08-13 at 19:59, exited 1 on
 * `Unrecognized token '/'` — the first character of the path DeFlow had sent
 * for every vendor from one line. `@DeFlow/adapters` performs no I/O, so the
 * read is here, and the file is still written under the run's
 * `.DeFlow/schemas/` either way: what the vendor is handed changes, what an
 * operator can read afterwards does not (NF8).
 *
 * An unreadable file is a typed refusal before a process exists, rather than a
 * turn that runs with no contract and fails validation afterwards.
 */
function readSchemaDocument(schemaPath: string, provider: string): string {
  try {
    return readFileSync(schemaPath, 'utf8');
  } catch (error) {
    throw new NodeFailureError(
      `the schema ${schemaPath} this turn is contracted to return could not be read ` +
        `(${(error as NodeJS.ErrnoException).code ?? 'unknown'}), so ${provider} cannot be told ` +
        'what to return',
      {
        reason: 'adapter.capability-missing',
        class: 'permanent',
        detail: { provider, schemaPath },
      },
    );
  }
}

/** Everything one turn's invocation depends on. */
export interface LiveTurnOptions {
  /** The registry id of the adapter this turn runs on. */
  readonly provider: string;
  /** Absolute, resolved against the operator's own `PATH` by the caller —
   * never looked up here, because DeFlowd's `PATH` is not theirs (§4.3). */
  readonly binaryPath: string;
  /** The directory the child is spawned in: the repository for framing and
   * the planner, the detached worktree for recon. */
  readonly cwd: string;
  /** The run's own `.DeFlow/schemas`, absolute. */
  readonly schemasDir: string;
  /**
   * KAR-19.13 — opens the vendor session for **this** child, and returns the id
   * it derived. Client-chosen, and echoed back by every vendor that takes one.
   *
   * A function rather than a value, and the difference is a wedged run.
   * `--session-id` *creates* a session and cannot attach to one, so a second
   * child presenting the first's id is refused outright — and on this path
   * `repair` and every re-advanced wake are second children. A string here
   * would be one id for the life of a `LiveTurnOptions`, which is exactly the
   * pin that produced `run_20260816T194933Z_839b9b`. The composition root's
   * implementation counts the turns the **ledger** already records and derives
   * from that, so a daemon restart does not start counting again.
   */
  openSession(): string;
  /** Built by `buildChildEnv()`. This module never reads `process.env`. */
  readonly env: Readonly<Record<string, string>>;
}

/** The document a turn is contracted to return. */
const DRAFT_SCHEMA_ID = 'DeFlow.taskspecdraft.v1';
const RECON_SURVEY_SCHEMA_ID = 'DeFlow.reconsurvey.v1';

interface ChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** The child's first bytes of stderr, for a failure that has to be readable in
 * the ledger three hours later. */
const excerpt = (text: string): string => text.trim().slice(0, 2000);

function spawnTurn(options: LiveTurnOptions, argv: readonly string[]): Promise<ChildResult> {
  return new Promise<ChildResult>((resolve, reject) => {
    const child = spawn(options.binaryPath, [...argv], {
      cwd: options.cwd,
      env: { ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Mandatory (docs/09 §9.3): the child leads its own process group, so a
      // wedged CLI and everything it spawned can be reached with one signal —
      // and so the negated-pid form `killTree` sends cannot reach DeFlowd's own
      // group.
      detached: true,
    });

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let aborted = false;

    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.byteLength;
      if (outBytes > MAX_TURN_BYTES) {
        if (!aborted) {
          aborted = true;
          // Through `killTree`, the one kill site (KAR-08.6 AC1): the child
          // leads its own group, and a positive-pid kill would leave whatever
          // it spawned running with `ppid` 1 while reporting success.
          if (child.pid !== undefined) killTree(child.pid, 'SIGKILL');
          reject(
            new NodeFailureError(
              `${options.provider} wrote more than ${String(MAX_TURN_BYTES)} bytes for one ` +
                'pre-execution turn, which is a child that has gone wrong rather than a large ' +
                'document; the turn was torn down',
              {
                reason: 'adapter.frame-too-large',
                class: 'permanent',
                detail: { provider: options.provider, bytes: outBytes },
              },
            ),
          );
        }
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));

    child.once('error', (error: Error) => {
      if (aborted) return;
      aborted = true;
      reject(
        new NodeFailureError(`${options.binaryPath} could not be spawned: ${error.message}`, {
          reason: 'adapter.spawn-failed',
          class: 'permanent',
          detail: { provider: options.provider, path: options.binaryPath },
        }),
      );
    });

    child.once('close', (code, signal) => {
      if (aborted) return;
      resolve({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

/**
 * The `structured_output` of one turn, whichever dialect carried it.
 *
 * An absent return is *not* `{ present: false }` invented here: it is what the
 * caller's handoff contract then refuses (`enforceHandoff`), and the presence
 * flag is the tagged answer that distinguishes "the agent returned nothing"
 * from "the agent returned an empty object" — the distinction that lets an
 * unserved turn be told from a served one.
 */
function readReturn(options: LiveTurnOptions, result: ChildResult): StructuredOutput {
  const spec = providerSpec(options.provider);
  if (spec === undefined) throw unregistered(options.provider);

  if (spec.shim.dialect === 'document') {
    const text = result.stdout.trim();
    if (text === '') return { present: false };
    try {
      return { present: true, value: JSON.parse(text) as unknown };
    } catch (error) {
      throw new NodeFailureError(
        `${options.provider} wrote ${String(result.stdout.length)} bytes that are not one JSON ` +
          `document: ${error instanceof Error ? error.message : String(error)}`,
        {
          reason: 'adapter.malformed-output',
          class: 'permanent',
          detail: { provider: options.provider },
        },
      );
    }
  }

  // The streaming dialects: the return rides on the result line, and reading it
  // is `@DeFlow/adapters`' own parser rather than a second one here.
  let found: StructuredOutput = { present: false };
  for (const line of result.stdout.split('\n')) {
    const parsed = parseShimLine(line);
    if (parsed === null) continue;
    const structured = shimStructuredOutput(parsed);
    if (structured.present) found = structured;
  }
  return found;
}

function unregistered(provider: string): NodeFailureError {
  return new NodeFailureError(
    `${provider} is not in PROVIDER_SPECS, so DeFlow does not know how to invoke it; a turn ` +
      'cannot be run on an adapter whose invocation nobody has written down',
    {
      reason: 'adapter.capability-missing',
      class: 'permanent',
      detail: { provider },
    },
  );
}

/**
 * One turn: spawn, wait, read the return.
 *
 * Every exit is a `NodeFailureError`, so a caller that lets it escape produces
 * a tagged failure in the ledger rather than a stack trace in a log line.
 */
export async function structuredTurn(
  options: LiveTurnOptions,
  request: { readonly prompt: string; readonly schemaPath: string },
): Promise<StructuredOutput> {
  const spec = providerSpec(options.provider);
  if (spec === undefined) throw unregistered(options.provider);

  // KAR-19.11 AC1 — read before the session is opened, so a missing schema
  // fails without having spent a turn's session id on a child that never ran.
  const schemaDocument = readSchemaDocument(request.schemaPath, options.provider);
  // KAR-19.13 — one session per child, not one per `LiveTurnOptions`. Opened
  // here rather than at the call site so `repair` and a re-advanced wake get
  // their own without either having to remember to ask.
  const sessionId = options.openSession();

  const argv = spec.shim.argv({
    resolved: { provider: spec.id, path: options.binaryPath },
    worktree: options.cwd,
    prompt: request.prompt,
    sessionId,
    // Every pre-execution turn is a `read` node (`RECON_PERMISSION`, and
    // framing and planning observe rather than edit). A level the vendor's own
    // flags cannot express is refused by the builder above, before a process
    // exists.
    permission: 'read',
    schemaPath: request.schemaPath,
    // KAR-19.11 AC1 — the document as well as the path, because the two vendors
    // disagree about which one their flag takes and the registry entry is what
    // decides. The file is written by `writeRunSchemas` before any turn runs, so
    // reading it above also fails *before* a process exists when it is missing,
    // rather than as an empty contract the child silently ignores.
    schemaDocument,
  });

  const result = await spawnTurn(options, argv);

  if (result.code !== 0) {
    // KAR-19.8 AC5, AC6 — before anything else: if the child refused an
    // argument *DeFlow* chose, that is what the operator needs to read, and it
    // is `permanent` rather than a retry every thirty seconds for ever.
    const rejected = rejectedArgument({ argv, stderr: result.stderr, spec });
    if (rejected !== null) {
      const refusal = argumentRefused({
        provider: options.provider,
        rejected,
        stderr: result.stderr,
        code: result.code,
        signal: result.signal,
      });
      agents.warn(
        { provider: options.provider, flag: rejected.flag, value: rejected.value },
        refusal.message,
      );
      throw refusal;
    }

    const failure = agentExited(result.code, result.signal);
    agents.warn(
      { provider: options.provider, code: result.code, signal: result.signal },
      `${options.provider} exited ${String(result.code ?? result.signal)} without completing the ` +
        `turn: ${excerpt(result.stderr)}`,
    );
    throw new NodeFailureError(
      `${options.provider} exited ${String(result.code ?? 'on a signal')} without completing the ` +
        `turn: ${excerpt(result.stderr)}`,
      {
        reason: failure.deflowFailure.reason,
        class: failure.deflowFailure.class,
        detail: {
          provider: options.provider,
          code: result.code,
          signal: result.signal,
          stderr: excerpt(result.stderr),
        },
      },
    );
  }

  return readReturn(options, result);
}

/**
 * A session over a path that holds none: every further turn is a new process,
 * and `steerable: false` is what makes the UI say so.
 *
 * KAR-19.13 AC3 — and a new process means a **new vendor session**. `repair`
 * re-enters `structuredTurn`, which opens its own, so the repaired turn's id
 * differs from the one the turn it is repairing spent. A repair is a
 * continuation in the *packet*, which is rebuilt from the ledger; it is not a
 * continuation in the vendor's session, because there is no session to
 * continue.
 */
function replayOnlySession(options: LiveTurnOptions, schemaPath: string): FramingSession {
  return {
    steerable: false,
    answer: () =>
      Promise.reject(
        new Error(
          `${options.provider} is driven through its CLI, which holds no session between turns; ` +
            'an answer is replayed into a fresh packet rather than steered (steerable is false, ' +
            'so nothing should have called this)',
        ),
      ),
    repair: (prompt: string) => structuredTurn(options, { prompt, schemaPath }),
  };
}

/** KAR-10.2's port, over a real process. */
export function liveFramingAgent(options: LiveTurnOptions): FramingAgent {
  const schemaPath = schemaPathFor(options.schemasDir, DRAFT_SCHEMA_ID);
  return {
    async open(prompt: string): Promise<{ session: FramingSession; turn: FramingTurn }> {
      const structuredOutput = await structuredTurn(options, { prompt, schemaPath });
      return {
        session: replayOnlySession(options, schemaPath),
        // A clarifying question is a *shape of return*, and no shipped adapter
        // has one on this path: a CLI turn either produces its document or it
        // does not. `null` is therefore the honest answer rather than a
        // limitation being hidden — the suspension path exists and is driven by
        // the interview, and an adapter that grows a question channel adds it
        // here rather than anywhere downstream.
        turn: { question: null, structuredOutput },
      };
    },
  };
}

/** KAR-10.5's port, over a real process. */
export function liveReconAgent(options: LiveTurnOptions): ReconAgent {
  const schemaPath = schemaPathFor(options.schemasDir, RECON_SURVEY_SCHEMA_ID);
  return {
    async open(prompt: string): Promise<{ session: FramingSession; turn: ReconTurn }> {
      const structuredOutput = await structuredTurn(options, { prompt, schemaPath });
      return { session: replayOnlySession(options, schemaPath), turn: { structuredOutput } };
    },
  };
}

/** KAR-11.1's port, over a real process. The schema path is the planner's own:
 * `compilePlanV1` names the emitted `DeFlow.plangraph.v1.json` it validates
 * against, and handing the child a different one would enforce a contract the
 * compiler does not read. */
export function livePlannerAgent(options: LiveTurnOptions): PlannerAgent {
  return {
    async plan(request: PlannerRequest): Promise<PlannerTurn> {
      const structuredOutput = await structuredTurn(options, {
        prompt: request.prompt,
        schemaPath: request.schemaPath,
      });
      return { structuredOutput };
    },
  };
}
