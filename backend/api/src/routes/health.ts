import type { FastifyInstance } from "fastify"

export async function health(app: FastifyInstance) {
  // 503 when Redis is unreachable, so the orchestrator holds traffic until the queue is back.
  app.get("/healthz", async (_req, reply) => {
    const redis = await app.redis.ping().then(() => "ok", (e: Error) => e.message)
    return reply.code(redis === "ok" ? 200 : 503).send({ ok: redis === "ok", redis })
  })
}
