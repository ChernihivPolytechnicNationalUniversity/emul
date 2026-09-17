import { Queue } from "bullmq"
import { ulid } from "ulid"
import { connect } from "./redis.ts"

/** The contract between the API (producer) and the worker (consumer). */
export const QUEUE = "jobs"

/**
 * Job ids are ULIDs, not BullMQ's counter: they sort by time and never repeat after a Redis
 * reset, so `jobs/<id>/` prefixes in S3 stay unique for as long as the objects live.
 */
export const newJobId = () => ulid()

/** Chips the emulator has a profile for (`src/mcu/chip.ts`); a job targets one of them. */
export const TARGETS = ["stm32f429zi", "stm32f746ig"] as const
export type Target = (typeof TARGETS)[number]

/** One member per kind of work; the worker switches on `kind`. The project itself is in S3. */
export type JobData = { kind: "echo"; target: Target }
export type JobKind = JobData["kind"]
export const JOB_KINDS: JobKind[] = ["echo"]

/** A source file as the client sends it: a relative path inside the project and its text. */
export type SourceFile = { path: string; content: string }

/** What `input/project.json` records about the project a job was given. */
export type ProjectManifest = {
  target: Target
  createdAt: string
  files: { path: string; size: number; sha256: string }[]
}

/** A file a finished job left in `out/`. */
export type Artifact = { name: string; key: string; size: number; contentType: string }

/** What a finished job leaves behind (also written to `result.json` next to the files). */
export type JobResult = {
  ok: boolean
  artifacts: Artifact[]
  finishedAt: string
  durationMs: number
}

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

const SOURCE_EXTENSIONS = new Set([".c", ".h", ".cpp", ".hpp", ".cc", ".s", ".S", ".ld", ".txt", ".md"])
export const SOURCE_LIMITS = { files: 200, fileBytes: 1024 * 1024 }

/**
 * A client path made safe for an S3 key and a build directory: relative, no `..`, plain
 * characters, a source extension. Returns null when it is anything else.
 */
export function sourcePath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".")
  if (parts.length === 0 || parts.length > 8) return null
  if (parts.some((p) => p === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p))) return null
  const name = parts[parts.length - 1]!
  const ext = name.slice(name.lastIndexOf("."))
  if (!SOURCE_EXTENSIONS.has(ext)) return null
  return parts.join("/")
}

export function createQueue() {
  return new Queue<JobData, JobResult>(QUEUE, {
    connection: connect(),
    defaultJobOptions: { removeOnComplete: { age: 3600 }, removeOnFail: { age: 24 * 3600 }, attempts: 1 },
  })
}
