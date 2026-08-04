/**
 * KAR-00.2 — the value package "a" imports across the pnpm workspace symlink.
 *
 * Only erasableSyntaxOnly-legal syntax belongs in this file (AC4). The banned
 * forms (enum, namespace, parameter properties) are exercised one at a time by
 * test/integration/spike-s2-zero-build.test.ts, which writes them in here
 * temporarily and reverts this exact file afterwards — it is never committed
 * with the banned syntax present.
 */
export function message(): string {
  return 'hello from @spike/b';
}

// D4's replacement idiom for `enum`: a `const` object plus a derived union,
// both erasable. EPIC-00-S3's last scenario asserts this runs.
export const Status = {
  Ok: 'ok',
  Fail: 'fail',
} as const;

export type StatusValue = (typeof Status)[keyof typeof Status];
