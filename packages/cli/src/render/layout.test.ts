/**
 * KAR-18.9 AC3, AC4 — wrapping and column alignment.
 *
 * The unbroken-token rule is the one worth writing down. A wrapper that breaks
 * on character count splits `/Users/…/pre-migrate-7.db` across two lines, and
 * the operator who copies it gets half a path — precisely at the moment they
 * most need to copy it. So a token wider than the whole column is emitted whole
 * on a line of its own and the line is allowed to be long, which is the one
 * deliberate exception to "no line exceeds the width".
 *
 * The alignment rule is the other half of the same complaint: a column width
 * that is a constant puts one long id's status out of line for the whole
 * section, so the width comes from the longest id **in that section**.
 *
 * Verifies: EPIC-18-S61 · AC3, AC4 · test plan #3, #4
 */
import { expect, it, describe as suite } from 'vitest';
import { columnWidth, wrapDetail } from './layout.ts';

/** 400 characters of prose, in words a wrapper can break between. */
const PROSE = Array.from({ length: 80 }, (_, index) => `word${index % 10}`)
  .join(' ')
  .slice(0, 400);

/** 120 characters of path, in one token a wrapper must not break. */
const LONG_PATH = `/tmp/DeFlow-fixture/${'segment/'.repeat(11)}pre-migrate-7.db`;

suite('EPIC-18-S61 — a paragraph that used to run off the edge (AC4)', () => {
  const INDENT = 12;

  it('wraps 400 characters of prose to 60 columns without splitting a word', () => {
    const lines = wrapDetail(PROSE, { width: 60, indent: INDENT });

    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(60);
    // Nothing was lost and nothing was cut in half: the words come back out in
    // the order they went in.
    expect(lines.join(' ').split(/\s+/).filter(Boolean)).toEqual(
      PROSE.split(/\s+/).filter(Boolean),
    );
  });

  it('indents every line after the first to the column the detail started at', () => {
    const lines = wrapDetail(PROSE, { width: 60, indent: INDENT });

    expect(lines[0]?.startsWith(' ')).toBe(false);
    for (const line of lines.slice(1)) {
      expect(line.startsWith(' '.repeat(INDENT))).toBe(true);
      expect(line[INDENT]).not.toBe(' ');
    }
  });

  it('emits a 120-character path whole, on a line of its own', () => {
    expect(LONG_PATH.length).toBeGreaterThan(100);
    const lines = wrapDetail(`the backup is at ${LONG_PATH} and it was kept`, {
      width: 60,
      indent: INDENT,
    });

    const carrying = lines.filter((line) => line.includes('/tmp/DeFlow-fixture/'));
    expect(carrying).toHaveLength(1);
    // Whole, and alone on its line: one token an operator can select and copy.
    expect(carrying[0]?.trim()).toBe(LONG_PATH);
    // And no fragment of it landed anywhere else.
    for (const line of lines) {
      if (line === carrying[0]) continue;
      expect(line).not.toContain('segment/');
    }
  });

  it('leaves a detail that already fits on one line', () => {
    expect(
      wrapDetail('git 2.51.0 supports merge-tree --write-tree', { width: 60, indent: 4 }),
    ).toEqual(['git 2.51.0 supports merge-tree --write-tree']);
  });

  it('survives an indent as wide as the terminal without looping or producing NaN', () => {
    const lines = wrapDetail(PROSE, { width: 20, indent: 40 });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('NaN');
  });
});

suite('column alignment comes from the longest id in the section (AC3)', () => {
  it('is the longest id, not a constant', () => {
    const ids = ['git.version', 'git.merge-tree', 'agents.claude.drift'];
    expect(columnWidth(ids)).toBe('agents.claude.drift'.length);
    // A different section, a different width — which is the point.
    expect(columnWidth(['memory.pty'])).toBe('memory.pty'.length);
    expect(columnWidth([])).toBe(0);
  });

  it('puts every status in a section at the same column', () => {
    const ids = ['runtime.node', 'runtime.pnpm', 'runtime.state-dir', 'runtime.workspace-dir'];
    const width = columnWidth(ids);
    const columns = ids.map((id) => `${id.padEnd(width)}  x`.indexOf('x'));
    expect(new Set(columns).size).toBe(1);
    expect(columns[0]).toBe('runtime.workspace-dir'.length + 2);
  });
});
