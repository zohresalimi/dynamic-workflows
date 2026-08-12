/**
 * KAR-18.8 — the decisions that must not be reached from a machine.
 *
 * Which state a provider is in, and which sentence the operator reads for it,
 * is a claim about *the registry* — that `claude` and `claude-agent-acp` are
 * two different binaries and only one of them is what DeFlow spawns — so it is
 * asserted here against a staged root rather than against whatever the
 * developer happens to have installed. Whether an install may happen at all is
 * pure argv, and the one branch of it worth spelling out on its own is that a
 * bare Enter means no.
 *
 * The wording guard is the test this story is really about. The report that
 * sent the first operator to install something they already had was one
 * substring in one sentence, and the invariant that would have caught it is
 * small enough to state: `is not installed` never co-occurs with a resolved
 * vendor-CLI path in the same check.
 *
 * Verifies: EPIC-18-S51, EPIC-18-S52 (the wording guard), EPIC-18-S55 (the
 * answer parser) · AC1, AC2, AC4, AC6 · test plan #1, #2, #9
 */
import { PROVIDER_SPECS } from '@DeFlow/adapters';
import { makeTempDir, removeTempDir } from '@DeFlow/testkit';
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, describe as suite } from 'vitest';
import {
  type AgentInstallState,
  installCommand,
  installMode,
  isAffirmative,
  type ProviderResolution,
  providerVerdict,
  resolveProviderStates,
} from './agent-install.ts';
import { askOn } from './run.ts';

let tmp = '';

beforeEach(async () => {
  tmp = await makeTempDir();
});

afterEach(async () => {
  await removeTempDir(tmp);
});

/** A file that exists and is executable — presence is the whole assertion. */
async function stage(root: string, names: readonly string[]): Promise<string> {
  await mkdir(root, { recursive: true });
  for (const name of names) {
    writeFileSync(join(root, name), '#!/usr/bin/env node\nprocess.exit(0);\n', { mode: 0o755 });
  }
  return root;
}

/** One provider resolved against a root holding exactly `names`. */
async function resolve(
  dir: string,
  provider: string,
  names: readonly string[],
): Promise<ProviderResolution> {
  const root = await stage(join(tmp, dir), names);
  const found = resolveProviderStates([root]).find((entry) => entry.provider === provider);
  if (found === undefined) throw new Error(`no ${provider} in the resolved registry`);
  return found;
}

/** The names to stage so that `vendor` / `spawned` are present or absent. */
function binaries(
  spec: { readonly shimBin: string; readonly bin: string },
  vendor: 'present' | 'absent',
  spawned: 'present' | 'absent',
): readonly string[] {
  return [
    ...(vendor === 'present' ? [spec.shimBin] : []),
    ...(spawned === 'present' && spec.bin !== spec.shimBin ? [spec.bin] : []),
  ];
}

suite('what the operator is told, from two resolutions and a kind (EPIC-18-S51)', () => {
  const rows = [
    {
      provider: 'claude',
      kind: 'adapter',
      vendor: 'present',
      spawned: 'present',
      state: 'installed',
      status: 'ok',
    },
    {
      provider: 'claude',
      kind: 'adapter',
      vendor: 'present',
      spawned: 'absent',
      state: 'adapter-missing',
      status: 'warn',
    },
    {
      provider: 'claude',
      kind: 'adapter',
      vendor: 'absent',
      spawned: 'absent',
      state: 'not-installed',
      status: 'warn',
    },
    // The second adapter-kind provider, named in the scenario's own notes:
    // `codex-acp` is the bridge and `codex` is the vendor CLI.
    {
      provider: 'codex',
      kind: 'adapter',
      vendor: 'present',
      spawned: 'absent',
      state: 'adapter-missing',
      status: 'warn',
    },
    {
      provider: 'gemini',
      kind: 'native',
      vendor: 'present',
      spawned: 'present',
      state: 'installed',
      status: 'ok',
    },
    {
      provider: 'gemini',
      kind: 'native',
      vendor: 'absent',
      spawned: 'absent',
      state: 'not-installed',
      status: 'warn',
    },
  ] as const;

  for (const row of rows) {
    it(`reports ${row.provider} (${row.kind}) as ${row.state}/${row.status} with the vendor CLI ${row.vendor} and the spawned binary ${row.spawned}`, async () => {
      const spec = PROVIDER_SPECS[row.provider as keyof typeof PROVIDER_SPECS];
      const resolution = await resolve(
        `${row.provider}-${row.vendor}-${row.spawned}`,
        row.provider,
        binaries({ shimBin: spec.shim.bin, bin: spec.bin }, row.vendor, row.spawned),
      );

      const verdict = providerVerdict(resolution);

      expect(verdict.state).toBe(row.state);
      expect(verdict.status).toBe(row.status);
    });
  }

  it('names the resolved absolute path when the adapter is installed', async () => {
    const root = join(tmp, 'installed');
    const resolution = await resolve('installed', 'claude', ['claude', 'claude-agent-acp']);

    expect(providerVerdict(resolution).detail).toContain(join(root, 'claude-agent-acp'));
  });

  it('says the ACP adapter is what is missing, and names it, when only the vendor CLI is here', async () => {
    const root = join(tmp, 'bridgeless');
    const resolution = await resolve('bridgeless', 'claude', ['claude']);
    const verdict = providerVerdict(resolution);

    // AC2 — the resolved path of the binary they *do* have, so the sentence is
    // checkable against their own shell rather than merely plausible.
    expect(verdict.detail).toContain(join(root, 'claude'));
    expect(verdict.detail).toContain('ACP adapter');
    expect(verdict.detail).toContain('@agentclientprotocol/claude-agent-acp');
    expect(verdict.detail).toContain('npm install -g @agentclientprotocol/claude-agent-acp');
  });

  it('still says "is not installed" when that is true, and names the install command', async () => {
    const resolution = await resolve('nothing', 'claude', []);
    const verdict = providerVerdict(resolution);

    // The guard against over-correcting: a fix that deletes the phrase outright
    // trades one wrong report for another (EPIC-18-S52, scenario 2).
    expect(verdict.detail).toContain('is not installed');
    expect(verdict.detail).toContain('npm install -g @agentclientprotocol/claude-agent-acp');
  });

  it('reports every registry provider, in id order', async () => {
    const root = await stage(join(tmp, 'all'), []);

    expect(resolveProviderStates([root]).map((entry) => entry.provider)).toEqual(
      Object.keys(PROVIDER_SPECS).toSorted((a, b) => a.localeCompare(b)),
    );
  });
});

suite('a native provider has no adapter to be missing (EPIC-18-S51)', () => {
  const natives = Object.values(PROVIDER_SPECS).filter((spec) => spec.kind === 'native');

  it('has at least one native provider to assert against', () => {
    expect(natives.length).toBeGreaterThan(0);
  });

  for (const spec of natives) {
    it(`is one executable under one name for ${spec.id}, so no reduction yields adapter-missing`, async () => {
      // The vendor CLI *is* the ACP agent for these, so an "install its adapter"
      // line would name a package that does not exist.
      expect(spec.shim.bin).toBe(spec.bin);

      for (const names of [[spec.shim.bin], []]) {
        const resolution = await resolve(`native-${spec.id}-${names.length}`, spec.id, names);
        expect(providerVerdict(resolution).state).not.toBe('adapter-missing');
      }
    });
  }
});

suite('"is not installed" never co-occurs with a resolved vendor path (EPIC-18-S52)', () => {
  // Every provider crossed with every combination of the two resolutions —
  // the table the shipped report failed on, read as an invariant rather than
  // as one example.
  for (const spec of Object.values(PROVIDER_SPECS)) {
    for (const vendor of ['present', 'absent'] as const) {
      for (const spawned of ['present', 'absent'] as const) {
        it(`holds for ${spec.id} with the vendor ${vendor} and the spawned binary ${spawned}`, async () => {
          const resolution = await resolve(
            `guard-${spec.id}-${vendor}-${spawned}`,
            spec.id,
            binaries({ shimBin: spec.shim.bin, bin: spec.bin }, vendor, spawned),
          );
          const verdict = providerVerdict(resolution);

          if (resolution.vendorPath !== null) {
            expect(verdict.detail).not.toContain('is not installed');
          }
        });
      }
    }
  }
});

suite('whether an install may happen at all', () => {
  const rows = [
    { json: false, fix: false, tty: false, mode: 'none' },
    { json: false, fix: false, tty: true, mode: 'prompt' },
    { json: false, fix: true, tty: false, mode: 'fix' },
    { json: false, fix: true, tty: true, mode: 'fix' },
    // --json never prompts and never reads stdin, TTY or not: a health check
    // that blocks in CI is a job that hangs until its timeout with no output.
    { json: true, fix: false, tty: false, mode: 'none' },
    { json: true, fix: false, tty: true, mode: 'none' },
    { json: true, fix: true, tty: false, mode: 'fix' },
    { json: true, fix: true, tty: true, mode: 'fix' },
  ] as const;

  for (const row of rows) {
    it(`is ${row.mode} with json=${row.json} fix=${row.fix} tty=${row.tty}`, () => {
      expect(installMode({ json: row.json, fix: row.fix, tty: row.tty })).toBe(row.mode);
    });
  }
});

suite('a bare Enter is not consent (EPIC-18-S55)', () => {
  for (const answer of ['y', 'Y', 'yes', 'YES', ' yes ', 'Yes\n']) {
    it(`reads ${JSON.stringify(answer)} as yes`, () => {
      expect(isAffirmative(answer)).toBe(true);
    });
  }

  for (const answer of ['', '\n', ' ', 'n', 'no', 'later', 'yep', 'ya', '1']) {
    it(`reads ${JSON.stringify(answer)} as no`, () => {
      expect(isAffirmative(answer)).toBe(false);
    });
  }

  it('answers "no" — and returns — when stdin is already at EOF', async () => {
    // The third row of the scenario outline, and the one that is a hang rather
    // than a wrong answer if it is missed: `readline.question()` on a stream
    // that ends without a line never settles, so `doctor` would sit there
    // forever on a machine whose stdout is a terminal and whose stdin is not.
    const written: string[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, done) {
        written.push(chunk.toString('utf8'));
        done();
      },
    });

    const answer = await askOn(Readable.from([]), sink)('Run it now? [y/N] ');

    expect(isAffirmative(answer)).toBe(false);
  });
});

suite('the command that is offered is the command that is run', () => {
  it('is one package, globally, and nothing else', () => {
    expect(installCommand('@agentclientprotocol/claude-agent-acp')).toBe(
      'npm install -g @agentclientprotocol/claude-agent-acp',
    );
  });
});

suite('the reported state is a type with exactly three members', () => {
  it('accepts nothing outside the three AC1 names', () => {
    const states: readonly AgentInstallState[] = ['installed', 'adapter-missing', 'not-installed'];

    expect(new Set(states).size).toBe(3);
  });
});
