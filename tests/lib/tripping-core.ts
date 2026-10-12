import { fileURLToPath } from "node:url"
import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads"
import type { CoreTransport, FromCore } from "@/sim/core-host"

export function spawnTrippingCore(tripAtSeconds: number): CoreTransport {
  const entry = new URL("./tripping-core-worker.ts", import.meta.url).href
  const tsconfig = fileURLToPath(new URL("../../tsconfig.app.json", import.meta.url))
  const replies = new MessageChannel()
  const boot = new URL("../../scripts/lib/core-worker-boot.mjs", import.meta.url)
  const w = new Worker(boot, { workerData: { entry, tsconfig, replyPort: replies.port2, tripAtSeconds }, transferList: [replies.port2], execArgv: [] })
  w.on("error", (e) => console.error("tripping core worker:", e))
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
    onMessage: (cb) => (handler = cb),
    poll,
    terminate: () => {
      replies.port1.close()
      void w.terminate()
    },
  }
}
