import vue from '@vitejs/plugin-vue';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

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
  plugins: [vue()],
  test: {
    name: 'web',
    include: ['src/**/*.test.ts'],
    browser: {
      enabled: true,
      provider: playwright(),
      headless: true,
      instances: [{ browser: 'chromium' }],
    },
  },
});
