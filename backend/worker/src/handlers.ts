import type { Job } from "bullmq"
import { jobKeys, type Artifact, type JobData, type ProjectManifest } from "emul-shared/jobs"
import { getJson, putObject } from "emul-shared/s3"

type Handler<K extends JobData["kind"]> = (job: Job<Extract<JobData, { kind: K }>>) => Promise<Artifact[]>

/** Puts one file into the job's `out/` and describes it for the result. */
async function emit(jobId: string, name: string, body: Buffer | string, contentType: string): Promise<Artifact> {
  const key = jobKeys(jobId).out(name)
  await putObject(key, body, contentType)
  return { name, key, size: Buffer.byteLength(body), contentType }
}

/** One handler per job kind, each answering with the files it left in `out/`; a thrown error fails the job. */
export const handlers: { [K in JobData["kind"]]: Handler<K> } = {
  // Placeholder until the build job lands: walks the project like a build would and leaves a log.
  async echo(job) {
    const manifest = await getJson<ProjectManifest>(jobKeys(job.id!).manifest)
    const log = [`echo for ${manifest.target}`, ...manifest.files.map((f) => `  ${f.path}  ${f.size} B  ${f.sha256.slice(0, 12)}`)].join("\n") + "\n"
    return [await emit(job.id!, "build.log", log, "text/plain; charset=utf-8")]
  },
}
