import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
  test: {
    environment: 'node',
    pool: 'forks',
    testTimeout: 600_000,
    hookTimeout: 600_000,
    setupFiles: ['./tests/setup.ts', ...(process.env.EMUL_WORKERS ? ['./scripts/lib/workers-preload.ts'] : [])],
    projects: [
      { extends: true, test: { name: 'sim', include: ['tests/sim/**/*.test.ts'] } },
      { extends: true, test: { name: 'firmware', include: ['tests/firmware/**/*.test.ts'] } },
    ],
  },
})
