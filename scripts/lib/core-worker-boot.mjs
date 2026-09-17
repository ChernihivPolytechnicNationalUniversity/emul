// Bootstraps a core worker under node: registers tsx in this thread, then loads the TypeScript entry.
import { workerData } from "node:worker_threads"
import { register } from "tsx/esm/api"

register({ tsconfig: workerData.tsconfig })
globalThis.__emulReplyPort = workerData.replyPort
await import(workerData.entry)
