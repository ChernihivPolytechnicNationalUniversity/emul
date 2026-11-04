import { describe, expect, it } from "vitest"
import { runsOf } from "@/schematic/circuit"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import { wirePins } from "@/schematic/migrate-wires"
import type { PlacedObject } from "@/schematic/types"
import { runPath, turnsAtPins } from "@/schematic/wire-look"
import type { WireSegment } from "@/schematic/wires/segment"

const c = (v: number) => v * GRID
const resistor = (id: string, x: number, y: number, rotation?: 90 | 180 | 270): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), ...(rotation && { rotation }) })
const pinAt = (o: PlacedObject, pin: string) => objectPins(o, GRID).find((p) => p.pin.id === pin)!.point
const seg = (id: string, a: Point, b: Point): WireSegment => ({ id, a, b })
const LEAD = 0.3 * GRID

function look(objects: PlacedObject[], wires: WireSegment[]) {
  const pins = wirePins(objects)
  return turnsAtPins(runsOf(wires, pins), pins)
}

describe("a wire turning at a pin is drawn with a rounded corner taking the lead's last 0.3 cell (design.md §8)", () => {
  it("a wire leaving a pin sideways turns on the lead, 0.3 cell back inside it", () => {
    const r = resistor("R1", 0, 0)
    const p = pinAt(r, "2")
    const { leads } = look([r], [seg("w", p, { x: p.x, y: p.y + c(3) })])
    const lead = leads.get("w")
    const end = lead?.start ?? lead?.end
    expect.soft(end, "a lead at the pin").toEqual({ x: p.x - LEAD, y: p.y })
  })

  it("on a part turned a quarter, the lead runs along the turned pin", () => {
    const r = resistor("R1", 0, 0, 90)
    const top = [pinAt(r, "1"), pinAt(r, "2")].sort((a, b) => a.y - b.y)[0]
    const { leads } = look([r], [seg("w", top, { x: top.x + c(3), y: top.y })])
    const lead = leads.get("w")
    expect.soft(lead?.start ?? lead?.end, "0.3 cell down the lead").toEqual({ x: top.x, y: top.y + LEAD })
  })

  it("a wire leaving a pin straight out has no lead to round, nor has a pin where a dot is", () => {
    const r = resistor("R1", 0, 0)
    const p = pinAt(r, "2")
    expect.soft(look([r], [seg("w", p, { x: p.x + c(3), y: p.y })]).leads.size, "straight out").toBe(0)
    const branched = look([r], [seg("a", p, { x: p.x, y: p.y + c(3) }), seg("b", p, { x: p.x, y: p.y - c(3) })])
    expect.soft(branched.leads.size, "a dot on the pin").toBe(0)
  })

  it("two pins butted at a right angle with no wire there are drawn as one corner; butted head to head, as a straight lead", () => {
    const a = resistor("A", 0, 0)
    const pa = pinAt(a, "2")
    const probe = resistor("B", 0, 0, 90)
    const top = [pinAt(probe, "1"), pinAt(probe, "2")].sort((x, y) => x.y - y.y)[0]
    const b: PlacedObject = { ...probe, x: probe.x + pa.x - top.x, y: probe.y + pa.y - top.y }
    const { corners } = look([a, b], [])
    expect.soft(corners.length, "one corner").toBe(1)
    expect.soft(corners[0]?.at, "at the pins").toEqual(pa)
    const facing = resistor("C", 0, 0)
    const c1 = pinAt(facing, "1")
    const head: PlacedObject = { ...facing, x: facing.x + pa.x - c1.x, y: facing.y + pa.y - c1.y }
    expect.soft(look([a, head], []).corners, "head to head").toEqual([])
  })

  it("the path starts on the lead, bends through the pin and runs on along the wire", () => {
    const path = runPath([{ x: 0, y: 0 }, { x: 0, y: 48 }], 6, { start: { x: -7.2, y: 0 } })
    expect.soft(path.startsWith("M-7.2 0 Q0 0 0 6"), path).toBe(true)
    expect.soft(path.endsWith("48"), path).toBe(true)
    expect.soft(runPath([{ x: 0, y: 0 }, { x: 0, y: 48 }], 6), "no leads: the plain polyline").toBe("M0 0 L0 48")
  })
})
