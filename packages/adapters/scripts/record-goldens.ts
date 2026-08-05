#!/usr/bin/env node
/**
 * `pnpm test:record` — capture a golden recording from a **real, authenticated
 * vendor CLI** (KAR-05.7 AC8).
 *
 * **This never runs in CI, and it never will.** It costs real quota against
 * the developer's own subscription, it needs credentials CI does not have, and
 * it is nondeterministic by construction: the same prompt to the same model
 * produces different tokens on a different day. A capture is a *decision* a
 * human makes, reviews and commits — which is exactly why the corpus it writes
 * into is keyed on the exact agent version, so that decision lands as a new
 * directory in a pull request rather than as an edit to files somebody else
 * recorded.
 *
 * What it does is deliberately small: resolve the provider through the
 * registry, ask the binary its version, and run one node's turn through the
 * ordinary `runAcpNode` with `DeFlow_RECORD=1` set. Nothing here is a second
 * implementation of the client — the recording has to be of the code path
 * DeFlow actually runs, or it is a recording of this script.
 *
 * Usage:
 *   pnpm test:record --provider <id> --case <name> [--prompt <text>]
 *                    [--bin <path>] [--root <dir>] [--out <dir>]
 *
 * The captured file lands at `<out>/<provider>@<exact-version>/<case>.ndjson`,
 * redacted on the way to disk by the transport tee (`src/recorder.ts`), with
 * `test/recordings-scrubbed.test.ts` as the backstop that says the redaction
 * ran.
 */
import type { Clock, TimerHandle } from '@DeFlow/core';
import { NodeIdSchema, ProviderIdSchema, RunIdSchema } from '@DeFlow/core';
import {
  appendEvents,
  appendIoChunk,
  blobHandle,
  openLedger,
  readEpoch,
  spillBytes,
} from '@DeFlow/ledger';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { PROVIDER_SPECS, providerSpec, spawnPlan } from '../src/provider-registry.ts';
import { RECORD_CASE_ENV, RECORD_DIR_ENV, RECORD_ENV } from '../src/recorder.ts';
import { runAcpNode } from '../src/run-node.ts';

const USAGE = `pnpm test:record --provider <id> --case <name> [options]

  --provider <id>   One of: ${Object.keys(PROVIDER_SPECS).join(', ')}
  --case <name>     The <case> half of <provider>@<version>/<case>.ndjson
  --prompt <text>   What to ask the agent. Keep it small: this costs real quota.
  --bin <path>      Absolute path to the binary that speaks ACP, when it is not
                    under --root.
  --root <dir>      A directory to resolve the vendor binary from. Repeatable.
  --out <dir>       Corpus root. Defaults to ./recordings

A manual tool. It spends real quota against your own subscription and is
nondeterministic by construction, so CI never runs it and never will. Review
the file it writes before committing it: it is a transcript of a real session.`;

interface Options {
  provider: string;
  case: string;
  prompt: string;
  bin: string | null;
  roots: string[];
  out: string;
}

function parse(argv: readonly string[]): Options | null {
  const options: Options = {
    provider: '',
    case: '',
    prompt: 'Reply with one short sentence describing what you can do, then stop.',
    bin: null,
    roots: [],
    out: 'recordings',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv.at(index);
    if (flag === '-h' || flag === '--help') return null;
    // Every flag here takes a value, so a missing or flag-shaped one is a
    // typo rather than a default to guess at.
    const value = argv.at(index + 1);
    if (value === undefined || value.startsWith('--')) return null;
    switch (flag) {
      case '--provider':
        options.provider = value;
        break;
      case '--case':
        options.case = value;
        break;
      case '--prompt':
        options.prompt = value;
        break;
      case '--bin':
        options.bin = resolve(value);
        break;
      case '--root':
        options.roots.push(resolve(value));
        break;
      case '--out':
        options.out = value;
        break;
      default:
        return null;
    }
    index += 1;
  }
  return options.provider === '' || options.case === '' ? null : options;
}

/**
 * The real clock, constructed here because a script *is* a composition root.
 *
 * Engine code never reaches for `Date.now()` (NF9); the place that assembles
 * the engine is the place that hands it a clock, and this is that place.
 */
const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((settle, reject) => {
      const timer = setTimeout(settle, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error(String(signal.reason)));
      });
    }),
  setTimer: (ms, fn): TimerHandle => {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

/** The verbatim `--version` output, reduced to the exact version inside it. */
function exactVersion(binary: string): string {
  const printed = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  const match = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*/.exec(printed);
  if (match === null) {
    throw new Error(
      `"${binary} --version" printed ${JSON.stringify(printed)}, which carries no exact ` +
        'version. A golden cannot be keyed on it — see src/recorder.ts.',
    );
  }
  return match[0];
}

async function main(): Promise<number> {
  // A refusal rather than a paragraph of documentation. `CI` is the one
  // environment variable every provider sets, and a tool that spends quota has
  // to refuse the place where nobody is watching it.
  if (process.env.CI !== undefined) {
    process.stderr.write(
      'pnpm test:record refuses to run in CI: it spends real quota against a personal ' +
        'subscription and is nondeterministic by construction.\n',
    );
    return 2;
  }

  const options = parse(process.argv.slice(2));
  if (options === null) {
    process.stdout.write(`${USAGE}\n`);
    return process.argv.length > 2 ? 1 : 0;
  }

  const provider = ProviderIdSchema.parse(options.provider);
  const spec = providerSpec(provider);
  if (spec === undefined) {
    process.stderr.write(`unknown provider "${provider}". ${USAGE}\n`);
    return 1;
  }

  const resolved = spec.resolve({
    roots: options.bin === null ? options.roots : [dirname(options.bin)],
    ...(options.bin === null ? {} : { binaryPath: options.bin }),
  });
  const version = exactVersion(resolved.path);

  const dataDir = mkdtempSync(join(process.env.TMPDIR ?? '/tmp', 'DeFlow-record-'));
  const worktree = join(dataDir, 'worktree');
  await mkdir(worktree, { recursive: true });
  const db = openLedger(dataDir);
  const epoch = readEpoch(db);
  const runId = RunIdSchema.parse(
    `run_${new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d+Z$/, 'Z')}_record`,
  );
  const nodeId = NodeIdSchema.parse('n1');
  const plan = spawnPlan(spec, { resolved, worktree });

  process.stdout.write(
    `recording ${provider}@${version} → ` +
      `${join(options.out, `${provider}@${version}`, `${options.case}.ndjson`)}\n`,
  );

  try {
    const outcome = await runAcpNode(
      {
        runId,
        nodeId,
        attempt: 0,
        provider,
        permission: 'worktree',
        worktree,
        binary: { path: plan.command, version, sha256: '' },
        argv: plan.argv,
        env: { ...process.env, ...plan.env },
        mcpServers: [],
        prompt: options.prompt,
      },
      {
        clock: systemClock,
        ledger: {
          // The port is async because a real sink may be; better-sqlite3 is
          // synchronous, so this resolves rather than awaits.
          append: (event) => {
            const [seq] = appendEvents(
              db,
              [
                {
                  runId,
                  ts: event.ts,
                  kind: event.kind,
                  v: event.v,
                  epoch,
                  ...(event.nodeId === undefined ? {} : { nodeId: event.nodeId }),
                  ...(event.attempt === undefined ? {} : { attempt: event.attempt }),
                  ...(event.ikey === undefined ? {} : { ikey: event.ikey }),
                  payload: event.payload,
                },
              ],
              { spillTo: dataDir },
            );
            return Promise.resolve(seq);
          },
          appendIo: (chunk) =>
            Promise.resolve(
              appendIoChunk(db, {
                runId,
                nodeId: chunk.nodeId,
                attempt: chunk.attempt + 1,
                stream: chunk.stream,
                ts: chunk.ts,
                data: chunk.data,
              }),
            ),
        },
        captureEvidence: (evidence) =>
          blobHandle(
            spillBytes(
              dataDir,
              typeof evidence === 'string' ? Buffer.from(evidence, 'utf8') : Buffer.from(evidence),
              'text/plain',
            ).sha256,
          ),
        record: {
          ...process.env,
          [RECORD_ENV]: '1',
          [RECORD_DIR_ENV]: resolve(options.out),
          [RECORD_CASE_ENV]: options.case,
        },
      },
    );

    process.stdout.write(`turn ended: ${outcome.status}\n`);
    process.stdout.write(
      'Review the recording before committing it — it is a transcript of a real session.\n',
    );
    return outcome.status === 'failed' ? 1 : 0;
  } finally {
    db.close();
  }
}

process.exitCode = await main();
