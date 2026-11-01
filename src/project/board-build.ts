import { TARGETS, type BuildOptions, type OptLevel, type Target } from "emul-shared/source"
import { avrFcpu } from "@/project/avr-clock"
import type { ComponentDef, PlacedObject } from "@/schematic/types"

/** What a board compiles at until its project says otherwise: a Debug build, as CubeIDE starts one. */
export const DEFAULT_BUILD_OPT: OptLevel = "-O0"
export const AVR_BUILD_OPT: OptLevel = "-Os"

/** The build target of a board or chip: its chip's id (an AVR's, upper-case in its profile, too). */
export const buildTarget = (def: ComponentDef | undefined): Target | undefined => TARGETS.find((t) => t === def?.chip?.toLowerCase())

/** The level a board's project compiles at: an AVR builds at -Os as the Arduino IDE does, since avr-libc's delays are only right when optimized. */
export const buildOpt = (board: PlacedObject | null | undefined, target: Target | undefined): OptLevel =>
  board?.build?.opt ?? (target === "atmega328p" ? AVR_BUILD_OPT : DEFAULT_BUILD_OPT)

/**
 * The options the Compile button sends for a board. The examples' prebuilt images are made
 * with the same (scripts/example-firmware.ts), so one stands for what Compile would give.
 */
export function buildOptions(board: PlacedObject, def: ComponentDef, target: Target): BuildOptions {
  const opt = buildOpt(board, target)
  return target === "atmega328p" ? { opt, fcpu: avrFcpu(def, board.props) } : { opt }
}
