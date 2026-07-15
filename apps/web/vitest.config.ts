import { defineConfig } from 'vitest/config';

// Node-environment unit tests for pure app logic (e.g. the tribe-quiz resolver).
// Scoped to __tests__ so it never pulls in React/Next component files.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/**/__tests__/**/*.test.ts'],
  },
});
