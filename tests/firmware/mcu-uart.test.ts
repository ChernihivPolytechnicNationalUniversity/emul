/**
 * USART: firmware/hal/Src/uart.c on the F429 model; what USART3 sends on PD8 at 115200 8N1 is
 * decoded, and bytes fed into PD9 are received under interrupt and echoed.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { buffer, hal } from "../lib/firmware"

const TX = parsePad("PD8")!
const RX = parsePad("PD9")!
const BAUD = 115200
const BIT = 1 / BAUD

describe("USART3 on the F429", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("uart.elf")), "uart.elf")
  const word = (name: string) => mcu.bus.read32(mcu.firmware!.symbols.find((s) => s.name === name)!.value)

  const decoded: string[] = []
  let rxState: "idle" | "data" = "idle"
  let rxT = 0
  let rxByte = 0
  let rxBit = 0
  let lastTx = true
  function watchTx() {
    const level = mcu.padDrive(TX) !== "low"
    const t = mcu.time
    if (rxState === "idle") {
      if (lastTx && !level) {
        rxState = "data"
        rxT = t + BIT * 1.5
        rxByte = 0
        rxBit = 0
      }
    } else if (t >= rxT) {
      if (rxBit < 8) {
        if (level) rxByte |= 1 << rxBit
        rxBit++
        rxT += BIT
      } else {
        if (!level) decoded.push("<framing error>")
        else decoded.push(String.fromCharCode(rxByte))
        rxState = "idle"
      }
    }
    lastTx = level
  }
  function run(seconds: number, step = BIT / 8) {
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) {
      if (!mcu.run(step)) break
      watchTx()
    }
  }
  function send(byte: number) {
    const bits = [false, ...Array.from({ length: 8 }, (_, i) => ((byte >>> i) & 1) === 1), true]
    for (const b of bits) {
      mcu.setPad(RX, b)
      run(BIT)
    }
  }

  describe("after boot", () => {
    beforeAll(() => {
      mcu.setPad(RX, true)
      run(0.003)
    })

    it("keeps the core running", () => {
      expect(mcu.cpu.halted?.message).toBeUndefined()
      expect(mcu.running).toBe(true)
    })

    it("sets BRR from the HAL", () => {
      // USARTDIV = 45 MHz / (16 × 115200) = 24.41 → BRR = 24.41 × 16 = 391 (0x187): 115 090 baud, 0.1 % off.
      expect(mcu.usart.find((u) => u.spec.name === "USART3")!.get("BRR")).toBe(391)
    })

    it("idles PD8 high (TX claimed)", () => {
      expect(mcu.padDrive(TX) ?? "float").toBe("high")
    })
  })

  describe("transmit: 'tick N' lines at 115200", () => {
    beforeAll(() => run(0.25))

    it("sends the first lines", () => {
      expect(decoded.join("").split("\r\n").slice(0, 3).join("|")).toBe("tick 0|tick 1|tick 2")
    })

    it("has no framing errors", () => {
      expect(decoded.filter((c) => c.startsWith("<")).length).toBe(0)
    })

    it("counts as many bytes as were decoded", () => {
      expect(word("txCount")).toBe(decoded.length)
    })
  })

  describe("receive under interrupt, echo upper-cased", () => {
    it("echoes a single 'a' as 'A'", () => {
      decoded.length = 0
      send(0x61)
      run(BIT * 12)
      expect.soft(word("rxCount"), "rxCount").toBe(1)
      expect.soft(word("lastRx"), "lastRx").toBe(0x61)
      expect.soft(decoded.join("")).toBe("A")
    })

    it("echoes 'hello' as 'HELLO'", () => {
      decoded.length = 0
      for (const c of "hello") send(c.charCodeAt(0))
      run(BIT * 12)
      expect.soft(word("rxCount"), "rxCount").toBe(6)
      expect.soft(decoded.join("").replace(/tick \d+\r\n/g, "")).toBe("HELLO")
      expect.soft(word("rxErrors"), "rxErrors").toBe(0)
    })
  })

  it("counts a 0 stop bit as a framing error, not data", () => {
    mcu.setPad(RX, false)
    run(BIT * 10)
    mcu.setPad(RX, true)
    run(BIT * 12)
    expect(word("rxErrors")).toBe(1)
  })
})
