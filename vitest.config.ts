import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000,
    include: ['tests/**/*.test.ts', 'packages/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@shorts/schemas': path.resolve(__dirname, './packages/schemas/src/index.ts'),
      '@shorts/core': path.resolve(__dirname, './packages/core/src/index.ts'),
      '@shorts/providers': path.resolve(__dirname, './packages/providers/src/index.ts'),
      '@shorts/agents': path.resolve(__dirname, './packages/agents/src/index.ts'),
      '@shorts/rendering': path.resolve(__dirname, './packages/rendering/src/index.ts'),
    },
  },
});
