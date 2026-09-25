import * as React from "react"
import { toast } from "sonner"
import {
  deleteProject,
  lastProject,
  listProjects,
  newId,
  parseSchematic,
  readProject,
  readShare,
  sharedFragment,
  setLastProject,
  thumbnail,
  writeProject,
  type ProjectMeta,
} from "@/project/project-store"
import { emptySchematic, type Schematic } from "@/schematic/types"
import { useEvent } from "./use-event"

const DELAY = 500
const CHANNEL = "emul-projects"
const TAB_KEY = "emul-project"

type Message = { id: string; at: number } | { list: true }

export type Projects = {
  current: ProjectMeta | null
  list: ProjectMeta[]
  shared: boolean
  keep: (doc: Schematic) => Promise<void>
  onChange: (doc: Schematic) => void
  create: (name: string, doc?: Schematic) => Promise<void>
  open: (id: string) => Promise<void>
  rename: (id: string, name: string) => Promise<void>
  duplicate: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  read: (id: string) => Promise<{ meta: ProjectMeta; doc: Schematic } | null>
}

export function uniqueName(base: string, list: readonly ProjectMeta[]): string {
  const taken = new Set(list.map((p) => p.name))
  if (!taken.has(base)) return base
  for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`
}

function tabProject(): string | null {
  try {
    return sessionStorage.getItem(TAB_KEY)
  } catch {
    return null
  }
}

function setTabProject(id: string) {
  try {
    sessionStorage.setItem(TAB_KEY, id)
  } catch {
    return
  }
}

export function useProjects(load: (doc: Schematic) => void): Projects {
  const [current, setCurrent] = React.useState<ProjectMeta | null>(null)
  const [list, setList] = React.useState<ProjectMeta[]>([])
  const [shared, setShared] = React.useState(false)
  const viewing = React.useRef(false)
  const meta = React.useRef<ProjectMeta | null>(null)
  const stored = React.useRef(false)
  const saved = React.useRef<string | null>(null)
  const pending = React.useRef<Schematic | null>(null)
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const ready = React.useRef(false)
  const stale = React.useRef(false)
  const warned = React.useRef(false)
  const channel = React.useRef<BroadcastChannel | null>(null)

  const warn = useEvent((e: unknown) => {
    if (warned.current) return
    warned.current = true
    toast.warning("The bench is not being saved", {
      description: `This browser refused its storage (${(e as Error)?.message ?? e}). Use File → Save to file to keep your work.`,
      duration: Infinity,
    })
  })

  const post = (m: Message) => channel.current?.postMessage(m)

  const refresh = useEvent(async () => setList(await listProjects()))

  const show = (m: ProjectMeta, isStored: boolean) => {
    meta.current = m
    stored.current = isStored
    setCurrent(m)
    setTabProject(m.id)
    document.title = `${m.name} – εmul`
  }

  const flush = useEvent(async () => {
    clearTimeout(timer.current)
    const doc = pending.current
    pending.current = null
    const m = meta.current
    if (!doc || !m || !ready.current || viewing.current) return
    const text = JSON.stringify(doc)
    if (text === saved.current) return
    if (!stored.current && !doc.objects.length && !doc.library?.length) return
    saved.current = text
    const next: ProjectMeta = { ...m, at: Date.now(), thumb: thumbnail(doc) }
    meta.current = next
    const first = !stored.current
    stored.current = true
    try {
      await writeProject(next, text)
      if (first) await setLastProject(next.id)
      if (meta.current?.id === next.id) setCurrent(meta.current)
      post({ id: next.id, at: next.at })
      void refresh()
    } catch (e) {
      warn(e)
    }
  })

  const leaveShare = () => {
    if (!viewing.current) return
    viewing.current = false
    setShared(false)
    if (sharedFragment()) history.replaceState(null, "", location.pathname + location.search)
  }

  const enter = (m: ProjectMeta, text: string | null, doc: Schematic, isStored: boolean) => {
    leaveShare()
    clearTimeout(timer.current)
    pending.current = null
    saved.current = text
    show(m, isStored)
    load(doc)
    if (isStored) void setLastProject(m.id).catch(warn)
  }

  const open = useEvent(async (id: string) => {
    if (meta.current?.id === id) return
    await flush()
    const p = await readProject(id)
    const doc = p && parseSchematic(p.text)
    if (!p || !doc) {
      toast.error("That project could not be opened")
      return void refresh()
    }
    enter(p.meta, p.text, doc, true)
  })

  const create = useEvent(async (name: string, doc: Schematic = emptySchematic()) => {
    await flush()
    const m = meta.current
    if (m && !stored.current && !viewing.current && !doc.objects.length) return
    const now = Date.now()
    const all = await listProjects()
    const next: ProjectMeta = { id: newId(), name: uniqueName(name, all), created: now, at: now, thumb: thumbnail(doc) }
    const text = JSON.stringify(doc)
    const keep = doc.objects.length > 0 || !!doc.library?.length
    if (keep) {
      await writeProject(next, text)
      post({ list: true })
      void refresh()
    }
    enter(next, keep ? text : null, doc, keep)
  })

  const rename = useEvent(async (id: string, name: string) => {
    const clean = name.trim()
    if (!clean) return
    const m = meta.current?.id === id ? meta.current : (await readProject(id))?.meta
    if (!m || m.name === clean) return
    const next = { ...m, name: clean }
    if (meta.current?.id === id) show(next, stored.current)
    if (meta.current?.id !== id || stored.current) await writeProject(next)
    post({ list: true })
    void refresh()
  })

  const duplicate = useEvent(async (id: string) => {
    if (meta.current?.id === id) await flush()
    const p = await readProject(id)
    if (!p) return
    const now = Date.now()
    const next: ProjectMeta = { ...p.meta, id: newId(), name: uniqueName(`${p.meta.name} copy`, await listProjects()), created: now, at: now }
    await writeProject(next, p.text)
    post({ list: true })
    void refresh()
  })

  const remove = useEvent(async (id: string) => {
    const p = await readProject(id)
    await deleteProject(id)
    post({ list: true })
    const rest = await listProjects()
    setList(rest)
    if (meta.current?.id === id) {
      if (rest.length) {
        const q = await readProject(rest[0].id)
        const doc = q && parseSchematic(q.text)
        if (q && doc) enter(q.meta, q.text, doc, true)
      } else {
        const now = Date.now()
        enter({ id: newId(), name: "Untitled", created: now, at: now }, null, emptySchematic(), false)
      }
    }
    if (!p) return
    toast(`Deleted “${p.meta.name}”`, {
      action: {
        label: "Undo",
        onClick: () =>
          void writeProject(p.meta, p.text)
            .then(() => {
              post({ list: true })
              return refresh()
            })
            .catch(warn),
      },
    })
  })

  const view = useEvent(async (fragment: string) => {
    const got = await readShare(fragment)
    if (!got) {
      toast.error("That link does not hold a bench", { description: "It may have been cut short when it was sent." })
      return false
    }
    await flush()
    const now = Date.now()
    enter({ id: newId(), name: got.name ?? "Shared bench", created: now, at: now }, null, got.doc, false)
    viewing.current = true
    setShared(true)
    return true
  })

  const keep = useEvent(async (doc: Schematic) => {
    const m = meta.current
    if (!m || !viewing.current) return
    const now = Date.now()
    const next: ProjectMeta = { ...m, name: uniqueName(m.name, await listProjects()), created: now, at: now, thumb: thumbnail(doc) }
    const text = JSON.stringify(doc)
    await writeProject(next, text)
    await setLastProject(next.id)
    leaveShare()
    saved.current = text
    show(next, true)
    post({ list: true })
    void refresh()
    toast.success(`Saved to your projects as “${next.name}”`)
  })

  const read = useEvent(async (id: string) => {
    if (meta.current?.id === id) await flush()
    const p = await readProject(id)
    const doc = p && parseSchematic(p.text)
    return p && doc ? { meta: p.meta, doc } : null
  })

  const reload = useEvent(async () => {
    const m = meta.current
    if (!m) return
    const p = await readProject(m.id)
    const doc = p && parseSchematic(p.text)
    if (!p || !doc || p.text === saved.current) return
    enter(p.meta, p.text, doc, true)
  })

  const boot = useEvent(async () => {
    const all = await listProjects()
    setList(all)
    const fragment = sharedFragment()
    if (fragment && (await view(fragment))) return
    for (const id of [tabProject(), await lastProject()]) {
      if (!id || !all.some((p) => p.id === id)) continue
      const p = await readProject(id)
      const doc = p && parseSchematic(p.text)
      if (!p || !doc) continue
      enter(p.meta, p.text, doc, true)
      if (doc.objects.length)
        toast(`“${p.meta.name}” is back`, { description: "Projects are kept in this browser only. File → Save to file keeps a copy on disk." })
      return
    }
    const now = Date.now()
    enter({ id: newId(), name: uniqueName("Untitled", all), created: now, at: now }, null, emptySchematic(), false)
  })

  const booted = React.useRef(false)
  React.useEffect(() => {
    if (!booted.current) {
      booted.current = true
      void navigator.storage?.persist?.().catch(() => {})
      boot()
        .catch((e) => {
          warn(e)
          const now = Date.now()
          show({ id: newId(), name: "Untitled", created: now, at: now }, false)
        })
        .finally(() => {
          ready.current = true
          pending.current = null
        })
    }

    const ch = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL)
    channel.current = ch
    if (ch)
      ch.onmessage = (e: MessageEvent<Message>) => {
        const m = e.data
        if ("list" in m) return void refresh().catch(warn)
        void refresh().catch(warn)
        if (m.id === meta.current?.id && m.at !== meta.current.at) stale.current = true
      }
    const onVisibility = () => {
      if (document.visibilityState === "hidden") return void flush()
      if (!stale.current) return
      stale.current = false
      clearTimeout(timer.current)
      pending.current = null
      void reload().catch(warn)
    }
    const onHide = () => void flush()
    const onHash = () => {
      const fragment = sharedFragment()
      if (fragment) void view(fragment).catch(warn)
    }
    window.addEventListener("hashchange", onHash)
    document.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("pagehide", onHide)
    return () => {
      void flush()
      ch?.close()
      channel.current = null
      document.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("pagehide", onHide)
      window.removeEventListener("hashchange", onHash)
    }
  }, [boot, flush, refresh, reload, warn, view])

  const onChange = React.useCallback(
    (doc: Schematic) => {
      pending.current = doc
      clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), DELAY)
    },
    [flush],
  )

  return { current, list, shared, keep, onChange, create, open, rename, duplicate, remove, read }
}
