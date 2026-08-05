/**
 * KAR-05.6 AC5/AC6 — the M1 workflow tool set, and what a phase unlocks.
 *
 * Pure data, so a unit test: which tools exist, that each one declares *both*
 * an input and an output schema, and that the analysis phase is read-only.
 * The wire round trip is `test/integration/mcp-tool-roundtrip.test.ts`.
 *
 * Verifies: EPIC-05-S23, EPIC-05-S24 · AC5, AC6
 */
import { expect, it, describe as suite } from 'vitest';
import {
  M1_TOOLS,
  PROPOSE_PLAN_PATCH,
  READ_ARTIFACT,
  READ_FACT,
  toolNamesForPhase,
  toolsForPhase,
  WORKFLOW_PHASES,
} from './catalog.ts';

suite('the M1 tool set (AC5)', () => {
  it('is the three workflow tools the story names', () => {
    expect(M1_TOOLS.map((tool) => tool.name)).toEqual([
      READ_FACT,
      READ_ARTIFACT,
      PROPOSE_PLAN_PATCH,
    ]);
  });

  it('declares both an inputSchema and an outputSchema for every tool', () => {
    for (const tool of M1_TOOLS) {
      expect(Object.keys(tool.inputSchema).length, `${tool.name} inputSchema`).toBeGreaterThan(0);
      expect(Object.keys(tool.outputSchema).length, `${tool.name} outputSchema`).toBeGreaterThan(0);
    }
  });

  it('names every tool under the DeFlow prefix, so a vendor tool cannot collide', () => {
    for (const tool of M1_TOOLS) expect(tool.name.startsWith('DeFlow.')).toBe(true);
  });
});

suite('a phase unlocks tools (AC6)', () => {
  it('exposes only read-oriented tools during analysis', () => {
    expect(toolNamesForPhase('analysis')).toEqual([READ_FACT, READ_ARTIFACT]);
  });

  it('unlocks the plan-patch proposal in the implementation phase', () => {
    expect(toolNamesForPhase('implementation')).toContain(PROPOSE_PLAN_PATCH);
  });

  it('withdraws the plan-patch proposal again when the phase goes back to analysis', () => {
    expect(toolNamesForPhase('analysis')).not.toContain(PROPOSE_PLAN_PATCH);
  });

  it('returns tools from the catalog itself, never copies of them', () => {
    for (const phase of WORKFLOW_PHASES) {
      for (const tool of toolsForPhase(phase)) expect(M1_TOOLS).toContain(tool);
    }
  });
});
