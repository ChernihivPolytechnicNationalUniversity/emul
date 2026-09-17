import { JOB_KINDS, type JobData } from "emul-shared/jobs"
import { presignGet } from "emul-shared/s3"
import type { FastifyInstance } from "fastify"

/** Enqueue a job and poll its state; the worker does the work. */
export async function jobs(app: FastifyInstance) {
  app.post<{ Body: JobData }>(
    "/jobs",
    { schema: { body: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: JOB_KINDS }, payload: {} } } } },
    async (req, reply) => {
      const job = await app.queue.add(req.body.kind, req.body)
      return reply.code(202).send({ ok: true, id: job.id })
    },
  )

  // A finished job lists its files with presigned URLs: the browser downloads from the store directly
  // (the bucket stays private, the URL expires), nothing streams through the API.
  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const job = await app.queue.getJob(req.params.id)
    if (!job) return reply.code(404).send({ ok: false, error: "not found" })
    const artifacts = await Promise.all(
      (job.returnvalue?.artifacts ?? []).map(async (a) => ({ ...a, key: undefined, url: await presignGet(a.key, a.name) })),
    )
    return { ok: true, id: job.id, state: await job.getState(), artifacts, error: job.failedReason || null }
  })
}
