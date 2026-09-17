import { createHash } from "node:crypto"
import { JOB_KINDS, JOB_URL_TTL, OUTPUTS, SOURCE_LIMITS, TARGETS, jobKeys, newJobId, sourcePath, type JobData, type JobKind, type ProjectManifest, type SourceFile, type Target } from "emul-shared/jobs"
import { presignGet, presignRead, presignWrite, putJson, putObject } from "emul-shared/s3"
import type { FastifyInstance } from "fastify"

type NewJob = { kind: JobKind; target: Target; files: SourceFile[] }

/** Enqueue a job over a project and poll its state; the worker does the work. */
export async function jobs(app: FastifyInstance) {
  app.post<{ Body: NewJob }>(
    "/jobs",
    {
      schema: {
        body: {
          type: "object",
          required: ["kind", "target", "files"],
          properties: {
            kind: { type: "string", enum: JOB_KINDS },
            target: { type: "string", enum: TARGETS },
            files: {
              type: "array",
              minItems: 1,
              maxItems: SOURCE_LIMITS.files,
              items: {
                type: "object",
                required: ["path", "content"],
                properties: { path: { type: "string", maxLength: 512 }, content: { type: "string", maxLength: SOURCE_LIMITS.fileBytes } },
              },
            },
          },
        },
      },
    },
    async (req, reply) => {
      const { files, kind, target } = req.body
      // The project goes to S3 under the job's prefix; Redis carries the kind, the target and URLs.
      const seen = new Set<string>()
      const manifest: ProjectManifest = { target, createdAt: new Date().toISOString(), files: [] }
      const sources: SourceFile[] = []
      for (const file of files) {
        const path = sourcePath(file.path)
        if (!path) return reply.code(400).send({ ok: false, error: `not a source path: ${file.path}` })
        if (seen.has(path)) return reply.code(400).send({ ok: false, error: `duplicate path: ${path}` })
        seen.add(path)
        const size = Buffer.byteLength(file.content)
        if (size > SOURCE_LIMITS.fileBytes) return reply.code(400).send({ ok: false, error: `too large: ${path}` })
        manifest.files.push({ path, size, sha256: createHash("sha256").update(file.content).digest("hex") })
        sources.push({ path, content: file.content })
      }
      const id = newJobId()
      const keys = jobKeys(id)
      await Promise.all(sources.map((f) => putObject(keys.source(f.path), f.content, "text/plain; charset=utf-8")))
      await putJson(keys.manifest, manifest)
      const data: JobData = {
        kind,
        target,
        sources: await Promise.all(sources.map(async (f) => ({ path: f.path, url: await presignRead(keys.source(f.path), JOB_URL_TTL) }))),
        outputs: Object.fromEntries(await Promise.all(OUTPUTS[kind].map(async (name) => [name, await presignWrite(keys.out(name), JOB_URL_TTL)]))),
        result: await presignWrite(keys.result, JOB_URL_TTL),
      }
      const job = await app.queue.add(kind, data, { jobId: id })
      return reply.code(202).send({ ok: true, id: job.id })
    },
  )

  // A finished job lists its files with presigned URLs: the browser downloads from the store directly
  // (the bucket stays private, the URL expires), nothing streams through the API.
  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const job = await app.queue.getJob(req.params.id)
    if (!job) return reply.code(404).send({ ok: false, error: "not found" })
    const result = job.returnvalue
    const artifacts = await Promise.all(
      (result?.artifacts ?? []).map(async ({ key, ...a }) => ({ ...a, url: await presignGet(key, a.name) })),
    )
    return {
      ok: true,
      id: job.id,
      kind: job.data.kind,
      target: job.data.target,
      state: await job.getState(),
      result: result ? { ok: result.ok, error: result.error ?? null, finishedAt: result.finishedAt, durationMs: result.durationMs } : null,
      artifacts,
      error: job.failedReason || null,
    }
  })
}
