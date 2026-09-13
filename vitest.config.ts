import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // PBKDF2 password tests are intentionally slower than unit defaults
    testTimeout: 15_000,
  },
});
