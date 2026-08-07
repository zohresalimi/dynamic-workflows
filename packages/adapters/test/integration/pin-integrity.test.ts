/**
 * KAR-09.3 — the integrity check where it actually has to run: immediately
 * before a process exists.
 *
 * A real file-backed ledger and a real fake binary that records every
 * invocation, because the claim is not "the function throws" — that is the
 * unit test — but *"and no provider process was spawned"*. A mocked spawn
 * could only confirm what the mock was handed; a witness binary on disk with
 * an empty log is the observation.
 *
 * The re-injection scenarios (EPIC-09-S16) are driven through the same path
 * with a summariser stub in place of a real vendor compaction. The
 * `compact_boundary` fixture EPIC-09's Definition of Ready calls for does not
 * exist yet — it costs real quota and KAR-09.6 owns capturing it — so what is
 * exercised here is the half that fixture would not add anything to: what the
 * check does when the bytes coming back from a re-injection are not the bytes
 * that went in.
 *
 * Verifies: EPIC-09-S16, EPIC-09-S17 (first and second scenarios),
 * EPIC-09-S19 · AC4, AC5, AC6, AC7
 */

import {
  type ContextPacket,
  PinIntegrityViolation,
  parseEvent,
  pinnedKept,
  renderPacket,
} from '@DeFlow/core';
import { makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import { runAcpNode } from '../../src/index.ts';
import {
  eventOf,
  mockAgentBinary,
  NODE_ID,
  openTestLedger,
  PROVIDER,
  RUN_ID,
  type TestLedger,
} from './support/harness.ts';
import { pinnedPacket, pinsOf } from './support/pinned-packet.ts';

const WITNESS = fileURLToPath(new URL('./support/spawn-witness.ts', import.meta.url));

let dir = '';
let worktree = '';
let spawnLog = '';
let ledger: TestLedger;

beforeEach(async () => {
  dir = await makeTempDir();
  worktree = join(dir, 'wt', 'n1');
  spawnLog = join(dir, 'spawns.ndjson');
  await mkdir(worktree, { recursive: true });
  ledger = openTestLedger(dir);
});

afterEach(async () => {
  ledger.close();
  await removeTempDir(dir);
});

/** Every invocation the witness binary recorded. Absent file means none. */
const spawns = (): string[] =>
  existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').split('\n').filter(Boolean) : [];

/** A node dispatched with `prompt` and the packet's pinned set. The binary is
 * the witness, so "was anything spawned" is a fact on disk. */
async function dispatch(packet: ContextPacket, prompt: string) {
  return runAcpNode(
    {
      runId: RUN_ID,
      nodeId: NODE_ID,
      attempt: 0,
      provider: PROVIDER,
      permission: 'worktree',
      worktree,
      binary: { path: WITNESS, version: '1.0.0', sha256: 'a'.repeat(64) },
      // The whole child environment, so PATH is what lets the witness's
      // `#!/usr/bin/env node` shebang resolve at all.
      env: { PATH: process.env.PATH ?? '', DeFlow_SPAWN_LOG: spawnLog },
      mcpServers: [],
      prompt,
      pins: pinsOf(packet),
    },
    { clock: new TestClock(), ledger: ledger.sink, captureEvidence: ledger.captureEvidence },
  );
}

suite('a vanished pin fails the node before anything is spawned (EPIC-09-S17)', () => {
  it('appends pin.integrity_violated, then node.failed, and spawns nothing', async () => {
    const packet = await pinnedPacket();
    const dropped = packet.segments.find((segment) => segment.kind === 'pinned.constraints');
    // The manifest is intact; the *render* silently drops one segment — which
    // is why the check takes the rendered prompt as an argument at all.
    const prompt = renderPacket(packet).replace(dropped?.text ?? '', '');

    const outcome = await dispatch(packet, prompt);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).toBe('safety.pin-integrity-violated');

    const kinds = ledger.events().map((event) => event.kind);
    expect(kinds).toContain('pin.integrity_violated');
    expect(kinds.indexOf('pin.integrity_violated')).toBeLessThan(kinds.indexOf('node.failed'));
    // The attempt never began: no `node.started`, and no child process.
    expect(kinds).not.toContain('node.started');
    expect(spawns()).toEqual([]);

    const violated = eventOf(ledger.events(), 'pin.integrity_violated');
    expect(violated).toMatchObject({
      node: NODE_ID,
      attempt: 0,
      missingDigests: [dropped?.contentHash],
      segmentIds: [dropped?.id],
    });
    // The payload is the shape the `Event` union declares, not a lookalike.
    expect(
      parseEvent({
        seq: 1,
        runId: RUN_ID,
        ts: 0,
        kind: 'pin.integrity_violated',
        v: 1,
        epoch: 1,
        nodeId: NODE_ID,
        attempt: 0,
        payload: violated,
      }).status,
    ).toBe('ok');
  });

  it('says the pin was in the manifest and absent from the prompt', async () => {
    const packet = await pinnedPacket();
    const dropped = packet.segments.find((segment) => segment.kind === 'pinned.pathscope');
    const prompt = renderPacket(packet).replace(dropped?.text ?? '', '');

    const outcome = await dispatch(packet, prompt);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.message).toContain('absent from the prompt');
    expect(outcome.failure.message).toContain(dropped?.id);
    // A gate, not a retry: a vanished pin wants a human.
    expect(outcome.failure.class).toBe('gate');
  });

  it('reports every violating segment in one event, not the first one twice', async () => {
    const packet = await pinnedPacket();
    const [first, second] = packet.segments.filter((segment) => segment.pinned);
    const prompt = renderPacket(packet)
      .replace(first?.text ?? '', '')
      .replace(second?.text ?? '', '');

    await dispatch(packet, prompt);

    expect(eventOf(ledger.events(), 'pin.integrity_violated')).toMatchObject({
      missingDigests: [first?.contentHash, second?.contentHash],
      segmentIds: [first?.id, second?.id],
    });
  });

  it('dispatches normally when the pinned bytes are all there', async () => {
    const packet = await pinnedPacket();

    const outcome = await dispatch(packet, renderPacket(packet));

    // The witness is not an ACP agent, so the turn fails at the handshake —
    // but it fails *after* being spawned, which is the observation: the pin
    // check let the dispatch through.
    expect(spawns().length).toBe(1);
    const kinds = ledger.events().map((event) => event.kind);
    expect(kinds).not.toContain('pin.integrity_violated');
    expect(kinds).toContain('node.started');
    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).not.toBe('safety.pin-integrity-violated');
  });
});

suite('re-injection is byte-identical, not paraphrased (EPIC-09-S16)', () => {
  /** A compaction that keeps the pinned block verbatim, as §4.1 requires. */
  const verbatim = (packet: ContextPacket): string =>
    packet.segments
      .filter((segment) => segment.pinned)
      .map((segment) => segment.text)
      .join('\n\n');

  it('re-injects bytes that hash to the original contentHash', async () => {
    const packet = await pinnedPacket();
    const reinjected = verbatim(packet);

    const outcome = await dispatch(packet, reinjected);

    expect(ledger.events().map((event) => event.kind)).not.toContain('pin.integrity_violated');
    expect(outcome.status).toBe('failed'); // the witness is not an agent
    await expect(pinnedKept(packet, reinjected)).resolves.toEqual(packet.pinnedDigests);
  });

  it('rejects a summariser that paraphrases a constraint', async () => {
    const packet = await pinnedPacket({ pathScopes: ['src/checkout/**'] });
    // The stub rewrites "only write files under src/checkout/**" the way a
    // summariser would: same meaning, different bytes.
    const paraphrased = verbatim(packet).replace(
      /write: src\/checkout\/\*\*/,
      'writes restricted to the checkout source directory',
    );

    const outcome = await dispatch(packet, paraphrased);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).toBe('safety.pin-integrity-violated');
    expect(spawns()).toEqual([]);
  });

  it('rejects a cosmetic reflow, and names the segment whose digest changed', async () => {
    const packet = await pinnedPacket();
    const constraints = packet.segments.find(
      (segment) => segment.kind === 'pinned.constraints' && segment.text.includes('Safety'),
    );
    // Rewrapped to 72 columns. A reflow is a paraphrase as far as the hash is
    // concerned, and possibly as far as the model is too.
    const reflowed = verbatim(packet).replace(
      constraints?.text ?? '',
      (constraints?.text ?? '').replaceAll('\n', ' '),
    );

    const outcome = await dispatch(packet, reflowed);

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.failure.reason).toBe('safety.pin-integrity-violated');
    expect(outcome.failure.message).toContain(constraints?.id);
  });

  it('is the check, not the assertion, that a paraphrase trips', async () => {
    const packet = await pinnedPacket();

    await expect(
      pinnedKept(packet, verbatim(packet).replace('Goal', 'Objective')),
    ).rejects.toBeInstanceOf(PinIntegrityViolation);
  });
});

suite('pinnedKept is the positive evidence the check ran (EPIC-09-S19)', () => {
  it('records the digests a compaction preserved, and they equal pinnedDigests', async () => {
    const packet = await pinnedPacket();
    const rendered = renderPacket(packet);

    const kept = await pinnedKept(packet, rendered);

    ledger.appendRunEvent('context.compacted', {
      node: packet.nodeId,
      scope: 'DeFlow.packet',
      fidelity: 'exact',
      trigger: 'threshold',
      before: packet.totals.tokens,
      after: packet.totals.tokens - 10,
      droppedSegments: [],
      demotedToHandles: [],
      pinnedKept: kept,
      originalHandle: null,
    });

    const row = eventOf(ledger.events(), 'context.compacted');
    expect(row?.pinnedKept).toEqual(packet.pinnedDigests);
    expect(row?.pinnedKept).toHaveLength(5);
    expect(
      parseEvent({
        seq: 1,
        runId: RUN_ID,
        ts: 0,
        kind: 'context.compacted',
        v: 1,
        epoch: 1,
        payload: row,
      }).status,
    ).toBe('ok');
  });

  it('leaves no compaction row with an empty pinnedKept over a whole run', async () => {
    // Four compactions across twelve nodes, each recorded the same way.
    for (let node = 0; node < 12; node += 1) {
      const packet = await pinnedPacket({ nodeId: `n${node}` });
      if (node % 3 !== 0) continue;
      ledger.appendRunEvent('context.compacted', {
        node: packet.nodeId,
        scope: 'DeFlow.packet',
        fidelity: 'exact',
        trigger: 'threshold',
        before: packet.totals.tokens,
        after: packet.totals.tokens - 10,
        droppedSegments: [],
        demotedToHandles: [],
        pinnedKept: await pinnedKept(packet, renderPacket(packet)),
        originalHandle: null,
      });
    }

    const rows = ledger.events().filter((event) => event.kind === 'context.compacted');
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect((row.payload.pinnedKept as string[]).length).toBeGreaterThan(0);
    }
  });
});
