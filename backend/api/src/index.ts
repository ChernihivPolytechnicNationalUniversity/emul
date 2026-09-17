/**
 * API: the second container next to the static site, the ingress routes /api/* here.
 * It only enqueues work and serves results; the worker container does the work.
 *
 *   pnpm api        (listens on PORT, 8787 by default)
 */
import { checkBucket } from "emul-shared/s3"
import { build } from "./app.ts"

await checkBucket()
const app = build()
await app.listen({ port: Number(process.env.PORT ?? 8787), host: "0.0.0.0" })

// The container's PID 1 gets SIGTERM from the orchestrator; drain and exit instead of being killed.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => app.close().then(() => process.exit(0)))
