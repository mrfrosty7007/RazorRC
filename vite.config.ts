import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Tauri expects a fixed port and never falls back to another one.
const DEV_PORT = 1420;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // `TAURI_ENV_*` vars are injected by the Tauri CLI.
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
    host: false,
    watch: {
      // Rust sources are watched by the Tauri CLI, not Vite.
      ignored: ['**/src-tauri/**'],
    },
  },
  build: {
    // Safari 13 for macOS/iOS webviews, Chrome 105 elsewhere.
    target:
      process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    outDir: 'dist',
  },
}));
