/**
 * KAR-18.4 AC5 — the AR-1 guard over `deflow doctor`'s own source tree.
 *
 * EPIC-18-S30's second scenario is the reason this is a mechanical check
 * rather than a review note. *"'Never possesses a model credential' has to be
 * verifiable by inspection, and a `doctor` that helpfully checked whether you
 * are logged in by reading a token file would break it silently."* The
 * temptation is real and specific: the auth-shadowing section is the one place
 * in the codebase where an "…and are you actually authenticated?" line would
 * look like an improvement, and it would put DeFlow inside the credential path
 * AR-1 exists to keep it out of.
 *
 * Two rules, both over the code with comments stripped, because this package's
 * prose quotes credential paths and vendor login commands constantly and code
 * must be judged on its own:
 *
 *  1. No credential directory is named as a path to open.
 *  2. Nothing spawns a vendor's auth or login subcommand. `provider-
 *     availability.ts` in @DeFlow/adapters already renders one as a *string*
 *     for the operator to run; doctor prints that string and never executes it.
 *
 * Verifies: EPIC-18-S30 (scenario 2) · AC5 · test plan #6
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const DOCTOR_SRC = fileURLToPath(new URL('../src/doctor/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Over-removes at worst, which can only make the checks below stricter about
 * what they still see, never blinder. */
function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The credential stores of the five measured vendors (docs/15 §2.3). */
const CREDENTIAL_PATHS = [
  '.claude',
  '.codex',
  '.config/gcloud',
  '.gemini',
  '.copilot',
  '.config/opencode',
];

/**
 * Every string literal inside a process-spawning call — the binary *and* its
 * argv.
 *
 * The argv half is the one that matters here. A vendor's login flow is
 * `claude auth login`, not a binary called `login`, so a guard that inspected
 * only the first argument would wave through the exact line AR-1 forbids.
 */
function spawnedLiterals(source: string): string[] {
  const calls = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\(([\s\S]{0,300}?)\)/g;
  return [...source.matchAll(calls)].flatMap((call) =>
    [...(call[1] ?? '').matchAll(/(['"`])(.*?)\1/g)].map((literal) => literal[2] ?? ''),
  );
}

suite('the guard covers the code that can spawn (KAR-18.8 AC11)', () => {
  it('scans the module that runs "npm install -g"', () => {
    // KAR-18.8 gave `doctor` the ability to spawn a package manager, and both
    // rules below are only worth anything if they are read over the file that
    // does it. The scan is a directory walk, so a future move of the install
    // out of `src/doctor/` would drop it from the guard silently — this is what
    // turns that into a failing test instead.
    expect(sourceFiles(DOCTOR_SRC).map((file) => file.replace(DOCTOR_SRC, ''))).toContain(
      'agent-install.ts',
    );
  });
});

suite('doctor opens no credential file (AR-1)', () => {
  it('names no vendor credential directory anywhere in its code', () => {
    for (const file of sourceFiles(DOCTOR_SRC)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const path of CREDENTIAL_PATHS) {
        expect(
          code.includes(path),
          `${file} names the credential store "${path}". doctor reports on auth; it never reads ` +
            'one (AR-1, EPIC-18-S30 scenario 2).',
        ).toBe(false);
      }
    }
  });

  it('reaches for no home directory of its own', () => {
    for (const file of sourceFiles(DOCTOR_SRC)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      expect(code).not.toContain('homedir(');
      expect(code).not.toContain('os.homedir');
    }
  });
});

suite('doctor runs no login command (AR-1)', () => {
  it('captures no auth or login subcommand output', () => {
    for (const file of sourceFiles(DOCTOR_SRC)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const literal of spawnedLiterals(code)) {
        expect(
          /\b(login|auth|logout|whoami|token)\b/.test(literal),
          `${file} spawns "${literal}". A vendor's login command is rendered for the operator to ` +
            'run, never executed here (AR-1, KAR-05.3 AC7).',
        ).toBe(false);
      }
      // `authMethods` may be read — it arrives inside the probed capability
      // row — but nothing may turn one back into an argv.
      expect(code).not.toMatch(/authMethods[\s\S]{0,200}?\bspawn\w*\(/);
    }
  });
});
