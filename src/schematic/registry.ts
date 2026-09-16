import type { ComponentDef, PartState, PinRef, PlacedObject } from "./types"
import { basicComponents } from "./components/basic"
import { nucleoF429zi } from "./components/nucleo-f429zi"
import { open746ic } from "./components/open746i-c"
import { lcd7f } from "./components/lcd7-f"
import { stm32f429zi, stm32f746ig } from "./components/stm32-chip"
import { eeprom24c } from "./components/eeprom"
import { crystal, oscillator } from "./components/clock"
import { meterComponents } from "./components/meters"

/** Every component the palette can place. Add a definition file and list it here. */
export const registry: ComponentDef[] = [open746ic, nucleoF429zi, stm32f746ig, stm32f429zi, crystal, oscillator, eeprom24c, lcd7f, ...meterComponents, ...basicComponents]

const byId = new Map(registry.map((d) => [d.id, d]))

export function getDef(id: string): ComponentDef | undefined {
  return byId.get(id)
}

export function getPin(def: ComponentDef, pinId: string) {
  return def.pins.find((p) => p.id === pinId)
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
  const p = def.parts.find((x) => x.id === partId)
  return p && "initial" in p && p.initial ? p.initial : {}
}

/** MIME type used when dragging a palette entry onto the field. */
export const PALETTE_DRAG_TYPE = "application/x-emul-component"
