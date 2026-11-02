import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'lib/**/*.test.mjs'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
  }
});
