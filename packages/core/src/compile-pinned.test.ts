/**
 * KAR-10.4 — the byte-preserving compiler (AC2), and the property that makes
 * verbatim re-injection checkable rather than asserted.
 *
 * `docs/04-domain-model.md` §2: *"verbatim means identical bytes — the
 * summariser is never allowed near them."* So the compiler is tested the way a
 * codec is: an author's own bytes go in, and the same bytes come out of the
 * segment **and** out of the canonical form the digests are taken over. A
 * reflow, a re-wrap or a renumbered bullet is a red test, not a diff nobody
 * reads.
 *
 * Verifies: EPIC-10-S19 (third scenario) · AC2 · test plan #1, #2
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { buildPacket } from './build-packet.ts';
import { canonicalSpecText, compilePinnedSegments } from './compile-pinned.ts';
import type { Constraint } from './constraint.ts';
import { EventSeqSchema } from './ids.ts';
import { buildPinnedSegments } from './pinned-set.ts';
import { type TaskSpec, TaskSpecSchema } from './task-spec.ts';

const fixturePath = fileURLToPath(
  new URL('../test/fixtures/specs/vue3-migration.json', import.meta.url),
);
const baseSpec: Record<string, unknown> = JSON.parse(readFileSync(fixturePath, 'utf8'));

function approvedSpec(overrides: Record<string, unknown> = {}): TaskSpec {
  const draft = structuredClone(baseSpec);
  draft.nonGoals = ['Rewriting the payment gateway integration', 'Touching the pricing service'];
  draft.constraints = [
    'must not change the public API of @voyado/ui',
    'must not run database migrations',
  ];
  draft.approvedBy = { at: '2026-08-06T09:00:00Z', via: 'ui' };
  return TaskSpecSchema.parse({ ...draft, ...overrides });
}

const NODE = { pathScopes: ['src/checkout/**'], permission: 'worktree' } as const;

/**
 * A spec written by somebody who formats prose the way people actually do: a
 * hard-wrapped statement, a tab, a trailing double space, a numbered list
 * inside a criterion and a non-ASCII dash. Every one of these is something a
 * formatter would "tidy".
 */
const AWKWARD_GOAL =
  'Migrate the checkout module from Vue 2 to Vue 3.\n' +
  'The public API must not change — not one export.\n' +
  '\tNote: the codemod runs first.  ';

const AWKWARD_CRITERION =
  'All 47 components under packages/ui/src/** compile under Vue 3 with no type errors:\n' +
  '1. `pnpm -r typecheck` exits zero.\n' +
  '2.  no component was deleted rather than migrated.\n' +
  '*  and the build still runs.';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

suite('compilePinnedSegments preserves the author’s bytes (AC2)', () => {
  it('quotes every pinned spec string byte-identically into its segment', () => {
    const spec = approvedSpec();
    const compiled = compilePinnedSegments(spec, NODE);

    for (const segment of compiled) {
      for (const quote of segment.quoted) {
        expect(segment.text).toContain(quote.text);
      }
    }
  });

  it("every spec-sourced run is a byte-exact slice of the approved spec's canonical form", () => {
    const spec = approvedSpec();
    const canonical = canonicalSpecText(spec);

    // `pathScopes` and `permission` are the node's, not the spec's — F1.5 pins
    // six fields and the document only holds four of them.
    const quotes = compilePinnedSegments(spec, NODE)
      .flatMap((segment) => segment.quoted)
      .filter((quote) => quote.field !== 'pathScopes' && quote.field !== 'permission');

    expect(quotes.length).toBeGreaterThan(0);
    for (const quote of quotes) expect(canonical).toContain(quote.text);
  });

  it('does not reflow, re-wrap or normalise a bullet', () => {
    const spec = approvedSpec({
      goal: AWKWARD_GOAL,
      acceptanceCriteria: [{ id: 'ac-3', statement: AWKWARD_CRITERION }],
    });
    const compiled = compilePinnedSegments(spec, NODE);
    const goalSegment = compiled.find((segment) => segment.id === 'pinned-spec-goal');
    const criteria = compiled.find((segment) => segment.id === 'pinned-spec-criteria');

    // The bytes, not a normalised rendering of them.
    expect(goalSegment?.text).toContain(AWKWARD_GOAL);
    expect(criteria?.text).toContain(AWKWARD_CRITERION);
    expect(canonicalSpecText(spec)).toContain(AWKWARD_GOAL);
    expect(canonicalSpecText(spec)).toContain(AWKWARD_CRITERION);
  });

  it('compiles the fixture spec to a stable golden rendering', () => {
    expect(compilePinnedSegments(approvedSpec(), NODE)).toMatchSnapshot();
  });

  it('is total: a spec with no non-goals and a node with no write scope still compiles', () => {
    const spec = approvedSpec({ nonGoals: [], constraints: [] });
    const compiled = compilePinnedSegments(spec, { pathScopes: [], permission: 'read' });

    expect(compiled.map((segment) => segment.id)).toEqual([
      'pinned-spec-goal',
      'pinned-spec-criteria',
      'pinned-constraints-safety',
      'pinned-pathscope',
      'pinned-constraints-permission',
    ]);
    for (const segment of compiled) expect(segment.text.length).toBeGreaterThan(0);
  });
});

suite('compilePinnedSegments is pure (AC2)', () => {
  it('returns deeply equal results for a deep-frozen spec called twice', () => {
    const spec = deepFreeze(approvedSpec());
    const node = deepFreeze({ ...NODE });

    const first = compilePinnedSegments(spec, node);
    const second = compilePinnedSegments(spec, node);

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });

  /**
   * "No port constructed" is enforced structurally rather than by trapping a
   * global: `packages/core/test/purity.test.ts` greps every file under
   * `packages/core/src` for a `node:` import, a `Date.now` and a `Math.random`,
   * so a clock read in the compiler is a red test in a suite nobody can skip
   * past. What is left to assert here is the half a grep cannot see — that the
   * call is synchronous, because a promise would mean a hash, a file read or a
   * network call snuck in behind an `await`.
   */
  it('constructs no port: the call is synchronous', () => {
    const compiled = compilePinnedSegments(approvedSpec(), NODE);

    expect(compiled).not.toBeInstanceOf(Promise);
    expect(compiled.length).toBe(5);
  });

  it('does not mutate the constraints it is handed', () => {
    const constraints = deepFreeze<readonly Constraint[]>([
      { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
      { form: 'allow-only', subject: 'write-path', allowed: ['src/checkout/**'] },
    ]);
    expect(() => compilePinnedSegments(approvedSpec(), NODE, constraints)).not.toThrow();
  });
});

/**
 * AC2 is a claim about the bytes a *packet* carries, so it is only worth
 * anything if the packet builder composes them here. `buildPinnedSegments` is
 * the one producer of `pinned: true` and the digests in `spec.pinned` are of
 * its output; if it composed its own copy of the same five texts, the property
 * the suite above proves would be about a function nothing calls.
 */
suite('compilePinnedSegments is the only composer of the pinned bytes (AC2)', () => {
  it('renders exactly the text buildPinnedSegments puts in the packet', async () => {
    const spec = approvedSpec();
    const constraints: readonly Constraint[] = [
      { form: 'require', statement: 'keep the codemod commit separate' },
    ];

    const built = await buildPinnedSegments({
      spec,
      node: NODE,
      constraints,
      sourceEvent: EventSeqSchema.parse(7),
    });
    const compiled = compilePinnedSegments(spec, NODE, constraints);

    expect(
      built.map((segment) => ({ id: segment.id, kind: segment.kind, text: segment.text })),
    ).toEqual(
      compiled.map((segment) => ({ id: segment.id, kind: segment.kind, text: segment.text })),
    );
  });

  /**
   * AC6 — the KAR-09.4 restatement pass has to run on the way *into* the
   * packet, not on a copy nobody ships. A `forbid` over `write-path` whose
   * node declares a positive scope must reach the prompt as the positive form.
   */
  it('applies the forbid → allow-only restatement to the bytes the packet carries', async () => {
    const spec = approvedSpec({ constraints: [] });
    const constraints: readonly Constraint[] = [
      { form: 'forbid', subject: 'write-path', forbidden: ['packages/legacy/**'] },
      { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
    ];

    const [safety] = (
      await buildPinnedSegments({
        spec,
        node: NODE,
        constraints,
        sourceEvent: EventSeqSchema.parse(7),
      })
    ).filter((segment) => segment.id === 'pinned-constraints-safety');

    // The positive form, from what the node declared — and the residual
    // prohibition last, because it has no closed positive form.
    expect(safety?.text).toContain('only write files under src/checkout/**');
    expect(safety?.text).not.toContain('do not write-path');
    expect(safety?.text.indexOf('do not exfiltrate credentials')).toBeGreaterThan(
      safety?.text.indexOf('only write files under') ?? 0,
    );
  });

  /**
   * AC6's last clause. `DeFlow doctor` reports forbid-over-allow-only and a
   * rising ratio is the leading indicator of the §4.2 decay, so the number has
   * to be a count of what the prompt *says* — not of what the caller passed in
   * before the restatement pass ran on it.
   */
  it('counts the constraints the packet renders, after restatement', async () => {
    const spec = approvedSpec({ constraints: [] });
    const build = await buildPacket({
      runId: 'run_20260807T090000Z_a1b2c3',
      nodeId: 'implement',
      attempt: 1,
      builtAtEvent: 7,
      target: { provider: 'claude-code', model: 'sonnet', maxContext: 200_000 },
      pinned: {
        spec,
        node: NODE,
        constraints: [
          { form: 'forbid', subject: 'write-path', forbidden: ['packages/legacy/**'] },
          { form: 'forbid', subject: 'exfiltrate credentials', forbidden: ['.env'] },
        ],
        sourceEvent: 7,
      },
    });

    // One prohibition had a closed positive form and is no longer one; the
    // other genuinely has none and is still counted as a `forbid`.
    expect(build.constraints).toEqual({ allowOnly: 1, require: 0, forbid: 1 });
  });
});
