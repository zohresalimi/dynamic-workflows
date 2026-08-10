import tailwind from '@tailwindcss/vite';
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
 *
 * Tailwind 4 is CSS-first — no tailwind.config.js and no PostCSS step — so this
 * plugin plus `src/styles/theme.css` is the entire styling integration
 * (docs/12-frontend-architecture.md §8).
 */
export default defineConfig({
  plugins: [tailwind(), vue()],
  build: {
    // The published package ships the built SPA next to the bundled daemon.
    outDir: '../daemon/dist/ui',
    emptyOutDir: true,

    /**
     * KAR-16.1 AC10 — `rolldownOptions`, **not** `rollupOptions`.
     *
     * Vite 8 bundles with Rolldown and auto-converts the old name through a
     * compat layer, so the wrong spelling works — which is exactly why it is
     * worth getting right now rather than debugging a shim later
     * (docs/12-frontend-architecture.md §2.2). `test/ui-foundation.test.ts`
     * fails the build if it ever comes back.
     *
     * The output naming is stated rather than defaulted because AC9's budget is
     * asserted against a named entry chunk: `packages/web/test/integration/bundle-budget.test.ts`
     * reads the entry out of the built `index.html` and its module list out of
     * the sourcemap beside it, and a build with no stated output shape is one
     * where "the initial chunk" is whatever the bundler felt like that day.
     */
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
