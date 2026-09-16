/**
 * The F7 I²C register map (v2: CR2 NBYTES/AUTOEND, ISR/ICR, TXDR/RXDR, TIMINGR), driven at
 * register level the way RM0385 §30.4 describes the master sequences, against the 24C02
 * model over a wired-AND bus. No F7 HAL is available locally, so this stands in for it.
 *
 *   pnpm mcu-i2c-v2
 */
import { I2c, I2C_SPECS } from "@/mcu/periph/i2c"
import { Eeprom24 } from "@/sim/digital"

const HCLK = 216e6
const PCLK = 54e6
const i2c = new I2c(I2C_SPECS[0], "v2")
i2c.setClock(PCLK, HCLK)
const eeprom = new Eeprom24("U2", { value: "24C02" })

let failed = 0
let total = 0
const expect = (what: string, got: number | string, want: number | string, tol = 0) => {
  total++
  const ok = typeof got === "number" && typeof want === "number" ? Math.abs(got - want) <= tol : got === want
  if (!ok) failed++
  const fmt = (v: number | string) => (typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toPrecision(5)) : JSON.stringify(v))
  console.log(`  ${ok ? "✓" : "✗"} ${what.padEnd(44)} ${fmt(got).padStart(14)}  expected ${fmt(want)}${tol ? ` ±${tol}` : ""}`)
}

// --- the bus -------------------------------------------------------------------------------
let cycles = 0
const now = () => cycles / HCLK
const drive = { scl: true, sda: true, mem: null as boolean | null }
const level = { scl: true, sda: true }
const sclRises: number[] = []
let starts = 0
let stops = 0
i2c.onOut = (line, lvl) => {
  if (line === "SCL") drive.scl = lvl
  else drive.sda = lvl
  resolve()
}
function resolve() {
  for (;;) {
    const scl = drive.scl
    const sda = drive.sda && drive.mem !== false
    if (scl !== level.scl) {
      level.scl = scl
      if (scl) sclRises.push(now())
      i2c.pinEdge("SCL", scl)
      eeprom.input("SCL", scl, now())
      drain()
    } else if (sda !== level.sda) {
      if (level.scl) {
        if (sda) stops++
        else starts++
      }
      level.sda = sda
      i2c.pinEdge("SDA", sda)
      eeprom.input("SDA", sda, now())
      drain()
    } else return
  }
}
function drain() {
  while (eeprom.out.length) {
    const e = eeprom.out.shift()!
    if (e.pin === "SDA") drive.mem = e.level
    resolve()
  }
}
/** Advance until `cond` holds or `seconds` pass; the block is ticked at its own events. */
function until(cond: () => boolean, seconds = 2e-3): boolean {
  const end = cycles + seconds * HCLK
  while (cycles < end) {
    if (cond()) return true
    const step = Math.min(i2c.cyclesUntilEvent(), 50)
    cycles += step
    i2c.tick(step)
  }
  return cond()
}

// --- register access -----------------------------------------------------------------------
const R = { CR1: 0x00, CR2: 0x04, TIMINGR: 0x10, ISR: 0x18, ICR: 0x1c, RXDR: 0x24, TXDR: 0x28 }
const wr = (off: number, v: number) => i2c.write(off, v >>> 0, 4)
const rd = (off: number) => i2c.read(off, 4)
const ISR = { TXIS: 1 << 1, RXNE: 1 << 2, NACKF: 1 << 4, STOPF: 1 << 5, TC: 1 << 6, BUSY: 1 << 15 }
const CR2 = { RD_WRN: 1 << 10, START: 1 << 13, STOP: 1 << 14, AUTOEND: 1 << 25 }
const sadd = (addr7: number) => addr7 << 1
const nbytes = (n: number) => n << 16

// 100 kHz from 54 MHz: PRESC 0xB (÷12 → 4.5 MHz, 222 ns), SCLL 0x13 (20 × 222 = 4.4 µs), SCLH 0xF (16 → 3.6 µs); CubeMX's value.
wr(R.TIMINGR, 0xb0420f13)
wr(R.CR1, 1)

console.log("Master write: word address + 2 bytes, AUTOEND")
wr(R.CR2, sadd(0x50) | nbytes(3) | CR2.AUTOEND | CR2.START)
expect("BUSY once START is requested", until(() => (rd(R.ISR) & ISR.BUSY) !== 0) ? "yes" : "no", "yes")
for (const b of [0x10, 0x41, 0x42]) {
  expect(`TXIS before byte 0x${b.toString(16)}`, until(() => (rd(R.ISR) & ISR.TXIS) !== 0) ? "yes" : "no", "yes")
  wr(R.TXDR, b)
}
expect("STOPF after the last byte (AUTOEND)", until(() => (rd(R.ISR) & ISR.STOPF) !== 0) ? "yes" : "no", "yes")
wr(R.ICR, ISR.STOPF)
expect("no NACK", rd(R.ISR) & ISR.NACKF, 0)
expect("bus released", until(() => (rd(R.ISR) & ISR.BUSY) === 0, 1e-4) ? "yes" : "no", "yes")
cycles += 6e-3 * HCLK // the EEPROM's write cycle
expect("EEPROM took 'A','B' at 0x10", String.fromCharCode(...eeprom.snapshot().bytes.slice(0x10, 0x12)), "AB")
const period = sclRises.length > 12 ? (sclRises[11] - sclRises[2]) / 9 : 0
// (SCLL+1 + SCLH+1) × 222 ns = 8 µs; the remaining 2 µs of a real 100 kHz bus are the pull-up
// rise times, which the digital path does not model.
expect("SCL period from TIMINGR (µs)", period * 1e6, 8, 0.5)

console.log("\nMaster read: word address, repeated START, 2 bytes")
wr(R.CR2, sadd(0x50) | nbytes(1) | CR2.START)
expect("TXIS for the word address", until(() => (rd(R.ISR) & ISR.TXIS) !== 0) ? "yes" : "no", "yes")
wr(R.TXDR, 0x10)
expect("TC: transfer complete, clock stretched", until(() => (rd(R.ISR) & ISR.TC) !== 0) ? "yes" : "no", "yes")
const startsBefore = starts
wr(R.CR2, sadd(0x50) | CR2.RD_WRN | nbytes(2) | CR2.AUTOEND | CR2.START)
const got: number[] = []
for (let i = 0; i < 2; i++) {
  expect(`RXNE for byte ${i}`, until(() => (rd(R.ISR) & ISR.RXNE) !== 0) ? "yes" : "no", "yes")
  got.push(rd(R.RXDR))
}
expect("a repeated START was generated", starts - startsBefore, 1)
expect("read back 'A','B'", String.fromCharCode(...got), "AB")
expect("STOPF after AUTOEND", until(() => (rd(R.ISR) & ISR.STOPF) !== 0) ? "yes" : "no", "yes")
wr(R.ICR, ISR.STOPF)

console.log("\nNo such device: NACKF and an automatic STOP")
wr(R.CR2, sadd(0x51) | nbytes(1) | CR2.AUTOEND | CR2.START)
expect("NACKF", until(() => (rd(R.ISR) & ISR.NACKF) !== 0) ? "yes" : "no", "yes")
expect("STOPF too", until(() => (rd(R.ISR) & ISR.STOPF) !== 0) ? "yes" : "no", "yes")
wr(R.ICR, ISR.NACKF | ISR.STOPF)
expect("ISR clear again", rd(R.ISR) & (ISR.NACKF | ISR.STOPF), 0)
console.log(`\n${starts} STARTs, ${stops} STOPs, ${(cycles / HCLK * 1e3).toFixed(2)} ms of bus time`)
console.log(`${total - failed}/${total}`)
process.exit(failed ? 1 : 0)
