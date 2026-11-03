import { builder } from "@/schematic/builder"
import { GRID } from "@/schematic/geometry"
import type { Schematic } from "@/schematic/types"

export type SchematicCase = { name: string; build: () => Schematic }

export const SCHEMATIC_CASES: readonly SchematicCase[] = [
  {
    name: "junction-tap",
    build: () => {
      const { doc, place, wire } = builder(GRID)
      const r1 = place("resistor", 0, 2, { value: "1 kΩ" })
      const j = place("junction", 5, 2)
      const r2 = place("resistor", 8, 2, { value: "1 kΩ" })
      const r3 = place("resistor", 5, 5, { value: "1 kΩ" }, 90)
      wire(r1, "2", j, "J")
      wire(j, "J", r2, "1")
      wire(j, "J", r3, "1")
      return doc
    },
  },
  {
    name: "led-diamond-docking",
    build: () => {
      const { doc, place } = builder(GRID)
      place("led", 0, 0, { value: "red" }, 315)
      place("led", 5, 0, { value: "red" }, 45)
      place("led", 0, 3, { value: "red" }, 45)
      place("led", 5, 3, { value: "red" }, 315)
      return doc
    },
  },
  {
    name: "two-pin-contact-dot",
    build: () => {
      const { doc, place } = builder(GRID)
      place("resistor", 0, 0, { value: "1 kΩ" })
      place("led", 3, 1, { value: "red" }, 90)
      return doc
    },
  },
  {
    name: "close-parts-hooks",
    build: () => {
      const { doc, place, wire } = builder(GRID)
      const r1 = place("resistor", 0, 0, { value: "1 kΩ" })
      const r2 = place("resistor", 5, 1, { value: "2.2 kΩ" })
      wire(r1, "2", r2, "1")
      const r3 = place("resistor", 0, 6, { value: "1 kΩ" })
      const l1 = place("led", 4, 7, { value: "green" }, 90)
      wire(r3, "2", l1, "1")
      const r4 = place("resistor", 12, 0, { value: "1 kΩ" }, 90)
      const r5 = place("resistor", 14, 0, { value: "1 kΩ" }, 90)
      wire(r4, "2", r5, "2")
      wire(r4, "1", r5, "1")
      const r6 = place("resistor", 12, 7, { value: "1 kΩ" })
      const r7 = place("resistor", 13, 9, { value: "1 kΩ" }, 180)
      wire(r6, "2", r7, "1")
      return doc
    },
  },
  {
    name: "diode-bridge-attempt",
    build: () => {
      const { doc, place } = builder(GRID)
      const v = { value: "1N4007" }
      place("diode", 0, 0, v, 315)
      place("diode", 4, 0, v, 45)
      place("diode", 0, 4, v, 45)
      place("diode", 4, 4, v, 315)
      return doc
    },
  },
]
