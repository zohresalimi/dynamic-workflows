/**
 * KAR-05.3 AC3/AC4/AC7 — two rules that only a guard can hold, because both
 * fail silently.
 *
 * **A bare command name works on the author's machine.** DeFlowd's `PATH` at
 * daemon start is not the user's login-shell `PATH` — a daemon started by a
 * login item, a systemd unit or `npx` inherits a different environment — so
 * `spawn('gemini')` passes every spec here and fails on someone else's laptop
 * with an ENOENT that names nothing (docs/07-provider-adapter-layer.md §4.3).
 *
 * **Running the login command looks helpful.** Copilot's `initialize` hands
 * back a literal `{command, args}` to log in with. Executing it would be one
 * short, plausible, reviewable-looking line — and it would put DeFlow inside
 * the credential path that AR-1 exists to keep it out of, capturing whatever
 * the vendor's login flow printed. The rule is mechanical: no file that reads
 * an `authMethods` payload may import a process-spawning API at all.
 *
 * Verifies: EPIC-05-S10 (scenario 3), EPIC-05-S11 (scenario 4) · AC7 · test
 * plan #6, #7
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Comments in this package quote argv and vendor names constantly; code must
 * be judged on its own. Over-removes at worst, which can only make the checks
 * below stricter about what they still see, never blinder. */
export function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** Every literal first argument handed to a process-spawning call. */
export function spawnedLiterals(source: string): string[] {
  const calls = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(\s*(['"`])(.*?)\1/g;
  return [...codeOnly(source).matchAll(calls)].map((match) => match[2] ?? '');
}

const files = sourceFiles(SRC);

suite('no adapter source spawns a bare command name (test plan #6)', () => {
  it('found sources to check at all', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('every spawned command is a variable or an absolute path, never a name for PATH to answer', () => {
    const offenders = files.flatMap((path) =>
      spawnedLiterals(readFileSync(path, 'utf8'))
        .filter((literal) => !literal.startsWith('/'))
        .map((literal) => `${path}: spawn(${JSON.stringify(literal)})`),
    );
    expect(
      offenders,
      'Resolve the binary once, persist the absolute path in the capability row, and pass it ' +
        "explicitly. DeFlowd's PATH is not the user's login-shell PATH.",
    ).toEqual([]);
  });

  it('the check is not vacuous', () => {
    expect(spawnedLiterals("const c = spawn('gemini', ['--acp']);")).toEqual(['gemini']);
    expect(spawnedLiterals('const c = spawn(resolved.path, argv);')).toEqual([]);
    expect(spawnedLiterals("// spawn('gemini')")).toEqual([]);
  });
});

suite('nothing that reads authMethods can spawn (AC7)', () => {
  const reading = files.filter((path) =>
    codeOnly(readFileSync(path, 'utf8')).includes('authMethods'),
  );

  it('at least one source reads authMethods, or this guard proves nothing', () => {
    expect(reading).not.toEqual([]);
  });

  for (const path of reading) {
    it(`${path.slice(SRC.length)} imports no process-spawning API`, () => {
      const code = codeOnly(readFileSync(path, 'utf8'));
      expect(code).not.toMatch(/from\s+'node:child_process'/);
      expect(code).not.toMatch(/\b(spawn|exec|execFile)(Sync)?\s*\(/);
    });
  }
});
