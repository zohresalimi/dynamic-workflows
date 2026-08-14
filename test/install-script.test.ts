/**
 * KAR-20.2 — the macOS install script does nothing the `npx` path does not.
 *
 * `curl … | sh` asks for more trust than any other line DeFlow will ever print,
 * and the honest answer to *"why would I pipe your script into my shell"* is
 * not a paragraph in a README — it is that the script is short enough to read
 * and provably does one thing: check that this machine has a new enough Node,
 * then hand over to `deflow setup`, which is the same code path `npx deflow
 * setup` runs.
 *
 * So this file reads the script the way a suspicious operator would, and fails
 * if it ever grows a second capability: another package, a `sudo`, a file of
 * its own, a `PATH` edit that bypasses the consent rules `setup` carries.
 *
 * The end-state half of the scenario — that the script and `npx deflow setup`
 * leave the same machine behind — is `e2e/setup-install.test.ts`, because only
 * a real install can answer it.
 *
 * Verifies: EPIC-20-S12 (scenario 2) · KAR-20.2 AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { readText } from './support/workspace.ts';

const SCRIPT = 'scripts/install.sh';

/** The script with its comments stripped — every rule below is about what runs. */
function codeOnly(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

suite('the install script is a bootstrap, not a second installer (EPIC-20-S12)', () => {
  const source = readText(SCRIPT);
  const code = codeOnly(source);

  it('is POSIX sh, fails loudly, and hands over to "deflow setup"', () => {
    expect(source.startsWith('#!/bin/sh\n')).toBe(true);
    expect(code).toContain('set -eu');
    // One handover, and it is an `exec`: the script does not outlive the
    // command it starts, so there is no "and then…" for anything to hide in.
    const execs = [...code.matchAll(/^\s*exec .*/gm)].map((match) => match[0].trim());
    expect(execs).toHaveLength(1);
    expect(execs[0]).toContain('deflow setup');
    expect(execs[0]).toContain('npx --yes --package=');
  });

  it('installs no package of its own', () => {
    // The one package name it may carry is the one the npx path installs, and
    // it arrives through a variable so a pinned version or a packed tarball is
    // the same code path rather than a second one.
    expect(code).toContain('PACKAGE="${DEFLOW_PACKAGE:-deflow}"');
    for (const pattern of [
      /\bnpm\s+install\b/,
      /\bnpm\s+i\b/,
      /\bpnpm\s+(?:add|install)\b/,
      /\byarn\s+add\b/,
      /\bbrew\s+install\b/,
      /\bapt(?:-get)?\s+install\b/,
      /\bcurl\b/,
      /\bwget\b/,
    ]) {
      expect(pattern.test(code), `${SCRIPT} matches ${pattern.source}`).toBe(false);
    }
  });

  it('never uses sudo and never writes a file', () => {
    expect(/\bsudo\b/.test(code)).toBe(false);
    // No redirection into a file, no `tee`, no `mkdir`: every byte this run
    // leaves behind is written by `deflow setup`, under its own consent rules.
    const redirections = code.replaceAll(/>&\d/g, '').replaceAll(/\d?>\s*\/dev\/null/g, '');
    expect(/>\s*[^&|\s]/.test(redirections)).toBe(false);
    for (const pattern of [/\btee\b/, /\bmkdir\b/, /\bchmod\b/, /\bln\s+-s/]) {
      expect(pattern.test(code), `${SCRIPT} matches ${pattern.source}`).toBe(false);
    }
  });

  it('edits no PATH of its own', () => {
    // The profile edit is `setup`'s, where it is named, shown and consented to.
    // A script that appended its own line would have quietly bypassed all three.
    expect(/export\s+PATH=/.test(code)).toBe(false);
    for (const profile of ['.zshrc', '.bashrc', '.bash_profile', 'config.fish']) {
      expect(code.includes(profile), `${SCRIPT} names ${profile}`).toBe(false);
    }
  });

  it('refuses a machine it cannot serve rather than half-working on it', () => {
    // No Node, too old a Node, no npx, and Windows: four refusals, each of
    // which says what to do and states that nothing was changed.
    expect(code).toContain('command -v node');
    expect(code).toContain('command -v npx');
    expect(code).toContain('MIN_NODE_MAJOR=24');
    expect(code).toContain('NF5');
    expect(code).toContain('WSL2');
    const exits = [...code.matchAll(/^\s*exit 1$/gm)];
    expect(exits.length).toBeGreaterThanOrEqual(4);
  });
});
