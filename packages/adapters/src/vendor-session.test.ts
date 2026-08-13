/**
 * KAR-19.8 AC2 / EPIC-19-S53 — the vendor-side session id is *derived*, not
 * minted.
 *
 * The cheap fix for the 2026-08-13 defect passes every other assertion in this
 * story: `randomUUID()` at the call site satisfies the vendor, satisfies "is it
 * a UUID", and silently breaks two things nothing else checks — `--resume` on a
 * second attempt opens a session the first attempt's transcript is not in, and
 * the transcript file under the vendor's own projects directory can no longer
 * be found from the ledger. So this file asserts the *mapping*, and the golden
 * below is the load-bearing half of it.
 *
 * **The golden was computed from RFC 4122 §4.3, not from this module.** It is a
 * name-based v5 UUID over `<namespace> || "<runId>/<nodeId>/<attempt>"`, which
 * is a construction anybody can reproduce with `sha1` and eight lines of
 * JavaScript. Pinning it is what makes "the same tuple across processes and
 * across daemon lives" a fact rather than a claim: a fresh process running an
 * unchanged build has to produce these exact strings, and no in-process
 * `toEqual` between two calls can say that.
 *
 * Verifies: EPIC-19-S53 · KAR-19.8 AC2
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { expect, it, describe as suite } from 'vitest';
import { isUuid, VENDOR_SESSION_NAMESPACE, vendorSessionId } from './vendor-session.ts';

const RUN = RunIdSchema.parse('run_20260813T110608Z_379fc8');
const node = (id: string): ReturnType<typeof NodeIdSchema.parse> => NodeIdSchema.parse(id);

/**
 * The reference values, derived from the RFC rather than from this module —
 * see the header. The three pre-execution turn kinds and two attempts of one
 * agent node, which is every shape a caller has.
 */
const GOLDEN = [
  ['framing', 0, '9641715e-de03-5a62-8708-66ba9a823f91'],
  ['recon', 0, '46e4fb91-716d-5eef-8058-df423ca1a566'],
  ['planner', 0, '3ce4d195-0267-5391-96be-1fcd7e10fbd5'],
  ['implement', 0, '2c3ec084-adb4-5a63-9d1c-90100a095124'],
  ['implement', 1, '63c1e626-e9b2-5e09-abb0-47dc1cba264c'],
] as const;

suite('KAR-19.8 AC2 — the same tuple always gives the same id', () => {
  it.each(GOLDEN)(
    'derives the RFC-4122 v5 uuid for (run, %s, attempt %i)',
    (nodeId, attempt, expected) => {
      expect(vendorSessionId({ runId: RUN, nodeId: node(nodeId), attempt })).toBe(expected);
    },
  );

  it('answers the same value twice in one process', () => {
    const key = { runId: RUN, nodeId: node('implement'), attempt: 2 };

    expect(vendorSessionId(key)).toBe(vendorSessionId({ ...key }));
  });

  it('is a valid uuid, which is the whole of what the vendor validates', () => {
    for (const [nodeId, attempt] of GOLDEN) {
      expect(isUuid(vendorSessionId({ runId: RUN, nodeId: node(nodeId), attempt }))).toBe(true);
    }
  });

  it('refuses a negative or fractional attempt rather than deriving from it', () => {
    expect(() => vendorSessionId({ runId: RUN, nodeId: node('n1'), attempt: -1 })).toThrow();
    expect(() => vendorSessionId({ runId: RUN, nodeId: node('n1'), attempt: 1.5 })).toThrow();
  });
});

suite('KAR-19.8 AC2 — different tuples never collide', () => {
  it('mints 10000 distinct ids for 10000 distinct tuples', () => {
    const seen = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      const runId = RunIdSchema.parse(
        `run_2026081${index % 10}T110608Z_${(index % 0x100000).toString(16).padStart(6, '0')}`,
      );
      const nodeId = node(`n${index % 97}`);
      seen.add(vendorSessionId({ runId, nodeId, attempt: index % 7 }));
    }

    expect(seen.size).toBe(10_000);
  });

  it('separates the three parts, so "a/b" and "a" + "/b" are not the same tuple', () => {
    const first = vendorSessionId({ runId: RUN, nodeId: node('a-b'), attempt: 0 });
    const second = vendorSessionId({ runId: RUN, nodeId: node('a'), attempt: 0 });

    expect(first).not.toBe(second);
  });
});

suite('KAR-19.8 AC2 — nothing random reaches the derivation', () => {
  const source = readFileSync(new URL('./vendor-session.ts', import.meta.url), 'utf8');
  const code = source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

  it.each(['randomUUID', 'Math.random', 'Date.now', 'new Date', 'process.env', 'getRandomValues'])(
    'reads no %s',
    (forbidden) => {
      expect(code).not.toContain(forbidden);
    },
  );

  it('names one namespace, and it is itself a uuid', () => {
    expect(isUuid(VENDOR_SESSION_NAMESPACE)).toBe(true);
  });
});
