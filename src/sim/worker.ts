/// <reference lib="webworker" />
import type { PartState, Schematic } from "@/schematic/types"
import type { Failure } from "./engine"
import { SimLoop, type Probe, type Snapshot } from "./loop"

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

export type FromWorker =
  | { t: "snapshot"; snapshot: Snapshot | null }
  | { t: "failure"; failure: Failure }
  | { t: "started" }

const loop = new SimLoop()
const post = (msg: FromWorker) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(msg)

loop.onFailure = (failure) => post({ t: "failure", failure })

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
  if (now - lastReport < REPORT_MS) return
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
      // Pausing keeps the last snapshot on screen; only a restart clears it.
      setTimer(msg.running)
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
