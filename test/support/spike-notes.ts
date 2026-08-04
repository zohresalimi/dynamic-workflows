/**
 * KAR-00.7 — pure functions behind the notes-completeness check, the
 * closes-front-matter parser and the hardcoded-capability-matrix grep.
 *
 * "Pure" for the same reason test/support/guards.ts is: a check that has only
 * ever run against a compliant repository is not known to detect anything, so
 * every function here is exercised against both a violating fixture and a
 * clean one (test/spike-notes-completeness.test.ts).
 */
import type { SourceFile, Violation } from './guards.ts';

export { type Violation } from './guards.ts';

export interface NoteFile {
  readonly path: string;
  readonly text: string;
}

/**
 * Roadmap spike id -> the decision note that records it. KAR-00.5 combines
 * the roadmap's S5 (better-sqlite3) and S6 (@lydell/node-pty) into one note,
 * per the epic's own scope section ("S5 and S6 are combined into KAR-00.5") —
 * so both ids resolve to the same file, and `docs/spikes/` holds six note
 * files for the seven roadmap spike outcomes, not seven.
 */
export const SPIKE_NOTE_PATHS: Readonly<Record<string, string>> = {
  S1: 'docs/spikes/S1-acp-round-trip.md',
  S2: 'docs/spikes/S2-zero-build.md',
  S3: 'docs/spikes/S3-elk-worker.md',
  S4: 'docs/spikes/S4-one-port.md',
  S5: 'docs/spikes/S5-native-prebuilds.md',
  S6: 'docs/spikes/S5-native-prebuilds.md',
  S7: 'docs/spikes/S7-biome-vue.md',
};

/** Every distinct note file a roadmap spike resolves to, in id order. */
export const SPIKE_NOTE_FILES: readonly string[] = [...new Set(Object.values(SPIKE_NOTE_PATHS))];

export const GO_NO_GO_NOTE_PATH = 'docs/spikes/S0-go-no-go.md';

/**
 * AC4: the ten open-risk ids EPIC-00 was scoped to close, from the epic file
 * and roadmap §6.
 */
export const OWNED_RISK_IDS: readonly string[] = [
  'A0-1',
  'A0-3',
  'A0-6',
  'A1-1',
  'A1-2',
  'A2-1',
  'A2-3',
  'A3-4',
  'A3-5',
  'A4-2',
];

/**
 * The body of the first top-level ("## ") heading whose text starts with
 * `name` (so "## Measurement 1 — better-sqlite3" matches `name` "Measurement"),
 * up to the next top-level heading or the end of the file. `undefined` if no
 * such heading exists. A "### " subheading does not end the section.
 */
export function extractSection(text: string, name: string): string | undefined {
  const lines = text.split('\n');
  const headingStart = new RegExp(`^##\\s+${name}\\b`);
  const start = lines.findIndex((line) => headingStart.test(line));
  if (start === -1) return undefined;

  const nextTopLevel = /^##\s+\S/;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (nextTopLevel.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join('\n');
}

/**
 * EPIC-00-S23 scenario 1: a "## Measurement" section that is only a
 * one-line impression — the story's own example is "worked fine on my
 * machine" — is the same as no measurement at all.
 */
const IMPRESSION_PHRASES = [
  /^worked fine on my machine\.?$/i,
  /^seems fine\.?$/i,
  /^looks good\.?$/i,
];

/**
 * AC1 / EPIC-00-S21 scenario 1 / EPIC-00-S23 scenario 1: one note per roadmap
 * spike exists, and each has a non-empty "## Measurement" section that is not
 * a prose impression, and a non-empty "## Decision" section.
 */
export function checkNoteHasMeasurementAndDecision(note: NoteFile): Violation[] {
  const violations: Violation[] = [];

  const measurement = extractSection(note.text, 'Measurement');
  if (measurement === undefined) {
    violations.push({
      where: note.path,
      message:
        'has no "## Measurement" heading. A spike that ends in "seems fine" has not run — see ' +
        'docs/delivery/epics/EPIC-00-foundation-spikes.md "Why this matters".',
    });
  } else {
    const trimmed = measurement.trim();
    if (trimmed.length === 0) {
      violations.push({ where: note.path, message: '"## Measurement" section is empty.' });
    } else if (IMPRESSION_PHRASES.some((phrase) => phrase.test(trimmed))) {
      violations.push({
        where: note.path,
        message: `"## Measurement" section reads "${trimmed}" — a prose impression, not a recorded number. The spike must be re-run at its original timebox.`,
      });
    }
  }

  const decision = extractSection(note.text, 'Decision');
  if (decision === undefined || decision.trim().length === 0) {
    violations.push({
      where: note.path,
      message: 'has no non-empty "## Decision" section naming a decision.',
    });
  }

  return violations;
}

/** AC1: every expected note file exists and is complete. */
export function checkSpikeNotesComplete(notes: readonly NoteFile[]): Violation[] {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  const violations: Violation[] = [];

  for (const path of SPIKE_NOTE_FILES) {
    const note = byPath.get(path);
    if (note === undefined) {
      violations.push({ where: path, message: 'expected spike decision note does not exist.' });
      continue;
    }
    violations.push(...checkNoteHasMeasurementAndDecision(note));
  }

  return violations;
}

/**
 * The YAML front matter block a note opens with (between the first pair of
 * "---" lines), parsed by hand rather than pulled in the `yaml` package: the
 * shape is one key, `closes: [A0-1, A0-3]`, and a bracketed flow list on one
 * line is unambiguous without a general parser.
 */
export function closesFromFrontMatter(text: string): string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
  if (match === null) return [];
  const front = match[1] ?? '';
  const closesLine = /^closes:\s*\[([^\]]*)\]\s*$/m.exec(front);
  if (closesLine === null) return [];
  return (closesLine[1] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * AC4 / EPIC-00-S21 scenario 1: the union of every note's declared `closes:`
 * ids covers every id this epic owns. A note with no front matter declares
 * the empty set, which is legal (not every spike closes one of the ten).
 */
export function checkRiskIdsCovered(
  notes: readonly NoteFile[],
  requiredIds: readonly string[],
): Violation[] {
  const covered = new Set<string>();
  for (const note of notes) {
    for (const id of closesFromFrontMatter(note.text)) covered.add(id);
  }
  return requiredIds
    .filter((id) => !covered.has(id))
    .map((id) => ({
      where: 'docs/spikes/',
      message: `open-risk id ${id} is not declared "closes:" in any note's front matter, so it silently survives into M1 as an unowned assumption.`,
    }));
}

/**
 * AC5 / EPIC-00-S21 scenario 3 / A0-9: the fields of the generated capability
 * matrix (spikes/s1-acp/src/report.ts's `CapabilityMatrix`). A source file
 * that assigns literal boolean values to every one of them is the matrix
 * itself, hardcoded — as opposed to a type declaration (whose values are the
 * word "boolean", never matched below) or a partial comparison snapshot like
 * `SNAPSHOT_2026_08_02` (two keys, not the full nine), which the same file
 * documents as a diff input that never becomes the written value.
 */
export const CAPABILITY_MATRIX_KEYS: readonly string[] = [
  'resume',
  'list',
  'loadSession',
  'mcpHttp',
  'mcpSse',
  'mcpAcp',
  'promptImage',
  'promptAudio',
  'promptEmbeddedContext',
];

export function checkNoHardcodedCapabilityMatrix(files: readonly SourceFile[]): Violation[] {
  const violations: Violation[] = [];
  for (const file of files) {
    const hasEveryKeyAsLiteral = CAPABILITY_MATRIX_KEYS.every((key) =>
      new RegExp(`\\b${key}\\s*:\\s*(true|false)\\b`).test(file.text),
    );
    if (hasEveryKeyAsLiteral) {
      violations.push({
        where: file.path,
        message:
          `declares all ${CAPABILITY_MATRIX_KEYS.length} capability-matrix keys ` +
          `(${CAPABILITY_MATRIX_KEYS.join(', ')}) as literal booleans in source. The matrix must be ` +
          'derived from a live "initialize" response and written to fixtures/capabilities/ — a ' +
          'hardcoded matrix is wrong within a month (A0-9).',
      });
    }
  }
  return violations;
}
