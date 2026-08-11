/**
 * KAR-17.5 test plan row 7 — an ACP node renders typed message components, not
 * a terminal.
 *
 * Verifies: EPIC-17-S21 (scenarios 1, 2 and 3) · AC1
 *
 * The row's red is *"everything was routed through xterm for uniformity"*, and
 * uniformity is exactly how that decision gets made — one renderer is simpler
 * than two. What it costs is everything the frames already were: a `tool_call`
 * with an id and a status becomes a line of text nobody can select, link to,
 * search or theme. So the assertion is **both halves**: typed components are
 * present *and* no `Terminal` was constructed, because a list rendered beside a
 * hidden terminal would satisfy the first alone.
 *
 * Virtualisation is asserted by counting the DOM against the data. A list that
 * renders 2,000 `<article>`s looks identical in a screenshot and is the
 * difference between a panel and a stalled tab.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import type { AcpMessage } from '../../lib/acp-stream.ts';
import { forgetTerminalSnapshots, liveTerminalCount } from '../../lib/terminal-session.ts';
import AgentMessageList from './AgentMessageList.vue';

const open: { unmount: () => void }[] = [];

afterEach(() => {
  for (const screen of open.splice(0)) screen.unmount();
  forgetTerminalSnapshots();
});

function mount(messages: readonly AcpMessage[], selectedSeq: number | null = null) {
  const screen = render(AgentMessageList, { props: { messages, selectedSeq } });
  open.push(screen);
  return screen;
}

const message = (over: Partial<AcpMessage> & Pick<AcpMessage, 'seq' | 'kind'>): AcpMessage => ({
  title: over.kind,
  text: '',
  toolCallId: null,
  status: null,
  ...over,
});

/** One of each type AC1 names, which is the list the row is about. */
const FOUR: readonly AcpMessage[] = [
  message({ seq: 101, kind: 'agent_message_chunk', text: "I'll create that file." }),
  message({
    seq: 105,
    kind: 'tool_call',
    title: 'Write',
    toolCallId: 'toolu_012orqaSqTZd4XRpZaDKd2ca',
    status: 'pending',
  }),
  message({
    seq: 106,
    kind: 'tool_call_update',
    title: 'Write forbidden.txt',
    toolCallId: 'toolu_012orqaSqTZd4XRpZaDKd2ca',
    status: 'failed',
    text: 'EACCES: permission denied',
  }),
  message({ seq: 110, kind: 'plan', title: 'plan', text: '[in_progress] fix the reducer' }),
];

/**
 * Waits for the virtualiser to have measured the scroll element.
 *
 * A poll rather than two animation frames, and that is a fact about the thing
 * under test rather than flake insurance: the window a virtualiser renders is a
 * function of the viewport's *measured* height, which arrives on a
 * `ResizeObserver` callback. Before it does, the correct number of rows is
 * genuinely zero.
 */
const rowsReady = async (screen: { container: HTMLElement }): Promise<void> => {
  await expect
    .poll(() => screen.container.querySelectorAll('[data-acp-message]').length)
    .toBeGreaterThan(0);
};

suite('EPIC-17-S21 — the list, and the terminal that is not there', () => {
  it('renders one typed component per message, tagged with its ACP kind', async () => {
    const screen = mount(FOUR);
    await rowsReady(screen);

    const rows = [...screen.container.querySelectorAll('[data-acp-message]')];
    expect(rows.map((row) => row.getAttribute('data-kind'))).toEqual([
      'agent_message_chunk',
      'tool_call',
      'tool_call_update',
      'plan',
    ]);
  });

  it('constructs no Terminal at all — this is not a TTY byte stream', async () => {
    const screen = mount(FOUR);
    await rowsReady(screen);

    expect(liveTerminalCount()).toBe(0);
    expect(document.querySelector('.xterm')).toBeNull();
  });

  it('links every message to its seq, so a position is shareable', async () => {
    const screen = mount(FOUR);
    await rowsReady(screen);

    const links = [...screen.container.querySelectorAll('[data-permalink]')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      '#seq-101',
      '#seq-105',
      '#seq-106',
      '#seq-110',
    ]);
    // The id the link points at has to exist, or the link is decoration.
    for (const seq of [101, 105, 106, 110]) {
      expect(screen.container.querySelector(`#seq-${seq}`)).not.toBeNull();
    }
  });

  it('makes each message individually selectable, and says which one is selected', async () => {
    const screen = mount(FOUR, 105);
    await rowsReady(screen);

    const rows = [...screen.container.querySelectorAll<HTMLElement>('[data-acp-message]')];
    expect(rows.map((row) => row.getAttribute('aria-selected'))).toEqual([
      'false',
      'true',
      'false',
      'false',
    ]);

    rows[2]?.click();

    expect(screen.emitted('select')).toEqual([[106]]);
  });

  it('shows a tool call’s identity and status, not only its prose', async () => {
    const screen = mount(FOUR);
    await rowsReady(screen);

    const call = screen.container.querySelector('[data-seq="106"]') as HTMLElement;
    expect(call.getAttribute('data-tool-call-id')).toBe('toolu_012orqaSqTZd4XRpZaDKd2ca');
    expect(call.getAttribute('data-status')).toBe('failed');
    // The body arrives a tick later than the row: the grammar is loaded on
    // demand, and until it resolves the message renders as plain text. Both
    // states contain the sentence, which is the point.
    await expect.poll(() => call.textContent ?? '').toContain('EACCES: permission denied');
  });

  it('is searchable, because it is text in the DOM rather than glyphs on a canvas', async () => {
    const screen = mount(FOUR);
    await rowsReady(screen);

    // The claim EPIC-17-S21 scenario 2 makes about *why* the list beats a
    // terminal here. `window.find` is not available in every context, so the
    // property is asserted the way a search actually works over this DOM.
    await expect.poll(() => screen.container.textContent ?? '').toContain("I'll create that file.");
  });
});

suite('AC1 — the list is virtualised, not merely long', () => {
  it('keeps the DOM to a window, however many messages arrived', async () => {
    const many = Array.from({ length: 2_000 }, (_unused, index) =>
      message({
        seq: 1_000 + index,
        kind: 'agent_message_chunk',
        text: `chunk number ${index} of a very chatty agent`,
      }),
    );

    const screen = mount(many);
    await rowsReady(screen);

    const rendered = screen.container.querySelectorAll('[data-acp-message]').length;
    expect(rendered).toBeGreaterThan(0);
    // The red this is written for: a `v-for` over the whole array. Two thousand
    // articles render, the tab stalls, and every assertion above still passes.
    expect(rendered).toBeLessThan(200);
  });
});
