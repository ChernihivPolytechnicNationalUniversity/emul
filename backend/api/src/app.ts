import { createQueue } from "emul-shared/jobs"
import { connect, type Redis } from "emul-shared/redis"
import Fastify from "fastify"
import { health } from "./routes/health.ts"
import { jobs } from "./routes/jobs.ts"

declare module "fastify" {
  interface FastifyInstance {
    redis: Redis
    queue: ReturnType<typeof createQueue>
  }
}

/** The app without a listener, so tests can `app.inject()` it without opening a port. */
export function build() {
  // 8 MB body: a CubeIDE project with its headers, not just a main.c.
  const app = Fastify({ logger: true, bodyLimit: 8 * 1024 * 1024 })
  app.decorate("redis", connect())
  app.decorate("queue", createQueue())
  app.addHook("onClose", async () => {
    await app.queue.close()
    await app.redis.quit()
  })
  app.register(health)
  app.register(jobs)
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ ok: false, error: "not found" }))
  return app
}
