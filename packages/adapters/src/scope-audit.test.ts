/**
 * KAR-08.7 AC3, AC5 — the completion-time backstop as the node runners reach
 * it: when it runs, what it appends, and when it refuses to run at all.
 *
 * The *diffing* is the daemon's (`services/scope-diff.ts`, over a real git
 * repository — this package spawns no `git`). What is proved here is the half
 * that lives on the completion path: a node with no declared scope costs
 * nothing, a clean node appends nothing, a violating node appends exactly one
 * `node.scope_warning` carrying the auditor's own two fields — and a node that
 * declares a scope with no auditor wired behind it is refused *before* it is
 * spawned, rather than completing with a backstop that was never there.
 *
 * Verifies: EPIC-08-S30 · AC3, AC5
 */
import {
  EventSeqSchema,
  NodeFailureError,
  NodeIdSchema,
  NodeScopeWarningSchema,
} from '@DeFlow/core';
import { TestClock } from '@DeFlow/testkit';
import { expect, it, describe as suite } from 'vitest';
import type { EventRecord, LedgerSink } from './ports.ts';
import { auditCompletionScope, type ScopeAudit, scopeAuditRefusal } from './scope-audit.ts';

const NODE = NodeIdSchema.parse('implement');
const WORKTREE = '/tmp/wt/implement';

/** A sink that records what it was asked to append, and nothing else: the
 * ledger's own behaviour is @DeFlow/ledger's to prove. */
function recordingSink(): { readonly sink: LedgerSink; readonly appended: EventRecord[] } {
  const appended: EventRecord[] = [];
  const sink: LedgerSink = {
    append: (event) => {
      appended.push(event);
      return Promise.resolve(EventSeqSchema.parse(appended.length));
    },
    appendIo: () => Promise.resolve(EventSeqSchema.parse(1)),
  };
  return { sink, appended };
}

const auditor = (paths: readonly string[]): ScopeAudit => {
  return (request) =>
    Promise.resolve(
      paths.length === 0
        ? null
        : {
            node: request.node,
            attempt: request.attempt,
            declared: [...request.declared],
            paths: [...paths],
          },
    );
};

suite('auditCompletionScope — the check the node runners run before completing', () => {
  it('does nothing at all for a node that declared no scope', async () => {
    const { sink, appended } = recordingSink();
    let called = 0;
    const audit: ScopeAudit = (request) => {
      called += 1;
      return Promise.resolve({ node: request.node, attempt: 0, declared: [], paths: ['x'] });
    };

    const warning = await auditCompletionScope(
      { node: NODE, attempt: 0, worktree: WORKTREE, declared: undefined },
      { clock: new TestClock(), ledger: sink, scopeAudit: audit },
    );

    expect(warning).toBeNull();
    expect(called).toBe(0);
    expect(appended).toEqual([]);
  });

  it('does nothing for an empty declared scope — that is plan validation’s (AC1)', async () => {
    const { sink, appended } = recordingSink();
    let called = 0;
    const audit: ScopeAudit = (request) => {
      called += 1;
      return Promise.resolve({ node: request.node, attempt: 0, declared: [], paths: ['x'] });
    };

    const warning = await auditCompletionScope(
      { node: NODE, attempt: 0, worktree: WORKTREE, declared: [] },
      { clock: new TestClock(), ledger: sink, scopeAudit: audit },
    );

    expect(warning).toBeNull();
    expect(called).toBe(0);
    expect(appended).toEqual([]);
  });

  it('appends nothing when every change stayed in scope', async () => {
    const { sink, appended } = recordingSink();

    const warning = await auditCompletionScope(
      { node: NODE, attempt: 2, worktree: WORKTREE, declared: ['src/**'] },
      { clock: new TestClock(), ledger: sink, scopeAudit: auditor([]) },
    );

    expect(warning).toBeNull();
    expect(appended).toEqual([]);
  });

  it('appends exactly one node.scope_warning, carrying the auditor’s fields', async () => {
    const { sink, appended } = recordingSink();
    const clock = new TestClock(1_700_000_000_000);

    const warning = await auditCompletionScope(
      { node: NODE, attempt: 2, worktree: WORKTREE, declared: ['src/**'] },
      { clock, ledger: sink, scopeAudit: auditor(['docs/readme.md']) },
    );

    expect(appended).toHaveLength(1);
    expect(appended[0]).toEqual({
      kind: 'node.scope_warning',
      v: 1,
      ts: 1_700_000_000_000,
      nodeId: NODE,
      attempt: 2,
      payload: { node: NODE, attempt: 2, declared: ['src/**'], paths: ['docs/readme.md'] },
    });
    expect(warning).toEqual(appended[0]?.payload);
  });

  it('appends a payload the published event schema accepts', () => {
    // The event is only useful if a reader can parse it back; a shape this
    // module invented would fail at the first `readRange`.
    expect(
      NodeScopeWarningSchema.parse({
        node: NODE,
        attempt: 2,
        declared: ['src/**'],
        paths: ['docs/readme.md'],
      }),
    ).toEqual({ node: NODE, attempt: 2, declared: ['src/**'], paths: ['docs/readme.md'] });
  });

  it('passes the worktree and the declared globs through to the auditor', async () => {
    const { sink } = recordingSink();
    const seen: unknown[] = [];
    const audit: ScopeAudit = (request) => {
      seen.push(request);
      return Promise.resolve(null);
    };

    await auditCompletionScope(
      { node: NODE, attempt: 1, worktree: WORKTREE, declared: ['src/**', '!src/generated/**'] },
      { clock: new TestClock(), ledger: sink, scopeAudit: audit },
    );

    expect(seen).toEqual([
      {
        node: NODE,
        attempt: 1,
        worktree: WORKTREE,
        declared: ['src/**', '!src/generated/**'],
      },
    ]);
  });
});

suite('scopeAuditRefusal — a declared scope with nothing behind it (AC3)', () => {
  it('refuses a node that declares a scope with no auditor wired', () => {
    const refusal = scopeAuditRefusal(['src/**'], undefined);

    expect(refusal).toBeInstanceOf(NodeFailureError);
    // `internal`, not an agent failure: an unwired backstop is DeFlow's own
    // misconfiguration, and it cannot fix itself between attempts.
    expect(refusal?.deflowFailure.reason).toBe('internal');
    expect(refusal?.deflowFailure.class).toBe('permanent');
    expect(refusal?.message).toContain('src/**');
  });

  it('admits a node whose auditor is wired', () => {
    expect(scopeAuditRefusal(['src/**'], auditor([]))).toBeNull();
  });

  it('admits a node that declares nothing, wired or not', () => {
    expect(scopeAuditRefusal(undefined, undefined)).toBeNull();
    expect(scopeAuditRefusal([], undefined)).toBeNull();
  });
});
