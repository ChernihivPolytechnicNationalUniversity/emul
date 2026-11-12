import { describe, expect, it } from "vitest"
import { bodiesOf } from "@/schematic/body-crossing"
import { runsOf } from "@/schematic/circuit"
import { labelsOnTheirWires, MONO_ADVANCE_EM, wiresAtPins } from "@/components/field/pin-label"
import { wirePins } from "@/schematic/migrate-wires"
import { examples } from "@/schematic/examples"
import { GRID, objectPins, type Point } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { DRAW_REFUSED, drawEndAt, drawnTo, isRefusal, pointerAt, startDrawing } from "@/schematic/wire-draw"
import { inNormalForm, wiringOf } from "@/schematic/wire-edits"
import { WireGraph } from "@/schematic/wires/graph"
import { routeBetween } from "@/schematic/wires/router"
import { cells } from "../lib/route-reference"

const c = (v: number) => v * GRID
const chip = (def: string, x = 0, y = 0): PlacedObject => ({ id: "U1", def, x: c(x), y: c(y), props: { ref: "U1" } })
const docOf = (objects: PlacedObject[]): Schematic => ({ objects, wires: [], parts: {} })
const pinCell = (o: PlacedObject, id: string) => {
  const p = objectPins(o, GRID).find((q) => q.pin.id === id)!.point
  return [p.x / GRID, p.y / GRID]
}

type Segment = { readonly a: Point; readonly b: Point }

function alongOutlines(objects: readonly PlacedObject[], segments: readonly Segment[]): string[] {
  const found: string[] = []
  for (const body of bodiesOf(objects)) {
    if (getDef(body.object.def)?.pinsAreSockets) continue
    for (const corners of body.contour)
      for (let i = 0; i < corners.length; i++) {
        const p = corners[i]
        const q = corners[(i + 1) % corners.length]
        const horizontal = p.y === q.y
        if (!horizontal && p.x !== q.x) continue
        for (const s of segments) {
          if ((s.a.y === s.b.y) !== horizontal) continue
          const gap = Math.abs(horizontal ? s.a.y - p.y : s.a.x - p.x)
          if (gap >= GRID / 4) continue
          const [lo, hi] = horizontal ? [Math.min(s.a.x, s.b.x), Math.max(s.a.x, s.b.x)] : [Math.min(s.a.y, s.b.y), Math.max(s.a.y, s.b.y)]
          const [elo, ehi] = horizontal ? [Math.min(p.x, q.x), Math.max(p.x, q.x)] : [Math.min(p.y, q.y), Math.max(p.y, q.y)]
          if (Math.min(hi, ehi) - Math.max(lo, elo) > GRID / 4) found.push(`${body.object.props?.ref ?? body.object.def}: (${s.a.x / GRID}, ${s.a.y / GRID})–(${s.b.x / GRID}, ${s.b.y / GRID}) ${(gap / GRID).toFixed(1)} cell off its outline`)
        }
      }
  }
  return found
}

const routeSegments = (route: readonly Point[] | null): Segment[] => (route ?? []).slice(1).map((b, i) => ({ a: route![i], b }))

describe("a route never runs along a part's drawn outline (design.md §4.1: «the lead a symbol draws is the stub»; §7: leaving a pin sideways is free only off the body — a quarter cell is on it to the eye; ГОСТ 2.701 / IEC 61082: lines do not run on symbols)", () => {
  it("TP4056's VCC to CE, two pins on its left edge with no drawn lead: out one cell, down, back in — not down the chip's edge", () => {
    const u = chip("tp4056")
    const doc = docOf([u])
    const route = routeBetween(doc, { pin: { object: "U1", pin: "VCC" } }, { pin: { object: "U1", pin: "CE" } })
    const [vx, vy] = pinCell(u, "VCC")
    const [, cy] = pinCell(u, "CE")
    expect.soft(alongOutlines([u], routeSegments(route)), "no piece along the outline").toEqual([])
    expect.soft(cells(route), "the U one cell out").toEqual([
      [vx, vy],
      [vx - 1, vy],
      [vx - 1, cy],
      [vx, cy],
    ])
  })

  it("an NE555's RESET to VCC, side by side on its top edge a tenth of a cell off the box: a U above, not along the edge", () => {
    const u = chip("ne555")
    const route = routeBetween(docOf([u]), { pin: { object: "U1", pin: "RESET" } }, { pin: { object: "U1", pin: "VCC" } })
    expect.soft(alongOutlines([u], routeSegments(route)), "no piece along the outline").toEqual([])
    expect.soft(route?.length, "two corners").toBe(4)
  })

  it("no example's wire runs along a part's outline (plan.md acceptance 5: it reads as a schematic)", () => {
    const found = examples.flatMap((example) => {
      const doc = example.build(GRID)
      return alongOutlines(doc.objects, doc.wires).map((f) => `${example.id} ${f}`)
    })
    expect.soft(found, "wires along outlines").toEqual([])
  })
})

describe("the completion runs on every pointer move (design.md §6.1, §11): a target nothing can enter is refused at once", () => {
  it("lab1-f746: R2's free pin to PB6, which already has its wire and pins either side, gives no route after reading the first window, not the 128-cell one", () => {
    const doc = examples.find((e) => e.id === "lab1-f746")!.build(GRID)
    const mcu = doc.objects.find((o) => o.def === "stm32f746ig")!
    const r2 = doc.objects.find((o) => o.props?.ref === "R2")!
    const wiring = wiringOf(new WireGraph(), doc)
    let lines = 0
    const along = wiring.sheet.along.bind(wiring.sheet)
    Object.assign(wiring.sheet, { along: (...args: Parameters<typeof along>) => (lines++, along(...args)) })
    const read = (pin: string) => {
      lines = 0
      const route = routeBetween(doc, { pin: { object: r2.id, pin: "1" } }, { pin: { object: mcu.id, pin } }, wiring)
      return { route: !!route, lines }
    }
    const free = read("PB8")
    const wired = read("PB6")
    expect.soft(free.route, "guard: PB8, free, is reached").toBe(true)
    expect.soft(wired.route, "PB6 cannot be entered but along its own wire: no route").toBe(false)
    expect.soft(wired.lines <= 2 * free.lines, `PB6 decided on about the window PB8 needed (${free.lines} rows and columns read), not by growing it to 128 cells (${wired.lines})`).toBe(true)
  })
})

describe("the row taken after the fact, when the passing wire cannot step aside (design.md §13.9; phase 6 hand-over question 7)", () => {
  it("drawing R1 to RESET while D45's wire passes it and both half-cell steps out of RESET's row are taken: refused in words that fit — not `over`, which tells the user to end the wire on the pin they are ending it on", () => {
    const at = (x: number, y: number) => ({ x: c(x), y: c(y) })
    const resistor = (id: string, x: number, y: number): PlacedObject => ({ id, def: "resistor", x: c(x), y: c(y), props: { ref: id } })
    const doc = inNormalForm({
      objects: [{ id: "U1", def: "nucleo-f429zi", x: 0, y: 0, props: { ref: "U1" } }, resistor("R4", -12, 18), resistor("R1", -6, 15)],
      wires: [
        { id: "d45", a: at(6, 19), b: at(-8, 19) },
        { id: "below", a: at(4, 19.5), b: at(7, 19.5) },
        { id: "above", a: at(4, 18.5), b: at(7, 18.5) },
      ],
      parts: {},
    })
    const wiring = wiringOf(new WireGraph(), doc)
    const started = startDrawing(wiring, drawEndAt(wiring, at(-2, 16)))
    if (isRefusal(started)) throw new Error(started.refused)
    const target = drawEndAt(wiring, at(5, 19))
    expect.soft(target.kind, "guard: RESET's socket is the target").toBe("pin")
    const result = drawnTo(doc, wiring, pointerAt(started, at(5, 19)), target)
    expect.soft(isRefusal(result) && result.refused !== "over", "refused, but not as passing over a pin").toBe(true)
    expect.soft(isRefusal(result) && result.refused, "refused as the socket another net's wire passes").toBe("socket")
    expect.soft(isRefusal(result) && DRAW_REFUSED[result.refused].why.includes("End the wire on the pin"), "the words do not ask for what the user just did").toBe(false)
  })
})

describe("the examples review B judged worse are tidied in their builder code, never by a special case in the router (phase 6's review fixes brief; plan.md acceptance 5)", () => {
  const runsIn = (id: string) => {
    const doc = examples.find((e) => e.id === id)!.build(GRID)
    const pins = wirePins(doc.objects)
    const name = (p: Point) => {
      const here = pins.filter((q) => q.at.x === p.x && q.at.y === p.y)
      if (!here.length) return "·"
      return here
        .map((pin) => {
          const object = doc.objects.find((o) => o.id === pin.key.slice(0, pin.key.indexOf(":")))
          return `${object?.props?.ref ?? object?.def}:${pin.key.slice(pin.key.indexOf(":") + 1)}`
        })
        .sort()
        .join("+")
    }
    return { doc, runs: runsOf(doc.wires, pins).map((r) => `${name(r.points[0])} ${name(r.points[r.points.length - 1])} ${JSON.stringify(cells(r.points))}`) }
  }
  const hasRun = (id: string, from: string, to: string, points: number[][]) => {
    const { runs } = runsIn(id)
    const want = [`${from} ${to} ${JSON.stringify(points)}`, `${to} ${from} ${JSON.stringify([...points].reverse())}`]
    expect.soft(runs.some((r) => want.includes(r)), `${id}: ${from} → ${to} as ${JSON.stringify(points)}; the runs: ${runs.filter((r) => r.includes(from) || r.includes(to)).join("; ")}`).toBe(true)
  }

  it("open746-touch: TERM1's TX into RXD round the top and down the names column, one turn into the socket — not along the USART1 jumper's row, over the CP2102, past RXD and back (finding 2)", () => {
    hasRun("open746-touch", "TERM1:TX", "U1:VCP-RX", [[34, -6], [33, -6], [33, -11], [48, -11], [48, 8], [45, 8]])
  })

  it("system-exam: C5 the right way up, the rectifier's + and ground wires straight onto it with no lap round the bridge; the current mirror's base link one hook, not an S (finding 3)", () => {
    hasRun("system-exam", "D2:2+D3:2", "C5:1", [[45, 27], [45, 26], [55, 26]])
    hasRun("system-exam", "ground:GND", "C5:2", [[45, 37], [55, 37], [55, 30]])
    hasRun("system-exam", "Q2:B", "R13:2", [[54, 11], [53, 11], [53, 8], [57, 8]])
  })

  it("nucleo-i2c: one + rail on row 2 with T's to R1, R2 and the memory's VCC, no two wires of the net crossing beside the supply pin (finding 8)", () => {
    hasRun("nucleo-i2c", "supply:V", "·", [[38, 1], [38, 2]])
    const { doc } = runsIn("nucleo-i2c")
    const rail = doc.wires.filter((s) => s.a.y === c(2) && s.b.y === c(2))
    const crossing = doc.wires.filter((v) => v.a.x === v.b.x && rail.some((h) => Math.min(h.a.x, h.b.x) < v.a.x && v.a.x < Math.max(h.a.x, h.b.x) && Math.min(v.a.y, v.b.y) < c(2) && c(2) < Math.max(v.a.y, v.b.y)))
    expect.soft(crossing.map((s) => cells([s.a, s.b])), "nothing crosses the rail").toEqual([])
  })

  it("the bridge: R4 into the left corner along its row from the left, the bend the example now draws (review B's table and question 8: §13.22's tie kept)", () => {
    hasRun("bridge", "R4:2", "R1:1+R6:2", [[5, 5], [5, 6], [14, 6]])
  })

  it("charge-boost-chips: BT1's + into the DW03's VDD from above, clear of the battery's printed «3.7 V Li-ion» (finding 7)", () => {
    hasRun("charge-boost-chips", "U2:VDD", "·", [[26, 11], [26, 9], [28, 9], [28, 5]])
  })

  it("power-supply: the rails run a row out from C1's pins, so no pin label sits on its own wire (the main session's decision on review B's question 1, d)", () => {
    const { doc } = runsIn("power-supply")
    const at = wiresAtPins(wiringOf(new WireGraph(), doc).routes)
    const onTheirWires = doc.objects.flatMap((o) => [...labelsOnTheirWires(o, 0.4, MONO_ADVANCE_EM, GRID, at)].map((pin) => `${o.props?.ref}:${pin}`))
    expect.soft(onTheirWires.filter((k) => k.startsWith("C1:")), "C1's «+» and «−» clear of the rails").toEqual([])
  })
})
