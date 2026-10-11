import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['demo/tests/**/*.test.ts', 'tests/**/*.test.ts']
  }
});
