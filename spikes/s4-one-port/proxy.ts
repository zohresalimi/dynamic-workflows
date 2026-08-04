/**
 * The misconfiguration, reproduced once on purpose: a real Vite dev server with
 * `server.proxy` in front of the harness — the two-port shape the project has
 * chosen against (docs/03-local-development.md §4.3, ADR 0011).
 *
 * Three failure modes are recorded against Vite's dev proxy: SSE events buffer
 * and arrive in one burst, long streams hit socket timeouts, and close events
 * do not propagate back to the backend. `test/integration/spike-s4-one-port.test.ts`
 * measures the third directly and `run-long.mjs` runs a proxied client for the
 * same ten minutes as the direct one, so the first two are measured rather than
 * quoted.
 *
 * This file is the only place in the repository where `proxy` may appear as a
 * Vite server option: KAR-01.3's AC7 guard forbids the key anywhere under
 * `packages/`, and this throwaway workspace is outside its scan.
 */

import { createServer } from 'vite';

const PORT = Number(process.env.S4_PROXY_PORT ?? 7778);
const TARGET = `http://127.0.0.1:${Number(process.env.S4_TARGET_PORT ?? 7777)}`;
const proxyOptions = { target: TARGET, changeOrigin: false } as const;

const server = await createServer({
  configFile: false,
  logLevel: 'warn',
  server: {
    host: '127.0.0.1',
    port: PORT,
    strictPort: true,
    // Exactly the shape a developer reaches for when the API is "on the other
    // port", with the timeouts left at their defaults — because that is the
    // configuration whose failure modes are documented.
    proxy: { '/api': proxyOptions },
  },
});

await server.listen();
process.stdout.write(`${JSON.stringify({ msg: 'proxy listening', port: PORT, TARGET })}\n`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.close().finally(() => process.exit(0));
  });
}
