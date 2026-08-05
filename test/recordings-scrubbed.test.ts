/**
 * Nothing under `recordings/` says whose laptop it came off.
 *
 * The goldens are transcripts of real, authenticated vendor sessions, and this
 * repository is public. What travels with them is not a credential — absolute
 * paths under a home directory, the temp dir the session ran in, the machine's
 * installed slash commands, the vendor's session ids — which is exactly why it
 * survives review: there is nothing to notice unless something is looking.
 *
 * `packages/mock-agent/src/redaction.ts` is what removes it, in both paths that
 * write a recording (the spike's transport tee and the capture-to-replay
 * converter). This file is the backstop that says one of them was bypassed —
 * by a hand-edited file, a recording carried in from elsewhere, or a capture
 * taken with a tee that forgot.
 *
 * The scan reads *through* base64: a raw capture stores its frames as `b64`
 * chunks, so a grep over the file finds nothing and proves nothing.
 */
import { homedir, tmpdir, userInfo } from 'node:os';
import { expect, it, describe as suite } from 'vitest';
import {
  checkRecordingsAreScrubbed,
  type RecordingIdentity,
  describe as render,
  type SourceFile,
} from './support/guards.ts';
import { readSources, walk } from './support/workspace.ts';

const RECORDINGS = 'recordings';

const identity: RecordingIdentity = {
  home: homedir(),
  username: userInfo().username,
  tmpdir: tmpdir(),
};

/** A machine that is not this one, so the fixtures below hold on any host. */
const other: RecordingIdentity = {
  home: '/Users/somebody',
  username: 'somebody',
  tmpdir: '/var/folders/aa/bb/T',
};

const recordings = readSources(walk(RECORDINGS, () => true));

const capture = (frame: string): SourceFile => ({
  path: 'recordings/vendor@1.0.0/full-cycle.ndjson',
  text: `${JSON.stringify({
    t: 1,
    dir: 'in',
    b64: Buffer.from(`${frame}\n`, 'utf8').toString('base64'),
  })}\n`,
});

suite('the committed recordings carry no local detail', () => {
  it('scans every file in the directory, and there is a directory to scan', () => {
    // A guard whose input is empty passes for ever. Four files were committed
    // by the S1 spike; the count only ever goes up.
    expect(recordings.length).toBeGreaterThanOrEqual(4);
    expect(recordings.some((file) => file.path.endsWith('.ndjson'))).toBe(true);
  });

  it('finds no home path, no username, no temp dir and no command list', () => {
    expect(render(checkRecordingsAreScrubbed(recordings, identity))).toBe('');
  });

  it('and that verdict is about the frames, not about the base64 around them', () => {
    // The paths were there — they are placeholders now. If the scan stopped at
    // the file's own text it would report the same clean result for a capture
    // that still had them, so the evidence that it decoded anything is that the
    // redactor's placeholders are what it would have read.
    const decoded = readSources(walk(RECORDINGS, (path) => path.endsWith('.ndjson')))
      .flatMap((file) => file.text.split('\n'))
      .filter((line) => line.includes('"b64"'))
      .map((line) => Buffer.from(JSON.parse(line).b64 as string, 'base64').toString('utf8'))
      .join('\n');
    expect(decoded).toContain('<HOME>/');
    expect(decoded).toContain('<TMPDIR>/');
  });
});

suite('the guard bites', () => {
  it('reports a home-directory path, whoever it belongs to', () => {
    // Not the home of the machine running the check: the recording that leaks
    // is the one taken on the laptop nobody thought about.
    const violations = checkRecordingsAreScrubbed(
      [
        {
          path: 'recordings/vendor@1.0.0/case.ndjson',
          text: '{"t":0,"dir":"in","msg":{"params":{"cwd":"/Users/someone-else/projects/deflow"}}}',
        },
      ],
      other,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('/Users/someone-else');
  });

  it('reports a home directory that lives nowhere the pattern would guess', () => {
    // The username is deliberately not a substring of the home path: the rules
    // are independent, and a fixture where one name hides inside the other
    // would pass whichever rule happened to survive.
    const violations = checkRecordingsAreScrubbed(
      [{ path: 'recordings/vendor@1.0.0/case.ndjson', text: '"cwd":"/opt/dev/projects/deflow"' }],
      { home: '/opt/dev', username: 'ci-runner', tmpdir: '/tmp' },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('/opt/dev');
  });

  it('reports one hidden inside a base64 chunk, which is where they actually hide', () => {
    const violations = checkRecordingsAreScrubbed(
      [
        capture(
          '{"params":{"command":"/Users/someone-else/.nvm/versions/node/v24.18.0/bin/node"}}',
        ),
      ],
      other,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('/Users/someone-else');
  });

  it('reports the literal username on its own', () => {
    const violations = checkRecordingsAreScrubbed(
      [{ path: 'recordings/vendor@1.0.0/notes.txt', text: 'captured by somebody at 15:05\n' }],
      other,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('somebody');
  });

  it('reports the capture temp dir, in both spellings macOS uses', () => {
    for (const path of [
      '/var/folders/c3/pk78gyzj227f4s4h48grff0w0000gn/T/deflow-s1',
      '/private/var/folders/c3/pk78gyzj227f4s4h48grff0w0000gn/T/deflow-s1/forbidden.txt',
    ]) {
      const violations = checkRecordingsAreScrubbed(
        [capture(JSON.stringify({ params: { cwd: path } }))],
        other,
      );
      expect(violations.length).toBeGreaterThanOrEqual(1);
      expect(violations.map((violation) => violation.message).join('\n')).toContain(
        '/var/folders/',
      );
    }
  });

  it('reports an availableCommands entry, and accepts the empty list', () => {
    const listed = capture(
      JSON.stringify({
        params: {
          update: {
            sessionUpdate: 'available_commands_update',
            availableCommands: [{ name: 'deep-research', description: 'a private workflow' }],
          },
        },
      }),
    );
    expect(checkRecordingsAreScrubbed([listed], other)).toHaveLength(1);
    expect(checkRecordingsAreScrubbed([listed], other)[0]?.message).toContain('availableCommands');

    const emptied = capture(
      JSON.stringify({
        params: {
          update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
        },
      }),
    );
    expect(checkRecordingsAreScrubbed([emptied], other)).toEqual([]);
  });

  it('names the file it found the leak in, because that is what has to be re-scrubbed', () => {
    const violations = checkRecordingsAreScrubbed(
      [{ path: 'recordings/vendor@1.0.0/case.ndjson', text: '/home/ci/work' }],
      other,
    );
    expect(violations[0]?.where).toBe('recordings/vendor@1.0.0/case.ndjson');
    expect(violations[0]?.message).toContain('redaction.ts');
  });
});
