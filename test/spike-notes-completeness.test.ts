/**
 * KAR-00.7 — the go/no-go decision record is complete and internally
 * consistent.
 *
 * All three checks read committed markdown and source files off disk and
 * apply a pure guard, with no subprocess and no network — the same shape as
 * test/workspace-structure.test.ts and test/ci-workflow.test.ts, which is why
 * this lives in the "unit" project (test/*.test.ts) rather than
 * test/integration/, even though the epic's own test-plan table calls tests 1
 * and 2 "integration": the epic file is written before implementation and
 * grades a check by what it exercises, not by which Vitest project a
 * fs-only/no-subprocess check happens to be filed under in this repo.
 *
 * Verifies: EPIC-00-S21, EPIC-00-S22, EPIC-00-S23 (KAR-00.7 test plan #1-#3).
 * Test plan #4 ("read the go/no-go note against the kill criterion text side
 * by side") is manual by the story's own test plan and is not automated here.
 */
import { expect, it, describe as suite } from 'vitest';
import { describe as render } from './support/guards.ts';
import {
  checkNoHardcodedCapabilityMatrix,
  checkNoteHasMeasurementAndDecision,
  checkRiskIdsCovered,
  checkSpikeNotesComplete,
  closesFromFrontMatter,
  GO_NO_GO_NOTE_PATH,
  type NoteFile,
  OWNED_RISK_IDS,
  SPIKE_NOTE_FILES,
} from './support/spike-notes.ts';
import { exists, readSources, readText, walk } from './support/workspace.ts';

function readNote(path: string): NoteFile {
  return { path, text: readText(path) };
}

const allNotes = (): NoteFile[] => SPIKE_NOTE_FILES.map(readNote);

suite('KAR-00.7 test plan #1 — one complete decision note per spike (AC1)', () => {
  it('has exactly the six note files the seven roadmap spikes resolve to, each present', () => {
    expect(SPIKE_NOTE_FILES).toEqual([
      'docs/spikes/S1-acp-round-trip.md',
      'docs/spikes/S2-zero-build.md',
      'docs/spikes/S3-elk-worker.md',
      'docs/spikes/S4-one-port.md',
      'docs/spikes/S5-native-prebuilds.md',
      'docs/spikes/S7-biome-vue.md',
    ]);
    for (const path of SPIKE_NOTE_FILES) {
      expect(exists(path), path).toBe(true);
    }
  });

  it('has a non-empty "## Measurement" and "## Decision" section in every note', () => {
    expect(render(checkSpikeNotesComplete(allNotes()))).toBe('');
  });

  it('rejects a note whose "## Measurement" section is a one-line impression (EPIC-00-S23 scenario 1)', () => {
    const violating: NoteFile = {
      path: 'docs/spikes/S5-native-prebuilds.md',
      text: '# S5\n\n## Measurement\n\nworked fine on my machine\n\n## Decision\n\nadopt.\n',
    };
    const violations = checkNoteHasMeasurementAndDecision(violating);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations[0]?.where).toBe('docs/spikes/S5-native-prebuilds.md');
    expect(violations[0]?.message).toContain('prose impression');
  });

  it('rejects a note with no "## Measurement" heading at all', () => {
    const violating: NoteFile = {
      path: 'docs/spikes/S7-biome-vue.md',
      text: '# S7\n\n## Decision\n\nadopt.\n',
    };
    const violations = checkNoteHasMeasurementAndDecision(violating);
    expect(violations.some((v) => v.message.includes('no "## Measurement" heading'))).toBe(true);
  });

  it('accepts a note whose measurement is numeric and whose decision is stated', () => {
    const clean: NoteFile = {
      path: 'docs/spikes/S1-acp-round-trip.md',
      text: '# S1\n\n## Measurement\n\n17 events, spread 6699 ms.\n\n## Decision\n\nGO.\n',
    };
    expect(checkNoteHasMeasurementAndDecision(clean)).toEqual([]);
  });

  it('has a dated, committed go/no-go note', () => {
    expect(exists(GO_NO_GO_NOTE_PATH)).toBe(true);
    const text = readText(GO_NO_GO_NOTE_PATH);
    expect(text).toMatch(/\*\*Date:\*\*\s*2026-08-04/);
  });
});

suite(
  'KAR-00.7 test plan #2 — no hardcoded capability matrix survives as a source constant (AC5)',
  () => {
    it('finds fixtures/capabilities/ populated with generated, per-agent files', () => {
      expect(exists('fixtures/capabilities')).toBe(true);
      const files = walk('fixtures/capabilities', (path) => path.endsWith('.json'));
      expect(files.length).toBeGreaterThanOrEqual(2);
      for (const file of files) {
        const fixture = JSON.parse(readText(file)) as {
          probedAt?: string;
          capabilityMatrix?: unknown;
        };
        expect(fixture.probedAt, file).toBeTruthy();
        expect(fixture.capabilityMatrix, file).toBeTruthy();
      }
    });

    it('grep of packages/ and spikes/ finds no literal capability-matrix object', () => {
      const sources = readSources([
        ...walk('packages', (path) => path.endsWith('.ts')),
        ...walk('spikes', (path) => path.endsWith('.ts')),
      ]);
      expect(render(checkNoHardcodedCapabilityMatrix(sources))).toBe('');
    });

    it('the guard itself detects a hardcoded matrix when one is present', () => {
      const violations = checkNoHardcodedCapabilityMatrix([
        {
          path: 'packages/adapters/src/matrix.ts',
          text:
            'export const MATRIX = { resume: true, list: false, loadSession: true, mcpHttp: true, ' +
            'mcpSse: false, mcpAcp: false, promptImage: true, promptAudio: false, promptEmbeddedContext: true };',
        },
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]?.where).toBe('packages/adapters/src/matrix.ts');
    });

    it('does not flag a type declaration or a partial comparison snapshot', () => {
      const violations = checkNoHardcodedCapabilityMatrix([
        {
          path: 'spikes/s1-acp/src/report.ts',
          text: 'export interface CapabilityMatrix { resume: boolean; list: boolean; loadSession: boolean; mcpHttp: boolean; mcpSse: boolean; mcpAcp: boolean; promptImage: boolean; promptAudio: boolean; promptEmbeddedContext: boolean; }',
        },
        {
          path: 'spikes/s1-acp/src/capabilities.ts',
          text: "const SNAPSHOT = { 'claude-agent-acp': { resume: true, list: true } };",
        },
      ]);
      expect(violations).toEqual([]);
    });
  },
);

suite('KAR-00.7 test plan #3 — every owned open-risk id is claimed (AC4)', () => {
  it('parses a note\'s "closes:" front matter', () => {
    const note = '---\ncloses: [A0-1, A0-3, A4-2]\n---\n\n# S1\n';
    expect(closesFromFrontMatter(note)).toEqual(['A0-1', 'A0-3', 'A4-2']);
  });

  it('returns an empty list for a note with no front matter', () => {
    expect(closesFromFrontMatter('# S4\n\nno front matter here\n')).toEqual([]);
  });

  it("the union of every note's declared closes: ids covers all ten ids this epic owns", () => {
    expect(render(checkRiskIdsCovered(allNotes(), OWNED_RISK_IDS))).toBe('');
  });

  it('the guard flags a risk id that no note declares', () => {
    const violations = checkRiskIdsCovered(
      [{ path: 'docs/spikes/S1-acp-round-trip.md', text: '---\ncloses: [A0-1]\n---\n' }],
      ['A0-1', 'A2-1'],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('A2-1');
  });
});

suite('KAR-00.7 AC2 — the go/no-go note restates the kill criterion and names a decision', () => {
  const note = () => readText(GO_NO_GO_NOTE_PATH);

  it('restates the kill criterion verbatim from the epic file', () => {
    const epic = readText('docs/delivery/epics/EPIC-00-foundation-spikes.md');
    const kernel =
      'exec shims prove hopelessly unstable across two vendors, then the provider-neutrality thesis';
    expect(epic).toContain(kernel);
    expect(note()).toContain(kernel);
  });

  it('names exactly one of the three decisions', () => {
    const text = note();
    const named = ['**NO-GO**', '**GO, re-weighted**', '**GO.**'].filter((token) =>
      text.includes(token),
    );
    expect(named).toHaveLength(1);
  });

  it('lists every owned risk id with a closed/still-open verdict (AC4)', () => {
    const text = note();
    for (const id of OWNED_RISK_IDS) {
      expect(text, id).toMatch(new RegExp(`${id}[^\\n]*(closed|still open)`, 'i'));
    }
  });
});
