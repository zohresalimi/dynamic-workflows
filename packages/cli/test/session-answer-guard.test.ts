/**
 * KAR-21.3 AC2 / EPIC-21-S19 — one answer path, three callers, no fourth
 * implementation.
 *
 * This is the epic's second structural guard and it exists for the same reason
 * as the first. *Which* HTTP request answers *which* gate was a private
 * decision inside `deflow answer` until KAR-22.5 moved it into
 * `gateAnswerRequest`, whose own module note says what happens otherwise: *"a
 * second private copy is how the day a fifth spec decision is added ends with
 * one surface still answering the old way."* The terminal session is that
 * function's third caller, and the thing being protected is invisible in a diff
 * that looks locally reasonable — a route template inside a session module is
 * three characters and a plausible comment.
 *
 * **The forbidden vocabulary is derived from `gateAnswerRequest`'s own output**,
 * never spelled here. A guard that hard-coded `/spec/approve` would be a second
 * copy of the very decision it is defending, and it would keep passing on the
 * day that decision changed.
 *
 * The rule is a function of a path and a source rather than a loop over the
 * disk, so the second scenario can hand it a fixture and watch it bite — a
 * guard extended in name only passes forever.
 *
 * Verifies: EPIC-21-S19 · KAR-21.3 AC2 · test plan #2
 */
import { gateAnswerRequest, SPEC_DECISIONS, SPEC_GATE_NODE } from '@DeFlow/core';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, describe as suite } from 'vitest';

const CLI_SRC = fileURLToPath(new URL('../src/', import.meta.url));
const SESSION_DIR = join(CLI_SRC, 'run', 'session');

/** Two arbitrary but well-formed identifiers, so the paths below are real. */
const RUN_ID = 'run_20260816T101500Z_0a0a0a';
const PLAN_GATE = 'confirm-scope';

const specPath = gateAnswerRequest({
  runId: RUN_ID,
  gate: SPEC_GATE_NODE,
  optionId: SPEC_DECISIONS[0],
})?.path;
const nodePath = gateAnswerRequest({ runId: RUN_ID, gate: PLAN_GATE, optionId: 'go' })?.path;

/**
 * The route fragments no session module may contain, cut out of the two paths
 * `gateAnswerRequest` actually produces.
 *
 * Sliced rather than written: `/spec/` and `/respond` appear nowhere in this
 * file as literals, so the day KAR-10.3's routes move, this guard moves with
 * them instead of guarding a shape that no longer exists.
 */
function forbiddenFragments(): readonly string[] {
  if (specPath === undefined || nodePath === undefined) {
    throw new Error('gateAnswerRequest answered neither of its two routing paths');
  }
  const at = specPath.indexOf(RUN_ID);
  return [
    // `/api/runs/` — the prefix both paths share.
    specPath.slice(0, at),
    // `/spec/` — everything between the run id and the decision.
    specPath.slice(at + RUN_ID.length, specPath.lastIndexOf('/') + 1),
    // `/respond` — the tail of the other route.
    nodePath.slice(nodePath.lastIndexOf('/')),
  ];
}

/** The transport words a module that answered for itself would have to carry. */
const TRANSPORT_LITERALS = ['fetch(', 'JSON.stringify(', 'Bearer ', "'POST'", '"POST"'];

const REASON =
  'Which request answers which gate is decided once, in gateAnswerRequest (@DeFlow/core), and ' +
  'the transport belongs to packages/cli/src/run/gate-answer.ts. A route or a body under ' +
  'packages/cli/src/run/session/ is the fourth implementation KAR-22.5 exists to prevent ' +
  '(KAR-21.3 AC2).';

/** Rule, as a function of one file, so a fixture can be run through it. */
function gateRouteRule(path: string, code: string): string | null {
  for (const fragment of forbiddenFragments()) {
    if (code.includes(fragment)) return `${path} spells the route fragment "${fragment}" itself`;
  }
  for (const literal of TRANSPORT_LITERALS) {
    if (code.includes(literal)) return `${path} builds a request itself ("${literal}")`;
  }
  return null;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts')) return [];
    if (entry.name.endsWith('.test.ts')) return [];
    return [path];
  });
}

/** Over-removes at worst, which can only make the rule stricter. */
function codeOnly(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

suite('EPIC-21-S19 — no route string and no request body in the session', () => {
  it('covers every source file under run/session/', () => {
    // A directory walk, so a new module added beside the others is guarded the
    // day it lands rather than the day somebody remembers.
    const covered = sourceFiles(SESSION_DIR).map((file) => relative(SESSION_DIR, file));

    expect(covered).toContain('gate.ts');
    expect(covered).toContain('view.ts');
    expect(covered.length).toBeGreaterThan(3);
  });

  it('finds no spec route, no respond route and no request body in any of them', () => {
    for (const file of sourceFiles(SESSION_DIR)) {
      const path = relative(SESSION_DIR, file);
      expect(
        gateRouteRule(path, codeOnly(readFileSync(file, 'utf8'))),
        `run/session/${path} answers a gate for itself. ${REASON}`,
      ).toBeNull();
    }
  });

  it('routes the directory’s one gate answer through gateAnswerRequest', () => {
    // The negative rules above are satisfied by a directory that answers no
    // gate at all. This is the positive half: the session does answer one, and
    // it does it through the function that owns the decision.
    const sources = sourceFiles(SESSION_DIR).map((file) => codeOnly(readFileSync(file, 'utf8')));

    expect(sources.filter((code) => code.includes('gateAnswerRequest')).length).toBe(1);
    expect(sources.some((code) => code.includes("from '@DeFlow/core'"))).toBe(true);
  });

  it('bites when a route template comes back into the session', () => {
    // The shape the epic is afraid of: a template somebody reasonably wrote
    // while solving one small problem, in a file whose diff reads fine.
    const fixture = [
      'export const answer = (runId: string) =>',
      '  fetch(`/api/runs/${runId}/spec/approve`, { method: "POST" });',
    ].join('\n');

    const violation = gateRouteRule('gate.ts', fixture);

    expect(violation).not.toBeNull();
    expect(violation).toContain('gate.ts');
  });

  it('bites on the other route, and on a hand-built body', () => {
    expect(
      gateRouteRule('gate.ts', 'const p = `/api/runs/${id}/nodes/${n}/respond`;'),
    ).not.toBeNull(
      // The plan-gate route is the half a guard written against the spec gate
      // alone would miss, and it is the one every non-F1.3 gate uses.
    );
    expect(gateRouteRule('gate.ts', 'const body = JSON.stringify({ optionId });')).not.toBeNull();
    // And a file that carries none of it is clean, so the rule is not vacuous.
    expect(gateRouteRule('gate.ts', 'export const answerable = (r) => r !== null;')).toBeNull();
  });
});
