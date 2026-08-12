/**
 * KAR-18.3 AC7 / EPIC-18-S25 — `--json` in a pipe.
 *
 * `./run/render.test.ts` covers the shape of a line; what only a real process
 * can settle is that stdout **is not a TTY** and that nothing between the
 * renderer and the file descriptor puts an escape back. The CLI's stdout here
 * is a real file descriptor opened on a real file — the same thing a shell's
 * `> out.ndjson` produces — rather than a pipe this process reads, so
 * `process.stdout.isTTY` is genuinely `undefined` and the bytes asserted are
 * the bytes that landed on disk.
 *
 * Verifies: EPIC-18-S25 · AC7 · test plan #7
 */
import { RunIdSchema } from '@DeFlow/core';
import { type Booted, boot } from '@DeFlow/daemon';
import { it, makeRepo } from '@DeFlow/testkit';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, describe as suite } from 'vitest';
import { RUN_EXIT_CODES } from '../../src/run/exit-codes.ts';
import { spawnRun, until } from './support/cli-process.ts';
import { openSpecGate, waitForRun } from './support/run-fixture.ts';

let booted: Booted | undefined;

afterEach(async () => {
  await booted?.shutdown();
  booted = undefined;
});

/** The ESC byte that must never reach a pipe. */
const ESC = '\u001B';

suite('EPIC-18-S25 — machine-readable output (AC7)', () => {
  it('every line parses, no line has an escape, and the seqs strictly increase', async ({
    tmp,
  }) => {
    const dataDir = join(tmp, 'data');
    mkdirSync(dataDir, { recursive: true });
    booted = await boot({ dataDir, port: 0, dev: false });
    const repo = await makeRepo({ dir: join(tmp, 'repo') });

    const out = join(tmp, 'out.ndjson');
    const fd = openSync(out, 'w');
    const cli = spawnRun({
      dataDir,
      cwd: repo.dir,
      args: ['--json', '--no-wait', 'add a health endpoint'],
      stdoutFd: fd,
    });

    // The gate the run parks at, opened once the CLI has created the run —
    // see `./support/run-fixture.ts` for why the spec rather than the daemon
    // appends it.
    const runId = await waitForRun(booted.db);
    await until('the CLI subscribed', () =>
      readFileSync(out, 'utf8').includes('task.submitted') ? true : null,
    );
    openSpecGate(RunIdSchema.parse(runId), {
      db: booted.db,
      epoch: booted.epoch,
      ts: Date.now(),
    });

    const exit = await cli.exited;
    closeSync(fd);

    // AC6's fourth code, over the same event stream the human renderer reads.
    expect(exit.code).toBe(RUN_EXIT_CODES.awaitingHuman);

    const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const objects = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    for (const [index, object] of objects.entries()) {
      expect(lines[index]).not.toContain(ESC);
      expect(object).toMatchObject({ runId });
      expect(typeof object.seq).toBe('number');
      expect(typeof object.kind).toBe('string');
    }

    const seqs = objects.map((object) => Number(object.seq));
    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
    expect(new Set(seqs).size).toBe(seqs.length);

    // Nothing human-readable leaked onto the machine-readable stream: the
    // verdict sentence went to stderr, where a pipeline is not reading.
    expect(cli.stderr()).toContain('DeFlow.cli.verdict');
    expect(readFileSync(out, 'utf8')).not.toContain('DeFlow.cli.verdict');
  });
});
