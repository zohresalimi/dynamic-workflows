/**
 * KAR-09.9 AC2 / EPIC-09-S50 — which mechanism carried the schema, and the
 * fact that the softer one is recorded rather than silent.
 *
 * *"Pass the schema to the CLI natively where supported — far more reliable
 * than prompt-only instructions."* Two things follow, and both are asserted
 * here: a vendor with a schema flag gets the file on its argv, and a vendor
 * without one gets the schema in its prompt **and** a manifest field saying so,
 * so the planner (F2.7) can prefer a native adapter for a node whose downstream
 * consumers depend on a strict contract.
 *
 * No vendor is named in the module under test — the flags live in the provider
 * registry, which is the one file allowed to know how each CLI is invoked. They
 * are named *here*, and this file lives under `test/` rather than beside its
 * module for exactly that reason: `no-capability-table.test.ts` scans every
 * file under `src/`, and a spec that has to name five vendors to prove the
 * reading is right does not belong in the directory that rule protects.
 *
 * Verifies: EPIC-09-S50 · AC2 · test plan #4
 */
import { SchemaIdSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { PROVIDER_SPECS, shimPlan } from '../src/provider-registry.ts';
import {
  providerStructuredOutput,
  STRUCTURED_OUTPUT_MECHANISMS,
  structuredOutputContract,
} from '../src/structured-output.ts';

const SCHEMA = SchemaIdSchema.parse('DeFlow.finding.v1');
const SCHEMAS_DIR = '/tmp/run/.DeFlow/schemas';

const shimContext = (over: Record<string, unknown> = {}) => ({
  resolved: { provider: PROVIDER_SPECS.claude.id, path: '/usr/local/bin/claude' },
  worktree: '/tmp/run/wt',
  prompt: 'implement the thing',
  sessionId: '00000000-0000-4000-8000-000000000001',
  permission: 'read' as const,
  ...over,
});

suite('the mechanism is read off the invocation registry (AC2)', () => {
  it('offers exactly two, and they are the two the manifest can record', () => {
    expect([...STRUCTURED_OUTPUT_MECHANISMS]).toEqual(['native', 'prompt-only']);
  });

  it('reports native for the two vendors whose CLI takes a schema file', () => {
    expect(providerStructuredOutput('claude')).toEqual({
      provider: 'claude',
      structuredOutput: 'native',
      flag: '--json-schema',
    });
    expect(providerStructuredOutput('codex')).toEqual({
      provider: 'codex',
      structuredOutput: 'native',
      flag: '--output-schema',
    });
  });

  it.each(['gemini', 'copilot', 'opencode'])('reports prompt-only for %s', (provider) => {
    expect(providerStructuredOutput(provider)).toEqual({
      provider,
      structuredOutput: 'prompt-only',
      flag: null,
    });
  });

  it('reports prompt-only for a provider nobody has registered', () => {
    // Not an exception: an unknown provider is a planning question, and the
    // conservative answer is the softer contract rather than a claim that a
    // CLI DeFlow has never seen honours a flag.
    expect(providerStructuredOutput('some-future-cli').structuredOutput).toBe('prompt-only');
  });
});

suite('the native path puts the schema on the argv (test plan #3)', () => {
  it('passes the emitted document through the vendor’s own flag', () => {
    const contract = structuredOutputContract({
      provider: 'claude',
      schemaId: SCHEMA,
      schemasDir: SCHEMAS_DIR,
      maxTokens: 1500,
    });

    expect(contract.mechanism).toBe('native');
    expect(contract.schemaPath).toBe(`${SCHEMAS_DIR}/DeFlow.finding.v1.json`);
    expect(contract.promptInjection).toBeNull();

    // KAR-19.11 — the contract still names the file, and what rides on the
    // flag is now the entry's declared form. Claude Code 2.1.220 parses the
    // value of `--json-schema` as JSON and exited 1 on the path on 2026-08-13,
    // so this vendor gets the **document**; Codex, whose flag takes a `<FILE>`,
    // still gets the path (`exec-shim-argument-forms.test.ts`).
    const document = JSON.stringify({ title: SCHEMA, type: 'object' });
    const plan = shimPlan(
      PROVIDER_SPECS.claude,
      shimContext({ schemaPath: contract.schemaPath, schemaDocument: document }),
    );
    const at = plan.argv.indexOf('--json-schema');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(plan.argv[at + 1] ?? '')).toEqual(JSON.parse(document));
    expect(plan.argv).not.toContain(contract.schemaPath);
  });

  it('leaves the argv alone when no contract asked for a schema', () => {
    const plan = shimPlan(PROVIDER_SPECS.claude, shimContext());
    expect(plan.argv).not.toContain('--json-schema');
  });

  it('does not put a schema flag on a vendor that has none', () => {
    const plan = shimPlan(
      PROVIDER_SPECS.opencode,
      shimContext({
        resolved: { provider: PROVIDER_SPECS.opencode.id, path: '/usr/local/bin/opencode' },
        schemaPath: `${SCHEMAS_DIR}/DeFlow.finding.v1.json`,
      }),
    );
    expect(plan.argv.join(' ')).not.toContain('.json');
  });
});

suite('the prompt-only fallback is recorded, not silent (EPIC-09-S50)', () => {
  it('injects the schema at prompt level and names the softer contract', () => {
    const contract = structuredOutputContract({
      provider: 'opencode',
      schemaId: SCHEMA,
      schemasDir: SCHEMAS_DIR,
      maxTokens: 4000,
    });

    expect(contract.mechanism).toBe('prompt-only');
    expect(contract.flag).toBeNull();
    // The path is still computed: a prompt-only adapter is handed the schema's
    // *contents*, and the caller needs to know which file to read.
    expect(contract.schemaPath).toBe(`${SCHEMAS_DIR}/DeFlow.finding.v1.json`);
    expect(contract.promptInjection).toContain('DeFlow.finding.v1');
    expect(contract.promptInjection).toContain('4000');
  });

  it('is the field the planner routes on, exposed as the manifest carries it', () => {
    expect(
      structuredOutputContract({
        provider: 'opencode',
        schemaId: SCHEMA,
        schemasDir: SCHEMAS_DIR,
        maxTokens: 4000,
      }).manifest,
    ).toEqual({ provider: 'opencode', structuredOutput: 'prompt-only', flag: null });
  });
});
