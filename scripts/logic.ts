/**
 * Marks the simulator against the "Transistor logic" schematic: every gate and the half
 * adder are walked through all their input combinations headlessly, and the LEDs and
 * output voltages are checked against the truth tables.
 *
 *   pnpm logic
 *
 * Exit code 1 when any row comes out wrong.
 */
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
const failures: string[] = []
loop.onFailure = (f) => failures.push(`${f.ref}: ${f.damage.reason}`)
loop.setRunning(true)

let clock = 0
loop.advance(clock)
/** Advance the loop by `seconds` of simulated time in wall-clock sized ticks. */
function run(seconds: number) {
  const end = clock + seconds * 1000
  while (clock < end) {
    clock = Math.min(end, clock + 30)
    loop.advance(clock)
  }
}

/** Every switch of the bench, so a row can set them all at once. */
const switches = [parts.not.in, parts.nand.a, parts.nand.b, parts.nor.a, parts.nor.b, parts.adder.a, parts.adder.b]
function set(on: Map<PlacedObject, boolean>) {
  loop.setParts(Object.fromEntries(switches.map((sw) => [partKey(sw.id, "SW"), { on: on.get(sw) ?? false }])))
  run(0.05)
  return loop.snapshot()!
}
const lit = (snap: Snapshot, led: PlacedObject) => (snap.parts[partKey(led.id, "LED")]?.on ? 1 : 0)
const bit = (b: number) => (b ? "1" : "0")

let failed = 0
function row(block: string, inputs: number[], got: number[], want: number[], note = "") {
  const ok = got.every((g, i) => g === want[i])
  if (!ok) failed++
  console.log(`  ${ok ? "✓" : "✗"} ${inputs.map(bit).join(" ")}  →  ${got.map(bit).join(" ")}   expected ${want.map(bit).join(" ")}${note}`)
}

// Every combination of the two inputs is fed to all three two-input blocks at once, and the
// inverter follows the first bit; each block reads its own LED.
console.log("NOT / NAND / NOR   (a b → NOT a, a NAND b, a NOR b)")
for (const a of [0, 1])
  for (const b of [0, 1]) {
    const snap = set(
      new Map([
        [parts.not.in, !!a],
        [parts.nand.a, !!a],
        [parts.nand.b, !!b],
        [parts.nor.a, !!a],
        [parts.nor.b, !!b],
      ]),
    )
    row("gates", [a, b], [lit(snap, parts.not.led), lit(snap, parts.nand.led), lit(snap, parts.nor.led)], [1 - a, 1 - (a & b), 1 - (a | b)])
  }

console.log("\nHalf adder   (a b → sum carry)")
for (const a of [0, 1])
  for (const b of [0, 1]) {
    const snap = set(
      new Map([
        [parts.adder.a, !!a],
        [parts.adder.b, !!b],
      ]),
    )
    const vs = snap.probes[P.sum.id].v
    const vc = snap.probes[P.carry.id].v
    row("adder", [a, b], [lit(snap, parts.adder.sum), lit(snap, parts.adder.carry)], [a ^ b, a & b], `   sum ${vs.toFixed(2)} V, carry ${vc.toFixed(2)} V`)
  }

const snap = loop.snapshot()!
console.log(`\n${failed ? `${failed} rows wrong` : "all rows correct"}; solver converged: ${snap.converged}; sim time ${snap.time.toFixed(2)} s`)
if (failures.length) console.log(`failures reported: ${failures.join("; ")}`)
process.exit(failed ? 1 : 0)
