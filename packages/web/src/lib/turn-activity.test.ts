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
import {
  ARGUMENT_LIMIT,
  holdChunks,
  NO_ACTIVITY,
  type TurnToolRow,
  turnActivity,
} from './turn-activity.ts';

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

/** A `tool_use` block with the input the vendor actually sent. */
const called = (name: string, input: Record<string, unknown>, id = `tu_${name}`): unknown => ({
  type: 'tool_use',
  id,
  name,
  input,
});

/** A `user` frame — the shape a `tool_result` arrives in. */
const answer = (blocks: readonly unknown[]): string =>
  `${JSON.stringify({ type: 'user', message: { content: blocks } })}\n`;

const toolResult = (block: Record<string, unknown>): unknown => ({
  type: 'tool_result',
  ...block,
});

const toolRows = (events: readonly { readonly kind: string }[]): TurnToolRow[] =>
  events.filter((event): event is TurnToolRow => event.kind === 'tool');

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

/**
 * KAR-28.1 — the feed's rows: one per event, oldest first, the vendor's bytes.
 *
 * Verifies: EPIC-28-S01, EPIC-28-S02, EPIC-28-S03, EPIC-28-S06 · AC2–AC5
 */
suite('EPIC-28-S01 — a tool call names what it acted on', () => {
  it('renders the identifying argument beside the name, as the frame spelled it', () => {
    const events = turnActivity([
      chunk(1, assistant([called('Read', { file_path: 'src/api.ts' })])),
      chunk(2, assistant([called('Bash', { command: 'pnpm test', description: 'Run the suite' })])),
      chunk(3, assistant([called('mcp__linear__get_issue', { id: 'MET-1013' })])),
    ]).events;

    expect(toolRows(events).map((row) => [row.name, row.target])).toEqual([
      ['Read', 'src/api.ts'],
      ['Bash', 'pnpm test'],
      ['mcp__linear__get_issue', 'MET-1013'],
    ]);
  });

  it('truncates a long argument for width rather than re-wording it', () => {
    const command = `pnpm vitest run ${'a/very/long/path.test.ts '.repeat(40)}`;

    const [row] = toolRows(
      turnActivity([chunk(1, assistant([called('Bash', { command })]))]).events,
    );

    expect(row?.target).toHaveLength(ARGUMENT_LIMIT);
    expect(row?.target?.endsWith('…')).toBe(true);
    // The kept part is the frame's own bytes, unaltered.
    expect(command.startsWith((row?.target ?? '').slice(0, -1))).toBe(true);
  });

  it('leaves the argument absent rather than inventing one for a call with no input', () => {
    const events = turnActivity([chunk(1, assistant([called('TodoWrite', {})]))]).events;

    expect(toolRows(events)[0]?.target).toBeNull();
  });

  it('ignores a non-string argument rather than stringifying an object at the operator', () => {
    const events = turnActivity([
      chunk(1, assistant([called('Task', { subagent_type: { deep: true } })])),
    ]).events;

    expect(toolRows(events)[0]?.target).toBeNull();
  });
});

suite("EPIC-28-S02 — a tool call's result is folded into its row", () => {
  it("carries the vendor's own summary and reads success as success", () => {
    const events = turnActivity([
      chunk(1, assistant([called('Read', { file_path: 'src/api.ts' }, 'tu_1')])),
      chunk(
        2,
        answer([toolResult({ tool_use_id: 'tu_1', content: '     1\texport const a = 1' })]),
      ),
    ]).events;

    expect(toolRows(events)[0]?.result).toEqual({
      ok: true,
      summary: '1\texport const a = 1',
    });
  });

  it('reads a failure as a failure, still in the vendor’s own words', () => {
    const events = turnActivity([
      chunk(1, assistant([called('Bash', { command: 'pnpm lint' }, 'tu_2')])),
      chunk(
        2,
        answer([
          toolResult({
            tool_use_id: 'tu_2',
            is_error: true,
            content: [{ type: 'text', text: 'exit code 1' }],
          }),
        ]),
      ),
    ]).events;

    expect(toolRows(events)[0]?.result).toEqual({ ok: false, summary: 'exit code 1' });
  });

  it('shows the call alone when the result cannot be read, and reports no error', () => {
    const activity = turnActivity([
      chunk(1, assistant([called('Read', { file_path: 'a.ts' }, 'tu_3')])),
      // No `tool_use_id`: nothing here can be attached to a call without guessing.
      chunk(2, answer([toolResult({ content: 'something' })])),
      // A shape this build has no reading for: an id and nothing legible.
      chunk(3, answer([toolResult({ tool_use_id: 'tu_3', content: [{ type: 'image' }] })])),
    ]).events;

    expect(toolRows(activity)).toHaveLength(1);
    expect(toolRows(activity)[0]?.result).toBeNull();
    // Nothing anywhere turned the unreadable frames into an error row.
    expect(activity.map((event) => event.kind)).toEqual(['tool']);
  });

  it('attaches each result to the call it answers, not to the newest one', () => {
    const events = turnActivity([
      chunk(1, assistant([called('Read', { file_path: 'a.ts' }, 'tu_a')])),
      chunk(2, assistant([called('Read', { file_path: 'b.ts' }, 'tu_b')])),
      chunk(3, answer([toolResult({ tool_use_id: 'tu_b', content: 'b read' })])),
      chunk(4, answer([toolResult({ tool_use_id: 'tu_a', content: 'a read' })])),
    ]).events;

    expect(toolRows(events).map((row) => row.result?.summary)).toEqual(['a read', 'b read']);
  });
});

suite("EPIC-28-S03 — the agent's own words are on screen", () => {
  it('renders text between two calls as its own row, in the order it was emitted', () => {
    const events = turnActivity([
      chunk(1, assistant([{ type: 'text', text: 'Reading the repository' }])),
      chunk(2, assistant([called('Read', { file_path: 'src/api.ts' })])),
      chunk(3, assistant([{ type: 'text', text: 'Now checking Linear' }])),
      chunk(4, assistant([called('mcp__linear__get_issue', { id: 'MET-1013' })])),
    ]).events;

    expect(events.map((event) => event.kind)).toEqual(['text', 'tool', 'text', 'tool']);
    expect(events.flatMap((event) => (event.kind === 'text' ? [event.text] : []))).toEqual([
      'Reading the repository',
      'Now checking Linear',
    ]);
  });

  it('gives every row a key of its own, so a list can be drawn from them', () => {
    const events = turnActivity([
      chunk(1, assistant([called('Read', { file_path: 'a.ts' }), { type: 'text', text: 'done' }])),
    ]).events;

    expect(new Set(events.map((event) => event.key)).size).toBe(events.length);
    expect(events).toHaveLength(2);
  });
});

suite('EPIC-28-S06 — an unreadable frame makes the feed quieter, never broken', () => {
  it('skips a block in a dialect this build cannot read and keeps its neighbours', () => {
    const events = turnActivity([
      chunk(1, assistant([called('Read', { file_path: 'a.ts' })])),
      chunk(2, assistant([{ type: 'thinking', thinking: 'a dialect nothing here parses' }])),
      chunk(3, `${JSON.stringify({ type: 'stream_event', event: { kind: 'unknown' } })}\n`),
      chunk(4, assistant([called('Bash', { command: 'pnpm test' })])),
    ]).events;

    expect(events.map((event) => event.kind)).toEqual(['tool', 'tool']);
    expect(toolRows(events).map((row) => row.name)).toEqual(['Read', 'Bash']);
  });

  it('drops whitespace-only prose rather than drawing an empty row', () => {
    const events = turnActivity([chunk(1, assistant([{ type: 'text', text: '   \n  ' }]))]).events;

    expect(events).toEqual([]);
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
