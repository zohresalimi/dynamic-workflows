/**
 * KAR-27.3 AC3 — reading a pre-execution turn's tool calls out of its own
 * stdout.
 *
 * The failure this excludes is subtle and was the whole 2026-08-23 report in
 * miniature: a chunk is however many bytes the kernel handed the pipe, so a
 * frame carrying a tool call routinely spans two chunks. A reader that parsed
 * per chunk would show the short frames and silently drop the long ones — and
 * the long ones are the tool calls. The strip would then be *present* and
 * *empty*, which is worse than absent.
 *
 * Verifies: EPIC-27-S18 · AC3
 */
import { expect, it, describe as suite } from 'vitest';
import type { IoChunkLine } from './node-output.ts';
import { holdChunks, NO_ACTIVITY, turnActivity } from './turn-activity.ts';

const TS = 1_787_000_000_000;

const chunk = (seq: number, data: string, ts = TS + seq): IoChunkLine => ({
  seq,
  stream: 'stdout',
  ts,
  data,
});

const assistant = (blocks: readonly unknown[]): string =>
  `${JSON.stringify({ type: 'assistant', message: { content: blocks } })}\n`;

const toolUse = (name: string): unknown => ({
  type: 'tool_use',
  id: `tu_${name}`,
  name,
  input: {},
});

suite('turnActivity — the tool calls an operator wanted to see', () => {
  it('names each tool exactly as the frame spelled it', () => {
    const activity = turnActivity([
      chunk(1, assistant([toolUse('Read')])),
      chunk(2, assistant([toolUse('mcp__linear__list_issues')])),
    ]);

    expect(activity.toolCalls.map((call) => call.name)).toEqual([
      'Read',
      'mcp__linear__list_issues',
    ]);
  });

  it('reads a frame that spans two chunks, which is most of them', () => {
    const frame = assistant([toolUse('Grep')]);
    const split = Math.floor(frame.length / 2);

    const activity = turnActivity([chunk(1, frame.slice(0, split)), chunk(2, frame.slice(split))]);

    expect(activity.toolCalls.map((call) => call.name)).toEqual(['Grep']);
    // Attributed to the chunk it began in, so a link to it points at a row
    // that exists.
    expect(activity.toolCalls[0]?.seq).toBe(1);
  });

  it('reads two frames that share one chunk', () => {
    const activity = turnActivity([
      chunk(1, assistant([toolUse('Read')]) + assistant([toolUse('Bash')])),
    ]);

    expect(activity.toolCalls.map((call) => call.name)).toEqual(['Read', 'Bash']);
  });

  it('takes several calls out of one frame, in the order the agent made them', () => {
    const activity = turnActivity([
      chunk(1, assistant([toolUse('Read'), { type: 'text', text: 'and now' }, toolUse('Glob')])),
    ]);

    expect(activity.toolCalls.map((call) => call.name)).toEqual(['Read', 'Glob']);
  });

  it('skips a line that is not JSON rather than reporting a broken turn', () => {
    const activity = turnActivity([
      chunk(1, 'warning: something the vendor printed straight to the pipe\n'),
      chunk(2, assistant([toolUse('Read')])),
    ]);

    expect(activity.toolCalls.map((call) => call.name)).toEqual(['Read']);
  });

  it('ignores a tool_use block with no name rather than inventing one', () => {
    const activity = turnActivity([chunk(1, assistant([{ type: 'tool_use', id: 'tu_1' }]))]);

    expect(activity.toolCalls).toEqual([]);
  });

  it('ignores non-assistant frames, which are most of a transcript', () => {
    const activity = turnActivity([
      chunk(1, `${JSON.stringify({ type: 'system', subtype: 'init' })}\n`),
      chunk(2, `${JSON.stringify({ type: 'result', subtype: 'success' })}\n`),
    ]);

    expect(activity.toolCalls).toEqual([]);
  });

  it('leaves a half-arrived frame for the next poll rather than guessing at it', () => {
    const frame = assistant([toolUse('Read')]);

    expect(turnActivity([chunk(1, frame.slice(0, 20))]).toolCalls).toEqual([]);
  });
});

suite('turnActivity — the other two things the strip renders', () => {
  it('keeps the last thing the agent said in words', () => {
    const activity = turnActivity([
      chunk(1, assistant([{ type: 'text', text: 'Looking at the repository' }])),
      chunk(2, assistant([{ type: 'text', text: 'Checking Linear for the story' }])),
    ]);

    expect(activity.lastText).toBe('Checking Linear for the story');
  });

  it('reports when the last output arrived, and the cursor to follow from', () => {
    const activity = turnActivity([chunk(4, assistant([])), chunk(9, assistant([]))]);

    expect(activity.lastOutputTs).toBe(TS + 9);
    expect(activity.cursor).toBe(9);
  });

  it('answers nothing at all for a turn that has produced nothing yet', () => {
    expect(turnActivity([])).toEqual(NO_ACTIVITY);
  });
});

suite('holdChunks — the bounded window the strip keeps', () => {
  it('dedupes a re-delivered chunk instead of holding it twice', () => {
    const held = holdChunks([], [chunk(1, 'a'), chunk(2, 'b')], 10);

    expect(holdChunks(held, [chunk(2, 'b'), chunk(3, 'c')], 10).map((one) => one.seq)).toEqual([
      1, 2, 3,
    ]);
  });

  it('drops the oldest past the cap, so a long turn cannot grow the tab', () => {
    const many = Array.from({ length: 12 }, (_unused, index) => chunk(index + 1, 'x'));

    expect(holdChunks([], many, 5).map((one) => one.seq)).toEqual([8, 9, 10, 11, 12]);
  });
});
