import { examples, lab1Stand } from "@/schematic/examples"
import { GRID } from "@/schematic/geometry"
import { partKey, type PartState, type PlacedObject, type Schematic, type Wire } from "@/schematic/types"

export const TILE_PITCH = { x: 100 * GRID, y: 80 * GRID }

export const TILINGS = [1, 4, 16, 40, 67, 167]

export const BOARD_PITCH = { x: 90 * GRID, y: 70 * GRID }
export const BOARD_TILINGS = [1, 4, 25, 100, 400, 1700]

export function tiled(base: Schematic, tiles: number, pitch = TILE_PITCH): Schematic {
  const objects: PlacedObject[] = []
  const wires: Wire[] = []
  const parts: Record<string, PartState> = {}
  const columns = Math.ceil(Math.sqrt(tiles))
  for (let tile = 0; tile < tiles; tile++) {
    const dx = (tile % columns) * pitch.x
    const dy = Math.floor(tile / columns) * pitch.y
    const renamed = new Map(base.objects.map((object) => [object.id, `${object.id}-${tile}`]))
    for (const object of base.objects) objects.push({ ...object, id: renamed.get(object.id)!, x: object.x + dx, y: object.y + dy })
    for (const wire of base.wires)
      wires.push({
        ...wire,
        id: `${wire.id}-${tile}`,
        from: { ...wire.from, object: renamed.get(wire.from.object)! },
        to: { ...wire.to, object: renamed.get(wire.to.object)! },
        points: wire.points?.map((point) => ({ x: point.x + dx, y: point.y + dy })),
      })
    for (const [key, state] of Object.entries(base.parts)) {
      const [object, part] = key.split(":")
      const renamedObject = renamed.get(object)
      if (renamedObject) parts[partKey(renamedObject, part)] = state
    }
  }
  return { objects, wires, parts }
}

export const stressDocuments = (tilings: readonly number[] = TILINGS) => {
  const base = lab1Stand.build(GRID)
  return tilings.map((tiles) => tiled(base, tiles))
}

export const boardDocuments = (tilings: readonly number[] = BOARD_TILINGS) => {
  const base = examples.find((example) => example.id === "lab1-open746i-c")!.build(GRID)
  return tilings.map((tiles) => tiled(base, tiles, BOARD_PITCH))
}
