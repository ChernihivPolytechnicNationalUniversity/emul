/**
 * A core of its own: one emulated MCU in a dedicated worker, driven by the loop through the
 * shared-memory protocol in `src/sim/core-host.ts`. Runs both as a browser worker (spawned by
 * the simulation worker) and as a node `worker_threads` worker (spawned by the scripts). The
 * MCU is the same in-process host the loop would use (an STM32's `LocalCore`, an `AvrCore`, a
 * `PicCore`): the worker only moves what crosses between it and the loop.
 *
 * The worker sits in `Atomics.wait` on the run sequence; on each run it applies the command
 * bank (reset, boot pin, clocks, sampled pad levels, ADC voltages, queued exact-time edges),
 * runs the core to the target, then publishes the output bank (time, flags, supply current,
 * every pad's drive and cumulative high time) and the edges made. Messages (firmware, panel
 * wiring, status and frame requests) are handled between runs: the loop counts them in a
 * control word so the worker knows when to yield to its event loop.
 */
import { READS_ONLY_THE_CIRCUIT } from "./periph/gpio"
import type { PadRef } from "./pads"
import type { PanelSignal } from "@/schematic/types"
import { CMD, CMD_BACKUP, CMD_BOOT0, CMD_RESET, CMD_STEPS, CMD_SUPPLY_KEPT, CMD_YIELD, CTL, IN_RING, OUT, OUT_HALTED, OUT_LOADED, OUT_RING, OUT_RUNNING, OUT_STOPPED, PAD_KEYS, SHM, STOP_REASONS, TRAIT_KNOWN, TRAIT_NO_RESET_PIN, decodeClock, decodeSample, encodeDrive, makeCore, type CoreHost, type FromCore, type PanelWiring, type ToCore } from "@/sim/core-host"

type Port = { post(msg: FromCore, transfer?: ArrayBuffer[]): void; onMessage(cb: (msg: ToCore) => void): void }

/** The message port of whichever environment spawned us. */
async function port(): Promise<Port> {
  if (typeof self !== "undefined" && typeof (self as { postMessage?: unknown }).postMessage === "function") {
    const w = self as unknown as DedicatedWorkerGlobalScope
    return { post: (msg, transfer) => w.postMessage(msg, transfer ?? []), onMessage: (cb) => (w.onmessage = (e) => cb(e.data as ToCore)) }
  }
  const spec = "node:worker_threads"
  type ParentPort = { postMessage(msg: unknown, transfer?: ArrayBuffer[]): void; on(ev: "message", cb: (msg: ToCore) => void): void }
  const { parentPort } = (await import(/* @vite-ignore */ spec)) as { parentPort: ParentPort | null }
  if (!parentPort) throw new Error("core worker started without a parent")
  // Replies go over the port the spawner handed us (readable synchronously), else back up the parent port.
  const reply = ((globalThis as { __emulReplyPort?: ParentPort }).__emulReplyPort ?? parentPort) as ParentPort
  return { post: (msg, transfer) => reply.postMessage(msg, transfer ?? []), onMessage: (cb) => parentPort.on("message", cb) }
}

const p = await port()
let core: CoreHost | null = null
let ctl: Int32Array
let f64: Float64Array
let cmdBanks: Float64Array[] = []
let outBanks: Float64Array[] = []
/** The panels wired to this core, as the loop last described them. */
const panels = new Map<string, PanelWiring>()
/** Cumulative high time per pad for the duty accounting; -1 while nothing drives the pad that way. */
const dutyAcc = new Float64Array(PAD_KEYS).fill(-1)
/** Frames asked for since the last run, served once the run is done. */
const captures: { object: string; wall: number; powered: boolean }[] = []
/** Sequence of the status request to answer, 0 when none is pending. */
let statusWanted = 0
/** Pads the circuit is wired to, the only ones reported per run. */
let padList = new Int32Array(0)
/** What the core was last handed per pad, so only changes go in. */
const readback = new Float64Array(PAD_KEYS)
const analog = new Float64Array(PAD_KEYS).fill(NaN)
const sourceOhms = new Float64Array(PAD_KEYS).fill(NaN)
const sourceFarads = new Float64Array(PAD_KEYS).fill(NaN)

/** A message port ping: resolves after every task already queued (the pending messages) ran. */
const channel = new MessageChannel()
const yieldToEvents = () =>
  new Promise<void>((resolve) => {
    channel.port1.onmessage = () => resolve()
    channel.port2.postMessage(0)
  })

/** Messages taken so far; the loop counts what it posted, so the worker knows when it has them all. */
let received = 0
/** Yield to the event loop until every message the loop has posted so far has been handled. */
async function drain(posted: number) {
  for (let i = 0; received < posted && i < 10000; i++) await yieldToEvents()
}

const padOf = (key: number): PadRef => ({ port: key >>> 4, pin: key & 15 })

p.onMessage((msg) => {
  received++
  handle(msg)
  traits()
  if (ctl) {
    Atomics.store(ctl, CTL.TAKEN, received)
    Atomics.notify(ctl, CTL.TAKEN)
  }
})

function handle(msg: ToCore) {
  switch (msg.t) {
    case "init": {
      core = makeCore(msg.chip, msg.external, null)
      core.setPads(padList)
      ctl = new Int32Array(msg.shm, 0, CTL.WORDS)
      f64 = new Float64Array(msg.shm, SHM.f64Base)
      cmdBanks = [0, 1].map((b) => f64.subarray(SHM.cmd + b * CMD.SIZE, SHM.cmd + (b + 1) * CMD.SIZE))
      outBanks = [0, 1].map((b) => f64.subarray(SHM.out + b * OUT.SIZE, SHM.out + (b + 1) * OUT.SIZE))
      Atomics.store(ctl, CTL.READY, 1)
      break
    }
    case "load":
      core?.load(msg.data, msg.name)
      break
    case "configure":
      core?.configure?.(msg.props)
      break
    case "rc":
      core?.setRcNetwork?.(msg.hz, msg.erOhms)
      break
    case "watch":
      core?.setDigitalWatch(msg.keys)
      break
    case "pads":
      padList = Int32Array.from(msg.keys)
      core?.setPads(padList)
      break
    case "status":
      statusWanted = msg.seq
      break
    case "panel": {
      if (!core) break
      const wired = new Map<PanelSignal, { host: CoreHost; pad: PadRef }>()
      for (const [signal, pad] of msg.wired) wired.set(signal, { host: core, pad })
      panels.set(msg.object, { object: msg.object, spec: msg.spec, wired })
      break
    }
    case "capture":
      captures.push(msg)
      break
    case "drop":
      panels.delete(msg.object)
      core?.dropPanel(msg.object)
      break
    case "debug":
      core?.debug(msg.cmd)
      break
    case "reference":
      p.post({ t: "reference", seq: msg.seq, text: core?.referenceProblem?.(msg.volts, msg.wiring) ?? null })
      break
    case "inspect": {
      // The core is between runs whenever a message is taken; the in-process hosts answer at once.
      const seq = msg.seq
      const asked = core ? core.inspect(msg.req) : Promise.resolve({ regs: null, memory: [], stop: null, time: 0, halted: "no core" })
      void asked.then((reply) => p.post({ t: "inspected", seq, reply }, reply.memory.map((c) => c.bytes.buffer as ArrayBuffer)))
      break
    }
  }
}

/** The supply voltage the loop last gave, for the input thresholds; NaN until it has. */
let vdd = NaN

function publish(parity: number, running: boolean, idd: number) {
  const c = core!
  const out = outBanks[parity]
  out[OUT.TIME] = c.time
  const stop = c.debugStop
  out[OUT.FLAGS] = (c.loaded ? OUT_LOADED : 0) | (running ? OUT_RUNNING : 0) | (c.halted ? OUT_HALTED : 0) | (stop ? OUT_STOPPED : 0)
  out[OUT.STOP_PC] = stop ? stop.pc : 0
  out[OUT.STOP_REASON] = stop ? STOP_REASONS.indexOf(stop.reason) : 0
  out[OUT.IDD] = lastIdd = idd
  out[OUT.POR] = c.porThreshold
  const supply = Number.isFinite(vdd) ? vdd : c.chip.electrical.vdd
  for (let i = 0; i < padList.length; i++) {
    const key = padList[i]
    const pad = padOf(key)
    out[OUT.DRIVE + key] = encodeDrive(c.padDrive(pad))
    // Duty as cumulative high seconds: the loop differences it over its own interval.
    const d = c.takeDuty(pad, DUTY_INTERVAL)
    if (d === null) dutyAcc[key] = -1
    else dutyAcc[key] = (dutyAcc[key] < 0 ? 0 : dutyAcc[key]) + d * DUTY_INTERVAL
    out[OUT.DUTY + key] = dutyAcc[key]
    if (c.inputThresholds) {
      const th = c.inputThresholds(pad, supply)
      out[OUT.VIH + key] = th.high
      out[OUT.VIL + key] = th.low
    }
  }
  // Edges out, oldest first; a full ring drops the newest and counts them.
  const edges = c.drainEdges()
  if (edges.length) {
    let head = Atomics.load(ctl, CTL.OUT_HEAD)
    const tail = Atomics.load(ctl, CTL.OUT_TAIL)
    for (const e of edges) {
      if (head - tail >= OUT_RING) {
        Atomics.add(ctl, CTL.DROPPED, 1)
        continue
      }
      const at = SHM.outRing + (head % OUT_RING) * 2
      f64[at] = e.time
      f64[at + 1] = (e.pad.port * 16 + e.pad.pin) * 4 + (e.level === null ? 2 : e.level ? 1 : 0)
      head++
    }
    Atomics.store(ctl, CTL.OUT_HEAD, head)
  }
}
/** `takeDuty` measures against an interval; the value is turned back into seconds, so any interval does. */
const DUTY_INTERVAL = 1
/** The supply current last reported: what the loop saw before a batch of steps. */
let lastIdd = 0

/** Every reported pad's duty so far, as `publish` counts it. */
function accumulateDuty() {
  const c = core!
  for (let i = 0; i < padList.length; i++) {
    const key = padList[i]
    const d = c.takeDuty(padOf(key), DUTY_INTERVAL)
    if (d === null) dutyAcc[key] = -1
    else dutyAcc[key] = (dutyAcc[key] < 0 ? 0 : dutyAcc[key]) + d * DUTY_INTERVAL
  }
}

/** Apply the queued exact-time edges (the digital fast path in). */
function takeEdgesIn(head: number) {
  const c = core!
  let tail = Atomics.load(ctl, CTL.IN_TAIL)
  for (; tail < head; tail++) {
    const at = SHM.inRing + (tail % IN_RING) * 2
    const code = f64[at + 1]
    c.setPadAt(padOf(code >>> 2), (code & 3) === 1, f64[at])
  }
  Atomics.store(ctl, CTL.IN_TAIL, tail)
}

/** What the loop sampled for this run: levels, ADC voltages and their sources, readback codes. */
function takePads(cmd: Float64Array) {
  const c = core!
  for (let key = 0; key < PAD_KEYS; key++) {
    const code = cmd[CMD.READBACK + key] || READS_ONLY_THE_CIRCUIT
    if (code !== readback[key]) {
      readback[key] = code
      c.setReadback(padOf(key), code)
    }
    const v = cmd[CMD.ANALOG + key]
    if (!Number.isNaN(v) && v !== analog[key]) {
      analog[key] = v
      c.setAnalog(padOf(key), v)
    }
    const ohms = cmd[CMD.SOURCE_OHMS + key]
    const farads = cmd[CMD.SOURCE_FARADS + key]
    if (!Number.isNaN(ohms) && (ohms !== sourceOhms[key] || farads !== sourceFarads[key])) {
      sourceOhms[key] = ohms
      sourceFarads[key] = farads
      c.setAnalogSource(padOf(key), ohms, farads)
    }
    const lv = cmd[CMD.LEVELS + key]
    if (lv === 0) continue
    const sample = decodeSample(lv)
    c.setPad(padOf(key), sample.level, sample.sampledUnder)
  }
}

function run(seq: number) {
  const c = core!
  const parity = seq & 1
  const cmd = cmdBanks[parity]
  const flags = cmd[CMD.FLAGS]
  c.boot0 = (flags & CMD_BOOT0) !== 0
  if (flags & CMD_RESET) {
    if (cmd[CMD.BATTERY] > 0) c.runOnBattery(cmd[CMD.BATTERY])
    c.reset({ backup: (flags & CMD_BACKUP) !== 0, supplyKept: (flags & CMD_SUPPLY_KEPT) !== 0 })
    dutyAcc.fill(-1)
  }
  c.setClockSources(decodeClock(cmd, CMD.HSE_HZ), decodeClock(cmd, CMD.LSE_HZ))
  if (Number.isFinite(cmd[CMD.VDD])) c.setSupply((vdd = cmd[CMD.VDD]))
  if (Number.isFinite(cmd[CMD.VBAT])) c.setBattery(cmd[CMD.VBAT])
  if (Number.isFinite(cmd[CMD.VREF])) c.setReference(cmd[CMD.VREF])
  if (Number.isFinite(cmd[CMD.VRESET])) c.setResetVoltage?.(cmd[CMD.VRESET])
  c.yieldOnOutput = (flags & CMD_YIELD) !== 0
  takePads(cmd)
  takeEdgesIn(cmd[CMD.IN_UPTO])
  const target = cmd[CMD.TARGET]
  let running = c.running
  if (flags & CMD_STEPS) {
    // The duty the loop has taken up to the last step: the quiet steps' part counted in, step by step.
    const out = outBanks[parity]
    out.set(dutyAcc, OUT.DUTY_BASE)
    let past = 0
    const quiet = () => {
      accumulateDuty()
      out.set(dutyAcc, OUT.DUTY_BASE)
      Atomics.store(ctl, CTL.PROGRESS, ++past)
      return true
    }
    out[OUT.STEPS] = c.runSteps(target, cmd[CMD.BASE], cmd[CMD.STEP], cmd[CMD.STEPS], c.padVersion(), lastIdd, quiet, () => {})
    publish(parity, c.running, c.supplyCurrent())
    return
  }
  if (running) {
    if (c.yieldOnOutput) running = c.runUntil(target)
    else while (c.time < target && c.running) if (!c.runUntil(target)) break
    running = c.running
  }
  publish(parity, running, c.supplyCurrent())
}

/** What the core's settings make of it, for the loop to read at any time. */
function traits() {
  if (core) Atomics.store(ctl, CTL.TRAITS, TRAIT_KNOWN | (core.resetPin === false ? TRAIT_NO_RESET_PIN : 0))
}

function haltOn(error: unknown, seq: number) {
  const c = core!
  const out = outBanks[seq & 1]
  c.halt(`emulator error: ${error instanceof Error ? error.message : String(error)}`)
  out[OUT.STEPS] = Atomics.load(ctl, CTL.PROGRESS) + 1
  try {
    publish(seq & 1, false, 0)
  } catch {
    out[OUT.FLAGS] = (c.loaded ? OUT_LOADED : 0) | OUT_HALTED
  }
}

async function main() {
  let seen = 0
  let mail = 0
  for (;;) {
    // Wait for the next run (spinning briefly first); while idle, look at the mailbox.
    while (Atomics.load(ctl, CTL.SEQ) === seen) {
      for (let i = 0; i < 20000 && Atomics.load(ctl, CTL.SEQ) === seen; i++);
      if (Atomics.load(ctl, CTL.SEQ) === seen) Atomics.wait(ctl, CTL.SEQ, seen, 1)
      if (Atomics.load(ctl, CTL.MAIL) !== mail) {
        mail = Atomics.load(ctl, CTL.MAIL)
        await drain(mail)
        serve()
      }
    }
    seen = Atomics.load(ctl, CTL.SEQ)
    // Messages posted before the run was issued (firmware, pads to report) apply to it.
    if (Atomics.load(ctl, CTL.MAIL) !== mail) {
      mail = Atomics.load(ctl, CTL.MAIL)
      await drain(mail)
    }
    try {
      run(seen)
    } catch (e) {
      haltOn(e, seen)
    }
    Atomics.store(ctl, CTL.ACK, seen)
    Atomics.notify(ctl, CTL.ACK)
    serve()
  }
}

/** Answer what the messages asked for: status and panel frames. */
function serve() {
  if (!core) return
  if (statusWanted) {
    const seq = statusWanted
    statusWanted = 0
    p.post({ t: "status", seq, status: { ...core.status(), host: "worker (pipelined)" } })
  }
  while (captures.length) {
    const c = captures.shift()!
    const panel = panels.get(c.object)
    if (!panel) continue
    const r = core.capturePanel(panel, c.wall, c.powered)
    p.post({ t: "frame", object: c.object, frame: r.frame, status: r.status }, r.frame ? [r.frame] : [])
  }
}

// The init message comes first; nothing to do until it has.
while (!core) await yieldToEvents()
void main()
