import { ATMEGA328P } from "@/mcu/avr/chip"
import { clockKind } from "@/mcu/avr/mcu"
import type { ComponentDef } from "@/schematic/types"

/** A crystal on a bare chip's XTAL pins whose value the build cannot see: the usual 16 MHz. */
const UNKNOWN_CRYSTAL_HZ = 16e6

/**
 * The F_CPU an AVR program on this board or chip is built for: the clock its low fuse selects
 * (CKSEL, Table 9-1) from the board's resonator or the internal oscillators, divided by 8 while
 * CKDIV8 is programmed (§9.12). The fields hold the fuses; empty, the board's defaults or the
 * factory's apply.
 */
export function avrFcpu(def: ComponentDef, props: Record<string, string> = {}): number {
  const field = { ...def.defaults, ...props }.fuseLow
  const parsed = field ? parseInt(field.trim().replace(/^0x/i, ""), 16) : NaN
  const low = Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xff ? parsed : ATMEGA328P.factoryFuses.low
  const kind = clockKind(low & 0x0f)
  const source = kind === "internal-rc" ? 8e6 : kind === "internal-128k" ? 128e3 : (def.mcuClocks?.hse?.hz ?? UNKNOWN_CRYSTAL_HZ)
  return Math.round((low & 0x80) === 0 ? source / 8 : source)
}
