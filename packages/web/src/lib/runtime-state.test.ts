/**
 * KAR-26.4 — the runtime state word's table, exercised over the **full**
 * cartesian product of its inputs.
 *
 * Verifies: EPIC-26-S25 · AC1
 *
 * The pure half of what `../components/settings/runtimes-panel.test.ts`
 * re-proves in the DOM, the same split `./connector-status.test.ts` /
 * `../components/settings/connectors-panel.test.ts` already use: this file
 * owns totality (every combination, including the wire-unreachable ones), the
 * DOM file owns "the rendered chip carries this word and this token's
 * colour".
 */
import { expect, it, describe as suite } from 'vitest';
import {
  type ResolvedRuntimeState,
  type RuntimeStateInput,
  resolveRuntimeState,
} from './runtime-state.ts';

const WORDS = ['disabled', 'ready', 'partial', 'unusable', 'unreported', 'unknown'] as const;

/**
 * The full cartesian product: `enabled` × { report present with all six
 * `(available, acp)` pairs (`acp` ranges over the closed `RouteState` set
 * *plus* `null`, the unreadable-field case), report absent × all three
 * `reportStatus` values } — 2 × 9 = 18 rows, none omitted, so a combination
 * this table has no answer for cannot exist without this file naming it.
 */
const CASES: readonly { readonly input: RuntimeStateInput; readonly want: ResolvedRuntimeState }[] =
  [
    // enabled: false wins first and unconditionally, whatever the report says —
    // `providerVerdict()`'s own precedence, copied.
    {
      input: {
        enabled: false,
        report: { available: true, acp: 'available' },
        reportStatus: 'reported',
      },
      want: { word: 'disabled', tone: 'neutral' },
    },
    {
      input: {
        enabled: false,
        report: { available: true, acp: 'missing' },
        reportStatus: 'reported',
      },
      want: { word: 'disabled', tone: 'neutral' },
    },
    {
      input: { enabled: false, report: { available: true, acp: null }, reportStatus: 'reported' },
      want: { word: 'disabled', tone: 'neutral' },
    },
    {
      input: {
        enabled: false,
        report: { available: false, acp: 'missing' },
        reportStatus: 'reported',
      },
      want: { word: 'disabled', tone: 'neutral' },
    },
    {
      input: {
        enabled: false,
        report: { available: false, acp: 'available' },
        reportStatus: 'reported',
      },
      want: { word: 'disabled', tone: 'neutral' },
    },
    {
      input: { enabled: false, report: { available: false, acp: null }, reportStatus: 'reported' },
      want: { word: 'disabled', tone: 'neutral' },
    },
    {
      input: { enabled: false, report: null, reportStatus: 'reported' },
      want: { word: 'disabled', tone: 'neutral' },
    },
    {
      input: { enabled: false, report: null, reportStatus: 'machine-unknown' },
      want: { word: 'disabled', tone: 'neutral' },
    },
    {
      input: { enabled: false, report: null, reportStatus: 'unavailable' },
      want: { word: 'disabled', tone: 'neutral' },
    },
    // enabled, with a report: available × acp.
    {
      input: {
        enabled: true,
        report: { available: true, acp: 'available' },
        reportStatus: 'reported',
      },
      want: { word: 'ready', tone: 'ok' },
    },
    {
      input: {
        enabled: true,
        report: { available: true, acp: 'missing' },
        reportStatus: 'reported',
      },
      want: { word: 'partial', tone: 'warn' },
    },
    // An available row whose `acp` field was absent or unreadable: "partial"
    // would be a composed claim ("node-execution turns go unserved") made
    // from a field the daemon never sent — the honest word is `unknown`.
    {
      input: { enabled: true, report: { available: true, acp: null }, reportStatus: 'reported' },
      want: { word: 'unknown', tone: 'neutral' },
    },
    {
      input: {
        enabled: true,
        report: { available: false, acp: 'missing' },
        reportStatus: 'reported',
      },
      want: { word: 'unusable', tone: 'warn' },
    },
    // Unreachable on the wire — `providerRoutes()` cannot open `acp` while
    // `shim` is closed — but the mapping still answers it through the
    // `available: false` row rather than crashing or special-casing it.
    {
      input: {
        enabled: true,
        report: { available: false, acp: 'available' },
        reportStatus: 'reported',
      },
      want: { word: 'unusable', tone: 'warn' },
    },
    {
      input: { enabled: true, report: { available: false, acp: null }, reportStatus: 'reported' },
      want: { word: 'unusable', tone: 'warn' },
    },
    // enabled, no row: `unreported` only when a report actually arrived and
    // claimed to know the machine. A `known: false` report and a report that
    // never reached this tab both resolve to `unknown` — an absence of
    // information, never an affirmative claim about a report's contents.
    {
      input: { enabled: true, report: null, reportStatus: 'reported' },
      want: { word: 'unreported', tone: 'neutral' },
    },
    {
      input: { enabled: true, report: null, reportStatus: 'machine-unknown' },
      want: { word: 'unknown', tone: 'neutral' },
    },
    {
      input: { enabled: true, report: null, reportStatus: 'unavailable' },
      want: { word: 'unknown', tone: 'neutral' },
    },
  ];

suite('EPIC-26-S25 — the word is a total mapping over the daemon’s own fields', () => {
  it.each(CASES)(
    'enabled=$input.enabled report=$input.report reportStatus=$input.reportStatus → "$want.word"',
    ({ input, want }) => {
      expect(resolveRuntimeState(input)).toEqual(want);
    },
  );

  it('is total: no input in the product resolves to undefined or to a word outside the six', () => {
    for (const { input } of CASES) {
      const resolved = resolveRuntimeState(input);
      expect(resolved).toBeDefined();
      expect(WORDS).toContain(resolved.word);
      expect(['ok', 'warn', 'neutral']).toContain(resolved.tone);
    }
  });

  it('covers the whole product, so the table above cannot silently shrink', () => {
    const seen = new Set(
      CASES.map(
        ({ input }) =>
          `${input.enabled}|${
            input.report === null
              ? `null|${input.reportStatus}`
              : `${input.report.available}|${String(input.report.acp)}`
          }`,
      ),
    );
    expect(seen.size).toBe(18);
  });
});
