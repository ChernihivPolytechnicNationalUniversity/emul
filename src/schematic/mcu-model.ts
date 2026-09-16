import type { ChipProfile } from "@/mcu/chip"
import type { Element, NodeRef } from "./types"

/**
 * Electrical model of an MCU on a component, generated from its chip profile: the supply
 * load, the reset and boot pins with their internal resistors, and one GPIO driver per pad,
 * every one carrying the datasheet's absolute maximum ratings. Both bare chips and boards
 * with an MCU on them build their model from this, so the numbers live in one place.
 *
 * Damage is per component: exceeding any rating burns the whole part and shorts its supply
 * (the `supply` element), which is what a fried die does — a pin driven past its absolute
 * maximum blows its protection diode onto the rail, and the die behind it goes with it. The
 * simulation loop then stops the core.
 */
export function mcuModel(chip: ChipProfile, at: { vdd: NodeRef; gnd: NodeRef; pads: NodeRef[]; nrst?: NodeRef; boot0?: NodeRef }): Element[] {
  const e = chip.electrical
  const pin = { voltage: e.pinVoltageMax, current: e.pinCurrentMax, fail: "short" } as const
  const out: Element[] = [
    // Supply current as a load the loop sets by power mode (run at HSI until firmware says
    // otherwise); over-voltage destroys the part.
    { kind: "R", a: at.vdd, b: at.gnd, value: e.vdd / (e.idd.run[0] + e.idd.run[1] * 16), live: "$idd", supply: true, limits: { voltage: e.vddMax, fail: "short" } },
  ]
  // NRST idles high on the internal pull-up; a button or the supervisor pulls it low.
  if (at.nrst) out.push({ kind: "R", a: at.nrst, b: at.vdd, value: e.nrstPullUp, limits: pin })
  if (at.boot0 && e.boot0PullDown) out.push({ kind: "R", a: at.boot0, b: at.gnd, value: e.boot0PullDown, limits: pin })
  for (const node of at.pads) out.push({ kind: "GPIO", node, vddNode: at.vdd, limits: pin })
  return out
}
