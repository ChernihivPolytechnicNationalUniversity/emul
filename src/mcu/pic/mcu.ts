/**
 * A PIC16F62x assembled from a chip profile: the core, the two ports, the interrupt logic, the
 * configuration word, the oscillator modes, the resets and their timers, Sleep and the two ways
 * into Program/Verify mode. Every behaviour cites docs/pic16-checklist.md (row IDs, or D-numbers
 * for the decisions where the documents are silent). The simulation loop drives it as it drives
 * the other cores: run to a time, read the pads, report what the circuit puts on them.
 */
import { CpuHalt, emulatorError } from "../faults"
import { parseFirmware, type Firmware } from "../elf"
import type { PadDrive } from "../periph/gpio"
import type { PadRef } from "../pads"
import { PicCpu, STATUS_PD, STATUS_TO, type FileHooks, type PicSystem } from "./cpu"
import { ER_MIN_HZ, byVdd, clkoutOnRa6, clockRating, erFrequency, fosc, oscMode, vddMin, type OscMode, type PicProfile } from "./chip"
import type { Peripheral, PicBus } from "./io"
import { PicPort, type PinMode } from "./port"
import { Timer0, Watchdog } from "./periph/timer0"
import { Timer1, type T1Oscillator } from "./periph/timer1"
import { Ccp1, Timer2 } from "./periph/ccp"
import { Comparators } from "./periph/comparator"
import { Usart } from "./periph/usart"
import { DataEeprom } from "./periph/eeprom"

export type PicResetCause = "power-on" | "brown-out" | "mclr" | "mclr-sleep" | "wdt"

/** What feeds OSC1/OSC2 from the circuit: a crystal or resonator across them, a clock into OSC1, or the RC/ER network's frequency. */
export type PicClockFeed = { hz: number; kind: "crystal" | "clock" | "rc" } | null

// SFR addresses (Tables 4-3…4-6).
const TMR0 = [0x01, 0x101]
const PORTA = 0x05
const PORTB = [0x06, 0x106]
const INTCON = [0x0b, 0x8b, 0x10b, 0x18b]
const PIR1 = 0x0c
const OPTION = [0x81, 0x181]
const TRISA = 0x85
const TRISB = [0x86, 0x186]
const PIE1 = 0x8c
const PCON = 0x8e

/** Comparator modes: which of RA0–RA3 are analog inputs (Figure 10-1: "A" pins read 0). */
const ANALOG_BY_CM = [0b1111, 0b1111, 0b1111, 0b0111, 0b1111, 0b0110, 0b0111, 0b0000]

export class PicMcu implements PicBus, PicSystem {
  readonly chip: PicProfile
  readonly cpu: PicCpu
  readonly porta: PicPort
  readonly portb: PicPort
  readonly peripherals: Peripheral[] = []
  readonly timer0: Timer0
  readonly wdt: Watchdog
  readonly timer1: Timer1
  readonly timer2: Timer2
  readonly ccp: Ccp1
  readonly comparators: Comparators
  readonly usart: Usart
  readonly dataEeprom: DataEeprom
  /** The voltage on each pad as the circuit last solved it (comparator inputs). */
  private readonly analog = new Map<number, number>()
  readonly eeprom: Uint8Array
  /** Configuration word at 2007h (Register 14-1); erased: 3FFFh (P8-162). */
  config = 0x3fff
  /** User ID words 2000h–2003h. */
  readonly ids = new Uint16Array(4).fill(0x3fff)
  firmware: Firmware | null = null
  firmwareName = ""

  // Interrupt logic (Figure 14-14) and the registers around it.
  intcon = 0
  pir1 = 0
  pie1 = 0
  optionReg = 0xff
  pcon = 0x08

  /** Simulated time at the start of the current slice, and the cycle it began at. */
  time = 0
  private sliceCycle = 0
  private sliceTime = 0
  clockFeed: PicClockFeed = null
  vdd = 5
  /** Held: power-on (VDD under the POR level), brown-out, MCLR, or start-up timers until `startAt`. */
  private porHeld = false
  private borHeld = false
  private borLowSince: number | null = null
  private mclrLowSince: number | null = null
  private mclrInReset = false
  private mclrDuringSleep = false
  private startAt = 0
  /** Program/Verify mode: the part does not run until a reset (decision D11). */
  programmingMode = false
  programmingEntry: "high-voltage" | "low-voltage" | null = null
  private mclrVolts = 5
  resets = 0
  lastReset: PicResetCause | null = null
  /** Time the core resumed after its last wake-up from Sleep (the start-up wait included). */
  wokeAt: number | null = null
  private wdtWake = false
  private resetRequest: PicResetCause | null = null
  /** PORTB<7:4> as latched by the last read or write of PORTB (§5.2, P1-226). */
  private rbLatched = 0
  /** OSCF speed change in progress: the system clock is halted until then (§14.2.8, P4-052). */
  private haltedUntil = 0

  /** Edges on watched pads, stamped with their exact time (the digital fast path out). */
  readonly digitalOut: { pad: PadRef; level: boolean | null; time: number }[] = []
  readonly digitalWatch = new Set<number>()
  yieldOnOutput = false
  /** Blocks or modes the firmware used that are not modelled, by name. */
  readonly unmodelled = new Map<string, { reads: number; writes: number }>()
  private readonly padQueue: { pad: PadRef; level: boolean; time: number }[] = []
  private seed = 0x2545f491

  constructor(chip: PicProfile) {
    this.chip = chip
    this.cpu = new PicCpu(chip, this)
    this.eeprom = new Uint8Array(chip.eepromBytes).fill(0xff)
    this.porta = new PicPort("A", 0, (p) => this.modeA(p))
    this.portb = new PicPort("B", 1, (p) => this.modeB(p))
    for (const port of [this.porta, this.portb]) {
      port.onDrive = (pin, drive, cycle) => this.padChanged(port.index, pin, drive, cycle)
      port.onInput = (pin, level, cycle) => this.inputChanged(port.index, pin, level, cycle)
    }
    this.timer0 = this.attach(
      new Timer0(this, {
        get option() {
          return host.optionReg
        },
        setT0if: (cycle) => this.setFlag("intcon", 0x04, cycle),
        t0cki: () => this.porta.pin(4),
      }),
    )
    const host = this
    this.wdt = this.attach(
      new Watchdog(
        this,
        {
          get option() {
            return host.optionReg
          },
          get enabled() {
            return (host.config & 0x04) !== 0
          },
          get asleep() {
            return host.cpu.sleeping
          },
          timeout: (asleep) => this.wdtTimeout(asleep),
        },
        chip.electrical.wdt.typ,
      ),
    )
    this.timer1 = this.attach(
      new Timer1(this, {
        setTmr1if: (cycle) => this.setFlag("pir1", 0x01, cycle),
        t1cki: () => this.portb.pin(6),
        get asleep() {
          return host.cpu.sleeping
        },
        get compareTarget() {
          return host.ccp.compareTarget
        },
        onCompare: (cycle) => this.ccp.onCompare(cycle),
        get specialEvent() {
          return host.ccp.specialEvent
        },
      }),
    )
    this.timer2 = this.attach(
      new Timer2(this, {
        setTmr2if: (cycle) => this.setFlag("pir1", 0x02, cycle),
        onPeriod: (cycle) => this.ccp.onPeriod(cycle),
      }),
    )
    this.ccp = this.attach(
      new Ccp1(this, {
        timer1: this.timer1,
        timer2: this.timer2,
        setCcp1if: (cycle) => this.setFlag("pir1", 0x04, cycle),
        get asleep() {
          return host.cpu.sleeping
        },
        pinChanged: (cycle) => this.portb.refresh(cycle),
      }),
    )
    this.comparators = this.attach(
      new Comparators(this, {
        volts: (pin) => this.analog.get(pin) ?? (this.porta.pin(pin) ? this.vdd : 0),
        get vdd() {
          return host.vdd
        },
        setCmif: (cycle) => this.setFlag("pir1", 0x40, cycle),
        pinsChanged: (cycle) => this.porta.refresh(cycle),
        defective001: chip.comparator001Defective,
      }),
    )
    this.usart = this.attach(
      new Usart(this, {
        flag: (mask, on, cycle) => {
          if (on) this.setFlag("pir1", mask, cycle)
          else {
            this.pir1 &= ~mask
            this.irqChanged(cycle)
          }
        },
        pinAt: (pin, at) => this.portb.pinAt(pin, at),
        pinsChanged: (cycle) => this.portb.refresh(cycle),
      }),
    )
    this.dataEeprom = this.attach(
      new DataEeprom(this, {
        cells: this.eeprom,
        get vdd() {
          return host.vdd
        },
        vddMin: vddMin(chip),
        writeTime: chip.electrical.eeWrite.typ,
        endurance: chip.electrical.eeEndurance,
        setEeif: (cycle) => this.setFlag("pir1", 0x80, cycle),
      }),
    )
    this.registers()
    this.powerOnReset()
  }

  attach<T extends Peripheral>(p: T): T {
    this.peripherals.push(p)
    return p
  }

  // --- PicBus --------------------------------------------------------------------------------

  /** FOSC, Hz, from the configuration word and the circuit; 0 when nothing oscillates. */
  get fosc(): number {
    return this.oscillator() ?? 0
  }
  get hz(): number {
    return this.fosc / 4
  }
  register(addrs: number | number[], hooks: FileHooks) {
    this.cpu.hook(addrs, hooks)
  }
  reschedule() {
    let due = Infinity
    for (const p of this.peripherals) if (p.due < due) due = p.due
    if (this.padQueue.length) due = Math.min(due, Math.max(this.cpu.cycles, Math.ceil(this.timeCycle(this.padQueue[0].time) - 1e-9)))
    this.cpu.nextEventCycle = due
  }
  pinsChanged(cycle = Math.ceil(this.cpu.at)) {
    this.porta.refresh(cycle)
    this.portb.refresh(cycle)
  }
  cycleTime(cycle: number): number {
    const hz = this.hz
    return hz > 0 ? this.sliceTime + (cycle - this.sliceCycle) / hz : this.sliceTime
  }
  timeCycle(t: number): number {
    return this.sliceCycle + (t - this.sliceTime) * this.hz
  }
  get now(): number {
    return this.cycleTime(this.cpu.cycles)
  }
  feature(what: string) {
    const hit = this.unmodelled.get(what) ?? { reads: 0, writes: 0 }
    hit.writes++
    this.unmodelled.set(what, hit)
  }
  random(): number {
    // xorshift32: the cells' power-up pattern, different on every power-on (decision D2).
    let x = this.seed
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.seed = x >>> 0
    return this.seed / 2 ** 32
  }

  // --- interrupts (Figure 14-14) ----------------------------------------------------------------

  /** The wake-up term: enabled flags, peripheral ones through PEIE, GIE not involved (P4-153). */
  private get requested(): boolean {
    const i = this.intcon
    if (i & (i >> 3) & 0x07) return true
    return (i & 0x40) !== 0 && (this.pir1 & this.pie1) !== 0
  }
  irqChanged(cycle: number) {
    const vector = (this.intcon & 0x80) !== 0 && this.requested
    if (!vector) this.cpu.irqAt = Infinity
    else if (this.cpu.irqAt === Infinity) this.cpu.irqAt = cycle
  }
  /** A flag sets at `cycle` (hardware sets flags in Q1, P8-170). */
  setFlag(reg: "intcon" | "pir1", mask: number, cycle: number) {
    if (reg === "intcon") this.intcon |= mask
    else this.pir1 |= mask
    this.irqChanged(cycle)
  }

  // --- registers -------------------------------------------------------------------------------

  private registers() {
    const at = () => this.cpu.at
    this.register(TMR0, { name: "TMR0", read: () => this.timer0.read(), peek: () => this.timer0.value(this.cpu.cycles), write: (v) => this.timer0.write(v) })
    this.register(OPTION, { name: "OPTION_REG", read: () => this.optionReg, write: (v) => this.writeOption(v, at()) })
    this.register(INTCON, {
      name: "INTCON",
      read: () => this.intcon,
      write: (v) => {
        this.intcon = v & 0xff
        this.irqChanged(at())
        // A persisting PORTB mismatch sets RBIF again at the next Q1 (§5.2 b, P1-229).
        if (!(v & 1) && this.rbMismatch()) this.setFlag("intcon", 0x01, Math.ceil(at()))
      },
    })
    this.register(PIR1, {
      name: "PIR1",
      read: () => this.pir1,
      // RCIF and TXIF are read-only (Register 4-5); bit 3 unimplemented.
      write: (v) => {
        this.pir1 = (this.pir1 & 0x30) | (v & 0xc7)
        this.irqChanged(at())
        // A comparator mismatch keeps CMIF set until CMCON is read (§10.6).
        if (!(v & 0x40) && this.comparators.mismatch()) this.setFlag("pir1", 0x40, Math.ceil(at()))
      },
    })
    this.register(PIE1, {
      name: "PIE1",
      read: () => this.pie1,
      write: (v) => {
        this.pie1 = v & 0xf7
        this.irqChanged(at())
      },
    })
    this.register(PCON, { name: "PCON", read: () => this.pcon, write: (v) => this.writePcon(v) })
    this.register(PORTA, {
      name: "PORTA",
      read: () => this.porta.read(at()),
      peek: () => this.porta.read(this.cpu.cycles),
      write: (v) => this.porta.writeLatch(v, Math.ceil(at())),
    })
    this.register(TRISA, {
      name: "TRISA",
      // TRISA5 reads 1: RA5 has no output driver (Example 5-1, Table 4-4; decision on P1-211).
      read: () => this.porta.tris | 0x20,
      write: (v) => this.porta.writeTris(v, Math.ceil(at())),
    })
    this.register(PORTB, {
      name: "PORTB",
      read: () => {
        const v = this.portb.read(at())
        this.rbLatched = v & 0xf0
        return v
      },
      peek: () => this.portb.read(this.cpu.cycles),
      write: (v) => {
        this.rbLatched = this.portb.read(at()) & 0xf0
        this.portb.writeLatch(v, Math.ceil(at()))
      },
    })
    this.register(TRISB, { name: "TRISB", read: () => this.portb.tris, write: (v) => this.writeTrisB(v, at()) })
    const cmp = this.comparators
    this.register(0x1f, {
      name: "CMCON",
      read: () => cmp.readCmcon(),
      peek: () => cmp.peekCmcon(),
      write: (v) => cmp.writeCmcon(v, Math.ceil(at())),
    })
    this.register(0x9f, {
      name: "VRCON",
      read: () => cmp.vrcon,
      write: (v) => cmp.writeVrcon(v, Math.ceil(at())),
    })
    const t1 = this.timer1
    const t2 = this.timer2
    const ccp = this.ccp
    this.register(0x0e, { name: "TMR1L", read: () => t1.readL(), peek: () => t1.peekValue() & 0xff, write: (v) => t1.write(false, v) })
    this.register(0x0f, { name: "TMR1H", read: () => t1.readH(), peek: () => t1.peekValue() >> 8, write: (v) => t1.write(true, v) })
    this.register(0x10, { name: "T1CON", read: () => t1.t1con, write: (v) => t1.writeT1con(v) })
    this.register(0x11, { name: "TMR2", read: () => t2.read(), peek: () => t2.value(this.cpu.cycles), write: (v) => t2.write(v) })
    this.register(0x12, { name: "T2CON", read: () => t2.t2con, write: (v) => t2.writeT2con(v) })
    this.register(0x92, { name: "PR2", read: () => t2.pr2, write: (v) => t2.writePr2(v) })
    this.register(0x15, { name: "CCPR1L", read: () => ccp.ccpr1l, write: (v) => ccp.writeL(v) })
    this.register(0x16, { name: "CCPR1H", read: () => ccp.ccpr1h, write: (v) => ccp.writeH(v) })
    this.register(0x17, { name: "CCP1CON", read: () => ccp.ccp1con, write: (v) => ccp.writeCon(v) })
    const u = this.usart
    this.register(0x18, {
      name: "RCSTA",
      read: () => u.readRcsta(),
      peek: () => u.peekRcsta(),
      write: (v) => {
        u.writeRcsta(v)
        this.checkUsartTris()
      },
    })
    this.register(0x19, { name: "TXREG", read: () => u.txreg, write: (v) => u.writeTxreg(v) })
    this.register(0x1a, { name: "RCREG", read: () => u.readRcreg(), peek: () => u.peekRcreg(), write: () => {} })
    this.register(0x98, { name: "TXSTA", read: () => u.readTxsta(), peek: () => u.peekTxsta(), write: (v) => u.writeTxsta(v) })
    this.register(0x99, { name: "SPBRG", read: () => u.spbrg, write: (v) => u.writeSpbrg(v) })
    const ee = this.dataEeprom
    this.register(0x9a, { name: "EEDATA", read: () => ee.eedata, write: (v) => (ee.eedata = v & 0xff) })
    this.register(0x9b, { name: "EEADR", read: () => ee.eeadr, write: (v) => (ee.eeadr = v & 0xff) })
    this.register(0x9c, { name: "EECON1", read: () => ee.readEecon1(), write: (v) => ee.writeEecon1(v) })
    // EECON2 is not a physical register: it reads 0 (P3-192).
    this.register(0x9d, { name: "EECON2", read: () => 0, write: (v) => ee.writeEecon2(v) })
  }

  private writeOption(v: number, at: number) {
    const c = Math.floor(at)
    const was = this.optionReg
    this.timer0.optionChanging(c)
    this.optionReg = v & 0xff
    this.timer0.optionChanged(c)
    this.wdt.plan()
    if ((was ^ v) & 0x80) this.pinsChanged(Math.ceil(at))
    this.reschedule()
  }
  /** SPEN with TRISB<2:1> not both set: §12.0 asks for them set (decision D28). */
  private checkUsartTris() {
    if (this.usart.spen && (this.portb.tris & 0x06) !== 0x06)
      this.feature("USART enabled (SPEN) with TRISB<1> or TRISB<2> = 0: §12.0 asks for both set — the pin drives the USART's output (decision D28)")
  }
  private writeTrisB(v: number, at: number) {
    this.portb.writeTris(v, Math.ceil(at))
    this.checkUsartTris()
    // An RB<7:4> pin turned input joins the comparison (P1-225).
    if (this.rbMismatch()) this.setFlag("intcon", 0x01, Math.ceil(at))
  }

  /** PCON: OSCF switches the internal oscillator; POR/BOR are the program's bookkeeping (Register 4-6). */
  private writePcon(v: number) {
    const oscf = (v & 0x08) !== 0
    const was = (this.pcon & 0x08) !== 0
    this.pcon = v & 0x0b
    const mode = oscMode(this.config)
    if (oscf === was) return
    if (mode !== "INTOSC" && !(mode === "RC" && this.chip.rcKind === "ER")) return
    // The speed transition: two clock pulses at the old rate and eight at the new, the system clock halted (§14.2.8, P4-052;
    // DS40300C says nothing of it for INTRC/ER — the same sequence is assumed, decision in the checklist).
    const oldHz = this.fosc
    this.rebase()
    const newHz = this.oscillator() ?? oldHz
    this.haltedUntil = this.time + 2 / oldHz + 8 / newHz
    this.clockMoved()
    this.checkClock()
  }

  // --- clock -------------------------------------------------------------------------------------

  /** FOSC from the configuration word and the circuit (Register 14-1, §14.2); null: nothing oscillates. */
  private oscillator(): number | null {
    const e = this.chip.electrical
    const slow = (this.pcon & 0x08) === 0
    switch (oscMode(this.config)) {
      case "INTOSC":
        return slow ? e.intoscSlow : e.intosc
      case "RC":
        if (this.chip.rcKind === "ER" && slow) return e.intoscSlow // ER: OSCF = 0 is the fixed 37 kHz (P6-009)
        return this.clockFeed?.kind === "rc" && this.clockFeed.hz > 0 ? this.clockFeed.hz : null
      case "EC":
        return this.clockFeed?.kind === "clock" ? this.clockFeed.hz : null
      default:
        // A crystal or resonator across OSC1/OSC2, or a clock driven into OSC1 (§14.2.2, Figure 14-4).
        return this.clockFeed && this.clockFeed.kind !== "rc" ? this.clockFeed.hz : null
    }
  }
  get oscMode(): OscMode {
    return oscMode(this.config)
  }
  /** Why the core does not run, when the selected oscillator gets nothing from the circuit. */
  clockProblem(): string | null {
    if (this.oscillator() !== null) return null
    switch (oscMode(this.config)) {
      case "RC":
        if (this.chip.rcKind === "ER" && this.erOhms !== null)
          return `the ER oscillator stops: ${(this.erOhms / 1e6).toFixed(2)} MΩ on RA7/OSC1 would give under ${ER_MIN_HZ / 1e3} kHz ("may stop completely", DS40300C §14.2.4; decision D39)`
        return this.chip.rcKind === "ER"
          ? "FOSC selects the ER oscillator: a resistor from RA7/OSC1 to VSS sets its frequency, and there is none"
          : "FOSC selects the RC oscillator: REXT to VDD and CEXT to VSS on RA7/OSC1 set its frequency, and there are none"
      case "EC":
        return "FOSC selects an external clock on RA7/OSC1/CLKIN, and nothing drives it"
      default:
        return `FOSC selects the ${oscMode(this.config)} oscillator: there is no crystal or resonator across OSC1/OSC2`
    }
  }
  setClockFeed(feed: PicClockFeed) {
    this.rebase()
    this.clockFeed = feed
    this.clockMoved()
    this.checkClock()
  }
  /** The original part's ER resistor from RA7/OSC1 to VSS, Ω (DS40300C §14.2.4, Table 14-3; decision D39). */
  erOhms: number | null = null
  setErResistor(ohms: number | null) {
    this.erOhms = ohms
    if (ohms !== null && (ohms < 10e3 || ohms > 1e6))
      this.feature(`ER resistor ${ohms >= 1e6 ? `${+(ohms / 1e6).toFixed(2)} MΩ` : `${+(ohms / 1e3).toFixed(2)} kΩ`} outside the recommended 10 kΩ–1 MΩ (DS40300C §14.2.4: temperature- or leakage-sensitive; decision D39)`)
    const hz = ohms === null ? null : erFrequency(ohms)
    this.setClockFeed(ohms === null ? null : { hz: hz ?? 0, kind: "rc" })
  }
  /** A clock outside the part's ratings is reported; the part runs as configured (decision D38). */
  private checkClock() {
    const hz = this.oscillator()
    if (!hz) return
    const kind = this.oscMode === "INTOSC" || (this.oscMode === "RC" && this.chip.rcKind === "ER" && !(this.pcon & 0x08)) ? "internal" : (this.clockFeed?.kind ?? "internal")
    const why = clockRating(this.chip, this.config, hz, kind, this.vdd)
    if (why) this.feature(why)
  }
  /** Close the current slice at the present cycle. */
  private rebase() {
    for (const p of this.peripherals) p.sync(this.cpu.cycles)
    this.time = this.cycleTime(this.cpu.cycles)
    this.sliceTime = this.time
    this.sliceCycle = this.cpu.cycles
  }
  private clockMoved() {
    for (const p of this.peripherals) p.clockChanged(this.cpu.cycles)
    this.reschedule()
    this.cpu.stop = true
  }

  // --- pins ------------------------------------------------------------------------------------

  private get lvp() {
    return (this.config & 0x80) !== 0
  }
  private get mclre() {
    return (this.config & 0x20) !== 0
  }
  /** PORTA pins: comparator inputs/outputs, RA4 open drain, RA5 input only, RA6/RA7 by FOSC (§5.1, Figures 5-1…5-7). */
  private modeA(p: number): PinMode {
    const m: PinMode = { digital: true, output: true, openDrain: false, pullUp: false }
    const cmp = this.comparators
    const cm = cmp ? cmp.mode : 0
    if (p < 4 && ANALOG_BY_CM[cm] & (1 << p)) m.digital = false
    if (p === 4) m.openDrain = true
    // CM = 110: C1 out on RA3, C2 out on RA4 (open drain), TRISA enabling them (§10.5, Figures 5-3/5-4).
    if (cm === 6 && (p === 3 || p === 4)) m.outValue = ((cmp.outputs >> (p - 3)) & 1) === 1
    // VREF on RA2: VREN and VROE with TRISA<2> = 1 (§11, P3-070).
    if (p === 2 && cmp?.outputOn && (this.porta.tris & 0x04)) {
      m.outEnable = true
      m.outValue = cmp.vref()
    }
    if (p === 5) m.output = false
    const f = fosc(this.config)
    if (p === 6) {
      if (clkoutOnRa6(this.config)) {
        // CLKOUT: FOSC/4 on the pin; its level is averaged as a duty (Figure 5-6). Stopped in Sleep.
        m.outEnable = true
        m.outValue = !this.cpu.sleeping
      } else if (!(f === 3 || f === 4 || f === 6)) {
        m.digital = false
        m.output = false
      }
    }
    if (p === 7 && !(f === 4 || f === 5)) {
      m.digital = false
      m.output = false
    }
    return m
  }
  /** PORTB pins: weak pull-ups, RB4 as PGM with LVP (§5.2, Figures 5-8…5-15). */
  private modeB(p: number): PinMode {
    const m: PinMode = { digital: true, output: true, openDrain: false, pullUp: false }
    const pgm = p === 4 && this.lvp
    if (pgm) m.output = false
    // T1OSCEN: RB7/RB6 are the Timer1 oscillator's — no output, the digital input off (§7.0, P2-041; D17).
    if ((p === 6 || p === 7) && this.timer1?.oscEnabled) {
      m.output = false
      m.digital = false
    }
    // RB3/CCP1: compare and PWM output through the pin's mux; TRISB<3> still enables it (Figure 5-11, §9.2.1, §9.3).
    if (p === 3 && this.ccp?.drivesPin) m.outValue = this.ccp.output
    // RB1/RX/DT and RB2/TX/CK with SPEN: the USART's output through the mux, its output enable besides TRIS, no pull-up
    // (Figures 5-9/5-10, decision D28).
    const usart = (p === 1 || p === 2) && this.usart?.spen
    if (usart) {
      const o = this.usart.pinOut(p as 1 | 2)
      m.outEnable = o.enable || ((this.portb.tris >> p) & 1) === 0
      m.outValue = o.value
    }
    const input = !m.output || ((this.portb.tris >> p) & 1) === 1
    m.pullUp = !(this.optionReg & 0x80) && input && !pgm && !usart
    return m
  }

  /** RB<7:4> inputs that differ from the value latched at the last PORTB access (P1-225/226). */
  private rbMismatch(): boolean {
    for (let p = 4; p < 8; p++) {
      if (p === 4 && this.lvp) continue
      if (!((this.portb.tris >> p) & 1)) continue
      if (this.portb.di(p) !== ((this.rbLatched >> p) & 1) > 0) return true
    }
    return false
  }

  private inputChanged(port: number, pin: number, level: boolean, cycle: number) {
    if (port === 0 && pin === 4) this.timer0.pinEdge(level, cycle)
    if (port === 1) {
      // RB0/INT: the edge INTEDG selects (§14.5.1).
      if (pin === 0 && level === ((this.optionReg & 0x40) !== 0)) this.setFlag("intcon", 0x02, cycle)
      if (pin === 6) this.timer1.pinEdge(level, cycle)
      if (pin === 1) this.usart.rxEdge(level, cycle)
      if (pin === 2) this.usart.ckEdge(level, cycle)
      if (pin === 3) this.ccp.pinEdge(level, cycle)
      if (pin >= 4 && this.rbMismatch()) this.setFlag("intcon", 0x01, cycle)
      if (pin === 4 && this.lvp && level) this.enterProgramming("low-voltage")
    }
  }

  // --- reset and start-up ------------------------------------------------------------------------

  /** Power-on: unknown cells at random (D2), then the POR state (Tables 14-6/14-7). */
  private powerOnReset() {
    this.seed = (this.seed ^ Math.floor(Math.random() * 2 ** 32)) >>> 0 || 1
    this.cpu.powerOn(() => this.random())
    this.rbLatched = Math.floor(this.random() * 16) << 4
    this.porta.latch = Math.floor(this.random() * 256) & 0xf0
    this.portb.latch = Math.floor(this.random() * 256)
    this.pcon = 0x08 | (this.random() < 0.5 ? 1 : 0)
    this.intcon = this.random() < 0.5 ? 1 : 0
    this.applyReset("power-on")
  }

  /**
   * The registers' reset state for a cause other than a wake-up (Table 14-7 middle column, Table
   * 14-6 for STATUS/PCON), and the start-up timers that follow it (Table 14-3).
   */
  private applyReset(cause: PicResetCause) {
    this.lastReset = cause
    this.resets = cause === "power-on" ? 0 : this.resets + 1
    const wasSleeping = this.cpu.sleeping
    this.dataEeprom.interrupt(this.time)
    this.cpu.reset()
    const s = this.cpu.status
    switch (cause) {
      case "power-on":
        this.cpu.status = s | STATUS_TO | STATUS_PD
        break
      case "mclr":
        // 000u uuuu.
        break
      case "mclr-sleep":
        this.cpu.status = (s | STATUS_TO) & ~STATUS_PD
        break
      case "wdt":
        // 0000 uuuu: TO clear, PD unchanged.
        this.cpu.status = s & ~STATUS_TO
        break
      case "brown-out":
        // 000x xuuu: TO and PD unknown (D2).
        this.cpu.status = (s & 0x07) | (this.random() < 0.5 ? STATUS_TO : 0) | (this.random() < 0.5 ? STATUS_PD : 0)
        break
    }
    void wasSleeping
    // PCON: OSCF = 1 on every reset (Tables 14-6/14-7, decision on P4-094); POR only on power-on; BOR = 0 on a brown-out.
    this.pcon = (this.pcon & 0x03) | 0x08
    if (cause === "power-on") this.pcon &= ~0x02
    if (cause === "brown-out") this.pcon &= ~0x01
    this.intcon &= 0x01
    this.pir1 = 0
    this.pie1 = 0
    this.optionReg = 0xff
    this.porta.latch &= 0xf0
    this.porta.tris = 0xff
    this.portb.tris = 0xff
    this.wdtWake = false
    this.resetRequest = null
    this.haltedUntil = 0
    this.wokeAt = null
    this.sliceCycle = 0
    this.sliceTime = this.time
    for (const p of this.peripherals) p.reset(cause === "power-on")
    // T1CON clears on a brown-out too (Table 14-7 note 6).
    if (cause === "brown-out") this.timer1.brownOut()
    this.porta.refresh(0)
    this.portb.refresh(0)
    this.reschedule()
    // Start-up: PWRT on POR and BOR when enabled (or forced by BODEN on the original part), then the OST in crystal modes (Table 14-3).
    const e = this.chip.electrical
    const mode = oscMode(this.config)
    const crystal = mode === "LP" || mode === "XT" || mode === "HS"
    let wait = 0
    if (cause === "power-on" || cause === "brown-out") {
      const pwrt = !(this.config & 0x08) || (this.chip.borForcesPwrt && (this.config & 0x40) !== 0)
      if (pwrt) wait += e.pwrt.typ
      // The OST counts 1024 OSC1 cycles; it is on the BOR row of Table 14-3 too (decision on P4-067).
      if (crystal) wait += 1024 / (this.oscillator() ?? Infinity)
    }
    this.startAt = this.time + wait
    this.irqChanged(0)
  }

  /** Load a HEX image: program memory, the ID words, the configuration word and the data EEPROM (DS41196G Figure 2-1). */
  load(data: ArrayBuffer, name = "") {
    const fw = parseFirmware(data, name, [])
    this.cpu.flash.fill(0x3fff)
    this.eeprom.fill(0xff)
    this.ids.fill(0x3fff)
    let config: number | null = null
    for (const s of fw.segments)
      for (let i = 0; i < s.data.length; i++) {
        const a = s.addr + i
        const w = a >> 1
        const hi = a & 1
        const b = s.data[i]
        if (w < 0x2000) {
          if (w >= this.chip.flashWords) throw new Error(`image does not fit the ${this.chip.flashWords}-word program memory (word 0x${w.toString(16)})`)
          this.cpu.flash[w] = hi ? (this.cpu.flash[w] & 0x00ff) | ((b & 0x3f) << 8) : (this.cpu.flash[w] & 0x3f00) | b
        } else if (w >= 0x2000 && w < 0x2004) {
          const k = w - 0x2000
          this.ids[k] = hi ? (this.ids[k] & 0x00ff) | ((b & 0x3f) << 8) : (this.ids[k] & 0x3f00) | b
        } else if (w === 0x2007) {
          const c: number = config ?? 0x3fff
          config = hi ? (c & 0x00ff) | ((b & 0x3f) << 8) : (c & 0x3f00) | b
        } else if (w >= 0x2100 && w < 0x2100 + this.chip.eepromBytes && !hi) this.eeprom[w - 0x2100] = b
      }
    this.cpu.invalidate()
    this.firmware = fw
    this.firmwareName = name
    this.config = config ?? 0x3fff
    this.time = 0
    this.powerOnReset()
    this.checkClock()
  }
  /** Program words straight into flash (tests), with a configuration word. */
  program(words: number[], config = 0x3fff, at = 0) {
    this.cpu.flash.fill(0x3fff)
    this.cpu.flash.set(words.map((w) => w & 0x3fff), at)
    this.cpu.invalidate()
    this.config = config & 0x3fff
    this.firmware = { format: "bin", segments: [], entry: 0, symbols: [] }
    this.time = 0
    this.powerOnReset()
    this.checkClock()
  }

  /** The supply: POR on the rise through the POR level, BOR when enabled (§14.4.1, §14.4.4). */
  setSupply(volts: number) {
    const e = this.chip.electrical
    this.vdd = volts
    if (this.porHeld) {
      if (volts >= e.por) {
        this.porHeld = false
        const t = this.time
        this.powerOnReset()
        this.time = t
      }
      return
    }
    // POR re-arms when VDD has gone back under its level (D003: a POR is ensured from VSS; decision D10).
    if (volts < e.por) {
      this.porHeld = true
      this.holdInReset()
      return
    }
    if (this.config & 0x40) {
      const vbor = e.bor.typ
      if (!this.borHeld && volts < vbor) {
        this.borLowSince ??= this.time
        // A dip shorter than TBOR does not assure a reset (param 35): it resets once it has lasted TBOR.
        if (this.time - this.borLowSince >= e.borTime) {
          this.borHeld = true
          this.holdInReset()
        }
      } else if (volts >= vbor) {
        this.borLowSince = null
        if (this.borHeld) {
          this.borHeld = false
          this.applyReset("brown-out")
        }
      }
    }
    if (volts < vddMin(this.chip) && !this.porHeld) this.feature(`VDD ${volts.toFixed(2)} V: under the operating range (D001)`)
    else this.checkClock()
  }

  /** MCLR as a logic level (MCLRE = 1): low for at least TMCL resets (§14.3, param 30). */
  setMclr(low: boolean) {
    this.setMclrVoltage(low ? 0 : this.vdd)
  }
  /**
   * MCLR/VPP as a voltage: VIHH with RB6 and RB7 low enters Program/Verify (§14.11, DS41196G);
   * otherwise a Schmitt input (D042) that resets the part when MCLRE = 1. The HV detect works
   * whatever MCLRE says (Figure 5-5).
   */
  setMclrVoltage(volts: number) {
    this.mclrVolts = volts
    const e = this.chip.electrical
    if (volts >= e.vihh.min && !this.portb.pin(6) && !this.portb.pin(7)) {
      this.enterProgramming("high-voltage")
      return
    }
    if (!this.mclre) return
    const low = volts <= e.schmittOfVdd.vil * this.vdd
    if (low && this.mclrLowSince === null) {
      this.mclrLowSince = this.time
      this.mclrDuringSleep = this.cpu.sleeping
    } else if (!low && this.mclrLowSince !== null) {
      this.mclrLowSince = null
      if (this.mclrInReset) {
        this.mclrInReset = false
        this.leaveReset(this.mclrDuringSleep ? "mclr-sleep" : "mclr")
      }
    }
  }
  /** MCLR held long enough becomes a reset (the filter of §14.3 passes pulses of TMCL and longer). */
  private checkMclr() {
    if (this.mclrLowSince === null || this.mclrInReset) return
    if (this.time - this.mclrLowSince >= this.chip.electrical.mclrPulse - 1e-12) {
      this.mclrInReset = true
      this.holdInReset()
    }
  }
  /** VDD has stayed under VBOR for TBOR: brown-out reset, held until VDD is back over VBOR (§14.4.4). */
  private checkBor() {
    if (this.borLowSince === null || this.borHeld) return
    if (this.time - this.borLowSince >= this.chip.electrical.borTime - 1e-12) {
      this.borHeld = true
      this.holdInReset()
    }
  }
  /** A reset released: MCLR resets have no start-up timer (Table 14-3 lists POR, BOR and wake-up only). */
  private leaveReset(cause: PicResetCause) {
    const keepTime = this.time
    if (this.programmingMode) {
      this.programmingMode = false
      this.programmingEntry = null
    }
    this.applyReset(cause)
    this.time = keepTime
    this.sliceTime = keepTime
    // The PWRT and OST run from the POR pulse: held in MCLR past them, the part starts at once (§14.4.5, P4-074).
    if (this.startAt < keepTime) this.startAt = keepTime
  }

  /** Program/Verify mode: all other logic held in reset (DS41196G §2), left only through a reset (decision D11). */
  private enterProgramming(how: "high-voltage" | "low-voltage") {
    if (this.programmingMode) return
    this.programmingMode = true
    this.programmingEntry = how
    this.holdInReset()
    this.cpu.stop = true
    this.feature("ICSP: Program/Verify mode entered — the programming protocol (DS41196G) is not modelled; the part waits for a reset")
  }

  /** A reset takes hold: the pins go to inputs, a data EEPROM write under way is cut (D36). */
  private holdInReset() {
    this.dataEeprom.interrupt(this.time)
    this.porta.tris = this.portb.tris = 0xff
    this.pinsChanged(this.cpu.cycles)
  }

  /** Power applied from nothing (the loop's own power-on): a POR at time 0, the image kept. */
  powerOn() {
    this.time = 0
    this.porHeld = this.borHeld = false
    this.borLowSince = this.mclrLowSince = null
    this.mclrInReset = false
    this.programmingMode = false
    this.programmingEntry = null
    this.padQueue.length = 0
    this.powerOnReset()
    this.checkClock()
  }

  requestReset(cause: PicResetCause) {
    this.resetRequest = cause
    this.cpu.stop = true
  }
  private wdtTimeout(asleep: boolean) {
    if (asleep) {
      // WDT wake-up: STATUS uuu0 0uuu, execution continues after SLEEP (Table 14-6).
      this.cpu.status &= ~(STATUS_TO | STATUS_PD)
      this.wdtWake = true
    } else this.requestReset("wdt")
  }

  // --- running -------------------------------------------------------------------------------

  get running() {
    return this.firmware !== null && this.cpu.halted === null
  }
  get inReset() {
    return this.porHeld || this.borHeld || this.mclrInReset || this.programmingMode || this.time < this.startAt
  }

  /** Advance until simulated time `end`. Returns false once the core has halted. */
  runUntil(end: number): boolean {
    if (!this.running) return false
    try {
      while (this.time < end) {
        this.checkMclr()
        this.checkBor()
        if (this.porHeld || this.borHeld || this.mclrInReset || this.programmingMode) {
          this.time = end
          this.checkMclr()
          this.checkBor()
          this.drainHeld()
          break
        }
        const hold = Math.max(this.startAt, this.haltedUntil)
        if (this.time < hold) {
          const t = Math.min(end, hold, this.mclrLowSince !== null ? this.mclrLowSince + this.chip.electrical.mclrPulse : Infinity)
          this.time = t
          this.sliceTime = t
          this.sliceCycle = this.cpu.cycles
          this.drainHeld()
          if (t >= hold) for (const p of this.peripherals) p.clockChanged(this.cpu.cycles)
          this.reschedule()
          continue
        }
        if (this.oscillator() === null) {
          this.time = end
          this.drainHeld()
          break
        }
        let stopAt = end
        if (this.mclrLowSince !== null) stopAt = Math.min(stopAt, this.mclrLowSince + this.chip.electrical.mclrPulse)
        if (this.borLowSince !== null && !this.borHeld) stopAt = Math.min(stopAt, this.borLowSince + this.chip.electrical.borTime)
        const cycles = Math.max(1, Math.round((stopAt - this.time) * this.hz))
        const target = this.cpu.cycles + Math.min(cycles, 20000)
        this.sliceTime = this.time
        this.sliceCycle = this.cpu.cycles
        this.cpu.run(target)
        this.time = this.cycleTime(this.cpu.cycles)
        if (this.cpu.halted) return false
        if (this.resetRequest) {
          const cause = this.resetRequest
          const t = this.time
          this.applyReset(cause)
          this.time = t
          this.sliceTime = t
          this.startAt = t
          continue
        }
        if (this.cpu.stop) {
          this.cpu.stop = false
          if (this.yieldOnOutput && this.digitalOut.length) return true
        }
      }
      // Events due at the cycle the run stopped on have happened (they belong to its Q1): take them now.
      if (this.cpu.nextEventCycle <= this.cpu.cycles && !this.cpu.halted) {
        this.cpu.at = this.cpu.cycles
        this.service()
      }
    } catch (e) {
      if (!(e instanceof CpuHalt)) this.cpu.halted = emulatorError(e, this.cpu.opPc)
      return false
    }
    return true
  }
  private drainHeld() {
    const q = this.padQueue
    while (q.length && q[0].time <= this.time) {
      const e = q.shift()!
      this.portOf(e.pad)!.setExternal(e.pad.pin, e.level, this.cpu.cycles, undefined)
    }
  }
  private drainPads(cycle: number) {
    const q = this.padQueue
    while (q.length && this.timeCycle(q[0].time) <= cycle + 1e-9) {
      const e = q.shift()!
      this.portOf(e.pad)!.setExternal(e.pad.pin, e.level, Math.min(cycle, this.timeCycle(e.time)), undefined)
    }
  }

  // --- PicSystem ---------------------------------------------------------------------------------

  /** SLEEP completes as a NOP when an enabled flag is already set, whatever GIE (§14.8.1 note, decision D6). */
  sleep(): boolean {
    if (this.requested) return false
    const c = this.cpu.cycles
    // The WDT and its postscaler clear (when the prescaler is the WDT's; with PSA = 0 there is no postscaler, §6.3).
    this.wdt.clear(c)
    for (const p of this.peripherals) if (p.domain === "core") p.setClockRunning(false, c)
    this.pinsChanged(c + 1)
    return true
  }
  clrwdt() {
    this.wdt.clear(this.cpu.cycles)
  }
  option(w: number) {
    this.writeOption(w, this.cpu.cycles + 0.75)
  }
  tris(f: number, w: number) {
    // TRIS 5 / TRIS 6 load TRISA / TRISB; TRIS 7 has no port C behind it — a NOP (decision D5).
    if (f === 5) this.porta.writeTris(w, this.cpu.cycles + 1)
    else if (f === 6) this.writeTrisB(w, this.cpu.cycles + 0.75)
  }
  acknowledge() {
    this.intcon &= ~0x80
    this.cpu.irqAt = Infinity
  }
  retfie() {
    this.intcon |= 0x80
    this.irqChanged(this.cpu.cycles + 0.75)
  }
  canWake(): boolean {
    return this.requested || this.wdtWake
  }
  /** Oscillator start-up after Sleep, in instruction cycles (Table 14-3, Table 17-5 F14, Figure 14-17 note 2). */
  wakeCycles(): number {
    const e = this.chip.electrical
    const c = this.cpu.cycles
    this.wdtWake = false
    // The WDT is cleared on any wake-up (§14.8.1, P4-191).
    this.wdt.clear(c)
    for (const p of this.peripherals) if (p.domain === "core") p.setClockRunning(true, c)
    let wait = 0
    switch (oscMode(this.config)) {
      case "LP":
      case "XT":
      case "HS":
        wait = 256 // 1024 TOSC
        break
      case "INTOSC":
        wait = Math.round(byVdd(e.intoscWake, this.vdd) * this.hz)
        break
      case "RC":
        wait = Math.round(e.rcWake * this.hz)
        break
    }
    this.wokeAt = this.cycleTime(c + wait)
    this.pinsChanged(c + wait)
    return wait
  }
  reserved(word: number) {
    this.feature(`reserved opcode 0x${word.toString(16).padStart(4, "0")} (run as a NOP, decision D1)`)
  }
  service() {
    const c = this.cpu.cycles
    this.drainPads(c)
    for (const p of this.peripherals) if (p.due <= c) p.service(c)
    this.reschedule()
  }

  // --- pads ------------------------------------------------------------------------------------

  private portOf(p: PadRef): PicPort | null {
    return p.port === 0 ? this.porta : p.port === 1 ? this.portb : null
  }
  hasPad(p: PadRef): boolean {
    return this.portOf(p) !== null && p.pin >= 0 && p.pin < 8
  }
  padDrive(p: PadRef): PadDrive {
    return this.portOf(p)?.drive[p.pin] ?? null
  }
  /** CLKOUT frequency on a pad (RA6 with FOSC = 101/111 while the oscillator runs), else null. */
  clockOut(p: PadRef): number | null {
    if (p.port !== 0 || p.pin !== 6 || !clkoutOnRa6(this.config) || this.cpu.sleeping || this.inReset) return null
    return this.hz || null
  }
  setPad(p: PadRef, level: boolean, sampledUnder?: PadDrive) {
    this.portOf(p)?.setExternal(p.pin, level, this.cpu.cycles, sampledUnder)
  }
  setPadAt(p: PadRef, level: boolean, time: number) {
    if (!this.hasPad(p)) return
    if (time > this.now) {
      const q = this.padQueue
      let i = q.length
      while (i > 0 && q[i - 1].time > time) i--
      q.splice(i, 0, { pad: p, level, time })
      this.reschedule()
      return
    }
    this.portOf(p)!.setExternal(p.pin, level, Math.min(this.cpu.cycles, this.timeCycle(time)), undefined)
  }
  setWiredPads(keys: Iterable<number>) {
    const masks = [0, 0]
    for (const k of keys) if (k >>> 4 < 2) masks[k >>> 4] |= 1 << (k & 15)
    this.porta.sensed = masks[0]
    this.portb.sensed = masks[1]
    this.pinsChanged(this.cpu.cycles)
  }
  padVersion(): number {
    return this.porta.version + this.portb.version
  }
  private padChanged(port: number, pin: number, drive: PadDrive, cycle: number) {
    const key = port * 16 + pin
    this.trackDuty(key, port, pin, drive, cycle)
    if (!this.digitalWatch.has(key)) return
    const level = drive === "high" ? true : drive === "low" ? false : null
    this.digitalOut.push({ pad: { port, pin }, level, time: this.cycleTime(cycle) })
    if (this.yieldOnOutput) this.cpu.stop = true
  }

  /** CCP1's PWM on RB3: its duty is averaged for the circuit (the analog step is far longer than its period). */
  private dutySource(port: number, pin: number) {
    return port === 1 && pin === 3 && this.ccp?.pwm === true
  }
  private readonly duty = new Map<number, { level: boolean; since: number; high: number }>()
  private trackDuty(key: number, port: number, pin: number, drive: PadDrive, cycle: number) {
    if (!this.dutySource(port, pin) || (drive !== "high" && drive !== "low")) {
      this.duty.delete(key)
      return
    }
    const t = this.cycleTime(cycle)
    const d = this.duty.get(key)
    const level = drive === "high"
    if (!d) {
      this.duty.set(key, { level, since: t, high: 0 })
      return
    }
    if (d.level) d.high += t - d.since
    d.since = t
    d.level = level
  }
  dutyPads(): number[] {
    const keys = [...this.duty.keys()]
    if (this.clockOut({ port: 0, pin: 6 }) !== null) keys.push(6)
    return keys
  }
  /** What `takeDuty` would return now, leaving the accounting as it is. */
  peekDuty(p: PadRef, interval: number): number | null {
    // CLKOUT is FOSC/4, high for half of each instruction cycle (Figure 14-15).
    if (p.port === 0 && p.pin === 6 && this.clockOut(p) !== null) return 0.5
    const d = this.duty.get(p.port * 16 + p.pin)
    if (!d) return null
    const high = d.level ? d.high + (this.now - d.since) : d.high
    return interval > 0 ? Math.min(1, high / interval) : d.level ? 1 : 0
  }
  /** Fraction of the last `interval` a PWM-driven pad was high; null when nothing drives it that way. */
  takeDuty(p: PadRef, interval: number): number | null {
    if (p.port === 0 && p.pin === 6 && this.clockOut(p) !== null) return 0.5
    const d = this.duty.get(p.port * 16 + p.pin)
    if (!d) return null
    const now = this.now
    if (d.level) d.high += now - d.since
    d.since = now
    const v = interval > 0 ? Math.min(1, d.high / interval) : d.level ? 1 : 0
    d.high = 0
    return v
  }

  /**
   * Typical supply current, A (decision D45): awake, D012A (INTOSC 4 MHz) by VDD, scaled with FOSC as
   * CMOS switching current is; asleep, IPD (D020) plus the WDT (D021) and BOR (D022) when they run.
   */
  supplyCurrent(asleep: number): number {
    const e = this.chip.electrical
    const active = byVdd(e.iddIntosc, this.vdd) * (this.fosc / 4e6)
    let sleeping = byVdd(e.ipd, this.vdd)
    if (this.config & 0x04) sleeping += byVdd(e.iwdt, this.vdd)
    if (this.config & 0x40) sleeping += e.ibor
    if (this.inReset || !this.running) return active
    return active * (1 - asleep) + sleeping * asleep
  }

  /** The clock for the inspector: the FOSC mode and what feeds it. */
  clockLabel(): string {
    const slow = !(this.pcon & 0x08)
    switch (this.oscMode) {
      case "INTOSC":
        return `internal ${slow ? `${this.chip.electrical.intoscSlow / 1e3} kHz` : "4 MHz"}`
      case "RC":
        return this.chip.rcKind === "ER" ? (slow ? `ER, slow ${this.chip.electrical.intoscSlow / 1e3} kHz` : "ER (resistor on RA7)") : "RC (REXT/CEXT on RA7)"
      case "EC":
        return "external clock on RA7/CLKIN"
      default:
        return `${this.oscMode} ${this.clockFeed?.kind === "clock" ? "(clock into OSC1)" : "crystal"}`
    }
  }

  /**
   * Input thresholds of a pad, V (D030–D041, decision D44): PORTA and the PORTB alternate inputs in use
   * are Schmitt triggers (0.2/0.8 VDD), the PORTB port inputs TTL (0.8/2.0 V at 4.5–5.5 V, else
   * 0.15 VDD / 0.25 VDD + 0.8 V) — the guaranteed VIL max and VIH min; a level between keeps the last.
   */
  inputThresholds(p: PadRef, vdd: number): { high: number; low: number } {
    const e = this.chip.electrical
    const st = { high: e.schmittOfVdd.vih * vdd, low: e.schmittOfVdd.vil * vdd }
    if (p.port === 0) return st
    const schmitt =
      (p.pin === 0 && (this.intcon & 0x10) !== 0) ||
      ((p.pin === 1 || p.pin === 2) && this.usart.spen) ||
      (p.pin === 3 && this.ccp.capture) ||
      (p.pin === 6 && (this.timer1.t1con & 0x0a) === 0x02) ||
      (p.pin === 4 && this.lvp)
    if (schmitt) return st
    return vdd >= 4.5 && vdd <= 5.5 ? { high: e.ttl.vih, low: e.ttl.vil } : { high: 0.25 * vdd + 0.8, low: 0.15 * vdd }
  }

  /** The crystal on RB7/T1OSI–RB6/T1OSO, from the circuit. */
  setT1Oscillator(o: T1Oscillator) {
    // The A part's Timer1 oscillator is rated for 32.768 kHz, the original's up to 200 kHz (Ft1; decision D42).
    if (o?.kind === "crystal") {
      const off = this.chip.revisionA ? Math.abs(o.hz - 32768) > 32768 * 0.01 : o.hz > 200e3
      if (off)
        this.feature(
          `Timer1 crystal ${+(o.hz / 1e3).toFixed(3)} kHz: the ${this.chip.name}'s Timer1 oscillator is rated for ${this.chip.revisionA ? "32.768 kHz" : "up to 200 kHz"} (Ft1; decision D42) — it runs at the crystal's frequency`,
        )
    }
    this.timer1.setOscillator(o)
    this.reschedule()
  }
  /** The voltage the circuit puts on a pad (comparator inputs); the comparators re-evaluate. */
  setAnalog(p: PadRef, volts: number) {
    if (p.port !== 0) return
    if (this.analog.get(p.pin) === volts) return
    this.analog.set(p.pin, volts)
    if (p.pin < 4) this.comparators.evaluate(this.cpu.cycles)
  }
  /** VREF, V, and what RA2 sees when it is put out (§11). */
  vrefVolts(): number {
    return this.comparators.vref()
  }
  vrefOutput(): { volts: number; ohms: number } | null {
    const c = this.comparators
    if (!c.outputOn || !(this.porta.tris & 0x04)) return null
    return { volts: c.vref(), ohms: c.vrefOhms() }
  }
  /** CCP1's output latch (compare/PWM), before the pin's TRIS gate. */
  get ccpOutput() {
    return this.ccp.output
  }

  // --- inspection --------------------------------------------------------------------------------

  /** A file register without side effects. */
  peekFile(a: number): number {
    return this.cpu.peek(a)
  }
  /** Store as a raw write (tests). */
  pokeFile(a: number, v: number) {
    this.cpu.at = this.cpu.cycles
    this.cpu.poke(a, v)
  }
  /** Read as the core would, side effects included (tests). */
  readFile(a: number): number {
    this.cpu.at = this.cpu.cycles
    return this.cpu.read(a)
  }
  get mclrVoltage() {
    return this.mclrVolts
  }
}
