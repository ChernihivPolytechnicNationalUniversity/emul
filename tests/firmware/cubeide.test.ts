import { execFile, execFileSync } from "node:child_process"
import { promisify } from "node:util"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { cubeIdeProject, type CubeIdeExport, type StSite } from "@/project/cubeide"
import { readCubeProject } from "@/project/cubemx"
import { GRID } from "@/schematic/geometry"
import { builder } from "@/schematic/builder"
import { partKey } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { cubeIdeFolder } from "../lib/cubemx"

const ROOT = join(import.meta.dirname, "..", "..")
const ST = process.env.ST ?? join(homedir(), "tools", "st")
const TOOL = process.env.TOOL ?? join(homedir(), "tools", "arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi", "bin", "arm-none-eabi-")
const LEDS = ["LED1", "LED2", "LED3", "LED4"]

function siteFrom(dir: string): StSite {
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { files: string[] }
  return { files: index.files, read: async (path) => new Uint8Array(readFileSync(join(dir, path))) }
}

type Tool = "c.compiler" | "cpp.compiler" | "assembler"

function debugOption(cproject: string, tool: Tool, option: string): string[] {
  const block = new RegExp(`tool\\.${tool.replace(".", "\\.")}\\.option\\.${option}\\.\\d+"[^>]*>\\n((?:\\s*<listOptionValue[^\\n]*\\n)+)`).exec(cproject)
  return [...block![1]!.matchAll(/value="([^"]*)"/g)].map((m) => m[1]!)
}

const run = promisify(execFile)
const PARALLEL = 8

async function compileLikeCubeIde(dir: string, exported: CubeIdeExport): Promise<Buffer> {
  const cproject = readFileSync(join(dir, ".cproject"), "utf8")
  const fpu = /fpu\.value\.([\w-]+)"/.exec(cproject)![1]!
  const linker = /tool\.c\.linker\.option\.script\.\d+"[^>]*value="\$\{workspace_loc:\/\$\{ProjName\}\/([^}]+)\}"/.exec(cproject)![1]!
  const cpu = ["-mcpu=cortex-m7", "-mthumb", `-mfpu=${fpu}`, "-mfloat-abi=hard"]
  const flags = (tool: Tool) => [
    ...cpu,
    "-g3",
    "-O0",
    "-ffunction-sections",
    "-fdata-sections",
    ...debugOption(cproject, tool, "definedsymbols").map((d) => `-D${d}`),
    ...debugOption(cproject, tool, "includepaths").map((i) => `-I${i.replace(/^\.\.\/?/, "") || "."}`),
  ]
  const sources = exported.entries.map((e) => e.path.slice(exported.name.length + 1)).filter((f) => /\.(c|cpp|cc|s)$/i.test(f))
  mkdirSync(join(dir, "Debug"), { recursive: true })
  const compile = (source: string, i: number) => {
    const object = join("Debug", `${i}.o`)
    const args = /\.(cpp|cc)$/.test(source)
      ? ["g++", [...flags("cpp.compiler"), "-fno-exceptions", "-fno-rtti", "-fno-use-cxa-atexit"]]
      : /\.s$/i.test(source)
        ? ["gcc", [...flags("assembler"), "-x", "assembler-with-cpp"]]
        : ["gcc", [...flags("c.compiler"), "-std=gnu11"]]
    return run(`${TOOL}${args[0]}`, [...(args[1] as string[]), "-c", source, "-o", object], { cwd: dir }).then(() => object)
  }
  const objects: string[] = []
  for (let i = 0; i < sources.length; i += PARALLEL) objects.push(...(await Promise.all(sources.slice(i, i + PARALLEL).map((s, j) => compile(s, i + j)))))
  execFileSync(`${TOOL}g++`, [...cpu, ...objects, `-T${linker}`, "-specs=nosys.specs", "-specs=nano.specs", "-Wl,--gc-sections", "-static", "-o", "firmware.elf", "-Wl,--start-group", "-lc", "-lm", "-lstdc++", "-lsupc++", "-Wl,--end-group"], { cwd: dir })
  return readFileSync(join(dir, "firmware.elf"))
}

describe("a board's code exported as an STM32CubeIDE project, built from the zip alone, on the Open746I-C", () => {
  let exported: CubeIdeExport
  let elf: Buffer
  beforeAll(async () => {
    if (!existsSync(join(ST, "core", "Include"))) throw new Error(`${ST} has no core/Include — stage ST's sources with backend/worker/toolchain/stage-st.sh and point ST at them`)
    const work = mkdtempSync(join(tmpdir(), "emul-cubeide-"))
    execFileSync(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), "--tsconfig", "tsconfig.app.json", "scripts/st-sources.ts", ST, join(work, "site")], { cwd: ROOT })
    const project = await readCubeProject(cubeIdeFolder())
    exported = await cubeIdeProject({ name: "bench", target: "stm32f746ig", files: project.files, opt: "-O0", site: siteFrom(join(work, "site")) })
    const dir = join(work, "out", exported.name)
    for (const e of exported.entries) {
      const path = join(work, "out", e.path)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, e.content)
    }
    elf = await compileLikeCubeIde(dir, exported)
  })

  it("holds everything the build needs: ST's HAL and CMSIS, the startup file and the linker script the .cproject names", () => {
    expect(elf.length).toBeGreaterThan(0)
  })

  it("runs: 50 MHz from the crystal, LED1 lit, joystick C steps to LED2", () => {
    const { doc, place } = builder(GRID)
    const board = place("open746i-c", 0, 0)
    board.props = { ...board.props, firmware: "firmware.elf", firmwareData: elf.toString("base64") }
    const loop = new SimLoop()
    let clock = 0
    const run = (seconds: number) => {
      const end = clock + seconds * 1000
      while (clock < end) {
        clock = Math.min(end, clock + 30)
        loop.advance(clock)
      }
    }
    const leds = () => LEDS.map((l) => (loop.snapshot()!.parts[partKey(board.id, l)]?.on ? "●" : "○")).join("")
    loop.setDoc(doc)
    loop.setParts(doc.parts)
    loop.setRunning(true)
    run(0.2)
    expect(loop.snapshot()!.mcus[board.id]?.sysclk ?? 0, "SYSCLK").toBe(50e6)
    expect(leds(), "after boot").toBe("●○○○")
    loop.setParts({ [partKey(board.id, "JOY_C")]: { pressed: true } })
    run(0.05)
    loop.setParts({})
    run(1.2)
    expect(leds(), "a second after C").toBe("○●○○")
  })
})
