import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { buildNets } from "@/schematic/nets"
import { getDef } from "@/schematic/registry"
import { examples } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import type { Damage, PlacedObject } from "@/schematic/types"
import { compareRefs, fieldEntries, searchField, valueNumber } from "@/components/explorer/field-index"
import { countBySeverity, runtimeProblems, sortProblems, staticProblems, type RuntimeReadout } from "@/components/explorer/problems"

// The field explorer: rows for what is on the bench, the search that finds a part or one of its
// pins, and the problems list, worst first.

const pinOf = (o: PlacedObject, kind: string) => getDef(o.def)!.pins.find((p) => p.kind === kind)!.id

function bench() {
  const b = builder(GRID)
  const board = b.place("nucleo-f429zi", 0, 0)
  const r1 = b.place("resistor", 40, 0, { value: "220 Ω" })
  const r2 = b.place("resistor", 40, 4, { value: "4.7 kΩ" })
  const r10 = b.place("resistor", 40, 8, { value: "10 kΩ" })
  const led = b.place("led", 50, 0)
  const timer = b.place("ne555", 60, 0)
  const gnd = b.place("ground", 70, 10)
  return { ...b, board, r1, r2, r10, led, timer, gnd }
}

const ids = (hits: { object: string; kind: string; pin?: string }[]) => hits.map((h) => (h.kind === "pin" ? `${h.object}:${h.pin}` : h.object))

describe("the field's rows", () => {
  it("sort boards, chips, then parts; designators by number, R2 before R10", () => {
    const { doc, board, r1, r2, r10, led, timer, gnd } = bench()
    const order = fieldEntries(doc.objects).map((e) => e.id)
    expect(order[0]).toBe(board.id)
    expect(order.indexOf(r2.id)).toBeLessThan(order.indexOf(r10.id))
    expect(order).toEqual(expect.arrayContaining([r1.id, led.id, timer.id, gnd.id]))
    expect(compareRefs("R2", "R10")).toBeLessThan(0)
    expect(compareRefs("U1", "D13")).toBeGreaterThan(0)
  })

  it("show a part's value", () => {
    const { doc, r2 } = bench()
    expect(fieldEntries(doc.objects).find((e) => e.id === r2.id)?.value).toBe("4.7 kΩ")
  })
})

describe("values as a student writes them", () => {
  it.each([
    ["220", 220],
    ["220Ω", 220],
    ["220R", 220],
    ["220 ohm", 220],
    ["0.22k", 220],
    ["4k7", 4700],
    ["4.7k", 4700],
    ["4.7 kΩ", 4700],
    ["2R2", 2.2],
    ["100nF", 100e-9],
    ["10u", 10e-6],
    ["1M5", 1.5e6],
  ])("%s is %d", (text, n) => expect(valueNumber(text)).toBeCloseTo(n, 12))

  it("text that is not a value is not one", () => {
    for (const t of ["R1", "led", "PA5", "", "k"]) expect(valueNumber(t), t).toBeNaN()
  })
})

describe("the field's search", () => {
  it("finds a part by its designator, and R1 is not R10", () => {
    const { doc, r1 } = bench()
    expect(ids(searchField(doc.objects, "R1"))).toEqual([r1.id])
    expect(ids(searchField(doc.objects, "r1"))).toEqual([r1.id])
  })

  it("finds every part whose designator starts with the letters typed", () => {
    const { doc, r1, r2, r10 } = bench()
    expect(ids(searchField(doc.objects, "R")).slice(0, 3)).toEqual([r1.id, r2.id, r10.id])
  })

  it("finds a part by its value however it is spelt", () => {
    const { doc, r2 } = bench()
    for (const q of ["4k7", "4.7k", "4700", "4.7kΩ"]) expect(ids(searchField(doc.objects, q)), q).toEqual([r2.id])
  })

  it("finds a part by its name", () => {
    const { doc, timer, led } = bench()
    expect(ids(searchField(doc.objects, "ne555"))).toContain(timer.id)
    expect(ids(searchField(doc.objects, "led"))).toContain(led.id)
  })

  it("finds a pin by its MCU name, its printed label or its signal", () => {
    const { doc, board } = bench()
    const def = getDef(board.def)!
    const pa5 = def.pins.find((p) => p.mcu === "PA5")!
    const hits = searchField(doc.objects, "PA5")
    expect(hits.some((h) => h.kind === "pin" && h.object === board.id && h.pin === pa5.id)).toBe(true)
    // A label printed on the board (D13 on a Nucleo is PA5).
    if (pa5.label) expect(ids(searchField(doc.objects, pa5.label))).toContain(`${board.id}:${pa5.id}`)
  })

  it("narrows a pin to one part: U1 PA5", () => {
    const b = bench()
    const second = b.place("nucleo-f429zi", 0, 40)
    const ref = b.board.props!.ref!
    const hits = searchField(b.doc.objects, `${ref} PA5`)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.every((h) => h.kind === "pin" && h.object === b.board.id)).toBe(true)
    expect(hits.some((h) => h.object === second.id)).toBe(false)
  })

  it("puts parts before pins, and needs every word", () => {
    const { doc, timer } = bench()
    const hits = searchField(doc.objects, "vcc")
    expect(hits.length).toBeGreaterThan(0)
    expect(searchField(doc.objects, `${timer.props!.ref} zzz`)).toEqual([])
    const all = searchField(doc.objects, "R")
    const firstPin = all.findIndex((h) => h.kind === "pin")
    expect(firstPin === -1 || all.slice(firstPin).every((h) => h.kind === "pin")).toBe(true)
  })

  it("does not find every ground pin from one letter", () => {
    const { doc } = bench()
    expect(searchField(doc.objects, "g").filter((h) => h.kind === "pin")).toEqual([])
  })

  it("answers within a frame on a bench of 500 parts", () => {
    const b = builder(GRID)
    for (let i = 0; i < 20; i++) b.place("nucleo-f429zi", (i % 5) * 60, Math.floor(i / 5) * 60)
    for (let i = 0; i < 480; i++) b.place(i % 3 ? "resistor" : "led", 400 + (i % 40) * 6, (i / 40) * 6, i % 3 ? { value: `${(i % 9) + 1} kΩ` } : {})
    const entries = fieldEntries(b.doc.objects)
    const t0 = performance.now()
    for (const q of ["R", "R123", "PA5", "4k7", "U3 PB7", "led", "vcc"]) searchField(b.doc.objects, q, entries)
    const per = (performance.now() - t0) / 7
    expect(per).toBeLessThan(16)
  })
})

const idle: RuntimeReadout = { live: false, converged: true, damage: {}, mcu: () => undefined }

describe("problems on the bench", () => {
  it("a chip with nothing wired has no supply and no ground", () => {
    const { doc, timer } = bench()
    const problems = staticProblems(doc.objects, buildNets(doc.objects, doc.wires, GRID))
    const mine = problems.filter((p) => p.object === timer.id).map((p) => [p.severity, p.title])
    expect(mine).toEqual(expect.arrayContaining([["error", `${timer.props!.ref} has no supply`], ["error", `${timer.props!.ref} has no ground`]]))
    const supply = problems.find((p) => p.key === `${timer.id}:no-supply`)!
    expect(supply.pin).toBe(pinOf(timer, "power"))
    expect(supply.fix).toMatch(/^Wire /)
  })

  it("wiring the supply and ground clears both", () => {
    const b = bench()
    const rail = b.place("supply", 60, -6)
    b.wire(b.timer, pinOf(b.timer, "power"), rail, getDef("supply")!.pins[0].id)
    b.wire(b.timer, pinOf(b.timer, "gnd"), b.gnd, getDef("ground")!.pins[0].id)
    const problems = staticProblems(b.doc.objects, buildNets(b.doc.objects, b.doc.wires, GRID))
    expect(problems.filter((p) => p.object === b.timer.id)).toEqual([])
  })

  it("passive parts, sources and boards ask for no supply", () => {
    const { doc, r1, led, gnd, board } = bench()
    const problems = staticProblems(doc.objects, buildNets(doc.objects, doc.wires, GRID))
    for (const o of [r1, led, gnd]) expect(problems.filter((p) => p.object === o.id), o.def).toEqual([])
    expect(problems.filter((p) => p.object === board.id && p.severity !== "info")).toEqual([])
  })

  it("a board with no firmware is a note, not an error", () => {
    const { doc, board } = bench()
    const p = staticProblems(doc.objects, buildNets(doc.objects, doc.wires, GRID)).find((x) => x.object === board.id)
    expect(p?.severity).toBe("info")
    const loaded = doc.objects.map((o) => (o.id === board.id ? { ...o, props: { ...o.props, firmware: "blink.elf" } } : o))
    expect(staticProblems(loaded, buildNets(loaded, doc.wires, GRID)).filter((x) => x.object === board.id)).toEqual([])
  })

  it("no example in the catalogue has an error on its bench", () => {
    for (const example of examples) {
      const doc = example.build(GRID)
      const errors = staticProblems(doc.objects, buildNets(doc.objects, doc.wires, GRID)).filter((p) => p.severity === "error")
      expect(errors.map((p) => p.title), example.name).toEqual([])
    }
  })
})

describe("problems while running", () => {
  const { doc, board, r1 } = bench()
  const burnt: Damage = { reason: "1.2 W in a 0.25 W resistor", fail: "open", element: 0, fatal: true }

  it("a burnt part is an error with the reason", () => {
    const p = runtimeProblems(doc.objects, { ...idle, damage: { [r1.id]: burnt } })
    expect(p).toEqual([expect.objectContaining({ severity: "error", object: r1.id, title: `${r1.props!.ref} burnt out`, detail: burnt.reason })])
  })

  it("an MCU held in reset, stopped, or faulted says so; one with no firmware is left to the static note", () => {
    const status = (s: object) => ({ ...idle, live: true, mcu: (id: string) => (id === board.id ? ({ running: false, halted: null, faults: [], firmware: "blink.elf", powered: true, ...s } as never) : undefined) })
    expect(runtimeProblems(doc.objects, status({ powered: false }))[0]).toMatchObject({ severity: "warning", title: `${board.props!.ref} is held in reset` })
    expect(runtimeProblems(doc.objects, status({ halted: "HardFault at 0x08000124" }))[0]).toMatchObject({ severity: "error", detail: "HardFault at 0x08000124" })
    expect(runtimeProblems(doc.objects, status({ firmware: "" }))).toEqual([])
  })

  it("a solver that cannot settle is a warning about the bench", () => {
    expect(runtimeProblems(doc.objects, { ...idle, live: true, converged: false })).toEqual([expect.objectContaining({ key: "solver", severity: "warning" })])
  })

  it("the list runs worst first, then by designator", () => {
    const list = sortProblems(
      [...staticProblems(doc.objects, buildNets(doc.objects, doc.wires, GRID)), ...runtimeProblems(doc.objects, { ...idle, damage: { [r1.id]: burnt } })],
      doc.objects,
    )
    const levels = list.map((p) => p.severity)
    expect(levels).toEqual([...levels].sort((a, b) => ["error", "warning", "info"].indexOf(a) - ["error", "warning", "info"].indexOf(b)))
    expect(countBySeverity(list).error).toBeGreaterThanOrEqual(3)
  })
})

describe("the explorer's size", () => {
  it("keeps its width between its narrowest and widest, and folds when dragged past the narrowest", async () => {
    const { clampFieldWidth, FIELD_WIDTH, FIELD_FOLD_BELOW, clampShare, INSPECTOR_SHARE } = await import("@/components/explorer/panel-size")
    expect(clampFieldWidth(100)).toBe(FIELD_WIDTH.min)
    expect(clampFieldWidth(5000)).toBe(FIELD_WIDTH.max)
    expect(clampFieldWidth(300.4)).toBe(300)
    expect(FIELD_FOLD_BELOW).toBeLessThan(FIELD_WIDTH.min)
    expect(clampShare(0)).toBe(INSPECTOR_SHARE.min)
    expect(clampShare(1)).toBe(INSPECTOR_SHARE.max)
    expect(clampShare(0.5)).toBe(0.5)
  })
})
