import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * Builds the MV3 extension.
 * - HTML entries (dashboard, side panel) go through the normal Vite pipeline.
 * - Service worker and content scripts are emitted as flat, un-hashed IIFE/ESM
 *   files at the root of dist/, because manifest.json references them by name.
 */
export default defineConfig({
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome114',
    sourcemap: false,
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, 'dashboard.html'),
        sidepanel: resolve(__dirname, 'sidepanel.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        'content-d2l': resolve(__dirname, 'src/content/d2l.ts'),
        'content-gdocs': resolve(__dirname, 'src/content/gdocs.ts'),
      },
      output: {
        entryFileNames: (chunk) =>
          ['background', 'content-d2l', 'content-gdocs'].includes(chunk.name)
            ? '[name].js'
            : 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
