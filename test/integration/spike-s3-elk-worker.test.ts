/**
 * KAR-00.4 — does elkjs survive `vite build`, and does it stay out of the entry?
 * KAR-00.10 — and is the thing that asks that question able to fail correctly?
 *
 * A3-4 is graded **High** and was never build-tested: elkjs is GWT-transpiled
 * Java, its README acknowledges bundler friction, and its documented
 * `workerUrl` option assumes a publicly-served path that does not survive
 * Vite's asset hashing. The plan — Vite's `?worker` import plus ELK's
 * `workerFactory` — was a plan, not an observation.
 *
 * Every build here is a real `vite build` subprocess over the real app at
 * spikes/s3-elk-worker/, and every number is read off the bytes it wrote. The
 * `no-elk` variant is the same application with the engine module aliased away,
 * which is what makes the entry-chunk comparison in AC2 a comparison of one
 * thing rather than of two different apps.
 *
 * ## What KAR-00.10 changed, and why
 *
 * This file used to assert the *byte count* KAR-00.4 recorded on 2026-08-04 —
 * `elk-worker.min-COjlAv4s.js`, 1425139 B — against whatever this machine had
 * just built. That is not an instrument. A minifier that emits 51 different
 * bytes under an unchanged elkjs, vite and rollup turns it red, and the only
 * available repair is to re-record the number, which buys a green until the
 * next toolchain bump and buys nothing else. Meanwhile it cannot distinguish
 * that from the regression the spike actually exists to catch — ELK sliding out
 * of its worker chunk and back into the first paint's critical path — because
 * both readings are just "the number moved".
 *
 * So the claims below are the properties, and the sizes are relationships:
 *
 *  - ELK is in a worker chunk and its fingerprints are absent from the entry;
 *  - the entry chunk stays under an absolute budget (NF3 territory);
 *  - what ELK adds to the entry stays under AC2's 100 KB cap;
 *  - and of ELK's total shipped weight, the worker chunk carries essentially
 *    all of it — a share, so a minifier moving kilobytes cannot trip it and a
 *    megabyte moving from the worker to the entry cannot avoid tripping it.
 *
 * `measurements/build-sizes.json` survives as a **record** of one build on one
 * stated toolchain. Nothing asserts equality against it.
 *
 * The proof that any of this can fail is the `main-thread` variant: the same
 * app with `elkjs/lib/elk.bundled.js` imported as a plain module, which is
 * exactly "ELK was bundled back into the entry chunk". Every dimension of the
 * instrument is asserted to fire on it. A budget that cannot fail is not an
 * instrument, and the way to know it can fail is to watch it.
 *
 * The browser half — the worker actually loading from the hashed URL, the
 * heartbeat, the union graph, the constraint recipe — is
 * e2e/spike-s3-elk-worker.test.ts.
 *
 * Verifies: EPIC-00-S14 (scenarios 1 and 2) · AC1, AC2, AC5, AC6.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it, describe as suite } from 'vitest';
import {
  BUDGET,
  type BuildResult,
  type BuildSizesRecord,
  budgetViolations,
  build,
  elkWeight,
  MEASUREMENTS_DIR,
  readAsset,
  runCheckScript,
} from '../../spikes/s3-elk-worker/src/harness.ts';
import { repoRoot } from '../support/workspace.ts';

const NOTE = join(repoRoot, 'docs/spikes/S3-elk-worker.md');
const note = (): string => readFileSync(NOTE, 'utf8');

/**
 * Strings only a real GWT-transpiled ELK bundle contains. Deliberately *not*
 * the bare "org.eclipse.elk" prefix: the app's own constraint probe writes
 * option ids like "org.eclipse.elk.layered.layering.layerChoiceConstraint" into
 * the entry chunk, and a fingerprint a caller can trip is not a fingerprint.
 */
const ELK_FINGERPRINTS = ['org.eclipse.elk.alg', 'elk.alg.layered', 'ELK Layered'];

let withElk: BuildResult;
let withoutElk: BuildResult;

beforeAll(async () => {
  withElk = await build('elk');
  withoutElk = await build('no-elk');
}, 180_000);

suite('EPIC-00-S14 — the worker chunk is emitted and hashed (AC1)', () => {
  it('builds at all', () => {
    expect(withElk.exitCode, withElk.output).toBe(0);
    expect(existsSync(join(withElk.outDir, 'index.html'))).toBe(true);
  });

  it('emits exactly one worker chunk, hashed, under assets/', () => {
    expect(
      withElk.workers.map((chunk) => chunk.file),
      'no worker chunk means "?worker" + workerFactory did not wire up, and the dagre fallback is the answer',
    ).toHaveLength(1);
    const [worker] = withElk.workers;
    expect(worker?.file).toMatch(/^assets\/.*worker.*-[A-Za-z0-9_-]{8}\.js$/);
  });

  it('puts ELK itself in that worker chunk, not somewhere else', () => {
    const [worker] = withElk.workers;
    const text = readAsset(withElk, worker?.file ?? '');
    for (const fingerprint of ELK_FINGERPRINTS) expect(text).toContain(fingerprint);
    expect(worker?.bytes).toBeGreaterThan(1_000_000);
  });

  it('references the hashed worker from the entry, so the URL is the built one', () => {
    const [worker] = withElk.workers;
    const entry = readAsset(withElk, withElk.entry.file);
    expect(entry).toContain((worker?.file ?? '').replace('assets/', ''));
  });
});

suite('EPIC-00-S14 — ELK is absent from the initial chunk (AC2)', () => {
  it('leaves no trace of ELK in the entry chunk', () => {
    const entry = readAsset(withElk, withElk.entry.file);
    for (const fingerprint of ELK_FINGERPRINTS) expect(entry).not.toContain(fingerprint);
  });

  it('costs the entry chunk less than 100 KB against the same build without ELK', () => {
    const delta = withElk.entry.bytes - withoutElk.entry.bytes;
    expect(
      Math.abs(delta),
      `entry with ELK: ${withElk.entry.bytes} B, without: ${withoutElk.entry.bytes} B`,
    ).toBeLessThan(BUDGET.entryCostBytes);
  });

  it('emits no worker chunk at all in the ELK-free variant, so the comparison is honest', () => {
    expect(withoutElk.workers).toHaveLength(0);
    expect(withoutElk.exitCode, withoutElk.output).toBe(0);
  });

  it('keeps the whole entry chunk inside its own budget, whatever the minifier does', () => {
    const weight = elkWeight(withElk, withoutElk);
    expect(
      weight.entryBytes,
      `the entry chunk is the first paint's critical path (NF3); ${weight.entryBytes} B against a ${BUDGET.entryBytes} B budget`,
    ).toBeLessThan(BUDGET.entryBytes);
  });

  it('puts essentially all of ELK’s shipped weight in the worker chunk, as a share', () => {
    const weight = elkWeight(withElk, withoutElk);
    expect(
      weight.workerShare,
      `worker chunk ${weight.workerBytes} B against ${weight.entryCostBytes} B of entry cost — a share survives a minifier moving bytes, and cannot survive a megabyte moving chunks`,
    ).toBeGreaterThan(BUDGET.workerShare);
  });

  it('passes every dimension of the budget at once', () => {
    expect(budgetViolations(elkWeight(withElk, withoutElk))).toEqual([]);
  });
});

/**
 * KAR-00.10 AC4. The instrument above is only worth having if it goes red when
 * the thing it protects breaks, and the only way to know that is to break it.
 *
 * `S3_VARIANT=main-thread` aliases the engine module to one that imports
 * `elkjs/lib/elk.bundled.js` as a plain module — no `?worker`, no
 * `workerFactory`, 1.6 MB of GWT-transpiled Java statically reachable from the
 * entry. That is precisely the regression docs/spikes/S3-elk-worker.md names as
 * the failure mode the measurement rules out, built rather than described.
 *
 * Every dimension is asserted separately rather than as one "it fails", because
 * an instrument with three dead dimensions and one live one still reports a
 * violation.
 */
suite('KAR-00.10 — the budget goes red when ELK is bundled back into the entry', () => {
  let mainThread: BuildResult;

  beforeAll(async () => {
    mainThread = await build('main-thread');
  }, 180_000);

  it('builds, so what follows is a measurement and not a broken build', () => {
    expect(mainThread.exitCode, mainThread.output).toBe(0);
  });

  it('puts ELK in the entry chunk, where the fingerprint check finds it', () => {
    const entry = readAsset(mainThread, mainThread.entry.file);
    for (const fingerprint of ELK_FINGERPRINTS) expect(entry).toContain(fingerprint);
  });

  it('emits no worker chunk at all', () => {
    expect(mainThread.workers).toEqual([]);
  });

  it('blows the entry budget, the 100 KB cap and the worker share, all three', () => {
    const weight = elkWeight(mainThread, withoutElk);
    expect(weight.entryBytes).toBeGreaterThan(BUDGET.entryBytes);
    expect(weight.entryCostBytes).toBeGreaterThan(BUDGET.entryCostBytes);
    expect(weight.workerShare).toBeLessThan(BUDGET.workerShare);
  });

  it('is reported by the same instrument the passing build is judged with', () => {
    expect(budgetViolations(elkWeight(mainThread, withoutElk)).sort()).toEqual([
      'elk-in-entry',
      'entry-bytes',
      'entry-cost-bytes',
      'worker-share',
    ]);
  });
});

suite('the artefact the epic asks for', () => {
  /**
   * The two halves are one spec on purpose. `check.mjs` used to rewrite
   * `measurements/build-sizes.json` every time it ran — which the note already
   * claimed it did not (docs/spikes/S3-elk-worker.md §Measurement: "Only
   * `pnpm spike:s3:record` rewrites the committed copy"). Two things followed:
   * `pnpm test` left the working tree dirty, and the spec that compared the
   * recorded numbers against the measured ones ran *after* the run that had
   * just overwritten them, so it could not fail. The same numbers quoted in the
   * note, which nothing rewrites, could and did.
   *
   * Split across two specs, the second one would read a file the first had
   * already restamped and pass for the same reason. So the pristine content is
   * read before the first `check.mjs` this file ever runs.
   */
  it('has a check.mjs that asserts on the built dist, passes, and leaves the record alone', () => {
    const record = join(MEASUREMENTS_DIR, 'build-sizes.json');
    const before = readFileSync(record, 'utf8');

    const check = runCheckScript();
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toContain('worker chunk');

    expect(
      readFileSync(record, 'utf8'),
      'a test run that restamps a tracked golden can never disagree with it',
    ).toBe(before);
  });
});

/**
 * AC3: the numbers KAR-00.4 measured are still worth having — they are what the
 * note quotes, and "1.4 MB of ELK, 5.5 KB of entry cost" is the finding. They
 * are kept as a record of one build on one stated toolchain, and asserted only
 * for the things a record has to be: well-formed, self-describing, and inside
 * the budgets it was taken under.
 */
suite('KAR-00.10 — build-sizes.json is a record, not an assertion (AC3)', () => {
  const record = (): BuildSizesRecord =>
    JSON.parse(
      readFileSync(join(MEASUREMENTS_DIR, 'build-sizes.json'), 'utf8'),
    ) as BuildSizesRecord;

  it('says it is a record, and on what toolchain it was taken', () => {
    const { recordedOn } = record();
    expect(recordedOn.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(recordedOn.node).toMatch(/^v?\d+\./);
    expect(recordedOn.os).not.toHaveLength(0);
    expect(recordedOn.vite).toBe('8.2.0');
    expect(recordedOn.elkjs).toBe('0.12.0');
    expect(record().$comment).toMatch(/record/i);
  });

  it('carries the budgets it was judged against, so the record and the code cannot drift', () => {
    expect(record().budgets).toEqual(BUDGET);
  });

  it('is a build that would still pass those budgets today', () => {
    const { measured } = record();
    expect(
      budgetViolations({
        entryBytes: measured.entryWithElkBytes,
        entryCostBytes: measured.entryDeltaBytes,
        workerBytes: measured.workerChunkBytes,
        workerShare:
          measured.workerChunkBytes / (measured.workerChunkBytes + measured.entryDeltaBytes),
        elkInEntry: false,
      }),
    ).toEqual([]);
  });

  it('is the same order of magnitude as what this machine builds, without being the same bytes', () => {
    const { measured } = record();
    const drift =
      Math.abs((withElk.workers[0]?.bytes ?? 0) - measured.workerChunkBytes) /
      measured.workerChunkBytes;
    expect(
      drift,
      `recorded ${measured.workerChunkBytes} B, built ${withElk.workers[0]?.bytes ?? 0} B — a tolerance, so a minifier cannot spend an afternoon, and a vanished worker chunk cannot hide`,
    ).toBeLessThan(0.05);
  });
});

suite('EPIC-00-S14, EPIC-00-S16 — the decision note (AC2, AC5, AC6)', () => {
  it('exists, with a measurement and a decision', () => {
    expect(existsSync(NOTE)).toBe(true);
    expect(note()).toMatch(/## Measurement/);
    expect(note()).toMatch(/## Decision/);
  });

  /**
   * AC2 asks for the before/after numbers in the note, and they are there — as
   * the record of the build they were taken from, which is why the note states
   * the machine and the date in its header. What this spec will not do is
   * assert that a number written into prose on 2026-08-04 is the number this
   * machine's minifier emits today: that is the equality KAR-00.10 exists to
   * remove, and it fails for reasons that have nothing to say about ELK.
   *
   * What is asserted instead is that the note states the claim the code now
   * enforces, so a reader and the suite cannot disagree about what is protected.
   */
  it('quotes the entry-chunk numbers it recorded, as a record with a date on it', () => {
    const text = note();
    const { measured } = JSON.parse(
      readFileSync(join(MEASUREMENTS_DIR, 'build-sizes.json'), 'utf8'),
    ) as BuildSizesRecord;
    expect(text, 'AC2 asks for the before/after numbers in the note').toContain(
      String(measured.entryWithElkBytes),
    );
    expect(text).toContain(String(measured.entryWithoutElkBytes));
    expect(text).toContain(String(measured.workerChunkBytes));
    expect(
      text,
      'a recorded number without its toolchain is a number nobody can re-derive',
    ).toMatch(/recorded on|record of one build/i);
  });

  it('states the budgets the suite now enforces, in the same units', () => {
    const text = note();
    expect(text).toContain(String(BUDGET.entryBytes));
    expect(text).toContain(String(BUDGET.entryCostBytes));
    expect(text).toContain(String(BUDGET.workerShare));
    expect(text, 'AC4: the note has to say how the budget was proved able to fail').toContain(
      'main-thread',
    );
  });

  it('names the engine KAR-16.6 is built against (AC6)', () => {
    const text = note();
    expect(text).toContain('KAR-16.6');
    expect(text).toMatch(/elkjs|@dagrejs\/dagre/);
  });

  it('records what the constraint recipe actually did, so nobody re-tries it in W11 (AC5)', () => {
    const text = note();
    expect(text).toContain('layerChoiceConstraint');
    expect(text).toContain('positionChoiceConstraint');
    expect(text).toContain('interactiveLayout');
    expect(text).toContain('semiInteractive');
    expect(text).toContain('org.eclipse.elk.position');
  });

  it('records the union graph as the primary mechanism for F10.2, and warns about the dagre pin', () => {
    const text = note();
    expect(text).toMatch(/union[- ]graph/i);
    expect(text).toContain('F10.2');
    expect(text).toContain('1.1.2');
    expect(text).toContain('3.0.0');
  });
});
