/**
 * LIS302DL (ST DS Rev 4, Oct 2008) and LIS3DSH (ST DocID022405 Rev 2, Oct 2015) as the
 * STM32F4-Discovery wires them: 4-wire SPI on SPI1, CS on PE3, INT1/INT2 on PE0/PE1.
 * Expected values come from the datasheets (section / table in each test name); where the
 * datasheet is silent the test pins the decision documented in src/sim/lis-accel.ts.
 */
import { describe, expect, it } from "vitest"
import { LisAccelerometer, NOT_MODELLED, type LisVariant } from "@/sim/lis-accel"

const PINS = { cs: "CS", sck: "SCK", mosi: "MOSI", miso: "MISO", int1: "INT1", int2: "INT2" }
const HALF = 0.5e-6 // 1 MHz SCK

function bench(variant: LisVariant) {
  const c = new LisAccelerometer("u5", PINS, variant)
  let t = 0
  c.input("CS", true, t)
  c.input("SCK", true, t) // CPOL = 1: SCK idles high
  c.input("MOSI", false, t)
  /** Command byte then data bytes in one CS-low frame, mode 3; returns what MISO carried per byte (null bits as -1 bytes). */
  const frame = (bytes: number[], misoBits?: (boolean | null)[]) => {
    const got: number[] = []
    c.input("CS", false, (t += HALF))
    for (const byte of bytes) {
      let v = 0
      for (let b = 7; b >= 0; b--) {
        c.input("SCK", false, (t += HALF)) // slave shifts MISO on the falling edge
        c.input("MOSI", ((byte >>> b) & 1) === 1, t)
        const m = c.drive("MISO") // master samples on the rising edge
        misoBits?.push(m)
        c.input("SCK", true, (t += HALF))
        v = (v << 1) | (m ? 1 : 0)
      }
      got.push(v)
    }
    c.input("CS", true, (t += HALF))
    return got
  }
  const read = (addr: number) => frame([0x80 | addr, 0])[1]
  const write = (addr: number, value: number) => frame([addr, value])
  /** Let `s` seconds of loop time pass, ticking as the loop does every 10 µs-ish (coarser here: every 100 µs). */
  const wait = (s: number) => {
    const end = t + s
    while (t < end) c.tick((t = Math.min(end, t + 100e-6)))
  }
  const int1 = () => c.drive("INT1")
  const int2 = () => c.drive("INT2")
  return { c, frame, read, write, wait, int1, int2, now: () => t }
}

const s8 = (v: number) => (v << 24) >> 24
const s16 = (lo: number, hi: number) => (((hi << 8) | lo) << 16) >> 16

describe.each(["lis302dl", "lis3dsh"] as const)("%s common SPI behaviour", (variant) => {
  it("releases MISO while CS is high and during the command byte; drives it from bit 8 of a read (§5.2)", () => {
    const k = bench(variant)
    expect(k.c.drive("MISO"), "CS high").toBeNull()
    const bits: (boolean | null)[] = []
    k.frame([0x8f, 0], bits)
    expect(bits.slice(0, 8).every((b) => b === null), "bits 0–7 Hi-Z").toBe(true)
    expect(bits.slice(8).every((b) => b !== null), "bits 8–15 driven").toBe(true)
    expect(k.c.drive("MISO"), "after CS rises").toBeNull()
  })

  it("keeps MISO released during a write (§5.2.2)", () => {
    const k = bench(variant)
    const bits: (boolean | null)[] = []
    k.frame([0x20, 0x47], bits)
    expect(bits.every((b) => b === null)).toBe(true)
  })

  it("answers WHO_AM_I (LIS302DL §7.1 0x3B, LIS3DSH Table 18 0x3F)", () => {
    expect(bench(variant).read(0x0f)).toBe(variant === "lis302dl" ? 0x3b : 0x3f)
  })

  it("powers up in power-down: no data, STATUS 0 however long it waits (LIS302DL §7.2 PD=0, LIS3DSH Table 23 ODR=0000)", () => {
    const k = bench(variant)
    k.wait(0.1)
    expect(k.read(0x27)).toBe(0)
  })

  it("ignores a partial byte cut short by CS", () => {
    const k = bench(variant)
    const ctrl = variant === "lis302dl" ? 0x20 : 0x20
    // command + 5 bits only
    k.c.input("CS", false, k.now() + 1e-6)
    for (const bit of [0, 0, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1]) {
      k.c.input("SCK", false, k.now() + 2e-6)
      k.c.input("MOSI", bit === 1, k.now() + 2e-6)
      k.c.input("SCK", true, k.now() + 3e-6)
    }
    k.c.input("CS", true, k.now() + 4e-6)
    k.wait(1e-5)
    expect(k.read(ctrl)).toBe(0x07)
  })

  it("lists what it does not model", () => {
    expect(NOT_MODELLED.length).toBeGreaterThan(3)
    expect(NOT_MODELLED.every((s) => typeof s === "string" && s.length > 0)).toBe(true)
  })
})

describe("LIS302DL", () => {
  const ON = 0x47 // DR=0 100 Hz, PD=1, FS=0, Zen Yen Xen (what ST's BSP LIS302DL_Init writes for ±2.3 g)

  it("has the Table 16 reset values", () => {
    const k = bench("lis302dl")
    const expected: [number, number][] = [[0x20, 0x07], [0x21, 0], [0x22, 0], [0x27, 0], [0x30, 0], [0x31, 0], [0x32, 0], [0x33, 0], [0x34, 0], [0x38, 0], [0x39, 0], [0x3f, 0]]
    for (const [a, v] of expected) expect.soft(k.read(a), `0x${a.toString(16)}`).toBe(v)
  })

  it("round-trips rw registers and ignores writes to read-only ones (Table 16)", () => {
    const k = bench("lis302dl")
    k.write(0x33, 0x5a)
    k.write(0x0f, 0x00)
    k.write(0x27, 0xff)
    expect(k.read(0x33)).toBe(0x5a)
    expect(k.read(0x0f)).toBe(0x3b)
    expect(k.read(0x27)).toBe(0)
  })

  it("MS=1 increments the address, MS=0 repeats it (§5.2, bit 1 of the command)", () => {
    const k = bench("lis302dl")
    k.write(0x3d, 0x11)
    k.write(0x3e, 0x22)
    expect(k.frame([0xc0 | 0x3d, 0, 0]).slice(1)).toEqual([0x11, 0x22])
    expect(k.frame([0x80 | 0x3d, 0, 0]).slice(1)).toEqual([0x11, 0x11])
    k.frame([0x40 | 0x3b, 0xa1, 0xa2])
    expect(k.read(0x3b)).toBe(0xa1)
    expect(k.read(0x3c)).toBe(0xa2)
  })

  it("produces the first sample 3/ODR after PD is set (Table 4 note 5), then every 1/ODR", () => {
    const k = bench("lis302dl")
    k.write(0x20, ON)
    k.wait(0.029)
    expect(k.read(0x27) & 0x08, "before 30 ms").toBe(0)
    k.wait(0.002)
    expect(k.read(0x27), "ZYXDA ZDA YDA XDA").toBe(0x0f)
  })

  it("reads 1 g on Z flat on a desk at 18 mg/digit, ±2 g (Table 3, §2.5.2 two's complement)", () => {
    const k = bench("lis302dl")
    k.write(0x20, ON)
    k.wait(0.031)
    // ST's BSP LIS302DL_ReadACC: 6 bytes from OUT_X with RW|MS, keeps buffer[0], [2], [4]
    const b = k.frame([0xc0 | 0x29, 0, 0, 0, 0, 0, 0]).slice(1)
    expect([s8(b[0]), s8(b[2]), s8(b[4])]).toEqual([0, 0, 56])
    expect([b[1], b[3], b[5]], "the Not Used addresses read 0").toEqual([0, 0, 0])
  })

  it("scales by 72 mg/digit at FS=1 and saturates at the 8-bit limits (Table 3)", () => {
    const k = bench("lis302dl")
    k.c.setAcceleration({ x: -1, y: 5, z: 20 })
    k.write(0x20, ON | 0x20)
    k.wait(0.031)
    expect([s8(k.read(0x29)), s8(k.read(0x2b)), s8(k.read(0x2d))]).toEqual([-14, 69, 127])
    k.write(0x20, ON)
    k.wait(0.011)
    expect([s8(k.read(0x29)), s8(k.read(0x2b))]).toEqual([-56, 127])
    k.c.setAcceleration({ x: -9, y: 0, z: 0 })
    k.wait(0.011)
    expect(s8(k.read(0x29))).toBe(-128)
  })

  it("runs at 400 Hz with DR=1 (§7.2)", () => {
    const k = bench("lis302dl")
    k.write(0x20, ON | 0x80)
    k.wait(3 / 400 + 1e-4)
    expect(k.read(0x27) & 0x08).toBe(0x08)
    k.read(0x29), k.read(0x2b), k.read(0x2d)
    expect(k.read(0x27) & 0x08).toBe(0)
    k.wait(1 / 400)
    expect(k.read(0x27) & 0x08).toBe(0x08)
  })

  it("sets xOR/ZYXOR when a sample overwrites unread data, clears DA/OR as the outputs are read (§7.6; clearing rule is a decision)", () => {
    const k = bench("lis302dl")
    k.write(0x20, ON)
    k.wait(0.031 + 0.01)
    expect(k.read(0x27)).toBe(0xff)
    k.read(0x29)
    expect(k.read(0x27)).toBe(0xee)
    k.read(0x2b), k.read(0x2d)
    expect(k.read(0x27)).toBe(0)
  })

  it("only flags enabled axes; all axes off means no data ready (§7.2 Xen/Yen/Zen)", () => {
    const k = bench("lis302dl")
    k.write(0x20, 0x44 | 0x01) // Z and X
    k.wait(0.031)
    expect(k.read(0x27)).toBe(0x0d)
    k.write(0x20, 0x40)
    k.read(0x29), k.read(0x2d)
    k.wait(0.02)
    expect(k.read(0x27)).toBe(0)
  })

  it("stops sampling when PD is cleared (§7.2)", () => {
    const k = bench("lis302dl")
    k.write(0x20, ON)
    k.wait(0.031)
    k.read(0x29), k.read(0x2b), k.read(0x2d)
    k.write(0x20, 0x07)
    k.wait(0.05)
    expect(k.read(0x27)).toBe(0)
  })

  it("routes data-ready to INT1 with I1CFG=100, active high push-pull by default (§7.4 Tables 24–25)", () => {
    const k = bench("lis302dl")
    expect(k.int1(), "CFG 000 = GND").toBe(false)
    k.write(0x22, 0x04)
    k.write(0x20, ON)
    const on = k.now()
    expect(k.int1()).toBe(false)
    k.wait(0.031)
    expect(k.int1(), "new set ready").toBe(true)
    k.frame([0xc0 | 0x29, 0, 0, 0, 0, 0])
    expect(k.int1(), "outputs read").toBe(false)
    const edge = k.c.out.find((e) => e.pin === "INT1" && e.level === true)
    expect(edge!.time - on, "rose at the sample instant, 3/ODR after PD").toBeCloseTo(0.03, 5)
  })

  it("drives INT2 with I2CFG=100, inverts with IHL and opens the drain with PP_OD (§7.4)", () => {
    const k = bench("lis302dl")
    k.write(0x22, 0x20 | 0x80) // INT2 = DRDY, active low
    expect(k.int2(), "idle high when active low").toBe(true)
    k.write(0x20, ON)
    k.wait(0.031)
    expect(k.int2()).toBe(false)
    k.read(0x29), k.read(0x2b), k.read(0x2d)
    k.write(0x22, 0x20 | 0x80 | 0x40) // open drain
    expect(k.int2(), "inactive (high) = released").toBeNull()
    k.wait(0.011)
    expect(k.int2(), "active = pulled low").toBe(false)
  })

  it("adds the self-test force: X negative, Y/Z positive with STP; STM flips the sign (§2.5.3, Table 3 notes 6–7)", () => {
    const k = bench("lis302dl")
    k.write(0x20, ON)
    k.wait(0.031)
    const base = [s8(k.read(0x29)), s8(k.read(0x2b)), s8(k.read(0x2d))]
    k.write(0x20, ON | 0x10)
    k.wait(0.011)
    const stp = [s8(k.read(0x29)), s8(k.read(0x2b)), s8(k.read(0x2d))]
    const d = stp.map((v, i) => v - base[i])
    expect(d[0]).toBeLessThanOrEqual(-7)
    expect(d[0]).toBeGreaterThanOrEqual(-32)
    for (const v of d.slice(1)) {
      expect(v).toBeGreaterThanOrEqual(7)
      expect(v).toBeLessThanOrEqual(32)
    }
    k.write(0x20, ON | 0x08)
    k.wait(0.011)
    const stm = [s8(k.read(0x29)), s8(k.read(0x2b)), s8(k.read(0x2d))]
    expect(stm.map((v, i) => v - base[i])).toEqual(d.map((v) => -v))
  })

  it("self-clears BOOT (§7.3)", () => {
    const k = bench("lis302dl")
    k.write(0x21, 0x40 | 0x10)
    expect(k.read(0x21)).toBe(0x10)
  })

  it("puts nothing on MISO in 3-wire mode (SIM=1, §7.3: data goes out on SDI)", () => {
    const k = bench("lis302dl")
    k.write(0x21, 0x80)
    const bits: (boolean | null)[] = []
    k.frame([0x8f, 0], bits)
    expect(bits.every((b) => b === null)).toBe(true)
  })

  it("reaches only 6-bit addresses: 0x40 in the command is MS, not an address bit (§5.2)", () => {
    const k = bench("lis302dl")
    expect(k.frame([0xc0 | 0x0f, 0])[1]).toBe(0x3b)
  })
})

describe("LIS3DSH", () => {
  const ON = 0x67 // ODR 100 Hz, BDU 0, Z/Y/X enabled (ST's BSP LIS3DSH_Init low byte)

  it("has the Table 15 / §7 reset values and INFO1/INFO2 (Tables 16–17)", () => {
    const k = bench("lis3dsh")
    const expected: [number, number][] = [
      [0x0d, 0x21], [0x0e, 0x00], [0x10, 0], [0x16, 0x01], [0x17, 0], [0x20, 0x07], [0x21, 0], [0x22, 0], [0x23, 0], [0x24, 0],
      [0x27, 0], [0x28, 0], [0x29, 0], [0x2a, 0], [0x2b, 0], [0x2c, 0], [0x2d, 0], [0x2e, 0],
    ]
    for (const [a, v] of expected) expect.soft(k.read(a), `0x${a.toString(16)}`).toBe(v)
  })

  it("decodes a 7-bit address: 0x40 is address bit 6, not an MS bit (§5.2 text over Fig. 7–12)", () => {
    const k = bench("lis3dsh")
    k.write(0x50, 0x99) // TIM4_1
    expect(k.read(0x50), "write-only register reads back what was written (decision)").toBe(0x99)
    expect(k.read(0x40 | 0x0f), "0x4F is ST1_16, not WHO_AM_I").toBe(0)
  })

  it("auto-increments with ADD_INC=1 (reset, a decision) and repeats with ADD_INC=0 (§5.2, Table 28)", () => {
    const k = bench("lis3dsh")
    expect(k.read(0x25) & 0x10, "ADD_INC at reset").toBe(0x10)
    k.frame([0x10, 1, 2, 3])
    expect(k.frame([0x90, 0, 0, 0]).slice(1)).toEqual([1, 2, 3])
    k.write(0x25, 0x00)
    expect(k.frame([0x90, 0, 0, 0]).slice(1)).toEqual([1, 1, 1])
  })

  it("ignores writes to read-only registers (Table 15)", () => {
    const k = bench("lis3dsh")
    k.write(0x0f, 0)
    k.write(0x0d, 0)
    k.write(0x28, 0x55)
    expect([k.read(0x0f), k.read(0x0d), k.read(0x28)]).toEqual([0x3f, 0x21, 0])
  })

  it("samples at the CTRL_REG4 ODR (Table 23)", () => {
    for (const [code, hz] of [[1, 3.125], [4, 25], [6, 100], [7, 400], [9, 1600]] as const) {
      const k = bench("lis3dsh")
      k.write(0x20, (code << 4) | 0x07)
      k.wait(0.9 / hz)
      expect.soft(k.read(0x27) & 0x08, `${hz} Hz before 1/ODR`).toBe(0)
      k.wait(0.15 / hz)
      expect.soft(k.read(0x27) & 0x08, `${hz} Hz after 1/ODR`).toBe(0x08)
    }
  })

  it("reads 1 g on Z as a 16-bit LH word at 0.06 mg/digit, ±2 g (Table 3, §7.23–7.25)", () => {
    const k = bench("lis3dsh")
    k.write(0x20, ON)
    k.wait(0.011)
    // ST's BSP LIS3DSH_ReadACC: six single-byte reads, L then H
    const b = [0x28, 0x29, 0x2a, 0x2b, 0x2c, 0x2d].map((a) => k.read(a))
    expect([s16(b[0], b[1]), s16(b[2], b[3]), s16(b[4], b[5])]).toEqual([0, 0, 16667])
  })

  it("scales by the FSCALE sensitivity (Table 3, Table 25) and saturates at ±32767/−32768", () => {
    const cases: [number, number][] = [[0, 0.06], [1, 0.12], [2, 0.18], [3, 0.24], [4, 0.73]]
    for (const [code, so] of cases) {
      const k = bench("lis3dsh")
      k.c.setAcceleration({ x: 1.5, y: -1, z: 0 })
      k.write(0x24, code << 3)
      k.write(0x20, ON)
      k.wait(0.011)
      const b = k.frame([0xa8, 0, 0, 0, 0, 0, 0]).slice(1)
      expect.soft(s16(b[0], b[1]), `X at FSCALE ${code}`).toBe(Math.min(32767, Math.round(1500 / so)))
      expect.soft(s16(b[2], b[3]), `Y at FSCALE ${code}`).toBe(Math.round(-1000 / so))
    }
    const k = bench("lis3dsh")
    k.c.setAcceleration({ x: 3, y: -3, z: 0 })
    k.write(0x20, ON)
    k.wait(0.011)
    const b = k.frame([0xa8, 0, 0, 0, 0]).slice(1)
    expect([s16(b[0], b[1]), s16(b[2], b[3])]).toEqual([32767, -32768])
  })

  it("holds an axis pair once one half is read until the other half is, with BDU=1 (§7.5)", () => {
    const k = bench("lis3dsh")
    k.c.setAcceleration({ x: 0.5, y: 0, z: 1 })
    k.write(0x20, ON | 0x08)
    k.wait(0.011)
    const lo = k.read(0x28)
    k.c.setAcceleration({ x: -0.5, y: 0, z: 1 })
    k.wait(0.02)
    const hi = k.read(0x29)
    expect(s16(lo, hi), "pair from one sample").toBe(Math.round(500 / 0.06))
    expect(s16(k.read(0x28), k.read(0x29)), "unlocked: the latest sample").toBe(Math.round(-500 / 0.06))
  })

  it("updates halves independently with BDU=0 (§7.5 continuous update)", () => {
    const k = bench("lis3dsh")
    k.c.setAcceleration({ x: 0.5, y: 0, z: 1 })
    k.write(0x20, ON)
    k.wait(0.011)
    const lo = k.read(0x28)
    k.c.setAcceleration({ x: -0.5, y: 0, z: 1 })
    k.wait(0.02)
    const hi = k.read(0x29)
    expect(s16(lo, hi)).not.toBe(Math.round(500 / 0.06))
  })

  it("sets STATUS DA/OR and mirrors them in STAT DRDY/DOR (Table 30, Table 42); OUT_x_H read clears the axis (decision)", () => {
    const k = bench("lis3dsh")
    k.write(0x20, ON)
    k.wait(0.011)
    expect(k.read(0x27)).toBe(0x0f)
    expect(k.read(0x18) & 0x03).toBe(0x01)
    k.wait(0.01)
    expect(k.read(0x27)).toBe(0xff)
    expect(k.read(0x18) & 0x03).toBe(0x03)
    k.read(0x28)
    expect(k.read(0x27), "the L byte alone does not clear").toBe(0xff)
    k.read(0x29)
    expect(k.read(0x27)).toBe(0xee)
    k.frame([0xaa, 0, 0, 0, 0])
    expect(k.read(0x27)).toBe(0)
    expect(k.read(0x18) & 0x03).toBe(0)
  })

  it("keeps INT1 released until INT1_EN; with DR_EN it carries DRDY, active low latched by default (Table 20)", () => {
    const k = bench("lis3dsh")
    expect(k.int1(), "INT1 disabled at reset (decision: pad off)").toBeNull()
    k.write(0x23, 0x80 | 0x08) // DR_EN, INT1_EN, IEA=0 active low, IEL=0 latched
    expect(k.int1(), "idle = inactive high").toBe(true)
    k.write(0x20, ON)
    k.wait(0.011)
    expect(k.int1(), "DRDY asserted low").toBe(false)
    k.wait(0.005)
    expect(k.int1(), "latched until read").toBe(false)
    k.frame([0xa8, 0, 0, 0, 0, 0, 0])
    expect(k.int1()).toBe(true)
  })

  it("asserts INT1 high with IEA=1 and pulses it with IEL=1 (Table 20)", () => {
    const k = bench("lis3dsh")
    k.write(0x23, 0x80 | 0x40 | 0x20 | 0x08)
    expect(k.int1()).toBe(false)
    k.write(0x20, ON)
    k.wait(0.0101)
    expect(k.int1(), "pulse starts at the sample").toBe(true)
    k.wait(0.006)
    expect(k.int1(), "pulse over though nothing was read").toBe(false)
    const rises = k.c.out.filter((e) => e.pin === "INT1" && e.level === true)
    k.wait(0.02)
    expect(k.c.out.filter((e) => e.pin === "INT1" && e.level === true).length - rises.length, "one pulse per sample").toBe(2)
  })

  it("leaves INT1 still without DR_EN even when enabled (Table 20)", () => {
    const k = bench("lis3dsh")
    k.write(0x23, 0x08 | 0x40)
    k.write(0x20, ON)
    k.wait(0.03)
    expect(k.int1()).toBe(false)
  })

  it("adds the positive self-test +140/+140/+590 mg; negative flips the sign; 11 is not allowed (Table 3, Table 26)", () => {
    const k = bench("lis3dsh")
    k.write(0x20, ON)
    const xyz = () => {
      const b = k.frame([0xa8, 0, 0, 0, 0, 0, 0]).slice(1)
      return [s16(b[0], b[1]), s16(b[2], b[3]), s16(b[4], b[5])]
    }
    k.wait(0.011)
    expect(xyz()).toEqual([0, 0, 16667])
    k.write(0x24, 0x02)
    k.wait(0.011)
    expect(xyz()).toEqual([2333, 2333, 26500])
    k.write(0x24, 0x04)
    k.wait(0.011)
    expect(xyz()).toEqual([-2333, -2333, 6833])
    k.write(0x24, 0x06)
    k.wait(0.011)
    expect(xyz(), "not allowed: treated as normal").toEqual([0, 0, 16667])
  })

  it("soft-resets every register with STRT (Table 20) and self-clears BOOT (Table 28)", () => {
    const k = bench("lis3dsh")
    k.write(0x20, ON)
    k.write(0x24, 0x18)
    k.write(0x10, 0x33)
    k.write(0x25, 0x90)
    expect(k.read(0x25)).toBe(0x10)
    k.write(0x23, 0x01)
    expect([k.read(0x20), k.read(0x24), k.read(0x10), k.read(0x23)]).toEqual([0x07, 0, 0, 0])
    k.wait(0.05)
    expect(k.read(0x27), "back in power-down").toBe(0)
  })

  it("reports quiet time: Infinity when no pin follows the samples, the next sample when INT1 does", () => {
    const k = bench("lis3dsh")
    k.write(0x20, ON)
    expect(k.c.quietUntil()).toBe(Infinity)
    k.write(0x23, 0x88)
    expect(k.c.quietUntil()).toBeGreaterThan(k.now())
    expect(k.c.quietUntil()).toBeLessThanOrEqual(k.now() + 0.01 + 1e-9)
  })
})
