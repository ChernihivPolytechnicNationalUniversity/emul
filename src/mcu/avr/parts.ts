/** AVR parts by profile: the factory that assembles each one. */
import type { AvrProfile } from "./chip"
import type { AvrMcu } from "./mcu"
import { createAtmega328p } from "./atmega328p"

export function createAvr(chip: AvrProfile): AvrMcu {
  switch (chip.id) {
    case "ATMEGA328P":
      return createAtmega328p()
    default:
      throw new Error(`no AVR model for ${chip.id}`)
  }
}
