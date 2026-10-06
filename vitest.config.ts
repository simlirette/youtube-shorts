import { defineConfig } from 'vitest/config';
import path from 'node:path';

const alias = {
  '@shorts/schemas': path.resolve(__dirname, './packages/schemas/src/index.ts'),
  '@shorts/core': path.resolve(__dirname, './packages/core/src/index.ts'),
  '@shorts/providers': path.resolve(__dirname, './packages/providers/src/index.ts'),
  '@shorts/agents': path.resolve(__dirname, './packages/agents/src/index.ts'),
  '@shorts/rendering': path.resolve(__dirname, './packages/rendering/src/index.ts'),
  '@shorts/pipeline': path.resolve(__dirname, './packages/pipeline/src/index.ts'),
};

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 60_000,
    hookTimeout: 300_000,
    include: ['tests/**/*.test.ts'],
    env: { SHORTS_SKIP_DOTENV: '1', LOG_LEVEL: 'warn' },
  },
  resolve: { alias },
});
