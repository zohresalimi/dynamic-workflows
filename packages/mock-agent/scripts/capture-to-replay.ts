#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
/**
 * Turns a raw transport capture into a replay recording.
 *
 * A capture (`{"t":…,"dir":…,"b64":…}`) is what a tee in the client's transport
 * writes: base64 chunks, labelled from the client's side. A replay recording
 * (`{"t":…,"dir":…,"msg":…}`) is what `deflow-mock-agent --replay` reads:
 * whole frames, labelled from the agent's side. This is the one-way door
 * between them, kept in the repo so the goldens under `recordings/` are
 * reproducible rather than hand-edited — and so a reviewer can read the frames
 * they are approving instead of a wall of base64.
 *
 * Usage:
 *   node packages/mock-agent/scripts/capture-to-replay.ts \
 *     recordings/claude-agent-acp@0.64.1/full-cycle.ndjson \
 *     recordings/claude-agent-acp@0.64.1/simple-edit.ndjson [--frames <n>]
 *
 * With no `--out`, it prints a numbered listing of the frames instead of
 * writing anything, which is how you choose `--frames`.
 */
import { basename, dirname } from 'node:path';
import process from 'node:process';
import { fromTransportCapture, parseRecording, parseRecordingKey } from '../src/recording.ts';

const [source, target] = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const frameFlag = process.argv.indexOf('--frames');
const frameLimit = frameFlag < 0 ? undefined : Number(process.argv[frameFlag + 1]);

if (source === undefined) {
  process.stderr.write('usage: capture-to-replay <capture.ndjson> [<out.ndjson>] [--frames <n>]\n');
  process.exit(2);
}

const key = parseRecordingKey(basename(dirname(source)));
if (!key.ok) {
  process.stderr.write(`${key.message}\n`);
  process.exit(2);
}

const converted = fromTransportCapture(readFileSync(source, 'utf8'), {
  derivedFrom: basename(source),
  ...(frameLimit === undefined || Number.isNaN(frameLimit) ? {} : { frameLimit }),
});

if (target === undefined) {
  const parsed = parseRecording(converted, source);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.message}\n`);
    process.exit(1);
  }
  parsed.frames.forEach((frame, index) => {
    const method = frame.msg['method'];
    const label =
      typeof method === 'string'
        ? method
        : frame.msg['result'] !== undefined
          ? `result#${JSON.stringify(frame.msg['id'])}`
          : `error#${JSON.stringify(frame.msg['id'])}`;
    const summary = JSON.stringify(frame.msg).slice(0, 120);
    process.stdout.write(`${index + 1}\t${frame.t}\t${frame.dir}\t${label}\t${summary}\n`);
  });
  process.exit(0);
}

writeFileSync(target, converted);
process.stdout.write(`${target}: ${converted.split('\n').filter(Boolean).length} lines\n`);
