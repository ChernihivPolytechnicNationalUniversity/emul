import { describe, expect, it } from "vitest"
import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type PartState, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

function start(doc: Schematic) {
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  let parts: Record<string, PartState> = { ...doc.parts }
  return {
    run: (seconds: number) => {
      const end = clock + seconds * 1000
      while (clock < end) {
        clock = Math.min(end, clock + 10)
        loop.advance(clock)
      }
      return loop.snapshot()!
    },
    parts: (p: Record<string, PartState>) => {
      parts = { ...parts, ...p }
      loop.setParts(parts)
    },
  }
}

const kindReading = (snap: Snapshot, id: string, kind: string) => snap.readings.find((r) => r.object === id && r.kind === kind)!
const volts = (snap: Snapshot, id: string, pin: string) => snap.pinVoltage[pinKey(id, pin)] ?? 0

function bench(cell: Record<string, string>, load?: string) {
  const { doc, place, wire } = builder(GRID)
  const mod = place("lx-lcbst", 10, 10)
  const bat = place("battery", 0, 10, { chem: "li-ion", capacity: "2 Ah", ...cell })
  const gnd = place("ground", 10, 30)
  wire(bat, "+", mod, "B+")
  wire(bat, "-", mod, "B-")
  wire(mod, "IN-", gnd, "GND")
  let r
  if (load) {
    r = place("resistor", 20, 5, { value: load, power: "5" })
    wire(mod, "VO+", r, "1")
    wire(r, "2", mod, "VO-")
  }
  return { doc, mod, bat, r }
}

describe("LX-LCBST: TP4056 + DW03 + MT3608", () => {
  it("charges a half-empty cell at 1 A from USB and lights CHRG", () => {
    const { doc, mod } = bench({ soc: "50" })
    doc.parts[partKey(mod.id, "USB")] = { on: true }
    const t = start(doc)
    const snap = t.run(0.05)
    const chg = kindReading(snap, mod.id, "CHG")
    expect.soft(chg.current, "charge current (A)").toBeNear(1, 0.03)
    expect.soft(chg.extra?.State).toBe("constant current")
    expect.soft(snap.parts[partKey(mod.id, "CHRG")]?.on, "red LED").toBe(true)
    expect.soft(snap.parts[partKey(mod.id, "STDBY")]?.on ?? false, "blue LED").toBe(false)
  })

  it("trickles a cell below 2.9 V", () => {
    const { doc, place, wire } = builder(GRID)
    const mod = place("lx-lcbst", 10, 10)
    const cell = place("dc-source", 0, 10, { value: "2.5 V", imax: "5 A" })
    const gnd = place("ground", 10, 30)
    wire(cell, "+", mod, "B+")
    wire(cell, "-", mod, "B-")
    wire(mod, "IN-", gnd, "GND")
    doc.parts[partKey(mod.id, "USB")] = { on: true }
    const snap = start(doc).run(0.1)
    const chg = kindReading(snap, mod.id, "CHG")
    expect.soft(chg.extra?.State).toBe("trickle")
    expect.soft(chg.current * 1e3, "trickle current (mA)").toBeNear(100, 5)
  })

  it("tapers at 4.2 V and stops at C/10, then STDBY", () => {
    const { doc, mod, bat } = bench({ soc: "100", capacity: "0.1 Ah" })
    doc.parts[partKey(mod.id, "USB")] = { on: true }
    const t = start(doc)
    let snap = t.run(0.05)
    expect.soft(volts(snap, bat.id, "+") - volts(snap, bat.id, "-"), "cell held at float (V)").toBeLessThan(4.25)
    snap = t.run(5)
    const chg = kindReading(snap, mod.id, "CHG")
    expect.soft(chg.extra?.State).toBe("charged")
    expect.soft(Math.abs(chg.current), "no current once charged").toBeLessThan(1e-3)
    expect.soft(snap.parts[partKey(mod.id, "STDBY")]?.on, "blue LED").toBe(true)
  })

  it("boosts the cell to 5 V into 50 Ω", () => {
    const { doc, mod, r, bat } = bench({ soc: "80" }, "50 Ω")
    const snap = start(doc).run(0.05)
    expect.soft(volts(snap, mod.id, "VO+") - volts(snap, mod.id, "VO-"), "output (V)").toBeNear(5, 0.05)
    expect.soft(Math.abs(kindReading(snap, r!.id, "R").current), "load (A)").toBeNear(0.1, 0.002)
    const cell = kindReading(snap, bat.id, "BAT")
    expect.soft(-cell.current, "cell current ≈ 0.5 W / 0.9 / V").toBeNear(0.5 / 0.9 / cell.voltage + 1e-3, 0.01)
  })

  it("follows the trimmer to 12 V", () => {
    const { doc, mod } = bench({ soc: "80" }, "1 kΩ")
    mod.props = { ...mod.props, vout: "12 V" }
    const snap = start(doc).run(0.05)
    expect.soft(volts(snap, mod.id, "VO+") - volts(snap, mod.id, "VO-"), "output (V)").toBeNear(12, 0.1)
  })

  it("an overload drags the output down at the switch limit", () => {
    const { doc, mod, bat } = bench({ soc: "80" }, "2 Ω")
    const snap = start(doc).run(0.005)
    const boost = kindReading(snap, mod.id, "BOOST")
    expect.soft(boost.extra?.mode).toBe("current limit")
    expect.soft(volts(snap, mod.id, "VO+") - volts(snap, mod.id, "VO-"), "output sags (V)").toBeLessThan(4.5)
    expect.soft(-kindReading(snap, bat.id, "BAT").current, "cell current (A)").toBeNear(2, 0.1)
  })

  it("a shorted output trips the protection, and it stays off until a charger is connected", () => {
    const { doc, place, wire } = builder(GRID)
    const mod = place("lx-lcbst", 10, 10)
    const bat = place("battery", 0, 10, { chem: "li-ion", capacity: "2 Ah", soc: "80" })
    const gnd = place("ground", 10, 30)
    const sw = place("switch", 20, 5)
    wire(bat, "+", mod, "B+")
    wire(bat, "-", mod, "B-")
    wire(mod, "IN-", gnd, "GND")
    wire(mod, "VO+", sw, "1")
    wire(sw, "2", mod, "VO-")
    doc.parts[partKey(sw.id, "SW")] = { on: true }
    const t = start(doc)
    let snap = t.run(0.05)
    expect.soft(kindReading(snap, mod.id, "PROT").extra?.State).toMatch(/short|overcurrent/)
    expect.soft(Math.abs(kindReading(snap, bat.id, "BAT").current), "cell cut off (A)").toBeLessThan(0.01)
    expect.soft(Object.keys(snap.damage), "nothing burnt").toEqual([])
    t.parts({ [partKey(sw.id, "SW")]: { on: false } })
    snap = t.run(0.05)
    expect.soft(kindReading(snap, mod.id, "PROT").extra?.State, "the boost's own divider keeps CS up").toMatch(/short|overcurrent/)
    t.parts({ [partKey(mod.id, "USB")]: { on: true } })
    snap = t.run(0.05)
    expect.soft(kindReading(snap, mod.id, "PROT").extra?.State, "a charger resets it").toBe("normal")
    expect.soft(volts(snap, mod.id, "VO+") - volts(snap, mod.id, "VO-"), "output back (V)").toBeNear(5, 0.05)
  })

  it("cuts an empty cell off at 2.4 V; a charger releases it and charges with the load on", () => {
    const { doc, mod, bat } = bench({ soc: "0", capacity: "0.05 Ah" }, "25 Ω")
    const t = start(doc)
    let snap = t.run(0.2)
    expect.soft(kindReading(snap, mod.id, "PROT").extra?.State).toBe("over-discharge")
    expect.soft(Math.abs(kindReading(snap, bat.id, "BAT").current), "cell cut off (A)").toBeLessThan(0.01)
    expect.soft(Object.keys(snap.damage), "nothing burnt").toEqual([])
    t.parts({ [partKey(mod.id, "USB")]: { on: true } })
    snap = t.run(0.2)
    expect.soft(kindReading(snap, mod.id, "PROT").extra?.State).toBe("normal")
    expect.soft(kindReading(snap, bat.id, "BAT").current, "charging (A)").toBeGreaterThan(0.05)
    expect.soft(volts(snap, mod.id, "VO+") - volts(snap, mod.id, "VO-"), "output while charging (V)").toBeNear(5, 0.05)
  })

  it("plugging and unplugging the USB leaves every step converged", () => {
    const { doc, mod } = bench({ soc: "50" }, "100 Ω")
    const loop = new SimLoop()
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    let clock = 0
    loop.advance(0)
    let stuck = 0
    const run = (ms: number) => {
      const end = clock + ms
      while (clock < end) {
        clock += 10
        loop.advance(clock)
        if (!loop.snapshot()!.converged) stuck++
      }
    }
    for (const ms of [300, 700, 1500, 3000]) {
      loop.setParts({ ...doc.parts, [partKey(mod.id, "USB")]: { on: true } })
      run(ms)
      loop.setParts({ ...doc.parts, [partKey(mod.id, "USB")]: { on: false } })
      run(300)
    }
    expect.soft(stuck, "ticks ending on an unconverged step").toBe(0)
    expect.soft(kindReading(loop.snapshot()!, mod.id, "CHG").extra?.State).toBe("no input")
  })

  it("12 V on VBUS kills the TP4056", () => {
    const { doc, place, wire } = builder(GRID)
    const mod = place("lx-lcbst", 10, 10)
    const bat = place("battery", 0, 10, { chem: "li-ion", capacity: "2 Ah", soc: "50" })
    const src = place("dc-source", 0, 0, { value: "12 V", imax: "5 A" })
    const gnd = place("ground", 10, 30)
    wire(bat, "+", mod, "B+")
    wire(bat, "-", mod, "B-")
    wire(mod, "IN-", gnd, "GND")
    wire(src, "+", mod, "IN+")
    wire(src, "-", gnd, "GND")
    const snap = start(doc).run(0.01)
    expect.soft(snap.damage[mod.id]?.reason ?? "", "TP4056 over its 8 V").toMatch(/voltage/)
  })
})

describe("bare power ICs", () => {
  it("TP4056 with 2.4 kΩ on PROG charges at 500 mA, and not with CE low", () => {
    const { doc, place, wire } = builder(GRID)
    const u = place("tp4056", 10, 10)
    const src = place("dc-source", 0, 0, { value: "5 V", imax: "3 A" })
    const bat = place("battery", 20, 10, { chem: "li-ion", capacity: "2 Ah", soc: "50" })
    const rprog = place("resistor", 0, 20, { value: "2.4 kΩ" })
    const gnd = place("ground", 10, 30)
    wire(src, "+", u, "VCC")
    wire(src, "-", gnd, "GND")
    wire(u, "VCC", u, "CE")
    wire(u, "TEMP", gnd, "GND")
    wire(u, "PROG", rprog, "1")
    wire(rprog, "2", gnd, "GND")
    wire(u, "GND", gnd, "GND")
    wire(u, "BAT", bat, "+")
    wire(bat, "-", gnd, "GND")
    let snap = start(doc).run(0.05)
    expect.soft(kindReading(snap, u.id, "CHG").current, "charge current (A)").toBeNear(0.5, 0.02)
    doc.wires = doc.wires.filter((w) => !(w.to.object === u.id && w.to.pin === "CE"))
    snap = start(doc).run(0.05)
    expect.soft(Math.abs(kindReading(snap, u.id, "CHG").current), "CE floating: off (A)").toBeLessThan(1e-3)
  })

  it("DW03 cuts a shorted pack off", () => {
    const { doc, place, wire } = builder(GRID)
    const u = place("dw03", 10, 10)
    const bat = place("battery", 0, 10, { chem: "li-ion", capacity: "2 Ah", soc: "80" })
    const load = place("resistor", 20, 0, { value: "0.5 Ω", power: "50" })
    wire(bat, "+", u, "VDD")
    wire(bat, "-", u, "GND")
    wire(bat, "+", load, "1")
    wire(load, "2", u, "VM")
    const snap = start(doc).run(0.05)
    expect.soft(kindReading(snap, u.id, "PROT").extra?.State).toMatch(/short|overcurrent/)
    expect.soft(Math.abs(kindReading(snap, bat.id, "BAT").current), "cell cut off (A)").toBeLessThan(0.01)
  })

  it("MT3608 with an inductor, a Schottky and a 75k/10k divider boosts 3.7 V to 5.1 V", () => {
    const { doc, place, wire } = builder(GRID)
    const u = place("mt3608", 10, 10)
    const bat = place("battery", 0, 10, { chem: "li-ion", capacity: "2 Ah", soc: "60" })
    const l = place("inductor", 4, 4, { value: "22 µH", imax: "3 A" })
    const d = place("diode", 18, 4, { value: "SS34", vf: "0.3", imax: "3 A", vrev: "40 V" })
    const r1 = place("resistor", 24, 10, { value: "75 kΩ" })
    const r2 = place("resistor", 24, 16, { value: "10 kΩ" })
    const load = place("resistor", 30, 4, { value: "51 Ω", power: "1" })
    const gnd = place("ground", 10, 30)
    wire(bat, "+", u, "IN")
    wire(u, "IN", u, "EN")
    wire(bat, "+", l, "1")
    wire(l, "2", u, "SW")
    wire(u, "SW", d, "1")
    wire(d, "2", r1, "1")
    wire(r1, "2", u, "FB")
    wire(u, "FB", r2, "1")
    wire(r2, "2", gnd, "GND")
    wire(d, "2", load, "1")
    wire(load, "2", gnd, "GND")
    wire(u, "GND", gnd, "GND")
    wire(bat, "-", gnd, "GND")
    const snap = start(doc).run(0.05)
    expect.soft(JSON.stringify(snap.damage), "nothing burnt").toBe("{}")
    expect.soft(volts(snap, d.id, "2"), "output (V)").toBeNear(5.1, 0.05)
    expect.soft(kindReading(snap, u.id, "BOOST").extra?.mode).toBe("regulating")
    expect.soft(Math.abs(kindReading(snap, l.id, "L").current), "inductor carries the input current (A)").toBeNear(5.1 * 0.1 / 0.9 / 3.8, 0.02)
  })
})

describe("the module's circuit from bare chips (example)", () => {
  it("boosts to 5.1 V, and charges at 1 A with CHRG lit once the USB is in", async () => {
    const { examples } = await import("@/schematic/examples")
    const doc = examples.find((e) => e.id === "charge-boost-chips")!.build(GRID)
    const u1 = doc.objects.find((o) => o.def === "tp4056")!
    const d1 = doc.objects.find((o) => o.def === "diode")!
    const led = doc.objects.find((o) => o.def === "led" && o.props?.value === "red")!
    const plug = doc.objects.filter((o) => o.def === "switch")[0]
    const t = start(doc)
    let snap = t.run(0.05)
    expect.soft(JSON.stringify(snap.damage), "nothing burnt").toBe("{}")
    expect.soft(volts(snap, d1.id, "2"), "output (V)").toBeNear(5.1, 0.05)
    t.parts({ [partKey(plug.id, "SW")]: { on: true } })
    snap = t.run(0.05)
    expect.soft(kindReading(snap, u1.id, "CHG").current, "charge current (A)").toBeNear(1, 0.03)
    expect.soft(Math.abs(kindReading(snap, led.id, "D").current) * 1e3, "CHRG LED (mA)").toBeGreaterThan(1)
    expect.soft(volts(snap, d1.id, "2"), "output while charging (V)").toBeNear(5.1, 0.05)
  })
})
