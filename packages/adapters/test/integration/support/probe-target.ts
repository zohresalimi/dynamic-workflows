#!/usr/bin/env node
/**
 * A real ACP-speaking child whose `--version` output, `initialize` result and
 * own bytes are all under the spec's control.
 *
 * A bin with a shebang and an execute bit, copied into a tmpdir by the spec
 * that uses it, because `binary_sha256` is the sha256 of *the resolved entry
 * file*: "a rebuilt binary at the same version writes a third row" is only a
 * real claim if the bytes at the path being probed actually change.
 *
 * Three things need a fixture the mock agent cannot give:
 *
 * 1. **Byte-for-byte.** It writes the `initialize` result as *raw text*, with
 *    spacing and key order the SDK would never produce, so "stored
 *    byte-for-byte" is a claim a spec can actually falsify. Anything built on
 *    `JSON.stringify` would agree with a re-serialising probe by accident.
 * 2. **A version bump and a rebuilt binary.** The manifest's primary key is
 *    `(provider, version, binary_sha256)`, and both halves have to be movable
 *    independently: `--version-output` changes what it reports, and the
 *    `MARKER` comment below changes its own bytes without changing anything
 *    else.
 * 3. **"No `session/new` was ever sent."** Every method it receives is
 *    appended to `$DeFlow_PROBE_LOG`, one per line, so the spec asserts the
 *    absence of a request rather than the absence of a reply — which is the
 *    difference between "probing costs no quota" and "probing happened to not
 *    get an answer".
 *
 * Raw ndjson rather than the SDK, for the reason above: the SDK would encode
 * the result its own way, which is precisely what is under test.
 */
// MARKER: rebuild-marker-0
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

function option(name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

/**
 * The result member, as literal source text. Deliberately not `JSON.stringify`
 * output — two spaces after a colon, spaces inside every brace — so a probe
 * that re-serialised what it parsed would disagree with it.
 *
 * One line, and no newline anywhere inside it: this is ndjson, and a frame
 * split across lines is not a slower frame, it is a different (broken)
 * protocol. Writing one here once cost an afternoon of "the probe hangs",
 * which is worth a comment.
 */
const RESULT_TEXT =
  '{ "protocolVersion":  1, "agentCapabilities": { "loadSession": true, ' +
  '"sessionCapabilities": { "resume": true } }, "authMethods": [] }';

if (argv.includes('--version')) {
  process.stdout.write(`${option('--version-output', 'probe-target 1.0.0')}\n`);
  process.exit(0);
}

const log = process.env.DeFlow_PROBE_LOG;
const write = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

for await (const line of lines) {
  if (line.trim() === '') continue;
  const frame = JSON.parse(line) as { id?: unknown; method?: string };
  if (typeof frame.method !== 'string') continue;
  if (log !== undefined) appendFileSync(log, `${frame.method}\n`);
  if (frame.id === undefined) continue;

  if (frame.method === 'initialize') {
    write(`{"jsonrpc":"2.0","id":${JSON.stringify(frame.id)},"result":${RESULT_TEXT}}`);
    continue;
  }

  write(
    `{"jsonrpc":"2.0","id":${JSON.stringify(frame.id)},"error":{"code":-32601,"message":"probe-target does not implement ${frame.method}"}}`,
  );
}
