import { describe, expect, it } from "vitest"
import { pinContacts } from "@/schematic/contacts"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { allDefs, getDef } from "@/schematic/registry"
import { pinKey, type ComponentDef, type PlacedObject, type Schematic, type Wire } from "@/schematic/types"
import { Engine, GMIN } from "@/sim/engine"
import { FlowSolver, type FlowNet } from "@/sim/flow"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { buildNetlist, groundTiesOf, type GroundTie } from "@/sim/netlist"
import { exampleBase64 } from "../lib/firmware"

type Bench = ReturnType<typeof builder>

function unplugged(doc: Schematic, obj: PlacedObject) {
  for (const part of getDef(obj.def)?.parts ?? []) if (part.type === "usb") doc.parts[`${obj.id}:${part.id}`] = { on: false }
}

const ALKALINE_CELL_FRESH = 1.65

function run(doc: Schematic, seconds: number, emf: number, every?: (now: Snapshot, leak: number) => void) {
  const leak = GMIN * buildNetlist(doc).nodes * emf
  const loop = new SimLoop()
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(0)
  while (clock < seconds * 1000) {
    clock += 30
    loop.advance(clock)
    if (every && clock % 90 === 0) {
      loop.snapshot()
      every(loop.snapshot()!, leak)
    }
  }
  const mean = loop.snapshot()!
  const now = loop.snapshot()!
  return { mean, now, leak }
}

const wireAmps = (snap: Snapshot, w: Wire) => snap.wireCurrent[w.id] ?? 0
const pinAmps = (snap: Snapshot, obj: PlacedObject, pin: string) => snap.pinCurrent[pinKey(obj.id, pin)] ?? 0

function nanoOnABattery(b: Bench, cells: number) {
  const nano = b.place("arduino-nano", 0, 0, { firmware: "avr-blink.elf", firmwareData: exampleBase64("avr-blink.elf") })
  unplugged(b.doc, nano)
  const battery = b.place("battery", -10, 16, { chem: "alkaline", cells: String(cells) })
  return { nano, battery, emf: cells * ALKALINE_CELL_FRESH }
}

function shortGroups(def: ComponentDef): string[][] {
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k) ?? k
    if (p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  for (const el of def.model ?? []) if (el.kind === "SHORT") for (const n of el.nodes) parent.set(find(n), find(el.nodes[0]))
  const groups = new Map<string, string[]>()
  for (const p of def.pins) {
    const root = find(p.id)
    groups.set(root, [...(groups.get(root) ?? []), p.id])
  }
  return [...groups.values()]
}

const pinsWith = (def: ComponentDef, node: string) => shortGroups(def).find((g) => g.includes(node)) ?? def.pins.filter((p) => p.id === node).map((p) => p.id)

describe("Arduino Nano on a 9 V battery (the bug from production): the current out of + comes back through −, whichever GND pin takes it", () => {
  for (const gnd of ["J2-2", "J1-4", "J4-6"]) {
    it(`+ on VIN, − on ${gnd}`, () => {
      const b = builder(GRID)
      const { nano, battery, emf } = nanoOnABattery(b, 6)
      const plus = b.wire(battery, "+", nano, "J2-1")
      const minus = b.wire(battery, "-", nano, gnd)
      const { mean, now, leak } = run(b.doc, 0.6, emf)
      const drawn = pinAmps(now, battery, "-")
      expect.soft(drawn * 1e3, "the Nano draws its tens of mA from the battery (mA)").toBeGreaterThan(15)
      expect.soft(wireAmps(now, plus), "the + wire carries the battery's current, battery → VIN").toBeNear(drawn, leak)
      expect.soft(wireAmps(now, minus), `the − wire carries the same current back, ${gnd} → battery`).toBeNear(-drawn, leak)
      expect.soft(wireAmps(mean, minus), "averaged over the frame, what goes out on + comes back on −").toBeNear(-wireAmps(mean, plus), leak)
      expect.soft(wireAmps(mean, plus), "and the average is the battery's current, give or take the sketch's activity").toBeNearRel(drawn, 0.1)
      expect.soft(pinAmps(now, nano, "J2-1"), "a meter in VIN's lead reads the battery's current, into the board").toBeNear(drawn, leak)
      expect.soft(pinAmps(now, nano, gnd), `a meter in ${gnd}'s lead reads it coming out`).toBeNear(-drawn, leak)
      for (const other of ["J2-2", "J1-4", "J4-6"].filter((p) => p !== gnd)) expect.soft(pinAmps(now, nano, other), `${other}, with nothing on it, carries nothing`).toBeNear(0, 1e-12)
    })
  }
})

describe("Arduino Nano on 4.5 V into its 5V net: + is just as exact on every pin of that net", () => {
  for (const plusPin of ["J2-4", "J4-2"]) {
    it(`+ on ${plusPin}, − on J2-2`, () => {
      const b = builder(GRID)
      const { nano, battery, emf } = nanoOnABattery(b, 3)
      const plus = b.wire(battery, "+", nano, plusPin)
      const minus = b.wire(battery, "-", nano, "J2-2")
      const { now, leak } = run(b.doc, 0.6, emf)
      const drawn = pinAmps(now, battery, "-")
      expect.soft(drawn * 1e3, "the MCU, the FT232RL and the PWR LED draw from it (mA)").toBeGreaterThan(10)
      expect.soft(wireAmps(now, plus), "the + wire carries all of it, the FT232RL's share on its internal node included").toBeNear(drawn, leak)
      expect.soft(wireAmps(now, minus), "and − brings all of it back").toBeNear(-drawn, leak)
      expect.soft(pinAmps(now, nano, plusPin), `${plusPin}'s lead`).toBeNear(drawn, leak)
    })
  }
})

describe("the return through a ground symbol: the wire from the board's GND pin to it carries the board's current", () => {
  for (const gnd of ["J2-2", "J1-4"]) {
    it(`battery − and the Nano's ${gnd} on one ground symbol`, () => {
      const b = builder(GRID)
      const { nano, battery, emf } = nanoOnABattery(b, 6)
      const ground = b.place("ground", -10, 24)
      b.wire(battery, "+", nano, "J2-1")
      const back = b.wire(battery, "-", ground, "GND")
      const fromBoard = b.wire(nano, gnd, ground, "GND")
      const { now, leak } = run(b.doc, 0.6, emf)
      const drawn = pinAmps(now, battery, "-")
      expect.soft(wireAmps(now, back), "ground symbol → battery −").toBeNear(-drawn, leak)
      expect.soft(wireAmps(now, fromBoard), `${gnd} → ground symbol, the same current`).toBeNear(drawn, leak)
      expect.soft(pinAmps(now, ground, "GND"), "nothing is lost into the symbol: in on one wire, out on the other").toBeNear(0, leak)
    })
  }

  it("a 9 V rail on VIN and the Nano's GND on a ground symbol (the bench of nano-bench.test.ts)", () => {
    const b = builder(GRID)
    const nano = b.place("arduino-nano", 0, 0, { firmware: "avr-blink.elf", firmwareData: exampleBase64("avr-blink.elf") })
    unplugged(b.doc, nano)
    const rail = b.place("supply", -10, 16, { value: "VIN", voltage: "9 V" })
    const ground = b.place("ground", -10, 20)
    const plus = b.wire(rail, "V", nano, "J2-1")
    const minus = b.wire(ground, "GND", nano, "J2-2")
    const { now, leak } = run(b.doc, 0.6, 9)
    expect.soft(wireAmps(now, plus) * 1e3, "the rail feeds the Nano (mA)").toBeGreaterThan(15)
    expect.soft(wireAmps(now, minus), "the GND wire returns all of it to the ground the rail stands on").toBeNear(-wireAmps(now, plus), leak)
  })

  it("two GND wires to one ground symbol share the return equally: two equal paths between the same two nodes", () => {
    const b = builder(GRID)
    const { nano, battery, emf } = nanoOnABattery(b, 6)
    const ground = b.place("ground", -10, 24)
    b.wire(battery, "+", nano, "J2-1")
    b.wire(battery, "-", ground, "GND")
    const one = b.wire(ground, "GND", nano, "J2-2")
    const two = b.wire(ground, "GND", nano, "J1-4")
    const { now, leak } = run(b.doc, 0.6, emf)
    const drawn = pinAmps(now, battery, "-")
    expect.soft(wireAmps(now, one), "J2-2 takes half").toBeNear(-drawn / 2, leak)
    expect.soft(wireAmps(now, two), "J1-4 the other half").toBeNear(-drawn / 2, leak)
  })

  it("a return into two ground symbols, one of them doubled by a second symbol on its pin: two ground ties against one, 2 : 1", () => {
    const b = builder(GRID)
    const rail = b.place("supply", 0, 0, { value: "+3V3", voltage: "3.3 V" })
    const r = b.place("resistor", 4, 4, { value: "1k" })
    const paired = b.place("ground", 10, 8)
    b.place("ground", 10, 8)
    const single = b.place("ground", 14, 8)
    b.wire(rail, "V", r, "1")
    const toPaired = b.wire(r, "2", paired, "GND")
    const toSingle = b.wire(r, "2", single, "GND")
    const { now, leak } = run(b.doc, 0.05, 3.3)
    const through = Math.abs(now.readings.find((x) => x.object === r.id)!.current)
    expect.soft(through * 1e3, "3.3 V over 1 kΩ (mA)").toBeNearRel(3.3, 0.01)
    expect.soft(wireAmps(now, toPaired), "two thirds into the doubled ground").toBeNear((2 / 3) * through, leak)
    expect.soft(wireAmps(now, toSingle), "a third into the single one").toBeNear(through / 3, leak)
  })

  it("an LED from +5V sunk by D13: the pad's return is the board's own ground, so the GND wire carries it too", () => {
    const b = builder(GRID)
    const { nano, battery, emf } = nanoOnABattery(b, 6)
    const ground = b.place("ground", -10, 24)
    const r = b.place("resistor", 14, 0, { value: "330" })
    const led = b.place("led", 18, 0, { color: "red" })
    b.wire(battery, "+", nano, "J2-1")
    const back = b.wire(battery, "-", ground, "GND")
    const fromBoard = b.wire(nano, "J2-2", ground, "GND")
    b.wire(nano, "J2-4", r, "1")
    b.wire(r, "2", led, "1")
    const sunk = b.wire(led, "2", nano, "J2-15")
    let lit = 0
    run(b.doc, 1.3, emf, (now, leak) => {
      const drawn = pinAmps(now, battery, "-")
      if (Math.abs(wireAmps(now, sunk)) > 3e-3) lit++
      expect.soft(wireAmps(now, back), `t = ${now.time.toFixed(2)} s: ground symbol → battery −`).toBeNear(-drawn, leak)
      expect.soft(wireAmps(now, fromBoard), `t = ${now.time.toFixed(2)} s: J2-2 → ground symbol, the LED's current included while D13 sinks it`).toBeNear(drawn, leak)
    })
    expect.soft(lit, "D13 sank the LED's current for part of the run").toBeGreaterThan(0)
  })
})

describe("a pad driven to a voltage, as a DAC drives its pin: its return is the part's own ground", () => {
  it("D13 held at 2.5 V into 1 kΩ to a ground symbol, the Nano's GND on that symbol: the GND wire brings the current home", () => {
    const b = builder(GRID)
    const nano = b.place("arduino-nano", 0, 0)
    const ground = b.place("ground", -10, 24)
    const r = b.place("resistor", 14, 0, { value: "1k" })
    const out = b.wire(nano, "J2-15", r, "1")
    const down = b.wire(r, "2", ground, "GND")
    const home = b.wire(nano, "J2-2", ground, "GND")
    const net = buildNetlist(b.doc)
    const engine = new Engine(net)
    for (let i = 0; i < 50; i++) engine.step(20e-6, () => ({}), (_, object, node) => (object === nano.id && node === "J2-15" ? 2.5 : null))
    const terminals = engine.terminalCurrents()
    const flow = new FlowSolver(b.doc.wires, net).currents((k) => terminals.get(k) ?? 0)
    const through = Math.abs(engine.readings().find((x) => x.object === r.id)!.current)
    const leak = GMIN * net.nodes * 2.5
    expect.soft(through * 1e3, "the pad drives milliamps through 1 kΩ (mA)").toBeGreaterThan(1)
    expect.soft(flow.wires.get(out.id) ?? 0, "D13 → resistor").toBeNear(through, leak)
    expect.soft(flow.wires.get(down.id) ?? 0, "resistor → ground symbol").toBeNear(through, leak)
    expect.soft(flow.wires.get(home.id) ?? 0, "ground symbol → J2-2: the pad's return, not lost into the symbol").toBeNear(-through, leak)
  })
})

describe("a signal pin brought out on two headers: RESET on J1-3 and J2-3", () => {
  for (const reset of ["J1-3", "J2-3"])
    for (const drawn of ["from the pin", "towards the pin"] as const) {
      it(`10 kΩ from ${reset} to GND, the wire drawn ${drawn}: RP1D's current comes out through that pin`, () => {
        const b = builder(GRID)
        const { nano, battery, emf } = nanoOnABattery(b, 6)
        const r = b.place("resistor", 14, 0, { value: "10k" })
        b.wire(battery, "+", nano, "J2-1")
        b.wire(battery, "-", nano, "J2-2")
        const out = drawn === "from the pin" ? b.wire(nano, reset, r, "1") : b.wire(r, "1", nano, reset)
        const back = b.wire(r, "2", nano, "J1-4")
        const { now, leak } = run(b.doc, 0.3, emf)
        const through = Math.abs(now.readings.find((x) => x.object === r.id)!.current)
        expect.soft(through * 1e3, "≈ 5 V over 11 kΩ (mA)").toBeNearRel((5 / 11e3) * 1e3, 0.05)
        expect.soft(wireAmps(now, out), `${reset} → resistor`).toBeNear(drawn === "from the pin" ? through : -through, leak)
        expect.soft(wireAmps(now, back), "resistor → J1-4").toBeNear(through, leak)
        expect.soft(pinAmps(now, nano, reset), `a meter in ${reset}'s lead`).toBeNear(-through, leak)
      })
    }
})

describe("a seven-segment display's two common leads, 3 and 8, joined inside", () => {
  for (const [def, polarity] of [["seven-segment-ca", "anode"], ["seven-segment-cc", "cathode"]] as const)
    for (const common of ["COM3", "COM8"]) {
      it(`${def}: segment a lit through ${common}`, () => {
        const b = builder(GRID)
        const display = b.place(def, 0, 0)
        const battery = b.place("battery", -10, 0, { chem: "alkaline", cells: "3" })
        const r = b.place("resistor", -6, -4, { value: "220" })
        const feed = b.wire(battery, "+", r, "1")
        const lit = polarity === "anode" ? b.wire(r, "2", display, common) : b.wire(r, "2", display, "a")
        const back = polarity === "anode" ? b.wire(display, "a", battery, "-") : b.wire(display, common, battery, "-")
        const { now, leak } = run(b.doc, 0.05, 3 * ALKALINE_CELL_FRESH)
        const drawn = pinAmps(now, battery, "-")
        expect.soft(drawn * 1e3, "the segment lights (mA)").toBeGreaterThan(3)
        expect.soft(wireAmps(now, feed), "battery → resistor").toBeNear(drawn, leak)
        expect.soft(wireAmps(now, lit), "resistor → display").toBeNear(drawn, leak)
        expect.soft(wireAmps(now, back), "display → battery −").toBeNear(drawn, leak)
        expect.soft(pinAmps(now, display, common), `${common}'s lead`).toBeNear(polarity === "anode" ? drawn : -drawn, leak)
      })
    }
})

describe("the 7\" LCD docked on the Open746I-C's P15: its 3.3 V and its return cross by contact, not by wire", () => {
  const b = builder(GRID)
  const board = b.place("open746i-c", 0, 0)
  unplugged(b.doc, board)
  const lcd = b.place("lcd7-f", 3, 59)
  const source = b.place("dc-source", -12, 0, { value: "3.3 V", rint: "0.05 Ω", imax: "10 A" })
  const plus = b.wire(source, "+", board, "P23-1")
  const minus = b.wire(source, "-", board, "P24-1")
  const { now, leak } = run(b.doc, 0.05, 3.3)
  const contacts = pinContacts(b.doc.objects, GRID).groups
  const lcdPins = getDef("lcd7-f")!.pins.map((p) => p.id)
  const lead = (pin: string) => pinAmps(now, lcd, pin)
  const lcdGround = ["3", "29", "36"]

  it("the source's wires carry what the board and the panel draw", () => {
    const drawn = pinAmps(now, source, "-")
    expect.soft(drawn, "the panel's logic and backlight alone are over 0.3 A").toBeGreaterThan(0.3)
    expect.soft(wireAmps(now, plus), "+ wire").toBeNear(drawn, leak)
    expect.soft(wireAmps(now, minus), "− wire").toBeNear(-drawn, leak)
  })

  it("what enters the panel through its leads leaves through its leads: it has no ground of its own", () => {
    const into = lcdPins.reduce((sum, pin) => sum + lead(pin), 0)
    expect.soft(lead("4"), "3.3 V into pin 4 (A)").toBeGreaterThan(0.3)
    expect.soft(into, "the sum over all 40 leads").toBeNear(0, leak)
    expect.soft(-lcdGround.reduce((sum, pin) => sum + lead(pin), 0), "the three GND leads take it back out (A)").toBeGreaterThan(0.3)
  })

  it("the three docked GND pins are three equal paths between the panel's ground plane and the board's: a third each", () => {
    const back = lcdGround.reduce((sum, pin) => sum + lead(pin), 0)
    for (const pin of lcdGround) expect.soft(lead(pin), `pin ${pin}`).toBeNear(back / 3, leak)
  })

  it("at every docked contact, what leaves one lead enters the other", () => {
    let pairs = 0
    for (const pin of lcdPins) {
      const group = contacts.get(pinKey(lcd.id, pin))
      if (group === undefined) continue
      const mates = [...contacts].filter(([key, g]) => g === group && key.startsWith(`${board.id}:`)).map(([key]) => key)
      expect.soft(mates.length, `pin ${pin} docks on one board pin`).toBe(1)
      expect.soft(lead(pin) + (now.pinCurrent[mates[0]] ?? 0), `pin ${pin} ↔ ${mates[0].slice(board.id.length + 1)}`).toBeNear(0, leak)
      pairs++
    }
    expect.soft(pairs, "the FFC's 40 lines are docked").toBe(40)
  })
})

describe("every board and bare chip in the catalogue, fed on each pin of its supply net and returned on each pin of its ground net", () => {
  const powered = allDefs().filter((d) => d.mcuPower && [...groundTiesOf(d).keys()].length > 0)
  for (const def of powered) {
    const ground = [...groundTiesOf(def).keys()][0]
    const groundPins = pinsWith(def, ground)
    const supplyPins = pinsWith(def, def.mcuPower!)
    const volts = def.board?.volts ?? 3.3
    it(`${def.id}: ${volts} V across ${supplyPins.length} supply × ${groundPins.length} ground pins`, () => {
      const cases = [...groundPins.map((g) => [supplyPins[0], g] as const), ...supplyPins.slice(1).map((s) => [s, groundPins[0]] as const)]
      expect.soft(cases.length, "the board has a supply and a ground pin to wire").toBeGreaterThan(0)
      for (const [plusPin, minusPin] of cases) {
        if (plusPin === undefined || minusPin === undefined) continue
        const b = builder(GRID)
        const board = b.place(def.id, 0, 0)
        unplugged(b.doc, board)
        const source = b.place("dc-source", -12, 0, { value: `${volts} V`, rint: "0.1 Ω", imax: "10 A" })
        const plus = b.wire(source, "+", board, plusPin)
        const minus = b.wire(source, "-", board, minusPin)
        const { now, leak } = run(b.doc, 0.03, volts)
        const drawn = pinAmps(now, source, "-")
        expect.soft(drawn, `${plusPin} → ${minusPin}: the part draws current`).toBeGreaterThan(1e-6)
        expect.soft(wireAmps(now, plus), `${plusPin}: the + wire carries the source's current`).toBeNear(drawn, leak)
        expect.soft(wireAmps(now, minus), `${minusPin}: the − wire carries it back`).toBeNear(-drawn, leak)
        expect.soft(pinAmps(now, board, plusPin), `${plusPin}'s lead`).toBeNear(drawn, leak)
        expect.soft(pinAmps(now, board, minusPin), `${minusPin}'s lead`).toBeNear(-drawn, leak)
      }
    })
  }
})

describe("a bare chip fed from a rail, its ground pins left unwired: the return goes through the reference, no lead carries it", () => {
  for (const id of ["pic16f627", "atmega328p", "stm32f405rg"]) {
    it(id, () => {
      const def = getDef(id)!
      const b = builder(GRID)
      const chip = b.place(id, 0, 0)
      const rail = b.place("supply", -10, 0, { value: "+3V3", voltage: "3.3 V" })
      const feed = b.wire(rail, "V", chip, pinsWith(def, def.mcuPower!)[0])
      const { now, leak } = run(b.doc, 0.03, 3.3)
      expect.soft(wireAmps(now, feed), "the rail feeds the chip").toBeGreaterThan(1e-6)
      expect.soft(pinAmps(now, chip, pinsWith(def, def.mcuPower!)[0]), "its supply lead carries what the wire brings").toBeNear(wireAmps(now, feed), leak)
      for (const pin of pinsWith(def, [...groundTiesOf(def).keys()][0])) expect.soft(pinAmps(now, chip, pin), `${pin}, with nothing on it`).toBeNear(0, leak)
    })
  }
})

describe("which ground ties take a return: the schematic's own grounds before a part's reference", () => {
  it("a ground symbol and the rails ground a net; every board and chip grounds its own GND pin as a reference", () => {
    const expected = (def: ComponentDef): GroundTie => (def.mcuPower ? "reference" : "schematic")
    let checked = 0
    for (const def of allDefs())
      for (const [node, tie] of groundTiesOf(def)) {
        checked++
        expect.soft(tie, `${def.id} at ${node}`).toBe(expected(def))
      }
    expect.soft(checked, "ties found across the catalogue").toBeGreaterThan(30)
  })
})

type Conductance = { a: string; b: string; g: number }

function bruteForce(nodes: readonly string[], edges: readonly Conductance[], entering: ReadonlyMap<string, number>, reference: string): Map<string, number> {
  const neighbours = new Map<string, string[]>(nodes.map((n) => [n, []]))
  for (const { a, b } of edges) {
    neighbours.get(a)!.push(b)
    neighbours.get(b)!.push(a)
  }
  const pinned = new Set<string>()
  const seen = new Set<string>()
  for (const start of [reference, ...nodes]) {
    if (seen.has(start)) continue
    pinned.add(start)
    const stack = [start]
    seen.add(start)
    while (stack.length)
      for (const next of neighbours.get(stack.pop()!)!) {
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
  }
  const free = nodes.filter((n) => !pinned.has(n))
  const row = new Map(free.map((n, i) => [n, i]))
  const m = free.length
  const a = new Float64Array(m * m)
  const rhs = new Float64Array(m)
  for (const { a: p, b: q, g } of edges) {
    const i = row.get(p)
    const j = row.get(q)
    if (i !== undefined) a[i * m + i] += g
    if (j !== undefined) a[j * m + j] += g
    if (i !== undefined && j !== undefined) {
      a[i * m + j] -= g
      a[j * m + i] -= g
    }
  }
  for (const [n, amps] of entering) if (row.has(n)) rhs[row.get(n)!] += amps
  for (let col = 0; col < m; col++) {
    let p = col
    for (let r = col + 1; r < m; r++) if (Math.abs(a[r * m + col]) > Math.abs(a[p * m + col])) p = r
    for (let c = 0; c < m; c++) [a[col * m + c], a[p * m + c]] = [a[p * m + c], a[col * m + c]]
    ;[rhs[col], rhs[p]] = [rhs[p], rhs[col]]
    for (let r = col + 1; r < m; r++) {
      const f = a[r * m + col] / a[col * m + col]
      for (let c = col; c < m; c++) a[r * m + c] -= f * a[col * m + c]
      rhs[r] -= f * rhs[col]
    }
  }
  const x = new Float64Array(m)
  for (let r = m - 1; r >= 0; r--) {
    let s = rhs[r]
    for (let c = r + 1; c < m; c++) s -= a[r * m + c] * x[c]
    x[r] = s / a[r * m + r]
  }
  const phi = new Map(nodes.map((n) => [n, row.has(n) ? x[row.get(n)!] : 0]))
  return phi
}

describe("the wire currents are the limit of a real conductance network: traces and contacts ≫ wires ≫ the schematic's grounds ≫ a part's reference", () => {
  const wire = (id: string, from: string, to: string): Wire => {
    const [fo, fp] = from.split(":")
    const [to_, tp] = to.split(":")
    return { id, from: { object: fo, pin: fp }, to: { object: to_, pin: tp } }
  }
  const wires: Wire[] = [
    wire("bat+", "T:+", "A:V1"),
    wire("bat-", "T:-", "S1:GND"),
    wire("a-gnd", "A:G1", "S1:GND"),
    wire("io", "A:IO", "R:1"),
    wire("io-b", "R:2", "B:IO"),
    wire("b-gnd", "B:G2", "S2:GND"),
    wire("a-b", "B:G1", "A:G3"),
    wire("a-b-2", "B:G2", "A:G1"),
    wire("on-itself", "A:G2", "A:G3"),
    wire("lcd-v", "L:V", "T:+"),
  ]
  const shorts = [
    ["A:G1", "A:G2", "A:G3", "A:$gnd"],
    ["A:V1", "A:V2", "A:$v"],
    ["B:G1", "B:G2", "B:$gnd"],
    ["L:G1", "L:G2", "L:$gnd"],
  ]
  const contacts = new Map([
    ["A:G2", "A:G2"],
    ["L:G1", "A:G2"],
    ["A:G3", "A:G3"],
    ["L:G2", "A:G3"],
    ["A:V2", "A:V2"],
    ["L:V", "A:V2"],
    ["S1:GND", "S1:GND"],
    ["S3:GND", "S1:GND"],
  ])
  const ties = new Map<string, GroundTie>([
    ["A:$gnd", "reference"],
    ["B:$gnd", "reference"],
    ["S1:GND", "schematic"],
    ["S2:GND", "schematic"],
    ["S3:GND", "schematic"],
  ])
  const pins = ["T:+", "T:-", "A:V1", "A:V2", "A:G1", "A:G2", "A:G3", "A:IO", "R:1", "R:2", "B:IO", "B:G1", "B:G2", "S1:GND", "S2:GND", "S3:GND", "L:G1", "L:G2", "L:V"]
  const parent = new Map<string, string>()
  const find = (k: string): string => {
    const p = parent.get(k) ?? k
    if (p === k) return k
    const root = find(p)
    parent.set(k, root)
    return root
  }
  for (const group of shorts) for (const k of group) parent.set(find(k), find(group[0]))
  for (const [k, c] of contacts) parent.set(find(k), find(c))
  const keys = [...new Set([...shorts.flat(), ...contacts.keys(), ...contacts.values()])]
  const net: FlowNet = {
    pinNet: new Map(pins.map((p, i) => [p, i])),
    groundTies: ties,
    contacts,
    conductorOf: new Map(keys.map((k) => [k, find(k)])),
    partShorts: shorts,
  }
  const solver = new FlowSolver(wires, net)

  function terminals(seed: number): Map<string, number> {
    let s = seed
    const random = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1
    const t = new Map<string, number>()
    for (const k of ["A:$gnd", "A:$v", "A:IO", "B:IO", "B:$gnd", "T:-", "L:$gnd", "L:V", "S1:GND"]) t.set(k, random() * 0.05)
    t.set("T:+", -(t.get("A:$v")! + t.get("L:V")!))
    t.set("R:1", -t.get("A:IO")!)
    t.set("R:2", -t.get("B:IO")!)
    return t
  }

  function limit(t: ReadonlyMap<string, number>, eps: number) {
    const nodes = [...new Set([...pins, ...keys, ...t.keys(), "⏚", ...shorts.map((_, i) => `hub${i}`), ...[...contacts.values()].map((c) => `contact ${c}`)])]
    const edges: Conductance[] = [
      ...wires.map((w) => ({ a: pinKey(w.from.object, w.from.pin), b: pinKey(w.to.object, w.to.pin), g: 1 })),
      ...shorts.flatMap((group, i) => group.map((k) => ({ a: `hub${i}`, b: k, g: 1 / eps }))),
      ...[...contacts].map(([k, c]) => ({ a: `contact ${c}`, b: k, g: 1 / eps })),
      ...[...ties].map(([k, tie]) => ({ a: k, b: "⏚", g: tie === "schematic" ? eps : eps * eps })),
    ]
    let total = 0
    const entering = new Map<string, number>()
    const plane = (k: string) => {
      const i = shorts.findIndex((group) => group.includes(k))
      return i < 0 ? k : `hub${i}`
    }
    for (const [k, amps] of t) {
      entering.set(plane(k), (entering.get(plane(k)) ?? 0) - amps)
      total += amps
    }
    entering.set("⏚", total)
    const phi = bruteForce(nodes, edges, entering, "⏚")
    const through = (a: string, b: string, g: number) => g * (phi.get(a)! - phi.get(b)!)
    const wireAmpsOf = new Map(wires.map((w) => [w.id, through(pinKey(w.from.object, w.from.pin), pinKey(w.to.object, w.to.pin), 1)]))
    const leads = new Map<string, number>()
    for (const pin of pins) {
      let amps = 0
      for (const w of wires) {
        if (pinKey(w.to.object, w.to.pin) === pin) amps += wireAmpsOf.get(w.id)!
        if (pinKey(w.from.object, w.from.pin) === pin) amps -= wireAmpsOf.get(w.id)!
      }
      const c = contacts.get(pin)
      if (c) amps += through(`contact ${c}`, pin, 1 / eps)
      leads.set(pin, amps)
    }
    return { wires: wireAmpsOf, leads }
  }

  for (const seed of [1, 7, 42]) {
    it(`random terminal currents (seed ${seed}): the solver is the ε → 0 limit, the error falling with ε`, () => {
      const t = terminals(seed)
      const flow = solver.currents((k) => t.get(k) ?? 0)
      const scale = Math.max(...[...t.values()].map(Math.abs))
      const errors = [1e-1, 1e-2, 1e-3].map((eps) => {
        const exact = limit(t, eps)
        let worst = 0
        for (const w of wires) worst = Math.max(worst, Math.abs((flow.wires.get(w.id) ?? 0) - exact.wires.get(w.id)!))
        for (const pin of solver.leadPins) worst = Math.max(worst, Math.abs((flow.leads.get(pin) ?? 0) - exact.leads.get(pin)!))
        return worst / scale
      })
      expect.soft(errors[1], "ε = 10⁻²: at least five times closer to the solver than at 10⁻¹").toBeLessThan(errors[0] * 0.2)
      expect.soft(errors[2], "ε = 10⁻³: five times closer again").toBeLessThan(errors[1] * 0.2)
      expect.soft(errors[2], "ε = 10⁻³: the solver agrees with the network to 1 % of the largest current").toBeLessThan(1e-2)
      expect.soft(flow.wires.get("on-itself") ?? 0, "a wire between two pins of one trace carries nothing next to the trace").toBe(0)
    })
  }

  const parts: Record<string, readonly string[]> = {
    A: ["A:V1", "A:V2", "A:G1", "A:G2", "A:G3", "A:IO", "A:$gnd", "A:$v"],
    B: ["B:IO", "B:G1", "B:G2", "B:$gnd"],
    L: ["L:G1", "L:G2", "L:V", "L:$gnd"],
    T: ["T:+", "T:-"],
    R: ["R:1", "R:2"],
    S1: ["S1:GND"],
    S2: ["S2:GND"],
    S3: ["S3:GND"],
  }
  const groundNet = ["A:$gnd", "B:$gnd", "L:$gnd", "T:-", "S1:GND", "S2:GND", "S3:GND"]
  const leadOf = (flow: { leads: ReadonlyMap<string, number> }, t: ReadonlyMap<string, number>, pin: string) => flow.leads.get(pin) ?? t.get(pin) ?? 0

  for (const seed of [3, 11]) {
    it(`Kirchhoff at every part (seed ${seed}): its leads bring in what its elements take plus what its ground tie lets go, a third of the surplus per schematic ground`, () => {
      const t = terminals(seed)
      const flow = solver.currents((k) => t.get(k) ?? 0)
      const perTie = -groundNet.reduce((sum, k) => sum + (t.get(k) ?? 0), 0) / 3
      for (const [part, keys] of Object.entries(parts)) {
        const brought = keys.filter((k) => pins.includes(k)).reduce((sum, pin) => sum + leadOf(flow, t, pin), 0)
        const taken = keys.reduce((sum, k) => sum + (t.get(k) ?? 0), 0)
        const grounded = keys.filter((k) => ties.get(k) === "schematic").length * perTie
        expect.soft(brought, `${part}`).toBeNear(taken + grounded, 1e-12)
      }
      expect.soft((flow.wires.get("bat+") ?? 0) - (flow.wires.get("lcd-v") ?? 0), "the battery's + pin: out on its wires exactly what it gives").toBeNear(-t.get("T:+")!, 1e-12)
    })
  }

  it("the loop's linear forms are exact: the currents for any terminal currents are the sum of the unit responses", () => {
    for (const seed of [5, 9]) {
      const t = terminals(seed)
      const flow = solver.currents((k) => t.get(k) ?? 0)
      const summed = { wires: new Map<string, number>(), leads: new Map<string, number>() }
      for (const [key, amps] of t) {
        const unit = solver.unit(key)
        for (const [id, a] of unit.wires) summed.wires.set(id, (summed.wires.get(id) ?? 0) + amps * a)
        for (const [pin, a] of unit.leads) summed.leads.set(pin, (summed.leads.get(pin) ?? 0) + amps * a)
      }
      for (const w of wires) expect.soft(flow.wires.get(w.id) ?? 0, `seed ${seed}, wire ${w.id}`).toBeNear(summed.wires.get(w.id) ?? 0, 1e-12)
      for (const pin of solver.leadPins) expect.soft(flow.leads.get(pin) ?? 0, `seed ${seed}, lead ${pin}`).toBeNear(summed.leads.get(pin) ?? 0, 1e-12)
    }
  })

  it("a transfer that balances inside one conductor still shows in the leads: 1 A from board A's ground plane to the docked panel's", () => {
    const t = new Map([
      ["A:$gnd", -1],
      ["L:$gnd", 1],
    ])
    const flow = solver.currents((k) => t.get(k) ?? 0)
    const sum = (ks: readonly string[]) => ks.reduce((s, k) => s + (flow.leads.get(k) ?? 0), 0)
    expect.soft(sum(["L:G1", "L:G2"]), "into the panel through its two docked GND pins").toBeNear(1, 1e-12)
    expect.soft(sum(["A:G1", "A:G2", "A:G3"]), "out of the board through its GND pins").toBeNear(-1, 1e-12)
    expect.soft((flow.leads.get("L:G1") ?? 0) + (flow.leads.get("A:G2") ?? 0), "the docked pair A:G2 ↔ L:G1, equal and opposite").toBeNear(0, 1e-12)
    for (const w of wires) expect.soft(flow.wires.get(w.id) ?? 0, `no wire carries it: ${w.id}`).toBeNear(0, 1e-12)
  })
})
