/**
 * KAR-14.1 — subscription quota and API-key currency, kept apart all the way to
 * the socket.
 *
 * EPIC-14-S4 is declared `Automated at: integration`, and the reason is the same
 * one `run-rollup-api.test.ts` gives for EPIC-14-S1: its last two Then clauses
 * are about a **response body**, not about a projection.
 *
 * > And the node inspector payload for each node names its auth mode
 * > And a run containing an "api_key" node is labelled as such in the run summary
 *
 * Folding hand-built events through `reduce()` proves the fold — and
 * `cost-rollup.test.ts` and `run-summary.test.ts` already do. It does not prove
 * that two nodes which really ran, one against a subscription and one against an
 * explicit API key, reach an operator as two figures. So this file drives the
 * whole path: one fake exec-shim agent, two real `runShimNode` turns into one
 * real file-backed ledger, a real DeFlowd bound over that directory, and every
 * assertion made against JSON that came back over a socket.
 *
 * The clause that does the work is the second one. §12 of
 * docs/07-provider-adapter-layer.md keeps the two substances apart because they
 * are not the same money, and the flow file's note names the invariant behind
 * it: the effective auth mode of every provider is *"a recorded, rendered fact
 * and never something the user has to infer from a bill"*. Inferring it from
 * which of the four cost cells happens to be non-`null` is inferring — and it
 * fails outright for a node whose provider cannot be priced at all, where every
 * cell is `null` and the auth mode has vanished. So the rollup names the auth
 * modes that contributed, beside the money rather than inside it.
 *
 * Both turns run the same vendor CLI on purpose. `provider.auth_mode` (KAR-08.8)
 * is a property of the *credential a turn resolved*, not of the binary: the same
 * `claude` on the same PATH is subscription spend with a session token and real
 * currency with an API key, which is exactly why the rollup cannot derive the
 * answer from the provider id.
 *
 * Verifies: EPIC-14-S4 · KAR-14.1 AC3
 */

import {
  type EventRecord,
  type LedgerSink,
  runShimNode,
  shimCapabilityRow,
} from '@DeFlow/adapters';
import {
  type EventSeq,
  HandleSchema,
  type NodeId,
  NodeIdSchema,
  type ProviderAuthMode,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunk,
  blobHandle,
  openLedger,
  readEpoch,
  spillBytes,
} from '@DeFlow/ledger';
import { authorizedFetch, it, linkFakeAgent, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { clearLedgerView, openLedgerView, setLedgerView } from '../../src/http/ledger-view.ts';
import { startHttp } from '../../src/http/server.ts';

/**
 * Every request this spec makes carries the daemon's bearer token (KAR-15.2).
 *
 * Assigned to a local `fetch` so the call sites below read the way they did
 * before the daemon authenticated anything — the token is a property of this
 * whole file, not a decision at each request.
 */
const fetch = authorizedFetch();

const RUN: RunId = RunIdSchema.parse('run_20260806T090000Z_a4c001');
const SUB_NODE: NodeId = NodeIdSchema.parse('n-sub');
const KEY_NODE: NodeId = NodeIdSchema.parse('n-key');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3302';
const NOW = 1_800_000_000_000;

/** The subscription turn's figure, and the API-key turn's. Deliberately unequal
 *  and deliberately not a round sum: 0.5 + 0.25 is 0.75, and a projection that
 *  had collapsed them would be caught by a field holding it. */
const SUBSCRIPTION_USD = 0.5;
const API_KEY_USD = 0.25;

function turn(costUsd: number): string {
  return JSON.stringify({
    name: 'kar-14-1-auth-mode-turn',
    description: 'One headless turn whose result envelope carries a priced figure.',
    steps: [{ type: 'message', text: 'ok' }],
    result: { subtype: 'success', text: 'ok', totalCostUsd: costUsd, inputTokens: 1_000 },
  });
}

/** The production sink, minus the harness: `appendAll` is one transaction. */
function ledgerSink(db: ReturnType<typeof openLedger>, dataDir: string): LedgerSink {
  const epoch = readEpoch(db);
  const draft = (event: EventRecord) => ({
    runId: RUN,
    ts: event.ts,
    kind: event.kind,
    v: event.v,
    epoch,
    ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
    ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
    ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
    payload: event.payload,
  });
  return {
    async append(event) {
      const [seq] = appendEvents(db, [draft(event)], { spillTo: dataDir });
      return seq as EventSeq;
    },
    async appendAll(events) {
      return appendEvents(db, events.map(draft), { spillTo: dataDir }) as EventSeq[];
    },
    async appendIo(chunk) {
      return appendIoChunk(db, {
        runId: RUN,
        nodeId: chunk.nodeId,
        attempt: chunk.attempt + 1,
        stream: chunk.stream,
        ts: chunk.ts,
        data: chunk.data,
      });
    },
  };
}

interface Served {
  readonly origin: string;
  close(): Promise<void>;
}

/** Two real turns on one ledger, one per auth mode, served over HTTP. */
async function serveMixedRun(tmp: string): Promise<Served> {
  const agent = await linkFakeAgent(tmp, 'claude');
  const dataDir = join(tmp, 'data');
  const worktree = join(tmp, 'wt');
  await mkdir(dataDir, { recursive: true });
  await mkdir(worktree, { recursive: true });

  const db = openLedger(dataDir);
  const sha256 = createHash('sha256').update(readFileSync(agent.binary)).digest('hex');

  const runTurn = async (
    nodeId: NodeId,
    authMode: ProviderAuthMode,
    costUsd: number,
  ): Promise<void> => {
    const outcome = await runShimNode(
      {
        runId: RUN,
        nodeId,
        attempt: 0,
        provider: CLAUDE,
        permission: 'read',
        authMode,
        worktree,
        prompt: 'say ok',
        sessionId: SESSION,
        binary: { path: agent.binary, version: '2.1.220', sha256 },
        sandbox: {
          version: '2.1.220',
          platform: 'darwin',
          roots: [agent.binDir],
          configDir: join(tmp, 'sandbox'),
        },
        env: {
          ...process.env,
          DeFlow_FAKE_DIALECT: 'claude-stream-json',
          DeFlow_FAKE_SCENARIO: turn(costUsd),
          DeFlow_FAKE_SEED: '42',
          DeFlow_FAKE_NOW: String(NOW),
          DeFlow_SIDE_EFFECT_LOG: join(tmp, 'side-effects.ndjson'),
        },
      },
      {
        clock: { now: () => NOW, setTimer: () => ({ cancel: () => {} }) },
        ledger: ledgerSink(db, dataDir),
        captureEvidence: (evidence) =>
          HandleSchema.parse(
            blobHandle(
              spillBytes(
                dataDir,
                typeof evidence === 'string'
                  ? Buffer.from(evidence, 'utf8')
                  : Buffer.from(evidence),
                'text/plain',
              ).sha256,
            ),
          ),
        capabilityRow: shimCapabilityRow({
          provider: CLAUDE,
          version: '2.1.220',
          binaryPath: agent.binary,
          binarySha256: sha256,
          probedAt: NOW,
        }),
      },
    );
    expect(outcome.status).toBe('completed');
  };

  await runTurn(SUB_NODE, 'subscription', SUBSCRIPTION_USD);
  await runTurn(KEY_NODE, 'api_key', API_KEY_USD);

  const view = openLedgerView(dataDir);
  setLedgerView(view);
  const started = await startHttp({
    port: 0,
    hostname: '127.0.0.1',
    dev: false,
    token: TEST_DAEMON_TOKEN,
  });
  const address = started.server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await started.close();
      clearLedgerView();
      view.close();
      db.close();
    },
  };
}

interface Figures {
  readonly subscription: number | null;
  readonly apiKey: number | null;
  readonly vendorReported: number | null;
  readonly estimated: number | null;
}

interface Rollup {
  readonly costUsd: Figures;
  readonly authModes: readonly ProviderAuthMode[];
}

interface Body {
  readonly budget: {
    readonly run: Rollup;
    readonly nodes: Readonly<Record<string, Rollup>>;
    readonly providers: Readonly<Record<string, Rollup>>;
  };
}

let served: Served | undefined;

afterEach(async () => {
  await served?.close();
  served = undefined;
});

async function summary(tmp: string): Promise<Body> {
  served = await serveMixedRun(tmp);
  const response = await fetch(`${served.origin}/api/runs/${RUN}`);
  expect(response.status).toBe(200);
  return (await response.json()) as Body;
}

suite('EPIC-14-S4 — subscription quota and API-key currency over the API (AC3)', () => {
  it('reports the two as separate fields, neither derived from the other', async ({ tmp }) => {
    const body = await summary(tmp);

    expect(body.budget.run.costUsd.subscription).toBeCloseTo(SUBSCRIPTION_USD, 6);
    expect(body.budget.run.costUsd.apiKey).toBeCloseTo(API_KEY_USD, 6);
  });

  it('exposes no field holding their sum, at any keying', async ({ tmp }) => {
    const body = await summary(tmp);
    const total = SUBSCRIPTION_USD + API_KEY_USD;

    // The four cells and nothing else: a fifth key is how a convenience total
    // gets added, and it would be added by someone who had not read §12.
    const rollups = [
      body.budget.run,
      ...Object.values(body.budget.nodes),
      ...Object.values(body.budget.providers),
    ];
    for (const rollup of rollups) {
      expect(Object.keys(rollup.costUsd).sort()).toEqual([
        'apiKey',
        'estimated',
        'subscription',
        'vendorReported',
      ]);
    }

    // `vendorReported` legitimately holds every priced contribution regardless
    // of credential, so the sum appears there and must not be read as a total
    // of the two *substances*. The claim under test is the partition that §12
    // names: nothing adds subscription to apiKey.
    expect(body.budget.run.costUsd.subscription).not.toBeCloseTo(total, 6);
    expect(body.budget.run.costUsd.apiKey).not.toBeCloseTo(total, 6);
  });

  it('names each node its own auth mode in the node payload', async ({ tmp }) => {
    const body = await summary(tmp);

    expect(body.budget.nodes[SUB_NODE]?.authModes).toEqual(['subscription']);
    expect(body.budget.nodes[KEY_NODE]?.authModes).toEqual(['api_key']);
  });

  it('labels the run itself as containing an API-key node', async ({ tmp }) => {
    const body = await summary(tmp);

    expect([...body.budget.run.authModes].sort()).toEqual(['api_key', 'subscription']);
  });
});
