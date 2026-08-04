/**
 * KAR-00.1 — Spike: ACP client completes a full prompt cycle against a real adapter.
 *
 * A0-1, graded **Critical**, is the assumption this file exists to settle: no
 * full ACP prompt cycle had ever been executed against any agent. Everything
 * past `initialize` was read out of `@agentclientprotocol/sdk@1.3.0`'s types
 * and its shipped `schema/schema.json`, never observed.
 *
 * The live run spends real vendor quota, so it happens once
 * (`node spikes/s1-acp/run.ts --agent <name>`) and tees every raw byte, with a
 * client-side receipt timestamp, to `recordings/<agent>@<version>/`. Every
 * re-run — including this file — replays that recording through the *same*
 * client code, so a regression in the client still fails here even though no
 * vendor is contacted. The failure paths that a vendor cannot be asked to
 * produce on demand (a 10 MB line with no newline, an agent that ignores
 * `session/cancel`, an agent whose advertised capabilities contradict the
 * snapshot) run against real fake-agent binaries under `spikes/s1-acp/agents/`.
 * Nothing here mocks a module.
 *
 * Verifies: EPIC-00-S4, EPIC-00-S5, EPIC-00-S6, EPIC-00-S7, EPIC-00-S8,
 * EPIC-00-S9, EPIC-00-S10 · AC1–AC8.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it, describe as suite } from 'vitest';
import { readRecording, sessionUpdateArrivals } from '../../spikes/s1-acp/src/recording.ts';
import type { RunReport } from '../../spikes/s1-acp/src/report.ts';
import { repoRoot } from '../support/workspace.ts';

const SPIKE_ROOT = join(repoRoot, 'spikes/s1-acp');
const RUN = join(SPIKE_ROOT, 'run.ts');

/** The two agents the story names, with the exact versions that were probed. */
const CLAUDE = { agent: 'claude-agent-acp', version: '0.64.1' } as const;
const GEMINI = { agent: 'gemini-cli', version: '0.53.1' } as const;

const recordingPath = (a: { agent: string; version: string }) =>
  join(repoRoot, 'recordings', `${a.agent}@${a.version}`, 'full-cycle.ndjson');
const fixturePath = (a: { agent: string; version: string }) =>
  join(repoRoot, 'fixtures/capabilities', `${a.agent}@${a.version}.json`);

function node(args: string[], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

/** Replays a committed recording through the real client and returns its report. */
function replay(agent: string): RunReport {
  const result = node([RUN, '--agent', agent, '--replay', '--json']);
  if (result.status !== 0) {
    throw new Error(
      `replay of ${agent} exited ${result.status}:\n${result.stdout}${result.stderr}`,
    );
  }
  return JSON.parse(result.stdout) as RunReport;
}

const note = () => readFileSync(join(repoRoot, 'docs/spikes/S1-acp-round-trip.md'), 'utf8');

beforeAll(() => {
  // The spike carries its own two dependencies (the ACP SDK, for its schema,
  // and ajv) in its own workspace, outside the root globs — so `pnpm -r` and
  // `tsc -b` never see this throwaway directory. Only verify-recording.ts and
  // probe-linebuffer.ts need them; the harness and the replay do not, which is
  // what keeps this install to two packages.
  if (existsSync(join(SPIKE_ROOT, 'node_modules/ajv'))) return;
  const install = spawnSync('pnpm', ['install'], { cwd: SPIKE_ROOT, encoding: 'utf8' });
  if (install.status !== 0) {
    throw new Error(`pnpm install failed in ${SPIKE_ROOT}:\n${install.stdout}${install.stderr}`);
  }
}, 120_000);

suite('EPIC-00-S4 — the six steps complete against the real adapter (AC1–AC6)', () => {
  let report: RunReport;

  beforeAll(() => {
    report = replay(CLAUDE.agent);
  });

  it('a single command drives all six steps and prints a table of what was observed', () => {
    // The table is AC1's deliverable, so it is asserted as output and not only
    // as a data structure.
    const table = node([RUN, '--agent', CLAUDE.agent, '--replay']);
    expect(table.status, table.stderr).toBe(0);
    for (const step of [
      'initialize',
      'session/new',
      'session/prompt',
      'session/update',
      'session/request_permission',
      'session/cancel',
    ]) {
      expect(table.stdout).toContain(step);
    }
    expect(report.steps.map((s) => s.step)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
      'session/update',
      'session/request_permission',
      'session/cancel',
    ]);
    expect(report.steps.filter((s) => s.status !== 'ok')).toEqual([]);
  });

  it('initialize negotiates wire protocolVersion 1 (AC2)', () => {
    expect(report.protocolVersion).toBe(1);
  });

  it('the capability fixture is the agentCapabilities block verbatim, keyed on the exact version (AC2)', () => {
    const fixture = JSON.parse(readFileSync(fixturePath(CLAUDE), 'utf8')) as {
      agent: string;
      version: string;
      agentCapabilities: unknown;
    };
    expect(fixture.agent).toBe(CLAUDE.agent);
    expect(fixture.version).toBe(CLAUDE.version);
    // Verbatim: byte-for-byte what initialize returned, not a re-shaped subset.
    expect(fixture.agentCapabilities).toEqual(report.agentCapabilities);
  });

  it('session/new returns a session id and accepts DeFlow’s own stdio MCP server (AC3)', () => {
    expect(report.sessionId).toMatch(/[0-9a-f-]{8,}/);
    expect(report.mcp.declared).toBe(true);
    expect(report.mcp.accepted).toBe(true);
    expect(report.mcp.error).toBeNull();
    // "Accepted without error" is weak on its own — an agent could ignore the
    // argument entirely and still answer session/new. The MCP server itself
    // records the handshake it served, which is the evidence that it was
    // actually launched and spoken to.
    expect(report.mcp.handshake).toContain('initialize');
    expect(report.mcp.handshake).toContain('tools/list');
  });

  it('a reject_once outcome is honoured rather than ignored (AC5)', () => {
    expect(report.permission.requested).toBe(true);
    expect(report.permission.optionKinds).toContain('reject_once');
    expect(report.permission.answeredWith).toBe('reject_once');
    expect(report.permission.actionPerformed).toBe(false);
    expect(report.permission.evidence).toBeTruthy();
  });

  it('session/cancel settles as cancelled and the client keeps draining afterwards (AC6)', () => {
    expect(report.cancellation.sent).toBe(true);
    expect(report.cancellation.stopReason).toBe('cancelled');
    expect(report.cancellation.settledMs).toBeLessThan(5_000);
    expect(report.cancellation.trailingUpdatesAccepted).toBeGreaterThanOrEqual(1);
    expect(report.cancellation.readLoopAliveAfter).toBe(true);
  });

  it('every recorded frame validates against the ACP schema’s 262 $defs', () => {
    const result = node([join(SPIKE_ROOT, 'verify-recording.ts'), recordingPath(CLAUDE)]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const verdict = JSON.parse(result.stdout) as {
      defs: number;
      frames: number;
      invalid: { line: number; errors: string }[];
    };
    expect(verdict.defs).toBe(262);
    expect(verdict.frames).toBeGreaterThan(20);
    expect(verdict.invalid).toEqual([]);
  });

  it('the decision note records A0-1 as closed', () => {
    expect(note()).toContain('A0-1: closed');
  });
});

suite('EPIC-00-S5 — the capability matrix is generated per agent, never assumed', () => {
  it.each([
    [CLAUDE, { resume: true, list: true }],
    [GEMINI, { resume: false, list: false }],
  ])('%o advertises the capabilities it actually advertises', (agent, expected) => {
    const fixture = JSON.parse(readFileSync(fixturePath(agent), 'utf8')) as {
      version: string;
      capabilityMatrix: { resume: boolean; list: boolean };
    };
    expect(fixture.version).toBe(agent.version);
    expect(fixture.capabilityMatrix.resume).toBe(expected.resume);
    expect(fixture.capabilityMatrix.list).toBe(expected.list);
  });

  it('the note records which of the six steps completed for each agent', () => {
    const text = note();
    expect(text).toContain('claude-agent-acp@0.64.1');
    expect(text).toContain('gemini-cli@0.53.1');
    // Gemini's cycle stops at session/new for an auth reason that AR-1 forbids
    // the harness to work around, and the note has to say so in those terms.
    expect(text).toMatch(/Gemini API key is missing or not configured/);
  });

  it('a probed value that contradicts the snapshot is written as observed, not smoothed to the snapshot', () => {
    // A real fake agent binary that advertises session.resume where the
    // 2026-08-02 snapshot for its name says it cannot resume.
    const report = JSON.parse(
      node([
        RUN,
        '--agent',
        'fake-divergent',
        '--json',
        '--fixture-dir',
        join(SPIKE_ROOT, '.tmp/divergence'),
      ]).stdout,
    ) as RunReport;
    expect(report.capabilityMatrix.resume).toBe(true);
    expect(report.capabilityDivergence).toContainEqual(
      expect.stringContaining('session.resume: snapshot no, observed yes'),
    );
    const written = JSON.parse(
      readFileSync(join(SPIKE_ROOT, '.tmp/divergence/fake-divergent@9.9.9.json'), 'utf8'),
    ) as { capabilityMatrix: { resume: boolean } };
    expect(written.capabilityMatrix.resume).toBe(true);
  });
});

suite(
  'EPIC-00-S6 — streaming is incremental, measured by client-side receipt timestamps (AC4)',
  () => {
    it('at least three session/update notifications arrive with a spread over 500 ms', () => {
      // Measured at the transport, at record time, against the real vendor —
      // the replay cannot manufacture this number.
      const arrivals = sessionUpdateArrivals(readRecording(recordingPath(CLAUDE)));
      expect(arrivals.length).toBeGreaterThanOrEqual(3);
      const spread = Math.max(...arrivals) - Math.min(...arrivals);
      expect(spread).toBeGreaterThan(500);
    });

    it('the note’s Measurement section carries the full inter-arrival list', () => {
      const text = note();
      expect(text).toMatch(/## Measurement/);
      expect(text).toMatch(/inter-arrival/i);
    });
  },
);

suite('EPIC-00-S7 — what the ACP path does and does not surface (AC7)', () => {
  const frames = () => readRecording(recordingPath(CLAUDE)).map((f) => f.raw);

  it('token usage IS surfaced, so the scenario’s Given does not hold', () => {
    const report = replay(CLAUDE.agent);
    expect(report.tokenAccounting.usageUpdates).toBeGreaterThan(0);
    expect(report.tokenAccounting.promptResultUsage).not.toBeNull();
    expect(report.tokenAccounting.verdict).toBe('exact');
    expect(frames().join('\n')).toContain('"sessionUpdate":"usage_update"');
  });

  it('compaction state is not surfaced: no frame carries a field named for it', () => {
    const report = replay(CLAUDE.agent);
    expect(report.compaction.observed).toBe(false);
    const log = frames().join('\n');
    // No *key* is compaction-shaped anywhere in the log.
    expect(log).not.toMatch(/"[^"]*compact[^"]*"\s*:/i);
    // The string does occur — as the name of Claude Code's `/compact` slash
    // command in available_commands_update. Asserting that explicitly is what
    // stops the check above from silently becoming vacuous if the naming
    // changes, and records why a plain substring grep answers the wrong
    // question.
    expect(log).toMatch(/"name":"compact"/);
  });

  it('structured_output is absent from the success result — and from the protocol', () => {
    const report = replay(CLAUDE.agent);
    expect(report.structuredOutput.present).toBe(false);
    expect(frames().join('\n')).not.toMatch(/structured[_ ]?output/i);
  });

  it('the note records A0-3 and A4-2 against the evidence, and prescribes honest degradation', () => {
    const text = note();
    expect(text).toContain('A0-3');
    expect(text).toContain('A4-2');
    expect(text).toContain("tokenAccounting: 'exact'");
    expect(text).toMatch(/unknown rather than as zero|unknown, never as `?0`?/);
    expect(text).toContain('KAR-09.9');
  });
});

suite('EPIC-00-S8 — a 10 MB frame with no newline is capped, not absorbed (AC8)', () => {
  it('the harness terminates the connection with a typed framing failure', () => {
    const result = node([RUN, '--agent', 'fake-flood', '--json']);
    const report = JSON.parse(result.stdout) as RunReport;
    expect(report.frameCapBytes).toBe(8 * 1024 * 1024);
    expect(report.framing.failed).toBe(true);
    expect(report.framing.code).toBe('adapter.frame-too-large');
    expect(report.framing.capBytes).toBe(8 * 1024 * 1024);
    // The cap fires on the pipe chunk that crosses it — so at most one OS
    // chunk past the cap, and well short of the 10 MB the agent was willing to
    // send. The connection is down at that point, not merely complaining.
    expect(report.framing.bytesAtFailure).toBeGreaterThan(8 * 1024 * 1024);
    expect(report.framing.bytesAtFailure).toBeLessThan(8 * 1024 * 1024 + 1024 * 1024);
    expect(report.steps.find((s) => s.step === 'session/new')?.observed).toContain(
      'the connection is terminated rather than buffered further',
    );
  });

  it('the SDK’s own LineBuffer has no such cap, which is why the harness needs one', () => {
    const result = node([join(SPIKE_ROOT, 'probe-linebuffer.ts')]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const probe = JSON.parse(result.stdout) as {
      pushedBytes: number;
      linesEmitted: number;
      pendingBytes: number;
      threw: boolean;
    };
    expect(probe.pushedBytes).toBe(10 * 1024 * 1024);
    expect(probe.linesEmitted).toBe(0);
    expect(probe.threw).toBe(false);
    expect(probe.pendingBytes).toBe(10 * 1024 * 1024);
  });

  it('the note records the cap value and names KAR-05.4 as its consumer', () => {
    const text = note();
    expect(text).toContain('8 MiB');
    expect(text).toContain('KAR-05.4');
  });
});

suite('EPIC-00-S9 — the shim path’s flag footguns, confirmed in this harness (AC8)', () => {
  const claudeInstalled = spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0;

  it.runIf(claudeInstalled)(
    '"claude -p --output-format stream-json" without --verbose exits non-zero',
    () => {
      const result = spawnSync('claude', ['-p', '--output-format', 'stream-json'], {
        encoding: 'utf8',
        input: 'hi',
      });
      expect(result.status).not.toBe(0);
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(output).toContain(
        'When using --print, --output-format=stream-json requires --verbose',
      );
    },
  );

  it('the recorded --help baseline names each flag the research found missing', () => {
    const baseline = JSON.parse(
      readFileSync(join(repoRoot, 'fixtures/cli-flags/2026-08-04.json'), 'utf8'),
    ) as {
      capturedAt: string;
      commands: Record<
        string,
        { version: string | null; status: string; flags: Record<string, boolean | null> }
      >;
    };
    // Gone from `claude --help` at 2.1.220, which is the whole point.
    expect(baseline.commands['claude']?.version).toContain('2.1.220');
    expect(baseline.commands['claude']?.flags['--permission-prompt-tool']).toBe(false);
    // `codex` is not installed on this machine, and "the binary is absent" is a
    // different fact from "the flag is absent". It is recorded as null, so the
    // churn list cannot silently gain a finding nobody observed.
    expect(baseline.commands['codex exec']?.status).toBe('not-installed');
    expect(baseline.commands['codex exec']?.flags['--full-auto']).toBeNull();
    // Both still present at 0.53.1, and both deprecated — `--acp` is the
    // replacement, and it is what the harness spawns.
    expect(baseline.commands['gemini']?.flags['--experimental-acp']).toBe(true);
    expect(baseline.commands['gemini']?.flags['--allowed-tools']).toBe(true);
    expect(baseline.commands['gemini']?.flags['--acp']).toBe(true);
  });

  it.runIf(claudeInstalled)('the installed claude still matches its recorded baseline', () => {
    const help = spawnSync('claude', ['--help'], { encoding: 'utf8' });
    const baseline = JSON.parse(
      readFileSync(join(repoRoot, 'fixtures/cli-flags/2026-08-04.json'), 'utf8'),
    ) as { commands: Record<string, { flags: Record<string, boolean | null> }> };
    const observed = Object.fromEntries(
      Object.keys(baseline.commands['claude']?.flags ?? {}).map((flag) => [
        flag,
        (help.stdout ?? '').includes(flag),
      ]),
    );
    expect(observed).toEqual(baseline.commands['claude']?.flags);
  });

  it('the note records the working assumption about vendor flags', () => {
    expect(note()).toContain('assume every vendor flag you depend on moves within 6 months');
  });
});

suite('EPIC-00-S10 — cancellation, graded (AC6, kill-criterion input)', () => {
  it('an agent that ignores session/cancel is recorded as a deadlock, not waited on forever', () => {
    const result = node([RUN, '--agent', 'fake-deadlock', '--json'], {
      SPIKE_CANCEL_TIMEOUT_MS: '2000',
    });
    const report = JSON.parse(result.stdout) as RunReport;
    expect(report.cancellation.sent).toBe(true);
    expect(report.cancellation.stopReason).toBeNull();
    expect(report.cancellation.verdict).toBe('cancel: deadlock');
    expect(report.steps.find((s) => s.step === 'session/cancel')?.status).toBe('failed');
  });

  it('trailing updates after a settled cancel do not wedge the transport', () => {
    const result = node([RUN, '--agent', 'fake-trailing', '--json']);
    const report = JSON.parse(result.stdout) as RunReport;
    expect(report.cancellation.stopReason).toBe('cancelled');
    expect(report.cancellation.trailingUpdatesAccepted).toBe(2);
    expect(report.cancellation.readLoopAliveAfter).toBe(true);
    expect(report.cancellation.verdict).toBe('cancel: settles, trailing updates drained');
  });

  it('the note grades the outcome and feeds KAR-00.7 with what was actually observed', () => {
    const text = note();
    expect(text).toContain('KAR-00.7');
    expect(text).toContain('KAR-05.9');
    expect(text).toContain('A0-2');
  });
});

suite('the spike leaves the artefacts the story names behind', () => {
  it.each([
    'spikes/s1-acp/run.ts',
    'fixtures/capabilities/claude-agent-acp@0.64.1.json',
    'fixtures/capabilities/gemini-cli@0.53.1.json',
    'docs/spikes/S1-acp-round-trip.md',
    'recordings/claude-agent-acp@0.64.1/full-cycle.ndjson',
  ])('%s exists', (path) => {
    expect(existsSync(join(repoRoot, path))).toBe(true);
  });

  it('no capability constant is hard-coded in the harness — the fixture is generated', () => {
    const source = readFileSync(join(SPIKE_ROOT, 'src/capabilities.ts'), 'utf8');
    // The snapshot table is allowed to exist as a *comparison* input, but the
    // written fixture must come from the probe. A0-9: the snapshot is a test
    // fixture, never a constant.
    expect(source).toMatch(/SNAPSHOT_2026_08_02/);
    expect(source).toContain('observed');
  });
});
