/**
 * The addressable-LED symbols: no pin name runs into a pixel, at any text size the field
 * draws names at, in any orientation (a part turns with its names).
 */
import { describe, expect, it } from "vitest"
import { boundsOf, boxCorners, labelFrame, labelKnockout, MAX_PIN_LABEL_CELLS, PIN_LABEL_CELLS, pinLabels } from "@/components/field/pin-label"
import { orientPin, type Orientation } from "@/schematic/geometry"
import { addressableComponents } from "@/schematic/components/addressable"
import type { Rotation } from "@/schematic/types"
import { ALL_PARTS } from "@/sim/addressable/parts"

const ORIENTATIONS: Orientation[] = ([0, 90, 180, 270] as Rotation[]).flatMap((rotation) => [{ rotation, mirror: false }, { rotation, mirror: true }])

describe("addressable-LED symbols", () => {
  it("no pin name overlaps a pixel", () => {
    const clashes: string[] = []
    for (const def of addressableComponents)
      for (const size of [PIN_LABEL_CELLS, 0.6, MAX_PIN_LABEL_CELLS]) {
        // Upright: names and pixels turn together, except that names stay readable, so check every orientation.
        for (const o of ORIENTATIONS) {
          const labels = pinLabels(def, o)
          const pixels = def.parts.flatMap((p) => (p.type === "pixel" ? [p] : []))
          for (const label of labels) {
            const pin = orientPin(def.pins.find((p) => p.id === label.id)!, def, o)
            const box = boundsOf(boxCorners(labelKnockout(label.text, label.anchor, size).solid, labelFrame(label, size)).map((p) => ({ x: pin.x + p.x, y: pin.y + p.y })))
            for (const px of pixels) {
              const c = orientPin({ id: "", label: "", x: px.x, y: px.y, side: "left", labelAt: "right", kind: "digital" }, def, o)
              const h = (px.size ?? 0.8) / 2
              if (box.x < c.x + h && c.x - h < box.x + box.w && box.y < c.y + h && c.y - h < box.y + box.h) {
                clashes.push(`${def.id} ${o.rotation}${o.mirror ? "m" : ""} @${size}: ${label.text}/${px.id}`)
                break
              }
            }
          }
        }
      }
    expect([...new Set(clashes.map((c) => c.replace(/ \d+m? /, " ")))]).toEqual([])
  })

  it("every part number is something the palette search finds", () => {
    const words = addressableComponents.flatMap((d) => [d.name, ...(d.keywords ?? [])].map((w) => w.toLowerCase()))
    const lost = ALL_PARTS.map((s) => s.part).filter((part) => !words.some((w) => w.includes(part.toLowerCase())))
    expect(lost).toEqual([])
    expect(addressableComponents.find((d) => d.keywords?.includes("WS2811"))?.name).toBe("WS2811")
  })
})
