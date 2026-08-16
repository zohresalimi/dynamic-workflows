/**
 * KAR-21.5 AC2, AC5 / EPIC-21-S38, S41 — the frame in the environments people
 * actually watch runs in.
 *
 * Two claims that look unrelated and are the same claim. `NO_COLOR` and a C
 * locale are decisions `render/style.ts` already makes for every report this CLI
 * prints, and 40 columns is a width it already computes; the frame's whole job
 * is to be **given** those answers rather than to work them out again. So the
 * discriminating assertion in this file is not "the frame is plain when
 * `NO_COLOR` is set" — a frame that never coloured anything would pass that. It
 * is the pair: plain when `createStyle` says plain, **coloured when
 * `createStyle` says coloured**, with the frame never having read an
 * environment to find out which.
 *
 * The narrow half is goldens, because *readable* is a judgement and a golden is
 * how a judgement gets reviewed once and then held. The properties beside them
 * are what can fail for a reason a reviewer would want named: a row off the
 * edge, a token broken in half, a gate that lost its options.
 *
 * Verifies: EPIC-21-S38, EPIC-21-S41 · AC2, AC5 · test plan #2, #5
 */
import type { HumanGateState, NodeId, NodeState, RunId, RunState } from '@DeFlow/core';
import {
  initialRunState,
  pendingGate,
  pendingGateSummary,
  SPEC_APPROVAL_OPTIONS,
} from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { PART_SEPARATORS, TRANSCRIPT_GLYPHS, UTF8_GLYPHS } from '../../render/glyphs.ts';
import { createStyle, type Style } from '../../render/style.ts';
import { initialSessionState, type SessionState } from './state.ts';
import { renderFrame } from './view.ts';

/** The byte no frame may carry once `createStyle` has said no. */
const ESC = String.fromCodePoint(0x1b);

const RUN_ID = 'run_20260816T101500Z_0a0a0a' as RunId;
const SPEC_GATE = 'n_spec_0' as NodeId;
const NOW = 1_760_000_000_000;

const node = (over: Partial<NodeState>): NodeState => ({
  status: 'scheduled',
  attempt: 0,
  attempts: 1,
  provider: null,
  model: null,
  permission: null,
  worktree: null,
  result: null,
  failure: null,
  suspension: null,
  requestHash: null,
  wakeAt: null,
  startedTs: 0,
  updatedSeq: 1,
  ...over,
});

/**
 * EPIC-21-S01's state, which S41 names as the one it renders from: four nodes,
 * one running for 95 seconds, and a worktree path long enough that a 20-column
 * window has to do something about it.
 */
function midFlight(over: Partial<RunState> = {}): RunState {
  const base = initialRunState();
  return {
    ...base,
    runId: RUN_ID,
    status: 'running',
    nodes: {
      n_recon_1: node({ status: 'completed' }),
      n_impl_2: node({
        status: 'running',
        startedTs: NOW - 95_000,
        worktree: '/w/DeFlow/n_impl_2',
      }),
      n_impl_3: node({ status: 'scheduled' }),
      n_impl_4: node({ status: 'failed', attempt: 1, attempts: 2 }),
    },
    budget: {
      ...base.budget,
      run: {
        ...base.budget.run,
        costUsd: { subscription: 0, apiKey: 1.2, vendorReported: null, estimated: null },
      },
    },
    ...over,
  };
}

/** The same run, stopped on a spec gate, so the gate half has something to be
 * complete about. */
function atGate(): RunState {
  const gate: HumanGateState = {
    node: SPEC_GATE,
    prompt: 'Approve the rendered specification before any implementation node is scheduled.',
    // The real option set, so the golden shows the rows an operator gets rather
    // than two this file invented.
    options: [...SPEC_APPROVAL_OPTIONS],
    requestedSeq: 9,
    response: null,
    deadline: null,
    escalated: false,
    reason: null,
    permission: null,
  } as HumanGateState;
  return {
    ...midFlight({ status: 'needs-human' }),
    humanGates: { [SPEC_GATE]: gate },
  };
}

const session = (over: Partial<SessionState> = {}): SessionState => ({
  ...initialSessionState(),
  nowMs: NOW,
  rows: 24,
  ...over,
});

const styleAt = (width: number): Style =>
  createStyle({ isTty: false, env: { LANG: 'en_US.UTF-8' }, columns: width });

suite('EPIC-21-S38 — one styling decision, honoured by the frame too (AC2)', () => {
  /**
   * Every environment AC2 names, and the answer `style.ts` already gives it.
   *
   * Each row is one `createStyle` **says no** to colour, which is what the
   * scenario's feature line means: `NO_COLOR` and `--no-color` say no on a
   * terminal, and a locale says nothing about colour at all — so the two locale
   * rows are stated on a pipe, where `shouldStyle`'s last test is what refuses.
   * Asserting a C locale suppressed colour on a TTY would be asserting
   * something `style.ts` does not do and this story must not add.
   */
  const environments = [
    { what: 'NO_COLOR set', input: { isTty: true, env: { NO_COLOR: '' } }, charset: 'utf8' },
    {
      what: '--no-color passed',
      input: { isTty: true, env: { LANG: 'en_US.UTF-8' }, noColor: true },
      charset: 'utf8',
    },
    {
      what: '--json',
      input: { isTty: true, env: { LANG: 'en_US.UTF-8' }, json: true },
      charset: 'utf8',
    },
    { what: 'TERM=dumb', input: { isTty: true, env: { TERM: 'dumb' } }, charset: 'utf8' },
    { what: 'LC_ALL=C on a pipe', input: { isTty: false, env: { LC_ALL: 'C' } }, charset: 'ascii' },
    {
      what: 'LANG=en_US.UTF-8 on a pipe',
      input: { isTty: false, env: { LANG: 'en_US.UTF-8' } },
      charset: 'utf8',
    },
  ] as const;

  for (const { what, input, charset } of environments) {
    it(`writes no colour escape and uses the ${charset} glyph set when ${what}`, () => {
      const style = createStyle({ ...input, columns: 80 });
      const text = renderFrame(midFlight(), session({ keyboard: true }), style).join('\n');

      expect(text).not.toContain(ESC);
      // The decision was `createStyle`'s: the frame is asserted to agree with
      // it rather than to have reached the same conclusion independently.
      expect(style.colour).toBe(false);
      expect(style.charset).toBe(charset);
      expect(text).toContain(TRANSCRIPT_GLYPHS[charset].active);
      if (charset === 'ascii') {
        // AC2's claim is about the **glyph set**, which is what `createStyle`
        // decides: every member of the UTF-8 vocabulary is gone and the ASCII
        // one is in its place, separator included. It is deliberately not "no
        // byte above 0x7f": this CLI's prose uses an em dash in `doctor`,
        // `status` and the run transcript alike, and a rule that held for the
        // frame alone would be a standard invented here rather than the one
        // `render/style.ts` already applies everywhere.
        for (const glyph of [
          ...Object.values(UTF8_GLYPHS),
          ...Object.values(TRANSCRIPT_GLYPHS.utf8),
          PART_SEPARATORS.utf8,
        ].filter((one) => /[^ -~]/.test(one))) {
          expect(text, `the UTF-8 glyph "${glyph}" reached a C-locale frame`).not.toContain(glyph);
        }
        expect(text).toContain(PART_SEPARATORS.ascii);
      }
    });
  }

  it('does colour the frame when createStyle says colour, which is the other half', () => {
    // Without this the suite above would pass against a frame that never
    // painted anything, and AC2 would be satisfied by an absence.
    const style = createStyle({ isTty: false, env: { FORCE_COLOR: '1', LANG: 'en_US.UTF-8' } });

    expect(style.colour).toBe(true);
    expect(renderFrame(midFlight(), session(), style).join('\n')).toContain(ESC);
  });

  it('never re-decides the charset from an environment it was not given', () => {
    // A frame that read `process.env` would produce the UTF-8 set here, because
    // the process running this suite is not in the C locale.
    const style = createStyle({ isTty: false, env: { LC_ALL: 'C' } });

    expect(renderFrame(midFlight(), session(), style).join('\n')).toContain(
      TRANSCRIPT_GLYPHS.ascii.done,
    );
  });
});

/**
 * The window a narrow frame is actually watched in: a tall split pane.
 *
 * 40 rows rather than 24, and the reason is worth stating because it looks like
 * a thumb on the scale. The frame's height budget is a **fraction of the
 * window** (KAR-21.1 AC7), and a row that wraps to three lines at 20 columns
 * spends three of it — so a 20x24 window legitimately shows a header and a
 * `+4 more`, which is the row budget working rather than the wrapping failing.
 * S41 is a scenario about *width*; pinning it in a window with rows to spare is
 * what keeps its goldens about the thing it is asking about. The short-window
 * case is EPIC-21-S43's, one suite over in `degrade.test.ts`, and it has its
 * own answer.
 */
const NARROW_ROWS = 40;

suite('EPIC-21-S41 — 40 and 20 columns are readable, not merely non-crashing (AC5)', () => {
  for (const width of [40, 20] as const) {
    it(`wraps every line inside ${String(width)} columns except an unbreakable token`, () => {
      for (const run of [midFlight(), atGate()]) {
        const lines = renderFrame(
          run,
          session({ keyboard: true, rows: NARROW_ROWS }),
          styleAt(width),
        );

        for (const line of lines) {
          if (line.length <= width) continue;
          // KAR-18.9 AC4's one deliberate exception, and the only one: a line
          // over the width must be a single token that could not be broken.
          expect(line.trim().split(/\s+/), `"${line}" ran off the edge`).toHaveLength(1);
        }
      }
    });

    it(`keeps the glyph, id and status of every node row it shows at ${String(width)} columns`, () => {
      const style = styleAt(width);
      const text = renderFrame(
        midFlight(),
        session({ keyboard: true, rows: NARROW_ROWS }),
        style,
      ).join('\n');
      const glyphs = TRANSCRIPT_GLYPHS[style.charset];

      // Which rows a budget holds is KAR-21.1's decision; what this pins is
      // that a row that *is* shown is whole. The running node is asserted
      // unconditionally because `ROW_PRIORITY` puts it first — a frame that
      // dropped the node the operator is watching would be the failure.
      expect(text, 'the running node lost its row').toContain('n_impl_2');
      for (const [id, glyph, status] of [
        ['n_recon_1', glyphs.done, 'completed'],
        ['n_impl_2', glyphs.active, 'running'],
        ['n_impl_3', glyphs.pending, 'scheduled'],
        ['n_impl_4', glyphs.gone, 'failed'],
      ] as const) {
        if (!text.includes(id)) continue;
        expect(text, `${id} lost its glyph`).toContain(glyph);
        expect(text, `${id} lost its status`).toContain(status);
      }
    });

    it(`keeps the gate summary complete at ${String(width)} columns`, () => {
      const run = atGate();
      const gate = pendingGate(run);
      expect(gate).not.toBeNull();
      if (gate === null) return;
      const text = renderFrame(
        run,
        session({ keyboard: true, rows: NARROW_ROWS }),
        styleAt(width),
      ).join('\n');

      // Complete rather than present: every word of `pendingGateSummary`'s own
      // sentence survives the wrap, and every option the gate offered has a row.
      for (const word of pendingGateSummary(gate).split(/\s+/)) {
        expect(text, `the gate summary lost "${word}"`).toContain(word);
      }
      for (const option of gate.options) {
        expect(text, `the gate lost its "${option.id}" option`).toContain(option.id);
      }
    });

    it(`matches the golden for ${String(width)} columns`, async () => {
      // EPIC-21-S01's state, which is the one S41 names.
      const lines = renderFrame(
        midFlight(),
        session({ keyboard: true, rows: NARROW_ROWS }),
        styleAt(width),
      );

      await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(
        `__goldens__/frame-${String(width)}.txt`,
      );
    });

    it(`matches the golden for a gate at ${String(width)} columns`, async () => {
      const lines = renderFrame(
        atGate(),
        session({ keyboard: true, rows: NARROW_ROWS }),
        styleAt(width),
      );

      await expect(`${lines.join('\n')}\n`).toMatchFileSnapshot(
        `__goldens__/frame-gate-${String(width)}.txt`,
      );
    });
  }

  it('truncates no token at either width', () => {
    // The failure this rules out is a frame that "fits" by cutting: a token the
    // 80-column frame carries is either absent from the narrow one or whole in
    // it, and never half of itself.
    for (const width of [80, 40, 20]) {
      const text = renderFrame(
        midFlight(),
        session({ keyboard: true, rows: NARROW_ROWS }),
        styleAt(width),
      ).join(' ');
      for (const token of ['n_impl_2', '/w/DeFlow/n_impl_2']) {
        expect(text, `${String(width)} columns broke ${token}`).toContain(token);
      }
      // A truncation would leave the head of a dropped id behind; nothing in
      // this frame may be a prefix of an id without being the whole id.
      for (const partial of ['n_recon_', 'n_impl_', '/w/DeFlow/n_impl_2/']) {
        const stray = text.split(/\s+/).filter((word) => word === partial);
        expect(stray, `${String(width)} columns left "${partial}" behind`).toEqual([]);
      }
    }
  });
});
