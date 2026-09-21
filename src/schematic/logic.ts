import { BinaryIcon } from "lucide-react"
import { builder } from "./builder"
import type { Example } from "./examples"
import type { PlacedObject, Schematic } from "./types"

/**
 * Digital logic out of discrete transistors: CMOS gates built from the N- and P-channel
 * MOSFETs, driven by toggle switches and read out on LEDs. A NOT, a NAND and a NOR on their
 * own, and a half adder that puts four of them together: Sum = (A NOR B) NOR (A AND B),
 * Carry = A AND B. `scripts/logic.ts` walks every input combination headlessly and checks
 * the truth tables; the same document opens from File › Examples.
 *
 * Every gate is a cell with junctions for its inputs (`a`, `b`) and output (`out`), so the
 * blocks wire to each other pin to pin. A 5 V rail is enough to turn both types fully on:
 * the N-channel needs 2 V on the gate, the P-channel 3.7 V below its source.
 */
export type LogicBench = {
  doc: Schematic
  parts: {
    not: { in: PlacedObject; led: PlacedObject }
    nand: { a: PlacedObject; b: PlacedObject; led: PlacedObject }
    nor: { a: PlacedObject; b: PlacedObject; led: PlacedObject }
    adder: { a: PlacedObject; b: PlacedObject; sum: PlacedObject; carry: PlacedObject; sumOut: PlacedObject; carryOut: PlacedObject }
  }
}

const V5 = { value: "+5V", voltage: "5 V" }
const PULL_DOWN = { value: "10 kΩ", power: "0.25" }
const LED_R = { value: "330 Ω", power: "0.25" }

type Gate = { a: PlacedObject; b?: PlacedObject; out: PlacedObject }

export function buildLogic(grid: number): LogicBench {
  const { doc, place, wire } = builder(grid)
  const rail = (x: number, y: number) => place("supply", x, y, V5)
  const gnd = (x: number, y: number) => place("ground", x, y)
  /** Vertical two-pin part: pin 1 on top at (x+1, y), pin 2 below at (x+1, y+4). */
  const vert = (def: string, x: number, y: number, props: Record<string, string>) => place(def, x, y, props, 90)
  /** A junction whose pin sits at (x, y). */
  const node = (x: number, y: number) => place("junction", x - 1, y - 1)

  /**
   * Inverter cell: P-channel over N-channel, gates tied. Input junction at (ox−2, oy+6),
   * output at (ox+6, oy+9). The ground symbol butts against the N-channel source.
   */
  const inverter = (ox: number, oy: number): Gate => {
    const v = rail(ox + 2, oy)
    const p = place("pmos", ox, oy + 4)
    const n = place("nmos", ox, oy + 10)
    gnd(ox + 2, oy + 14)
    const a = node(ox - 2, oy + 6)
    const out = node(ox + 6, oy + 9)
    wire(v, "V", p, "S")
    wire(p, "D", n, "D")
    wire(p, "D", out, "J", [[ox + 3, oy + 9]])
    wire(a, "J", p, "G")
    wire(a, "J", n, "G", [[ox - 2, oy + 12]])
    return { a, out }
  }

  /**
   * NAND cell: two P-channels in parallel from the rail, two N-channels in series to ground.
   * Inputs at (ox−2, oy+6) and (ox−4, oy+1), output at (ox+12, oy+9). Each P-channel has its
   * own rail symbol so input B can slip between them to the second gate.
   */
  const nand = (ox: number, oy: number): Gate => {
    const v1 = rail(ox + 2, oy)
    const v2 = rail(ox + 8, oy)
    const p1 = place("pmos", ox, oy + 4)
    const p2 = place("pmos", ox + 6, oy + 4)
    const n1 = place("nmos", ox, oy + 10)
    const n2 = place("nmos", ox, oy + 16)
    gnd(ox + 2, oy + 20)
    const a = node(ox - 2, oy + 6)
    const b = node(ox - 4, oy + 1)
    const out = node(ox + 12, oy + 9)
    wire(v1, "V", p1, "S")
    wire(v2, "V", p2, "S")
    wire(p1, "D", n1, "D")
    wire(n1, "S", n2, "D")
    wire(p2, "D", p1, "D", [[ox + 9, oy + 9], [ox + 3, oy + 9]])
    wire(p2, "D", out, "J", [[ox + 9, oy + 9]])
    wire(a, "J", p1, "G")
    wire(a, "J", n1, "G", [[ox - 2, oy + 12]])
    wire(b, "J", p2, "G", [[ox - 4, oy - 1], [ox + 5, oy - 1], [ox + 5, oy + 6]])
    wire(b, "J", n2, "G", [[ox - 4, oy + 18]])
    return { a, b, out }
  }

  /**
   * NOR cell: two P-channels in series from the rail, two N-channels in parallel to ground.
   * Inputs at (ox−2, oy+6) and (ox−4, oy+12), output at (ox+12, oy+15). Input B reaches the
   * second N-channel underneath the two ground symbols.
   */
  const nor = (ox: number, oy: number): Gate => {
    const v = rail(ox + 2, oy)
    const p1 = place("pmos", ox, oy + 4)
    const p2 = place("pmos", ox, oy + 10)
    const n1 = place("nmos", ox, oy + 16)
    const n2 = place("nmos", ox + 6, oy + 16)
    gnd(ox + 2, oy + 20)
    gnd(ox + 8, oy + 20)
    const a = node(ox - 2, oy + 6)
    const b = node(ox - 4, oy + 12)
    const out = node(ox + 12, oy + 15)
    wire(v, "V", p1, "S")
    wire(p1, "D", p2, "S")
    wire(p2, "D", n1, "D")
    wire(n2, "D", p2, "D", [[ox + 9, oy + 15], [ox + 3, oy + 15]])
    wire(n2, "D", out, "J", [[ox + 9, oy + 15]])
    wire(a, "J", p1, "G")
    wire(a, "J", n1, "G", [[ox - 2, oy + 18]])
    wire(b, "J", p2, "G")
    wire(b, "J", n2, "G", [[ox - 4, oy + 23], [ox + 5, oy + 23], [ox + 5, oy + 18]])
    return { a, b, out }
  }

  /**
   * Logic input: a switch from the rail into a 10 kΩ pull-down, so the node reads 5 V with
   * the switch on and 0 V with it off. The junction (the signal) sits at (x+1, y+6).
   */
  const input = (x: number, y: number, label: string) => {
    rail(x, y)
    const sw = vert("switch", x, y + 2, { value: label })
    const j = node(x + 1, y + 6)
    const r = vert("resistor", x, y + 7, PULL_DOWN)
    gnd(x, y + 11)
    wire(j, "J", r, "1")
    return { sw, j }
  }

  /** Logic output: an LED and 330 Ω to ground, fed from `from` with the anode at (x+1, y). */
  const indicator = (from: PlacedObject, fromY: number, x: number, y: number, label: string) => {
    const led = vert("led", x, y, { value: "red", imax: "20 mA", ref: label })
    vert("resistor", x, y + 4, LED_R)
    gnd(x, y + 8)
    wire(from, "J", led, "1", [[x + 1, fromY]])
    return led
  }

  // --- NOT: one switch straight into the inverter.
  const not = (() => {
    const ox = 6
    const g = inverter(ox, 0)
    const sw = input(ox - 6, 0, "IN")
    wire(sw.j, "J", g.a, "J")
    const led = indicator(g.out, 9, ox + 8, 10, "NOT")
    return { in: sw.sw, led }
  })()

  // --- NAND on its own: A goes up and over into the upper input, B comes up from below.
  const nandDemo = (() => {
    const ox = 34
    const g = nand(ox, 0)
    const a = input(ox - 14, 0, "A")
    const b = input(ox - 9, 16, "B")
    wire(a.j, "J", g.b!, "J", [[ox - 11, 6], [ox - 11, 1]])
    wire(b.j, "J", g.a, "J", [[ox - 6, 22], [ox - 6, 6]])
    const led = indicator(g.out, 9, ox + 14, 10, "NAND")
    return { a: a.sw, b: b.sw, led }
  })()

  // --- NOR on its own: B drops from above into the upper input, A runs straight into the lower.
  const norDemo = (() => {
    const ox = 74
    const g = nor(ox, 0)
    const b = input(ox - 9, -8, "B")
    const a = input(ox - 14, 6, "A")
    wire(b.j, "J", g.a, "J", [[ox - 6, -2], [ox - 6, 6]])
    wire(a.j, "J", g.b!, "J")
    const led = indicator(g.out, 15, ox + 14, 16, "NOR")
    return { a: a.sw, b: b.sw, led }
  })()

  // --- Half adder: NAND1 and NOR1 both see A and B. Carry = NOT NAND1 = A AND B, and
  //     Sum = NOR1 NOR Carry, which is high only when exactly one input is.
  const adder = (() => {
    const oy = 36
    const nand1 = nand(16, oy)
    const nor1 = nor(16, oy + 26)
    const inv = inverter(40, oy)
    const nor2 = nor(62, oy + 13)
    const a = input(0, oy, "A")
    const b = input(5, oy + 16, "B")
    // A: up into NAND1's upper input, and down the left edge into NOR1's lower one.
    wire(a.j, "J", nand1.b!, "J", [[3, oy + 6], [3, oy + 1]])
    wire(a.j, "J", nor1.b!, "J", [[3, oy + 6], [3, oy + 38]])
    // B: up into NAND1's lower input, down into NOR1's upper one.
    wire(b.j, "J", nand1.a, "J", [[9, oy + 22], [9, oy + 6]])
    wire(b.j, "J", nor1.a, "J", [[9, oy + 22], [9, oy + 32]])
    // NAND1 → inverter → Carry, and on into NOR2.
    wire(nand1.out, "J", inv.a, "J", [[32, oy + 9], [32, oy + 6]])
    const carry = indicator(inv.out, oy + 9, 48, oy + 10, "CARRY")
    wire(inv.out, "J", nor2.a, "J", [[52, oy + 9], [52, oy + 19]])
    // NOR1 → NOR2 → Sum.
    wire(nor1.out, "J", nor2.b!, "J", [[52, oy + 41], [52, oy + 25]])
    const sum = indicator(nor2.out, oy + 28, 76, oy + 29, "SUM")
    return { a: a.sw, b: b.sw, sum, carry, sumOut: nor2.out, carryOut: inv.out }
  })()

  return { doc, parts: { not, nand: nandDemo, nor: norDemo, adder } }
}

export const transistorLogic: Example = {
  id: "logic",
  name: "Transistor logic",
  description: "CMOS NOT, NAND and NOR gates from discrete MOSFETs, and a half adder built out of them. Flip the switches, watch the LEDs.",
  icon: BinaryIcon,
  build: (grid) => buildLogic(grid).doc,
}
