/**
 * A core of its own: one emulated MCU in a dedicated worker, driven by the loop through the
 * shared-memory protocol in `src/sim/core-host.ts`. Runs both as a browser worker (spawned by
 * the simulation worker) and as a node `worker_threads` worker (spawned by the scripts).
 *
 * The worker sits in `Atomics.wait` on the run sequence; on each run it applies the command
 * bank (reset, boot pin, clocks, sampled pad levels, ADC voltages, queued exact-time edges),
 * runs the core to the target, then publishes the output bank (time, flags, supply current,
 * every pad's drive and cumulative high time) and the edges made. Messages (firmware, panel
 * wiring, status and frame requests) are handled between runs: the loop counts them in a
 * control word so the worker knows when to yield to its event loop.
 */
import { chipById, STM32F429ZI } from "./chip"
import { CpuHalt } from "./faults"
import { Stm32, type PadRef } from "./stm32f429"
import { PanelInstance } from "@/sim/display"
import { CMD, CMD_BACKUP, CMD_BOOT0, CMD_RESET, CMD_STEPS, CMD_YIELD, CTL, IN_RING, OUT, OUT_HALTED, OUT_LOADED, OUT_RING, OUT_RUNNING, PAD_KEYS, SHM, decodeClock, encodeDrive, statusOf, type FromCore, type ToCore } from "@/sim/core-host"

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
let mcu: Stm32 | null = null
let ctl: Int32Array
let f64: Float64Array
let cmdBanks: Float64Array[] = []
let outBanks: Float64Array[] = []
const panels = new Map<string, PanelInstance>()
/** Cumulative high time per pad for the duty accounting; -1 while nothing drives the pad that way. */
const dutyAcc = new Float64Array(PAD_KEYS).fill(-1)
/** Frames asked for since the last run, served once the run is done. */
const captures: { object: string; wall: number; powered: boolean }[] = []
/** Sequence of the status request to answer, 0 when none is pending. */
let statusWanted = 0
/** Pads the circuit is wired to, the only ones reported per run. */
let padList = new Int32Array(0)

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

p.onMessage((msg) => {
  received++
  switch (msg.t) {
    case "init": {
      const chip = chipById(msg.chip) ?? STM32F429ZI
      mcu = new Stm32(chip, msg.external)
      ctl = new Int32Array(msg.shm, 0, CTL.WORDS)
      f64 = new Float64Array(msg.shm, SHM.f64Base)
      cmdBanks = [0, 1].map((b) => f64.subarray(SHM.cmd + b * CMD.SIZE, SHM.cmd + (b + 1) * CMD.SIZE))
      outBanks = [0, 1].map((b) => f64.subarray(SHM.out + b * OUT.SIZE, SHM.out + (b + 1) * OUT.SIZE))
      // The ADC reads the voltage the loop last wrote for the pad (NaN: none).
      mcu.analogRead = (pad) => {
        const v = analogBank[CMD.ANALOG + pad.port * 16 + pad.pin]
        return Number.isNaN(v) ? null : v
      }
      Atomics.store(ctl, CTL.READY, 1)
      break
    }
    case "load":
      if (!mcu) break
      try {
        mcu.load(msg.data, msg.name)
      } catch (e) {
        mcu.firmware = null
        mcu.cpu.halted = new CpuHalt("fault", `cannot load firmware: ${(e as Error).message}`, 0)
      }
      break
    case "watch":
      if (!mcu) break
      mcu.digitalWatch.clear()
      for (const k of msg.keys) mcu.digitalWatch.add(k)
      break
    case "pads":
      padList = Int32Array.from(msg.keys)
      break
    case "status":
      statusWanted = msg.seq
      break
    case "panel": {
      const panel = panels.get(msg.object) ?? new PanelInstance(msg.object, msg.spec)
      panels.set(msg.object, panel)
      panel.wired.clear()
      if (mcu) for (const [signal, pad] of msg.wired) panel.wired.set(signal, { mcu, pad })
      break
    }
    case "capture":
      captures.push(msg)
      break
    case "drop":
      panels.delete(msg.object)
      break
  }
})

/** The command bank of the current run, for the ADC callback. */
let analogBank: Float64Array<ArrayBufferLike> = new Float64Array(0)

function publish(parity: number, running: boolean, idd: number) {
  const m = mcu!
  const out = outBanks[parity]
  out[OUT.TIME] = m.time
  out[OUT.FLAGS] = (m.firmware ? OUT_LOADED : 0) | (running ? OUT_RUNNING : 0) | (m.cpu.halted ? OUT_HALTED : 0)
  out[OUT.IDD] = lastIdd = idd
  out[OUT.POR] = m.porThreshold
  const pad: PadRef = { port: 0, pin: 0 }
  for (let i = 0; i < padList.length; i++) {
    const key = padList[i]
    pad.port = key >>> 4
    pad.pin = key & 15
    out[OUT.DRIVE + key] = encodeDrive(m.padDrive(pad))
    // Duty as cumulative high seconds: the loop differences it over its own interval.
    const d = m.takeDuty(pad, DUTY_INTERVAL)
    if (d === null) dutyAcc[key] = -1
    else dutyAcc[key] = (dutyAcc[key] < 0 ? 0 : dutyAcc[key]) + d * DUTY_INTERVAL
    out[OUT.DUTY + key] = dutyAcc[key]
  }
  // Edges out, oldest first; a full ring drops the newest and counts them.
  const edges = m.digitalOut
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
    edges.length = 0
  }
}
/** `takeDuty` measures against an interval; the value is turned back into seconds, so any interval does. */
const DUTY_INTERVAL = 1
/** The supply current last reported: what the loop saw before a batch of steps. */
let lastIdd = 0

/** Every reported pad's duty so far, as `publish` counts it. */
function accumulateDuty() {
  const m = mcu!
  const pad: PadRef = { port: 0, pin: 0 }
  for (let i = 0; i < padList.length; i++) {
    const key = padList[i]
    pad.port = key >>> 4
    pad.pin = key & 15
    const d = m.takeDuty(pad, DUTY_INTERVAL)
    if (d === null) dutyAcc[key] = -1
    else dutyAcc[key] = (dutyAcc[key] < 0 ? 0 : dutyAcc[key]) + d * DUTY_INTERVAL
  }
}

/** Apply the queued exact-time edges (the digital fast path in). */
function takeEdgesIn(head: number) {
  const m = mcu!
  let tail = Atomics.load(ctl, CTL.IN_TAIL)
  for (; tail < head; tail++) {
    const at = SHM.inRing + (tail % IN_RING) * 2
    const code = f64[at + 1]
    const key = code >>> 2
    m.setPadAt({ port: key >>> 4, pin: key & 15 }, (code & 3) === 1, f64[at])
  }
  Atomics.store(ctl, CTL.IN_TAIL, tail)
}

function run(seq: number) {
  const m = mcu!
  const parity = seq & 1
  const cmd = cmdBanks[parity]
  analogBank = cmd
  const flags = cmd[CMD.FLAGS]
  m.boot0 = (flags & CMD_BOOT0) !== 0
  if (flags & CMD_RESET) {
    if (cmd[CMD.BATTERY] > 0) m.runOnBattery(cmd[CMD.BATTERY])
    m.reset("por", { backup: (flags & CMD_BACKUP) !== 0 })
    dutyAcc.fill(-1)
  }
  m.setClockSources(decodeClock(cmd, CMD.HSE_HZ), decodeClock(cmd, CMD.LSE_HZ))
  m.yieldOnOutput = (flags & CMD_YIELD) !== 0
  const pad: PadRef = { port: 0, pin: 0 }
  for (let key = 0; key < PAD_KEYS; key++) {
    const lv = cmd[CMD.LEVELS + key]
    if (lv === 0) continue
    pad.port = key >>> 4
    pad.pin = key & 15
    m.setPad(pad, lv === 2)
  }
  takeEdgesIn(cmd[CMD.IN_UPTO])
  const target = cmd[CMD.TARGET]
  let running = m.running
  if (flags & CMD_STEPS) {
    // The duty the loop has taken up to the last step: the quiet steps' part counted in, step by step.
    const out = outBanks[parity]
    out.set(dutyAcc, OUT.DUTY_BASE)
    let past = 0
    out[OUT.STEPS] = running
      ? m.runSteps(target, cmd[CMD.BASE], cmd[CMD.STEP], cmd[CMD.STEPS], lastIdd, () => {
          accumulateDuty()
          out.set(dutyAcc, OUT.DUTY_BASE)
          Atomics.store(ctl, CTL.PROGRESS, ++past)
          return true
        })
      : 0
    publish(parity, m.running, running ? m.stepIdd : m.supplyCurrent())
    return
  }
  if (running) {
    if (m.yieldOnOutput) running = m.runUntil(target)
    else while (m.time < target && m.running) if (!m.runUntil(target)) break
    running = m.running
  }
  publish(parity, running, m.supplyCurrent())
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
    run(seen)
    Atomics.store(ctl, CTL.ACK, seen)
    Atomics.notify(ctl, CTL.ACK)
    serve()
  }
}

/** Answer what the messages asked for: status and panel frames. */
function serve() {
  if (!mcu) return
  if (statusWanted) {
    const seq = statusWanted
    statusWanted = 0
    p.post({ t: "status", seq, status: statusOf(mcu, "worker (pipelined)") })
  }
  while (captures.length) {
    const c = captures.shift()!
    const panel = panels.get(c.object)
    if (!panel) continue
    const r = panel.capture(c.wall, c.powered)
    p.post({ t: "frame", object: c.object, frame: r.frame, status: r.status }, r.frame ? [r.frame] : [])
  }
}

// The init message comes first; nothing to do until it has.
while (!mcu) await yieldToEvents()
void main()
