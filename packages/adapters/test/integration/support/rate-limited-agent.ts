/**
 * A real ACP-speaking child that completes the handshake, opens a session, and
 * then answers `session/prompt` with a JSON-RPC error of the caller's choosing.
 *
 * A binary rather than a mocked module, for the reason the whole strategy is
 * built on: what KAR-14.4 AC1 claims about the ACP path is that a *wire*
 * failure normalises to `provider.rate_limited`, and a stubbed transport would
 * only prove that the stub returned what it was given. It writes raw ndjson
 * for the same reason `version-liar.ts` does — the fixture's job is to send a
 * specific frame, not to be a well-behaved agent.
 *
 * `--code` is the JSON-RPC error code to answer the prompt with, and
 * `--resets-at` is the epoch **seconds** value to put on the error's `data`
 * (omit it, or pass `none`, for a vendor that said it was limited and not when
 * it lifts). `--nest` puts the same value under `rate_limit_info`, which is how
 * the one verified vendor spells it.
 *
 * Every method it receives is appended to `$DeFlow_RATE_LIMIT_LOG`, one per
 * line, so a spec can assert that a refusal happened **before the spawn** by
 * finding no log at all.
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
};

const code = Number(flag('--code') ?? '-32042');
const resetsAtArgument = flag('--resets-at') ?? 'none';
const resetsAt = resetsAtArgument === 'none' ? null : Number(resetsAtArgument);
const nested = argv.includes('--nest');
const log = process.env.DeFlow_RATE_LIMIT_LOG;

const SESSION_ID = 'sess_rate_limited_0001';

const write = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

/** The vendor payload, exactly as this fixture's flags describe it. Whatever
 * shape it has, DeFlow must keep it verbatim rather than normalise it. */
const errorData = (): Record<string, unknown> => {
  if (resetsAt === null) return { status: 'rejected', retryAfter: 'unknown' };
  return nested
    ? { rate_limit_info: { status: 'rejected', resetsAt } }
    : { status: 'rejected', resetsAt };
};

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });

for await (const line of lines) {
  if (line.trim() === '') continue;
  const frame = JSON.parse(line) as { id?: unknown; method?: string };
  if (typeof frame.method !== 'string') continue;
  if (log !== undefined) appendFileSync(log, `${frame.method}\n`);
  if (frame.id === undefined) continue;

  if (frame.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: frame.id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] },
    });
    continue;
  }

  if (frame.method === 'session/new') {
    write({ jsonrpc: '2.0', id: frame.id, result: { sessionId: SESSION_ID } });
    continue;
  }

  if (frame.method === 'session/prompt') {
    write({
      jsonrpc: '2.0',
      id: frame.id,
      error: { code, message: 'usage limit reached for this account', data: errorData() },
    });
    continue;
  }

  write({
    jsonrpc: '2.0',
    id: frame.id,
    error: { code: -32601, message: `rate-limited-agent does not implement ${frame.method}` },
  });
}
