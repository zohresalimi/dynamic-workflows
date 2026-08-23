/**
 * The F1.3 gate's prompt, split into the sections it was rendered from — and
 * **not** re-rendered from anything.
 *
 * `RunGateBanner.vue`'s own header comment states the rule this module is
 * written under, and nothing here relaxes it: the prompt an operator reads is
 * the gate's own `human.requested.prompt`, verbatim, because re-rendering it
 * from `run.created.spec` would be a second renderer of one document and the
 * two would disagree the first time a run was amended. So this file is a
 * *splitter*, not a renderer. It finds `renderSpecForReview`'s own heading
 * lines in the string it was given and reports where they are; every byte
 * between two headings is handed back unchanged, in order, and
 * `sectionsJoin()` reassembles the original exactly.
 *
 * That property is the whole contract, and `./spec-prompt-sections.test.ts`
 * asserts it as a round trip rather than by example: a splitter that dropped,
 * trimmed or re-wrapped one line would still look right in a screenshot and
 * would be a quiet edit to a document somebody is about to approve.
 *
 * A prompt this cannot parse — a permission escalation's one-sentence ask, a
 * future gate with headings of its own, a spec renderer that grew a section —
 * yields `null`, and the caller falls back to the single `<pre>` block that
 * has always been the honest rendering of "text we do not understand the shape
 * of". Guessing would be the failure mode worth avoiding here.
 */

/**
 * `renderSpecForReview`'s own headings, in its own order.
 *
 * Spelled here rather than imported because they are not exported by
 * `@DeFlow/core` — the renderer composes them inline — and because what this
 * module needs is not "the headings the current build emits" but "the headings
 * this splitter knows how to lay out". A build that adds a ninth section
 * should fall through to the `<pre>` until somebody has decided how the new
 * section is drawn, which is exactly what an unknown heading does here.
 *
 * `Declared paths` is optional in the renderer (it is emitted only when the
 * draft declares paths), which is why membership is tested per line rather
 * than the list being matched in sequence.
 */
export const SPEC_PROMPT_HEADINGS = [
  'Goal',
  'In scope',
  'Declared paths',
  'Non-goals',
  'Constraints',
  'Acceptance criteria',
  'Known failure modes',
  'Prior decisions',
] as const;

export type SpecPromptHeading = (typeof SPEC_PROMPT_HEADINGS)[number];

export interface SpecPromptSection {
  /** The heading line, exactly as it appeared. */
  readonly title: SpecPromptHeading;
  /** Every line between this heading and the next, verbatim — blanks included. */
  readonly lines: readonly string[];
}

const HEADINGS = new Set<string>(SPEC_PROMPT_HEADINGS);

/**
 * The prompt's sections, or `null` when this is not a rendered spec.
 *
 * `null` on two conditions, both meaning "not the document this lays out":
 * the first line is not a heading (so there is text this splitter would have
 * to invent a home for), or no heading occurs at all.
 */
export function splitSpecPrompt(prompt: string): readonly SpecPromptSection[] | null {
  if (prompt === '') return null;

  const lines = prompt.split('\n');
  if (!HEADINGS.has(lines[0] ?? '')) return null;

  const sections: SpecPromptSection[] = [];
  let title: SpecPromptHeading | null = null;
  let body: string[] = [];

  const close = (): void => {
    if (title !== null) sections.push({ title, lines: body });
  };

  for (const line of lines) {
    if (HEADINGS.has(line)) {
      close();
      title = line as SpecPromptHeading;
      body = [];
      continue;
    }
    body.push(line);
  }
  close();

  return sections.length === 0 ? null : sections;
}

/**
 * The inverse: the exact string `splitSpecPrompt` was given.
 *
 * Exists for the round-trip assertion, and is the reason `lines` keeps its
 * blank entries rather than being tidied on the way in. A splitter you cannot
 * reverse is a splitter nobody can prove kept the bytes.
 */
export function sectionsJoin(sections: readonly SpecPromptSection[]): string {
  return sections.flatMap((section) => [section.title, ...section.lines]).join('\n');
}

/** The framed document's own bullet marker, as `bullets()` writes it. */
const BULLET = '- ';

export interface SpecPromptItem {
  /** Whether the line was written as a bullet by `bullets()`. */
  readonly bullet: boolean;
  /**
   * The line's text with the marker removed when there was one.
   *
   * The marker is removed *for drawing only* — a list draws its own bullets,
   * and printing "- " inside a list item shows the operator two of them. Every
   * other byte is the document's.
   */
  readonly text: string;
}

/**
 * One section's lines as drawable items: blanks dropped, markers separated.
 *
 * The blank lines exist in the source to space sections apart in a `<pre>`;
 * in a laid-out list they are empty rows. Dropping them is a rendering
 * decision and it is made here, once, rather than in each caller's template.
 */
export function sectionItems(section: SpecPromptSection): readonly SpecPromptItem[] {
  return section.lines
    .filter((line) => line.trim() !== '')
    .map((line) =>
      line.startsWith(BULLET)
        ? { bullet: true, text: line.slice(BULLET.length) }
        : { bullet: false, text: line },
    );
}

export interface PriorDecision {
  /** What was decided — the decision's own sentence. */
  readonly decision: string;
  /** Where it came from, or `null` when the line carried no source. */
  readonly source: string | null;
}

/**
 * `"<decision> (<source>)"` split back into its two facts.
 *
 * `renderSpecForReview` writes a pinned decision as its sentence followed by
 * its source in brackets, and the redesign draws those in two columns — so
 * something has to undo the join. It is here, beside the splitter, rather than
 * in the component: it is string handling with an off-by-one in it (a decision
 * whose own sentence ends in brackets), and that belongs somewhere a test can
 * reach it.
 *
 * Only a **trailing** bracketed group counts, and only when the line ends with
 * it. Anything else is left alone as the whole decision, which is the reading
 * that cannot lose text.
 */
export function parsePriorDecision(line: string): PriorDecision {
  const match = /^(.*) \(([^()]*)\)$/.exec(line);
  if (match === null || match[1] === undefined || match[1] === '') {
    return { decision: line, source: null };
  }
  return { decision: match[1], source: match[2] ?? null };
}

/**
 * A byte count in the vocabulary the rest of this application uses for sizes.
 *
 * Kilobytes with one decimal above 1024 bytes, plain bytes below it — the
 * unit an operator can act on ("2.1 KB" is a document you read; "2147 bytes"
 * is a number you convert). `TextEncoder` rather than `String.length` because
 * the prompt is UTF-8 on the wire and a spec full of em-dashes is longer than
 * its character count says.
 */
export function promptSize(prompt: string): string {
  const bytes = new TextEncoder().encode(prompt).length;
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}
