import type { CatalogueEntry, ComponentDef, HdlModule, PartDef, PartState, PinDef, PinRef, PlacedObject } from "./types"
import { hdlDef } from "./hdl"
import { withPadClasses } from "./mcu-model"
import * as ICONS from "./icons"
import type { Icon } from "./icons"
import { CATALOGUE } from "./catalogue.gen"
import { PART_FILES } from "./parts"

/**
 * The parts, known two ways. The catalogue (generated, small) names every part, its group, size
 * and icon, and is here from the start: the palette and search run on it. A part's definition
 * (pins, artwork, model) comes from its file the first time it is wanted, so a page carries no
 * definitions up front however many parts there are. getDef stays synchronous: whatever brings
 * parts into a document (opening a project, an example, a paste, a collaborator's change, the
 * simulation worker) first awaits ensureDefs for the ids it holds.
 */

/** What the catalogue knows of a part before its file loads. */
export type PartMeta = Omit<CatalogueEntry, "icon" | "file"> & { icon: Icon }

const icons = ICONS as unknown as Record<string, Icon>

export const catalogue: readonly PartMeta[] = CATALOGUE.map(({ icon, file: _file, ...meta }) => ({ ...meta, icon: icons[icon] }))
const metaById = new Map(catalogue.map((m) => [m.id, m]))
const fileOf = new Map(CATALOGUE.map((e) => [e.id, e.file]))

const byId = new Map<string, ComponentDef>()
const loading = new Map<string, Promise<void>>()
const loaded: string[] = []

const library = new Map<string, { module: HdlModule; def: ComponentDef | null }>()
const listeners = new Set<() => void>()
let libraryVersion = 0

const defListeners = new Set<() => void>()
let defsVersion = 0

/** A part's full definition, or undefined while its file has not loaded (or for an id nobody knows). */
export function getDef(id: string): ComponentDef | undefined {
  return byId.get(id) ?? library.get(id)?.def ?? undefined
}

/** What the palette, search and menus need of a part: there from the start, no file to wait for. */
export function getMeta(id: string): PartMeta | ComponentDef | undefined {
  return metaById.get(id) ?? library.get(id)?.def ?? undefined
}

function loadFile(file: string): Promise<void> {
  let pending = loading.get(file)
  if (!pending) {
    const load = PART_FILES[file]
    pending = load().then(({ defs }) => {
      for (const def of defs) byId.set(def.id, withPadClasses(def))
      loaded.push(file)
      defsVersion++
      for (const l of defListeners) l()
    })
    // A failed load (the network dropped) may be tried again.
    pending.catch(() => loading.delete(file))
    loading.set(file, pending)
  }
  return pending
}

/**
 * Load the files these parts live in. Null when every one is here already, so a caller that has
 * nothing to wait for goes on in the same tick. Ids the catalogue does not know (HDL modules, a
 * part from a newer version) are passed over: getDef answers for them as before.
 */
export function ensureDefs(ids: Iterable<string>): Promise<void> | null {
  const files = new Set<string>()
  for (const id of ids) {
    if (byId.has(id)) continue
    const file = fileOf.get(id)
    if (file) files.add(file)
  }
  return files.size ? Promise.all([...files].map(loadFile)).then(() => {}) : null
}

/**
 * Run now if these parts are here, else once their files have loaded: for a click that places a
 * part, which must not wait when nothing is missing. A failed load goes to onError.
 */
export function afterDefs(ids: Iterable<string>, run: () => void, onError: (e: unknown) => void = console.error): void {
  const pending = ensureDefs(ids)
  if (pending) pending.then(run, onError)
  else run()
}

/**
 * Documents that arrive one after another (projects opened, a collaborator's changes, pastes)
 * each go in once their parts are here, and never ahead of one that came earlier: a second
 * change whose parts are loaded already waits behind a first that is still loading.
 */
export function defsQueue(onError: (e: unknown) => void = console.error): (ids: Iterable<string>, run: () => void) => void {
  let tail: Promise<void> | null = null
  return (ids, run) => {
    const pending = ensureDefs(ids)
    if (!pending && !tail) return run()
    const next = (tail ?? Promise.resolve())
      .then(() => pending)
      .then(run)
      .catch(onError)
    tail = next
    void next.finally(() => {
      if (tail === next) tail = null
    })
  }
}

/** The part ids a document or a clip holds. */
export const defIds = (doc: { objects: readonly { def: string }[] }) => doc.objects.map((o) => o.def)

/** Load every part: for tests and scripts, which read the whole catalogue at once. */
export const loadAllDefs = (): Promise<void> => Promise.all(Object.keys(PART_FILES).map(loadFile)).then(() => {})

/** The files loaded so far, in the order they came. */
export const loadedFiles = (): readonly string[] => [...loaded]

/** Every part's definition, in catalogue order. Only after loadAllDefs: a page never has them all. */
export function allDefs(): ComponentDef[] {
  if (loaded.length < Object.keys(PART_FILES).length) throw new Error("allDefs() before loadAllDefs(): the page loads parts as they are wanted")
  return catalogue.map((m) => byId.get(m.id)!)
}

/** A part a synchronous builder needs. Throws MissingDefs while its file has not loaded: withDefs catches it, loads, and runs the builder again. */
export function need(id: string): ComponentDef {
  const def = getDef(id)
  if (def) return def
  if (fileOf.has(id)) throw new MissingDefs([id])
  throw new Error(`Unknown part "${id}"`)
}

export class MissingDefs extends Error {
  readonly ids: string[]
  constructor(ids: string[]) {
    super(`Parts not loaded yet: ${ids.join(", ")}`)
    this.ids = ids
  }
}

/** Run a synchronous builder (an example, an imported project's bench) once the parts it places have loaded. */
export async function withDefs<T>(build: () => T): Promise<T> {
  for (;;) {
    try {
      return build()
    } catch (e) {
      if (!(e instanceof MissingDefs)) throw e
      await ensureDefs(e.ids)
      const still = e.ids.filter((id) => !byId.has(id))
      if (still.length) throw new Error(`The catalogue puts ${still.join(", ")} in a file that does not define it: run pnpm catalogue`)
    }
  }
}

/** Bumped each time a file of parts loads: a view drawing a part that was still loading subscribes. */
export const getDefsVersion = () => defsVersion

export function subscribeDefs(listener: () => void): () => void {
  defListeners.add(listener)
  return () => defListeners.delete(listener)
}

export function setLibrary(modules: readonly HdlModule[] | undefined): boolean {
  const list = modules ?? []
  let changed = list.length !== library.size
  const next = new Map<string, { module: HdlModule; def: ComponentDef | null }>()
  for (const m of list) {
    const known = library.get(m.id)
    if (known && known.module.built === m.built && known.module.name === m.name) {
      next.set(m.id, { module: m, def: known.def })
      if (known.module !== m) known.module = m
      continue
    }
    changed = true
    next.set(m.id, { module: m, def: hdlDef(m) })
  }
  if (!changed) {
    for (const [id, entry] of next) library.set(id, entry)
    return false
  }
  library.clear()
  for (const [id, entry] of next) library.set(id, entry)
  libraryVersion++
  return true
}

export function notifyLibrary() {
  for (const l of listeners) l()
}

export function subscribeLibrary(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export const getLibraryVersion = () => libraryVersion

export function libraryEntries(): { module: HdlModule; def: ComponentDef | null }[] {
  return [...library.values()]
}

export function hdlModule(id: string): HdlModule | undefined {
  return library.get(id)?.module
}

type Identified = { id: string }

const firstOfEachId = <T extends Identified>(items: readonly T[]): Map<string, T> => {
  const byId = new Map<string, T>()
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item)
  return byId
}

const memoisedById = <T extends Identified>(cache: WeakMap<ComponentDef, Map<string, T>>, def: ComponentDef, items: readonly T[]): Map<string, T> => {
  const known = cache.get(def)
  if (known) return known
  const byId = firstOfEachId(items)
  cache.set(def, byId)
  return byId
}

const pinsOfDef = new WeakMap<ComponentDef, Map<string, PinDef>>()
const partsOfDef = new WeakMap<ComponentDef, Map<string, PartDef>>()

export function getPin(def: ComponentDef, pinId: string): PinDef | undefined {
  return memoisedById(pinsOfDef, def, def.pins).get(pinId)
}

function getPart(def: ComponentDef, partId: string): PartDef | undefined {
  return memoisedById(partsOfDef, def, def.parts).get(partId)
}

/** How a pin reads in text: "R1.2", "U1.PA5", or the component name when the pin has no label. */
export function pinName(objects: PlacedObject[], ref: PinRef): string {
  const obj = objects.find((o) => o.id === ref.object)
  const def = obj && getDef(obj.def)
  if (!obj || !def) return "?"
  const owner = obj.props?.ref || def.name
  const pin = getPin(def, ref.pin)
  // A pin drawn without a label still needs telling apart in a readout when the part has
  // several (a transformer's windings); a part with one pin is named by the part alone.
  const label = pin?.label || (def.pins.length > 1 ? ref.pin : "")
  return label ? `${owner}.${label}` : owner
}

/** State a part has before anyone touches it: a USB cable starts plugged in, everything else off. */
export function partInitial(def: ComponentDef, partId: string): PartState {
  const p = getPart(def, partId)
  return p && "initial" in p && p.initial ? p.initial : {}
}

/** MIME type used when dragging a palette entry onto the field. */
export const PALETTE_DRAG_TYPE = "application/x-emul-component"
