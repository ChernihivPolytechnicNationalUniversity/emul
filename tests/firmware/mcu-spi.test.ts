/**
 * SPI master: firmware/hal/Src/spi.c on the F429 model; the SCK/MOSI edges SPI1 puts on PA5/PA7
 * (with the bit-banged chip select on PD14) are decoded and answered on MISO like a slave would,
 * and the firmware must see the reply.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { buffer, hal } from "../lib/firmware"

const SCK = parsePad("PA5")!
const MISO = parsePad("PA6")!
const MOSI = parsePad("PA7")!
const CS = parsePad("PD14")!
const key = (p: { port: number; pin: number }) => p.port * 16 + p.pin

describe("SPI1 master on the F429", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("spi.elf")), "spi.elf")
  mcu.digitalWatch.add(key(CS))
  mcu.yieldOnOutput = true
  const sym = (name: string) => mcu.firmware!.symbols.find((s) => s.name === name)!.value
  const word = (name: string) => mcu.bus.read32(sym(name))
  const byte = (name: string, i: number) => mcu.bus.read8(sym(name) + i)

  /** The slave at the other end: mode 0 (CPOL 0, CPHA 0), MSB first, replies 0x50 + n. */
  const frames: { at: number; mosi: number; risingEdges: number[] }[] = []
  let mosi = false
  let sck = false
  let cs = true
  let reply = 0
  let replyBit = 0
  let cur: (typeof frames)[number] | null = null
  function slave(e: { pad: { port: number; pin: number }; level: boolean | null; time: number }) {
    const k = key(e.pad)
    // A released pad (null) reads high here: the bench has a pull-up on the chip select.
    if (k === key(MOSI)) mosi = e.level !== false
    else if (k === key(CS)) {
      if ((e.level !== false) === cs) return
      cs = e.level !== false
      if (!cs) {
        // Selected: the first bit of the reply goes out before any clock.
        reply = 0x50 + (frames.length & 0x0f)
        replyBit = 0
        mcu.setPad(MISO, ((reply >>> 7) & 1) === 1)
        cur = { at: e.time, mosi: 0, risingEdges: [] }
        frames.push(cur)
      } else mcu.setPad(MISO, false)
    } else if (k === key(SCK)) {
      // The pin being claimed at its idle level is not an edge.
      if ((e.level !== false) === sck) return
      sck = e.level !== false
      if (!cur || cs) return
      if (e.level) {
        // Rising: sample MOSI.
        cur.mosi = ((cur.mosi << 1) | (mosi ? 1 : 0)) & 0xff
        cur.risingEdges.push(e.time)
      } else {
        // Falling: shift out the next reply bit.
        replyBit++
        if (replyBit < 8) mcu.setPad(MISO, ((reply >>> (7 - replyBit)) & 1) === 1)
      }
    }
  }
  function run(seconds: number) {
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) {
      if (!mcu.runUntil(end)) break
      for (const e of mcu.digitalOut) slave(e)
      mcu.digitalOut.length = 0
    }
  }

  describe("after boot", () => {
    beforeAll(() => {
      // Past the master's start-up grace period.
      run(0.012)
    })

    it("keeps the core running", () => {
      expect(mcu.cpu.halted?.message).toBeUndefined()
      expect(mcu.running).toBe(true)
    })

    it("sets SPI1 CR1: master, ÷64, soft NSS, enabled", () => {
      const spi1 = mcu.spi.find((s) => s.spec.name === "SPI1")!
      expect((spi1.get("CR1") & 0x37c).toString(16)).toBe((0x4 | (5 << 3) | 0x40 | 0x300).toString(16))
    })

    it("idles SCK low and chip select high", () => {
      expect.soft(mcu.padDrive(SCK) ?? "float", "SCK").toBe("low")
      expect.soft(mcu.padDrive(CS) ?? "float", "chip select").toBe("high")
    })
  })

  describe("transfers every 10 ms (after a 10 ms grace period)", () => {
    beforeAll(() => run(0.051))

    it("counts the transfers without HAL errors", () => {
      expect.soft(word("count"), "transfers").toBeNear(5, 1)
      expect.soft(word("errors"), "HAL errors").toBe(0)
    })

    it("has the slave see every transfer", () => {
      expect(frames.length).toBe(word("count"))
    })

    it("puts 0xA0 + n on MOSI", () => {
      expect.soft(frames[0].mosi.toString(16), "first byte").toBe("a0")
      expect.soft(frames[3].mosi.toString(16), "fourth byte").toBe("a3")
    })

    it("clocks 8 bits per byte at 90 MHz / 64", () => {
      expect.soft(frames[1].risingEdges.length, "clocks").toBe(8)
      const period = (frames[1].risingEdges[7] - frames[1].risingEdges[0]) / 7
      expect.soft(period * 1e9, "SCK period (ns)").toBeNear(1e9 / (90e6 / 64), 2)
    })

    it("drops chip select before the clock", () => {
      expect((frames[1].risingEdges[0] - frames[1].at) * 1e6).toBeNear(1.5, 1.5)
    })

    it("has the master read the slave's replies back", () => {
      expect.soft(byte("rxLog", 0).toString(16), "reply 0x50").toBe("50")
      expect.soft(byte("rxLog", 3).toString(16), "reply 0x53").toBe("53")
    })

    it("spaces the transfers by HAL_Delay(10)", () => {
      // HAL_Delay(10) waits 10 ticks plus one to be safe.
      expect((frames[3].at - frames[2].at) * 1e3).toBeNear(11, 0.2)
    })

    it("touches no unmodelled features", () => {
      expect(mcu.unmodelled.summary()).toHaveLength(0)
    })
  })
})
