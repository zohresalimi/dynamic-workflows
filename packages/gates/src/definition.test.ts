/**
 * KAR-12.1 test plan #11 (the load-time half) — gate definitions.
 *
 * The worked examples are copied verbatim from
 * docs/10-verification-gates.md §2, so a definition the architecture documents
 * and a definition the loader accepts cannot drift apart.
 *
 * Verifies: EPIC-12-S10 (second scenario) · AC3
 */
import { expect, it, describe as suite } from 'vitest';
import { GateLoadError, loadGateDefinition } from './definition.ts';

const TYPECHECK_YAML = `id: typecheck
kind: deterministic
title: TypeScript project check
run: pnpm exec tsc -p tsconfig.json --noEmit
cwd: worktree
timeout: 300s
effect: pure
permission: worktree
expect:
  exitCode: 0
findings:
  parser: tsc
satisfies: [ac-3, ac-7]
severityFloor: error
`;

const BUNDLE_BUDGET_YAML = `id: bundle-budget
kind: deterministic
title: Bundle size budget
run: node scripts/bundle-budget.mjs --json
cwd: worktree
timeout: 120s
effect: pure
expect:
  exitCode: 0
findings:
  parser: jsonl
  path: $.violations
satisfies: [ac-11]
`;

const load = (source: string, options?: { readonly repoCwdPermitted?: boolean }) =>
  loadGateDefinition('.DeFlow/gates/typecheck.yaml', source, options);

suite('the two worked examples from §2 round-trip', () => {
  it('parses typecheck.yaml', () => {
    const definition = load(TYPECHECK_YAML);
    expect(definition.id).toBe('typecheck');
    expect(definition.kind).toBe('deterministic');
    expect(definition.run).toBe('pnpm exec tsc -p tsconfig.json --noEmit');
    expect(definition.cwd).toBe('worktree');
    expect(definition.timeoutMs).toBe(300_000);
    expect(definition.effect).toBe('pure');
    expect(definition.permission).toBe('worktree');
    expect(definition.expect.exitCode).toBe(0);
    expect(definition.findings.parser).toBe('tsc');
    expect(definition.satisfies).toEqual(['ac-3', 'ac-7']);
    expect(definition.severityFloor).toBe('error');
  });

  it('parses bundle-budget.yaml, including the parser path expression', () => {
    const definition = loadGateDefinition('.DeFlow/gates/bundle-budget.yaml', BUNDLE_BUDGET_YAML);
    expect(definition.findings.parser).toBe('jsonl');
    expect(definition.findings.path).toBe('$.violations');
    expect(definition.timeoutMs).toBe(120_000);
    // Not stated in the file, so the documented default applies.
    expect(definition.severityFloor).toBe('error');
  });

  it('carries the file path it was loaded from', () => {
    expect(load(TYPECHECK_YAML).file).toBe('.DeFlow/gates/typecheck.yaml');
  });
});

suite('a gate must be pure (AC3)', () => {
  it('rejects effect: mutating with GATE_MUST_BE_PURE, naming the file', () => {
    const source = TYPECHECK_YAML.replace('effect: pure', 'effect: mutating');
    expect(() => load(source)).toThrow(GateLoadError);
    try {
      load(source);
      expect.unreachable('a mutating gate must not load');
    } catch (error) {
      expect((error as GateLoadError).code).toBe('GATE_MUST_BE_PURE');
      expect((error as GateLoadError).file).toBe('.DeFlow/gates/typecheck.yaml');
      expect((error as GateLoadError).message).toContain('.DeFlow/gates/typecheck.yaml');
    }
  });

  it('treats an omitted effect as the same error — there is no default', () => {
    const source = TYPECHECK_YAML.replace('effect: pure\n', '');
    expect(() => load(source)).toThrow(GateLoadError);
    try {
      load(source);
      expect.unreachable('a gate with no effect must not load');
    } catch (error) {
      expect((error as GateLoadError).code).toBe('GATE_MUST_BE_PURE');
    }
  });
});

suite('cwd: repo needs an explicit opt-in (S10, second scenario)', () => {
  const repoCwd = TYPECHECK_YAML.replace('cwd: worktree', 'cwd: repo');

  it('refuses without the opt-in', () => {
    try {
      load(repoCwd);
      expect.unreachable('cwd: repo must not load without the opt-in');
    } catch (error) {
      expect((error as GateLoadError).code).toBe('GATE_REPO_CWD_NOT_PERMITTED');
      expect((error as GateLoadError).file).toBe('.DeFlow/gates/typecheck.yaml');
    }
  });

  it('accepts it with the opt-in', () => {
    expect(load(repoCwd, { repoCwdPermitted: true }).cwd).toBe('repo');
  });

  it('needs no opt-in for the worktree default', () => {
    expect(load(TYPECHECK_YAML).cwd).toBe('worktree');
  });
});

suite('everything else that stops a definition loading', () => {
  it('reports an unparseable YAML file as a load failure, never a skip', () => {
    try {
      load('id: [unclosed\n');
      expect.unreachable('malformed YAML must not load');
    } catch (error) {
      expect((error as GateLoadError).code).toBe('GATE_DEFINITION_INVALID');
      expect((error as GateLoadError).file).toBe('.DeFlow/gates/typecheck.yaml');
    }
  });

  it('names the offending field on a schema failure', () => {
    const source = TYPECHECK_YAML.replace('parser: tsc', 'parser: hand-waving');
    try {
      load(source);
      expect.unreachable('an unknown parser must not load');
    } catch (error) {
      expect((error as GateLoadError).code).toBe('GATE_DEFINITION_INVALID');
      expect((error as GateLoadError).message).toContain('findings.parser');
    }
  });

  it('rejects a timeout that is not a duration', () => {
    const source = TYPECHECK_YAML.replace('timeout: 300s', 'timeout: soon');
    expect(() => load(source)).toThrow(GateLoadError);
  });

  it('accepts the duration units a definition may spell', () => {
    const at = (timeout: string) =>
      load(TYPECHECK_YAML.replace('timeout: 300s', `timeout: ${timeout}`)).timeoutMs;
    expect(at('5s')).toBe(5_000);
    expect(at('2m')).toBe(120_000);
    expect(at('750ms')).toBe(750);
  });
});
