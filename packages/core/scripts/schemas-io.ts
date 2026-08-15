/**
 * KAR-02.8 — the filesystem half of schema emission, shared by
 * `emit-schemas.ts` and `check-schemas.ts`.
 *
 * It lives under `packages/core/scripts/` and not under `src/` on purpose:
 * `@DeFlow/core` is pure and publishes no I/O (R1), and a `node:fs` import in
 * `packages/core/src/**` fails the lint rule this story adds. Build tooling is
 * allowed to touch the disk; the published surface is not.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type JsonSchemaDocument,
  SCHEMA_REGISTRY,
  schemaFileName,
  serializeSchemaDocument,
  toJsonSchemaDocument,
} from '../src/json-schema.ts';

/** `<repo>/` — this file is `<repo>/packages/core/scripts/schemas-io.ts`. */
export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The committed emission target. `.DeFlow/schemas/` in a run directory is a
 * copy of this made at `deflow init` time: the daemon must be able to hand a
 * vendor CLI an absolute path inside the run's own directory, and the run
 * directory must stay self-describing after the fact.
 */
export const defaultSchemasDir = join(repoRoot, 'schemas');

/** `--dir <path>` (relative paths resolve against the repo root). */
export function schemasDirFrom(argv: readonly string[]): string {
  const index = argv.indexOf('--dir');
  if (index === -1) return defaultSchemasDir;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--dir needs a path');
  }
  return value.startsWith('/') ? value : join(repoRoot, value);
}

export interface GeneratedSchema {
  readonly schemaId: string;
  readonly fileName: string;
  readonly document: JsonSchemaDocument;
  readonly text: string;
}

/** Every registered document, converted and serialised — no I/O yet. */
export function generateAll(): readonly GeneratedSchema[] {
  return SCHEMA_REGISTRY.map((registration) => {
    const document = toJsonSchemaDocument(registration.schemaId);
    return {
      schemaId: registration.schemaId,
      fileName: schemaFileName(registration.schemaId),
      document,
      text: serializeSchemaDocument(document),
    };
  });
}

export function writeAll(dir: string, generated: readonly GeneratedSchema[]): void {
  mkdirSync(dir, { recursive: true });
  for (const schema of generated) writeFileSync(join(dir, schema.fileName), schema.text, 'utf8');
}

/** What is on disk today, by file name. Missing directory reads as empty. */
export function readSchemaDir(dir: string): ReadonlyMap<string, string> {
  const files = new Map<string, string>();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    files.set(entry, readFileSync(join(dir, entry), 'utf8'));
  }
  return files;
}

/**
 * A unified diff of two texts, hand-rolled over an LCS table.
 *
 * `node:util`'s `diff` would do this in one call and is deliberately not used:
 * it is still flagged experimental, this runs on the Node 24 *and* Node 26 CI
 * legs, and a build script that stops working on a runtime upgrade is exactly
 * the kind of surprise a drift check exists to prevent. The inputs are pretty-
 * printed JSON of at most a few thousand lines, so the quadratic table is
 * milliseconds.
 */
export function unifiedDiff(
  onDisk: string,
  generated: string,
  onDiskLabel: string,
  generatedLabel: string,
  context = 3,
): string {
  // `+` is what the Zod source says and the file lacks; `-` is what the file
  // says and Zod does not. Re-emitting always turns a `+` into a context line.
  const a = generated.split('\n');
  const b = onDisk.split('\n');

  // lcs[i][j] = length of the longest common subsequence of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    Array.from<number>({ length: b.length + 1 }).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      const next = lcs[i + 1] as number[];
      row[j] =
        a[i] === b[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }

  const marked: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      marked.push(` ${a[i]}`);
      i++;
      j++;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      marked.push(`+${a[i]}`);
      i++;
    } else {
      marked.push(`-${b[j]}`);
      j++;
    }
  }
  for (; i < a.length; i++) marked.push(`+${a[i]}`);
  for (; j < b.length; j++) marked.push(`-${b[j]}`);

  // Keep changed lines plus `context` lines either side; elide the rest.
  const keep = new Set<number>();
  for (const [index, line] of marked.entries()) {
    if (line.startsWith(' ')) continue;
    for (let k = index - context; k <= index + context; k++) {
      if (k >= 0 && k < marked.length) keep.add(k);
    }
  }

  const body: string[] = [];
  let elided = false;
  for (const [index, line] of marked.entries()) {
    if (keep.has(index)) {
      body.push(line);
      elided = false;
    } else if (!elided) {
      body.push('@@');
      elided = true;
    }
  }

  return [`--- ${onDiskLabel}`, `+++ ${generatedLabel}`, ...body].join('\n');
}
