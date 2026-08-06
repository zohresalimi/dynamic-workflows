#!/usr/bin/env node
/**
 * KAR-00.1 — the ACP round-trip harness.
 *
 *   node spikes/s1-acp/run.ts --agent claude-agent-acp            # live, spends quota
 *   node spikes/s1-acp/run.ts --agent claude-agent-acp --replay   # from the recording
 *   node spikes/s1-acp/run.ts --agent gemini-cli --json
 *
 * A live run spawns the vendor binary under the developer's own account — it
 * reads no token file and sets no auth environment variable (AR-1) — tees
 * every raw byte with a client-side receipt timestamp to
 * `recordings/<agent>@<version>/full-cycle.ndjson`, and writes the generated
 * capability fixture to `fixtures/capabilities/`. A replay run drives the same
 * client from that recording, so the cycle is re-runnable for ever without
 * spending another credit — and generates its own copy of the fixture into a
 * temporary directory rather than restamping the committed one with the time
 * of the replay (src/paths.ts).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agentSpec } from './src/agents.ts';
import type { Channel, Clock } from './src/client.ts';
import { runCycle } from './src/cycle.ts';
import { DEFAULT_FRAME_CAP_BYTES } from './src/framing.ts';
import { fixtureDirFor, isCommittedFixture } from './src/paths.ts';
import { Recorder, readFrames, readHeader, readRecording } from './src/recording.ts';
import { type RunReport, renderTable } from './src/report.ts';
import { replayChannel, spawnChannel } from './src/transports.ts';

const spikeRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const has = (name: string) => process.argv.includes(`--${name}`);

const agentName = flag('agent');
if (agentName === undefined) {
  console.error('usage: node spikes/s1-acp/run.ts --agent <name> [--replay] [--json]');
  process.exit(2);
}

const agent = agentSpec(agentName);
const replay = has('replay');
const asJson = has('json');
// Vendor recordings are committed — they are the seed of EPIC-05's golden
// suite. Fake-agent runs are test byproducts (one of them is an 11 MB flood)
// and go to the spike's own gitignored scratch directory.
const recordingRoot =
  agent.kind === 'vendor' ? join(repoRoot, 'recordings') : join(spikeRoot, '.tmp/recordings');
const recordingDir = join(recordingRoot, `${agent.name}@${agent.version}`);
const recordingPath = join(recordingDir, 'full-cycle.ndjson');
const mcpLogPath = join(recordingDir, 'mcp-handshake.txt');
// Only a live probe of a real vendor writes the committed fixture; every other
// run generates its own into a temporary directory (see src/paths.ts).
const fixtureDir = flag('fixture-dir') ?? fixtureDirFor(replay ? 'replay' : 'live', agent.kind);

let cwd: string;
let channel: Channel;
let replayClock: Clock | undefined;
let recorder: Recorder | undefined;
let cleanup: (() => void) | undefined;

if (replay) {
  cwd = readHeader(recordingPath).cwd;
  const replayed = replayChannel(readFrames(readRecording(recordingPath)));
  channel = replayed;
  replayClock = replayed.clock;
} else {
  cwd = mkdtempSync(join(tmpdir(), `deflow-s1-${agent.name}-`));
  writeFileSync(join(cwd, 'README.md'), '# DeFlow S1 spike workspace\n');
  mkdirSync(recordingDir, { recursive: true });
  rmSync(mcpLogPath, { force: true });
  recorder = new Recorder(recordingPath, {
    agent: agent.name,
    version: agent.version,
    command: agent.command,
    args: agent.args,
    cwd,
    startedAt: new Date().toISOString(),
    frameCapBytes: DEFAULT_FRAME_CAP_BYTES,
  });
  const spawned = spawnChannel(agent.command, agent.args, cwd);
  channel = spawned;
  cleanup = () => {
    recorder?.close();
    if (spawned.stderr() !== '') {
      writeFileSync(join(recordingDir, 'agent-stderr.txt'), spawned.stderr());
    }
  };
}

const report: RunReport = await runCycle(channel, {
  agent,
  mode: replay ? 'replay' : 'live',
  cwd,
  recordingPath,
  mcpLogPath,
  mcpServerPath: join(spikeRoot, 'mcp-server.ts'),
  fixtureDir,
  frameCapBytes: DEFAULT_FRAME_CAP_BYTES,
  cancelTimeoutMs: Number(process.env['SPIKE_CANCEL_TIMEOUT_MS'] ?? 5000),
  drainMs: replay ? 250 : 4000,
  ...(recorder ? { tee: recorder.note.bind(recorder) } : {}),
  ...(replayClock ? { clock: replayClock } : {}),
  writeFixture: (path, contents) => {
    // The belt to src/paths.ts's braces. A fake agent must never overwrite a
    // vendor fixture, and a replay must never restamp one: its `probedAt` would
    // be the time of the replay rather than of the probe, which is how a clean
    // checkout used to come back dirty from `pnpm test`. Loud rather than
    // silent, because either would only ever happen by mistake.
    if (isCommittedFixture(path) && (replay || agent.kind === 'fake')) {
      throw new Error(
        `refusing to write ${path}: only a live vendor probe writes the committed fixtures`,
      );
    }
    writeFileSync(path, contents);
  },
});

cleanup?.();

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  process.stdout.write(`${renderTable(report)}\n`);
}

process.exit(report.steps.every((step) => step.status === 'ok') ? 0 : 1);
