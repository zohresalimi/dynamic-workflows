/**
 * KAR-12.2 AC1, AC2, AC4 — the ACP half of independent review, against a real
 * mock agent and a real recorded transport log.
 *
 * The ACP path learns the session id later than the shim path does: it arrives
 * in the `session/new` response, so the check cannot run before spawn and must
 * run between that response and the first `session/prompt`. That ordering is
 * the whole claim, and the only honest way to assert it is on frames that
 * actually crossed the pipe — the recorded transport log names every method,
 * and *"zero `session/prompt` frames"* is a statement about it rather than
 * about a flag DeFlow set for itself.
 *
 * The session id is journaled to `node.started` **as its own event, the
 * instant it arrives**, which is [05 §8.3](../../../../docs/05-durable-execution.md)'s
 * rule about never buffering one. Here it does double duty: a buffered session
 * id is lost in exactly the crash where it was needed, and it is also what
 * makes independence auditable after the fact (AC1).
 *
 * Verifies: EPIC-12-S12, EPIC-12-S17 · AC1, AC2, AC4 · test plan #7
 */
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type AcpNodeRequest,
  RECORD_CASE_ENV,
  RECORD_DIR_ENV,
  RECORD_ENV,
  runAcpNode,
} from '../../src/index.ts';
import {
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  scenario,
  type TestLedger,
} from './support/harness.ts';

let dir = '';
let worktree = '';
let corpus = '';
let ledger: TestLedger;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  corpus = join(dir, 'recordings');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

const PRODUCER = 'implement-1';

interface Line {
  readonly msg?: { readonly method?: string };
  readonly header?: Record<string, unknown>;
}

/** Every method name that crossed the pipe, in order. */
const methodsOf = (kase: string): string[] =>
  readFileSync(join(corpus, `${PROVIDER}@0.0.0`, `${kase}.ndjson`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Line)
    .flatMap((line) => (line.msg?.method === undefined ? [] : [line.msg.method]));

function request(review: AcpNodeRequest['review']): AcpNodeRequest {
  return {
    runId: RUN_ID,
    nodeId: NODE_ID,
    attempt: 0,
    provider: PROVIDER,
    permission: 'worktree',
    worktree,
    binary: mockAgentBinary(),
    argv: ['--seed', '42', '--scenario', scenario('minimal-turn.jsonc')],
    mcpServers: [],
    prompt: 'judge the diff against the pinned criteria',
    ...(review === undefined ? {} : { review }),
  };
}

const recordEnv = (kase: string): NodeJS.ProcessEnv => ({
  ...process.env,
  [RECORD_ENV]: '1',
  [RECORD_DIR_ENV]: corpus,
  [RECORD_CASE_ENV]: kase,
});

const run = async (review: AcpNodeRequest['review'], kase: string) =>
  runAcpNode(request(review), {
    clock: new TestClock(),
    ledger: ledger.sink,
    captureEvidence: ledger.captureEvidence,
    record: recordEnv(kase),
  });

/** Every `node.started` payload the run appended, in order. */
const startedPayloads = (): { session?: { id: string; origin: string } }[] =>
  ledger
    .events()
    .filter((event) => event.kind === 'node.started')
    .map((event) => event.payload as { session?: { id: string; origin: string } });

suite('the id arrives from session/new and is journaled at once (AC1 · EPIC-12-S17)', () => {
  it('appends a second node.started carrying the resolved session', async () => {
    const outcome = await run(
      { producers: [{ id: PRODUCER, resolvedSessionId: 'a-session-nobody-else-holds' }] },
      'review-ok',
    );

    expect(outcome.status).toBe('completed');
    const payloads = startedPayloads();
    // The first is the handshake's, written before a session exists; the second
    // is the session id, its own event rather than a field patched onto the
    // first, because the ledger is append-only and the id arrived later.
    expect(payloads[0]?.session).toBeUndefined();
    expect(payloads[1]?.session?.origin).toBe('session/new');
    expect(payloads[1]?.session?.id).toBe(outcome.sessionId);
    expect(typeof outcome.sessionId).toBe('string');
  });

  it('journals it before any session/prompt frame is sent', async () => {
    await run(
      { producers: [{ id: PRODUCER, resolvedSessionId: 'a-session-nobody-else-holds' }] },
      'review-ok',
    );

    const kinds = ledger.events().map((event) => event.kind);
    const journaled = kinds.lastIndexOf('node.started');
    const firstProgress = kinds.indexOf('node.progress');
    expect(journaled).toBeGreaterThanOrEqual(0);
    expect(journaled).toBeLessThan(firstProgress);

    const methods = methodsOf('review-ok');
    expect(methods).toContain('session/new');
    expect(methods).toContain('session/prompt');
    expect(methods.indexOf('session/new')).toBeLessThan(methods.indexOf('session/prompt'));
  });
});

suite('a shared session is refused after session/new, before the prompt (AC2, AC4)', () => {
  it('fails the node with the refusal code', async () => {
    // The producer is declared to hold whatever session the agent hands back,
    // which is what a hand-patched plan produces.
    const first = await run(
      { producers: [{ id: PRODUCER, resolvedSessionId: 'a-session-nobody-else-holds' }] },
      'probe',
    );
    const agentSession = first.sessionId;
    expect(agentSession).not.toBeNull();

    ledger.close();
    ledger = openTestLedger(dir);

    const outcome = await run(
      { producers: [{ id: PRODUCER, resolvedSessionId: agentSession as string }] },
      'review-refused',
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.detail?.code).toBe('REVIEW_SESSION_NOT_INDEPENDENT');
    expect(outcome.failure.class).toBe('gate');
  });

  it('sends zero session/prompt frames for that node', async () => {
    const probe = await run(
      { producers: [{ id: PRODUCER, resolvedSessionId: 'a-session-nobody-else-holds' }] },
      'probe',
    );
    ledger.close();
    ledger = openTestLedger(dir);

    await run(
      { producers: [{ id: PRODUCER, resolvedSessionId: probe.sessionId as string }] },
      'review-refused',
    );

    const methods = methodsOf('review-refused');
    // The session was opened — that is where the id comes from — and nothing
    // was ever asked of it.
    expect(methods).toContain('session/new');
    expect(methods).not.toContain('session/prompt');
  });
});

suite('a fork is refused on this path too (AC3)', () => {
  it('refuses REVIEW_INHERITS_PRODUCER_CONTEXT and prompts nothing', async () => {
    const outcome = await run(
      {
        producers: [{ id: PRODUCER, resolvedSessionId: 'a-session-nobody-else-holds' }],
        resume: { kind: 'fork' },
      },
      'review-forked',
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.detail?.code).toBe('REVIEW_INHERITS_PRODUCER_CONTEXT');
    expect(methodsOf('review-forked')).not.toContain('session/prompt');
  });
});

suite('a node that is not a review is untouched', () => {
  it('runs its turn normally with no review block', async () => {
    const outcome = await run(undefined, 'ordinary');

    expect(outcome.status).toBe('completed');
    expect(methodsOf('ordinary')).toContain('session/prompt');
  });
});
