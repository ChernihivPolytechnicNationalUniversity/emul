/**
 * The UI's side of the debugger, for every board on the bench: it hands each core its
 * breakpoints, learns of stops from the simulation worker, fetches registers and memory at a
 * stop, unwinds the stack, evaluates what the views ask for, and turns the buttons (step
 * over, into, out, to the cursor) into what the core executes. Plain TypeScript: React
 * subscribes to it (`useDebugView`).
 *
 * The bench is one machine: a stop on any core pauses all of it, and going on — continue, or
 * a step on one core — takes every core along.
 */
import type { SourceFile } from "emul-shared/source"
import { chipById, type ChipProfile } from "@/mcu/chip"
import type { Firmware } from "@/mcu/elf"
import { base64ToBytes } from "@/lib/bytes"
import type { BlockInfo, BreakpointSpec, CoreDebugCommand, CoreRegisters, DebugStop, InspectReply, InspectRequest, StepRequest } from "./protocol"
import type { DebugInfo } from "./info"
import type { MemorySnapshot } from "./memory"
import type { StackFrame } from "./unwind"
import type { Radix, Shown, Value, Env } from "./values"
import { parseBuildRecord, type BuildRecord } from "./sources"

/**
 * The ELF and DWARF readers, the unwinder and the evaluator come with the code panel (a chunk
 * of its own, loaded the first time it opens), which hands them over here: the page does not
 * carry them until someone debugs. A stop with the panel closed opens it, and waits for them.
 */
export type Analysis = {
  parseFirmware: typeof import("@/mcu/elf").parseFirmware
  MemorySnapshot: typeof import("./memory").MemorySnapshot
  DebugInfo: typeof import("./info").DebugInfo
  unwind: typeof import("./unwind").unwind
  evaluateExpression: typeof import("./eval").evaluateExpression
  Pending: typeof import("./eval").Pending
  show: typeof import("./values").show
}
let analysis: Analysis | null = null
let provided: (a: Analysis) => void = () => {}
const analysisReady = new Promise<Analysis>((resolve) => (provided = resolve))
export function provideAnalysis(a: Analysis) {
  if (analysis) return
  analysis = a
  provided(a)
}

/** The line to the cores, through the simulation worker. */
export type DebugBridge = {
  command: (object: string, cmd: CoreDebugCommand) => void
  inspect: (object: string, req: InspectRequest) => Promise<InspectReply | null>
  resetCore: (object: string) => void
}

/** What the controller needs from the page: the bench's Run/Pause, and showing a board. */
export type DebugHost = {
  setRunning: (running: boolean) => void
  /** A stop on a board: show it (the code panel switches to it). */
  reveal: (object: string) => void
}

/** A board as the debugger sees it, from the document. */
export type DebugBoard = {
  id: string
  chip: string
  image: string
  imageName: string
  /** The project, when the image was built from it (its paths then name the image's files). */
  project: SourceFile[] | null
  added: SourceFile[]
  breakpoints: BreakpointSpec[]
  catchFaults: boolean
  build: BuildRecord | null
}

export type BoardStatus = "no-image" | "running" | "stepping" | "stopped" | "paused"

export type BoardView = {
  status: BoardStatus
  /** Why the core is where it is: a debugger stop, or the bench paused under it. */
  stop: DebugStop | null
  regs: CoreRegisters | null
  /** The registers and the memory at the stop before, to mark what changed. */
  prevRegs: CoreRegisters | null
  prevMem: MemorySnapshot | null
  frames: StackFrame[]
  frame: number
  mem: MemorySnapshot | null
  /** The core's own time at the stop. */
  time: number
  error: string | null
  /** Bumped on every change, for views that cache. */
  version: number
}

const EMPTY: BoardView = { status: "no-image", stop: null, regs: null, prevRegs: null, prevMem: null, frames: [], frame: 0, mem: null, time: 0, error: null, version: 0 }

type Board = DebugBoard & {
  view: BoardView
  info: DebugInfo | null
  infoFor: string | null
  chipProfile: ChipProfile | null
  /** What the core was last told, to send only changes. */
  sentBreakpoints: string
  sentCatch: boolean | null
  /** Bumped when the bench goes on: replies to reads made before are stale. */
  gen: number
  fetching: boolean
}

/** No simulation yet: commands go nowhere, reads come back empty. */
const NO_BRIDGE: DebugBridge = { command: () => {}, inspect: () => Promise.resolve(null), resetCore: () => {} }

export class DebugController {
  private readonly host: DebugHost
  private bridge: DebugBridge = NO_BRIDGE
  private readonly boards = new Map<string, Board>()
  private readonly listeners = new Set<() => void>()
  /** Told when a board's stop (or a frame picked in it) is ready to be shown: the code panel opens its line. */
  private readonly showListeners = new Set<(object: string) => void>()
  /** Whether the bench is running, as the simulation last said. */
  private running = false
  /** The board whose code is on screen: a pause fetches its state first. */
  private focused: string | null = null
  radix: Radix = "dec"

  constructor(host: DebugHost) {
    this.host = host
  }

  /** The simulation's line to the cores (made by its hook, after this controller). */
  attach(bridge: DebugBridge | null) {
    this.bridge = bridge ?? NO_BRIDGE
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  /** Stops ready to show, by board. */
  onShow(fn: (object: string) => void): () => void {
    this.showListeners.add(fn)
    return () => this.showListeners.delete(fn)
  }
  private show(object: string) {
    for (const fn of this.showListeners) fn(object)
  }
  private changed(b?: Board) {
    if (b) b.view = { ...b.view, version: b.view.version + 1 }
    for (const fn of this.listeners) fn()
  }

  view(id: string | null): BoardView {
    return (id && this.boards.get(id)?.view) || EMPTY
  }
  board(id: string | null): DebugBoard | null {
    return (id && this.boards.get(id)) || null
  }
  get benchRunning() {
    return this.running
  }

  private images = new Map<string, { for: string; fw: Firmware | null }>()
  /** A board's image as loaded (segments, symbols): what the disassembly reads when nothing else is at hand — HEX and BIN images included. */
  image(id: string | null): Firmware | null {
    const b = id ? this.boards.get(id) : undefined
    if (!b?.image || !analysis) return null
    const info = this.info(id)
    if (info) return info.firmware
    const had = this.images.get(b.id)
    if (had?.for === b.image) return had.fw
    let fw: Firmware | null = null
    try {
      const bytes = base64ToBytes(b.image)
      fw = analysis.parseFirmware(bytes.buffer as ArrayBuffer, b.imageName)
    } catch {
      fw = null
    }
    this.images.set(b.id, { for: b.image, fw })
    return fw
  }

  /** The debug information of a board's image, parsed on first use and kept while the image stays. */
  info(id: string | null): DebugInfo | null {
    const b = id ? this.boards.get(id) : undefined
    if (!b || !b.image) return null
    if (!analysis) return null
    if (b.infoFor !== b.image) {
      b.infoFor = b.image
      const bytes = base64ToBytes(b.image)
      // Only an ELF has debug information; a HEX or BIN image is disassembled from its bytes alone.
      const elf = bytes.length > 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46
      try {
        b.info = elf ? new analysis.DebugInfo(bytes) : null
      } catch (e) {
        b.info = null
        b.view = { ...b.view, error: `cannot read the image: ${(e as Error).message}` }
      }
    }
    return b.info
  }

  // --- the document ----------------------------------------------------------------------------

  /** The boards as the document has them now: configuration goes to the cores when it changed. */
  sync(list: DebugBoard[]) {
    const seen = new Set<string>()
    let any = false
    for (const d of list) {
      seen.add(d.id)
      let b = this.boards.get(d.id)
      if (!b) {
        b = { ...d, view: { ...EMPTY }, info: null, infoFor: null, chipProfile: chipById(d.chip) ?? null, sentBreakpoints: "", sentCatch: null, gen: 0, fetching: false }
        this.boards.set(d.id, b)
        any = true
      }
      const imageChanged = b.image !== d.image
      Object.assign(b, d)
      if (imageChanged) {
        b.gen++
        b.view = { ...EMPTY, status: d.image ? (this.running ? "running" : "paused") : "no-image", version: b.view.version + 1 }
        any = true
      } else if (b.view.status === "no-image" && d.image) {
        b.view = { ...b.view, status: this.running ? "running" : "paused" }
        any = true
      }
      const bps = JSON.stringify(d.breakpoints)
      if (bps !== b.sentBreakpoints) {
        b.sentBreakpoints = bps
        this.bridge.command(d.id, { op: "breakpoints", list: d.breakpoints })
        any = true
      }
      if (d.catchFaults !== b.sentCatch) {
        b.sentCatch = d.catchFaults
        this.bridge.command(d.id, { op: "catch", faults: d.catchFaults })
      }
    }
    for (const id of [...this.boards.keys()])
      if (!seen.has(id)) {
        this.boards.delete(id)
        any = true
      }
    if (any) this.changed()
  }

  /** The board whose code is on screen. At a pause its state is fetched when it is first shown. */
  focus(id: string | null) {
    this.focused = id
    const b = id ? this.boards.get(id) : undefined
    if (b && !this.running && b.image && !b.view.regs) void this.refresh(b, null)
  }

  // --- the simulation's news ----------------------------------------------------------------------

  /** The bench started or stopped (the user's Run/Pause, or a stop). */
  onRunning(running: boolean) {
    this.running = running
    for (const b of this.boards.values()) {
      if (!b.image) continue
      if (running) {
        b.gen++
        b.view = { ...b.view, status: b.view.status === "stepping" ? "stepping" : "running", stop: null, frames: [], mem: null, prevRegs: b.view.regs ?? b.view.prevRegs, prevMem: b.view.mem ?? b.view.prevMem, regs: null, error: null, version: b.view.version + 1 }
      } else if (b.view.status === "running" || b.view.status === "stepping") {
        b.view = { ...b.view, status: "paused", version: b.view.version + 1 }
      }
    }
    // A plain pause: show where the focused board's core is (a stop has fetched its own already).
    if (!running) {
      const b = this.focused ? this.boards.get(this.focused) : undefined
      if (b?.image && !b.view.regs && b.view.status !== "stopped") void this.refresh(b, null)
    }
    this.changed()
  }

  /** Cores stopped for the debugger; the bench is paused. The first to stop is shown. */
  onStop(stops: { object: string; stop: DebugStop }[]) {
    this.running = false
    for (const { object, stop } of stops) {
      const b = this.boards.get(object)
      if (!b) continue
      b.view = { ...b.view, status: "stopped", stop, version: b.view.version + 1 }
      void this.refresh(b, stop)
    }
    const first = stops[0]?.object
    if (first) this.host.reveal(first)
    this.changed()
  }

  /** Registers, RAM and the stack of a stopped (or paused) core. */
  private async refresh(b: Board, stop: DebugStop | null) {
    const gen = b.gen
    const ram = (b.chipProfile?.memory ?? []).filter((r) => r.kind === "ram" && !r.external).map((r) => ({ addr: r.base, size: r.size }))
    const [reply, a] = await Promise.all([this.bridge.inspect(b.id, { regs: true, ranges: ram }), analysisReady])
    if (gen !== b.gen) return
    if (!reply?.regs) {
      b.view = { ...b.view, error: reply?.halted ?? "the core does not answer", version: b.view.version + 1 }
      this.changed()
      return
    }
    const info = this.info(b.id)
    const mem = new a.MemorySnapshot(info?.firmware.segments ?? [], reply.memory)
    const real = reply.stop ?? stop
    b.view = {
      ...b.view,
      status: real ? "stopped" : "paused",
      stop: real ?? { reason: "pause", pc: reply.regs.r[15] },
      regs: reply.regs,
      mem,
      time: reply.time,
      frames: info ? a.unwind(info, reply.regs, mem) : [],
      frame: 0,
      error: reply.halted,
      version: b.view.version + 1,
    }
    this.changed()
    this.show(b.id)
    await this.fill(b)
  }

  /** Fetch the memory the last evaluations missed, and evaluate again (a pointer to follow, a struct in SDRAM). */
  private async fill(b: Board) {
    for (let round = 0; round < 6; round++) {
      const mem = b.view.mem
      const info = this.info(b.id)
      if (!mem || b.fetching) return
      // The unwinder may have missed stack beyond the RAM fetched (an SDRAM stack): again with what arrives.
      const misses = mem.takeMisses()
      if (!misses.length) break
      b.fetching = true
      const gen = b.gen
      const reply = await this.bridge.inspect(b.id, { ranges: misses }).finally(() => (b.fetching = false))
      if (gen !== b.gen || !reply) return
      for (const c of reply.memory) mem.add(c)
      if (info && b.view.regs && analysis) b.view = { ...b.view, frames: analysis.unwind(info, b.view.regs, mem) }
      b.view = { ...b.view, version: b.view.version + 1 }
      this.changed()
    }
    this.changed(b)
  }

  /** Views call this after rendering: whatever they read and did not have is fetched. */
  requestMissing(id: string | null) {
    const b = id ? this.boards.get(id) : undefined
    if (b?.view.mem && b.view.mem.misses.size && !b.fetching) void this.fill(b)
  }

  // --- going on ---------------------------------------------------------------------------------

  continue() {
    this.host.setRunning(true)
  }
  pause() {
    this.host.setRunning(false)
  }

  /** A step on one board's core; the bench runs until it is done. */
  step(id: string, req: StepRequest) {
    const b = this.boards.get(id)
    if (!b?.image) return
    b.view = { ...b.view, status: "stepping" }
    this.bridge.command(id, { op: "step", step: req })
    this.changed(b)
  }

  /**
   * Step out of the selected frame: run to where its caller goes on, once the stack is back
   * above the frame (a recursion's deeper activations do not count). An inlined function is
   * left by stepping over its lines until the pc is out of it.
   */
  stepOut(id: string) {
    const b = this.boards.get(id)
    const v = b?.view
    if (!b || !v?.frames.length) return this.step(id, { kind: "instruction" })
    const k = v.frame
    const f = v.frames[k]
    if (f.inlined) return void this.stepOutOfInline(b, f)
    // The caller: the next frame down that is not an inlined level of this one.
    let caller = k + 1
    while (caller < v.frames.length && v.frames[caller].pc === f.pc && !v.frames[caller].interruptedBy) caller++
    const c = v.frames[caller]
    if (!c) return this.step(id, { kind: "over" })
    const sp = c.interruptedBy ? (c.regs.r[13] ?? undefined) : (f.cfa ?? undefined)
    this.step(id, { kind: "until", addr: c.pc, sp: sp ?? undefined })
  }

  private async stepOutOfInline(b: Board, f: StackFrame) {
    const scope = f.level?.scope
    const info = this.info(b.id)
    for (let i = 0; i < 50 && scope && info; i++) {
      const stopped = this.nextStop(b)
      this.step(b.id, { kind: "over" })
      await stopped
      const pc = b.view.regs?.r[15]
      if (pc === undefined || b.view.stop?.reason !== "step") return
      if (!info.inlineLevels(pc).some((l) => l.scope === scope)) return
    }
  }

  /** Resolves once the board's view has a fresh stop. */
  private nextStop(b: Board): Promise<void> {
    return new Promise((resolve) => {
      const was = b.gen
      const off = this.subscribe(() => {
        if (b.gen !== was && b.view.regs && (b.view.status === "stopped" || b.view.status === "paused")) {
          off()
          resolve()
        }
      })
    })
  }

  /** Run to an address (the cursor's line), wherever the stack is. */
  runTo(id: string, addr: number) {
    this.step(id, { kind: "until", addr })
  }

  /** Reset the board's core, as a probe's reset does: it starts over; the bench keeps its time and its state. */
  restart(id: string) {
    const b = this.boards.get(id)
    if (!b) return
    this.bridge.resetCore(id)
    if (!this.running) {
      b.gen++
      void this.refresh(b, null)
    }
  }

  selectFrame(id: string, index: number) {
    const b = this.boards.get(id)
    if (!b || index < 0 || index >= b.view.frames.length) return
    b.view = { ...b.view, frame: index }
    this.changed(b)
    this.show(id)
  }

  // --- values -----------------------------------------------------------------------------------

  /** What evaluating needs, in the selected frame (or another). */
  env(id: string | null, frame?: number): Env | null {
    const b = id ? this.boards.get(id) : undefined
    const info = this.info(id)
    if (!b || !info || !b.view.mem) return null
    return { info, mem: b.view.mem, frame: b.view.frames[frame ?? b.view.frame] ?? null }
  }

  /** The locals visible in a frame. */
  locals(id: string | null, frame?: number) {
    const env = this.env(id, frame)
    const level = env?.frame?.level
    return env && level ? env.info.variablesOf(level) : []
  }

  /** An expression's value and its text, in the selected frame. */
  evaluate(id: string | null, expr: string, frame?: number): { value: Value | null; shown: Shown } {
    const env = this.env(id, frame)
    if (!env || !analysis) return { value: null, shown: { text: "not stopped", error: true, expandable: false } }
    try {
      const value = analysis.evaluateExpression(env, { locals: this.locals(id, frame) }, expr)
      return { value, shown: analysis.show(env, value, this.radix) }
    } catch (e) {
      if (e instanceof analysis.Pending) return { value: null, shown: { text: "…", pending: true, expandable: false } }
      return { value: null, shown: { text: `<${(e as Error).message}>`, error: true, expandable: false } }
    }
  }

  /** The peripheral blocks the board's emulated MCU models, with their registers (the peripherals view without a device map). */
  async modelledBlocks(id: string): Promise<BlockInfo[]> {
    const reply = await this.bridge.inspect(id, { blocks: true })
    return reply?.blocks ?? []
  }

  /** Read memory for the memory view: what is held, or null while it is fetched. */
  readMemory(id: string | null, addr: number, size: number): Uint8Array | null {
    const b = id ? this.boards.get(id) : undefined
    return b?.view.mem?.bytes(addr, size) ?? null
  }

  setRadix(radix: Radix) {
    this.radix = radix
    for (const b of this.boards.values()) b.view = { ...b.view, version: b.view.version + 1 }
    this.changed()
  }
}

/** The debugger's picture of a board from the document's object. */
export function boardFromObject(o: { id: string; props?: Record<string, string>; project?: SourceFile[]; debug?: { breakpoints?: BreakpointSpec[]; sources?: SourceFile[]; catchFaults?: boolean } }, chip: string): DebugBoard {
  const build = parseBuildRecord(o.props?.firmwareBuild)
  return {
    id: o.id,
    chip,
    image: o.props?.firmwareData ?? "",
    imageName: o.props?.firmware ?? "",
    project: build && o.project ? o.project : null,
    added: o.debug?.sources ?? [],
    breakpoints: o.debug?.breakpoints ?? [],
    catchFaults: o.debug?.catchFaults ?? true,
    build,
  }
}
