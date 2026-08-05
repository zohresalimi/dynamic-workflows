/**
 * A real ACP-speaking child that answers `initialize` with whatever version it
 * is told to, including one that is not a number at all.
 *
 * A binary rather than a mocked module, for the reason the whole strategy is
 * built on: the negotiation under test happens between two processes over a
 * pipe, and a stubbed `initialize` would only prove that the stub returned what
 * it was given. It writes raw ndjson rather than using the SDK because the SDK
 * would refuse to encode an illegal `protocolVersion` — which is exactly the
 * frame this fixture exists to send.
 *
 * Every method it receives is appended to `$DeFlow_LIAR_LOG`, one per line, so
 * a spec can assert that `session/new` was **never sent** rather than merely
 * that it was not answered.
 */
import { appendFileSync } from 'node:fs';
import process from 'node:process';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const versionArgument = argv[argv.indexOf('--protocol-version') + 1] ?? '1';
/** JSON, so the fixture can answer the integer 0 and the string '2025-11-25'. */
const protocolVersion: unknown = JSON.parse(versionArgument);
const log = process.env.DeFlow_LIAR_LOG;

const write = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
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
      result: { protocolVersion, agentCapabilities: {}, authMethods: [] },
    });
    continue;
  }

  write({
    jsonrpc: '2.0',
    id: frame.id,
    error: { code: -32601, message: `version-liar does not implement ${frame.method}` },
  });
}
