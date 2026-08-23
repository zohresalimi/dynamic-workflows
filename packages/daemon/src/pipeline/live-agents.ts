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
  connectorSettingsArgument,
  killTree,
  parseShimLine,
  providerSpec,
  rejectedArgument,
  shimResultFailure,
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

/**
 * What `openSession` answers: the vendor id for this child, and the attempt it
 * was the *n*th of.
 *
 * A pair rather than the bare id, because the number is what addresses the
 * turn's io (AC2) and the caller that opened the session is the only one that
 * can state it without counting the row it has just written.
 */
export interface OpenedSession {
  readonly id: string;
  /** 0-based, as the event envelope counts sessions. */
  readonly attempt: number;
}

/**
 * KAR-27.3 AC2 — where one child's bytes go as they arrive.
 *
 * Synchronous and fire-and-forget: `spawnTurn`'s `data` handler is on the hot
 * path of a stream the child is filling, and a port that returned a promise
 * would put a queue of unresolved writes between DeFlow and the runaway guard.
 * The implementation is one `INSERT` (`./pre-execution-session.ts`).
 */
export interface TurnIoWriter {
  append(stream: 'stdout' | 'stderr', data: Uint8Array): void;
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
  openSession(): OpenedSession;
  /**
   * KAR-27.3 AC2 — opens the io sink for **this** child, addressed by the
   * attempt `openSession` just returned.
   *
   * Optional, and the optionality is a claim rather than convenience: a turn
   * driven without a ledger (the unit specs over the mock agent) has nowhere to
   * put bytes, and a required port would have made every one of them build a
   * fake store to exercise a path they are not about. A turn with no sink runs
   * exactly as it did before this story — it just leaves no transcript behind.
   */
  readonly openIo?: ((attempt: number) => TurnIoWriter) | undefined;
  /** Built by `buildChildEnv()`. This module never reads `process.env`. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The connected MCP servers the vendor CLI on this machine has, by display
   * name — discovered once per daemon life (`connector-servers.ts`) and
   * carried here so every pre-execution turn grants the read verbs on them.
   * Absent or empty means no `permissions` document is emitted and every
   * connector call is denied by the vendor's own headless default — which on
   * 2026-08-23 was recorded in a spec as *"Operator declined the Linear
   * list_issues call"* when no operator had been asked anything, and framed a
   * story Linear had already marked Done.
   */
  readonly connectorServers?: readonly string[];
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

/**
 * KAR-27.3 AC5 — the child's **last** bytes of stdout.
 *
 * The other end from `excerpt`, and deliberately: a stream-json turn's first
 * bytes are its `system/init` line, which says nothing about why it died, while
 * the result envelope that does is the last thing written. A head excerpt of
 * stdout would have been the same silence in a longer form.
 */
const tailExcerpt = (text: string): string => text.trim().slice(-2000);

/**
 * The failure the child stated in its own result frame, or `null` when it
 * stated none this build can read.
 *
 * `parseShimLine` throws on a line that is not JSON, and this is a diagnosis
 * path: a child that died mid-frame must not turn a readable failure into an
 * unreadable one, so a line that will not parse is passed over rather than
 * raised. The last statement wins, because a turn that reported twice reported
 * last about how it ended.
 */
function statedCause(stdout: string): NodeFailureError | null {
  let found: NodeFailureError | null = null;
  for (const line of stdout.split('\n')) {
    try {
      const parsed = parseShimLine(line);
      if (parsed === null) continue;
      found = shimResultFailure(parsed) ?? found;
    } catch {
      // Not a frame. The tail excerpt still carries it verbatim.
    }
  }
  return found;
}

/**
 * KAR-27.3 AC2 — a writer that gives up quietly rather than taking the turn
 * down with it.
 *
 * Liveness narrates a turn; it does not get a vote on whether the turn runs. A
 * full disk or a locked ledger has to cost the operator a transcript, never the
 * eight minutes of interrogation the transcript was describing — so the first
 * throw is logged once and persistence stops for the rest of the child's life.
 * Logged *once* because the alternative, on a stream producing a chunk every
 * few milliseconds, is a log file that fills the disk that was already full.
 */
function forgivingly(writer: TurnIoWriter | undefined, provider: string): TurnIoWriter | null {
  if (writer === undefined) return null;
  let broken = false;
  return {
    append: (stream, data) => {
      if (broken) return;
      try {
        writer.append(stream, data);
      } catch (error) {
        broken = true;
        agents.warn(
          { provider, stream, err: error },
          'the io store refused a chunk of this turn; the turn continues without a transcript',
        );
      }
    },
  };
}

function spawnTurn(
  options: LiveTurnOptions,
  argv: readonly string[],
  io?: TurnIoWriter,
): Promise<ChildResult> {
  const writer = forgivingly(io, options.provider);
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
      // AC2 — persisted at exactly the point it is buffered, and not before.
      // The chunk that trips the guard above is neither buffered nor stored, so
      // the transcript at exit is byte-for-byte what the buffer captured; what
      // the child wrote *before* it went wrong stays as evidence of the
      // runaway.
      writer?.append('stdout', chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      err.push(chunk);
      writer?.append('stderr', chunk);
    });

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
  const session = options.openSession();

  const argv = spec.shim.argv({
    resolved: { provider: spec.id, path: options.binaryPath },
    worktree: options.cwd,
    prompt: request.prompt,
    sessionId: session.id,
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

  // The connector rules for a read turn, on the same flag the sandbox document
  // rides for execution nodes — but never both: pre-execution turns have no
  // sandbox document, so this is the invocation's one settings argument.
  const connector = connectorSettingsArgument(spec, 'read', options.connectorServers ?? []);
  const spawned = [...argv, ...connector];

  // AC2 — the sink is opened on the attempt this child's session is, so a
  // repair's transcript sits beside the turn it repaired rather than on top of
  // it.
  const result = await spawnTurn(options, spawned, options.openIo?.(session.attempt));

  if (result.code !== 0) {
    // KAR-19.8 AC5, AC6 — before anything else: if the child refused an
    // argument *DeFlow* chose, that is what the operator needs to read, and it
    // is `permanent` rather than a retry every thirty seconds for ever.
    const rejected = rejectedArgument({ argv: spawned, stderr: result.stderr, spec });
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

    // KAR-27.3 AC5 — the child said nothing on stderr. On 2026-08-23 that is
    // exactly how a rate-limited turn died: `stderr: ""` in the ledger, and the
    // operator-readable cause only in the vendor's own transcript file. It was
    // on stdout the whole time, in the turn's own result frame.
    const stated = statedCause(result.stdout);
    if (stated !== null && excerpt(result.stderr) === '') {
      const cause = new NodeFailureError(
        `${options.provider} exited ${String(result.code ?? 'on a signal')} and said why on ` +
          `stdout rather than stderr: ${stated.message}`,
        {
          reason: stated.deflowFailure.reason,
          class: stated.deflowFailure.class,
          detail: {
            ...stated.deflowFailure.detail,
            provider: options.provider,
            code: result.code,
            signal: result.signal,
            stderr: '',
            stdoutTail: tailExcerpt(result.stdout),
          },
        },
      );
      agents.warn(
        { provider: options.provider, code: result.code, signal: result.signal },
        cause.message,
      );
      throw cause;
    }

    const failure = agentExited(result.code, result.signal);
    // With nothing on stderr the excerpt was the empty string, and *"exited 1
    // without completing the turn: "* is a ledger message that tells its reader
    // to go and find the real one somewhere else.
    const said =
      excerpt(result.stderr) === '' ? tailExcerpt(result.stdout) : excerpt(result.stderr);
    agents.warn(
      { provider: options.provider, code: result.code, signal: result.signal },
      `${options.provider} exited ${String(result.code ?? result.signal)} without completing the ` +
        `turn: ${said}`,
    );
    throw new NodeFailureError(
      `${options.provider} exited ${String(result.code ?? 'on a signal')} without completing the ` +
        `turn: ${said}`,
      {
        reason: failure.deflowFailure.reason,
        class: failure.deflowFailure.class,
        detail: {
          provider: options.provider,
          code: result.code,
          signal: result.signal,
          // Never removed, whatever else is added: an empty `stderr` is itself
          // a fact about the child, and a reader who knows it was empty knows
          // not to go looking for it.
          stderr: excerpt(result.stderr),
          ...(excerpt(result.stderr) === '' ? { stdoutTail: tailExcerpt(result.stdout) } : {}),
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
