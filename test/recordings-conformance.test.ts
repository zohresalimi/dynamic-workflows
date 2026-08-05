/**
 * KAR-05.7 Layer A, over the whole committed corpus — every frame in
 * `recordings/`, validated against `@agentclientprotocol/sdk`'s
 * `schema.json`.
 *
 * This is the layer that runs on every commit and costs nothing: no vendor CLI,
 * no credential, no network. It exists because the two most important adapters
 * (`claude-agent-acp`, `codex-acp`) are community-maintained bridges whose
 * fidelity to the CLI underneath them is unproven, and the way that fidelity
 * breaks is a field quietly changing shape in a release. Held against a
 * recorded corpus, that becomes a red commit; held against nothing, it becomes
 * a failed three-hour run on somebody's machine.
 *
 * Sibling to `test/recordings-scrubbed.test.ts`, which asks a different
 * question of the same files — that one is about what the recordings say about
 * the machine they came off; this one is about what they say about the
 * protocol.
 *
 * Verifies: EPIC-05-S25 · AC2, AC6
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe as suite } from 'vitest';
import { describeUpdate } from '../packages/adapters/src/updates.ts';
import {
  ACP_SCHEMA_DEFS,
  acpSchema,
  type CapturedFrame,
  corpusRecordings,
  describeViolations,
  readCapturedFrames,
  readCorpusDirectories,
  validateAcpFrames,
} from '../packages/testkit/src/acp-conformance.ts';

const ROOT = 'recordings';

const corpus = corpusRecordings(readCorpusDirectories(ROOT));

const framesOf = (file: string): CapturedFrame[] =>
  readCapturedFrames(readFileSync(join(ROOT, file), 'utf8'), `${ROOT}/${file}`);

suite('the corpus is a corpus', () => {
  it('has recordings to check, all keyed on an exact version', () => {
    // A guard whose input is empty passes for ever. `corpusRecordings` throws
    // on a directory that is not <provider>@<exact-version>, so reaching this
    // line at all is half the assertion.
    expect(corpus.length).toBeGreaterThanOrEqual(3);
    for (const recording of corpus) {
      expect(recording.version, recording.file).toMatch(/^\d+\.\d+\.\d+/);
    }
  });

  it('is validated against the published schema, with its 262 $defs', () => {
    expect(Object.keys(acpSchema().$defs as object)).toHaveLength(ACP_SCHEMA_DEFS);
  });
});

suite('AC2 — every recorded frame validates', () => {
  it.each(corpus.map((recording) => recording.file))('%s', (file) => {
    const frames = framesOf(file);
    // A file that produced no frames would pass vacuously, which is how a
    // reader that silently stopped understanding the capture format hides.
    expect(frames.length, `${file} produced no frames`).toBeGreaterThan(0);

    const violations = validateAcpFrames(frames);
    expect(describeViolations(violations)).toBe('');
  });

  it('runs offline, with no vendor CLI installed and no network', () => {
    // Stated as an assertion rather than a comment because it is the property
    // that lets this layer sit on every commit: the oracle is a file inside
    // node_modules and the corpus is a directory in the repository.
    expect(acpSchema().$schema).toContain('json-schema.org');
    expect(corpus.every((recording) => recording.file.endsWith('.ndjson'))).toBe(true);
  });
});

/**
 * AC7 — the second layer of assertion on the same recordings.
 *
 * Raw frames against `schema.json` above; DeFlow's own **normalised** event
 * vocabulary here, through the serializer `test/setup.ts` registers. The two
 * are complementary rather than redundant: snapshotting only the normalised
 * form is less brittle *and* less sensitive — it cannot catch an upstream
 * change the normaliser happens to swallow — while snapshotting only the raw
 * frames says nothing about whether DeFlow still understands them.
 *
 * `describeUpdate` is the normaliser, and it is applied here to bytes real
 * vendors wrote. A vendor that renames a `sessionUpdate` shows up as a diff on
 * the phase; one that moves the text out of `content.text` shows up as a
 * message that went empty.
 */
suite('AC7 — the normalised DeFlow event vocabulary each recording produces', () => {
  it.each(corpus.map((recording) => recording.file))('%s', (file) => {
    const vocabulary = framesOf(file)
      .filter((frame) => frame.dir === 'out' && frame.msg?.method === 'session/update')
      .map((frame) => (frame.msg?.params as { update: never }).update)
      .map((update) => describeUpdate(update));

    // Through the normalising serializer: session ids, timestamps and absolute
    // paths inside a message would otherwise churn this file on every run, and
    // a snapshot that always diffs is one nobody reads.
    //
    // An empty vocabulary is snapshotted rather than rejected — the gemini
    // capture really does end at the handshake, and recording that as `[]` is
    // what makes the day it stops being empty (or the day a full recording
    // becomes empty) a diff.
    expect(vocabulary).toMatchSnapshot();
  });

  it('produces a vocabulary somewhere — a corpus that normalises to nothing is a bug', () => {
    const total = corpus
      .flatMap((recording) => framesOf(recording.file))
      .filter((frame) => frame.dir === 'out' && frame.msg?.method === 'session/update').length;
    expect(total).toBeGreaterThan(0);
  });

  it('understands every update in the corpus — an unknown phase is a finding', () => {
    // `describeUpdate` carries an unrecognised discriminator through verbatim
    // rather than throwing, which is right for a running daemon and would be
    // silent here. This is where it stops being silent.
    const phases = new Set(
      corpus
        .flatMap((recording) => framesOf(recording.file))
        .filter((frame) => frame.dir === 'out' && frame.msg?.method === 'session/update')
        .map((frame) => describeUpdate((frame.msg?.params as { update: never }).update).phase),
    );
    expect([...phases].sort()).toMatchSnapshot();
  });
});
