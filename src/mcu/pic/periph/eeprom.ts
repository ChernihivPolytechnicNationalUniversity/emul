/**
 * The data EEPROM (DS40044G §13, DS33023A §7; checklist P3-171…P3-206, P8-088…P8-101, decisions
 * D33–D37): EEADR/EEDATA, EECON1 (WRERR, WREN, WR, RD) and the unlock register EECON2.
 *
 * A read is immediate (the byte is in EEDATA for the next instruction). A write needs WREN and the
 * exact unlock — 55h then AAh into EECON2, then WR, on consecutive cycles (D35) — latches the address
 * and data, and takes TDEW on the module's own timer (Sleep included), then clears WR and sets EEIF.
 * A reset or a supply outside D121 during the write leaves the byte half-done (D36).
 */
import { Peripheral, type PicBus } from "../io"

export interface EepromHost {
  readonly cells: Uint8Array
  readonly vdd: number
  readonly vddMin: number
  /** TDEW, s, and the per-byte endurance (D122, D120). */
  readonly writeTime: number
  readonly endurance: number
  setEeif(cycle: number): void
}

type Write = { addr: number; data: number; start: number; end: number; lowVdd: boolean }

export class DataEeprom extends Peripheral {
  readonly name = "Data EEPROM"
  override readonly domain = "own" as const
  private readonly host: EepromHost
  eedata = 0
  eeadr = 0
  private wren = false
  private wrerr = false
  private writing: Write | null = null
  /** A write cut short by a reset: WRERR on the reset that follows (D34). */
  private cut = false
  /** The unlock sequence: the cycle 55h was written, then the cycle AAh was (D35). */
  private unlock55 = -Infinity
  private unlockAA = -Infinity
  /** E/W cycles per byte (D37). */
  readonly wear: Uint32Array

  constructor(bus: PicBus, host: EepromHost) {
    super(bus)
    this.host = host
    this.wear = new Uint32Array(host.cells.length)
  }

  /** The cell EEADR selects: the 128-byte parts ignore bit 7 (D33). */
  private cell(): number {
    const n = this.host.cells.length
    if (this.eeadr >= n) this.bus.feature(`EEADR ${hex(this.eeadr)} past the ${n}-byte data EEPROM: bit 7 is taken as not decoded, the access reaches ${hex(this.eeadr & (n - 1))} (decision D33)`)
    return this.eeadr & (n - 1)
  }

  readEecon1() {
    return (this.wrerr ? 0x08 : 0) | (this.wren ? 0x04 : 0) | (this.writing ? 0x02 : 0)
  }
  writeEecon1(v: number) {
    const c = Math.floor(this.now)
    this.wrerr = (v & 0x08) !== 0
    this.wren = (v & 0x04) !== 0
    // RD and WR can only be set; hardware clears them (P3-184).
    if (v & 0x01) this.eedata = this.host.cells[this.cell()]
    const unlocked = this.unlockAA === this.unlock55 + 2 && c === this.unlockAA + 1
    this.unlock55 = this.unlockAA = -Infinity
    if (v & 0x02 && !this.writing && this.wren && unlocked) this.start()
  }
  writeEecon2(v: number) {
    const c = Math.floor(this.now)
    if (v === 0x55) {
      this.unlock55 = c
      this.unlockAA = -Infinity
    } else if (v === 0xaa && c === this.unlock55 + 2) this.unlockAA = c
    else this.unlock55 = this.unlockAA = -Infinity
  }

  private start() {
    const t = this.bus.cycleTime(this.now)
    const addr = this.cell()
    this.writing = { addr, data: this.eedata, start: t, end: t + this.host.writeTime, lowVdd: this.host.vdd < this.host.vddMin }
    if (++this.wear[addr] > this.host.endurance)
      this.bus.feature(`data EEPROM byte ${hex(addr)} written past its D120 endurance (${this.host.endurance} E/W cycles): it still holds, real cells start to fail (decision D37)`)
    this.plan()
    this.bus.reschedule()
  }
  private plan() {
    this.due = this.writing ? Math.max(this.bus.cpu.cycles, Math.ceil(this.bus.timeCycle(this.writing.end) - 1e-9)) : Infinity
  }
  /** The byte a write leaves when it is cut at time t (D36). */
  private halfDone(w: Write, t: number) {
    const old = this.host.cells[w.addr]
    const r = Math.floor(this.bus.random() * 256)
    return t - w.start < (w.end - w.start) / 2 ? old | r : w.data | (r & ~w.data & 0xff)
  }

  service(cycle: number) {
    const w = this.writing
    if (!w || this.bus.cycleTime(cycle) < w.end - 1e-12) return this.plan()
    this.writing = null
    if (w.lowVdd || this.host.vdd < this.host.vddMin) {
      this.host.cells[w.addr] = this.halfDone(w, w.start + (w.end - w.start) * this.bus.random())
      this.bus.feature(`data EEPROM write with VDD under ${this.host.vddMin} V (D121 VDRW): the byte is left half-done (decision D36)`)
    } else this.host.cells[w.addr] = w.data
    this.wrerr = false
    this.host.setEeif(cycle)
    this.plan()
  }
  clockChanged() {
    this.plan()
  }

  /** A reset (or power loss) takes hold at simulated time t: a write under way is cut (D34, D36). */
  interrupt(t: number) {
    const w = this.writing
    if (!w) return
    if (t >= w.end) {
      // It had finished before the reset took hold; its completion event just had not run.
      this.service(Math.ceil(this.bus.timeCycle(w.end)))
      return
    }
    this.host.cells[w.addr] = this.halfDone(w, t)
    this.writing = null
    this.cut = true
    this.due = Infinity
  }

  /** EECON1 ---- x000 on POR, ---- q000 on the other resets (Table 13-1); EEDATA/EEADR xxxx xxxx / uuuu uuuu. */
  reset(por: boolean) {
    this.wren = false
    this.writing = null
    this.unlock55 = this.unlockAA = -Infinity
    if (por) {
      this.wrerr = this.bus.random() < 0.5
      this.eedata = Math.floor(this.bus.random() * 256)
      this.eeadr = Math.floor(this.bus.random() * 256)
    } else if (this.cut) this.wrerr = true
    this.cut = false
    this.due = Infinity
  }
}

const hex = (v: number) => `${v.toString(16).padStart(2, "0").toUpperCase()}h`
