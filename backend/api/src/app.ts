import { createQueue, QUEUES, type QueueName } from "emul-shared/jobs"
import { connect, type Redis } from "emul-shared/redis"
import Fastify from "fastify"
import { health } from "./routes/health.ts"
import { jobs } from "./routes/jobs.ts"

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis
    queues: Record<QueueName, ReturnType<typeof createQueue>>
  }
}

/** The app without a listener, so tests can `app.inject()` it without opening a port. */
export function build() {
  // 8 MB body: a CubeIDE project with its headers, not just a main.c.
  const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 })
  app.decorate("redis", connect())
  app.decorate("queues", Object.fromEntries(QUEUES.map((name) => [name, createQueue(name)])) as Record<QueueName, ReturnType<typeof createQueue>>)
  app.addHook("onClose", async () => {
    await Promise.all(Object.values(app.queues).map((q) => q.close()))
    await app.redis.quit()
  })
  app.register(health)
  // Same host as the site: the ingress sends /api/* here without stripping the prefix.
  app.register(jobs, { prefix: "/api" })
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, error: "not found" }))
  return app
}
