/**
 * KAR-17.2 — the field-level "why did this change" panel's content, test 4 of
 * the story's plan.
 *
 * Verifies: EPIC-17-S8 · AC5
 *
 * The red this is written against is *"the panel diffs rendered strings instead
 * of objects"*. So every fixture below is an **RFC 6902 operation** — an `op`,
 * a JSON Pointer `path` and a `value` — which is what `GET …/plans/diff` puts
 * on the wire, and what a line-diff of two pretty prints could never produce.
 * A panel fed a string diff cannot tell `/provider` from `/brief`, and it is a
 * failure that reads perfectly plausibly on screen.
 *
 * The operations are written out here rather than computed, because computing
 * them is not this side's job: `packages/daemon/src/plan/diff.ts` produces them
 * with `rfc6902@^5.3.0` over the two node documents, and
 * `packages/daemon/src/plan/diff.test.ts` is where **that** choice — and the
 * "never `fast-json-patch`" half of EPIC-17-S8's third scenario — is asserted.
 */
import { expect, it, describe as suite } from 'vitest';
import { describeOperations, escalationIn, type JsonPatchOperation } from './plan-patch.ts';

/** The provider re-route AC5 shows, exactly as the endpoint answers with it. */
const PROVIDER_REROUTE: readonly JsonPatchOperation[] = [
  { op: 'replace', path: '/provider/prefer/0', value: 'codex' },
];

/**
 * A `reads[]` change: an operation on a different pointer, not a longer string.
 *
 * `/reads/-` is RFC 6902 §4.1's append token and is exactly what the daemon's
 * `createPatch` emits for a value added past the end of an array
 * (`packages/daemon/src/plan/diff.test.ts`). Pinned here as the wire shape,
 * because the panel renders the pointer verbatim.
 */
const READS_WIDENED: readonly JsonPatchOperation[] = [
  { op: 'add', path: '/reads/-', value: { kind: 'fact', key: 'repo.layout' } },
];

const escalate = (to: string): readonly JsonPatchOperation[] => [
  { op: 'replace', path: '/permission', value: to },
];

suite('AC5 — the patch renders as operations over a node object', () => {
  it('renders a provider re-route as one replace on the provider path', () => {
    const lines = describeOperations(PROVIDER_REROUTE);

    expect(lines).toHaveLength(1);
    expect(lines[0]?.op).toBe('replace');
    expect(lines[0]?.path).toBe('/provider/prefer/0');
    expect(lines[0]?.value).toBe('codex');
    // The panel shows the operation as JSON, because that is what the
    // acceptance criterion shows an operator being shown.
    expect(lines[0]?.text).toContain('"op": "replace"');
    expect(lines[0]?.text).toContain('"value": "codex"');
  });

  it('renders a reads[] change on the reads pointer, with its object value intact', () => {
    const lines = describeOperations(READS_WIDENED);

    expect(lines[0]?.path).toBe('/reads/-');
    // The value is an *object*, and survives as one: a panel that stringified
    // on the way in could not tell a fact from a spec section.
    expect(lines[0]?.value).toEqual({ kind: 'fact', key: 'repo.layout' });
    expect(lines[0]?.text).toContain('"kind": "fact"');
  });

  it('gives every changed field its own operation on a multi-field patch', () => {
    const lines = describeOperations([
      { op: 'replace', path: '/permission', value: 'worktree+net' },
      { op: 'replace', path: '/retry/maxAttempts', value: 5 },
    ]);

    expect(lines.map((line) => line.path)).toEqual(['/permission', '/retry/maxAttempts']);
  });

  it('renders an operation with no value at all, rather than dropping it', () => {
    // `remove` carries no `value`, and a renderer that assumed one would show a
    // blank line where a field disappeared — which is the change most worth
    // seeing.
    const lines = describeOperations([{ op: 'remove', path: '/model' }]);

    expect(lines[0]?.op).toBe('remove');
    expect(lines[0]?.value).toBeUndefined();
    expect(lines[0]?.text).toContain('"path": "/model"');
  });
});

suite('AC5 — a permission escalation is called out distinctly', () => {
  it('names the escalation, because that is what the patch policy gates on', () => {
    expect(escalationIn(escalate('worktree+net'), 'worktree')).toEqual({
      from: 'worktree',
      to: 'worktree+net',
    });
  });

  it('marks the operation itself, so the line is legible without the summary', () => {
    const lines = describeOperations(escalate('full'), 'worktree');

    expect(lines.find((line) => line.path === '/permission')?.escalates).toBe(true);
  });

  it('says nothing when the permission went the other way', () => {
    // Narrowing a node's permission is not the thing F2.5 gates on, and calling
    // it out as one would train an operator to ignore the marker — which costs
    // exactly the escalation the marker exists for.
    expect(escalationIn(escalate('read'), 'worktree')).toBeNull();
  });

  it('says nothing when no permission operation is in the patch at all', () => {
    expect(escalationIn(PROVIDER_REROUTE, 'worktree')).toBeNull();
  });

  it('says nothing about a permission level the ladder does not know', () => {
    // Failing closed here would mark every unknown level as an escalation and
    // make the marker noise; failing open marks none and leaves the operation
    // itself on screen, which is the honest half of the answer.
    expect(escalationIn(escalate('root'), 'worktree')).toBeNull();
    expect(escalationIn(escalate('full'), 'godmode')).toBeNull();
  });

  it('marks nothing when the caller has no older permission to compare against', () => {
    expect(describeOperations(escalate('full')).every((line) => !line.escalates)).toBe(true);
  });
});
