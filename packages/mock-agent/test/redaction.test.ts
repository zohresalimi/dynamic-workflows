/**
 * The redactor every recording passes through before it reaches the disk.
 *
 * A recording is a transcript of a real session on somebody's laptop, and the
 * repository it lands in is public. Four kinds of local detail come along for
 * the ride and none of them is a secret, which is exactly why nobody notices
 * them: absolute paths under the developer's home, the temporary directory the
 * spike ran the agent in, the machine's installed slash commands (Claude Code
 * announces the lot in one `available_commands_update` frame), and the vendor's
 * own session and message ids.
 *
 * The rules below are written as *behaviour of the redactor*, not as facts
 * about today's committed files, because the point is that the next capture is
 * scrubbed too. Two properties matter as much as the removal itself:
 *
 *   - **Protocol shape survives.** `t`, `dir`, method names, key order, frame
 *     order and every field the replay compares are untouched. A redaction that
 *     reshaped frames would turn the goldens into fiction.
 *   - **Placeholders are deterministic.** Ids are numbered by order of first
 *     appearance, so redacting twice is the same as redacting once and a replay
 *     stays byte-identical run to run.
 */
import { expect, it, describe as suite } from 'vitest';
import type { Json, JsonObject } from '../src/recording.ts';
import {
  HOME_PLACEHOLDER,
  RecordingRedactor,
  redactRecording,
  TMPDIR_PLACEHOLDER,
} from '../src/redaction.ts';

const HOME = '/Users/somebody';
const TMP = '/var/folders/c3/pk78gyzj227f4s4h48grff0w0000gn/T';

const redactor = () => new RecordingRedactor({ home: HOME, tmpdir: TMP });

const line = (value: unknown): string => JSON.stringify(value);
const chunk = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
const decode = (b64: string): string => Buffer.from(b64, 'base64').toString('utf8');

interface CaptureLine {
  readonly t?: number;
  readonly dir?: string;
  readonly b64?: string;
  readonly msg?: JsonObject;
  readonly header?: JsonObject;
}

const parse = (text: string): CaptureLine[] =>
  text
    .split('\n')
    .filter((row) => row.trim() !== '')
    .map((row) => JSON.parse(row) as CaptureLine);

suite('absolute paths collapse to a placeholder', () => {
  it('replaces the home prefix and keeps the rest of the path', () => {
    expect(redactor().paths('/Users/somebody/projects/deflow/spikes/s1-acp/mcp-server.ts')).toBe(
      `${HOME_PLACEHOLDER}/projects/deflow/spikes/s1-acp/mcp-server.ts`,
    );
    expect(redactor().paths('/Users/somebody')).toBe(HOME_PLACEHOLDER);
  });

  it('replaces any other home directory too, because the next capture is not this machine', () => {
    // The recording that leaks is the one taken on the laptop nobody thought
    // about, so the rule cannot be "the home directory of whoever is running
    // the redactor".
    expect(redactor().paths('/Users/someone-else/.nvm/versions/node/v24.18.0/bin/node')).toBe(
      `${HOME_PLACEHOLDER}/.nvm/versions/node/v24.18.0/bin/node`,
    );
    expect(redactor().paths('/home/ci/work/repo')).toBe(`${HOME_PLACEHOLDER}/work/repo`);
  });

  it('replaces the capture temp dir, including the /private twin macOS reports', () => {
    // The agent resolves the same directory two ways in one session: the client
    // passes `/var/folders/…` as the session cwd and the tool call comes back
    // with `/private/var/folders/…`.
    expect(redactor().paths(`${TMP}/deflow-s1-claude-agent-acp-KxCs1r`)).toBe(
      `${TMPDIR_PLACEHOLDER}/deflow-s1-claude-agent-acp-KxCs1r`,
    );
    expect(redactor().paths(`/private${TMP}/deflow-s1-claude-agent-acp-KxCs1r/forbidden.txt`)).toBe(
      `${TMPDIR_PLACEHOLDER}/deflow-s1-claude-agent-acp-KxCs1r/forbidden.txt`,
    );
  });

  it('leaves a path that is neither home nor temp alone', () => {
    expect(redactor().paths('/usr/local/bin/node')).toBe('/usr/local/bin/node');
    expect(redactor().paths('packages/mock-agent/src/replay.ts')).toBe(
      'packages/mock-agent/src/replay.ts',
    );
  });

  it('redacts a path wherever it appears inside a frame, at any depth', () => {
    const frame = redactor().value({
      params: {
        cwd: `${TMP}/deflow-s1-gemini-cli-Xpmy9s`,
        mcpServers: [
          {
            command: `${HOME}/.nvm/versions/node/v24.18.0/bin/node`,
            args: [`${HOME}/projects/deflow/spikes/s1-acp/mcp-server.ts`],
          },
        ],
      },
    }) as JsonObject;

    expect(frame).toEqual({
      params: {
        cwd: `${TMPDIR_PLACEHOLDER}/deflow-s1-gemini-cli-Xpmy9s`,
        mcpServers: [
          {
            command: `${HOME_PLACEHOLDER}/.nvm/versions/node/v24.18.0/bin/node`,
            args: [`${HOME_PLACEHOLDER}/projects/deflow/spikes/s1-acp/mcp-server.ts`],
          },
        ],
      },
    });
  });
});

suite('the machine’s command inventory does not travel', () => {
  const update = (commands: Json): JsonObject => ({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId: 'a54d92c7-c390-4042-8a61-ada78417aad6',
      update: { sessionUpdate: 'available_commands_update', availableCommands: commands },
    },
  });

  it('empties availableCommands, keeping the frame itself', () => {
    // The frame stays because its arrival is part of the recorded cadence: a
    // replay that never sent it would be a different session.
    const redacted = redactor().value(
      update([
        { name: 'deep-research', description: 'a workflow nobody outside this laptop has' },
        { name: 'compact', description: 'Free up context', input: null },
      ]),
    ) as JsonObject;

    const params = redacted['params'] as JsonObject;
    const sessionUpdate = params['update'] as JsonObject;
    expect(sessionUpdate['sessionUpdate']).toBe('available_commands_update');
    expect(sessionUpdate['availableCommands']).toEqual([]);
    expect(JSON.stringify(redacted)).not.toContain('deep-research');
  });

  it('leaves an already-empty list alone', () => {
    const redacted = redactor().value(update([])) as JsonObject;
    const params = redacted['params'] as JsonObject;
    expect((params['update'] as JsonObject)['availableCommands']).toEqual([]);
  });
});

suite('ids become placeholders numbered by first appearance', () => {
  it('numbers session ids in the order the recording introduces them, stably', () => {
    const one = new RecordingRedactor({ home: HOME, tmpdir: TMP });
    const first = one.value({ result: { sessionId: 'a54d92c7-c390-4042-8a61-ada78417aad6' } });
    const again = one.value({ params: { sessionId: 'a54d92c7-c390-4042-8a61-ada78417aad6' } });
    const second = one.value({ result: { sessionId: 'e832feab-c8b3-4b93-be46-f959aec91a4d' } });

    const idOf = (value: Json, key: 'result' | 'params'): unknown =>
      ((value as JsonObject)[key] as JsonObject)['sessionId'];

    expect(idOf(first, 'result')).toBe('00000000-0000-4000-8000-000000000001');
    // The same id twice is the same placeholder, or the replay would answer a
    // frame that belongs to another session.
    expect(idOf(again, 'params')).toBe('00000000-0000-4000-8000-000000000001');
    expect(idOf(second, 'result')).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('keeps the session id a uuid, which is the shape a client parses', () => {
    const redacted = redactor().value({ sessionId: 'a54d92c7-c390-4042-8a61-ada78417aad6' });
    expect((redacted as JsonObject)['sessionId']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('numbers provider message ids the same way', () => {
    const one = redactor();
    const a = one.value({ update: { messageId: 'msg_011CdhuzNv6WJHYXDALD5i7N' } }) as JsonObject;
    const b = one.value({ update: { messageId: 'msg_011CdhuzNv6WJHYXDALD5i7N' } }) as JsonObject;
    const c = one.value({ update: { messageId: 'msg_011CdhuzeppAGsd7qfgEFBJg' } }) as JsonObject;

    expect((a['update'] as JsonObject)['messageId']).toBe('msg-1');
    expect((b['update'] as JsonObject)['messageId']).toBe('msg-1');
    expect((c['update'] as JsonObject)['messageId']).toBe('msg-2');
  });

  it('replaces an id that reappears inside some other string', () => {
    const one = redactor();
    one.value({ result: { sessionId: 'a54d92c7-c390-4042-8a61-ada78417aad6' } });
    const mentioned = one.value({
      text: 'session a54d92c7-c390-4042-8a61-ada78417aad6 was cancelled',
    }) as JsonObject;
    expect(mentioned['text']).toBe('session 00000000-0000-4000-8000-000000000001 was cancelled');
  });

  it('leaves every other id alone — the JSON-RPC id is what correlates a reply', () => {
    const redacted = redactor().value({
      jsonrpc: '2.0',
      id: 3,
      params: { toolCall: { toolCallId: 'toolu_012orqaSqTZd4XRpZaDKd2ca' } },
    }) as JsonObject;
    expect(redacted['id']).toBe(3);
    expect(((redacted['params'] as JsonObject)['toolCall'] as JsonObject)['toolCallId']).toBe(
      'toolu_012orqaSqTZd4XRpZaDKd2ca',
    );
  });
});

suite('everything the replay compares survives', () => {
  it('keeps key order, so a redacted frame is a diff of values and nothing else', () => {
    const original = line({
      jsonrpc: '2.0',
      id: 2,
      method: 'session/new',
      params: { cwd: `${TMP}/x`, mcpServers: [] },
    });
    expect(redactor().frame(original)).toBe(
      line({
        jsonrpc: '2.0',
        id: 2,
        method: 'session/new',
        params: { cwd: `${TMPDIR_PLACEHOLDER}/x`, mcpServers: [] },
      }),
    );
  });

  it('falls back to path redaction on a line that is not JSON at all', () => {
    // A truncated capture — a killed recorder, a crashed CLI — ends in half a
    // frame. Half a frame cannot be parsed, and it can still carry a path.
    expect(redactor().frame(`{"path":"${HOME}/projects/deflow`)).toBe(
      `{"path":"${HOME_PLACEHOLDER}/projects/deflow`,
    );
  });
});

suite('a raw transport capture is redacted chunk by chunk', () => {
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };

  it('redacts the frames a chunk completes and re-encodes them as one chunk', () => {
    // The real capture has a chunk carrying two notifications; splitting it
    // would rewrite the cadence the recording exists to preserve.
    const both = `${line({ a: `${HOME}/one` })}\n${line({ b: `${HOME}/two` })}\n`;
    const out = redactor().chunk('in', new TextEncoder().encode(both));
    expect(new TextDecoder().decode(out)).toBe(
      `${line({ a: `${HOME_PLACEHOLDER}/one` })}\n${line({ b: `${HOME_PLACEHOLDER}/two` })}\n`,
    );
  });

  it('holds a frame split across two chunks until the chunk that completes it', () => {
    const one = redactor();
    const whole = `${line(initialize)}\n`;
    const first = one.chunk('out', new TextEncoder().encode(whole.slice(0, 12)));
    const second = one.chunk('out', new TextEncoder().encode(whole.slice(12)));
    expect(first).toHaveLength(0);
    expect(new TextDecoder().decode(second)).toBe(whole);
  });

  it('keeps the two directions apart', () => {
    const one = redactor();
    one.chunk('in', new TextEncoder().encode('{"half":'));
    const out = one.chunk('out', new TextEncoder().encode(`${line(initialize)}\n`));
    expect(new TextDecoder().decode(out)).toBe(`${line(initialize)}\n`);
  });

  it('flushes a truncated trailing frame with its paths and command list gone', () => {
    const one = redactor();
    one.chunk(
      'in',
      new TextEncoder().encode(
        `{"cwd":"${HOME}/projects","availableCommands":[{"name":"deep-research"`,
      ),
    );
    const flushed = new TextDecoder().decode(one.flush('in'));
    expect(flushed).toContain(`${HOME_PLACEHOLDER}/projects`);
    expect(flushed).not.toContain('deep-research');
    expect(flushed).not.toContain('/Users/');
  });
});

suite('a whole recording file, in either of its two shapes', () => {
  const capture = [
    line({
      header: {
        agent: 'claude-agent-acp',
        version: '0.64.1',
        cwd: `${TMP}/deflow-s1-claude-agent-acp-KxCs1r`,
        frameCapBytes: 8388608,
      },
    }),
    line({ t: 0.072, dir: 'out', b64: chunk(`${line({ jsonrpc: '2.0', id: 1 })}\n`) }),
    line({
      t: 609.356,
      dir: 'in',
      b64: chunk(
        `${line({
          method: 'session/update',
          params: {
            sessionId: 'a54d92c7-c390-4042-8a61-ada78417aad6',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [{ name: 'compact' }],
            },
          },
        })}\n`,
      ),
    }),
  ].join('\n');

  it('redacts the header, the b64 frames and nothing else about the file', () => {
    const rows = parse(redactRecording(capture, { home: HOME, tmpdir: TMP }));

    expect(rows[0]?.header?.['cwd']).toBe(
      `${TMPDIR_PLACEHOLDER}/deflow-s1-claude-agent-acp-KxCs1r`,
    );
    // The measurement AC4 rests on is the receipt time of each chunk. It is
    // recorded, never recomputed.
    expect(rows.map((row) => row.t)).toEqual([undefined, 0.072, 609.356]);
    expect(rows.map((row) => row.dir)).toEqual([undefined, 'out', 'in']);
    expect(decode(rows[1]?.b64 ?? '')).toBe(`${line({ jsonrpc: '2.0', id: 1 })}\n`);

    const update = JSON.parse(decode(rows[2]?.b64 ?? '').trim()) as JsonObject;
    const params = update['params'] as JsonObject;
    expect(params['sessionId']).toBe('00000000-0000-4000-8000-000000000001');
    expect((params['update'] as JsonObject)['availableCommands']).toEqual([]);
  });

  it('redacts a replay recording, whose lines carry whole frames instead', () => {
    const replay = [
      line({ header: { agent: 'claude-agent-acp', derivedFrom: 'full-cycle.ndjson' } }),
      line({
        t: 1256.739,
        dir: 'out',
        msg: { jsonrpc: '2.0', id: 2, result: { sessionId: 'a54d92c7' } },
      }),
      line({
        t: 1257.206,
        dir: 'in',
        msg: { jsonrpc: '2.0', id: 3, params: { cwd: `${HOME}/projects/deflow` } },
      }),
    ].join('\n');

    const rows = parse(redactRecording(replay, { home: HOME, tmpdir: TMP }));
    expect(rows[1]?.msg?.['result']).toEqual({
      sessionId: '00000000-0000-4000-8000-000000000001',
    });
    expect(rows[2]?.msg?.['params']).toEqual({ cwd: `${HOME_PLACEHOLDER}/projects/deflow` });
    expect(rows[2]?.t).toBe(1257.206);
    expect(rows[1]?.msg?.['id']).toBe(2);
  });

  it('is idempotent, which is what lets it sit in both the capture and the replay path', () => {
    const once = redactRecording(capture, { home: HOME, tmpdir: TMP });
    expect(redactRecording(once, { home: HOME, tmpdir: TMP })).toBe(once);
  });
});
