import type { SourceFile } from "emul-shared/source"

/**
 * The example firmware as source projects, straight from `firmware/`: an example places a
 * board and hands it these files, the student reads them in the editor and hits Compile.
 * Each loader is a dynamic import, so no example's sources come with the page.
 */
export type ProjectLoader = () => Promise<SourceFile[]>

// Vite reads these options at build time, so they are spelled out at each glob. Outside Vite
// (the test scripts under tsx import the examples too) the call throws: then there is no code
// to load, which those scripts never ask for. (`typeof import.meta.glob` is no test: a built
// bundle has the calls replaced and the property gone.)
type Raw = Record<string, () => Promise<string>>
const glob = (load: () => Raw): Raw => {
  try {
    return load()
  } catch {
    return {}
  }
}

const halApps = glob(() => import.meta.glob("../../firmware/hal/Src/{main,square,pwm,uart,i2c,adc,spi,spi-slave}.c", { query: "?raw", import: "default" }) as Raw)
const lab1 = glob(() => import.meta.glob("../../firmware/lab1/Core/{Inc,Src}/*.{c,h}", { query: "?raw", import: "default" }) as Raw)
const lab1RunningLightFiles = glob(() => import.meta.glob("../../firmware/lab1-running-light/{Core,App}/{Inc,Src}/*.{c,cpp,h}", { query: "?raw", import: "default" }) as Raw)
const lcd = glob(() => import.meta.glob("../../firmware/lcd/{display,touch,cube}/{Src,Inc,BSP,Fonts}/*.{c,cpp,h}", { query: "?raw", import: "default" }) as Raw)
const cubeTexture = glob(() => import.meta.glob("../../firmware/lcd/cube/texture.c", { query: "?raw", import: "default" }) as Raw)
const retarget = glob(() => import.meta.glob("../../firmware/lcd/retarget.c", { query: "?raw", import: "default" }) as Raw)

const MAIN_H = '#ifndef MAIN_H\n#define MAIN_H\n\n#include "stm32f4xx_hal.h"\n\n#endif /* MAIN_H */\n'

/** One of the Nucleo HAL apps, laid out as CubeIDE would: the app as `Core/Src/main.c`. */
export const nucleoApp =
  (name: string): ProjectLoader =>
  async () => {
    const load = halApps[`../../firmware/hal/Src/${name}.c`]
    if (!load) throw new Error(`no such firmware app: ${name}`)
    return [
      { path: "Core/Inc/main.h", content: MAIN_H },
      { path: "Core/Src/main.c", content: await load() },
    ]
  }

/** Files of a glob under `prefix`, with the rest of each path kept as the project's. */
async function under(files: Raw, prefix: string): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  for (const [key, load] of Object.entries(files)) {
    if (!key.startsWith(prefix)) continue
    out.push({ path: key.slice(prefix.length), content: await load() })
  }
  return out
}

/** The lab's CubeIDE project (`firmware/lab1`), Core/ only. */
export const lab1Project: ProjectLoader = () => under(lab1, "../../firmware/lab1/")

/** The lab as completed for variant 1 (`firmware/lab1-running-light`): the CubeMX Core/ and the App/ that drives it. */
export const lab1RunningLightProject: ProjectLoader = () => under(lab1RunningLightFiles, "../../firmware/lab1-running-light/")

/**
 * One of the Open746I-C demos (`firmware/lcd/<name>`) with printf retargeted to USART1; the
 * demo's own hal_conf.h stays home, the build service's has every module on.
 */
export const lcdProject = (name: "display" | "touch" | "cube"): ProjectLoader => async () => {
  const files = (await under(lcd, `../../firmware/lcd/${name}/`)).filter((f) => !f.path.endsWith("stm32f7xx_hal_conf.h"))
  files.push({ path: "Src/retarget.c", content: await retarget["../../firmware/lcd/retarget.c"]!() })
  if (name === "cube") files.push({ path: "texture.c", content: await cubeTexture["../../firmware/lcd/cube/texture.c"]!() })
  return files
}
