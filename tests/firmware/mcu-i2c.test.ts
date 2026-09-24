/**
 * I²C master: firmware/hal/Src/i2c.c on the F429 model with a 24C02 model (src/sim/digital.ts)
 * on PB8/PB9 through a two-line wired-AND bus; the HAL's memory writes, acknowledge polling and
 * reads must all land.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { Eeprom24 } from "@/sim/digital"
import { buffer, hal } from "../lib/firmware"

const SCL = parsePad("PB8")!
const SDA = parsePad("PB9")!
const key = (p: { port: number; pin: number }) => p.port * 16 + p.pin

describe("I2C1 master on the F429 with a 24C02", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("i2c.elf")), "i2c.elf")
  mcu.yieldOnOutput = true
  const word = (name: string) => mcu.bus.read32(mcu.firmware!.symbols.find((s) => s.name === name)!.value)

  /** The bus: two open-drain lines with pull-ups, the MCU and the EEPROM as drivers. */
  const eeprom = new Eeprom24("U2", { value: "24C02" })
  const drivers = { scl: { mcu: null as boolean | null }, sda: { mcu: null as boolean | null, mem: null as boolean | null } }
  const level = { scl: true, sda: true }
  const sclRises: number[] = []
  function resolve(time: number) {
    // Deliveries re-enter here (the EEPROM answers an edge at once), so re-read after each.
    for (;;) {
      const scl = drivers.scl.mcu !== false
      const sda = drivers.sda.mcu !== false && drivers.sda.mem !== false
      if (scl !== level.scl) {
        level.scl = scl
        if (scl) sclRises.push(time)
        mcu.setPadAt(SCL, scl, time)
        eeprom.input("SCL", scl, time)
        drain(time)
      } else if (sda !== level.sda) {
        level.sda = sda
        mcu.setPadAt(SDA, sda, time)
        eeprom.input("SDA", sda, time)
        drain(time)
      } else return
    }
  }
  function drain(time: number) {
    while (eeprom.out.length) {
      const e = eeprom.out.shift()!
      if (e.pin === "SDA") drivers.sda.mem = e.level
      resolve(time)
    }
  }
  function run(seconds: number) {
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) {
      if (!mcu.runUntil(end)) break
      for (const e of mcu.digitalOut) {
        if (key(e.pad) === key(SCL)) drivers.scl.mcu = e.level
        else if (key(e.pad) === key(SDA)) drivers.sda.mcu = e.level
        resolve(e.time)
      }
      mcu.digitalOut.length = 0
    }
  }

  describe("boot and greeting", () => {
    beforeAll(() => {
      mcu.setPad(SCL, true)
      mcu.setPad(SDA, true)
      run(0.04)
    })

    it("keeps the core running", () => {
      expect(mcu.cpu.halted?.message).toBeUndefined()
      expect(mcu.running).toBe(true)
    })

    it("sets CCR for 100 kHz", () => {
      // 45 MHz / (2 × 100 kHz) = 225.
      expect(mcu.i2c.find((x) => x.spec.name === "I2C1")!.get("CCR") & 0xfff).toBe(225)
    })

    it("reaches the counter loop with the greeting verified", () => {
      expect.soft(word("phase"), "phase (3 = counter loop)").toBe(3)
      expect.soft(word("errors"), "HAL errors").toBe(0)
      expect.soft(word("verified"), "read-back matched").toBe(1)
    })

    it("leaves the greeting in the EEPROM", () => {
      const snap = eeprom.snapshot()
      expect.soft(String.fromCharCode(...snap.bytes.slice(0, 14))).toBe("Hello, EEPROM!")
      expect.soft(snap.writes, "page writes: 2 pages + the counter").toBeNear(15 + 1, 2)
    })

    it("sees NACKs while acknowledge polling", () => {
      expect(word("polls")).toBeGreaterThan(0)
    })

    it("clocks SCL at 100 kHz inside a byte", () => {
      const period = sclRises.length > 20 ? (sclRises[19] - sclRises[10]) / 9 : 0
      expect(period * 1e6).toBeNear(10, 0.3)
    })
  })

  describe("counter at 0x40", () => {
    let c0 = 0
    let c1 = 0
    beforeAll(() => {
      c0 = word("counter")
      run(0.5)
      c1 = word("counter")
    })

    it("advances about every 105 ms", () => {
      expect(c1 - c0).toBeNear(5, 1)
    })

    it("is stored at EEPROM byte 0x40", () => {
      expect(eeprom.snapshot().bytes[0x40]).toBe(c1)
    })

    it("has still no HAL errors or unmodelled features", () => {
      expect.soft(word("errors"), "HAL errors").toBe(0)
      expect.soft(mcu.unmodelled.summary(), "unmodelled").toHaveLength(0)
    })
  })
})
