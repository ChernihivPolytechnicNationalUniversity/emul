import { CpuIcon } from "lucide-react"
import { builder } from "../builder"
import type { Icon } from "../icons"
import { nucleoApp, type ProjectLoader } from "../projects"
import type { Schematic } from "../types"

/**
 * A four-digit common-cathode display multiplexed: firmware/hal/Src/sevenseg.c counts the
 * seconds since reset on a CC56-12EWA, TIM6 at 1 kHz lighting one digit per millisecond
 * (250 Hz refresh), the decimal point of digit 2 as a separator.
 *
 * Segments a–g, DP come from eight GPIOs on CN10 (D6 D5 D4 D3 D2 D1 D0 D42) through 220 Ω
 * each: (3.3 − 1.8 − ~0.2 V) / 220 Ω ≈ 6 mA a segment. A digit with all eight lit sinks
 * ~48 mA through its common, twice the F429's 25 mA absolute maximum for one pin, so each
 * common goes to ground through a BC547 whose base takes a GPIO on CN7 (D12 D13 D14 D15)
 * through 1 kΩ: 2.6 mA of base current saturates it at 48 mA (Ic max 100 mA). At 1/4 duty a
 * segment averages ~1.5 mA against its 30 mA DC and 160 mA peak ratings.
 */
export const nucleoSevenSeg: { id: string; name: string; description: string; icon: Icon; projects: { ref: string; load: ProjectLoader }[]; build: (grid: number) => Schematic } = {
  id: "nucleo-7seg",
  name: "Nucleo 4-digit 7-segment",
  description: "A CC56-12EWA multiplexed by TIM6 at 1 kHz: segments through 220 Ω from eight GPIOs, each digit's cathode pulled down by a BC547; counts seconds 00.00–99.99.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: nucleoApp("sevenseg") }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)

    // Segments: CN10 outer rows 25..32 (pin ends at x 28). Each runs right to its own column,
    // down through a vertical 220 Ω and on to the display's pin on rows 40..47; the top row
    // takes the rightmost column so no two wires cross.
    const ds = place("seven-segment-4-cc", 47, 39, { value: "CC56-12EWA" })
    const SEGMENTS: [string, string][] = [
      ["a", "CN10-4"], // PE9, D6
      ["b", "CN10-6"], // PE11, D5
      ["c", "CN10-8"], // PF14, D4
      ["d", "CN10-10"], // PE13, D3
      ["e", "CN10-12"], // PF15, D2
      ["f", "CN10-14"], // PG14, D1
      ["g", "CN10-16"], // PG9, D0
      ["DP", "CN10-18"], // PE8, D42
    ]
    SEGMENTS.forEach(([seg, pin], i) => {
      const x = 44 - 2 * i
      const r = place("resistor", x - 1, 34, { value: "220 Ω", power: "0.25" }, 90)
      wire(u, pin, r, "1", [[x, 25 + i]])
      wire(r, "2", ds, seg, [[x, 40 + i]])
    })

    // Digit drivers above the display: a BC547 per common (collector down to it, emitter up to
    // its own ground), its base through 1 kΩ from a CN7 pin. The rightmost driver takes the
    // highest header row, so the base wires nest; D1 runs straight up, D2..D4 fan right.
    const BASES = ["CN7-12", "CN7-10", "CN7-4", "CN7-2"] // PA6 D12, PA5 D13, PB9 D14, PB8 D15
    const ROWS = [18, 17, 14, 13]
    for (let k = 0; k < 4; k++) {
      const cx = 51 + 11 * k
      const q = place("npn", cx - 3, 23, { value: "BC547" }, 180)
      q.mirror = true // collector at the bottom, emitter on top, base on the left
      const rb = place("resistor", cx - 5, 20, { value: "1 kΩ", power: "0.25" }, 90)
      const gnd = place("ground", cx + 2, 24)
      wire(u, BASES[k], rb, "1", [[cx - 4, ROWS[k]]])
      wire(rb, "2", q, "B")
      wire(q, "E", gnd, "GND", [[cx + 3, 22]])
      const d = 51 + 4 * k
      wire(ds, `D${k + 1}`, q, "C", k === 0 ? [] : [[d, 28 + k], [cx, 28 + k]])
    }
    return doc
  },
}
