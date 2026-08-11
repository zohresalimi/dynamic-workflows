import tailwind from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { graphRendererAlias } from '../scripts/renderer-alias.ts';

/**
 * The measurement harness's own build (KAR-16.6 AC3/AC4).
 *
 * Separate from `../vite.config.ts` on purpose: adding a second entry to the
 * shipped SPA's build would put a development harness into the artefact the
 * daemon serves, and into the initial-chunk budget `bundle-budget.test.ts`
 * defends. This config builds the same components with the same plugins into a
 * throwaway directory that `../scripts/measure-graph.ts` serves over plain HTTP.
 *
 * `base: './'` because that directory is served from wherever the script put
 * it, under whatever port it bound.
 */
export default defineConfig({
  root: import.meta.dirname,
  // KAR-16.6 AC10 — `DeFlow_GRAPH_RENDERER=stub` swaps the renderer here too,
  // so the swap can be proven by rendering a real plan and not only by the
  // application still compiling.
  resolve: { alias: graphRendererAlias() },
  base: './',
  plugins: [tailwind(), vue()],
  build: {
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
