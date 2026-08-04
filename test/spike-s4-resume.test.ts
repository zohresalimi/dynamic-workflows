/**
 * KAR-00.3 — the resume contract, as pure arithmetic.
 *
 * `EventSource` sends `Last-Event-ID` only on an automatic reconnect, never on
 * a fresh `new EventSource()` after a page reload, and it cannot set custom
 * headers at all. That single verified fact is why the stream endpoint needs
 * *two* resume mechanisms, and why the rule is "resume from strictly greater
 * than seq" rather than "expect seq + 1" — a rolled-back transaction burns an
 * AUTOINCREMENT value in the real ledger, so gaps are lawful.
 *
 * The browser half of that claim (the header really is absent after a reload,
 * really is present after a reconnect) is asserted against a real Chromium in
 * e2e/spike-s4-one-port.test.ts. This file is the arithmetic the server and the
 * client both route through, which is where an off-by-one would live.
 *
 * Verifies: EPIC-00-S13 (scenarios 2 and 4) · AC5.
 */
import { expect, it, describe as suite } from 'vitest';
import {
  classifySeq,
  eventsAfter,
  resumeFrom,
  type StreamEvent,
} from '../spikes/s4-one-port/src/resume.ts';

const log: StreamEvent[] = [136, 137, 138, 140].map((seq) => ({
  seq,
  at: seq * 1000,
  data: `event ${seq}`,
}));

suite('which resume mechanism a request is using', () => {
  it('reads ?since=137 as "strictly after 137"', () => {
    expect(resumeFrom({ since: '137' })).toEqual({ mode: 'since', after: 137 });
  });

  it('reads a Last-Event-ID header the same way when there is no ?since', () => {
    expect(resumeFrom({ lastEventId: '137' })).toEqual({ mode: 'last-event-id', after: 137 });
  });

  it('resumes from the greater of the two when both are offered', () => {
    // Measured rather than assumed, and not what this spike expected. A page
    // that reloaded hydrates at "/api/stream?since=137"; when *that* connection
    // is severed the browser reconnects to the same URL, so it sends the stale
    // ?since together with a current Last-Event-ID. The header is the browser's
    // own running cursor and is never behind; the query string was frozen at
    // page load. Preferring ?since would replay everything in between.
    expect(resumeFrom({ since: '137', lastEventId: '150' })).toEqual({
      mode: 'last-event-id',
      after: 150,
    });

    // And the other way round, for the client that knows better than the
    // browser does — a hydration request opened before any event arrived.
    expect(resumeFrom({ since: '140', lastEventId: '12' })).toEqual({
      mode: 'since',
      after: 140,
    });
  });

  it('calls a tie a reconnect, because only a reconnect carries the header', () => {
    expect(resumeFrom({ since: '137', lastEventId: '137' })).toEqual({
      mode: 'last-event-id',
      after: 137,
    });
  });

  it('is live when neither is offered', () => {
    expect(resumeFrom({})).toEqual({ mode: 'live' });
    expect(resumeFrom({ since: null, lastEventId: null })).toEqual({ mode: 'live' });
  });

  it('is live rather than a full replay when the value is not a sequence number', () => {
    for (const since of ['', 'abc', '-1', '1.5', 'NaN', '1e3']) {
      expect(resumeFrom({ since }), `?since=${since}`).toEqual({ mode: 'live' });
    }
  });

  it('accepts 0, which means "everything from the beginning"', () => {
    expect(resumeFrom({ since: '0' })).toEqual({ mode: 'since', after: 0 });
  });
});

suite('what a resuming connection is owed', () => {
  it('replays strictly greater than the cursor — no duplicate of the last seen event', () => {
    expect(eventsAfter(log, { mode: 'since', after: 137 }).map((event) => event.seq)).toEqual([
      138, 140,
    ]);
  });

  it('replays nothing when the cursor is already at the head', () => {
    expect(eventsAfter(log, { mode: 'since', after: 140 })).toEqual([]);
  });

  it('replays everything from 0', () => {
    expect(eventsAfter(log, { mode: 'since', after: 0 }).map((event) => event.seq)).toEqual([
      136, 137, 138, 140,
    ]);
  });

  it('replays nothing for a live connection, however long the log is', () => {
    expect(eventsAfter(log, { mode: 'live' })).toEqual([]);
  });

  it('treats a Last-Event-ID cursor identically to a ?since cursor', () => {
    expect(eventsAfter(log, { mode: 'last-event-id', after: 137 })).toEqual(
      eventsAfter(log, { mode: 'since', after: 137 }),
    );
  });
});

suite('a gap in the sequence is expected and is not an error (EPIC-00-S13 scenario 4)', () => {
  it('accepts 140 immediately after 138 — a rolled-back transaction burned 139', () => {
    expect(classifySeq(138, 140)).toBe('accepted');
  });

  it('accepts the first event of a connection whatever its seq', () => {
    expect(classifySeq(null, 1)).toBe('accepted');
    expect(classifySeq(null, 4_291)).toBe('accepted');
  });

  it('reports a repeat of the last seen seq as a duplicate', () => {
    expect(classifySeq(138, 138)).toBe('duplicate');
  });

  it('reports a lower seq as a regression, which is the only real violation', () => {
    expect(classifySeq(138, 137)).toBe('regression');
  });
});
