import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
      '@data': resolve(__dirname, 'data'),
    },
  },
  server: {
    fs: {
      allow: ['.'],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
});
