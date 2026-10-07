import { SOURCE_LIMITS, TARGETS, sourcePath, type SourceFile, type Target } from "emul-shared/source"
import { chipById } from "@/mcu/chip"
import { builder } from "@/schematic/builder"
import { getDef } from "@/schematic/registry"
import type { PlacedObject, Schematic } from "@/schematic/types"
import { normalizeFiles } from "./files"

export type ProjectEntry = { path: string; size: number; read: () => Promise<Uint8Array> }

export type Refusal = { path: string; why: string }

export type CubeProject = {
  name: string
  notBuilt: string[]
  root: string
  ioc: string | null
  mcu: string | null
  target: Target | null
  files: SourceFile[]
  vendorFiles: number
  refused: Refusal[]
}

export const BOARD_FOR: Record<Target, string> = { stm32f429zi: "nucleo-f429zi", stm32f746ig: "open746i-c" }

const BUILD_FILE = /\.(c|h|cpp|hpp|cc|s|ld)$/i
const JUNK = /(^|\/)(\.|__MACOSX\/)/
const BUILD_OUTPUT = /^(Debug|Release|build|cmake-build-[^/]*)\//i
const OTHER_TOOLCHAIN = /^(EWARM|MDK-ARM)\//i
const VENDOR = /^Drivers\/(CMSIS|STM32[^/]*_HAL_Driver)\//i
const RAM_LINKER = /_RAM\.ld$/i
const IOC = /\.ioc$/i
const NOT_A_SOURCE_NAME = "name must be letters, digits, . _ - with a source extension"
const PART_IN_FILE_NAME = /(?:^|\/)(?:startup_)?(stm32[a-z]\d{3}[a-z0-9]*?)(?:x+)?(?:_flash)?\.(?:s|ld)$/i

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "")
const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const depth = (path: string) => path.split("/").length
const under = (path: string, dir: string) => dir === "" || path.startsWith(dir + "/")
const relative = (path: string, dir: string) => (dir === "" ? path : path.slice(dir.length + 1))

export function parseIoc(text: string): Map<string, string> {
  const keys = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq <= 0) continue
    keys.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim().replace(/\\(.)/g, "$1"))
  }
  return keys
}

export function targetOf(mcu: string): Target | null {
  const part = mcu.toUpperCase()
  return TARGETS.find((t) => part.startsWith(familyOf(t))) ?? null
}

const FAMILY_LENGTH = "STM32F746".length
const PART_LENGTH = "STM32F746IG".length
export const partOf = (target: Target) => chipById(target)!.name
const familyOf = (target: Target) => partOf(target).slice(0, FAMILY_LENGTH)
const boardName = (target: Target) => getDef(BOARD_FOR[target])?.name ?? BOARD_FOR[target]

export function couldBePart(mcu: string, target: Target): boolean {
  const named = mcu.toUpperCase().slice(0, PART_LENGTH)
  return named.length < PART_LENGTH || named === partOf(target).slice(0, PART_LENGTH)
}

function commonDir(paths: string[]): string {
  if (!paths.length) return ""
  let dir = dirOf(paths[0]!)
  while (dir && !paths.every((p) => under(p, dir))) dir = dirOf(dir)
  return dir
}

const namedAfterFolder = (ioc: string) => baseName(ioc).replace(IOC, "").toLowerCase() === baseName(dirOf(ioc)).toLowerCase()

function projectRoot(paths: string[]): { root: string; ioc: string | null; nested: string[] } {
  const iocs = paths.filter((p) => IOC.test(p)).sort((a, b) => depth(a) - depth(b) || Number(namedAfterFolder(b)) - Number(namedAfterFolder(a)) || a.localeCompare(b))
  const ioc = iocs[0] ?? null
  if (!ioc) return { root: commonDir(paths), ioc, nested: [] }
  const root = dirOf(ioc)
  const siblings = [...new Set(iocs.filter((p) => depth(p) === depth(ioc)).map(dirOf))]
  if (siblings.length > 1) throw new Error(`Folder holds ${siblings.length} projects (${siblings.map(baseName).join(", ")}). Open one of them.`)
  const nested = iocs.map(dirOf).filter((dir) => dir !== root && under(dir, root)).map((dir) => relative(dir, root))
  return { root, ioc, nested }
}

export const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true })
const WINDOWS_1251 = new TextDecoder("windows-1251")

export function decodeSource(bytes: Uint8Array): string {
  try {
    return STRICT_UTF8.decode(bytes)
  } catch {
    return WINDOWS_1251.decode(bytes)
  }
}

const SOURCE_FILE = /\.(c|cpp|cc|s)$/i
const SOURCE_ENTRIES = /<sourceEntries>([\s\S]*?)<\/sourceEntries>/
const SOURCE_ENTRY = /<entry\b[^>]*\bkind="sourcePath"[^>]*>/g
const attribute = (tag: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1]

export function cubeIdeBuilds(cproject: string): ((path: string) => boolean) | null {
  const block = SOURCE_ENTRIES.exec(cproject)?.[1]
  if (!block) return null
  const folders = [...block.matchAll(SOURCE_ENTRY)].map((m) => ({
    name: attribute(m[0], "name") ?? "",
    excluded: (attribute(m[0], "excluding") ?? "").split("|").filter(Boolean),
  }))
  return (path) =>
    folders.some(({ name, excluded }) => {
      if (!under(path, name)) return false
      const inside = relative(path, name)
      return !excluded.some((x) => inside === x || inside.startsWith(`${x}/`))
    })
}

async function readSmall(entry: ProjectEntry, path: string): Promise<string> {
  if (entry.size > SOURCE_LIMITS.fileBytes) throw new Error(`${path} is over ${SOURCE_LIMITS.fileBytes / 1024 / 1024} MB.`)
  return decodeSource(await entry.read())
}

export async function readCubeProject(entries: ProjectEntry[]): Promise<CubeProject> {
  const normalized = entries.map((e) => ({ ...e, path: e.path.replace(/\\/g, "/").replace(/^\/+/, "") }))
  const all = normalized.filter((e) => !JUNK.test(e.path))
  if (!all.length) throw new Error("Folder is empty.")
  const { root, ioc, nested } = projectRoot(all.map((e) => e.path))
  const ownIoc = ioc ? all.find((e) => e.path === ioc) : undefined
  const iocText = ownIoc ? await readSmall(ownIoc, ioc!) : null
  const settings = iocText !== null ? parseIoc(iocText) : new Map<string, string>()
  const cprojectEntry = normalized.find((e) => e.path === (root ? `${root}/.cproject` : ".cproject"))
  const builds = cprojectEntry ? cubeIdeBuilds(await readSmall(cprojectEntry, ".cproject")) : null
  const notBuilt: string[] = []

  const kept: ProjectEntry[] = []
  const refused: Refusal[] = []
  let vendorFiles = 0
  for (const entry of all) {
    if (!under(entry.path, root)) continue
    const path = relative(entry.path, root)
    if (nested.some((dir) => under(path, dir))) continue
    if (entry.path === ioc) continue
    if (!BUILD_FILE.test(path) || BUILD_OUTPUT.test(path) || OTHER_TOOLCHAIN.test(path) || RAM_LINKER.test(path)) continue
    if (VENDOR.test(path)) {
      vendorFiles++
      continue
    }
    if (builds && SOURCE_FILE.test(path) && !builds(path)) {
      notBuilt.push(path)
      continue
    }
    const clean = sourcePath(path)
    if (!clean) refused.push({ path, why: depth(path) > 8 ? "more than 8 folders deep" : NOT_A_SOURCE_NAME })
    else if (entry.size > SOURCE_LIMITS.fileBytes) refused.push({ path, why: `over ${SOURCE_LIMITS.fileBytes / 1024 / 1024} MB` })
    else kept.push({ ...entry, path: clean })
  }

  const name = settings.get("ProjectManager.ProjectName") || (ioc ? baseName(ioc).replace(IOC, "") : baseName(root)) || "STM32 project"
  if (!kept.length) {
    throw new Error(vendorFiles ? `${name} has no sources besides ST drivers.` : "No C or C++ sources. Open the folder that contains the .ioc.")
  }
  if (kept.length + (ownIoc ? 1 : 0) > SOURCE_LIMITS.files) {
    throw new Error(`${name} has ${kept.length} source files; the limit is ${SOURCE_LIMITS.files}.`)
  }

  const sources = await Promise.all(kept.map(async (e) => ({ path: e.path, content: decodeSource(await e.read()) })))
  const iocFile = ownIoc && iocText !== null ? [{ path: sourcePath(relative(ownIoc.path, root)) ?? "project.ioc", content: iocText }] : []
  const files = normalizeFiles([...sources, ...iocFile])
  const mcu = settings.get("Mcu.UserName") || settings.get("Mcu.CPN") || settings.get("Mcu.Name") || partFromFiles(files)
  refused.sort((a, b) => a.path.localeCompare(b.path, "en"))
  notBuilt.sort((a, b) => a.localeCompare(b, "en"))
  return { name, notBuilt, root, ioc, mcu, target: mcu ? targetOf(mcu) : null, files, vendorFiles, refused }
}

function partFromFiles(files: SourceFile[]): string | null {
  for (const f of files) {
    const m = PART_IN_FILE_NAME.exec(f.path)
    if (m) return m[1]!.toUpperCase()
  }
  return null
}

export function cubeBench(project: CubeProject & { target: Target }, grid: number): { doc: Schematic; board: PlacedObject } {
  const { doc, place } = builder(grid)
  const board = place(BOARD_FOR[project.target], 0, 0)
  board.project = project.files
  return { doc, board }
}

export function importNotes(project: CubeProject, target: Target): string[] {
  const notes: string[] = []
  if (project.mcu && !couldBePart(project.mcu, target)) {
    notes.push(`Project is for ${project.mcu}, runs on the ${partOf(target)}. Pins missing on the ${partOf(target)} do nothing.`)
  }
  if (project.notBuilt.length) {
    const shown = project.notBuilt.slice(0, 3)
    notes.push(`Skipped, not built by the CubeIDE project: ${shown.join(", ")}${project.notBuilt.length > shown.length ? ` and ${project.notBuilt.length - shown.length} more` : ""}.`)
  }
  if (project.vendorFiles) notes.push(`Skipped ST HAL and CMSIS (${project.vendorFiles} files); the build service has its own.`)
  if (project.refused.length) {
    const shown = project.refused.slice(0, 3).map((r) => `${r.path} (${r.why})`)
    const more = project.refused.length - shown.length
    notes.push(`Not imported: ${shown.join("; ")}${more > 0 ? `; ${more} more` : ""}.`)
  }
  return notes
}

export function unsupportedChip(project: CubeProject): { title: string; description: string } {
  const boards = TARGETS.map((t) => `${partOf(t)} (${boardName(t)})`).join(", ")
  return project.mcu
    ? { title: `${project.mcu} not supported`, description: `Supported: ${boards}.` }
    : { title: "Unknown chip", description: `${project.name} has no .ioc or startup file. Open the folder that contains the .ioc.` }
}
