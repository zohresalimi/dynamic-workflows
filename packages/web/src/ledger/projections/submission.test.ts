/**
 * KAR-22.2 AC6 — what the operator asked for, folded out of the run's own
 * `task.submitted`.
 *
 * The red this exists for is small and expensive: the composer clears when it
 * submits, and until this projection there was nowhere on any run surface that
 * said what had been asked. An operator who came back to a run an hour later
 * could see a plan, a graph and a cost, and could not see the sentence the
 * whole thing came from.
 *
 * The rule that makes it worth a projection rather than a field the composer
 * keeps: **the answer comes off the ledger.** A page that remembered its own
 * submission would show it in the tab that submitted it and nowhere else — not
 * on a second tab, not after a reload, and not for a run started from a
 * terminal. `task.submitted` is the event; this is its only reader.
 *
 * Verifies: EPIC-22-S27 · KAR-22.2 AC6 · test plan #8
 */
import type { Event } from '@DeFlow/core';
import { expect, it, describe as suite } from 'vitest';
import { applySubmission, emptySubmission } from './submission.ts';

const RUN = 'run_20260815T120000Z_aaaaaa';

/** A `task.submitted` envelope, as the stream delivers it. */
const submitted = (seq: number, payload: Record<string, unknown>): Event =>
  ({
    seq,
    runId: RUN,
    ts: 1_755_000_000_000,
    kind: 'task.submitted',
    v: 1,
    epoch: 1,
    payload,
  }) as unknown as Event;

const other = (seq: number): Event =>
  ({
    seq,
    runId: RUN,
    ts: 1_755_000_000_000,
    kind: 'run.started',
    v: 1,
    epoch: 1,
    payload: {},
  }) as unknown as Event;

const TEXT = {
  sha256: 'a'.repeat(64),
  raw: 'Migrate the checkout module off the legacy gateway',
  provenance: {
    kind: 'text',
    by: 'ui',
    submittedAt: 1_755_000_000_000,
    cwd: '/repos/checkout',
    projectId: 'prj_20260815T101112Z_a1b2c3',
  },
};

suite('applySubmission — the three intake shapes, as the operator asked them', () => {
  it('holds free text verbatim, never summarised', () => {
    const state = emptySubmission();
    applySubmission(state, submitted(1, TEXT));

    expect(state.task).toEqual({
      kind: 'text',
      by: 'ui',
      submittedAt: 1_755_000_000_000,
      summary: 'Migrate the checkout module off the legacy gateway',
      raw: 'Migrate the checkout module off the legacy gateway',
      handle: null,
      cwd: '/repos/checkout',
      projectId: 'prj_20260815T101112Z_a1b2c3',
    });
  });

  it('names the file a `--file` submission resolved to', () => {
    const state = emptySubmission();
    applySubmission(
      state,
      submitted(1, {
        sha256: 'b'.repeat(64),
        raw: '# Spec\n\nRewrite the importer.\n',
        provenance: {
          kind: 'file',
          by: 'ui',
          submittedAt: 1_755_000_000_001,
          cwd: '/repos/checkout',
          resolvedPath: '/repos/checkout/docs/spec.md',
          bytes: 30,
          mediaType: 'text/markdown',
        },
      }),
    );

    // The **resolved** path, which is the one intake's containment check
    // approved — not the string the operator typed, which may have been
    // relative and is no longer a fact about anything.
    expect(state.task?.kind).toBe('file');
    expect(state.task?.summary).toBe('/repos/checkout/docs/spec.md');
    expect(state.task?.raw).toBe('# Spec\n\nRewrite the importer.\n');
  });

  it('names the issue an `--issue` submission resolved', () => {
    const state = emptySubmission();
    applySubmission(
      state,
      submitted(1, {
        sha256: 'c'.repeat(64),
        raw: '{"title":"Checkout 500s"}',
        provenance: {
          kind: 'issue',
          by: 'cli',
          submittedAt: 1_755_000_000_002,
          url: 'https://github.com/example/repo/issues/7',
          resolver: 'gh',
          httpStatus: 200,
          fetchedAt: 1_755_000_000_002,
        },
      }),
    );

    expect(state.task?.kind).toBe('issue');
    expect(state.task?.by).toBe('cli');
    expect(state.task?.summary).toBe('https://github.com/example/repo/issues/7');
  });

  it('says where a source too large to inline went, rather than inventing one', () => {
    const state = emptySubmission();
    applySubmission(
      state,
      submitted(1, {
        sha256: 'd'.repeat(64),
        handle: `artifact://${'d'.repeat(64)}`,
        provenance: {
          kind: 'file',
          by: 'ui',
          submittedAt: 1_755_000_000_003,
          resolvedPath: '/repos/checkout/docs/huge.md',
          bytes: 400_000,
          mediaType: 'text/markdown',
        },
      }),
    );

    // `raw` is absent by construction above the inline threshold, and the
    // honest rendering of that is `null` plus the handle — never an empty
    // string, which reads on screen as "they submitted nothing".
    expect(state.task?.raw).toBeNull();
    expect(state.task?.handle).toBe(`artifact://${'d'.repeat(64)}`);
    expect(state.task?.summary).toBe('/repos/checkout/docs/huge.md');
  });
});

suite('applySubmission — the cursor and the kinds it does not own', () => {
  it('advances the cursor for every event, including ones it ignores', () => {
    const state = emptySubmission();
    applySubmission(state, other(4));

    // A frame that was seen has been seen. A projection that only moved its
    // cursor for kinds it folds would re-request everything else on every
    // reconnect for the life of the run.
    expect(state.appliedSeq).toBe(4);
    expect(state.task).toBeNull();
  });

  it('ignores a replayed envelope at or below the cursor', () => {
    const state = emptySubmission();
    applySubmission(state, submitted(2, TEXT));
    applySubmission(state, submitted(1, { ...TEXT, raw: 'something else entirely' }));

    expect(state.task?.raw).toBe(TEXT.raw);
  });

  it('holds nothing for a payload this build cannot read', () => {
    const state = emptySubmission();
    // A `task.submitted` from a newer daemon whose provenance kind this build
    // does not know. Ignored rather than thrown: an older tab against a newer
    // daemon must keep working, and it must keep advancing.
    applySubmission(state, submitted(1, { sha256: 'e'.repeat(64), raw: 'x', provenance: {} }));

    expect(state.task).toBeNull();
    expect(state.appliedSeq).toBe(1);
  });
});
