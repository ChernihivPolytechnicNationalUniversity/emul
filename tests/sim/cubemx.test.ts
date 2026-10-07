import { crc32 } from "node:zlib"
import { describe, expect, it } from "vitest"
import { SOURCE_LIMITS } from "emul-shared/source"
import { readZip, writeZip } from "@/lib/zip"
import { cubeBench, importNotes, parseIoc, readCubeProject, unsupportedChip } from "@/project/cubemx"
import { mainFile } from "@/project/files"
import { GRID } from "@/schematic/geometry"
import { battery, cubeIdeFolder, entry, ioc } from "../lib/cubemx"
import { zip } from "../lib/zip"

describe("a CubeMX project opened in the editor", () => {
  describe("the STM32CubeIDE layout, as CubeMX generates it, inside its folder", async () => {
    const project = await readCubeProject(cubeIdeFolder())
    const paths = project.files.map((f) => f.path)

    it("is named and placed by its .ioc", () => {
      expect(project.name).toBe("Lab1")
      expect(project.mcu).toBe("STM32F746IGTx")
      expect(project.target).toBe("stm32f746ig")
    })

    it("keeps the sources, the startup file and the flash linker script, relative to the .ioc", () => {
      expect(paths).toContain("Core/Src/main.c")
      expect(paths).toContain("Core/Inc/stm32f7xx_hal_conf.h")
      expect(paths).toContain("App/Src/lab1.cpp")
      expect(paths).toContain("Core/Startup/startup_stm32f746igtx.s")
      expect(paths).toContain("STM32F746IGTX_FLASH.ld")
    })

    it("leaves out ST's HAL and CMSIS, the build output, the RAM linker script and the IDE's files", () => {
      expect(paths.filter((p) => p.startsWith("Drivers/"))).toEqual([])
      expect(paths.filter((p) => p.startsWith("Debug/"))).toEqual([])
      expect(paths).not.toContain("STM32F746IGTX_RAM.ld")
      expect(paths.filter((p) => !/\.(c|cpp|h|s|ld)$/.test(p))).toEqual(["Lab1.ioc"])
      expect(project.vendorFiles).toBe(4)
      expect(project.refused).toEqual([])
      expect(importNotes(project, "stm32f746ig")).toEqual(["ST's HAL and CMSIS (4 files) stay out: the build service compiles its own."])
    })

    it("turns Windows line endings into the editor's", () => {
      const conf = project.files.find((f) => f.path === "Core/Inc/stm32f7xx_hal_conf.h")!
      expect(conf.content).not.toContain("\r")
      expect(conf.content).toBe(battery("stm32f7xx_hal_conf.h"))
    })

    it("opens on main.c", () => {
      expect(mainFile(project.files)).toBe("Core/Src/main.c")
    })

    it("becomes a bench of its own: the Open746I-C carrying the files, nothing precompiled", () => {
      const { doc, board } = cubeBench({ ...project, target: "stm32f746ig" }, GRID)
      expect(doc.objects).toHaveLength(1)
      expect(board.def).toBe("open746i-c")
      expect(board.props?.ref).toBe("U1")
      expect(board.project).toBe(project.files)
      expect(board.props?.firmwareData).toBeUndefined()
    })
  })

  it("takes the CMake layout and leaves its build tree and CMake files out", async () => {
    const project = await readCubeProject([
      entry("lab1/lab1.ioc", ioc("lab1", "STM32F746IGTx")),
      entry("lab1/CMakeLists.txt", "cmake_minimum_required(VERSION 3.22)"),
      entry("lab1/CMakePresets.json", "{}"),
      entry("lab1/cmake/stm32cubemx/CMakeLists.txt", "add_library(stm32cubemx INTERFACE)"),
      entry("lab1/cmake/gcc-arm-none-eabi.cmake", "set(CMAKE_SYSTEM_NAME Generic)"),
      entry("lab1/build/Debug/CMakeFiles/4.0.0/CompilerIdC/CMakeCCompilerId.c", "#error not a source of the project"),
      entry("lab1/startup_stm32f746xx.s", battery("startup_stm32f746xx.s")),
      entry("lab1/STM32F746XX_FLASH.ld", battery("STM32F746IGTX_FLASH.ld")),
      entry("lab1/Core/Src/main.c", "int main(void) { for (;;); }"),
    ])
    expect(project.files.map((f) => f.path)).toEqual(["Core/Src/main.c", "lab1.ioc", "startup_stm32f746xx.s", "STM32F746XX_FLASH.ld"])
  })

  it("tells the chip from the startup file when there is no .ioc, and names the project after its folder", async () => {
    const project = await readCubeProject([
      entry("blink/Makefile", "TARGET = blink"),
      entry("blink/startup_stm32f429xx.s", ".syntax unified"),
      entry("blink/Src/main.c", "int main(void) { for (;;); }"),
      entry("blink/Inc/main.h", "#pragma once"),
    ])
    expect(project.name).toBe("blink")
    expect(project.target).toBe("stm32f429zi")
    expect(importNotes(project, "stm32f429zi")).toEqual([])
    expect(mainFile(project.files)).toBe("Src/main.c")
    expect(cubeBench({ ...project, target: "stm32f429zi" }, GRID).board.def).toBe("nucleo-f429zi")
  })

  it("opens the shallowest .ioc's project and leaves out another project kept inside it", async () => {
    const project = await readCubeProject([...cubeIdeFolder("Laba2"), ...cubeIdeFolder("Laba2/backup/Old")])
    expect(project.name).toBe("Laba2")
    expect(project.files.some((f) => f.path.startsWith("backup/"))).toBe(false)
  })

  it("says so when the part is another package of the board's chip", async () => {
    const project = await readCubeProject(cubeIdeFolder("Disco", "STM32F746NGHx"))
    expect(project.target).toBe("stm32f746ig")
    expect(importNotes(project, "stm32f746ig")[0]).toBe(
      "Generated for STM32F746NGHx; it runs on the board's STM32F746IGT6: the same core and peripherals, but a pin the STM32F746IGT6 does not have does nothing.",
    )
  })

  it("refuses a chip that is not emulated, naming the ones that are", async () => {
    const project = await readCubeProject(cubeIdeFolder("STM32F767ZI_ADC", "STM32F767ZITx"))
    expect(project.target).toBeNull()
    expect(unsupportedChip(project)).toEqual({
      title: "STM32F767ZITx is not emulated",
      description: "εmul runs the STM32F429ZIT6 (Nucleo-144) and the STM32F746IGT6 (Open746I-C).",
    })
  })

  it("lists the files it cannot hold instead of dropping them quietly", async () => {
    const project = await readCubeProject([
      entry("p/p.ioc", ioc("p", "STM32F746IGTx")),
      entry("p/Core/Src/main.c", "int main(void) { for (;;); }"),
      entry("p/Core/Src/main - Copy.c", "int main(void) { for (;;); }"),
      entry("p/Core/Inc/LEGACY.H", "#pragma once"),
      entry("p/Core/Src/font.c", "const char font[] = {0};", SOURCE_LIMITS.fileBytes + 1),
      entry("p/a/b/c/d/e/f/g/h/deep.c", "int deep;"),
    ])
    expect(project.files.map((f) => f.path)).toEqual(["Core/Src/main.c", "p.ioc"])
    expect(project.refused).toEqual([
      { path: "a/b/c/d/e/f/g/h/deep.c", why: "more than 8 folders deep" },
      { path: "Core/Inc/LEGACY.H", why: "a name of other than letters, digits, . _ - or a source extension" },
      { path: "Core/Src/font.c", why: "over 1 MB" },
      { path: "Core/Src/main - Copy.c", why: "a name of other than letters, digits, . _ - or a source extension" },
    ])
    expect(importNotes(project, "stm32f746ig")).toEqual([
      "Not imported: a/b/c/d/e/f/g/h/deep.c (more than 8 folders deep); Core/Inc/LEGACY.H (a name of other than letters, digits, . _ - or a source extension); Core/Src/font.c (over 1 MB); 1 more.",
    ])
  })

  it("refuses a project over the file limit, and a folder with nothing to build", async () => {
    const many = Array.from({ length: SOURCE_LIMITS.files + 1 }, (_, i) => entry(`big/Core/Src/f${i}.c`, `int f${i};`))
    await expect(readCubeProject([entry("big/big.ioc", ioc("big", "STM32F746IGTx")), ...many])).rejects.toThrow(
      `big has ${SOURCE_LIMITS.files + 1} source files besides ST's drivers; a project holds at most ${SOURCE_LIMITS.files}`,
    )
    await expect(readCubeProject([entry("d/d.ioc", ioc("d", "STM32F746IGTx")), entry("d/Drivers/CMSIS/Include/core_cm7.h")])).rejects.toThrow(
      "d has only ST's drivers, no sources of its own",
    )
    await expect(readCubeProject([entry("docs/readme.pdf"), entry("docs/notes.docx")])).rejects.toThrow("No C or C++ sources here")
    await expect(readCubeProject([])).rejects.toThrow("The folder is empty")
  })

  it("reads the .ioc as CubeMX writes it: escapes, comments, CRLF", () => {
    const keys = parseIoc("#comment\r\nProjectManager.ProjectName=lab\\:1\r\nMcu.UserName=STM32F746IGTx\r\nbroken line\r\n")
    expect(keys.get("ProjectManager.ProjectName")).toBe("lab:1")
    expect(keys.get("Mcu.UserName")).toBe("STM32F746IGTx")
    expect(keys.size).toBe(2)
  })

  describe("from a .zip", () => {
    it("reads stored and deflated entries, sizes after the data (as Eclipse writes them), and skips folders", async () => {
      const text = "int main(void)\r\n{\r\n  for (;;);\r\n}\r\n".repeat(50)
      const entries = readZip(
        zip([
          { path: "Lab1/" },
          { path: "Lab1/Core/" },
          { path: "Lab1/Core/Src/main.c", content: text, deflate: true },
          { path: "Lab1/Core/Inc/main.h", content: "#pragma once\n" },
          { path: "Lab1/Core/Src/gpio.c", content: text, deflate: true, dataDescriptor: true },
          { path: "Lab1/Debug/Lab1.elf", content: new Uint8Array(4096), deflate: true, dataDescriptor: true },
        ]),
      )
      expect(entries.map((e) => [e.path, e.size])).toEqual([
        ["Lab1/Core/Src/main.c", text.length],
        ["Lab1/Core/Inc/main.h", 13],
        ["Lab1/Core/Src/gpio.c", text.length],
        ["Lab1/Debug/Lab1.elf", 4096],
      ])
      const decode = async (e: (typeof entries)[number]) => new TextDecoder().decode(await e.read())
      expect(await decode(entries[0]!)).toBe(text)
      expect(await decode(entries[1]!)).toBe("#pragma once\n")
      expect(await decode(entries[2]!)).toBe(text)
    })

    it("opens a zipped CubeIDE project the same as its folder", async () => {
      const folder = cubeIdeFolder()
      const archive = zip(await Promise.all(folder.map(async (e, i) => ({ path: e.path, content: await e.read(), deflate: i % 2 === 0, dataDescriptor: i % 3 === 0 }))))
      const fromZip = await readCubeProject(readZip(archive))
      const fromFolder = await readCubeProject(folder)
      expect(fromZip).toEqual(fromFolder)
    })

    it("writes a zip its own reader reads back: names, contents deflated where that is smaller, a CRC per entry, the time it was made", async () => {
      const made = new Date(2026, 9, 7, 17, 42, 30)
      const main = "int main(void)\r\n{\r\n  for (;;);\r\n}\r\n".repeat(40)
      const archive = await writeZip([{ path: "Core/Src/main.c", content: main }, { path: "Core/Inc/ü.h", content: new Uint8Array([0, 255, 7]) }], made)
      const entries = readZip(archive)
      expect(entries.map((e) => [e.path, e.size])).toEqual([["Core/Src/main.c", main.length], ["Core/Inc/ü.h", 3]])
      expect(new TextDecoder().decode(await entries[0]!.read())).toBe(main)
      expect([...(await entries[1]!.read())]).toEqual([0, 255, 7])
      const view = new DataView(archive.buffer)
      expect(view.getUint16(8, true), "main.c deflated").toBe(8)
      expect(view.getUint32(14, true), "CRC-32 of main.c, as zlib has it").toBe(crc32(main))
      expect(view.getUint32(18, true), "main.c packed smaller").toBeLessThan(main.length / 10)
      expect(view.getUint16(10, true), "17:42:30").toBe((17 << 11) | (42 << 5) | 15)
      expect(view.getUint16(12, true), "2026-10-07").toBe((46 << 9) | (10 << 5) | 7)
      const second = 30 + "Core/Src/main.c".length + view.getUint32(18, true)
      expect(view.getUint16(second + 8, true), "three bytes stored as they are").toBe(0)
    })

    it("refuses an entry that inflates past the size the archive gives it", async () => {
      const archive = zip([{ path: "p/Core/Src/main.c", content: "x".repeat(10_000), deflate: true }])
      new DataView(archive.buffer).setUint32(archive.length - 22 - 46 - "p/Core/Src/main.c".length + 24, 10, true)
      await expect(readZip(archive)[0]!.read()).rejects.toThrow("holds more than the archive says")
    })

    it("refuses an entry whose contents do not match its checksum", async () => {
      const archive = zip([{ path: "p/Core/Src/main.c", content: "int x = 0;" }])
      archive[30 + "p/Core/Src/main.c".length + 8] = "9".charCodeAt(0)
      await expect(readZip(archive)[0]!.read()).rejects.toThrow("does not match its checksum")
    })

    it("refuses what is not a zip", () => {
      expect(() => readZip(new TextEncoder().encode("not an archive at all, just some text"))).toThrow("not a zip archive")
    })
  })

  describe("the layouts STM32CubeMX writes for each toolchain", () => {
    const core = (root: string) => [
      entry(`${root}/${root}.ioc`, ioc(root, "STM32F746IGTx")),
      entry(`${root}/Core/Src/main.c`, "int main(void) { for (;;); }"),
      entry(`${root}/Core/Inc/main.h`, "#pragma once"),
    ]

    it("leaves out the IAR and Keil startup files of an EWARM or MDK-ARM project, so the build service's GNU one is used", async () => {
      const ewarm = await readCubeProject([...core("ewarm"), entry("ewarm/EWARM/startup_stm32f746xx.s", "  SECTION CSTACK:DATA:NOROOT(3)"), entry("ewarm/EWARM/stm32f746xx_flash.icf", "")])
      const mdk = await readCubeProject([...core("mdk"), entry("mdk/MDK-ARM/startup_stm32f746xx.s", "Stack_Size EQU 0x400"), entry("mdk/MDK-ARM/mdk.uvprojx", "")])
      expect(ewarm.files.map((f) => f.path)).toEqual(["Core/Inc/main.h", "Core/Src/main.c", "ewarm.ioc"])
      expect(mdk.files.map((f) => f.path)).toEqual(["Core/Inc/main.h", "Core/Src/main.c", "mdk.ioc"])
    })

    it("takes the STM32CubeIDE layout CubeMX puts in a STM32CubeIDE/ folder", async () => {
      const project = await readCubeProject([
        ...core("ide"),
        entry("ide/STM32CubeIDE/.project", "<projectDescription/>"),
        entry("ide/STM32CubeIDE/Application/User/Startup/startup_stm32f746igtx.s", ".syntax unified"),
        entry("ide/STM32CubeIDE/Application/User/Core/syscalls.c", "int _write;"),
        entry("ide/STM32CubeIDE/STM32F746IGTX_FLASH.ld", "MEMORY {}"),
        entry("ide/STM32CubeIDE/STM32F746IGTX_RAM.ld", "MEMORY {}"),
      ])
      expect(project.files.map((f) => f.path)).toEqual([
        "Core/Inc/main.h",
        "Core/Src/main.c",
        "ide.ioc",
        "STM32CubeIDE/Application/User/Core/syscalls.c",
        "STM32CubeIDE/Application/User/Startup/startup_stm32f746igtx.s",
        "STM32CubeIDE/STM32F746IGTX_FLASH.ld",
      ])
    })

    it("refuses a folder that holds several projects side by side, and takes the .ioc named after its folder when one holds two", async () => {
      await expect(readCubeProject([...core("Alpha"), ...core("Beta")])).rejects.toThrow("There are 2 STM32 projects here (Alpha, Beta): pick the folder of one of them")
      const two = await readCubeProject([entry("Lab1/Lab1_old.ioc", ioc("Lab1_old", "STM32F429ZITx")), ...core("Lab1")])
      expect([two.name, two.mcu]).toEqual(["Lab1", "STM32F746IGTx"])
    })

    it("reads a source saved in windows-1251 as Cyrillic", async () => {
      const cp1251 = Uint8Array.from([0x2f, 0x2a, 0x20, 0xcb, 0xe0, 0xe1, 0xe0, 0x20, 0x2a, 0x2f])
      const project = await readCubeProject([...core("cp"), entry("cp/Core/Src/lab.c", cp1251)])
      expect(project.files.find((f) => f.path === "Core/Src/lab.c")!.content).toBe("/* Лаба */")
    })

    it("builds what the STM32CubeIDE project builds: its source folders, without the files it excludes", async () => {
      const cproject = `<cproject><sourceEntries>
\t<entry excluding="Third_Party/FreeRTOS/Source/portable/MemMang/heap_1.c|Third_Party/FreeRTOS/Source/portable/MemMang/heap_2.c" flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Middlewares"/>
\t<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Core"/>
\t<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Drivers"/>
</sourceEntries></cproject>`
      const heap = "rtos/Middlewares/Third_Party/FreeRTOS/Source/portable/MemMang"
      const project = await readCubeProject([
        ...core("rtos"),
        entry("rtos/.cproject", cproject),
        entry(`${heap}/heap_1.c`, "void *pvPortMalloc;"),
        entry(`${heap}/heap_2.c`, "void *pvPortMalloc;"),
        entry(`${heap}/heap_4.c`, "void *pvPortMalloc;"),
        entry("rtos/Tests/test_main.c", "int main(void) { return 0; }"),
        entry("rtos/Tests/test.h", "#pragma once"),
      ])
      expect(project.files.map((f) => f.path)).toEqual([
        "Core/Inc/main.h",
        "Core/Src/main.c",
        "Middlewares/Third_Party/FreeRTOS/Source/portable/MemMang/heap_4.c",
        "rtos.ioc",
        "Tests/test.h",
      ])
      expect(project.notBuilt).toEqual([
        "Middlewares/Third_Party/FreeRTOS/Source/portable/MemMang/heap_1.c",
        "Middlewares/Third_Party/FreeRTOS/Source/portable/MemMang/heap_2.c",
        "Tests/test_main.c",
      ])
      expect(importNotes(project, "stm32f746ig")[0]).toBe(
        "Left out, as the STM32CubeIDE project does not build them: Middlewares/Third_Party/FreeRTOS/Source/portable/MemMang/heap_1.c, Middlewares/Third_Party/FreeRTOS/Source/portable/MemMang/heap_2.c, Tests/test_main.c.",
      )
    })

    it("refuses an .ioc over the size of a source before reading it", async () => {
      const huge = { path: "big/big.ioc", size: 50 * 1024 * 1024, read: async () => { throw new Error("read") } }
      await expect(readCubeProject([huge, entry("big/Core/Src/main.c", "int main;")])).rejects.toThrow("big/big.ioc is over 1 MB")
    })
  })
})
