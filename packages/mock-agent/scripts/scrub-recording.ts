#!/usr/bin/env node
/**
 * Redacts a committed recording in place.
 *
 * The capture path scrubs by construction — the transport tee writes through
 * `RecordingRedactor`, and `fromTransportCapture` runs it again on the way to a
 * replay golden — so this script exists for the files that were captured before
 * it did, and for the day a recording arrives from somewhere else. It is
 * idempotent: on an already-scrubbed file it writes the same bytes back.
 *
 * Usage:
 *   node packages/mock-agent/scripts/scrub-recording.ts recordings/<dir>/<file>…
 *
 * `.ndjson` files are redacted as recordings, in either shape (a raw `b64`
 * transport capture or a `msg` replay recording). Anything else is treated as
 * text and only its absolute paths are rewritten.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { RecordingRedactor, redactRecording } from '../src/redaction.ts';

const paths = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));

if (paths.length === 0) {
  process.stderr.write('usage: scrub-recording <recording>…\n');
  process.exit(2);
}

for (const path of paths) {
  const before = readFileSync(path, 'utf8');
  const after = path.endsWith('.ndjson')
    ? redactRecording(before)
    : new RecordingRedactor().paths(before);
  if (after === before) {
    process.stdout.write(`${path}: already scrubbed\n`);
    continue;
  }
  writeFileSync(path, after);
  process.stdout.write(`${path}: scrubbed (${before.length} -> ${after.length} bytes)\n`);
}
