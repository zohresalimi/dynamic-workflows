/**
 * KAR-05.1 AC6 — no business logic in an ACP handler.
 *
 * ACP v2 deletes `fs/read_text_file`, `fs/write_text_file` and all five
 * `terminal/*` methods from the client and pushes them onto MCP (verified by
 * diffing the SDK's v1 and v2 `CLIENT_METHODS`). When that lands, the MCP front
 * is re-pointed and the ACP front is deleted — which is only a deletion if the
 * security-sensitive code was never in it.
 *
 * A line count is a blunt instrument and that is the point: it cannot be
 * argued with, and the first thing anyone does when leaking policy into a
 * transport handler is write more lines.
 *
 * Verifies: EPIC-05-S5 (scenario 4) · AC6 · test plan #8
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const FRONTS = fileURLToPath(new URL('../src/services/fronts/', import.meta.url));

const read = (name: string): string => readFileSync(join(FRONTS, name), 'utf8');
const lines = (name: string): number => read(name).trimEnd().split('\n').length;

/** The four permission levels, as `PERMISSION_LEVELS` spells them. A front
 * that mentions one is deciding something it must not decide. */
const PERMISSION_LITERALS = /'(read|worktree|worktree\+net|full)'/;

suite('the ACP fronts are thin', () => {
  it('acp-fs.ts is under 40 lines', () => {
    expect(lines('acp-fs.ts')).toBeLessThan(40);
  });

  it('acp-terminal.ts is under 60 lines', () => {
    expect(lines('acp-terminal.ts')).toBeLessThan(60);
  });

  it('acp-permission.ts is under 40 lines', () => {
    expect(lines('acp-permission.ts')).toBeLessThan(40);
  });
});

suite('the ACP fronts contain no policy', () => {
  const files = readdirSync(FRONTS).filter((name) => name.startsWith('acp-'));

  it('covers every front there is, so a new one cannot opt out', () => {
    expect(files.sort()).toEqual(['acp-fs.ts', 'acp-permission.ts', 'acp-terminal.ts']);
  });

  it.for(files)('%s branches on nothing and delegates everything', (name) => {
    const source = read(name)
      // Comments explain the rule; code must not implement it.
      .replaceAll(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

    expect(source).not.toMatch(PERMISSION_LITERALS);
    expect(source).not.toMatch(/\bif\s*\(/);
    expect(source).not.toMatch(/\bswitch\s*\(/);
    // Delegation, not implementation: no filesystem and no child processes in
    // a transport handler.
    expect(source).not.toMatch(/node:fs|node:child_process/);
    expect(source).toMatch(/-service\.ts/);
  });
});
