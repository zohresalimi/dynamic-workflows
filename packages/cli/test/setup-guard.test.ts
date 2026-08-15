/**
 * KAR-20.2 AC11, AC14 — the two rules `deflow setup` cannot be trusted on
 * without a mechanical check.
 *
 * `setup` is the one command in this CLI that installs software onto somebody's
 * machine, and it asks for that trust in its first five minutes, before the
 * operator has seen the tool do anything. Two promises make that reasonable,
 * and both of them are the kind of promise that decays by accident:
 *
 *  1. **Nothing global is installed without consent except this package**
 *     (AC11). The decay is somebody adding a convenience — "while we're here,
 *     let's make sure npm is current" — and `setup` quietly becoming a command
 *     that changes machines. So no source line here may name a global update, a
 *     package-manager installation, or `sudo`.
 *  2. **No credential is read** (AR-1, AC14). The decay is the friendly one:
 *     an "…and are you signed in?" line in a report about a fresh machine,
 *     which would put DeFlow inside the credential path AR-1 exists to keep it
 *     out of. This is the same guard KAR-18.4 and KAR-18.8 carry, extended to
 *     the second entry point — `test/doctor-ar1-guard.test.ts` scans
 *     `src/doctor/`, and nothing scanned `src/setup/` until this file.
 *
 * Verifies: EPIC-20-S22 (its source half) · AC11, AC14 · test plan #14
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const SETUP_SRC = fileURLToPath(new URL('../src/setup/', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts')) return [];
    return entry.name.endsWith('.test.ts') ? [] : [path];
  });
}

/** Over-removes at worst, which can only make the rules below stricter about
 * what they still see, never blinder. */
function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/**
 * Every string literal inside a process-spawning call — the binary *and* its
 * argv, because `npm install -g` is an argv rather than a binary called
 * `install`.
 */
function spawnedLiterals(source: string): string[] {
  const calls =
    /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|run)\(([\s\S]{0,400}?)\)/g;
  return [...source.matchAll(calls)].flatMap((call) =>
    [...(call[1] ?? '').matchAll(/(['"`])(.*?)\1/g)].map((literal) => literal[2] ?? ''),
  );
}

/** The credential stores of the measured vendors (docs/15 §2.3). */
const CREDENTIAL_PATHS = [
  '.claude',
  '.codex',
  '.config/gcloud',
  '.gemini',
  '.copilot',
  '.config/opencode',
];

suite('the guard covers the code that can spawn', () => {
  it('scans the module that runs "npm install -g"', () => {
    // A directory walk, so moving the install out of `src/setup/` would drop it
    // from the guard silently. This is what turns that into a failing test.
    const covered = sourceFiles(SETUP_SRC).map((file) => relative(SETUP_SRC, file));
    expect(covered).toContain('run.ts');
    expect(covered).toContain('profile.ts');
    expect(covered).toContain('plan.ts');
  });
});

suite('nothing global is installed without consent except this package (AC11)', () => {
  it('names no package manager installation but its own, and no sudo', () => {
    for (const file of sourceFiles(SETUP_SRC)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const literal of spawnedLiterals(code)) {
        expect(
          /\bsudo\b|\bupdate\b|\bupgrade\b|\bbrew\b|\bapt(?:-get)?\b|\bport\b|\bcurl\b/.test(
            literal,
          ),
          `${relative(SETUP_SRC, file)} spawns "${literal}". setup installs exactly one thing — ` +
            'the package the operator just asked for — and asks before anything else (AC11).',
        ).toBe(false);
      }
      // `sudo` nowhere at all, not merely nowhere inside a spawn: a shell
      // command assembled into a string and handed to `sh -c` would not be
      // caught by the literal scan above.
      expect(/\bsudo\b/.test(code), `${relative(SETUP_SRC, file)} names sudo`).toBe(false);
    }
  });

  it('installs one package globally, in one place, with a `-g` that is written once', () => {
    // Not a style rule: two call sites that both know how to install globally
    // is how a second, unprompted one appears without anybody noticing.
    const sites = sourceFiles(SETUP_SRC)
      .flatMap((file) => {
        const code = codeOnly(readFileSync(file, 'utf8'));
        return [...code.matchAll(/'install',\s*'-g'/g)].map(() => relative(SETUP_SRC, file));
      })
      .sort();
    expect(sites).toEqual(['run.ts']);
  });
});

suite('setup reads no credential file and captures no login output (AR-1, AC14)', () => {
  it('names no vendor credential directory anywhere in its code', () => {
    for (const file of sourceFiles(SETUP_SRC)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const path of CREDENTIAL_PATHS) {
        expect(
          code.includes(path),
          `${relative(SETUP_SRC, file)} names the credential store "${path}". setup installs a ` +
            'command and describes a machine; it never reads one (AR-1).',
        ).toBe(false);
      }
    }
  });

  it('reaches for no home directory of its own, and reads no token variable', () => {
    for (const file of sourceFiles(SETUP_SRC)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      // `$HOME` arrives in the passed environment, which is what makes a fake
      // home a staged fact rather than a thing this code decides for itself.
      expect(code).not.toContain('homedir(');
      expect(code).not.toContain('os.homedir');
      expect(code).not.toMatch(/_API_KEY|_TOKEN\b|ANTHROPIC_|OPENAI_/);
    }
  });

  it('spawns no auth or login subcommand', () => {
    for (const file of sourceFiles(SETUP_SRC)) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const literal of spawnedLiterals(code)) {
        expect(
          /\b(login|auth|logout|whoami|token)\b/.test(literal),
          `${relative(SETUP_SRC, file)} spawns "${literal}". A vendor's login command is ` +
            'rendered for the operator to run, never executed here (AR-1).',
        ).toBe(false);
      }
    }
  });
});
