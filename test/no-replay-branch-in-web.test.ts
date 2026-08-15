/**
 * KAR-16.5 AC2 — the web codebase contains no branch on whether it is talking
 * to a replay.
 *
 * Verifies: EPIC-16-S31 (scenario 2) · AC2
 *
 * *"A grep of `packages/web/src` for any replay-related identifier returns
 * nothing, and there is no `if (isReplay)` anywhere in the frontend."* This is
 * the assertion that keeps the harness honest: `deflow replay` boots the same
 * `boot()`, serves the same routes and enforces the same auth, so there is
 * nothing for a client to detect — and the day the UI needs to know, the
 * harness has drifted and *that* is the bug (EPIC-16 risk register).
 *
 * Two deliberate narrowings, both of which would otherwise make this vacuous:
 *
 * - **Comments are stripped first.** `PlanGraphView.vue` explains that it can
 *   be tested against a store *"instead of against a fixture server"*, which is
 *   prose about the design and not a branch. Matching it would force the
 *   comment to be deleted, which is the opposite of the point.
 * - **`replay` on its own is not a forbidden word.** `api/scrub.ts` replays
 *   events forward from a snapshot — `replayWindow`, `replayedFrom`, *"replaying
 *   r_1 from 9 failed"* — and that is the client's own vocabulary for folding,
 *   with nothing to do with `deflow replay`. What is forbidden is an identifier
 *   naming the *mode*: a boolean, a mode string, a build flag, a second server.
 *
 * The control at the bottom is what stops this passing because the scan is
 * broken rather than because the codebase is clean.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const WEB_SRC = fileURLToPath(new URL('../packages/web/src/', import.meta.url));

/**
 * Identifiers that would mean the frontend knows what it is talking to.
 *
 * Each one is a way somebody would actually write it: a boolean, a mode string,
 * a build-time flag, a per-environment base URL, or the command name itself.
 */
const FORBIDDEN: readonly RegExp[] = [
  /\bis[_-]?replay\b/i,
  /\breplay[_-]?mode\b/i,
  /\breplay[_-]?(server|client|daemon|harness|api|url|origin)\b/i,
  /\bVITE_[A-Z_]*REPLAY[A-Z_]*\b/,
  /\b__REPLAY__\b/,
  /\bDeFlow replay\b/i,
  /\bfixture\b/i,
  /\bharness\b/i,
  /\bmock(ed|s)?\b/i,
];

/** Source files only: a spec naming the fixture it folds is exactly right. */
function sources(dir: string, into: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__snapshots__') continue;
      sources(path, into);
      continue;
    }
    if (!/\.(ts|vue)$/.test(entry.name)) continue;
    if (/\.(test|type-test)\.ts$/.test(entry.name)) continue;
    into.push(path);
  }
  return into;
}

/**
 * `text` with its comments removed.
 *
 * Naive on purpose — it is a grep, not a parser — and the direction of its
 * error is the safe one: the only thing it can do wrong is strip too much of a
 * string literal, and a rule that under-matches is caught by the control.
 */
export function stripComments(text: string): string {
  return text.replaceAll(/\/\*[\s\S]*?\*\//g, ' ').replaceAll(/(^|[^:])\/\/[^\n]*/g, '$1');
}

suite('EPIC-16-S31 — the UI contains no replay branch (AC2)', () => {
  const files = sources(WEB_SRC);

  it('scans the whole of packages/web/src', () => {
    // A walk that found nothing would make every assertion below pass.
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((path) => path.endsWith('.vue'))).toBe(true);
  });

  it('names no replay-mode identifier anywhere in the shipped frontend', () => {
    const offences: string[] = [];
    for (const path of files) {
      const code = stripComments(readFileSync(path, 'utf8'));
      for (const [index, line] of code.split('\n').entries()) {
        for (const pattern of FORBIDDEN) {
          if (pattern.test(line)) {
            offences.push(`${path.slice(WEB_SRC.length)}:${index + 1}: ${line.trim()}`);
          }
        }
      }
    }

    expect(offences).toEqual([]);
  });

  it('would catch the branch it exists to forbid — the control', () => {
    const written = stripComments(
      ['// a replay-aware client is what this forbids', 'if (isReplay) { pollInstead(); }'].join(
        '\n',
      ),
    );

    expect(FORBIDDEN.some((pattern) => pattern.test(written))).toBe(true);
    // And the comment above it is genuinely gone, so prose about replay never
    // trips the rule.
    expect(written).not.toMatch(/forbids/);
  });
});
