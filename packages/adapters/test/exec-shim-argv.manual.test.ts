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
 * **KAR-19.11 widened it from one flag to the whole argv.** EPIC-19-S56 asserted
 * that the real `claude` accepts the framing invocation; two minutes after that
 * story landed, the same binary refused the *next* argument. So the rows below
 * are now per turn kind and per permission level, and they are the work list
 * the registry's own provenance column produces: every argument whose form is
 * recorded as read from `--help` or decoded from the bundle rather than
 * `executed` is a row nobody has ever run, and this is where it gets run.
 *
 * Verifies: EPIC-19-S56, EPIC-19-S77 · KAR-19.8 AC7, KAR-19.11 AC6 (manual)
 */
import { NodeIdSchema, RunIdSchema } from '@DeFlow/core';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import {
  auditShimArgv,
  PROVIDER_SPECS,
  type ProviderSpec,
  providerSpec,
  shimPlan,
  vendorSessionId,
} from '../src/index.ts';

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
    execFileSync('command', ['-v', binary], {
      shell: '/bin/sh',
      stdio: 'ignore',
    });
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
      // KAR-19.11 — the document, because that is what this vendor's flag
      // takes. The path here is what died at 19:59.
      schemaDocument: readFileSync(DRAFT_SCHEMA, 'utf8'),
    });

    const turn = spawnSync('claude', [...plan.argv], {
      encoding: 'utf8',
      timeout: 300_000,
    });

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

/**
 * EPIC-19-S77 — **the whole argv, per turn kind and per permission level,
 * against the real binary.**
 *
 * The rows are derived from `PROVIDER_SPECS` rather than listed, so a vendor
 * added next month is covered here too. Each one is **reported as skipped with
 * its reason** when the variable is unset or the binary is not on PATH — never
 * as passed, because a row that quietly did not run is indistinguishable from
 * one that did, and that indistinguishability is this story's whole subject.
 */
const MANUAL_TURNS = [
  { node: 'framing', schemaId: 'DeFlow.taskspecdraft.v1' },
  { node: 'planner', schemaId: 'DeFlow.plangraph.v1' },
] as const;

/** Which vendors this row can even be attempted for: an entry whose CLI is the
 * bundled agent is covered on every commit by the integration battery. */
const VENDORS = (Object.values(PROVIDER_SPECS) as readonly ProviderSpec[]).filter(
  (spec) => spec.bundled !== true,
);

const rows = VENDORS.flatMap((spec) =>
  MANUAL_TURNS.flatMap((turn) =>
    spec.shim.permissions.map((permission, index) => ({
      label: `${spec.id}/${turn.node}/${permission}`,
      spec,
      turn,
      permission,
      // Every row is a distinct session, and it is **derived** rather than
      // minted (KAR-19.8's rule): Claude Code refuses a `--session-id` it has
      // already seen with `Error: Session ID <uuid> is already in use.`, so the
      // permission index rides in the tuple's `attempt` slot. Reusing one id
      // across rows would make every row after the first fail for a reason that
      // has nothing to do with the argument shapes under test.
      attempt: index,
    })),
  ),
);

/** A real vendor turn is minutes, not the unit slice's five seconds. Stated per
 * row rather than globally so the rest of this file keeps the fast default. */
const REAL_TURN_TIMEOUT_MS = 600_000;

/**
 * A fresh synthetic run id per invocation of this battery, and the honest
 * reason it is not the fixed one above.
 *
 * A vendor session id is **derived** from `(runId, nodeId, attempt)` and never
 * minted (KAR-19.8), which means running the same row twice sends the same id
 * twice — and Claude Code answers the second one with `Error: Session ID <uuid>
 * is already in use.` So the *run* is what differs between invocations, exactly
 * as it does in production: a real `run_<ts>_<hex>` is new every time, and this
 * battery is one synthetic run of it. Deriving the id stays intact; what moves
 * is the tuple's first member.
 */
const BATTERY_RUN = RunIdSchema.parse(
  `run_${new Date()
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z')}_${Math.floor(Date.now() % 0xff_ff_ff)
    .toString(16)
    .padStart(6, '0')}`,
);

suite('EPIC-19-S77 — the real binary accepts the complete argv DeFlow would send', () => {
  // A `for` loop rather than `it.each`, because each row needs the test context
  // to report its **skip and the reason for it** — and `it.each` hands the case
  // data where the context would be. A row that could not run must never be
  // absent from the report.
  for (const { label, spec, turn, permission, attempt } of rows) {
    it(
      label,
      (ctx) => {
        if (!enabled) ctx.skip(MANUAL);
        if (!onPath(spec.shim.bin)) ctx.skip(`${MANUAL} — no "${spec.shim.bin}" resolved on PATH`);

        const schemaPath = join(SCHEMAS_DIR, `${turn.schemaId}.json`);
        const plan = shimPlan(spec, {
          resolved: { provider: spec.id, path: spec.shim.bin },
          worktree: process.cwd(),
          prompt: `Reply with a ${turn.schemaId} document for: add a health endpoint.`,
          sessionId: vendorSessionId({
            runId: RUN,
            nodeId: NodeIdSchema.parse(turn.node),
            attempt,
          }),
          permission,
          ...(spec.shim.structuredOutputFlag === undefined
            ? {}
            : {
                schemaPath,
                schemaDocument: readFileSync(schemaPath, 'utf8'),
              }),
        });

        // The declared forms first, so a failure here says *which* argument is the
        // wrong shape before a quota is spent finding out.
        for (const audited of auditShimArgv(spec, plan.argv)) {
          expect([label, audited.problem]).toEqual([label, null]);
          expect([label, audited.argument === null]).toEqual([label, false]);
        }

        const turned = spawnSync(spec.shim.bin, [...plan.argv], {
          encoding: 'utf8',
          timeout: 300_000,
        });

        // The vendor's own words go in the assertion, not just the exit code.
        // The whole point of this row is to learn *which argument* a real binary
        // objects to, and `expected 1 to be +0` is the message that made the
        // last three findings cost a probe script apiece.
        const said = (turned.stderr || turned.stdout || '').trim().slice(0, 500);
        expect([label, turned.status, said]).toEqual([label, 0, said]);
        expect(said).not.toMatch(/invalid|unknown|unsupported|unrecognized|not valid/i);
      },
      REAL_TURN_TIMEOUT_MS,
    );
  }
});
