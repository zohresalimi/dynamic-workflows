/**
 * KAR-19.8 AC1, AC8 / EPIC-19-S52 (the outline), EPIC-19-S57 — the value DeFlow
 * puts on a validated flag is one the entry itself declares the form of.
 *
 * On 2026-08-13 an operator's run reached framing and died on
 * `Error: Invalid session ID. Must be a valid UUID.` — because
 * `packages/daemon/src/pipeline/live-chain.ts` filled `ShimContext.sessionId`
 * with `` `${runId}-framing` `` and Claude Code 2.1.220 validates the flag. The
 * whole provider-contract suite was green: nothing anywhere asserted that the
 * *form* of a value DeFlow chooses matches the form the vendor demands.
 *
 * So the guard is over the table rather than over the entry that broke. Its
 * rows are derived from `PROVIDER_SPECS`, and the form each value is checked
 * against is read from the entry's own `shim.sessionId` declaration — a literal
 * in this file would be a second copy of the registry, and the next vendor
 * added would be covered by nobody.
 *
 * Verifies: EPIC-19-S52 (Scenario Outline), EPIC-19-S57 · KAR-19.8 AC1, AC8
 */
import { NodeIdSchema, type PermissionLevel, RunIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  ARGUMENT_FORMS,
  checkArgumentForm,
  PROVIDER_SPECS,
  type ProviderSpec,
  type ShimPlan,
  shimPlan,
  vendorSessionId,
} from '../src/index.ts';

const BIN = '/opt/DeFlow/bin';
const WORKTREE = '/tmp/DeFlow/wt/n1';
const RUN = RunIdSchema.parse('run_20260813T110608Z_379fc8');

const specs = Object.values(PROVIDER_SPECS) as readonly ProviderSpec[];

/** The one permission level every entry in the table can express. */
const READ: PermissionLevel = 'read';

function plan(spec: ProviderSpec, sessionId: string): ShimPlan {
  return shimPlan(spec, {
    resolved: { provider: spec.id, path: `${BIN}/${spec.shim.bin}` },
    worktree: WORKTREE,
    prompt: 'summarise the failing test',
    sessionId,
    permission: READ,
  });
}

/** The value that follows `flag` in `argv`, or `null`. */
function valueOf(argv: readonly string[], flag: string): string | null {
  const at = argv.lastIndexOf(flag);
  return at < 0 ? null : (argv[at + 1] ?? null);
}

/**
 * EPIC-19-S52's Examples table: every turn kind that reaches the shim.
 *
 * `framing`, `recon` and `planner` are the pre-execution turns
 * (`live-chain.ts`); `implement` stands for an agent node, which reaches the
 * same builder through `run-shim-node.ts`. All four are `(runId, nodeId,
 * attempt)` tuples and nothing else, which is the point.
 */
const TURNS = ['framing', 'recon', 'planner', 'implement'] as const;

suite('KAR-19.8 AC1 — every claude turn carries a session id the vendor accepts', () => {
  const claude = PROVIDER_SPECS.claude;

  it.each(TURNS)('puts a valid uuid on --session-id for the %s turn', (turn) => {
    const sessionId = vendorSessionId({
      runId: RUN,
      nodeId: NodeIdSchema.parse(turn),
      attempt: 0,
    });

    const argv = plan(claude, sessionId).argv;

    expect(valueOf(argv, '--session-id')).toBe(sessionId);
    // KAR-19.11 folded this form into the one argument vocabulary: the session
    // id is now a row in the entry's own `arguments` audit rather than a
    // mechanism beside it, so the check is the same one every other argument
    // gets.
    expect(checkArgumentForm({ form: 'uuid' }, sessionId)).toBeNull();
  });

  it('is the value the 2026-08-13 run died on that the form now refuses', () => {
    // The regression, stated as the assertion it should always have been: the
    // id DeFlow used to build is a well-formed DeFlow run id and is not a uuid,
    // so the vendor refused it on every attempt.
    expect(checkArgumentForm({ form: 'uuid' }, `${RUN}-framing`)).toMatch(/uuid/i);
  });
});

suite('KAR-19.8 AC8 — the guard is over the table, not over the entry that broke', () => {
  it.each(specs.map((spec) => [spec.id, spec] as const))(
    '%s supplies a value matching the form its own entry declares',
    (_id, spec) => {
      const sessionId = vendorSessionId({
        runId: RUN,
        nodeId: NodeIdSchema.parse('implement'),
        attempt: 0,
      });
      const argv = plan(spec, sessionId).argv;
      const declared = spec.shim.sessionId;

      if (declared === undefined) {
        // An entry that declares no session id must not smuggle one onto the
        // argv: an undeclared value is one no test can check the form of, which
        // is the state `claude` was in on 2026-08-13.
        expect(argv).not.toContain(sessionId);
        return;
      }

      const value = valueOf(argv, declared.flag);
      expect(value).toBe(sessionId);
      expect(checkArgumentForm({ form: declared.form }, value ?? '')).toBeNull();
    },
  );

  it('declares a form for every entry that passes a session id, and only those', () => {
    const sessionId = vendorSessionId({
      runId: RUN,
      nodeId: NodeIdSchema.parse('implement'),
      attempt: 0,
    });

    for (const spec of specs) {
      const passes = plan(spec, sessionId).argv.includes(sessionId);
      expect([spec.id, passes]).toEqual([spec.id, spec.shim.sessionId !== undefined]);
    }
  });

  it('names a form from the one closed vocabulary, and declares it as an argument too', () => {
    for (const spec of specs) {
      const declared = spec.shim.sessionId;
      if (declared === undefined) continue;
      // KAR-19.11 AC2 — a member of the vocabulary, not a parallel mechanism,
      // and the same flag appears in the entry's audit table so the guard over
      // the whole argv covers it without a second rule.
      expect(ARGUMENT_FORMS).toContain(declared.form);
      const audited = spec.shim.arguments.find((one) => one.flag === declared.flag);
      expect([spec.id, audited?.form]).toEqual([spec.id, declared.form]);
    }
  });
});
