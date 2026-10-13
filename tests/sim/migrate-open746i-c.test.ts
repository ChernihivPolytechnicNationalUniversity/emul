import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { pinContacts } from "@/schematic/contacts"
import { lcdDemo } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { RENUMBERED_SINCE_1_28 } from "@/schematic/migrate-open746i-c"
import { SCHEMATIC_VERSION, stamped, upgraded, versionOf } from "@/schematic/migrate"
import { parseProject, readProjectFile, schematicText } from "@/project/project-store"
import { getDef } from "@/schematic/registry"
import type { PinKind, PlacedObject, Rotation, Schematic, Wire } from "@/schematic/types"

type TablePin = { label: string; mcu: string | null; kind: PinKind; connector: string | null; x: number; y: number }

const DATA = join(import.meta.dirname, "..", "data", "emul-1.28.0")
const BOARD_1_28: { width: number; height: number; pins: Record<string, TablePin> } = JSON.parse(readFileSync(join(DATA, "open746i-c-pins.json"), "utf8"))
const board = getDef("open746i-c")!
const RAILS = new Set(["GND", "3V3", "5V"])
const CARD_DETECT_BEHIND_JMP1 = "P6-9"

function signalOf(p: TablePin): string {
  if (p.kind === "gnd") return "GND"
  if (p.connector === "P22" || p.label === "5V") return "5V"
  if (p.connector === "P23" || ["3V3", "IOREF", "AVDD"].includes(p.label)) return "3V3"
  if (p.kind === "nc") return "NC"
  return p.mcu ?? p.label
}

const signalIn1_28 = (id: string) => (id === CARD_DETECT_BEHIND_JMP1 ? "PC13" : signalOf(BOARD_1_28.pins[id]))

function signalNow(id: string): string | undefined {
  const pin = board.pins.find((p) => p.id === id)
  return pin && signalOf({ ...pin, mcu: pin.mcu ?? null, connector: pin.connector ?? null })
}

const open746 = (at: Partial<PlacedObject> = {}): PlacedObject => ({ id: "U1", def: "open746i-c", x: 0, y: 0, props: { ref: "U1" }, ...at })
const doc = (objects: PlacedObject[], wires: Wire[] = [], parts: Schematic["parts"] = {}): Schematic => ({ objects, wires, parts })
const lcdTouching = (d: Schematic, lcd: PlacedObject) => [...pinContacts(d.objects, GRID).groups.keys()].filter((key) => key.startsWith(`${lcd.id}:`)).length

describe("a project saved on emul 1.28.0 keeps its Open746I-C wiring now that P1, P4, P10 and P11 are numbered as on the board", () => {
  it("the brigade's lab 2 file drives its red, green and blue ballasts from PD12, PD13 and PD14 again", async () => {
    const bytes = readFileSync(join(DATA, "lab2-rgb-pwm.emul"))
    const saved = (JSON.parse(bytes.toString("utf8")) as { schematic: Schematic }).schematic
    expect(versionOf(saved), "a 1.28.0 file carries no schematic version").toBe(1)

    const otherEnds = (d: Schematic, id: string) => d.wires.flatMap((w) => (w.from.object === id ? [w.to] : w.to.object === id ? [w.from] : []))
    const padOfBallast = (d: Schematic, ledRef: string) => {
      const led = d.objects.find((o) => o.props?.ref === ledRef)!
      const ballast = otherEnds(d, led.id).find((e) => d.objects.find((o) => o.id === e.object)?.def === "resistor")!
      const onBoard = otherEnds(d, ballast.object).find((e) => d.objects.find((o) => o.id === e.object)?.def === "open746i-c")!
      return signalNow(onBoard.pin)
    }
    const colours = (d: Schematic) => ({ red: padOfBallast(d, "VD1R"), green: padOfBallast(d, "VD1G"), blue: padOfBallast(d, "VD1B") })

    expect(colours(saved), "taken as it was saved, the renumbered P4 sends green to ground and red to PD13").toEqual({ red: "PD13", green: "GND", blue: "PD14" })

    const read = await readProjectFile(new Blob([bytes]))
    expect(read, "the file reads as a project").not.toBeNull()
    expect(colours(read!.doc), "opened: TIM4 CH1–CH3 as the brief and the firmware have them").toEqual({ red: "PD12", green: "PD13", blue: "PD14" })
    expect(versionOf(read!.doc)).toBe(SCHEMATIC_VERSION)
    expect(read!.notes).toEqual(["U1: 2 wire ends on P4 moved to keep the same signals, now that these pins are numbered as on the board itself."])
  })

  it("a wire on every pin of the 1.28.0 board ends on the same signal, and no wire moves onto another rail", () => {
    const pins = Object.keys(BOARD_1_28.pins)
    const resistor: PlacedObject = { id: "R1", def: "resistor", x: -480, y: 0 }
    const wires: Wire[] = [
      ...pins.map((pin, i): Wire => ({ id: `w${i}`, from: { object: "U1", pin }, to: { object: "R1", pin: "1" } })),
      { id: "across", from: { object: "U1", pin: "P4-3" }, to: { object: "U1", pin: "P1-11" } },
    ]
    const before = doc([open746(), resistor], wires)
    const { doc: after, notes } = upgraded(before)

    pins.forEach((pin, i) => expect.soft(signalNow(after.wires[i].from.pin), `${pin} (${signalIn1_28(pin)})`).toBe(signalIn1_28(pin)))
    const across = after.wires.at(-1)!
    expect.soft([signalNow(across.from.pin), signalNow(across.to.pin)], "a wire with both ends on the board").toEqual(["PD13", "GND"])

    const ontoARail = after.wires.filter((w, i) => i < pins.length && !RAILS.has(signalIn1_28(pins[i])) && RAILS.has(signalNow(w.from.pin)!))
    expect(ontoARail.map((w) => w.from.pin), "signal wires now on a supply rail").toEqual([])
    const offARail = after.wires.filter((w, i) => i < pins.length && RAILS.has(signalIn1_28(pins[i])) && signalNow(w.from.pin) !== signalIn1_28(pins[i]))
    expect(offARail.map((w) => w.from.pin), "rail wires now on another rail or a signal").toEqual([])

    expect.soft(
      Object.fromEntries(["P4-3", "P4-5", "P4-9", "P4-10", "P1-11", "P1-12", "P11-2", "P10-1", "P10-20"].map((pin) => [pin, after.wires[pins.indexOf(pin)].from.pin])),
      "the pins the review called out",
    ).toEqual({ "P4-3": "P4-5", "P4-5": "P4-7", "P4-9": "P4-3", "P4-10": "P4-4", "P1-11": "P1-3", "P1-12": "P1-4", "P11-2": "P11-4", "P10-1": "P10-3", "P10-20": "P10-16" })
    expect.soft(
      after.wires.filter((w, i) => w === before.wires[i]).length,
      "every wire off P1, P4, P10 and P11 is the same object",
    ).toBe(pins.length - RENUMBERED_SINCE_1_28.size)
    expect.soft(new Set([...RENUMBERED_SINCE_1_28.keys()].map((pin) => pin.split("-")[0])), "only the four headers the board renumbers").toEqual(new Set(["P1", "P4", "P10", "P11"]))
    expect(notes).toEqual([`U1: ${RENUMBERED_SINCE_1_28.size + 2} wire ends on P1, P4, P10, P11 moved to keep the same signals, now that these pins are numbered as on the board itself.`])
  })

  it("the board's size and P15 as 1.28.0 drew them are the ones the migration docks the LCD from", () => {
    expect([BOARD_1_28.width, BOARD_1_28.height]).toEqual([76, 56])
    expect([BOARD_1_28.pins["P15-1"].x, BOARD_1_28.pins["P15-1"].y, BOARD_1_28.pins["P15-40"].x, BOARD_1_28.pins["P15-40"].y]).toEqual([35, 52, 54, 53])
  })

  it.each([
    { rotation: 0 as Rotation, board: [10, -4], lcd: [13, 52] },
    { rotation: 180 as Rotation, board: [0, 0], lcd: [8, -40] },
  ])("a 7\" LCD docked on P15 at 1.28.0's place docks again, the board turned $rotation°", ({ rotation, board: [bx, by], lcd: [lx, ly] }) => {
    const u = open746({ x: bx * GRID, y: by * GRID, rotation })
    const lcd: PlacedObject = { id: "LCD", def: "lcd7-f", x: lx * GRID, y: ly * GRID, rotation }
    const before = doc([u, lcd])
    expect(lcdTouching(before, lcd), "off P15 on today's board").toBeLessThan(40)
    const after = upgraded(before).doc
    const moved = after.objects.find((o) => o.id === "LCD")!
    expect(lcdTouching(after, moved), "all forty FFC lines touch P15 again").toBe(40)
    expect(after.objects.find((o) => o.id === "U1"), "the board stays where it was").toBe(u)
  })

  it("an LCD that was not docked stays where it was", () => {
    const lcd: PlacedObject = { id: "LCD", def: "lcd7-f", x: 4 * GRID, y: 80 * GRID }
    const after = upgraded(doc([open746(), lcd])).doc
    expect(after.objects.find((o) => o.id === "LCD")).toBe(lcd)
  })

  it("a JMP1 left open cannot open a soldered link, so the upgrade says so", () => {
    expect(upgraded(doc([open746()], [], { "U1:JMP1": { on: false } })).notes).toEqual([
      "U1: JMP1 was open in this project. On the board it is a 0 Ω resistor soldered in place, not a jumper, so the SD card detect on P6-9 now always reaches PC13.",
    ])
    expect(upgraded(doc([open746()], [], { "U1:JMP1": { on: true } })).notes).toEqual([])
    expect(upgraded(doc([open746()])).notes).toEqual([])
  })

  it("a schematic at today's version is left alone, and one from 1.28.0 without the board is only stamped", () => {
    const today = stamped(lcdDemo.build(GRID))
    const kept = upgraded(today)
    expect(kept.doc).toBe(today)
    expect(kept.notes).toEqual([])

    const newer = { ...today, version: SCHEMATIC_VERSION + 1 }
    expect(upgraded(newer).doc).toBe(newer)

    const plain = doc([{ id: "R1", def: "resistor", x: 0, y: 0 }], [{ id: "w", from: { object: "R1", pin: "1" }, to: { object: "R1", pin: "2" } }])
    const { doc: same, notes } = upgraded(plain)
    expect(same).toEqual({ ...plain, version: SCHEMATIC_VERSION })
    expect(same.objects).toBe(plain.objects)
    expect(same.wires).toBe(plain.wires)
    expect(notes).toEqual([])
  })

  it("a schematic this branch saved before documents carried a version is recognised by its strip wires and left alone", () => {
    const wires: Wire[] = [
      { id: "w1", from: { object: "U1", pin: "P4-5" }, to: { object: "U1", pin: "P20-11" } },
    ]
    const { doc: after, notes } = upgraded(doc([open746()], wires))
    expect(after.wires).toEqual(wires)
    expect(notes).toEqual([])
    expect(versionOf(after)).toBe(SCHEMATIC_VERSION)
  })

  it("what the app stores is stamped, so a project upgraded once is never upgraded again", () => {
    const old = doc([open746()], [{ id: "w1", from: { object: "U1", pin: "P4-5" }, to: { object: "U1", pin: "P4-9" } }])
    const first = parseProject(JSON.stringify(old))!
    expect(first.doc.wires[0].from.pin).not.toBe("P4-5")
    expect(first.notes.length).toBe(1)
    const again = parseProject(schematicText(first.doc))!
    expect(again.doc.wires).toEqual(first.doc.wires)
    expect(again.notes).toEqual([])
    expect(JSON.parse(schematicText(doc([]))).version).toBe(SCHEMATIC_VERSION)
  })
})
