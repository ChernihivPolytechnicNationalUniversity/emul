import { JOB_KINDS, type JobData } from "emul-shared/jobs"
import { getObject } from "emul-shared/s3"
import type { FastifyInstance } from "fastify"

/** Enqueue a job, poll its state, fetch its artifact; the worker does the work. */
export async function jobs(app: FastifyInstance) {
  app.post<{ Body: JobData }>(
    "/jobs",
    { schema: { body: { type: "object", required: ["kind"], properties: { kind: { type: "string", enum: JOB_KINDS }, payload: {} } } } },
    async (req, reply) => {
      const job = await app.queue.add(req.body.kind, req.body)
      return reply.code(202).send({ ok: true, id: job.id })
    },
  )

  app.get<{ Params: { id: string } }>("/jobs/:id", async (req, reply) => {
    const job = await app.queue.getJob(req.params.id)
    if (!job) return reply.code(404).send({ ok: false, error: "not found" })
    return { ok: true, id: job.id, state: await job.getState(), result: job.returnvalue ?? null, error: job.failedReason || null }
  })

  // Streamed through the API rather than a presigned URL, so the bucket can stay private to the cluster.
  app.get<{ Params: { id: string } }>("/jobs/:id/artifact", async (req, reply) => {
    const job = await app.queue.getJob(req.params.id)
    const artifact = job?.returnvalue?.artifact
    if (!artifact) return reply.code(404).send({ ok: false, error: "no artifact" })
    const obj = await getObject(artifact.key)
    reply.header("content-type", obj.contentType ?? artifact.contentType)
    if (obj.size) reply.header("content-length", obj.size)
    reply.header("content-disposition", `attachment; filename="${artifact.key.split("/").pop()}"`)
    return reply.send(obj.body)
  })
}
