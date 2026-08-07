/**
 * KAR-09.7 AC8 / AR-1 — a full subscription-path run makes no outbound request.
 *
 * The claim is about a whole run rather than about a module, so this is a whole
 * run: a real fake-vendor binary spawned as a real child, a real file-backed
 * ledger, and a spy installed on every door out of the process before the node
 * starts. `fetch`, `http.request`/`get`, `https.request`/`get` and a DNS lookup
 * are between them every way a Node process reaches the network without a
 * native addon, and DNS is the one that catches an attempt DeFlow did not make
 * directly — a library reaching out on its own still has to resolve a name.
 *
 * The spies refuse rather than delegate. A spy that recorded and passed the
 * call through would, on the day this regresses, make a real request to a real
 * vendor from a developer's machine on a subscription key — which is precisely
 * the event under test.
 *
 * Verifies: EPIC-09-S40 · KAR-09.7 AC8 · test plan #8
 */
import {
  type NodeId,
  NodeIdSchema,
  type ProviderId,
  ProviderIdSchema,
  type RunId,
  RunIdSchema,
} from '@DeFlow/core';
import { it, linkFakeAgent } from '@DeFlow/testkit';
import { createHash } from 'node:crypto';
import dns, { promises as dnsPromises } from 'node:dns';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join } from 'node:path';
import { expect, describe as suite } from 'vitest';
import {
  runShimNode,
  type ShimNodeRequest,
  type ShimPorts,
  shimCapabilityRow,
} from '../../src/index.ts';
import { openTestLedger } from './support/harness.ts';

const RUN: RunId = RunIdSchema.parse('run_20260807T101500Z_ac0907');
const NODE: NodeId = NodeIdSchema.parse('n1');
const CLAUDE: ProviderId = ProviderIdSchema.parse('claude');
const SESSION = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const NOW = 1_800_000_000_000;

/** Every outbound attempt the spies saw, as `door → target`. */
interface Doors {
  readonly attempts: string[];
  restore(): void;
}

function watchEveryDoor(): Doors {
  const attempts: string[] = [];
  const refuse = (door: string, target: unknown): never => {
    const description = `${door} → ${String(target)}`;
    attempts.push(description);
    throw new Error(`outbound request attempted on the subscription path: ${description}`);
  };

  const originals = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    lookup: dns.lookup,
    promisesLookup: dnsPromises.lookup,
  };

  globalThis.fetch = ((input: unknown) => refuse('fetch', input)) as typeof fetch;
  http.request = ((target: unknown) => refuse('http.request', target)) as typeof http.request;
  http.get = ((target: unknown) => refuse('http.get', target)) as typeof http.get;
  https.request = ((target: unknown) => refuse('https.request', target)) as typeof https.request;
  https.get = ((target: unknown) => refuse('https.get', target)) as typeof https.get;
  dns.lookup = ((hostname: unknown) => refuse('dns.lookup', hostname)) as typeof dns.lookup;
  dnsPromises.lookup = ((hostname: unknown) =>
    refuse('dns.promises.lookup', hostname)) as typeof dnsPromises.lookup;

  return {
    attempts,
    restore() {
      globalThis.fetch = originals.fetch;
      http.request = originals.httpRequest;
      http.get = originals.httpGet;
      https.request = originals.httpsRequest;
      https.get = originals.httpsGet;
      dns.lookup = originals.lookup;
      dnsPromises.lookup = originals.promisesLookup;
    },
  };
}

suite('a subscription-path run reaches no network (AC8)', () => {
  it('completes a whole node with zero outbound attempts', async ({ tmp }) => {
    const agent = await linkFakeAgent(tmp, 'claude');
    const dataDir = join(tmp, 'data');
    const worktree = join(tmp, 'wt');
    await mkdir(dataDir, { recursive: true });
    await mkdir(worktree, { recursive: true });
    const ledger = openTestLedger(dataDir);

    const request: ShimNodeRequest = {
      runId: RUN,
      nodeId: NODE,
      attempt: 0,
      provider: CLAUDE,
      permission: 'read',
      worktree,
      prompt: 'say ok',
      sessionId: SESSION,
      binary: {
        path: agent.binary,
        version: '2.1.220',
        sha256: createHash('sha256').update(readFileSync(agent.binary)).digest('hex'),
      },
      sandbox: {
        version: '2.1.220',
        platform: 'darwin',
        roots: [join(tmp, 'bin')],
        configDir: join(tmp, 'sandbox'),
      },
      env: {
        ...process.env,
        DeFlow_FAKE_DIALECT: 'claude-stream-json',
        DeFlow_FAKE_SCENARIO: 'claude-turn',
        DeFlow_FAKE_SEED: '42',
        DeFlow_FAKE_NOW: String(NOW),
      },
    };

    const ports: ShimPorts = {
      clock: { now: () => NOW, sleep: async () => {}, setTimer: () => ({ cancel: () => {} }) },
      ledger: ledger.sink,
      captureEvidence: ledger.captureEvidence,
      capabilityRow: shimCapabilityRow({
        provider: CLAUDE,
        version: '2.1.220',
        binaryPath: agent.binary,
        binarySha256: request.binary.sha256,
        probedAt: NOW,
      }),
    };

    const doors = watchEveryDoor();
    try {
      const outcome = await runShimNode(request, ports);
      expect(outcome.status).toBe('completed');
    } finally {
      doors.restore();
      ledger.close();
    }

    expect(
      doors.attempts,
      'the subscription path reached the network. AR-1: DeFlow never authenticates to a vendor ' +
        'API on the user’s subscription, and /v1/messages/count_tokens is api-key-path only.',
    ).toEqual([]);
  });
});
