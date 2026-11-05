import { readFileSync } from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { compression } from 'vite-plugin-compression2'

const ISOLATION = { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }

/**
 * Gets the boot splash on screen with the document: inlines its loop as a data: URI and
 * un-blocks the app's stylesheet, at build time. The splash has to
 * be the first thing on screen; as a URL it queues behind the entry chunk and its modulepreloads,
 * inline it arrives with the document itself (25 kB, and index.html revalidates with an ETag, so
 * it's re-sent only when it changed). Dev keeps the URL, so `npm run export` shows up on reload.
 * Fails the build if the reference is gone, rather than silently shipping a splash that waits.
 */
function inlineBootLoader(): Plugin {
  const SRC = '/loader/emul-loader.webm'
  return {
    name: 'emul:inline-boot-loader',
    apply: 'build',
    transformIndexHtml: {
      // After Vite has injected the entry's <link rel="stylesheet">.
      order: 'post',
      handler(html) {
        if (!html.includes(`src="${SRC}"`)) throw new Error(`index.html no longer references ${SRC}`)
        const data = readFileSync(path.resolve(import.meta.dirname, 'public', SRC.slice(1))).toString('base64')
        return (
          html
            .replace(`src="${SRC}"`, `src="data:video/webm;base64,${data}"`)
            // The app's stylesheet is render-blocking, so first paint — the splash — would wait
            // for it. Load it as print media and flip it on arrival: the splash paints with the
            // document, the unstyled app underneath stays covered, and dismissBootSplash waits
            // for the sheet before lifting the cover.
            .replace(/<link rel="stylesheet"([^>]*)>/g, `<link rel="stylesheet"$1 media="print" onload="this.media='all'">`)
        )
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    inlineBootLoader(),
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
  server: { headers: ISOLATION, proxy: { '/api': { target: process.env.EMUL_API ?? 'http://localhost:8787', changeOrigin: true }, '/collab': { target: process.env.EMUL_COLLAB ?? 'ws://localhost:8788', ws: true, changeOrigin: true } } },
  // The core worker awaits its message port at top level, which the default iife worker bundle cannot express.
  worker: { format: 'es' },
  preview: { headers: ISOLATION },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
