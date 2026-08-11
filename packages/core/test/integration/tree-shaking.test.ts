/**
 * `@DeFlow/core`'s `sideEffects` declaration, both halves of it, against a real
 * bundler.
 *
 * KAR-17.1 put the ledger transport on the web app's boot path, and with it the
 * barrel — so a tab that only wanted `canonicalJson` was parsing every zod
 * schema in the domain before its first paint, which is about 42 KB gzip of the
 * ~200 KB NF3 budget (docs/12 §10). The fix is the manifest field that lets a
 * bundler drop what a consumer did not ask for.
 *
 * That field is also the most dangerous kind of change available in a
 * `package.json`, because it is a *promise about the code* enforced by nobody:
 * declare `"sideEffects": false` on this package and a bundler is entitled to
 * delete `../../src/upcasters.ts`'s twenty-two `registerUpcaster(...)` calls —
 * every one of which is a hop from an old event version to the current one. The
 * symptom would be a production-only, old-data-only failure to read events
 * written by a previous build, which no unit test in this repository runs a
 * bundler to see. The declaration is therefore the **array** form, naming the
 * one module in `src/` that really does do something at import time.
 *
 * So this spec builds the package twice, with a real bundler, and **executes
 * what came out**:
 *
 * 1. an entry that upcasts a `v1` payload — the hops must have survived;
 * 2. an entry that only canonicalises JSON — zod must **not** have survived.
 *
 * Neither can be answered by reading source. `vite` is reached through
 * `packages/web`'s copy because that is the workspace's only installation of
 * it; the bundler is Rolldown either way, which is what the application ships
 * through.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, expect, it, describe as suite } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const VITE = join(repoRoot, 'packages/web/node_modules/vite/bin/vite.js');
const CORE_ENTRY = join(repoRoot, 'packages/core/src/index.ts');

/** A `budget.consumed` payload as a build before KAR-14.1 wrote it. */
const V1_SPEND = {
  node: 'n-impl',
  provider: 'claude',
  usage: { inputTokens: 18_420, outputTokens: 2310, source: 'vendor-reported' },
  costUsd: 0.42,
};

interface Built {
  /** What the bundle exported when Node ran it. */
  readonly exported: Record<string, unknown>;
  /** The bundle's own source text, unminified. */
  readonly code: string;
}

let dir: string;
let upcasting: Built;
let canonicalising: Built;

function run(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [VITE, ...args], {
      cwd,
      // Vitest runs with NODE_ENV=test, and a bundle built under it is not the
      // one that ships — the same correction `packages/web`'s budget spec makes.
      env: { ...process.env, NODE_ENV: 'production' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`vite exited ${String(code)}\n${output}`)),
    );
  });
}

/**
 * Bundles one entry against the workspace's own `@DeFlow/core` source and loads
 * the result.
 *
 * The alias points at the package's `src/index.ts`, which is exactly what the
 * workspace `exports` map resolves to — so the bundler reads
 * `packages/core/package.json`, and its `sideEffects` field, the same way the
 * web build does.
 */
async function build(name: string, source: string): Promise<Built> {
  const at = join(dir, name);
  await writeFile(join(dir, `${name}.js`), source, 'utf8');
  await writeFile(
    join(dir, `${name}.config.js`),
    `export default {
      resolve: { alias: { '@DeFlow/core': ${JSON.stringify(CORE_ENTRY)} } },
      logLevel: 'error',
      build: {
        outDir: ${JSON.stringify(at)},
        emptyOutDir: true,
        minify: false,
        target: 'node24',
        lib: { entry: ${JSON.stringify(join(dir, `${name}.js`))}, formats: ['es'], fileName: 'out' },
      },
    };\n`,
    'utf8',
  );

  await run(['build', '--config', join(dir, `${name}.config.js`)], dir);

  const file = join(at, 'out.js');
  const exported = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  return { exported, code: await readFile(file, 'utf8') };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'DeFlow-shake-'));
  // Without this, Vite's library mode emits `.mjs` (its ESM name for a CommonJS
  // package) and both the config file and the entry are read as CommonJS.
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n', 'utf8');

  upcasting = await build(
    'upcast',
    `import { upcast } from '@DeFlow/core';
     export const lifted = upcast('budget.consumed', 1, ${JSON.stringify(V1_SPEND)});\n`,
  );
  canonicalising = await build(
    'canonical',
    `import { canonicalJson } from '@DeFlow/core';
     export const encoded = canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] });\n`,
  );
}, 240_000);

afterAll(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true });
});

suite('the upcaster hops survive a tree-shaken build', () => {
  it('lifts a v1 budget.consumed payload to v2 in the bundled build', () => {
    // The registrations are top-level calls whose results nothing reads, which
    // is the shape a bundler is allowed to delete from a package that says it
    // has no side effects. Rolldown at the current pin keeps them — `upcast`
    // comes from the same module, so the module is in the graph either way —
    // and that is a fact about today's bundler rather than a guarantee. This is
    // where a pin bump that changes its mind is caught; the alternative is
    // discovering it when a six-month-old ledger stops reading.
    expect(upcasting.exported['lifted']).toEqual({ ...V1_SPEND, authMode: 'subscription' });
  });

  it('keeps every registered hop, not merely the one asserted above', () => {
    // Twenty-two registrations in `src/upcasters.ts`; a bundler that dropped
    // half of them would still satisfy the assertion above. Counting the calls
    // in the emitted text is the only way to see the rest of them.
    const registrations = upcasting.code.match(/registerUpcaster\(/g)?.length ?? 0;
    expect(registrations).toBeGreaterThanOrEqual(20);
  });
});

suite('what a consumer did not ask for is not shipped', () => {
  it('canonicalises JSON without pulling zod in behind it', () => {
    expect(canonicalising.exported['encoded']).toBe('{"a":[2,{"c":4,"d":3}],"b":1}');
    // The boot path's whole claim, in one assertion: `canonicalJson` has no
    // imports at all, so a consumer of it must not pay for the schema
    // vocabulary that shares the barrel with it.
    expect(canonicalising.code).not.toContain('zod');
  });

  it('is a real shake, not an empty bundle', () => {
    // The control. `not.toContain` is true of nothing at all, so the assertion
    // above is only worth something beside a build that did produce code.
    expect(canonicalising.code.length).toBeGreaterThan(500);
    expect(upcasting.code).toContain('zod');
  });
});
