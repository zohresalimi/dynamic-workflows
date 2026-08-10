import tailwind from '@tailwindcss/vite';
import vue from '@vitejs/plugin-vue';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';
import { emulateMedia } from './test/commands.ts';

// The `web` slice of the root config's test.projects (docs/14-testing-strategy.md §13).
//
// Browser mode with a real Chromium, not jsdom or happy-dom. The nine P0 views
// are built on @vue-flow/core, d3 and xterm.js, and those need real layout and
// real measurement: jsdom and happy-dom have no SVG measurement, no canvas and
// no WebGL, and they do not fail cleanly — getBBox() returns 0, getContext('2d')
// stubs to null or a no-op, and element sizes report as zero. A test asserting
// "the node label fits inside the node" then passes against a 0x0 box.
//
// The browser binary itself is not downloaded at install time; CI runs
// `pnpm exec playwright install --with-deps chromium` before this project, and
// so must a developer who wants to run it locally.
export default defineConfig({
  // Tailwind is a plugin here as well as in vite.config.ts, and not by
  // accident: a component spec that mounts without the stylesheet the app
  // ships would assert against an unstyled DOM, where every `--state-*` lookup
  // resolves to the empty string and the seven-colour assertions pass or fail
  // for reasons that have nothing to do with the component.
  plugins: [tailwind(), vue()],
  // Pre-bundled up front rather than discovered mid-run. Vite's optimizer
  // reloads the page when it meets a new CommonJS-ish dependency, and a reload
  // in the middle of a browser test is reported as a flake rather than as what
  // it is — so the shell's runtime dependencies are named here.
  optimizeDeps: {
    include: [
      '@vue-flow/core',
      '@vueuse/core',
      'lucide-vue-next',
      'pinia',
      'reka-ui',
      'vue-router',
    ],
  },
  test: {
    name: 'web',
    include: ['src/**/*.test.ts'],
    // KAR-15.3 AC1/AC2. A real HTTP/1.1 SSE origin on a port of its own, so a
    // spec can hold six streams open and watch an ordinary `fetch` queue behind
    // them. It has to be started from Node — a page cannot start a server for
    // itself — and it has to be a *different* origin from the one serving the
    // test runner's own modules, or exhausting the pool wedges the run instead
    // of demonstrating anything. See ./test/sse-origin.ts.
    globalSetup: ['./test/global-setup.ts'],
    // One file at a time, and for a reason that is not tidiness.
    //
    // Two resources in this slice are global to the *browser* and cannot be
    // partitioned by giving each file its own fixture. The SSE origin above is
    // one ledger and one stream registry, so a `__reset` in one file empties
    // the ledger another file is mid-assertion over. And Chrome's ~6
    // connection-per-origin cap is shared: `src/api/multiplex.test.ts`
    // deliberately exhausts it for ten seconds to demonstrate what happens
    // next, and any file running beside it in that window cannot open a stream
    // at all — which presents as a timeout in an unrelated spec.
    fileParallelism: false,
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
      // KAR-16.1 AC6/AC8 — `prefers-color-scheme` and `prefers-reduced-motion`
      // are OS inputs the page cannot set for itself, and stubbing
      // `window.matchMedia` would leave the CSS media block (the thing AC8 is
      // actually about) inert. See ./test/commands.ts.
      commands: { emulateMedia },
    },
  },
});
