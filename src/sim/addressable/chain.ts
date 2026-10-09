/**
 * Cascadable LED chips as digital parts. One object is one chip, or a chain of identical
 * chips wired DO → DIN inside it (a strip, a ring, a matrix): the chain reads the frame's
 * header if the part has one, takes the next `chips × word` bits, passes the header and
 * everything after its words on at its DO, and latches what it took when the frame ends.
 *
 *   AddressableChain   supply, input threshold, straps, the shift into words, latching, faults
 *   ├── NrzChain       single-wire NRZ input (WS281x, WS291x, SK6812): backup input BIN,
 *   │                  relay output BO, direction sensing (WS2812B-V6)
 *   └── ClockedChain   clock + data input (WS2801), output current set by feedback resistors
 *
 * What the latched words light is a `LightStage` (pixels in the package, or current sinks for
 * LEDs outside it); how a frame is cut into fields is a `FrameFormat`.
 */
import type { DigitalEdge, DigitalPart } from "../digital"
import { formatFor, type ChannelDrive, type FrameFormat } from "./format"
import { PixelLight, SinkLight, type LightStage } from "./light"
import type { Channel, ChipSpec, ClockedTiming, NrzTiming, StrapEffect } from "./spec"

/** A timing rule broken, how often, and the last offending value against the limit (seconds, or Hz for a clock). */
export type TimingFault = { rule: string; count: number; last: number; limit: number }

export type WordField = { channel: Channel; role: "level" | "gain"; value: number; bits: number }

export type AddressableSnapshot = {
  part: string
  chips: number
  channels: Channel[]
  /** Per chip: latched duty (0..1) and current scale of each channel. */
  drive: ChannelDrive[][]
  /** Per chip: the latched word's fields as received; the frame header's. */
  words: WordField[][]
  header: WordField[]
  /** Per chip, for pixels: the colour it shows, 0xRRGGBB (0 dark). */
  colors: number[]
  /** Frames latched since power-on, and the bits the last one brought to this object. */
  frames: number
  lastBits: number
  /** Bits passed on at DO in the frame so far or the last one. */
  passed: number
  vdd: number
  /** The supply the die needs to run (the datasheet minimum), V. */
  supplyMin: number
  powered: boolean
  burnt: boolean
  /** Supply current averaged over the PWM period, A. */
  current: number
  /** The input the chip listens to (BIN after a backup switch-over, DO on a reversed V6). */
  input: string
  /** The data input's high level as last seen, and the threshold it must clear, V. */
  dinHigh: number | null
  vih: number
  /** Pulses that arrived but were not taken (below VIH, or the chip off). */
  ignored: number
  faults: TimingFault[]
  /** Strap and mode notes: a mode the model does not have, an inverted output. */
  notes: string[]
}

/** Edge times are differences of absolute times: a picosecond of float noise is not a timing fault. */
const TIME_EPS = 1e-12

/** Latching waits this long past the reset time before trusting no edge is still on its way (a core in a worker runs a step behind). */
const LATCH_SLACK = 50e-6

export abstract class AddressableChain implements DigitalPart {
  readonly object: string
  abstract readonly pins: readonly string[]
  abstract readonly outputs: readonly string[]
  abstract readonly senses: readonly string[]
  readonly out: DigitalEdge[] = []
  readonly spec: ChipSpec
  readonly chips: number
  protected readonly format: FrameFormat
  protected readonly light: LightStage
  /** Bits in one chip's word and in the frame header. */
  protected readonly word: number
  protected readonly head: number

  /** Words shifting in this frame, per chip; bits taken into them; the header shifting in. */
  private words: number[][]
  private taken = 0
  private headerIn: number[] | null
  private headerBitsIn = 0
  /** The words and header of the last latch, for the inspector. */
  private shown: number[][]
  private shownHeader: number[] | null
  private frames = 0
  private lastBits = 0
  protected passed = 0
  private faults = new Map<string, TimingFault>()
  protected ignored = 0

  protected vdd = 0
  protected powered = false
  protected burnt = false
  /** A chip marked dead on the field (to try a backup line): no output, no answer. */
  protected dead = false
  /** What the strap pin selects now. */
  protected strap: StrapEffect | null = null

  constructor(object: string, spec: ChipSpec, chips: number) {
    this.object = object
    this.spec = spec
    this.chips = chips
    this.format = formatFor(spec)
    this.word = this.format.word.bits
    this.head = this.format.header?.bits ?? 0
    this.light = spec.light.kind === "pixel" ? new PixelLight(spec, chips, this.format.channels) : new SinkLight(spec, chips, this.format.channels)
    this.words = Array.from({ length: chips }, () => this.format.word.blank())
    this.shown = this.words.map((w) => w.slice())
    this.headerIn = this.format.header?.blank() ?? null
    this.shownHeader = this.headerIn?.slice() ?? null
  }

  /** Whether the chip takes data at all right now. */
  protected get alive() {
    return this.powered && !this.burnt && !this.dead
  }

  /** Threshold the data input must clear, V. */
  protected get vih() {
    const v = this.spec.logic.vih
    return "volts" in v ? v.volts : v.ratio * this.vdd
  }

  configure(props: Record<string, string>) {
    const dead = props.fault === "dead"
    if (dead !== this.dead) {
      this.dead = dead
      this.light.on = this.alive
      this.refreshOutputs(0)
    }
  }

  /** Another part number picked on the field is a different chip: the loop builds a new one. */
  outdated(props: Record<string, string>) {
    return !!props.value && props.value !== this.spec.part
  }

  reset() {
    this.burnt = false
    this.powered = false
    this.vdd = 0
    this.light.on = false
    this.powerOn()
    this.faults.clear()
    this.ignored = 0
    this.frames = 0
    this.refreshOutputs(0)
  }

  burn() {
    this.burnt = true
    this.light.on = false
    this.refreshOutputs(0)
  }

  /** Power-on reset: latches cleared, every output off, the frame starts over. */
  protected powerOn() {
    this.light.clear()
    for (const w of this.words) w.fill(0)
    for (const w of this.shown) w.fill(0)
    this.headerIn?.fill(0)
    this.shownHeader?.fill(0)
    this.taken = 0
    this.headerBitsIn = 0
    this.passed = 0
    this.lastBits = 0
  }

  /** Supply in, the data input's levels, the strap; power-on and power-off follow the supply. */
  sense(volts: (pin: string) => number, time: number) {
    const gnd = volts("GND")
    this.vdd = volts(this.spec.logic.pin) - gnd
    // Pixels draw their LEDs' current from VDD; a driver's own supply is its die's.
    this.light.vdd = volts(this.spec.light.kind === "pixel" ? "VDD" : this.spec.logic.pin) - gnd
    const up = this.vdd >= this.spec.supply.min
    if (up !== this.powered) {
      this.powered = up
      if (up) this.powerOn()
      this.light.on = this.alive
      this.refreshOutputs(time)
    }
    const strap = this.spec.strap
    if (strap) {
      const high = volts(strap.pin) - gnd > this.vih
      this.strap = (high ? strap.high : strap.low) ?? null
    }
    this.senseInputs((pin) => volts(pin) - gnd)
  }

  /** The data inputs' voltages after a solve (their high level against VIH), feedback pins. */
  protected abstract senseInputs(volts: (pin: string) => number): void

  /** Output pins follow the chip's state (driven while it runs, released when it is off). */
  protected abstract refreshOutputs(time: number): void

  /** Header bit number `index` of the frame arrived. */
  protected takeHeader(index: number, bit: number) {
    if (!this.headerIn || !this.format.header) return
    this.format.header.push(this.headerIn, index, bit)
    this.headerBitsIn = index + 1
  }

  /** The next own bit of the frame arrived: shift it into the chip it belongs to. */
  protected take(bit: number) {
    const chip = Math.floor(this.taken / this.word)
    if (chip < this.chips) this.format.word.push(this.words[chip], this.taken % this.word, bit)
    this.taken++
  }

  /**
   * Whether the frame just ended was data at all: a line whose high never cleared VIH was
   * read as noise by the die. The analog side may only catch the line high some steps into a
   * frame, so the whole frame is judged when it latches, not pulse by pulse.
   */
  protected frameValid(): boolean {
    return true
  }

  /** The frame ended (reset low long enough, or the latch delay): show what came in. */
  protected latch() {
    if (this.taken === 0 && this.headerBitsIn === 0) return
    if (!this.frameValid()) {
      this.ignored += this.taken + this.headerBitsIn
      for (const w of this.words) w.fill(0)
      this.headerIn?.fill(0)
      this.taken = 0
      this.headerBitsIn = 0
      return
    }
    // The gains of a complete header apply to the whole frame; a cut header leaves the old ones.
    if (this.headerIn && this.headerBitsIn >= this.head) this.shownHeader = this.headerIn.slice()
    const full = Math.min(this.chips, Math.floor(this.taken / this.word))
    // A chip that got only part of its word keeps showing its old one.
    for (let chip = 0; chip < full; chip++) {
      this.light.set(chip, this.decode(this.words[chip], this.shownHeader))
      this.shown[chip] = this.words[chip].slice()
    }
    for (const w of this.words) w.fill(0)
    this.headerIn?.fill(0)
    this.lastBits = this.taken + this.headerBitsIn
    // A frame counts when it changed something: a whole word, or a whole header.
    if (full > 0 || (this.head > 0 && this.headerBitsIn >= this.head)) this.frames++
    this.taken = 0
    this.headerBitsIn = 0
  }

  /** A word's output drive, through the strap (an inverting POL). */
  private decode(word: readonly number[], header: readonly number[] | null): ChannelDrive[] {
    const drive = this.format.decode(word, header)
    return this.strap?.kind === "invert" ? drive.map((d) => ({ duty: 1 - d.duty, scale: d.scale })) : drive
  }

  /** Bits of this frame taken into words or the header. */
  protected get pending() {
    return this.taken + this.headerBitsIn
  }

  protected fault(rule: string, value: number, limit: number) {
    const f = this.faults.get(rule)
    if (f) {
      f.count++
      f.last = value
    } else this.faults.set(rule, { rule, count: 1, last: value, limit })
  }

  /** Loop time as of the last tick. */
  protected now = 0

  tick(time: number): boolean {
    this.now = time
    if (this.pending > 0 && time >= this.latchAt() + LATCH_SLACK) this.latch()
    return this.light.tick(time)
  }

  quietUntil(): number {
    const latch = this.pending > 0 ? this.latchAt() + LATCH_SLACK : Infinity
    return Math.min(this.light.quietUntil(this.now), latch)
  }

  /** When an open frame latches if nothing more comes (Infinity: the line is still high). */
  protected abstract latchAt(): number

  analog(key: string): number | undefined {
    return this.light.analog(key)
  }

  protected notes(): string[] {
    if (this.strap?.kind === "unmodelled") return [this.strap.what]
    if (this.strap?.kind === "invert") return [`${this.spec.strap?.pin}: outputs inverted`]
    return []
  }

  snapshot(): AddressableSnapshot {
    const light = this.light
    return {
      part: this.spec.part,
      chips: this.chips,
      channels: [...this.format.channels],
      drive: light.drive.map((c) => c.map((d) => ({ ...d }))),
      words: this.shown.map((w) => this.format.word.describe(w)),
      header: this.format.header && this.shownHeader ? this.format.header.describe(this.shownHeader) : [],
      colors: light instanceof PixelLight ? Array.from({ length: this.chips }, (_, i) => light.color(i)) : [],
      frames: this.frames,
      lastBits: this.lastBits,
      passed: this.passed,
      vdd: this.vdd,
      supplyMin: this.spec.supply.min,
      powered: this.powered,
      burnt: this.burnt,
      current: light.averageCurrent(),
      input: this.inputName(),
      dinHigh: this.dataHigh(),
      vih: this.vih,
      ignored: this.ignored,
      faults: [...this.faults.values()].map((f) => ({ ...f })),
      notes: this.notes(),
    }
  }

  protected abstract inputName(): string
  protected abstract dataHigh(): number | null

  abstract drive(pin: string): boolean | null
  abstract input(pin: string, level: boolean, time: number): void
}

// --- single-wire NRZ ---------------------------------------------------------------------------

/** One NRZ input: edges into bits, with the datasheet's timing checked. */
class NrzReceiver {
  readonly pin: string
  level = false
  rise = -Infinity
  fall = -Infinity
  prevBit = 0
  /** Bits since this input's last reset gap (its position in the frame), and when the first began. */
  bits = 0
  start = -Infinity
  /** Voltage the pin was last seen at while high, V (null before it was ever seen high); the highest seen in the current frame. */
  high: number | null = null
  frameHigh: number | null = null
  /** The current pulse passes on at DO rather than into a word. */
  passing = false
  /** The current pulse cleared VIH while the chip ran. */
  counted = false
  constructor(pin: string) {
    this.pin = pin
  }
}

export class NrzChain extends AddressableChain {
  readonly pins: readonly string[]
  readonly outputs: readonly string[]
  readonly senses: readonly string[]
  private readonly receivers = new Map<string, NrzReceiver>()
  /** The primary input, and where the chain drives its output (swapped on a reversed V6). */
  private inPin = "DIN"
  private outPin = "DO"
  /** A bidirectional part that has not seen data yet: both pins listen, neither drives. */
  private undecided = false
  /** Listening on BIN after the backup switch-over (kept until power-off). */
  private onBackup = false
  private readonly levels = new Map<string, boolean | null>()

  constructor(object: string, spec: ChipSpec, chips: number) {
    super(object, spec, chips)
    if (spec.input.kind !== "nrz") throw new Error(`${spec.part} is not a single-wire part`)
    const input = spec.input
    const data = ["DIN", ...(input.backup ? ["BIN"] : []), ...(input.bidirectional ? ["DO"] : [])]
    for (const pin of data) this.receivers.set(pin, new NrzReceiver(pin))
    this.outputs = ["DO", ...(input.relay ? ["BO"] : []), ...(input.bidirectional ? ["DIN"] : [])]
    this.pins = [...new Set([...data, ...this.outputs])]
    this.senses = [...new Set(["VDD", "GND", spec.logic.pin, ...data, ...(spec.strap ? [spec.strap.pin] : [])])]
  }

  private get timing(): NrzTiming {
    const base = (this.spec.input as { timing: NrzTiming }).timing
    return this.strap?.kind === "timing" ? this.strap.timing : base
  }

  private get active(): NrzReceiver {
    return this.receivers.get(this.onBackup ? "BIN" : this.inPin)!
  }

  private get relays() {
    return this.spec.input.kind === "nrz" && !!this.spec.input.relay
  }

  protected powerOn() {
    super.powerOn()
    this.onBackup = false
    this.undecided = this.spec.input.kind === "nrz" && !!this.spec.input.bidirectional
    this.inPin = "DIN"
    this.outPin = "DO"
    // A fresh die has seen no pulse: whatever low comes first counts as the reset before a frame.
    for (const rx of this.receivers?.values() ?? []) {
      rx.bits = 0
      rx.passing = false
      rx.rise = -Infinity
      rx.fall = -Infinity
    }
  }

  protected inputName() {
    return this.onBackup ? "BIN" : this.undecided ? "DIN or DO (waiting for data)" : this.inPin
  }

  protected dataHigh() {
    return this.active.high
  }

  protected senseInputs(volts: (pin: string) => number) {
    // The analog side sees a pulse train sampled at its own step: whatever it catches high is
    // the driver's high level.
    for (const rx of this.receivers.values()) {
      if (rx.pin === this.outPin && !this.undecided) continue
      const v = volts(rx.pin)
      // The line only ever sits at ground or at its driver's high: anything above is the high.
      if (v > 0.2) {
        rx.high = v
        rx.frameHigh = Math.max(rx.frameHigh ?? 0, v)
      }
    }
  }

  drive(pin: string): boolean | null {
    return this.levels.get(pin) ?? null
  }

  private set(pin: string, level: boolean | null, time: number) {
    if ((this.levels.get(pin) ?? null) === level) return
    this.levels.set(pin, level)
    this.out.push({ pin, level, time })
  }

  protected refreshOutputs(time: number) {
    // Running, DO (and BO) idle low between frames; unpowered, dead or still listening on
    // both pins, they let go.
    const idle = this.alive && !this.undecided ? false : null
    for (const pin of this.outputs) this.set(pin, pin === this.outPin || pin === "BO" ? idle : null, time)
  }

  protected latchAt() {
    const rx = this.active
    return rx.level ? Infinity : rx.fall + this.timing.reset
  }

  protected frameValid() {
    const rx = this.active
    const high = rx.frameHigh ?? rx.high
    return high === null || high >= this.vih
  }

  /** Levels the inputs stand at when the chain joins the bench: no edges, nothing to decode. */
  prime(levels: Map<string, boolean>) {
    for (const [pin, level] of levels) {
      const rx = this.receivers.get(pin)
      if (rx) rx.level = level
    }
  }

  input(pin: string, level: boolean, time: number) {
    const rx = this.receivers.get(pin)
    if (!rx || rx.level === level) return
    rx.level = level
    // The chip's own output comes back to it on the net: not data.
    if (pin === this.outPin && !this.undecided) return
    if (level) this.onRise(rx, time)
    else this.onFall(rx, time)
  }

  private onRise(rx: NrzReceiver, time: number) {
    if (this.undecided && this.alive) {
      // A V6 takes whichever of its two pins carries data first as the input.
      this.undecided = false
      this.inPin = rx.pin
      this.outPin = rx.pin === "DIN" ? "DO" : "DIN"
      this.refreshOutputs(time)
    }
    const t = this.timing
    const low = time - rx.fall
    const active = rx === this.active
    if (low >= t.reset || !Number.isFinite(rx.rise)) {
      if (active) {
        if (this.pending > 0) this.latch()
        this.passed = 0
      }
      rx.bits = 0
      rx.start = time
      rx.frameHigh = null
    } else if (Number.isFinite(rx.fall) && active && this.alive) {
      const [min, max] = rx.prevBit ? t.t1l : t.t0l
      if (low < min - TIME_EPS) this.fault(rx.prevBit ? "T1L short" : "T0L short", low, min)
      else if (low > max + TIME_EPS) this.fault(rx.prevBit ? "T1L long" : "T0L long", low, max)
    }
    rx.rise = time
    rx.counted = false
    if (!active || !this.alive) return
    // A high that never reaches VIH is no pulse to this input.
    if (rx.high !== null && rx.high < this.vih) {
      this.ignored++
      return
    }
    rx.counted = true
    const delay = this.spec.delay
    if (this.relays) this.set("BO", true, time + delay)
    const region = this.region(rx.bits)
    rx.passing = region === "pass" || region === "header"
    if (rx.passing) this.set(this.outPin, true, time + delay)
  }

  /**
   * Where bit `pos` of the frame (on the active input) goes: the header (read and passed on),
   * the dead chip's word skipped on BIN, this object's words, or past them (passed on).
   */
  private region(pos: number): "header" | "skip" | "own" | "pass" {
    if (pos < this.head) return "header"
    const ownStart = this.head + (this.onBackup ? this.word : 0)
    if (pos < ownStart) return "skip"
    return pos < ownStart + this.chips * this.word ? "own" : "pass"
  }

  private onFall(rx: NrzReceiver, time: number) {
    const high = time - rx.rise
    rx.fall = time
    const t = this.timing
    // The chip decides at a fixed point after the rising edge: past the 0-code's high, short of the 1-code's.
    const bit = high > (t.t0h[1] + t.t1h[0]) / 2 ? 1 : 0
    rx.prevBit = bit
    const pos = rx.bits++
    if (rx.pin === "BIN" && !this.onBackup) this.watchBackup()
    if (rx !== this.active || !rx.counted) return
    const [min, max] = bit ? t.t1h : t.t0h
    if (high < min - TIME_EPS) this.fault(bit ? "T1H short" : "T0H short", high, min)
    else if (high > max + TIME_EPS) this.fault(bit ? "T1H long" : "T0H long", high, max)
    const delay = this.spec.delay
    if (this.relays) this.set("BO", false, time + delay)
    if (rx.passing) {
      this.set(this.outPin, false, time + delay)
      this.passed++
    }
    const region = this.region(pos)
    if (region === "header") this.takeHeader(pos, bit)
    else if (region === "own") this.take(bit)
  }

  /**
   * BIN carries the stream as the chip before this one received it: the header, that chip's
   * word, then ours. With the chip before alive, DIN has had data by the time BIN brings our
   * word (the header passes straight through it; without a header DIN starts a word behind
   * BIN). If DIN has stayed silent all frame by then, the chip before is dead: this one moves
   * to BIN for good (until power-off, as the WS2813/WS2815 datasheets put it) and from then on
   * skips the dead chip's word. The frame it notices this in is lost: its word has gone by.
   */
  private watchBackup() {
    const bin = this.receivers.get("BIN")!
    if (bin.bits !== this.head + 2 * this.word || !this.alive) return
    const din = this.receivers.get(this.inPin)!
    if (din.rise >= bin.start || din.level) return
    this.onBackup = true
  }
}

// --- clock + data ------------------------------------------------------------------------------

/**
 * WS2801: SDI shifted in on CKI's rising edges; after its 24 rising edges the chip relays CKI
 * and SDI to CKO and SDO; CKI held low past the latch time ends the frame. Each output sinks
 * the current its feedback resistor sets.
 */
export class ClockedChain extends AddressableChain {
  readonly pins = ["CKI", "SDI", "CKO", "SDO"] as const
  readonly outputs = ["CKO", "SDO"] as const
  readonly senses: readonly string[]
  private readonly timing: ClockedTiming
  private ci = false
  private di = false
  private lastEdge = -Infinity
  private lastRise = -Infinity
  private ciHigh: number | null = null
  /** Rising edges since the last latch: past the chain's words, the chip relays. */
  private edges = 0
  private readonly levels = new Map<string, boolean | null>()

  constructor(object: string, spec: ChipSpec, chips: number) {
    super(object, spec, chips)
    if (spec.input.kind !== "clocked") throw new Error(`${spec.part} is not a clocked part`)
    this.timing = spec.input.timing
    const feedback = spec.light.kind === "sink" ? spec.light.outputs.flatMap((o) => (o.feedback ? [o.feedback] : [])) : []
    this.senses = [...new Set(["VDD", "GND", spec.logic.pin, "CKI", ...feedback, ...(spec.strap ? [spec.strap.pin] : [])])]
  }

  private get relaying() {
    return this.edges >= this.chips * this.word
  }

  protected inputName() {
    return "CKI/SDI"
  }

  protected dataHigh() {
    return this.ciHigh
  }

  protected senseInputs(volts: (pin: string) => number) {
    const v = volts("CKI")
    if (this.ci && v > 0.2) this.ciHigh = v
    const light = this.light as SinkLight
    light.outputs.forEach((o, i) => {
      if (o.feedback) light.setFeedback(i, volts(o.feedback))
    })
  }

  /** The feedback pins hold their reference while the chip runs. */
  analog(key: string): number | undefined {
    const light = this.light as SinkLight
    const fb = this.spec.light.kind === "sink" ? this.spec.light.feedback : undefined
    if (fb && light.outputs.some((o) => o.feedback === key)) return this.alive ? fb.volts : 0
    return super.analog(key)
  }

  drive(pin: string): boolean | null {
    return this.levels.get(pin) ?? null
  }

  private set(pin: string, level: boolean | null, time: number) {
    if ((this.levels.get(pin) ?? null) === level) return
    this.levels.set(pin, level)
    this.out.push({ pin, level, time })
  }

  protected refreshOutputs(time: number) {
    const level = this.alive ? false : null
    this.set("CKO", level, time)
    this.set("SDO", level, time)
  }

  protected latchAt() {
    return this.ci ? Infinity : this.lastEdge + this.timing.latch
  }

  protected latch() {
    super.latch()
    this.edges = 0
  }

  protected get pending() {
    return super.pending + (this.relaying ? 1 : 0)
  }

  prime(levels: Map<string, boolean>) {
    this.ci = levels.get("CKI") ?? this.ci
    this.di = levels.get("SDI") ?? this.di
  }

  input(pin: string, level: boolean, time: number) {
    const delay = this.spec.delay
    if (pin === "SDI") {
      this.di = level
      if (this.alive && this.relaying) this.set("SDO", level, time + delay)
      return
    }
    if (pin !== "CKI" || level === this.ci) return
    const since = time - this.lastEdge
    this.ci = level
    if (!level) {
      this.lastEdge = time
      if (this.alive && this.relaying) this.set("CKO", false, time + delay)
      return
    }
    // The clock idled low past the latch time before this edge: that frame is over.
    if (since >= this.timing.latch && this.edges > 0) {
      this.latch()
      this.passed = 0
    }
    if (Number.isFinite(this.lastRise) && time - this.lastRise < 1 / this.timing.maxHz) this.fault("clock too fast", 1 / (time - this.lastRise), this.timing.maxHz)
    this.lastRise = time
    this.lastEdge = time
    if (!this.alive) return
    if (this.ciHigh !== null && this.ciHigh < this.vih) {
      this.ignored++
      return
    }
    if (this.relaying) {
      this.set("SDO", this.di, time + delay)
      this.set("CKO", true, time + delay)
      this.passed++
    } else this.take(this.di ? 1 : 0)
    this.edges++
  }
}

/** The chain for a spec: by how it takes its data. */
export function chainFor(object: string, spec: ChipSpec, chips: number): AddressableChain {
  return spec.input.kind === "nrz" ? new NrzChain(object, spec, chips) : new ClockedChain(object, spec, chips)
}
