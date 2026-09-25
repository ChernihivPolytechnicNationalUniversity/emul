import { Queue } from "bullmq"
import { ulid } from "ulid"
import { connect } from "./redis.ts"
import type { BuildOptions, Target } from "./source.ts"

export { DEFAULT_OPT, OPT_LEVELS, SOURCE_LIMITS, TARGETS, isOptLevel, sourcePath, type BuildOptions, type OptLevel, type SourceFile, type Target } from "./source.ts"

/** The contract between the API (producer) and the worker (consumer). */
export const QUEUE = "jobs"

/**
 * Job ids are ULIDs, not BullMQ's counter: they sort by time and never repeat after a Redis
 * reset, so `jobs/<id>/` prefixes in S3 stay unique for as long as the objects live.
 */
export const newJobId = () => ulid()

/** `echo` lists the project back (a smoke test); `build` compiles it into `firmware.elf`. */
export type JobKind = "echo" | "build"
export const JOB_KINDS: JobKind[] = ["echo", "build"]

/** The files each kind may leave in `out/`; the API presigns a PUT for each before the job runs. */
export const OUTPUTS: Record<JobKind, string[]> = {
  echo: ["build.log"],
  build: ["build.log", "firmware.elf", "firmware.map"],
}

/**
 * What the worker gets: the project as presigned GET URLs and its outputs as presigned PUT
 * URLs, so the worker holds no store credentials at all. It runs a compiler over code it did
 * not write; a `.incbin "/proc/1/environ"` in that code must find nothing worth taking.
 */
export type JobData = {
  kind: JobKind
  target: Target
  /** How to compile (a `build` job): the optimization level. */
  options?: BuildOptions
  sources: { path: string; url: string }[]
  /** By output name, e.g. `firmware.elf`. */
  outputs: Record<string, string>
  /** Where `result.json` goes. */
  result: string
}

/** How long a job's URLs stay valid: it may wait in the queue, then run for a while. */
export const JOB_URL_TTL = 60 * 60

/** What `input/project.json` records about the project a job was given. */
export type ProjectManifest = {
  target: Target
  options?: BuildOptions
  createdAt: string
  files: { path: string; size: number; sha256: string }[]
}

/** A file a finished job left in `out/`. */
export type Artifact = { name: string; key: string; size: number; contentType: string }

/**
 * What a finished job leaves behind (also written to `result.json` next to the files).
 * `ok: false` with a log is a job that ran and found the project wanting (compile errors);
 * a job that could not run at all fails in BullMQ instead and has no result.
 */
export type JobResult = {
  ok: boolean
  artifacts: Artifact[]
  error?: string
  finishedAt: string
  durationMs: number
}

/** What a handler answers with; the worker adds the timing. */
export type Outcome = Pick<JobResult, "ok" | "artifacts" | "error">

/**
 * S3 layout, one prefix per job (a lifecycle rule expires `jobs/` after 7 days):
 *
 *   jobs/<id>/input/project.json   manifest
 *   jobs/<id>/input/src/<path>     sources as sent, paths sanitized by `sourcePath`
 *   jobs/<id>/out/<name>           firmware.elf, firmware.map, build.log, …
 *   jobs/<id>/result.json          the JobResult
 */
export const jobKeys = (jobId: string) => ({
  manifest: `jobs/${jobId}/input/project.json`,
  source: (path: string) => `jobs/${jobId}/input/src/${path}`,
  out: (name: string) => `jobs/${jobId}/out/${name}`,
  result: `jobs/${jobId}/result.json`,
})

export function createQueue() {
  return new Queue<JobData, JobResult>(QUEUE, {
    connection: connect(),
    defaultJobOptions: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 }, attempts: 1 },
  })
}
