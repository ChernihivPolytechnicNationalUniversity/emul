import { randomBytes } from "node:crypto"
import { getObject, putObject } from "emul-shared/s3"
import type { FastifyInstance, FastifyRequest } from "fastify"

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ID = /^[A-Za-z0-9]{8}$/
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const PER_HOUR = 60
const key = (id: string) => `shares/${id}.emul`

function newShareId() {
  return Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("")
}

const clientIp = (req: FastifyRequest) => String(req.headers["x-real-ip"] ?? req.ip)

export async function shares(app: FastifyInstance) {
  app.addContentTypeParser("application/zstd", { parseAs: "buffer" }, (_req, body, done) => done(null, body))

  app.post("/shares", async (req, reply) => {
    const body = req.body
    if (!Buffer.isBuffer(body) || body.length < 8 || !body.subarray(0, 4).equals(ZSTD_MAGIC))
      return reply.code(400).send({ ok: false, error: "not an emul project" })
    const bucket = `shares:ip:${clientIp(req)}`
    const count = await app.redis.incr(bucket)
    if (count === 1) await app.redis.expire(bucket, 3600)
    if (count > PER_HOUR) return reply.code(429).send({ ok: false, error: "too many links this hour" })
    const id = newShareId()
    await putObject(key(id), body, "application/zstd")
    return reply.code(201).send({ ok: true, id })
  })

  app.get<{ Params: { id: string } }>("/shares/:id", async (req, reply) => {
    const { id } = req.params
    if (!ID.test(id)) return reply.code(404).send({ ok: false, error: "not found" })
    try {
      const body = await getObject(key(id))
      return reply.type("application/zstd").header("cache-control", "public, max-age=31536000, immutable").send(body)
    } catch (e) {
      if ((e as { name?: string }).name === "NoSuchKey") return reply.code(404).send({ ok: false, error: "not found" })
      throw e
    }
  })
}
