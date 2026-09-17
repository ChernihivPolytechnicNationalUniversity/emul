/**
 * Worker: takes jobs off the Redis queue the API fills and leaves their artifacts in S3.
 *
 *   pnpm worker        (WORKER_CONCURRENCY jobs at once, 2 by default)
 */
import { Worker } from "bullmq"
import { QUEUE, type JobData, type JobResult } from "emul-shared/jobs"
import { connect } from "emul-shared/redis"
import { checkBucket } from "emul-shared/s3"
import { handlers } from "./handlers.ts"

await checkBucket()

const worker = new Worker<JobData, JobResult>(QUEUE, (job) => handlers[job.data.kind](job), {
  connection: connect(),
  concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
})
worker.on("completed", (job) => console.log(`job ${job.id} (${job.data.kind}) done`))
worker.on("failed", (job, err) => console.error(`job ${job?.id} (${job?.data.kind}) failed: ${err.message}`))
worker.on("error", (err) => console.error(err))
console.log(`worker on queue "${QUEUE}"`)

// The container's PID 1 gets SIGTERM from the orchestrator; finish the running jobs and exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => worker.close().then(() => process.exit(0)))
