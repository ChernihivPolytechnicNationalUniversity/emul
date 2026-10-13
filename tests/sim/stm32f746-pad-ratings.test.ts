import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STM32F746IG } from "@/mcu/chip"
import { parsePad } from "@/mcu/pads"
import { builder } from "@/schematic/builder"
import { lab1Board } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { getDef } from "@/schematic/registry"
import { partKey, pinKey, type PartState, type PlacedObject } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { example } from "../lib/firmware"

type ElectricalTable = { table: number; rows: Record<string, string>[] }
type PinRow = { port_pin: string | null; type: string; io_structure: string; notes: number[] }

const DATA = join(import.meta.dirname, "..", "data", "ds10916")
const ELECTRICAL: { tables: ElectricalTable[] } = JSON.parse(readFileSync(join(DATA, "ds10916-rev5-electrical.json"), "utf8"))
const TABLE_10: PinRow[] = JSON.parse(readFileSync(join(DATA, "ds10916-rev5-pins.json"), "utf8"))
const table = (n: number) => ELECTRICAL.tables.find((t) => t.table === n)!.rows
const row = (n: number, column: string, text: string) => table(n).find((r) => r[column].replace(/\s/g, "") === text.replace(/\s/g, ""))!
const number = (cell: string) => Number(cell.replace(/\s/g, "").replace("−", "-"))
const pads = STM32F746IG.electrical.pads!

const board = getDef("open746i-c")!
const STRIP = /^P(18|19|20|21)-\d+$/
const strip = (pad: string) => board.pins.find((p) => STRIP.test(p.id) && p.mcu === pad)!.id
const STRIP_3V3 = "P20-35"
const STRIP_GND = "P18-35"
const PORTS_ELF = example("open746-ports.elf")
const EVERY_JUMPER = ["JMP2_1", "JMP2_2", "JMP2_3", "JMP2_4", "JMP3_1", "JMP3_2", "JMP3_3", "JMP3_4", "JMP4_1", "JMP4_2", "JMP4_3", "JMP4_4", "JMP4_5", "JMP5_A4", "JMP5_A5", "JMP6", "OTG_VBUS", "OTG_PWR", "OTG_FLG"]
const GPIO_BASE = 0x40020000
const GPIO = { MODER: 0x00, PUPDR: 0x0c, ODR: 0x14 }
const R_GPIO = STM32F746IG.electrical.outputOhms!
const AMS1117_VOLTS = 3.29
const PIN_LAB_2026_10_12 = { ph4HighMv: 3262, pi8HighMv: 3224, ledMa: 1.44 }

type Load = (u: PlacedObject, b: ReturnType<typeof builder>) => void

function boardWith(load: Load, keep: string[] = [], unplugged: Record<string, PartState> = {}) {
  const doc = lab1Board.build(GRID)
  const u = doc.objects.find((o) => o.def === "open746i-c")!
  u.props = { ...u.props, firmware: "open746-ports.elf", firmwareData: PORTS_ELF.toString("base64") }
  const b = builder(GRID)
  load(u, b)
  doc.objects.push(...b.doc.objects)
  doc.wires.push(...b.doc.wires)
  const loop = new SimLoop()
  loop.setDoc(doc)
  const parts: Record<string, PartState> = { ...doc.parts }
  for (const jumper of EVERY_JUMPER) if (!keep.includes(jumper)) parts[partKey(u.id, jumper)] = { on: false }
  for (const [part, state] of Object.entries(unplugged)) parts[partKey(u.id, part)] = state
  loop.setParts(parts)
  loop.setRunning(true)
  let clock = 0
  loop.advance(clock)
  const run = (seconds: number) => {
    const end = clock + seconds * 1000
    while (clock < end) {
      clock = Math.min(end, clock + 20)
      loop.advance(clock)
    }
    return loop.snapshot()!
  }
  const volts = (snap: Snapshot, pad: string) => snap.pinVoltage[pinKey(u.id, strip(pad))]
  const outputs = async (levels: Record<string, boolean>, pullUps: string[] = []) => {
    const ports = new Map<number, { moder: number; odr: number; pupdr: number }>()
    const portOf = (port: number) => ports.get(port) ?? ports.set(port, { moder: 0, odr: 0, pupdr: 0 }).get(port)!
    for (const [name, level] of Object.entries(levels)) {
      const p = parsePad(name)!
      const regs = portOf(p.port)
      regs.moder |= 1 << (2 * p.pin)
      if (level) regs.odr |= 1 << p.pin
    }
    for (const name of pullUps) {
      const p = parsePad(name)!
      portOf(p.port).pupdr |= 1 << (2 * p.pin)
    }
    const word = (value: number) => new Uint8Array(new Uint32Array([value >>> 0]).buffer)
    const base = (port: number) => GPIO_BASE + 0x400 * port
    await loop.inspect(u.id, {
      write: [...ports].flatMap(([port, regs]) => [
        { kind: "memory" as const, addr: base(port) + GPIO.ODR, bytes: word(regs.odr) },
        { kind: "memory" as const, addr: base(port) + GPIO.PUPDR, bytes: word(regs.pupdr) },
        { kind: "memory" as const, addr: base(port) + GPIO.MODER, bytes: word(regs.moder) },
      ]),
    })
  }
  const padCurrent = (snap: Snapshot, pad: string) => {
    const index = board.model!.findIndex((el) => el.kind === "GPIO" && (el.node.startsWith("$") ? el.node.slice(1) : board.pins.find((p) => p.id === el.node)?.mcu) === pad)
    return snap.readings.find((r) => r.object === u.id && r.element === index)!.current
  }
  return { u, run, volts, outputs, padCurrent }
}

const source = (volts: number, pad: string, ohms?: number): Load => (u, b) => {
  const rail = b.place("supply", 96, 4, { value: `${volts} V`, voltage: `${volts} V`, imax: "10 A" })
  if (ohms === undefined) return b.wire(rail, "V", u, strip(pad))
  const r = b.place("resistor", 100, 4, { value: `${ohms} Ω`, power: "10" })
  b.wire(rail, "V", r, "1")
  b.wire(r, "2", u, strip(pad))
}
const toGround = (pad: string, ohms: number): Load => (u, b) => {
  const r = b.place("resistor", 100, 10 + 3 * parsePad(pad)!.pin, { value: `${ohms} Ω`, power: "10" })
  b.wire(u, strip(pad), r, "1")
  b.wire(r, "2", u, STRIP_GND)
}
const to3v3 = (pad: string, ohms: number): Load => (u, b) => {
  const r = b.place("resistor", 104, 10 + 3 * parsePad(pad)!.pin, { value: `${ohms} Ω`, power: "10" })
  b.wire(u, strip(pad), r, "1")
  b.wire(r, "2", u, STRIP_3V3)
}
const both = (...loads: Load[]): Load => (u, b) => loads.forEach((load) => load(u, b))

describe("the F746 pad classes are DS10916 Rev 5's", () => {
  const gpios = TABLE_10.filter((p) => p.port_pin && p.type === "I/O")

  it("TTa: PA4 and PA5, every other GPIO FT (Table 10)", () => {
    expect(gpios.filter((p) => p.io_structure === "TTa").map((p) => p.port_pin)).toEqual(pads.tta.pads)
    expect(gpios.filter((p) => p.io_structure !== "TTa").every((p) => p.io_structure === "FT")).toBe(true)
  })

  it("the backup domain: the pads with Table 10 note 2 (PC13, PC14, PC15, PI8)", () => {
    expect(gpios.filter((p) => p.notes.includes(2)).map((p) => p.port_pin).sort()).toEqual([...pads.backupDomain.pads].sort())
  })

  it("absolute maximum VIN: FT VDD + 4.0 V, TTa 4.0 V, BOOT 9.0 V (Table 15, p. 120)", () => {
    expect(row(15, "ratings", "Input voltage on FT pins").max).toBe(`VDD+${pads.ft.aboveVdd.toFixed(1)}`)
    expect(number(row(15, "ratings", "Input voltage on TTa pins").max)).toBe(pads.tta.voltageMax)
    expect(number(row(15, "ratings", "Input voltage on BOOT pin").max)).toBe(STM32F746IG.electrical.bootVoltageMax)
  })

  it("absolute maximum current: IIO 25 mA a pin, IINJ −5/+0 mA on FT and ±5 mA on TTa (Table 16, p. 121)", () => {
    expect(number(row(16, "ratings", "Output current sunk by any I/O and control pin").max) / 1e3).toBe(STM32F746IG.electrical.pinCurrentMax)
    expect(row(16, "ratings", "Injected current on FT, FTf, RST and B pins").max.replace(/\s/g, "")).toBe(`−${pads.injectedCurrentMax * 1e3}/+0`)
    expect(row(16, "ratings", "Injected current on TTa pins").max).toBe(`±${pads.injectedCurrentMax * 1e3}`)
  })

  it("weak pulls 40 kΩ typical, 10 kΩ on PA10/PB12 (Table 57)", () => {
    const pulls = table(57).filter((r) => r.symbol === "RPU")
    expect(pulls.find((r) => r.pins.startsWith("All pins"))!.typ).toBe("40")
    expect(pulls.find((r) => r.pins.startsWith("PA10/PB12"))!.typ).toBe(String(pads.otgId.pullOhms / 1e3))
    expect(pads.otgId.pads).toEqual(["PA10", "PB12"])
  })
})

describe("voltage on an input pad (pads float, every board jumper open)", () => {
  it("5 V on FT PB6 is fine: no positive clamp, below VDD + 4 V", () => {
    const bench = boardWith(source(5, "PB6"))
    const snap = bench.run(0.05)
    expect(snap.damage).toEqual({})
    expect(bench.volts(snap, "PB6")).toBeNear(5, 0.01)
  })

  it("7.0 V on FT PB6 is still inside VDD + 4.0 V; 7.5 V burns the MCU (VDD is the board's 3.29 V)", () => {
    expect(boardWith(source(7, "PB6")).run(0.05).damage).toEqual({})
    const burnt = boardWith(source(7.5, "PB6"))
    const snap = burnt.run(0.05)
    expect(snap.damage[burnt.u.id]?.reason, "the board's MCU").toMatch(/^voltage 7\.5\d* V exceeds the 7\.29\d* V rating$/)
  })

  it("5 V on FT PB6 with both USB cables out burns it: VDD + 4.0 V is 4 V with VDD at 0 V", () => {
    const bench = boardWith(source(5, "PB6"), [], { USB: { on: false }, MUSB: { on: false } })
    const snap = bench.run(0.05)
    expect(snap.damage[bench.u.id]?.reason).toMatch(/^voltage 5(\.0+)? V exceeds the 4\.0\d* V rating$/)
  })

  it("5 V straight onto TTa PA4 burns the MCU", () => {
    const bench = boardWith(source(5, "PA4"))
    expect(bench.run(0.05).damage[bench.u.id], "the board's MCU").toBeTruthy()
  })

  it("5 V through 10 kΩ on TTa PA4 is fine: the clamp to VDD takes 0.1 mA, the pad stays under 4 V", () => {
    const bench = boardWith(source(5, "PA4", 10e3))
    const snap = bench.run(0.05)
    expect(snap.damage).toEqual({})
    expect(bench.volts(snap, "PA4"), "clamped a junction above 3.3 V").toBeGreaterThan(3.7)
    expect(bench.volts(snap, "PA4"), "inside Table 15's 4.0 V").toBeLessThan(pads.tta.voltageMax)
  })

  it("5 V through 150 Ω on TTa PA4 injects about 7 mA, past ±5 mA, and burns it", () => {
    const bench = boardWith(source(5, "PA4", 150))
    expect(bench.run(0.2).damage[bench.u.id]?.reason).toMatch(/^current 6\.\d+ mA exceeds the 5(\.0+)? mA rating$/)
  })

  it("−5 V through 10 kΩ on FT PB6 injects 0.4 mA and is fine; through 470 Ω, 9 mA, it burns", () => {
    const fine = boardWith(source(-5, "PB6", 10e3))
    const snap = fine.run(0.05)
    expect(snap.damage).toEqual({})
    expect(fine.volts(snap, "PB6"), "clamped a junction below ground").toBeLessThan(-0.4)
    const burnt = boardWith(source(-5, "PB6", 470))
    expect(burnt.run(0.1).damage[burnt.u.id]?.reason).toMatch(/current/)
  })
})

describe("current out of a driven pad", () => {
  it("PB6 high into 150 Ω sources about 19 mA, inside 25 mA; into 68 Ω, 35 mA, it burns", async () => {
    const fine = boardWith(toGround("PB6", 150))
    fine.run(0.02)
    await fine.outputs({ PB6: true })
    const snap = fine.run(0.05)
    expect(snap.damage).toEqual({})
    expect(-fine.padCurrent(snap, "PB6") * 1e3, "mA").toBeNear(AMS1117_VOLTS / (150 + R_GPIO) * 1e3, 0.3)
    const burnt = boardWith(toGround("PB6", 68))
    burnt.run(0.02)
    await burnt.outputs({ PB6: true })
    expect(burnt.run(0.2).damage[burnt.u.id]?.reason).toMatch(/^current .* exceeds the 25(\.0+)? mA rating$/)
  })
})

describe("the backup-domain pads PC13–PC15 and PI8 behind the power switch", () => {
  it("LED4 on PI8 sags more than twice as far as LED1 on PB6, as the pin lab measured LED4 against LED3", async () => {
    const bench = boardWith(() => {}, ["JMP3_1", "JMP3_4"])
    bench.run(0.02)
    await bench.outputs({ PB6: true, PI8: true })
    const snap = bench.run(0.05)
    expect(snap.damage).toEqual({})
    expect(snap.parts[partKey(bench.u.id, "LED1")]?.on).toBe(true)
    expect(snap.parts[partKey(bench.u.id, "LED4")]?.on, "PI8 still lights its LED").toBe(true)
    const rail = snap.pinVoltage[pinKey(bench.u.id, STRIP_3V3)]
    const drop = (pad: string) => rail - bench.volts(snap, pad)
    const current = (pad: string) => -bench.padCurrent(snap, pad)
    expect(drop("PB6") / current("PB6"), "PB6 source resistance, Ω").toBeNear(R_GPIO, 0.5)
    expect((drop("PI8") - pads.backupDomain.switchDrop) / current("PI8"), "PI8 source resistance past the switch's own drop, Ω").toBeNear(R_GPIO + pads.backupDomain.switchOhms, 0.5)
    expect(current("PI8") * 1e3, "LED4 current, mA").toBeNear(PIN_LAB_2026_10_12.ledMa, 0.1)
    const extra = (drop("PI8") - drop("PB6") * (current("PI8") / current("PB6"))) * 1e3
    const benchExtra = PIN_LAB_2026_10_12.ph4HighMv - PIN_LAB_2026_10_12.pi8HighMv
    expect(extra, "PI8's extra drop, mV: the pin lab's 3262 − 3224 under LED3 and LED4").toBeNear(benchExtra, 3)
  })

  it("PI8 sourcing 6 mA into 470 Ω, past the 3 mA the switch and the pad carry, burns the MCU", async () => {
    const bench = boardWith(toGround("PI8", 470))
    bench.run(0.02)
    await bench.outputs({ PI8: true })
    expect(bench.run(0.2).damage[bench.u.id]?.reason).toMatch(/exceeds the 3(\.0+)? mA rating$/)
  })

  it("PI8 and PC13 sourcing 2 mA each are fine alone and burn the shared switch together", async () => {
    for (const pad of ["PI8", "PC13"]) {
      const alone = boardWith(toGround(pad, 1500))
      alone.run(0.02)
      await alone.outputs({ [pad]: true })
      expect(alone.run(0.2).damage, `${pad} alone`).toEqual({})
    }
    const together = boardWith(both(toGround("PI8", 1500), toGround("PC13", 1500)))
    together.run(0.02)
    await together.outputs({ PI8: true, PC13: true })
    const damage = together.run(0.3).damage[together.u.id]
    expect(damage?.reason).toMatch(/exceeds the 3(\.0+)? mA rating$/)
    expect(board.model![damage!.element], "the element that failed").toMatchObject({ kind: "R", label: "Backup-domain power switch" })
  })

  it("PI8 sinks 2.2 mA from 3.3 V through 1.5 kΩ; 4.9 mA through 680 Ω burns it (±3 mA, p. 164)", async () => {
    const fine = boardWith(to3v3("PI8", 1500))
    fine.run(0.02)
    await fine.outputs({ PI8: false })
    expect(fine.run(0.2).damage).toEqual({})
    const burnt = boardWith(to3v3("PI8", 680))
    burnt.run(0.02)
    await burnt.outputs({ PI8: false })
    expect(burnt.run(0.3).damage[burnt.u.id]?.reason).toMatch(/exceeds the 3(\.0+)? mA rating$/)
  })
})

describe("weak pulls", () => {
  it("PB12's pull-up is 10 kΩ, PB13's 40 kΩ: each against 10 kΩ to ground", async () => {
    const bench = boardWith(both(toGround("PB12", 10e3), toGround("PB13", 10e3)))
    bench.run(0.02)
    await bench.outputs({}, ["PB12", "PB13"])
    const snap = bench.run(0.05)
    expect(bench.volts(snap, "PB12"), "3.3 V × 10 k / (10 k + 10 k)").toBeNear(1.65, 0.02)
    expect(bench.volts(snap, "PB13"), "3.3 V × 10 k / (10 k + 40 k)").toBeNear(0.66, 0.02)
  })
})
