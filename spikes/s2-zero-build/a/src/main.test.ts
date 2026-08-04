import { message } from '@spike/b';
import { expect, it } from 'vitest';

// AC3 — vitest must resolve "@spike/b" across the workspace symlink exactly
// as `node` does, or a zero-build dev loop that only works for `node` is not
// a dev loop.
it('resolves @spike/b through the workspace symlink', () => {
  expect(message()).toBe('hello from @spike/b');
});
