/**
 * A bare PIC16F628A on the bench: +5 V into VDD, 10 kΩ from MCLR to +5 V, an LED through 220 Ω on
 * RB3, a serial terminal on RB1/RX and RB2/TX. The firmware (firmware/pic/examples/blink.c, its
 * configuration word from the HEX image: INTOSC, PWRT, MCLR on) toggles the LED every 0.5 s from
 * Timer1, prints a tick a second at 9600 baud and echoes what is typed upper-cased. Then the bench
 * is changed the way a student would: MCLR pulled low, the supply dropped.
 */
import { beforeAll, describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { getDef } from "@/schematic/registry"
import { pinKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { exampleBase64 } from "../lib/firmware"

function bench() {
  const { doc, place, wire } = builder(GRID)
  const chip = getDef("pic16f628a")!
  const y = (pin: string) => chip.pins.find((p) => p.id === pin)!.y
  const R = chip.width
  const dd = place("pic16f628a", 0, 0, { firmware: "pic-blink.hex", firmwareData: exampleBase64("pic-blink.hex") })
  const v5 = place("supply", -9, y("VDD") - 3, { value: "+5V", voltage: "5 V" })
  const gnd = place("ground", -9, y("VSS") + 2)
  wire(v5, "V", dd, "VDD")
  wire(dd, "VSS", gnd, "GND")
  const rr = place("resistor", -8, y("RA5") - 1, { ref: "R1", value: "10 kΩ", power: "0.25" }, 90)
  wire(dd, "RA5", rr, "2")
  wire(rr, "1", v5, "V")
  const led = place("led", R + 12, y("RB3") - 1, { value: "red", imax: "20 mA" })
  const r2 = place("resistor", R + 5, y("RB3") - 1, { ref: "R2", value: "220 Ω", power: "0.25" })
  const g2 = place("ground", R + 18, y("RB3"))
  wire(dd, "RB3", r2, "1")
  wire(r2, "2", led, "1")
  wire(led, "2", g2, "GND")
  const term = place("serial-terminal", R + 6, y("RB1") - 1, { baud: "9600" })
  wire(dd, "RB2", term, "RX")
  wire(dd, "RB1", term, "TX")
  return { doc, dd, term, led, rr, v5 }
}

function run(loop: SimLoop, state: { clock: number }, seconds: number) {
  const end = state.clock + seconds * 1000
  while (state.clock < end) {
    state.clock = Math.min(end, state.clock + 30)
    loop.advance(state.clock)
  }
}
function start(doc: ReturnType<typeof bench>["doc"]) {
  const loop = new SimLoop()
  const state = { clock: 0 }
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  loop.advance(0)
  return { loop, state }
}

describe("PIC16F628A on the bench: INTOSC, LED, serial terminal", () => {
  const b = bench()
  const { loop, state } = start(b.doc)
  const rb3 = () => loop.snapshot()!.pinVoltage[pinKey(b.dd.id, "RB3")]

  beforeAll(() => run(loop, state, 2.4))

  it("runs at 4 MHz on the internal oscillator, with the HEX image's configuration word", () => {
    const st = loop.snapshot()!.mcus[b.dd.id]
    expect(st.halted).toBe(null)
    expect(st.running).toBe(true)
    expect(st.sysclk).toBe(4e6)
    expect(st.labels?.clock).toMatch(/internal 4 MHz/)
    expect(st.unmodelled).toEqual([])
  })

  it("prints a tick a second at 9600 baud without framing errors", () => {
    const t = loop.snapshot()!.terminals[b.term.id]
    expect(t.text).toMatch(/^tick 0\r\ntick 1\r\n/)
    expect(t.framingErrors).toBe(0)
  })

  it("blinks the LED: RB3 spends about half of each second high", () => {
    let high = 0
    let n = 0
    for (let i = 0; i < 100; i++) {
      run(loop, state, 0.01)
      n++
      if (rb3() > 2.5) high++
    }
    expect(high / n).toBeGreaterThan(0.3)
    expect(high / n).toBeLessThan(0.7)
  })

  it("echoes typed text upper-cased", () => {
    loop.sendSerial(b.term.id, "pic")
    run(loop, state, 0.05)
    expect(loop.snapshot()!.terminals[b.term.id].text.replace(/tick \d+\r\n/g, "")).toBe("PIC")
  })

  it("MCLR pulled low holds the part; released, it restarts with an MCLR reset (§14.3)", () => {
    const before = loop.snapshot()!.mcus[b.dd.id].resets
    const doc = structuredClone(b.doc)
    const gnd = doc.objects.find((o) => o.def === "ground")!
    doc.wires = doc.wires.map((w) => (w.from.object === b.dd.id && w.from.pin === "RA5" ? { ...w, to: { object: gnd.id, pin: "GND" } } : w))
    loop.setDoc(doc)
    run(loop, state, 0.05)
    const held = loop.snapshot()!.mcus[b.dd.id]
    expect(held.labels?.power).toBe("in reset")
    run(loop, state, 0.05)
    expect(loop.snapshot()!.mcus[b.dd.id].instructions).toBe(held.instructions)
    loop.setDoc(b.doc)
    run(loop, state, 0.2)
    const st = loop.snapshot()!.mcus[b.dd.id]
    expect(st.labels?.power).toBe("active")
    expect(st.resets).toBeGreaterThan(before)
    expect(st.labels?.reset).toBe("MCLR")
  })
})

describe("13 V on MCLR/VPP", () => {
  it("enters Program/Verify mode (RB6/RB7 low): the program stops, the programming module waits for commands on RB6/RB7", () => {
    const b = bench()
    // RB6 and RB7 to ground, MCLR to a 13 V supply instead of through R1 to +5 V.
    const gnd = b.doc.objects.find((o) => o.def === "ground")!
    const vpp = { id: "vpp", def: "supply", x: -20, y: 0, rotation: 0, props: { value: "VPP", voltage: "13 V" } }
    b.doc.objects.push(vpp as (typeof b.doc.objects)[number])
    b.doc.wires = b.doc.wires.filter((w) => !(w.from.object === b.dd.id && w.from.pin === "RA5") && !(w.to.object === b.dd.id && w.to.pin === "RA5"))
    b.doc.wires.push(
      { id: "w-vpp", from: { object: b.dd.id, pin: "RA5" }, to: { object: "vpp", pin: "V" }, points: [] } as (typeof b.doc.wires)[number],
      { id: "w-rb6", from: { object: b.dd.id, pin: "RB6" }, to: { object: gnd.id, pin: "GND" }, points: [] } as (typeof b.doc.wires)[number],
      { id: "w-rb7", from: { object: b.dd.id, pin: "RB7" }, to: { object: gnd.id, pin: "GND" }, points: [] } as (typeof b.doc.wires)[number],
    )
    const { loop, state } = start(b.doc)
    run(loop, state, 0.2)
    const st = loop.snapshot()!.mcus[b.dd.id]
    expect(st.labels?.power).toBe("Program/Verify mode")
    expect(st.unmodelled).toEqual([])
  })
})
