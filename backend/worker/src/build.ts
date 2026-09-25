import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { DEFAULT_OPT, type BuildOptions, type SourceFile, type Target } from "emul-shared/source"

/**
 * Compile a project for its chip with GCC, the way STM32CubeIDE would: the program's own
 * sources, ST's HAL and CMSIS, a startup file and a linker script for the chip.
 *
 * The image lays the pieces out as (see the Dockerfile and toolchain/):
 *   targets/<target>/   target.json, the linker script, startup, system_*.c, *_it.c,
 *                       *_hal_msp.c, *_hal_conf.h — the "batteries" a CubeMX project has
 *   targets/common/     batteries every chip shares (syscalls.c)
 *   $ST_ROOT            HAL + CMSIS sources and headers per family
 *   $HAL_ROOT/<target>  libhal.a, the HAL compiled once with our hal_conf.h
 *
 * A project file with the same name as a battery replaces it, so a CubeMX project drops in
 * as is; a project with its own hal_conf.h gets the HAL compiled from source against it.
 */

const TARGETS_DIR = process.env.TARGETS_DIR ?? new URL("../targets/", import.meta.url).pathname
const ST_ROOT = process.env.ST_ROOT ?? "/opt/st"
const HAL_ROOT = process.env.HAL_ROOT ?? "/opt/hal"
const GCC = process.env.ARM_GCC ?? "arm-none-eabi-"
/** A build over this is not a build anyone waits for. */
const TIMEOUT_MS = 120_000
const MAX_LOG = 4 * 1024 * 1024

type TargetSpec = { name: string; family: string; cpu: string[]; defines: string[]; linker: string }

export type BuildOutput = {
  ok: boolean
  log: string
  elf?: Buffer
  map?: Buffer
  /** Why it is not ok, in a line: the compiler's exit, a timeout, a missing target. */
  error?: string
}

const run = promisify(execFile)
const C = /\.(c)$/i
const CXX = /\.(cpp|cc)$/i
const ASM = /\.s$/i
const HEADER = /\.(h|hpp)$/i
const LINKER = /\.ld$/i
const HAL_CONF = /^stm32f\dxx_hal_conf\.h$/

export async function build(target: Target, files: SourceFile[], options: BuildOptions = {}): Promise<BuildOutput> {
  const targetDir = path.join(TARGETS_DIR, target)
  let spec: TargetSpec
  try {
    spec = JSON.parse(await readFile(path.join(targetDir, "target.json"), "utf8")) as TargetSpec
  } catch {
    return { ok: false, log: "", error: `no such target: ${target}` }
  }
  const family = path.join(ST_ROOT, spec.family)

  const dir = await mkdtemp(path.join(tmpdir(), "emul-build-"))
  const src = path.join(dir, "src")
  try {
    for (const f of files) {
      const p = path.join(src, f.path)
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, f.content)
    }

    const own = new Set(files.map((f) => path.basename(f.path)))
    const sources = files.filter((f) => C.test(f.path) || CXX.test(f.path) || ASM.test(f.path)).map((f) => f.path)
    const includes = [...new Set(files.filter((f) => HEADER.test(f.path)).map((f) => path.dirname(f.path)))]
    const linker = files.find((f) => LINKER.test(f.path))?.path ?? path.join(targetDir, spec.linker)
    const ownConf = files.some((f) => HAL_CONF.test(path.basename(f.path)))

    // The batteries the project did not bring.
    const batteries: string[] = []
    for (const dir of [targetDir, path.join(TARGETS_DIR, "common")]) {
      for (const name of await readdir(dir)) {
        if ((C.test(name) || ASM.test(name)) && !own.has(name)) batteries.push(path.join(dir, name))
      }
    }
    // The HAL: prebuilt against our hal_conf.h, or from source against the project's.
    const halSources: string[] = []
    if (ownConf) {
      for (const name of await readdir(path.join(family, "hal", "Src"))) {
        if (C.test(name) && !name.includes("template")) halSources.push(path.join(family, "hal", "Src", name))
      }
    }

    const cxxSources = sources.filter((s) => CXX.test(s))
    const cSources = sources.filter((s) => !CXX.test(s))
    // -g3 at every level: the debugger reads the line table, the variables and the macros from it.
    const common = [
      ...spec.cpu,
      ...spec.defines,
      options.opt ?? DEFAULT_OPT,
      "-g3",
      "-Wall",
      "-ffunction-sections",
      "-fdata-sections",
      "-fdiagnostics-color=never",
      "-fmax-errors=50",
      ...[...includes, targetDir, path.join(family, "hal", "Inc"), path.join(family, "cmsis", "Include"), path.join(ST_ROOT, "core", "Include")].map((i) => `-I${i}`),
    ]
    const driver = `${GCC}gcc`
    const lines = [
      `# ${spec.name}, ${options.opt ?? DEFAULT_OPT}`,
      `# ${path.basename(driver)} ${sources.join(" ")} + ${batteries.map((b) => path.basename(b)).join(" ")}${ownConf ? " + HAL from source" : " -lhal"}`,
      "",
    ]

    // A clean environment and a working directory of its own: the compiler sees the sources
    // and the toolchain, nothing of this process.
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C" }

    // C++ files are compiled on their own so the C++-only switches reach no C file; a program of
    // ours never unwinds or asks for a type at run time, so the C++ runtime it needs is what the
    // C one already has.
    const cxxObjects: string[] = []
    for (const source of cxxSources) {
      const object = path.join("obj", `${source.replace(/[\\/]/g, "__")}.o`)
      await mkdir(path.join(src, "obj"), { recursive: true })
      const compile = await exec(driver, [...common, "-x", "c++", "-fno-exceptions", "-fno-rtti", "-fno-threadsafe-statics", "-c", source, "-o", object], src, env)
      lines.push(compile.output)
      if (compile.error) return { ok: false, log: lines.join("\n"), error: compile.error }
      cxxObjects.push(object)
    }

    const args = [
      ...common,
      ...withLanguages([...cSources, ...batteries, ...halSources]),
      ...(cxxObjects.length ? ["-x", "none", ...cxxObjects] : []),
      "-o",
      "firmware.elf",
      `-T${linker}`,
      "-specs=nano.specs",
      "-Wl,--gc-sections",
      "-Wl,-Map=firmware.map",
      ...(ownConf ? [] : [`-L${path.join(HAL_ROOT, target)}`, "-lhal"]),
      ...(cxxObjects.length ? ["-lstdc++"] : []),
      "-lm",
    ]
    const compile = await exec(driver, args, src, env)
    lines.push(compile.output)
    if (compile.error) return { ok: false, log: lines.join("\n"), error: compile.error }

    const size = await exec(`${GCC}size`, ["firmware.elf"], src, env)
    lines.push(size.output)
    return {
      ok: true,
      log: lines.join("\n"),
      elf: await readFile(path.join(src, "firmware.elf")),
      map: await readFile(path.join(src, "firmware.map")),
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** `-x` switches so the driver compiles each file as what it is, whichever driver links. */
function withLanguages(sources: string[]): string[] {
  const out: string[] = []
  let lang = ""
  for (const s of sources) {
    const next = CXX.test(s) ? "c++" : ASM.test(s) ? "assembler-with-cpp" : "c"
    if (next !== lang) out.push("-x", (lang = next))
    out.push(s)
  }
  return out
}

async function exec(file: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ output: string; error?: string }> {
  try {
    const { stdout, stderr } = await run(file, args, { cwd, env, timeout: TIMEOUT_MS, maxBuffer: MAX_LOG, killSignal: "SIGKILL" })
    return { output: stderr + stdout }
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string; killed?: boolean; signal?: string }
    const output = (err.stderr ?? "") + (err.stdout ?? "")
    if (err.code === "ENOENT") return { output, error: `${path.basename(file)} is not installed` }
    if (err.killed || err.signal) return { output, error: `${path.basename(file)} took longer than ${TIMEOUT_MS / 1000} s and was stopped` }
    return { output, error: `${path.basename(file)} exited with ${String(err.code)}` }
  }
}
