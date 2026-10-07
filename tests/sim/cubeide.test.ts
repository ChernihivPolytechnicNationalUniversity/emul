import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { describe, expect, it } from "vitest"
import type { SourceFile } from "emul-shared/source"
import { cubeIdeProject, type CubeIdeExport, type StSite } from "@/project/cubeide"
import { readCubeProject } from "@/project/cubemx"
import { template } from "@/project/template"
import { cubeIdeFolder, entry, ioc } from "../lib/cubemx"

const TARGETS = join(import.meta.dirname, "..", "..", "backend", "worker", "targets")

const site: StSite = (() => {
  const real = new Map<string, Buffer>(
    readdirSync(TARGETS, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => [`targets/${relative(TARGETS, join(d.parentPath, d.name)).replace(/\\/g, "/")}`, readFileSync(join(d.parentPath, d.name))] as const),
  )
  const drivers = [
    "core/Include/core_cm7.h",
    "core/Include/core_cm4.h",
    "f7/hal/Src/stm32f7xx_hal.c",
    "f7/hal/Inc/stm32f7xx_hal.h",
    "f7/hal/Inc/Legacy/stm32_hal_legacy.h",
    "f7/cmsis/Include/stm32f746xx.h",
    "f4/hal/Src/stm32f4xx_hal.c",
    "f4/hal/Inc/stm32f4xx_hal.h",
    "f4/cmsis/Include/stm32f429xx.h",
  ]
  return {
    files: [...real.keys(), ...drivers],
    read: async (path) => new Uint8Array(real.get(path) ?? Buffer.from(`/* ${path} */`)),
  }
})()

const text = (exported: CubeIdeExport, path: string) => {
  const e = exported.entries.find((x) => x.path === `${exported.name}/${path}`)
  if (!e) throw new Error(`${path} is not in the export`)
  return typeof e.content === "string" ? e.content : new TextDecoder().decode(e.content)
}
const paths = (exported: CubeIdeExport) => exported.entries.map((e) => e.path.slice(exported.name.length + 1)).sort()
const listed = (cproject: string, option: string) =>
  [...new RegExp(`${option}\\.\\d+"[^>]*>\\n((?:\\s*<listOptionValue[^\\n]*\\n)+)`).exec(cproject)![1]!.matchAll(/value="([^"]*)"/g)].map((m) => m[1])

async function exportOf(files: SourceFile[], options: Partial<Parameters<typeof cubeIdeProject>[0]> = {}) {
  return cubeIdeProject({ name: "bench", target: "stm32f746ig", files, opt: "-O0", site, ...options })
}

describe("a board's code exported as an STM32CubeIDE project", () => {
  describe("a CubeMX project with C++ in App/, as imported from STM32CubeIDE", async () => {
    const imported = await readCubeProject(cubeIdeFolder())
    const exported = await exportOf(imported.files)
    const cproject = text(exported, ".cproject")
    const project = text(exported, ".project")

    it("is named after its .ioc and sits in a folder of that name", () => {
      expect(exported.name).toBe("Lab1")
      expect(exported.entries.every((e) => e.path.startsWith("Lab1/"))).toBe(true)
      expect(project).toContain("<name>Lab1</name>")
      expect(cproject).toContain('<project id="Lab1.null.1994678739" name="Lab1"/>')
    })

    it("is a CubeMX project for C and C++, with the .ioc set up for STM32CubeIDE under the project's root", () => {
      expect(project).toContain("<nature>com.st.stm32cube.ide.mcu.MCUCubeProjectNature</nature>")
      expect(project).toContain("<nature>org.eclipse.cdt.core.ccnature</nature>")
      const iocText = text(exported, "Lab1.ioc")
      expect(iocText).toMatch(/^ProjectManager\.TargetToolchain=STM32CubeIDE$/m)
      expect(iocText).toMatch(/^ProjectManager\.UnderRoot=true$/m)
      expect(iocText).toMatch(/^ProjectManager\.ProjectName=Lab1$/m)
      expect(iocText).toMatch(/^Mcu\.UserName=STM32F746IGTx$/m)
    })

    it("builds for the board's chip with the build service's defines, every header folder and the flash script", () => {
      expect(cproject).not.toContain("{{")
      expect(cproject).toContain('value="STM32F746IGTx"')
      expect(cproject).toContain("fpu.value.fpv5-sp-d16")
      expect(listed(cproject, "c.compiler.option.definedsymbols")).toEqual(["DEBUG", "STM32F746xx", "USE_HAL_DRIVER", "HSE_VALUE=8000000"])
      expect(listed(cproject, "cpp.compiler.option.definedsymbols")).toEqual(["DEBUG", "STM32F746xx", "USE_HAL_DRIVER", "HSE_VALUE=8000000"])
      const includes = ["../App/Inc", "../Core/Inc", "../Drivers/STM32F7xx_HAL_Driver/Inc", "../Drivers/STM32F7xx_HAL_Driver/Inc/Legacy", "../Drivers/CMSIS/Device/ST/STM32F7xx/Include", "../Drivers/CMSIS/Include"]
      expect(listed(cproject, "c.compiler.option.includepaths")).toEqual(includes)
      expect(listed(cproject, "cpp.compiler.option.includepaths")).toEqual(includes)
      expect(cproject.match(/\$\{workspace_loc:\/\$\{ProjName\}\/STM32F746IGTX_FLASH\.ld\}/g)).toHaveLength(6)
      expect([...cproject.matchAll(/kind="sourcePath" name="([^"]*)"/g)].map((m) => m[1])).toEqual(["App", "Core", "Drivers", "App", "Core", "Drivers"])
    })

    it("brings ST's HAL and CMSIS where CubeMX puts them, and what the build service adds that the project lacks", () => {
      const all = paths(exported)
      expect(all).toContain("Drivers/STM32F7xx_HAL_Driver/Src/stm32f7xx_hal.c")
      expect(all).toContain("Drivers/STM32F7xx_HAL_Driver/Inc/Legacy/stm32_hal_legacy.h")
      expect(all).toContain("Drivers/CMSIS/Device/ST/STM32F7xx/Include/stm32f746xx.h")
      expect(all).toContain("Drivers/CMSIS/Include/core_cm7.h")
      expect(all).toContain("Core/Src/syscalls.c")
      expect(all.filter((p) => /startup_/.test(p))).toEqual(["Core/Startup/startup_stm32f746igtx.s"])
      expect(all.filter((p) => p.endsWith("stm32f7xx_it.c")), "the project's own, not the service's as well").toEqual(["Core/Src/stm32f7xx_it.c"])
      expect(all.filter((p) => p.startsWith("Drivers/STM32F4"))).toEqual([])
    })

    it("tells the files apart as UTF-8 whatever the workspace's own encoding", () => {
      expect(text(exported, ".settings/org.eclipse.core.resources.prefs")).toBe("eclipse.preferences.version=1\nencoding/<project>=UTF-8\n")
    })
  })

  it("lays a CMake project out as STM32CubeIDE would, and drops the path of the machine it came from", async () => {
    const cmakeIoc = `${ioc("lab1", "STM32F746IGTx")}\r\nProjectManager.TargetToolchain=CMake\r\nProjectManager.ToolChainLocation=C:\\\\Users\\\\student\\\\lab1\\\\\r\nMxCube.Version=6.18.1\r\n`
    const imported = await readCubeProject([
      entry("lab1/lab1.ioc", cmakeIoc),
      entry("lab1/startup_stm32f746xx.s", ".syntax unified"),
      entry("lab1/STM32F746xx_FLASH.ld", "MEMORY {}"),
      entry("lab1/Core/Src/main.c", "int main(void) { for (;;); }"),
      entry("lab1/Core/Inc/main.h", "#pragma once"),
    ])
    const exported = await exportOf(imported.files)
    expect(paths(exported).filter((p) => !p.startsWith("Drivers/") && !p.startsWith("Core/Src/") && !p.startsWith("Core/Inc/"))).toEqual([
      ".cproject",
      ".project",
      ".settings/org.eclipse.core.resources.prefs",
      "Core/Startup/startup_stm32f746igtx.s",
      "STM32F746IGTX_FLASH.ld",
      "lab1.ioc",
    ])
    const iocText = text(exported, "lab1.ioc")
    expect(iocText.match(/^ProjectManager\.TargetToolchain=.*$/gm), "one toolchain, the IDE's").toEqual(["ProjectManager.TargetToolchain=STM32CubeIDE"])
    expect(iocText.match(/^ProjectManager\.ToolChainLocation=.*$/gm)).toEqual(["ProjectManager.ToolChainLocation="])
    expect(iocText).not.toContain("student")
    expect(exported.cubeMxVersion).toBe("6.18.1")
    expect(text(exported, "Core/Startup/startup_stm32f746igtx.s")).toBe(".syntax unified")
  })

  it("moves the files CubeMX keeps in STM32CubeIDE/ to the project's root layout", async () => {
    const exported = await exportOf([
      { path: "ide.ioc", content: ioc("ide", "STM32F746IGTx") },
      { path: "Core/Src/main.c", content: "int main(void) { for (;;); }" },
      { path: "STM32CubeIDE/Application/User/Core/syscalls.c", content: "int own_write;" },
      { path: "STM32CubeIDE/Application/User/Startup/startup_stm32f746igtx.s", content: ".syntax unified" },
      { path: "STM32CubeIDE/STM32F746IGTX_FLASH.ld", content: "MEMORY {}" },
    ])
    const all = paths(exported)
    expect(all.filter((p) => p.startsWith("STM32CubeIDE/"))).toEqual([])
    expect(text(exported, "Core/Src/syscalls.c")).toBe("int own_write;")
    expect(text(exported, "STM32F746IGTX_FLASH.ld")).toBe("MEMORY {}")
    expect(all.filter((p) => /startup_/.test(p))).toEqual(["Core/Startup/startup_stm32f746igtx.s"])
  })

  it("never writes two files to one path when a rename lands on another file's name", async () => {
    const exported = await exportOf([
      ...template("stm32f746ig"),
      { path: "boot/BOOT_FLASH.ld", content: "MEMORY { FLASH : ORIGIN = 0x08000000 }" },
      { path: "STM32CubeIDE/STM32F746IGTX_FLASH.ld", content: "MEMORY { FLASH : ORIGIN = 0x08008000 }" },
    ])
    const all = exported.entries.map((e) => e.path)
    expect(new Set(all).size).toBe(all.length)
    expect(text(exported, "STM32F746IGTX_FLASH.ld")).toBe("MEMORY { FLASH : ORIGIN = 0x08000000 }")
    expect(text(exported, "STM32CubeIDE/STM32F746IGTX_FLASH.ld")).toBe("MEMORY { FLASH : ORIGIN = 0x08008000 }")
  })

  it("makes a project with no .ioc whole from the build service's files: a Nucleo's template", async () => {
    const exported = await exportOf(template("stm32f429zi"), { name: "Nucleo blink", target: "stm32f429zi" })
    const cproject = text(exported, ".cproject")
    expect(exported.name).toBe("Nucleo_blink")
    expect(exported.cubeMxVersion).toBeNull()
    expect(text(exported, ".project")).not.toContain("MCUCubeProjectNature")
    expect(text(exported, ".project")).not.toContain("ccnature")
    expect(cproject).toContain('value="STM32F429ZITx"')
    expect(cproject).toContain("fpu.value.fpv4-sp-d16")
    expect(listed(cproject, "c.compiler.option.definedsymbols")).toEqual(["DEBUG", "STM32F429xx", "USE_HAL_DRIVER", "HSE_VALUE=8000000"])
    expect(paths(exported).filter((p) => p.startsWith("Core/") || p.endsWith(".ld"))).toEqual([
      "Core/Inc/main.h",
      "Core/Inc/stm32f4xx_hal_conf.h",
      "Core/Inc/stm32f4xx_it.h",
      "Core/Src/main.c",
      "Core/Src/stm32f4xx_hal_msp.c",
      "Core/Src/stm32f4xx_it.c",
      "Core/Src/syscalls.c",
      "Core/Src/system_stm32f4xx.c",
      "Core/Startup/startup_stm32f429zitx.s",
      "STM32F429ZITX_FLASH.ld",
    ])
  })

  it("carries the board's optimization into the Debug build, and compiles the whole project when a source sits at its top", async () => {
    const files = [...template("stm32f746ig"), { path: "texture.c", content: "const char texture[] = {0};" }]
    const o2 = text(await exportOf(files, { opt: "-O2" }), ".cproject")
    expect(o2).toContain('value="com.st.stm32cube.ide.mcu.gnu.managedbuild.tool.c.compiler.option.optimization.level.value.o2"')
    expect(o2).toContain('value="com.st.stm32cube.ide.mcu.gnu.managedbuild.tool.cpp.compiler.option.optimization.level.value.o2"')
    expect([...o2.matchAll(/kind="sourcePath" name="([^"]*)"/g)].map((m) => m[1])).toEqual(["", ""])
    const o0 = text(await exportOf(files), ".cproject")
    expect(o0).not.toContain("optimization.level.value.o0")
  })

  it("names a project with no .ioc after the bench, in letters every STM32CubeIDE takes", async () => {
    expect((await exportOf(template("stm32f746ig"), { name: "Лаба 2: біжучий вогник" })).name).toBe("Laba_2_bizhuchyi_vohnyk")
    expect((await exportOf(template("stm32f746ig"), { name: "lab1.v2" })).name).toBe("lab1_v2")
  })

  it("gives the assembler the include paths and defines too, and searches a board support package's headers", async () => {
    const files = [...template("stm32f746ig"), { path: "Drivers/BSP/Custom/board.h", content: "#pragma once" }, { path: "Core/Src/delay.S", content: '#include "main.h"' }]
    const cproject = text(await exportOf(files), ".cproject")
    const includes = listed(cproject, "c.compiler.option.includepaths")
    expect(includes).toContain("../Drivers/BSP/Custom")
    expect(listed(cproject, "assembler.option.includepaths")).toEqual(includes)
    expect(listed(cproject, "assembler.option.definedsymbols")).toEqual(["DEBUG", "STM32F746xx", "USE_HAL_DRIVER", "HSE_VALUE=8000000"])
    expect(cproject.match(/assembler\.option\.includepaths\.\d+/g)).toHaveLength(2)
  })

  it("says so when the site has no copy of ST's drivers to pack", async () => {
    await expect(cubeIdeProject({ name: "x", target: "stm32f746ig", files: template("stm32f746ig"), opt: "-O0", site: { files: [], read: async () => new Uint8Array() } })).rejects.toThrow(
      "ST drivers are missing on this site",
    )
  })
})
