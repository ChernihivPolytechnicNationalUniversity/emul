import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { formatOf, guestRoom, hostRoom, join as joinRoom, newerPeers, newerThanThis, olderPeers, onNewerFormat, pushTo, readRoom, reloadForNewer, ROOM_FORMAT, ROOM_VERSION, roomOf, shelfName, split, type NewerSeen, type Room } from "@/collab/elements"
import { readProjectFile } from "@/project/project-store"
import { GRID, objectPins } from "@/schematic/geometry"
import { legacyUpgraded, SCHEMATIC_VERSION } from "@/schematic/migrate"
import type { LegacySchematic, PlacedObject, Schematic } from "@/schematic/types"
import { clipboardText, clipFromClipboard, clipOfThisVersion, pastedInto, type Clip } from "@/schematic/use-schematic"
import { inNormalForm, withSegments } from "@/schematic/wire-edits"
import { normalFormViolations } from "../lib/wire-reference"
import type { WireSegment } from "@/schematic/wires/segment"
import { pinPartition } from "../lib/pin-partition"

const OLD = join(import.meta.dirname, "..", "data", "emul-1.42.0")

async function rawOld(file: string): Promise<LegacySchematic> {
  const { Zstd } = await import("@hpcc-js/wasm-zstd")
  const bytes = (await Zstd.load()).decompress(new Uint8Array(readFileSync(join(OLD, file))))
  return (JSON.parse(new TextDecoder().decode(bytes)) as { schematic: LegacySchematic }).schematic
}

async function opened(file: string) {
  const read = await readProjectFile(new Blob([readFileSync(join(OLD, file))]))
  if (!read) throw new Error(`${file} does not read`)
  return read
}

const placements = (doc: Pick<Schematic, "objects">) => doc.objects.map((o) => [o.id, o.x, o.y, o.rotation ?? 0]).sort()
const drawn = (wires: readonly WireSegment[]) => wires.map((s) => [s.a.x, s.a.y, s.b.x, s.b.y].join(",")).sort()

function emptyRoom(): Room {
  const ydoc = new Y.Doc()
  return roomOf(ydoc, ydoc.getMap<string>("meta"))
}

function roomAnOlderTabFilled(doc: LegacySchematic, stamp?: string): Room {
  const room = emptyRoom()
  const legacy = room.ydoc.getMap<string>(shelfName(SCHEMATIC_VERSION - 1))
  for (const [k, v] of split(doc as unknown as Schematic)) legacy.set(k, v)
  if (stamp) room.meta.set(ROOM_VERSION, stamp)
  return room
}

const legacyShelf = (room: Room) => new Map(room.ydoc.getMap<string>(shelfName(SCHEMATIC_VERSION - 1)).entries())

describe("a live room keeps a shelf per format, so a tab of an older εmul never sees the wires it cannot read (design.md §13.16)", () => {
  it("the shelves are named by format: the old one keeps its name, this one carries its number", () => {
    expect.soft(shelfName(3), "1.42.0's shelf").toBe("elements")
    expect.soft(shelfName(SCHEMATIC_VERSION), "this version's").toBe(`elements@${SCHEMATIC_VERSION}`)
  })

  it("a guest entering a room an older εmul filled gets it as the file opens, notes and all; it is written to this version's shelf, and the old shelf is left as it was", async () => {
    const file = await opened("npn-on-a-diagonal.emul")
    const room = roomAnOlderTabFilled(await rawOld("npn-on-a-diagonal.emul"))
    const before = legacyShelf(room)
    const entered = guestRoom(room)!
    expect.soft(entered.notes, "the file's notes").toEqual(file.notes)
    expect.soft(placements(entered.doc), "the file's placements").toEqual(placements(file.doc))
    expect.soft(drawn(entered.doc.wires), "the file's wires").toEqual(drawn(file.doc.wires))
    expect.soft(formatOf(room), "the room's format").toBe(SCHEMATIC_VERSION)
    expect.soft(drawn(joinRoom(new Map(room.elements.entries())).wires), "written to this version's shelf").toEqual(drawn(file.doc.wires))
    expect.soft(legacyShelf(room), "the old shelf untouched").toEqual(before)
    const again = readRoom(room)
    expect.soft(again.notes, "read again: nothing to say").toEqual([])
    expect.soft(placements(again.doc), "nor anything moved").toEqual(placements(file.doc))
  })

  it("a room a tab of the lattice's version stamped is frozen without being moved onto the lattice again", async () => {
    const file = await opened("npn-on-a-diagonal.emul")
    expect.soft(file.notes.length, "the file's upgrade has something to say").toBeGreaterThan(0)
    const room = roomAnOlderTabFilled(legacyUpgraded(await rawOld("npn-on-a-diagonal.emul")).doc, "3")
    const entered = guestRoom(room)!
    expect.soft(entered.notes, "nothing moved again").toEqual([])
    expect.soft(placements(entered.doc), "every part where the file has it").toEqual(placements(file.doc))
    expect.soft(drawn(entered.doc.wires), "and every wire").toEqual(drawn(file.doc.wires))
  })

  it("a host entering such a room gets the same; a host bringing a document to an empty room writes it on this version's shelf", async () => {
    const file = await opened("npn-on-a-diagonal.emul")
    const old = roomAnOlderTabFilled(await rawOld("npn-on-a-diagonal.emul"))
    const entered = hostRoom(old, { objects: [], wires: [], parts: {} })!
    expect.soft(entered.notes, "the file's notes").toEqual(file.notes)
    expect.soft(formatOf(old), "the room's format").toBe(SCHEMATIC_VERSION)
    const empty = emptyRoom()
    expect.soft(hostRoom(empty, file.doc), "an empty room has nothing to hand back").toBeNull()
    expect.soft(empty.meta.get(ROOM_FORMAT), "its format").toBe(String(SCHEMATIC_VERSION))
    expect.soft(legacyShelf(empty).size, "nothing on the old shelf").toBe(0)
    expect.soft(drawn(guestRoom(empty)!.doc.wires), "a guest reads the host's wires").toEqual(drawn(file.doc.wires))
  })

  it("a room on this version's shelf is read as it is, and an empty room turns a guest away", async () => {
    const file = await opened("led-diamond.emul")
    const room = emptyRoom()
    pushTo(room, file.doc)
    const entered = guestRoom(room)!
    expect.soft(entered.notes, "no notes").toEqual([])
    expect.soft(placements(entered.doc), "unchanged").toEqual(placements(file.doc))
    expect.soft(guestRoom(emptyRoom()), "empty").toBeNull()
  })

  it("a room's format is never lowered: a newer tab's room stays newer, and this tab can tell", async () => {
    const file = await opened("led-diamond.emul")
    const room = emptyRoom()
    room.meta.set(ROOM_FORMAT, String(SCHEMATIC_VERSION + 1))
    pushTo(room, file.doc)
    expect.soft(formatOf(room), "still the newer format").toBe(SCHEMATIC_VERSION + 1)
    expect.soft(newerThanThis(room), "newer than this tab").toBe(true)
    expect.soft(newerThanThis(emptyRoom()), "an empty room is not").toBe(false)
  })
})

describe("the tabs in a room say which format they write (design.md §13.16)", () => {
  it("a tab that says nothing or an earlier format is older, a later one newer, this one neither", () => {
    const peers = [{ name: "1.42.0" }, { name: "lattice", format: 3 }, { name: "now", format: SCHEMATIC_VERSION }, { name: "later", format: SCHEMATIC_VERSION + 1 }, { name: "garbage", format: "x" }]
    expect.soft(olderPeers(peers).map((p) => p.name), "older").toEqual(["1.42.0", "lattice", "garbage"])
    expect.soft(newerPeers(peers).map((p) => p.name), "newer").toEqual(["later"])
  })

  it("a tab told again and again of the same newer format acts once: it reloads, or after its reload it warns, and then keeps quiet", () => {
    const kept = new Map<string, string>()
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) }
    const first: NewerSeen = { format: SCHEMATIC_VERSION }
    expect.soft(onNewerFormat(storage, "room", SCHEMATIC_VERSION, first), "its own format is no news").toBeNull()
    expect.soft(onNewerFormat(storage, "room", SCHEMATIC_VERSION + 1, first), "the first word of a newer one").toBe("reload")
    expect.soft(onNewerFormat(storage, "room", SCHEMATIC_VERSION + 1, first), "the same again").toBeNull()
    const reloaded: NewerSeen = { format: SCHEMATIC_VERSION }
    expect.soft(onNewerFormat(storage, "room", SCHEMATIC_VERSION + 1, reloaded), "after the reload: a warning").toBe("warn")
    for (let i = 0; i < 5; i++) expect.soft(onNewerFormat(storage, "room", SCHEMATIC_VERSION + 1, reloaded), `then quiet (${i})`).toBeNull()
    expect.soft(onNewerFormat(storage, "room", SCHEMATIC_VERSION + 2, reloaded), "a later format still counts").toBe("reload")
  })

  it("a tab reloads itself for a newer format once per room and format, and never where it cannot remember having done so", () => {
    const kept = new Map<string, string>()
    const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) }
    expect.soft(reloadForNewer(storage, "room-a", 5), "the first time").toBe(true)
    expect.soft(reloadForNewer(storage, "room-a", 5), "not twice").toBe(false)
    expect.soft(reloadForNewer(storage, "room-a", 6), "a later format again").toBe(true)
    expect.soft(reloadForNewer(storage, "room-b", 5), "another room").toBe(true)
    expect.soft(reloadForNewer(null, "room-a", 7), "no storage").toBe(false)
    const refusing = { getItem: () => null, setItem: () => { throw new Error("quota") } }
    expect.soft(reloadForNewer(refusing, "room-a", 7), "storage that refuses").toBe(false)
  })
})

describe("the clipboard carries the version, its wires as segments, and nothing an older tab could misread (design.md §13.16)", () => {
  it("a clip copied here comes back exactly as it went, and an older tab reading it finds no wires of its own format", async () => {
    const { doc } = await opened("power-supply.emul")
    const clip: Clip = { objects: doc.objects, wires: doc.wires, parts: doc.parts }
    const text = clipboardText(clip)
    const raw = JSON.parse(text) as { emul: { wires: unknown[]; segments: unknown[] }; version: number }
    expect.soft(raw.version, "the version").toBe(SCHEMATIC_VERSION)
    expect.soft(raw.emul.wires, "no wires an older tab would read").toEqual([])
    const back = clipFromClipboard(text)!
    expect.soft(back.notes, "nothing to say").toEqual([])
    expect.soft(placements(back.clip), "every part where it was").toEqual(placements(doc))
    expect.soft(back.clip.wires, "every segment as it was").toEqual(doc.wires)
  })

  it("a clip from an older tab, with no version, is upgraded and frozen as the file is, and says what moved", async () => {
    const file = await opened("npn-on-a-diagonal.emul")
    const stored = await rawOld("npn-on-a-diagonal.emul")
    const back = clipFromClipboard(JSON.stringify({ emul: { objects: stored.objects, wires: stored.wires, parts: stored.parts } }))!
    expect.soft(back.notes, "the file's notes").toEqual(file.notes)
    expect.soft(placements(back.clip), "the file's placements").toEqual(placements(file.doc))
    expect.soft(drawn(back.clip.wires), "the file's wires").toEqual(drawn(file.doc.wires))
  })

  it("a clip from a tab of the lattice's version is frozen without being moved again", async () => {
    const file = await opened("power-supply.emul")
    const lattice = legacyUpgraded(await rawOld("power-supply.emul")).doc
    const back = clipOfThisVersion({ objects: lattice.objects, wires: lattice.wires, parts: lattice.parts }, 3)!
    expect.soft(placements(back.clip), "every part where the file has it").toEqual(placements(file.doc))
    expect.soft(drawn(back.clip.wires), "and every wire").toEqual(drawn(file.doc.wires))
  })

  it("a clip from a newer εmul is refused rather than misread", () => {
    const text = JSON.stringify({ emul: { objects: [], wires: [], segments: [], parts: {} }, version: SCHEMATIC_VERSION + 1 })
    expect.soft(clipFromClipboard(text), "refused").toBeNull()
  })

  it("a clip of this version is brought into normal form, and one that cannot be is refused rather than pasted (findings 3.L14)", () => {
    const clip = (segments: WireSegment[]) => JSON.stringify({ emul: { objects: [], wires: [], segments, parts: {} }, version: SCHEMATIC_VERSION })
    const overlapping = clipFromClipboard(clip([{ id: "a", a: { x: 0, y: 0 }, b: { x: 4 * GRID, y: 0 } }, { id: "b", a: { x: 2 * GRID, y: 0 }, b: { x: 6 * GRID, y: 0 } }]))
    expect.soft(overlapping?.clip.wires.map((s) => [s.a.x, s.b.x]), "two overlapping wires merged into one").toEqual([[0, 6 * GRID]])
    expect.soft(clipFromClipboard(clip([{ id: "d", a: { x: 0, y: 0 }, b: { x: GRID, y: GRID } }])), "a diagonal wire: no clip").toBeNull()
    expect.soft(clipFromClipboard(clip([{ id: "d", a: { x: 0, y: 0 }, b: { x: GRID, y: 0 } }, { id: "d", a: { x: 0, y: GRID }, b: { x: GRID, y: GRID } }])), "two wires with one id: no clip").toBeNull()
  })

  it("text that is not an εmul clip is no clip", () => {
    for (const text of [undefined, "", "R1 10k", "{\"emul\": 3}", JSON.stringify({ objects: [] })]) expect.soft(clipFromClipboard(text), JSON.stringify(text)).toBeNull()
  })
})

describe("a paste brings its segments along and joins where its pins land (design.md §6.6)", () => {
  const resistor = (id: string, x: number, y: number): PlacedObject => ({ id, def: "resistor", x: x * GRID, y: y * GRID, props: { ref: id } })
  const pinAt = (o: PlacedObject, pin: string) => objectPins(o, GRID).find((p) => p.pin.id === pin)!.point

  it("the pasted wires move with their parts under fresh ids, and a pasted pin landing on a wire splits it there", () => {
    const r1 = resistor("R1", 0, 0)
    const r2 = resistor("R2", 8, 0)
    const wire: WireSegment = { id: "w", a: pinAt(r1, "2"), b: pinAt(r2, "1") }
    const clip: Clip = { objects: [r1, r2], wires: [wire], parts: {} }
    const below = { x: 0, y: 6 * GRID }
    const host = resistor("H", 0, 0)
    const crossing: WireSegment = { id: "bus", a: { x: pinAt(r2, "2").x, y: pinAt(r2, "2").y + below.y - 4 * GRID }, b: { x: pinAt(r2, "2").x, y: pinAt(r2, "2").y + below.y + 4 * GRID } }
    const doc: Schematic = { objects: [{ ...host, x: -40 * GRID }], wires: [crossing], parts: {} }
    let n = 0
    const pasted = pastedInto(doc, clip, below.x, below.y, (id) => `${id}'`, () => `new${n++}`)
    const ids = pasted.wires.map((s) => s.id)
    expect.soft(ids.includes("w"), "fresh ids").toBe(false)
    expect.soft(pasted.objects.map((o) => o.props?.ref), "fresh designators").toEqual(["H", "R1", "R2"])
    expect.soft(pinPartition(pasted), "R1 2 to R2 1 by the pasted wire, R2 2 onto the bus").toEqual([["R1.2", "R2.1"]])
    const split = pasted.wires.filter((s) => s.a.x === crossing.a.x && s.b.x === crossing.a.x)
    expect.soft(split.length, "the bus split where R2's pin landed").toBe(2)
  })
})

describe("found by phase 3's reviews", () => {
  it("a room this version has written stays its own, emptied or not: the old shelf is not read again, nor an old tab's later edits (findings 3.R3)", async () => {
    const room = roomAnOlderTabFilled(await rawOld("power-supply.emul"))
    expect.soft(guestRoom(room)!.doc.objects.length, "the first entry upgrades the old shelf").toBeGreaterThan(0)
    pushTo(room, { objects: [], wires: [], parts: {} })
    room.ydoc.getMap<string>(shelfName(SCHEMATIC_VERSION - 1)).set("o:old-tab-edit", JSON.stringify({ id: "old-tab-edit", def: "resistor", x: 0, y: 0, z: 99 }))
    expect.soft(readRoom(room).doc.objects, "emptied on purpose, it stays empty").toEqual([])
    expect.soft(hostRoom(room, { objects: [], wires: [], parts: {} }), "a host finds nothing to take back").toBeNull()
  })

  it("two tabs splitting one wire at once end up with one normal drawing, the same in both (findings 3.R4)", () => {
    const rail: WireSegment = { id: "rail", a: { x: 0, y: 0 }, b: { x: 10 * GRID, y: 0 } }
    const base: Schematic = { objects: [], wires: [rail], parts: {} }
    const left = emptyRoom()
    const right = emptyRoom()
    pushTo(left, base)
    Y.applyUpdate(right.ydoc, Y.encodeStateAsUpdate(left.ydoc))
    const branch = (id: string, x: number) => withSegments(base, [{ id, a: { x: x * GRID, y: 0 }, b: { x: x * GRID, y: 4 * GRID } }], [], [], () => `${id}-piece`)
    pushTo(left, branch("a", 3))
    pushTo(right, branch("b", 7))
    Y.applyUpdate(left.ydoc, Y.encodeStateAsUpdate(right.ydoc))
    Y.applyUpdate(right.ydoc, Y.encodeStateAsUpdate(left.ydoc))
    const merged = joinRoom(new Map(left.elements.entries()))
    expect.soft(normalFormViolations(merged.wires, []).length, "the raw merge overlaps itself").toBeGreaterThan(0)
    const fromLeft = inNormalForm(merged)
    const fromRight = inNormalForm(joinRoom(new Map(right.elements.entries())))
    expect.soft(normalFormViolations(fromLeft.wires, []), "normal").toEqual([])
    expect.soft(fromRight.wires, "the same drawing, ids and all, in both tabs").toEqual(fromLeft.wires)
    expect.soft(inNormalForm(fromLeft), "and already normal stays as it is").toBe(fromLeft)
  })

  it("a room keeps a part's firmware, project, debugger settings and part state, and the wires in their order, through the shelf (findings 3.R12, 3.L13)", () => {
    const doc: Schematic = {
      objects: [{ id: "U1", def: "nucleo-f429zi", x: 0, y: 0, props: { ref: "U1", firmware: "app.elf", firmwareData: "AAAA", firmwareBuild: "debug" }, project: { files: [] } as never, debug: { breakpoints: [] } as never }],
      wires: [
        { id: "w", a: { x: 0, y: 0 }, b: { x: GRID, y: 0 }, color: "red" },
        { id: "a", a: { x: 0, y: 2 * GRID }, b: { x: GRID, y: 2 * GRID } },
      ],
      parts: { "U1:USER": { on: true } },
    }
    const room = emptyRoom()
    pushTo(room, doc)
    expect.soft(joinRoom(new Map(room.elements.entries())), "the document as it went").toEqual(doc)
  })
})
