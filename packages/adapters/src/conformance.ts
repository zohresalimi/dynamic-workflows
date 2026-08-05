/**
 * KAR-05.7 Layer B — the behavioural contract, parameterised over adapters
 * (docs/07-provider-adapter-layer.md §11.3).
 *
 * **There is no official ACP conformance kit** (verified negative, 2026-08-02;
 * see ./recorder.ts and `packages/testkit/src/acp-conformance.ts` for the
 * evidence). Layer A holds the wire shape against `schema.json`. This layer
 * holds the *behaviour*: eight assertions that an adapter either honours or
 * does not, run against the mock's six capability profiles on every commit and
 * against a real, installed CLI only behind an `@live` tag.
 *
 * Three decisions shape the module.
 *
 * **It knows nothing about vitest.** The engine returns a report; a caller
 * turns that report into `it`s (see
 * `test/integration/support/provider-contract.ts`) or prints it. `DeFlow
 * doctor` (EPIC-18, KAR-18.4) is the other caller — running this against the
 * versions actually installed on a user's machine is the whole reason the
 * assertions are data rather than test bodies.
 *
 * **A skip is a result, not an absence.** A capability-dependent assertion
 * that quietly does not run is indistinguishable from one that passed, which
 * is how you end up believing five adapters are covered when three are. So
 * every skip carries the reason that produced it — `capability-absent:
 * session.list` — and the report counts it separately.
 *
 * **Capability honesty is checked per capability.** Assertion 6 as tabulated
 * is "call a method the agent did not advertise and assert `-32601`", and its
 * mirror is the one that actually catches a lying manifest: *call every method
 * the agent did advertise and assert it is not `-32601`.* That row is the
 * single input the entire routing layer trusts, so its failure message names
 * the capability and the method rather than merely the code.
 */
import type { Clock, Handle, NodeId, ProviderId, RunId } from '@DeFlow/core';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import * as acp from '@agentclientprotocol/sdk';
import { type CapabilityKey, type CapabilityRow, capability } from './capabilities.ts';
import { CLIENT_CAPABILITIES, CLIENT_INFO } from './client-capabilities.ts';
import { ACP_PROTOCOL_VERSION } from './failures.ts';
import { killTree } from './kill-tree.ts';
import type { AgentBinary, EventRecord, LedgerSink } from './ports.ts';
import { runAcpNode } from './run-node.ts';
import { agentTransport } from './transport.ts';

/** One staged scenario. Adding an adapter means answering these six. */
export const CONFORMANCE_CASES = [
  'turn',
  'cancel',
  'permission',
  'capability-honesty',
  'malformed-line',
  'oversized-frame',
] as const;

export type ConformanceCase = (typeof CONFORMANCE_CASES)[number];

/** How to invoke the adapter for one case. */
export interface ConformanceTarget {
  readonly kind: 'target';
  readonly binary: AgentBinary;
  readonly argv?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/** Why this adapter cannot stage the case at all — reported as a skip. */
export interface ConformanceUnavailable {
  readonly kind: 'unavailable';
  readonly reason: string;
}

export type ConformanceStage = ConformanceTarget | ConformanceUnavailable;

export interface ConformanceAdapter {
  /** What the report calls it: `mock-agent:gemini`, `claude-agent-acp@0.64.1`. */
  readonly name: string;
  /**
   * What this adapter advertised, as the probe stored it — the row every
   * capability-dependent skip is decided from. `null` means nothing has been
   * probed, and every such assertion skips rather than guessing.
   */
  readonly capabilityRow: CapabilityRow | null;
  stage(kase: ConformanceCase): ConformanceStage;
}

/** AC3 — one call site per adapter, and this is what it hands over. */
export type AdapterFactory = () => ConformanceAdapter | Promise<ConformanceAdapter>;

export interface ConformancePorts {
  readonly clock: Clock;
  readonly ledger: LedgerSink;
  readonly captureEvidence: (evidence: string | Uint8Array) => Handle;
  /** A fresh, empty directory for one case. */
  readonly worktree: (kase: ConformanceCase) => Promise<string>;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly provider: ProviderId;
  /**
   * Live, non-zombie members of a process group — assertion 8's evidence that
   * `killTree()` ran. Absent reports that half of the assertion as skipped
   * rather than passing it on faith.
   */
  readonly liveInGroup?: (pgid: number) => readonly string[];
}

export type ConformanceStatus = 'passed' | 'failed' | 'skipped';

export interface ConformanceResult {
  /** 1–8, as tabulated in §11.3. */
  readonly assertion: number;
  readonly name: string;
  /** The capability or method a per-subject result is about. */
  readonly subject?: string;
  readonly status: ConformanceStatus;
  /** Why it failed, or — for a skip — the reason it did not run. */
  readonly detail: string;
}

export interface ConformanceReport {
  readonly adapter: string;
  readonly results: readonly ConformanceResult[];
  readonly passed: boolean;
}

/**
 * The routing-relevant capabilities and the method each one promises, which is
 * the pairing assertion 6 checks in both directions.
 *
 * `additionalDirectories` maps to `session/new` rather than a method of its
 * own: it is a modifier on session creation, and `session/new` is the request
 * whose params it qualifies.
 */
export const HONESTY_METHODS: Readonly<Record<string, { key: CapabilityKey; method: string }>> = {
  'session.resume': { key: 'resume', method: 'session/resume' },
  'session.fork': { key: 'fork', method: 'session/fork' },
  'session.list': { key: 'list', method: 'session/list' },
  'session.delete': { key: 'delete', method: 'session/delete' },
  additionalDirectories: { key: 'additionalDirectories', method: 'session/new' },
};

/**
 * A method name no agent can legitimately claim, for the half of assertion 6
 * that is stated positively in the table.
 *
 * Deliberately not underscore-prefixed: `_vendor/thing` is the extension
 * namespace ACP reserves, and an agent is entitled to answer one.
 */
export const UNADVERTISED_METHOD = 'deflow/conformance-probe';

export const METHOD_NOT_FOUND = -32601;

/** The frame cap assertion 8 runs under — small enough to trip on one line. */
export const CONFORMANCE_FRAME_CAP_BYTES = 64 * 1024;

const jsonRpcCode = (error: unknown): number | null => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : null;
};

interface MethodAnswer {
  /** Whether the agent answered at all, as opposed to refusing the method. */
  readonly answered: boolean;
  readonly code: number | null;
  readonly message: string;
}

interface Interrogation {
  readonly answers: ReadonlyMap<string, MethodAnswer>;
  readonly protocolVersion: unknown;
}

/**
 * One connection, several raw requests, no pull loop.
 *
 * `runAcpNode` cannot serve assertion 6 — it drives a *turn*, and the question
 * here is what happens when DeFlow asks for a method that is not part of one.
 * So this is the only place in the package that opens a connection by hand,
 * and it opens it the same way: the same transport, the same handshake, the
 * same client capabilities.
 */
async function interrogate(
  target: ConformanceTarget,
  cwd: string,
  methods: readonly { readonly name: string; readonly params: (sessionId: string) => unknown }[],
): Promise<Interrogation> {
  const child: ChildProcessWithoutNullStreams = spawn(
    target.binary.path,
    [...(target.argv ?? [])],
    {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      ...(target.env === undefined ? {} : { env: target.env }),
    },
  );
  const pgid = child.pid ?? 0;
  const exited = new Promise<void>((resolve) => {
    child.once('exit', () => resolve());
  });
  // Nothing reads stderr on this path, and a full 64 KiB pipe would wedge an
  // agent that logs.
  child.stderr.resume();

  const transport = agentTransport(child);
  const answers = new Map<string, MethodAnswer>();
  let protocolVersion: unknown = null;

  try {
    await Promise.race([
      transport.failed,
      acp.client({ name: CLIENT_INFO.name }).connectWith(transport.stream, async (ctx) => {
        const initialized = await ctx.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: CLIENT_CAPABILITIES,
          clientInfo: { ...CLIENT_INFO },
        });
        protocolVersion = initialized.protocolVersion;

        // `session/new` runs first because it is both one of the methods under
        // test and the source of the session id the others need. An agent that
        // refuses it still gets asked everything else — with a placeholder id,
        // because "refuses session/new" and "refuses session/resume" are two
        // different findings and collapsing them loses one.
        let sessionId = 'deflow-conformance-no-session';
        try {
          const created = await ctx.request('session/new', { cwd, mcpServers: [] });
          sessionId = created.sessionId;
          answers.set('session/new', { answered: true, code: null, message: '' });
        } catch (error) {
          answers.set('session/new', {
            answered: false,
            code: jsonRpcCode(error),
            message: error instanceof Error ? error.message : String(error),
          });
        }

        for (const method of methods) {
          if (answers.has(method.name)) continue;
          try {
            await ctx.request(method.name as never, method.params(sessionId) as never);
            answers.set(method.name, { answered: true, code: null, message: '' });
          } catch (error) {
            answers.set(method.name, {
              answered: false,
              code: jsonRpcCode(error),
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }),
    ]);
  } finally {
    child.stdin.end();
    // The same abstraction every other exit in this package goes through: an
    // interrogation that left the agent running would leak one process per
    // profile per run.
    if (pgid > 1) {
      try {
        killTree(pgid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    await exited;
  }

  return { answers, protocolVersion };
}

/** The result list for one case an adapter cannot stage. */
function unavailable(
  assertions: readonly { readonly assertion: number; readonly name: string }[],
  reason: string,
): ConformanceResult[] {
  return assertions.map((entry) => ({ ...entry, status: 'skipped' as const, detail: reason }));
}

const ASSERTIONS: Readonly<Record<number, string>> = {
  1: 'initialize returns protocolVersion === 1',
  2: 'session/new returns a sessionId',
  3: 'a trivial prompt yields >=1 agent_message_chunk then stopReason end_turn',
  4: 'session/cancel mid-turn yields stopReason cancelled, late updates tolerated',
  5: "a permission request round-trips and a client cancel gives outcome 'cancelled'",
  6: 'capability honesty: advertised methods answer, unadvertised ones give -32601',
  7: 'a malformed JSON line produces a structured adapter error and no crash',
  8: 'an oversized frame produces FrameTooLarge, killTree() runs, and no OOM',
};

const named = (assertion: number): { assertion: number; name: string } => ({
  assertion,
  name: ASSERTIONS[assertion] ?? '',
});

/** A sink that counts what was appended, so "the tail arrived" is observable. */
function countingSink(sink: LedgerSink, onEvent: (event: EventRecord) => void): LedgerSink {
  return {
    async append(event) {
      const seq = await sink.append(event);
      onEvent(event);
      return seq;
    },
    appendIo: (chunk) => sink.appendIo(chunk),
  };
}

const phaseOf = (event: EventRecord): string =>
  (event.payload as { phase?: string } | null)?.phase ?? event.kind;

/**
 * The whole battery, against one adapter.
 *
 * Runs the cases in order and never stops at the first failure: a report that
 * halted would tell you one thing about an adapter when the question is what
 * it can be trusted with.
 */
export async function runProviderConformance(
  factory: AdapterFactory,
  ports: ConformancePorts,
): Promise<ConformanceReport> {
  const adapter = await factory();
  const results: ConformanceResult[] = [];
  const record = (
    assertion: number,
    status: ConformanceStatus,
    detail: string,
    subject?: string,
  ): void => {
    results.push({
      ...named(assertion),
      ...(subject === undefined ? {} : { subject }),
      status,
      detail,
    });
  };

  const base = (kase: ConformanceCase, worktree: string, target: ConformanceTarget) => ({
    runId: ports.runId,
    nodeId: ports.nodeId,
    attempt: 0,
    provider: ports.provider,
    permission: 'worktree' as const,
    worktree,
    binary: target.binary,
    ...(target.argv === undefined ? {} : { argv: target.argv }),
    ...(target.env === undefined ? {} : { env: target.env }),
    mcpServers: [],
    prompt: `conformance: ${kase}`,
  });

  // ── assertions 1, 2, 3 — one trivial turn ──────────────────────────────
  {
    const stage = adapter.stage('turn');
    if (stage.kind === 'unavailable') {
      results.push(...unavailable([named(1), named(2), named(3)], stage.reason));
    } else {
      const worktree = await ports.worktree('turn');
      const outcome = await runAcpNode(base('turn', worktree, stage), {
        clock: ports.clock,
        ledger: ports.ledger,
        captureEvidence: ports.captureEvidence,
      });

      record(
        1,
        outcome.protocolVersion === ACP_PROTOCOL_VERSION ? 'passed' : 'failed',
        `initialize answered protocolVersion ${JSON.stringify(outcome.protocolVersion)}`,
      );
      record(
        2,
        typeof outcome.sessionId === 'string' && outcome.sessionId !== '' ? 'passed' : 'failed',
        `session/new answered sessionId ${JSON.stringify(outcome.sessionId)}`,
      );
      if (outcome.status !== 'completed') {
        record(
          3,
          'failed',
          `the turn ended ${outcome.status}${outcome.status === 'failed' ? `: ${outcome.failure.message}` : ''}`,
        );
      } else {
        const output = outcome.result.output as { text?: string; textHandle?: string };
        const text = output.text ?? '';
        const streamed = text.length > 0 || output.textHandle !== undefined;
        record(
          3,
          streamed && outcome.stopReason === 'end_turn' ? 'passed' : 'failed',
          `stopReason ${outcome.stopReason}, ${text.length} characters of agent_message_chunk text`,
        );
      }
    }
  }

  // ── assertion 4 — cancel mid-turn, and the tail that follows it ────────
  {
    const stage = adapter.stage('cancel');
    if (stage.kind === 'unavailable') {
      results.push(...unavailable([named(4)], stage.reason));
    } else {
      const worktree = await ports.worktree('cancel');
      const controller = new AbortController();
      let aborted = false;
      let chunks = 0;
      let afterCancel = 0;
      const sink = countingSink(ports.ledger, (event) => {
        if (phaseOf(event) === 'agent_message_chunk') {
          chunks += 1;
          if (aborted) afterCancel += 1;
          // One chunk in, the agent is mid-turn. Any later is the same
          // measurement made slower.
          if (chunks === 1 && !aborted) {
            aborted = true;
            controller.abort();
          }
        }
      });

      const outcome = await runAcpNode(base('cancel', worktree, stage), {
        clock: ports.clock,
        ledger: sink,
        captureEvidence: ports.captureEvidence,
        signal: controller.signal,
      });

      const cancelled = outcome.status === 'cancelled' && outcome.stopReason === 'cancelled';
      record(
        4,
        cancelled && afterCancel > 0 ? 'passed' : 'failed',
        cancelled
          ? `${afterCancel} session/update notifications were accepted after session/cancel`
          : `the turn ended ${outcome.status} rather than cancelled`,
      );
    }
  }

  // ── assertion 5 — a permission round trip, cancelled by the client ─────
  {
    const stage = adapter.stage('permission');
    if (stage.kind === 'unavailable') {
      results.push(...unavailable([named(5)], stage.reason));
    } else {
      const worktree = await ports.worktree('permission');
      const asked: unknown[] = [];
      const outcome = await runAcpNode(base('permission', worktree, stage), {
        clock: ports.clock,
        ledger: ports.ledger,
        captureEvidence: ports.captureEvidence,
        handlers: {
          // `RequestPermissionOutcome` has a `{ outcome: 'cancelled' }` variant
          // with no `optionId`, and an agent that destructures `optionId`
          // unconditionally wedges the node. That variant is the assertion.
          'session/request_permission': (params: never) => {
            asked.push(params);
            return { outcome: { outcome: 'cancelled' } };
          },
        },
      });

      const ended =
        outcome.status === 'cancelled'
          ? 'cancelled'
          : outcome.status === 'completed'
            ? outcome.stopReason
            : 'failed';
      record(
        5,
        asked.length > 0 && outcome.status !== 'failed' ? 'passed' : 'failed',
        `${asked.length} permission request(s) round-tripped; the turn then ended ${ended}`,
      );
    }
  }

  // ── assertion 6 — capability honesty, in both directions ───────────────
  {
    const stage = adapter.stage('capability-honesty');
    if (stage.kind === 'unavailable') {
      results.push(...unavailable([named(6)], stage.reason));
    } else {
      const worktree = await ports.worktree('capability-honesty');
      const { answers } = await interrogate(stage, worktree, [
        { name: UNADVERTISED_METHOD, params: () => ({}) },
        { name: 'session/resume', params: (sessionId) => ({ sessionId, cwd: worktree }) },
        { name: 'session/fork', params: (sessionId) => ({ sessionId, cwd: worktree }) },
        { name: 'session/list', params: () => ({}) },
        { name: 'session/delete', params: (sessionId) => ({ sessionId }) },
      ]);

      const probe = answers.get(UNADVERTISED_METHOD);
      record(
        6,
        probe?.code === METHOD_NOT_FOUND ? 'passed' : 'failed',
        `${UNADVERTISED_METHOD} answered ${probe?.answered === true ? 'successfully' : `code ${probe?.code ?? 'nothing'}`}, expected ${METHOD_NOT_FOUND}`,
        UNADVERTISED_METHOD,
      );

      const row = adapter.capabilityRow;
      for (const [name, { key, method }] of Object.entries(HONESTY_METHODS)) {
        if (row === null) {
          record(6, 'skipped', 'no capability row has been probed for this adapter', name);
          continue;
        }
        const answer = capability(row, key);
        if (answer.supported !== true) {
          // Explicit, and reported — a capability-dependent assertion that
          // silently does not run is indistinguishable from one that passed.
          record(6, 'skipped', `${answer.reason}: ${name}`, name);
          continue;
        }
        const observed = answers.get(method);
        record(
          6,
          observed?.code === METHOD_NOT_FOUND ? 'failed' : 'passed',
          observed?.code === METHOD_NOT_FOUND
            ? `advertised the capability "${name}" (${answer.path}) but answered ${method} with ` +
                `JSON-RPC ${METHOD_NOT_FOUND} ${observed.message}`
            : `advertised "${name}" and answered ${method}`,
          name,
        );
      }
    }
  }

  // ── assertion 7 — a malformed line is a structured failure ─────────────
  {
    const stage = adapter.stage('malformed-line');
    if (stage.kind === 'unavailable') {
      results.push(...unavailable([named(7)], stage.reason));
    } else {
      const worktree = await ports.worktree('malformed-line');
      const outcome = await runAcpNode(base('malformed-line', worktree, stage), {
        clock: ports.clock,
        ledger: ports.ledger,
        captureEvidence: ports.captureEvidence,
      });

      const structured =
        outcome.status === 'failed' &&
        outcome.failure.reason.startsWith('adapter.') &&
        outcome.failure.message !== '' &&
        outcome.exit !== null;
      record(
        7,
        structured ? 'passed' : 'failed',
        outcome.status === 'failed'
          ? `${outcome.failure.reason} (${outcome.failure.class}), agent exited with ` +
              `${JSON.stringify(outcome.exit)}`
          : `the turn ended ${outcome.status}; a malformed line has to be a failure, not a result`,
      );
    }
  }

  // ── assertion 8 — an oversized frame, and the group that follows it ────
  {
    const stage = adapter.stage('oversized-frame');
    if (stage.kind === 'unavailable') {
      results.push(...unavailable([named(8)], stage.reason));
    } else {
      const worktree = await ports.worktree('oversized-frame');
      const outcome = await runAcpNode(base('oversized-frame', worktree, stage), {
        clock: ports.clock,
        ledger: ports.ledger,
        captureEvidence: ports.captureEvidence,
        maxFrameBytes: CONFORMANCE_FRAME_CAP_BYTES,
      });

      const tripped =
        outcome.status === 'failed' && outcome.failure.reason === 'adapter.frame-too-large';
      const live = ports.liveInGroup?.(outcome.pgid) ?? [];
      record(
        8,
        tripped && live.length === 0 ? 'passed' : 'failed',
        tripped
          ? `frame cap tripped at ${CONFORMANCE_FRAME_CAP_BYTES} bytes; ${live.length} process(es) left in the group`
          : `the turn ended ${outcome.status === 'failed' ? outcome.failure.reason : outcome.status}`,
      );
    }
  }

  return {
    adapter: adapter.name,
    results,
    passed: results.every((result) => result.status !== 'failed'),
  };
}

/** The report as a human reads it — one line per assertion, skips included. */
export function describeConformance(report: ConformanceReport): string {
  return report.results
    .map(
      (result) =>
        `${result.status.toUpperCase().padEnd(7)} #${result.assertion}` +
        `${result.subject === undefined ? '' : ` [${result.subject}]`} ${result.name} — ${result.detail}`,
    )
    .join('\n');
}
