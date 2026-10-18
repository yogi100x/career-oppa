import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  // Only the Clerk publishable key is exposed to the popup bundle. The web
  // app's other private environment values are never passed to Vite.
  const appEnv = loadEnv(mode, resolve(__dirname, '../web'), '');
  const publicKey =
    process.env.VITE_CLERK_PUBLISHABLE_KEY ??
    appEnv.VITE_CLERK_PUBLISHABLE_KEY ??
    appEnv.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  return {
    plugins: [
      react(),
      {
        name: 'copy-extension-manifest',
        closeBundle() {
          copyFileSync(
            resolve(__dirname, 'manifest.json'),
            resolve(__dirname, 'dist/manifest.json'),
          );
        },
      },
    ],
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
    define: {
      'import.meta.env.VITE_CLERK_PUBLISHABLE_KEY': JSON.stringify(publicKey),
    },
  };
});
