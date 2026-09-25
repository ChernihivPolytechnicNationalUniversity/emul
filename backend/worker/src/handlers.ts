import type { Job } from "bullmq"
import { jobKeys, type Artifact, type JobData, type JobKind, type Outcome } from "emul-shared/jobs"
import type { SourceFile } from "emul-shared/source"
import { build } from "./build.ts"
import { synth } from "./synth.ts"
import { download, upload } from "./store.ts"

type Handler = (job: Job<JobData>) => Promise<Outcome>

/** The project, fetched by the job's presigned URLs. */
async function sources(job: Job<JobData>): Promise<SourceFile[]> {
  return Promise.all(job.data.sources.map(async (s) => ({ path: s.path, content: (await download(s.url)).toString("utf8") })))
}

/** Puts one file into the job's `out/` by its presigned URL and describes it for the result. */
async function emit(job: Job<JobData>, name: string, body: Buffer | string, contentType: string): Promise<Artifact> {
  const url = job.data.outputs[name]
  if (!url) throw new Error(`no output URL for ${name}`)
  await upload(url, body, contentType)
  return { name, key: jobKeys(job.id!).out(name), size: Buffer.byteLength(body), contentType }
}

const TEXT = "text/plain; charset=utf-8"

/**
 * One handler per job kind, each answering with the files it left in `out/` and whether the
 * project passed. A thrown error is the service's failure, not the project's.
 */
export const handlers: Record<JobKind, Handler> = {
  /** Walks the project like a build would and leaves a log: a smoke test of the pipeline. */
  async echo(job) {
    const files = await sources(job)
    const log = [`echo for ${job.data.target}`, ...files.map((f) => `  ${f.path}  ${Buffer.byteLength(f.content)} B`)].join("\n") + "\n"
    return { ok: true, artifacts: [await emit(job, "build.log", log, TEXT)] }
  },
  /** Compile the project for its chip; a compile error is `ok: false` with the log. */
  async build(job) {
    if (!job.data.target) throw new Error("a build job needs a target")
    const out = await build(job.data.target, await sources(job), job.data.options)
    const artifacts = [await emit(job, "build.log", out.log, TEXT)]
    if (out.elf) artifacts.push(await emit(job, "firmware.elf", out.elf, "application/octet-stream"))
    if (out.map) artifacts.push(await emit(job, "firmware.map", out.map, TEXT))
    return { ok: out.ok, artifacts, error: out.error }
  },
  async synth(job) {
    const out = await synth(await sources(job), job.data.options)
    const artifacts = [await emit(job, "build.log", out.log, TEXT)]
    if (out.netlist) artifacts.push(await emit(job, "netlist.json", JSON.stringify(out.netlist), "application/json"))
    return { ok: out.ok, artifacts, error: out.error }
  },
}
