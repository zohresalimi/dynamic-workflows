/**
 * KAR-19.8 AC7 / EPIC-19-S56 — the F3.4 battery's real-vendor row.
 *
 * **Manual, and saying so plainly is the point.** It spawns a real,
 * authenticated vendor CLI and spends real quota, so it runs only when a person
 * asks for it — the same mechanism KAR-02.8 established in
 * `packages/core/test/vendor-cli-schema.manual.test.ts`:
 *
 * ```
 * DeFlow_MANUAL_VENDOR_CLI=1 pnpm vitest run --project unit \
 *   packages/adapters/test/exec-shim-argv.manual.test.ts
 * ```
 *
 * Without the variable each case is **skipped with its reason**, never passed:
 * a green row that proves nothing about the machine the product runs on is this
 * epic's own failure mode, one level up.
 *
 * What runs everywhere instead is `test/integration/exec-shim-conformance.test.ts`
 * (the same argv against a double that enforces the vendor's rules) and
 * `test/exec-shim-session-id.test.ts` (the argument-form table). This row is
 * what catches the vendor *changing* the rule — which is what happened on
 * 2026-08-13, and is why F3.4 exists at all.
 *
 * Verifies: EPIC-19-S56 · KAR-19.8 AC7 (manual)
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { execFileSync, spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import { providerSpec, shimPlan, vendorSessionId } from '../src/index.ts';

/** The reason a skipped row carries, so the report says why rather than
 * leaving a gap that reads like coverage. */
const MANUAL = 'manual: needs an authenticated vendor CLI (DeFlow_MANUAL_VENDOR_CLI=1)';

const enabled = process.env.DeFlow_MANUAL_VENDOR_CLI === '1';

const SCHEMAS_DIR = fileURLToPath(new URL('../../../schemas/', import.meta.url));
const DRAFT_SCHEMA = join(SCHEMAS_DIR, 'DeFlow.taskspecdraft.v1.json');

const RUN = RunIdSchema.parse('run_20260813T110608Z_379fc8');
const NODE = NodeIdSchema.parse('framing');

function onPath(binary: string): boolean {
  try {
    execFileSync('command', ['-v', binary], { shell: '/bin/sh', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

suite('EPIC-19-S56 — the installed claude accepts the argv DeFlow builds (manual)', () => {
  it('exits 0 on the registry’s own framing invocation', (ctx) => {
    if (!enabled) ctx.skip(MANUAL);
    if (!onPath('claude')) ctx.skip(`${MANUAL} — no "claude" resolved on PATH`);

    const spec = providerSpec('claude');
    if (spec === undefined) throw new Error('PROVIDER_SPECS has no "claude" entry');

    // The argv the registry builds, passed to the real binary **unmodified**.
    // Anything assembled here would be a different invocation from the one the
    // product sends, which is the whole failure this row exists to catch.
    const plan = shimPlan(spec, {
      resolved: { provider: spec.id, path: 'claude' },
      worktree: process.cwd(),
      prompt: 'Reply with a DeFlow.taskspecdraft.v1 document for: add a health endpoint.',
      sessionId: vendorSessionId({ runId: RUN, nodeId: NODE, attempt: 0 }),
      permission: 'read',
      format: 'json',
      schemaPath: DRAFT_SCHEMA,
    });

    const turn = spawnSync('claude', [...plan.argv], { encoding: 'utf8', timeout: 300_000 });

    expect(turn.stderr).not.toMatch(/invalid|unknown|unsupported|unrecognized/i);
    expect(turn.status).toBe(0);

    const envelope = JSON.parse(turn.stdout) as {
      is_error?: boolean;
      structured_output?: unknown;
    };
    expect(envelope.is_error ?? false).toBe(false);
    expect(envelope.structured_output).toBeDefined();
  });
});
