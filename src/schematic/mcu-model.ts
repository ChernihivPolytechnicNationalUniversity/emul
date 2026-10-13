import { chipById, type ChipProfile, type PadClasses } from "@/mcu/chip"
import { parsePad } from "@/mcu/pads"
import type { ComponentDef, Element, ModelElement, NodeRef } from "./types"

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
  if (at.boot0 && e.boot0PullDown) out.push({ kind: "R", a: at.boot0, b: at.gnd, value: e.boot0PullDown, limits: { ...pin, voltage: e.bootVoltageMax ?? pin.voltage } })
  const drive = e.outputOhms ? { ohms: e.outputOhms } : undefined
  for (const node of at.pads) out.push({ kind: "GPIO", node, vddNode: at.vdd, drive, capacitance: e.pinCapacitance, limits: pin })
  return out
}

const BACKUP_DOMAIN_SUPPLY = "$backup-domain"
const BACKUP_DOMAIN_SWITCH = "$backup-domain-switch"

type Pad = Extract<ModelElement, { kind: "GPIO" }>

function classify(el: Pad, pad: string, classes: PadClasses): Pad {
  const fail = el.limits?.fail ?? "short"
  if (classes.tta.pads.includes(pad))
    return { ...el, clamp: { injection: classes.injectedCurrentMax, rail: el.vddNode }, limits: { current: el.limits?.current, voltage: classes.tta.voltageMax, fail } }
  const backup = classes.backupDomain.pads.includes(pad)
  return {
    ...el,
    vddNode: backup ? BACKUP_DOMAIN_SUPPLY : el.vddNode,
    pull: classes.otgId.pads.includes(pad) ? classes.otgId.pullOhms : undefined,
    clamp: { injection: classes.injectedCurrentMax },
    limits: { current: backup ? classes.backupDomain.currentMax : el.limits?.current, aboveSupply: classes.ft.aboveVdd, fail },
  }
}

export function withPadClasses(def: ComponentDef): ComponentDef {
  const classes = def.chip ? chipById(def.chip)?.electrical.pads : undefined
  if (!classes || !def.model) return def
  const padOf = (node: NodeRef) => (node.startsWith("$") ? node.slice(1) : def.pins.find((p) => p.id === node)?.mcu)
  let backupFeed: NodeRef | undefined
  const model = def.model.map((el): ModelElement => {
    if (el.kind !== "GPIO") return el
    const pad = padOf(el.node)
    if (!pad || !parsePad(pad)) return el
    if (classes.backupDomain.pads.includes(pad)) backupFeed ??= el.vddNode
    return classify(el, pad, classes)
  })
  if (backupFeed)
    model.push(
      { kind: "V", plus: backupFeed, minus: BACKUP_DOMAIN_SWITCH, value: classes.backupDomain.switchDrop },
      { kind: "R", a: BACKUP_DOMAIN_SWITCH, b: BACKUP_DOMAIN_SUPPLY, value: classes.backupDomain.switchOhms, label: "Backup-domain power switch", limits: { current: classes.backupDomain.currentMax, fail: "short" } },
    )
  return { ...def, model }
}
