import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { DEFAULT_OPT, type BuildOptions, type SourceFile, type Target } from "emul-shared/source"
import { ARDUINO_DEFINES, coreFor, INO, librariesFor, sketchToCpp } from "./arduino.ts"

/**
 * Compile a project for its chip with GCC, the way STM32CubeIDE would: the program's own
 * sources, ST's HAL and CMSIS, a startup file and a linker script for the chip. An AVR target
 * (`"toolchain": "avr"` in its target.json) is avr-gcc with avr-libc instead, which brings its
 * own startup, vectors and linker script for the `-mmcu` it is given: the project's sources are
 * all there is.
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
const AVR_GCC = process.env.AVR_GCC ?? "avr-"
/** F_CPU when the job names none: an Arduino board's 16 MHz. */
const DEFAULT_FCPU = 16_000_000
/** A build over this is not a build anyone waits for. */
const TIMEOUT_MS = 120_000
const MAX_LOG = 4 * 1024 * 1024

type ArmSpec = { name: string; toolchain?: "arm"; family: string; cpu: string[]; defines: string[]; linker: string }
type AvrSpec = { name: string; toolchain: "avr"; mcu: string }
/** A PIC16: `processor` as SDCC's -p and gpasm take it ("16f628a"); an LF part builds as its F part (gputils knows no LF processors, the silicon is the same). */
type PicSpec = { name: string; toolchain: "pic"; processor: string }
type TargetSpec = ArmSpec | AvrSpec | PicSpec

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
const FLASH_LINKER = /_FLASH\.ld$/i
const STARTUP = /^startup_.*\.s$/i
const HAL_CONF = /^stm32f\dxx_hal_conf\.h$/

export async function build(target: Target, files: SourceFile[], options: BuildOptions = {}): Promise<BuildOutput> {
  const targetDir = path.join(TARGETS_DIR, target)
  let spec: TargetSpec
  try {
    spec = JSON.parse(await readFile(path.join(targetDir, "target.json"), "utf8")) as TargetSpec
  } catch {
    return { ok: false, log: "", error: `no such target: ${target}` }
  }
  if (spec.toolchain === "avr") return buildAvr(spec, files, options)
  if (spec.toolchain === "pic") return buildPic(spec, files)
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
    const linkers = files.filter((f) => LINKER.test(f.path))
    const linker = (linkers.find((f) => FLASH_LINKER.test(f.path)) ?? linkers[0])?.path ?? path.join(targetDir, spec.linker)
    const ownStartup = files.some((f) => STARTUP.test(path.basename(f.path)))
    const ownConf = files.some((f) => HAL_CONF.test(path.basename(f.path)))

    // The batteries the project did not bring.
    const batteries: string[] = []
    for (const dir of [targetDir, path.join(TARGETS_DIR, "common")]) {
      for (const name of await readdir(dir)) {
        if (!(C.test(name) || ASM.test(name)) || own.has(name)) continue
        if (ownStartup && STARTUP.test(name)) continue
        batteries.push(path.join(dir, name))
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
    const batteryNames = batteries.map((b) => path.basename(b)).join(" ")
    const lines = [
      `# ${spec.name}, ${options.opt ?? DEFAULT_OPT}`,
      `# ${path.basename(driver)} ${sources.join(" ")}${batteryNames ? ` + ${batteryNames}` : ""}${ownConf ? " + HAL from source" : " -lhal"}`,
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

async function buildAvr(spec: AvrSpec, files: SourceFile[], options: BuildOptions): Promise<BuildOutput> {
  const dir = await mkdtemp(path.join(tmpdir(), "emul-build-"))
  const src = path.join(dir, "src")
  try {
    for (const f of files) {
      const p = path.join(src, f.path)
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, f.content)
    }
    if (files.some((f) => INO.test(f.path))) return await buildSketch(spec, files, options, src)
    const sources = files.filter((f) => C.test(f.path) || CXX.test(f.path) || ASM.test(f.path)).map((f) => f.path)
    if (!sources.length) return { ok: false, log: "", error: "no source files to compile" }
    const includes = [...new Set(files.filter((f) => HEADER.test(f.path)).map((f) => path.dirname(f.path)))]
    const fcpu = options.fcpu ?? DEFAULT_FCPU
    const opt = options.opt ?? DEFAULT_OPT
    const common = [
      `-mmcu=${spec.mcu}`,
      `-DF_CPU=${fcpu}UL`,
      opt,
      // Debian's avr-gcc 5.4 writes stabs for a bare -g: DWARF has to be asked for.
      "-gdwarf-4",
      "-g3",
      "-Wall",
      "-ffunction-sections",
      "-fdata-sections",
      "-fdiagnostics-color=never",
      "-fmax-errors=50",
      ...includes.map((i) => `-I${i}`),
    ]
    const driver = `${AVR_GCC}gcc`
    const lines = [`# ${spec.name}, ${opt}, F_CPU ${fcpu} Hz`, `# ${path.basename(driver)} ${sources.join(" ")} (avr-libc)`, ""]
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C" }

    // C++ on its own, as for ARM; avr-gcc has no libstdc++, and a program that throws or asks
    // for a type at run time has nothing to link against anyway.
    const cxxObjects: string[] = []
    for (const source of sources.filter((s) => CXX.test(s))) {
      const object = path.join("obj", `${source.replace(/[\\/]/g, "__")}.o`)
      await mkdir(path.join(src, "obj"), { recursive: true })
      const compile = await exec(driver, [...common, "-x", "c++", "-fno-exceptions", "-fno-rtti", "-fno-threadsafe-statics", "-c", source, "-o", object], src, env)
      lines.push(compile.output)
      if (compile.error) return { ok: false, log: lines.join("\n"), error: compile.error }
      cxxObjects.push(object)
    }
    const args = [
      ...common,
      ...withLanguages(sources.filter((s) => !CXX.test(s))),
      ...(cxxObjects.length ? ["-x", "none", ...cxxObjects] : []),
      "-o",
      "firmware.elf",
      "-Wl,--gc-sections",
      "-Wl,-Map=firmware.map",
      "-lm",
    ]
    const compile = await exec(driver, args, src, env)
    lines.push(compile.output)
    if (compile.error) return { ok: false, log: lines.join("\n"), error: compile.error }
    const size = await exec(`${AVR_GCC}size`, ["firmware.elf"], src, env)
    lines.push(size.output)
    return { ok: true, log: lines.join("\n"), elf: await readFile(path.join(src, "firmware.elf")), map: await readFile(path.join(src, "firmware.map")) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const PIC_ASM = /\.asm$/i

/**
 * A PIC16F62x project. With an `.asm` file it is assembly, as MPASM projects are: gpasm in absolute
 * mode on the file holding the reset vector (`main.asm`, else the only one), the others pulled in
 * with #include. Otherwise C with SDCC 4.4 for pic14 (its device headers and libraries are the
 * "non-free" ones derived from Microchip's, `--use-non-free`): each .c compiled to an object, the
 * objects linked by gplink through SDCC. The image is Intel HEX with the configuration word at
 * 2007h; it goes back in the `elf` field, the loader telling the two apart by their first byte.
 * SDCC has no -O levels of the GCC kind: the job's level is not used.
 */
async function buildPic(spec: PicSpec, files: SourceFile[]): Promise<BuildOutput> {
  const SDCC = process.env.SDCC ?? "sdcc"
  const GPASM = process.env.GPASM ?? "gpasm"
  const dir = await mkdtemp(path.join(tmpdir(), "emul-build-"))
  const src = path.join(dir, "src")
  try {
    for (const f of files) {
      const p = path.join(src, f.path)
      await mkdir(path.dirname(p), { recursive: true })
      await writeFile(p, f.content)
    }
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: dir, LANG: "C" }
    const includes = [...new Set(files.filter((f) => HEADER.test(f.path) || /\.inc$/i.test(f.path)).map((f) => path.dirname(f.path)))]
    const asm = files.filter((f) => PIC_ASM.test(f.path)).map((f) => f.path)
    if (asm.length) {
      const main = asm.find((a) => /^main\.asm$/i.test(path.basename(a))) ?? (asm.length === 1 ? asm[0] : undefined)
      if (!main) return { ok: false, log: "", error: "several .asm files and none is main.asm: name the one with the reset vector main.asm" }
      const processor = `p${spec.processor}`
      const lines = [`# ${spec.name}, gpasm (gputils) -p ${processor}`, `# ${main}${asm.length > 1 ? ` (the others through #include: ${asm.filter((a) => a !== main).join(" ")})` : ""}`, ""]
      const out = await exec(GPASM, ["-p", processor, "-o", "firmware.hex", ...includes.map((i) => `-I${i}`), main], src, env)
      lines.push(out.output)
      if (out.error) return { ok: false, log: lines.join("\n"), error: out.error }
      return { ok: true, log: lines.join("\n"), elf: await readFile(path.join(src, "firmware.hex")) }
    }
    const sources = files.filter((f) => C.test(f.path)).map((f) => f.path)
    if (!sources.length) return { ok: false, log: "", error: "no source files to compile (.c for SDCC, or .asm for gpasm)" }
    const common = ["-mpic14", `-p${spec.processor}`, "--use-non-free", ...includes.map((i) => `-I${i}`)]
    const lines = [`# ${spec.name}, SDCC 4.4 pic14 (--use-non-free)`, `# sdcc ${sources.join(" ")}`, ""]
    await mkdir(path.join(src, "obj"), { recursive: true })
    const objects: string[] = []
    // gpasm's notes on the code SDCC generated (bank selection, "Message[302]") are about no line of the project.
    const own = (out: string) => out.split("\n").filter((l) => !/^obj\/[^:]*\.asm:\d+:Message\[/.test(l)).join("\n")
    for (const source of sources) {
      const object = path.join("obj", `${source.replace(/[\\/]/g, "__").replace(/\.c$/i, "")}.o`)
      const compile = await exec(SDCC, [...common, "-c", source, "-o", object], src, env)
      if (own(compile.output).trim()) lines.push(own(compile.output))
      if (compile.error) return { ok: false, log: lines.join("\n"), error: compile.error }
      objects.push(object)
    }
    const link = await exec(SDCC, [...common, "-o", "firmware.hex", ...objects], src, env)
    if (link.output.trim()) lines.push(link.output)
    if (link.error) return { ok: false, log: lines.join("\n"), error: link.error }
    return { ok: true, log: lines.join("\n"), elf: await readFile(path.join(src, "firmware.hex")) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Compile jobs at once: the core and a library are a few dozen files each. */
const PARALLEL = 4

/**
 * An Arduino sketch: the .ino files as one C++ file (`arduino.ts`), the project's other sources,
 * the libraries they #include and the core, with platform.txt's switches — the core and the
 * libraries at -Os with warnings off, as the IDE builds them; the sketch at the board's level
 * with -Wall, so a student sees the warnings about their own code. Linked as the IDE links:
 * the core as an archive, --gc-sections.
 */
async function buildSketch(spec: AvrSpec, files: SourceFile[], options: BuildOptions, src: string): Promise<BuildOutput> {
  const fcpu = options.fcpu ?? DEFAULT_FCPU
  const opt = options.opt ?? "-Os"
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: path.dirname(src), LANG: "C" }
  const driver = `${AVR_GCC}gcc`
  const sketch = path.join("sketch", "sketch.ino.cpp")
  await mkdir(path.join(src, "sketch"), { recursive: true })
  await writeFile(path.join(src, sketch), sketchToCpp(files))
  const own = files.filter((f) => !INO.test(f.path) && (C.test(f.path) || CXX.test(f.path) || ASM.test(f.path))).map((f) => f.path)
  const core = await coreFor()
  const libs = await librariesFor(files.map((f) => f.content))
  const projectIncludes = [...new Set(files.filter((f) => HEADER.test(f.path)).map((f) => path.dirname(f.path)))]
  const includes = [...projectIncludes, ...core.includes, ...libs.flatMap((l) => l.includes)].map((i) => `-I${i}`)
  const base = [`-mmcu=${spec.mcu}`, `-DF_CPU=${fcpu}L`, ...ARDUINO_DEFINES, "-gdwarf-4", "-ffunction-sections", "-fdata-sections", "-fdiagnostics-color=never", "-fmax-errors=50", ...includes]
  const flags = (file: string, quiet: boolean) => {
    const level = quiet ? ["-Os", "-w"] : [opt, "-Wall"]
    if (ASM.test(file)) return [...base, "-x", "assembler-with-cpp"]
    if (C.test(file)) return [...base, ...level, "-std=gnu11"]
    return [...base, ...level, "-x", "c++", "-std=gnu++11", "-fpermissive", "-fno-exceptions", "-fno-threadsafe-statics", "-Wno-error=narrowing"]
  }
  const lines = [`# ${spec.name} (Arduino Nano), ${opt}, F_CPU ${fcpu} Hz`, `# sketch: ${files.filter((f) => INO.test(f.path)).map((f) => f.path).join(" ")}${own.length ? ` + ${own.join(" ")}` : ""}`, `# libraries: ${libs.map((l) => l.name).join(", ") || "none"}; core: ArduinoCore-avr 1.8.6`, ""]
  await mkdir(path.join(src, "obj"), { recursive: true })
  const object = (file: string, i: number) => path.join("obj", `${i}-${path.basename(file)}.o`)
  type Job = { file: string; quiet: boolean; out: string }
  const jobs: Job[] = [
    ...[sketch, ...own].map((file, i) => ({ file, quiet: false, out: object(file, i) })),
    ...libs.flatMap((l) => l.sources).map((file, i) => ({ file, quiet: true, out: object(file, 1000 + i) })),
  ]
  const coreJobs: Job[] = core.sources.map((file, i) => ({ file, quiet: true, out: object(file, 5000 + i) }))
  let failed: string | undefined
  const run = async (list: Job[]) => {
    let next = 0
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        while (next < list.length && !failed) {
          const job = list[next++]
          const compile = await exec(driver, [...flags(job.file, job.quiet), "-c", job.file, "-o", job.out], src, env)
          if (compile.output.trim()) lines.push(compile.output)
          if (compile.error) failed ??= compile.error
        }
      }),
    )
  }
  await run(jobs)
  if (failed) return { ok: false, log: lines.join("\n"), error: failed }
  await run(coreJobs)
  if (failed) return { ok: false, log: lines.join("\n"), error: failed }
  const archive = await exec(`${AVR_GCC}ar`, ["rcs", "core.a", ...coreJobs.map((j) => j.out)], src, env)
  if (archive.error) return { ok: false, log: lines.join("\n") + archive.output, error: archive.error }
  const link = await exec(driver, [`-mmcu=${spec.mcu}`, "-w", "-Os", "-gdwarf-4", "-Wl,--gc-sections", ...jobs.map((j) => j.out), "core.a", "-o", "firmware.elf", "-Wl,-Map=firmware.map", "-lm"], src, env)
  if (link.output.trim()) lines.push(link.output)
  if (link.error) return { ok: false, log: lines.join("\n"), error: link.error }
  const size = await exec(`${AVR_GCC}size`, ["firmware.elf"], src, env)
  lines.push(size.output)
  return { ok: true, log: lines.join("\n"), elf: await readFile(path.join(src, "firmware.elf")), map: await readFile(path.join(src, "firmware.map")) }
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
