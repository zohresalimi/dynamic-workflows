/**
 * Which MCP servers the operator's vendor CLI is actually connected to —
 * asked of the binary itself, once per daemon life per binary.
 *
 * The connector policy (`@DeFlow/adapters`' `connector-policy.ts`) needs real
 * server names: the vendor matches the server segment of a permission rule
 * literally, so `mcp__*` grants nothing and a policy written against guessed
 * names is a policy that silently does not apply. `<vendor> mcp list` is the
 * one place the names exist (`claude mcp list`, verified 2026-08-23 — there is
 * no `--json`, so the human lines are what gets parsed).
 *
 * **Once per daemon life, and never on the boot path.** The subcommand
 * health-checks every server over the network, which took seconds against one
 * connector — the same class of cost that put `probeProviders` 1.9 s into the
 * NF3 budget (MET-815). So the answer is cached per binary from the first turn
 * that needs it, and a failure is cached too: a CLI that cannot answer now
 * will not answer differently thirty seconds from now, and re-asking on every
 * tick is a spawn storm against a wedged binary.
 *
 * An empty answer is safe: no names means no `permissions` document, which is
 * the pre-2026-08-23 behaviour — every connector call denied, loudly.
 */
import { parseMcpListOutput } from '@DeFlow/adapters';
import { spawn } from 'node:child_process';
import { log } from '../logging.ts';

const connectors = log.child({ mod: 'connector-servers' });

/** Long enough for a CLI that health-checks its servers over the network;
 * short enough that a wedged one cannot hold a framing turn hostage. */
const MCP_LIST_TIMEOUT_MS = 15_000;

/** One daemon life's answers, keyed by the binary that gave them. */
const cache = new Map<string, Promise<readonly string[]>>();

/** Test seam and shutdown hygiene: the next `discoverConnectorServers` call
 * asks the binary again. */
export function resetConnectorServerCache(): void {
  cache.clear();
}

export interface ConnectorDiscoveryInput {
  /** The vendor CLI, absolute — the same binary the turn will spawn. */
  readonly binaryPath: string;
  /** Built by `buildChildEnv()`, like every other child of DeFlowd. */
  readonly env: Readonly<Record<string, string>>;
}

function runMcpList(input: ConnectorDiscoveryInput): Promise<readonly string[]> {
  return new Promise<readonly string[]>((resolve) => {
    // The watchdog is spawn's own `timeout`, not a timer of ours: the no-timer
    // rule (waits are node_wake rows, time enters through the Clock port)
    // exists so *scheduling* never happens off the ledger, and a child-process
    // deadline is process hygiene, delegated to the runtime that owns the
    // child. A killed child closes with a signal and lands on the same empty
    // answer as any other failure.
    const child = spawn(input.binaryPath, ['mcp', 'list'], {
      env: { ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: MCP_LIST_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

    const out: Buffer[] = [];
    let settled = false;
    const settle = (servers: readonly string[]): void => {
      if (settled) return;
      settled = true;
      resolve(servers);
    };

    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.once('error', () => {
      // A binary with no `mcp` subcommand, or none at all: the empty answer,
      // not a failure — the policy simply has nothing to say for this vendor.
      settle([]);
    });
    child.once('close', (code, signal) => {
      if (code !== 0) {
        if (signal !== null) {
          connectors.warn(
            { binaryPath: input.binaryPath, signal, timeoutMs: MCP_LIST_TIMEOUT_MS },
            'mcp list did not answer in time; no connector permissions this daemon life',
          );
        }
        settle([]);
        return;
      }
      const servers = parseMcpListOutput(Buffer.concat(out).toString('utf8'));
      connectors.info(
        { binaryPath: input.binaryPath, servers },
        `${String(servers.length)} connected MCP server(s) discovered for the connector policy`,
      );
      settle(servers);
    });
  });
}

/**
 * The connected server display names for one binary, from the per-life cache
 * or from the binary itself.
 */
export function discoverConnectorServers(
  input: ConnectorDiscoveryInput,
): Promise<readonly string[]> {
  const cached = cache.get(input.binaryPath);
  if (cached !== undefined) return cached;
  const answer = runMcpList(input);
  cache.set(input.binaryPath, answer);
  return answer;
}
