/**
 * KAR-00.4 — does elkjs survive `vite build`, and does it stay out of the entry?
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
  type BuildResult,
  build,
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
    ).toBeLessThan(100 * 1024);
  });

  it('emits no worker chunk at all in the ELK-free variant, so the comparison is honest', () => {
    expect(withoutElk.workers).toHaveLength(0);
    expect(withoutElk.exitCode, withoutElk.output).toBe(0);
  });
});

suite('the artefact the epic asks for', () => {
  it('has a check.mjs that asserts on the built dist and passes', () => {
    const check = runCheckScript();
    expect(check.exitCode, check.output).toBe(0);
    expect(check.output).toContain('worker chunk');
  });

  it('records the two entry sizes it measured, for the note to quote', () => {
    const recorded = JSON.parse(
      readFileSync(join(MEASUREMENTS_DIR, 'build-sizes.json'), 'utf8'),
    ) as Record<string, number>;
    expect(recorded.entryWithElkBytes).toBe(withElk.entry.bytes);
    expect(recorded.entryWithoutElkBytes).toBe(withoutElk.entry.bytes);
    expect(recorded.workerChunkBytes).toBe(withElk.workers[0]?.bytes);
  });
});

suite('EPIC-00-S14, EPIC-00-S16 — the decision note (AC2, AC5, AC6)', () => {
  it('exists, with a measurement and a decision', () => {
    expect(existsSync(NOTE)).toBe(true);
    expect(note()).toMatch(/## Measurement/);
    expect(note()).toMatch(/## Decision/);
  });

  it('quotes both entry-chunk byte counts and the worker chunk size', () => {
    const text = note();
    expect(text, 'AC2 asks for the before/after numbers in the note').toContain(
      String(withElk.entry.bytes),
    );
    expect(text).toContain(String(withoutElk.entry.bytes));
    expect(text).toContain(String(withElk.workers[0]?.bytes));
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
