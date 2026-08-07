/**
 * KAR-05.6 — the MCP host inside DeFlowd: one Unix domain socket, a grant per
 * node attempt, and the tool implementations themselves.
 *
 * **A UDS, not a TCP port.** DeFlowd is already local, so filesystem
 * permissions are available for free where a loopback socket would need an
 * auth scheme invented for it. The socket's parent directory is created `0700`
 * and the socket file `0600`: a process running as another user cannot even
 * `connect()`, which is a stronger statement than any token check made after
 * the connection exists (docs/15-security-model.md §5).
 *
 * **The token is the second lock, and it is one-time.** Filesystem permissions
 * stop another *user*; they do not stop another process of the same user, and
 * an agent is exactly that. So every `session/new` carries a fresh token bound
 * to one (run, node, attempt), it is spent by the first connection that
 * presents it, and a wrong or spent one is refused and logged with the run id
 * it claimed. A refusal is logged rather than silently dropped because it is
 * the only signal that something spawned the shim other than the agent DeFlow
 * spawned.
 *
 * **The host is the authority on which tools are callable, not the shim.** The
 * shim's tool list is always a little stale — a phase can advance while a
 * `tools/call` is in flight — so the phase check happens here, on the frame,
 * and a call for a tool the current phase does not include is refused *and
 * recorded*. The shim's `enable()`/`disable()` is presentation; this is
 * enforcement.
 */

import type { EventRecord, LedgerSink } from '@DeFlow/adapters';
import type {
  Clock,
  EventSeq,
  Fact,
  HandleRefusal,
  NodeHandleAccess,
  NodeId,
  RunId,
} from '@DeFlow/core';
import { PlanPatchSchema, REQUESTED_PATH_MAX } from '@DeFlow/core';
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import type { DestinationStream, Logger } from 'pino';
import { createLogger, log as daemonLog } from '../logging.ts';
import {
  ARTIFACT_INLINE_LIMIT_BYTES,
  PROPOSE_PLAN_PATCH,
  READ_ARTIFACT,
  READ_FACT,
  toolNamesForPhase,
  type WorkflowPhase,
} from './catalog.ts';
import {
  BRIDGE_VERSION,
  BridgeProtocolError,
  encodeFrame,
  type HostFrame,
  lineReader,
  parseShimFrame,
} from './protocol.ts';
import type { ArtifactStore } from './resolve-handle.ts';
import { mcpServerEntry } from './server-entry.ts';

/** Where the socket lives under the data directory. Created `0700`. */
export const MCP_SOCKET_DIR = 'mcp';

/**
 * The socket file name.
 *
 * Short on purpose: `sun_path` is 104 bytes on macOS and 108 on Linux, and a
 * data directory inside a temporary directory already spends half of that. One
 * socket serves every run — a connection names its run in the hello frame, and
 * the token is what decides whether the claim is true.
 */
export const MCP_SOCKET_FILE = 'host.sock';

/** The blackboard, as this host needs it. EPIC-09 owns the projection. */
export interface FactStore {
  /** The fact currently visible under `key`, or `null`. */
  read(key: string): Fact | null;
}

export interface McpGrantRequest {
  readonly runId: RunId;
  readonly nodeId: NodeId;
  /** 0-based, matching the event envelope. */
  readonly attempt: number;
  readonly phase: WorkflowPhase;
  /**
   * KAR-09.5 AC4 — the node's permission level, worktree scope and declared
   * read globs, so `DeFlow_read_artifact` can decide a `file://` handle by the
   * same ladder the ACP `fs/*` boundary uses.
   *
   * Optional, and absent means every `file://` handle is refused. That is the
   * fail-closed direction on purpose: this tool is *outside* the `fs/*`
   * mediation path, so a grant that forgot to say what the node may read must
   * not be read as "anything".
   */
  readonly access?: NodeHandleAccess;
}

export interface McpGrant {
  /** The one-time secret `session/new` carries in `DeFlow_RUN_TOKEN`. */
  readonly token: string;
  /** The untagged stdio entry to put in `session/new`. */
  readonly mcpServer: acp.McpServer;
  readonly phase: WorkflowPhase;
  /**
   * Moves this node to a new phase and pushes the resulting tool list to the
   * connected shim, which answers it with `sendToolListChanged()` (AC6).
   */
  setPhase(phase: WorkflowPhase): void;
  /** Ends the grant: the connection is closed and the token stops working. */
  revoke(): void;
}

export interface McpHostOptions {
  /** DeFlowd's data directory. The socket directory is created inside it. */
  readonly dataDir: string;
  /** Time enters here and nowhere else (NF9). */
  readonly clock: Clock;
  readonly ledger: LedgerSink;
  readonly facts: FactStore;
  /** KAR-09.5 — handle resolution, permission check included. */
  readonly artifacts: ArtifactStore;
  /** Where the operator log goes. Injected by specs so refusals are readable. */
  readonly destination?: DestinationStream;
  /** The shim entry point. Defaults to the one beside this package's `bin/`. */
  readonly entry?: string;
  /** How the one-time token is minted. Injected only by tests. */
  readonly mintToken?: () => string;
}

export interface McpHost {
  readonly socketPath: string;
  /** Whatever the socket is bound to. A string means a path, which means no
   * TCP port was bound — which is the assertion, not an implementation note. */
  listeningOn(): string | { readonly port: number } | null;
  grant(request: McpGrantRequest): McpGrant;
  /** How many shims are attached right now. */
  readonly connections: number;
  close(): Promise<void>;
}

/** A refusal the shim should report and exit on, rather than a crash. */
class ToolRefused extends Error {}

interface GrantState {
  readonly token: string;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly attempt: number;
  readonly access: NodeHandleAccess | undefined;
  phase: WorkflowPhase;
  /** Whether the token has been spent. One-time means exactly that (AC1). */
  spent: boolean;
  revoked: boolean;
  socket: Socket | null;
}

export function startMcpHost(options: McpHostOptions): Promise<McpHost> {
  const logger: Logger =
    options.destination === undefined
      ? daemonLog.child({ mod: 'mcp' })
      : createLogger({ destination: options.destination }).child({ mod: 'mcp' });

  const socketDir = join(options.dataDir, MCP_SOCKET_DIR);
  // 0700 before anything is bound inside it: a socket that existed for even an
  // instant under a wider mode is a socket somebody could have connected to.
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  // `recursive` skips the mode on a directory that already existed, and a data
  // directory outlives the daemon that made it — so the mode is asserted every
  // start rather than assumed from the one that created it.
  chmodSync(socketDir, 0o700);
  const socketPath = join(socketDir, MCP_SOCKET_FILE);
  rmSync(socketPath, { force: true });

  const grants = new Map<string, GrantState>();
  const live = new Set<Socket>();
  const mintToken = options.mintToken ?? (() => randomBytes(32).toString('hex'));

  const event = (kind: string, payload: unknown, grant: GrantState): EventRecord => ({
    kind,
    v: 1,
    ts: options.clock.now(),
    nodeId: grant.nodeId,
    attempt: grant.attempt,
    payload,
  });

  const progress = (grant: GrantState, message: string): Promise<EventSeq> =>
    options.ledger.append(
      event(
        'node.progress',
        { node: grant.nodeId, attempt: grant.attempt, phase: 'tool-use', message },
        grant,
      ),
    );

  async function readFact(grant: GrantState, args: Record<string, unknown>) {
    // Read rather than coerced: the args crossed a socket from a process an
    // agent spawned, so anything that is not the declared type is absent.
    const key = typeof args.key === 'string' ? args.key : '';
    const fact = options.facts.read(key);
    if (fact === null) throw new ToolRefused(`no fact is currently written under "${key}"`);
    // §5.2: the read is what makes this node a *consumer*, and the taint rule
    // is a numeric comparison over the seq this append assigns. Appended
    // before the value is handed back, for the same reason `node.started` is
    // written before the agent is spawned — a read the ledger never saw is a
    // read no invalidation can taint.
    await options.ledger.append(
      event('fact.read', { factId: fact.id, key: fact.key, by: grant.nodeId }, grant),
    );
    return {
      factId: fact.id,
      key: fact.key,
      kind: fact.kind,
      schemaId: fact.schemaId,
      value: fact.value,
      confidence: fact.provenance.confidence,
    };
  }

  /**
   * KAR-09.5 AC5 / EPIC-09-S29 — a refusal is recorded before it is returned,
   * and it is returned *typed*: `<code>: <message>`, never an empty body and
   * never a success envelope.
   *
   * A permission refusal becomes a `permission.denied` row, because that is the
   * event the operator already reads for "what did this node try to reach"; a
   * missing digest becomes a `node.progress` note, because nothing was denied —
   * the artifact simply is not there.
   */
  async function refuseHandle(
    grant: GrantState,
    handle: string,
    refusal: HandleRefusal,
  ): Promise<never> {
    const denial = refusal.denial;
    if (denial === undefined) {
      await progress(grant, `refused ${READ_ARTIFACT} ${handle}: ${refusal.code}`);
    } else {
      await options.ledger.append(
        event(
          'permission.denied',
          {
            node: grant.nodeId,
            attempt: grant.attempt,
            permission: denial.permission,
            method: denial.method,
            requested: denial.requested.slice(0, REQUESTED_PATH_MAX),
            reason:
              denial.reason.detail === undefined
                ? { code: denial.reason.code }
                : { code: denial.reason.code, detail: denial.reason.detail },
            ...(denial.declared === undefined ? {} : { declared: [...denial.declared] }),
          },
          grant,
        ),
      );
    }
    throw new ToolRefused(`${refusal.code}: ${refusal.message}`);
  }

  async function readArtifact(grant: GrantState, args: Record<string, unknown>) {
    const handle = typeof args.handle === 'string' ? args.handle : '';
    const resolution = await options.artifacts.resolve({
      runId: grant.runId,
      handle,
      access: grant.access,
    });
    if (!resolution.ok) return await refuseHandle(grant, handle, resolution.refusal);

    // The only thing that ever shortens a resolved body: a tool result travels
    // back through the agent's context window, and "the whole artifact" is not
    // a safe default for a store that holds multi-megabyte logs. It is
    // announced (`truncated: true`) rather than silent, and it is a prefix —
    // never a summary.
    const truncated = resolution.bytes > ARTIFACT_INLINE_LIMIT_BYTES;
    const text = truncated
      ? Buffer.from(resolution.text, 'utf8')
          .subarray(0, ARTIFACT_INLINE_LIMIT_BYTES)
          .toString('utf8')
      : resolution.text;
    await progress(
      grant,
      `${READ_ARTIFACT} ${resolution.handle} (${resolution.bytes} bytes${
        truncated ? ', truncated' : ''
      })`,
    );
    return { handle: resolution.handle, bytes: resolution.bytes, text, truncated };
  }

  async function proposePlanPatch(grant: GrantState, args: Record<string, unknown>) {
    const parsed = PlanPatchSchema.safeParse(args.patch);
    if (!parsed.success) {
      // Refused here rather than appended and rejected later: an unparseable
      // patch is not a proposal the policy engine can rule on, and the agent
      // is still in its tool loop and able to fix it.
      throw new ToolRefused(
        `the patch is not a valid DeFlow.planpatch.v1 document: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
          .join('; ')}`,
      );
    }
    const patch = parsed.data;
    // Proposing is not applying. KAR-11.3 owns `plan.patched`; what an agent
    // can do from inside its own tool loop is put the proposal on the record.
    await options.ledger.append(event('plan.patch.proposed', { patch }, grant));
    return {
      patchId: patch.id,
      accepted: false,
      detail: 'recorded as a proposal; the policy engine decides whether it is applied',
    };
  }

  async function invoke(
    grant: GrantState,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    switch (tool) {
      case READ_FACT:
        return await readFact(grant, args);
      case READ_ARTIFACT:
        return await readArtifact(grant, args);
      case PROPOSE_PLAN_PATCH:
        return await proposePlanPatch(grant, args);
      default:
        throw new ToolRefused(`no workflow tool is named "${tool}"`);
    }
  }

  /** The refusal path, in one place: record it, tell the shim, hang up. */
  function refuse(socket: Socket, reason: string, claimed: string): void {
    logger.warn({ run: claimed }, `refused an MCP shim connection: ${reason}`);
    socket.write(encodeFrame({ t: 'refused', reason }));
    socket.end();
  }

  const server: Server = createServer((socket) => {
    live.add(socket);
    socket.setEncoding('utf8');
    const read = lineReader();
    let grant: GrantState | null = null;

    const send = (frame: HostFrame): void => {
      if (!socket.writableEnded) socket.write(encodeFrame(frame));
    };

    const handle = async (line: string): Promise<void> => {
      const frame = parseShimFrame(line);

      if (grant === null) {
        if (frame.t !== 'hello') {
          refuse(socket, 'the first frame was not a hello', 'unknown');
          return;
        }
        const claimed = grants.get(frame.token);
        if (claimed === undefined || claimed.revoked || claimed.runId !== frame.run) {
          refuse(socket, 'the run token is not one this daemon issued', frame.run);
          return;
        }
        if (claimed.spent) {
          refuse(socket, 'the run token has already been spent; it is one-time', frame.run);
          return;
        }
        claimed.spent = true;
        claimed.socket = socket;
        grant = claimed;
        send({ t: 'welcome', v: BRIDGE_VERSION, tools: toolNamesForPhase(claimed.phase) });
        return;
      }

      if (frame.t === 'hello') {
        refuse(socket, 'a second hello on an established connection', frame.run);
        return;
      }

      if (frame.t === 'denied') {
        // The shim already refused it locally against the tool list it holds.
        // The event is still ours to write: NF10 says a run must be able to
        // explain itself, and "the agent tried to use a tool it no longer had"
        // is exactly the kind of thing that is unexplainable an hour later.
        await progress(grant, `refused MCP tool ${frame.tool}: not available in this phase`);
        return;
      }

      // The phase check is here, on the frame, and not only in the shim: the
      // shim's list can be one notification behind this one.
      if (!toolNamesForPhase(grant.phase).includes(frame.tool)) {
        await progress(grant, `refused MCP tool ${frame.tool}: not available in this phase`);
        send({ t: 'error', id: frame.id, message: `${frame.tool} is not available in this phase` });
        return;
      }

      try {
        send({ t: 'result', id: frame.id, value: await invoke(grant, frame.tool, frame.args) });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof ToolRefused)) {
          logger.error({ tool: frame.tool, node: grant.nodeId }, `MCP tool failed: ${message}`);
        }
        send({ t: 'error', id: frame.id, message });
      }
    };

    // Serialised on purpose: two tool calls interleaving their ledger appends
    // would make the order of `fact.read` rows depend on which one's I/O
    // finished first, and the taint rule reads that order.
    let queue: Promise<void> = Promise.resolve();
    socket.on('data', (chunk: string) => {
      let lines: string[];
      try {
        lines = read(chunk);
      } catch (error) {
        refuse(socket, (error as BridgeProtocolError).message, grant?.runId ?? 'unknown');
        return;
      }
      for (const line of lines) {
        queue = queue.then(() =>
          handle(line).catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            refuse(socket, message, grant?.runId ?? 'unknown');
          }),
        );
      }
    });

    const forget = (): void => {
      live.delete(socket);
      if (grant?.socket === socket) grant.socket = null;
    };
    socket.on('close', forget);
    socket.on('error', forget);
  });

  return new Promise<McpHost>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      // Node binds a socket under the process umask. The parent directory is
      // the real control, but a mode nobody set is a mode nobody decided.
      chmodSync(socketPath, 0o600);
      logger.debug({ socketPath }, 'MCP host listening');
      resolve({
        socketPath,
        listeningOn: () => server.address(),
        get connections(): number {
          return live.size;
        },
        grant(request: McpGrantRequest): McpGrant {
          const state: GrantState = {
            token: mintToken(),
            runId: request.runId,
            nodeId: request.nodeId,
            attempt: request.attempt,
            access: request.access,
            phase: request.phase,
            spent: false,
            revoked: false,
            socket: null,
          };
          grants.set(state.token, state);
          return {
            token: state.token,
            mcpServer: mcpServerEntry({
              ...(options.entry === undefined ? {} : { entry: options.entry }),
              socketPath,
              runId: request.runId,
              token: state.token,
            }),
            get phase(): WorkflowPhase {
              return state.phase;
            },
            setPhase(phase: WorkflowPhase): void {
              state.phase = phase;
              // AC6 — pushed, not polled, and emphatically not a new session.
              state.socket?.write(encodeFrame({ t: 'tools', tools: toolNamesForPhase(phase) }));
            },
            revoke(): void {
              state.revoked = true;
              grants.delete(state.token);
              state.socket?.end();
            },
          };
        },
        close(): Promise<void> {
          for (const socket of live) socket.destroy();
          live.clear();
          grants.clear();
          return new Promise<void>((done) => {
            server.close(() => {
              // The socket file is the server's, not the shim's: removing it
              // here is what keeps a stale inode from outliving the daemon
              // that bound it.
              rmSync(socketPath, { force: true });
              done();
            });
          });
        },
      });
    });
  });
}
