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
    // Precompressed .br/.gz next to every text asset and firmware ELF, served as-is by nginx
    // (brotli_static / gzip_static) — best ratio, no CPU spent per request.
    compression({
      algorithms: ['brotliCompress', 'gzip'],
      include: /\.(js|css|html|svg|json|elf|wasm)$/,
      threshold: 1024,
    }),
  ],
  // Cross-origin isolation for SharedArrayBuffer: the simulation runs each MCU core in a worker of its own.
  server: { headers: ISOLATION },
  // The core worker awaits its message port at top level, which the default iife worker bundle cannot express.
  worker: { format: 'es' },
  preview: { headers: ISOLATION },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
