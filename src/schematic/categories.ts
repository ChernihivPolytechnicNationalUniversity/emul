/**
 * The palette's groups, in the order the palette shows them. A part names its group by id; the
 * type admits no other value, so a new group is added here or not at all. Groups follow what a
 * student is looking for, not how a part is built: the everyday parts open the list.
 */
export const CATEGORIES = [
  { id: "basics", label: "Basics" },
  { id: "boards", label: "Boards", aside: "ready to run" },
  { id: "mcus", label: "Microcontrollers", aside: "bare chips" },
  { id: "leds", label: "LEDs & indicators" },
  { id: "displays", label: "Displays" },
  { id: "input", label: "Input" },
  { id: "semis", label: "Semiconductors" },
  { id: "ics", label: "ICs & timing" },
  { id: "power", label: "Power & sources" },
  { id: "sound", label: "Sound & motion" },
  { id: "instruments", label: "Instruments" },
] as const

export type PaletteCategory = (typeof CATEGORIES)[number]["id"]

/** Groups a newcomer opens first; the rest start folded, so the whole catalogue fits on a screen. */
export const OPEN_AT_FIRST: readonly PaletteCategory[] = ["basics"]

/** A project's own HDL modules: listed with the project, not in the library's groups. */
export const HDL_CATEGORY = "hdl"

export type Category = PaletteCategory | typeof HDL_CATEGORY

const LABELS: ReadonlyMap<string, string> = new Map(CATEGORIES.map((c) => [c.id, c.label]))

export const isPaletteCategory = (id: string): id is PaletteCategory => LABELS.has(id)

export const categoryLabel = (id: PaletteCategory): string => LABELS.get(id)!
