/**
 * The inputs the `--json` goldens were captured from (KAR-18.9 AC6).
 *
 * A golden is only worth what its input is worth. These are fixed, synthetic
 * and machine-independent on purpose: a golden captured from *this* machine's
 * doctor would encode a laptop's git version and a developer's `PATH`, and the
 * first CI run would rewrite it. What AC6 protects is the **document shape** —
 * the keys, their order, the nesting and the values a consumer branches on —
 * and that is a property of the renderer over a known report, not of the
 * machine the renderer ran on.
 *
 * They are shared between `../json-contract.test.ts` and the capture script
 * that wrote `__goldens__/`, so the golden and the assertion can never be
 * reading different fixtures.
 */
import type { Event, EventKind, RunId } from '@DeFlow/core';
import { EVENT_SCHEMAS, parseEvent, RunIdSchema } from '@DeFlow/core';
import type { DoctorSectionInput } from '../../../src/doctor/report.ts';
import type { DaemonStatus } from '../../../src/status.ts';

/** A run id with no entropy in it, so the golden is stable. */
export const GOLDEN_RUN: RunId = RunIdSchema.parse('run_20260810T101500Z_c4a5b1');

const TS = 1_754_812_800_000;

/**
 * One section per verdict, plus a check carrying `data` — because `data` is the
 * optional key, and an optional key is where a serializer drifts first.
 */
export const GOLDEN_DOCTOR_SECTIONS: readonly DoctorSectionInput[] = [
  {
    id: 'runtime',
    checks: [
      {
        id: 'runtime.node',
        status: 'ok',
        detail: 'Node 24.3.0 meets the >= 24 floor',
        data: { version: '24.3.0', major: 24 },
      },
      {
        id: 'runtime.pnpm',
        status: 'warn',
        detail:
          "pnpm is not on PATH. It is the development workflow's package manager; an installed " +
          'DeFlow runs without it.',
      },
    ],
  },
  {
    id: 'git',
    checks: [
      {
        id: 'git.version',
        status: 'fail',
        detail: 'git 2.30.0 is below the 2.38 floor',
        data: { version: '2.30.0' },
      },
    ],
  },
  {
    id: 'sandboxing',
    checks: [
      {
        id: 'sandboxing.levels',
        status: 'warn',
        detail: 'this platform can honour read',
        data: { honourable: ['read'] },
      },
    ],
  },
  {
    id: 'agents',
    checks: [{ id: 'agents.summary', status: 'ok', detail: '1 installed, 4 not installed' }],
  },
  {
    id: 'capabilities',
    checks: [{ id: 'capabilities.claude', status: 'ok', detail: 'ResumeBySessionId' }],
  },
  {
    id: 'conformance',
    checks: [
      { id: 'conformance.skipped', status: 'warn', detail: 'skipped — no adapter installed.' },
    ],
  },
  { id: 'auth', checks: [{ id: 'auth.shadowing', status: 'ok', detail: 'no shadowing variable' }] },
  { id: 'memory', checks: [{ id: 'memory.pty', status: 'ok', detail: 'node-pty loaded' }] },
];

/** A daemon nobody has to be running for the document to be exact. */
export const GOLDEN_STATUS: DaemonStatus = {
  kind: 'running',
  dataDir: '/tmp/DeFlow-golden/data',
  daemonFile: '/tmp/DeFlow-golden/data/daemon.json',
  pid: 4242,
  port: 7777,
  epoch: 3,
  startedAt: TS,
  uptimeMs: 65_000,
  runs: [
    {
      runId: GOLDEN_RUN,
      status: 'running',
      nodeCounts: { completed: 2, running: 1 },
    },
  ],
  ledgerError: null,
};

function event(kind: EventKind, payload: unknown, seq: number, nodeId?: string): Event {
  const parsed = parseEvent({
    seq,
    runId: GOLDEN_RUN,
    ts: TS,
    kind,
    v: EVENT_SCHEMAS[kind].v,
    epoch: 1,
    ...(nodeId === undefined ? {} : { nodeId }),
    payload,
  });
  if (parsed.status !== 'ok') {
    throw new Error(`golden fixture for ${kind} is not a valid event: ${JSON.stringify(parsed)}`);
  }
  return parsed.event;
}

/** The NDJSON golden's stream. Short, and one event of each framing shape. */
export const GOLDEN_STREAM: readonly Event[] = [
  event(
    'task.submitted',
    {
      sha256: 'a'.repeat(64),
      raw: 'add a health endpoint',
      provenance: { kind: 'text', by: 'cli', submittedAt: TS },
    },
    1,
  ),
  event(
    'node.scheduled',
    {
      node: 'impl',
      provider: 'claude',
      permission: 'worktree',
      worktree: `DeFlow/${GOLDEN_RUN}__impl`,
    },
    2,
    'impl',
  ),
  event('run.completed', { outcome: 'succeeded', criteriaSatisfied: [] }, 3),
];
