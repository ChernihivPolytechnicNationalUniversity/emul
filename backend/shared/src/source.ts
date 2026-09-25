/**
 * The part of the job contract the browser shares with the API: what a project is made of.
 * No Node imports here — the site bundles this file to validate a project before sending it.
 */

/** Chips the emulator has a profile for (`src/mcu/chip.ts`); a job targets one of them. */
export const TARGETS = ["stm32f429zi", "stm32f746ig"] as const
export type Target = (typeof TARGETS)[number]

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

/** How a build job compiles; anything left out is the service's default. */
export type BuildOptions = { opt?: OptLevel }

const SOURCE_EXTENSIONS = new Set([".c", ".h", ".cpp", ".hpp", ".cc", ".s", ".S", ".ld", ".txt", ".md"])
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
