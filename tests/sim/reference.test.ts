import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { elementTerminals, terminalName } from "@/schematic/terminals"
import type { Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { flippedWithWires } from "@/schematic/rubber-band"
import { wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"

const def = (id: string) => getDef(id)!

function reading(doc: Schematic, object: string) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  for (let clock = 0; clock <= 200; clock += 20) loop.advance(clock)
  return loop.snapshot()!.readings.find((r) => r.object === object && r.element === 0)!
}

function divider(highSide: "1" | "2") {
  const { doc, place, wire } = builder(GRID)
  const bat = place("dc-source", 0, 0, { value: "5 V" })
  const r = place("resistor", 6, 0, { value: "1 kΩ" })
  const gnd = place("ground", 3, 4)
  wire(bat, "+", r, highSide)
  wire(r, highSide === "1" ? "2" : "1", gnd, "GND")
  wire(bat, "-", gnd, "GND")
  return { doc, r }
}

describe("a two-terminal part reads its current and voltage from pin 1 to pin 2, the way a SPICE symbol does", () => {
  it("each passive element names the pins its reference runs between", () => {
    expect(elementTerminals(def("resistor"), 0)!.map(terminalName)).toEqual(["1", "2"])
    expect(elementTerminals(def("potentiometer"), 0)!.map(terminalName)).toEqual(["1", "W"])
    expect(elementTerminals(def("potentiometer"), 1)!.map(terminalName)).toEqual(["W", "2"])
    expect(elementTerminals(def("diode"), 0)!.map(terminalName)).toEqual(["A", "K"])
    expect(elementTerminals(def("switch"), 0)!.map(terminalName)).toEqual(["1", "2"])
    expect(elementTerminals(def("npn"), 0)).toBeNull()
  })

  it("with pin 1 on the supply the current reads positive, fed the other way round negative", () => {
    const forward = divider("1")
    const backward = divider("2")
    const a = reading(forward.doc, forward.r.id)
    const b = reading(backward.doc, backward.r.id)
    expect(a.current * 1e3).toBeNear(5, 0.01)
    expect(a.voltage).toBeNear(5, 0.01)
    expect(b.current * 1e3).toBeNear(-5, 0.01)
    expect(b.voltage).toBeNear(-5, 0.01)
  })

  it("mirroring a part does not rewire it: its wires follow its pins, the same pin stays on the supply, and the readings keep their sign (phase 4, design.md §6.6, §13.17)", () => {
    const { doc, r } = divider("1")
    const mirrored = flippedWithWires(doc, wiringOf(new WireGraph(), doc), new Set([r.id]), "horizontal").doc
    expect.soft(mirrored.objects.find((o) => o.id === r.id)?.mirror, "the resistor is mirrored").toBe(true)
    const a = reading(mirrored, r.id)
    expect.soft(a.current * 1e3, "pin 1 still on the supply: +5 mA").toBeNear(5, 0.01)
    expect.soft(a.voltage, "and +5 V").toBeNear(5, 0.01)
  })
})
