import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import type { ProjectEntry } from "@/project/cubemx"
import { FIRMWARE } from "./firmware"

const LAB = join(FIRMWARE, "lab1-running-light")
const TARGETS = join(FIRMWARE, "..", "backend", "worker", "targets")

export const CPROJECT = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<?fileVersion 4.0.0?><cproject storage_type_id="org.eclipse.cdt.core.XmlProjectDescriptionStorage">
	<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="false" name="Include paths (-I)" valueType="includePath">
		<listOptionValue builtIn="false" value="../Core/Inc"/>
		<listOptionValue builtIn="false" value="../App/Inc"/>
		<listOptionValue builtIn="false" value="../Drivers/STM32F7xx_HAL_Driver/Inc"/>
		<listOptionValue builtIn="false" value="../Drivers/CMSIS/Include"/>
	</option>
	<option IS_BUILTIN_EMPTY="false" IS_VALUE_EMPTY="false" name="Define symbols (-D)" valueType="definedSymbols">
		<listOptionValue builtIn="false" value="USE_HAL_DRIVER"/>
	</option>
	<sourceEntries>
		<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="App"/>
		<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Core"/>
		<entry flags="VALUE_WORKSPACE_PATH|RESOLVED" kind="sourcePath" name="Drivers"/>
	</sourceEntries>
</cproject>
`

export const ioc = (name: string, mcu: string) =>
  [
    "#MicroXplorer Configuration settings - do not modify",
    "File.Version=6",
    `Mcu.CPN=${mcu.replace(/x$/, "6")}`,
    "Mcu.Family=STM32F7",
    `Mcu.Name=${mcu}`,
    `Mcu.UserName=${mcu}`,
    `ProjectManager.ProjectName=${name}`,
    "ProjectManager.TargetToolchain=STM32CubeIDE",
    "PH0-OSC_IN.Mode=HSE-External-Oscillator",
    "board=custom",
  ].join("\r\n")

export const entry = (path: string, content: string | Uint8Array = "", size?: number): ProjectEntry => {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content
  return { path, size: size ?? bytes.length, read: async () => bytes }
}

function tree(dir: string, prefix: string): ProjectEntry[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => entry(`${prefix}/${relative(dir, join(d.parentPath, d.name)).replace(/\\/g, "/")}`, readFileSync(join(d.parentPath, d.name))))
}

export const battery = (name: string) => readFileSync(join(TARGETS, "stm32f746ig", name), "utf8")

export function cubeIdeFolder(root = "Lab1", mcu = "STM32F746IGTx"): ProjectEntry[] {
  const name = root.slice(root.lastIndexOf("/") + 1)
  return [
    entry(`${root}/${name}.ioc`, ioc(name, mcu)),
    entry(`${root}/.project`, "<projectDescription/>"),
    entry(`${root}/.cproject`, CPROJECT),
    entry(`${root}/.mxproject`, "[PreviousGenFiles]"),
    entry(`${root}/.settings/language.settings.xml`, "<project/>"),
    entry(`${root}/${name} Debug.launch`, "<launchConfiguration/>"),
    ...tree(join(LAB, "Core"), `${root}/Core`),
    ...tree(join(LAB, "App"), `${root}/App`),
    entry(`${root}/Core/Inc/stm32f7xx_hal_conf.h`, battery("stm32f7xx_hal_conf.h").replace(/\n/g, "\r\n")),
    entry(`${root}/Core/Src/system_stm32f7xx.c`, battery("system_stm32f7xx.c")),
    entry(`${root}/Core/Startup/startup_stm32f746igtx.s`, battery("startup_stm32f746xx.s")),
    entry(`${root}/STM32F746IGTX_FLASH.ld`, battery("STM32F746IGTX_FLASH.ld")),
    entry(`${root}/STM32F746IGTX_RAM.ld`, battery("STM32F746IGTX_FLASH.ld").replace(/>\s*ROM/g, ">RAM")),
    entry(`${root}/Drivers/STM32F7xx_HAL_Driver/Src/stm32f7xx_hal.c`, "#error the build service brings its own HAL"),
    entry(`${root}/Drivers/STM32F7xx_HAL_Driver/Inc/stm32f7xx_hal.h`, "#error the build service brings its own HAL"),
    entry(`${root}/Drivers/STM32F7xx_HAL_Driver/LICENSE.txt`, "BSD-3-Clause"),
    entry(`${root}/Drivers/CMSIS/Include/core_cm7.h`, "#error the build service brings its own CMSIS"),
    entry(`${root}/Drivers/CMSIS/Device/ST/STM32F7xx/Include/stm32f746xx.h`, "#error the build service brings its own CMSIS"),
    entry(`${root}/Debug/makefile`, "all: Lab1.elf"),
    entry(`${root}/Debug/Core/Src/main.o`, new Uint8Array([0x7f, 0x45, 0x4c, 0x46])),
    entry(`${root}/Debug/Core/Src/subdir.mk`, "C_SRCS += ../Core/Src/main.c"),
    entry(`${root}/Debug/${name}.elf`, new Uint8Array([0x7f, 0x45, 0x4c, 0x46])),
  ]
}

