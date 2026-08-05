/**
 * KAR-05.7 AC1, AC6 — the golden-recording tee, as a pure unit.
 *
 * Three claims live here because none of them needs a subprocess: the
 * directory key refuses anything that is not an exact version, the tee is off
 * unless `DeFlow_RECORD=1` says otherwise, and every line it writes has been
 * through the redactor. What the tee does to a *real* pipe — both directions,
 * stderr, the exit code, monotonic offsets — is
 * `test/integration/record-tee.test.ts`, because that claim is about a child
 * process and this one is not.
 *
 * Verifies: EPIC-05-S28 · AC1, AC6 · test plan #8
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, describe as suite } from 'vitest';
import { InvalidRecordingKey, RECORDING_DIR_SHAPE } from './failures.ts';
import {
  openTransportRecorder,
  RECORD_CASE_ENV,
  RECORD_DIR_ENV,
  RECORD_ENV,
  recordingDirName,
  redactRecordingText,
} from './recorder.ts';

const roots: string[] = [];

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'DeFlow-rec-'));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const header = {
  provider: 'some-agent-acp',
  version: '0.64.1',
  case: 'simple-edit',
  command: '/opt/bin/some-agent-acp',
  args: [] as readonly string[],
  cwd: '/workspace',
  frameCapBytes: 8 * 1024 * 1024,
};

suite('AC6 — the directory is keyed on the exact version', () => {
  it('joins the provider and the version with an @', () => {
    expect(recordingDirName('some-agent-acp', '0.64.1')).toBe('some-agent-acp@0.64.1');
    expect(recordingDirName('other-agent-cli', '0.53.1-rc.2')).toBe('other-agent-cli@0.53.1-rc.2');
  });

  it.each(['latest', 'v0.64.1', '0.64', '', 'DeFlow-mock-agent 0.0.0'])(
    'refuses the moving or unparsed version %o',
    (version) => {
      // The failure this rule prevents is silent: a vendor release under
      // "@latest" invalidates every golden in the directory in place, so the
      // diff a reviewer would have seen never exists.
      expect(() => recordingDirName('some-agent-acp', version)).toThrow(InvalidRecordingKey);
      expect(() => recordingDirName('some-agent-acp', version)).toThrow(RECORDING_DIR_SHAPE);
    },
  );

  it('refuses an empty provider, and says what the shape is', () => {
    expect(() => recordingDirName('', '0.64.1')).toThrow(RECORDING_DIR_SHAPE);
  });
});

suite('AC1 — the tee is off unless the environment turns it on', () => {
  it('returns null when DeFlow_RECORD is unset, empty or not 1', () => {
    for (const env of [{}, { [RECORD_ENV]: '' }, { [RECORD_ENV]: '0' }, { [RECORD_ENV]: 'no' }]) {
      expect(openTransportRecorder(env, header)).toBeNull();
    }
  });

  it('opens a file named <provider>@<version>/<case>.ndjson under the corpus root', () => {
    const root = scratch();
    const recorder = openTransportRecorder(
      { [RECORD_ENV]: '1', [RECORD_DIR_ENV]: root, [RECORD_CASE_ENV]: 'my-case' },
      header,
    );
    expect(recorder).not.toBeNull();
    recorder?.close();
    expect(recorder?.path).toBe(join(root, 'some-agent-acp@0.64.1', 'my-case.ndjson'));
    expect(readFileSync(recorder?.path ?? '', 'utf8')).toContain('"header"');
  });

  it('throws rather than writing into a directory with no exact version', () => {
    const root = scratch();
    expect(() =>
      openTransportRecorder(
        { [RECORD_ENV]: '1', [RECORD_DIR_ENV]: root },
        { ...header, version: 'latest' },
      ),
    ).toThrow(InvalidRecordingKey);
  });
});

suite('AC1 — every line is written through the redactor', () => {
  it('replaces the home directory, the temp directory and the username', () => {
    const text = redactRecordingText(
      '{"cwd":"/Users/ada/work","tmp":"/private/var/folders/aa/bb/T/x","who":"ada"}',
      { home: '/Users/ada', username: 'ada', tmpdir: '/var/folders/aa/bb/T' },
    );
    expect(text).not.toContain('/Users/ada');
    expect(text).not.toContain('/var/folders/aa/bb/T');
    expect(text).not.toMatch(/"ada"/);
    expect(text).toContain('<HOME>');
    expect(text).toContain('<TMPDIR>');
  });

  it('empties availableCommands, which enumerates the recording machine', () => {
    const text = redactRecordingText(
      '{"update":{"availableCommands":[{"name":"deploy"},{"name":"release"}]}}',
      { home: '/Users/ada', username: 'ada', tmpdir: '/tmp' },
    );
    expect(text).not.toContain('deploy');
    expect(text).toContain('"availableCommands":[]');
  });

  it('is idempotent, so a second pass over a scrubbed capture changes nothing', () => {
    const identity = { home: '/Users/ada', username: 'ada', tmpdir: '/var/folders/aa/bb/T' };
    const once = redactRecordingText('{"cwd":"/Users/ada/work"}', identity);
    expect(redactRecordingText(once, identity)).toBe(once);
  });

  it('applies to what the tee writes, not only to what a caller remembers to scrub', () => {
    const root = scratch();
    const recorder = openTransportRecorder(
      { [RECORD_ENV]: '1', [RECORD_DIR_ENV]: root, [RECORD_CASE_ENV]: 'redaction' },
      { ...header, cwd: '/Users/ada/work' },
      { identity: { home: '/Users/ada', username: 'ada', tmpdir: '/var/folders/aa/bb/T' }, now: 0 },
    );
    recorder?.note(
      'in',
      Buffer.from(
        '{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/Users/ada"}}\n',
      ),
    );
    recorder?.close();
    const written = readFileSync(recorder?.path ?? '', 'utf8');
    expect(written).not.toContain('/Users/ada');
    expect(written).toContain('<HOME>');
  });
});

suite('AC1 — one {"t","dir","msg"} object per line, agent-perspective', () => {
  it('writes what the client sent as "in" and what the agent wrote as "out"', () => {
    const root = scratch();
    let clock = 0;
    const recorder = openTransportRecorder(
      { [RECORD_ENV]: '1', [RECORD_DIR_ENV]: root, [RECORD_CASE_ENV]: 'directions' },
      header,
      { now: () => clock },
    );
    recorder?.note('in', Buffer.from('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n'));
    clock = 5;
    recorder?.note('out', Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'));
    recorder?.close();

    const lines = readFileSync(recorder?.path ?? '', 'utf8')
      .trim()
      .split('\n');
    const frames = lines.slice(1).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames.map((frame) => frame.dir)).toEqual(['in', 'out']);
    expect(frames.map((frame) => frame.t)).toEqual([0, 5]);
    expect(frames[0]?.msg).toEqual({ jsonrpc: '2.0', id: 1, method: 'initialize' });
  });

  it('holds a frame that spans two chunks until the newline arrives', () => {
    const root = scratch();
    const recorder = openTransportRecorder(
      { [RECORD_ENV]: '1', [RECORD_DIR_ENV]: root, [RECORD_CASE_ENV]: 'split' },
      header,
      { now: 0 },
    );
    recorder?.note('out', Buffer.from('{"jsonrpc":"2.0",'));
    recorder?.note('out', Buffer.from('"id":1,"result":{}}\n'));
    recorder?.close();

    const frames = readFileSync(recorder?.path ?? '', 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.msg).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });

  it('records a line the client could never parse rather than dropping it', () => {
    // The whole reason the tee is in the transport: an adapter-level tee only
    // ever records what the normaliser already understood, which is precisely
    // the class of change a conformance suite exists to detect.
    const root = scratch();
    const recorder = openTransportRecorder(
      { [RECORD_ENV]: '1', [RECORD_DIR_ENV]: root, [RECORD_CASE_ENV]: 'unparseable' },
      header,
      { now: 0 },
    );
    recorder?.note('out', Buffer.from('{"this is not json\n'));
    recorder?.close();

    const lines = readFileSync(recorder?.path ?? '', 'utf8')
      .trim()
      .split('\n')
      .slice(1);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toMatchObject({
      dir: 'out',
      raw: '{"this is not json',
    });
  });

  it('flushes a frame the session died in the middle of, and the exit beside it', () => {
    const root = scratch();
    const recorder = openTransportRecorder(
      { [RECORD_ENV]: '1', [RECORD_DIR_ENV]: root, [RECORD_CASE_ENV]: 'truncated' },
      header,
      { now: 0 },
    );
    recorder?.note('out', Buffer.from('{"jsonrpc":"2.0","id":1,"res'));
    recorder?.stderr(Buffer.from('panic: boom\n'));
    recorder?.exit({ code: 1, signal: null });
    recorder?.close();

    const lines = readFileSync(recorder?.path ?? '', 'utf8')
      .trim()
      .split('\n')
      .slice(1)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.some((line) => line.stderr === 'panic: boom\n')).toBe(true);
    expect(lines.some((line) => JSON.stringify(line.exit) === '{"code":1,"signal":null}')).toBe(
      true,
    );
    expect(lines.some((line) => line.raw === '{"jsonrpc":"2.0","id":1,"res')).toBe(true);
  });
});
