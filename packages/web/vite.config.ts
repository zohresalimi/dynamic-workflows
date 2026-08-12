import tailwind from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { diffSyntaxAlias } from './scripts/diff-syntax-alias.ts';
import { graphRendererAlias } from './scripts/renderer-alias.ts';

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
  /**
   * KAR-17.6 — the diff surface's dependencies are CommonJS-ish enough that
   * Vite's optimizer wants to pre-bundle them, and a dependency discovered
   * mid-run triggers a page reload. In the app that is a flicker; in a browser
   * spec it is reported as a flake.
   */
  optimizeDeps: {
    include: [
      '@git-diff-view/core',
      '@git-diff-view/vue',
      '@shikijs/magic-move/core',
      '@shikijs/magic-move/vue',
    ],
  },
  /**
   * KAR-16.6 AC10. Empty unless `DeFlow_GRAPH_RENDERER=stub` is set, in which
   * case every import of the graph facade resolves to the stub renderer and
   * nothing else in the application changes — which is the claim.
   */
  resolve: { alias: [...graphRendererAlias(), ...diffSyntaxAlias()] },
  build: {
    // `packages/web/dist`, and the copy into `packages/cli/dist/ui/` is a
    // separate step in `packages/cli/scripts/build.ts` (docs/16-repo-layout.md
    // §2). Building straight into the CLI's output directory would look
    // tidier and would put the two steps in the wrong order: the bundler runs
    // after this and cleans what it emits, so the UI has to arrive between the
    // two, not before both.
    outDir: 'dist',
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
