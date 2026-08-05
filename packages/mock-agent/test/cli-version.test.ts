/**
 * `--version`, added for KAR-05.2.
 *
 * The capability probe records "the verbatim `--version` output" (KAR-05.2
 * AC2), so the one agent DeFlow can probe on every machine with no vendor CLI
 * installed has to answer it. Without this flag the probe's version column
 * could only ever be exercised against a real vendor binary — which is exactly
 * the dependency the mock exists to remove.
 *
 * `$DeFlow_MOCK_VERSION` is the seam that makes a *version bump* testable
 * (EPIC-05-S8): the probe's three-part primary key has to write a second row
 * when the same binary starts reporting a different version, and the only
 * honest way to observe that is to have the real binary report one.
 *
 * Verifies: KAR-05.2 AC2 (the mock half)
 */
import { PassThrough } from 'node:stream';
import { expect, it, describe as suite } from 'vitest';
import { BIN_NAME, MOCK_AGENT_VERSION, parseArgv, VERSION_ENV } from '../src/cli.ts';
import { type Io, run } from '../src/main.ts';

interface CollectingIo extends Io {
  stdoutText(): string;
  stderrText(): string;
}

function collectingIo(): CollectingIo {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => out.push(chunk));
  stderr.on('data', (chunk: Buffer) => err.push(chunk));
  return {
    stdin: new PassThrough(),
    stdout,
    stderr,
    stdoutText: () => Buffer.concat(out).toString('utf8'),
    stderrText: () => Buffer.concat(err).toString('utf8'),
  };
}

suite('parseArgv --version', () => {
  it('is its own kind, not a run', () => {
    expect(parseArgv(['--version'])).toEqual({ kind: 'version' });
  });

  it('wins over every other argument, the way --help does', () => {
    expect(parseArgv(['--capabilities', 'claude', '--version'])).toEqual({ kind: 'version' });
  });
});

suite('run --version', () => {
  it('writes one line, "<bin> <version>", and exits 0', async () => {
    const io = collectingIo();
    const code = await run(['--version'], io, {});
    expect(code).toBe(0);
    expect(io.stdoutText()).toBe(`${BIN_NAME} ${MOCK_AGENT_VERSION}\n`);
    expect(io.stderrText()).toBe('');
  });

  it('reports the version $DeFlow_MOCK_VERSION names, so a bump is testable', async () => {
    const io = collectingIo();
    const code = await run(['--version'], io, { [VERSION_ENV]: '1.1.0' });
    expect(code).toBe(0);
    expect(io.stdoutText()).toBe(`${BIN_NAME} 1.1.0\n`);
  });
});
