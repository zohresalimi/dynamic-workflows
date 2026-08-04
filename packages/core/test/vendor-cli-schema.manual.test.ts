/**
 * KAR-02.8 — a vendor CLI consumes an emitted schema file directly.
 *
 * **Manual.** It spawns a real, authenticated vendor CLI and spends real
 * quota, so it runs only when a human asks for it:
 *
 * ```
 * DeFlow_MANUAL_VENDOR_CLI=1 pnpm vitest run --project unit \
 *   packages/core/test/vendor-cli-schema.manual.test.ts
 * ```
 *
 * Without that variable every case is skipped, so CI reports it as skipped
 * rather than running it — the outcome EPIC-02-S26 asks for, and visible in
 * the report rather than silently absent from the include globs.
 *
 * The automatable half of S26 is already covered without any vendor: that an
 * emitted file is a **standalone document** with no `$ref` leaving the file is
 * asserted in `packages/core/src/json-schema.test.ts`, and it is the property
 * a CLI actually depends on — a relative `$ref` is what it cannot resolve.
 * EPIC-04's mock agent plus a recording is what turns the rest of this into a
 * CI-runnable contract test; until then, this file is the record of how it was
 * checked by hand.
 *
 * Verifies: EPIC-02-S26 · AC1 (manual)
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';

const enabled = process.env.DeFlow_MANUAL_VENDOR_CLI === '1';
const schemasDir = new URL('../../../schemas/', import.meta.url).pathname;
const findingSchema = join(schemasDir, 'DeFlow.finding.v1.json');

function onPath(binary: string): boolean {
  try {
    execFileSync('command', ['-v', binary], { shell: '/bin/sh', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

suite('a vendor CLI accepts an emitted schema file (manual)', () => {
  it.skipIf(!enabled || !onPath('claude'))(
    'Claude Code accepts DeFlow.finding.v1.json as --json-schema',
    () => {
      expect(existsSync(findingSchema)).toBe(true);

      const stdout = execFileSync(
        'claude',
        [
          '-p',
          'Return a finding with id "manual-probe", severity "info", message "probe", evidence [].',
          '--json-schema',
          findingSchema,
          '--output-format',
          'json',
        ],
        { encoding: 'utf8', timeout: 120_000 },
      );

      const envelope = JSON.parse(stdout) as { structured_output?: unknown; is_error?: boolean };
      expect(envelope.is_error ?? false).toBe(false);
      expect(envelope.structured_output).toBeDefined();
    },
  );

  it.skipIf(!enabled || !onPath('codex'))('Codex accepts the same file as --output-schema', () => {
    const stdout = execFileSync(
      'codex',
      [
        'exec',
        '--output-schema',
        findingSchema,
        'Return a finding with id "manual-probe", severity "info", message "probe", evidence [].',
      ],
      { encoding: 'utf8', timeout: 120_000 },
    );

    expect(stdout.length).toBeGreaterThan(0);
  });
});
