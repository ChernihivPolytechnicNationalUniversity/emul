import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { getDef } from "@/schematic/registry"

type AfRow = { pin: string; af: Record<string, string> }
type PinRow = { port_pin: string | null; additional_functions: string[] }

const DATA = join(import.meta.dirname, "..", "data", "ds10916")
const TABLE_12: AfRow[] = JSON.parse(readFileSync(join(DATA, "ds10916-rev5-af.json"), "utf8"))
const TABLE_10: PinRow[] = JSON.parse(readFileSync(join(DATA, "ds10916-rev5-pins.json"), "utf8"))

const functionsOf = new Map<string, Set<string>>()
const known = (pad: string) => functionsOf.get(pad) ?? functionsOf.set(pad, new Set([pad])).get(pad)!
for (const row of TABLE_12)
  for (const cell of Object.values(row.af)) for (const signal of cell.split("/")) if (signal !== "-" && signal !== "") known(row.pin).add(signal)
for (const row of TABLE_10) if (row.port_pin) for (const signal of row.additional_functions) known(row.port_pin).add(signal)

const familyOf = (signal: string) => signal.match(/^[A-Z]+\d*/)?.[0] ?? signal

describe("Open746I-C: a connector's peripheral signal names the instance the F746 has on that pad", () => {
  const board = getDef("open746i-c")!
  const functionOf = (p: (typeof board.pins)[number]) => p.fn ?? p.signal
  const named = board.pins.filter((p) => p.mcu && functionOf(p) && functionsOf.has(p.mcu) && familyOf(functionOf(p)!) !== functionOf(p))

  it("covers the connectors' signal names", () => expect(named.length).toBeGreaterThan(100))

  it.each(named.map((p) => [`${p.id} ${p.mcu} ${functionOf(p)}`, p.mcu!, functionOf(p)!] as const))("%s", (_, pad, signal) => {
    const sameFamily = [...functionsOf.get(pad)!].filter((f) => familyOf(f) === familyOf(signal))
    if (sameFamily.length > 0) expect(sameFamily).toContain(signal)
  })

  it("P4's PD11–PD13 are I2C4 on the F746, whatever the board prints", () => {
    const signals = Object.fromEntries(board.pins.filter((p) => p.connector === "P4" && p.mcu?.startsWith("PD1")).map((p) => [p.mcu, p.signal]))
    expect(signals).toEqual({ PD11: "I2C4_SMBA", PD12: "I2C4_SCL", PD13: "I2C4_SDA" })
  })
})
