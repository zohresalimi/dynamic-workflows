/**
 * KAR-05.5 AC6 — `session/load` is never a substitute for `session/resume`,
 * and if a diagnostic path uses it deliberately, the flood is bounded and
 * deduplicated on DeFlow's own event ids.
 *
 * The specific trap this file exists to close: **the agent's ids are not
 * stable across a reconnect.** A dedupe keyed on `toolCallId` or on a message
 * id concludes that a replayed history it already has is 400 new events, and
 * the ledger grows a second copy of the run. Both keys used below are minted
 * by DeFlow — the ordinal of the notification in DeFlow's own durable log, and
 * a digest DeFlow computed over the frame itself, scoped by node and attempt.
 *
 * Verifies: EPIC-05-S21 (scenarios 2, 3) · AC6 · test plan #7
 */
import { NodeIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  dedupeReplayedNotifications,
  deflowNotificationId,
  loadWouldFlood,
  MAX_LOAD_REPLAY_NOTIFICATIONS,
} from '../src/index.ts';

const NODE = NodeIdSchema.parse('n1');
const SCOPE = { nodeId: NODE, attempt: 0 };

/** One `session/update` as the agent replays it, with its own volatile ids. */
const update = (index: number, agentId = `tool_${index}`): unknown => ({
  sessionId: 'sess_abc',
  update: {
    sessionUpdate: 'tool_call',
    toolCallId: agentId,
    title: `step ${index}`,
    status: 'completed',
  },
});

const idsFor = async (notifications: readonly unknown[]): Promise<string[]> =>
  await Promise.all(
    notifications.map(async (notification) => await deflowNotificationId(SCOPE, notification)),
  );

suite("the id is DeFlow's own (EPIC-05-S21 scenario 2)", () => {
  it('is scoped by node and attempt, so two nodes never collide', async () => {
    const one = await deflowNotificationId({ nodeId: NODE, attempt: 0 }, update(1));
    const other = await deflowNotificationId({ nodeId: NODE, attempt: 1 }, update(1));
    expect(one).not.toBe(other);
    expect(one).toContain('n1');
  });

  it('is stable for the same frame', async () => {
    expect(await deflowNotificationId(SCOPE, update(1))).toBe(
      await deflowNotificationId(SCOPE, update(1)),
    );
  });
});

suite('a replayed history DeFlow already has adds nothing (EPIC-05-S21)', () => {
  it('discards all 400 when all 400 are already appended', async () => {
    const replayed = Array.from({ length: 400 }, (_, index) => update(index));
    const result = await dedupeReplayedNotifications(await idsFor(replayed), replayed, SCOPE);
    expect(result.discarded).toBe(400);
    expect(result.fresh).toHaveLength(0);
  });

  it('gains zero rows when the same notification is delivered twice', async () => {
    const one = update(1);
    const result = await dedupeReplayedNotifications(await idsFor([one]), [one, one], SCOPE);
    expect(result.fresh).toHaveLength(0);
    expect(result.discarded).toBe(2);
  });

  it('still dedupes when the agent re-minted its own ids across the reconnect', async () => {
    // The whole point: `tool_1` came back as `tool_9f3c`. Keyed on the agent's
    // id this is a new event; keyed on DeFlow's own position it is not.
    const appended = [update(1, 'tool_1'), update(2, 'tool_2')];
    const replayed = [update(1, 'tool_9f3c'), update(2, 'tool_ab77')];
    const result = await dedupeReplayedNotifications(await idsFor(appended), replayed, SCOPE);
    expect(result.fresh).toHaveLength(0);
    expect(result.discarded).toBe(2);
  });

  it('keeps the tail DeFlow has never seen, numbered from its own log', async () => {
    const appended = [update(1), update(2)];
    const replayed = [update(1), update(2), update(3), update(4)];
    const result = await dedupeReplayedNotifications(await idsFor(appended), replayed, SCOPE);
    expect(result.discarded).toBe(2);
    expect(result.fresh.map((entry) => entry.ordinal)).toEqual([2, 3]);
    expect(result.fresh.map((entry) => entry.notification)).toEqual([update(3), update(4)]);
  });
});

suite('a days-long run is protected (EPIC-05-S21 scenario 3)', () => {
  it('refuses before the frame is sent, naming the count', () => {
    const failure = loadWouldFlood(20_000);
    expect(failure).not.toBeNull();
    expect(failure?.message).toContain('20000');
    expect(failure?.deflowFailure.detail).toMatchObject({
      notifications: 20_000,
      cap: MAX_LOAD_REPLAY_NOTIFICATIONS,
    });
  });

  it('permits a session small enough to be worth loading', () => {
    expect(loadWouldFlood(12)).toBeNull();
    expect(loadWouldFlood(MAX_LOAD_REPLAY_NOTIFICATIONS)).toBeNull();
    expect(loadWouldFlood(MAX_LOAD_REPLAY_NOTIFICATIONS + 1)).not.toBeNull();
  });
});
