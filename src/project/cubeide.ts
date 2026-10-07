import type { OptLevel, SourceFile, Target } from "emul-shared/source"
import type { ZipInput } from "@/lib/zip"
import { safeName } from "@/components/hdl/files"
import { partOf } from "./cubemx"
import cprojectTemplate from "./cubeide/template.cproject?raw"
import projectTemplate from "./cubeide/template.project?raw"

export type StSite = { files: string[]; read: (path: string) => Promise<Uint8Array> }

export type CubeIdeExport = { name: string; entries: ZipInput[]; cubeMxVersion: string | null }

type TargetSpec = { family: string; defines: string[] }

const CUBEIDE: Record<Target, { fpu: string; clockMHz: number }> = {
  stm32f429zi: { fpu: "fpv4-sp-d16", clockMHz: 180 },
  stm32f746ig: { fpu: "fpv5-sp-d16", clockMHz: 216 },
}

const OPTIMIZATION: Record<OptLevel, string | null> = { "-O0": null, "-Og": "og", "-O1": "o1", "-O2": "o2", "-O3": "o3", "-Os": "os" }

const SOURCE = /\.(c|cpp|cc|s)$/i
const CPP = /\.(cpp|cc)$/i
const HEADER = /\.(h|hpp)$/i
const STARTUP = /(^|\/)startup_[^/]*\.s$/i
const LINKER = /\.ld$/i
const FLASH_LINKER = /_FLASH\.ld$/i
const IOC = /^[^/]+\.ioc$/i
const ST_DRIVERS = /^Drivers\/(CMSIS|STM32[^/]*_HAL_Driver)\//i
const CUBEIDE_SUBFOLDER = /^STM32CubeIDE\/Application\/User\/Core\/([^/]+)$/

const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const topFolder = (path: string) => (path.includes("/") ? path.slice(0, path.indexOf("/")) : "")
const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

export const eclipseName = (name: string) => safeName(name.replace(/\./g, "_")).replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "emul_project"

export const cubeMcu = (target: Target) => `${partOf(target).slice(0, -1)}x`

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    if (!(key in values)) throw new Error(`the CubeIDE template has no value for ${key}`)
    return values[key]!
  })
}

function setIocKeys(ioc: string, keys: Record<string, string>): string {
  const written = new Set<string>()
  const lines = ioc.split("\n").flatMap((line) => {
    const key = line.slice(0, line.indexOf("="))
    if (!Object.hasOwn(keys, key)) return [line]
    if (written.has(key)) return []
    written.add(key)
    return [`${key}=${keys[key]}`]
  })
  const missing = Object.entries(keys).filter(([key]) => !written.has(key)).map(([key, value]) => `${key}=${value}`)
  lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, ...missing)
  return lines.join("\n")
}

const iocValue = (ioc: string, key: string) => new RegExp(`^${key.replace(/\./g, "\\.")}=(.*)$`, "m").exec(ioc)?.[1]?.trim() || null

function cubeIdeLayout(files: SourceFile[], mcu: string, name: string): SourceFile[] {
  const taken = new Set(files.map((f) => f.path))
  const startup = files.find((f) => STARTUP.test(f.path))
  const linkers = files.filter((f) => LINKER.test(f.path))
  const flash = linkers.find((f) => FLASH_LINKER.test(f.path)) ?? (linkers.length === 1 ? linkers[0] : undefined)
  const ioc = files.find((f) => IOC.test(f.path))
  const moved = (f: SourceFile): string => {
    if (f === startup) return `Core/Startup/startup_${mcu.toLowerCase()}.s`
    if (f === flash) return `${mcu.toUpperCase()}_FLASH.ld`
    if (f === ioc) return `${name}.ioc`
    const core = CUBEIDE_SUBFOLDER.exec(f.path)
    if (core) return `Core/Src/${core[1]}`
    if (f.path.startsWith("STM32CubeIDE/") && LINKER.test(f.path)) return baseName(f.path)
    return f.path
  }
  return files.map((f) => {
    const to = moved(f)
    if (to === f.path || taken.has(to)) return f
    taken.add(to)
    return { ...f, path: to }
  })
}

function batteryPath(name: string, mcu: string): string {
  if (STARTUP.test(name)) return `Core/Startup/startup_${mcu.toLowerCase()}.s`
  if (LINKER.test(name)) return `${mcu.toUpperCase()}_FLASH.ld`
  return HEADER.test(name) ? `Core/Inc/${name}` : `Core/Src/${name}`
}

async function batteries(site: StSite, target: Target, project: SourceFile[], mcu: string): Promise<{ path: string; content: Uint8Array }[]> {
  const own = new Set(project.map((f) => baseName(f.path)))
  const hasStartup = project.some((f) => STARTUP.test(f.path))
  const hasLinker = project.some((f) => LINKER.test(f.path))
  const wanted = site.files.filter((p) => {
    if (!p.startsWith(`targets/${target}/`) && !p.startsWith("targets/common/")) return false
    const name = baseName(p)
    if (!SOURCE.test(name) && !HEADER.test(name) && !LINKER.test(name)) return false
    if (STARTUP.test(name)) return !hasStartup
    if (LINKER.test(name)) return !hasLinker
    return !own.has(name)
  })
  return Promise.all(wanted.map(async (p) => ({ path: batteryPath(baseName(p), mcu), content: await site.read(p) })))
}

function driverPath(sitePath: string, family: string, familyDir: string): string | null {
  const hal = `${family}/hal/`
  const cmsis = `${family}/cmsis/Include/`
  if (sitePath.startsWith(hal)) return `Drivers/${familyDir}_HAL_Driver/${sitePath.slice(hal.length)}`
  if (sitePath.startsWith(cmsis)) return `Drivers/CMSIS/Device/ST/${familyDir}/Include/${sitePath.slice(cmsis.length)}`
  if (sitePath.startsWith("core/Include/")) return `Drivers/CMSIS/Include/${sitePath.slice("core/Include/".length)}`
  return null
}

const listValues = (values: string[], indent: string) => values.map((v) => `${indent}<listOptionValue builtIn="false" value="${xml(v)}"/>`).join("\n")

function cppOptions(config: "debug" | "release", defines: string[], includes: string[]): string {
  const id = config === "debug" ? "1001" : "2001"
  const tool = "com.st.stm32cube.ide.mcu.gnu.managedbuild.tool.cpp.compiler.option"
  const indent = "\t\t\t\t\t\t\t\t\t"
  return [
    `\t\t\t\t\t\t\t\t<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="false" id="${tool}.definedsymbols.${id}" name="Define symbols (-D)" superClass="${tool}.definedsymbols" useByScannerDiscovery="false" valueType="definedSymbols">`,
    listValues(defines, indent),
    "\t\t\t\t\t\t\t\t</option>",
    `\t\t\t\t\t\t\t\t<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="false" id="${tool}.includepaths.${id}" name="Include paths (-I)" superClass="${tool}.includepaths" useByScannerDiscovery="false" valueType="includePath">`,
    listValues(includes, indent),
    "\t\t\t\t\t\t\t\t</option>",
  ].join("\n")
}

function assemblerOptions(config: "debug" | "release", defines: string[] | null, includes: string[]): string {
  const id = config === "debug" ? "1003" : "2003"
  const tool = "com.st.stm32cube.ide.mcu.gnu.managedbuild.tool.assembler.option"
  const indent = "\t\t\t\t\t\t\t\t\t"
  const definesOption = defines
    ? [
        `\t\t\t\t\t\t\t\t<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="false" id="${tool}.definedsymbols.${id}" name="Define symbols (-D)" superClass="${tool}.definedsymbols" valueType="definedSymbols">`,
        listValues(defines, indent),
        "\t\t\t\t\t\t\t\t</option>",
      ]
    : []
  return [
    ...definesOption,
    `\t\t\t\t\t\t\t\t<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="false" id="${tool}.includepaths.${id}" name="Include paths (-I)" superClass="${tool}.includepaths" valueType="includePath">`,
    listValues(includes, indent),
    "\t\t\t\t\t\t\t\t</option>",
  ].join("\n")
}

function cppLinkerScript(config: "debug" | "release", linker: string): string {
  const id = config === "debug" ? "1002" : "2002"
  const option = "com.st.stm32cube.ide.mcu.gnu.managedbuild.tool.cpp.linker.option.script"
  return `\t\t\t\t\t\t\t\t<option id="${option}.${id}" name="Linker Script (-T)" superClass="${option}" value="\${workspace_loc:/\${ProjName}/${xml(linker)}}" valueType="string"/>`
}

function optimization(tool: "c" | "cpp", opt: OptLevel): string {
  const level = OPTIMIZATION[opt]
  return level ? ` value="com.st.stm32cube.ide.mcu.gnu.managedbuild.tool.${tool}.compiler.option.optimization.level.value.${level}" valueType="enumerated"` : ""
}

function buildDefaults(config: "Debug" | "Release", mcu: string, includes: string[], defines: string[], sourceDirs: string[], linker: string): string {
  return [
    "com.st.stm32cube.ide.common.services.build.inputs.revA.1.0.6",
    config,
    config === "Debug" ? "true" : "false",
    "Executable",
    "com.st.stm32cube.ide.mcu.gnu.managedbuild.option.toolchain.value.workspace",
    mcu,
    "0",
    "0",
    "arm-none-eabi-",
    "${gnu_tools_for_stm32_compiler_path}",
    includes.join(" | "),
    "",
    "",
    defines.join(" | "),
    "",
    sourceDirs.join(" | "),
    "",
    "",
    `\${workspace_loc:/\${ProjName}/${linker}}`,
    "true",
    "NonSecure",
    "",
    "secure_nsclib.o",
    "",
    "None",
    "",
    "",
    "",
  ].join(" || ")
}

export async function cubeIdeProject(options: { name: string; target: Target; files: SourceFile[]; opt: OptLevel; site: StSite }): Promise<CubeIdeExport> {
  const { target, opt, site } = options
  const mcu = cubeMcu(target)
  const ownIoc = options.files.find((f) => IOC.test(f.path))
  const name = eclipseName(ownIoc ? (iocValue(ownIoc.content, "ProjectManager.ProjectName") ?? ownIoc.path.replace(/\.ioc$/i, "")) : options.name)
  const specPath = `targets/${target}/target.json`
  if (!site.files.includes(specPath)) throw new Error("this site has no copy of ST's drivers and the build service's files to pack (run pnpm st-sources)")
  const spec = JSON.parse(new TextDecoder().decode(await site.read(specPath))) as TargetSpec
  const familyDir = `STM32${spec.family.toUpperCase()}xx`

  const project = cubeIdeLayout(options.files, mcu, name).map((f) =>
    IOC.test(f.path)
      ? {
          ...f,
          content: setIocKeys(f.content, {
            "ProjectManager.ProjectName": name,
            "ProjectManager.ProjectFileName": `${name}.ioc`,
            "ProjectManager.TargetToolchain": "STM32CubeIDE",
            "ProjectManager.UnderRoot": "true",
            "ProjectManager.ToolChainLocation": "",
          }),
        }
      : f,
  )
  const added = await batteries(site, target, project, mcu)
  const taken = new Set([...project.map((f) => f.path), ...added.map((f) => f.path)])
  const drivers = await Promise.all(
    site.files
      .map((p) => ({ from: p, to: driverPath(p, spec.family, familyDir) }))
      .filter((d): d is { from: string; to: string } => !!d.to && !taken.has(d.to))
      .map(async (d) => ({ path: d.to, content: await site.read(d.from) })),
  )

  const paths = [...project.map((f) => f.path), ...added.map((f) => f.path), ...drivers.map((f) => f.path)]
  const linker = paths.find((p) => FLASH_LINKER.test(p)) ?? paths.find((p) => LINKER.test(p))
  if (!linker) throw new Error("no linker script to build with")
  const headerDirs = [...new Set(paths.filter((p) => HEADER.test(p) && !ST_DRIVERS.test(p)).map(dirOf))].sort()
  const includes = [
    ...headerDirs.map((d) => (d ? `../${d}` : "..")),
    `../Drivers/${familyDir}_HAL_Driver/Inc`,
    `../Drivers/${familyDir}_HAL_Driver/Inc/Legacy`,
    `../Drivers/CMSIS/Device/ST/${familyDir}/Include`,
    "../Drivers/CMSIS/Include",
  ]
  const defines = spec.defines.map((d) => d.replace(/^-D/, ""))
  const sources = paths.filter((p) => SOURCE.test(p))
  const sourceDirs = sources.some((p) => !p.includes("/")) ? [""] : [...new Set(sources.map(topFolder))].sort()
  const cpp = sources.some((p) => CPP.test(p))

  const cproject = fill(cprojectTemplate, {
    name,
    mcu,
    fpu: CUBEIDE[target].fpu,
    clock: String(CUBEIDE[target].clockMHz),
    defaultsDebug: xml(buildDefaults("Debug", mcu, includes, defines, sourceDirs, linker)),
    defaultsRelease: xml(buildDefaults("Release", mcu, includes, defines, sourceDirs, linker)),
    debugDefines: listValues(["DEBUG", ...defines], "\t\t\t\t\t\t\t\t\t"),
    releaseDefines: listValues(defines, "\t\t\t\t\t\t\t\t\t"),
    includes: listValues(includes, "\t\t\t\t\t\t\t\t\t"),
    debugOptimizationC: optimization("c", opt),
    debugOptimizationCpp: optimization("cpp", opt),
    asmDebugDefines: listValues(["DEBUG", ...defines], "\t\t\t\t\t\t\t\t\t"),
    asmDebugIncludes: assemblerOptions("debug", null, includes),
    asmReleaseOptions: assemblerOptions("release", defines, includes),
    debugCppOptions: cppOptions("debug", ["DEBUG", ...defines], includes),
    releaseCppOptions: cppOptions("release", defines, includes),
    linker: xml(linker),
    cppLinkerDebug: cppLinkerScript("debug", linker),
    cppLinkerRelease: cppLinkerScript("release", linker),
    sources: sourceDirs.map((d) => `\t\t\t\t\t\t<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="${xml(d)}"/>`).join("\n"),
  })
  const natures = [
    "com.st.stm32cube.ide.mcu.MCUProjectNature",
    ...(ownIoc ? ["com.st.stm32cube.ide.mcu.MCUCubeProjectNature"] : []),
    "org.eclipse.cdt.core.cnature",
    ...(cpp ? ["org.eclipse.cdt.core.ccnature"] : []),
    "com.st.stm32cube.ide.mcu.MCUCubeIdeServicesRevAev2ProjectNature",
    "com.st.stm32cube.ide.mcu.MCUAdvancedStructureProjectNature",
    "com.st.stm32cube.ide.mcu.MCUSingleCpuProjectNature",
    "com.st.stm32cube.ide.mcu.MCURootProjectNature",
    "org.eclipse.cdt.managedbuilder.core.managedBuildNature",
    "org.eclipse.cdt.managedbuilder.core.ScannerConfigNature",
  ]
  const dotProject = fill(projectTemplate, { name, natures: natures.map((n) => `\t\t<nature>${n}</nature>`).join("\n") })

  const entries: ZipInput[] = [
    { path: ".project", content: dotProject },
    { path: ".cproject", content: cproject },
    { path: ".settings/org.eclipse.core.resources.prefs", content: "eclipse.preferences.version=1\nencoding/<project>=UTF-8\n" },
    ...project.map((f) => ({ path: f.path, content: f.content })),
    ...added,
    ...drivers,
  ].map((e) => ({ ...e, path: `${name}/${e.path}` }))
  return { name, entries, cubeMxVersion: ownIoc ? iocValue(ownIoc.content, "MxCube.Version") : null }
}
