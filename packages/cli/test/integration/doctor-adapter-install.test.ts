/**
 * KAR-18.8 — `doctor` tells the operator what is actually missing, and offers
 * to put it there.
 *
 * The story exists because the first operator to run the shipped CLI on a
 * machine that was not the author's was told `claude is not installed` while
 * `claude --version` answered in the same shell. Both statements were true of
 * different binaries: the registry distinguishes the vendor CLI (`spec.shim.
 * bin`) from the bridge DeFlow spawns (`spec.bin`), and detection resolved only
 * the second while reporting the failure under the *provider's* name.
 *
 * Integration for all of it, because every claim here is a claim about a
 * machine: a binary that actually resolves on a `PATH`, an `npm` that is
 * actually spawned or actually is not, a lockfile that actually lands
 * somewhere. The one thing a mocked `child_process` would let through is the
 * one thing this story must not ship — a `doctor` that says it installed
 * something it did not.
 *
 * Verifies: EPIC-18-S50, EPIC-18-S52, EPIC-18-S53, EPIC-18-S54, EPIC-18-S55,
 * EPIC-18-S56 · AC1-AC11 · test plan #3-#8
 */
import {
  admitRun,
  MOCK_AGENT_SENTENCE,
  type ProviderResolution,
  providerVerdict,
  resolveProviderStates,
} from '@DeFlow/adapters';
import { systemClock } from '@DeFlow/daemon';
import { makeRepo, makeTempDir, removeTempDir, TestClock } from '@DeFlow/testkit';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import type { DoctorCheck, DoctorReport, DoctorSectionId } from '../../src/doctor/report.ts';
import { type DoctorOptions, type DoctorResult, runDoctor } from '../../src/doctor/run.ts';
import {
  doctorEnv,
  fakeBin,
  resolveOnHostPath,
  writeFakeNpm,
  writeGitShim,
  writeMockAgentShim,
} from './support/doctor-fixture.ts';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

/** The adapter version the fake npm "publishes", and the fixture it produces. */
const ADAPTER_VERSION = '0.64.1';

const CLAUDE_PKG = '@agentclientprotocol/claude-agent-acp';
const CODEX_PKG = '@agentclientprotocol/codex-acp';

function section(report: DoctorReport, id: DoctorSectionId) {
  const found = report.sections.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no ${id} section in the report`);
  return found;
}

const check = (report: DoctorReport, id: string): DoctorCheck | undefined =>
  report.sections.flatMap((entry) => entry.checks).find((entry) => entry.id === id);

const detailsOf = (report: DoctorReport, id: DoctorSectionId): string =>
  section(report, id)
    .checks.map((entry) => entry.detail)
    .join('\n');

interface Machine {
  readonly cwd: string;
  readonly dataDir: string;
  readonly binDir: string;
  readonly fixtures: string;
  readonly npmLog: string;
  readonly env: NodeJS.ProcessEnv;
  /** Every argv the fake npm was invoked with, in order. */
  invocations(): Promise<readonly (readonly string[])[]>;
}

interface MachineOptions {
  /** Vendor CLIs to put on the temp PATH — `claude`, `codex`, `gemini`. */
  readonly vendors?: readonly string[];
  /** What the fake npm does when it is run. */
  readonly npm?: 'installs' | 'succeeds-installing-nothing' | { code: number; stderr: string };
  /** A `git` shim reporting this version instead of the real git's. */
  readonly gitVersion?: string;
}

/**
 * A repository, a data directory and a `PATH` holding exactly what the spec
 * asked for.
 *
 * `PATH` never includes the developer's own beyond `node`'s own directory (see
 * `doctorEnv`), so "claude resolves" and "claude-agent-acp does not" are staged
 * facts rather than whatever this machine happens to have installed. That one
 * inherited directory is why every spec that passes `--fix` **must** stage a
 * fake `npm`: the real one lives next to `node` on most installations, and a
 * spec that forgot would perform a genuine global install.
 */
async function machine(name: string, options: MachineOptions): Promise<Machine> {
  const repo = await makeRepo({ dir: join(tmp, name) });
  await mkdir(join(repo.dir, '.DeFlow'), { recursive: true });

  const dataDir = join(tmp, `${name}-data`);
  const binDir = join(tmp, `${name}-bin`);
  const staging = join(tmp, `${name}-staging`);
  const npmLog = join(tmp, `${name}-npm.jsonl`);
  await mkdir(binDir, { recursive: true });

  for (const vendor of options.vendors ?? []) await fakeBin(binDir, vendor);

  if (options.npm === 'installs') {
    // The bytes npm "publishes": a working ACP agent, staged off PATH so that
    // nothing resolves it until the install copies it into place.
    const installs: Record<string, string> = {};
    for (const [bridge, dir] of [
      ['claude-agent-acp', 'claude'],
      ['codex-acp', 'codex'],
    ] as const) {
      installs[join(binDir, bridge)] = await writeMockAgentShim(join(staging, dir), {
        name: bridge,
        version: ADAPTER_VERSION,
      });
    }
    await writeFakeNpm(binDir, { log: npmLog, installs });
  } else if (options.npm === 'succeeds-installing-nothing') {
    await writeFakeNpm(binDir, { log: npmLog });
  } else if (options.npm !== undefined) {
    await writeFakeNpm(binDir, {
      log: npmLog,
      failure: { exitCode: options.npm.code, stderr: options.npm.stderr },
    });
  }

  if (options.gitVersion !== undefined) {
    await writeGitShim(binDir, {
      version: options.gitVersion,
      realGit: resolveOnHostPath('git') as string,
    });
  }

  return {
    cwd: repo.dir,
    dataDir,
    binDir,
    fixtures: join(tmp, `${name}-fixtures`),
    npmLog,
    env: doctorEnv({ dataDir, binDirs: [binDir], realGit: true }),
    invocations: async () => {
      if (!existsSync(npmLog)) return [];
      return (await readFile(npmLog, 'utf8'))
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]);
    },
  };
}

/** The battery spawns a turn per assertion per adapter; only S50 pays for it. */
const base = (host: Machine, overrides: Partial<DoctorOptions> = {}): DoctorOptions => ({
  cwd: host.cwd,
  env: host.env,
  clock: new TestClock(1_755_000_000_000),
  conformance: false,
  capabilityFixtureDir: host.fixtures,
  ...overrides,
});

/** A prompt port that records what it was asked and answers `answer`. */
function scriptedPrompt(answer: string) {
  const asked: string[] = [];
  return {
    asked,
    prompt: async (question: string): Promise<string> => {
      asked.push(question);
      return answer;
    },
  };
}

suite('the vendor CLI is installed, its ACP adapter is not (EPIC-18-S50)', () => {
  it('offers, installs on yes, re-resolves and re-probes in the same run', async () => {
    const host = await machine('s50', { vendors: ['claude'], npm: 'installs' });
    const scripted = scriptedPrompt('y');

    const result = await runDoctor(
      base(host, { isTty: () => true, prompt: scripted.prompt, clock: systemClock }),
    );

    // The state and the sentence, before anything was installed: this is what
    // the operator sees above the prompt.
    const prompt = scripted.asked[0] ?? '';
    expect(scripted.asked).toHaveLength(1);
    expect(prompt).toContain(`npm install -g ${CLAUDE_PKG}`);
    expect(prompt).toContain(join(host.binDir, 'claude'));

    // AC4/AC8 — one invocation, exactly the argv that was named in the prompt.
    expect(await host.invocations()).toEqual([['install', '-g', CLAUDE_PKG]]);

    const install = check(result.report, 'agents.claude.install');
    expect(install?.status).toBe('ok');
    expect(install?.data?.command).toBe(`npm install -g ${CLAUDE_PKG}`);
    expect(install?.data?.exitCode).toBe(0);
    expect(install?.detail).toMatch(/\d+ ms/);
    expect(install?.data?.elapsedMs).toBeGreaterThan(0);

    // AC1/AC9 — re-resolved in the same run, and the probe describes the
    // adapter that exists now rather than the machine as it was at start.
    const claude = check(result.report, 'agents.claude');
    expect(claude?.data?.state).toBe('installed');
    expect(claude?.status).toBe('ok');
    expect(claude?.detail).toContain(join(host.binDir, 'claude-agent-acp'));
    expect(check(result.report, 'capabilities.claude')?.detail).toContain(ADAPTER_VERSION);
    expect(await readdir(host.fixtures)).toContain(`claude@${ADAPTER_VERSION}.json`);

    expect(result.exitCode).toBe(0);
  });

  it('reports adapter-missing with the vendor path before any install (AC1, AC2)', async () => {
    const host = await machine('s50-state', { vendors: ['claude'] });

    const result = await runDoctor(base(host));
    const claude = check(result.report, 'agents.claude');

    expect(claude?.data?.state).toBe('adapter-missing');
    expect(claude?.status).toBe('warn');
    expect(claude?.detail).toContain(join(host.binDir, 'claude'));
    expect(claude?.detail).toContain(CLAUDE_PKG);
    // AC3 — a provider DeFlow cannot route through is not a broken machine.
    expect(result.exitCode).toBe(0);
    expect(result.report.status).not.toBe('fail');
  });

  /**
   * KAR-19.2 AC3, EPIC-19-S13 — one sentence, three surfaces.
   *
   * `doctor`'s Agents line and the daemon's admission refusal are rendered for
   * the same machine state and compared **byte for byte**. A second, friendlier
   * wording written for the refusal would be correct on the day it was written
   * and would drift within a month; this is what makes that a failing test
   * rather than a thing to remember. The source half of the same guard —
   * that exactly one module composes the sentence at all — is
   * `test/one-install-renderer.test.ts`.
   *
   * **Amended 2026-08-13 by KAR-19.10.** This machine — a vendor CLI with no
   * ACP bridge — is no longer refused by default: it can frame, survey and plan
   * through the exec shim, so admission admits it and states what it cannot
   * reach. The refusal it is compared against is therefore the one an operator
   * gets when they name it explicitly, which is the case where DeFlow will not
   * quietly serve part of the run on something else. The claim under test is
   * unchanged: the sentence is `providerVerdict`'s, not a second wording.
   */
  it('renders the same sentence doctor prints into the admission refusal (KAR-19.2 AC3)', async () => {
    const host = await machine('s13-wording', { vendors: ['claude'] });

    const doctored = check((await runDoctor(base(host))).report, 'agents.claude');
    const resolutions = resolveProviderStates([host.binDir]);
    const claude = resolutions.find((entry) => entry.provider === 'claude');
    const refusal = admitRun(resolutions, { provider: 'claude' });

    expect(claude).toBeDefined();
    const sentence = providerVerdict(claude as ProviderResolution).detail;

    // The report and the refusal each carry the renderer's own sentence, so
    // they cannot say different things about the same machine.
    expect(doctored?.detail).toContain(sentence);
    expect(refusal.outcome).toBe('refused');
    if (refusal.outcome !== 'refused') return;

    expect(refusal.message).toContain(sentence);
    expect(refusal.message).not.toContain('claude is not installed');
    // AC4 — and the refusal, unlike the report, ends with the way to proceed
    // with nothing installed at all.
    expect(refusal.message.trimEnd().endsWith(MOCK_AGENT_SENTENCE.trimEnd())).toBe(true);
  });
});

suite('"claude is not installed" is never printed when claude is on PATH (EPIC-18-S52)', () => {
  it('says it in no stream — text, stderr, or the JSON document', async () => {
    const host = await machine('s52', { vendors: ['claude'] });

    const text = await runDoctor(base(host));
    const json = await runDoctor(base(host, { json: true }));

    for (const stream of [text.stdout, text.stderr, json.stdout, json.stderr]) {
      expect(stream).not.toContain('claude is not installed');
    }
    for (const rendering of [text.stdout, json.stdout]) {
      expect(rendering).toContain(join(host.binDir, 'claude'));
      expect(rendering).toContain(CLAUDE_PKG);
    }
    expect(text.exitCode).toBe(0);
    expect(json.exitCode).toBe(0);
  });

  it('is still the right sentence when it is true', async () => {
    const host = await machine('s52-absent', {});

    const result = await runDoctor(base(host));
    const claude = check(result.report, 'agents.claude');

    // The guard against over-correcting: a fix that deletes the phrase for
    // every machine trades one wrong report for another.
    expect(claude?.detail).toContain('claude is not installed');
    expect(claude?.detail).toContain(`npm install -g ${CLAUDE_PKG}`);
    expect(claude?.data?.state).toBe('not-installed');
    expect(claude?.status).toBe('warn');
    // The binary that is missing is the vendor CLI, and it is the one the
    // operator has to get first — naming the bridge here is what made the
    // sentence unreadable in the other direction.
    expect(claude?.detail).toContain('"claude"');
    expect(result.exitCode).toBe(0);
  });
});

suite('--fix installs without prompting; --json never prompts (EPIC-18-S53)', () => {
  it('installs once per missing adapter and no more, with no TTY', async () => {
    const host = await machine('s53-fix', { vendors: ['claude', 'codex'], npm: 'installs' });
    const scripted = scriptedPrompt('y');

    const result = await runDoctor(
      base(host, {
        fix: true,
        isTty: () => false,
        prompt: scripted.prompt,
        clock: systemClock,
      }),
    );

    // AC6 — --fix does not ask, and nothing was written to stdout to ask with.
    expect(scripted.asked).toEqual([]);
    expect(result.stdout).not.toContain('[y/N]');

    expect(await host.invocations()).toEqual([
      ['install', '-g', CLAUDE_PKG],
      ['install', '-g', CODEX_PKG],
    ]);

    for (const provider of ['claude', 'codex']) {
      const install = check(result.report, `agents.${provider}.install`);
      expect(install?.data?.command).toBe(
        `npm install -g ${provider === 'claude' ? CLAUDE_PKG : CODEX_PKG}`,
      );
      expect(install?.data?.exitCode).toBe(0);
      expect(install?.data?.elapsedMs).toBeGreaterThan(0);
    }
    expect(result.exitCode).toBe(0);
  });

  it('carries a per-provider install result inside the --json --fix document', async () => {
    const host = await machine('s53-json', { vendors: ['claude'], npm: 'installs' });
    const scripted = scriptedPrompt('y');

    const result = await runDoctor(
      base(host, { json: true, fix: true, isTty: () => true, prompt: scripted.prompt }),
    );

    expect(scripted.asked).toEqual([]);
    expect(await host.invocations()).toEqual([['install', '-g', CLAUDE_PKG]]);

    const parsed = JSON.parse(result.stdout) as {
      exitCode: number;
      sections: { checks: { id: string; status: string; data?: Record<string, unknown> }[] }[];
    };
    const install = parsed.sections
      .flatMap((entry) => entry.checks)
      .find((entry) => entry.id === 'agents.claude.install');
    expect(install?.status).toBe('ok');
    expect(install?.data?.command).toBe(`npm install -g ${CLAUDE_PKG}`);
    expect(install?.data?.exitCode).toBe(0);
    // Exactly one document, and no ANSI byte in it.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the absence of ESC
    expect(result.stdout).not.toMatch(/\[/);
    expect(parsed.exitCode).toBe(0);
  });

  it('installs nothing with no TTY and no --fix, and prints the command instead', async () => {
    const host = await machine('s53-piped', { vendors: ['claude'], npm: 'installs' });
    const scripted = scriptedPrompt('y');

    const result = await runDoctor(base(host, { isTty: () => false, prompt: scripted.prompt }));

    expect(scripted.asked).toEqual([]);
    expect(await host.invocations()).toEqual([]);

    const claude = check(result.report, 'agents.claude');
    expect(claude?.status).toBe('warn');
    expect(claude?.data?.state).toBe('adapter-missing');
    expect(claude?.detail).toContain(`npm install -g ${CLAUDE_PKG}`);
    expect(result.exitCode).toBe(0);
  });
});

suite('an install that does not work says so (EPIC-18-S54)', () => {
  const rows = [
    { name: 'E401', code: 1, stderr: 'npm error code E401 — incorrect or missing credentials\n' },
    {
      name: 'EACCES',
      code: 1,
      stderr: "npm error code EACCES — permission denied, mkdir '/usr/lib'\n",
    },
    { name: 'not found', code: 127, stderr: 'npm: command not found\n' },
  ] as const;

  for (const row of rows) {
    it(`reports ${row.name} verbatim, once, and never as a success`, async () => {
      const host = await machine(`s54-${row.code}-${row.name.replace(/\W/g, '')}`, {
        vendors: ['claude'],
        npm: { code: row.code, stderr: row.stderr },
      });

      const result = await runDoctor(base(host, { fix: true, clock: systemClock }));

      // AC10 — one attempt, one report. An offline machine costs one timeout.
      expect(await host.invocations()).toEqual([['install', '-g', CLAUDE_PKG]]);

      const install = check(result.report, 'agents.claude.install');
      expect(install?.status).toBe('warn');
      expect(install?.data?.exitCode).toBe(row.code);
      expect(install?.detail).toMatch(/\d+ ms/);
      // AC8 — npm's own words, trimmed but not paraphrased.
      expect(install?.detail).toContain(row.stderr.trim());
      expect(install?.detail).not.toMatch(/\binstalled successfully\b|\bis now installed\b/i);

      // AC8 — the state afterwards is re-resolved, not read off the exit code.
      expect(check(result.report, 'agents.claude')?.data?.state).toBe('adapter-missing');
      expect(check(result.report, 'agents.claude')?.status).toBe('warn');
      expect(result.exitCode).toBe(0);
    });
  }

  it('is resolved rather than assumed when npm exits 0 and installs nothing', async () => {
    const host = await machine('s54-liar', {
      vendors: ['claude'],
      npm: 'succeeds-installing-nothing',
    });

    const result = await runDoctor(base(host, { fix: true, clock: systemClock }));

    const install = check(result.report, 'agents.claude.install');
    expect(install?.data?.exitCode).toBe(0);
    expect(install?.status).toBe('warn');
    // The sentence nobody writes: the command said it worked and the binary is
    // still not there. A different global prefix produces exactly this.
    expect(install?.detail).toMatch(/reported success/i);
    expect(install?.detail).toContain('claude-agent-acp');
    expect(check(result.report, 'agents.claude')?.data?.state).toBe('adapter-missing');
    expect(result.exitCode).toBe(0);
  });
});

suite('declining installs nothing and changes no exit code (EPIC-18-S55)', () => {
  // The outline's third row — EOF on stdin — is asserted where it can actually
  // be staged: `askOn` against a stream that is already ended, in
  // `agent-install.test.ts`. Passing `''` here a second time under an "EOF"
  // name would be the same assertion wearing a label it had not earned.
  for (const [label, answer] of [
    ['n', 'n'],
    ['a bare Enter', ''],
  ] as const) {
    it(`spawns no child process for ${label}`, async () => {
      const host = await machine(`s55-${label.replace(/\W/g, '')}`, {
        vendors: ['claude'],
        npm: 'installs',
      });
      const scripted = scriptedPrompt(answer);

      const result = await runDoctor(base(host, { isTty: () => true, prompt: scripted.prompt }));

      expect(scripted.asked).toHaveLength(1);
      expect(await host.invocations()).toEqual([]);

      const claude = check(result.report, 'agents.claude');
      expect(claude?.status).toBe('warn');
      expect(claude?.data?.state).toBe('adapter-missing');
      expect(check(result.report, 'agents.claude.install')?.status).toBe('warn');
      expect(detailsOf(result.report, 'agents')).toContain(`npm install -g ${CLAUDE_PKG}`);
      expect(result.exitCode).toBe(0);
    });
  }

  it('leaves KAR-18.4 AC11 alone: a git fail is 5, and the warns are still warns', async () => {
    const host = await machine('s55-exit', {
      vendors: ['claude'],
      npm: { code: 1, stderr: 'npm error code E401\n' },
      gitVersion: '2.30.0',
    });

    const result = await runDoctor(base(host, { fix: true, clock: systemClock }));

    expect(section(result.report, 'git').status).toBe('fail');
    expect(result.exitCode).toBe(5);
    // …because of the git check and for no other reason: everything this story
    // added is a warn, and warns do not reach the exit code.
    expect(section(result.report, 'agents').status).toBe('warn');
    for (const id of ['agents.claude', 'agents.claude.install']) {
      expect(check(result.report, id)?.status).toBe('warn');
    }
  });
});

suite('no egress, and a vendor that is not on the machine (EPIC-18-S56)', () => {
  it('reports the network error as npm gave it, once, and says it can wait', async () => {
    const offline =
      'npm error code ENOTFOUND\n' +
      'npm error network request to https://registry.npmjs.org/@agentclientprotocol%2fclaude-agent-acp failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org\n';
    const host = await machine('s56-offline', {
      vendors: ['claude'],
      npm: { code: 1, stderr: offline },
    });

    const result = await runDoctor(base(host, { fix: true, clock: systemClock }));

    expect(await host.invocations()).toHaveLength(1);

    const install = check(result.report, 'agents.claude.install');
    expect(install?.status).toBe('warn');
    expect(install?.detail).toContain('getaddrinfo ENOTFOUND registry.npmjs.org');
    // NF1 — an offer that cannot complete offline is survivable, and the report
    // says when it can be completed instead of leaving the operator guessing.
    expect(install?.detail).toMatch(/egress/i);
    expect(check(result.report, 'agents.claude')?.data?.state).toBe('adapter-missing');
    expect(result.exitCode).toBe(0);
  });

  it('spawns no npm at all for vendors that are not on the machine (AC7)', async () => {
    const host = await machine('s56-none', { npm: 'installs' });
    const scripted = scriptedPrompt('y');

    const result = await runDoctor(
      base(host, { fix: true, isTty: () => true, prompt: scripted.prompt }),
    );

    expect(scripted.asked).toEqual([]);
    expect(await host.invocations()).toEqual([]);

    const agents = detailsOf(result.report, 'agents');
    for (const [provider, pkg] of [
      ['claude', CLAUDE_PKG],
      ['codex', CODEX_PKG],
      ['gemini', '@google/gemini-cli'],
      ['copilot', '@github/copilot'],
      ['opencode', 'opencode-ai'],
    ] as const) {
      expect(check(result.report, `agents.${provider}`)?.data?.state).toBe('not-installed');
      expect(check(result.report, `agents.${provider}`)?.status).toBe('warn');
      expect(check(result.report, `agents.${provider}.install`)).toBeUndefined();
      expect(agents).toContain(`npm install -g ${pkg}`);
    }
    expect(result.exitCode).toBe(0);
  });

  it('never claims adapter-missing for a native provider on a real PATH', async () => {
    const host = await machine('s56-native', { vendors: ['gemini'], npm: 'installs' });

    const result = await runDoctor(base(host, { fix: true }));

    // `installed` rather than "not adapter-missing": an assertion that reads
    // green off an absent field would pass before any of this existed.
    expect(check(result.report, 'agents.gemini')?.data?.state).toBe('installed');
    expect(check(result.report, 'agents.gemini.install')).toBeUndefined();
    expect(await host.invocations()).toEqual([]);
  });
});

suite('one package, and nothing wider (AC11)', () => {
  it('runs no update and writes no lockfile into the repository', async () => {
    const host = await machine('ac11', { vendors: ['claude'], npm: 'installs' });

    await runDoctor(base(host, { fix: true, clock: systemClock }));

    const invocations = await host.invocations();
    expect(invocations).toEqual([['install', '-g', CLAUDE_PKG]]);
    for (const argv of invocations) {
      expect(argv.join(' ')).not.toMatch(/\b(update|upgrade|audit|-y)\b/);
    }

    // The fake npm writes a lockfile into its own cwd on every success, so this
    // asserts *where* the install ran rather than what npm chose to do.
    expect(existsSync(join(host.cwd, 'package-lock.json'))).toBe(false);
    expect(existsSync(join(host.cwd, 'node_modules'))).toBe(false);
    expect(existsSync(join(host.cwd, '.DeFlow', 'package-lock.json'))).toBe(false);
  });
});
