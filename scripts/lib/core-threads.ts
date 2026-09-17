/**
 * Remote cores under node: each in a `worker_threads` worker running src/mcu/core-worker.ts
 * through tsx, for scripts that want to measure or exercise the worker path
 * (`pnpm bench --workers`).
 */
import { fileURLToPath } from "node:url"
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads"
import type { CoreTransport, FromCore } from "@/sim/core-host"

export function spawnNodeCore(): CoreTransport {
  const entry = new URL("../../src/mcu/core-worker.ts", import.meta.url).href
  const tsconfig = fileURLToPath(new URL("../../tsconfig.app.json", import.meta.url))
  // Replies come over a channel of their own so a script that never yields to the event loop
  // can still take them synchronously (`receiveMessageOnPort`).
  const replies = new MessageChannel()
  const w = new Worker(new URL("./core-worker-boot.mjs", import.meta.url), { workerData: { entry, tsconfig, replyPort: replies.port2 }, transferList: [replies.port2], execArgv: [] })
  w.on("error", (e) => console.error("core worker:", e))
  let handler: ((msg: FromCore) => void) | null = null
  const poll = () => {
    for (;;) {
      const m = receiveMessageOnPort(replies.port1)
      if (!m) return
      handler?.(m.message as FromCore)
    }
  }
  return {
    post: (msg, transfer) => w.postMessage(msg, transfer ?? []),
    // No listener on the port: a started port hands messages to it asynchronously and the
    // synchronous receive gets nothing. The proxy polls where it needs the replies.
    onMessage: (cb) => (handler = cb),
    poll,
    terminate: () => {
      replies.port1.close()
      void w.terminate()
    },
  }
}
