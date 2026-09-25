/**
 * The "Nucleo SPI link" example co-simulated: two cores in lockstep, the SPI1 master on U1
 * clocking bytes into the SPI4 slave on U2 over the field's wires, and the slave's replies
 * coming back within the same frame.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { nucleoSpi } from "@/schematic/examples"
import { pinKey } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

type Core = { mcu: { bus: { read32: (a: number) => number; read8: (a: number) => number }; firmware: { symbols: { name: string; value: number }[] } } }

describe("Nucleo SPI link", () => {
  const doc = nucleoSpi.build(GRID)
  const u1 = doc.objects.find((o) => o.props?.ref === "U1")!
  const u2 = doc.objects.find((o) => o.props?.ref === "U2")!
  u1.props = { ...u1.props, firmware: "nucleo-spi-master.elf", firmwareData: exampleBase64("nucleo-spi-master.elf") }
  u2.props = { ...u2.props, firmware: "nucleo-spi-slave.elf", firmwareData: exampleBase64("nucleo-spi-slave.elf") }

  const loop = new SimLoop()
  const core = (id: string) => (loop as unknown as { mcus: Map<string, { mcu: Core }> }).mcus.get(id)!.mcu.mcu
  const sym = (c: ReturnType<typeof core>, name: string) => c.firmware.symbols.find((x) => x.name === name)!.value
  const word = (c: ReturnType<typeof core>, name: string) => c.bus.read32(sym(c, name))
  const log = (c: ReturnType<typeof core>, n: number) => Array.from({ length: n }, (_, i) => c.bus.read8(sym(c, "rxLog") + i).toString(16)).join(" ")
  let snap: Snapshot
  let m: ReturnType<typeof core>
  let s: ReturnType<typeof core>

  beforeAll(() => {
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    let clock = 0
    loop.advance(clock)
    while (clock < 100) {
      clock = Math.min(100, clock + 30)
      loop.advance(clock)
    }
    snap = loop.snapshot()!
    m = core(u1.id)
    s = core(u2.id)
  })

  it("runs both cores with nothing unmodelled", () => {
    expect(snap.mcus[u1.id].running, "master").toBe(true)
    expect(snap.mcus[u2.id].running, "slave").toBe(true)
    expect(snap.mcus[u1.id].unmodelled.length + snap.mcus[u2.id].unmodelled.length).toBe(0)
  })

  it("moves every byte the master sends", () => {
    expect.soft(word(m, "count"), "bytes sent by the master").toBeNear(9, 1)
    expect.soft(word(s, "count"), "bytes received by the slave").toBe(word(m, "count"))
    expect.soft(word(m, "errors"), "master HAL errors").toBe(0)
    expect.soft(word(s, "errors"), "slave HAL errors").toBe(0)
  })

  it("logs the same bytes on both sides", () => {
    expect.soft(log(s, 6), "slave's log").toBe("a0 a1 a2 a3 a4 a5")
    expect.soft(log(m, 6), "master's log").toBe("50 51 52 53 54 55")
  })

  it("idles SCK low and chip select high on the wires", () => {
    expect.soft(snap.pinVoltage[pinKey(u1.id, "CN7-10")], "SCK").toBeLessThan(0.5)
    expect.soft(snap.pinVoltage[pinKey(u2.id, "CN9-16")], "chip select").toBeGreaterThan(3)
  })
})
