import * as React from "react"
import { pinKey, type Damage, type PartState, type Schematic } from "@/schematic/types"
import type { Failure, ProbeReading, Reading, TraceChunk } from "./engine"
import type { LogicChunk, McuStatus, Probe, Snapshot } from "./loop"
import type { FromWorker, ToWorker } from "./worker"

export type SimReadout = {
  /** Solver advancing. `live` also covers a paused simulation still showing its last state. */
  running: boolean
  live: boolean
  paused: boolean
  time: number
  converged: boolean
  /** True when a source in the circuit has an AC component; RMS values are then available. */
  ac: boolean
  /** Voltage of a pin; undefined when the pin is not part of a solved net. */
  pinVoltage: (object: string, pin: string) => number | undefined
  /** RMS voltage of a pin over the last few cycles; undefined when not solved or not an AC circuit. */
  pinVoltageRms: (object: string, pin: string) => number | undefined
  /** Parts whose state the simulation determines (LEDs), keyed by partKey. */
  parts: Record<string, PartState & { level: number }>
  /** Mean amps per wire id since the previous snapshot, positive from `wire.from` to `wire.to`. */
  wireCurrent: Map<string, number>
  /** Mean |amps| per wire: how much flows regardless of direction. */
  wireCurrentAbs: Map<string, number>
  /** Flow marker position per wire, world px, integrated from the real current by the solver. */
  wirePhase: Map<string, number>
  /** Current into a component pin; undefined when no solved element terminates there. */
  pinCurrent: (object: string, pin: string) => number | undefined
  /** What a probe reads, by the id it was registered under. */
  probe: (id: string) => (ProbeReading & { live: boolean }) | undefined
  /** Burnt components by object id. Cleared on every run. */
  damage: Record<string, Damage>
  /** Operating points of an object's model elements, in model order. */
  readings: (object: string) => Reading[]
  /** State of the emulated MCU on a board object, when it has firmware. */
  mcu: (object: string) => McuStatus | undefined
  /** What a serial terminal has received. */
  terminal: (object: string) => { text: string; framingErrors: number } | undefined
  /** A digital part's own state (an EEPROM's bytes). */
  digital: (object: string) => unknown
}

const idle: SimReadout = {
  running: false,
  live: false,
  paused: false,
  time: 0,
  converged: true,
  ac: false,
  pinVoltage: () => undefined,
  pinVoltageRms: () => undefined,
  parts: {},
  wireCurrent: new Map(),
  wireCurrentAbs: new Map(),
  wirePhase: new Map(),
  pinCurrent: () => undefined,
  probe: () => undefined,
  damage: {},
  readings: () => [],
  mcu: () => undefined,
  terminal: () => undefined,
  digital: () => undefined,
}

/** Turn the worker's plain data into the lookup shape the components expect. */
function toReadout(s: Snapshot): SimReadout {
  const byObject = new Map<string, Reading[]>()
  for (const r of s.readings) {
    const list = byObject.get(r.object)
    if (list) list.push(r)
    else byObject.set(r.object, [r])
  }
  for (const list of byObject.values()) list.sort((a, b) => a.element - b.element)
  return {
    running: true,
    live: true,
    paused: false,
    time: s.time,
    converged: s.converged,
    ac: s.ac,
    parts: s.parts,
    damage: s.damage,
    wireCurrent: new Map(Object.entries(s.wireCurrent)),
    wireCurrentAbs: new Map(Object.entries(s.wireCurrentAbs)),
    wirePhase: new Map(Object.entries(s.wirePhase)),
    readings: (object) => byObject.get(object) ?? [],
    pinVoltage: (object, pin) => s.pinVoltage[pinKey(object, pin)],
    pinVoltageRms: (object, pin) => s.pinVoltageRms[pinKey(object, pin)],
    pinCurrent: (object, pin) => s.pinCurrent[pinKey(object, pin)],
    probe: (id) => s.probes[id],
    mcu: (object) => s.mcus[object],
    terminal: (object) => s.terminals[object],
    digital: (object) => s.digital[object],
  }
}

export type SimOptions = {
  /** Simulated seconds per real second; 1 is real time. */
  speed?: number
  /** Voltages to track across every solver step; the array identity drives the update. */
  probes?: Probe[]
  onFailure?: (f: Failure) => void
  /** Oscilloscope resolution, seconds per sample; 0 collects nothing. */
  traceBucket?: number
  /** Called with every run of oscilloscope samples the worker sends, with the probe ids in order. */
  onTrace?: (chunk: TraceChunk, probes: string[]) => void
  /** Logic analyser on: probed nets are recorded as exact-time edges. */
  logic?: boolean
  onLogic?: (chunk: LogicChunk, probes: string[]) => void
}

const NO_PROBES: Probe[] = []

/**
 * Runs the electrical simulation on a worker thread, at `speed` × real time.
 * The solver never touches the main thread, so panning, zooming and typing stay smooth
 * however heavy the circuit is. `restart` throws the state away and starts from t = 0.
 */
export function useSimulation(
  doc: Schematic,
  running: boolean,
  { speed = 1, probes = NO_PROBES, onFailure, traceBucket = 0, onTrace, logic = false, onLogic }: SimOptions = {},
) {
  const [readout, setReadout] = React.useState<SimReadout>(idle)
  /** True once the worker has taken a step: there is then state a restart would throw away. */
  const [started, setStarted] = React.useState(false)
  const workerRef = React.useRef<Worker | null>(null)
  const onFailureRef = React.useRef(onFailure)
  const onTraceRef = React.useRef(onTrace)
  const onLogicRef = React.useRef(onLogic)
  React.useEffect(() => {
    onFailureRef.current = onFailure
    onTraceRef.current = onTrace
    onLogicRef.current = onLogic
  }, [onFailure, onTrace, onLogic])

  React.useEffect(() => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })
    workerRef.current = worker
    worker.onmessage = (e: MessageEvent<FromWorker>) => {
      const msg = e.data
      if (msg.t === "snapshot") {
        if (msg.snapshot && msg.snapshot.trace.count > 0) onTraceRef.current?.(msg.snapshot.trace, msg.snapshot.traceProbes)
        if (msg.snapshot?.logic) onLogicRef.current?.(msg.snapshot.logic, msg.snapshot.traceProbes)
        setReadout(msg.snapshot ? toReadout(msg.snapshot) : idle)
        // A null snapshot is the worker acknowledging a restart: nothing left to start over from.
        if (!msg.snapshot) setStarted(false)
      } else if (msg.t === "started") setStarted(true)
      else onFailureRef.current?.(msg.failure)
    }
    return () => {
      workerRef.current = null
      worker.terminate()
    }
  }, [])

  const send = React.useCallback((msg: ToWorker) => workerRef.current?.postMessage(msg), [])

  // Topology and values: anything that changes the netlist.
  const topology = React.useMemo(
    () => ({ objects: doc.objects, wires: doc.wires }),
    [doc.objects, doc.wires],
  )
  React.useEffect(() => {
    send({ t: "doc", doc: { ...topology, parts: {} } })
  }, [send, topology])

  // Switch and button states are pushed live; they do not rebuild the netlist.
  React.useEffect(() => {
    send({ t: "parts", parts: doc.parts })
  }, [send, doc.parts])

  React.useEffect(() => {
    send({ t: "probes", probes })
  }, [send, probes])

  React.useEffect(() => {
    send({ t: "speed", speed })
  }, [send, speed])

  React.useEffect(() => {
    send({ t: "trace", bucket: traceBucket })
  }, [send, traceBucket])

  React.useEffect(() => {
    send({ t: "logic", on: logic })
  }, [send, logic])

  React.useEffect(() => {
    send({ t: "running", running })
  }, [send, running])

  const restart = React.useCallback(() => {
    setReadout(idle)
    setStarted(false)
    send({ t: "restart" })
  }, [send])

  /** Type into a serial terminal on the field. */
  const sendSerial = React.useCallback((object: string, text: string) => send({ t: "serial", object, text }), [send])

  // Pausing freezes the picture: the last state stays on screen, marked paused, until a restart.
  const sim = React.useMemo<SimReadout>(() => {
    if (running) return readout
    if (!readout.live) return { ...idle, damage: readout.damage }
    return { ...readout, running: false, paused: true }
  }, [running, readout])
  return { sim, restart, started, sendSerial }
}
