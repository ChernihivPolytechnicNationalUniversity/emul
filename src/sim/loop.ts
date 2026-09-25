import { getDef } from "@/schematic/registry"
import { partKey, pinKey, type ComponentDef, type Damage, type PartState, type Schematic } from "@/schematic/types"
import { parsePad, type PadRef } from "@/mcu/stm32f429"
import type { ClockSource } from "@/mcu/periph/rcc"
import { crystalStartup } from "@/schematic/components/clock"
import { parseValue } from "./units"
import { DT } from "./speeds"
import { Engine, type Failure, type PartReader, type PinReader, type ProbeReading, type Reading, type TraceChunk } from "./engine"
import { wireCurrents } from "./flow"
import { buildNetlist, GROUND, type GpioState } from "./netlist"
import { UartDecoder, uartFrameEdges, uartFrameSeconds, type Edge } from "./serial"
import { createDigitalPart, type DigitalPart } from "./digital"
import { PanelInstance } from "./display"
import { LocalCore, makeCore, type CoreHost, type CoreStatus, type CoreTransport, type PanelWiring } from "./core-host"
import type { BreakpointSpec, CoreDebugCommand, DebugStop, InspectReply, InspectRequest } from "@/debug/protocol"

/**
 * Shortest press a button registers, in simulated seconds. A mouse click can come and go
 * between two solver batches; a finger on a real button cannot, so the release is held back.
 */
const MIN_PRESS = 0.02
/** STM32 power-on reset threshold (DS9405/DS10916 VPOR/PDR ≈ 1.7 V); below it the core is held in reset. */
const VDD_POR = 1.7
/** NRST input low threshold: the reset pin is a Schmitt input like any other (VIL 0.3 VDD). */
/** How far one lockstepped core may run ahead of another (seconds). */
const LOCKSTEP_LEAD = 1e-6
const NRST_LOW = 0.3 * 3.3
/** VBAT keeps the backup domain above this (the datasheet's 1.65 V minimum). */
const VBAT_MIN = 1.65
/** BOOT0 counts as high above this (a TTL-ish threshold on the 3.3 V part). */
const BOOT_HIGH = 0.5 * 3.3
/** Below this on its VCC an oscillator module puts out nothing. */
const OSC_VCC_MIN = 2.0

/** Flow markers: idle below this current; speed in world px per simulated second and its cap. */
const FLOW_MIN = 1e-5
const FLOW_SPEED = 40
const FLOW_MAX_SPEED = 220

/** Schmitt thresholds of an STM32 input, as a fraction of VDD (DS9405: VIL 0.3 VDD, VIH 0.7 VDD). */
const VIH = 0.7 * 3.3
const VIL = 0.3 * 3.3

/** A serial terminal on the field: what it has received, and where its bits go. */
class TerminalInstance {
  readonly object: string
  baud: number
  decoder: UartDecoder
  /** Received bytes → text. A multi-byte character can straddle two snapshots, so it streams. */
  charset = "utf-8"
  textDecoder = new TextDecoder("utf-8")
  text = ""
  rxNet: number | undefined
  txNet: number | undefined
  /** Edges the terminal's own TX line goes through (for the analog level), and its current level. */
  txEdges: Edge[] = []
  txLevel = true
  /** Loop time the TX line is busy until. */
  txBusyUntil = 0
  constructor(object: string, baud: number) {
    this.object = object
    this.baud = baud
    this.decoder = new UartDecoder(baud)
  }
}

/**
 * A net on the exact-time digital path: every driver's current level (push-pull true/false,
 * open-drain or released null) and who hears the resolved level. Resolution is wired-AND
 * with a push-pull driver winning: low if anyone pulls low, else high if anyone drives high,
 * else whatever the pull-ups say (`released`, read off the analog circuit each step).
 */
class DigitalNet {
  readonly node: number
  /**
   * What each driver puts on the net. An MCU pad drives push-pull (`strong`); a digital part's
   * outputs are open-drain I²C-class drivers (rated to sink a few milliamps), so a pad driving
   * high wins over a part pulling low — as a bit-banged master's STOP does against a slave still
   * holding a data bit, which the touch demo relies on.
   */
  readonly drivers = new Map<string, { level: boolean | null; strong: boolean }>()
  level = true
  /** Level when nobody drives: a pull-up (true), a pull-down (false), or nothing — the line keeps its charge (null). */
  released: boolean | null = null
  pads: { inst: McuInstance; pad: PadRef }[] = []
  parts: { part: DigitalPart; pin: string }[] = []
  rx: TerminalInstance[] = []
  /** Other ends of resistors on the net: a resistor to a high node is a pull-up. */
  pulls: number[] = []
  /** Logic-analyser probes (indices into the probe list) watching this net. */
  logic: number[] = []
  /** A terminal's TX: its frames arrive as levels ahead of time (`sendSerial`), never from the analog side. */
  terminal = false
  constructor(node: number) {
    this.node = node
  }
  resolve(): boolean {
    let strongHigh = false
    let weakLow = false
    let weakHigh = false
    for (const d of this.drivers.values()) {
      if (d.level === null) continue
      if (d.strong) {
        if (!d.level) return false
        strongHigh = true
      } else if (d.level) weakHigh = true
      else weakLow = true
    }
    if (strongHigh) return true
    if (weakLow) return false
    if (weakHigh) return true
    return this.released ?? this.level
  }
}

/** Received text a terminal keeps; older output scrolls off. */
const TERMINAL_MAX = 8000

/** Windows-1251 for the 0x80–0xFF range, the other encoding STM32 labs in this part of the world use. */
const CP1251_HIGH = "ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00a0ЎўЈ¤Ґ¦§Ё©Є«¬\u00ad®Ї°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯабвгдежзийклмнопрстуфхцчшщъыьэюя"
const CP1251_INDEX = new Map([...CP1251_HIGH].map((c, i) => [c, 0x80 + i]))

/** Text → bytes in the terminal's charset: UTF-8 through TextEncoder, CP1251 by table, '?' for the rest. */
function encodeText(text: string, charset: string): Uint8Array {
  if (charset === "windows-1251") {
    const out: number[] = []
    for (const c of text) {
      const code = c.codePointAt(0)!
      out.push(code < 0x80 ? code : (CP1251_INDEX.get(c) ?? 0x3f))
    }
    return Uint8Array.from(out)
  }
  return new TextEncoder().encode(text)
}

/** What the UI shows about an MCU: where its core is and how it is doing. */
export type McuStatus = CoreStatus & {
  firmware: string
  /** VDD is up; below the power-on threshold the core is held in reset. */
  powered: boolean
}

/** A clock source found on an MCU's oscillator pins; an oscillator module only runs while its VCC net is up. */
type ClockFeed = { source: ClockSource | null; vccNet?: number }

/** An emulated MCU sitting on a board object, with the map from model nodes to its pads. */
class McuInstance {
  mcu: CoreHost
  /** Model node ("CN7-10", "$PB7") → pad. */
  readonly pads = new Map<string, PadRef>()
  /**
   * Pads that read from a solved net, refreshed on every engine rebuild: [pad, net index].
   * `digital` marks nets fed by the exact-time path (a terminal or another core), which the
   * analog sampler then leaves alone: its 20 µs quantization would mangle the bits.
   */
  inputs: { pad: PadRef; node: number; key: string; digital: boolean }[] = []
  /** Net index by pad (port*16+pin) for the same pads. */
  padNode = new Map<number, number>()
  /** The same inputs by pad (port*16+pin), for the duty sampling of PWM pads. */
  inputByPad = new Map<number, { pad: PadRef; node: number; key: string; digital: boolean }>()
  /**
   * Level to present for pads that switched within the step just run (PWM faster than the
   * analog step), by model node. Sampled at a random instant of the step, so over many steps
   * a load sees the true duty rather than whatever phase a fixed sampling point aliases to.
   */
  sampled = new Map<string, GpioState>()
  /** The step before's samples, swapped in each step to compare against. */
  sampledPrev = new Map<string, GpioState>()
  /** Pads that have received an exact-time edge: from then on the analog sampler leaves them alone. */
  readonly digitalPads = new Set<number>()
  /** Deliver an exact-time level to a pad, taking it over from the analog sampler. */
  drive(pad: PadRef, level: boolean, time: number) {
    this.digitalPads.add(pad.port * 16 + pad.pin)
    this.mcu.setPadAt(pad, level, time)
  }
  /** Shares a net with another core: runs in lockstep with it (see `runLockstep`). */
  coupled = false
  /** Pads (port·16 + pin) on nets with a digital part: traffic there needs answers at exact times. */
  readonly partPads = new Set<number>()
  /** A remote core with part traffic runs in step with the loop for this many runs after the last edge. */
  keepInStep() {
    if (this.mcu instanceof LocalCore) return
    ;(this.mcu as { keepInStep?: (runs: number) => void }).keepInStep?.(IN_STEP_RUNS)
  }
  /** Bring a remote core back into this thread (a peer to run in lockstep with turned up). */
  relocate() {
    if (this.mcu instanceof LocalCore) return
    const remote = this.mcu
    remote.dispose()
    const def = getDef(this.defId)
    this.mcu = makeCore(def?.chip, def?.mcuMemory, null)
    this.applyDebug()
    if (this.data) this.mcu.load(this.data.slice(0), this.name)
  }
  /** What the debugger has set for this board: kept here so a new core (a relocation) gets it too. */
  debug: { breakpoints: BreakpointSpec[]; faults: boolean } = { breakpoints: [], faults: false }
  applyDebug() {
    this.mcu.debug({ op: "breakpoints", list: this.debug.breakpoints })
    this.mcu.debug({ op: "catch", faults: this.debug.faults })
  }
  /** The firmware image, kept for a relocation. */
  data: ArrayBuffer | null = null
  readonly defId: string
  /** engine time − this core's own time, as of the current step: cores restart at 0 on reset. */
  offset = 0
  /** Engine time the core last started from zero, so it can be driven to the engine's clock. */
  base = 0
  /** Dead silicon: stays halted through power cycles and resets until the next run. */
  burnt = false
  /** What the pads last read as, for the engine to skip its scan while nothing changed. */
  padVersion = -1
  idd = 0
  padsLive = false
  /** Net of the pin that powers the MCU (undefined: unsolved, treated as powered), and whether it is up. */
  powerNet: number | undefined = undefined
  /** Net of NRST (undefined: unsolved, treated as released). */
  resetNet: number | undefined = undefined
  /** Net of BOOT0 (undefined: unsolved or absent, treated as low: boot from flash). */
  boot0Net: number | undefined = undefined
  /** Net of VBAT (undefined: unsolved or absent, treated as VDD: nothing survives an outage). */
  vbatNet: number | undefined = undefined
  /** Engine time VDD went down, while the backup domain is living on VBAT. */
  offAt: number | null = null
  /** What the circuit puts on OSC_IN/OSC_OUT and OSC32_IN/OSC32_OUT (a board's own parts, or crystals wired to a bare chip). */
  hse: ClockFeed = { source: null }
  lse: ClockFeed = { source: null }
  powered = false
  go = false
  /** The base64 the firmware was loaded from, so a re-sent document does not reload it. */
  loadedFrom = ""
  name = ""
  readonly object: string

  constructor(object: string, defId: string, spawn: (() => CoreTransport) | null) {
    this.object = object
    this.defId = defId
    const def = getDef(defId)
    this.mcu = makeCore(def?.chip, def?.mcuMemory, spawn)
    if (!def?.model) return
    for (const el of def.model) {
      if (el.kind !== "GPIO") continue
      const mcuName = el.node.startsWith("$") ? el.node.slice(1) : def.pins.find((p) => p.id === el.node)?.mcu
      const pad = mcuName ? parsePad(mcuName) : null
      if (pad) this.pads.set(el.node, pad)
    }
  }

  status(): McuStatus {
    return { ...this.mcu.status(), firmware: this.name, powered: this.powered }
  }
}

function decodeBase64(text: string): ArrayBuffer {
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out.buffer
}

/**
 * Solver steps per tick at 1× speed, so heavy circuits slow down instead of freezing.
 * The budget scales with the requested speed, which stays a ceiling rather than a promise.
 */
const STEPS_PER_TICK = 1500
/** What a part with no state set reads as. */
const NO_STATE: PartState = {}
/** Most steps a core runs ahead of the solver in one go (`quietSteps`). */
const QUIET_STEPS = 500
/** Runs a remote core stays in step with the loop after traffic with a digital part (~2 ms of steps). */
const IN_STEP_RUNS = 100
/** Time constant of the achieved-speed average, wall-clock seconds. */
const RATE_TAU = 0.5
/** Diode current that counts as fully lit, and the current below which an LED is dark. */
const LED_FULL = 8e-3
const LED_DARK = 2e-4

/** A voltage measurement between two pins; a null `b` measures against ground. */
export type Probe = { id: string; a: string; b: string | null }

/**
 * Level changes seen by the logic analyser: `times` in seconds, `codes` = probe index × 2 +
 * level, in time order per probe. `levels` is every probe's level at the end of the chunk
 * (a channel with no edge in a chunk still has a level); `dropped` says the chunk overflowed.
 */
export type LogicChunk = { count: number; times: Float64Array; codes: Uint8Array; levels: Uint8Array; end: number; dropped: boolean }
/** Edges kept per snapshot before the analyser starts dropping (a 1 MHz clock makes 100k in 50 ms). */
const LOGIC_CHUNK = 1 << 17
/** A probe's level before anything has been seen on its net. */
const LOGIC_UNKNOWN = 0xff

/** Everything the UI needs after a batch of steps. Plain data: it crosses a worker boundary. */
export type Snapshot = {
  time: number
  converged: boolean
  ac: boolean
  /** Pin voltages by pinKey; instantaneous, and RMS in AC circuits. */
  pinVoltage: Record<string, number>
  pinVoltageRms: Record<string, number>
  /** LED states by partKey. */
  parts: Record<string, PartState & { level: number }>
  /** Amps per wire id, positive from `wire.from` to `wire.to`; the mean since the last snapshot. */
  wireCurrent: Record<string, number>
  /** Mean |amps| per wire over the same interval: what flows, whichever way it went. */
  wireCurrentAbs: Record<string, number>
  /**
   * Flow marker position per wire in world px, integrated from the instantaneous current at
   * every solver step: the dashes move exactly when and where charge does, forward for
   * `from` → `to`. The magnitude is log-compressed so µA and A are both watchable.
   */
  wirePhase: Record<string, number>
  /** Amps by pinKey, positive into the component. Only pins a solved element terminates on. */
  pinCurrent: Record<string, number>
  readings: Reading[]
  /** Probe readings by probe id; `live` is false when a probe sits on no solved net. */
  probes: Record<string, ProbeReading & { live: boolean }>
  /** Oscilloscope samples since the last snapshot, probes in `traceProbes` order. */
  trace: TraceChunk
  traceProbes: string[]
  /** Logic-analyser edges since the last snapshot (probe ids in `traceProbes` order); null while the analyser is off. */
  logic: LogicChunk | null
  damage: Record<string, Damage>
  /**
   * Simulated seconds per real second actually achieved, smoothed over the last ~second;
   * null before the first step. Falls below `speed` when the step budget is the limit.
   */
  rate: number | null
  /** Emulated MCUs by object id. */
  mcus: Record<string, McuStatus>
  /** Serial terminals: what each has received so far. */
  terminals: Record<string, { text: string; framingErrors: number }>
  /** Digital parts' own state (an EEPROM's contents), by object id. */
  digital: Record<string, unknown>
  /** Display panels by object id: a new RGBA frame when the picture changed (null: as before), and the panel's verdict on the signal. */
  displays: Record<string, { width: number; height: number; frame: ArrayBuffer | null; status: string }>
}

/**
 * Owns the engine and advances it against a wall clock, independent of any display refresh.
 * No DOM and no React: this is what the worker runs, and what tests drive directly.
 */
export class SimLoop {
  private doc: Schematic = { objects: [], wires: [], parts: {} }
  private engine: Engine | null = null
  private damage: Record<string, Damage> = {}
  private parts: Record<string, PartState> = {}
  /** State of parts nobody has touched (a USB cable starts plugged in). */
  private partDefaults: Record<string, PartState> = {}
  /** Simulated time each part was pressed at, and releases waiting for MIN_PRESS to pass. */
  private pressedAt = new Map<string, number>()
  private heldReleases = new Map<string, PartState>()
  private bounceTime = new Map<string, { time: number; field: "pressed" | "on" }>()
  private bouncing = new Map<string, { state: PartState; field: "pressed" | "on"; flips: number[] }>()
  private probes: Probe[] = []
  private mcus = new Map<string, McuInstance>()
  private terminals = new Map<string, TerminalInstance>()
  private digitalParts = new Map<string, DigitalPart>()
  /** RGB panels, by object id: their wiring to cores, and an instance of our own for one no core drives. */
  private panels = new Map<string, PanelWiring & { own: PanelInstance }>()
  /**
   * Spawns the worker a remote core lives in; null runs every core in this thread. Set by the
   * environment (the simulation worker in the browser, a script in node).
   */
  spawnCore: (() => CoreTransport) | null = (globalThis as { __emulSpawnCore?: () => CoreTransport }).__emulSpawnCore ?? null
  /** Nets on the exact-time path, by net index. */
  private digitalNets = new Map<number, DigitalNet>()
  /**
   * Wire currents are linear in the element terminal currents, so the distribution over the
   * wire graph is solved once per rebuild as coefficients, and every step just sums. Means
   * over the interval between snapshots are what the flow display wants: a sample every
   * 50 ms of a 1 kHz square wave would alias to whatever phase it happens to land on.
   */
  private flow: { id: string; slots: Int32Array; coefs: Float64Array }[] = []
  private flowSigned = new Float64Array(0)
  private flowAbs = new Float64Array(0)
  private flowPhase = new Float64Array(0)
  private flowPhaseIds: string[] = []
  private flowSeconds = 0
  private traceBucket = 0
  /** Whether each probe resolved to solved nets, in `probes` order. */
  private probeLive: boolean[] = []
  /** Logic analyser: on, the edge log since the last snapshot, and each probe's last level. */
  private logicOn = false
  private logicTimes = new Float64Array(LOGIC_CHUNK)
  private logicCodes = new Uint8Array(LOGIC_CHUNK)
  private logicCount = 0
  private logicDropped = false
  private logicLevel: Uint8Array = new Uint8Array(0)
  private stale = true
  /** Wall-clock ms of the last advance; null until the run starts or resumes. */
  private last: number | null = null
  /** Achieved speed, an exponential average over the last RATE_TAU seconds of wall clock. */
  private rate: number | null = null
  /** A terminal or digital part changed what it drives: the engine must read the pads again. */
  private padsDirty = true
  speed = 1
  /** Most steps a core runs ahead of the solver in one go; 1 steps everything in lockstep. */
  quietMax = QUIET_STEPS
  running = false
  /** Called for every part that burns out, once. */
  onFailure: ((f: Failure) => void) | null = null
  /** Called when cores stop for the debugger; the bench is paused by then. */
  onDebugStop: ((stops: { object: string; stop: DebugStop }[]) => void) | null = null
  /** Debug settings by board, for boards whose core does not exist yet (the document has not arrived). */
  private debugConfig = new Map<string, { breakpoints: BreakpointSpec[]; faults: boolean }>()

  setDoc(doc: Schematic) {
    this.doc = doc
    this.stale = true
    this.partDefaults = {}
    for (const obj of doc.objects) {
      const def = getDef(obj.def)
      if (!def) continue
      for (const p of def.parts) if ("initial" in p && p.initial) this.partDefaults[partKey(obj.id, p.id)] = p.initial
    }
    this.syncBounce()
    this.syncFirmware()
    this.syncTerminals()
    this.syncDigitalParts()
    this.syncPanels()
  }

  /** Whether a panel's logic supply pin is up, as the last solve left it. */
  private panelPowered(p: PanelWiring): boolean {
    const engine = this.engine
    if (!engine || !p.spec.power) return true
    const node = engine.net.pinNet.get(pinKey(p.object, p.spec.power))
    if (node === undefined || node === GROUND) return false
    return engine.v[node] > 2.7
  }

  /** Panel instances follow the document. */
  private syncPanels() {
    const seen = new Set<string>()
    for (const obj of this.doc.objects) {
      const def = getDef(obj.def)
      if (!def?.panel) continue
      seen.add(obj.id)
      if (!this.panels.has(obj.id)) this.panels.set(obj.id, { object: obj.id, spec: def.panel, wired: new Map(), own: new PanelInstance(obj.id, def.panel) })
    }
    for (const id of [...this.panels.keys()])
      if (!seen.has(id)) {
        this.panels.delete(id)
        for (const inst of this.mcus.values()) inst.mcu.dropPanel(id)
      }
  }

  /** Digital parts follow the document: created for known definitions, reconfigured on prop edits. */
  private syncDigitalParts() {
    const seen = new Set<string>()
    for (const obj of this.doc.objects) {
      const props = obj.props ?? {}
      let part = this.digitalParts.get(obj.id)
      if (!part) {
        const made = createDigitalPart(obj.def, obj.id, props)
        if (!made) continue
        part = made
        this.digitalParts.set(obj.id, part)
      } else part.configure(props)
      seen.add(obj.id)
    }
    for (const id of [...this.digitalParts.keys()]) if (!seen.has(id)) this.digitalParts.delete(id)
  }

  /** Terminal instances follow the document; a baud change re-arms the decoder. */
  private syncTerminals() {
    const seen = new Set<string>()
    for (const obj of this.doc.objects) {
      if (obj.def !== "serial-terminal") continue
      seen.add(obj.id)
      const baud = Number(obj.props?.baud) || 115200
      const charset = obj.props?.charset || "utf-8"
      let t = this.terminals.get(obj.id)
      if (!t) {
        t = new TerminalInstance(obj.id, baud)
        this.terminals.set(obj.id, t)
      } else if (t.baud !== baud) {
        t.baud = baud
        t.decoder = new UartDecoder(baud)
      }
      if (t.charset !== charset) {
        t.charset = charset
        t.textDecoder = new TextDecoder(charset)
      }
    }
    for (const id of [...this.terminals.keys()]) if (!seen.has(id)) this.terminals.delete(id)
  }

  /**
   * Boards carry their firmware in props (name + base64 image). Create an emulated MCU for each
   * one, load it when the image changes, and drop MCUs whose board left the document.
   */
  private syncFirmware() {
    const seen = new Set<string>()
    for (const obj of this.doc.objects) {
      const data = obj.props?.firmwareData
      if (!data) continue
      seen.add(obj.id)
      let inst = this.mcus.get(obj.id)
      const reflash = !!inst && inst.loadedFrom !== ""
      if (!inst) {
        inst = new McuInstance(obj.id, obj.def, this.spawnCore)
        const cfg = this.debugConfig.get(obj.id)
        if (cfg) {
          inst.debug = cfg
          inst.applyDebug()
        }
        this.mcus.set(obj.id, inst)
      }
      if (inst.loadedFrom !== data) {
        inst.loadedFrom = data
        inst.name = obj.props?.firmware ?? "firmware"
        inst.data = decodeBase64(data)
        inst.mcu.load(inst.data.slice(0), inst.name)
        // A new image on a live board is a debugger's flash-and-reset: the core starts over
        // (the host's view of its clock too, or a remote core is never asked to run again),
        // the backup domain keeps its time, the rest of the bench does not notice.
        if (reflash) {
          inst.mcu.boot0 = false
          inst.mcu.reset({ backup: true })
        } else inst.go = true
        inst.base = this.engine?.time ?? 0
        this.mapInputs()
      }
    }
    for (const id of [...this.mcus.keys()])
      if (!seen.has(id)) {
        this.mcus.get(id)!.mcu.dispose()
        this.mcus.delete(id)
      }
  }

  /**
   * What a bare chip has on an oscillator pin pair: a crystal across both pins, or an
   * oscillator module's OUT on the input pin (bypass). The parts are markers — nothing
   * oscillates in the analog engine — so this is a look at the nets, not at voltages.
   */
  private oscillatorFeed(object: string, def: ComponentDef, inPad: string, outPad: string): ClockFeed {
    const pinNet = this.engine?.net.pinNet
    const inPin = def.pins.find((p) => p.mcu === inPad)
    const outPin = def.pins.find((p) => p.mcu === outPad)
    if (!pinNet || !inPin || !outPin) return { source: null }
    const oscIn = pinNet.get(pinKey(object, inPin.id))
    const oscOut = pinNet.get(pinKey(object, outPin.id))
    if (oscIn === undefined || oscIn === GROUND) return { source: null }
    for (const obj of this.doc.objects) {
      if (obj.def !== "crystal" && obj.def !== "oscillator") continue
      const props = { ...getDef(obj.def)?.defaults, ...obj.props }
      const hz = parseValue(props.value ?? "")
      if (!(hz > 0)) continue
      if (obj.def === "crystal") {
        const a = pinNet.get(pinKey(obj.id, "1"))
        const b = pinNet.get(pinKey(obj.id, "2"))
        if (oscOut !== undefined && oscOut !== GROUND && ((a === oscIn && b === oscOut) || (a === oscOut && b === oscIn)))
          return { source: { hz, kind: "crystal", startup: crystalStartup(hz) } }
      } else if (pinNet.get(pinKey(obj.id, "OUT")) === oscIn) {
        return { source: { hz, kind: "clock", startup: 0 }, vccNet: pinNet.get(pinKey(obj.id, "VCC")) ?? GROUND }
      }
    }
    return { source: null }
  }

  private boot0High(inst: McuInstance) {
    const engine = this.engine
    return !!engine && inst.boot0Net !== undefined && inst.boot0Net !== GROUND && engine.v[inst.boot0Net] > BOOT_HIGH
  }

  /** Bind each MCU pad to the matrix node of its GPIO element, if that node is solved. */
  private mapInputs() {
    const engine = this.engine
    for (const inst of this.mcus.values()) {
      inst.inputs = []
      if (!engine) continue
      const obj = this.doc.objects.find((o) => o.id === inst.object)
      const def = obj && getDef(obj.def)
      inst.powerNet = def?.mcuPower ? engine.net.pinNet.get(pinKey(inst.object, def.mcuPower)) : undefined
      inst.resetNet = def?.mcuReset ? engine.net.pinNet.get(pinKey(inst.object, def.mcuReset)) : undefined
      inst.boot0Net = def?.mcuBoot0 ? engine.net.pinNet.get(pinKey(inst.object, def.mcuBoot0)) : undefined
      inst.vbatNet = def?.mcuVbat ? engine.net.pinNet.get(pinKey(inst.object, def.mcuVbat)) : undefined
      if (def) {
        inst.hse = def.mcuClocks ? { source: def.mcuClocks.hse } : this.oscillatorFeed(inst.object, def, "PH0", "PH1")
        inst.lse = def.mcuClocks ? { source: def.mcuClocks.lse } : this.oscillatorFeed(inst.object, def, "PC14", "PC15")
      }
      inst.padNode.clear()
      inst.inputByPad.clear()
      for (const el of engine.net.elements) {
        if (el.kind !== "GPIO" || el.object !== inst.object) continue
        const pad = inst.pads.get(el.nodeKey)
        if (pad) {
          const input = { pad, node: el.node, key: el.nodeKey, digital: false }
          inst.inputs.push(input)
          inst.padNode.set(pad.port * 16 + pad.pin, el.node)
          inst.inputByPad.set(pad.port * 16 + pad.pin, input)
        }
      }
    }
    // Nets on the digital path: shared by two cores, at a terminal, or at a digital part.
    const nets = new Map<number, DigitalNet>()
    const netFor = (node: number) => {
      let n = nets.get(node)
      if (!n) {
        n = new DigitalNet(node)
        const prev = this.digitalNets.get(node)
        if (prev) {
          n.level = prev.level
          n.released = prev.released
        }
        nets.set(node, n)
      }
      return n
    }
    const padsByNet = new Map<number, { inst: McuInstance; pad: PadRef }[]>()
    for (const inst of this.mcus.values())
      for (const { pad, node } of inst.inputs) padsByNet.set(node, [...(padsByNet.get(node) ?? []), { inst, pad }])
    const shared = new Set<number>()
    for (const [node, pads] of padsByNet) if (new Set(pads.map((p) => p.inst)).size > 1) shared.add(node)
    for (const node of shared) netFor(node)
    for (const t of this.terminals.values()) {
      t.rxNet = engine?.net.pinNet.get(pinKey(t.object, "RX"))
      t.txNet = engine?.net.pinNet.get(pinKey(t.object, "TX"))
      if (t.txNet !== undefined) netFor(t.txNet).terminal = true
      if (t.rxNet !== undefined) netFor(t.rxNet).rx.push(t)
    }
    // The analyser's probes: their nets travel exactly too. A net with nothing digital on it
    // (an analog source, a gate's output) is thresholded from the solution each step.
    this.logicLevel = new Uint8Array(this.probes.length).fill(LOGIC_UNKNOWN)
    if (this.logicOn && engine)
      this.probes.forEach((p, i) => {
        const node = engine.net.pinNet.get(p.a)
        if (node === undefined || node === GROUND) return
        netFor(node).logic.push(i)
      })
    // Panels: which MCU pad sits on each signal pin's net.
    for (const panel of this.panels.values()) {
      panel.wired.clear()
      for (const [pin, signal] of Object.entries(panel.spec.signals)) {
        const node = engine?.net.pinNet.get(pinKey(panel.object, pin))
        if (node === undefined) continue
        const pad = padsByNet.get(node)?.[0]
        if (pad) panel.wired.set(signal, { host: pad.inst.mcu, pad: pad.pad })
      }
    }
    const partNets = new Set<number>()
    for (const part of this.digitalParts.values())
      for (const pin of part.pins) {
        const node = engine?.net.pinNet.get(pinKey(part.object, pin))
        if (node === undefined) continue
        netFor(node).parts.push({ part, pin })
        partNets.add(node)
      }
    for (const [node, n] of nets) {
      n.pads = padsByNet.get(node) ?? []
      if (engine)
        for (const el of engine.net.elements) {
          if (el.kind !== "R") continue
          if (el.a === node) n.pulls.push(el.b)
          else if (el.b === node) n.pulls.push(el.a)
        }
      // A net already on the digital path has a level, a terminal's TX idles high; any other
      // net gets its level from the first thing seen on it.
      if (this.digitalNets.has(node) || n.terminal) for (const probe of n.logic) this.logicLevel[probe] = probe * 2 + (n.terminal || n.level ? 1 : 0)
    }
    this.digitalNets = nets
    for (const inst of this.mcus.values()) {
      inst.coupled = false
      inst.partPads.clear()
      const watch: number[] = []
      for (const i of inst.inputs) {
        i.digital = nets.has(i.node)
        // Plain GPIO edges on those nets travel exactly too (a bit-banged chip select, a
        // bit-banged UART into the terminal), so they keep their order against the serial ones.
        if (i.digital) watch.push(i.pad.port * 16 + i.pad.pin)
        if (shared.has(i.node)) inst.coupled = true
        if (partNets.has(i.node)) inst.partPads.add(i.pad.port * 16 + i.pad.pin)
      }
      // Cores in lockstep with a peer run in this thread: a worker cannot yield per edge to another worker.
      if (inst.coupled) inst.relocate()
      inst.mcu.setDigitalWatch(watch)
      inst.mcu.setPads(inst.inputs.map((i) => i.pad.port * 16 + i.pad.pin))
      // A part answers an edge at the edge's own time, so the core must hand edges over as it makes them.
      inst.mcu.yieldOnOutput = inst.coupled || inst.partPads.size > 0
    }
    // A relocated core is a new host: the panels wired to it must point at the new one.
    for (const panel of this.panels.values())
      for (const [signal, w] of panel.wired) {
        const inst = padsByNet.get(engine!.net.pinNet.get(pinKey(panel.object, Object.entries(panel.spec.signals).find(([, s]) => s === signal)![0]))!)?.[0]
        if (inst && inst.inst.mcu !== w.host) panel.wired.set(signal, { host: inst.inst.mcu, pad: w.pad })
      }
  }

  // --- serial: the digital fast path ---------------------------------------------------------
  //
  // Bits between an MCU and a terminal (or another MCU) travel as timestamped edges, so a
  // 115200-baud frame survives the 20 µs analog step. The analog side still sees the levels.

  /** Whether any core runs in a worker pipelined behind the loop (its edges arrive a step late). */
  private get pipelined() {
    for (const inst of this.mcus.values()) if (!(inst.mcu instanceof LocalCore)) return true
    return false
  }

  /** Deterministic uniform noise in [0, 1) for the sub-step sampling (a 32-bit LCG). */
  private ditherState = 0x2545f491
  private dither() {
    this.ditherState = (Math.imul(this.ditherState, 1664525) + 1013904223) >>> 0
    return this.ditherState / 4294967296
  }

  /**
   * Pull-ups on the digital nets, as the analog circuit currently has them; and for nets
   * nobody drives digitally yet (an address pin strapped to ground, the bus before the first
   * transfer) the level itself, from the analog solution.
   */
  private refreshReleased(engine: Engine, time: number) {
    for (const n of this.digitalNets.values()) {
      let up = false
      let down = false
      for (const other of n.pulls) {
        const v = other === GROUND ? 0 : engine.v[other]
        if (v > VIH) up = true
        else if (v < VIL) down = true
      }
      for (const { inst, pad } of n.pads) {
        const d = inst.mcu.padDrive(pad)
        if (d === "pullup") up = true
        else if (d === "pulldown") down = true
      }
      n.released = up ? true : down ? false : null
      if (n.drivers.size === 0 && !n.terminal && (n.parts.length || n.logic.length)) {
        const v = n.node === GROUND ? 0 : engine.v[n.node]
        const level = v > VIH ? true : v < VIL ? false : n.level
        if (level !== n.level) {
          n.level = level
          this.deliverLevel(n, level, time)
        }
      }
    }
  }

  /** One driver on a net changed: re-resolve, and tell everyone if the level moved. */
  private setDriver(net: DigitalNet, driver: string, level: boolean | null, time: number, strong: boolean) {
    net.drivers.set(driver, { level, strong })
    const resolved = net.resolve()
    if (resolved === net.level) return
    net.level = resolved
    this.deliverLevel(net, resolved, time)
  }

  /** A net's resolved level at `time` goes to every pad, part and terminal on it. */
  private deliverLevel(net: DigitalNet, level: boolean, time: number) {
    for (const probe of net.logic) this.logEdge(probe, level, time)
    for (const p of net.pads) {
      if (net.parts.length) p.inst.keepInStep()
      p.inst.drive(p.pad, level, time - p.inst.offset)
    }
    for (const t of net.rx) t.decoder.edge({ time, level })
    for (const { part, pin } of net.parts) {
      part.input(pin, level, time)
      this.drainPart(part)
    }
  }

  /** Drives a part produced go onto their nets (which may cascade, briefly). */
  private drainPart(part: DigitalPart) {
    const engine = this.engine
    if (!engine) return
    this.padsDirty = true
    for (let round = 0; part.out.length && round < 16; round++) {
      const edges = part.out.splice(0, part.out.length)
      for (const e of edges) {
        const node = engine.net.pinNet.get(pinKey(part.object, e.pin))
        const net = node === undefined ? undefined : this.digitalNets.get(node)
        if (net) this.setDriver(net, `${part.object}/${e.pin}`, e.level, e.time, false)
      }
    }
  }

  /** Edges a core made in the run just done: onto their nets, to terminals, parts and other cores. */
  private deliverDigital(inst: McuInstance): boolean {
    const out = inst.mcu.drainEdges()
    if (!out.length) return false
    for (const e of out) {
      const key = e.pad.port * 16 + e.pad.pin
      // Traffic with a part: a remote core answers in step until it is over.
      if (inst.partPads.has(key)) inst.keepInStep()
      const node = inst.padNode.get(key)
      const net = node === undefined ? undefined : this.digitalNets.get(node)
      if (net) this.setDriver(net, `${inst.object}/${key}`, e.level, e.time + inst.offset, true)
    }
    return true
  }

  /**
   * Cores that share a net run in lockstep: the one furthest behind runs until it catches the
   * others up (or gets `LOCKSTEP_LEAD` ahead), yielding whenever it puts an edge on a shared net
   * so the edge reaches its peers before they run past it. An SPI slave then answers a clock
   * edge at the edge's own time and the master samples the answer half a period later, as
   * the hardware would; a bit-banged protocol gets the same treatment. The lead bound keeps
   * a peer's own register writes from landing more than a microsecond out of order.
   */
  private runLockstep(group: McuInstance[], end: number) {
    for (;;) {
      let lag: McuInstance | null = null
      let lagNow = Infinity
      for (const i of group) {
        if (!i.mcu.running) continue
        const t = i.mcu.time + i.offset
        if (t < end - 1e-12 && t < lagNow) {
          lag = i
          lagNow = t
        }
      }
      if (!lag) return
      let lead = lagNow
      for (const i of group) if (i !== lag && i.mcu.running) lead = Math.max(lead, i.mcu.time + i.offset)
      const until = Math.min(end, Math.max(lead, lagNow + LOCKSTEP_LEAD))
      lag.mcu.runUntil(until - lag.offset)
      // Edges out, and whatever the peers answered synchronously to a late-applied edge.
      for (let round = 0; round < 8; round++) {
        let any = false
        for (const i of group) if (this.deliverDigital(i)) any = true
        if (!any) break
      }
    }
  }

  /** Text typed into a terminal: encoded in its charset, framed at its baud, onto its TX net. */
  sendSerial(object: string, text: string) {
    const t = this.terminals.get(object)
    const engine = this.engine
    if (!t || !engine) return
    // A core in a worker may already be running the next step: start the frame past it.
    let at = Math.max(t.txBusyUntil, engine.time + DT * (this.spawnCore ? 3 : 1))
    for (const byte of encodeText(text, t.charset)) {
      const edges = uartFrameEdges(byte, at, t.baud)
      t.txEdges.push(...edges)
      // The terminal is the only driver of its TX net: the edges are the levels, ahead of time.
      const net = t.txNet === undefined ? undefined : this.digitalNets.get(t.txNet)
      if (net) for (const e of edges) for (const p of net.pads) p.inst.drive(p.pad, e.level, e.time - p.inst.offset)
      at += uartFrameSeconds(t.baud)
    }
    t.txBusyUntil = at
  }

  /** Terminal TX levels for the analog engine, and received frames, as of `time`. */
  private serviceTerminals(time: number) {
    for (const t of this.terminals.values()) {
      while (t.txEdges.length && t.txEdges[0].time <= time) {
        this.padsDirty = true
        const e = t.txEdges.shift()!
        t.txLevel = e.level
        const net = t.txNet === undefined ? undefined : this.digitalNets.get(t.txNet)
        if (net) for (const probe of net.logic) this.logEdge(probe, e.level, e.time)
      }
      // A core in a worker hands its edges over a step late: the decoder stays a step behind them.
      t.decoder.poll(this.pipelined ? time - DT : time)
      if (t.decoder.bytes.length) {
        t.text += t.textDecoder.decode(new Uint8Array(t.decoder.bytes), { stream: true })
        t.decoder.bytes.length = 0
        if (t.text.length > TERMINAL_MAX) t.text = t.text.slice(-TERMINAL_MAX)
      }
    }
  }

  /**
   * What the pad behind (object, node) drives: the emulated MCU's GPIO block, a terminal, a
   * digital part, or nothing. The lookup is resolved once per element and kept by index.
   */
  private readonly pinState: PinReader = (index, object, node): GpioState => {
    let reader = this.pinReaders[index]
    if (reader === undefined) {
      reader = this.resolvePin(object, node)
      this.pinReaders[index] = reader
    }
    return reader()
  }
  private pinReaders: (() => GpioState)[] = []
  private resolvePin(object: string, node: string): () => GpioState {
    const inst = this.mcus.get(object)
    if (inst?.mcu.loaded) {
      // The supply load follows the power mode: the resistance that draws the mode's current.
      if (node === "$idd") return () => (inst.mcu.loaded ? inst.mcu.chip.electrical.vdd / inst.idd : null)
      const pad = inst.pads.get(node)
      if (!pad) return () => null
      // The drive is recomputed only when the core's pads changed (its version counts every
      // GPIO register write and DAC change), so a still board costs a compare per pad per step.
      let version = -1
      let drive: GpioState = null
      return () => {
        if (!inst.mcu.loaded) return null
        if (inst.sampled.size !== 0) {
          const s = inst.sampled.get(node)
          if (s !== undefined) return s
        }
        if (inst.padVersion !== version) {
          version = inst.padVersion
          drive = inst.mcu.padDrive(pad)
        }
        return drive
      }
    }
    const term = this.terminals.get(object)
    if (term) return node === "TX" ? () => (term.txLevel ? "high" : "low") : node === "RX" ? () => "pullup" : () => null
    const part = this.digitalParts.get(object)
    if (part) {
      return () => {
        const d = part.drive(node)
        return d === null ? null : d ? "high" : "low"
      }
    }
    return () => null
  }

  /** After a solver step, feed the node voltages back into the MCU input registers. */
  private sampleInputs(engine: Engine) {
    for (const inst of this.mcus.values()) {
      if (!inst.mcu.loaded) continue
      for (const { pad, node, digital } of inst.inputs) {
        const v = node === GROUND ? 0 : engine.v[node]
        // The ADC samples the pad's net as the last solve left it (a step old at most).
        inst.mcu.setAnalog(pad, v)
        if (digital && inst.digitalPads.has(pad.port * 16 + pad.pin)) continue
        if (v > VIH) inst.mcu.setPad(pad, true)
        else if (v < VIL) inst.mcu.setPad(pad, false)
      }
    }
  }

  setParts(parts: Record<string, PartState>) {
    const now = this.engine?.time ?? 0
    const next: Record<string, PartState> = { ...parts }
    for (const key of new Set([...Object.keys(parts), ...Object.keys(this.parts)])) {
      const was = (this.bouncing.get(key)?.state ?? this.parts[key])?.pressed ?? false
      const is = parts[key]?.pressed ?? false
      if (is && !was) {
        this.pressedAt.set(key, now)
        this.heldReleases.delete(key)
      } else if (!is && was && now - (this.pressedAt.get(key) ?? -Infinity) < MIN_PRESS) {
        // Too quick: keep it pressed and let the release through once the press has lasted.
        this.heldReleases.set(key, parts[key] ?? {})
        next[key] = { ...(parts[key] ?? {}), pressed: true }
      }
    }
    const prev = this.parts
    this.parts = next
    for (const key of this.bounceTime.keys()) this.startBounce(key, prev[key], now)
    // Touch panels and the like: the part's state goes to the digital part behind it.
    for (const [key, state] of Object.entries(parts)) {
      const i = key.indexOf(":")
      const part = this.digitalParts.get(key.slice(0, i))
      if (!part?.interact) continue
      part.interact(key.slice(i + 1), state, now)
      this.drainPart(part)
    }
  }

  /** Apply releases whose press has now lasted long enough. */
  private releaseHeld(now: number) {
    if (this.heldReleases.size === 0) return
    for (const [key, state] of this.heldReleases) {
      if (now - (this.pressedAt.get(key) ?? 0) < MIN_PRESS) continue
      const prev = this.parts[key]
      this.parts = { ...this.parts, [key]: state }
      this.heldReleases.delete(key)
      this.startBounce(key, prev, now)
      const i = key.indexOf(":")
      const part = this.digitalParts.get(key.slice(0, i))
      if (part?.interact) {
        part.interact(key.slice(i + 1), state, now)
        this.drainPart(part)
      }
    }
  }

  private syncBounce() {
    for (const [key, b] of this.bouncing) this.parts = { ...this.parts, [key]: b.state }
    this.bouncing.clear()
    this.bounceTime.clear()
    for (const obj of this.doc.objects) {
      const def = getDef(obj.def)
      if (!def) continue
      const props = { ...def.defaults, ...obj.props }
      if (props.bounce !== "on") continue
      const time = parseValue(props.tbounce ?? "")
      if (!(time > 0)) continue
      for (const p of def.parts) {
        if (p.type === "button") this.bounceTime.set(partKey(obj.id, p.id), { time, field: "pressed" })
        else if (p.type === "switch") this.bounceTime.set(partKey(obj.id, p.id), { time, field: "on" })
      }
    }
  }

  private startBounce(key: string, before: PartState | undefined, now: number) {
    const b = this.bounceTime.get(key)
    if (!b) return
    const state = this.parts[key] ?? {}
    const cur = this.bouncing.get(key)
    if (!!state[b.field] === !!(cur?.state ?? before)?.[b.field]) {
      if (cur) cur.state = state
      return
    }
    const n = 2 * (2 + Math.floor(Math.random() * 5))
    const flips = Array.from({ length: n }, () => now + b.time * Math.random() ** 2).sort((x, y) => x - y)
    this.bouncing.set(key, { state, field: b.field, flips })
  }

  private applyBounce(now: number) {
    for (const [key, b] of this.bouncing) {
      let i = 0
      while (i < b.flips.length && b.flips[i] <= now) i++
      if (i) b.flips = b.flips.slice(i)
      const value = b.flips.length % 2 ? !b.state[b.field] : !!b.state[b.field]
      if (!b.flips.length) this.bouncing.delete(key)
      if (!!this.parts[key]?.[b.field] !== value) this.parts = { ...this.parts, [key]: { ...b.state, [b.field]: value } }
    }
  }

  setProbes(probes: Probe[]) {
    const before = this.probeKeys()
    this.probes = probes
    // A probe can pull an otherwise idle MCU pad into the matrix, which needs a rebuild.
    const after = this.probeKeys()
    if (before.size !== after.size || [...after].some((k) => !before.has(k))) this.stale = true
    this.applyProbes()
  }

  private probeKeys(): Set<string> {
    const keys = new Set<string>()
    for (const p of this.probes) {
      keys.add(p.a)
      if (p.b) keys.add(p.b)
    }
    return keys
  }

  /** Point the engine's probes at the nets the pins ended up on; a rebuild renumbers them. */
  private applyProbes() {
    const engine = this.engine
    if (!engine) return
    const nodes = new Int32Array(this.probes.length * 2)
    this.probeLive = this.probes.map((p, i) => {
      const a = engine.net.pinNet.get(p.a)
      const b = p.b === null ? GROUND : engine.net.pinNet.get(p.b)
      nodes[i * 2] = a ?? GROUND
      nodes[i * 2 + 1] = b ?? GROUND
      return a !== undefined && b !== undefined
    })
    engine.setProbes(nodes)
  }

  /**
   * Logic analyser on/off. Probed nets join the exact-time path while it is on, so an MCU's
   * serial edges reach it at their own time rather than as 20 µs samples.
   */
  setLogic(on: boolean) {
    if (on === this.logicOn) return
    this.logicOn = on
    this.logicCount = 0
    this.logicDropped = false
    this.stale = true
  }

  /** An edge for the analyser, if that probe's level actually moved (the first level seen is where the record starts, not an edge). */
  private logEdge(probe: number, level: boolean, time: number) {
    const code = probe * 2 + (level ? 1 : 0)
    if (this.logicLevel[probe] === code) return
    const unknown = this.logicLevel[probe] === LOGIC_UNKNOWN
    this.logicLevel[probe] = code
    if (unknown) return
    if (this.logicCount >= LOGIC_CHUNK) {
      this.logicDropped = true
      return
    }
    this.logicTimes[this.logicCount] = time
    this.logicCodes[this.logicCount] = code
    this.logicCount++
  }

  private drainLogic(): LogicChunk | null {
    if (!this.logicOn) return null
    const n = this.logicCount
    const chunk: LogicChunk = { count: n, times: this.logicTimes.slice(0, n), codes: this.logicCodes.slice(0, n), levels: this.logicLevel.slice(), end: this.engine?.time ?? 0, dropped: this.logicDropped }
    this.logicCount = 0
    this.logicDropped = false
    return chunk
  }

  /** Oscilloscope resolution in seconds per sample; 0 stops collecting. */
  setTraceBucket(bucket: number) {
    this.traceBucket = bucket
    this.engine?.setTrace(bucket)
  }

  setRunning(running: boolean) {
    if (running === this.running) return
    this.running = running
    // The bench goes on: every core stopped for the debugger goes on with it.
    if (running) for (const inst of this.mcus.values()) if (inst.mcu.debugStop) inst.mcu.debug({ op: "resume" })
    // A pause must not bank wall-clock time, or resuming would fast-forward.
    this.last = null
    this.rate = null
    // Every run starts with intact parts.
    if (running && Object.keys(this.damage).length) {
      this.damage = {}
      this.stale = true
      for (const inst of this.mcus.values())
        if (inst.mcu.loaded && inst.mcu.halted) {
          inst.burnt = false
          inst.mcu.reset()
          inst.base = this.engine?.time ?? 0
        }
    }
  }

  // --- debugging -------------------------------------------------------------------------------
  //
  // A core that stops for the debugger (a breakpoint, a step done, a fault caught) freezes the
  // whole bench at that instant: the circuit, the instruments and every other core wait with
  // it, and going on (continue, or a step) takes all of them along — a step advances the bench
  // by exactly the time the stepped code takes.

  /** A debugger command for a board's core; `resume` and `step` also set the bench running. */
  debug(object: string, cmd: CoreDebugCommand) {
    const cfg = this.debugConfig.get(object) ?? { breakpoints: [], faults: false }
    if (cmd.op === "breakpoints") cfg.breakpoints = cmd.list
    if (cmd.op === "catch") cfg.faults = cmd.faults
    this.debugConfig.set(object, cfg)
    const inst = this.mcus.get(object)
    if (inst) inst.debug = cfg
    if (cmd.op === "breakpoints" || cmd.op === "catch") {
      inst?.mcu.debug(cmd)
      return
    }
    if (cmd.op === "step" && inst) inst.mcu.debug(cmd)
    this.setRunning(true)
  }

  /**
   * Reset one board's core as a debug probe does: the program starts over, the backup domain
   * and the rest of the bench keep their state and their time.
   */
  resetCore(object: string) {
    const inst = this.mcus.get(object)
    if (!inst?.mcu.loaded) return
    inst.mcu.reset({ backup: true })
    inst.base = this.engine?.time ?? 0
    inst.digitalPads.clear()
  }

  /** Registers and memory of a board's core, read without side effects; null when it has none. */
  inspect(object: string, req: InspectRequest): Promise<InspectReply | null> {
    const inst = this.mcus.get(object)
    return inst ? inst.mcu.inspect(req) : Promise.resolve(null)
  }

  /** After the cores' runs of a step: pause the bench if any stopped for the debugger. */
  private debugStops(mcus: McuInstance[]): boolean {
    let stops: { object: string; stop: DebugStop }[] | null = null
    for (const inst of mcus) {
      const stop = inst.mcu.debugStop
      if (stop) (stops ??= []).push({ object: inst.object, stop })
    }
    if (!stops) return false
    this.running = false
    this.last = null
    this.rate = null
    // All-stop, as GDB has it: a step another core was taking is over.
    for (const inst of mcus) if (!inst.mcu.debugStop && inst.mcu.running) inst.mcu.debug({ op: "resume" })
    this.onDebugStop?.(stops)
    return true
  }

  get booting() {
    for (const inst of this.mcus.values()) if (!inst.mcu.ready) return true
    return false
  }

  /** Stop the workers the cores live in (a script that is done with the loop). */
  dispose() {
    for (const inst of this.mcus.values()) inst.mcu.dispose()
    this.mcus.clear()
  }

  /** Throw away the accumulated state and start the next run from t = 0. */
  restart() {
    this.engine = null
    this.damage = {}
    this.stale = true
    this.last = null
    this.rate = null
    for (const inst of this.mcus.values()) {
      inst.burnt = false
      inst.powered = false
      inst.mcu.reset()
      inst.digitalPads.clear()
      inst.base = 0
    }
    for (const part of this.digitalParts.values()) part.reset()
    for (const t of this.terminals.values()) {
      t.text = ""
      t.decoder = new UartDecoder(t.baud)
      t.textDecoder = new TextDecoder(t.charset)
      t.txEdges = []
      t.txLevel = true
      t.txBusyUntil = 0
    }
  }

  private rebuild(adopt: boolean) {
    this.padsDirty = true
    this.pinReaders = []
    const prev = this.engine
    const next = new Engine(buildNetlist({ ...this.doc, parts: {} }, this.damage, undefined, this.probeKeys()))
    if (adopt && prev) next.adopt(prev)
    this.engine = next
    this.stale = false
    this.applyProbes()
    this.mapInputs()
    this.buildFlow(next)
    next.setTrace(this.traceBucket)
    if (adopt && prev) next.adoptProbes(prev)
  }

  /** Solve the wire graph once per terminal to get each wire's current as a linear form. */
  private buildFlow(engine: Engine) {
    const { net } = engine
    const { index, keys } = engine.terminalSlots
    const perWire = new Map<string, { slots: number[]; coefs: number[] }>()
    for (const key of keys) {
      const slot = index.get(key)!
      const unit = wireCurrents(this.doc.wires, net.pinNet, net.groundKeys, (k) => (k === key ? 1 : 0), net.contacts)
      for (const [id, amps] of unit) {
        if (amps === 0) continue
        let f = perWire.get(id)
        if (!f) {
          f = { slots: [], coefs: [] }
          perWire.set(id, f)
        }
        f.slots.push(slot)
        f.coefs.push(amps)
      }
    }
    this.flow = this.doc.wires.map((w) => {
      const f = perWire.get(w.id)
      return { id: w.id, slots: Int32Array.from(f?.slots ?? []), coefs: Float64Array.from(f?.coefs ?? []) }
    })
    this.flowSigned = new Float64Array(this.flow.length)
    this.flowAbs = new Float64Array(this.flow.length)
    // Marker positions survive a rebuild so the dashes do not jump when a part is edited.
    const phase = new Float64Array(this.flow.length)
    if (this.flowPhaseIds.length) {
      const prev = new Map(this.flowPhaseIds.map((id, i) => [id, this.flowPhase[i]]))
      this.flow.forEach((f, i) => (phase[i] = prev.get(f.id) ?? 0))
    }
    this.flowPhase = phase
    this.flowPhaseIds = this.flow.map((f) => f.id)
    this.flowSeconds = 0
  }

  /** Marker speed in world px per simulated second for a current: ~40 px/s at 1 mA, capped. */
  private static flowSpeed(amps: number) {
    return Math.min(FLOW_MAX_SPEED, FLOW_SPEED * Math.log10(1 + amps / 1e-4))
  }

  /** Accumulate every wire's current over a step just taken. */
  private accumulateFlow(engine: Engine, dt: number) {
    const tc = engine.terminalSlots.current
    const flow = this.flow
    for (let i = 0; i < flow.length; i++) {
      const { slots, coefs } = flow[i]
      let amps = 0
      for (let k = 0; k < slots.length; k++) amps += coefs[k] * tc[slots[k]]
      this.flowSigned[i] += amps * dt
      this.flowAbs[i] += Math.abs(amps) * dt
      if (amps > FLOW_MIN) this.flowPhase[i] += SimLoop.flowSpeed(amps) * dt
      else if (amps < -FLOW_MIN) this.flowPhase[i] -= SimLoop.flowSpeed(-amps) * dt
    }
    this.flowSeconds += dt
  }

  /**
   * Advance to wall-clock `now` (ms). Returns the number of solver steps taken, so a caller
   * can tell a busy tick from an idle one.
   */
  advance(now: number): number {
    if (this.stale) this.rebuild(this.engine !== null)
    const engine = this.engine
    if (!engine || !this.running) return 0
    if (this.last === null) {
      this.last = now
      return 0
    }
    const budget = STEPS_PER_TICK * Math.max(1, this.speed)
    const wall = (now - this.last) / 1000
    const steps = Math.min(budget, Math.floor((wall * this.speed) / DT))
    if (steps <= 0) return 0
    this.last = now
    // What this tick actually delivered against the wall clock, blended in by how long it took.
    const achieved = (steps * DT) / wall
    this.rate = this.rate === null ? achieved : this.rate + (achieved - this.rate) * (1 - Math.exp(-wall / RATE_TAU))
    const read = (key: string) => this.parts[key] ?? this.partDefaults[key] ?? NO_STATE
    const mcus = [...this.mcus.values()].filter((m) => m.mcu.loaded)
    for (let i = 0; i < steps; i++) {
      if (this.heldReleases.size) this.releaseHeld(engine.time)
      if (this.bouncing.size) this.applyBounce(engine.time)
      // The cores run ahead of the solver by one step, then the step sees their pads. A core
      // whose VDD is below the power-on threshold sits in reset until the rail comes back.
      const active: McuInstance[] = []
      for (const inst of mcus) {
        if (inst.burnt) continue
        if (!inst.mcu.ready) {
          inst.base = engine.time
          continue
        }
        // Reset is held while VDD is below the POR threshold or NRST is pulled low; the core
        // starts from the vector table when both are released.
        const vdd = inst.powerNet === undefined ? Infinity : inst.powerNet === GROUND ? 0 : engine.v[inst.powerNet]
        const nrst = inst.resetNet === undefined ? Infinity : inst.resetNet === GROUND ? 0 : engine.v[inst.resetNet]
        // The backup domain lives on VBAT: with it up through an outage the RTC keeps counting.
        const vbatUp = inst.vbatNet !== undefined && inst.vbatNet !== GROUND && engine.v[inst.vbatNet] > VBAT_MIN
        if (vdd < Math.max(VDD_POR, inst.mcu.porThreshold) || nrst < NRST_LOW) {
          if (inst.powered) {
            inst.powered = false
            const outage = vdd < Math.max(VDD_POR, inst.mcu.porThreshold)
            inst.mcu.reset({ backup: outage && vbatUp })
            inst.offAt = outage && vbatUp ? engine.time : null
            inst.digitalPads.clear()
          } else if (inst.offAt !== null && !vbatUp) {
            // The battery went too while VDD was down: the backup domain is gone.
            inst.mcu.reset()
            inst.offAt = null
          }
          continue
        }
        if (!inst.powered) {
          inst.powered = true
          // The boot pins are sampled as reset is released.
          inst.mcu.boot0 = !inst.go && this.boot0High(inst)
          inst.go = false
          if (inst.offAt !== null) inst.mcu.runOnBattery(engine.time - inst.offAt)
          inst.mcu.reset({ backup: inst.offAt !== null })
          inst.offAt = null
          inst.base = engine.time
        }
        // An oscillator module clocks only while its own supply is up.
        const feed = (f: ClockFeed) => (f.vccNet === undefined || (f.vccNet !== GROUND && engine.v[f.vccNet] > OSC_VCC_MIN) ? f.source : null)
        inst.mcu.setClockSources(feed(inst.hse), feed(inst.lse))
        // Fixed since the core's last reset: a core's overshoot past the step end must stay an
        // overshoot, or the lockstep ordering below sees two cores "at the step end" and lets
        // a master clock on before its slave has answered.
        inst.offset = inst.base
        if (inst.mcu.running) active.push(inst)
      }
      if (this.digitalNets.size) this.refreshReleased(engine, engine.time)
      const coupled = active.filter((i) => i.coupled)
      // A lone core on a circuit at rest runs ahead over the steps where nothing it drives
      // changes; the solver takes those steps after it, and the step where something did
      // change the usual way below (the core already stands at its end).
      if (active.length === 1 && mcus.length === 1 && !coupled.length) {
        const inst = active[0]
        const n = this.quietSteps(engine, inst, steps - i)
        if (n > 1) {
          const k = inst.mcu.runSteps(engine.time, inst.base, DT, n, inst.padVersion, inst.idd, () => this.quietDuty(inst), () => this.quietStep(engine, read))
          if (k > 1) i += k - 1
          // An edge that ended the run goes out before the core runs on, as after any run.
          if (k > 0) this.deliverDigital(inst)
        }
      }
      for (const inst of active) {
        if (inst.coupled) continue
        const target = engine.time + DT - inst.base
        // A core with digital parts on its nets yields at every edge it makes.
        while (inst.mcu.time < target && inst.mcu.running) {
          inst.mcu.runUntil(target)
          this.deliverDigital(inst)
        }
      }
      if (coupled.length) this.runLockstep(coupled, engine.time + DT)
      // Whether any pad can read differently from the last step: the engine skips its pad
      // scan otherwise (most steps of a board sitting on a fixed picture).
      let refresh = this.padsDirty
      this.padsDirty = false
      for (const inst of mcus) {
        const live = !inst.burnt && inst.powered
        if (live !== inst.padsLive) refresh = true
        inst.padsLive = live
        // A core held in reset still has pads (floating, or as the reset left them).
        const version = inst.mcu.padVersion()
        if (version !== inst.padVersion) refresh = true
        inst.padVersion = version
        if (!live) continue
        const idd = inst.mcu.supplyCurrent()
        if (idd !== inst.idd) refresh = true
        inst.idd = idd
        // Outputs that switched within the step are sampled at a random instant of it. The
        // pads are only re-read when a sample differs from the step before.
        const was = inst.sampled
        const now = inst.sampledPrev
        now.clear()
        for (const padKey of inst.mcu.dutyPads()) {
          const input = inst.inputByPad.get(padKey)
          if (input === undefined) continue
          const d = inst.mcu.takeDuty(input.pad, DT)
          if (d !== null && d > 0 && d < 1) now.set(input.key, this.dither() < d ? "high" : "low")
        }
        inst.sampled = now
        inst.sampledPrev = was
        if (now.size !== was.size) refresh = true
        else for (const [key, level] of now) if (was.get(key) !== level) refresh = true
      }
      this.serviceTerminals(engine.time + DT)
      for (const part of this.digitalParts.values())
        if (part.tick) {
          part.tick(engine.time + DT)
          if (part.out.length) this.drainPart(part)
        }
      engine.step(DT, read, this.pinState, refresh || this.padsDirty)
      this.accumulateFlow(engine, DT)
      if (mcus.length) this.sampleInputs(engine)
      if (engine.failures.length) {
        // Everything that broke in this step goes at once; the circuit is then re-solved.
        for (const f of engine.failures) {
          const had = this.damage[f.object]
          if (had) {
            // A dead part cannot break further; one still working can lose another element.
            if (had.fatal || had.element === f.damage.element || had.also?.some((d) => d.element === f.damage.element)) continue
            had.also = [...(had.also ?? []), { element: f.damage.element, fail: f.damage.fail, reason: f.damage.reason }]
            if (f.damage.fatal) had.fatal = true
            this.onFailure?.(f)
            continue
          }
          this.damage[f.object] = f.damage
          // A burnt MCU is dead silicon: the core stops and its pads leave the circuit.
          const inst = this.mcus.get(f.object)
          if (inst?.mcu.loaded) {
            inst.burnt = true
            inst.mcu.halt(`burnt out: ${f.damage.reason}`)
          }
          this.onFailure?.(f)
        }
        this.rebuild(true)
        return i + 1
      }
      // A core stopped for the debugger freezes the bench at the end of this step: the circuit
      // shows what the core left on its pins (a step over a GPIO write lights the LED), and
      // nothing runs on.
      if (this.debugStops(mcus)) return i + 1
    }
    return steps
  }

  /**
   * How many of the next `left` steps a lone core may run ahead of the solver: the circuit
   * settled and staying so, nothing queued to reach it (a held release, a terminal's frame,
   * a part's scan), no pad sampled at random from a duty. 1 when it must go step by step.
   */
  private quietSteps(engine: Engine, inst: McuInstance, left: number): number {
    if (left < 2 || this.padsDirty || this.heldReleases.size || this.bouncing.size || !inst.padsLive) return 1
    // An in-process core's PWM pads are sampled step by step as they run (`quietDuty`); a worker's are not.
    if (inst.sampled.size && !(inst.mcu instanceof LocalCore)) return 1
    for (const t of this.terminals.values()) if (t.txEdges.length) return 1
    let n = Math.min(left, this.quietMax, engine.settledFor(DT) + 1)
    for (const part of this.digitalParts.values()) {
      if (!part.tick) continue
      if (!part.quietUntil) return 1
      // The quiet steps tick the part at their ends: all of them before it may drive.
      n = Math.min(n, Math.floor((part.quietUntil() - engine.time) / DT))
    }
    return n
  }

  /**
   * After a quiet step of an in-process core: the step's end as `advance` samples it — each
   * wired PWM pad's duty, dithered — and whether the solver would read every pad as before.
   * If it would, the duties are taken and the samples kept, as the step itself would have;
   * if not, nothing is touched and the step is the core's last, for `advance` to take.
   */
  private quietDuty(inst: McuInstance): boolean {
    const core = inst.mcu as LocalCore
    const drive = (key: string) => {
      const pad = inst.pads.get(key)
      return pad ? core.padDrive(pad) : null
    }
    let state = this.ditherState
    const now = inst.sampledPrev
    now.clear()
    for (const padKey of core.dutyPads()) {
      const input = inst.inputByPad.get(padKey)
      if (input === undefined) continue
      const d = core.peekDuty(input.pad, DT)
      if (d !== null && d > 0 && d < 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0
        now.set(input.key, state / 4294967296 < d ? "high" : "low")
      }
    }
    // A sampled pad reads as its sample, any other as it drives.
    for (const [key, level] of now) if (level !== (inst.sampled.get(key) ?? drive(key))) return false
    for (const [key, level] of inst.sampled) if (!now.has(key) && level !== drive(key)) return false
    for (const padKey of core.dutyPads()) {
      const input = inst.inputByPad.get(padKey)
      if (input !== undefined) core.takeDuty(input.pad, DT)
    }
    this.ditherState = state
    inst.sampledPrev = inst.sampled
    inst.sampled = now
    return true
  }

  /** A step the core has already run with nothing changing: the rest of the step as `advance` takes it. */
  private quietStep(engine: Engine, read: PartReader) {
    this.serviceTerminals(engine.time + DT)
    for (const part of this.digitalParts.values()) part.tick?.(engine.time + DT)
    engine.step(DT, read, this.pinState, false)
    this.accumulateFlow(engine, DT)
  }

  /** What a panel shows: composed by the core that drives its pixel clock, or by our own instance when none does. */
  private capturePanel(p: PanelWiring & { own: PanelInstance }) {
    const wall = performance.now()
    const powered = this.panelPowered(p)
    const host = p.wired.get("CLK")?.host
    return host ? host.capturePanel(p, wall, powered) : p.own.capture(wall, powered)
  }

  /** Current operating point, shaped for the UI. Built on demand, not on every step; `paused` builds one for a bench that is not running (a debugger stop). */
  snapshot(paused = false): Snapshot | null {
    const engine = this.engine
    if (!engine || (!this.running && !paused)) return null
    const { net } = engine
    const pinVoltage: Record<string, number> = {}
    const pinVoltageRms: Record<string, number> = {}
    for (const [key, index] of net.pinNet) {
      pinVoltage[key] = index === GROUND ? 0 : engine.v[index]
      if (engine.ac) pinVoltageRms[key] = index === GROUND ? 0 : Math.sqrt(engine.v2[index])
    }
    const parts: Snapshot["parts"] = {}
    net.elements.forEach((el, index) => {
      if (el.kind !== "D" || !el.part) return
      // Brightness follows the current the eye would average, so PWM dimming and AC both read steadily.
      // A bench frozen by the debugger shows the current as it stands: the pins stay where the
      // stopped code left them for as long as the eye cares to look.
      const i = paused && !this.running ? engine.diodeI[index] : engine.diodeAvg[index]
      const level = i < LED_DARK ? 0 : Math.min(1, i / LED_FULL)
      parts[partKey(el.object, el.part)] = { on: level > 0.05, level }
    })
    const terminals = engine.terminalCurrents()
    const wireCurrent: Record<string, number> = {}
    const wireCurrentAbs: Record<string, number> = {}
    const wirePhase: Record<string, number> = {}
    this.flow.forEach((f, i) => (wirePhase[f.id] = this.flowPhase[i]))
    if (this.flowSeconds > 0) {
      this.flow.forEach((f, i) => {
        wireCurrent[f.id] = this.flowSigned[i] / this.flowSeconds
        wireCurrentAbs[f.id] = this.flowAbs[i] / this.flowSeconds
      })
      this.flowSigned.fill(0)
      this.flowAbs.fill(0)
      this.flowSeconds = 0
    } else {
      // No steps since the last snapshot (paused): report the instantaneous distribution.
      for (const [id, amps] of wireCurrents(this.doc.wires, net.pinNet, net.groundKeys, (k) => terminals.get(k) ?? 0, net.contacts)) {
        wireCurrent[id] = amps
        wireCurrentAbs[id] = Math.abs(amps)
      }
    }
    const pinCurrent: Record<string, number> = {}
    for (const key of net.pinNet.keys()) {
      const amps = terminals.get(key)
      if (amps !== undefined) pinCurrent[key] = amps
    }
    const probeReadings = engine.probeReadings()
    const probes: Snapshot["probes"] = {}
    this.probes.forEach((p, i) => {
      probes[p.id] = { ...probeReadings[i], live: this.probeLive[i] ?? false }
    })
    return {
      time: engine.time,
      converged: engine.converged,
      ac: engine.ac,
      pinVoltage,
      pinVoltageRms,
      parts,
      wireCurrent,
      wireCurrentAbs,
      wirePhase,
      pinCurrent,
      readings: engine.readings(),
      probes,
      trace: engine.drainTrace(),
      traceProbes: this.probes.map((p) => p.id),
      logic: this.drainLogic(),
      damage: this.damage,
      rate: this.rate,
      mcus: Object.fromEntries([...this.mcus].map(([id, inst]) => [id, inst.status()])),
      terminals: Object.fromEntries([...this.terminals].map(([id, t]) => [id, { text: t.text, framingErrors: t.decoder.framingErrors }])),
      digital: Object.fromEntries([...this.digitalParts].map(([id, p]) => [id, p.snapshot()])),
      displays: Object.fromEntries([...this.panels].map(([id, p]) => [id, { width: p.spec.width, height: p.spec.height, ...this.capturePanel(p) }])),
    }
  }
}
