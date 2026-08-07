/**
 * KAR-02.3 — `readsAreSatisfiable`, the pure reachability walk that catches an
 * undeclared read before a token is spent (docs/04-domain-model.md §3.1).
 *
 * The twelve-node plan below is built rather than read from a JSON file
 * because every scenario in EPIC-02-S11 is the *same* plan with one thing
 * moved: the write removed, the writer demoted from ancestor to sibling, the
 * read widened to a prefix. A builder makes that one flag per scenario; twelve
 * hand-maintained JSON copies would make it twelve files that drift.
 *
 * Verifies: EPIC-02-S11 · AC6
 */
import { expect, it, describe as suite } from 'vitest';
import { type PlanGraph, PlanGraphSchema } from './plan-graph.ts';
import { readsAreSatisfiable } from './reads-satisfiable.ts';
import { validateDeclaredReads } from './validate-declared-reads.ts';

interface Shape {
  /** Does `recon-auth-surface` declare the write that `implement-auth` reads? */
  readonly reconWrites: boolean;
  /** Move `recon-auth-surface` off the ancestor chain and alongside
   * `implement-auth` — a parallel node writing a fact you read is a race, not
   * a dependency. */
  readonly reconIsSibling: boolean;
  /** Widen `summarise`'s read to the `finding/*` prefix form. */
  readonly summariseReadsPrefix: boolean;
  /** Drop every edge, leaving `deps` as the only statement of ancestry. */
  readonly withoutEdges?: boolean;
}

const RETURNS = { schemaId: 'DeFlow.finding.v1', maxTokens: 500 };

function agent(
  id: string,
  deps: string[],
  extra: { reads?: unknown[]; writes?: unknown[] } = {},
): Record<string, unknown> {
  return {
    id,
    title: id,
    type: 'agent',
    deps,
    lifecycle: 'active',
    reads: extra.reads ?? [],
    writes: extra.writes ?? [],
    permission: 'read',
    pathScopes: { write: [] },
    returns: RETURNS,
    brief: `Do ${id}.`,
    provider: { prefer: ['claude-code'], requires: [] },
    resume: 'native-if-available',
  };
}

const AUTH_FACT = 'finding/auth-uses-jwt';

function twelveNodePlan(shape: Shape): PlanGraph {
  const reconWrite = { kind: 'fact', key: AUTH_FACT, schemaId: 'DeFlow.finding.v1' };
  const nodes = [
    agent(
      'recon-auth-surface',
      shape.reconIsSibling ? ['draft-plan'] : [],
      shape.reconWrites ? { writes: [reconWrite] } : {},
    ),
    agent('recon-ui-surface', []),
    agent(
      'draft-plan',
      shape.reconIsSibling ? ['recon-ui-surface'] : ['recon-auth-surface', 'recon-ui-surface'],
    ),
    agent('implement-auth', ['draft-plan'], {
      reads: [
        { kind: 'fact', key: AUTH_FACT },
        { kind: 'spec', section: 'constraints' },
      ],
    }),
    agent('implement-ui', ['draft-plan']),
    agent('gate-typecheck', ['implement-auth', 'implement-ui']),
    agent('gate-tests', ['gate-typecheck']),
    agent('summarise', ['gate-tests'], {
      reads: shape.summariseReadsPrefix ? [{ kind: 'fact', key: 'finding/*' }] : [],
    }),
    agent('approve-release', ['summarise']),
    agent('ship-it', ['approve-release']),
    agent('notify-team', ['ship-it']),
    agent('archive-run', ['notify-team']),
  ];

  const edges = shape.withoutEdges
    ? []
    : nodes.flatMap((node) =>
        (node.deps as string[]).map((from) => ({ from, to: node.id as string, kind: 'control' })),
      );

  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: 'run_20260802T141133Z_9f2a1c',
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'a'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes,
    edges,
  });
}

/** A minimal graph around a handful of nodes, for the cases that are about
 * the walk rather than about a realistic plan. */
function graphOf(nodes: Record<string, unknown>[]): PlanGraph {
  return PlanGraphSchema.parse({
    schemaId: 'DeFlow.plangraph.v1',
    runId: 'run_20260802T141133Z_9f2a1c',
    version: 1,
    planHash: `sha256-${'0'.repeat(64)}`,
    parent: null,
    taskSpecHash: `sha256-${'a'.repeat(64)}`,
    createdBy: 'planner',
    createdAt: '2026-08-02T14:11:33.000Z',
    nodes,
    edges: [],
  });
}

suite('readsAreSatisfiable — EPIC-02-S11', () => {
  it('is exactly twelve nodes, so "no ancestor writes it" is a real walk', () => {
    expect(
      twelveNodePlan({ reconWrites: true, reconIsSibling: false, summariseReadsPrefix: false })
        .nodes,
    ).toHaveLength(12);
  });

  it('reports exactly one violation for a dangling fact read', () => {
    const violations = readsAreSatisfiable(
      twelveNodePlan({ reconWrites: false, reconIsSibling: false, summariseReadsPrefix: false }),
    );
    expect(violations).toEqual([{ node: 'implement-auth', read: AUTH_FACT }]);
  });

  it('accepts a write declared by an ancestor two hops up', () => {
    expect(
      readsAreSatisfiable(
        twelveNodePlan({ reconWrites: true, reconIsSibling: false, summariseReadsPrefix: false }),
      ),
    ).toEqual([]);
  });

  it('does not accept a write declared by a sibling — that is a race, not a dependency', () => {
    const violations = readsAreSatisfiable(
      twelveNodePlan({ reconWrites: true, reconIsSibling: true, summariseReadsPrefix: false }),
    );
    expect(violations).toEqual([{ node: 'implement-auth', read: AUTH_FACT }]);
  });

  it('accepts the prefix form finding/* against an ancestor writing finding/auth-uses-jwt', () => {
    expect(
      readsAreSatisfiable(
        twelveNodePlan({ reconWrites: true, reconIsSibling: false, summariseReadsPrefix: true }),
      ),
    ).toEqual([]);
  });

  it('reports the prefix form when nothing an ancestor writes matches it', () => {
    const violations = readsAreSatisfiable(
      twelveNodePlan({ reconWrites: false, reconIsSibling: false, summariseReadsPrefix: true }),
    );
    expect(violations).toContainEqual({ node: 'summarise', read: 'finding/*' });
  });

  it('treats a spec read as satisfiable regardless of ancestry', () => {
    // implement-auth reads { kind: 'spec', section: 'constraints' } in every
    // shape above, and never appears as a violation for it.
    const violations = readsAreSatisfiable(
      twelveNodePlan({ reconWrites: false, reconIsSibling: false, summariseReadsPrefix: false }),
    );
    expect(violations.map((violation) => violation.read)).not.toContain('constraints');
  });

  it('walks deps even when the graph declares no edges', () => {
    expect(
      readsAreSatisfiable(
        twelveNodePlan({
          reconWrites: true,
          reconIsSibling: false,
          summariseReadsPrefix: true,
          withoutEdges: true,
        }),
      ),
    ).toEqual([]);
  });
});

suite('readsAreSatisfiable — the walk itself', () => {
  it('does not let a node satisfy its own read', () => {
    const violations = readsAreSatisfiable(
      graphOf([
        agent('self-serving', [], {
          reads: [{ kind: 'fact', key: 'finding/x' }],
          writes: [{ kind: 'fact', key: 'finding/x', schemaId: 'DeFlow.finding.v1' }],
        }),
      ]),
    );
    expect(violations).toEqual([{ node: 'self-serving', read: 'finding/x' }]);
  });

  it('never treats an artifact read as a violation — a handle is content-addressed, not planned', () => {
    const violations = readsAreSatisfiable(
      graphOf([
        agent('reads-an-artifact', [], {
          reads: [{ kind: 'artifact', handle: `artifact://${'b'.repeat(64)}` }],
        }),
      ]),
    );
    expect(violations).toEqual([]);
  });

  it('terminates on a dependency cycle instead of recursing forever', () => {
    // Cycles are the full validator's to reject (KAR-11.2). This walk must
    // still return.
    const violations = readsAreSatisfiable(
      graphOf([
        agent('a', ['b'], { reads: [{ kind: 'fact', key: 'finding/x' }] }),
        agent('b', ['a']),
      ]),
    );
    expect(violations).toEqual([{ node: 'a', read: 'finding/x' }]);
  });

  it('ignores a dep that names a node the graph does not contain', () => {
    const violations = readsAreSatisfiable(
      graphOf([agent('orphan', ['ghost'], { reads: [{ kind: 'fact', key: 'finding/x' }] })]),
    );
    expect(violations).toEqual([{ node: 'orphan', read: 'finding/x' }]);
  });

  it('reports one violation per unsatisfied read, in deterministic (node, read) order', () => {
    const violations = readsAreSatisfiable(
      graphOf([
        agent('first', [], { reads: [{ kind: 'fact', key: 'finding/a' }] }),
        agent('second', [], {
          reads: [
            { kind: 'fact', key: 'finding/b' },
            { kind: 'fact', key: 'finding/c' },
          ],
        }),
      ]),
    );
    expect(violations).toEqual([
      { node: 'first', read: 'finding/a' },
      { node: 'second', read: 'finding/b' },
      { node: 'second', read: 'finding/c' },
    ]);
  });
});

/**
 * KAR-02.3 and KAR-09.1 are the same gate — "every declared read is satisfied
 * by an ancestor's declared write or by the pinned spec", PRD F6.2 — described
 * once in [04-domain-model §3.1] and once in [08-context-and-memory §2.1].
 * They are two names in the public API because both epics' acceptance criteria
 * name their own, and both are already exported; they must never again be two
 * *implementations*, because two implementations is how a graph gets accepted
 * on the `plan.proposed` path and rejected on the `plan.patched` path.
 *
 * `readsAreSatisfiable` is therefore the KAR-02.3-shaped view of
 * `validateDeclaredReads`, and this suite is what holds it there.
 */
suite('readsAreSatisfiable — one gate, one implementation (KAR-02.3 / KAR-09.1)', () => {
  const GLOB_WRITE = { kind: 'fact', key: 'finding/*', schemaId: 'DeFlow.finding.v1' };

  it('accepts an exact read against an ancestor that writes the finding/* prefix form', () => {
    // A `WriteDecl` may carry the prefix form just as a `ReadDecl` may: a recon
    // node that cannot know its findings' names up front declares the
    // namespace it produces into. Matching only the read side makes that a
    // false rejection of a sound plan.
    const violations = readsAreSatisfiable(
      graphOf([
        agent('recon-auth-surface', [], { writes: [GLOB_WRITE] }),
        agent('implement', ['recon-auth-surface'], { reads: [{ kind: 'fact', key: AUTH_FACT }] }),
      ]),
    );
    expect(violations).toEqual([]);
  });

  it('still refuses a near-miss where neither side carries a glob to anchor on', () => {
    const violations = readsAreSatisfiable(
      graphOf([
        agent('recon', [], {
          writes: [{ kind: 'fact', key: 'finding/auth', schemaId: 'DeFlow.finding.v1' }],
        }),
        agent('implement', ['recon'], { reads: [{ kind: 'fact', key: 'finding/authz' }] }),
      ]),
    );
    expect(violations).toEqual([{ node: 'implement', read: 'finding/authz' }]);
  });

  const corpus: { readonly name: string; readonly graph: PlanGraph }[] = [
    {
      name: 'a sound twelve-node plan',
      graph: twelveNodePlan({
        reconWrites: true,
        reconIsSibling: false,
        summariseReadsPrefix: true,
      }),
    },
    {
      name: 'a twelve-node plan with a dangling read',
      graph: twelveNodePlan({
        reconWrites: false,
        reconIsSibling: false,
        summariseReadsPrefix: true,
      }),
    },
    {
      name: 'a twelve-node plan whose producer is a sibling',
      graph: twelveNodePlan({
        reconWrites: true,
        reconIsSibling: true,
        summariseReadsPrefix: false,
      }),
    },
    {
      name: 'an ancestor writing the glob form',
      graph: graphOf([
        agent('recon-auth-surface', [], { writes: [GLOB_WRITE] }),
        agent('implement', ['recon-auth-surface'], { reads: [{ kind: 'fact', key: AUTH_FACT }] }),
      ]),
    },
    {
      name: 'a spec read with no ancestor at all',
      graph: graphOf([agent('frame', [], { reads: [{ kind: 'spec', section: 'criteria' }] })]),
    },
    {
      name: 'an artifact read',
      graph: graphOf([
        agent('reads-an-artifact', [], {
          reads: [{ kind: 'artifact', handle: `artifact://${'b'.repeat(64)}` }],
        }),
      ]),
    },
    {
      name: 'violations declared out of alphabetical order',
      graph: graphOf([
        agent('zeta', [], { reads: [{ kind: 'fact', key: 'finding/z' }] }),
        agent('alpha', [], { reads: [{ kind: 'fact', key: 'finding/a' }] }),
      ]),
    },
    {
      name: 'a dependency cycle',
      graph: graphOf([
        agent('a', ['b'], { reads: [{ kind: 'fact', key: 'finding/x' }] }),
        agent('b', ['a']),
      ]),
    },
  ];

  it.each(corpus)('agrees with validateDeclaredReads on $name', ({ graph }) => {
    expect(readsAreSatisfiable(graph)).toEqual(
      validateDeclaredReads(graph).map((error) => ({ node: error.node, read: error.key })),
    );
  });
});
