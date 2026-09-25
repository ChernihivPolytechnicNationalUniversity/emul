/**
 * Where an emulated core runs. The loop talks to every MCU through `CoreHost`: `LocalCore`
 * is the `Stm32` itself, in the loop's own thread; `RemoteCore` is a proxy for one living in
 * a worker of its own (`src/mcu/core-worker.ts`), so a board's core and the analog solver
 * use two CPU cores, and two boards use three.
 *
 * A remote core is pipelined one step behind the loop: `runUntil(T)` first collects the run
 * issued before, then issues the run to T and returns without waiting, so the core computes
 * that interval while the solver takes its step. What the loop then sees (pad drives, PWM
 * duty, edges, supply current) is the state at the end of the *previous* interval, and what
 * the core sees (sampled pin levels, ADC voltages, VDD/NRST) reaches it one step later than
 * it would in-process: 20 µs of latency in both directions, invisible for LEDs, buttons, PWM
 * and ADC readings. Where the exact time of an answer matters — a digital part answering an
 * I²C edge — the proxy drops to a synchronous round trip per run (`sync`) while that traffic
 * lasts, so those exchanges keep their timing; and cores sharing a net with another core stay
 * in-process altogether, in lockstep.
 *
 * Transport is a SharedArrayBuffer with Atomics: the loop and the core each write their own
 * side, double-banked by run parity so a bank being read is never the one being written.
 */
import { chipById, STM32F429ZI, type ChipProfile, type MemoryRegion } from "@/mcu/chip"
import { CpuHalt } from "@/mcu/faults"
import type { PadDrive } from "@/mcu/periph/gpio"
import type { ClockSource } from "@/mcu/periph/rcc"
import { Stm32, type ClockStatus, type PadRef, type PowerStatus } from "@/mcu/stm32f429"
import type { CoreDebugCommand, DebugStop, InspectReply, InspectRequest, StopReason } from "@/debug/protocol"
import type { PanelSignal, PanelSpec } from "@/schematic/types"
import { PanelInstance } from "./display"

/** What the UI shows about a core: where it is and how it is doing. */
export type CoreStatus = {
  running: boolean
  /** Why the core stopped, when it did. */
  halted: string | null
  time: number
  pc: number
  instructions: number
  sysclk: number
  /** Human-readable pending/fault notes for the debugger panel. */
  faults: string[]
  /** Peripheral blocks the firmware touched that the emulator does not model, busiest first. */
  unmodelled: { block: string; reads: number; writes: number }[]
  /** System resets since power-on (watchdogs, SYSRESETREQ, Standby exit) and the cause of the last one. */
  resets: number
  lastReset: string | null
  /** VBAT held the RTC and backup registers through the last power cut. */
  backupKept: boolean
  /** Power mode, share of the time asleep since the last status, and the supply-current estimate. */
  power: PowerStatus
  /** System clock source and rate, what feeds HSE/LSE, and why an oscillator the firmware waits on is not coming. */
  clock: ClockStatus
  /** Stopped for the debugger: a breakpoint, a finished step, a caught fault. */
  debug: DebugStop | null
  /**
   * Where the core runs: in the loop's thread, in a worker pipelined one step behind it (pad
   * and pin levels cross with 20 µs of latency), or in a worker in step with it.
   */
  host: "in-process" | "worker (pipelined)" | "worker (in step)"
}

/** An exact-time edge a core put on a pad. */
export type OutEdge = { pad: PadRef; level: boolean | null; time: number }

/** A panel wired to cores: which host and pad drives each signal pin. */
export type PanelWiring = { object: string; spec: PanelSpec; wired: Map<PanelSignal, { host: CoreHost; pad: PadRef }> }

export interface CoreHost {
  readonly chip: ChipProfile
  /** Firmware is loaded (the core can run). */
  readonly loaded: boolean
  readonly ready: boolean
  /** The core stopped on a fault, breakpoint or burn-out. */
  readonly halted: boolean
  readonly running: boolean
  /** The core's own time (from its last reset); a pipelined core reports the end of the run issued. */
  readonly time: number
  readonly porThreshold: number
  boot0: boolean
  /** Whether the core hands edges over as it makes them (a part or peer must answer at the edge's time). */
  yieldOnOutput: boolean
  /** Runs in step with the loop rather than pipelined (a remote core with digital traffic to answer). */
  readonly sync: boolean
  load(data: ArrayBuffer, name: string): void
  /** Restart the core; `backup` keeps the RTC and backup registers (VBAT held them). */
  reset(opts?: { backup?: boolean }): void
  /** Time VDD was off with VBAT on, to count the RTC through before the next reset. */
  runOnBattery(seconds: number): void
  /** Dead silicon: the core stops with this reason until the next run. */
  halt(reason: string): void
  setClockSources(hse: ClockSource | null, lse: ClockSource | null): void
  /** Pads whose plain-GPIO edges travel the exact-time path. */
  setDigitalWatch(keys: Iterable<number>): void
  /** Pads the circuit is wired to: the only ones whose drive and duty need reporting. */
  setPads(keys: Iterable<number>): void
  /** A sampled level for a pad (the analog sampler, once per step). */
  setPad(pad: PadRef, level: boolean): void
  /** A level at an exact time, now or later (the digital fast path in). */
  setPadAt(pad: PadRef, level: boolean, time: number): void
  /** The voltage the ADC would sample on a pad, as the last solve left it. */
  setAnalog(pad: PadRef, volts: number): void
  /** Run to `end` (own time). Returns false when the core stopped. */
  runUntil(end: number): boolean
  /**
   * Run up to `n` of the loop's steps from loop time `time` (the core's own time is loop time
   * less `base`) while nothing the loop reads changes, stopping after the step where something
   * did (`Stm32.runSteps`). `version` and `idd` are the pad version and supply current the loop
   * last saw; an in-process core asks `quiet` after each step whether the loop would read its
   * pads as before (and the loop takes the step's duties if so). `step` takes the solver's side
   * of each step before the last, in order, as soon as the core is past it. Returns the steps
   * run; 0 when the core was not where the loop saw it (a pipelined run in flight changed
   * something), and the loop steps as usual.
   */
  runSteps(time: number, base: number, dt: number, n: number, version: number, idd: number, quiet: () => boolean, step: () => void): number
  padDrive(pad: PadRef): PadDrive
  /** Counts every change of what the pads drive (GPIO register writes, DAC outputs): a cheap "re-read the pads?" test. */
  padVersion(): number
  /** Pads (port·16 + pin) a peripheral toggles, whose duty `takeDuty` reports. */
  dutyPads(): Iterable<number>
  /** Fraction of the last interval a peripheral-driven pad was high; null when nothing drives it that way. */
  takeDuty(pad: PadRef, interval: number): number | null
  /** Edges made since the last drain (own time). */
  drainEdges(): OutEdge[]
  supplyCurrent(): number
  status(): CoreStatus
  /** What a panel wired to this core shows: a fresh frame when the picture changed, and the panel's verdict. */
  capturePanel(panel: PanelWiring, wall: number, powered: boolean): { frame: ArrayBuffer | null; status: string }
  /** The panel left the document. */
  dropPanel(object: string): void
  /** Breakpoints, vector catch, resume and steps for the core's debug unit (see mcu/debugger.ts). */
  debug(cmd: CoreDebugCommand): void
  /** Where the core is stopped for the debugger; a remote core's is as of its last completed run. */
  readonly debugStop: DebugStop | null
  /** Registers and memory, read without side effects. */
  inspect(req: InspectRequest): Promise<InspectReply>
  dispose(): void
}

/** Pad keys (port·16 + pin) cover ports A–K. */
export const PAD_KEYS = 11 * 16

/**
 * Wait until `ctl[index]` is no longer `value`: spinning first, since a futex wake-up costs
 * tens of microseconds — as much as a whole step — while the other side usually answers
 * within a few; then sleeping in short slices so a stalled peer costs no CPU.
 */
export function awaitChange(ctl: Int32Array, index: number, value: number, spins = 20000) {
  for (let i = 0; i < spins; i++) if (Atomics.load(ctl, index) !== value) return
  while (Atomics.load(ctl, index) === value) Atomics.wait(ctl, index, value, 5)
}

// --- the core in this thread ------------------------------------------------------------------

export class LocalCore implements CoreHost {
  readonly mcu: Stm32
  readonly chip: ChipProfile
  readonly sync = false
  private readonly panels = new Map<string, PanelInstance>()
  private edges: OutEdge[] = []

  constructor(chip: ChipProfile, external: MemoryRegion[] = []) {
    this.chip = chip
    this.mcu = new Stm32(chip, external)
  }
  get loaded() {
    return this.mcu.firmware !== null
  }
  readonly ready = true
  get halted() {
    return this.mcu.cpu.halted !== null
  }
  get running() {
    return this.mcu.running
  }
  get time() {
    return this.mcu.time
  }
  get porThreshold() {
    return this.mcu.porThreshold
  }
  get boot0() {
    return this.mcu.boot0
  }
  set boot0(v: boolean) {
    this.mcu.boot0 = v
  }
  get yieldOnOutput() {
    return this.mcu.yieldOnOutput
  }
  set yieldOnOutput(v: boolean) {
    this.mcu.yieldOnOutput = v
  }
  load(data: ArrayBuffer, name: string) {
    try {
      this.mcu.load(data, name)
    } catch (e) {
      this.mcu.firmware = null
      this.mcu.cpu.halted = new CpuHalt("fault", `cannot load firmware: ${(e as Error).message}`, 0)
    }
  }
  reset(opts: { backup?: boolean } = {}) {
    this.mcu.reset("por", opts)
  }
  runOnBattery(seconds: number) {
    this.mcu.runOnBattery(seconds)
  }
  halt(reason: string) {
    this.mcu.cpu.halted = new CpuHalt("fault", reason, this.mcu.cpu.pc)
  }
  setClockSources(hse: ClockSource | null, lse: ClockSource | null) {
    this.mcu.setClockSources(hse, lse)
  }
  setDigitalWatch(keys: Iterable<number>) {
    this.mcu.digitalWatch.clear()
    for (const k of keys) this.mcu.digitalWatch.add(k)
  }
  setPads() {}
  setPad(pad: PadRef, level: boolean) {
    this.mcu.setPad(pad, level)
  }
  setPadAt(pad: PadRef, level: boolean, time: number) {
    this.mcu.setPadAt(pad, level, time)
  }
  private readonly analog = new Float64Array(PAD_KEYS).fill(NaN)
  setAnalog(pad: PadRef, volts: number) {
    this.analog[pad.port * 16 + pad.pin] = volts
    if (!this.analogBound) {
      this.analogBound = true
      this.mcu.analogRead = (p) => {
        const v = this.analog[p.port * 16 + p.pin]
        return Number.isNaN(v) ? null : v
      }
    }
  }
  private analogBound = false
  runUntil(end: number) {
    const ok = this.mcu.runUntil(end)
    if (this.mcu.digitalOut.length) {
      this.edges.push(...this.mcu.digitalOut)
      this.mcu.digitalOut.length = 0
    }
    return ok
  }
  /** The last batched step's supply current, for the loop's next read. */
  private stepIdd: number | null = null
  runSteps(time: number, base: number, dt: number, n: number, version: number, idd: number, quiet: () => boolean, step: () => void) {
    const m = this.mcu
    if (!m.running || m.padVersion() !== version) return 0
    const k = m.runSteps(time, base, dt, n, idd, quiet)
    for (let j = 1; j < k; j++) step()
    this.stepIdd = m.stepIdd
    if (m.digitalOut.length) {
      this.edges.push(...m.digitalOut)
      m.digitalOut.length = 0
    }
    return k
  }
  padDrive(pad: PadRef) {
    return this.mcu.padDrive(pad)
  }
  padVersion() {
    return this.mcu.padVersion()
  }
  dutyPads() {
    return this.mcu.dutyPads()
  }
  takeDuty(pad: PadRef, interval: number) {
    return this.mcu.takeDuty(pad, interval)
  }
  peekDuty(pad: PadRef, interval: number) {
    return this.mcu.peekDuty(pad, interval)
  }
  drainEdges() {
    if (this.mcu.digitalOut.length) {
      this.edges.push(...this.mcu.digitalOut)
      this.mcu.digitalOut.length = 0
    }
    const out = this.edges
    this.edges = []
    return out
  }
  supplyCurrent() {
    const idd = this.stepIdd
    if (idd === null) return this.mcu.supplyCurrent()
    this.stepIdd = null
    return idd
  }
  status(): CoreStatus {
    return statusOf(this.mcu, "in-process")
  }
  capturePanel(panel: PanelWiring, wall: number, powered: boolean) {
    let p = this.panels.get(panel.object)
    if (!p) {
      p = new PanelInstance(panel.object, panel.spec)
      this.panels.set(panel.object, p)
    }
    p.wired.clear()
    for (const [signal, w] of panel.wired) if (w.host === this) p.wired.set(signal, { mcu: this.mcu, pad: w.pad })
    return p.capture(wall, powered)
  }
  dropPanel(object: string) {
    this.panels.delete(object)
  }
  debug(cmd: CoreDebugCommand) {
    this.mcu.debug(cmd)
  }
  get debugStop() {
    return this.mcu.debugStop
  }
  inspect(req: InspectRequest) {
    return Promise.resolve(this.mcu.inspect(req))
  }
  dispose() {}
}

/** The status fields every host reports the same way, read off the model. */
export function statusOf(mcu: Stm32, host: CoreStatus["host"]): CoreStatus {
  return {
    running: mcu.running,
    halted: mcu.cpu.halted?.message ?? null,
    time: mcu.time,
    pc: mcu.cpu.pc,
    instructions: mcu.cpu.instructions,
    sysclk: mcu.firmware ? mcu.clocks.sysclk : 0,
    faults: mcu.cpu.scs.faults.slice(-5).map((f) => `${f.detail} at 0x${f.pc.toString(16)}`),
    unmodelled: mcu.unmodelled.summary(),
    resets: mcu.resets,
    lastReset: mcu.lastReset,
    backupKept: mcu.backupKept,
    power: mcu.powerStatus(),
    clock: mcu.clockStatus(),
    debug: mcu.debugStop,
    host,
  }
}

// --- the shared-memory protocol --------------------------------------------------------------
//
// One SharedArrayBuffer per remote core. Int32 control words (Atomics), then Float64 blocks.
// Everything the loop hands the core for a run sits in the command bank of that run's parity;
// everything the core reports sits in the output bank of the same parity. The loop reads the
// bank of the last acknowledged run while the core writes the bank of the run in flight.

/** Control words (Int32 indices). */
export const CTL = {
  /** Run sequence issued by the loop; the core waits on it. */
  SEQ: 0,
  /** Last sequence the core completed; the loop waits on it. */
  ACK: 1,
  /** Edges out: entries written by the core (monotonic) and drained by the loop. */
  OUT_HEAD: 2,
  OUT_TAIL: 3,
  /** Edges in: entries written by the loop, taken by the core before a run. */
  IN_HEAD: 4,
  IN_TAIL: 5,
  /** Messages posted by the loop since start: the core yields to its event loop when it changes. */
  MAIL: 6,
  /** Edges the core had to drop because the ring was full. */
  DROPPED: 7,
  READY: 8,
  /** Steps of a `CMD_STEPS` run the core is past without anything changing: the loop may take them meanwhile. */
  PROGRESS: 9,
  WORDS: 10,
} as const

/** Command flags (per run, in the command bank). */
export const CMD_RESET = 1
export const CMD_BOOT0 = 2
export const CMD_YIELD = 4
/** The reset keeps the backup domain (VBAT held it through the outage). */
export const CMD_BACKUP = 8
/** Run the loop's steps (`CMD.STEPS` of `CMD.STEP` from loop time `CMD.TARGET`) while nothing changes. */
export const CMD_STEPS = 16
/** Output flags (per run, in the output bank). */
export const OUT_LOADED = 1
export const OUT_RUNNING = 2
export const OUT_HALTED = 4
/** Stopped for the debugger; the output bank has the PC and the reason. */
export const OUT_STOPPED = 8
/** Stop reasons as the output bank codes them. */
export const STOP_REASONS: StopReason[] = ["breakpoint", "step", "pause", "bkpt", "exception", "reset"]

/** Command bank layout (Float64 offsets within the bank). */
export const CMD = { TARGET: 0, FLAGS: 1, HSE_HZ: 2, HSE_KIND: 3, HSE_START: 4, LSE_HZ: 5, LSE_KIND: 6, LSE_START: 7, LEVELS: 8, ANALOG: 8 + PAD_KEYS, BATTERY: 8 + 2 * PAD_KEYS, BASE: 9 + 2 * PAD_KEYS, STEP: 10 + 2 * PAD_KEYS, STEPS: 11 + 2 * PAD_KEYS, IN_UPTO: 12 + 2 * PAD_KEYS, SIZE: 13 + 2 * PAD_KEYS } as const
/** Output bank layout. */
export const OUT = { TIME: 0, FLAGS: 1, IDD: 2, POR: 3, STEPS: 4, STOP_PC: 5, STOP_REASON: 6, DRIVE: 7, DUTY: 7 + PAD_KEYS, DUTY_BASE: 7 + 2 * PAD_KEYS, SIZE: 7 + 3 * PAD_KEYS } as const
/** Edge rings: [time, code] pairs; code = key·4 + level (0 low, 1 high, 2 released). */
export const OUT_RING = 8192
export const IN_RING = 2048

export const CLOCK_KIND = ["crystal", "clock", "any"] as const

/** Byte layout of the shared buffer. */
export const SHM = (() => {
  const ctlBytes = CTL.WORDS * 4
  // Float64 blocks start 8-aligned.
  const f64Base = 8 * Math.ceil(ctlBytes / 8)
  const cmd = 0
  const out = cmd + 2 * CMD.SIZE
  const outRing = out + 2 * OUT.SIZE
  const inRing = outRing + 2 * OUT_RING
  const doubles = inRing + 2 * IN_RING
  return { f64Base, cmd, out, outRing, inRing, bytes: f64Base + doubles * 8 }
})()

/** Pad drive encoded in a double: 0 floating, 1–4 the pull/drive codes, 1000 + volts for a DAC output. */
export function encodeDrive(d: PadDrive): number {
  if (d === null) return 0
  if (typeof d === "number") return 1000 + d
  return d === "high" ? 1 : d === "low" ? 2 : d === "pullup" ? 3 : 4
}
export function decodeDrive(v: number): PadDrive {
  if (v === 0) return null
  if (v >= 1000 - 100) return v - 1000
  return v === 1 ? "high" : v === 2 ? "low" : v === 3 ? "pullup" : "pulldown"
}
export function encodeClock(bank: Float64Array, at: number, c: ClockSource | null) {
  bank[at] = c ? c.hz : 0
  bank[at + 1] = c ? CLOCK_KIND.indexOf(c.kind) : -1
  bank[at + 2] = c ? c.startup : 0
}
export function decodeClock(bank: Float64Array, at: number): ClockSource | null {
  if (bank[at + 1] < 0) return null
  return { hz: bank[at], kind: CLOCK_KIND[bank[at + 1]], startup: bank[at + 2] }
}

/** Messages to the core worker. */
export type ToCore =
  | { t: "init"; chip: string; external: MemoryRegion[]; shm: SharedArrayBuffer }
  | { t: "load"; data: ArrayBuffer; name: string }
  | { t: "watch"; keys: number[] }
  | { t: "pads"; keys: number[] }
  | { t: "status"; seq: number }
  | { t: "panel"; object: string; spec: PanelSpec; wired: [PanelSignal, PadRef][] }
  | { t: "capture"; object: string; wall: number; powered: boolean }
  | { t: "drop"; object: string }
  | { t: "debug"; cmd: CoreDebugCommand }
  | { t: "inspect"; seq: number; req: InspectRequest }
/** Messages from the core worker. */
export type FromCore =
  | { t: "status"; seq: number; status: CoreStatus }
  | { t: "frame"; object: string; frame: ArrayBuffer | null; status: string }
  | { t: "inspected"; seq: number; reply: InspectReply }

/** How a remote core's messages travel; the environment (browser or node) provides it. */
export interface CoreTransport {
  post(msg: ToCore, transfer?: ArrayBuffer[]): void
  onMessage(cb: (msg: FromCore) => void): void
  /** Take replies that have arrived, synchronously, where the environment allows (node). */
  poll?(): void
  terminate(): void
}

// --- the proxy of a core in a worker ------------------------------------------------------------

export class RemoteCore implements CoreHost {
  readonly chip: ChipProfile
  private readonly transport: CoreTransport
  private readonly ctl: Int32Array
  private readonly f64: Float64Array
  /** Sequence of the last run issued, and whether it is still in flight. */
  private seq = 0
  private inFlight = false
  /** The two command and output banks, and the output bank of the last completed run. */
  private readonly cmdBanks: Float64Array[]
  private readonly outBanks: Float64Array[]
  private outBank: Float64Array
  private loadedFlag = false
  private haltedFlag = false
  private runningFlag = false
  /** The debugger's stop, as the last completed run reported it. */
  private stopFlag: DebugStop | null = null
  private inspectSeq = 0
  private readonly inspecting = new Map<number, (reply: InspectReply) => void>()
  private lastTime = 0
  private targetTime = 0
  private lastStatus: CoreStatus | null = null
  private edges: OutEdge[] = []
  /** Cumulative high time per pad as of the last two reads, for the duty over the interval. */
  private dutyPrev = new Float64Array(PAD_KEYS)
  private frames = new Map<string, { frame: ArrayBuffer | null; status: string; wiring: string }>()
  private hse: ClockSource | null = null
  private lse: ClockSource | null = null
  private resetPending = true
  private resetBackup = false
  private battery = 0
  private watch: number[] = []
  boot0 = false
  yieldOnOutput = false
  /**
   * Runs in step until this run count when something must answer an edge at the edge's own
   * time; the loop extends it while such traffic lasts.
   */
  private syncUntil = 0
  private runs = 0

  constructor(chip: ChipProfile, external: MemoryRegion[], transport: CoreTransport) {
    this.chip = chip
    this.transport = transport
    const shm = new SharedArrayBuffer(SHM.bytes)
    this.ctl = new Int32Array(shm, 0, CTL.WORDS)
    this.f64 = new Float64Array(shm, SHM.f64Base)
    this.cmdBanks = [0, 1].map((b) => this.f64.subarray(SHM.cmd + b * CMD.SIZE, SHM.cmd + (b + 1) * CMD.SIZE))
    this.outBanks = [0, 1].map((b) => this.f64.subarray(SHM.out + b * OUT.SIZE, SHM.out + (b + 1) * OUT.SIZE))
    this.outBank = this.outBanks[0]
    for (let b = 0; b < 2; b++) {
      const cmd = this.cmdBanks[b]
      cmd.fill(0, CMD.LEVELS, CMD.ANALOG)
      cmd.fill(NaN, CMD.ANALOG, CMD.SIZE)
      encodeClock(cmd, CMD.HSE_HZ, null)
      encodeClock(cmd, CMD.LSE_HZ, null)
    }
    transport.onMessage((msg) => {
      if (msg.t === "status") {
        this.lastStatus = msg.status
        this.statusGot = msg.seq
      }
      else if (msg.t === "frame") {
        const f = this.frames.get(msg.object)
        if (f) {
          f.frame = msg.frame
          f.status = msg.status
        }
      } else if (msg.t === "inspected") {
        const done = this.inspecting.get(msg.seq)
        this.inspecting.delete(msg.seq)
        done?.(msg.reply)
      }
    })
    this.post({ t: "init", chip: chip.id, external, shm })
  }

  private post(msg: ToCore, transfer?: ArrayBuffer[]) {
    Atomics.add(this.ctl, CTL.MAIL, 1)
    this.transport.post(msg, transfer)
  }
  /** The command bank of the next run to issue. */
  private get next() {
    return this.cmdBanks[(this.seq + 1) & 1]
  }

  get loaded() {
    return this.loadedFlag
  }
  get ready() {
    return Atomics.load(this.ctl, CTL.READY) !== 0
  }
  get halted() {
    return this.haltedFlag
  }
  get running() {
    return this.runningFlag
  }
  get time() {
    return this.inFlight ? this.targetTime : this.lastTime
  }
  get porThreshold() {
    // Before the first run the option bytes are at their default (BOR off: 1.7 V).
    return this.outBank[OUT.POR] || 1.7
  }
  get sync() {
    return this.runs < this.syncUntil
  }
  /** Something on this core's nets needs edges answered at their own time: run in step for a while. */
  keepInStep(runs: number) {
    this.syncUntil = Math.max(this.syncUntil, this.runs + runs)
  }

  load(data: ArrayBuffer, name: string) {
    // The worker's load ends in a reset, as the local core's does (`Stm32.load`): the program
    // runs from time 0 the moment it lands. Mirror that here, or a core loaded without a reset
    // of its own (the first image on a board already powered) never gets asked to run.
    this.finish()
    this.loadedFlag = true
    this.haltedFlag = false
    this.haltReason = null
    this.stopFlag = null
    this.post({ t: "load", data, name }, [data])
    this.runningFlag = true
    this.lastTime = 0
    this.outBank.fill(0, OUT.DRIVE, OUT.DRIVE + PAD_KEYS)
    this.version++
  }
  reset(opts: { backup?: boolean } = {}) {
    this.finish()
    this.resetPending = true
    this.resetBackup = !!opts.backup
    this.haltedFlag = false
    this.haltReason = null
    this.stopFlag = null
    this.runningFlag = this.loadedFlag
    this.lastTime = 0
    // Pads come up floating at reset; the core confirms after its next run.
    this.outBank.fill(0, OUT.DRIVE, OUT.DRIVE + PAD_KEYS)
    this.version++
  }  runOnBattery(seconds: number) {
    this.battery = seconds
  }

  private haltReason: string | null = null
  /** The loop stops driving a halted core; the core itself is told at its next reset. */
  halt(reason: string) {
    this.finish()
    this.haltedFlag = true
    this.haltReason = `fault at 0x${(this.lastStatus?.pc ?? 0).toString(16).padStart(8, "0")}: ${reason}`
    this.runningFlag = false
  }
  setClockSources(hse: ClockSource | null, lse: ClockSource | null) {
    this.hse = hse
    this.lse = lse
  }
  setDigitalWatch(keys: Iterable<number>) {
    const next = [...keys].sort((a, b) => a - b)
    if (next.length === this.watch.length && next.every((k, i) => k === this.watch[i])) return
    this.watch = next
    this.post({ t: "watch", keys: next })
  }
  private pads: number[] = []
  setPads(keys: Iterable<number>) {
    const next = [...keys].sort((a, b) => a - b)
    if (next.length === this.pads.length && next.every((k, i) => k === this.pads[i])) return
    this.pads = next
    this.post({ t: "pads", keys: next })
  }
  setPad(pad: PadRef, level: boolean) {
    this.next[CMD.LEVELS + pad.port * 16 + pad.pin] = level ? 2 : 1
  }
  setPadAt(pad: PadRef, level: boolean, time: number) {
    const head = Atomics.load(this.ctl, CTL.IN_HEAD)
    const tail = Atomics.load(this.ctl, CTL.IN_TAIL)
    if (head - tail >= IN_RING) return
    const at = SHM.inRing + (head % IN_RING) * 2
    this.f64[at] = time
    this.f64[at + 1] = (pad.port * 16 + pad.pin) * 4 + (level ? 1 : 0)
    Atomics.store(this.ctl, CTL.IN_HEAD, head + 1)
  }
  setAnalog(pad: PadRef, volts: number) {
    this.next[CMD.ANALOG + pad.port * 16 + pad.pin] = volts
  }

  /** Wait for the run in flight and take its results. */
  private finish() {
    if (!this.inFlight) return
    this.inFlight = false
    awaitChange(this.ctl, CTL.ACK, this.seq - 1)
    const prev = this.outBank
    this.outBank = this.outBanks[this.seq & 1]
    // Anything the pads drive differently than after the run before bumps the version.
    for (let k = 0; k < PAD_KEYS; k++)
      if (this.outBank[OUT.DRIVE + k] !== prev[OUT.DRIVE + k]) {
        this.version++
        break
      }
    const flags = this.outBank[OUT.FLAGS]
    this.loadedFlag = (flags & OUT_LOADED) !== 0
    this.runningFlag = (flags & OUT_RUNNING) !== 0
    this.haltedFlag = (flags & OUT_HALTED) !== 0
    this.stopFlag = flags & OUT_STOPPED ? { reason: STOP_REASONS[this.outBank[OUT.STOP_REASON]] ?? "breakpoint", pc: this.outBank[OUT.STOP_PC] } : null
    this.lastTime = this.outBank[OUT.TIME]
    // Edges the run made, in order.
    const head = Atomics.load(this.ctl, CTL.OUT_HEAD)
    let tail = Atomics.load(this.ctl, CTL.OUT_TAIL)
    for (; tail < head; tail++) {
      const at = SHM.outRing + (tail % OUT_RING) * 2
      const code = this.f64[at + 1]
      const key = code >>> 2
      const lv = code & 3
      this.edges.push({ pad: { port: key >>> 4, pin: key & 15 }, level: lv === 2 ? null : lv === 1, time: this.f64[at] })
    }
    Atomics.store(this.ctl, CTL.OUT_TAIL, tail)
  }

  runUntil(end: number) {
    this.finish()
    // Stopped for the debugger: nothing runs until it is told to go on.
    if (!this.loadedFlag || this.haltedFlag || this.stopFlag) return false
    this.issue(end, 0)
    if (this.sync) this.finish()
    return this.runningFlag
  }
  runSteps(time: number, base: number, dt: number, n: number, version: number, idd: number, _quiet: () => boolean, step: () => void) {
    // The worker counts the quiet steps' duties itself; the pipelined core's dither is its own anyway.
    this.finish()
    if (!this.loadedFlag || this.haltedFlag || this.stopFlag || this.sync || this.version !== version || this.outBank[OUT.IDD] !== idd || this.edges.length) return 0
    const bank = this.next
    bank[CMD.BASE] = base
    bank[CMD.STEP] = dt
    bank[CMD.STEPS] = n
    Atomics.store(this.ctl, CTL.PROGRESS, 0)
    this.issue(time, CMD_STEPS)
    // The solver follows the core through the steps it is past, while it runs on.
    let taken = 0
    while (Atomics.load(this.ctl, CTL.ACK) !== this.seq) {
      const past = Atomics.load(this.ctl, CTL.PROGRESS)
      if (taken < past) {
        for (; taken < past; taken++) step()
      }
    }
    this.finish()
    const k = this.outBank[OUT.STEPS]
    for (; taken < k - 1; taken++) step()
    // The loop takes the last step's duty against the level the quiet steps ended at.
    const out = this.outBank
    for (const key of this.pads) if (out[OUT.DUTY_BASE + key] >= 0) this.dutyPrev[key] = out[OUT.DUTY_BASE + key]
    return k
  }
  /** Hand the core its next run: to `end`, or the loop's steps from `end` with `CMD_STEPS`. */
  private issue(end: number, steps: number) {
    const bank = this.next
    bank[CMD.TARGET] = end
    // Yielding per edge only makes sense in step: pipelined, a run that stopped early would fall behind.
    bank[CMD.FLAGS] = (this.resetPending ? CMD_RESET : 0) | (this.resetPending && this.resetBackup ? CMD_BACKUP : 0) | (this.boot0 ? CMD_BOOT0 : 0) | (this.sync ? CMD_YIELD : 0) | steps
    bank[CMD.BATTERY] = this.resetPending ? this.battery : 0
    // The edges in so far are this run's; one queued while it runs waits for the next, whenever the core looks.
    bank[CMD.IN_UPTO] = Atomics.load(this.ctl, CTL.IN_HEAD)
    encodeClock(bank, CMD.HSE_HZ, this.hse)
    encodeClock(bank, CMD.LSE_HZ, this.lse)
    this.resetPending = false
    this.battery = 0
    this.seq++
    this.runs++
    this.targetTime = end
    this.inFlight = true
    Atomics.store(this.ctl, CTL.SEQ, this.seq)
    Atomics.notify(this.ctl, CTL.SEQ)
    // The next command bank starts clean: a sampled level is for one run (a pad on the
    // exact-time path is not sampled, and must not be dragged back to a stale level), while
    // the ADC voltages carry over until the next solve rewrites them.
    const nxt = this.next
    nxt.fill(0, CMD.LEVELS, CMD.ANALOG)
    nxt.set(bank.subarray(CMD.ANALOG, CMD.SIZE), CMD.ANALOG)
  }
  padDrive(pad: PadRef) {
    return decodeDrive(this.outBank[OUT.DRIVE + pad.port * 16 + pad.pin])
  }
  private version = 0
  padVersion() {
    return this.version
  }
  dutyPads(): number[] {
    const out: number[] = []
    for (const key of this.pads) if (this.outBank[OUT.DUTY + key] >= 0) out.push(key)
    return out
  }
  takeDuty(pad: PadRef, interval: number) {
    const key = pad.port * 16 + pad.pin
    const acc = this.outBank[OUT.DUTY + key]
    if (acc < 0) {
      this.dutyPrev[key] = 0
      return null
    }
    const high = acc - this.dutyPrev[key]
    this.dutyPrev[key] = acc
    return interval > 0 ? Math.min(1, Math.max(0, high / interval)) : 0
  }
  drainEdges() {
    const out = this.edges
    this.edges = []
    return out
  }
  supplyCurrent() {
    return this.outBank[OUT.IDD]
  }
  private statusAsked = 0
  private statusGot = 0
  status(): CoreStatus {
    this.post({ t: "status", seq: ++this.statusAsked })
    // Where replies can be taken synchronously (node), give the core a moment to answer (it may
    // still be in a batch of quiet steps), so a script reading the status right after a run
    // sees this run's figures.
    if (this.transport.poll) {
      const deadline = performance.now() + (this.lastStatus ? 50 : 100)
      for (;;) {
        this.transport.poll()
        if (this.statusGot >= this.statusAsked || performance.now() > deadline) break
      }
    }
    const s = this.lastStatus
    const host: CoreStatus["host"] = this.sync ? "worker (in step)" : "worker (pipelined)"
    if (!s)
      return {
        running: this.runningFlag,
        halted: this.haltedFlag ? this.haltReason : null,
        time: this.lastTime,
        pc: 0,
        instructions: 0,
        sysclk: 0,
        faults: [],
        unmodelled: [],
        resets: 0,
        lastReset: null,
        backupKept: false,
        power: { mode: "run", asleep: 0, current: 0, regulator: "main" },
        clock: { source: "HSI", pllSource: "HSI", sysclk: 0, hse: null, lse: null, problems: [] },
        debug: this.stopFlag,
        host,
      }
    return { ...s, running: this.runningFlag, halted: this.haltedFlag ? (this.haltReason ?? s.halted ?? "halted") : null, time: this.lastTime, debug: this.stopFlag, host }
  }
  capturePanel(panel: PanelWiring, wall: number, powered: boolean) {
    const wired: [PanelSignal, PadRef][] = []
    for (const [signal, w] of panel.wired) if (w.host === this) wired.push([signal, w.pad])
    const wiring = JSON.stringify(wired)
    let f = this.frames.get(panel.object)
    if (!f || f.wiring !== wiring) {
      f = { frame: null, status: f?.status ?? "no signal", wiring }
      this.frames.set(panel.object, f)
      this.post({ t: "panel", object: panel.object, spec: panel.spec, wired })
    }
    this.post({ t: "capture", object: panel.object, wall, powered })
    this.transport.poll?.()
    const frame = f.frame
    f.frame = null
    return { frame, status: f.status }
  }
  dropPanel(object: string) {
    this.frames.delete(object)
    this.post({ t: "drop", object })
  }
  debug(cmd: CoreDebugCommand) {
    // The worker takes it before the next run; a core going on is running from now on as far as the loop is concerned.
    this.finish()
    this.post({ t: "debug", cmd })
    if (cmd.op === "resume" || cmd.op === "step") {
      this.stopFlag = null
      this.runningFlag = this.loadedFlag && !this.haltedFlag
    }
  }
  get debugStop() {
    return this.stopFlag
  }
  inspect(req: InspectRequest): Promise<InspectReply> {
    const seq = ++this.inspectSeq
    return new Promise((resolve) => {
      this.inspecting.set(seq, resolve)
      this.post({ t: "inspect", seq, req })
      // Where replies are taken synchronously (node), wait for this one here, as `status` does.
      if (this.transport.poll) {
        const deadline = performance.now() + 2000
        while (this.inspecting.has(seq) && performance.now() < deadline) this.transport.poll()
      }
    })
  }
  dispose() {
    this.transport.terminate()
    for (const done of this.inspecting.values()) done({ regs: null, memory: [], stop: null, time: 0, halted: "the core is gone" })
    this.inspecting.clear()
  }
}

/** A core for a board: remote when a spawner is at hand, else in this thread. */
export function makeCore(chipId: string | undefined, external: MemoryRegion[] | undefined, spawn: (() => CoreTransport) | null): CoreHost {
  const chip = (chipId && chipById(chipId)) || STM32F429ZI
  if (spawn) {
    try {
      return new RemoteCore(chip, external ?? [], spawn())
    } catch {
      // No SharedArrayBuffer (not cross-origin isolated) or no worker: in-process it is.
    }
  }
  return new LocalCore(chip, external ?? [])
}
