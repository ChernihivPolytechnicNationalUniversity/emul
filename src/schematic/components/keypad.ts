/**
 * 4×4 matrix membrane keypad, after the Parallax #27899 sheet (v1.2, 12/16/2011): sixteen keys,
 * each a contact between its row and its column, nothing else inside — no diodes, so three keys
 * held at the corners of a rectangle close the fourth corner's path too (ghosting), as on the
 * real part. Rating 24 V DC, 30 mA (Parallax); contact resistance under 100 Ω (Adafruit #3844).
 * Neither gives a bounce time; the retailers' "≤ 5 ms" (Thinkrobotics, Probots listings, not a
 * maker's sheet) is the default when bounce is switched on.
 */
import { KeypadIcon } from "../icons"
import type { ComponentDef, Element, PartDef, PinDef } from "../types"
import { BOUNCE_FIELDS } from "./basic"

const LEGENDS = [
  ["1", "2", "3", "A"],
  ["4", "5", "6", "B"],
  ["7", "8", "9", "C"],
  ["*", "0", "#", "D"],
]

const W = 10
const H = 11
const PITCH = 1.9
const KEY = 1.5
const LEFT = 2.15
const TOP = 1.4

const partId = (r: number, c: number) => `K${r + 1}${c + 1}`

/** Header left to right seen from the front: rows 1–4, then columns 1–4; Parallax numbers it 8 down to 1. */
const HEADER = ["R1", "R2", "R3", "R4", "C1", "C2", "C3", "C4"]

const pins: PinDef[] = HEADER.map((id, k) => ({
  id,
  label: id,
  x: 1 + k,
  y: H,
  side: "bottom",
  labelAt: "top",
  kind: "digital",
  connector: "8-pin header",
  connectorPin: 8 - k,
  note: id.startsWith("R") ? `Row ${id[1]}: keys ${LEGENDS[Number(id[1]) - 1].join(" ")}` : `Column ${id[1]}: keys ${LEGENDS.map((row) => row[Number(id[1]) - 1]).join(" ")}`,
}))

const parts: PartDef[] = LEGENDS.flatMap((row, r) =>
  row.map((face, c): PartDef => ({ type: "button", id: partId(r, c), label: `Key ${face}`, face, x: LEFT + c * PITCH, y: TOP + r * PITCH, size: KEY, printed: true })),
)

/**
 * The 30 mA is a switching rating, as every switch's here: a key carrying more reads over 100 %
 * in the inspector. No sheet gives a carry limit or a failure for a printed membrane contact,
 * and it has no silver contact spot to weld, so it never breaks.
 */
const KEY_LIMITS = { current: "{imax}" } as const

const model: Element[] = LEGENDS.flatMap((row, r) =>
  row.map((_, c): Element => ({ kind: "SW", a: `R${r + 1}`, b: `C${c + 1}`, part: partId(r, c), closed: "pressed", ron: "{rcontact}", limits: KEY_LIMITS })),
)

export const keypad4x4: ComponentDef = {
  id: "keypad-4x4",
  name: "Keypad 4×4",
  description:
    "Matrix membrane keypad (Parallax #27899): 16 keys, each closing its row to its column — scan the rows, read the columns. No diodes: three keys at a rectangle's corners ghost the fourth. 24 V DC, 30 mA rating; contact resistance under 100 Ω.",
  category: "Switches",
  keywords: ["keypad", "keyboard", "matrix", "membrane", "4x4", "27899"],
  icon: KeypadIcon,
  prefix: "SW",
  width: W,
  height: H,
  defaults: { imax: "30 mA", rcontact: "100 Ω", bounce: "off", tbounce: "5 ms" },
  fields: [{ key: "imax", label: "Contact rating", type: "quantity", unit: "A" }, { key: "rcontact", label: "Contact resistance", type: "quantity", unit: "Ω" }, ...BOUNCE_FIELDS],
  pins,
  body: [
    { type: "rect", x: 0.6, y: 0.3, w: W - 1.2, h: H - 1.1, rx: 0.3, fill: "zone" },
    { type: "path", d: `M1 ${H - 0.8} H${W - 2}`, muted: true },
    { type: "text", x: W - 0.7, y: -0.25, text: "{ref}", size: 0.32, muted: true, anchor: "end" },
  ],
  parts,
  model,
  info: { Source: "Parallax #27899 4x4 Matrix Membrane Keypad, v1.2 (12/16/2011); Adafruit #3844 product page (contact resistance)" },
}
