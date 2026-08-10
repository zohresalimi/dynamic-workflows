/**
 * KAR-12.5 AC10 — the structural path-scope gate, and the promotion rule that
 * keeps it from being either advisory or hysterical
 * (docs/10-verification-gates.md §6.2, §9.1).
 *
 * §6.2's shape is the whole design: an undeclared write is a **warning**,
 * because hard-failing on scope alone teaches everyone to declare `src/**` on
 * every node and costs you both the prediction and the ground truth. It is
 * promoted to `error` in exactly three cases, and one of them —
 * *"the path is in the run's protected set"* — is §9.1's real defence: the
 * classic failure is not a human overriding a gate, it is an agent "fixing"
 * the check.
 *
 * Verifies: EPIC-12-S35 · AC10
 */
import type { GateId } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  assertRepairScope,
  DEFAULT_PROTECTED_PATHS,
  RepairScopeViolation,
  SCOPE_UNDECLARED_WRITE,
  scopeGateFindings,
} from './scope-gate.ts';

const GATE = 'scope' as GateId;
const WORKTREE = '/tmp/deflow/wt/run__fix-a13f';

const input = (overrides: Record<string, unknown> = {}) => ({
  gate: GATE,
  worktree: WORKTREE,
  declared: ['packages/ui/src/**'],
  changed: [] as readonly string[],
  ...overrides,
});

suite('a repair node writing a protected path (EPIC-12-S35, outline)', () => {
  for (const path of [
    '.DeFlow/gates/typecheck.yaml',
    '.DeFlow/config.yaml',
    '.github/workflows/ci.yml',
    'pnpm-lock.yaml',
  ]) {
    it(`fails on ${path} at severity error`, () => {
      const findings = scopeGateFindings(input({ changed: [path] }));

      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe(SCOPE_UNDECLARED_WRITE);
      expect(findings[0]?.severity).toBe('error');
      expect(findings[0]?.file).toBe(path);
    });
  }

  it('is an error even when the node had the nerve to declare it', () => {
    // The protected set is not a scope check with extra steps. A fix node that
    // declares `.DeFlow/**` and then edits its own gate has done exactly the
    // thing §9.1 names, and a declaration is not a licence.
    const findings = scopeGateFindings(
      input({ declared: ['.DeFlow/**'], changed: ['.DeFlow/gates/typecheck.yaml'] }),
    );

    expect(findings[0]?.severity).toBe('error');
  });

  it('treats a test file the plan marked as a contract as protected', () => {
    const findings = scopeGateFindings(
      input({
        declared: ['packages/ui/src/**', 'packages/ui/test/**'],
        changed: ['packages/ui/test/contract/date-picker.contract.test.ts'],
        contractPaths: ['packages/ui/test/contract/**'],
      }),
    );

    expect(findings[0]?.severity).toBe('error');
    expect(findings[0]?.rule).toBe(SCOPE_UNDECLARED_WRITE);
  });
});

suite('an ordinary undeclared write is a warning (EPIC-12-S35, second scenario)', () => {
  it('warns on one import site outside the scope and does not fail the gate', () => {
    const findings = scopeGateFindings(input({ changed: ['packages/ui/src2/index.ts'] }));

    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('warning');
  });

  it('says nothing at all about a path the node declared', () => {
    expect(scopeGateFindings(input({ changed: ['packages/ui/src/DatePicker.vue'] }))).toEqual([]);
  });

  it('still reports the violation, so the diff view and the blast radius see it', () => {
    const findings = scopeGateFindings(input({ changed: ['packages/ui/src2/index.ts'] }));

    expect(findings[0]?.file).toBe('packages/ui/src2/index.ts');
    expect(findings[0]?.message).toContain('packages/ui/src/**');
  });
});

suite('the same path becomes an error when it also conflicts (third scenario)', () => {
  it('promotes on a merge-tree conflict', () => {
    const findings = scopeGateFindings(
      input({ changed: ['packages/ui/src2/index.ts'], conflicts: ['packages/ui/src2/index.ts'] }),
    );

    expect(findings[0]?.severity).toBe('error');
  });

  it('promotes a path that escaped the worktree entirely', () => {
    const findings = scopeGateFindings(input({ changed: ['../outside/thing.ts'] }));

    expect(findings[0]?.severity).toBe('error');
  });

  it('leaves a conflict at a declared path to the merge gate', () => {
    // `merge/conflict` is a different finding with a different rule. A scope
    // gate that also reported conflicts would double-count them, and the
    // reviewer would see the same problem twice under two names.
    expect(
      scopeGateFindings(
        input({
          changed: ['packages/ui/src/DatePicker.vue'],
          conflicts: ['packages/ui/src/DatePicker.vue'],
        }),
      ),
    ).toEqual([]);
  });
});

suite('the protected set is the run manifest, not a hunch', () => {
  it('names the four families §6.2 lists', () => {
    expect(DEFAULT_PROTECTED_PATHS).toContain('.DeFlow/**');
    expect(DEFAULT_PROTECTED_PATHS.some((glob) => glob.includes('.github'))).toBe(true);
    expect(DEFAULT_PROTECTED_PATHS.some((glob) => glob.includes('lock'))).toBe(true);
  });

  it('is replaceable per run without touching the matcher', () => {
    const findings = scopeGateFindings(
      input({ changed: ['infra/terraform.tf'], protectedPaths: ['infra/**'] }),
    );

    expect(findings[0]?.severity).toBe('error');
  });
});

suite('the check runs before the verdict is considered (AC10, test plan #11)', () => {
  it('throws a gate-class node failure on an error-severity violation', () => {
    expect(() => assertRepairScope(input({ changed: ['.DeFlow/gates/typecheck.yaml'] }))).toThrow(
      RepairScopeViolation,
    );
  });

  it('carries the offending finding on the failure, not only in the message', () => {
    try {
      assertRepairScope(input({ changed: ['.DeFlow/gates/typecheck.yaml'] }));
      expect.unreachable('the protected write should have failed the node');
    } catch (error) {
      expect(error).toBeInstanceOf(RepairScopeViolation);
      const violation = error as RepairScopeViolation;
      expect(violation.findings.map((finding) => finding.file)).toEqual([
        '.DeFlow/gates/typecheck.yaml',
      ]);
      expect(violation.failureClass).toBe('gate');
    }
  });

  it('lets a warning-only diff through: a warning is not a failure', () => {
    expect(() =>
      assertRepairScope(input({ changed: ['packages/ui/src2/index.ts'] })),
    ).not.toThrow();
  });
});
