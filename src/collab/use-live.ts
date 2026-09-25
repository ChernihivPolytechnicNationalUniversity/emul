import * as React from "react"
import { HocuspocusProvider } from "@hocuspocus/provider"
import * as Y from "yjs"
import { COLLAB_PATH, ROOM_ELEMENTS, ROOM_META } from "emul-shared/room"
import { useEvent } from "@/hooks/use-event"
import type { Point, Schematic } from "@/schematic/types"
import { join, split } from "./elements"
import { anonymousIdentity, withAnimal, type Identity } from "./identity"

export type Move = { ids: string[]; dx: number; dy: number }
export type Peer = Identity & { clientId: number; cursor: Point | null; moving: Move | null; wire: Point[] | null }
export type LiveStatus = "off" | "connecting" | "live" | "offline"

export type Live = {
  room: string | null
  status: LiveStatus
  host: boolean
  me: Identity
  peers: Peer[]
  link: string | null
  start: (name: string, doc: Schematic) => Promise<void>
  join: (room: string) => Promise<{ name: string; doc: Schematic } | null>
  leave: () => void
  onChange: (doc: Schematic) => void
  onPointer: (point: Point | null) => void
  onMove: (move: Move | null) => void
  onWire: (points: Point[] | null) => void
  linkFor: () => string | null
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
const ROOM_PATH = /^\/r\/([A-Za-z0-9]{10})\/?$/
const HOST_KEY = "emul-live"
const CURSOR_MS = 50
const MAX_IDS = 300
const MAX_POINTS = 200

export const roomFromPath = (path = location.pathname) => ROOM_PATH.exec(path)?.[1] ?? null
export const roomLink = (room: string) => `${location.origin}/r/${room}`

function newRoomId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => ALPHABET[b % ALPHABET.length]).join("")
}

export function hostedRoom(): string | null {
  try {
    return sessionStorage.getItem(HOST_KEY)
  } catch {
    return null
  }
}

function setHostedRoom(room: string | null) {
  try {
    if (room) sessionStorage.setItem(HOST_KEY, room)
    else sessionStorage.removeItem(HOST_KEY)
  } catch {
    return
  }
}

type Session = { room: string; ydoc: Y.Doc; elements: Y.Map<string>; meta: Y.Map<string>; provider: HocuspocusProvider; ready: boolean }

export function useLive(merge: (doc: Schematic) => void): Live {
  const [me, setMe] = React.useState(anonymousIdentity)
  const meRef = React.useRef(me)
  const [room, setRoom] = React.useState<string | null>(null)
  const [status, setStatus] = React.useState<LiveStatus>("off")
  const [host, setHost] = React.useState(false)
  const [peers, setPeers] = React.useState<Peer[]>([])
  const session = React.useRef<Session | null>(null)
  const frame = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const cursorAt = React.useRef(0)
  const cursorTimer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const current = () => {
    const s = session.current
    return s ? join(new Map(s.elements.entries())) : null
  }

  const push = (s: Session, doc: Schematic) => {
    const next = split(doc)
    s.ydoc.transact(() => {
      for (const [k, v] of next) if (s.elements.get(k) !== v) s.elements.set(k, v)
      for (const k of [...s.elements.keys()]) if (!next.has(k)) s.elements.delete(k)
    })
  }

  const teardown = useEvent(() => {
    const s = session.current
    session.current = null
    clearTimeout(frame.current)
    clearTimeout(cursorTimer.current)
    s?.provider.destroy()
    s?.ydoc.destroy()
    setRoom(null)
    setStatus("off")
    setHost(false)
    setPeers([])
  })

  const leave = useEvent(() => {
    teardown()
    setHostedRoom(null)
    if (roomFromPath()) history.replaceState(null, "", "/")
  })

  const connect = (id: string) =>
    new Promise<Session>((resolve, reject) => {
      teardown()
      const ydoc = new Y.Doc()
      const elements = ydoc.getMap<string>(ROOM_ELEMENTS)
      const meta = ydoc.getMap<string>(ROOM_META)
      let first = true
      const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${COLLAB_PATH}`
      const provider = new HocuspocusProvider({
        url,
        name: id,
        document: ydoc,
        onStatus: ({ status: s }) => {
          if (session.current?.provider !== provider) return
          setStatus(s === "connected" ? (first ? "connecting" : "live") : s === "connecting" ? "connecting" : "offline")
        },
        onSynced: ({ state }) => {
          if (!state || !first) return
          first = false
          setStatus("live")
          resolve(s)
        },
        onAwarenessChange: ({ states }) => {
          if (session.current?.provider !== provider) return
          const own = provider.awareness?.clientID ?? 0
          const others = states
            .filter((st) => st.clientId !== own && st.user)
            .map((st) => ({
              ...(st.user as Identity),
              clientId: st.clientId,
              cursor: (st.cursor as Point | null) ?? null,
              moving: (st.moving as Move | null) ?? null,
              wire: (st.wire as Point[] | null) ?? null,
            }))
          setPeers(others)
          if (others.some((p) => p.animal === meRef.current.animal && p.clientId < own)) {
            const next = withAnimal(meRef.current, new Set(others.map((p) => p.animal)))
            meRef.current = next
            setMe(next)
            provider.awareness?.setLocalStateField("user", next)
          }
        },
      })
      const s: Session = { room: id, ydoc, elements, meta, provider, ready: false }
      session.current = s
      setRoom(id)
      setStatus("connecting")
      provider.awareness?.setLocalStateField("user", meRef.current)
      elements.observe((_e, tx) => {
        if (tx.local) return
        clearTimeout(frame.current)
        frame.current = setTimeout(() => {
          const doc = current()
          if (doc && session.current === s) merge(doc)
        }, 16)
      })
      setTimeout(() => {
        if (first && session.current === s) reject(new Error("the live service did not answer"))
      }, 15000)
    })

  const start = useEvent(async (name: string, doc: Schematic) => {
    const id = hostedRoom() ?? newRoomId()
    const s = await connect(id)
    setHost(true)
    setHostedRoom(id)
    s.meta.set("name", name)
    if (s.elements.size === 0) push(s, doc)
    else merge(current()!)
    s.ready = true
  })

  const joinRoom = useEvent(async (id: string) => {
    const s = await connect(id)
    if (s.elements.size === 0) {
      leave()
      return null
    }
    s.ready = true
    return { name: s.meta.get("name") ?? "Live bench", doc: current()! }
  })

  const onChange = React.useCallback((doc: Schematic) => {
    const s = session.current
    if (s?.ready) push(s, doc)
  }, [])

  const pending = React.useRef<Record<string, unknown>>({})
  const share = React.useCallback((field: string, value: unknown, now: boolean) => {
    const s = session.current
    if (!s?.provider.awareness) return
    pending.current[field] = value
    const send = () => {
      cursorAt.current = performance.now()
      const fields = pending.current
      pending.current = {}
      for (const [k, v] of Object.entries(fields)) s.provider.awareness?.setLocalStateField(k, v)
    }
    clearTimeout(cursorTimer.current)
    const wait = CURSOR_MS - (performance.now() - cursorAt.current)
    if (now || wait <= 0) send()
    else cursorTimer.current = setTimeout(send, wait)
  }, [])

  const onPointer = React.useCallback((point: Point | null) => share("cursor", point, false), [share])
  const onMove = React.useCallback(
    (move: Move | null) => share("moving", move && { ...move, ids: move.ids.slice(0, MAX_IDS) }, move === null),
    [share],
  )
  const onWire = React.useCallback(
    (points: Point[] | null) => share("wire", points && points.slice(0, MAX_POINTS), points === null),
    [share],
  )

  React.useEffect(() => () => teardown(), [teardown])

  return { room, status, host, me, peers, link: room ? roomLink(room) : null, linkFor: () => (session.current ? roomLink(session.current.room) : null), start, join: joinRoom, leave, onChange, onPointer, onMove, onWire }
}
