/**
 * DMA: firmware/hal/Src/dma.c on the F429 model — a memory-to-memory copy, USART3 transmit and
 * receive through DMA1 with the HAL's interrupt chain, and a TIM3-paced circular stream toggling
 * PB7 through GPIOB->BSRR with no CPU involved.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { Stm32F429, parsePad } from "@/mcu/stm32f429"
import { UartDecoder, uartFrameEdges } from "@/sim/serial"
import { buffer, hal } from "../lib/firmware"

const TX = parsePad("PD8")!
const RX = parsePad("PD9")!
const LD2 = parsePad("PB7")!
const BAUD = 115200
const key = (p: { port: number; pin: number }) => p.port * 16 + p.pin

describe("DMA on the F429", () => {
  const mcu = new Stm32F429()
  mcu.load(buffer(hal("dma.elf")), "dma.elf")
  mcu.digitalWatch.add(key(LD2))
  const sym = (name: string) => mcu.firmware!.symbols.find((s) => s.name === name)!.value
  const word = (name: string) => mcu.bus.read32(sym(name))

  const decoder = new UartDecoder(BAUD)
  const ld2Edges: number[] = []
  function run(seconds: number) {
    const end = mcu.time + seconds
    while (mcu.time < end && mcu.running) {
      if (!mcu.runUntil(end)) break
      for (const e of mcu.digitalOut) {
        if (key(e.pad) === key(TX)) decoder.edge({ time: e.time, level: e.level !== false })
        else if (key(e.pad) === key(LD2)) ld2Edges.push(e.time)
      }
      mcu.digitalOut.length = 0
      decoder.poll(mcu.time)
    }
  }
  const text = () => String.fromCharCode(...decoder.bytes)

  describe("memory to memory, then the first DMA line", () => {
    beforeAll(() => {
      mcu.setPad(RX, true)
      run(0.03)
    })

    it("keeps the core running", () => {
      expect(mcu.cpu.halted?.message).toBeUndefined()
      expect(mcu.running).toBe(true)
    })

    it("verifies the memory-to-memory copy", () => {
      expect(word("m2mOk")).toBe(1)
    })

    it("sends the first line by DMA", () => {
      expect.soft(text().split("\r\n")[0]).toBe("dma line 0 abcdefghijklmnopqrstuvwxy")
      expect.soft(word("txDone"), "TxCplt callbacks").toBe(1)
      expect.soft(word("errors"), "HAL errors").toBe(0)
    })
  })

  describe("timer-paced circular stream on PB7", () => {
    it("toggles PB7 at 100 Hz", () => {
      expect(ld2Edges.filter((t) => t > 0.01 && t < 0.03).length, "toggles in 20 ms").toBeNear(2, 1)
    })

    it("keeps lines coming and PB7 toggling every 10 ms", () => {
      run(0.25)
      expect.soft(word("txDone"), "lines every ~101 ms").toBeNear(3, 1)
      const intervals = ld2Edges
        .slice(-10)
        .map((t, i, a) => (i ? t - a[i - 1] : 0))
        .slice(1)
      expect.soft((intervals.reduce((a, b) => a + b, 0) / intervals.length) * 1e3, "toggle interval (ms)").toBeNear(10, 0.05)
    })
  })

  describe("receive by DMA: an 8-byte frame is echoed", () => {
    const frame = "ABCDEFGH"
    let before = 0
    beforeAll(() => {
      let at = mcu.time + 1e-3
      const edges = [...frame].flatMap((c) => {
        const e = uartFrameEdges(c.charCodeAt(0), at, BAUD)
        at += 10 / BAUD
        return e
      })
      for (const e of edges) mcu.setPadAt(RX, e.level, e.time)
      before = decoder.bytes.length
      run(0.12)
    })

    it("completes the receive", () => {
      expect(word("rxDone")).toBe(1)
    })

    it("lands the frame in rxBuf", () => {
      expect(String.fromCharCode(...Array.from({ length: 8 }, (_, i) => mcu.bus.read8(sym("rxBuf") + i)))).toBe(frame)
    })

    it("echoes it back through DMA", () => {
      expect(text().slice(before)).toContain(frame)
    })

    it("has still no HAL errors or unmodelled features", () => {
      expect.soft(word("errors"), "HAL errors").toBe(0)
      expect.soft(mcu.unmodelled.summary(), "unmodelled").toHaveLength(0)
    })
  })
})
