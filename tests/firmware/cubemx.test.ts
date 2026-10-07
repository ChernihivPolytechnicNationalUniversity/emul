import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import type { SourceFile } from "emul-shared/source"
import { cubeBench, readCubeProject, type CubeProject } from "@/project/cubemx"
import { GRID } from "@/schematic/geometry"
import { partKey, type Schematic } from "@/schematic/types"
import { SimLoop } from "@/sim/loop"
import { battery, cubeIdeFolder } from "../lib/cubemx"

const ST = process.env.ST ?? join(homedir(), "tools", "st")
const TOOL = process.env.TOOL ?? join(homedir(), "tools", "arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi", "bin", "arm-none-eabi-")
process.env.ST_ROOT = ST
process.env.ARM_GCC = TOOL
const { build } = await import("../../backend/worker/src/build")

const LEDS = ["LED1", "LED2", "LED3", "LED4"]

async function buildFor(files: SourceFile[]) {
  if (!existsSync(join(ST, "core", "Include"))) throw new Error(`${ST} has no core/Include — stage ST's sources with backend/worker/toolchain/stage-st.sh and point ST at them`)
  const out = await build("stm32f746ig", files, { opt: "-O0" })
  if (!out.ok) throw new Error(`${out.error}\n${out.log.slice(-3000)}`)
  return out.elf!
}

function bench(project: CubeProject, elf: Buffer) {
  const { doc, board } = cubeBench({ ...project, target: "stm32f746ig" }, GRID)
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
  const start = (d: Schematic) => {
    loop.setDoc(d)
    loop.setParts(d.parts)
    loop.setRunning(true)
    loop.advance(clock)
  }
  const leds = () => LEDS.map((l) => (loop.snapshot()!.parts[partKey(board.id, l)]?.on ? "●" : "○")).join("")
  const press = (part: string) => {
    loop.setParts({ [partKey(board.id, part)]: { pressed: true } })
    run(0.05)
    loop.setParts({})
  }
  start(doc)
  return { loop, board, run, leds, press }
}

describe("a CubeIDE project opened in the editor, built by the build service, on the Open746I-C", () => {
  let project: CubeProject
  let elf: Buffer
  beforeAll(async () => {
    project = await readCubeProject(cubeIdeFolder())
    elf = await buildFor(project.files)
  })

  it("builds with its own startup file in place of the service's", () => {
    expect(project.files.some((f) => f.path === "Core/Startup/startup_stm32f746igtx.s")).toBe(true)
    expect(elf.length).toBeGreaterThan(0)
  })

  it("boots from the 8 MHz crystal to 50 MHz and runs the light on the joystick", () => {
    const b = bench(project, elf)
    b.run(0.2)
    const mcu = b.loop.snapshot()!.mcus[b.board.id]
    expect(mcu?.halted, "halted").toBeFalsy()
    expect(mcu?.sysclk ?? 0, "SYSCLK").toBe(50e6)
    expect(b.leds(), "after boot").toBe("●○○○")
    b.press("JOY_C")
    b.run(1.2)
    expect(b.leds(), "a second after C").toBe("○●○○")
  })

  it("links against the flash script when the RAM one comes along", async () => {
    const ram = { path: "STM32F746IGTX_RAM.ld", content: battery("STM32F746IGTX_FLASH.ld").replace(/>\s*ROM/g, ">RAM") }
    const withRam = await buildFor([ram, ...project.files])
    const b = bench(project, withRam)
    b.run(0.2)
    expect(b.leds(), "after boot").toBe("●○○○")
  })
})
