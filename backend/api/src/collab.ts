import { Database } from "@hocuspocus/extension-database"
import { Redis as RedisSync } from "@hocuspocus/extension-redis"
import { Server } from "@hocuspocus/server"
import { connect } from "emul-shared/redis"
import { ROOM_ID, ROOM_TTL_SECONDS } from "emul-shared/room"

const redis = connect()
const key = (room: string) => `collab:${room}`

const server = new Server({
  port: Number(process.env.PORT ?? 8788),
  quiet: true,
  debounce: 2000,
  maxDebounce: 10000,
  websocketOptions: { maxPayload: 32 * 1024 * 1024 },
  async onConnect({ documentName }) {
    if (!ROOM_ID.test(documentName)) throw new Error("not a room")
  },
  extensions: [
    new RedisSync({ redis }),
    new Database({
      fetch: async ({ documentName }) => {
        const state = await redis.getBuffer(key(documentName))
        return state ? new Uint8Array(state) : null
      },
      store: async ({ documentName, state }) => {
        await redis.set(key(documentName), Buffer.from(state), "EX", ROOM_TTL_SECONDS)
      },
    }),
  ],
})

await server.listen()

for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () =>
    server
      .destroy()
      .then(() => redis.quit())
      .then(() => process.exit(0)),
  )
