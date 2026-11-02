import { describe, expect, it } from "vitest"
import { STM32F405RG, STM32F429ZI } from "@/mcu/chip"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey } from "@/schematic/types"
import { getDef } from "@/schematic/registry"
import { buildNetlist } from "@/sim/netlist"
import { SimLoop } from "@/sim/loop"
import { EYE_SETTLED } from "../lib/eye"

const pads = STM32F405RG.electrical.pads!
const FT_PB6 = "EXT1-13"
const TTA_PA4 = "EXT2-11"

function bench(volts: number, pin: string, ohms = 0, usb = true) {
  const { place, wire, doc } = builder(GRID)
  const u = place("olimex-stm32-h405", 0, 0)
  const supply = place("dc-source", 40, 30, { value: `${volts} V` })
  const gnd = place("ground", 40, 40)
  wire(supply, "-", gnd, "GND")
  wire(gnd, "GND", u, "EXT1-6")
  if (ohms > 0) {
    const r = place("resistor", 34, 30, { value: `${ohms} Ω`, power: "1" })
    wire(supply, "+", r, "1")
    wire(r, "2", u, pin)
  } else wire(supply, "+", u, pin)
  doc.parts[partKey(u.id, "USB")] = { on: usb }
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  while (clock < EYE_SETTLED * 1000) loop.advance((clock += 20))
  const snap = loop.snapshot()!
  return { damage: snap.damage[u.id]?.reason, volts: snap.pinVoltage[pinKey(u.id, pin)]! }
}

describe("the F405's pad classes (DS8626 Rev 12)", () => {
  it("are DS8626's: FT to VDD + 4.0 V, TTa PA4/PA5 to 4.0 V (Table 11), ±5 mA injected (Table 12), PC13–PC15 behind the backup switch at 3 mA (Table 7 note 3)", () => {
    expect.soft(pads.ft.aboveVdd).toBe(4.0)
    expect.soft(pads.tta).toEqual({ pads: ["PA4", "PA5"], voltageMax: 4.0 })
    expect.soft(pads.injectedCurrentMax).toBe(5e-3)
    expect.soft(pads.backupDomain.pads).toEqual(expect.arrayContaining(["PC13", "PC14", "PC15"]))
    expect.soft(pads.backupDomain.currentMax).toBe(3e-3)
  })
})

describe("the F429's pad classes (DS9405 Rev 14: Table 14 voltages, Table 15 injection, PA4/PA5 the only TTa, PC13–PC15 and PI8 behind the 3 mA switch)", () => {
  it("are the F405's", () => {
    expect(STM32F429ZI.electrical.pads).toEqual(pads)
  })
})

describe("on the STM32-H405, without firmware", () => {
  it("takes 5 V on FT PB6: no positive clamp, inside VDD + 4 V", () => {
    const got = bench(5, FT_PB6)
    expect.soft(got.damage).toBeUndefined()
    expect.soft(got.volts).toBeNear(5, 0.05)
  })

  it("burns at 7.5 V on FT PB6, past the regulator's 3.3 V + 4 V", () => {
    expect(bench(7.5, FT_PB6).damage).toMatch(/^voltage 7\.5\d* V exceeds the 7\.3\d* V rating$/)
  })

  it("burns at 5 V on FT PB6 with USB out: VDD + 4 V is 4 V on a dead supply", () => {
    expect(bench(5, FT_PB6, 0, false).damage).toMatch(/^voltage 5(\.0+)? V exceeds the 4(\.0+)? V rating$/)
  })

  it("burns at 5 V straight onto TTa PA4, and takes it through 10 kΩ, clamped under 4 V", () => {
    expect.soft(bench(5, TTA_PA4).damage).toBeTruthy()
    const through = bench(5, TTA_PA4, 10e3)
    expect.soft(through.damage).toBeUndefined()
    expect.soft(through.volts).toBeLessThan(pads.tta.voltageMax)
  })
})

describe("a dead F405 keeps its pads' junctions (the die's supply failed, nothing else)", () => {
  it("FT PB6 keeps its VSS clamp and TTa PA4 its VSS and VDD clamps, with the healthy ESD junction; the drivers go", () => {
    const { place, wire, doc } = builder(GRID)
    const u = place("olimex-stm32-h405", 0, 0)
    for (const [i, pin] of [FT_PB6, TTA_PA4].entries()) {
      const r = place("resistor", 40, i * 6, { value: "1 kΩ" })
      wire(r, "1", u, pin)
      wire(r, "2", u, "EXT1-6")
    }
    const model = getDef("olimex-stm32-h405")!.model!
    const supply = model.findIndex((el) => el.kind === "R" && el.supply)
    expect(supply, "the die's supply element").toBeGreaterThanOrEqual(0)
    const onPad = (net: ReturnType<typeof buildNetlist>, pin: string) => {
      const key = pinKey(u.id, pin)
      return net.elements.filter((e) => e.keys.includes(key))
    }
    const junctions = (net: ReturnType<typeof buildNetlist>, pin: string) =>
      onPad(net, pin)
        .filter((e) => e.kind === "D")
        .map((e) => ({ clamp: e.id.slice(e.id.lastIndexOf("$")), n: e.kind === "D" ? e.n : NaN }))
        .sort((a, b) => a.clamp.localeCompare(b.clamp))
    const healthy = buildNetlist(doc)
    const dead = buildNetlist(doc, { [u.id]: { reason: "the supply failed", fail: "short", element: supply, fatal: true } })
    for (const pin of [FT_PB6, TTA_PA4]) {
      expect.soft(junctions(dead, pin), `${pin}: the same junctions`).toEqual(junctions(healthy, pin))
      const drivers = (net: ReturnType<typeof buildNetlist>) => onPad(net, pin).filter((e) => e.kind === "GPIO").length
      expect.soft(drivers(healthy), `${pin}: driven while alive`).toBe(1)
      expect.soft(drivers(dead), `${pin}: no driver left on the dead die`).toBe(0)
    }
    expect.soft(junctions(healthy, FT_PB6).map((j) => j.clamp), "FT: a VSS clamp only").toEqual(["$clamp-vss"])
    expect.soft(junctions(healthy, TTA_PA4).map((j) => j.clamp), "TTa: VSS and VDD clamps").toEqual(["$clamp-vdd", "$clamp-vss"])
  })
})
