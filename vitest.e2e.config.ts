import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/**/*.e2e.ts'],
    testTimeout: 60000,
    hookTimeout: 60000,
    // e2e tests share an Electron instance per file — run files one at a time.
    fileParallelism: false,
    pool: 'forks',
  }
});
