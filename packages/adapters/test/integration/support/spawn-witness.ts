#!/usr/bin/env node
/**
 * A stand-in for any vendor CLI, which records exactly how it was invoked.
 *
 * A fake *binary*, not a mocked module (docs/14-testing-strategy.md §3.3): the
 * claims KAR-05.3 makes are about what the operating system was asked to run —
 * which argv reached the child, which environment entries it inherited, and
 * whether it leads its own process group — and a stubbed `spawn` can only ever
 * confirm what the stub was handed.
 *
 * It appends one JSON line per invocation to `$DeFlow_SPAWN_LOG`, so "exactly
 * two spawn attempts were made in total" is a fact the spec reads off disk
 * rather than a count it kept itself.
 *
 * `$DeFlow_REJECT_ARG` makes it behave like a CLI whose flag surface moved: any
 * argument containing that substring is rejected the way a yargs-based CLI
 * rejects one — a line on stderr and a non-zero exit, both immediate. That is
 * the shape the deprecated-flag fallback has to recognise, and recognising it
 * from the *outside* is the whole point.
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);

const log = process.env.DeFlow_SPAWN_LOG;
if (log !== undefined) {
  appendFileSync(
    log,
    `${JSON.stringify({
      argv,
      cwd: process.cwd(),
      pid: process.pid,
      codexPath: process.env.CODEX_PATH ?? null,
      path: process.env.PATH ?? null,
    })}\n`,
  );
}

if (argv.includes('--version')) {
  process.stdout.write(`${process.env.DeFlow_WITNESS_VERSION ?? 'witness 1.0.0'}\n`);
  process.exit(0);
}

const reject = process.env.DeFlow_REJECT_ARG;
if (reject !== undefined && reject !== '' && argv.some((arg) => arg.includes(reject))) {
  // The literal shape yargs prints, which is what Gemini's CLI is built on.
  process.stderr.write(`Unknown arguments: ${argv.join(', ')}\n`);
  process.exit(1);
}

const RESULT = '{"protocolVersion":1,"agentCapabilities":{"loadSession":true},"authMethods":[]}';

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

for await (const line of lines) {
  if (line.trim() === '') continue;
  const frame = JSON.parse(line) as { id?: unknown; method?: string };
  if (typeof frame.method !== 'string' || frame.id === undefined) continue;
  if (frame.method === 'initialize') {
    process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(frame.id)},"result":${RESULT}}\n`);
    continue;
  }
  process.stdout.write(
    `{"jsonrpc":"2.0","id":${JSON.stringify(frame.id)},"error":{"code":-32601,"message":"witness does not implement ${frame.method}"}}\n`,
  );
}
