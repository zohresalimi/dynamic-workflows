/**
 * KAR-04.5 — the recording format itself: the directory key, the ndjson line
 * shape, and the comparator that decides whether a client frame matches.
 *
 * The comparator is the piece with a real failure mode. A naive `deepEqual`
 * makes every replay fail on the first JSON-RPC `id`, and the obvious
 * over-correction — comparing only `method` — makes a replay green against a
 * client that sent a completely different prompt. `id` and `_meta` are the
 * only two fields a client is entitled to differ on
 * (docs/07-provider-adapter-layer.md §11.4), and that is exactly the line the
 * tests below draw.
 *
 * Verifies: EPIC-04-S15, EPIC-04-S16 · AC2, AC4 · test plan row 2
 */
import { expect, it, describe as suite } from 'vitest';
import {
  frameDiff,
  framesEqual,
  fromTransportCapture,
  type JsonObject,
  parseRecording,
  parseRecordingKey,
  RECORDING_DIR_SHAPE,
} from '../src/recording.ts';

function key(name: string) {
  const parsed = parseRecordingKey(name);
  if (!parsed.ok) throw new Error(`expected a key, got: ${parsed.message}`);
  return parsed.key;
}

function keyFailure(name: string): string {
  const parsed = parseRecordingKey(name);
  if (parsed.ok) throw new Error(`expected a rejection, got: ${JSON.stringify(parsed.key)}`);
  return parsed.message;
}

function recording(text: string) {
  const parsed = parseRecording(text, 'a.ndjson');
  if (!parsed.ok) throw new Error(`expected a recording, got: ${parsed.message}`);
  return parsed;
}

function recordingFailure(text: string): string {
  const parsed = parseRecording(text, 'a.ndjson');
  if (parsed.ok) throw new Error(`expected a rejection, got ${parsed.frames.length} frames`);
  return parsed.message;
}

const line = (value: unknown): string => JSON.stringify(value);

suite('AC4 — the directory name is the version key', () => {
  it('reads <provider>@<version> apart', () => {
    expect(key('claude-agent-acp@0.64.1')).toEqual({
      provider: 'claude-agent-acp',
      version: '0.64.1',
    });
    expect(key('gemini-cli@0.53.1')).toEqual({ provider: 'gemini-cli', version: '0.53.1' });
  });

  it('accepts a prerelease version, because vendors ship them', () => {
    expect(key('codex@1.0.0-rc.1').version).toBe('1.0.0-rc.1');
  });

  it('rejects a directory with no version at all, naming the expected shape', () => {
    const message = keyFailure('claude-agent-acp');
    expect(message).toContain(RECORDING_DIR_SHAPE);
    expect(message).toContain('claude-agent-acp');
  });

  it('rejects a moving tag, which is the whole point of keying on the version', () => {
    // "@latest" is the exact rot this rule exists to prevent: a golden keyed on
    // a moving tag is silently invalidated by a vendor release instead of
    // producing a new directory in a pull request.
    expect(keyFailure('claude-agent-acp@latest')).toContain(RECORDING_DIR_SHAPE);
  });

  it('rejects an empty provider or an empty version', () => {
    expect(keyFailure('@0.64.1')).toContain(RECORDING_DIR_SHAPE);
    expect(keyFailure('claude-agent-acp@')).toContain(RECORDING_DIR_SHAPE);
  });
});

suite('the ndjson line shape', () => {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: 1 },
  };

  it('reads header, direction, offset and message, keeping the file line number', () => {
    const parsed = recording(
      [
        line({ header: { agent: 'claude-agent-acp', version: '0.64.1' } }),
        line({ t: 0, dir: 'in', msg: initialize }),
        '',
        line({ t: 12.5, dir: 'out', msg: { jsonrpc: '2.0', id: 1, result: {} } }),
      ].join('\n'),
    );

    expect(parsed.header).toEqual({ agent: 'claude-agent-acp', version: '0.64.1' });
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[0]).toMatchObject({ line: 2, t: 0, dir: 'in' });
    // Line 4, not 3: a blank line still occupies a line in the file, and the
    // number in a mismatch message has to be the one an editor jumps to.
    expect(parsed.frames[1]).toMatchObject({ line: 4, t: 12.5, dir: 'out' });
  });

  it('rejects a line that is not a JSON object, naming the line number', () => {
    expect(recordingFailure(`${line({ t: 0, dir: 'in', msg: initialize })}\nnot json`)).toContain(
      'line 2',
    );
    expect(recordingFailure(line([1, 2, 3]))).toContain('line 1');
  });

  it('rejects an unknown direction', () => {
    const message = recordingFailure(line({ t: 0, dir: 'sideways', msg: initialize }));
    expect(message).toContain('line 1');
    expect(message).toContain('sideways');
  });

  it('rejects a frame with no msg', () => {
    expect(recordingFailure(line({ t: 0, dir: 'in' }))).toContain('msg');
  });

  it('rejects a raw transport capture, and says how to convert it', () => {
    // The captures under recordings/ that a spike produced hold base64 chunks,
    // not parsed frames. Replaying one directly would fail on every line; the
    // message has to point at the converter rather than at the format.
    const message = recordingFailure(line({ t: 0, dir: 'in', b64: 'e30K' }));
    expect(message).toContain('b64');
    expect(message).toContain('capture-to-replay');
  });

  it('rejects a recording whose first frame is outbound', () => {
    // A capture taken on the client side labels directions the other way
    // round, and the two files are otherwise indistinguishable. In ACP the
    // client always speaks first, so an agent-relative recording always opens
    // with an inbound frame — replaying a client-relative one would compare
    // the agent's own frames against the client's.
    const message = recordingFailure(line({ t: 0, dir: 'out', msg: initialize }));
    expect(message).toMatch(/perspective|client/i);
  });

  it('rejects a recording with no frames at all', () => {
    expect(recordingFailure(line({ header: { agent: 'x' } }))).toMatch(/no frames|empty/i);
  });
});

suite('AC2 — frames compare modulo JSON-RPC id and _meta', () => {
  const recorded: JsonObject = {
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: {
      sessionId: 'a54d92c7',
      prompt: [{ type: 'text', text: 'Create a file named forbidden.txt' }],
      _meta: { recordedBy: 'spike-s1' },
    },
    _meta: { clientInfo: 'spike' },
  };

  it('treats two frames differing only in id and _meta as equal', () => {
    const actual: JsonObject = {
      jsonrpc: '2.0',
      id: 91,
      method: 'session/prompt',
      params: {
        sessionId: 'a54d92c7',
        prompt: [{ type: 'text', text: 'Create a file named forbidden.txt' }],
        _meta: { somethingElse: true },
      },
      _meta: { clientInfo: 'DeFlowd/0.0.0' },
    };
    expect(framesEqual(recorded, actual)).toBe(true);
  });

  it('treats a missing _meta as equal to a present one', () => {
    const actual: JsonObject = {
      jsonrpc: '2.0',
      id: 91,
      method: 'session/prompt',
      params: {
        sessionId: 'a54d92c7',
        prompt: [{ type: 'text', text: 'Create a file named forbidden.txt' }],
      },
    };
    expect(framesEqual(recorded, actual)).toBe(true);
  });

  it('does not care about key order', () => {
    expect(
      framesEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 } as JsonObject),
    ).toBe(true);
  });

  it('treats two frames differing in params.sessionId as unequal', () => {
    const actual = JSON.parse(JSON.stringify(recorded)) as JsonObject;
    (actual['params'] as JsonObject)['sessionId'] = 'deadbeef';
    expect(framesEqual(recorded, actual)).toBe(false);
  });

  it('treats a different prompt text as unequal', () => {
    const actual = JSON.parse(JSON.stringify(recorded)) as JsonObject;
    (actual['params'] as JsonObject)['prompt'] = [{ type: 'text', text: 'rm -rf /' }];
    expect(framesEqual(recorded, actual)).toBe(false);
  });

  it('treats a different method as unequal', () => {
    const actual = JSON.parse(JSON.stringify(recorded)) as JsonObject;
    actual['method'] = 'session/cancel';
    expect(framesEqual(recorded, actual)).toBe(false);
  });

  it('does not strip an id nested inside params, which is a real field', () => {
    // `id` is only volatile at the top level. A plan entry's id, a toolCallId,
    // an MCP server id — all of those are content.
    expect(framesEqual({ params: { id: 'a' } }, { params: { id: 'b' } })).toBe(false);
  });
});

suite('AC2 — a mismatch prints a unified diff', () => {
  it('shows the differing lines with - and + markers', () => {
    const diff = frameDiff(
      { jsonrpc: '2.0', method: 'session/prompt', params: { text: 'hello' } },
      { jsonrpc: '2.0', method: 'session/prompt', params: { text: 'goodbye' } },
    );
    expect(diff).toContain('--- recorded');
    expect(diff).toContain('+++ received');
    expect(diff).toContain('-');
    expect(diff).toContain('hello');
    expect(diff).toContain('goodbye');
    expect(diff.split('\n').some((row) => row.startsWith('-') && row.includes('hello'))).toBe(true);
    expect(diff.split('\n').some((row) => row.startsWith('+') && row.includes('goodbye'))).toBe(
      true,
    );
  });

  it('does not report the volatile fields as differences', () => {
    const diff = frameDiff(
      { id: 1, method: 'session/prompt', _meta: { a: 1 } },
      { id: 99, method: 'session/cancel', _meta: { b: 2 } },
    );
    expect(diff).not.toContain('_meta');
    expect(diff).not.toContain('99');
  });
});

suite('converting a raw transport capture into a replay recording', () => {
  const chunk = (text: string): string => Buffer.from(text, 'utf8').toString('base64');
  const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} };
  const response = { jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } };

  it('flips the client-relative directions and decodes the frames', () => {
    // The capture is written from the client's side: "out" is what the client
    // wrote *to* the agent. Replay serves the agent's side, so the two labels
    // swap — and the resulting file starts, as every ACP session does, with an
    // inbound frame.
    const converted = fromTransportCapture(
      [
        line({ header: { agent: 'claude-agent-acp', version: '0.64.1' } }),
        line({ t: 0.1, dir: 'out', b64: chunk(`${line(initialize)}\n`) }),
        line({ t: 9.5, dir: 'in', b64: chunk(`${line(response)}\n`) }),
      ].join('\n'),
      { derivedFrom: 'full-cycle.ndjson' },
    );

    const parsed = recording(converted);
    expect(parsed.frames.map((frame) => frame.dir)).toEqual(['in', 'out']);
    expect(parsed.frames[0]?.msg).toEqual(initialize);
    expect(parsed.frames[1]?.msg).toEqual(response);
    expect(parsed.frames[1]?.t).toBe(9.5);
    expect(parsed.header?.['derivedFrom']).toBe('full-cycle.ndjson');
  });

  it('splits a chunk that carried more than one frame', () => {
    // A transport tee records chunks, not frames, and the real capture has at
    // least one chunk holding two notifications.
    const converted = fromTransportCapture(
      [
        line({ t: 0, dir: 'out', b64: chunk(`${line(initialize)}\n`) }),
        line({ t: 1, dir: 'in', b64: chunk(`${line(response)}\n${line({ a: 1 })}\n`) }),
      ].join('\n'),
    );
    expect(recording(converted).frames).toHaveLength(3);
  });

  it('reassembles a frame split across two chunks', () => {
    const whole = `${line(response)}\n`;
    const converted = fromTransportCapture(
      [
        line({ t: 0, dir: 'out', b64: chunk(`${line(initialize)}\n`) }),
        line({ t: 1, dir: 'in', b64: chunk(whole.slice(0, 12)) }),
        line({ t: 2, dir: 'in', b64: chunk(whole.slice(12)) }),
      ].join('\n'),
    );
    const parsed = recording(converted);
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.frames[1]?.msg).toEqual(response);
    // The frame's time is when its terminating newline arrived, which is the
    // earliest moment the other side could have acted on it.
    expect(parsed.frames[1]?.t).toBe(2);
  });

  it('keeps only the first n frames when asked, so a case can be a prefix', () => {
    const converted = fromTransportCapture(
      [
        line({ t: 0, dir: 'out', b64: chunk(`${line(initialize)}\n`) }),
        line({ t: 1, dir: 'in', b64: chunk(`${line(response)}\n`) }),
        line({ t: 2, dir: 'in', b64: chunk(`${line({ a: 1 })}\n`) }),
      ].join('\n'),
      { frameLimit: 2 },
    );
    expect(recording(converted).frames).toHaveLength(2);
  });
});
