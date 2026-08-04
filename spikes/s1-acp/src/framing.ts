/**
 * The frame cap that `@agentclientprotocol/sdk@1.3.0` does not have.
 *
 * The SDK's `LineBuffer.push()` keeps an unterminated tail in `#pending` for
 * ever — there is no maximum line length anywhere in it — so an agent that
 * never emits `\n` grows the daemon's heap until it dies. This is the
 * replacement the architecture calls for: the same newline framing, with a
 * byte budget measured against the *pending line* and enforced on the byte
 * that crosses it rather than after the line is whole.
 *
 * docs/01-architecture-overview.md §5, docs/07-provider-adapter-layer.md.
 */

/** The architecture's cap: 8 MiB per line. */
export const DEFAULT_FRAME_CAP_BYTES = 8 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * Raised when a single line exceeds the cap. `code` is the ledger's own
 * failure kind (docs/04-domain-model.md), so the spike and production speak
 * the same word for this failure.
 */
export class FrameTooLargeError extends Error {
  readonly code = 'adapter.frame-too-large';
  readonly capBytes: number;
  readonly bytesAtFailure: number;

  constructor(capBytes: number, bytesAtFailure: number) {
    super(
      `ACP frame exceeded the ${capBytes}-byte cap at ${bytesAtFailure} bytes with no newline; ` +
        'the connection is terminated rather than buffered further',
    );
    this.name = 'FrameTooLargeError';
    this.capBytes = capBytes;
    this.bytesAtFailure = bytesAtFailure;
  }
}

/** Newline framing with a hard per-line byte cap. */
export class CappedLineFramer {
  #pending: Uint8Array[] = [];
  #pendingBytes = 0;
  readonly capBytes: number;

  constructor(capBytes: number = DEFAULT_FRAME_CAP_BYTES) {
    this.capBytes = capBytes;
  }

  /** Bytes currently held for an unterminated line. */
  get pendingBytes(): number {
    return this.#pendingBytes;
  }

  /**
   * Consumes a chunk and returns each complete line, newline stripped.
   *
   * @throws {FrameTooLargeError} as soon as the pending line would exceed the
   * cap. The chunk is not retained, so the caller can drop the connection with
   * the buffer bounded by `capBytes` rather than by the agent's generosity.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    const lines: Uint8Array[] = [];
    let start = 0;
    let index = chunk.indexOf(NEWLINE, start);
    while (index !== -1) {
      this.#guard(index - start);
      lines.push(this.#take(chunk.subarray(start, index)));
      start = index + 1;
      index = chunk.indexOf(NEWLINE, start);
    }
    if (start < chunk.byteLength) {
      this.#guard(chunk.byteLength - start);
      // Copy the tail rather than retaining a view, so a few carried bytes do
      // not pin the whole chunk's backing buffer.
      this.#pending.push(new Uint8Array(chunk.subarray(start)));
      this.#pendingBytes += chunk.byteLength - start;
    }
    return lines;
  }

  #guard(incoming: number): void {
    const total = this.#pendingBytes + incoming;
    if (total > this.capBytes) {
      this.#pending = [];
      this.#pendingBytes = 0;
      throw new FrameTooLargeError(this.capBytes, total);
    }
  }

  #take(tail: Uint8Array): Uint8Array {
    if (this.#pending.length === 0) return tail;
    const line = new Uint8Array(this.#pendingBytes + tail.byteLength);
    let offset = 0;
    for (const part of this.#pending) {
      line.set(part, offset);
      offset += part.byteLength;
    }
    line.set(tail, offset);
    this.#pending = [];
    this.#pendingBytes = 0;
    return line;
  }
}
