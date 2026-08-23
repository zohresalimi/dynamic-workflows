/**
 * The spec-prompt splitter keeps every byte of the document it splits.
 *
 * The rule this file exists to hold is `RunGateBanner.vue`'s: an operator
 * approves the *gate's own* prompt, verbatim. Laying that prompt out in
 * sections is a rendering choice; losing, trimming or re-wrapping a line of it
 * while doing so is an edit to a document somebody is about to sign, and it
 * would look completely correct in review. So the central assertion here is a
 * round trip rather than a set of examples — split it, join it, get the same
 * string back — driven off `renderSpecForReview`'s real output rather than off
 * a prompt this file typed.
 */
import { renderSpecForReview, TASKSPEC_DRAFT_SCHEMA_ID, TaskSpecDraftSchema } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import {
  parsePriorDecision,
  promptSize,
  SPEC_PROMPT_HEADINGS,
  type SpecPromptSection,
  sectionItems,
  sectionsJoin,
  splitSpecPrompt,
} from './spec-prompt-sections.ts';

/**
 * A framed document with every optional section filled, so the splitter meets
 * all eight headings — `Declared paths` included, which the renderer emits
 * only when the draft declares any.
 *
 * Parsed through the daemon's own schema rather than cast into shape: a
 * fixture the production parser would reject is a fixture that proves nothing
 * about the production prompt, and the cast is exactly how that goes unnoticed.
 */
const DRAFT = TaskSpecDraftSchema.parse({
  schemaId: TASKSPEC_DRAFT_SCHEMA_ID,
  goal: 'Migrate the checkout module',
  scope: {
    included: ['the checkout module', 'its two adapters'],
    paths: ['packages/checkout/**'],
  },
  nonGoals: ['rewriting billing'],
  constraints: ['no schema change'],
  acceptanceCriteria: [
    { id: 'ac-1', statement: 'it migrates', verifiedBy: ['build'] },
    { id: 'ac-2', statement: 'nothing else moves', verifiedBy: ['review'] },
  ],
  knownFailureModes: [{ id: 'fm-1', description: 'the cart empties', detection: 'the cart gate' }],
  priorDecisions: [
    { decision: 'Keep the existing repository layout', source: 'repository' },
    { decision: 'Do not touch the billing schema', source: 'operator' },
  ],
});

const PROMPT = renderSpecForReview(DRAFT);

/** One section by name, or a failure that names what was missing. */
function sectionNamed(title: string): SpecPromptSection {
  const found = (splitSpecPrompt(PROMPT) ?? []).find((section) => section.title === title);
  if (found === undefined) throw new Error(`the rendered spec has no "${title}" section`);
  return found;
}

suite('the splitter finds the renderer’s own sections', () => {
  it('scans a prompt that really is one, so a passing split is not a split of nothing', () => {
    // The premise, asserted rather than assumed: if `renderSpecForReview` ever
    // stopped emitting headings, every expectation below would be about a
    // different string and this file would quietly prove nothing.
    expect(PROMPT).toContain('Goal');
    expect(PROMPT.split('\n').length).toBeGreaterThan(10);
  });

  it('names each section in the renderer’s own order', () => {
    const sections = splitSpecPrompt(PROMPT);
    expect(sections).not.toBeNull();
    expect(sections?.map((section) => section.title)).toEqual([...SPEC_PROMPT_HEADINGS]);
  });

  it('hands back a document identical to the one it was given', () => {
    // The whole contract. Not "the sections look right" — the *bytes* are the
    // ones the daemon put on the wire, because that is what was approved.
    const sections = splitSpecPrompt(PROMPT);
    expect(sectionsJoin(sections ?? [])).toBe(PROMPT);
  });

  it('carries the goal’s prose into the Goal section, unchanged', () => {
    expect(sectionNamed('Goal').lines).toContain('Migrate the checkout module');
  });

  it('keeps a bullet’s text and reports that it was a bullet', () => {
    expect(sectionItems(sectionNamed('In scope'))).toEqual([
      { bullet: true, text: 'the checkout module' },
      { bullet: true, text: 'its two adapters' },
    ]);
  });

  it('drops only the blank spacing lines when it draws, and nothing else', () => {
    const sections = splitSpecPrompt(PROMPT) ?? [];
    for (const section of sections) {
      const drawn = sectionItems(section).length;
      const nonBlank = section.lines.filter((line) => line.trim() !== '').length;
      expect(drawn).toBe(nonBlank);
    }
  });
});

suite('a prompt that is not a rendered spec falls through to the <pre>', () => {
  it('refuses a one-sentence escalation rather than guessing at sections', () => {
    expect(splitSpecPrompt('The agent asked to write outside its worktree.')).toBeNull();
  });

  it('refuses an empty prompt', () => {
    expect(splitSpecPrompt('')).toBeNull();
  });

  it('refuses a prompt whose first line is prose, even when a heading follows', () => {
    // Text before the first heading has no section to belong to, and inventing
    // one for it would be the splitter writing a line of the document.
    expect(splitSpecPrompt('Please read this first\nGoal\nSomething')).toBeNull();
  });
});

suite('a pinned decision splits into its sentence and its source', () => {
  it('separates a trailing bracketed source', () => {
    expect(parsePriorDecision('Keep the existing repository layout (repository)')).toEqual({
      decision: 'Keep the existing repository layout',
      source: 'repository',
    });
  });

  it('leaves a line with no source whole', () => {
    expect(parsePriorDecision('Keep the layout')).toEqual({
      decision: 'Keep the layout',
      source: null,
    });
  });

  it('takes only the last bracketed group, so a bracketed sentence survives', () => {
    expect(parsePriorDecision('Keep (most of) the layout (repository)')).toEqual({
      decision: 'Keep (most of) the layout',
      source: 'repository',
    });
  });

  it('never returns an empty decision — brackets alone are the whole line', () => {
    expect(parsePriorDecision('(repository)')).toEqual({
      decision: '(repository)',
      source: null,
    });
  });
});

suite('the document’s size is reported in a unit an operator reads', () => {
  it('counts UTF-8 bytes, not characters', () => {
    // An em-dash is three bytes and one character. A spec full of them is
    // bigger than its `.length` claims, and the figure beside "full framed
    // document" is a claim about what would be downloaded.
    expect(promptSize('—'.repeat(400))).toBe('1.2 KB');
  });

  it('stays in bytes below a kilobyte', () => {
    expect(promptSize('abc')).toBe('3 B');
  });
});
