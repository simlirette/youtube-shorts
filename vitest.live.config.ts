import { defineConfig } from 'vitest/config';
import base from './vitest.config';

/** Real-provider acceptance tests. Uses the configured .env credentials and incurs API cost. */
export default defineConfig({
  ...base,
  test: {
    environment: 'node',
    testTimeout: 1_800_000,
    hookTimeout: 1_800_000,
    include: ['tests/live/**/*.live.ts'],
    fileParallelism: false,
  },
});
