import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'scratch-entry.ts',
      formats: ['es'],
      fileName: () => 'scratch.js',
    },
  },
});
