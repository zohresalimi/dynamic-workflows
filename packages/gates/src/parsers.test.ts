/**
 * KAR-12.1 test plan #5 — the seven `findings.parser` values, each against
 * output captured from the real tool at the version this workspace pins.
 *
 * The fixtures in ../test/fixtures/parsers were produced by running the tool,
 * not by imagining its shape: a parser written against an invented shape passes
 * its own test and fails on the first real run. The only edits made to them are
 * the two the privacy rules require — the absolute path of the capture
 * directory and the capturing machine's hostname — and both are replaced with
 * synthetic values rather than removed.
 *
 * Verifies: EPIC-12-S7 · AC8
 */
import type { GateId } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';
import type { GateFinding } from './finding.ts';
import { GATE_PARSERS, type GateParser, parseFindings } from './parsers.ts';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../test/fixtures/parsers/${name}`, import.meta.url)), 'utf8');

/** The root the vitest capture was taken under; see the fixture header. */
const CAPTURE_ROOT = '/tmp/deflow-gate-fixture';

const parse = (
  parser: GateParser,
  stdout: string,
  options: { readonly repoRoot?: string; readonly path?: string } = {},
): readonly GateFinding[] =>
  parseFindings(parser, {
    gate: 'gate-under-test' as GateId,
    repoRoot: options.repoRoot ?? CAPTURE_ROOT,
    stdout,
    stderr: '',
    ...(options.path === undefined ? {} : { path: options.path }),
  });

interface Case {
  readonly parser: GateParser;
  readonly stdout: string;
  readonly ruleExample: string;
  readonly path?: string;
}

const CASES: readonly Case[] = [
  { parser: 'tsc', stdout: fixture('tsc.txt'), ruleExample: 'ts2345' },
  { parser: 'eslint-json', stdout: fixture('oxlint.json'), ruleExample: 'no-floating-promises' },
  {
    parser: 'biome-json',
    stdout: fixture('biome-report.json'),
    ruleExample: 'lint/suspicious/noDebugger',
  },
  { parser: 'vitest-json', stdout: fixture('vitest.json'), ruleExample: 'test/failed' },
  { parser: 'junit-xml', stdout: fixture('junit.xml'), ruleExample: 'test/failed' },
  {
    parser: 'jsonl',
    stdout: fixture('bundle-budget.jsonl'),
    ruleExample: 'budget/bundle-size',
    path: '$.violations',
  },
];

suite('every parser against a captured fixture (S7, first scenario)', () => {
  for (const testCase of CASES) {
    suite(testCase.parser, () => {
      const findings = parse(
        testCase.parser,
        testCase.stdout,
        testCase.path === undefined ? {} : { path: testCase.path },
      );

      it('produces at least one finding', () => {
        expect(findings.length).toBeGreaterThan(0);
      });

      it('gives every finding a repo-relative POSIX file path', () => {
        for (const finding of findings) {
          expect(finding.file).not.toContain('\\');
          expect(finding.file.startsWith('/')).toBe(false);
        }
      });

      it('gives every finding a 1-based range.startLine', () => {
        for (const finding of findings) {
          expect(Number.isInteger(finding.range.startLine)).toBe(true);
          expect(finding.range.startLine).toBeGreaterThanOrEqual(1);
        }
      });

      it('gives every finding a non-empty rule', () => {
        for (const finding of findings) expect(finding.rule).not.toBe('');
      });

      it(`reports the documented rule example`, () => {
        expect(findings.map((finding) => finding.rule)).toContain(testCase.ruleExample);
      });

      it('gives every finding a stable id of exactly 12 hex characters', () => {
        for (const finding of findings) expect(finding.id).toMatch(/^[0-9a-f]{12}$/);
      });

      it('gives every finding a non-empty message and a known severity', () => {
        for (const finding of findings) {
          expect(finding.message).not.toBe('');
          expect(['error', 'warning', 'info']).toContain(finding.severity);
        }
      });
    });
  }
});

suite('parser "none" (S7, second scenario)', () => {
  it('is one of the seven and produces no findings at all', () => {
    expect([...GATE_PARSERS]).toEqual([
      'tsc',
      'eslint-json',
      'biome-json',
      'vitest-json',
      'junit-xml',
      'jsonl',
      'none',
    ]);
    expect(parse('none', 'a wall of build output\nwith no structure in it\n')).toEqual([]);
  });
});

suite('what each parser reads out of its own fixture', () => {
  it('tsc: file, line, column, code and message', () => {
    const [first, second] = parse('tsc', fixture('tsc.txt'));
    expect(first).toMatchObject({
      file: 'packages/ui/src/App.ts',
      rule: 'ts2322',
      severity: 'error',
      range: { startLine: 4, startCol: 7 },
      message: "Type 'string' is not assignable to type 'number'.",
    });
    expect(second?.rule).toBe('ts2345');
  });

  it('tsc: a win32-shaped path in the output becomes POSIX (S7, third scenario)', () => {
    const [first] = parse('tsc', fixture('tsc-win32.txt'));
    expect(first?.file).toBe('packages/ui/src/App.vue');
  });

  it('eslint-json: the rule id is unwrapped from its plugin prefix', () => {
    const rules = parse('eslint-json', fixture('oxlint.json')).map((finding) => finding.rule);
    expect(rules).toEqual(['no-debugger', 'no-floating-promises']);
  });

  it('biome-json: the category is the rule, and a whole-file diagnostic is line 1', () => {
    const findings = parse('biome-json', fixture('biome-report.json'));
    expect(findings.map((finding) => finding.rule)).toContain('format');
    for (const finding of findings) expect(finding.range.startLine).toBeGreaterThanOrEqual(1);
  });

  it('vitest-json: only failed assertions become findings, anchored at the failing line', () => {
    const findings = parse('vitest-json', fixture('vitest.json'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'test/math.test.ts',
      rule: 'test/failed',
      severity: 'error',
      range: { startLine: 8 },
    });
    expect(findings[0]?.message).toContain('subtracts');
  });

  it('junit-xml: one finding per failing testcase', () => {
    const findings = parse('junit-xml', fixture('junit.xml'));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: 'test/math.test.ts',
      rule: 'test/failed',
      range: { startLine: 8 },
    });
  });

  it('jsonl: $.violations is honoured, and severity comes from the producer', () => {
    const findings = parse('jsonl', fixture('bundle-budget.jsonl'), { path: '$.violations' });
    expect(findings).toHaveLength(2);
    expect(findings.map((finding) => finding.severity)).toEqual(['error', 'warning']);
    expect(findings[0]?.file).toBe('packages/ui/src/main.ts');
  });

  it('jsonl: without a path expression each line is itself a finding', () => {
    const stdout =
      '{"file":"src/a.ts","line":3,"rule":"budget/bundle-size","severity":"error","message":"over"}\n';
    expect(parse('jsonl', stdout)).toHaveLength(1);
  });
});
