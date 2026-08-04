/**
 * KAR-02.1 — identifier formats: `NodeIdSchema` and `HandleSchema`.
 *
 * `NodeId` is the load-bearing one (docs/04-domain-model.md §1.1): it is the
 * effect journal's idempotency key component and the plan-evolution
 * scrubber's cross-version identity, so its format is enforced at the schema
 * boundary rather than by convention.
 *
 * Verifies: EPIC-02-S1 · AC1, AC3
 */
import { expect, it, describe as suite } from 'vitest';
import { HandleSchema, NodeIdSchema, NodeLifecycleSchema } from './ids.ts';

const SIXTY_FOUR_LOWERCASE_CHARS = 'a'.repeat(64);
const SIXTY_THREE_LOWERCASE_CHARS = 'a'.repeat(63);
const SIXTY_FOUR_HEX = '0'.repeat(64);

suite('NodeIdSchema', () => {
  it.each([
    ['recon-auth-surface', true, 'the documented example'],
    ['a', true, 'one character, lower bound'],
    ['9-lives', true, 'may start with a digit'],
    [SIXTY_THREE_LOWERCASE_CHARS, true, '63 is the cap, and is allowed'],
    ['Recon-Auth', false, 'uppercase breaks case-insensitive fs'],
    ['recon_auth', false, 'underscore not in the class'],
    ['-leading', false, 'must start alphanumeric'],
    ['recon auth', false, 'space is not a path segment'],
    ['recon/auth', false, 'separator would split the ikey'],
    ['', false, 'empty'],
    [SIXTY_FOUR_LOWERCASE_CHARS, false, '63 is the cap'],
  ])('%s -> ok=%s (%s)', (id, ok) => {
    const result = NodeIdSchema.safeParse(id);
    expect(result.success).toBe(ok);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([]);
      expect(result.error.issues[0]?.message).toContain('^[a-z0-9][a-z0-9-]{0,62}$');
    }
  });
});

suite('HandleSchema', () => {
  it('accepts an artifact:// handle carrying a 64-hex sha256', () => {
    expect(HandleSchema.safeParse(`artifact://${SIXTY_FOUR_HEX}`).success).toBe(true);
  });

  it('accepts a file:// handle carrying a repo-relative path and a line range', () => {
    expect(HandleSchema.safeParse('file://src/component.vue#L12-L40').success).toBe(true);
  });

  it('rejects a file:// handle carrying an absolute path', () => {
    expect(HandleSchema.safeParse('file:///etc/passwd#L1-L2').success).toBe(false);
  });

  it('rejects an artifact:// handle with a non-hex or short digest', () => {
    expect(HandleSchema.safeParse('artifact://not-hex').success).toBe(false);
  });

  it('rejects a free string that matches neither scheme', () => {
    expect(HandleSchema.safeParse('https://example.com/file').success).toBe(false);
  });
});

suite('NodeLifecycleSchema', () => {
  it.each(['active', 'superseded', 'abandoned'])('accepts %s', (value) => {
    expect(NodeLifecycleSchema.safeParse(value).success).toBe(true);
  });

  it('rejects a value outside the closed set', () => {
    expect(NodeLifecycleSchema.safeParse('deleted').success).toBe(false);
  });
});
