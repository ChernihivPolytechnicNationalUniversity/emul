import { Queue } from "bullmq"
import { connect } from "./redis.ts"

/** The contract between the API (producer) and the worker (consumer). */
export const QUEUE = "jobs"

/** One member per kind of work; the worker switches on `kind`. */
export type JobData = { kind: "echo"; payload: unknown }
export type JobKind = JobData["kind"]
export const JOB_KINDS: JobKind[] = ["echo"]

/** What a finished job leaves behind: the artifact lives in S3, only its key travels through Redis. */
export type Artifact = { key: string; size: number; contentType: string }
export type JobResult = { artifact?: Artifact }

/** S3 key of a job's artifact; every job's files live under its own prefix. */
export const artifactKey = (jobId: string, name: string) => `jobs/${jobId}/${name}`

export function createQueue() {
  return new Queue<JobData, JobResult>(QUEUE, {
    connection: connect(),
    defaultJobOptions: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 }, attempts: 1 },
  })
}
