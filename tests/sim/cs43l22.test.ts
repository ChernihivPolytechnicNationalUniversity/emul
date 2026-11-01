/**
 * CS43L22 reference tests, written from Cirrus DS792F2 (March 2010) before the model. Section and
 * page numbers are the datasheet's. Board wiring is MB997 C-01 (STM32F4-Discovery): I²C1 on
 * PB6/PB9, AD0 = GND → 0x4A, RESET on PD4 with a pull-down, I2S3 slave.
 */
import { describe, expect, it } from "vitest"
import { Cs43l22, NOT_MODELLED, type Cs43l22Pins } from "@/sim/cs43l22"

const PINS: Cs43l22Pins = { sda: "PB9", scl: "PB6", reset: "PD4", mclk: "PC7", sclk: "PC10", sdin: "PC12", lrck: "PA4" }
const ADDR = 0x4a
const dB = (db: number) => 10 ** (db / 20)

type Format = "i2s" | "lj" | "rj" | "dsp"
type PlayOptions = { format?: Format; bits?: number; slot?: number; fs?: number; mclk?: number }

/** A host on the codec's pins: I²C master bit-banged at < 100 kHz, an I²S master with MCLK. */
function bench(options?: ConstructorParameters<typeof Cs43l22>[2], i2cStep = 5e-6) {
  const codec = new Cs43l22("U7", PINS, options)
  let t = 1e-3
  let masterSda = true
  let line = true
  // The SDA net is the wired-AND of the master and the codec, delivered on change as the loop does.
  const sync = () => {
    const level = masterSda && codec.drive(PINS.sda) !== false
    if (level !== line) {
      line = level
      codec.input(PINS.sda, level, t)
    }
  }
  const sda = (level: boolean) => {
    t += i2cStep
    masterSda = level
    sync()
  }
  const scl = (level: boolean) => {
    t += i2cStep
    codec.input(PINS.scl, level, t)
    sync()
  }
  const start = () => {
    sda(true)
    scl(true)
    sda(false)
    scl(false)
  }
  const stop = () => {
    sda(false)
    scl(true)
    sda(true)
  }
  /** One byte out; true when the codec ACKed it. */
  const sendByte = (byte: number) => {
    for (let i = 7; i >= 0; i--) {
      sda(((byte >> i) & 1) === 1)
      scl(true)
      scl(false)
    }
    sda(true)
    scl(true)
    const ack = !line
    scl(false)
    return ack
  }
  const readByte = (ack: boolean) => {
    sda(true)
    let byte = 0
    for (let i = 0; i < 8; i++) {
      scl(true)
      byte = (byte << 1) | (line ? 1 : 0)
      scl(false)
    }
    sda(!ack)
    scl(true)
    scl(false)
    sda(true)
    return byte
  }
  const pin = (name: keyof Cs43l22Pins, level: boolean, dt = 1e-6) => {
    t += dt
    codec.input(PINS[name], level, t)
  }

  /** Write: START, 0x94, MAP (INCR in bit 7), data…, STOP (§5.1 Fig. 16). The ACKs, in order. */
  const write = (map: number, data: number[], incr = data.length > 1) => {
    start()
    const acks = [sendByte(ADDR << 1), sendByte(map | (incr ? 0x80 : 0)), ...data.map(sendByte)]
    stop()
    return acks
  }
  /** Read: aborted write to set MAP, STOP, START, 0x95, data with master NACK on the last (§5.1 Fig. 17). */
  const read = (map: number, n = 1, incr = n > 1, repeatedStart = false) => {
    start()
    sendByte(ADDR << 1)
    sendByte(map | (incr ? 0x80 : 0))
    if (!repeatedStart) stop()
    start()
    if (!sendByte((ADDR << 1) | 1)) {
      stop()
      return null
    }
    const out: number[] = []
    for (let i = 0; i < n; i++) out.push(readByte(i < n - 1))
    stop()
    return out
  }
  const read1 = (map: number) => read(map)![0]

  /**
   * Datasheet §4.9 power-up: RESET high, registers loaded while 0x02 = 0x01, §4.11 settings, then
   * 0x9E. Interface Ctl 1 resets to 0x00 = Left-Justified (§6), so 0x06 = 0x04 (I²S, what `play`
   * sends by default) goes first; a test's own setup overrides it.
   */
  const powerUp = (setup: [number, number][] = [], init = true) => {
    pin("reset", true, 2e-3)
    t += 1e-6
    for (const [r, v] of [[0x06, 0x04], ...setup]) write(r, [v])
    if (init) initSettings()
    write(0x02, [0x9e])
  }
  const initSettings = () => {
    write(0x00, [0x99])
    write(0x47, [0x80])
    write(0x32, [read1(0x32) | 0x80])
    write(0x32, [read1(0x32) & 0x7f])
    write(0x00, [0x00])
  }

  /** Frames on the I²S bus, LRCK/SCLK/SDIN as an MCU master drives them, MCLK at `mclk`·Fs (0: none). */
  const play = (frames: [number, number][], o: PlayOptions = {}) => {
    const format = o.format ?? "i2s"
    const bits = o.bits ?? 16
    const slot = o.slot ?? 32
    const fs = o.fs ?? 48000
    const mclk = o.mclk ?? 256
    const all: [number, number][] = [[0, 0], [0, 0], ...frames, [0, 0], [0, 0]]
    const word = (v: number, n: number) => Array.from({ length: n }, (_, i) => ((v >> (n - 1 - i)) & 1) as 0 | 1)
    const stream: (0 | 1)[] = []
    for (const [l, r] of all) {
      if (format === "dsp") {
        const f = [...word(l, bits), ...word(r, bits)]
        stream.push(...f, ...Array<0>(2 * slot - f.length).fill(0))
      } else
        for (const v of [l, r]) {
          const pad = Array<0>(slot - bits).fill(0)
          stream.push(...(format === "rj" ? [...pad, ...word(v, bits)] : [...word(v, bits), ...pad]))
        }
    }
    const T = 1 / (2 * slot * fs)
    const events: [number, string, boolean][] = []
    const t0 = t + 10e-6
    for (let n = 0; n < stream.length; n++) {
      const pos = n % (2 * slot)
      const lr = format === "dsp" ? pos === 0 : format === "i2s" ? pos >= slot : pos < slot
      const d = format === "i2s" ? (n === 0 ? 0 : stream[n - 1]) : stream[n]
      const tf = t0 + n * T
      events.push([tf, PINS.sclk, false], [tf + 1e-9, PINS.lrck, lr], [tf + 1e-9, PINS.sdin, d === 1], [tf + T / 2, PINS.sclk, true])
    }
    const end = t0 + stream.length * T
    if (mclk > 0) {
      const Tm = 1 / (mclk * fs)
      for (let k = 0; t0 + (k * Tm) / 2 < end; k++) events.push([t0 + Tm / 7 + (k * Tm) / 2, PINS.mclk, k % 2 === 0])
    }
    events.sort((a, b) => a[0] - b[0])
    const last = new Map<string, boolean>()
    for (const [time, p, level] of events) {
      if (last.get(p) === level) continue
      last.set(p, level)
      codec.input(p, level, time)
    }
    t = end + 10e-6
  }
  return { codec, write, read, read1, pin, powerUp, initSettings, play, start, stop, sendByte, now: () => t, advance: (dt: number) => (t += dt) }
}

/** Index where `expected` begins inside `got` (exact sample match), or -1. */
function findRun(got: Float32Array, expected: number[]) {
  outer: for (let i = 0; i + expected.length <= got.length; i++) {
    for (let k = 0; k < expected.length; k++) if (Math.abs(got[i + k] - expected[k]) > 1e-6) continue outer
    return i
  }
  return -1
}
const s16 = (v: number) => v / 32768

describe("CS43L22: reset and I²C control port (§4.8, §5.1, p.16–17)", () => {
  it("holds the bus silent while RESET is low (PD4 pull-down), answers 0x4A once RESET is high", () => {
    const b = bench()
    expect(b.write(0x02, [0x01])[0], "no ACK in reset").toBe(false)
    expect(b.codec.snapshot().reset).toBe(true)
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    expect(b.write(0x02, [0x01])).toEqual([true, true, true])
  })

  it("ignores a START sooner than tirs = 550 ns after RESET rises (p.17)", () => {
    const b = bench(undefined, 100e-9)
    b.pin("reset", true, 2e-3)
    b.start()
    expect(b.sendByte(ADDR << 1)).toBe(false)
    b.stop()
    b.advance(1e-6)
    b.start()
    expect(b.sendByte(ADDR << 1)).toBe(true)
    b.stop()
  })

  it("latches AD0 on the RESET rising edge: AD0 high answers 0x4B (§5.1)", () => {
    const b = bench({ ad0: true })
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    expect(b.write(0x02, [0x01])[0]).toBe(false)
    b.start()
    expect(b.sendByte(0x4b << 1)).toBe(true)
    b.stop()
  })

  it("reads chip ID 11100 + REVID (§7.1): 0xE3 for rev B1 by default, configurable", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    expect(b.read1(0x01)).toBe(0xe3)
    const a1 = bench({ revision: 1 })
    a1.pin("reset", true, 2e-3)
    a1.advance(1e-6)
    expect(a1.read1(0x01)).toBe(0xe1)
  })

  it("comes out of reset with the Quick Reference values in 0x01–0x34 (§6)", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    const expected = new Array(0x35).fill(0)
    Object.assign(expected, { 0x01: 0xe3, 0x02: 0x01, 0x03: 0x07, 0x04: 0x05, 0x05: 0xa0, 0x08: 0x81, 0x09: 0x81, 0x0a: 0xa5, 0x0d: 0x60, 0x0e: 0x02, 0x18: 0x80, 0x19: 0x80, 0x1f: 0x88, 0x28: 0x7f, 0x2b: 0x3f, 0x32: 0x3b, 0x34: 0x5f })
    expect(b.read(0x01, 0x34)).toEqual(expected.slice(1))
  })

  it("MAP INCR = 1 auto-increments on writes and reads; INCR = 0 keeps MAP (§5.1.1.1)", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    b.write(0x20, [0x11, 0x22, 0x33, 0x44], true)
    expect(b.read(0x20, 4)).toEqual([0x11, 0x22, 0x33, 0x44])
    b.write(0x24, [0x55, 0x66], false)
    expect(b.read(0x24, 2, false)).toEqual([0x66, 0x66])
    expect(b.read1(0x25)).toBe(0x00)
  })

  it("accepts the read with a repeated START after the MAP byte (Fig. 17) as well as STOP + START (p.34)", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    b.write(0x1f, [0x5a])
    expect(b.read(0x1f, 1, false, true)).toEqual([0x5a])
    expect(b.read(0x1f, 1, false, false)).toEqual([0x5a])
  })

  it("ACKs but ignores writes to the read-only registers 0x01, 0x2E, 0x30, 0x31 (§7)", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    for (const r of [0x01, 0x2e, 0x30, 0x31]) expect(b.write(r, [0xff])).toEqual([true, true, true])
    expect([b.read1(0x01), b.read1(0x2e), b.read1(0x30), b.read1(0x31)]).toEqual([0xe3, 0, 0, 0])
  })

  it("stores the §4.11 writes to the unmapped 0x00 / 0x47 and reports the init done", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    expect(b.write(0x47, [0x80])).toEqual([true, true, true])
    expect(b.read1(0x47)).toBe(0x80)
    expect(b.codec.snapshot().initDone).toBe(false)
    const fresh = bench()
    fresh.pin("reset", true, 2e-3)
    fresh.advance(1e-6)
    fresh.initSettings()
    expect(fresh.codec.snapshot().initDone).toBe(true)
    expect(fresh.read1(0x32)).toBe(0x3b)
  })

  it("returns every register to its default when RESET goes low again (§4.10 step 6)", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    b.write(0x20, [0x12])
    b.pin("reset", false, 1e-6)
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    expect(b.read1(0x20)).toBe(0x00)
  })

  it("warns about a RESET low pulse shorter than 1 ms (p.16) and an SCL faster than 100 kHz (p.17)", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.pin("reset", false, 1e-6)
    b.pin("reset", true, 100e-6)
    expect(b.codec.snapshot().warnings.join("\n")).toMatch(/1 ms/)
    const fast = bench(undefined, 1e-6)
    fast.pin("reset", true, 2e-3)
    fast.advance(1e-6)
    fast.read1(0x01)
    expect(fast.codec.snapshot().warnings.join("\n")).toMatch(/100 kHz/)
  })
})

describe("CS43L22: power control (§4.9–4.11, §7.2, §7.3)", () => {
  it("is powered down at 0x01, up at 0x9E, down at 0x9F", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.advance(1e-6)
    expect(b.codec.snapshot().powered).toBe(false)
    b.initSettings()
    b.write(0x02, [0x9e])
    expect(b.codec.snapshot().powered).toBe(true)
    b.write(0x02, [0x9f])
    expect(b.codec.snapshot().powered).toBe(false)
  })

  it("warns when powered up without the §4.11 required initialization settings", () => {
    const b = bench()
    b.powerUp([], false)
    expect(b.codec.snapshot().powered).toBe(true)
    expect(b.codec.snapshot().warnings.join("\n")).toMatch(/4\.11/)
    const ok = bench()
    ok.powerUp()
    expect(ok.codec.snapshot().warnings.join("\n")).not.toMatch(/4\.11/)
  })

  it("plays nothing while powered down (§7.2)", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    b.play([[0x4000, 0x4000]])
    expect(b.codec.takeAudio().left.length).toBe(0)
    expect(b.codec.pressure()).toBe(0)
  })

  it("headphone channels follow PDN_HPx and the SPKR/HP pin, tied low on the board (§7.3)", () => {
    // 0x05 (reset): PDN_HPx = 00 → ON while SPKR/HP is LO.
    const b = bench()
    b.powerUp()
    b.play([[0x4000, 0x2000]])
    expect(findRun(b.codec.takeAudio().left, [0.5])).toBeGreaterThanOrEqual(0)
    // 0xAF: HP always on (ST BSP), speakers off.
    b.write(0x04, [0xaf])
    b.play([[0x4000, 0x2000]])
    expect(findRun(b.codec.takeAudio().right, [0.25])).toBeGreaterThanOrEqual(0)
    // 0x4F: HPB = 01 (ON when HI → off), HPA = 00 (on).
    b.write(0x04, [0x4f])
    b.play([[0x4000, 0x2000]])
    const out = b.codec.takeAudio()
    expect(findRun(out.left, [0.5])).toBeGreaterThanOrEqual(0)
    expect(out.right.every((v) => v === 0)).toBe(true)
    // 0xFF: both always off.
    b.write(0x04, [0xff])
    b.play([[0x4000, 0x2000]])
    expect(b.codec.takeAudio().left.every((v) => v === 0)).toBe(true)
  })

  it("INV_SWCH inverts the SPKR/HP pin sense (§7.6.2)", () => {
    const b = bench()
    b.powerUp([[0x07, 0x08]])
    b.play([[0x4000, 0x4000]])
    expect(b.codec.takeAudio().left.every((v) => v === 0)).toBe(true)
  })
})

describe("CS43L22: serial audio port, slave receiver (§4.7, §7.5)", () => {
  const frames: [number, number][] = [
    [0x4000, -0x2000],
    [0x1234, 0x7fff],
    [-0x8000, 0x0001],
  ]
  const expectFrames = (b: ReturnType<typeof bench>, scale: (v: number) => number = s16) => {
    const out = b.codec.takeAudio()
    const i = findRun(out.left, frames.map(([l]) => scale(l)))
    expect(i, `left ${Array.from(out.left.slice(0, 12))}`).toBeGreaterThanOrEqual(0)
    expect(Array.from(out.right.slice(i, i + frames.length))).toEqual(frames.map(([, r]) => Math.fround(scale(r))))
    return out
  }

  it("I²S (DACDIF = 01): LRCK low = left, MSB one SCLK after the LRCK edge, 16-bit in 32-bit slots; deduces Fs", () => {
    const b = bench()
    b.powerUp([[0x06, 0x04]])
    b.play(frames)
    const out = expectFrames(b)
    expect(out.rate).toBe(48000)
  })

  it("I²S with 16-bit slots (32 SCLK per frame) at 44.1 kHz", () => {
    const b = bench()
    b.powerUp([[0x06, 0x04]])
    b.play(frames, { slot: 16, fs: 44100 })
    expect(expectFrames(b).rate).toBe(44100)
  })

  it("I²S with 24-bit data: the receiver takes up to 24 bits MSB first", () => {
    const b = bench()
    b.powerUp([[0x06, 0x04]])
    const f24: [number, number][] = [[0x400000, -0x123456]]
    b.play(f24, { bits: 24 })
    const out = b.codec.takeAudio()
    const i = findRun(out.left, [0.5])
    expect(i).toBeGreaterThanOrEqual(0)
    expect(out.right[i]).toBe(Math.fround(-0x123456 / 0x800000))
  })

  it("Left-Justified (DACDIF = 00): LRCK high = left, MSB on the first SCLK after the edge", () => {
    const b = bench()
    b.powerUp([[0x06, 0x00]])
    b.play(frames, { format: "lj" })
    expectFrames(b)
  })

  it("Right-Justified (DACDIF = 10, AWL = 11 → 16-bit): LSB on the last SCLK before the LRCK edge", () => {
    const b = bench()
    b.powerUp([[0x06, 0x0b]])
    b.play(frames, { format: "rj" })
    expectFrames(b)
  })

  it("Right-Justified 24-bit (AWL = 00)", () => {
    const b = bench()
    b.powerUp([[0x06, 0x08]])
    b.play([[0x400000, -0x200000]], { format: "rj", bits: 24 })
    const out = b.codec.takeAudio()
    const i = findRun(out.left, [0.5])
    expect(i).toBeGreaterThanOrEqual(0)
    expect(out.right[i]).toBe(-0.25)
  })

  it("DSP mode (DSP = 1, LJ, AWL = 11 → 16-bit): left then right right after the frame sync (§4.7.1)", () => {
    const b = bench()
    b.powerUp([[0x06, 0x13]])
    b.play(frames, { format: "dsp" })
    expectFrames(b)
  })
})

describe("CS43L22: clocking (§4.6, §4.8, §7.4, §7.26, §9.1)", () => {
  it("reports SPCLKERR on the first status read after power-up, then clears on read (§7.26 note)", () => {
    const b = bench()
    b.powerUp()
    b.play([[0, 0]])
    expect(b.read1(0x2e) & 0x40).toBe(0x40)
    b.play([[0, 0]])
    expect(b.read1(0x2e) & 0x40).toBe(0)
  })

  it("accepts the AUTO MCLK:LRCK ratios of §9.1 (256× SSM, 512× with MCLKDIV2, 128× DSM)", () => {
    for (const [clocking, mclk] of [
      [0xa0, 256],
      [0xa0, 384],
      [0xa1, 512],
      [0xa0, 128],
    ]) {
      const b = bench()
      b.powerUp([[0x05, clocking]])
      b.play([[0x4000, 0]], { mclk })
      expect(findRun(b.codec.takeAudio().left, [0.5]), `ratio ${mclk}`).toBeGreaterThanOrEqual(0)
    }
  })

  it("flags an invalid ratio (300×) in SPCLKERR and plays silence", () => {
    const b = bench()
    b.powerUp()
    b.play([[0x4000, 0x4000]], { mclk: 300 })
    expect(b.codec.takeAudio().left.every((v) => v === 0)).toBe(true)
    b.read1(0x2e)
    b.play([[0x4000, 0x4000]], { mclk: 300 })
    expect(b.read1(0x2e) & 0x40).toBe(0x40)
    expect(b.codec.snapshot().warnings.join("\n")).toMatch(/ratio/)
  })

  it("plays nothing and warns when MCLK is absent while powered (§4.8: the DAC runs from MCLK)", () => {
    const b = bench()
    b.powerUp()
    b.play([[0x4000, 0x4000]], { mclk: 0 })
    expect(b.codec.takeAudio().left.length).toBe(0)
    expect(b.codec.snapshot().warnings.join("\n")).toMatch(/MCLK/)
  })

  it("warns when MCLK is removed less than 100 µs after 0x9F (§4.10 step 4)", () => {
    const b = bench()
    b.powerUp()
    b.codec.setMclk(12.288e6, b.now())
    b.write(0x02, [0x9f])
    b.codec.setMclk(0, b.now() + 20e-6)
    expect(b.codec.snapshot().warnings.join("\n")).toMatch(/100 µs/)
  })
})

describe("CS43L22: volume and mute chain (§4.2 Fig. 5, §7.10–7.14, §7.19–7.20)", () => {
  const level = (setup: [number, number][], sample = 0x4000, channel: "left" | "right" = "left") => {
    const b = bench()
    b.powerUp(setup)
    b.play([[sample, sample]])
    const out = b.codec.takeAudio()[channel]
    let peak = 0
    for (const v of out) if (Math.abs(v) > Math.abs(peak)) peak = v
    return { peak, b }
  }

  it("is unity at the reset volumes (PCM, master and headphone all 0 dB)", () => {
    expect(level([]).peak).toBeCloseTo(0.5, 6)
  })

  it("MSTxVOL: 8-bit two's complement, 0.5 dB steps, +12 dB at 0x18, 0x19–0x34 = −102 dB (§7.19)", () => {
    expect(level([[0x20, 0xf4]]).peak).toBeCloseTo(0.5 * dB(-6), 6)
    expect(level([[0x20, 0x0c]], 0x1000).peak).toBeCloseTo(0.125 * dB(6), 6)
    expect(level([[0x20, 0x19]]).peak).toBeCloseTo(0.5 * dB(-102), 9)
    expect(level([[0x20, 0x34]]).peak).toBeCloseTo(0.5 * dB(-102), 9)
    expect(level([[0x20, 0x35]]).peak).toBeCloseTo(0.5 * dB(-101.5), 9)
  })

  it("HPxVOL: 0x00 = 0 dB, 0xFF = −0.5 dB, 0x01 = muted (§7.20)", () => {
    expect(level([[0x22, 0xff]]).peak).toBeCloseTo(0.5 * dB(-0.5), 6)
    expect(level([[0x22, 0xe8]]).peak).toBeCloseTo(0.5 * dB(-12), 6)
    expect(level([[0x22, 0x01]]).peak).toBe(0)
  })

  it("PCMxVOL: +12 dB at 0x18 down through 0x7F = −0.5 dB to 0x19 = −51.5 dB (§7.14)", () => {
    expect(level([[0x1a, 0x7c]]).peak).toBeCloseTo(0.5 * dB(-2), 6)
    expect(level([[0x1a, 0x19]]).peak).toBeCloseTo(0.5 * dB(-51.5), 8)
    expect(level([[0x1a, 0x0c]], 0x1000).peak).toBeCloseTo(0.125 * dB(6), 6)
  })

  it("clips at full scale and latches PCMxOVFL, clear on read (§7.26.3)", () => {
    const { peak, b } = level([[0x1a, 0x18]])
    expect(peak).toBeCloseTo(1, 6)
    const status = b.read1(0x2e)
    expect(status & 0x08, "PCMAOVFL").toBe(0x08)
    expect(status & 0x04, "PCMBOVFL").toBe(0)
    expect(b.read1(0x2e) & 0x08).toBe(0)
  })

  it("latches DSPAOVFL in bit 5 when master volume clips (§7.26.2 table order)", () => {
    const { b } = level([[0x20, 0x18]])
    expect(b.read1(0x2e) & 0x30).toBe(0x20)
  })

  it("mutes: PCMxMUTE (§7.14.1), MSTxMUTE (§7.10.4), HPxMUTE (§7.12.1) — per channel", () => {
    for (const setup of [[[0x1a, 0x80]], [[0x0d, 0x61]], [[0x0f, 0x40]]] as [number, number][][]) {
      expect(level(setup).peak, JSON.stringify(setup)).toBe(0)
      expect(level(setup, 0x4000, "right").peak).toBeCloseTo(0.5, 6)
    }
  })

  it("INV_PCMA inverts channel A's polarity (§7.10.3)", () => {
    expect(level([[0x0d, 0x64]]).peak).toBeCloseTo(-0.5, 6)
  })

  it("PLYBCKB=A gangs the volumes onto channel A's settings, mutes stay per channel (§7.10.2)", () => {
    expect(level([[0x0d, 0x70], [0x20, 0xf4], [0x21, 0x00]], 0x4000, "right").peak).toBeCloseTo(0.5 * dB(-6), 6)
    expect(level([[0x0d, 0x71]], 0x4000, "right").peak).toBeCloseTo(0.5, 6)
  })

  it("PCMxSWP: 11 swaps, 01 mixes (L+R)/2 (§7.22)", () => {
    const b = bench()
    b.powerUp([[0x26, 0xf0]])
    b.play([[0x4000, 0x2000]])
    let out = b.codec.takeAudio()
    let i = findRun(out.left, [0.25])
    expect(i).toBeGreaterThanOrEqual(0)
    expect(out.right[i]).toBe(0.5)
    b.write(0x26, [0x50])
    b.play([[0x4000, 0x2000]])
    out = b.codec.takeAudio()
    i = findRun(out.left, [0.375])
    expect(i).toBeGreaterThanOrEqual(0)
    expect(out.right[i]).toBe(0.375)
  })

  it("FREEZE holds register changes until it is cleared; read-back shows the new value (§7.11.3)", () => {
    const b = bench()
    b.powerUp()
    b.write(0x0e, [0x0a])
    b.write(0x20, [0xf4])
    expect(b.read1(0x20)).toBe(0xf4)
    b.play([[0x4000, 0x4000]])
    expect(findRun(b.codec.takeAudio().left, [0.5])).toBeGreaterThanOrEqual(0)
    b.write(0x0e, [0x02])
    b.play([[0x4000, 0x4000]])
    expect(findRun(b.codec.takeAudio().left, [Math.fround(0.5 * dB(-6))])).toBeGreaterThanOrEqual(0)
  })

  it("full-scale headphone output is 2·G·MI·VA = 2.05 Vpp at HPGAIN 011, VA 2.5 V (p.11, p.15)", () => {
    const b = bench()
    b.pin("reset", true, 2e-3)
    expect(b.codec.snapshot().fullScaleVpp).toBeCloseTo(2.05, 2)
    b.advance(1e-6)
    b.write(0x0d, [0xc0])
    expect(b.codec.snapshot().fullScaleVpp).toBeCloseTo(2 * 1.0 * 0.6787 * 2.5, 3)
  })

  it("drives the bench sound through pressure(), scaled with HPGAIN", () => {
    const p = (hpgain: number) => {
      const b = bench()
      b.powerUp([[0x0d, hpgain << 5]])
      let t = b.now()
      b.codec.setMclk(256 * 48000, t)
      for (let k = 0; k < 4; k++) b.codec.receiveFrame(0x4000, 0x4000, 16, (t += 1 / 48000))
      return b.codec.pressure()
    }
    expect(p(0b011)).toBeGreaterThan(0)
    expect(p(0b110) / p(0b011)).toBeCloseTo(1 / 0.6047, 3)
  })
})

describe("CS43L22: beep generator (§4.2.1, §7.15–7.17)", () => {
  /** Word-level feed (receiveFrame) at Fs 48 kHz with MCLK 256×: seconds of SDIN silence. */
  const run = (setup: [number, number][], seconds: number) => {
    const b = bench()
    b.powerUp(setup)
    const fs = 48000
    let t = b.now()
    b.codec.setMclk(256 * fs, t)
    const n = Math.round(seconds * fs)
    for (let k = 0; k < n; k++) b.codec.receiveFrame(0, 0, 16, (t += 1 / fs))
    return b.codec.takeAudio()
  }
  const crossings = (x: Float32Array) => {
    let c = 0
    for (let k = 1; k < x.length; k++) if (x[k - 1] < 0 && x[k] >= 0) c++
    return c
  }
  const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

  it("continuous beep: FREQ 0111 = 1000 Hz at Fs 48 kHz, BPVOL 00000 = −6 dB", () => {
    const out = run([[0x1c, 0x70], [0x1d, 0x00], [0x1e, 0xc0]], 0.5)
    expect(crossings(out.left)).toBeGreaterThanOrEqual(498)
    expect(crossings(out.left)).toBeLessThanOrEqual(501)
    expect(peak(out.left)).toBeCloseTo(dB(-6), 2)
  })

  it("BPVOL 00110 = +6 dB is the top step; the master volume acts on the beep (§4.2.1 note)", () => {
    expect(peak(run([[0x1c, 0x70], [0x1d, 0x02], [0x1e, 0xc0]], 0.1).left)).toBeCloseTo(dB(-2), 2)
    expect(peak(run([[0x1c, 0x70], [0x1d, 0x00], [0x1e, 0xc0], [0x20, 0xf4]], 0.1).left)).toBeCloseTo(dB(-12), 2)
  })

  it("single beep: ONTIME 0000 ≈ 86 ms, then silence", () => {
    const out = run([[0x1c, 0x70], [0x1e, 0x40]], 0.3)
    const last = out.left.findLastIndex((v) => Math.abs(v) > 1e-3)
    expect(last / 48000).toBeGreaterThan(0.08)
    expect(last / 48000).toBeLessThan(0.09)
  })
})

describe("CS43L22: NOT_MODELLED", () => {
  it("lists what the model leaves out", () => {
    expect(NOT_MODELLED.length).toBeGreaterThan(5)
    expect(NOT_MODELLED.join("\n")).toMatch(/limiter/i)
    expect(NOT_MODELLED.join("\n")).toMatch(/master mode/i)
  })
})
