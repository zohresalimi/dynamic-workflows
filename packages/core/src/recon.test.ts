/**
 * KAR-10.5 — the verification half of repository reconnaissance, as pure
 * decisions over what the daemon read from the worktree.
 *
 * The integration specs
 * (`packages/daemon/test/integration/recon-survey.test.ts`) run the whole node;
 * these pin the rule that gives `confidence` its meaning — a claimed command is
 * `verified` only when the script key is really in the manifest — without a
 * repository, a ledger or an agent, because it is a decision and not I/O.
 *
 * Verifies: EPIC-10-S24, EPIC-10-S25, EPIC-10-S27 · AC2, AC3, AC4, AC5, AC8
 */
import { expect, it, describe as suite } from 'vitest';
import { HandleSchema } from './ids.ts';
import {
  deriveReconFacts,
  jsonScriptLineRange,
  RECON_FACT_SCHEMA_ID,
  RECON_PERMISSION,
  RECON_RETURN_MAX_TOKENS,
  type ReconFactCandidate,
  type RepoObservation,
  reconReturns,
  scriptKeyOf,
} from './recon.ts';

const SURVEY_HANDLE = HandleSchema.parse(`artifact://${'a'.repeat(64)}`);

const MANIFEST = `{
  "name": "ui",
  "private": true,
  "scripts": {
    "test": "vitest run",
    "build": "vite build"
  }
}
`;

const observation = (over: Partial<RepoObservation> = {}): RepoObservation => ({
  manifest: {
    path: 'package.json',
    kind: 'package.json',
    text: MANIFEST,
    scripts: { test: 'vitest run', build: 'vite build' },
  },
  scope: { paths: ['packages/ui'], fileCount: 47 },
  gates: [],
  ...over,
});

const byKey = (facts: readonly ReconFactCandidate[], key: string): ReconFactCandidate => {
  const found = facts.find((fact) => fact.key === key);
  if (found === undefined) throw new Error(`no ${key} fact was derived from ${facts.length}`);
  return found;
};

suite('the node type', () => {
  it('surveys at read, and returns under the recon budget rather than the default', () => {
    expect(RECON_PERMISSION).toBe('read');
    expect(RECON_RETURN_MAX_TOKENS).toBe(4000);
    expect(reconReturns().maxTokens).toBe(4000);
  });
});

suite('scriptKeyOf — which manifest key a claimed command would run', () => {
  it('reads the key out of every spelling a package manager accepts', () => {
    expect(scriptKeyOf('pnpm test')).toBe('test');
    expect(scriptKeyOf('pnpm test:unit')).toBe('test:unit');
    expect(scriptKeyOf('pnpm run build')).toBe('build');
    expect(scriptKeyOf('npm run test:unit')).toBe('test:unit');
    expect(scriptKeyOf('yarn lint')).toBe('lint');
  });

  it('answers null for a command that is not a script invocation at all', () => {
    expect(scriptKeyOf('cargo test')).toBeNull();
    expect(scriptKeyOf('vitest run')).toBeNull();
    expect(scriptKeyOf('')).toBeNull();
  });
});

suite('jsonScriptLineRange — the evidence a manifest read produces', () => {
  it('addresses the line the script key is declared on, 1-based', () => {
    expect(jsonScriptLineRange(MANIFEST, 'test')).toEqual({ start: 5, end: 5 });
    expect(jsonScriptLineRange(MANIFEST, 'build')).toEqual({ start: 6, end: 6 });
  });

  it('answers null for a key the manifest does not declare', () => {
    expect(jsonScriptLineRange(MANIFEST, 'test:unit')).toBeNull();
  });
});

suite('EPIC-10-S25 — verified means the script key exists (AC2)', () => {
  it('records a claimed command that exists as verified, with the manifest line as evidence', () => {
    const facts = deriveReconFacts({
      survey: {
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript', packageManager: 'pnpm' },
        commands: { test: 'pnpm test', build: 'pnpm build' },
      },
      observation: observation(),
      surveyHandle: SURVEY_HANDLE,
    });

    const test = byKey(facts, 'finding/test-command');
    expect(test.confidence).toBe('verified');
    expect(test.fromEvidence).toEqual(['file://package.json#L5-L5']);
    expect(test.value).toMatchObject({ reconKind: 'command', role: 'test', command: 'pnpm test' });
    expect(test.schemaId).toBe(RECON_FACT_SCHEMA_ID);
  });

  it('records a claimed command the manifest does not declare as speculative, with no evidence', () => {
    const facts = deriveReconFacts({
      survey: {
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript', packageManager: 'pnpm' },
        commands: { test: 'pnpm test:unit' },
      },
      observation: observation(),
      surveyHandle: SURVEY_HANDLE,
    });

    const test = byKey(facts, 'finding/test-command');
    expect(test.confidence).toBe('speculative');
    expect(test.confidence).not.toBe('verified');
    expect(test.fromEvidence).toEqual([]);
    expect(test.value).toMatchObject({ command: 'pnpm test:unit', script: null });
  });

  it('verifies a command the manifest declares even when the agent claimed none', () => {
    const facts = deriveReconFacts({
      survey: {
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript' },
        commands: {},
      },
      observation: observation(),
      surveyHandle: SURVEY_HANDLE,
    });

    expect(byKey(facts, 'finding/build-command').confidence).toBe('verified');
    expect(byKey(facts, 'finding/build-command').value).toMatchObject({ command: 'vite build' });
  });
});

suite('EPIC-10-S24 — scope and toolchain (AC3, AC5)', () => {
  it('carries the discovered path set, its file count and the survey handle', () => {
    const facts = deriveReconFacts({
      survey: {
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript', packageManager: 'pnpm' },
        commands: { test: 'pnpm test' },
      },
      observation: observation(),
      surveyHandle: SURVEY_HANDLE,
    });

    const scope = byKey(facts, 'scope/touched-paths');
    expect(scope.kind).toBe('scope');
    expect(scope.value).toEqual({
      reconKind: 'scope',
      paths: ['packages/ui'],
      fileCount: 47,
      survey: SURVEY_HANDLE,
    });
    expect(scope.fromEvidence).toEqual([SURVEY_HANDLE]);
  });

  it('gives every derived fact at least one evidence handle it was read from', () => {
    const facts = deriveReconFacts({
      survey: {
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript', packageManager: 'pnpm' },
        commands: { test: 'pnpm test', build: 'pnpm build' },
      },
      observation: observation({
        gates: [{ id: 'typecheck', path: '.DeFlow/gates/typecheck.yaml', lines: 9 }],
      }),
      surveyHandle: SURVEY_HANDLE,
    });

    // The speculative arm is the documented exception (EPIC-10-S25): a claim
    // with nothing behind it must not be handed an evidence handle it did not
    // come from. Every other fact was derived from something addressable.
    for (const fact of facts) {
      if (fact.confidence === 'speculative') continue;
      expect(fact.fromEvidence.length).toBeGreaterThan(0);
    }
  });
});

suite('EPIC-10-S27 — gate definitions already in the repository (AC4)', () => {
  it('names each discovered gate id with the file it was read from', () => {
    const facts = deriveReconFacts({
      survey: {
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript' },
        commands: {},
      },
      observation: observation({
        gates: [
          { id: 'typecheck', path: '.DeFlow/gates/typecheck.yaml', lines: 9 },
          { id: 'visual-regression', path: '.DeFlow/gates/visual-regression.yaml', lines: 14 },
        ],
      }),
      surveyHandle: SURVEY_HANDLE,
    });

    const gates = byKey(facts, 'finding/repo-gates');
    expect(gates.confidence).toBe('verified');
    expect(gates.value).toEqual({
      reconKind: 'gates',
      gates: [
        { id: 'typecheck', path: '.DeFlow/gates/typecheck.yaml' },
        { id: 'visual-regression', path: '.DeFlow/gates/visual-regression.yaml' },
      ],
    });
    expect(gates.fromEvidence).toEqual([
      'file://.DeFlow/gates/typecheck.yaml#L1-L9',
      'file://.DeFlow/gates/visual-regression.yaml#L1-L14',
    ]);
  });

  it('writes no gates fact at all when the repository defines none', () => {
    const facts = deriveReconFacts({
      survey: {
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript' },
        commands: {},
      },
      observation: observation(),
      surveyHandle: SURVEY_HANDLE,
    });

    expect(facts.map((fact) => fact.key)).not.toContain('finding/repo-gates');
  });
});

suite('EPIC-10-S25 — a repository with no manifest at all (AC8)', () => {
  it('states that detection failed, at asserted, and fabricates no command', () => {
    const facts = deriveReconFacts({
      survey: {
        schemaId: 'DeFlow.reconsurvey.v1',
        toolchain: { language: 'typescript', packageManager: 'pnpm' },
        // The model is happy to guess. Nothing in the repository confirms it.
        commands: { test: 'pnpm test', build: 'pnpm build' },
      },
      observation: observation({ manifest: null, scope: { paths: [], fileCount: 0 } }),
      surveyHandle: SURVEY_HANDLE,
    });

    for (const key of ['finding/toolchain', 'finding/test-command', 'finding/build-command']) {
      const fact = byKey(facts, key);
      expect(fact.confidence).toBe('asserted');
      expect(fact.value).toMatchObject({ reconKind: 'detection-failed' });
      expect(fact.fromEvidence).toEqual([SURVEY_HANDLE]);
    }

    // Nothing anywhere in the derived set repeats the model's guess as a
    // command a plan could schedule.
    expect(JSON.stringify(facts)).not.toContain('pnpm test');
    expect(JSON.stringify(facts)).not.toContain('pnpm build');
  });
});
