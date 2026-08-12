/**
 * KAR-18.7 AC4 / EPIC-18-S49 — `DeFlow status` signals nothing, ever.
 *
 * *"And no signal is sent to the recorded pid"* is a clause about something
 * that does **not** happen, and the integration spec can only observe it for
 * the one pid it spawned. This is the structural half: `status` is a read-only
 * command, so nothing in its source may reach for `process.kill` — not even
 * with signal `0`, the "is it alive?" idiom, which is exactly the shortcut a
 * later change would take instead of comparing start times, and which would
 * quietly reintroduce the recycled-pid bug the whole discipline exists for.
 *
 * Verifies: EPIC-18-S49 · AC4
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const STATUS_SRC = fileURLToPath(new URL('../src/status.ts', import.meta.url));

/** Over-removes at worst, which can only make the check stricter. */
function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

suite('status is a query, not an intervention', () => {
  it('sends no signal to the pid it reads', () => {
    const code = codeOnly(readFileSync(STATUS_SRC, 'utf8'));

    expect(code).not.toContain('process.kill');
    expect(code).not.toMatch(/\bkill\s*\(/);
    expect(code).not.toMatch(/\bkillTree\b/);
  });
});
