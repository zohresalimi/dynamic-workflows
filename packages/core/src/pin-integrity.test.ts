/**
 * KAR-09.3 — the integrity check, both halves of it.
 *
 * `rendered.includes` catches a pin the render lost; the hash comparison
 * catches a packet mutated after the digest was taken. Dropping either one
 * leaves a check that still passes its own happy path and no longer means
 * anything (EPIC-09-S18 notes).
 *
 * Verifies: EPIC-09-S18, EPIC-09-S14 (third scenario) · AC4, AC5 · test plan
 * #1, #2, #3, #4, #5
 */
import { expect, it, describe as suite } from 'vitest';
import { contentHash } from './hash.ts';
import { type SegmentId, SegmentIdSchema } from './ids.ts';
import { assertPinIntegrity, PinIntegrityViolation, pinnedKept } from './pin-integrity.ts';

const id = (value: string): SegmentId => SegmentIdSchema.parse(value);

interface Pin {
  readonly id: SegmentId;
  readonly text: string;
  readonly contentHash: string;
  readonly pinned: boolean;
}

/** A segment whose `contentHash` really is the sha256 of its own text. */
async function pin(name: string, text: string): Promise<Pin> {
  return { id: id(name), text, contentHash: await contentHash(text), pinned: true };
}

/** A segment whose text was mutated *after* the hash was taken. */
async function mutated(name: string, was: string, now: string): Promise<Pin> {
  return { id: id(name), text: now, contentHash: await contentHash(was), pinned: true };
}

const GOAL = 'Goal: migrate the checkout flow to Vue 3.';
const SCOPE = 'Only write files under src/checkout/**.';
const CRITERIA = '1. pnpm test passes\n2. no v-model modifiers are dropped';
const PERMISSION = 'Permission level: worktree.';

const render = (...parts: readonly string[]): string => parts.join('\n\n');

suite('assertPinIntegrity', () => {
  it('returns void when every pinned text is present in the render', async () => {
    const pins = [await pin('goal', GOAL), await pin('scope', SCOPE)];
    const rendered = render(GOAL, SCOPE, 'Task brief: start with the router.');

    await expect(assertPinIntegrity({ segments: pins }, rendered)).resolves.toBeUndefined();
  });

  it('ignores unpinned segments entirely — a dropped tool output is not a violation', async () => {
    const kept = await pin('goal', GOAL);
    const dropped = { ...(await pin('tool', 'a 38 KB build log')), pinned: false };
    const rendered = render(GOAL);

    await expect(
      assertPinIntegrity({ segments: [kept, dropped] }, rendered),
    ).resolves.toBeUndefined();
  });

  it('throws with that one digest when the render is missing a single pin', async () => {
    const goal = await pin('goal', GOAL);
    const scope = await pin('scope', SCOPE);
    const rendered = render(GOAL, 'Task brief: start with the router.');

    const thrown = await assertPinIntegrity({ segments: [goal, scope] }, rendered).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(PinIntegrityViolation);
    const violation = thrown as PinIntegrityViolation;
    expect(violation.missingDigests).toEqual([scope.contentHash]);
    expect(violation.segmentIds).toEqual([scope.id]);
  });

  it('collects every violating segment before it throws, not just the first', async () => {
    const pins = [
      await pin('a', GOAL),
      await pin('b', SCOPE),
      await pin('c', CRITERIA),
      await pin('d', PERMISSION),
    ];
    // The second and the fourth are absent from the render.
    const rendered = render(GOAL, CRITERIA);

    const thrown = await assertPinIntegrity({ segments: pins }, rendered).catch(
      (error: unknown) => error,
    );

    const violation = thrown as PinIntegrityViolation;
    expect(violation.missingDigests).toHaveLength(2);
    expect(violation.missingDigests).toEqual([pins[1]?.contentHash, pins[3]?.contentHash]);
    expect(violation.segmentIds).toHaveLength(2);
    expect(violation.segmentIds).toEqual([pins[1]?.id, pins[3]?.id]);
  });

  it('throws on a stale contentHash even though the mutated text is present verbatim', async () => {
    const tampered = await mutated('scope', SCOPE, 'Only write files under src/**.');
    const rendered = render(GOAL, tampered.text);

    const thrown = await assertPinIntegrity({ segments: [tampered] }, rendered).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(PinIntegrityViolation);
    expect((thrown as PinIntegrityViolation).segmentIds).toEqual([tampered.id]);
  });

  it('rejects a paraphrase — a summariser is never allowed near a pin', async () => {
    const scope = await pin('scope', 'only write files under src/checkout/**');
    const paraphrased = 'restrict writes to the checkout source directory';

    const thrown = await assertPinIntegrity({ segments: [scope] }, render(paraphrased)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(PinIntegrityViolation);
  });

  it('rejects a cosmetic reflow: a rewrapped constraint block is a violation, not a tolerance', async () => {
    const block = await pin(
      'constraints',
      'Only write files under src/checkout/** and commit only to the node branch.',
    );
    const reflowed = 'Only write files under src/checkout/** and commit only to the\nnode branch.';

    const thrown = await assertPinIntegrity({ segments: [block] }, render(reflowed)).catch(
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(PinIntegrityViolation);
    expect((thrown as PinIntegrityViolation).segmentIds).toEqual([block.id]);
  });

  it('says which half failed: present in the manifest, absent from the prompt', async () => {
    const scope = await pin('scope', SCOPE);
    const stale = await mutated('goal', GOAL, `${GOAL} (edited)`);

    const thrown = (await assertPinIntegrity(
      { segments: [scope, stale] },
      render(stale.text),
    ).catch((error: unknown) => error)) as PinIntegrityViolation;

    expect(thrown.message).toContain('scope');
    expect(thrown.message).toContain('absent from the prompt');
    expect(thrown.message).toContain('goal');
    expect(thrown.message).toMatch(/contentHash|digest/);
    // One line: it is written into `NodeFailure.message`, which a board cell
    // renders.
    expect(thrown.message).not.toContain('\n');
  });

  it('carries the typed failure the node runner fails the node with', async () => {
    const scope = await pin('scope', SCOPE);

    const thrown = (await assertPinIntegrity({ segments: [scope] }, 'nothing').catch(
      (error: unknown) => error,
    )) as PinIntegrityViolation;

    expect(thrown.deflowFailure.reason).toBe('safety.pin-integrity-violated');
    // A vanished pin wants a human, not another attempt.
    expect(thrown.deflowFailure.class).toBe('gate');
  });

  it('costs five hashes on a hundred-segment packet, not a hundred', async () => {
    // EPIC-09-S18's third scenario asks for "under 5 ms" on a 100-segment
    // packet with 5 pins. A wall-clock assertion is not available here — the
    // core forbids reading an elapsed-time counter, for the same reason it
    // forbids `Date.now()` — and it would be the wrong measurement anyway: the
    // claim is that the check is O(pins) rather than O(segments), and a
    // millisecond budget only observes that indirectly, on a machine that
    // happened not to be busy. Counting the reads observes it directly.
    let unpinnedReads = 0;
    const pins = await Promise.all([
      pin('goal', GOAL),
      pin('criteria', CRITERIA),
      pin('constraints', SCOPE),
      pin('scope', `${SCOPE} (write)`),
      pin('permission', PERMISSION),
    ]);
    const rest = await Promise.all(
      Array.from({ length: 95 }, async (_, index) => {
        const built = await pin(`s${index}`, `tool output ${index}: ${'x'.repeat(400)}`);
        return {
          ...built,
          pinned: false,
          get text(): string {
            unpinnedReads += 1;
            return built.text;
          },
        };
      }),
    );
    const packet = { segments: [...pins, ...rest] };
    const rendered = render(...pins.map((segment) => segment.text));

    await expect(assertPinIntegrity(packet, rendered)).resolves.toBeUndefined();

    expect(unpinnedReads).toBe(0);
  });
});

suite('pinnedKept', () => {
  it('returns the digest list — the positive evidence that the check ran', async () => {
    const pins = [await pin('goal', GOAL), await pin('scope', SCOPE)];
    const unpinned = { ...(await pin('brief', 'Task brief.')), pinned: false };
    const rendered = render(GOAL, SCOPE, 'Task brief.');

    await expect(pinnedKept({ segments: [...pins, unpinned] }, rendered)).resolves.toEqual([
      pins[0]?.contentHash,
      pins[1]?.contentHash,
    ]);
  });

  it('throws rather than returning a list nobody verified', async () => {
    const scope = await pin('scope', SCOPE);

    await expect(pinnedKept({ segments: [scope] }, render(GOAL))).rejects.toBeInstanceOf(
      PinIntegrityViolation,
    );
  });
});
