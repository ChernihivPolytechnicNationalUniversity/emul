/**
 * The part of the job contract the browser shares with the API: what a project is made of.
 * No Node imports here — the site bundles this file to validate a project before sending it.
 */

/** Chips the emulator has a profile for (`src/mcu/chip.ts`, `src/mcu/avr/chip.ts`, `src/mcu/pic/chip.ts`); a job targets one of them. */
export const STM32_TARGETS = ["stm32f429zi", "stm32f746ig", "stm32f407vg", "stm32f405rg"] as const
/** PIC16F62x parts, by their profile ids lower-cased: C builds with SDCC, assembly with gpasm. */
export const PIC_TARGETS = [
  "pic16f627",
  "pic16f627-04",
  "pic16f628",
  "pic16f628-04",
  "pic16lf627",
  "pic16lf628",
  "pic16f627a",
  "pic16f628a",
  "pic16f648a",
  "pic16lf627a",
  "pic16lf628a",
  "pic16lf648a",
] as const
export const TARGETS = [...STM32_TARGETS, "atmega328p", ...PIC_TARGETS] as const
export type PicTarget = (typeof PIC_TARGETS)[number]
export const isPicTarget = (t: string | undefined): t is PicTarget => !!t && (PIC_TARGETS as readonly string[]).includes(t)
export type Target = (typeof TARGETS)[number]
/** The targets an STM32CubeMX/CubeIDE project can be for. */
export type Stm32Target = (typeof STM32_TARGETS)[number]

/** A source file as the client sends it: a relative path inside the project and its text. */
export type SourceFile = { path: string; content: string }

/**
 * GCC optimization levels a build can ask for. -O0 is a Debug build as STM32CubeIDE makes
 * it (every line steps, every variable is there); -O2 what the service built before the
 * choice existed, and still its default.
 */
export const OPT_LEVELS = ["-O0", "-Og", "-O1", "-O2", "-O3", "-Os"] as const
export type OptLevel = (typeof OPT_LEVELS)[number]
export const DEFAULT_OPT: OptLevel = "-O2"
export const isOptLevel = (v: unknown): v is OptLevel => typeof v === "string" && (OPT_LEVELS as readonly string[]).includes(v)

/**
 * How a build job compiles; anything left out is the service's default. `fcpu` is the clock
 * an AVR program is built for (F_CPU, which avr-libc's delays and baud macros count in): the
 * board's, as its crystal and fuses make it.
 */
export type BuildOptions = { opt?: OptLevel; fcpu?: number }
export const FCPU_RANGE = { min: 1_000, max: 32_000_000 } as const

const SOURCE_EXTENSIONS = new Set([".ino", ".pde", ".c", ".h", ".cpp", ".hpp", ".cc", ".s", ".S", ".asm", ".inc", ".ld", ".ioc", ".txt", ".md", ".vhd", ".vhdl", ".v", ".sv"])
export const SOURCE_LIMITS = { files: 200, fileBytes: 1024 * 1024 }

/**
 * A client path made safe for an S3 key and a build directory: relative, no `..`, plain
 * characters, a source extension. Returns null when it is anything else.
 */
export function sourcePath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".")
  if (parts.length === 0 || parts.length > 8) return null
  if (parts.some((p) => p === ".." || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(p))) return null
  const name = parts[parts.length - 1]!
  const ext = name.slice(name.lastIndexOf("."))
  if (!SOURCE_EXTENSIONS.has(ext)) return null
  return parts.join("/")
}
