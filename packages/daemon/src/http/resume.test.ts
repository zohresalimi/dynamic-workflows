/**
 * KAR-15.4 test plan #1 and #2 — the cursor a connection resumes from, and the
 * window a hydrate page asks for.
 *
 * Verifies: EPIC-15-S28 (precedence), EPIC-15-S31 (the hydrate window) · AC3,
 * AC4
 *
 * Pure, and its own module, because the precedence is a *contract* rather than
 * a detail of the handler: `since` > `Last-Event-ID` > head, in that order,
 * with `since=0` beating a stale header rather than being discarded as falsy.
 * That coercion bug — `Number(since) || Number(lastEventId)` — is one character
 * away at all times and produces a UI that silently starts from head on every
 * cold hydrate, which is exactly the NF10 failure §4.1 is written to prevent.
 */
import { expect, it, describe as suite } from 'vitest';
import { DEFAULT_HYDRATE_LIMIT, hydrateLimit, MAX_HYDRATE_LIMIT, resumeFrom } from './resume.ts';

suite('EPIC-15-S28 — since > Last-Event-ID > head (AC3)', () => {
  it.each([
    ['both, disagreeing: the client’s own cursor wins', '10432', '10400', 10_432],
    ['since alone — the page-reload path', '10432', undefined, 10_432],
    ['Last-Event-ID alone — the browser’s own reconnect', undefined, '10400', 10_400],
    ['an explicit zero beats a stale header', '0', '10400', 0],
  ])('%s', (_name, since, lastEventId, seq) => {
    expect(resumeFrom(since, lastEventId)).toEqual({ kind: 'seq', seq });
  });

  it('starts at the head of the log when neither cursor is present', () => {
    // Head, not zero: a client that asked for no cursor is asking to be told
    // where the log is, and `hello.headSeq` is what tells it. Replaying the
    // whole ledger at every anonymous connection would be the other failure.
    expect(resumeFrom(undefined, undefined)).toEqual({ kind: 'head' });
  });

  it.each([
    ['a non-numeric since', 'not-a-number'],
    ['a negative since', '-1'],
    ['a fractional since', '10.5'],
    ['an empty since', ''],
  ])('falls past %s to the header', (_name, since) => {
    expect(resumeFrom(since, '10400')).toEqual({ kind: 'seq', seq: 10_400 });
  });

  it('falls all the way to head when both values are unusable', () => {
    expect(resumeFrom('nonsense', 'also-nonsense')).toEqual({ kind: 'head' });
  });
});

suite('EPIC-15-S31 — the hydrate window (AC4)', () => {
  it('defaults to 1000 when limit is omitted', () => {
    expect(hydrateLimit(undefined)).toBe(DEFAULT_HYDRATE_LIMIT);
    expect(DEFAULT_HYDRATE_LIMIT).toBe(1000);
  });

  it('caps at 5000 rather than refusing the request', () => {
    expect(hydrateLimit('50000')).toBe(MAX_HYDRATE_LIMIT);
    expect(MAX_HYDRATE_LIMIT).toBe(5000);
  });

  it('takes a limit inside the window as asked', () => {
    expect(hydrateLimit('250')).toBe(250);
    expect(hydrateLimit('5000')).toBe(5000);
  });

  it.each([
    ['zero', '0'],
    ['a negative limit', '-10'],
    ['a fraction', '12.5'],
    ['nonsense', 'lots'],
  ])('falls back to the default for %s', (_name, limit) => {
    expect(hydrateLimit(limit)).toBe(DEFAULT_HYDRATE_LIMIT);
  });
});
