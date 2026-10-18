import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export default defineConfig({
  resolve: {
    alias: {
      // The provider's ESM bundle embeds Next CommonJS code using __dirname.
      // Its published CommonJS entry runs correctly under the Node test runner.
      '@dodopayments/nextjs': require.resolve('@dodopayments/nextjs', {
        paths: [fileURLToPath(new URL('./apps/web/', import.meta.url))],
      }),
    },
  },
  test: {
    include: ['apps/*/**/*.test.ts', 'packages/*/**/*.test.ts'],
    fileParallelism: false,
  },
});
