import type { Job } from "bullmq"
import { artifactKey, type JobData, type JobResult } from "emul-shared/jobs"
import { putObject } from "emul-shared/s3"

type Handler<K extends JobData["kind"]> = (job: Job<Extract<JobData, { kind: K }>, JobResult>) => Promise<JobResult>

/** One handler per job kind; a thrown error fails the job with its message. */
export const handlers: { [K in JobData["kind"]]: Handler<K> } = {
  // Placeholder until the build job lands: the payload comes back as a JSON artifact.
  async echo(job) {
    const body = JSON.stringify(job.data.payload)
    const name = "result.json"
    const key = artifactKey(job.id!, name)
    await putObject(key, body, "application/json")
    return { artifacts: [{ name, key, size: Buffer.byteLength(body), contentType: "application/json" }] }
  },
}
