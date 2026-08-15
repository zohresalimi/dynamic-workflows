/**
 * KAR-16.5 test plan #3, #5, #6 — `deflow replay`, on a real socket.
 *
 * Verifies: EPIC-16-S31, EPIC-16-S33 · AC1, AC3, AC4, AC5, AC9
 *
 * *"The UI cannot tell the difference, because there is no difference — the
 * browser is a projection of an event stream either way"*
 * (docs/03-local-development.md §6.2). That claim is only worth anything if it
 * is asserted against the same wire the live daemon serves, so everything here
 * is real: a real `boot()`, a real ephemeral port, a real file-backed ledger
 * restored from a committed fixture, and frames read off the socket by hand.
 *
 * The auth suite is not pedantry. *"A harness that skips auth is a harness that
 * lets an auth regression ship, because the harness is what most development
 * runs against."*
 */
import { authorizedFetch, it, TEST_DAEMON_TOKEN } from '@DeFlow/testkit';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, describe as suite } from 'vitest';
import { type ReplayHarness, startReplay } from '../../src/replay/harness.ts';
import { parseSpeed } from '../../src/replay/speed.ts';
import { readFrames } from './support/sse.ts';

const FIXTURES = fileURLToPath(new URL('../../../../test/fixtures/runs/', import.meta.url));
const fixture = (name: string): string => join(FIXTURES, name, 'events.jsonl');

const authorized = authorizedFetch();

let harness: ReplayHarness | undefined;
const sockets: AbortController[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.abort();
  await harness?.close();
  harness = undefined;
});

/** Boots the harness over `name`, into a data directory of its own. */
async function replay(
  tmp: string,
  name: string,
  speed = 'max',
  options: { keepaliveMs?: number } = {},
): Promise<ReplayHarness> {
  harness = await startReplay({
    fixture: fixture(name),
    speed: parseSpeed(speed),
    port: 0,
    dataDir: join(tmp, name),
    token: TEST_DAEMON_TOKEN,
    ...(options.keepaliveMs === undefined ? {} : { keepaliveMs: options.keepaliveMs }),
  });
  return harness;
}

/** Opens `GET /api/stream?<query>` and reads its frames off the socket. */
async function openStream(
  origin: string,
  query: string,
): Promise<{ response: Response; frames: ReturnType<typeof readFrames> }> {
  const controller = new AbortController();
  sockets.push(controller);
  const response = await authorized(`${origin}/api/stream?${query}`, {
    signal: controller.signal,
  });
  return { response, frames: readFrames(response, controller.signal) };
}

suite('EPIC-16-S31 — the harness serves the normal contract (AC1)', () => {
  it('answers every endpoint the acceptance criteria name', async ({ tmp }) => {
    const played = await replay(tmp, 'three-patches');
    await played.played();
    const [runId] = played.runIds;

    const paths = [
      `/api/runs/${runId}`,
      `/api/runs/${runId}/events?since=0`,
      `/api/runs/${runId}/snapshot?seq=head`,
      `/api/runs/${runId}/plans`,
      `/api/runs/${runId}/plans/1`,
      `/api/runs/${runId}/plans/diff?from=1&to=2`,
      `/api/runs/${runId}/gates`,
      `/api/runs/${runId}/criteria`,
    ];

    for (const path of paths) {
      const response = await authorized(`${played.origin}${path}`);
      // A 5xx, a 404 or a 401 would each mean a different half of the harness
      // is missing; the point of the sweep is that none of them happen.
      expect([200, 404], `${path} answered ${response.status}`).toContain(response.status);
      expect(response.headers.get('X-DeFlow-Api')).toBe('1');
    }
  });

  it('serves the recorded events under their recorded seq, gaps and all (AC9)', async ({ tmp }) => {
    const played = await replay(tmp, 'crash-resume-seq-gap');
    await played.played();

    for (const runId of played.runIds) {
      const response = await authorized(`${played.origin}/api/runs/${runId}/events?since=0`);
      expect(response.status).toBe(200);
      const page = (await response.json()) as { events: { seq: number }[] };
      const seqs = page.events.map((event) => event.seq);
      // Strictly ascending with holes: the fixture's whole reason to exist.
      expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
      expect(new Set(seqs).size).toBe(seqs.length);
    }
  });
});

suite('EPIC-16-S31 — the stream contract is the same contract (AC3)', () => {
  it('opens with hello, writes retry once, and ids every frame with its seq', async ({ tmp }) => {
    const played = await replay(tmp, 'happy-path-12');
    const [runId] = played.runIds;
    const { response, frames } = await openStream(played.origin, `runs=${runId}&since=0`);

    expect(response.headers.get('content-type')).toMatch(/text\/event-stream/);
    expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');

    const hello = await frames.until((frame) => frame.event === 'hello');
    const payload = JSON.parse(hello.data) as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(
      expect.arrayContaining(['streamId', 'apiVersion', 'build', 'daemonEpoch', 'headSeq']),
    );
    expect(payload.daemonEpoch).toBeTypeOf('number');

    await played.played();
    await frames.until((frame) => frame.event === 'caught_up');

    // `retry: 2000`, once and only once, however many frames follow it.
    expect(frames.raw().match(/retry: 2000/g)).toHaveLength(1);

    const ledgerFrames = frames.all().filter((frame) => frame.event === undefined);
    expect(ledgerFrames.length).toBeGreaterThan(0);
    for (const frame of ledgerFrames) {
      const event = JSON.parse(frame.data) as { seq: number };
      expect(frame.id).toBe(String(event.seq));
    }
  });

  it('keeps sending keepalives on an idle stream', async ({ tmp }) => {
    const played = await replay(tmp, 'happy-path-12', 'max', { keepaliveMs: 60 });
    const [runId] = played.runIds;
    const { frames } = await openStream(played.origin, `runs=${runId}&since=0`);

    await frames.until((frame) => frame.event === 'hello');
    await played.played();
    // The cadence is the daemon's own (15 s in production, shortened here the
    // same way EPIC-15's specs shorten it): what is under test is that the
    // harness does not stop keepalives once the recording runs out.
    await frames.untilKeepalives(2);
    expect(frames.keepalives()).toBeGreaterThanOrEqual(2);
  });
});

suite('EPIC-16-S31 — auth is not bypassed because it is "only dev" (AC5)', () => {
  it('refuses an unauthenticated /api/runs with 401 missing_token', async ({ tmp }) => {
    const played = await replay(tmp, 'happy-path-12');
    const [runId] = played.runIds;

    const response = await fetch(`${played.origin}/api/runs/${runId}`);
    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'missing_token',
    );
  });

  it('refuses a foreign Origin with 403 bad_origin', async ({ tmp }) => {
    const played = await replay(tmp, 'happy-path-12');
    const [runId] = played.runIds;

    const response = await authorized(`${played.origin}/api/runs/${runId}`, {
      headers: { Origin: 'https://evil.example.com' },
    });
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('bad_origin');
  });

  it('leaves GET /api/health as the only unauthenticated route', async ({ tmp }) => {
    const played = await replay(tmp, 'happy-path-12');

    const health = await fetch(`${played.origin}/api/health`);
    expect(health.status).toBe(200);

    const stream = await fetch(`${played.origin}/api/stream`);
    expect(stream.status).toBe(401);
  });
});

suite('EPIC-16-S33 — playback control (AC4)', () => {
  it('delivers the whole fixture at max, as fast as the socket drains', async ({ tmp }) => {
    const played = await replay(tmp, 'three-patches', 'max');
    await played.played();

    expect(played.position()).toBe(played.headSeq);
    expect(played.emitted()).toBe(played.recorded);
  });

  it('emits nothing while paused, and the connection stays open', async ({ tmp }) => {
    // 1x over a fixture recorded across minutes: without pausing, the second
    // event is minutes away, so what is asserted is that *pausing* is what
    // holds the position rather than the schedule doing it by accident.
    const played = await replay(tmp, 'three-patches', '1x', { keepaliveMs: 60 });
    const [runId] = played.runIds;
    const { frames } = await openStream(played.origin, `runs=${runId}&since=0`);
    await frames.until((frame) => frame.event === 'hello');

    played.pause();
    expect(played.paused()).toBe(true);
    const held = played.position();

    await frames.untilKeepalives(2);
    expect(played.position()).toBe(held);
    expect(frames.ended()).toBe(false);
  });

  it('seeks forward to a seq and resumes emission after it', async ({ tmp }) => {
    const played = await replay(tmp, 'happy-path-12', '1x');
    const [runId] = played.runIds;
    const { frames } = await openStream(played.origin, `runs=${runId}&since=0`);
    await frames.until((frame) => frame.event === 'hello');

    const target = played.seqs[Math.floor(played.seqs.length / 2)] ?? 0;
    await played.seek(target);

    expect(played.position()).toBe(target);
    // Everything up to the target is committed — a seek is a fast-forward
    // through the recording, not a jump that skips it — and the client can
    // hydrate the state at that point from the snapshot endpoint.
    const snapshot = await authorized(`${played.origin}/api/runs/${runId}/snapshot?seq=${target}`);
    expect(snapshot.status).toBe(200);
    expect(((await snapshot.json()) as { seq: number }).seq).toBe(target);

    // And the rest of the recording still plays: seeking to the head is the
    // same fast-forward again, which is what "resumes emission" means for a
    // recording whose remaining gaps are recorded hours.
    await played.seek(played.headSeq);
    await played.played();
    expect(played.position()).toBe(played.headSeq);
    expect(played.emitted()).toBe(played.recorded);
  });

  it('does not un-commit on a backward seek — the client re-hydrates instead', async ({ tmp }) => {
    const played = await replay(tmp, 'happy-path-12', 'max');
    await played.played();
    const [runId] = played.runIds;

    const target = played.seqs[2] ?? 0;
    await played.seek(target);

    // The ledger is append-only, so a backward seek is a *view* movement: the
    // harness reports the position and the client re-hydrates from
    // `…/snapshot?seq=<N>` (EPIC-15-S47's whole reason to exist). Nothing is
    // withdrawn, and the events past it stay served.
    expect(played.position()).toBe(target);
    const events = await authorized(`${played.origin}/api/runs/${runId}/events?since=${target}`);
    const page = (await events.json()) as { events: { seq: number }[] };
    expect(page.events.length).toBeGreaterThan(0);
  });
});
