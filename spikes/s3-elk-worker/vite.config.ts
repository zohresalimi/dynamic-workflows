import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Two builds of one app.
 *
 * `S3_VARIANT=no-elk` swaps the engine module for a stub that throws. Nothing
 * else changes — same entry, same fixtures, same DOM rendering, same dynamic
 * dagre import — so the difference between the two entry chunks is ELK and
 * nothing else, which is what AC2 asks to be measured.
 *
 * `manifest: true` because `check.mjs` and the integration slice read the entry
 * chunk's real filename out of `dist/.vite/manifest.json` rather than guessing
 * at a hash.
 */
const variant = process.env.S3_VARIANT === 'no-elk' ? 'no-elk' : 'elk';

export default defineConfig({
  resolve: {
    alias: {
      'elk-engine': fileURLToPath(
        new URL(
          variant === 'no-elk' ? './src/engine/absent.ts' : './src/engine/elk.ts',
          import.meta.url,
        ),
      ),
    },
  },
  build: {
    manifest: true,
    target: 'es2024',
    // Off: the spike reads the entry chunk's bytes, and a sourcemap comment
    // plus a .map file next to it is noise in a size comparison.
    sourcemap: false,
  },
});
