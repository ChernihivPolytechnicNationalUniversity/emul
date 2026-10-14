import { describe, expect, it } from "vitest"
import { parseElf } from "@/mcu/elf"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey, type PartState, type PlacedObject, type Schematic } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { BENCH_SINGLE_READING_SPREAD_LSB } from "../lib/adc-bench"
import { buffer, example } from "../lib/firmware"

const STRIP_COLUMNS = { left: { odd: 10, even: 11 }, right: { odd: 39, even: 38 } }
const STRIP_ROWS = 18
const STRIP_LAYOUT = {
  P18: { side: "right", top: 23, reversed: true },
  P19: { side: "right", top: 5, reversed: true },
  P20: { side: "left", top: 5, reversed: false },
  P21: { side: "left", top: 23, reversed: false },
} as const
const STRIPS = ["P18", "P19", "P20", "P21"] as const
const SCHEMATIC_PINOUT = {
  P16: [
    "GND", "5Vin", "PE2", "PE3", "PE4", "PE5", "PE6", "VBAT", "PI8", "PC13",
    "PC14", "PC15", "PI9", "PI10", "PI11", "PF0", "PF1", "PF2", "PF3", "PF4",
    "PF5", "PF6", "PF7", "PF8", "PF9", "PF10", "PH0", "PH1", "RESET", "PC0",
    "PC1", "PC2", "PC3", "VREF+", "PA1", "PA0", "PH2", "PA2", "3.3V", "PH3",
    "3.3V", "GND", "PH4", "GND", "PA3", "PH5", "PA5", "PA4", "PA7", "PA6",
    "PC5", "PC4", "PB1", "PB0", "PF11", "PB2", "PF13", "PF12", "PF15", "PF14",
    "PG1", "PG0", "PE8", "PE7", "PE10", "PE9", "PE12", "PE11", "PE14", "PE13",
    "PB10", "PE15", "PH6", "PB11", "PH8", "PH7", "PH10", "PH9", "3.3V", "PH11",
  ],
  P17: [
    "3.3V", "GND", "PH12", "PB12", "PB13", "PB14", "PB15", "PD8", "PD9", "PD10",
    "PD11", "PD12", "PD13", "PD14", "PD15", "PG2", "PG3", "PG4", "PG5", "PG6",
    "PG7", "PG8", "PC6", "PC7", "PC8", "PC9", "PA8", "PA9", "PA10", "PA11",
    "PA12", "PA13", "PH14", "PH13", "PI0", "PH15", "3.3V", "PI1", "3.3V", "GND",
    "PI2", "GND", "PI3", "PA14", "PA15", "PC10", "PC11", "PC12", "PD0", "PD1",
    "PD2", "PD3", "PD4", "PD5", "PD6", "PD7", "PG9", "PG10", "PG11", "PG12",
    "PG13", "PG14", "PG15", "PB3", "PB4", "PB5", "PB6", "PB7", "BOOT0", "PB8",
    "PB9", "PE0", "PE1", "PDR_ON", "PI4", "PI5", "PI6", "PI7", "GND", "5V",
  ],
  P18: [
    "PE2", "PE3", "PE4", "PE5", "PE6", "PC13", "PI8", "PC15", "PC14", "PI10",
    "PI9", "PF0", "PI11", "PF2", "PF1", "PF4", "PF3", "PF6", "PF5", "PF8",
    "PF7", "PF10", "PF9", "PH1", "PH0", "PC0", "PC1", "PC2", "PC3", "PA0",
    "PA1", "PA2", "PH2", "PH3", "GND", "3.3V",
  ],
  P19: [
    "PH4", "PH5", "PA3", "PA4", "PA5", "PA6", "PA7", "PC4", "PC5", "PB0",
    "PB1", "PB2", "PF11", "PF12", "PF13", "PF14", "PF15", "PG0", "PG1", "PE7",
    "PE8", "PE9", "PE10", "PE11", "PE12", "PE13", "PE14", "PE15", "PB10", "PB11",
    "PH6", "PH7", "PH8", "PH9", "PH10", "PH11",
  ],
  P20: [
    "PH12", "PB12", "PB13", "PB14", "PB15", "PD8", "PD9", "PD10", "PD11", "PD12",
    "PD13", "PD14", "PD15", "PG2", "PG3", "PG4", "PG5", "PG6", "PG7", "PG8",
    "PC6", "PC7", "PC8", "PC9", "PA8", "PA9", "PA10", "PA11", "PA12", "PA13",
    "PH14", "PH13", "PI0", "PH15", "3.3V", "PI1",
  ],
  P21: [
    "PI2", "PA14", "PI3", "PC10", "PA15", "PC12", "PC11", "PD1", "PD0", "PD3",
    "PD2", "PD5", "PD4", "PD7", "PD6", "PG10", "PG9", "PG12", "PG11", "PG14",
    "PG13", "PB3", "PG15", "PB5", "PB4", "PB7", "PB6", "PB8", "PB9", "PE0",
    "PE1", "PI5", "PI4", "PI7", "PI6", "5V",
  ],
}

const board = getDef("open746i-c")!
const elf = example("lab1-f746.elf")
const isGpio = (name: string) => /^P[A-I](?:[0-9]|1[0-5])$/.test(name)
const expectedPins = STRIPS.flatMap((connector) => SCHEMATIC_PINOUT[connector].map((name, index) => ({
  id: `${connector}-${index + 1}`,
  connector,
  connectorPin: index + 1,
  name,
})))
const expectedGpios = expectedPins.map((pin) => pin.name).filter(isGpio)

function pin(id: string) {
  const matches = board.pins.filter((p) => p.id === id)
  expect(matches, `${id} exists exactly once on the board`).toHaveLength(1)
  return matches[0]!
}

function stripPins(connector: typeof STRIPS[number]) {
  const pins = expectedPins.filter((p) => p.connector === connector).map((p) => pin(p.id))
  expect(board.pins.filter((p) => p.connector === connector), `${connector} has 36 contacts`).toHaveLength(36)
  return pins
}

function lab1Document() {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "lab1-f746.elf", firmwareData: elf.toString("base64") }
  return { doc, u }
}

function simulate(doc: Schematic) {
  const loop = new SimLoop()
  let clock = 0
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 30)
      loop.advance(clock)
    }
    const snap = loop.snapshot()
    expect(snap, "the circuit produces a snapshot").not.toBeNull()
    return snap!
  }
  return { loop, run }
}

function volts(snap: Snapshot, object: string, id: string) {
  pin(id)
  const voltage = snap.pinVoltage[pinKey(object, id)]
  expect(Number.isFinite(voltage), `${id} has a solved voltage`).toBe(true)
  return voltage
}

describe("Open746I-C pin strips match the schematic", () => {
  it.each(expectedPins)("exposes $id as $name", ({ id, connector, connectorPin, name }) => {
    const actual = pin(id)
    const label = name === "3.3V" ? "3V3" : name
    const kind = name === "GND" ? "gnd" : isGpio(name) ? "digital" : "power"
    expect(actual, id).toMatchObject({ id, connector, connectorPin, label, kind })
    expect(actual.mcu, `${id} MCU pad`).toBe(isGpio(name) ? name : undefined)
  })

  it.each([
    ["VBAT", "P16", 8],
    ["BOOT0", "P17", 69],
  ] as const)("keeps %s on %s pin %i", (id, connector, connectorPin) => {
    expect(pin(id)).toMatchObject({ id, connector, connectorPin })
  })
})

describe("Open746I-C pin strips follow the board geometry", () => {
  it.each(STRIPS)("places %s on integer cells with its wires leaving outward", (connector) => {
    const layout = STRIP_LAYOUT[connector]
    for (const expected of expectedPins.filter((p) => p.connector === connector)) {
      const actual = pin(expected.id)
      const odd = expected.connectorPin % 2 === 1
      const row = Math.floor((expected.connectorPin - 1) / 2)
      const x = STRIP_COLUMNS[layout.side][odd ? "odd" : "even"]
      const y = layout.top + (layout.reversed ? STRIP_ROWS - 1 - row : row)
      const labelAt = odd ? layout.side : layout.side === "left" ? "right" : "left"
      expect.soft(actual, expected.id).toMatchObject({ x, y, side: layout.side, stub: odd ? 2 : 3, labelAt })
      expect.soft(Number.isInteger(actual.x) && Number.isInteger(actual.y), `${expected.id} lies on the grid`).toBe(true)
    }
  })

  it("gives every pin of the whole board its own point", () => {
    const occupied = new Map<string, string>()
    for (const p of board.pins) {
      const point = `${p.x},${p.y}`
      expect.soft(occupied.get(point), `${p.id} collides with another pin at ${point}`).toBeUndefined()
      occupied.set(point, p.id)
    }
  })
})

describe("Open746I-C strips expose every GPIO with one driver", () => {
  it("exposes exactly 140 distinct GPIOs, each once across the four strips", () => {
    const gpios = STRIPS.flatMap(stripPins).map((p) => p.mcu).filter((name): name is string => name !== undefined)
    expect(gpios).toHaveLength(140)
    expect(new Set(gpios).size, "distinct MCU pads").toBe(140)
    expect(gpios.sort(), "GPIOs from the schematic").toEqual([...expectedGpios].sort())
    for (const name of expectedGpios) expect(gpios.filter((gpio) => gpio === name), name).toHaveLength(1)
  })

  it.each([
    ["P16", "P18", "P19"],
    ["P17", "P20", "P21"],
  ] as const)("carries all 70 GPIOs of %s on %s and %s", (socket, first, second) => {
    const expected = SCHEMATIC_PINOUT[socket].filter(isGpio).sort()
    const actual = [...stripPins(first), ...stripPins(second)].map((p) => p.mcu).filter((name): name is string => name !== undefined).sort()
    expect(expected).toHaveLength(70)
    expect(actual, `${socket} GPIOs on its yellow strips`).toEqual(expected)
  })

  it("includes the GPIO behind every other header pin", () => {
    const strips = STRIPS.flatMap(stripPins)
    const ids = new Set(strips.map((p) => p.id))
    const gpios = new Set(strips.map((p) => p.mcu))
    for (const p of board.pins) {
      if (ids.has(p.id) || !p.mcu || p.mcu === "NRST") continue
      expect.soft(gpios.has(p.mcu), `${p.id} reaches ${p.mcu} on a strip`).toBe(true)
    }
  })

  it("drives each strip GPIO with exactly one GPIO element, including formerly internal joystick pads", () => {
    const drivers = new Map<string, string[]>()
    expect(board.model, "board electrical model").toBeDefined()
    // The CP2102's TXD is a GPIO element of the board too, driven from the terminal on its PC end, not by the MCU.
    const bridgeDrivers = new Set(board.pins.flatMap((p) => (p.hostSerial === "out" && p.hostDriver ? [p.hostDriver] : [])))
    for (const element of board.model!) {
      if (element.kind !== "GPIO" || bridgeDrivers.has(element.node)) continue
      const name = element.node.startsWith("$") ? element.node.slice(1) : pin(element.node).mcu
      expect(name, `${element.node} resolves to an MCU GPIO`).toMatch(/^P[A-I](?:[0-9]|1[0-5])$/)
      const nodes = drivers.get(name!) ?? []
      nodes.push(element.node)
      drivers.set(name!, nodes)
    }
    for (const [name, nodes] of drivers) expect.soft(nodes, `${name} has one GPIO driver`).toHaveLength(1)
    for (const expected of expectedPins.filter((p) => isGpio(p.name))) {
      pin(expected.id)
      expect.soft(drivers.get(expected.name) ?? [], `${expected.name} on ${expected.id} has one GPIO driver`).toHaveLength(1)
    }
  })
})

describe("Open746I-C strip voltages follow lab 1", () => {
  it("shares the USER LED signals with their peripheral headers as the staircase advances", () => {
    const { doc, u } = lab1Document()
    const { run } = simulate(doc)
    const boot = run(0.05)
    expect(boot.mcus[u.id]?.firmware, "MCU loaded").toBe("lab1-f746.elf")
    expect(boot.mcus[u.id]?.running, "core running").toBe(true)
    expect(boot.mcus[u.id]?.sysclk, "SYSCLK").toBe(50e6)
    expect(boot.parts[partKey(u.id, "LED1")]?.on, "LED1 starts on").toBe(true)
    expect(boot.parts[partKey(u.id, "LED3")]?.on, "LED3 starts off").toBe(false)
    expect(volts(boot, u.id, "P21-27"), "PB6 on P21 and P3").toBeNear(volts(boot, u.id, "P3-6"), 0.02)
    expect(volts(boot, u.id, "P19-1"), "PH4 on P19 and CN4 while LED3 is off").toBeNear(volts(boot, u.id, "CN4-3"), 0.02)
    expect(volts(boot, u.id, "P19-1"), "PH4 starts low").toBeNear(0, 0.05)
    const lit = run(3.1)
    expect(lit.parts[partKey(u.id, "LED3")]?.on, "LED3 turns on at 3 s").toBe(true)
    expect(volts(lit, u.id, "P19-1"), "PH4 on P19 and CN4 while LED3 is on").toBeNear(volts(lit, u.id, "CN4-3"), 0.02)
    expect(volts(lit, u.id, "P19-1"), "PH4 is driven high").toBeGreaterThan(3)
    expect(volts(lit, u.id, "P21-27"), "PB6 still shares P3-6").toBeNear(volts(lit, u.id, "P3-6"), 0.02)
  })

  it("pulls P21-13 low while joystick C is pressed and high again on release", () => {
    const { doc, u } = lab1Document()
    const { loop, run } = simulate(doc)
    const flash = { [partKey(u.id, "BOOT")]: { on: false } }
    expect(volts(run(0.05), u.id, "P21-13"), "PD4 idles high").toBeNear(3.3, 0.05)
    loop.setParts({ ...flash, [partKey(u.id, "JOY_C")]: { pressed: true } })
    expect(volts(run(0.05), u.id, "P21-13"), "PD4 while C is pressed").toBeNear(0, 0.05)
    loop.setParts({ ...flash, [partKey(u.id, "JOY_C")]: { pressed: false } })
    expect(volts(run(0.05), u.id, "P21-13"), "PD4 released").toBeNear(3.3, 0.05)
  })

  it("brings 3.3 V, 5 V and ground to the strip supply contacts", () => {
    const { doc, u } = lab1Document()
    const snap = simulate(doc).run(0.05)
    expect.soft(volts(snap, u.id, "P18-36"), "P18 3V3").toBeNear(3.3, 0.02)
    expect.soft(volts(snap, u.id, "P20-35"), "P20 3V3").toBeNear(3.3, 0.02)
    expect.soft(volts(snap, u.id, "P21-36"), "P21 5V").toBeNear(5, 0.05)
    expect.soft(volts(snap, u.id, "P18-35"), "P18 GND").toBeNear(0, 0.02)
  })
})

describe("Open746I-C strip pins accept external wiring", () => {
  it("lights a red LED through 1 kΩ from P21-27 to P18-35 with the same current as P3-6", () => {
    pin("P21-27")
    pin("P18-35")
    const { doc, u } = lab1Document()
    const load = builder(GRID)
    const stripResistor = load.place("resistor", 80, 10, { value: "1 kΩ" })
    const stripLed = load.place("led", 88, 10, { value: "red" })
    const headerResistor = load.place("resistor", 80, 16, { value: "1 kΩ" })
    const headerLed = load.place("led", 88, 16, { value: "red" })
    load.wire(u, "P21-27", stripResistor, "1")
    load.wire(stripResistor, "2", stripLed, "1")
    load.wire(stripLed, "2", u, "P18-35")
    load.wire(u, "P3-6", headerResistor, "1")
    load.wire(headerResistor, "2", headerLed, "1")
    load.wire(headerLed, "2", u, "P24-1")
    doc.objects.push(...load.doc.objects)
    doc.wires.push(...load.doc.wires)
    const snap = simulate(doc).run(0.05)
    expect(snap.parts[partKey(u.id, "LED1")]?.on, "the firmware drives LED1").toBe(true)
    const current = (object: string) => {
      const reading = snap.readings.find((r) => r.object === object && r.element === 0)
      expect(reading, `${object} has a current reading`).toBeDefined()
      return reading!.current
    }
    const stripCurrent = current(stripLed.id)
    const headerCurrent = current(headerLed.id)
    expect.soft(stripCurrent * 1e3, "strip LED forward current in mA").toBeNear(1.4, 0.3)
    expect.soft(headerCurrent * 1e3, "header LED forward current in mA").toBeNear(1.4, 0.3)
    expect.soft(stripCurrent, "same current through strip and peripheral header").toBeNear(headerCurrent, 1e-6)
    expect.soft(current(stripResistor.id), "series resistor carries the strip LED current").toBeNear(stripCurrent, 1e-6)
    expect.soft(snap.parts[partKey(stripLed.id, "LED")]?.on, "strip LED is lit").toBe(true)
    expect.soft(snap.parts[partKey(headerLed.id, "LED")]?.on, "header LED is lit").toBe(true)
    expect.soft(snap.damage, "the external loads damage nothing").toEqual({})
  })
})

const portsElf = example("open746-ports.elf")
const BENCH = parseElf(buffer(portsElf)).symbols.find((s) => s.name === "bench")!.value
const LEVELS = BENCH + 16
const PORTS = 9
const NO_PAD = 0xffff
const Command = { drive: 1, listenPulledDown: 2, listenPulledUp: 3, measure: 4 } as const
const ANALOG = LEVELS + PORTS * 2
const ANALOG_INPUTS = ["PA0", "PA1", "PA2", "PA3", "PA4", "PA5", "PA6", "PA7", "PB0", "PB1", "PC0", "PC1", "PC2", "PC3", "PC4", "PC5", "PF6", "PF7", "PF8", "PF9", "PF10", "PF3", "PF4", "PF5"]
const stripGpios = expectedPins.filter((p) => isGpio(p.name))
const padOf = (name: string) => (name.charCodeAt(1) - 65) * 16 + Number(name.slice(2))
const freedFromTheBoard = Object.fromEntries(
  ["JMP2_1", "JMP2_2", "JMP2_3", "JMP2_4", "JMP3_1", "JMP3_2", "JMP3_3", "JMP3_4", "JMP4_1", "JMP4_2", "JMP4_3", "JMP4_4", "JMP4_5", "JMP5_A4", "JMP5_A5", "JMP6", "OTG_VBUS", "OTG_PWR", "OTG_FLG"].map((jumper) => [jumper, { on: false }]),
)

function portsBench(extend: (u: PlacedObject, doc: Schematic) => void = () => {}) {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "open746-ports.elf", firmwareData: portsElf.toString("base64") }
  extend(u, doc)
  const sim = simulate(doc)
  let sequence = 0
  const boardParts = (extra: Record<string, PartState> = {}) => ({
    ...Object.fromEntries(Object.entries(freedFromTheBoard).map(([jumper, state]) => [partKey(u.id, jumper), state])),
    ...extra,
  })
  const order = async (command: number, pad = NO_PAD) => {
    sequence++
    const word = (value: number) => new Uint8Array(new Uint32Array([value]).buffer)
    await sim.loop.inspect(u.id, {
      write: [
        { kind: "memory", addr: BENCH + 8, bytes: word(command) },
        { kind: "memory", addr: BENCH + 12, bytes: word(pad) },
        { kind: "memory", addr: BENCH, bytes: word(sequence) },
      ],
    })
    for (let tries = 0; tries < 20; tries++) {
      sim.run(0.001)
      const reply = await sim.loop.inspect(u.id, { ranges: [{ addr: BENCH + 4, size: 4 }] })
      const applied = new DataView(reply!.memory[0].bytes.buffer, reply!.memory[0].bytes.byteOffset).getUint32(0, true)
      if (applied === sequence) return
    }
    throw new Error(`the firmware never applied command ${command} for pad ${pad}`)
  }
  const levels = async () => {
    const reply = await sim.loop.inspect(u.id, { ranges: [{ addr: LEVELS, size: PORTS * 2 }] })
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return (name: string) => (view.getUint16(Math.floor(padOf(name) / 16) * 2, true) >> padOf(name) % 16) & 1
  }
  const analog = async () => {
    const reply = await sim.loop.inspect(u.id, { ranges: [{ addr: ANALOG, size: ANALOG_INPUTS.length * 2 }] })
    const bytes = reply!.memory[0].bytes
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return ANALOG_INPUTS.map((_, i) => view.getUint16(i * 2, true))
  }
  return { ...sim, u, order, levels, analog, boardParts }
}

describe("every strip pin is the MCU pad it names, driven by the firmware", () => {
  it("one pad at a time high: only its own strip pin rises, all 139 others stay low", async () => {
    const bench = portsBench()
    bench.loop.setProbes(stripGpios.map((p) => ({ id: p.id, a: pinKey(bench.u.id, p.id), b: null })))
    bench.loop.setParts(bench.boardParts())
    bench.run(0.02)
    const wrong: string[] = []
    for (const lit of stripGpios) {
      await bench.order(Command.drive, padOf(lit.name))
      const snap = bench.run(0.001)
      for (const p of stripGpios) {
        const v = snap.pinVoltage[pinKey(bench.u.id, p.id)]
        const high = p === lit
        if (!(high ? v > 3 : v < 0.3)) wrong.push(`${lit.name} lit: ${p.id} (${p.name}) at ${v?.toFixed(2)} V`)
      }
    }
    expect(wrong.slice(0, 20), `${wrong.length} wrong readings`).toEqual([])
  })
})

describe("every strip pin reaches the MCU pad it names, read by the firmware", () => {
  async function walk(pull: "down" | "up") {
    const rail = pull === "down" ? "P18-36" : "P18-35"
    const switches = new Map<string, PlacedObject>()
    const bench = portsBench((u, doc) => {
      const load = builder(GRID)
      stripGpios.forEach((p, i) => {
        const sw = load.place("switch", 90 + (i % 14) * 6, 4 + Math.floor(i / 14) * 6)
        load.wire(u, p.id, sw, "1")
        load.wire(sw, "2", u, rail)
        switches.set(p.id, sw)
      })
      doc.objects.push(...load.doc.objects)
      doc.wires.push(...load.doc.wires)
    })
    const allOpen = Object.fromEntries([...switches.values()].map((sw) => [partKey(sw.id, "SW"), { on: false }]))
    bench.loop.setParts(bench.boardParts(allOpen))
    bench.run(0.02)
    await bench.order(pull === "down" ? Command.listenPulledDown : Command.listenPulledUp)
    const idle = pull === "down" ? 0 : 1
    const wrong: string[] = []
    const before = await bench.levels()
    for (const p of stripGpios) if (before(p.name) !== idle) wrong.push(`nothing closed: ${p.name} reads ${before(p.name)}`)
    for (const closed of stripGpios) {
      bench.loop.setParts(bench.boardParts({ ...allOpen, [partKey(switches.get(closed.id)!.id, "SW")]: { on: true } }))
      bench.run(0.001)
      bench.run(0.001)
      const read = await bench.levels()
      for (const p of stripGpios) {
        const want = p === closed ? 1 - idle : idle
        if (read(p.name) !== want) wrong.push(`${closed.id} to ${rail}: ${p.name} reads ${read(p.name)}`)
      }
    }
    return wrong
  }

  it("pulled down inside, one strip pin at a time switched to 3.3 V: only its own pad reads 1", async () => {
    const wrong = await walk("down")
    expect(wrong.slice(0, 20), `${wrong.length} wrong readings`).toEqual([])
  })

  it("pulled up inside, one strip pin at a time switched to ground: only its own pad reads 0", async () => {
    const wrong = await walk("up")
    expect(wrong.slice(0, 20), `${wrong.length} wrong readings`).toEqual([])
  })
})

describe("every analog strip pin reaches the ADC channel of the pad it names", () => {
  it("a 25-step resistor ladder on the 24 ADC-capable strip pins reads back step by step on ADC1 and ADC3", async () => {
    const taps = ANALOG_INPUTS.map((name) => stripGpios.find((p) => p.name === name)!)
    const rungs: PlacedObject[] = []
    const bench = portsBench((u, doc) => {
      const ladder = builder(GRID)
      for (let i = 0; i <= taps.length; i++) rungs.push(ladder.place("resistor", 90, 4 + i * 4, { value: "1 kΩ" }))
      ladder.wire(u, "P18-36", rungs[0], "1")
      for (let i = 0; i < taps.length; i++) {
        ladder.wire(rungs[i], "2", rungs[i + 1], "1")
        ladder.wire(rungs[i], "2", u, taps[i].id)
      }
      ladder.wire(rungs[taps.length], "2", u, "P18-35")
      doc.objects.push(...ladder.doc.objects)
      doc.wires.push(...ladder.doc.wires)
    })
    bench.loop.setParts(bench.boardParts())
    bench.run(0.02)
    await bench.order(Command.measure)
    const snap = bench.run(0.001)
    const codes = await bench.analog()
    const rail = volts(snap, bench.u.id, "P18-36")
    taps.forEach((tap, i) => {
      const v = volts(snap, bench.u.id, tap.id)
      expect.soft(v, `${tap.id} (${tap.name}) sits on rung ${i + 1}`).toBeNear((rail * (taps.length - i)) / (taps.length + 1), 0.01)
      expect.soft(codes[i], `${tap.name} on ${tap.id}: ADC code for ${v.toFixed(3)} V, one conversion within the bench's single-reading spread`).toBeNear((v / rail) * 4095, BENCH_SINGLE_READING_SPREAD_LSB)
    })
  })
})
