#!/usr/bin/env node
/**
 * The footgun, measured against the real class rather than asserted from the
 * source.
 *
 * `@agentclientprotocol/sdk@1.3.0`'s `LineBuffer` has no maximum line length.
 * This pushes 10 MB with no `\n` into the genuine SDK export and reports what
 * happened: no lines emitted, nothing thrown, and every one of those bytes
 * still retained. That is why DeFlow interposes its own cap
 * (src/framing.ts) instead of relying on the SDK.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
// `LineBuffer` is not in the package's `exports` map, and `package.json` is
// not either — `schema/schema.json` is the only non-entry subpath the SDK
// exposes, so the package root is derived from it. That the class carrying
// this footgun is unreachable through the public surface is itself part of the
// finding: consumers get it whether they want it or not, via ndJsonStream().
const sdkRoot = dirname(dirname(require.resolve('@agentclientprotocol/sdk/schema/schema.json')));
const { LineBuffer } = (await import(pathToFileURL(join(sdkRoot, 'dist/line-buffer.js')).href)) as {
  LineBuffer: new () => {
    push(chunk: Uint8Array): Uint8Array[];
    flush(): Uint8Array | undefined;
  };
};

const TOTAL = 10 * 1024 * 1024;
const CHUNK = 64 * 1024;

const buffer = new LineBuffer();
const before = process.memoryUsage().heapUsed;
let linesEmitted = 0;
let threw = false;
let pushed = 0;

try {
  const chunk = new Uint8Array(CHUNK).fill(0x78); // 'x', and never 0x0a
  while (pushed < TOTAL) {
    linesEmitted += buffer.push(chunk).length;
    pushed += CHUNK;
  }
} catch {
  threw = true;
}

const pendingBytes = buffer.flush()?.byteLength ?? 0;

process.stdout.write(
  `${JSON.stringify(
    {
      pushedBytes: pushed,
      linesEmitted,
      threw,
      pendingBytes,
      heapGrowthBytes: process.memoryUsage().heapUsed - before,
    },
    null,
    2,
  )}\n`,
);
