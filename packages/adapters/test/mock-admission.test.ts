/**
 * KAR-19.7 AC3 — `admitFraming` is unchanged, and a source guard proves it.
 *
 * The tempting fix for *"nothing on this machine can serve a framing turn"* was
 * one line in `admitFraming`: let the bundled agent through, or drop the
 * `structuredOutputFlag` requirement. Both are refused for the reason KAR-10.2
 * AC3 gives — *"the fallback for a spec is not a softer contract, it is a
 * different adapter"* — and a special case for the test double is exactly the
 * kind of exception that leaves the production branch exercised by nothing
 * anybody runs.
 *
 * So admission reaches `native` for the bundled agent through the same two
 * questions it asks of every provider, having learned nothing about mocks. The
 * third suite is the mechanical form of that claim: if admission cannot name
 * the agent, it cannot be special-cased for it.
 *
 * Verifies: EPIC-19-S46 · AC3 · test plan #3
 */
import { NodeFailureError, NodeIdSchema } from '@DeFlow/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { admitFraming, type CapabilityRow, shimCapabilityRow } from '../src/index.ts';

const srcDir = new URL('../src/', import.meta.url).pathname;

/**
 * Removes block comments and whole-line `//` comments, leaving executable
 * source — the same reading `no-capability-table.test.ts` performs, restated
 * here rather than imported from it: importing a spec file registers its
 * suites into this one's run.
 */
function strippedOfComments(source: string): string {
  return source
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

const NODE = NodeIdSchema.parse('framing');
const PROVIDER = 'mock';

const row = (): CapabilityRow =>
  shimCapabilityRow({
    provider: PROVIDER,
    version: '0.0.0',
    binaryPath: '/opt/DeFlow/deflow-mock-agent',
    binarySha256: 'c'.repeat(64),
    probedAt: 1_754_470_000_000,
  });

suite('EPIC-19-S46 — admission answers through the questions it already asks', () => {
  it('admits a framing node routed onto the bundled agent', () => {
    expect(admitFraming({ node: NODE, provider: PROVIDER }, row())).toBeNull();
  });

  it('refuses it with no probed row, exactly as it does every other provider', () => {
    const refusal = admitFraming({ node: NODE, provider: PROVIDER }, null);

    expect(refusal).toBeInstanceOf(NodeFailureError);
    expect(refusal?.deflowFailure.reason).toBe('adapter.capability-missing');
  });

  it('still refuses a provider with no flag to take a schema on', () => {
    const refusal = admitFraming({ node: NODE, provider: 'nothing-registered' }, row());

    expect(refusal).toBeInstanceOf(NodeFailureError);
  });
});

/**
 * The three files admission is made of. Named individually rather than scanned
 * as a directory: the claim is about these three, and a glob that silently
 * matched none of them would pass for ever.
 */
const ADMISSION_FILES = ['framing-admission.ts', 'admission.ts', 'structured-output.ts'];

/** Every provider id the registry is the one file allowed to name. */
const PROVIDERS = ['mock', 'claude', 'codex', 'gemini', 'copilot', 'opencode'];

suite('EPIC-19-S46 — no provider is named where a decision is made', () => {
  it.each(ADMISSION_FILES)('%s names no provider in its executable half', (name) => {
    const code = strippedOfComments(readFileSync(join(srcDir, name), 'utf8')).toLowerCase();

    for (const provider of PROVIDERS) expect(code).not.toContain(provider);
  });

  it('and that is a real result, not an empty read', () => {
    for (const name of ADMISSION_FILES) {
      expect(strippedOfComments(readFileSync(join(srcDir, name), 'utf8')).length).toBeGreaterThan(
        200,
      );
    }
  });
});
