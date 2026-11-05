import { getDef, getMeta } from "@/schematic/registry"
import type { NetMap } from "@/schematic/nets"
import { pinKey, type Damage, type PinDef, type PlacedObject } from "@/schematic/types"
import type { McuStatus } from "@/sim/loop"
import { compareRefs } from "./field-index"

// What is wrong on the field, one flat list, worst first. Two kinds of check:
//   static — read from the bench itself, always on: a chip with no supply or no ground wired, a
//   bare MCU with supply pins left open, a board or chip with nothing to run;
//   runtime — what the running simulation reports: a part burnt out, an MCU stopped or held in
//   reset, the solver unable to settle.
// Every problem says what is wrong in a few words, how we know (the pins), and what to do.

export type Severity = "error" | "warning" | "info"

export const SEVERITY_ORDER: Severity[] = ["error", "warning", "info"]

export type Problem = {
  /** Stable across recomputes: the row keeps its place and its selection. */
  key: string
  severity: Severity
  /** The object it is about; none for the whole bench (the solver). */
  object?: string
  /** The pin it points at, when one does. */
  pin?: string
  title: string
  /** How we know: the pins, the reading, the reason the model gave. */
  detail: string
  /** What to do about it. */
  fix?: string
}

/**
 * Parts whose supply and ground pins are inputs that must be wired. A power pin elsewhere can be an
 * output (a regulator's OUT, a boost converter's SW), a common (a seven-segment's COM, an RGB LED's
 * cathode) or the source itself: those groups and parts stay out.
 */
const SUPPLIED_CATEGORIES = new Set(["mcus", "ics", "displays", "leds", "input", "sound"])
const NOT_SUPPLIED = [/^rgb-led/, /^seven-segment/, /^resonator$/]

const suppliedPart = (defId: string, category: string | undefined) => !!category && SUPPLIED_CATEGORIES.has(category) && !NOT_SUPPLIED.some((r) => r.test(defId))

const label = (p: PinDef) => p.label || p.mcu || p.id
const listPins = (pins: PinDef[]) => {
  const names = [...new Set(pins.map(label))]
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} and ${names.length - 4} more` : names.join(", ")
}

const nameOf = (o: PlacedObject) => o.props?.ref || getMeta(o.def)?.name || o.def

/** Problems the bench shows without running: supply, ground, firmware. */
export function staticProblems(objects: readonly PlacedObject[], nets: Pick<NetMap, "connected">): Problem[] {
  const out: Problem[] = []
  for (const o of objects) {
    const def = getDef(o.def)
    if (!def) continue
    const who = nameOf(o)
    const wired = (p: PinDef) => nets.connected(pinKey(o.id, p.id))
    if (suppliedPart(def.id, def.category) && def.pins.some((p) => p.kind !== "power" && p.kind !== "gnd" && p.kind !== "nc")) {
      const power = def.pins.filter((p) => p.kind === "power")
      const ground = def.pins.filter((p) => p.kind === "gnd")
      const openPower = power.filter((p) => !wired(p))
      const openGround = ground.filter((p) => !wired(p))
      if (power.length && openPower.length === power.length)
        out.push({ key: `${o.id}:no-supply`, severity: "error", object: o.id, pin: power[0].id, title: `${who} has no supply`, detail: `${listPins(power)} not wired.`, fix: `Wire ${label(power[0])} to the supply.` })
      else if (def.category === "mcus" && openPower.length)
        // A bare MCU wants every supply pin: the datasheet ties them all, each one decoupled.
        out.push({ key: `${o.id}:open-supply`, severity: "warning", object: o.id, pin: openPower[0].id, title: `${who}: supply pins left open`, detail: `${listPins(openPower)} not wired.`, fix: "Wire each one to its supply, as the datasheet does." })
      if (ground.length && openGround.length === ground.length)
        out.push({ key: `${o.id}:no-ground`, severity: "error", object: o.id, pin: ground[0].id, title: `${who} has no ground`, detail: `${listPins(ground)} not wired.`, fix: `Wire ${label(ground[0])} to ground.` })
    }
    if (def.chip && !o.props?.firmware)
      out.push({ key: `${o.id}:no-firmware`, severity: "info", object: o.id, title: `${who} has no firmware`, detail: "Nothing runs until code is built or loaded.", fix: "Open its code (⌘J) and Compile, or drop an .elf on it." })
  }
  return out
}

/** What the running simulation reports, as the explorer needs it. */
export type RuntimeReadout = {
  live: boolean
  converged: boolean
  damage: Readonly<Record<string, Damage>>
  mcu: (object: string) => McuStatus | undefined
}

/** Problems only a running simulation shows: burnt parts, stopped or unpowered MCUs, a solver that cannot settle. */
export function runtimeProblems(objects: readonly PlacedObject[], sim: RuntimeReadout): Problem[] {
  const out: Problem[] = []
  for (const o of objects) {
    const who = nameOf(o)
    const damage = sim.damage[o.id]
    if (damage)
      out.push({ key: `${o.id}:burnt`, severity: "error", object: o.id, title: damage.fatal ? `${who} burnt out` : `${who} is damaged`, detail: damage.reason, fix: "Fix what overloaded it, then restart the simulation." })
    if (!sim.live) continue
    const status = sim.mcu(o.id)
    if (!status || !status.firmware) continue
    if (!status.powered)
      out.push({ key: `${o.id}:reset`, severity: "warning", object: o.id, title: `${who} is held in reset`, detail: "Its supply is below the power-on level.", fix: "Check its supply and ground wiring." })
    else if (status.halted)
      out.push({ key: `${o.id}:halted`, severity: "error", object: o.id, title: `${who} stopped`, detail: status.halted, fix: "Open its code (⌘J) and debug from the fault." })
    else if (status.faults.length)
      out.push({ key: `${o.id}:fault`, severity: "error", object: o.id, title: `${who}: ${status.faults[0]}`, detail: status.faults.slice(1).join("; ") || "The core reported a fault.", fix: "Open its code (⌘J) and debug from the fault." })
  }
  if (sim.live && !sim.converged)
    out.push({ key: "solver", severity: "warning", title: "Simulation did not settle", detail: "The solver found no steady answer this step.", fix: "Look for a loop of sources, or a part with nothing to hold it." })
  return out
}

/** One flat list, worst first; within a level, by designator. */
export function sortProblems(problems: Problem[], objects: readonly PlacedObject[]): Problem[] {
  const ref = new Map(objects.map((o) => [o.id, nameOf(o)]))
  return problems.sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) || compareRefs(ref.get(a.object ?? "") ?? "", ref.get(b.object ?? "") ?? "") || a.key.localeCompare(b.key))
}

export const countBySeverity = (problems: readonly Problem[]) => {
  const n: Record<Severity, number> = { error: 0, warning: 0, info: 0 }
  for (const p of problems) n[p.severity]++
  return n
}
