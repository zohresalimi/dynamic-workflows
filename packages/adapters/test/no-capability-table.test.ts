/**
 * KAR-05.2 AC5 — the capability matrix exists only as data.
 *
 * A0-9 is the highest-value *silent* risk in this layer: a stale per-vendor
 * table does not produce an error, it produces a wrong routing decision hours
 * into a run. Two of the five versions in the 2026-08-02 snapshot were
 * published the same day they were measured, and the whole of KAR-05.2 exists
 * so that every routing answer comes from a row probed on this machine.
 *
 * A convenience constant — "we know Codex cannot fork" — would quietly
 * reintroduce it, and would look like a helpful optimisation in review. So the
 * rule is mechanical: **no file under `packages/adapters/src/` may name two or
 * more vendors in executable code.** Prose is exempt, because explaining that
 * Gemini omits `sessionCapabilities` where Codex answers an explicit `false`
 * is how the next reader understands why the three-way answer exists at all;
 * comments cannot route a node.
 *
 * Verifies: EPIC-05-S6 (scenario 3) · AC5 · test plan #8
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const srcDir = new URL('../src/', import.meta.url).pathname;

/** The five verified adapters, plus the two names their npm packages use. */
const VENDORS = [
  'claude',
  'codex',
  'gemini',
  'copilot',
  'opencode',
  'anthropic',
  'openai',
] as const;

/**
 * Removes block comments and whole-line `//` comments, leaving executable
 * source. Deliberately does not try to be a JavaScript lexer: it over-removes
 * at worst, which can only make this check *stricter* about what it still
 * sees, never blinder.
 */
export function strippedOfComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Every vendor named in `source`'s executable half, lowercased. */
function vendorsNamedIn(source: string): string[] {
  const code = strippedOfComments(source).toLowerCase();
  return VENDORS.filter((vendor) => code.includes(vendor));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const files = sourceFiles(srcDir);

suite('no source file under packages/adapters/src carries a vendor matrix', () => {
  it('found source files to check at all', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file.slice(srcDir.length)} names no more than one vendor in code`, () => {
      const named = vendorsNamedIn(readFileSync(file, 'utf8'));
      expect(
        named,
        `${file} names ${named.join(', ')} in executable code. The capability matrix is a ` +
          'probed row, never a constant: ask capability(row, key) instead.',
      ).toHaveLength(0);
    });
  }
});

suite('the check is not vacuous', () => {
  it('flags a convenience constant of exactly the kind AC5 forbids', () => {
    const tempting = `
      export const RESUME_BY_VENDOR = {
        claude: true,
        codex: true,
        gemini: false,
      } as const;
    `;
    expect(vendorsNamedIn(tempting)).toEqual(['claude', 'codex', 'gemini']);
  });

  it('does not flag prose that explains why the three-way answer exists', () => {
    const prose = `
      /**
       * Gemini returned no sessionCapabilities key at all, where Codex
       * answered an explicit false. Collapsing the two is the bug.
       */
      // Claude's response has no mcpCapabilities.acp either.
      export const CAPABILITY_PATHS = { resume: 'agentCapabilities.sessionCapabilities.resume' };
    `;
    expect(vendorsNamedIn(prose)).toEqual([]);
  });
});
