/**
 * The "Nucleo serial console" example: USART3 at 115200 through the VCP pins into the serial
 * terminal, decoded from exact-time edges despite the 20 µs analog step; text typed into the
 * terminal reaches the firmware and comes back echoed + 1.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoSerial } from "@/schematic/examples"
import { pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

type Core = { bus: { read32: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } }

describe("Nucleo serial console", () => {
  const doc = nucleoSerial.build(GRID)
  const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
  const term = doc.objects.find((o) => o.def === "serial-terminal")!
  u.props = { ...u.props, firmware: "nucleo-uart.elf", firmwareData: exampleBase64("nucleo-uart.elf") }

  const loop = new SimLoop()
  let clock = 0
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
  }
  const text = () => loop.snapshot()!.terminals[term.id].text
  const echoed = () => text().replace(/tick \d+\r\n/g, "")
  const core = () => (loop as unknown as { mcus: Map<string, { mcu: { mcu: Core } }> }).mcus.get(u.id)!.mcu.mcu
  const rxCount = () => {
    const mcu = core()
    return mcu.bus.read32(mcu.firmware.symbols.find((x) => x.name === "rxCount")!.value)
  }

  describe("after boot", () => {
    let snap: Snapshot
    beforeAll(() => {
      loop.setDoc(doc)
      loop.setParts(doc.parts)
      loop.setRunning(true)
      loop.advance(clock)
      run(0.35)
      snap = loop.snapshot()!
    })

    it("runs the core", () => expect(snap.mcus[u.id].running).toBe(true))
    it("idles the VCP TX pin high", () => expect(snap.pinVoltage[pinKey(u.id, "VCP-TX")]).toBeGreaterThan(3))
    it("shows the ticks in the terminal", () => expect(text().split("\r\n").slice(0, 3).join("|")).toBe("tick 0|tick 1|tick 2"))
    it("has no framing errors", () => expect(snap.terminals[term.id].framingErrors).toBe(0))
  })

  describe("typing into the terminal", () => {
    let snap: Snapshot
    beforeAll(() => {
      loop.sendSerial(term.id, "hi")
      run(0.12)
      snap = loop.snapshot()!
    })

    it("echoes 'hi' upper-cased", () => expect(echoed().slice(-2)).toBe("HI"))
    it("brings the terminal TX pin back high", () => expect(snap.pinVoltage[pinKey(term.id, "TX")]).toBeGreaterThan(3))
  })

  describe("non-ASCII goes out as UTF-8 bytes (and CP1251 when asked)", () => {
    it("sends 'Привет' as 12 bytes in UTF-8 and gets it back readable", () => {
      const before = rxCount()
      loop.sendSerial(term.id, "Привет")
      run(0.03)
      expect(rxCount() - before).toBe(12)
      expect(echoed().slice(-6)).toBe("Привет")
    })

    it("decodes the firmware's own UTF-8 line", () => {
      run(0.7)
      expect(text()).toMatch(/Крок 9\r\n/)
    })

    it("sends 'Привет' as 6 bytes in CP1251", () => {
      term.props = { ...term.props, charset: "windows-1251" }
      loop.setDoc(doc)
      const before = rxCount()
      loop.sendSerial(term.id, "Привет")
      run(0.03)
      expect(rxCount() - before).toBe(6)
      term.props = { ...term.props, charset: "utf-8" }
      loop.setDoc(doc)
    })
  })

  it("reads a baud mismatch as garbage, not silence", () => {
    term.props = { ...term.props, baud: "9600" }
    loop.setDoc(doc)
    run(0.25)
    expect(text().slice(-40)).not.toMatch(/tick \d+\r\n$/)
  })
})
