import { STM32F401CC, STM32F401CE, STM32F405RG, STM32F407VG, STM32F411CE, STM32F429ZI, STM32F746IG, type ChipElectrical, type ChipProfile } from "@/mcu/chip"
import { ChipIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PinDef, PinKind } from "../types"
import { DOCS } from "../datasheets/docs"
import type { Claim, Datasheet } from "../types"
import type { Characteristic } from "../characteristics"

/**
 * STM32 parts as bare chips: an IC symbol with every signal pin of the package brought out,
 * so a circuit is drawn around it the way a schematic does — crystal, reset, LEDs, buttons as
 * separate parts. One builder, one pin table per package; the electrical model and the
 * emulated core come from the chip profile.
 *
 * Symbol conventions: pin names inside the body, package pin numbers over the stubs, groups
 * separated by rules — supply, ground, NRST/BOOT0 and ports A–D on the left, the remaining
 * ports on the right. The VDD and VSS pads are one net each on the die, so the symbol shows a
 * single VDD and a single VSS; VDDA/VSSA, VBAT and VDDUSB keep their own pins.
 */

/**
 * [package pin, name] for every pin of a package, in pin order. `leftPorts`: how many ports
 * (from A) the left column takes, for a package whose ports are not alike in size; without it
 * the left column gets the smaller half of the ports.
 */
type Package = { name: string; pins: [number, string][]; source: string; leftPorts?: number }

/** Body width in cells: room for two pin-name columns and the title block. */
const WIDTH = 12
/** First pin row; the title block sits above. */
const TOP = 4
/** Pin stubs are 2 cells so the package pin number fits over them. */
const STUB = 2

const PIN_NOTES: Record<string, string> = {
  PH0: "OSC_IN",
  PH1: "OSC_OUT",
  PC14: "OSC32_IN",
  PC15: "OSC32_OUT",
  PA13: "SWDIO",
  PA14: "SWCLK",
  NRST: "Reset, active low; internal pull-up",
  BOOT0: "Boot from flash while low",
}

type Group = { names: string[]; kind?: PinKind }

// Was one note: `VDD 4 V; FT pins VDD + 4 V, TTa pins (PA4, PA5) 4 V; 25 mA a pin, 3 mA on PC13, PC14, PC15, PI8;
// injected −5 mA (TTa ±5 mA)` (without pad data: `VDD 4 V, I/O pins 4 V and 25 mA`); now a note each.
function absoluteMaximum(e: ChipElectrical): Record<string, string> {
  const pads = e.pads
  if (!pads) return { "Absolute maximum": `VDD ${e.vddMax} V`, "I/O pins": `${e.pinVoltageMax} V, ${e.pinCurrentMax * 1e3} mA` }
  const mA = (amps: number) => `${amps * 1e3} mA`
  const tta = pads.tta.pads.length > 0
  return {
    "Absolute maximum": `VDD ${e.vddMax} V`,
    "FT pins": `VDD+${pads.ft.aboveVdd} V`,
    ...(tta ? { "TTa pins": `${pads.tta.pads.join("/")} ${pads.tta.voltageMax} V` } : {}),
    "Pin current": mA(e.pinCurrentMax),
    "Backup-domain pins": `${pads.backupDomain.pads.join("/")} ${mA(pads.backupDomain.currentMax)}`,
    "Injected current": `−${mA(pads.injectedCurrentMax)}${tta ? ` (TTa ±${mA(pads.injectedCurrentMax)})` : ""}`,
  }
}

export function stm32Chip(chip: ChipProfile, pkg: Package, description: string): ComponentDef {
  const byName = new Map<string, number[]>()
  for (const [n, name] of pkg.pins) byName.set(name, [...(byName.get(name) ?? []), n])
  const has = (name: string) => byName.has(name)

  const port = (letter: string): Group => ({
    names: pkg.pins
      .map(([, n]) => n)
      .filter((n) => new RegExp(`^P${letter}\\d+$`).test(n))
      .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2))),
  })
  const ports = "ABCDEFGHIJK".split("").map(port).filter((g) => g.names.length)
  // The left column also carries supply, ground and reset, so it gets the smaller half of the ports.
  const half = pkg.leftPorts ?? Math.floor(ports.length / 2)
  const left: Group[] = [
    { names: ["VDD", "VDDA", "VDDUSB", "VBAT"].filter(has), kind: "power" },
    { names: ["VSS", "VSSA"].filter(has), kind: "gnd" },
    { names: ["NRST", "BOOT0"].filter(has) },
    ...ports.slice(0, half),
  ]
  const right: Group[] = ports.slice(half)

  /** Package pin numbers drawn over the stubs, and thin rules between pin groups. */
  const decorations: BodyShape[] = []
  const column = (groups: Group[], x: number, side: "left" | "right"): PinDef[] => {
    const pins: PinDef[] = []
    const out = side === "left" ? -1 : 1
    let y = TOP
    for (const [gi, g] of groups.entries()) {
      if (gi > 0) decorations.push({ type: "path", d: `M${x} ${y - 0.5} h${out * -1.5}`, muted: true })
      for (const name of g.names) {
        const nums = byName.get(name) ?? []
        const isPort = /^P[A-K]\d+$/.test(name)
        pins.push({
          id: name,
          label: name,
          x,
          y,
          side,
          labelAt: side === "left" ? "right" : "left",
          kind: g.kind ?? "digital",
          stub: STUB,
          mcu: isPort ? name : undefined,
          connector: pkg.name,
          connectorPin: nums[0],
          note: PIN_NOTES[name] ?? (nums.length > 1 ? `all ${nums.length} ${name} pads: pins ${nums.join(", ")}` : undefined),
        })
        decorations.push({ type: "text", x: x + out * 1.1, y: y - 0.32, text: String(nums[0]), size: 0.22, muted: true })
        y++
      }
      y++
    }
    return pins
  }

  const pins: PinDef[] = [...column(left, 0, "left"), ...column(right, WIDTH, "right")]
  const height = Math.max(...pins.map((p) => p.y)) + 1

  const body: BodyShape[] = [
    { type: "rect", x: 0, y: 0, w: WIDTH, h: height, rx: 0.2, fill: "board" },
    // Pin-1 mark in the corner, as on the package.
    { type: "circle", cx: 0.8, cy: 0.8, r: 0.22, fill: "foreground" },
    { type: "text", x: WIDTH / 2, y: 1.2, text: "{ref}", size: 0.45 },
    { type: "text", x: WIDTH / 2, y: 2.05, text: chip.name, size: 0.5 },
    { type: "text", x: WIDTH / 2, y: 2.8, text: `${chip.core.name} · ${pkg.name}`, size: 0.3, muted: true },
    { type: "path", d: `M0.6 ${TOP - 0.6} H${WIDTH - 0.6}`, muted: true },
    ...decorations,
  ]

  const model: Element[] = [
    { kind: "SHORT", nodes: ["VSS", "VSSA"].filter(has) },
    { kind: "GND", node: "VSS" },
    ...mcuModel(chip, { vdd: "VDD", gnd: "VSS", nrst: has("NRST") ? "NRST" : undefined, boot0: has("BOOT0") ? "BOOT0" : undefined, pads: pins.filter((p) => p.mcu).map((p) => p.id) }),
  ]

  const e = chip.electrical
  const flash = chip.memory.find((m) => m.kind === "flash")!
  // "SRAM" as the datasheet counts it: system RAM plus CCM/DTCM, without the ITCM-RAM.
  const ram = chip.memory.filter((m) => m.kind === "ram" && m.name !== "ITCM").reduce((s, m) => s + m.size, 0)
  const kb = (bytes: number) => (bytes >= 1 << 20 ? `${bytes >> 20} MB` : `${bytes >> 10} KB`)
  return {
    id: chip.id,
    name: chip.name.replace(/[TU]6$/, ""),
    description,
    keywords: ["STM32", chip.name.slice(0, 7), chip.line === "f7" ? "Cortex-M7" : "Cortex-M4", "ARM", "MCU"],
    category: "mcus",
    icon: ChipIcon,
    prefix: "DD",
    width: WIDTH,
    height,
    body,
    pins,
    parts: [],
    model,
    hideIdle: true,
    chip: chip.id,
    mcuPower: "VDD",
    mcuReset: "NRST",
    mcuBoot0: has("BOOT0") ? "BOOT0" : undefined,
    info: {
      // MCU: `${chip.name}, ${chip.core.name}, ${kb(flash.size)} Flash, ${kb(ram)} SRAM`
      MCU: `${chip.name}, ${kb(flash.size)}/${kb(ram)}`,
      Package: pkg.name,
      ...absoluteMaximum(e),
      // Source (in the datasheet record): pkg.source
    },
  }
}

// --- packages ------------------------------------------------------------------------------
// Pin tables from the KiCad MCU_ST_STM32F4/F7 libraries, cross-checked against the ST
// datasheets' "pin and ball definitions" (Nucleo header map for the F429, the teaching
// stand's schematic for the F746; for the F405/F407 and the F411/F401 the datasheets' tables,
// read cell by cell, agree with KiCad's to the pin).

const LQFP176_F746: Package = {
  name: "LQFP176",
  source: "ST DS10916 Table 10, RM0385",
  pins: [
  [1, "PE2"], [2, "PE3"], [3, "PE4"], [4, "PE5"], [5, "PE6"], [6, "VBAT"], [7, "PI8"], [8, "PC13"],
  [9, "PC14"], [10, "PC15"], [11, "PI9"], [12, "PI10"], [13, "PI11"], [14, "VSS"], [15, "VDD"], [16, "PF0"],
  [17, "PF1"], [18, "PF2"], [19, "PF3"], [20, "PF4"], [21, "PF5"], [22, "VSS"], [23, "VDD"], [24, "PF6"],
  [25, "PF7"], [26, "PF8"], [27, "PF9"], [28, "PF10"], [29, "PH0"], [30, "PH1"], [31, "NRST"], [32, "PC0"],
  [33, "PC1"], [34, "PC2"], [35, "PC3"], [36, "VDD"], [37, "VSSA"], [38, "VREF+"], [39, "VDDA"], [40, "PA0"],
  [41, "PA1"], [42, "PA2"], [43, "PH2"], [44, "PH3"], [45, "PH4"], [46, "PH5"], [47, "PA3"], [48, "BYPASS_REG"],
  [49, "VDD"], [50, "PA4"], [51, "PA5"], [52, "PA6"], [53, "PA7"], [54, "PC4"], [55, "PC5"], [56, "PB0"],
  [57, "PB1"], [58, "PB2"], [59, "PF11"], [60, "PF12"], [61, "VSS"], [62, "VDD"], [63, "PF13"], [64, "PF14"],
  [65, "PF15"], [66, "PG0"], [67, "PG1"], [68, "PE7"], [69, "PE8"], [70, "PE9"], [71, "VSS"], [72, "VDD"],
  [73, "PE10"], [74, "PE11"], [75, "PE12"], [76, "PE13"], [77, "PE14"], [78, "PE15"], [79, "PB10"], [80, "PB11"],
  [81, "VCAP_1"], [82, "VDD"], [83, "PH6"], [84, "PH7"], [85, "PH8"], [86, "PH9"], [87, "PH10"], [88, "PH11"],
  [89, "PH12"], [90, "VSS"], [91, "VDD"], [92, "PB12"], [93, "PB13"], [94, "PB14"], [95, "PB15"], [96, "PD8"],
  [97, "PD9"], [98, "PD10"], [99, "PD11"], [100, "PD12"], [101, "PD13"], [102, "VSS"], [103, "VDD"], [104, "PD14"],
  [105, "PD15"], [106, "PG2"], [107, "PG3"], [108, "PG4"], [109, "PG5"], [110, "PG6"], [111, "PG7"], [112, "PG8"],
  [113, "VSS"], [114, "VDDUSB"], [115, "PC6"], [116, "PC7"], [117, "PC8"], [118, "PC9"], [119, "PA8"], [120, "PA9"],
  [121, "PA10"], [122, "PA11"], [123, "PA12"], [124, "PA13"], [125, "VCAP_2"], [126, "VSS"], [127, "VDD"], [128, "PH13"],
  [129, "PH14"], [130, "PH15"], [131, "PI0"], [132, "PI1"], [133, "PI2"], [134, "PI3"], [135, "VSS"], [136, "VDD"],
  [137, "PA14"], [138, "PA15"], [139, "PC10"], [140, "PC11"], [141, "PC12"], [142, "PD0"], [143, "PD1"], [144, "PD2"],
  [145, "PD3"], [146, "PD4"], [147, "PD5"], [148, "VSS"], [149, "VDD"], [150, "PD6"], [151, "PD7"], [152, "PG9"],
  [153, "PG10"], [154, "PG11"], [155, "PG12"], [156, "PG13"], [157, "PG14"], [158, "VSS"], [159, "VDD"], [160, "PG15"],
  [161, "PB3"], [162, "PB4"], [163, "PB5"], [164, "PB6"], [165, "PB7"], [166, "BOOT0"], [167, "PB8"], [168, "PB9"],
  [169, "PE0"], [170, "PE1"], [171, "PDR_ON"], [172, "VDD"], [173, "PI4"], [174, "PI5"], [175, "PI6"], [176, "PI7"],
  ],
}

const LQFP144_F429: Package = {
  name: "LQFP144",
  source: "ST DS9405 Table 10, RM0090",
  pins: [
  [1, "PE2"], [2, "PE3"], [3, "PE4"], [4, "PE5"], [5, "PE6"], [6, "VBAT"], [7, "PC13"], [8, "PC14"],
  [9, "PC15"], [10, "PF0"], [11, "PF1"], [12, "PF2"], [13, "PF3"], [14, "PF4"], [15, "PF5"], [16, "VSS"],
  [17, "VDD"], [18, "PF6"], [19, "PF7"], [20, "PF8"], [21, "PF9"], [22, "PF10"], [23, "PH0"], [24, "PH1"],
  [25, "NRST"], [26, "PC0"], [27, "PC1"], [28, "PC2"], [29, "PC3"], [30, "VDD"], [31, "VSSA"], [32, "VREF+"],
  [33, "VDDA"], [34, "PA0"], [35, "PA1"], [36, "PA2"], [37, "PA3"], [38, "VSS"], [39, "VDD"], [40, "PA4"],
  [41, "PA5"], [42, "PA6"], [43, "PA7"], [44, "PC4"], [45, "PC5"], [46, "PB0"], [47, "PB1"], [48, "PB2"],
  [49, "PF11"], [50, "PF12"], [51, "VSS"], [52, "VDD"], [53, "PF13"], [54, "PF14"], [55, "PF15"], [56, "PG0"],
  [57, "PG1"], [58, "PE7"], [59, "PE8"], [60, "PE9"], [61, "VSS"], [62, "VDD"], [63, "PE10"], [64, "PE11"],
  [65, "PE12"], [66, "PE13"], [67, "PE14"], [68, "PE15"], [69, "PB10"], [70, "PB11"], [71, "VCAP_1"], [72, "VDD"],
  [73, "PB12"], [74, "PB13"], [75, "PB14"], [76, "PB15"], [77, "PD8"], [78, "PD9"], [79, "PD10"], [80, "PD11"],
  [81, "PD12"], [82, "PD13"], [83, "VSS"], [84, "VDD"], [85, "PD14"], [86, "PD15"], [87, "PG2"], [88, "PG3"],
  [89, "PG4"], [90, "PG5"], [91, "PG6"], [92, "PG7"], [93, "PG8"], [94, "VSS"], [95, "VDD"], [96, "PC6"],
  [97, "PC7"], [98, "PC8"], [99, "PC9"], [100, "PA8"], [101, "PA9"], [102, "PA10"], [103, "PA11"], [104, "PA12"],
  [105, "PA13"], [106, "VCAP_2"], [107, "VSS"], [108, "VDD"], [109, "PA14"], [110, "PA15"], [111, "PC10"], [112, "PC11"],
  [113, "PC12"], [114, "PD0"], [115, "PD1"], [116, "PD2"], [117, "PD3"], [118, "PD4"], [119, "PD5"], [120, "VSS"],
  [121, "VDD"], [122, "PD6"], [123, "PD7"], [124, "PG9"], [125, "PG10"], [126, "PG11"], [127, "PG12"], [128, "PG13"],
  [129, "PG14"], [130, "VSS"], [131, "VDD"], [132, "PG15"], [133, "PB3"], [134, "PB4"], [135, "PB5"], [136, "PB6"],
  [137, "PB7"], [138, "BOOT0"], [139, "PB8"], [140, "PB9"], [141, "PE0"], [142, "PE1"], [143, "PDR_ON"], [144, "VDD"],
  ],
}

const LQFP100_F40X: Package = {
  name: "LQFP100",
  source: "ST DS8626 Table 7, RM0090",
  // PA, PB left; PC, PD, PE, PH right (PA–PC left made the left column 55 rows to the right's 34).
  leftPorts: 2,
  pins: [
  [1, "PE2"], [2, "PE3"], [3, "PE4"], [4, "PE5"], [5, "PE6"], [6, "VBAT"], [7, "PC13"], [8, "PC14"],
  [9, "PC15"], [10, "VSS"], [11, "VDD"], [12, "PH0"], [13, "PH1"], [14, "NRST"], [15, "PC0"], [16, "PC1"],
  [17, "PC2"], [18, "PC3"], [19, "VDD"], [20, "VSSA"], [21, "VREF+"], [22, "VDDA"], [23, "PA0"], [24, "PA1"],
  [25, "PA2"], [26, "PA3"], [27, "VSS"], [28, "VDD"], [29, "PA4"], [30, "PA5"], [31, "PA6"], [32, "PA7"],
  [33, "PC4"], [34, "PC5"], [35, "PB0"], [36, "PB1"], [37, "PB2"], [38, "PE7"], [39, "PE8"], [40, "PE9"],
  [41, "PE10"], [42, "PE11"], [43, "PE12"], [44, "PE13"], [45, "PE14"], [46, "PE15"], [47, "PB10"], [48, "PB11"],
  [49, "VCAP_1"], [50, "VDD"], [51, "PB12"], [52, "PB13"], [53, "PB14"], [54, "PB15"], [55, "PD8"], [56, "PD9"],
  [57, "PD10"], [58, "PD11"], [59, "PD12"], [60, "PD13"], [61, "PD14"], [62, "PD15"], [63, "PC6"], [64, "PC7"],
  [65, "PC8"], [66, "PC9"], [67, "PA8"], [68, "PA9"], [69, "PA10"], [70, "PA11"], [71, "PA12"], [72, "PA13"],
  [73, "VCAP_2"], [74, "VSS"], [75, "VDD"], [76, "PA14"], [77, "PA15"], [78, "PC10"], [79, "PC11"], [80, "PC12"],
  [81, "PD0"], [82, "PD1"], [83, "PD2"], [84, "PD3"], [85, "PD4"], [86, "PD5"], [87, "PD6"], [88, "PD7"],
  [89, "PB3"], [90, "PB4"], [91, "PB5"], [92, "PB6"], [93, "PB7"], [94, "BOOT0"], [95, "PB8"], [96, "PB9"],
  [97, "PE0"], [98, "PE1"], [99, "VSS"], [100, "VDD"],
  ],
}

const LQFP64_F40X: Package = {
  name: "LQFP64",
  source: "ST DS8626 Table 7, RM0090",
  // PA left; PB, PC, PD2, PH right: PD and PH are one or two pins each.
  leftPorts: 1,
  pins: [
  [1, "VBAT"], [2, "PC13"], [3, "PC14"], [4, "PC15"], [5, "PH0"], [6, "PH1"], [7, "NRST"], [8, "PC0"],
  [9, "PC1"], [10, "PC2"], [11, "PC3"], [12, "VSSA"], [13, "VDDA"], [14, "PA0"], [15, "PA1"], [16, "PA2"],
  [17, "PA3"], [18, "VSS"], [19, "VDD"], [20, "PA4"], [21, "PA5"], [22, "PA6"], [23, "PA7"], [24, "PC4"],
  [25, "PC5"], [26, "PB0"], [27, "PB1"], [28, "PB2"], [29, "PB10"], [30, "PB11"], [31, "VCAP_1"], [32, "VDD"],
  [33, "PB12"], [34, "PB13"], [35, "PB14"], [36, "PB15"], [37, "PC6"], [38, "PC7"], [39, "PC8"], [40, "PC9"],
  [41, "PA8"], [42, "PA9"], [43, "PA10"], [44, "PA11"], [45, "PA12"], [46, "PA13"], [47, "VCAP_2"], [48, "VDD"],
  [49, "PA14"], [50, "PA15"], [51, "PC10"], [52, "PC11"], [53, "PC12"], [54, "PD2"], [55, "PB3"], [56, "PB4"],
  [57, "PB5"], [58, "PB6"], [59, "PB7"], [60, "BOOT0"], [61, "PB8"], [62, "PB9"], [63, "VSS"], [64, "VDD"],
  ],
}

const UFQFPN48_F4X1: Package = {
  name: "UFQFPN48",
  // PA left; PB, PC13–15, PH0/1 right.
  leftPorts: 1,
  source: "ST DS10314 / DS9716 / DS10086 Table 8, RM0383 / RM0368",
  pins: [
  [1, "VBAT"], [2, "PC13"], [3, "PC14"], [4, "PC15"], [5, "PH0"], [6, "PH1"], [7, "NRST"], [8, "VSSA"],
  [9, "VDDA"], [10, "PA0"], [11, "PA1"], [12, "PA2"], [13, "PA3"], [14, "PA4"], [15, "PA5"], [16, "PA6"],
  [17, "PA7"], [18, "PB0"], [19, "PB1"], [20, "PB2"], [21, "PB10"], [22, "VCAP_1"], [23, "VSS"], [24, "VDD"],
  [25, "PB12"], [26, "PB13"], [27, "PB14"], [28, "PB15"], [29, "PA8"], [30, "PA9"], [31, "PA10"], [32, "PA11"],
  [33, "PA12"], [34, "PA13"], [35, "VSS"], [36, "VDD"], [37, "PA14"], [38, "PA15"], [39, "PB3"], [40, "PB4"],
  [41, "PB5"], [42, "PB6"], [43, "PB7"], [44, "BOOT0"], [45, "PB8"], [46, "PB9"], [47, "VSS"], [48, "VDD"],
  ],
}
export const stm32f746ig = stm32Chip(STM32F746IG, LQFP176_F746, "Cortex-M7 MCU, LQFP176")
export const stm32f429zi = stm32Chip(STM32F429ZI, LQFP144_F429, "Cortex-M4F MCU, LQFP144")
export const stm32f407vg = stm32Chip(STM32F407VG, LQFP100_F40X, "Cortex-M4F MCU, LQFP100")
export const stm32f405rg = stm32Chip(STM32F405RG, LQFP64_F40X, "Cortex-M4F MCU, LQFP64")
export const stm32f411ce = stm32Chip(STM32F411CE, UFQFPN48_F4X1, "Cortex-M4F MCU, UFQFPN48")
export const stm32f401cc = stm32Chip(STM32F401CC, UFQFPN48_F4X1, "Cortex-M4F MCU, UFQFPN48")
export const stm32f401ce = stm32Chip(STM32F401CE, UFQFPN48_F4X1, "Cortex-M4F MCU, UFQFPN48")

/** This file's parts, in palette order: the catalogue loads them from here. */
export const defs: ComponentDef[] = [stm32f746ig, stm32f429zi, stm32f407vg, stm32f405rg, stm32f411ce, stm32f401ce, stm32f401cc]

// --- datasheet records -----------------------------------------------------------------------
// The key numbers of each part, read from its datasheet (PDF page indices, as url#page=N opens
// them): one row per chip, the characteristics generated from it. Every STM32 here is the
// "6" temperature suffix (−40 to 85 °C ambient).

type Page = { page: number; at: string }

type Stm32Sheet = {
  docs: Datasheet["docs"]
  /** VDD range (general operating conditions) and its abs max (voltage characteristics). */
  vdd: [min: number, max: number]
  vddAt: Page
  vddAbsMax: number
  vddAbsAt: Page
  /** Highest fHCLK. */
  hclk: number
  hclkAt: Page
  /** Flash and SRAM (system SRAM incl. CCM/DTCM) in bytes, GPIOs of this package: the features table. */
  flash: number
  ram: number
  memoryAt: Page
  gpios: number
  gpiosAt: Page
  /** ±8 mA with the standard VOL/VOH (output driving current); 25 mA abs max (current characteristics). */
  driveAt: Page
  pinAbsAt: Page
  /** Ambient range for suffix 6; maximum junction temperature (thermal characteristics). */
  ambientAt: Page
  junctionMax: number
  junctionAt: Page
}

const KB = 1024

const SHEETS: Record<string, Stm32Sheet> = {
  stm32f746ig: {
    docs: [DOCS["st-ds10916"], DOCS["st-rm0385"], DOCS["st-es0290"], DOCS["arm-ddi0403e"], DOCS["arm-ddi0489"]],
    vdd: [1.7, 3.6], vddAt: { page: 104, at: "Table 18" }, vddAbsMax: 4.0, vddAbsAt: { page: 102, at: "Table 15" },
    hclk: 216e6, hclkAt: { page: 104, at: "Table 18" },
    flash: 1024 * KB, ram: 320 * KB, memoryAt: { page: 15, at: "Table 2" }, gpios: 140, gpiosAt: { page: 16, at: "Table 2" },
    driveAt: { page: 146, at: "Output driving current" }, pinAbsAt: { page: 103, at: "Table 16" },
    ambientAt: { page: 105, at: "Table 18" }, junctionMax: 125, junctionAt: { page: 103, at: "Table 17" },
  },
  stm32f429zi: {
    docs: [DOCS["st-ds9405"], DOCS["st-rm0090"], DOCS["st-es0206"], DOCS["arm-ddi0403e"], DOCS["arm-ddi0439"]],
    vdd: [1.7, 3.6], vddAt: { page: 95, at: "Table 17" }, vddAbsMax: 4.0, vddAbsAt: { page: 93, at: "Table 14" },
    hclk: 180e6, hclkAt: { page: 95, at: "Table 17" },
    flash: 2048 * KB, ram: 256 * KB, memoryAt: { page: 16, at: "Table 2" }, gpios: 114, gpiosAt: { page: 16, at: "Table 2" },
    driveAt: { page: 137, at: "Output driving current" }, pinAbsAt: { page: 94, at: "Table 15" },
    ambientAt: { page: 96, at: "Table 17" }, junctionMax: 125, junctionAt: { page: 94, at: "Table 16" },
  },
  stm32f407vg: {
    docs: [DOCS["st-ds8626"], DOCS["st-rm0090"], DOCS["st-es0182"], DOCS["arm-ddi0403e"], DOCS["arm-ddi0439"]],
    vdd: [1.8, 3.6], vddAt: { page: 81, at: "Table 14" }, vddAbsMax: 4.0, vddAbsAt: { page: 80, at: "Table 11" },
    hclk: 168e6, hclkAt: { page: 81, at: "Table 14" },
    flash: 1024 * KB, ram: 192 * KB, memoryAt: { page: 15, at: "Table 2" }, gpios: 82, gpiosAt: { page: 16, at: "Table 2" },
    driveAt: { page: 118, at: "Output driving current" }, pinAbsAt: { page: 81, at: "Table 12" },
    ambientAt: { page: 82, at: "Table 14" }, junctionMax: 125, junctionAt: { page: 81, at: "Table 13" },
  },
  stm32f405rg: {
    docs: [DOCS["st-ds8626"], DOCS["st-rm0090"], DOCS["st-es0182"], DOCS["arm-ddi0403e"], DOCS["arm-ddi0439"]],
    vdd: [1.8, 3.6], vddAt: { page: 81, at: "Table 14" }, vddAbsMax: 4.0, vddAbsAt: { page: 80, at: "Table 11" },
    hclk: 168e6, hclkAt: { page: 81, at: "Table 14" },
    flash: 1024 * KB, ram: 192 * KB, memoryAt: { page: 15, at: "Table 2" }, gpios: 51, gpiosAt: { page: 16, at: "Table 2" },
    driveAt: { page: 118, at: "Output driving current" }, pinAbsAt: { page: 81, at: "Table 12" },
    ambientAt: { page: 82, at: "Table 14" }, junctionMax: 125, junctionAt: { page: 81, at: "Table 13" },
  },
  stm32f411ce: {
    docs: [DOCS["st-ds10314"], DOCS["st-rm0383"], DOCS["st-es0287"], DOCS["st-an4073"], DOCS["arm-ddi0403e"], DOCS["arm-ddi0439"]],
    vdd: [1.7, 3.6], vddAt: { page: 63, at: "Table 14" }, vddAbsMax: 4.0, vddAbsAt: { page: 61, at: "Table 11" },
    hclk: 100e6, hclkAt: { page: 63, at: "Table 14" },
    flash: 512 * KB, ram: 128 * KB, memoryAt: { page: 13, at: "Table 2" }, gpios: 36, gpiosAt: { page: 13, at: "Table 2" },
    driveAt: { page: 100, at: "Output driving current" }, pinAbsAt: { page: 62, at: "Table 12" },
    ambientAt: { page: 64, at: "Table 14" }, junctionMax: 130, junctionAt: { page: 62, at: "Table 13" },
  },
  stm32f401ce: {
    docs: [DOCS["st-ds10086"], DOCS["st-rm0368"], DOCS["st-es0299"], DOCS["arm-ddi0403e"], DOCS["arm-ddi0439"]],
    vdd: [1.7, 3.6], vddAt: { page: 60, at: "Table 14" }, vddAbsMax: 4.0, vddAbsAt: { page: 58, at: "Table 11" },
    hclk: 84e6, hclkAt: { page: 60, at: "Table 14" },
    flash: 512 * KB, ram: 96 * KB, memoryAt: { page: 10, at: "Table 2" }, gpios: 36, gpiosAt: { page: 11, at: "Table 2" },
    driveAt: { page: 93, at: "Output driving current" }, pinAbsAt: { page: 59, at: "Table 12" },
    ambientAt: { page: 61, at: "Table 14" }, junctionMax: 125, junctionAt: { page: 59, at: "Table 13" },
  },
  stm32f401cc: {
    docs: [DOCS["st-ds9716"], DOCS["st-rm0368"], DOCS["st-es0222"], DOCS["arm-ddi0403e"], DOCS["arm-ddi0439"]],
    vdd: [1.7, 3.6], vddAt: { page: 59, at: "Table 14" }, vddAbsMax: 4.0, vddAbsAt: { page: 57, at: "Table 11" },
    hclk: 84e6, hclkAt: { page: 59, at: "Table 14" },
    flash: 256 * KB, ram: 64 * KB, memoryAt: { page: 11, at: "Table 2" }, gpios: 36, gpiosAt: { page: 11, at: "Table 2" },
    driveAt: { page: 91, at: "Output driving current" }, pinAbsAt: { page: 58, at: "Table 12" },
    ambientAt: { page: 60, at: "Table 14" }, junctionMax: 130, junctionAt: { page: 58, at: "Table 13" },
  },
}

function characteristics(s: Stm32Sheet): Characteristic[] {
  return [
    { kind: "supply", value: { min: s.vdd[0], max: s.vdd[1] }, limit: { max: s.vddAbsMax }, cite: s.vddAt, limitCite: s.vddAbsAt },
    { kind: "clock", value: { max: s.hclk }, cite: s.hclkAt },
    { kind: "flash", value: { typ: s.flash }, cite: s.memoryAt },
    { kind: "ram", value: { typ: s.ram }, cite: s.memoryAt },
    { kind: "ioPins", value: { typ: s.gpios }, cite: s.gpiosAt },
    { kind: "pinCurrent", value: { max: 8e-3, sym: true }, limit: { max: 25e-3, sym: true }, per: "pin", cite: s.driveAt, limitCite: s.pinAbsAt },
    { kind: "temperature", value: { min: -40, max: 85 }, limit: { max: s.junctionMax }, cite: s.ambientAt, limitCite: s.junctionAt },
  ]
}

// What the model does, with the test that holds it: the tests run one part of a line, and the
// line's other parts run the same blocks (src/mcu/periph) from their profiles.
const T = {
  core: "tests/firmware/mcu-test.test.ts",
  bare: "tests/sim/stm32-bare-chips.test.ts",
  dies: "tests/sim/lab1-sim.test.ts",
  f4: {
    tim: "tests/firmware/mcu-tim.test.ts",
    uart: "tests/firmware/mcu-uart.test.ts",
    spi: "tests/firmware/mcu-spi.test.ts",
    i2c: "tests/firmware/mcu-i2c.test.ts",
    adc: "tests/firmware/mcu-adc.test.ts",
    dma: "tests/firmware/mcu-dma.test.ts",
    lp: "tests/firmware/mcu-lp.test.ts",
  },
}
const claim = (what: string, test: string): Claim => ({ what, test })

const MODELLED: Record<string, Claim[]> = {
  stm32f746ig: [
    claim("Cortex-M7 core with FPU", T.core),
    claim("Runs unmodified HAL firmware", "tests/sim/lab1.test.ts"),
    claim("Clock tree, PLL and crystal", "tests/firmware/chip-clock.test.ts"),
    claim("Alternate functions per datasheet table", "tests/sim/stm32f746-pad-tables.test.ts"),
    claim("Timers with PWM and capture", "tests/sim/stm32f746-tim-capture.test.ts"),
    claim("USART serial with line options", "tests/sim/usart-line-options.test.ts"),
    claim("I²C master transfers", "tests/sim/mcu-i2c-v2.test.ts"),
    claim("12-bit ADC and DAC", "tests/sim/adc-model.test.ts"),
    claim("LTDC, DMA2D and SDRAM display", "tests/sim/lcd.test.ts"),
    claim("MPU memory protection", "tests/sim/stm32f746-mpu.test.ts"),
    claim("Pads burn past absolute maximum", "tests/sim/stm32f746-pad-ratings.test.ts"),
    claim("Dies above 4 V supply", T.dies),
  ],
  stm32f429zi: [
    claim("Cortex-M4F core with FPU", T.core),
    claim("Runs unmodified HAL firmware", "tests/firmware/mcu-blink.test.ts"),
    claim("Clock tree, PLL and crystal", "tests/firmware/chip-clock.test.ts"),
    claim("Timers with PWM and capture", T.f4.tim),
    claim("USART asynchronous serial", T.f4.uart),
    claim("SPI master transfers", T.f4.spi),
    claim("I²C master transfers", T.f4.i2c),
    claim("12-bit ADC and DAC", T.f4.adc),
    claim("DMA memory and peripheral transfers", T.f4.dma),
    claim("Sleep and Stop wake-ups", T.f4.lp),
    claim("Pads burn past absolute maximum", "tests/sim/stm32f405-pad-ratings.test.ts"),
    claim("Dies above 4 V supply", T.dies),
  ],
}
const F40X_MODELLED = [
  claim("Cortex-M4F core with FPU", T.core),
  claim("Runs unmodified HAL firmware", T.bare),
  claim("Clock tree, PLL and crystal", T.bare),
  claim("Alternate functions per datasheet table", "tests/sim/stm32f40x-pad-tables.test.ts"),
  claim("Timers with PWM and capture", T.f4.tim),
  claim("USART asynchronous serial", T.f4.uart),
  claim("SPI master transfers", T.f4.spi),
  claim("12-bit ADC and DAC", T.f4.adc),
  claim("I²S audio clocks and standards", "tests/sim/stm32f4-i2s.test.ts"),
  claim("Supply current per peripheral", "tests/sim/ds8626-supply.test.ts"),
  claim("Pads burn past absolute maximum", "tests/sim/stm32f405-pad-ratings.test.ts"),
  claim("Dies above 4 V supply", T.dies),
]
const F4X1_MODELLED = [
  claim("Cortex-M4F core with FPU", T.core),
  claim("Runs unmodified HAL firmware", T.bare),
  claim("Clock tree, PLL and crystal", T.bare),
  claim("Alternate functions per datasheet table", "tests/sim/stm32f4x1-pad-tables.test.ts"),
  claim("Timers with PWM and capture", T.f4.tim),
  claim("USART asynchronous serial", T.f4.uart),
  claim("SPI master transfers", T.f4.spi),
  claim("I²C master transfers", T.f4.i2c),
  claim("12-bit ADC", T.f4.adc),
  claim("PC13 burns past 3 mA", "tests/sim/blackpill-blink.test.ts"),
  claim("Dies above 4 V supply", T.dies),
]
MODELLED.stm32f407vg = F40X_MODELLED
MODELLED.stm32f405rg = F40X_MODELLED
MODELLED.stm32f411ce = F4X1_MODELLED
MODELLED.stm32f401ce = F4X1_MODELLED
MODELLED.stm32f401cc = F4X1_MODELLED

// What the model leaves out: blocks the datasheet lists that firmware finds unmodelled (reported
// when touched), with the datasheet's functional-overview page.
const gap = (what: string, page: number, at: string): Claim => ({ what, cite: { page, at } })
const NOT_MODELLED: Record<string, Claim[]> = {
  stm32f746ig: [
    gap("USB OTG FS and HS", 43, "§3.33, §3.34"),
    gap("Ethernet MAC", 42, "§3.31"),
    gap("bxCAN controllers", 43, "§3.32"),
    gap("SDMMC card interface", 42, "§3.30"),
    gap("SAI and SPDIFRX audio", 40, "§3.26, §3.27"),
    gap("Quad-SPI memory interface", 23, "§3.9"),
    gap("Camera interface (DCMI)", 44, "§3.36"),
    gap("Random number generator", 44, "§3.37"),
    gap("HDMI-CEC", 44, "§3.35"),
    gap("ST system bootloader", 25, "§3.15"),
  ],
  stm32f429zi: [
    gap("USB OTG FS and HS", 41, "§3.33, §3.34"),
    gap("Ethernet MAC", 40, "§3.31"),
    gap("bxCAN controllers", 40, "§3.32"),
    gap("SDIO card interface", 40, "§3.30"),
    gap("SAI audio interface", 39, "§3.27"),
    gap("Camera interface (DCMI)", 42, "§3.35"),
    gap("Random number generator", 42, "§3.36"),
    gap("CRC calculation unit", 22, "§3.5"),
    gap("RTC tamper and timestamp", 33, "§3.20"),
    gap("ST system bootloader", 26, "§3.15"),
  ],
  stm32f407vg: [
    gap("USB OTG FS and HS", 39, "§3.30, §3.31"),
    gap("Ethernet MAC", 38, "§3.28"),
    gap("bxCAN controllers", 39, "§3.29"),
    gap("SDIO card interface", 38, "§3.27"),
    gap("Camera interface (DCMI)", 40, "§3.32"),
    gap("Random number generator", 40, "§3.33"),
    gap("CRC calculation unit", 22, "§3.5"),
    gap("RTC tamper and timestamp", 32, "§3.19"),
    gap("ST system bootloader", 25, "§3.13"),
  ],
  stm32f405rg: [
    gap("USB OTG FS and HS", 39, "§3.30, §3.31"),
    gap("bxCAN controllers", 39, "§3.29"),
    gap("SDIO card interface", 38, "§3.27"),
    gap("Random number generator", 40, "§3.33"),
    gap("CRC calculation unit", 22, "§3.5"),
    gap("RTC tamper and timestamp", 32, "§3.19"),
    gap("ST system bootloader", 25, "§3.13"),
  ],
  stm32f411ce: [
    gap("USB OTG full speed", 32, "§3.27"),
    gap("SDIO card interface", 32, "§3.26"),
    gap("CRC calculation unit", 18, "§3.6"),
    gap("RTC tamper and timestamp", 27, "§3.18"),
    gap("ST system bootloader", 21, "§3.13"),
  ],
  stm32f401ce: [
    gap("USB OTG full speed", 31, "§3.26"),
    gap("SDIO card interface", 30, "§3.25"),
    gap("CRC calculation unit", 16, "§3.5"),
    gap("RTC tamper and timestamp", 26, "§3.17"),
    gap("ST system bootloader", 19, "§3.12"),
  ],
  stm32f401cc: [
    gap("USB OTG full speed", 30, "§3.26"),
    gap("SDIO card interface", 29, "§3.25"),
    gap("CRC calculation unit", 16, "§3.5"),
    gap("RTC tamper and timestamp", 25, "§3.17"),
    gap("ST system bootloader", 18, "§3.12"),
  ],
}

const RECORDS: Record<string, Datasheet> = Object.fromEntries(
  Object.entries(SHEETS).map(([id, s]) => [
    id,
    { maker: "STMicroelectronics", package: defs.find((d) => d.id === id)!.info!.Package, docs: s.docs, specs: [], characteristics: characteristics(s), modelled: MODELLED[id], notModelled: NOT_MODELLED[id] },
  ]),
)
for (const def of defs) def.datasheet ??= RECORDS[def.id]
