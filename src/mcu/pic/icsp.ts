/**
 * The programming module of the PIC16F627A/628A/648A in Program/Verify mode (DS41196G; checklist
 * P7-001…P7-143, decisions D48–D56): 6-bit commands and 16-bit data words clocked on RB6/CLOCK, LSb
 * first, taken at the falling edges; reads driven out on RB7/DATA from the rising edges. A 14-bit PC
 * over program memory (0000h–1FFFh, wrapping at the implemented end) and configuration memory
 * (2000h–3FFFh, wrapping to 2000h), the low bits of which address the data EEPROM.
 *
 * Programming only clears bits in flash and the configuration word (a bulk erase sets them); a data
 * EEPROM byte is erased and written by its own cycle. Cycle times run in simulated seconds; a command
 * that arrives during one is ignored and reported.
 */
import type { PicProfile } from "./chip"

export interface IcspHost {
  readonly chip: PicProfile
  readonly flash: Uint16Array
  readonly ids: Uint16Array
  readonly eeprom: Uint8Array
  config: number
  readonly vdd: number
  readonly time: number
  readonly entry: "high-voltage" | "low-voltage" | null
  feature(what: string): void
  random(): number
  /** Program memory changed: decoded instructions are stale. */
  flashChanged(): void
  /** DATA's drive changed. */
  dataChanged(): void
}

const C = { loadConfig: 0x00, loadProg: 0x02, loadData: 0x03, readProg: 0x04, readData: 0x05, inc: 0x06, program: 0x08, eraseProg: 0x09, eraseData: 0x0b }
/** Commands followed by a 16-bit data word (Table 2-3). */
const WITH_DATA = new Set([C.loadConfig, C.loadProg, C.loadData, C.readProg, C.readData])
/** Typical cycle times, s (D51): a flash word D133A, a data EEPROM byte D122, a bulk erase D133. */
const T_WORD = 2e-3
const T_BYTE = 4e-3
const T_ERASE = 4e-3
const hex = (v: number, n = 2) => `${v.toString(16).toUpperCase().padStart(n, "0")}h`

export class Icsp {
  private readonly host: IcspHost
  pc = 0
  /** The reserved cells 2004h/2005h and 2008h–200Fh (D53). */
  private readonly reserved = new Uint16Array(16).fill(0x3fff)
  private phase: "cmd" | "data" = "cmd"
  private bits = 0
  private shift = 0
  /** The command whose data phase is running; `ignored` when it came during a cycle. */
  private cmd = -1
  private ignored = false
  private rises = 0
  private readWord = 0
  private latch: { word: number; kind: "prog" | "data" } | null = null
  private busyUntil = -Infinity
  /** DATA as an output (Read Data, D49). */
  driving = false
  out = false

  constructor(host: IcspHost) {
    this.host = host
  }
  private get flashMask() {
    return this.host.chip.flashWords - 1
  }
  private get cp() {
    return (this.host.config & 0x2000) === 0
  }
  private get cpd() {
    return (this.host.config & 0x0100) === 0
  }
  /** E-001: the 627A/628A cannot reach the data EEPROM in low-voltage programming (D56). */
  private get dataBlocked() {
    const blocked = this.host.entry === "low-voltage" && this.host.chip.flashWords <= 2048 && this.host.chip.revisionA
    if (blocked) this.host.feature("ICSP data EEPROM access in low-voltage programming: not possible on the PIC16F627A/628A (errata E-001; decision D56)")
    return blocked
  }

  /** Program/Verify entered: PC = 0, the serial logic at the start of a command (P7-052). */
  enter() {
    this.pc = 0
    this.phase = "cmd"
    this.bits = this.shift = 0
    this.latch = null
    this.busyUntil = -Infinity
    this.setDrive(false, false)
  }
  /** An edge on RB4/PGM with the LVP bit set resets the PC (P7-054; D56). */
  pgmEdge() {
    this.pc = 0
    this.host.feature("RB4/PGM toggled during Program/Verify with the LVP bit set: the PC went back to 0 (DS41196G §2.4; decision D56)")
  }

  /** CLOCK (RB6) changed; `data` is DATA (RB7) now. */
  clock(rising: boolean, data: boolean) {
    if (rising) {
      if (this.phase !== "data" || this.ignored || (this.cmd !== C.readProg && this.cmd !== C.readData)) return
      const k = ++this.rises
      // Bit k of the frame (start, 14 bits, stop) at the k-th rising edge; driven from the 2nd (D49).
      if (k >= 2 && k <= 16) this.setDrive(true, k <= 15 ? ((this.readWord >> (k - 2)) & 1) === 1 : false)
      return
    }
    if (this.phase === "cmd") {
      if (data) this.shift |= 1 << this.bits
      if (++this.bits < 6) return
      const code = this.shift
      this.bits = this.shift = 0
      this.decode(code)
      return
    }
    if (data) this.shift |= 1 << this.bits
    if (++this.bits < 16) return
    const frame = this.shift
    this.bits = this.shift = 0
    this.phase = "cmd"
    this.setDrive(false, this.out)
    if (!this.ignored) this.dataDone(frame)
  }

  private setDrive(on: boolean, level: boolean) {
    if (on === this.driving && level === this.out) return
    this.driving = on
    this.out = level
    this.host.dataChanged()
  }

  private decode(code: number) {
    const c = code & 0x0f
    const known = c === C.program ? (code & 0x10) === 0 : [C.loadConfig, C.loadProg, C.loadData, C.readProg, C.readData, C.inc, C.eraseProg, C.eraseData].includes(c)
    if (!known) {
      this.host.feature(`ICSP command ${hex(code)}: not defined in DS41196G Table 2-3, ignored (decision D50)`)
      return
    }
    const busy = this.host.time < this.busyUntil
    if (busy) this.host.feature(`ICSP command ${hex(code)} while a programming or erase cycle is still running: ignored (TPROG/TDPROG/TERA, decision D50)`)
    if (WITH_DATA.has(c)) {
      this.phase = "data"
      this.cmd = c
      this.ignored = busy
      this.rises = 0
      if (!busy && c === C.readProg) this.readWord = this.readProg()
      if (!busy && c === C.readData) this.readWord = this.readData()
      return
    }
    if (busy) return
    if (c === C.inc) this.pc = this.pc < 0x2000 ? (this.pc + 1) & this.flashMask : 0x2000 + ((this.pc + 1 - 0x2000) & 0x1fff)
    else if (c === C.program) this.program()
    else if (c === C.eraseProg) this.eraseProgram()
    else if (c === C.eraseData) this.eraseData()
  }

  private dataDone(frame: number) {
    const word = (frame >> 1) & 0x3fff
    switch (this.cmd) {
      case C.loadConfig:
        this.pc = 0x2000
        this.latch = { word, kind: "prog" }
        break
      case C.loadProg:
        this.latch = { word, kind: "prog" }
        break
      case C.loadData:
        this.latch = { word: word & 0xff, kind: "data" }
        break
    }
  }

  // --- the memories as the PC sees them (D53, D54) --------------------------------------------------

  private readProg(): number {
    const pc = this.pc
    if (pc >= 0x2000 && pc < 0x2010) {
      const off = pc - 0x2000
      if (off < 4) return this.host.ids[off]
      if (off === 6) return this.host.chip.deviceId
      if (off === 7) return this.host.config
      return this.reserved[off]
    }
    // Past 200Fh the configuration space reaches program memory (§2.1).
    return this.cp ? 0 : this.host.flash[pc & this.flashMask]
  }
  private readData(): number {
    if (this.dataBlocked || this.cpd) return 0
    return this.host.eeprom[this.pc & (this.host.eeprom.length - 1)]
  }

  /** Begin Programming Only Cycle (§2.4.4; D52, D55). */
  private program() {
    const latch = this.latch
    if (!latch) {
      this.host.feature("ICSP Begin Programming without a Load since the last cycle: nothing written (DS41196G §2.4.4; decision D52)")
      return
    }
    this.latch = null
    const vdd = this.host.vdd
    if (latch.kind === "data") {
      this.busyUntil = this.host.time + T_BYTE
      if (this.dataBlocked) return
      if (this.cpd) {
        this.host.feature("ICSP data EEPROM write with CPD on: not written (decision D54)")
        return
      }
      const a = this.pc & (this.host.eeprom.length - 1)
      if (vdd < 2.0) this.host.feature(`ICSP data EEPROM write at VDD ${vdd.toFixed(2)} V, under 2.0 V (Table 4-1): left half-done (decision D55)`)
      this.host.eeprom[a] = vdd < 2.0 ? latch.word | (Math.floor(this.host.random() * 256) & ~latch.word & 0xff) : latch.word
      return
    }
    this.busyUntil = this.host.time + T_WORD
    const pc = this.pc
    const write = (old: number) => {
      const target = old & latch.word
      // E-002: the 627A/628A write flash only at 4.5–5.5 V; any part under the 2.0 V of Table 4-1.
      const min = this.host.chip.flashWords <= 2048 ? 4.5 : 2.0
      if (vdd >= min) return target
      this.host.feature(`ICSP flash word written at VDD ${vdd.toFixed(2)} V, under ${min} V (${min === 4.5 ? "errata E-002" : "DS41196G Table 4-1"}): left half-done (decision D55)`)
      return target | (Math.floor(this.host.random() * 0x4000) & old & ~target)
    }
    if (pc >= 0x2000 && pc < 0x2010) {
      const off = pc - 0x2000
      if (off < 4) this.host.ids[off] = write(this.host.ids[off])
      else if (off === 7) this.host.config = write(this.host.config)
      else if (off !== 6) this.reserved[off] = write(this.reserved[off])
      return
    }
    if (this.cp) {
      this.host.feature("ICSP program memory write with CP on: not written (decision D54)")
      return
    }
    const a = pc & this.flashMask
    this.host.flash[a] = write(this.host.flash[a])
    this.host.flashChanged()
  }

  /** Bulk Erase Program Memory by Table 3-1 (D52, D55). */
  private eraseProgram() {
    this.busyUntil = this.host.time + T_ERASE
    const low = this.host.vdd < 4.5
    if (low) this.host.feature(`ICSP bulk erase at VDD ${this.host.vdd.toFixed(2)} V: needs 4.5–5.5 V (Table 4-1, errata E-003); left half-done (decision D55)`)
    const erase = (old: number, bits: number) => (low ? old | (Math.floor(this.host.random() * (bits + 1)) & bits) : bits)
    const cpdOn = this.cpd
    const inConfig = this.pc >= 0x2000
    for (let i = 0; i < this.host.flash.length; i++) this.host.flash[i] = erase(this.host.flash[i], 0x3fff)
    this.host.config = erase(this.host.config, 0x3fff)
    if (inConfig) {
      for (let i = 0; i < 4; i++) this.host.ids[i] = erase(this.host.ids[i], 0x3fff)
      for (let i = 0; i < 16; i++) this.reserved[i] = erase(this.reserved[i], 0x3fff)
    }
    if (cpdOn) for (let i = 0; i < this.host.eeprom.length; i++) this.host.eeprom[i] = erase(this.host.eeprom[i], 0xff)
    this.host.flashChanged()
  }
  /** Bulk Erase Data Memory (§3.2). */
  private eraseData() {
    this.busyUntil = this.host.time + T_ERASE
    if (this.dataBlocked) return
    const low = this.host.vdd < 4.5
    if (low) this.host.feature(`ICSP bulk erase at VDD ${this.host.vdd.toFixed(2)} V: needs 4.5–5.5 V (Table 4-1); left half-done (decision D55)`)
    for (let i = 0; i < this.host.eeprom.length; i++) this.host.eeprom[i] = low ? this.host.eeprom[i] | Math.floor(this.host.random() * 256) : 0xff
  }
}
