/**
 * KAR-07.3 AC6 — the pure matcher behind the repo-wide grep
 * (test/generated-ref-call-sites.test.ts). Exercised directly here, over
 * synthetic source snippets, so the policy check is proven non-vacuous
 * rather than trusted to have caught something by accident.
 *
 * Verifies: EPIC-07-S8's third scenario · KAR-07.3 AC6.
 */
import { expect, it, describe as suite } from 'vitest';
import { findUnguardedGeneratedRefCalls } from './generated-ref-usage.ts';

suite('findUnguardedGeneratedRefCalls', () => {
  it('flags a bare positional call to nodeBranch(', () => {
    const source = "git.run(['branch', nodeBranch(runId, nodeId)]);";
    expect(findUnguardedGeneratedRefCalls(source)).toHaveLength(1);
  });

  it('flags a bare positional call to integrationBranch(', () => {
    const source = "git.run(['branch', integrationBranch(runId)]);";
    expect(findUnguardedGeneratedRefCalls(source)).toHaveLength(1);
  });

  it('accepts a "--"-guarded call', () => {
    const source = "git.run(['branch', '--', nodeBranch(runId, nodeId)]);";
    expect(findUnguardedGeneratedRefCalls(source)).toEqual([]);
  });

  it('accepts the double-quoted "--" guard too', () => {
    const source = 'git.run(["branch", "--", nodeBranch(runId, nodeId)]);';
    expect(findUnguardedGeneratedRefCalls(source)).toEqual([]);
  });

  it('accepts the --branch=<value> long-form template', () => {
    const source = "git.run(['worktree', 'add', `--branch=${nodeBranch(runId, nodeId)}`, path]);";
    expect(findUnguardedGeneratedRefCalls(source)).toEqual([]);
  });

  it('reports the correct line number', () => {
    const source = ['const a = 1;', 'const b = 2;', "git.run(['branch', nodeBranch(r, n)]);"].join(
      '\n',
    );
    const offenders = findUnguardedGeneratedRefCalls(source);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]?.line).toBe(3);
  });

  it('accepts a branch named as a workspace request field, never as argv', () => {
    // KAR-19.5's call site: the value goes to `WorkspaceManager.provision`,
    // whose argv builder puts it in `-b`'s value slot. See the module note for
    // why a field name is a guard and not an exception.
    const source = [
      'await workspace.provision({',
      '  mode: "write",',
      '  branch: nodeBranch(runRef(runId), node),',
      '});',
      'await workspace.remove({ salvageBranch: nodeBranch(runRef(runId), node) });',
    ].join('\n');
    expect(findUnguardedGeneratedRefCalls(source)).toEqual([]);
  });

  it('still flags a branch built into argv even when a field of that name exists', () => {
    // The guard is the *immediately preceding* field name, not the presence of
    // one anywhere: an argv element is still an argv element.
    const source = "git.run(['branch', nodeBranch(r, n)], { branch: 'x' });";
    expect(findUnguardedGeneratedRefCalls(source)).toHaveLength(1);
  });

  it('finds nothing in source with no such call at all', () => {
    expect(findUnguardedGeneratedRefCalls("git.run(['status']);")).toEqual([]);
  });

  it('flags every unguarded occurrence, not just the first', () => {
    const source = [
      "git.run(['branch', nodeBranch(r, n)]);",
      "git.run(['push', 'origin', integrationBranch(r)]);",
    ].join('\n');
    expect(findUnguardedGeneratedRefCalls(source)).toHaveLength(2);
  });
});
