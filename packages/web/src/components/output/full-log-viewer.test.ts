/**
 * KAR-17.5 test plan row 8 — "Open full log" never touches xterm.
 *
 * Verifies: EPIC-17-S23 · AC7
 *
 * The row's red is *"the archive path fell back to xterm"*, and putting a
 * 400 MB log into a terminal is a tab death with a very clear cause and no
 * warning: at 12 bytes a cell it is hundreds of megabytes of typed array before
 * anything is drawn. So the viewer is a **virtualised read-only list over byte
 * ranges**, and the assertion is the absence of a `Terminal` construction on
 * this path — which is checkable, because `../../lib/terminal-session.ts` is
 * the only file that can construct one and it counts them.
 *
 * The transport is asserted on the `Range` header rather than on what rendered.
 * A viewer that fetched the whole artifact and then sliced it in memory renders
 * identically and is exactly the build this row exists to fail.
 */
import { afterEach, expect, it, describe as suite } from 'vitest';
import { render } from 'vitest-browser-vue';
import { ARCHIVE_PAGE_BYTES, artifactArchive, rangeHeader } from '../../lib/log-archive.ts';
import { forgetTerminalSnapshots, liveTerminalCount } from '../../lib/terminal-session.ts';
import FullLogViewer from './FullLogViewer.vue';

const open: { unmount: () => void }[] = [];

afterEach(() => {
  for (const screen of open.splice(0)) screen.unmount();
  forgetTerminalSnapshots();
});

const SHA = 'a'.repeat(64);

/** A synthetic archive: 200,000 numbered lines, ≈ 6 MB. */
const LINE_COUNT = 200_000;
const line = (index: number): string => `${String(index).padStart(6, '0')} agent said something\n`;

/** The whole archive as bytes, built once — the *server's* copy, not the tab's. */
const archiveBytes = new TextEncoder().encode(
  Array.from({ length: LINE_COUNT }, (_unused, index) => line(index)).join(''),
);

interface Asked {
  readonly url: string;
  readonly range: string | null;
}

/**
 * A `fetch` that serves `GET /api/artifacts/:sha` the way DeFlowd does —
 * `Accept-Ranges: bytes`, `206` with a `Content-Range` for a ranged request —
 * and records what was asked for.
 */
function artifactFetch(asked: Asked[]): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const range = new Headers(init?.headers).get('Range');
    asked.push({ url, range });

    if (range === null) {
      return Promise.resolve(
        new Response(archiveBytes, {
          status: 200,
          headers: {
            'Accept-Ranges': 'bytes',
            'Content-Length': String(archiveBytes.byteLength),
          },
        }),
      );
    }

    const matched = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (matched === null) return Promise.resolve(new Response(null, { status: 416 }));
    const start = Number(matched[1]);
    const end = Math.min(Number(matched[2]), archiveBytes.byteLength - 1);

    return Promise.resolve(
      new Response(archiveBytes.slice(start, end + 1), {
        status: 206,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${archiveBytes.byteLength}`,
        },
      }),
    );
  }) as typeof fetch;
}

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

suite('AC7 / row 8 — the archive is byte ranges, and no terminal', () => {
  it('spells the range header the way HTTP does, inclusive at both ends', () => {
    // Off by one here is not a rendering bug: it drops or duplicates a byte at
    // every page boundary, which shows up as a mangled line every 64 KB.
    expect(rangeHeader(0, 1_023)).toBe('bytes=0-1023');
    expect(rangeHeader(1_024, 2_047)).toBe('bytes=1024-2047');
  });

  it('never asks for the whole artifact', async () => {
    const asked: Asked[] = [];
    const archive = artifactArchive({
      url: `/api/artifacts/${SHA}`,
      bytes: archiveBytes.byteLength,
      fetch: artifactFetch(asked),
    });

    await archive.read(0, ARCHIVE_PAGE_BYTES - 1);

    expect(asked).toHaveLength(1);
    expect(asked[0]?.range).toBe(`bytes=0-${ARCHIVE_PAGE_BYTES - 1}`);
    // A request with no Range is a whole-file read, which is the thing.
    expect(asked.every((one) => one.range !== null)).toBe(true);
  });

  it('mounts a virtualised viewer and constructs no Terminal', async () => {
    const asked: Asked[] = [];
    const screen = render(FullLogViewer, {
      props: {
        archive: artifactArchive({
          url: `/api/artifacts/${SHA}`,
          bytes: archiveBytes.byteLength,
          fetch: artifactFetch(asked),
        }),
      },
    });
    open.push(screen);

    await expect
      .poll(() => screen.container.querySelectorAll('[data-log-line]').length)
      .toBeGreaterThan(0);
    await settle();

    // Row 8's assertion, both halves.
    expect(liveTerminalCount()).toBe(0);
    expect(document.querySelector('.xterm')).toBeNull();

    // And virtualised: a fraction of the file's lines are in the DOM.
    const rendered = screen.container.querySelectorAll('[data-log-line]').length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(500);

    // Only the pages it needed, never the file.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((one) => one.range !== null)).toBe(true);
    const fetched = asked.length * ARCHIVE_PAGE_BYTES;
    expect(fetched).toBeLessThan(archiveBytes.byteLength / 4);
  });

  it('renders the bytes it fetched, not a placeholder', async () => {
    const asked: Asked[] = [];
    const screen = render(FullLogViewer, {
      props: {
        archive: artifactArchive({
          url: `/api/artifacts/${SHA}`,
          bytes: archiveBytes.byteLength,
          fetch: artifactFetch(asked),
        }),
      },
    });
    open.push(screen);

    await expect
      .poll(() => screen.container.textContent ?? '')
      .toContain('000000 agent said something');
  });
});

suite('EPIC-17-S23 scenario 2 — search runs over ranges fetched on demand', () => {
  it('finds a hit without ever holding the whole file', async () => {
    const asked: Asked[] = [];
    const archive = artifactArchive({
      url: `/api/artifacts/${SHA}`,
      bytes: archiveBytes.byteLength,
      fetch: artifactFetch(asked),
    });

    // A line about a fifth of the way in.
    const hit = await archive.search('040000 agent');

    expect(hit).not.toBeNull();
    expect(hit?.text).toContain('040000 agent said something');
    // Stopped at the page that held it rather than walking to the end.
    const scanned = asked.length * ARCHIVE_PAGE_BYTES;
    expect(scanned).toBeLessThan(archiveBytes.byteLength / 2);
    expect(asked.every((one) => one.range !== null)).toBe(true);
  });

  it('answers null for a string the archive does not contain, having read it in pages', async () => {
    const asked: Asked[] = [];
    const archive = artifactArchive({
      url: `/api/artifacts/${SHA}`,
      bytes: archiveBytes.byteLength,
      fetch: artifactFetch(asked),
    });

    expect(await archive.search('a string that is definitely not in there')).toBeNull();
    // It had to read everything to be sure — in pages, one at a time, never as
    // one buffer.
    expect(asked.length).toBeGreaterThan(1);
    expect(asked.every((one) => one.range !== null)).toBe(true);
  });
});
