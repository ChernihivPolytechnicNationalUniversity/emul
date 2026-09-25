import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { compression } from 'vite-plugin-compression2'

const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Precompressed .br/.gz next to every text asset, firmware ELF and the debugger's ST sources,
    // served as-is by nginx (brotli_static / gzip_static) — best ratio, no CPU spent per request.
    compression({
      algorithms: ['brotliCompress', 'gzip'],
      include: /\.(js|css|html|svg|json|elf|wasm|c|h|s)$/,
      threshold: 1024,
    }),
  ],
  // Cross-origin isolation for SharedArrayBuffer: the simulation runs each MCU core in a worker of its own.
  // /api goes to the api service (`pnpm api`), as the ingress routes it in production — or to a deployed
  // one: `EMUL_API=https://emul.digituni.org pnpm dev` drives the real build service from a dev checkout.
  server: { headers: ISOLATION, proxy: { '/api': { target: process.env.EMUL_API ?? 'http://localhost:8787', changeOrigin: true } } },
  // The core worker awaits its message port at top level, which the default iife worker bundle cannot express.
  worker: { format: 'es' },
  preview: { headers: ISOLATION },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
