/**
 * KAR-05.9 AC1 — no agent is ever spawned without `detached: true` and three
 * pipes, and the rule is enforced structurally rather than remembered.
 *
 * **Verified by measurement, not inference** (docs/07-provider-adapter-layer.md
 * §9.3). A bash script that backgrounds two children was spawned both ways:
 *
 * - `detached: false`, Node's default — the grandchildren's pgid was *DeFlowd's
 *   own process group*. `child.kill('SIGTERM')` killed only bash and both
 *   grandchildren kept running, and there is no group to kill instead, because
 *   signalling that group would kill DeFlowd itself.
 * - `detached: true` — the grandchildren's pgid equalled `child.pid`, and one
 *   `process.kill(-child.pid, …)` took the whole subtree.
 *
 * The failure mode of getting this wrong is not an error. It is a kill switch
 * that reports success while agents keep editing a worktree nobody is
 * supervising, and it is what most tutorials show. A `spawn` option is exactly
 * the kind of thing a later refactor "simplifies", so this file is the guard:
 * one grep over the package's own sources, with a non-vacuity check beside it.
 *
 * Verifies: EPIC-05-S30 (scenario 3) · AC1
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { codeOnly } from './no-path-lookup.test.ts';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * The argument text of every `spawn(...)` call in `source`, brackets balanced.
 *
 * A regular expression cannot do this: the options object contains its own
 * parentheses, braces and quotes, and a lazy `\(.*?\)` stops at the first `)`
 * inside `['pipe','pipe','pipe']`'s neighbours. Balancing is a dozen lines and
 * is the difference between a guard and a guard-shaped comment.
 */
export function spawnCallArguments(source: string): string[] {
  const code = codeOnly(source);
  const calls: string[] = [];
  const opener = /\bspawn(?:Sync)?\s*\(/g;

  for (const match of code.matchAll(opener)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let index = start;
    let quote: string | null = null;
    for (; index < code.length && depth > 0; index += 1) {
      const char = code[index];
      if (quote !== null) {
        if (char === '\\') index += 1;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "'" || char === '"' || char === '`') quote = char;
      else if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') depth -= 1;
    }
    calls.push(code.slice(start, index - 1));
  }
  return calls;
}

/** Whitespace-insensitive, so a formatter reflowing the object cannot break it. */
const flat = (text: string): string => text.replaceAll(/\s+/g, '');

export function spawnIsSupervisable(call: string): boolean {
  return (
    flat(call).includes('detached:true') && flat(call).includes("stdio:['pipe','pipe','pipe']")
  );
}

const files = sourceFiles(SRC);

suite('every agent spawn is detached with three pipes (AC1)', () => {
  const calls = files.flatMap((path) =>
    spawnCallArguments(readFileSync(path, 'utf8')).map((call) => ({ path, call })),
  );

  it('found agent spawns to check at all, or this guard proves nothing', () => {
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it('no spawn omits detached: true or the three pipes', () => {
    const offenders = calls
      .filter(({ call }) => !spawnIsSupervisable(call))
      .map(({ path, call }) => `${path.slice(SRC.length)}: spawn(${call.trim().slice(0, 80)}…)`);

    expect(
      offenders,
      "Without detached: true the grandchildren land in DeFlowd's own process group: " +
        'child.kill() reaches only the direct child, and group-killing would kill DeFlowd. ' +
        'Measured, not inferred — docs/07-provider-adapter-layer.md §9.3.',
    ).toEqual([]);
  });

  it('the check is not vacuous', () => {
    expect(
      spawnIsSupervisable("bin, argv, { detached: true, stdio: ['pipe','pipe','pipe'] }"),
    ).toBe(true);
    // The two ways to get it wrong, both of which look fine in review.
    expect(spawnIsSupervisable("bin, argv, { stdio: ['pipe','pipe','pipe'] }")).toBe(false);
    expect(spawnIsSupervisable('bin, argv, { detached: true }')).toBe(false);
    expect(spawnIsSupervisable('bin, argv')).toBe(false);
  });

  it('balances brackets rather than matching to the first close paren', () => {
    const source =
      'const c = spawn(plan.command, [...plan.argv], { env: { A: f(1) }, detached: true });';
    expect(spawnCallArguments(source)).toEqual([
      'plan.command, [...plan.argv], { env: { A: f(1) }, detached: true }',
    ]);
    expect(spawnCallArguments('// spawn(bin, argv)\n')).toEqual([]);
  });
});
