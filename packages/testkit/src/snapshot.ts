/**
 * The normalising snapshot serializer (docs/14-testing-strategy.md §9).
 *
 * Registered from `test/setup.ts` **before any snapshot exists**, because the
 * failure mode here is social rather than technical: an assertion mechanism that
 * produces a diff on every run stops being read, and once `-u` becomes a reflex
 * the snapshots will happily record a regression.
 *
 * Two rules, because two kinds of instability need different evidence:
 *   - unstable *values* (ULIDs, UUIDs, ISO timestamps, machine-varying path
 *     roots, ports, worktree directory names) are recognisable on sight, so
 *     they are normalised wherever a string contains them;
 *   - unstable *numbers* (epoch timestamps, durations, ports) are not — 1743 is
 *     just a number — so those are normalised by key.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The workspace root. @DeFlow/testkit is a private workspace package that is
 * never published, so deriving it from this file's own location is safe.
 */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url)).replace(/\/$/, '');

const realpathOrSelf = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Machine-varying path roots, longest first so that a repo inside $HOME is
 * reported as <repo>/... rather than <home>/....
 */
const pathRoots = (): [string, string][] =>
  (
    [
      [repoRoot, '<repo>'],
      [realpathOrSelf(repoRoot), '<repo>'],
      [tmpdir(), '<tmp-root>'],
      [realpathOrSelf(tmpdir()), '<tmp-root>'],
      [process.env.HOME ?? '', '<home>'],
    ] as [string, string][]
  )
    .filter(([root]) => root !== '')
    .sort((a, b) => b[0].length - a[0].length);

const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Applied in order. Each pattern must be idempotent against its own
 * replacement, or a re-serialised value would keep changing.
 */
const rules: [RegExp, string][] = [
  // The flat worktree branch/directory scheme, DeFlow/<runId>__<nodeId> (D13).
  [/DeFlow\/[A-Za-z0-9._-]+__[A-Za-z0-9._-]+/g, 'DeFlow/<worktree>'],
  // A tmp directory this testkit made: <tmp-root>/DeFlow-<random> -> <tmp>.
  // Hyphens are part of the name because the prefix is not one string across
  // the suites — `e2e/support/daemon.ts` asks `mkdtemp` for `DeFlow-` and
  // `e2e/support/up.ts` for `DeFlow-up-` — so stopping at the first hyphen left
  // the random suffix of the second shape behind. `/` still ends the match, so
  // this reaches no further than the directory it names.
  [/<tmp-root>\/DeFlow-[A-Za-z0-9-]+/g, '<tmp>'],
  [/DeFlow-[A-Za-z0-9]{6,}/g, '<tmp-name>'],
  [/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g, '<ts>'],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>'],
  // Crockford base32, 26 characters — a ULID. Anchored on both sides so a long
  // uppercase word in prose cannot be mistaken for one.
  [/\b[0-9A-HJKMNP-TV-Z]{26}\b/g, '<ulid>'],
  // Ephemeral ports, in an address and in a URL.
  [/(\/\/[A-Za-z0-9.-]+|\b\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/g, '$1:<port>'],
];

/** Normalises every unstable value a string can carry. Idempotent. */
export function normaliseSnapshotText(value: string): string {
  let out = value;
  for (const [root, placeholder] of pathRoots()) {
    out = out.replaceAll(root, placeholder);
  }
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  // <tmp-root> only exists to anchor the DeFlow-* rule above; anything left is
  // a plain reference to the OS temp directory.
  return out.replaceAll('<tmp-root>', '<tmp>');
}

/** Object keys whose *numeric* values cannot be recognised from the value alone. */
const NUMERIC_KEY_PLACEHOLDERS: Readonly<Record<string, string>> = {
  ts: '<ts>',
  timestamp: '<ts>',
  at: '<ts>',
  createdAt: '<ts>',
  updatedAt: '<ts>',
  startedAt: '<ts>',
  finishedAt: '<ts>',
  durationMs: '<dur>',
  elapsedMs: '<dur>',
  tookMs: '<dur>',
  port: '<port>',
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** A shallow copy with the by-key rules applied. */
export function normaliseSnapshotObject(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const placeholder = NUMERIC_KEY_PLACEHOLDERS[key];
    out[key] = placeholder !== undefined && typeof entry === 'number' ? placeholder : entry;
  }
  return out;
}

const needsKeyNormalising = (value: Record<string, unknown>): boolean =>
  Object.entries(value).some(
    ([key, entry]) => NUMERIC_KEY_PLACEHOLDERS[key] !== undefined && typeof entry === 'number',
  );

/**
 * A pretty-format plugin pair, in the shape `expect.addSnapshotSerializer`
 * wants. `already` breaks the recursion: a normalised copy is printed by the
 * same printer, and without it the plugin would match its own output forever.
 */
export function createSnapshotSerializers(): {
  test: (value: unknown) => boolean;
  serialize: (
    value: never,
    config: never,
    indentation: string,
    depth: number,
    refs: never,
    printer: (
      value: unknown,
      config: never,
      indentation: string,
      depth: number,
      refs: never,
    ) => string,
  ) => string;
}[] {
  const already = new WeakSet<object>();

  return [
    {
      test: (value: unknown) => typeof value === 'string' && normaliseSnapshotText(value) !== value,
      serialize: (value, config, indentation, depth, refs, printer) =>
        printer(normaliseSnapshotText(value as string), config, indentation, depth, refs),
    },
    {
      test: (value: unknown) =>
        isPlainObject(value) && !already.has(value) && needsKeyNormalising(value),
      serialize: (value, config, indentation, depth, refs, printer) => {
        const copy = normaliseSnapshotObject(value as Record<string, unknown>);
        already.add(copy);
        return printer(copy, config, indentation, depth, refs);
      },
    },
  ];
}
