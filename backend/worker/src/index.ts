/**
 * Worker: takes jobs off the Redis queue the API fills and leaves their files in S3.
 *
 *   pnpm worker        (WORKER_CONCURRENCY jobs at once, 2 by default)
 */
import { Worker } from "bullmq"
import { QUEUE, jobKeys, type JobData, type JobResult } from "emul-shared/jobs"
import { connect } from "emul-shared/redis"
import { checkBucket, putJson } from "emul-shared/s3"
import { handlers } from "./handlers.ts"

await checkBucket()

const worker = new Worker<JobData, JobResult>(
  QUEUE,
  async (job) => {
    // `result.json` sits next to the files so the outcome outlives the job's hour in Redis, failures included.
    const started = Date.now()
    const done = (ok: boolean, artifacts: JobResult["artifacts"]): JobResult => ({ ok, artifacts, finishedAt: new Date().toISOString(), durationMs: Date.now() - started })
    try {
      const result = done(true, await handlers[job.data.kind](job))
      await putJson(jobKeys(job.id!).result, result)
      return result
    } catch (err) {
      await putJson(jobKeys(job.id!).result, { ...done(false, []), error: (err as Error).message }).catch(() => {})
      throw err
    }
  },
  { connection: connect(), concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2) },
)
worker.on("completed", (job) => console.log(`job ${job.id} (${job.data.kind}) done`))
worker.on("failed", (job, err) => console.error(`job ${job?.id} (${job?.data.kind}) failed: ${err.message}`))
worker.on("error", (err) => console.error(err))
console.log(`worker on queue "${QUEUE}"`)

// The container's PID 1 gets SIGTERM from the orchestrator; finish the running jobs and exit.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => worker.close().then(() => process.exit(0)))
