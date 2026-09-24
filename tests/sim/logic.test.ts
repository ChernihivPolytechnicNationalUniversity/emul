/**
 * The "Transistor logic" schematic: every gate and the half adder are walked through all their
 * input combinations, and the LEDs are checked against the truth tables.
 */
import { describe, expect, it } from "vitest"
import { GRID } from "@/schematic/geometry"
import { buildLogic } from "@/schematic/logic"
import { partKey, pinKey, type PlacedObject } from "@/schematic/types"
import { SimLoop, type Snapshot } from "@/sim/loop"

const { doc, parts } = buildLogic(GRID)

const P = {
  sum: { id: "sum", a: pinKey(parts.adder.sumOut.id, "J"), b: null },
  carry: { id: "carry", a: pinKey(parts.adder.carryOut.id, "J"), b: null },
}

const loop = new SimLoop()
loop.setDoc(doc)
loop.setProbes(Object.values(P))
loop.setRunning(true)

let clock = 0
loop.advance(clock)
function run(seconds: number) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
  }
}

const switches = [parts.not.in, parts.nand.a, parts.nand.b, parts.nor.a, parts.nor.b, parts.adder.a, parts.adder.b]
function set(on: Map<PlacedObject, boolean>) {
  loop.setParts(Object.fromEntries(switches.map((sw) => [partKey(sw.id, "SW"), { on: on.get(sw) ?? false }])))
  run(0.05)
  return loop.snapshot()!
}
const lit = (snap: Snapshot, led: PlacedObject) => (snap.parts[partKey(led.id, "LED")]?.on ? 1 : 0)

const rows = [0, 1].flatMap((a) => [0, 1].map((b) => [a, b] as const))

describe("transistor logic", () => {
  // Every combination of the two inputs is fed to all three two-input blocks at once, and the
  // inverter follows the first bit; each block reads its own LED.
  it.each(rows)("NOT / NAND / NOR with a=%i b=%i", (a, b) => {
    const snap = set(
      new Map([
        [parts.not.in, !!a],
        [parts.nand.a, !!a],
        [parts.nand.b, !!b],
        [parts.nor.a, !!a],
        [parts.nor.b, !!b],
      ]),
    )
    expect([lit(snap, parts.not.led), lit(snap, parts.nand.led), lit(snap, parts.nor.led)]).toEqual([1 - a, 1 - (a & b), 1 - (a | b)])
  })

  it.each(rows)("half adder with a=%i b=%i", (a, b) => {
    const snap = set(
      new Map([
        [parts.adder.a, !!a],
        [parts.adder.b, !!b],
      ]),
    )
    expect([lit(snap, parts.adder.sum), lit(snap, parts.adder.carry)]).toEqual([a ^ b, a & b])
  })
})
