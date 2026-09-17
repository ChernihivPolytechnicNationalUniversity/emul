import { Redis } from "ioredis"
export type { Redis }
import { config } from "./config.ts"

/** One connection factory for the app, the queue and the worker. */
export function connect() {
  // BullMQ blocks on its own connections and needs unlimited retries per request.
  return new Redis(config.redisUrl, { maxRetriesPerRequest: null, enableReadyCheck: false })
}
