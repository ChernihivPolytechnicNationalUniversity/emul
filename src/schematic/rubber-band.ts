import type { FlipAxis, Turn } from "./geometry"
import type { Point, Schematic } from "./types"
import type { NewId, Wiring } from "./wire-edits"
import type { DragConflict, DragFrame } from "./wires/drag"

export type Carried = { readonly objects: ReadonlySet<string>; readonly wires?: ReadonlySet<string> }

export type Unlaid = { readonly at: Point; readonly net: string; readonly pin?: string }

export type Landed = { readonly doc: Schematic; readonly unlaid: readonly Unlaid[]; readonly at: Point; readonly refused?: readonly DragConflict[] }

export type DragOptions = { readonly detach?: boolean }

const unbuilt = (what: string): never => {
  throw new Error(`${what} is not built yet`)
}

export class PartDrag {
  constructor(_doc: Schematic, _wiring: Wiring, _carried: Carried, _options: DragOptions = {}) {}

  frame(_dx: number, _dy: number): DragFrame {
    return unbuilt("PartDrag.frame")
  }

  blocked(_dx: number, _dy: number): boolean {
    return unbuilt("PartDrag.blocked")
  }

  landed(_dx: number, _dy: number, _newId?: NewId): Landed {
    return unbuilt("PartDrag.landed")
  }
}

export class SegmentDrag {
  constructor(_doc: Schematic, _wiring: Wiring, _segment: string) {}

  frame(_dx: number, _dy: number): DragFrame {
    return unbuilt("SegmentDrag.frame")
  }

  landed(_dx: number, _dy: number, _newId?: NewId): Landed {
    return unbuilt("SegmentDrag.landed")
  }
}

export class TurnRun {
  constructor(_doc: Schematic, _wiring: Wiring, _ids: ReadonlySet<string>) {}

  get base(): Schematic {
    return unbuilt("TurnRun.base")
  }

  turned(_turn: Turn, _newId?: NewId): Landed {
    return unbuilt("TurnRun.turned")
  }
}

export function flippedWithWires(_doc: Schematic, _wiring: Wiring, _ids: ReadonlySet<string>, _axis: FlipAxis, _newId?: NewId): Landed {
  return unbuilt("flippedWithWires")
}
