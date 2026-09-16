import { STM32F429ZI } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind, Side } from "../types"
import { LED_COLORS } from "./basic"

/**
 * NUCLEO-F429ZI (Nucleo-144, MB1137). Pin data from ST UM1974, Table 16.
 * Scale: 1 cell = 2.54 mm; the board is 133.34 × 70 mm ≈ 52 × 28 cells.
 */

/** [connector pin, label, MCU pin, signal, function, note] */
type Row = [number, string, string?, string?, string?, string?]

const CN8_OUTER: Row[] = [
  [1, "NC"],
  [3, "IOREF", undefined, "IOREF", "3.3V ref"],
  [5, "RESET", "NRST", "RESET"],
  [7, "+3V3", undefined, "+3V3", "3.3V in/out"],
  [9, "+5V", undefined, "+5V", "5V out"],
  [11, "GND"],
  [13, "GND"],
  [15, "VIN", undefined, "VIN", "Power in"],
]
const CN8_INNER: Row[] = [
  [2, "D43", "PC8", "SDMMC_D0", "SDMMC/I2S_A"],
  [4, "D44", "PC9", "SDMMC_D1/I2S_A_CKIN", "SDMMC/I2S_A"],
  [6, "D45", "PC10", "SDMMC_D2", "SDMMC/I2S_A"],
  [8, "D46", "PC11", "SDMMC_D3", "SDMMC/I2S_A"],
  [10, "D47", "PC12", "SDMMC_CK", "SDMMC/I2S_A"],
  [12, "D48", "PD2", "SDMMC_CMD", "SDMMC/I2S_A"],
  [14, "D49", "PG2", "I/O"],
  [16, "D50", "PG3", "I/O"],
]
const CN9_OUTER: Row[] = [
  [1, "A0", "PA3", "ADC", "ADC123_IN3"],
  [3, "A1", "PC0", "ADC", "ADC123_IN10"],
  [5, "A2", "PC3", "ADC", "ADC123_IN13"],
  [7, "A3", "PF3", "ADC", "ADC3_IN9"],
  [9, "A4", "PF5", "ADC", "ADC3_IN15", "PB9 (I2C1_SDA) via solder bridge"],
  [11, "A5", "PF10", "ADC", "ADC3_IN8", "PB8 (I2C1_SCL) via solder bridge"],
  [13, "D72"],
  [15, "D71", "PA7", "I/O", undefined, "Shared with D11 and Ethernet RMII_DV (JP6)"],
  [17, "D70", "PF2", "I2C_B_SMBA", "I2C2"],
  [19, "D69", "PF1", "I2C_B_SCL", "I2C2"],
  [21, "D68", "PF0", "I2C_B_SDA", "I2C2"],
  [23, "GND"],
  [25, "D67", "PD0", "CAN_RX", "CAN1"],
  [27, "D66", "PD1", "CAN_TX", "CAN1"],
  [29, "D65", "PG0", "I/O"],
]
const CN9_INNER: Row[] = [
  [2, "D51", "PD7", "USART_B_SCLK", "USART2"],
  [4, "D52", "PD6", "USART_B_RX", "USART2"],
  [6, "D53", "PD5", "USART_B_TX", "USART2"],
  [8, "D54", "PD4", "USART_B_RTS", "USART2"],
  [10, "D55", "PD3", "USART_B_CTS", "USART2"],
  [12, "GND"],
  [14, "D56", "PE2", "SAI_A_MCLK", "SAI1_A", "Shared with D31"],
  [16, "D57", "PE4", "SAI_A_FS", "SAI1_A"],
  [18, "D58", "PE5", "SAI_A_SCK", "SAI1_A"],
  [20, "D59", "PE6", "SAI_A_SD", "SAI1_A"],
  [22, "D60", "PE3", "SAI_B_SD", "SAI1_B"],
  [24, "D61", "PF8", "SAI_B_SCK", "SAI1_B"],
  [26, "D62", "PF7", "SAI_B_MCLK", "SAI1_B"],
  [28, "D63", "PF9", "SAI_B_FS", "SAI1_B"],
  [30, "D64", "PG1", "I/O"],
]
const CN7_INNER: Row[] = [
  [1, "D16", "PC6", "I2S_A_MCK", "I2S2"],
  [3, "D17", "PB15", "I2S_A_SD", "I2S2"],
  [5, "D18", "PB13", "I2S_A_CK", "I2S2", "Shared with Ethernet RMII_TXD1 (JP7)"],
  [7, "D19", "PB12", "I2S_A_WS", "I2S2"],
  [9, "D20", "PA15", "I2S_B_WS", "I2S3/SPI3"],
  [11, "D21", "PC7", "I2S_B_MCK", "I2S3/SPI3"],
  [13, "D22", "PB5", "I2S_B_SD/SPI_B_MOSI", "I2S3/SPI3"],
  [15, "D23", "PB3", "I2S_B_CK/SPI_B_SCK", "I2S3/SPI3"],
  [17, "D24", "PA4", "SPI_B_NSS", "I2S3/SPI3"],
  [19, "D25", "PB4", "SPI_B_MISO", "I2S3/SPI3"],
]
const CN7_OUTER: Row[] = [
  [2, "D15", "PB8", "I2C_A_SCL", "I2C1_SCL"],
  [4, "D14", "PB9", "I2C_A_SDA", "I2C1_SDA"],
  [6, "AREF", undefined, "AREF", "AVDD"],
  [8, "GND"],
  [10, "D13", "PA5", "SPI_A_SCK", "SPI1_SCK"],
  [12, "D12", "PA6", "SPI_A_MISO", "SPI1_MISO"],
  [14, "D11", "PA7", "SPI_A_MOSI/TIM_E_PWM1", "SPI1_MOSI/TIM14_CH1", "PB5 via solder bridge"],
  [16, "D10", "PD14", "SPI_A_CS/TIM_B_PWM3", "SPI1_CS/TIM4_CH3"],
  [18, "D9", "PD15", "TIMER_B_PWM2", "TIM4_CH4"],
  [20, "D8", "PF12", "I/O"],
]
const CN10_INNER: Row[] = [
  [1, "AVDD", undefined, "AVDD", "Analog VDD"],
  [3, "AGND", undefined, "AGND", "Analog GND"],
  [5, "GND"],
  [7, "A6", "PB1", "ADC_A_IN", "ADC12_IN9"],
  [9, "A7", "PC2", "ADC_B_IN", "ADC123_IN12"],
  [11, "A8", "PF4", "ADC_C_IN", "ADC3_IN14"],
  [13, "D26", "PB6", "I/O"],
  [15, "D27", "PB2", "I/O"],
  [17, "GND"],
  [19, "D28", "PD13", "I/O"],
  [21, "D29", "PD12", "I/O"],
  [23, "D30", "PD11", "I/O"],
  [25, "D31", "PE2", "I/O", undefined, "Shared with D56"],
  [27, "GND"],
  [29, "D32", "PA0", "TIMER_C_PWM1", "TIM2_CH1"],
  [31, "D33", "PB0", "TIMER_D_PWM1", "TIM3_CH3", "Also LD1 (green) via SB120"],
  [33, "D34", "PE0", "TIMER_B_ETR", "TIM4_ETR"],
]
const CN10_OUTER: Row[] = [
  [2, "D7", "PF13", "I/O"],
  [4, "D6", "PE9", "TIMER_A_PWM1", "TIM1_CH1"],
  [6, "D5", "PE11", "TIMER_A_PWM2", "TIM1_CH2"],
  [8, "D4", "PF14", "I/O"],
  [10, "D3", "PE13", "TIMER_A_PWM3", "TIM1_CH3"],
  [12, "D2", "PF15", "I/O"],
  [14, "D1", "PG14", "USART_A_TX", "USART6_TX"],
  [16, "D0", "PG9", "USART_A_RX", "USART6_RX"],
  [18, "D42", "PE8", "TIMER_A_PWM1N", "TIM1_CH1N"],
  [20, "D41", "PE7", "TIMER_A_ETR", "TIM1_ETR"],
  [22, "GND"],
  [24, "D40", "PE10", "TIMER_A_PWM2N", "TIM1_CH2N"],
  [26, "D39", "PE12", "TIMER_A_PWM3N", "TIM1_CH3N"],
  [28, "D38", "PE14", "I/O"],
  [30, "D37", "PE15", "TIMER_A_BKIN1", "TIM1_BKIN1"],
  [32, "D36", "PB10", "TIMER_C_PWM2", "TIM2_CH3"],
  [34, "D35", "PB11", "TIMER_C_PWM3", "TIM2_CH4"],
]

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "GND" || label === "AGND") return "gnd"
  if (/^(\+3V3|\+5V|VIN|IOREF|AVDD|AREF)$/.test(label)) return "power"
  if (/^A\d+$/.test(label)) return "analog"
  if (label === "NC" || (label.startsWith("D") && !mcu)) return "nc"
  return "digital"
}

const WIDTH = 28
const HEIGHT = 52
const X = { leftOuter: 2, leftInner: 3, rightInner: WIDTH - 3, rightOuter: WIDTH - 2 }

function header(
  connector: string,
  side: Side,
  top: number,
  outer: Row[],
  inner: Row[],
): PinDef[] {
  const left = side === "left"
  const col = (rows: Row[], x: number, labelAt: Side, stub: number): PinDef[] =>
    rows.map(([pin, label, mcu, signal, fn, note], i) => ({
      id: `${connector}-${pin}`,
      label,
      x,
      y: top + i,
      side,
      labelAt,
      kind: kindOf(label, mcu),
      stub,
      mcu,
      signal,
      fn,
      connector,
      connectorPin: pin,
      note,
    }))
  return left
    ? [...col(outer, X.leftOuter, "left", 3), ...col(inner, X.leftInner, "right", 4)]
    : [...col(outer, X.rightOuter, "right", 3), ...col(inner, X.rightInner, "left", 4)]
}

const pins: PinDef[] = [
  // The ST-LINK's virtual COM port: USART3 of the target on PD8/PD9, reachable over the USB
  // cable on a real board; here as two pins on the ST-LINK zone for a serial terminal.
  { id: "VCP-TX", label: "VCP TX", x: 0, y: 4, side: "left", labelAt: "right", kind: "digital", stub: 2, mcu: "PD8", signal: "STLK_RX", fn: "USART3_TX", note: "Target → host; connect to a terminal's RX" },
  { id: "VCP-RX", label: "VCP RX", x: 0, y: 6, side: "left", labelAt: "right", kind: "digital", stub: 2, mcu: "PD9", signal: "STLK_TX", fn: "USART3_RX", note: "Host → target; connect to a terminal's TX" },
  ...header("CN8", "left", 13, CN8_OUTER, CN8_INNER),
  ...header("CN9", "left", 22, CN9_OUTER, CN9_INNER),
  ...header("CN7", "right", 13, CN7_OUTER, CN7_INNER),
  ...header("CN10", "right", 24, CN10_OUTER, CN10_INNER),
]

const body: BodyShape[] = [
  { type: "rect", x: 0, y: 0, w: WIDTH, h: HEIGHT, rx: 0.6, fill: "board" },
  // ST-LINK section
  { type: "rect", x: 0.5, y: 0.5, w: WIDTH - 1, h: 9.5, rx: 0.4, fill: "zone" },
  { type: "text", x: 14, y: 5, text: "ST-LINK/V2-1", size: 0.5 },
  { type: "text", x: 14, y: 6.2, text: "STM32F103CBT6", size: 0.32, muted: true },
  // MCU
  { type: "rect", x: 9, y: 21, w: 10, h: 10, rx: 0.3, fill: "chip" },
  { type: "text", x: 14, y: 25.6, text: "STM32F429ZI", size: 0.55, inverse: true },
  { type: "text", x: 14, y: 26.9, text: "LQFP144 · 180 MHz", size: 0.35, inverse: true },
  // Ethernet and USB OTG
  { type: "rect", x: 1, y: 45, w: 8, h: 6.5, rx: 0.3, fill: "connector" },
  { type: "text", x: 5, y: 48.3, text: "CN14 ETH", size: 0.38 },
  { type: "rect", x: 19, y: 46.5, w: 8, h: 5, rx: 0.3, fill: "connector" },
  { type: "text", x: 23, y: 49, text: "CN13 USB OTG", size: 0.34 },
  // connector names
  { type: "text", x: 2.5, y: 12.2, text: "CN8", size: 0.35, muted: true },
  { type: "text", x: 2.5, y: 21.2, text: "CN9", size: 0.35, muted: true },
  { type: "text", x: WIDTH - 2.5, y: 12.2, text: "CN7", size: 0.35, muted: true },
  { type: "text", x: WIDTH - 2.5, y: 23.2, text: "CN10", size: 0.35, muted: true },
]

const parts: PartDef[] = [
  { type: "led", id: "LD1", label: "LD1", x: 11, y: 41, color: "#22c55e", pin: "CN10-31", mcu: "PB0" },
  { type: "led", id: "LD2", label: "LD2", x: 13, y: 41, color: "#3b82f6", mcu: "PB7" },
  { type: "led", id: "LD3", label: "LD3", x: 15, y: 41, color: "#ef4444", mcu: "PB14" },
  { type: "button", id: "B1", label: "USER", x: 22, y: 42, mcu: "PC13" },
  { type: "button", id: "RESET", label: "RESET", x: 4, y: 8, mcu: "NRST" },
  { type: "usb", id: "USB", label: "CN1 USB", x: 14, y: 0.6, side: "top", initial: { on: true } },
]

// --- electrical model ---------------------------------------------------------

/** Header pins per MCU pin. Two header pins on one MCU pin (D11/D71, D31/D56) share one driver. */
const byMcu = new Map<string, string[]>()
for (const p of pins) if (p.mcu && p.mcu !== "NRST") byMcu.set(p.mcu, [...(byMcu.get(p.mcu) ?? []), p.id])

/** Every GND and AGND header pin is the same ground pour. */
const gndPins = pins.filter((p) => p.kind === "gnd").map((p) => p.id)
const GND = gndPins[0]
const V5 = "CN8-9"
const V3V3 = "CN8-7"
const NRST = "CN8-5"

/** LED series resistors are roughly what the MB1137 fits; forward drops come from the LED palette. */
const led = (mcu: string, part: string, color: keyof typeof LED_COLORS, r: number): Element[] => [
  { kind: "R", a: mcu, b: `$${part}k`, value: r },
  { kind: "D", anode: `$${part}k`, cathode: GND, vf: LED_COLORS[color].vf, part },
]

/**
 * Internal MCU pins that reach no header are named "$<MCU pin>" ($PB7); the inspector lists
 * their drivers next to the part (LED, button) that hangs on them.
 */
const model: Element[] = [
  { kind: "SHORT", nodes: gndPins },
  { kind: "GND", node: GND },
  // Power tree (UM1974 §6.3). The host's USB port arrives through CN1 when the cable is in and
  // is current-limited at 500 mA by the ST-LINK's power switch. VIN (7–12 V) feeds the +5V
  // rail through the LD1117S50; the LD39050 LDO makes +3V3 from +5V. Feeding 5 V straight into
  // the +5V pin (E5V) works too, as it does with JP3 set that way.
  { kind: "V", plus: "$usb", minus: GND, value: 5 },
  { kind: "SW", a: "$usb", b: "$usbsw", part: "USB", closed: "on" },
  { kind: "REG", in: "$usbsw", out: "$5v", gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "REG", in: "CN8-15", out: "$5v", gnd: GND, value: 5, dropout: 1.1, imax: 0.8 },
  { kind: "R", a: "$5v", b: V5, value: 0.02 },
  { kind: "REG", in: "$5v", out: "$3v3", gnd: GND, value: 3.3, dropout: 0.2, imax: 0.65 },
  { kind: "R", a: "$3v3", b: V3V3, value: 0.02 },
  // IOREF, AVDD and AREF all sit on the 3.3 V rail.
  { kind: "SHORT", nodes: [V3V3, "CN8-3", "CN10-1", "CN7-6"] },
  // The RESET button shorts NRST (held up by the MCU's internal pull-up) to ground.
  { kind: "SW", a: NRST, b: GND, part: "RESET", closed: "pressed" },
  // User LEDs. LD1 shares PB0 with D33 (SB120), LD2 and LD3 hang on pins the headers don't reach.
  ...led("CN10-31", "LD1", "green", 510),
  ...led("$PB7", "LD2", "blue", 330),
  ...led("$PB14", "LD3", "red", 330),
  // B1 USER pulls PC13 up to 3.3 V against its 100 kΩ pull-down.
  { kind: "R", a: "$PC13", b: GND, value: 100e3 },
  { kind: "SW", a: "$PC13", b: V3V3, part: "B1", closed: "pressed" },
  // Two header pins on one MCU pin share one driver.
  ...[...byMcu.values()].filter((ids) => ids.length > 1).map((ids): Element => ({ kind: "SHORT", nodes: ids })),
  // The MCU itself: supply load, NRST pull-up, and a GPIO driver behind every header pin
  // and every internal pin (LEDs, button), with the datasheet ratings.
  ...mcuModel(STM32F429ZI, { vdd: "$3v3", gnd: GND, nrst: NRST, pads: ["$PB7", "$PB14", "$PC13", ...[...byMcu.values()].map((ids) => ids[0])] }),
]

export const nucleoF429zi: ComponentDef = {
  id: "nucleo-f429zi",
  name: "Nucleo-144",
  description: "STM32F429ZI",
  category: "Boards",
  icon: BoardIcon,
  prefix: "U",
  width: WIDTH,
  height: HEIGHT,
  body,
  pins,
  parts,
  model,
  hideIdle: true,
  chip: STM32F429ZI.id,
  mcuPower: V3V3,
  mcuReset: NRST,
  // X3 (HSE crystal) is not fitted: the ST-LINK's MCO feeds 8 MHz into OSC_IN (SB149 closed),
  // so HSE works in bypass only. X2 is the 32.768 kHz LSE crystal (UM1974 §6.7).
  mcuClocks: { hse: { hz: 8e6, kind: "clock", startup: 0 }, lse: { hz: 32768, kind: "crystal", startup: 2 } },
  info: {
    MCU: "STM32F429ZIT6, Cortex-M4F 180 MHz, 2 MB Flash, 256 KB SRAM",
    "Virtual COM port": "USART3, TX PD8, RX PD9 (via ST-LINK)",
    "USB OTG FS": "DM PA11, DP PA12, VBUS PA9, ID PA10, PWR_EN PG6, OVRCR PG7",
    "Ethernet RMII": "REF_CLK PA1, MDIO PA2, MDC PC1, CRS_DV PA7, RXD0 PC4, RXD1 PC5, TX_EN PG11, TXD0 PG13, TXD1 PB13",
    Source: "ST UM1974, Table 16",
  },
}
