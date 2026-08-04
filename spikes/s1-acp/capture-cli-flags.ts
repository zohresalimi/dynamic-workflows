#!/usr/bin/env node
/**
 * Captures the `--help` baseline the monthly vendor-drift diff (roadmap §5)
 * runs against.
 *
 *   node spikes/s1-acp/capture-cli-flags.ts > fixtures/cli-flags/<date>.json
 *
 * Three breakages were already visible in the current release set on
 * 2026-08-02 — Claude Code's `--permission-prompt-tool` gone from `--help`,
 * `codex exec --full-auto` gone, Gemini's `--experimental-acp` and
 * `--allowed-tools` deprecated — so the working assumption this baseline
 * exists to serve is: **assume every vendor flag you depend on moves within 6
 * months.** A flag that is absent because the binary is not installed is
 * recorded as `null`, never as `false`; those are different facts.
 */
import { spawnSync } from 'node:child_process';

interface Probe {
  readonly binary: string;
  readonly helpArgs: string[];
  readonly flags: string[];
}

const PROBES: Record<string, Probe> = {
  claude: {
    binary: 'claude',
    helpArgs: ['--help'],
    flags: ['--permission-prompt-tool', '--output-format', '--verbose', '--print'],
  },
  'codex exec': {
    binary: 'codex',
    helpArgs: ['exec', '--help'],
    flags: ['--full-auto'],
  },
  gemini: {
    binary: 'gemini',
    helpArgs: ['--help'],
    flags: ['--acp', '--experimental-acp', '--allowed-tools'],
  },
};

function version(binary: string): string | null {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  return result.status === 0 ? ((result.stdout ?? '').trim().split('\n')[0] ?? null) : null;
}

const commands: Record<string, unknown> = {};
for (const [name, probe] of Object.entries(PROBES)) {
  const help = spawnSync(probe.binary, probe.helpArgs, { encoding: 'utf8' });
  const installed = help.status === 0;
  commands[name] = {
    binary: probe.binary,
    version: installed ? version(probe.binary) : null,
    status: installed ? 'captured' : 'not-installed',
    flags: Object.fromEntries(
      probe.flags.map((flag) => [flag, installed ? (help.stdout ?? '').includes(flag) : null]),
    ),
  };
}

process.stdout.write(
  `${JSON.stringify({ capturedAt: new Date().toISOString().slice(0, 10), commands }, null, 2)}\n`,
);
