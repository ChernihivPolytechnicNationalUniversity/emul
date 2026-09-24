/**
 * Logic analyser: probes on the example circuits record exact-time edges, and the decoders
 * read the buses back — the serial console's "tick N" at 115200 (and the echo of what was
 * typed), the SPI link's 0xA0+n / 0x50+n exchange, the I²C EEPROM's page write — plus a
 * bit-banged square wave and a pulse source on a purely analog net.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { nucleoI2c, nucleoSerial, nucleoSpi, nucleoSquare } from "@/schematic/examples"
import { partKey, pinKey, type Schematic } from "@/schematic/types"
import { SimLoop, type Probe } from "@/sim/loop"
import { LogicStore } from "@/components/logic/logic-store"
import { decodeI2c, decodeSpi, decodeUart, type EdgeSeries } from "@/sim/protocols"
import { exampleBase64 as fw } from "../lib/firmware"

/** A loop with the analyser on and probes on the given pins; `run` collects the edges into a store. */
function analyse(doc: Schematic, probes: Probe[]) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setProbes(probes)
  loop.setLogic(true)
  loop.setRunning(true)
  const store = new LogicStore()
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 20)
      loop.advance(clock)
      const s = loop.snapshot()!
      if (s.logic) store.push(s.logic, s.traceProbes)
    }
  }
  const edges = (id: string): EdgeSeries => store.edges(id) ?? { times: new Float64Array(0), levels: new Uint8Array(0), count: 0, last: true }
  return { loop, store, run, edges }
}
const text = (values: number[]) => String.fromCharCode(...values)

describe("logic analyser", () => {
  it("decodes the serial console at 115200", () => {
    const doc = nucleoSerial.build(GRID)
    const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
    const term = doc.objects.find((o) => o.def === "serial-terminal")!
    u.props = { ...u.props, firmware: "nucleo-uart.elf", firmwareData: fw("nucleo-uart.elf") }
    const { loop, store, run, edges } = analyse(doc, [
      { id: "tx", a: pinKey(u.id, "VCP-TX"), b: null },
      { id: "rx", a: pinKey(u.id, "VCP-RX"), b: null },
    ])
    run(0.25)
    const tx = edges("tx")
    expect.soft(tx.count, "edges recorded on TX").toBeGreaterThan(100)
    const frames = decodeUart(tx, { baud: 115200 }, 0, store.end)
    const line = text(frames.map((f) => f.value!))
    expect.soft(line.slice(0, 16), "decoded text").toBe("tick 0\r\ntick 1\r\n")
    expect.soft(frames.filter((f) => f.kind === "error").length, "no framing errors").toBe(0)
    expect.soft((frames[0].end - frames[0].start) * 1e6, "a byte takes 10 bits (µs)").toBeNear(86.8, 0.1)
    // The wrong baud reads garbage, as it would on the bench.
    const wrong = text(decodeUart(tx, { baud: 9600 }, 0, store.end).map((f) => f.value!))
    expect.soft(wrong, "at 9600 it is garbage").not.toContain("tick")
    loop.sendSerial(term.id, "hi")
    run(0.05)
    const typed = decodeUart(edges("rx"), { baud: 115200 }, 0, store.end)
    expect.soft(text(typed.map((f) => f.value!)), "typed bytes on the terminal's TX").toBe("hi")
    const echoed = text(decodeUart(edges("tx"), { baud: 115200 }, 0, store.end).map((f) => f.value!))
    expect.soft(echoed, "echoed upper-cased on the MCU's TX").toContain("HI")
  })

  it("decodes the SPI master/slave link in mode 0 with chip select", () => {
    const doc = nucleoSpi.build(GRID)
    const [u1, u2] = doc.objects.filter((o) => o.def === "nucleo-f429zi")
    u1.props = { ...u1.props, firmware: "nucleo-spi-master.elf", firmwareData: fw("nucleo-spi-master.elf") }
    u2.props = { ...u2.props, firmware: "nucleo-spi-slave.elf", firmwareData: fw("nucleo-spi-slave.elf") }
    const { store, run, edges } = analyse(doc, [
      { id: "sck", a: pinKey(u1.id, "CN7-10"), b: null },
      { id: "miso", a: pinKey(u1.id, "CN7-12"), b: null },
      { id: "mosi", a: pinKey(u1.id, "CN7-14"), b: null },
      { id: "cs", a: pinKey(u1.id, "CN7-16"), b: null },
    ])
    run(0.06)
    const sck = edges("sck")
    expect.soft(sck.count, "clock edges recorded").toBeGreaterThan(64)
    const frames = decodeSpi(sck, edges("mosi"), edges("miso"), edges("cs"), { cpol: 0, cpha: 0 }, 0, store.end)
    const mosi = frames.filter((f) => f.channel === 0).map((f) => f.value!)
    const miso = frames.filter((f) => f.channel === 1).map((f) => f.value!)
    expect.soft(mosi.slice(0, 4).map((v) => v.toString(16)).join(" "), "MOSI bytes 0xA0+n").toBe("a0 a1 a2 a3")
    expect.soft(miso.slice(1, 4).map((v) => v.toString(16)).join(" "), "MISO bytes 0x50+n").toBe("51 52 53")
    expect.soft(frames.filter((f) => f.kind === "error").length, "no partial bytes").toBe(0)
    const periods = [...Array(sck.count).keys()].filter((i) => i >= 2 && sck.levels[i] === 1).map((i) => sck.times[i] - sck.times[i - 2]).sort((a, b) => a - b)
    expect.soft(periods[periods.length >> 1] * 1e9, "clock period ≈ 1/1.4 MHz (ns)").toBeNear(711, 5)
    // Without the chip select the byte boundaries come from the clock gaps.
    const free = decodeSpi(sck, edges("mosi"), null, null, { cpol: 0, cpha: 0 }, 0, store.end)
    expect.soft(free.slice(0, 3).map((f) => f.value!.toString(16)).join(" "), "bytes framed by clock gaps alone").toBe("a0 a1 a2")
    // The wrong mode samples on the other edge: the bytes come out shifted.
    const wrong = decodeSpi(sck, edges("mosi"), null, edges("cs"), { cpol: 0, cpha: 1 }, 0, store.end)
    expect.soft(wrong[0]?.value, "mode 1 reads it differently").not.toBe(0xa0)
  })

  it("decodes the I²C EEPROM page write and read-back", () => {
    const doc = nucleoI2c.build(GRID)
    const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
    u.props = { ...u.props, firmware: "nucleo-i2c.elf", firmwareData: fw("nucleo-i2c.elf") }
    const { store, run, edges } = analyse(doc, [
      { id: "sda", a: pinKey(u.id, "CN7-4"), b: null },
      { id: "scl", a: pinKey(u.id, "CN7-2"), b: null },
    ])
    run(0.1)
    const frames = decodeI2c(edges("sda"), edges("scl"), 0, store.end)
    const items = frames.map((f) => f.text)
    expect.soft(items.slice(0, 3).join(" | "), "the HAL's device-ready check").toBe("S | 0x50 W A | P")
    expect.soft(items.slice(3, 15).join(" | "), "first page write (8 bytes)").toBe("S | 0x50 W A | 0x00 A | 0x48 'H' A | 0x65 'e' A | 0x6C 'l' A | 0x6C 'l' A | 0x6F 'o' A | 0x2C ',' A | 0x20 ' ' A | 0x45 'E' A | P")
    expect.soft(items, "acknowledge polling: a NACK while the EEPROM writes").toContain("0x50 W N")
    expect.soft(items.some((s, i) => s === "0x50 R A" && items[i - 1] === "Sr"), "a read: repeated start, address with R").toBe(true)
    const scl = edges("scl")
    const gaps = [...Array(scl.count).keys()].filter((i) => scl.levels[i] === 1 && i >= 2).map((i) => scl.times[i] - scl.times[i - 2]).sort((a, b) => a - b)
    expect.soft(gaps[gaps.length >> 1] * 1e6, "SCL period ≈ 10 µs (100 kHz)").toBeNear(10, 0.5)
  })

  it("times a bit-banged square wave and a pulse source on an analog net", () => {
    const doc = nucleoSquare.build(GRID)
    const u = doc.objects.find((o) => o.def === "nucleo-f429zi")!
    u.props = { ...u.props, firmware: "nucleo-square.elf", firmwareData: fw("nucleo-square.elf") }
    // A 1 kHz pulse source into a resistor: nothing digital on that net, the analyser thresholds the voltage.
    const extra = builder(GRID)
    const g = extra.place("pulse-source", 60, 10, { high: "3.3 V", low: "0 V", freq: "1 kHz", duty: "25" })
    const r = extra.place("resistor", 66, 12, { value: "1 kΩ" })
    const gnd = extra.place("ground", 72, 14)
    extra.wire(g, "+", r, "1")
    extra.wire(r, "2", gnd, "GND")
    extra.wire(g, "-", gnd, "GND")
    doc.objects.push(...extra.doc.objects)
    doc.wires.push(...extra.doc.wires)
    const { run, edges } = analyse(doc, [
      { id: "d13", a: pinKey(u.id, "CN7-10"), b: null },
      { id: "gen", a: pinKey(r.id, "1"), b: null },
    ])
    run(0.05)
    const d13 = edges("d13")
    const periods: number[] = []
    for (let i = 3; i < d13.count; i += 2) periods.push(d13.times[i] - d13.times[i - 2])
    const mean = periods.reduce((a, b) => a + b, 0) / periods.length
    expect.soft(mean * 1e6, "D13 period from exact edges (µs)").toBeNear(1000, 1)
    expect.soft(Math.max(...periods.map((p) => Math.abs(p - mean))) * 1e6, "edge jitter below 1 µs").toBeLessThan(1)
    const gen = edges("gen")
    const rise = [...Array(gen.count).keys()].filter((i) => gen.levels[i] === 1).map((i) => gen.times[i])
    expect.soft((rise[5] - rise[4]) * 1e6, "pulse source period, thresholded per 20 µs step (µs)").toBeNear(1000, 25)
    const fall = [...Array(gen.count).keys()].filter((i) => gen.levels[i] === 0).map((i) => gen.times[i])
    const high = fall.find((t) => t > rise[4])! - rise[4]
    expect.soft(high * 1e6, "25 % duty (µs high)").toBeNear(250, 25)
  })

  it("sees a button bounce on press and release only when bounce is on", () => {
    const edgesOf = (bounce: string) => {
      const { doc, place, wire } = builder(GRID)
      const bat = place("dc-source", 0, 0, { value: "3.3 V" })
      const r = place("resistor", 6, 0, { value: "10 kΩ" })
      const sw = place("pushbutton", 12, 0, { bounce })
      const gnd = place("ground", 3, 6)
      wire(bat, "+", r, "1")
      wire(r, "2", sw, "1")
      wire(sw, "2", gnd, "GND")
      wire(bat, "-", gnd, "GND")
      const { loop, run, edges } = analyse(doc, [{ id: "in", a: pinKey(sw.id, "1"), b: null }])
      run(0.02)
      const idle = edges("in").count
      loop.setParts({ [partKey(sw.id, "SW")]: { pressed: true } })
      run(0.05)
      const at = edges("in").count
      const pressed = at - idle
      loop.setParts({ [partKey(sw.id, "SW")]: { pressed: false } })
      run(0.05)
      const e = edges("in")
      const span = (from: number, to: number) => e.times[to - 1] - e.times[from]
      return { pressed, released: e.count - at, last: e.levels[e.count - 1], pressSpan: span(idle, at), releaseSpan: span(at, e.count) }
    }
    const off = edgesOf("off")
    expect.soft(off.pressed, "off: one edge on press").toBe(1)
    expect.soft(off.released, "off: one edge on release").toBe(1)
    const on = edgesOf("on")
    expect.soft(on.pressed, "on: a burst on press").toBeGreaterThan(1)
    expect.soft(on.released, "on: a burst on release").toBeGreaterThan(1)
    expect.soft(on.pressed % 2, "on: settles low after the press").toBe(1)
    expect.soft(on.last, "on: settles high after the release").toBe(1)
    expect.soft(on.pressSpan * 1e3, "press burst within 5 ms").toBeLessThanOrEqual(5)
    expect.soft(on.releaseSpan * 1e3, "release burst within 5 ms").toBeLessThanOrEqual(5)
  })
})
