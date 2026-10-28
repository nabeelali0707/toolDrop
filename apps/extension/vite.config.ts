import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The Chrome extension (Manifest V3): two pages and a service worker. The
// output names are fixed, because manifest.json names them.

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome120',
    modulePreload: { polyfill: false },
    // Readable output: injected functions run as written, and reviewers can read what runs.
    minify: false,
    rollupOptions: {
      input: { background: 'src/background.ts', popup: 'popup.html', review: 'review.html' },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
