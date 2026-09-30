import { describe, expect, it } from "vitest"
import { referenceArrow } from "@/components/field/pin-label"
import { builder } from "@/schematic/builder"
import { flipSelection } from "@/schematic/orient"
import { flipped, GRID, orientPin, UPRIGHT, type Orientation } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { elementTerminals, referenceTerminals, terminalName } from "@/schematic/terminals"
import type { Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"

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

  it("only a part that is one element between its two pins gets an arrow on the field", () => {
    for (const id of ["resistor", "capacitor", "inductor", "switch", "pushbutton", "led"]) expect(referenceTerminals(def(id)), id).not.toBeNull()
    for (const id of ["potentiometer", "crystal", "transformer", "open746i-c"]) expect(referenceTerminals(def(id)), id).toBeNull()
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

  it("mirroring a part does not rewire it: the same pin stays on the supply, so the readings keep their sign", () => {
    const { doc, r } = divider("1")
    const mirrored = flipSelection(doc, new Set([r.id]), "horizontal", GRID)
    expect(reading(mirrored, r.id).current).toBeCloseTo(reading(doc, r.id).current, 9)
  })
})

describe("the reference arrow sits beside pin 1 and points at pin 2", () => {
  const resistor = def("resistor")
  const arrowOf = (o: Orientation) => {
    const [a, b] = resistor.pins.map((pin) => orientPin(pin, resistor, o))
    return { arrow: referenceArrow(a, b, 0.3)!, a, b }
  }

  it("upright it runs left to right above the lead, clear of the body and of the pin number", () => {
    const { arrow, a } = arrowOf(UPRIGHT)
    const [tail, tip] = arrow
    expect(tip.x).toBeGreaterThan(tail.x)
    expect(tail.y).toBeCloseTo(tip.y)
    expect(tail.y).toBeLessThan(0)
    expect(tail.x).toBeGreaterThan(0.09)
    expect(a.x + tip.x).toBeLessThan(1)
  })

  it("mirrored it runs right to left, from wherever pin 1 went", () => {
    const { arrow, a, b } = arrowOf(flipped(UPRIGHT, "horizontal"))
    expect(a.x).toBeGreaterThan(b.x)
    expect(arrow[1].x).toBeLessThan(arrow[0].x)
  })

  it("stood on its side it runs down the part, beside it", () => {
    const { arrow } = arrowOf({ rotation: 90, mirror: false })
    expect(arrow[1].y).toBeGreaterThan(arrow[0].y)
    expect(arrow[0].x).toBeCloseTo(arrow[1].x)
    expect(arrow[0].x).not.toBeCloseTo(0)
  })
})
