/**
 * KAR-07.5 — the number shown before a fan-out is authorized
 * (docs/09-workspace-and-safety.md §5.3; EPIC-07-S22).
 *
 * The formula is `N × (tracked working tree)  +  N × node_modules`, with the
 * second term collapsing to ~0 under pnpm's content-addressable store. There
 * is **no `.git` term**, and its absence is a verified fact rather than an
 * omission: a 300 KB `.git` served a 24 KB worktree with no object
 * duplication, because the object store is shared. A per-worktree `.git` term
 * would overstate an 8-node fan-out on a large repository by gigabytes and
 * make the whole figure ignorable.
 *
 * Units are binary (`1 MB = 1024 KB`), the same convention `du -h` uses, which
 * is what makes §5.3's worked example come out at "approximately 7.2 GB".
 *
 * Verifies: EPIC-07-S22
 */
import { expect, it, describe as suite } from 'vitest';
import { estimateFanOutDisk, formatBytes, renderDiskEstimate } from './disk-estimate.ts';

const MB = 1024 * 1024;

suite('the estimate formula (EPIC-07-S22)', () => {
  const npm = estimateFanOutDisk({
    nodes: 8,
    trackedBytes: 120 * MB,
    nodeModulesBytes: 800 * MB,
    manager: 'npm',
  });

  it('is 8 × (120 MB + 800 MB), rendered as approximately 7.2 GB', () => {
    expect(npm.totalBytes).toBe(8 * (120 * MB + 800 * MB));
    expect(formatBytes(npm.totalBytes)).toBe('7.2 GB');
  });

  it('breaks the tracked-tree term out from the node_modules term', () => {
    expect(npm.terms).toEqual([
      { label: 'tracked working tree', perNodeBytes: 120 * MB, totalBytes: 8 * 120 * MB },
      { label: 'node_modules', perNodeBytes: 800 * MB, totalBytes: 8 * 800 * MB },
    ]);
  });

  it('names no .git term — the object store is shared', () => {
    expect(npm.terms.map((term) => term.label).join(' ')).not.toContain('.git');
    expect(renderDiskEstimate(npm)).not.toContain('.git');
  });

  it('says the same for yarn, which also pays a full copy per worktree', () => {
    const yarn = estimateFanOutDisk({
      nodes: 8,
      trackedBytes: 120 * MB,
      nodeModulesBytes: 800 * MB,
      manager: 'yarn',
    });

    expect(yarn.totalBytes).toBe(npm.totalBytes);
  });
});

suite('pnpm collapses the second term (EPIC-07-S22)', () => {
  const pnpm = estimateFanOutDisk({
    nodes: 8,
    trackedBytes: 120 * MB,
    nodeModulesBytes: 800 * MB,
    manager: 'pnpm',
  });

  it('reports the node_modules term as approximately zero', () => {
    expect(pnpm.terms[1]?.totalBytes).toBe(0);
    expect(pnpm.sharesStore).toBe(true);
  });

  it('totals approximately 960 MB', () => {
    expect(pnpm.totalBytes).toBe(960 * MB);
    expect(formatBytes(pnpm.totalBytes)).toBe('960 MB');
  });

  it('explains itself by naming the content-addressable store', () => {
    expect(renderDiskEstimate(pnpm)).toContain('content-addressable store');
  });

  it('does not claim a store for npm', () => {
    expect(
      renderDiskEstimate(estimateFanOutDisk({ nodes: 2, trackedBytes: MB, manager: 'npm' })),
    ).not.toContain('content-addressable store');
  });
});

suite('the rendered figure', () => {
  it('uses binary units with du -h’s labels', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(120 * MB)).toBe('120 MB');
    expect(formatBytes(1024 * MB)).toBe('1.0 GB');
  });

  it('drops the fractional digit at ten, where a tenth stops being a tenth of the reading', () => {
    expect(formatBytes(9 * 1024)).toBe('9.0 KB');
    expect(formatBytes(45 * 1024)).toBe('45 KB');
  });

  it('handles a repository with no dependencies at all', () => {
    const bare = estimateFanOutDisk({ nodes: 4, trackedBytes: 10 * MB, manager: null });

    expect(bare.totalBytes).toBe(40 * MB);
    expect(bare.terms[1]?.totalBytes).toBe(0);
  });

  it('refuses a node count below one rather than reporting a negative fan-out', () => {
    expect(() => estimateFanOutDisk({ nodes: 0, trackedBytes: MB, manager: 'npm' })).toThrow(
      RangeError,
    );
  });
});
