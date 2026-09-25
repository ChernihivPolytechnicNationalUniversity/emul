import type { ComponentDef, PartDef, PartState, PinDef, PinRef, PlacedObject } from "./types"
import { basicComponents } from "./components/basic"
import { nucleoF429zi } from "./components/nucleo-f429zi"
import { open746ic } from "./components/open746i-c"
import { lcd7f } from "./components/lcd7-f"
import { stm32f429zi, stm32f746ig } from "./components/stm32-chip"
import { eeprom24c } from "./components/eeprom"
import { crystal, oscillator } from "./components/clock"
import { meterComponents } from "./components/meters"
import { chargeBoostModule } from "./components/charge-boost"
import { powerIcs } from "./components/power-ics"

/** Every component the palette can place. Add a definition file and list it here. */
export const registry: ComponentDef[] = [open746ic, nucleoF429zi, stm32f746ig, stm32f429zi, crystal, oscillator, eeprom24c, lcd7f, chargeBoostModule, ...powerIcs, ...meterComponents, ...basicComponents]

const byId = new Map(registry.map((d) => [d.id, d]))

export function getDef(id: string): ComponentDef | undefined {
  return byId.get(id)
}

type Identified = { id: string }

const firstOfEachId = <T extends Identified>(items: readonly T[]): Map<string, T> => {
  const byId = new Map<string, T>()
  for (const item of items) if (!byId.has(item.id)) byId.set(item.id, item)
  return byId
}

const memoisedById = <T extends Identified>(cache: WeakMap<ComponentDef, Map<string, T>>, def: ComponentDef, items: readonly T[]): Map<string, T> => {
  const known = cache.get(def)
  if (known) return known
  const byId = firstOfEachId(items)
  cache.set(def, byId)
  return byId
}

const pinsOfDef = new WeakMap<ComponentDef, Map<string, PinDef>>()
const partsOfDef = new WeakMap<ComponentDef, Map<string, PartDef>>()

export function getPin(def: ComponentDef, pinId: string): PinDef | undefined {
  return memoisedById(pinsOfDef, def, def.pins).get(pinId)
}

function getPart(def: ComponentDef, partId: string): PartDef | undefined {
  return memoisedById(partsOfDef, def, def.parts).get(partId)
}

/** How a pin reads in text: "R1.2", "U1.PA5", or the component name when the pin has no label. */
export function pinName(objects: PlacedObject[], ref: PinRef): string {
  const obj = objects.find((o) => o.id === ref.object)
  const def = obj && getDef(obj.def)
  if (!obj || !def) return "?"
  const owner = obj.props?.ref || def.name
  const pin = getPin(def, ref.pin)
  // A pin drawn without a label still needs telling apart in a readout when the part has
  // several (a transformer's windings); a part with one pin is named by the part alone.
  const label = pin?.label || (def.pins.length > 1 ? ref.pin : "")
  return label ? `${owner}.${label}` : owner
}

/** State a part has before anyone touches it: a USB cable starts plugged in, everything else off. */
export function partInitial(def: ComponentDef, partId: string): PartState {
  const p = getPart(def, partId)
  return p && "initial" in p && p.initial ? p.initial : {}
}

/** MIME type used when dragging a palette entry onto the field. */
export const PALETTE_DRAG_TYPE = "application/x-emul-component"
