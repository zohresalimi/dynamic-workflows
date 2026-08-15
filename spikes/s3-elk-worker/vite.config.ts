import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Three builds of one app.
 *
 * `S3_VARIANT=no-elk` swaps the engine module for a stub that throws. Nothing
 * else changes — same entry, same fixtures, same DOM rendering, same dynamic
 * dagre import — so the difference between the two entry chunks is ELK and
 * nothing else, which is what AC2 asks to be measured.
 *
 * `S3_VARIANT=main-thread` (KAR-00.10) swaps it for one that imports
 * `elkjs/lib/elk.bundled.js` as a plain module: the regression AC2 exists to
 * catch, built rather than described, so the budget can be watched going red.
 * It is a test fixture — never served, never shipped.
 *
 * `manifest: true` because `check.mjs` and the integration slice read the entry
 * chunk's real filename out of `dist/.vite/manifest.json` rather than guessing
 * at a hash.
 */
const ENGINE = {
  elk: './src/engine/elk.ts',
  'no-elk': './src/engine/absent.ts',
  'main-thread': './src/engine/main-thread.ts',
} as const;

const requested = process.env.S3_VARIANT ?? 'elk';
const variant = requested in ENGINE ? (requested as keyof typeof ENGINE) : 'elk';

export default defineConfig({
  resolve: {
    alias: {
      'elk-engine': fileURLToPath(new URL(ENGINE[variant], import.meta.url)),
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
