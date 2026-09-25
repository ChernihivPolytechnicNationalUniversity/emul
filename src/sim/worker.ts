/// <reference lib="webworker" />
import type { PartState, Schematic } from "@/schematic/types"
import type { Failure } from "./engine"
import type { CoreTransport, FromCore } from "./core-host"
import { SimLoop, type Probe, type Snapshot } from "./loop"
import type { CoreDebugCommand, DebugStop, InspectReply, InspectRequest } from "@/debug/protocol"

/** How often the worker reports back to the UI. */
const REPORT_MS = 50
/** Tick period while running; the loop catches up by wall clock, so this only sets the grain. */
const TICK_MS = 4

export type ToWorker =
  | { t: "doc"; doc: Schematic }
  | { t: "parts"; parts: Record<string, PartState> }
  | { t: "probes"; probes: Probe[] }
  | { t: "trace"; bucket: number }
  | { t: "logic"; on: boolean }
  | { t: "running"; running: boolean }
  | { t: "speed"; speed: number }
  | { t: "restart" }
  /** Text typed into a serial terminal. */
  | { t: "serial"; object: string; text: string }
  /** A debugger command for a board's core (breakpoints, vector catch, resume, a step). */
  | { t: "debug"; object: string; cmd: CoreDebugCommand }
  /** Registers and memory of a board's core; answered with `inspected` and the same id. */
  | { t: "inspect"; id: number; object: string; req: InspectRequest }
  /** Reset one board's core (the debugger's restart). */
  | { t: "reset-core"; object: string }

export type FromWorker =
  | { t: "snapshot"; snapshot: Snapshot | null }
  | { t: "failure"; failure: Failure }
  | { t: "started" }
  /** Cores stopped for the debugger; the bench is paused. */
  | { t: "debug-stop"; stops: { object: string; stop: DebugStop }[] }
  /** The bench started or stopped on its own account (a stop, a step): the UI's Run/Pause follows. */
  | { t: "running"; running: boolean }
  | { t: "inspected"; id: number; reply: InspectReply | null }

const loop = new SimLoop()
// Each core in a worker of its own, when the page is cross-origin isolated (SharedArrayBuffer);
// otherwise every core runs in this thread.
if (typeof SharedArrayBuffer !== "undefined" && (self as { crossOriginIsolated?: boolean }).crossOriginIsolated)
  loop.spawnCore = (): CoreTransport => {
    const w = new Worker(new URL("../mcu/core-worker.ts", import.meta.url), { type: "module" })
    return {
      post: (msg, transfer) => w.postMessage(msg, transfer ?? []),
      onMessage: (cb) => (w.onmessage = (e) => cb(e.data as FromCore)),
      terminate: () => w.terminate(),
    }
  }
const post = (msg: FromWorker) => {
  // Display frames are megabytes each: hand them over instead of copying.
  const transfer: Transferable[] = []
  if (msg.t === "snapshot" && msg.snapshot) for (const d of Object.values(msg.snapshot.displays)) if (d.frame) transfer.push(d.frame)
  ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(msg, transfer)
}

loop.onFailure = (failure) => post({ t: "failure", failure })

/** The running state the UI was last told, or told us. */
let reported = false
/** The bench runs or not as the loop now has it: the timer follows, and the UI hears of a change it did not ask for. */
function syncRunning() {
  setTimer(loop.running)
  if (loop.running === reported) return
  reported = loop.running
  post({ t: "running", running: loop.running })
}
loop.onDebugStop = (stops) => {
  // The picture at the stop, then the stop: the UI shows the bench as it was at that instant.
  post({ t: "snapshot", snapshot: loop.snapshot(true) })
  post({ t: "debug-stop", stops })
  syncRunning()
}

let timer: ReturnType<typeof setInterval> | null = null
let lastReport = 0
let announced = false

function tick() {
  const now = performance.now()
  const steps = loop.advance(now)
  if (steps > 0 && !announced) {
    announced = true
    post({ t: "started" })
  }
  // A debugger stop in this tick has sent its own picture; a paused bench sends none (null means a restart).
  if (!loop.running || now - lastReport < REPORT_MS) return
  lastReport = now
  post({ t: "snapshot", snapshot: loop.snapshot() })
}

function setTimer(on: boolean) {
  if (on === (timer !== null)) return
  if (on) timer = setInterval(tick, TICK_MS)
  else {
    clearInterval(timer!)
    timer = null
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const msg = e.data
  switch (msg.t) {
    case "doc":
      loop.setDoc(msg.doc)
      break
    case "parts":
      loop.setParts(msg.parts)
      break
    case "probes":
      loop.setProbes(msg.probes)
      break
    case "trace":
      loop.setTraceBucket(msg.bucket)
      break
    case "logic":
      loop.setLogic(msg.on)
      break
    case "running":
      loop.setRunning(msg.running)
      reported = msg.running
      // Pausing keeps the last snapshot on screen; only a restart clears it.
      setTimer(msg.running)
      break
    case "debug":
      loop.debug(msg.object, msg.cmd)
      syncRunning()
      break
    case "reset-core":
      loop.resetCore(msg.object)
      break
    case "inspect":
      void loop.inspect(msg.object, msg.req).then((reply) => {
        const transfer = reply ? reply.memory.map((c) => c.bytes.buffer as ArrayBuffer) : []
        ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ t: "inspected", id: msg.id, reply } satisfies FromWorker, transfer)
      })
      break
    case "speed":
      loop.speed = msg.speed
      break
    case "serial":
      loop.sendSerial(msg.object, msg.text)
      break
    case "restart":
      loop.restart()
      announced = false
      post({ t: "snapshot", snapshot: null })
      break
  }
}
