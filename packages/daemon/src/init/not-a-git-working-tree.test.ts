/**
 * KAR-22.1 AC1 — the refusal for a path that is not a git working tree is
 * **one string**, not two strings that currently agree.
 *
 * `deflow init` throws `NotAGitWorkingTree` and the projects API answers 400
 * with the same sentence. If those are two copies they agree on the day they
 * are written and disagree on the day one of them is improved — and nothing
 * fails, because each surface's own spec asserts its own copy. So the constant
 * is exported and both read it, and this guard is what says so.
 *
 * Unit, because it is a fact about the source rather than about a request.
 *
 * Verifies: EPIC-22-S3 · KAR-22.1 AC1 · test plan #3
 */
import { expect, it, describe as suite } from 'vitest';
import { NOT_A_GIT_WORKING_TREE, NotAGitWorkingTree } from './workspace-init.ts';

suite('EPIC-22-S3 — one sentence, two surfaces', () => {
  it("is the message deflow init's own error carries", () => {
    expect(new NotAGitWorkingTree('/somewhere').message).toBe(NOT_A_GIT_WORKING_TREE);
  });

  it('names the lowercase command, not the capitalised product name', () => {
    expect(NOT_A_GIT_WORKING_TREE).toContain('deflow init');
    expect(NOT_A_GIT_WORKING_TREE).not.toMatch(/\bDeFlow init\b/);
  });

  it('names what the operator does next', () => {
    expect(NOT_A_GIT_WORKING_TREE).toContain('git init');
  });

  it('is a single line, because it is rendered in a form field as well as a terminal', () => {
    expect(NOT_A_GIT_WORKING_TREE).not.toContain('\n');
  });
});
