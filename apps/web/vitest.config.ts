import { defineConfig } from 'vitest/config';

// Node-environment unit tests for pure app logic (e.g. the tribe-quiz resolver)
// and source-level structural pins on React components (e.g. DropCard's
// P2.a selected-state surface). Scoped to __tests__ so it never pulls in
// React/Next component files for execution — tests that need React
// rendering should install @testing-library/react + a jsdom env first.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['app/**/__tests__/**/*.test.ts', 'components/**/__tests__/**/*.test.ts'],
  },
});
