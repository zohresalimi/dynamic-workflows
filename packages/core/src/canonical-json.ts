/**
 * KAR-02.9 — the canonical JSON encoder `@DeFlow/core` owns.
 *
 * docs/04-domain-model.md §3: `planHash` must be "sha256 over a canonical
 * JSON encoding you own (recursively sorted keys, no insignificant
 * whitespace, `undefined` omitted)". `ohash`'s stable key-ordering behaviour
 * is confirmed, but its README promises only "best efforts" at stable
 * serialisation — fine for "did this object change since last render" in the
 * UI, wrong for a value that is a primary key of the `plan` table and an
 * identity across daemon versions. This module is the one place that decides
 * what "canonical" means, so every hash built on top of it agrees forever.
 *
 * The encoding: object keys sorted at every depth (recursively, not just at
 * the top level), no whitespace, `undefined` object properties omitted
 * (never conflated with `null`), and every value that `JSON.stringify` would
 * otherwise coerce — `Date`, `Map`, `Set`, `BigInt`, `NaN`, `Infinity`, a
 * circular reference — rejected instead, naming the offending JSON Pointer
 * (RFC 6901) path so the caller can find it.
 *
 * Deliberately not normalising Unicode (AC5): a hash is a hash of the bytes
 * it was given, and silently normalising NFD to NFC would make two inputs
 * that are not byte-identical hash the same, which is exactly the kind of
 * "helpful" coercion this module exists to refuse.
 *
 * Verifies: EPIC-02-S8 · AC1, AC2, AC3, AC4, AC5
 */

/** Thrown when `canonicalJson` is given a value it will not silently coerce:
 * a `Date`, a `Map`, a `Set`, a `BigInt`, `NaN`, `Infinity`, a function or a
 * symbol. `path` is the RFC 6901 JSON Pointer to the offending value, `""`
 * meaning the root. */
export class CanonicalJsonUnsupported extends Error {
  readonly path: string;

  constructor(path: string, kind: string) {
    super(
      `canonicalJson: unsupported value at "${path === '' ? '/' : path}" (${kind}). ` +
        'canonicalJson never coerces a lossy value into JSON — reshape the input before hashing it.',
    );
    this.name = 'CanonicalJsonUnsupported';
    this.path = path;
  }
}

/** Thrown when the input contains a circular reference. `path` is the RFC
 * 6901 JSON Pointer to the value that closes the cycle. */
export class CanonicalJsonCycle extends Error {
  readonly path: string;

  constructor(path: string) {
    super(
      `canonicalJson: circular reference at "${path === '' ? '/' : path}". ` +
        'canonicalJson has no representation for a cycle; break it before hashing.',
    );
    this.name = 'CanonicalJsonCycle';
    this.path = path;
  }
}

/** RFC 6901 §3: "~" and "/" inside a reference token are escaped as "~0"
 * and "~1" respectively, and "~0" must be escaped first or it would collide
 * with an escaped "/". */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function childPath(path: string, token: string | number): string {
  return `${path}/${escapePointerToken(String(token))}`;
}

/**
 * Encodes `value` recursively into canonical JSON text.
 *
 * `ancestors` carries the chain of container objects currently being
 * encoded (not a global visited-set) so that the same object reachable
 * twice via two different, non-cyclic paths — a legitimate and common shape,
 * e.g. a shared fixture referenced by two nodes — is not mistaken for a
 * cycle. Only an object that is its own ancestor is a cycle.
 */
function encode(value: unknown, path: string, ancestors: ReadonlySet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonUnsupported(path, Number.isNaN(value) ? 'NaN' : 'Infinity');
      }
      // JS has one numeric type: 1.0 and 1 are the same double, so
      // JSON.stringify already gives AC4's round-trip property for free.
      return JSON.stringify(value);
    case 'bigint':
      throw new CanonicalJsonUnsupported(path, 'BigInt');
    case 'undefined':
      // Only reachable for the root value or an array element — object
      // properties are filtered out by the caller before encode() is ever
      // invoked on them, per AC2.
      throw new CanonicalJsonUnsupported(path, 'undefined');
    case 'function':
    case 'symbol':
      throw new CanonicalJsonUnsupported(path, typeof value);
    default:
      break;
  }

  // typeof value === 'object' and value !== null from here on.
  const container = value;
  if (ancestors.has(container)) throw new CanonicalJsonCycle(path);
  const nested = new Set(ancestors);
  nested.add(container);

  if (Array.isArray(value)) {
    const items = value.map((item, index) => {
      if (item === undefined) {
        // An array has no way to "omit" an element without shifting every
        // index after it, so — unlike an object property — this is refused
        // rather than silently rewritten to null.
        throw new CanonicalJsonUnsupported(childPath(path, index), 'undefined');
      }
      return encode(item, childPath(path, index), nested);
    });
    return `[${items.join(',')}]`;
  }

  if (value instanceof Date) throw new CanonicalJsonUnsupported(path, 'Date');
  if (value instanceof Map) throw new CanonicalJsonUnsupported(path, 'Map');
  if (value instanceof Set) throw new CanonicalJsonUnsupported(path, 'Set');

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined) // AC2: undefined is omitted, not stringified as null.
    .toSorted();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${encode(obj[key], childPath(path, key), nested)}`,
  );
  return `{${entries.join(',')}}`;
}

/**
 * The canonical JSON encoding of `value`: keys sorted recursively at every
 * depth, no insignificant whitespace, `undefined` object properties omitted
 * and `null` properties preserved. Throws `CanonicalJsonUnsupported` on a
 * `Date`, `Map`, `Set`, `BigInt`, `NaN`, `Infinity`, a function or a symbol,
 * and `CanonicalJsonCycle` on a circular reference — both naming the RFC
 * 6901 JSON Pointer path of the offending value. Never silently coerces.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, '', new Set());
}
