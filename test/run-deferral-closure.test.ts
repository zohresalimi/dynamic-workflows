/**
 * KAR-19.4 AC1 — a deferral whose reason is spent has to say so in the plan,
 * not only in the commit that spent it.
 *
 * Between 2026-08-11 and 2026-08-13 five blocks across `docs/delivery/` rested
 * on one sentence: *"no shipped code path executes a submitted run — nothing
 * calls `compilePlanV1` or `executeRun`"*. It was true when it was written.
 * KAR-19.3 and KAR-19.4 made it false, and the record did not all move: the
 * epic-level narrative and KAR-18.6 AC2 were closed while KAR-18.3 AC1 — the
 * *original* deferral, the one the others cite by name — was left reading *"the
 * four-node plan running to `run.completed` is not reachable"*, next to a
 * repository where it demonstrably is. A commit message claimed otherwise,
 * which is precisely the failure mode [README §9](../docs/delivery/README.md)
 * exists to prevent: *a cut is recorded and never silently absorbed* cuts both
 * ways, and an **un**-cut has to be recorded too.
 *
 * `test/run-completion-deferral.test.ts` guarded the other direction — it went
 * red the day a shipped source executed a run, and KAR-19.4 deleted it exactly
 * as its own instructions said. This is its counterpart on the far side of that
 * event, and it is the one that lasts: while a run *can* complete, no delivery
 * doc may still assert, unclosed, that none can.
 *
 * The rule is deliberately about **blocks, not files**. An amendment is allowed
 * to quote the dead reason at any length — that is what a historical record
 * is — as long as the same block also carries the closure that spends it. That
 * is the shape KAR-18.6 AC2's block already has, and copying a shape that is
 * right is cheaper than inventing one.
 *
 * Verifies: EPIC-19-S24 · KAR-19.4 AC1
 */
import { expect, it, describe as suite } from 'vitest';
import { docFiles, packageProductionSources, readSources } from './support/workspace.ts';

/**
 * The sentences the run-completion deferral was built on, verbatim enough to
 * match the prose and specific enough not to match anything else.
 *
 * A phrase list rather than a heuristic, because the claim being guarded is a
 * *specific historical claim* and a reader who re-words it is a reader who is
 * writing a new one. The last two are the by-reference forms: S20 and S21 never
 * restate the reason, they point at S18's note, and a pointer to a spent
 * deferral is a spent deferral.
 */
const DEAD_REASONS = [
  'no shipped code path executes a submitted run',
  'nothing calls `compilePlanV1` or `executeRun`',
  'is not reachable and is **not** faked',
  'the note on EPIC-18-S18',
  'the reason given on EPIC-18-S18',
] as const;

/** What a block has to carry to be allowed to quote one of them. */
const CLOSURE = '**Closed ';

interface Block {
  readonly where: string;
  readonly text: string;
  readonly reason: string;
}

/**
 * A block is a maximal run of non-blank lines.
 *
 * That is not an approximation of a markdown blockquote — it is exactly one,
 * for the amendments this rule is about: they mark their blank lines with a
 * bare `>`, so an amendment is never interrupted by a truly empty line and is
 * therefore always one block. Prose paragraphs split on the blank lines they
 * already have, which is what stops a closure three paragraphs away from
 * covering a claim it never mentions.
 */
export function blocks(text: string): readonly { readonly line: number; readonly text: string }[] {
  const out: { line: number; text: string }[] = [];
  let start = 0;
  let lines: string[] = [];
  const flush = (): void => {
    if (lines.length > 0) out.push({ line: start, text: lines.join(' ').replaceAll(/\s+/g, ' ') });
    lines = [];
  };
  for (const [index, raw] of text.split('\n').entries()) {
    if (raw.trim() === '') {
      flush();
      continue;
    }
    if (lines.length === 0) start = index + 1;
    lines.push(raw.replace(/^\s*>\s?/, '').trim());
  }
  flush();
  return out;
}

/** Every block that rests on a dead reason and does not close it. */
export function openDeferrals(files: readonly { path: string; text: string }[]): readonly Block[] {
  const found: Block[] = [];
  for (const file of files) {
    for (const block of blocks(file.text)) {
      if (block.text.includes(CLOSURE)) continue;
      const reason = DEAD_REASONS.find((phrase) =>
        block.text.toLowerCase().includes(phrase.toLowerCase()),
      );
      if (reason !== undefined) {
        found.push({ where: `${file.path}:${block.line}`, text: block.text, reason });
      }
    }
  }
  return found;
}

const delivery = readSources(docFiles().filter((path) => path.startsWith('docs/delivery/')));

suite('KAR-19.4 AC1 — the premise, so an empty result means something', () => {
  const sources = packageProductionSources();

  it('has a shipped caller of executeRun, which is what killed the reason', () => {
    const callers = sources
      .filter((source) => source.path !== 'packages/daemon/src/exec/run-executor.ts')
      .filter((source) => /\bexecuteRun\s*\(/.test(source.text))
      .map((source) => source.path);
    expect(callers).toEqual(['packages/daemon/src/pipeline/run-execution.ts']);
  });

  it('binds executeNodes in both composition roots, which is what shipped it', () => {
    for (const root of ['packages/daemon/src/main.ts', 'packages/cli/src/up.ts']) {
      const source = sources.find((file) => file.path === root);
      expect(source, `${root} is not in the shipped tree`).toBeDefined();
      expect(source?.text).toContain('executeNodes: execution.executeNodes');
    }
  });

  it('reads the delivery docs the rule is about', () => {
    expect(delivery.length).toBeGreaterThan(20);
    expect(delivery.map((file) => file.path)).toContain(
      'docs/delivery/epics/EPIC-18-cli-packaging.md',
    );
  });
});

suite('KAR-19.4 AC1 — no delivery doc still defers a run that now completes', () => {
  it('finds no open block resting on the spent reason', () => {
    const open = openDeferrals(delivery);
    expect(
      open.map((block) => `${block.where} — quoting "${block.reason}"`),
      'a run reaches run.completed on the shipped path; these blocks still say it cannot',
    ).toEqual([]);
  });
});

suite('KAR-19.4 AC1 — the scan bites, so a green means something', () => {
  it('catches a block that quotes the reason and never closes it', () => {
    const stale = {
      path: 'docs/delivery/epics/EPIC-18-cli-packaging.md',
      text: '> **Amended.** The four-node plan running to `run.completed`\n> is not reachable and is **not** faked.\n',
    };
    expect(openDeferrals([stale]).map((block) => block.reason)).toEqual([
      'is not reachable and is **not** faked',
    ]);
  });

  it('catches the by-reference form, which restates nothing', () => {
    const pointer = {
      path: 'docs/delivery/flows/EPIC-18-cli-packaging-flows.md',
      text: '> **Amended.** Both need a run that executes; see the note on EPIC-18-S18.\n',
    };
    expect(openDeferrals([pointer])).toHaveLength(1);
  });

  it('allows a block that quotes the reason and then spends it', () => {
    const closed = {
      path: 'docs/delivery/epics/EPIC-18-cli-packaging.md',
      text: '> **Amended.** Nothing calls `compilePlanV1` or `executeRun`.\n>\n> **Closed 2026-08-13 by KAR-19.4.** Both have shipped callers now.\n',
    };
    expect(openDeferrals([closed])).toEqual([]);
  });

  it('does not let a closure in a different paragraph cover a claim it never mentions', () => {
    const distant = {
      path: 'docs/delivery/flows/EPIC-18-cli-packaging-flows.md',
      text: '> **Amended.** No shipped code path executes a submitted run.\n\nSome unrelated prose.\n\n> **Closed 2026-08-13.** Something else entirely.\n',
    };
    expect(openDeferrals([distant])).toHaveLength(1);
  });
});
