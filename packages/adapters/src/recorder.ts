/**
 * KAR-05.7 AC1 — the golden-recording tee.
 *
 * **It belongs to the transport, and nowhere else.** A tee wired into the
 * adapter's parsing logic records the *normaliser's interpretation* of the
 * wire, so the one thing it can never see is a frame the normaliser did not
 * understand — which is exactly the change a conformance corpus exists to
 * catch. So this writes bytes as they leave and arrive, upstream of
 * `ndJsonStream` and upstream of every `describeUpdate` in the package, and a
 * line that is not JSON at all is recorded verbatim as `raw` rather than
 * dropped.
 *
 * **The file is keyed on the exact agent version** (AC6). `@latest` would let
 * a vendor release invalidate every golden underneath it in place; an exact
 * version makes a bump a *new directory in a pull request*, which is the only
 * form of the diff a reviewer can actually read. Anything that is not
 * `<major>.<minor>.<patch>` is refused rather than normalised, because the
 * alternative failure is silent.
 *
 * **The perspective is the agent's**, matching the format
 * `packages/mock-agent/src/recording.ts` already replays: `"in"` is a frame
 * the agent received, `"out"` one it wrote. The tee sits on the client's side
 * of the pipe, so the labels are flipped once, here, rather than by a
 * conversion step every reader would have to remember.
 *
 * **Nothing reaches the file un-redacted.** `recordings/` is public and a
 * capture is a transcript of a real session on somebody's laptop; what travels
 * with it is not a credential but a home directory, a temp path, a username
 * and the machine's own slash-command list. `test/recordings-scrubbed.test.ts`
 * is the backstop, and this is the thing it backs up.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { InvalidRecordingKey, RECORDING_DIR_SHAPE } from './failures.ts';

/** `DeFlow_RECORD=1` and nothing else turns the tee on. */
export const RECORD_ENV = 'DeFlow_RECORD';
/** The corpus root. Defaults to `recordings/` under the process's cwd. */
export const RECORD_DIR_ENV = 'DeFlow_RECORD_DIR';
/** The `<case>` half of the file name. Defaults to the node's id. */
export const RECORD_CASE_ENV = 'DeFlow_RECORD_CASE';

export const DEFAULT_RECORDING_ROOT = 'recordings';

/** `0.64.1`, `0.53.1-rc.2`. Never `latest`, never `v1`, never `0.64`. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/;

/**
 * `<provider>@<version>`, or a refusal naming the shape.
 *
 * The refusal is the feature. A directory called `claude-agent-acp@latest`
 * still replays, still passes Layer A and still looks like a golden — right up
 * to the release that quietly changed what it means.
 */
export function recordingDirName(provider: string, version: string): string {
  if (provider === '' || provider.includes('@') || provider.includes('/')) {
    throw new InvalidRecordingKey(
      `recording provider "${provider}" cannot be used as a directory name; ` +
        `the shape is ${RECORDING_DIR_SHAPE}, for example "some-agent-acp@0.64.1"`,
      { provider },
    );
  }
  if (!EXACT_VERSION.test(version)) {
    throw new InvalidRecordingKey(
      `recording version "${version}" is not an exact version; the shape is ` +
        `${RECORDING_DIR_SHAPE}, for example "some-agent-acp@0.64.1". A moving tag ` +
        `such as "@latest" is refused on purpose: a vendor release would silently ` +
        `invalidate every golden in the directory instead of producing a new one in ` +
        `a pull request.`,
      { provider, version },
    );
  }
  return `${provider}@${version}`;
}

/** The three machine-varying facts a capture carries without meaning to. */
export interface RecordingIdentity {
  readonly home: string;
  readonly username: string;
  readonly tmpdir: string;
}

export const HOME_PLACEHOLDER = '<HOME>';
export const TMPDIR_PLACEHOLDER = '<TMPDIR>';
export const USER_PLACEHOLDER = '<USER>';

const escape = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Everything a recording says about the machine it was taken on, replaced by a
 * placeholder. Idempotent, so a capture that was already scrubbed is unchanged
 * by a second pass — which is what lets the converter re-run over tee output
 * without producing a different file.
 *
 * The generic `/Users/<name>` and `/var/folders/…/T` rules run *after* the
 * literal ones so that this machine's own paths collapse to the same
 * placeholder as anybody else's rather than to a longer prefix of them.
 */
export function redactRecordingText(text: string, identity: RecordingIdentity): string {
  let out = text;
  const literal = (needle: string, placeholder: string): void => {
    if (needle.length > 1) out = out.replaceAll(needle, placeholder);
  };
  literal(`/private${identity.tmpdir}`, TMPDIR_PLACEHOLDER);
  literal(identity.tmpdir, TMPDIR_PLACEHOLDER);
  literal(identity.home, HOME_PLACEHOLDER);
  out = out.replace(
    /(?:\/private)?\/var\/folders\/[^/\s"'\\]+\/[^/\s"'\\]+\/T/g,
    TMPDIR_PLACEHOLDER,
  );
  out = out.replace(/\/(?:Users|home)\/[^/\s"'\\]+/g, HOME_PLACEHOLDER);
  // A username is a bare word, so it is only replaced where JSON would quote
  // it — a three-letter login name inside prose is not an identity leak, and a
  // rule that fired there would be turned off within the week.
  if (identity.username.length >= 3) {
    out = out.replace(new RegExp(`"${escape(identity.username)}"`, 'g'), `"${USER_PLACEHOLDER}"`);
  }
  // The slash-command list enumerates what is installed on the machine. It is
  // emptied rather than placeheld: the array's *shape* is what a replaying
  // client parses, and its contents are nobody's business.
  return out.replace(/"availableCommands"\s*:\s*\[[^\]]*\]/g, '"availableCommands":[]');
}

export function machineIdentity(): RecordingIdentity {
  return { home: homedir(), username: userInfo().username, tmpdir: tmpdir() };
}

/** `"in"` is a frame the **agent** received; `"out"` one it wrote. */
export type RecordedDirection = 'in' | 'out';

export interface RecordingHeader {
  readonly provider: string;
  /** Exact. `recordingDirName` is what refuses anything else. */
  readonly version: string;
  readonly case?: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly frameCapBytes: number;
}

export interface RecorderOptions {
  /**
   * Milliseconds, from the injected clock — either a function or a fixed
   * value. `t` is the offset from the first call, which is what makes
   * inter-chunk timing a measurement rather than a wall-clock coincidence.
   */
  readonly now?: number | (() => number);
  readonly identity?: RecordingIdentity;
}

export interface TransportRecorder {
  /** The file being written, absolute. */
  readonly path: string;
  /** Raw bytes, before anything parses them. */
  note(dir: RecordedDirection, bytes: Uint8Array): void;
  stderr(bytes: Uint8Array): void;
  exit(status: { readonly code: number | null; readonly signal: NodeJS.Signals | null }): void;
  /** Flushes any frame the session ended in the middle of. Idempotent. */
  close(): void;
}

const NEWLINE = 0x0a;
const decoder = new TextDecoder();

/**
 * The tee, or `null` when `DeFlow_RECORD` does not say `1`.
 *
 * Throws `InvalidRecordingKey` when recording *is* on and the version is not
 * exact: a misconfigured capture that quietly wrote nothing would be
 * discovered by its absence, hours later, after the quota was spent.
 */
export function openTransportRecorder(
  env: NodeJS.ProcessEnv,
  header: RecordingHeader,
  options: RecorderOptions = {},
): TransportRecorder | null {
  if (env[RECORD_ENV] !== '1') return null;

  const keyed = recordingDirName(header.provider, header.version);
  // The environment wins over the caller's default: `DeFlow_RECORD_CASE` is how
  // a developer names the capture they are taking, and the header's `case` is
  // only the fallback the daemon supplies (the node's id).
  const kase = env[RECORD_CASE_ENV] ?? header.case ?? 'session';
  const root = resolve(env[RECORD_DIR_ENV] ?? DEFAULT_RECORDING_ROOT);
  const path = join(root, keyed, `${kase}.ndjson`);

  const identity = options.identity ?? machineIdentity();
  const fixed = typeof options.now === 'number' ? options.now : 0;
  const now: () => number = typeof options.now === 'function' ? options.now : () => fixed;
  const started = now();
  const pending: Record<RecordedDirection, Uint8Array> = {
    in: new Uint8Array(0),
    out: new Uint8Array(0),
  };
  let closed = false;

  const write = (value: Record<string, unknown>): void => {
    appendFileSync(path, `${redactRecordingText(JSON.stringify(value), identity)}\n`);
  };

  const at = (): number => Number((now() - started).toFixed(3));

  /** One complete line: `msg` when it parses, `raw` when it does not. */
  const frame = (dir: RecordedDirection, text: string): void => {
    if (text.trim() === '') return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      write({ t: at(), dir, raw: text });
      return;
    }
    write({ t: at(), dir, msg });
  };

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `${redactRecordingText(
      JSON.stringify({
        header: {
          agent: header.provider,
          version: header.version,
          case: kase,
          command: header.command,
          args: [...header.args],
          cwd: header.cwd,
          frameCapBytes: header.frameCapBytes,
          perspective: 'agent',
        },
      }),
      identity,
    )}\n`,
  );

  return {
    path,
    note(dir, bytes) {
      if (closed) return;
      const buffer = new Uint8Array(pending[dir].length + bytes.length);
      buffer.set(pending[dir]);
      buffer.set(bytes, pending[dir].length);
      let from = 0;
      for (;;) {
        const newline = buffer.indexOf(NEWLINE, from);
        if (newline === -1) break;
        frame(dir, decoder.decode(buffer.subarray(from, newline)));
        from = newline + 1;
      }
      pending[dir] = buffer.subarray(from);
    },
    stderr(bytes) {
      if (closed || bytes.length === 0) return;
      write({ t: at(), stderr: decoder.decode(bytes) });
    },
    exit(status) {
      if (closed) return;
      write({ t: at(), exit: { code: status.code, signal: status.signal } });
    },
    close() {
      if (closed) return;
      for (const dir of ['in', 'out'] as const) {
        const tail = pending[dir];
        pending[dir] = new Uint8Array(0);
        if (tail.length > 0) write({ t: at(), dir, raw: decoder.decode(tail) });
      }
      closed = true;
    },
  };
}
