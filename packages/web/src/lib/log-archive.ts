/**
 * KAR-17.5 — the archive on disk, read a page at a time.
 *
 * Verifies: EPIC-17-S23 · AC7
 *
 * > The browser terminal is a **live tail**; the viewer is **the archive**.
 *
 * The complete output of a node lives at
 * `runs/<runId>/nodes/<nodeId>/stdout.log` (NF8) and is served, content
 * addressed, by `GET /api/artifacts/:sha` — which sets `Accept-Ranges: bytes`,
 * answers `206` with a `Content-Range`, and is immutably cacheable
 * (docs/11-api-and-realtime.md §6). That is what makes this cheap: the tab
 * holds the pages it is showing and nothing else, so a 400 MB log costs the
 * same as a 400 KB one.
 *
 * **Immutability is what makes the cache correct.** An artifact is addressed by
 * the digest of its bytes, so a page fetched once can never be stale — which is
 * why pages are memoised here with no invalidation and no TTL. That is only
 * safe because the address is the content.
 *
 * `read` is inclusive at both ends, because `Range` is. Getting that off by one
 * does not fail visibly: it drops or duplicates one byte at every page
 * boundary, which reads as a mangled line every 64 KB and looks like the agent
 * produced it.
 */

/**
 * The page size.
 *
 * 64 KB is roughly a thousand lines of agent output — comfortably more than a
 * viewport, so scrolling does not fetch per frame, and small enough that
 * opening the viewer on a huge log is one small request rather than a stall.
 */
export const ARCHIVE_PAGE_BYTES = 64 * 1024;

/** One `Range` header value, inclusive at both ends as HTTP defines it. */
export const rangeHeader = (start: number, endInclusive: number): string =>
  `bytes=${start}-${endInclusive}`;

/** Where a search found what it was looking for. */
export interface ArchiveHit {
  /** Byte offset of the match within the archive. */
  readonly offset: number;
  /** The line the match fell on. */
  readonly text: string;
}

export interface LogArchive {
  /** Total size, from the artifact's own metadata — never from a read. */
  readonly bytes: number;
  /** Bytes `[start, endInclusive]`, decoded. */
  read(start: number, endInclusive: number): Promise<string>;
  /** The first occurrence of `needle`, scanning in pages and stopping at it. */
  search(needle: string): Promise<ArchiveHit | null>;
}

export interface ArtifactArchiveOptions {
  /** `/api/artifacts/:sha`. */
  readonly url: string;
  readonly bytes: number;
  readonly fetch: typeof fetch;
  /** The bearer token, as a function so a late handoff still works. */
  readonly token?: () => string | null;
}

/**
 * A `LogArchive` over `GET /api/artifacts/:sha`.
 *
 * Decoding is **lossy on purpose** (`fatal: false`, the default, stated
 * anyway). A page boundary falls wherever the arithmetic put it, which is
 * routinely mid-character in a log full of box-drawing and emoji, and a decoder
 * that threw would blank the viewer for one split codepoint.
 */
export function artifactArchive(options: ArtifactArchiveOptions): LogArchive {
  const decoder = new TextDecoder('utf-8', { fatal: false });
  /** Safe with no invalidation: the address *is* the digest of the content. */
  const pages = new Map<number, Promise<string>>();

  async function readRange(start: number, endInclusive: number): Promise<string> {
    const headers: Record<string, string> = { Range: rangeHeader(start, endInclusive) };
    const token = options.token?.() ?? null;
    if (token !== null) headers['Authorization'] = `Bearer ${token}`;

    const response = await options.fetch(options.url, { headers });
    if (!response.ok) {
      throw new Error(`${options.url} answered ${response.status} for ${headers['Range']}`);
    }
    return decoder.decode(new Uint8Array(await response.arrayBuffer()));
  }

  function page(index: number): Promise<string> {
    let pending = pages.get(index);
    if (pending === undefined) {
      const start = index * ARCHIVE_PAGE_BYTES;
      pending = readRange(start, Math.min(start + ARCHIVE_PAGE_BYTES, options.bytes) - 1);
      pages.set(index, pending);
    }
    return pending;
  }

  const lastPage = Math.max(0, Math.ceil(options.bytes / ARCHIVE_PAGE_BYTES) - 1);

  return {
    bytes: options.bytes,

    async read(start: number, endInclusive: number): Promise<string> {
      const first = Math.floor(start / ARCHIVE_PAGE_BYTES);
      const last = Math.min(Math.floor(endInclusive / ARCHIVE_PAGE_BYTES), lastPage);

      let text = '';
      for (let index = first; index <= last; index += 1) text += await page(index);

      const offset = start - first * ARCHIVE_PAGE_BYTES;
      return text.slice(offset, offset + (endInclusive - start + 1));
    },

    async search(needle: string): Promise<ArchiveHit | null> {
      // Page by page, carrying one page's tail so a match straddling a boundary
      // is still found — the boundary is arithmetic and has nothing to do with
      // where the interesting line is.
      let carry = '';
      let carryOffset = 0;

      for (let index = 0; index <= lastPage; index += 1) {
        const text = carry + (await page(index));
        const at = text.indexOf(needle);
        if (at !== -1) {
          const lineStart = text.lastIndexOf('\n', at) + 1;
          const lineEnd = text.indexOf('\n', at);
          return {
            offset: carryOffset + at,
            text: text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd),
          };
        }
        // Keep enough to span a match cut in half, and no more: holding the
        // whole scan would be the fully-loaded buffer this exists to avoid.
        const keep = Math.min(text.length, Math.max(needle.length, 1) + 4_096);
        carryOffset += text.length - keep;
        carry = text.slice(text.length - keep);
      }
      return null;
    },
  };
}

/** One line of the archive, with the byte offset it started at. */
export interface LogLine {
  readonly offset: number;
  readonly text: string;
}

/**
 * Splits a decoded page into lines, dropping the trailing partial one.
 *
 * The last line of a page is almost always half a line, and rendering it would
 * show the operator a truncation the agent did not write. `keepLast` says to
 * keep it, which is right only for the final page of the file.
 */
export function logLines(text: string, offset: number, keepLast: boolean): LogLine[] {
  const parts = text.split('\n');
  const tail = parts.pop() ?? '';
  const lines: LogLine[] = [];

  let at = offset;
  for (const part of parts) {
    lines.push({ offset: at, text: part });
    at += part.length + 1;
  }
  if (keepLast && tail !== '') lines.push({ offset: at, text: tail });
  return lines;
}
