import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { STM32F405RG } from "@/mcu/chip"
import { olimexStm32H405 } from "@/schematic/components/olimex-stm32-h405"
import { builder } from "@/schematic/builder"
import { pinContacts } from "@/schematic/contacts"
import { getDef } from "@/schematic/registry"
import { GRID } from "@/schematic/geometry"
import { partKey, pinKey, type ModelElement, type PlacedObject } from "@/schematic/types"
import { Engine } from "@/sim/engine"
import { SimLoop, type Snapshot } from "@/sim/loop"
import { buildNetlist } from "@/sim/netlist"
import { DT } from "@/sim/speeds"
import { EYE_SETTLED } from "../lib/eye"
import { FIRMWARE } from "../lib/firmware"

/** UM §6.3.1 / §6.3.2, pin 1 to 26. */
const EXT1 = "PA11 PA8 PA12 PA9 3.3V GND PA10 PC10 PC11 PC12 PD2 PB5 PB6 PA6 PB7 PB8 PB9 PA5 PC0 PC1 PB0 PA7 VBAT PC13 RST PB1"
const EXT2 = "VDDA PC2 AGND PA0 3.3V GND PA2 PA1 PC3 PA3 PA4 PC4 PC5 PB10 PB11 PB13 PB12 PB14 PB15 PC6 PC7 PC8 +5V_USB PC9 GND VIN"
const JTAG = "3.3V 3.3V TRST GND TDI GND TMS GND TCK GND RTCK GND TDO GND RST GND NC GND 5V GND"
const pin = (id: string) => olimexStm32H405.pins.find((p) => p.id === id)!

describe("Olimex STM32-H405 pins (UM §6.3)", () => {
  it("has EXT1 and EXT2 pin for pin", () => {
    for (const [name, list] of [["EXT1", EXT1], ["EXT2", EXT2]] as const) list.split(" ").forEach((label, i) => expect(pin(`${name}-${i + 1}`).label, `${name}-${i + 1}`).toBe(label))
  })

  it("lays the headers out as the dimension drawing does: 0.1\" pitch, EXT2 pin 1 above EXT1 pin 25; EXT1 seven cells lower than the drawing's 1000 mil, to make room for the two name tables between them", () => {
    expect(pin("EXT2-3").x - pin("EXT2-1").x).toBe(-1)
    expect(pin("EXT1-3").x - pin("EXT1-1").x).toBe(1)
    expect(pin("EXT2-1").y - pin("EXT2-2").y).toBe(1)
    expect(pin("EXT1-2").y - pin("EXT1-1").y).toBe(1)
    expect((pin("EXT1-1").y + pin("EXT1-2").y) / 2 - (pin("EXT2-1").y + pin("EXT2-2").y) / 2).toBe(17)
    expect(pin("EXT2-1").x).toBe(pin("EXT1-25").x)
  })

  it("brings PA13/PA14/PA15/PB3/PB4 out on the JTAG header only, and leaves PB2, PC14/PC15 and PH0/PH1 on the board", () => {
    const where = (mcu: string) => olimexStm32H405.pins.filter((p) => p.mcu === mcu).map((p) => p.id)
    expect.soft(where("PB4")).toEqual(["JTAG-3"])
    expect.soft(where("PA15")).toEqual(["JTAG-5"])
    expect.soft(where("PA13")).toEqual(["JTAG-7"])
    expect.soft(where("PA14")).toEqual(["JTAG-9"])
    expect.soft(where("PB3")).toEqual(["JTAG-13"])
    for (const p of ["PB2", "PC14", "PC15", "PH0", "PH1"]) expect.soft(where(p), p).toEqual([])
  })

  it("has the 20-pin JTAG header pin for pin as the schematic draws it (the UM's table calls 11, 17 and 19 GND)", () => {
    JTAG.split(" ").forEach((label, i) => expect.soft(pin(`JTAG-${i + 1}`).label, `JTAG-${i + 1}`).toBe(label))
  })

  it("carries the F405RG with an 8 MHz and a 32.768 kHz crystal", () => {
    expect(olimexStm32H405.chip).toBe(STM32F405RG.id)
    expect(olimexStm32H405.mcuClocks).toMatchObject({ hse: { hz: 8e6, kind: "crystal" }, lse: { hz: 32768, kind: "crystal" } })
  })
})

const { place, wire, doc } = builder(GRID)
const u = place("olimex-stm32-h405", 0, 0)
const loop = new SimLoop()
const failures: string[] = []
loop.onFailure = (f) => failures.push(`${f.ref}: ${f.damage.reason}`)
let clock = 0
function settle(seconds = EYE_SETTLED): Snapshot {
  loop.setDoc(doc)
  loop.setParts(doc.parts)
  loop.setRunning(true)
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
  }
  return loop.snapshot()!
}
const v = (snap: Snapshot, o: PlacedObject, id: string) => snap.pinVoltage[pinKey(o.id, id)]!
const lit = (snap: Snapshot, id: string) => !!snap.parts[partKey(u.id, id)]?.on

describe("Olimex STM32-H405 without firmware", () => {
  it("powers 3.3V from USB through D1 and the LM1117 (240 Ω / 390 Ω, 60 µA adjust current); PWR lit, STAT dark", () => {
    const snap = settle()
    expect.soft(v(snap, u, "EXT2-23"), "+5V_USB").toBeNearRel(5, 0.01)
    expect.soft(v(snap, u, "EXT1-5"), "3.3V = 1.25 V × (1 + 390/240) + 60 µA × 390 Ω").toBeNearRel(3.305, 0.005)
    expect.soft(v(snap, u, "EXT2-26"), "VIN = 5 V less one 1N5819").toBeGreaterThan(4.75)
    expect.soft(v(snap, u, "EXT2-1"), "VDDA").toBeNearRel(v(snap, u, "EXT1-5"), 0.001)
    expect.soft(v(snap, u, "EXT1-23"), "VBAT jumpered to 3.3V").toBeNearRel(v(snap, u, "EXT1-5"), 0.001)
    expect.soft(lit(snap, "PWR"), "PWR").toBe(true)
    expect.soft(lit(snap, "STAT"), "STAT dark: PC12 floats").toBe(false)
    expect.soft(failures).toEqual([])
  })

  it("lights STAT when PC12 is pulled low", () => {
    const ls = place("logic-state", 10, 20)
    const w = wire(ls, "OUT", u, "EXT1-10")
    doc.parts[partKey(ls.id, "S")] = { on: false }
    expect(lit(settle(), "STAT")).toBe(true)
    doc.objects.splice(doc.objects.indexOf(ls), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
  })

  it("reads BUT on PA0 high through 10 kΩ, low when pressed; RESET pulls RST down", () => {
    let snap = settle()
    expect.soft(v(snap, u, "EXT2-4"), "PA0 released").toBeNearRel(v(snap, u, "EXT1-5"), 0.01)
    doc.parts[partKey(u.id, "BUT")] = { pressed: true }
    snap = settle()
    expect.soft(v(snap, u, "EXT2-4"), "PA0 pressed").toBeNear(0, 0.01)
    doc.parts[partKey(u.id, "BUT")] = { pressed: false }
    doc.parts[partKey(u.id, "RESET")] = { pressed: true }
    expect.soft(v(settle(), u, "EXT1-25"), "RST held").toBeNear(0, 0.01)
    doc.parts[partKey(u.id, "RESET")] = { pressed: false }
  })

  it("senses VBUS on PC4 through 15 kΩ / 22 kΩ, not on PA9", () => {
    const snap = settle()
    expect.soft(v(snap, u, "EXT2-12"), "PC4 = 5 V × 22/37").toBeNearRel((5 * 22) / 37, 0.02)
    doc.parts[partKey(u.id, "USB")] = { on: false }
    const off = settle()
    expect.soft(v(off, u, "EXT2-12"), "PC4 without USB: what C2 still holds on VIN leaks back through D1 into the divider, far below VIL").toBeLessThan(0.5)
    expect.soft(v(off, u, "EXT1-5"), "3.3V without USB").toBeLessThan(0.1)
    doc.parts[partKey(u.id, "USB")] = { on: true }
  })
})

describe("Olimex STM32-H405 circuits beyond the headers' own pins", () => {
  it("clamps PC11 near 0.65 V through R27 into Q3's base: an input there reads low", () => {
    const snap = settle()
    expect.soft(v(snap, u, "EXT1-9"), "PC11 left open").toBeGreaterThan(0.5)
    expect.soft(v(snap, u, "EXT1-9"), "PC11 left open").toBeLessThan(0.8)
  })

  it("switches 1.5 kΩ onto D+ when PC11 is low with VBUS present, and leaves D+ on the host's 15 kΩ otherwise", () => {
    expect.soft(v(settle(), u, "EXT1-3"), "DISC open: Q3 on, Q4 off").toBeLessThan(0.1)
    const ls = place("logic-state", 10, 20)
    const w = wire(ls, "OUT", u, "EXT1-9")
    doc.parts[partKey(ls.id, "S")] = { on: false }
    const pulled = v(settle(), u, "EXT1-3")
    expect.soft(pulled, "DISC low: Q4 follows its 3.84 V base, 1.5 kΩ against the host's 15 kΩ").toBeGreaterThan(2.5)
    expect.soft(pulled).toBeLessThan(3.3)
    doc.objects.splice(doc.objects.indexOf(ls), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
  })

  it("ties the JTAG header's 1 and 2 to 3.3 V, 15 to RST, the even pins to GND, and pulls 11, 17 and 19 down", () => {
    const snap = settle()
    for (const n of [1, 2]) expect.soft(v(snap, u, `JTAG-${n}`), `JTAG-${n}`).toBeNearRel(v(snap, u, "EXT1-5"), 0.001)
    for (const n of [4, 6, 8, 10, 12, 14, 16, 18, 20, 11, 17]) expect.soft(v(snap, u, `JTAG-${n}`), `JTAG-${n}`).toBeNear(0, 0.01)
    expect.soft(v(snap, u, "JTAG-19"), "JTAG-19: R3 47 kΩ against D2's reverse leakage, onsemi's typical 1N5819 (Fig. 9) about 36 µA at 3 V reverse: 1.72 V").toBeNear(1.72, 0.15)
    for (const n of [3, 5, 7, 9, 13]) expect.soft(v(snap, u, `JTAG-${n}`), `JTAG-${n} pulled up`).toBeGreaterThan(3)
    expect.soft(v(snap, u, "JTAG-15"), "RST").toBeNearRel(v(snap, u, "EXT1-25"), 0.001)
  })

  it("runs from a debugger's 5 V on JTAG pin 19 through D2 with USB unplugged", () => {
    doc.parts[partKey(u.id, "USB")] = { on: false }
    const supply = place("dc-source", 80, 0, { value: "5 V" })
    const gnd = place("ground", 80, 10)
    const wires = [wire(supply, "+", u, "JTAG-19"), wire(supply, "-", gnd, "GND"), wire(gnd, "GND", u, "JTAG-20")]
    const snap = settle()
    expect.soft(v(snap, u, "EXT2-26"), "VIN = 5 V less D2").toBeGreaterThan(4.6)
    expect.soft(v(snap, u, "EXT1-5"), "3.3V").toBeNearRel(3.305, 0.01)
    expect.soft(v(snap, u, "EXT2-23"), "+5V_USB stays off: D1 blocks, all but its leakage").toBeLessThan(0.5)
    for (const o of [supply, gnd]) doc.objects.splice(doc.objects.indexOf(o), 1)
    for (const w of wires) doc.wires.splice(doc.wires.indexOf(w), 1)
    doc.parts[partKey(u.id, "USB")] = { on: true }
  })

  it("runs from a debugger's 3.3 V on JTAG pins 1–2 with USB unplugged (UM §5.3): the rail, PWR lit, nothing back into VIN", () => {
    doc.parts[partKey(u.id, "USB")] = { on: false }
    const supply = place("dc-source", 80, 0, { value: "3.3 V" })
    const gnd = place("ground", 80, 10)
    const wires = [wire(supply, "+", u, "JTAG-1"), wire(supply, "-", gnd, "GND"), wire(gnd, "GND", u, "JTAG-4")]
    const snap = settle(1.5)
    expect.soft(v(snap, u, "EXT1-5"), "3.3V rail from the debugger").toBeNearRel(3.3, 0.005)
    expect.soft(v(snap, u, "JTAG-2"), "JTAG-2 on the same rail").toBeNearRel(3.3, 0.005)
    expect.soft(lit(snap, "PWR"), "PWR lit").toBe(true)
    expect.soft(v(snap, u, "EXT2-26"), "VIN, left at 4.7 V on C2 by the USB just unplugged, leaks away and is not held up from the rail: the LM1117 does not conduct backwards").toBeLessThan(3.3)
    expect.soft(failures, "nothing damaged").toEqual([])
    for (const o of [supply, gnd]) doc.objects.splice(doc.objects.indexOf(o), 1)
    for (const w of wires) doc.wires.splice(doc.wires.indexOf(w), 1)
    doc.parts[partKey(u.id, "USB")] = { on: true }
  })

  function fromVin(volts: number) {
    const b = builder(GRID)
    const board = b.place("olimex-stm32-h405", 0, 0)
    b.doc.parts[partKey(board.id, "USB")] = { on: false }
    const supply = b.place("dc-source", 80, 0, { value: `${volts} V` })
    const gnd = b.place("ground", 80, 10)
    b.wire(supply, "+", board, "EXT2-26")
    b.wire(supply, "-", gnd, "GND")
    b.wire(gnd, "GND", board, "EXT2-25")
    const sim = new SimLoop()
    sim.setDoc(b.doc)
    sim.setParts(b.doc.parts)
    sim.setRunning(true)
    let t = 0
    while (t < EYE_SETTLED * 1000) sim.advance((t += 20))
    const snap = sim.snapshot()!
    const damage = snap.damage[board.id]
    return { rail: snap.pinVoltage[pinKey(board.id, "EXT1-5")]!, pwr: !!snap.parts[partKey(board.id, "PWR")]?.on, damage: damage?.reason, also: damage?.also?.map((d) => d.reason) ?? [], fatal: damage?.fatal }
  }

  it("runs from +5 V on EXT2 #26 and GND on #25 with USB out (UM §3.3): 3.3 V, PWR lit", () => {
    const got = fromVin(5)
    expect.soft(got.rail, "3.3V").toBeNearRel(3.305, 0.01)
    expect.soft(got.pwr, "PWR").toBe(true)
    expect.soft(got.damage, "nothing damaged").toBeUndefined()
  })

  it("follows VIN less the LM1117's dropout below regulation: 1.1 V at light load (TI LM1117 §7.5)", () => {
    const got = fromVin(4.2)
    expect.soft(got.rail, "4.2 V − about 1.09 V").toBeNear(4.2 - 1.09, 0.03)
  })

  it("takes 15 V on VIN, and at 24 V loses the LM1117 past its 20 V absolute maximum (TI LM1117 §7.1) and C2, the 16 V tantalum, past the 1.32 × rated surge it is tested to (KEMET T491)", () => {
    const fine = fromVin(15)
    expect.soft(fine.damage, "15 V: the recommended maximum").toBeUndefined()
    expect.soft(fine.rail, "still 3.3 V").toBeNearRel(3.305, 0.01)
    const burnt = fromVin(24)
    expect.soft(burnt.damage, "24 V: the regulator fails").toMatch(/^voltage 2\d\.\d+ V exceeds the 20\.00 V rating$/)
    expect.soft(burnt.also, "and C2 shorts past the 1.32 × 16 V its surge test allows").toEqual([expect.stringMatching(/^surge voltage 2\d\.\d+ V exceeds the 21\.12 V rating$/)])
    expect.soft(burnt.fatal, "neither takes the board's other parts with it").toBe(false)
    expect.soft(burnt.rail, "the rail goes dead").toBeLessThan(0.5)
  })

  function coinCellOnVbat(vbatBridge: "closed" | "open") {
    const b = builder(GRID)
    const board = b.place("olimex-stm32-h405", 0, 0, { vbat: vbatBridge })
    const cell = b.place("battery", 80, 0, { chem: "li-mno2", capacity: "0.22 Ah" })
    const gnd = b.place("ground", 80, 10)
    const lead = b.wire(cell, "+", board, "EXT1-23")
    b.wire(cell, "-", gnd, "GND")
    b.wire(gnd, "GND", board, "EXT1-6")
    const sim = new SimLoop()
    sim.setDoc(b.doc)
    sim.setParts(b.doc.parts)
    sim.setRunning(true)
    let t = 0
    while (t < EYE_SETTLED * 1000) sim.advance((t += 20))
    const snap = sim.snapshot()!
    return { vbat: snap.pinVoltage[pinKey(board.id, "EXT1-23")]!, amps: Math.abs(snap.wireCurrent[lead.id] ?? 0), damage: snap.damage[board.id]?.reason }
  }

  it("a CR2032 on EXT1 #23 with VBAT open sits on VBAT alone, at its own rest voltage, and gives nothing while VDD is up: the backup domain then runs from VDD (UM §6.4.3, RM0090 §5.1.2)", () => {
    const got = coinCellOnVbat("open")
    expect.soft(got.vbat, "VBAT at the fresh cell's rest voltage, a little over its 3 V nominal").toBeNear(3.25, 0.1)
    expect.soft(got.amps, "no current while VDD is up").toBeLessThan(1e-9)
  })

  it("a CR2032 on EXT1 #23 with VBAT closed meets the 3.3 V rail (UM §6.4.3): the rail forces current into a cell that cannot take a charge", () => {
    const got = coinCellOnVbat("closed")
    expect.soft(got.vbat, "VBAT held at the rail").toBeNear(3.3, 0.05)
    expect.soft(got.amps, "about a milliamp into the cell").toBeGreaterThan(0.5e-3)
  })

  const RCC_APB1ENR = 0x40023840
  const PWREN = 1 << 28
  const PWR_CR = 0x40007000
  const DBP = 1 << 8
  const RCC_BDCR = 0x40023870
  const LSEON = 1
  const LSERDY = 2
  const RTCSEL_LSE = 1 << 8
  const RTCEN = 1 << 15
  const RTC = { TR: 0x40002800, CR: 0x40002808, ISR: 0x4000280c, WPR: 0x40002824, BKP0R: 0x40002850 }
  const INIT = 1 << 7
  const INITF = 1 << 6
  const BYPSHAD = 1 << 5
  const SENTINEL = 0xc0ffee42
  const OUTAGE_S = 3
  const bcd = (v: number) => (v & 0xf) + 10 * (v >>> 4)
  const secondsOf = (tr: number) => bcd((tr >>> 16) & 0x3f) * 3600 + bcd((tr >>> 8) & 0x7f) * 60 + bcd(tr & 0x7f)

  for (const [cell, kept] of [[true, true], [false, false]] as const) {
    it(`${kept ? "keeps" : "loses"} the backup domain through ${OUTAGE_S} s of USB unplugged ${cell ? "with a CR2032 on VBAT (bridge open)" : "with nothing on VBAT (the control)"}: BKP0R's sentinel and the LSE-clocked RTC ${kept ? "kept, the clock counted on through the outage" : "reset"}`, () => {
      const b = builder(GRID)
      const board = b.place("olimex-stm32-h405", 0, 0, { vbat: "open" })
      board.props = { ...board.props, firmwareData: readFileSync(join(FIRMWARE, "prebuilt", "h405-blink.U1.elf")).toString("base64") }
      let lead: { id: string } | undefined
      if (cell) {
        const bat = b.place("battery", 80, 0, { chem: "li-mno2", capacity: "0.22 Ah" })
        const gnd = b.place("ground", 80, 10)
        lead = b.wire(bat, "+", board, "EXT1-23")
        b.wire(bat, "-", gnd, "GND")
        b.wire(gnd, "GND", board, "EXT1-6")
      }
      const sim = new SimLoop()
      sim.setDoc(b.doc)
      const usb = (on: boolean) => {
        b.doc.parts[partKey(board.id, "USB")] = { on }
        sim.setParts(b.doc.parts)
      }
      usb(true)
      sim.setRunning(true)
      let t = 0
      const run = (ms: number) => {
        const end = t + ms
        while (t < end) sim.advance((t += 5))
      }
      type Bus = { read: (a: number, n: 4) => number; write: (a: number, v: number, n: 4) => void }
      const bus = () => (sim as unknown as { mcus: Map<string, { mcu: { mcu: { bus: Bus } } }> }).mcus.get(board.id)!.mcu.mcu.bus
      const r = (a: number) => bus().read(a, 4) >>> 0
      const w = (a: number, v: number) => bus().write(a, v >>> 0, 4)
      const until = (done: () => boolean, ms: number) => {
        for (let waited = 0; !done() && waited < ms; waited += 5) run(5)
        return done()
      }

      run(200)
      w(RCC_APB1ENR, r(RCC_APB1ENR) | PWREN)
      w(PWR_CR, r(PWR_CR) | DBP)
      w(RCC_BDCR, LSEON)
      expect(until(() => (r(RCC_BDCR) & LSERDY) !== 0, 3000), "LSE ready").toBe(true)
      w(RCC_BDCR, LSEON | RTCSEL_LSE | RTCEN)
      w(RTC.WPR, 0xca)
      w(RTC.WPR, 0x53)
      w(RTC.ISR, INIT)
      expect(until(() => (r(RTC.ISR) & INITF) !== 0, 100), "INITF").toBe(true)
      w(RTC.TR, 0)
      w(RTC.CR, BYPSHAD)
      w(RTC.ISR, 0)
      w(RTC.BKP0R, SENTINEL)
      run(1000)
      const before = secondsOf(r(RTC.TR))

      usb(false)
      run(OUTAGE_S * 1000 - 500)
      sim.snapshot()
      run(500)
      if (lead) {
        const out = sim.snapshot()!
        const vbat = out.pinVoltage[pinKey(board.id, "EXT1-23")]!
        const table25 = 0.73e-6 + ((vbat - 2.4) / 0.9) * (0.96e-6 - 0.73e-6)
        expect.soft(Math.abs(out.wireCurrent[lead.id] ?? 0), `the cell's current at ${vbat.toFixed(2)} V: DS8626 Table 25, LSE and RTC on, backup SRAM off`).toBeNearRel(table25, 0.01)
      }
      usb(true)
      run(200)
      const snap = sim.snapshot()!
      expect.soft(snap.mcus[board.id]?.running, "running again").toBe(true)
      expect.soft(snap.mcus[board.id]?.backupKept, "backup domain").toBe(kept)
      w(RCC_APB1ENR, r(RCC_APB1ENR) | PWREN)
      expect.soft(r(RTC.BKP0R), "BKP0R").toBe(kept ? SENTINEL : 0)
      expect.soft(r(RCC_BDCR) & (RTCSEL_LSE | RTCEN | LSEON), "BDCR: the LSE, RTCSEL and RTCEN").toBe(kept ? RTCSEL_LSE | RTCEN | LSEON : 0)
      if (kept) expect.soft(secondsOf(r(RTC.TR)) - before, "seconds counted across the outage and the 0.2 s after it").toBeNear(OUTAGE_S + 0.2, 1)
      else expect.soft(r(RTC.TR), "the calendar back at its reset value").toBe(0)
    })
  }

  it("and kept there, the cell vents once 3 % of its capacity has been forced in (the battery model's primary-cell limit); the board survives", () => {
    const b = builder(GRID)
    const board = b.place("olimex-stm32-h405", 0, 0, { vbat: "closed" })
    b.doc.parts[partKey(board.id, "USB")] = { on: true }
    const cell = b.place("battery", 80, 0, { chem: "li-mno2", capacity: "0.22 Ah" })
    const gnd = b.place("ground", 80, 10)
    b.wire(cell, "+", board, "EXT1-23")
    b.wire(cell, "-", gnd, "GND")
    b.wire(gnd, "GND", board, "EXT1-6")
    const engine = new Engine(buildNetlist(b.doc))
    const parts = (key: string) => b.doc.parts[key] ?? {}
    let seconds = 0
    while (!engine.failures.length && seconds < 48 * 3600) {
      engine.step(1, parts)
      seconds++
    }
    const failure = engine.failures[0]
    expect.soft(failure?.object, "the cell, not the board").toBe(cell.id)
    expect.soft(failure?.damage.reason, "vented").toMatch(/a primary cell, it vented$/)
    expect.soft(seconds / 3600, "hours to 3 % of 220 mAh at about a milliamp").toBeGreaterThan(2)
    expect.soft(seconds / 3600, "hours").toBeLessThan(24)
  })

  it("opens the USBP_E bridge: PC4 loses VBUS, the board stays powered", () => {
    doc.parts[partKey(u.id, "USBP_E")] = { on: false }
    const snap = settle()
    expect.soft(v(snap, u, "EXT2-12"), "PC4, cut off the 2.97 V divider and left floating").toBeLessThan(0.5)
    expect.soft(v(snap, u, "EXT1-5"), "3.3V").toBeNearRel(3.305, 0.01)
    doc.parts[partKey(u.id, "USBP_E")] = { on: true }
  })

  it("cuts the bottom bridges: VBAT off 3.3 V, STAT off PC12, and R-T joins TRST to RST", () => {
    u.props = { ...u.props, vbat: "open", lede: "open", rt: "closed" }
    const ls = place("logic-state", 10, 20)
    const w = wire(ls, "OUT", u, "EXT1-10")
    doc.parts[partKey(ls.id, "S")] = { on: false }
    doc.parts[partKey(u.id, "RESET")] = { pressed: true }
    const snap = settle()
    expect.soft(v(snap, u, "EXT1-23"), "VBAT").toBeLessThan(1)
    expect.soft(lit(snap, "STAT"), "STAT with LED_E cut").toBe(false)
    expect.soft(v(snap, u, "JTAG-3"), "TRST follows RST through R-T").toBeLessThan(0.5)
    doc.parts[partKey(u.id, "RESET")] = { pressed: false }
    doc.objects.splice(doc.objects.indexOf(ls), 1)
    doc.wires.splice(doc.wires.indexOf(w), 1)
    u.props = { ...u.props, vbat: "closed", lede: "closed", rt: "open" }
  })
})

describe("JTAG 11 and 17 are wired pins, not NC (R24/R2 10 kΩ to GND, Rev. C schematic)", () => {
  function divider(pin: string, by: "contact" | "wire") {
    const b = builder(GRID)
    const board = b.place("olimex-stm32-h405", 0, 0)
    b.doc.parts[partKey(board.id, "USB")] = { on: false }
    const target = olimexStm32H405.pins.find((p) => p.id === pin)!
    const one = getDef("resistor")!.pins.find((p) => p.id === "1")!
    const r = by === "contact" ? b.place("resistor", target.x - one.x, target.y - one.y, { value: "10 kΩ" }) : b.place("resistor", 60, 0, { value: "10 kΩ" })
    if (by === "wire") b.wire(r, "1", board, pin)
    const supply = b.place("dc-source", 70, 10, { value: "3.3 V" })
    const gnd = b.place("ground", 70, 20)
    b.wire(supply, "+", r, "2")
    b.wire(supply, "-", gnd, "GND")
    b.wire(gnd, "GND", board, "EXT1-6")
    const touching = [...pinContacts(b.doc.objects, GRID).groups.keys()].includes(pinKey(board.id, pin))
    const sim = new SimLoop()
    sim.setDoc(b.doc)
    sim.setParts(b.doc.parts)
    sim.setRunning(true)
    let t = 0
    while (t < EYE_SETTLED * 1000) sim.advance((t += 20))
    return { touching, volts: sim.snapshot()!.pinVoltage[pinKey(board.id, pin)]! }
  }
  for (const pin of ["JTAG-11", "JTAG-17"]) {
    it(`${pin} takes a resistor's pin set on it, and halves 3.3 V through 10 kΩ as a wire to it does`, () => {
      const contact = divider(pin, "contact")
      const wired = divider(pin, "wire")
      expect.soft(contact.touching, "in contact").toBe(true)
      expect.soft(contact.volts, "by contact: 3.3 V × 10k / (10k + 10k)").toBeNearRel(1.65, 0.01)
      expect.soft(wired.volts, "by wire, the same").toBeNearRel(contact.volts, 0.001)
    })
  }
})

describe("VR, the LM1117-ADJ, against TI SNOS412Q (§7.4 thermal, §7.5 electrical; shutdown point, hysteresis and time constant assumed)", () => {
  const VR_ELEMENT = olimexStm32H405.model!.findIndex((el) => "label" in el && el.label === "VR LM1117-ADJ")
  function vrBench(vin: number, load?: number) {
    const b = builder(GRID)
    const board = b.place("olimex-stm32-h405", 0, 0)
    b.doc.parts[partKey(board.id, "USB")] = { on: false }
    const gnd = b.place("ground", 80, 30)
    const src = b.place("dc-source", 80, 0, { value: `${vin} V`, rint: "1 mΩ", imax: "100 A" })
    b.wire(src, "+", board, "EXT2-26")
    b.wire(src, "-", gnd, "GND")
    b.wire(gnd, "GND", board, "EXT2-25")
    if (load !== undefined) {
      const r = b.place("resistor", 70, 20, { value: `${load} Ω`, power: "100" })
      b.wire(r, "1", board, "EXT1-5")
      b.wire(r, "2", gnd, "GND")
    }
    const engine = new Engine(buildNetlist(b.doc))
    const parts = (key: string) => b.doc.parts[key] ?? {}
    const run = (seconds: number) => {
      for (let k = 0; k < Math.round(seconds / DT); k++) engine.step(DT, parts)
    }
    const volt = (pin: string) => engine.v[engine.net.pinNet.get(pinKey(board.id, pin))!]
    const vr = () => engine.readings().find((r) => r.object === board.id && r.element === VR_ELEMENT)!
    return { b, board, engine, run, volt, vr, parts }
  }

  it("drops 1.1 V at 100 mA and 1.2 V at 800 mA below regulation (typical)", () => {
    for (const [amps, drop] of [[0.1, 1.1], [0.8, 1.2]] as const) {
      const t = vrBench(4.2, (4.2 - drop) / amps)
      t.run(2e-3)
      expect.soft(Math.abs(t.vr().current), `load near ${amps} A, plus the board's own 13 mA`).toBeNear(amps + 0.013, 0.01)
      expect.soft(t.volt("EXT2-26") - t.volt("EXT1-5"), `dropout at ${amps} A`).toBeNear(drop, 0.02)
    }
  })

  it("limits a short on its output to 1.2 A (typical; 0.8 A guaranteed, the UM's 'up to 800 mA')", () => {
    const t = vrBench(5, 1e-3)
    t.run(2e-3)
    expect.soft(Math.abs(t.vr().current), "current limit").toBeNearRel(1.2, 0.05)
  })

  it("feeds its own 240 Ω / 390 Ω divider 5.2 mA, over the 5 mA minimum load, with nothing else on the rail", () => {
    const t = vrBench(5)
    t.run(2e-3)
    const divider = t.engine.readings().find((r) => r.object === t.board.id && r.kind === "R" && Math.abs(Math.abs(r.voltage) - 1.25) < 0.02)
    expect.soft(divider && Math.abs(divider.current), "1.25 V across 240 Ω").toBeNearRel(1.25 / 240, 0.02)
    expect.soft(Math.abs(t.vr().current), "at least the divider's").toBeGreaterThan(5e-3)
  })

  it("shuts down from 15 V into 5 Ω (≈ 7.6 W, far past 61.6 °C/W's reach) within a second, and cycles back on", () => {
    const t = vrBench(15, 5)
    const out: number[] = []
    for (let k = 0; k < 400; k++) {
      t.run(0.01)
      out.push(t.volt("EXT1-5"))
    }
    expect.soft(out[5], "regulating at 50 ms").toBeNear(3.305, 0.05)
    const off = out.findIndex((v) => v < 1)
    expect.soft(off, "shut down").toBeGreaterThan(20)
    expect.soft(off, "within a second").toBeLessThan(100)
    expect.soft(out.slice(off).some((v) => v > 3.2), "back on once cooled").toBe(true)
  })

  it("runs on from 5 V at 100 mA (0.17 W, about 36 °C at the junction)", () => {
    const t = vrBench(5, 3.3 / 0.1)
    t.run(3)
    expect.soft(t.volt("EXT1-5"), "still 3.3 V after 3 s").toBeNear(3.305, 0.05)
    expect.soft(t.vr().extra?.mode, "not in shutdown").not.toBe("thermal shutdown")
  })

  it("fails open past 20 V without taking the board with it: 3.3 V put on the rail afterwards still lights PWR and loads it by milliamps", () => {
    const t = vrBench(24)
    let failed = ""
    for (let k = 0; k < Math.round(0.05 / DT) && !failed; k++) {
      t.engine.step(DT, t.parts)
      if (t.engine.failures.length) failed = t.engine.failures[0].damage.reason
    }
    expect.soft(failed, "VR fails").toMatch(/^voltage 2[34]\.\d+ V exceeds the 20\.00 V rating$/)
    const damage = t.engine.failures[0]?.damage
    expect.soft(damage?.fatal, "not fatal to the board").toBe(false)
    const rail = t.b.place("dc-source", 90, 0, { value: "3.3 V", rint: "1 mΩ", imax: "10 A" })
    const g2 = t.b.place("ground", 90, 30)
    t.b.wire(rail, "+", t.board, "EXT1-5")
    t.b.wire(rail, "-", g2, "GND")
    t.b.wire(g2, "GND", t.board, "EXT1-6")
    const after = new Engine(buildNetlist(t.b.doc, damage ? { [t.board.id]: damage } : {}))
    for (let k = 0; k < Math.round(2e-3 / DT); k++) after.step(DT, t.parts)
    const drawn = Math.abs(after.readings().find((r) => r.object === rail.id && r.kind === "V")!.current)
    expect.soft(drawn, "the rail loads the source by milliamps, no short").toBeLessThan(0.05)
    expect.soft(drawn, "and by something: the LEDs, pull-ups, the MCU").toBeGreaterThan(1e-4)
    expect.soft(VR_ELEMENT, "VR found in the model").toBeGreaterThanOrEqual(0)
    expect.soft(after.readings().some((r) => r.object === t.board.id && r.element === VR_ELEMENT), "VR gone").toBe(false)
  })
})

describe("the power path against its parts: onsemi's 1N5819 curves, the Rev. C capacitors and bead, USB 2.0 §7.2.4.1 and DS8626's VCAP inrush", () => {
  const ONSEMI_FIG7_25C: readonly [number, number][] = [[0.0207, 0.231], [0.0507, 0.2591], [0.101, 0.2805], [0.2129, 0.3086], [0.5099, 0.3591], [1.0157, 0.4148]]
  const ONSEMI_FIG9_1N5819_25C: readonly [number, number][] = [[2.29, 34.7e-6], [3.79, 38.8e-6], [4.99, 45.1e-6], [7.78, 56.6e-6], [11.87, 77.2e-6], [16.17, 105.6e-6], [19.56, 125.4e-6]]
  const along = (curve: readonly [number, number][], x: number, logX: boolean) => {
    const f = (v: number) => (logX ? Math.log(v) : v)
    let i = 1
    while (i < curve.length - 1 && x > curve[i][0]) i++
    const [x0, y0] = curve[i - 1]
    const [x1, y1] = curve[i]
    return y0 + ((f(x) - f(x0)) / (f(x1) - f(x0))) * (y1 - y0)
  }
  const index = (match: (el: ModelElement) => boolean) => olimexStm32H405.model!.findIndex(match)
  const D1 = index((el) => el.kind === "D" && el.anode === "EXT2-23")
  const CABLE = index((el) => "label" in el && el.label === "USB cable, VBUS and GND")
  const HOST_SWITCH = index((el) => "label" in el && el.label === "USB host port switch")
  const CORE_REGULATOR = index((el) => "label" in el && el.label === "Core regulator (VCAP)")
  const L1 = index((el) => "label" in el && el.label === "L1 ferrite bead")

  function bench(usb: boolean, wiring: (b: ReturnType<typeof builder>, board: PlacedObject, gnd: PlacedObject) => void = () => {}) {
    const b = builder(GRID)
    const board = b.place("olimex-stm32-h405", 0, 0)
    b.doc.parts[partKey(board.id, "USB")] = { on: usb }
    const gnd = b.place("ground", 80, 40)
    b.wire(gnd, "GND", board, "EXT2-25")
    wiring(b, board, gnd)
    const engine = new Engine(buildNetlist(b.doc))
    const parts = (key: string) => b.doc.parts[key] ?? {}
    const step = () => engine.step(DT, parts)
    const run = (seconds: number) => {
      for (let k = 0; k < Math.round(seconds / DT); k++) step()
    }
    const volt = (pin: string) => engine.v[engine.net.pinNet.get(pinKey(board.id, pin))!]
    const of = (element: number) => engine.readings().filter((r) => r.object === board.id && r.element === element)
    const amps = (element: number) => of(element)[0]?.current ?? NaN
    return { b, board, engine, parts, step, run, volt, of, amps }
  }
  const load = (ohms: number, pin = "EXT1-5") => (b: ReturnType<typeof builder>, board: PlacedObject, gnd: PlacedObject) => {
    const r = b.place("resistor", 70, 20, { value: `${ohms} Ω`, power: "100" })
    b.wire(r, "1", board, pin)
    b.wire(r, "2", gnd, "GND")
  }
  const supply = (volts: number, pin: string, extra?: ReturnType<typeof load>) => (b: ReturnType<typeof builder>, board: PlacedObject, gnd: PlacedObject) => {
    const src = b.place("dc-source", 90, 0, { value: `${volts} V`, rint: "1 mΩ", imax: "10 A" })
    b.wire(src, "+", board, pin)
    b.wire(src, "-", gnd, "GND")
    extra?.(b, board, gnd)
  }

  it("D1 drops what onsemi's typical 1N5819 forward curve gives (1N5817-D Fig. 7, 25 °C), from 20 mA to 0.5 A", () => {
    for (const ohms of [600, 90, 38, 17.5, 6.8]) {
      const t = bench(false, supply(5, "EXT2-23", load(ohms)))
      t.run(3e-3)
      const d = t.of(D1).find((r) => r.kind === "D")!
      const want = along(ONSEMI_FIG7_25C, d.current, true)
      expect.soft(t.volt("EXT2-23") - t.volt("EXT2-26"), `VF at ${(d.current * 1e3).toFixed(0)} mA`).toBeNear(want, 0.008)
    }
  })

  it("D1 leaks what the same datasheet's typical reverse curve gives for the 1N5819 (Fig. 9, 25 °C), within 10 % from 3 to 19 V reverse", () => {
    for (const volts of [3, 5, 8, 12, 16, 19]) {
      const t = bench(false, supply(volts, "EXT2-26"))
      t.run(3e-3)
      const reverse = t.volt("EXT2-26") - t.volt("EXT2-23")
      const total = -(t.of(D1).find((r) => r.kind === "D")!.current + t.amps(D1 + 1) + t.amps(D1 + 2))
      expect.soft(total, `reverse current at ${reverse.toFixed(2)} V`).toBeNearRel(along(ONSEMI_FIG9_1N5819_25C, reverse, false), 0.1)
    }
  })

  it("asks a modelled USB host (5 V, an assumed 0.5 A switch, USB 2.0's 120 µF and 0.25 Ω per conductor) for the charge of the 51.5 µF behind D1, the LM1117 and the core regulator when plugged in: over 2.5 × the 50 µC a 10 µF ∥ 44 Ω load (USB 2.0 §7.2.4.1) takes, counted above 100 mA over 50 ms (not the USB-IF's region method), and the host's 120 µF sagging past 330 mV", () => {
    const t = bench(false)
    t.run(0.01)
    t.b.doc.parts[partKey(t.board.id, "USB")] = { on: true }
    const hostNode = t.engine.net.nodeNet.get(pinKey(t.board.id, "$host"))!
    let charge = 0
    let above100mA = 0
    let hostMin = Infinity
    let fed = Math.abs(t.amps(HOST_SWITCH))
    const steps = Math.round(0.05 / DT)
    for (let k = 0; k < steps; k++) {
      t.step()
      const i = Math.abs(t.amps(CABLE))
      if (i > 0.1) above100mA += i * DT
      const now = Math.abs(t.amps(HOST_SWITCH))
      charge += ((fed + now) / 2) * DT
      fed = now
      hostMin = Math.min(hostMin, t.engine.v[hostNode])
    }
    const steady = Math.abs(t.amps(HOST_SWITCH))
    const VIN_FARADS = (0.1 + 10 + 0.1) * 1e-6
    const RAIL_FARADS = (2 * 11.5 + 5 * 0.1 + 6.6) * 1e-6
    const VDDA_FARADS = (6.6 + 0.1 + 0.1) * 1e-6
    const VCAP_FARADS = 2 * 2.2e-6
    const stored = VIN_FARADS * t.volt("EXT2-26") + (RAIL_FARADS + VDDA_FARADS) * t.volt("EXT1-5") + VCAP_FARADS * 1.26
    expect.soft(charge - steady * steps * DT, "the charge the host's port switch delivered beyond the steady load (its own 120 µF back at 5 V): Σ C·V of the schematic's").toBeNearRel(stored, 0.05)
    expect.soft(above100mA, "inrush charge above 100 mA, against the USB-IF's 50 µC").toBeGreaterThan(2.5 * 50e-6)
    expect.soft(5 - hostMin, "the host's sag").toBeGreaterThan(0.33)
    expect.soft(5 - hostMin, "and not a collapse").toBeLessThan(2)
  })

  it("charges VCAP's 2 × 2.2 µF from VDD through the core regulator at DS8626 Table 19's 160 mA inrush: 0.73 V after the first 20 µs of a stiff 3.3 V, 1.26 V (C · V12 = 5.5 µC, against ERUSH's 5.4 µC) after the second", () => {
    const stiff = (b: ReturnType<typeof builder>, board: PlacedObject, gnd: PlacedObject) => {
      const src = b.place("dc-source", 90, 0, { value: "3.3 V", rint: "1 mΩ", imax: "100 A" })
      const sw = b.place("switch", 85, 0)
      b.wire(src, "+", sw, "1")
      b.wire(sw, "2", board, "EXT1-5")
      b.wire(src, "-", gnd, "GND")
      b.doc.parts[partKey(sw.id, "SW")] = { on: false }
      return sw
    }
    let sw: PlacedObject | undefined
    const t = bench(false, (b, board, gnd) => (sw = stiff(b, board, gnd)))
    t.run(1e-3)
    t.b.doc.parts[partKey(sw!.id, "SW")] = { on: true }
    const vcap = () => t.engine.v[t.engine.net.nodeNet.get(pinKey(t.board.id, "$vcap"))!]
    t.step()
    expect.soft(vcap(), "after 20 µs at 160 mA into 4.4 µF").toBeNearRel((0.16 * 20e-6) / 4.4e-6, 0.05)
    t.step()
    expect.soft(vcap(), "charged").toBeNear(1.26, 0.005)
    t.run(1e-4)
    expect.soft(Math.abs(t.amps(CORE_REGULATOR)), "and quiet").toBeLessThan(1e-3)
  })

  it("keeps the rail above the F405's 1.68 V power-down threshold (DS8626 Table 19) for milliseconds after the USB is pulled: 47 µF of rail, VDDA and VIN capacitance into the board's ~250 Ω", () => {
    const t = bench(true)
    t.run(0.02)
    t.b.doc.parts[partKey(t.board.id, "USB")] = { on: false }
    let held = 0
    while (t.volt("EXT1-5") > 1.68 && held < 0.1) {
      t.step()
      held += DT
    }
    const tau = 47.1e-6 * (3.305 / 13.0e-3)
    expect.soft(held, "hold-up").toBeNearRel(tau * Math.log(3.305 / 1.68) + (0.36 * 10.2e-6) / 13.0e-3, 0.12)
  })

  it("feeds VDDA, the ADC's reference (VREF+ is VDDA on the LQFP64), through L1 as its DC resistance: 20 mV under the rail at 100 mA on EXT2-1, 60 mV at 300 mA, and with no part number, no rating to burn it", () => {
    expect.soft(olimexStm32H405.mcuVref, "the ADC references VDDA").toBe("EXT2-1")
    for (const [ohms, amps] of [[33, 0.1], [11, 0.3]] as const) {
      const t = bench(true, load(ohms, "EXT2-1"))
      t.run(amps > 0.2 ? 10 : 5e-3)
      expect.soft(t.volt("EXT1-5") - t.volt("EXT2-1"), `VDDA below the rail at ${amps} A`).toBeNearRel(Math.abs(t.amps(L1)) * 0.2, 0.01)
      expect.soft(Math.abs(t.amps(L1)), "the bead's current").toBeNearRel(amps, 0.1)
      expect.soft(t.engine.failures, "nothing burns").toEqual([])
    }
  })

  it("keeps C2, the 16 V tantalum, at 18 V on VIN for the 30 s εmul assumes (an assumed damage model: KEMET qualifies 1.32 × rated surges, it gives no time to failure) and shorts it after; the LM1117, inside its 20 V, and the rest of the board go on", () => {
    const t = bench(false, supply(18, "EXT2-26"))
    const failedBy = (seconds: number) => {
      for (let k = 0; k < Math.round(seconds / DT) && !t.engine.failures.length; k++) t.step()
      return t.engine.failures[0]?.damage
    }
    expect.soft(failedBy(29), "29 s over its rating").toBeUndefined()
    const damage = failedBy(2)
    expect.soft(damage?.reason, "C2 shorts").toMatch(/^voltage 1[78]\.\d+ V past the 16\.00 V rating for over 30\.00 s$/)
    expect.soft(damage?.fatal, "not fatal to the board").toBe(false)
  })

  it("lets C2 take a brief reverse voltage up to 15 % of its rating (KEMET T491, 25 °C), shorts it past that at once, and after the assumed 30 s any reverse voltage held, 0.1 V included (KEMET: never continuously reversed)", () => {
    const instant = bench(false, supply(-3, "EXT2-26"))
    instant.run(1e-3)
    expect.soft(instant.engine.failures[0]?.damage.reason, "3 V the wrong way").toMatch(/^reverse voltage [23]\.\d+ V exceeds the 2\.40 V rating$/)
    const held = bench(false, supply(-1, "EXT2-26"))
    held.run(25)
    expect.soft(held.engine.failures, "1 V reversed for 25 s").toEqual([])
    held.run(6)
    expect.soft(held.engine.failures[0]?.damage.reason, "and on past 30 s").toMatch(/^reverse voltage [01]\.\d+ V past the 10\.00 mV rating for over 30\.00 s$/)
    const slight = bench(false, supply(-0.1, "EXT2-26"))
    slight.run(31)
    expect.soft(slight.engine.failures[0]?.damage.reason, "0.1 V reversed for 31 s").toMatch(/^reverse voltage \d+\.\d+ mV past the 10\.00 mV rating for over 30\.00 s$/)
  })

  it("lets D2 fail short, and only D2, when a debugger's 5 V on JTAG 19 feeds a short on VIN: past the 1N5819's 1 A, without taking the board with it", () => {
    const short = (b: ReturnType<typeof builder>, board: PlacedObject, gnd: PlacedObject) => {
      const src = b.place("dc-source", 90, 0, { value: "5 V", rint: "1 mΩ", imax: "100 A" })
      b.wire(src, "+", board, "JTAG-19")
      b.wire(src, "-", gnd, "GND")
      const r = b.place("resistor", 70, 20, { value: "0.5 Ω", power: "1000" })
      b.wire(r, "1", board, "EXT2-26")
      b.wire(r, "2", gnd, "GND")
    }
    const t = bench(false, short)
    let damage: { element: number; reason: string; fatal: boolean } | undefined
    for (let k = 0; k < Math.round(10 / DT) && !damage; k++) {
      t.step()
      damage = t.engine.failures.find((f) => f.object === t.board.id)?.damage
    }
    expect.soft(damage?.element, "D2").toBe(index((el) => el.kind === "D" && el.anode === "JTAG-19"))
    expect.soft(damage?.reason, "past its average-current rating").toMatch(/^current \d+\.\d+ A exceeds the 1\.00 A rating$/)
    expect.soft(damage?.fatal, "not fatal to the board").toBe(false)
  })

  it("lets D1 fail short, and only D1, when USB's 5 V on +5V_USB feeds a short on VIN, without taking the board with it", () => {
    const short = (b: ReturnType<typeof builder>, board: PlacedObject, gnd: PlacedObject) => {
      const src = b.place("dc-source", 90, 0, { value: "5 V", rint: "1 mΩ", imax: "100 A" })
      b.wire(src, "+", board, "EXT2-23")
      b.wire(src, "-", gnd, "GND")
      const r = b.place("resistor", 70, 20, { value: "0.5 Ω", power: "1000" })
      b.wire(r, "1", board, "EXT2-26")
      b.wire(r, "2", gnd, "GND")
    }
    const t = bench(false, short)
    let damage: { element: number; reason: string; fatal: boolean } | undefined
    for (let k = 0; k < Math.round(10 / DT) && !damage; k++) {
      t.step()
      damage = t.engine.failures.find((f) => f.object === t.board.id)?.damage
    }
    expect.soft(damage?.element, "D1").toBe(D1)
    expect.soft(damage?.fatal, "not fatal to the board").toBe(false)
  })

  it("brings the rail up as slowly as its capacitors make it: 37 µF on the rail and VDDA, charged at no more than the LM1117's 1.2 A from a VIN the host's cable lets sag, take 0.06–0.2 ms to reach 3.0 V, not one step", () => {
    const t = bench(false)
    t.run(0.01)
    t.b.doc.parts[partKey(t.board.id, "USB")] = { on: true }
    let k = 0
    while (t.volt("EXT1-5") < 3.0 && k < 1000) {
      t.step()
      k++
    }
    expect.soft(k * DT, "time to 3.0 V: at least Σ C · 3.0 V / 1.2 A").toBeGreaterThanOrEqual(((30.1 + 6.8) * 1e-6 * 3.0) / 1.2 - DT)
    expect.soft(k * DT, "and not much more").toBeLessThanOrEqual(0.2e-3)
  })

  it("carries every capacitor of the Rev. C schematic on its node, at its value (the X5R ones at what DC bias leaves of them at 3.3 V)", () => {
    const want: Record<string, [string, number]> = {
      C1: ["EXT2-26", 100e-9], C2: ["$c2", 10e-6], C21: ["EXT2-26", 100e-9],
      C3: ["EXT1-5", 11.5e-6], C24: ["EXT1-5", 11.5e-6], C4: ["EXT1-5", 100e-9], C5: ["EXT1-5", 100e-9], C6: ["EXT1-5", 100e-9], C7: ["EXT1-5", 100e-9], C8: ["EXT1-5", 6.6e-6], C10: ["EXT1-5", 100e-9],
      C11: ["EXT2-1", 6.6e-6], C9: ["EXT2-1", 100e-9], C22: ["EXT2-1", 100e-9],
      C20: ["$vcap", 2.2e-6], C23: ["$vcap", 2.2e-6],
    }
    const have = Object.fromEntries(olimexStm32H405.model!.flatMap((el) => (el.kind === "C" && "label" in el && el.label && /^C\d+$/.test(el.label) ? [[el.label, [el.a, el.value]]] : [])))
    expect.soft(Object.keys(have).sort(), "the decouplers").toEqual(Object.keys(want).sort())
    for (const [name, [node, farads]] of Object.entries(want)) expect.soft(have[name], name).toEqual([node, farads])
  })
})

describe("the F405's own load on the board, with the starting project running", () => {
  const BLINK = readFileSync(join(FIRMWARE, "prebuilt", "h405-blink.U1.elf")).toString("base64")
  type Bus = { read: (a: number, n: 4) => number; write: (a: number, v: number, n: 4) => void }
  function running(wiring: (b: ReturnType<typeof builder>, board: PlacedObject) => void, usb = true) {
    const b = builder(GRID)
    const board = b.place("olimex-stm32-h405", 0, 0, { vbat: "open" })
    board.props = { ...board.props, firmwareData: BLINK }
    b.doc.parts[partKey(board.id, "USB")] = { on: usb }
    wiring(b, board)
    const sim = new SimLoop()
    sim.setDoc(b.doc)
    sim.setParts(b.doc.parts)
    sim.setRunning(true)
    let t = 0
    const run = (ms: number) => {
      const end = t + ms
      while (t < end) sim.advance((t += 5))
    }
    const parts = (key: string, state: Record<string, boolean>) => {
      b.doc.parts[key] = state
      sim.setParts(b.doc.parts)
    }
    const bus = () => (sim as unknown as { mcus: Map<string, { mcu: { mcu: { bus: Bus } } }> }).mcus.get(board.id)!.mcu.mcu.bus
    const r = (a: number) => bus().read(a, 4) >>> 0
    const w = (a: number, v: number) => bus().write(a, v >>> 0, 4)
    const engine = () => (sim as unknown as { engine: Engine }).engine
    return { b, board, sim, run, parts, r, w, engine }
  }
  const startLse = (r: (a: number) => number, w: (a: number, v: number) => void, run: (ms: number) => void) => {
    w(0x40023840, r(0x40023840) | (1 << 28))
    w(0x40007000, r(0x40007000) | (1 << 8))
    w(0x40023870, 1)
    run(2200)
  }

  it("draws its table current at a 2.4 V rail too: the supply resistance carries what the inspector reports", () => {
    const t = running((b, board) => {
      const src = b.place("dc-source", 90, 0, { value: "2.4 V", rint: "1 mΩ" })
      const gnd = b.place("ground", 90, 20)
      b.wire(src, "+", board, "EXT1-5")
      b.wire(src, "-", gnd, "GND")
      b.wire(gnd, "GND", board, "EXT1-6")
    }, false)
    t.run(600)
    const snap = t.sim.snapshot()!
    const engine = t.engine()
    const supply = engine.net.elements.findIndex((el) => el.kind === "R" && el.live === "$idd" && el.object === t.board.id)
    const drawn = Math.abs(engine.readings()[supply].current)
    expect.soft(drawn, "through the F405's supply element at 2.4 V").toBeNearRel(snap.mcus[t.board.id]!.power.current, 0.01)
  })

  it("loads a cell on VBAT from the first instant VDD is absent, a cold board included: Table 25's reset-state 0.1 µA", () => {
    let lead: { id: string } | undefined
    const t = running((b, board) => {
      const cell = b.place("battery", 80, 0, { chem: "li-mno2", capacity: "0.22 Ah" })
      const gnd = b.place("ground", 80, 10)
      lead = b.wire(cell, "+", board, "EXT1-23")
      b.wire(cell, "-", gnd, "GND")
      b.wire(gnd, "GND", board, "EXT1-6")
    }, false)
    t.run(200)
    t.sim.snapshot()
    t.run(300)
    expect.soft(Math.abs(t.sim.snapshot()!.wireCurrent[lead!.id] ?? 0), "never powered").toBeNearRel(0.1e-6, 0.02)
  })

  it("takes nothing from a cell on VBAT while VDD is up, RESET held or not (RM0090 §5.1.2: the backup domain runs from VDD)", () => {
    let lead: { id: string } | undefined
    const t = running((b, board) => {
      const cell = b.place("battery", 80, 0, { chem: "li-mno2", capacity: "0.22 Ah" })
      const gnd = b.place("ground", 80, 10)
      lead = b.wire(cell, "+", board, "EXT1-23")
      b.wire(cell, "-", gnd, "GND")
      b.wire(gnd, "GND", board, "EXT1-6")
    })
    t.run(300)
    t.parts(partKey(t.board.id, "RESET"), { pressed: true })
    t.run(200)
    t.sim.snapshot()
    t.run(300)
    expect.soft(Math.abs(t.sim.snapshot()!.wireCurrent[lead!.id] ?? 0), "RESET held").toBeLessThan(1e-9)
  })

  it("follows the cell's voltage through one outage: Table 25 at 3.3 V, then at 1.9 V, without the circuit being rebuilt", () => {
    let feed: { id: string } | undefined
    let sw: PlacedObject | undefined
    const t = running((b, board) => {
      const high = b.place("dc-source", 90, 0, { value: "3.3 V", rint: "1 mΩ" })
      const low = b.place("dc-source", 90, 20, { value: "1.9 V", rint: "1 mΩ" })
      sw = b.place("switch", 84, 0)
      const r = b.place("resistor", 84, 20, { value: "1 kΩ" })
      const gnd = b.place("ground", 96, 30)
      const node = b.place("resistor", 78, 10, { value: "1 mΩ" })
      b.wire(high, "+", sw, "1")
      b.wire(sw, "2", node, "1")
      b.wire(low, "+", r, "1")
      b.wire(r, "2", node, "1")
      feed = b.wire(node, "2", board, "EXT1-23")
      b.wire(high, "-", gnd, "GND")
      b.wire(low, "-", gnd, "GND")
      b.wire(gnd, "GND", board, "EXT1-6")
      b.doc.parts[partKey(sw.id, "SW")] = { on: true }
    })
    t.run(200)
    startLse(t.r, t.w, t.run)
    t.parts(partKey(t.board.id, "USB"), { on: false })
    t.run(500)
    t.sim.snapshot()
    t.run(300)
    const atHigh = t.sim.snapshot()!
    const vHigh = atHigh.pinVoltage[pinKey(t.board.id, "EXT1-23")]!
    const table25 = (v: number) => (v <= 2.4 ? 0.62e-6 + ((v - 1.8) / 0.6) * 0.11e-6 : 0.73e-6 + ((v - 2.4) / 0.9) * 0.23e-6)
    expect.soft(Math.abs(atHigh.wireCurrent[feed!.id] ?? 0), `at ${vHigh.toFixed(2)} V`).toBeNearRel(table25(vHigh), 0.02)
    t.parts(partKey(sw!.id, "SW"), { on: false })
    t.run(200)
    t.sim.snapshot()
    t.run(300)
    const atLow = t.sim.snapshot()!
    const vLow = atLow.pinVoltage[pinKey(t.board.id, "EXT1-23")]!
    expect.soft(vLow, "the low source through 1 kΩ").toBeNear(1.9, 0.01)
    expect.soft(Math.abs(atLow.wireCurrent[feed!.id] ?? 0), `at ${vLow.toFixed(2)} V`).toBeNearRel(table25(vLow), 0.02)
  })

  it("loads the cell again, at the reset state's 0.1 µA, when VBAT drops out and returns within one outage: the backup domain lost, the load not", () => {
    let feed: { id: string } | undefined
    let sw: PlacedObject | undefined
    const t = running((b, board) => {
      const cell = b.place("dc-source", 90, 0, { value: "3.3 V", rint: "1 mΩ" })
      sw = b.place("switch", 84, 0)
      const pull = b.place("resistor", 84, 20, { value: "1 MΩ" })
      const node = b.place("resistor", 78, 10, { value: "1 mΩ" })
      const gnd = b.place("ground", 96, 30)
      b.wire(cell, "+", sw, "1")
      b.wire(sw, "2", node, "1")
      b.wire(pull, "1", node, "1")
      b.wire(pull, "2", gnd, "GND")
      feed = b.wire(node, "2", board, "EXT1-23")
      b.wire(cell, "-", gnd, "GND")
      b.wire(gnd, "GND", board, "EXT1-6")
      b.doc.parts[partKey(sw.id, "SW")] = { on: true }
    })
    t.run(200)
    startLse(t.r, t.w, t.run)
    t.parts(partKey(t.board.id, "USB"), { on: false })
    t.run(300)
    t.parts(partKey(sw!.id, "SW"), { on: false })
    t.run(300)
    t.parts(partKey(sw!.id, "SW"), { on: true })
    t.run(200)
    t.sim.snapshot()
    t.run(300)
    expect.soft(Math.abs(t.sim.snapshot()!.wireCurrent[feed!.id] ?? 0), "back at 3.3 V, the domain reset").toBeNearRel(0.1e-6, 0.02)
  })

  it("adds Table 39's 12 mA (x32) for the second a sector erase keeps the flash busy, and nothing after it or after a RESET in the middle of one", () => {
    const t = running(() => {})
    t.run(400)
    const current = () => t.sim.snapshot()!.mcus[t.board.id]!.power.current
    t.sim.snapshot()
    t.run(100)
    const idle = current()
    const erase = () => {
      t.w(0x40023c04, 0x45670123)
      t.w(0x40023c04, 0xcdef89ab)
      t.w(0x40023c10, (2 << 8) | (1 << 1) | (11 << 3) | (1 << 16))
    }
    erase()
    t.run(400)
    expect.soft(current() - idle, "0.4 s into the erase").toBeNear(12e-3, 0.2e-3)
    t.run(500)
    expect.soft(current() - idle, "0.9 s in").toBeNear(12e-3, 0.2e-3)
    t.run(300)
    expect.soft(current() - idle, "0.9–1.2 s: the erase's last 0.1 s of the window's 0.3").toBeNear(12e-3 / 3, 0.3e-3)
    t.run(200)
    expect.soft(current() - idle, "done").toBeNear(0, 0.2e-3)
    erase()
    t.run(300)
    t.parts(partKey(t.board.id, "RESET"), { pressed: true })
    t.run(50)
    t.parts(partKey(t.board.id, "RESET"), { pressed: false })
    t.run(400)
    expect.soft(current() - idle, "after a RESET in the middle of one").toBeNear(0, 0.2e-3)
  })
})
