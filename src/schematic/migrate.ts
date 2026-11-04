import { GRID, orientationOf, orientPin, pinPoint, type Point } from "./geometry"
import { partsOnTheLattice, uprightOnTheLattice } from "./migrate-lattice"
import { BOARD_IN_1_28, RENUMBERED_SINCE_1_28 } from "./migrate-open746i-c"
import { wiresAsSegments } from "./migrate-wires"
import { getDef, getPin, withLibrary } from "./registry"
import { partKey, type ComponentDef, type LegacySchematic, type LegacyWire, type PinRef, type PlacedObject, type Schematic } from "./types"

const savedAsHctSelect = (o: PlacedObject) => o.def === "hc595" && o.props?.value === "74HCT595"

function renamedChip(o: PlacedObject): PlacedObject {
  if (!savedAsHctSelect(o)) return o
  const { value: _part, ...props } = o.props ?? {}
  return { ...o, def: "hct595", props }
}

export function migrated(saved: PlacedObject): PlacedObject {
  return uprightOnTheLattice(renamedChip(saved))
}

export type VersionedSchematic = Schematic & { version?: number }

export type SavedSchematic = Omit<Schematic, "wires"> & { wires: unknown[]; version?: number }

export type Upgrade = { doc: Schematic; notes: string[] }

type LegacyUpgrade = { doc: LegacySchematic; notes: string[] }

const legacySteps: ((doc: LegacySchematic) => LegacyUpgrade)[] = [open746HeadersAsOnTheBoard, (doc) => partsOnTheLattice(doc)]

export const SCHEMATIC_VERSION = legacySteps.length + 2

const drawnAsSegments = (wires: unknown) => Array.isArray(wires) && wires.length > 0 && wires.every((w) => !!w && typeof w === "object" && "a" in w && "b" in w && !("from" in w))

export function versionOf(doc: object): number {
  const { version, wires } = doc as { version?: unknown; wires?: unknown }
  if (typeof version === "number" && Number.isInteger(version) && version >= 1) return version
  return drawnAsSegments(wires) ? SCHEMATIC_VERSION : 1
}

export const stamped = (doc: Schematic): VersionedSchematic => ({ ...doc, version: SCHEMATIC_VERSION })

export function legacyUpgraded(doc: SavedSchematic | LegacySchematic): LegacyUpgrade {
  const from = versionOf(doc)
  return withLibrary(doc.library, () => {
    const notes: string[] = []
    let now = doc as LegacySchematic
    for (const step of legacySteps.slice(from - 1)) {
      const next = step(now)
      now = next.doc
      notes.push(...next.notes)
    }
    return { doc: now, notes }
  })
}

export function upgraded(doc: SavedSchematic | Schematic): Upgrade {
  if (versionOf(doc) >= SCHEMATIC_VERSION) return { doc: doc as Schematic, notes: [] }
  const legacy = legacyUpgraded(doc as SavedSchematic)
  const frozen = withLibrary(doc.library, () => wiresAsSegments(legacy.doc))
  return { doc: stamped(frozen.doc), notes: [...legacy.notes, ...frozen.notes] }
}

const BEFORE_VERSIONS = 2

export const upgradedFrom = (doc: SavedSchematic | Schematic, version: number | undefined): Upgrade => upgraded({ ...doc, version: version ?? (drawnAsSegments(doc.wires) ? SCHEMATIC_VERSION : BEFORE_VERSIONS) } as SavedSchematic)

const OPEN746 = "open746i-c"
const LCD7 = "lcd7-f"
const FFC_LINES = Array.from({ length: 40 }, (_, i) => i + 1)

const boardName = (board: PlacedObject) => board.props?.ref || "Open746I-C"

const STRIP_PIN = /^P(18|19|20|21)-\d+$/

const wiredToTheStrips = (doc: LegacySchematic, boards: readonly PlacedObject[]) =>
  doc.wires.some((w) => [w.from, w.to].some((end) => STRIP_PIN.test(end.pin) && boards.some((b) => b.id === end.object)))

function open746HeadersAsOnTheBoard(doc: LegacySchematic): LegacyUpgrade {
  const boards = doc.objects.filter((o) => o.def === OPEN746)
  const def = getDef(OPEN746)
  if (!boards.length || !def || wiredToTheStrips(doc, boards)) return { doc, notes: [] }
  const moved = new Map<string, string[]>()
  const renumbered = (end: PinRef): PinRef => {
    const now = boards.some((b) => b.id === end.object) ? RENUMBERED_SINCE_1_28.get(end.pin) : undefined
    if (!now) return end
    moved.set(end.object, [...(moved.get(end.object) ?? []), end.pin])
    return { ...end, pin: now }
  }
  const wires = doc.wires.map((w): LegacyWire => {
    const from = renumbered(w.from)
    const to = renumbered(w.to)
    return from === w.from && to === w.to ? w : { ...w, from, to }
  })
  const objects = doc.objects.map((o) => (o.def === LCD7 ? redockedOnP15(o, boards, def) : o))
  const notes = boards.flatMap((board) => [...renumberingNote(board, moved.get(board.id)), ...solderedJmp1Note(doc, board)])
  return { doc: { ...doc, objects, wires }, notes }
}

function renumberingNote(board: PlacedObject, ends: readonly string[] | undefined): string[] {
  if (!ends?.length) return []
  const headers = [...new Set(ends.map((pin) => pin.split("-")[0]))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
  return [`${boardName(board)}: ${ends.length} wire ${ends.length === 1 ? "end" : "ends"} on ${headers.join(", ")} moved to keep the same signals, now that these pins are numbered as on the board itself.`]
}

function solderedJmp1Note(doc: LegacySchematic, board: PlacedObject): string[] {
  if (doc.parts?.[partKey(board.id, "JMP1")]?.on !== false) return []
  return [`${boardName(board)}: JMP1 was open in this project. On the board it is a 0 Ω resistor soldered in place, not a jumper, so the SD card detect on P6-9 now always reaches PC13.`]
}

function p15LineIn1_28(board: PlacedObject, def: ComponentDef, line: number): Point | null {
  const pin = getPin(def, `P15-${line}`)
  if (!pin) return null
  const { width, height, p15Line1 } = BOARD_IN_1_28
  const cell = { x: p15Line1.x + ((line - 1) % 20), y: p15Line1.y + (line > 20 ? 1 : 0) }
  const at = orientPin({ ...pin, ...cell }, { ...def, width, height }, orientationOf(board))
  return { x: board.x + at.x * GRID, y: board.y + at.y * GRID }
}

const samePoint = (a: Point | null, b: Point | null) => !!a && !!b && Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5

const dockedIn1_28 = (lcd: PlacedObject, board: PlacedObject, def: ComponentDef) =>
  FFC_LINES.every((line) => samePoint(pinPoint(lcd, String(line), GRID), p15LineIn1_28(board, def, line)))

function redockedOnP15(lcd: PlacedObject, boards: readonly PlacedObject[], def: ComponentDef): PlacedObject {
  const board = boards.find((b) => dockedIn1_28(lcd, b, def))
  const was = board && p15LineIn1_28(board, def, 1)
  const now = board && pinPoint(board, "P15-1", GRID)
  if (!was || !now) return lcd
  return { ...lcd, x: lcd.x + now.x - was.x, y: lcd.y + now.y - was.y }
}
