import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

/**
 * The SPA build config.
 *
 * In development this file's `server` block is mostly moot: DeFlowd creates
 * Vite itself, in middleware mode, against its own node:http server, so the UI
 * and the API share one port and one origin (D10, ADR 0011).
 *
 * There is deliberately **no forwarding rule** in the `server` block, and a
 * guard test enforces its absence — including in this comment, which is why it
 * is worded around the option name. The UI is served by the daemon, so there is
 * nothing to forward to, and Vite's dev forwarding is documented-bad at exactly
 * the transport this product is built on: events buffer until the stream ends,
 * streams die after some minutes, and client closes never reach the backend
 * (vitejs/vite#12157). See docs/03-local-development.md §4.3.
 */
export default defineConfig({
  plugins: [vue()],
  build: {
    // The published package ships the built SPA next to the bundled daemon.
    outDir: '../daemon/dist/ui',
    emptyOutDir: true,
  },
});
