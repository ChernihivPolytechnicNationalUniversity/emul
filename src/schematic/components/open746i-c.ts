import { STM32F746IG } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind, Side } from "../types"
import { LED_COLORS } from "./basic"

/**
 * Waveshare Open746I-C: the mother board with the Core746I module (STM32F746IGT6, 8 MB SDRAM)
 * on it — the university's lab stand. Pin data from the board and module schematics; the
 * layout follows the photo: the module on the left, Arduino headers to its right, peripheral
 * headers around the edge, LEDs top right, joystick and WAKEUP bottom right, RESET bottom left.
 * Scale: 1 cell = 2.54 mm; the board is about 178 × 122 mm ≈ 70 × 48 cells.
 */

/** [header pin, label, MCU pin, signal, function, note] */
type Row = [number, string, string?, string?, string?, string?]

const WIDTH = 70
const HEIGHT = 48

// --- peripheral headers (schematic page 2) ------------------------------------------------------

const USART3: Row[] = [
  [1, "3V3"],
  [2, "GND"],
  [3, "RX", "PD9", "USART3_RX"],
  [4, "TX", "PD8", "USART3_TX"],
  [5, "CTS", "PD11", "USART3_CTS"],
  [6, "RTS", "PD12", "USART3_RTS"],
  [7, "CK", "PD10", "USART3_CK"],
]
const CAN1: Row[] = [[1, "3V3"], [2, "GND"], [3, "RX", "PA11", "CAN1_RX", undefined, "Shared with USART1 CTS (JMP2) and Arduino"], [4, "TX", "PA12", "CAN1_TX", undefined, "Shared with USART1 RTS (JMP2)"]]
const CAN2: Row[] = [[1, "3V3"], [2, "GND"], [3, "RX", "PB12", "CAN2_RX", undefined, "Shared with SPI2 NSS, I2S2 WS, ULPI D5, Arduino D10"], [4, "TX", "PB13", "CAN2_TX", undefined, "Shared with SPI2 SCK, I2S2 CK, ULPI D6, Arduino D13"]]
const I2C_ODD: Row[] = [[1, "3V3"], [3, "SDA", "PD13", "I2C2_SDA", undefined, "Also the 7\" LCD's touch SDA (P15-37)"], [5, "SCL", "PD12", "I2C2_SCL", undefined, "Also the 7\" LCD's touch SCL (P15-38)"], [7, "SMBA", "PD11", "I2C2_SMBA"], [9, "GND"]]
const I2C_EVEN: Row[] = [[2, "3V3"], [4, "SDA", "PB9", "I2C1_SDA"], [6, "SCL", "PB8", "I2C1_SCL"], [8, "SMBA", "PB5", "I2C1_SMBA"], [10, "GND"]]
const DCMI_ODD: Row[] = [
  [1, "3V3"],
  [3, "SIOC", "PB10", "I2C2_SCL"],
  [5, "VSYNC", "PG9", "DCMI_VSYNC"],
  [7, "PIXCLK", "PA6", "DCMI_PIXCLK"],
  [9, "D7", "PB9", "DCMI_D7"],
  [11, "D5", "PD3", "DCMI_D5"],
  [13, "D3", "PH12", "DCMI_D3"],
  [15, "D1", "PC7", "DCMI_D1"],
  [17, "RESET", "NRST", "NRST"],
  [19, "D9", "PI2", "DCMI_D9"],
  [21, "D11", "PH15", "DCMI_D11"],
  [23, "D13", "PI0", "DCMI_D13"],
]
const DCMI_EVEN: Row[] = [
  [2, "GND"],
  [4, "SIOD", "PB11", "I2C2_SDA"],
  [6, "HSYNC", "PA4", "DCMI_HSYNC"],
  [8, "XCLK", "PA8", "MCO1"],
  [10, "D6", "PB8", "DCMI_D6"],
  [12, "D4", "PH14", "DCMI_D4"],
  [14, "D2", "PH11", "DCMI_D2"],
  [16, "D0", "PC6", "DCMI_D0"],
  [18, "PWDN", "PA5", "I/O"],
  [20, "D8", "PI1", "DCMI_D8"],
  [22, "D10", "PI3", "DCMI_D10"],
  [24, "D12", "PG6", "DCMI_D12"],
]
const ETH_ODD: Row[] = [[1, "3V3"], [3, "MDIO", "PA2", "ETH_MDIO"], [5, "REFCLK", "PA1", "ETH_REF_CLK"], [7, "RXD0", "PC4", "ETH_RXD0"], [9, "TXEN", "PB11", "ETH_TX_EN"], [11, "TXD1", "PG14", "ETH_TXD1"], [13, "NC"]]
const ETH_EVEN: Row[] = [[2, "GND"], [4, "MDC", "PC1", "ETH_MDC"], [6, "CRSDV", "PA7", "ETH_CRS_DV"], [8, "RXD1", "PC5", "ETH_RXD1"], [10, "TXD0", "PG13", "ETH_TXD0"], [12, "NC"], [14, "NC"]]
const SPI2: Row[] = [[1, "3V3"], [3, "MISO", "PB14", "SPI2_MISO"], [5, "MOSI", "PB15", "SPI2_MOSI"], [7, "SCK", "PB13", "SPI2_SCK"], [9, "NSS", "PB12", "SPI2_NSS"], [11, "GND"]]
const SPI1: Row[] = [[2, "3V3"], [4, "MISO", "PA6", "SPI1_MISO"], [6, "MOSI", "PA7", "SPI1_MOSI"], [8, "SCK", "PA5", "SPI1_SCK"], [10, "NSS", "PA4", "SPI1_NSS"], [12, "GND"]]
const SAI_A: Row[] = [[1, "3V3"], [3, "GND"], [5, "NC"], [7, "NC"], [9, "SCK_A", "PE5", "SAI1_SCK_A"], [11, "FS_A", "PE4", "SAI1_FS_A"], [13, "SD_A", "PE6", "SAI1_SD_A"], [15, "MCLK_A", "PE2", "SAI1_MCLK_A"]]
const SAI_B: Row[] = [[2, "3V3"], [4, "GND"], [6, "SDA", "PB9", "I2C1_SDA"], [8, "SCL", "PB8", "I2C1_SCL"], [10, "SCK_B", "PF8", "SAI1_SCK_B"], [12, "FS_B", "PF9", "SAI1_FS_B"], [14, "SD_B", "PF6", "SAI1_SD_B"], [16, "MCLK_B", "PF7", "SAI1_MCLK_B"]]
const I2S3: Row[] = [[1, "3V3"], [3, "GND"], [5, "NC"], [7, "NC"], [9, "CK", "PC10", "I2S3_CK"], [11, "WS", "PA4", "I2S3_WS"], [13, "SD", "PC12", "I2S3_SD"], [15, "MCK", "PC7", "I2S3_MCK"]]
const I2S2: Row[] = [[2, "3V3"], [4, "GND"], [6, "SDA", "PB9", "I2C1_SDA"], [8, "SCL", "PB8", "I2C1_SCL"], [10, "CK", "PB13", "I2S2_CK"], [12, "WS", "PB12", "I2S2_WS"], [14, "SD", "PI3", "I2S2_SD"], [16, "MCK", "PC6", "I2S2_MCK"]]
const SDMMC: Row[] = [[1, "3V3"], [2, "GND"], [3, "D0", "PC8", "SDMMC1_D0"], [4, "CMD", "PD2", "SDMMC1_CMD"], [5, "CLK", "PC12", "SDMMC1_CK"], [6, "D3", "PC11", "SDMMC1_D3"], [7, "D2", "PC10", "SDMMC1_D2"], [8, "D1", "PC9", "SDMMC1_D1"], [9, "CD", "PC13", "I/O", undefined, "Card detect through JMP1"]]
const QSPI: Row[] = [[1, "3V3"], [2, "GND"], [3, "IO1", "PF9", "QUADSPI_BK1_IO1"], [4, "IO0", "PF8", "QUADSPI_BK1_IO0"], [5, "CLK", "PB2", "QUADSPI_CLK"], [6, "NCS", "PB6", "QUADSPI_BK1_NCS", undefined, "Shared with USER LED1 (JMP3)"], [7, "IO2", "PF7", "QUADSPI_BK1_IO2"], [8, "IO3", "PF6", "QUADSPI_BK1_IO3"]]
const ULPI_ODD: Row[] = [[1, "GND"], [3, "D7", "PB5", "ULPI_D7"], [5, "D6", "PB13", "ULPI_D6"], [7, "D5", "PB12", "ULPI_D5"], [9, "D4", "PB11", "ULPI_D4"], [11, "D3", "PB10", "ULPI_D3"], [13, "D2", "PB1", "ULPI_D2"], [15, "D1", "PB0", "ULPI_D1"], [17, "D0", "PA3", "ULPI_D0", undefined, "Shared with the LCD backlight PWM"], [19, "NC"]]
const ULPI_EVEN: Row[] = [[2, "3V3"], [4, "STP", "PC0", "ULPI_STP"], [6, "NXT", "PC3", "ULPI_NXT"], [8, "DIR", "PC2", "ULPI_DIR"], [10, "CK", "PA5", "ULPI_CK"], [12, "NC"], [14, "NC"], [16, "NC"], [18, "5V"], [20, "NC"]]
const FMC_ODD: Row[] = [[1, "3V3"], [3, "GND"], [5, "D0", "PD14", "FMC_D0"], [7, "D1", "PD15", "FMC_D1"], [9, "D2", "PD0", "FMC_D2"], [11, "D3", "PD1", "FMC_D3"], [13, "D4", "PE7", "FMC_D4"], [15, "D5", "PE8", "FMC_D5"], [17, "D6", "PE9", "FMC_D6"], [19, "D7", "PE10", "FMC_D7"]]
const FMC_EVEN: Row[] = [[2, "3V3"], [4, "GND"], [6, "NCE", "PG9", "FMC_NCE"], [8, "NOE", "PD4", "FMC_NOE", undefined, "Shared with joystick C (JMP4)"], [10, "NWE", "PD5", "FMC_NWE", undefined, "Shared with joystick D (JMP4)"], [12, "NWT", "PD6", "FMC_NWAIT"], [14, "ALE", "PD12", "FMC_A17"], [16, "CLE", "PD11", "FMC_A16"], [18, "NC"], [20, "NC"]]
/** P15, the 40-pin FFC for the 7" LCD (schematic page 3); the LCD component mirrors it pin for pin. */
const LCD7: Row[] = [
  [1, "5V"],
  [2, "5V"],
  [3, "GND"],
  [4, "3V3"],
  [5, "R0", "PH2", "LTDC_R0"],
  [6, "R1", "PH3", "LTDC_R1"],
  [7, "R2", "PH8", "LTDC_R2"],
  [8, "R3", "PH9", "LTDC_R3"],
  [9, "R4", "PH10", "LTDC_R4"],
  [10, "R5", "PC0", "LTDC_R5"],
  [11, "R6", "PB1", "LTDC_R6"],
  [12, "R7", "PG6", "LTDC_R7"],
  [13, "G0", "PE5", "LTDC_G0"],
  [14, "G1", "PE6", "LTDC_G1"],
  [15, "G2", "PH13", "LTDC_G2"],
  [16, "G3", "PG10", "LTDC_G3"],
  [17, "G4", "PH15", "LTDC_G4"],
  [18, "G5", "PI0", "LTDC_G5"],
  [19, "G6", "PI1", "LTDC_G6"],
  [20, "G7", "PI2", "LTDC_G7"],
  [21, "B0", "PE4", "LTDC_B0"],
  [22, "B1", "PG12", "LTDC_B1"],
  [23, "B2", "PD6", "LTDC_B2"],
  [24, "B3", "PG11", "LTDC_B3"],
  [25, "B4", "PI4", "LTDC_B4"],
  [26, "B5", "PI5", "LTDC_B5"],
  [27, "B6", "PI6", "LTDC_B6"],
  [28, "B7", "PI7", "LTDC_B7"],
  [29, "GND"],
  [30, "CLK", "PG7", "LTDC_CLK"],
  [31, "3V3", undefined, "LCD_DISP", undefined, "DISP: the board ties it to 3.3 V, so the backlight is on whenever the board is"],
  [32, "HS", "PI10", "LTDC_HSYNC"],
  [33, "VS", "PI9", "LTDC_VSYNC"],
  [34, "DE", "PF10", "LTDC_DE"],
  [35, "BL", "PA3", "LCD_PWM", "TIM2_CH4", "Backlight PWM (the demos drive it as a GPIO)"],
  [36, "GND"],
  [37, "SDA", "PD13", "TP_SDA", "I2C4_SDA", "Touch controller; the demos bit-bang it"],
  [38, "SCL", "PD12", "TP_SCL", "I2C4_SCL"],
  [39, "RST", "PD11", "TP_RST", "I/O", "Touch controller reset"],
  [40, "INT", "PD7", "TP_INT", "I/O", "Touch controller interrupt"],
]

// --- Arduino headers (schematic page 4) ---------------------------------------------------------

const CN2: Row[] = [[1, "NC"], [2, "IOREF", undefined, "IOREF", "3.3 V"], [3, "NRST", "NRST", "RESET"], [4, "3V3"], [5, "5V"], [6, "GND"], [7, "GND"], [8, "VIN", undefined, "5Vin"]]
const CN3: Row[] = [
  [1, "A0", "PA0", "ADC", "ADC123_IN0", "Also the WAKEUP button (R9 0 Ω); PC13 by option"],
  [2, "A1", "PC13", "I/O", undefined, "No ADC on PC13; SDMMC card detect"],
  [3, "A2", "PF9", "ADC", "ADC3_IN7"],
  [4, "A3", "PF8", "ADC", "ADC3_IN6"],
  [5, "A4", "PF7", "ADC", "ADC3_IN5", "PB9 (I2C1_SDA) via JMP5"],
  [6, "A5", "PF6", "ADC", "ADC3_IN4", "PB8 (I2C1_SCL) via JMP5"],
]
const CN1: Row[] = [
  [1, "D8", "PI8", "I/O", undefined, "Shared with USER LED4 (JMP3)"],
  [2, "D9", "PA15", "PWM", "TIM2_CH1"],
  [3, "D10", "PB12", "PWM/CS", "SPI2_NSS"],
  [4, "D11", "PB15", "PWM/MOSI", "SPI2_MOSI"],
  [5, "D12", "PB14", "MISO", "SPI2_MISO"],
  [6, "D13", "PB13", "SCK", "SPI2_SCK"],
  [7, "GND"],
  [8, "AVDD", undefined, "AVDD", "3.3 V"],
  [9, "SDA", "PB9", "I2C1_SDA"],
  [10, "SCL", "PB8", "I2C1_SCL"],
]
const CN4: Row[] = [
  [1, "D0", "PC7", "RX", "USART6_RX"],
  [2, "D1", "PC6", "TX", "USART6_TX"],
  [3, "D2", "PH4", "I/O", undefined, "Shared with USER LED3 (JMP3)"],
  [4, "D3", "PB4", "PWM", "TIM3_CH1"],
  [5, "D4", "PB2", "I/O"],
  [6, "D5", "PA8", "PWM", "TIM1_CH1"],
  [7, "D6", "PB7", "PWM", "TIM4_CH2", "Shared with USER LED2 (JMP3)"],
  [8, "D7", "PI3", "I/O"],
]

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "GND") return "gnd"
  if (/^(3V3|5V|VIN|IOREF|AVDD|5VDC)$/.test(label)) return "power"
  if (/^A\d$/.test(label)) return "analog"
  if (label === "NC") return "nc"
  if (!mcu && !/^(NRST|DISP)$/.test(label)) return "nc"
  return "digital"
}

/** Shrouded connector bodies drawn behind the header pins, one per strip (merged for 2-row headers). */
const connectors: BodyShape[] = []
function shroud(x: number, y: number, w: number, h: number) {
  // A second row of the same header widens the first shroud instead of adding one.
  const prev = connectors.find((c) => c.type === "rect" && ((c.x === x && c.y === y + h) || (c.x === x && c.y + c.h === y) || (c.y === y && c.x === x + w) || (c.y === y && c.x + c.w === x)))
  if (prev && prev.type === "rect") {
    prev.x = Math.min(prev.x, x)
    prev.y = Math.min(prev.y, y)
    prev.w = Math.max(prev.x + prev.w, x + w) - prev.x
    prev.h = Math.max(prev.y + prev.h, y + h) - prev.y
    return
  }
  connectors.push({ type: "rect", x, y, w, h, rx: 0.15, fill: "connector" })
}

/** A row of header pins from (x, y), one cell apart along `dir`, wires leaving toward `side`. */
function strip(connector: string, rows: Row[], at: { x: number; y: number; dir: "down" | "right"; side: Side; labelAt: Side; stub: number }): PinDef[] {
  if (at.dir === "down") shroud(at.x - 0.5, at.y - 0.5, 1, rows.length)
  else shroud(at.x - 0.5, at.y - 0.5, rows.length, 1)
  return rows.map(([pin, label, mcu, signal, fn, note], i) => ({
    id: `${connector}-${pin}`,
    label,
    x: at.x + (at.dir === "right" ? i : 0),
    y: at.y + (at.dir === "down" ? i : 0),
    side: at.side,
    labelAt: at.labelAt,
    kind: kindOf(label, mcu),
    stub: at.stub,
    mcu: mcu === "NRST" ? undefined : mcu,
    signal,
    fn,
    connector,
    connectorPin: pin,
    note,
  }))
}

const L = { outer: 2, inner: 3 }
const R = { outer: WIDTH - 2, inner: WIDTH - 3 }
const left = (connector: string, rows: Row[], y: number, inner = false): PinDef[] =>
  strip(connector, rows, { x: inner ? L.inner : L.outer, y, dir: "down", side: "left", labelAt: inner ? "right" : "left", stub: inner ? 4 : 3 })
const right = (connector: string, rows: Row[], y: number, inner = false): PinDef[] =>
  strip(connector, rows, { x: inner ? R.inner : R.outer, y, dir: "down", side: "right", labelAt: inner ? "left" : "right", stub: inner ? 4 : 3 })
const top = (connector: string, rows: Row[], x: number, inner = false): PinDef[] =>
  strip(connector, rows, { x, y: inner ? 2 : 1, dir: "right", side: "top", labelAt: inner ? "bottom" : "top", stub: inner ? 3 : 2 })
const bottom = (connector: string, rows: Row[], x: number, inner = false): PinDef[] =>
  strip(connector, rows, { x, y: inner ? HEIGHT - 2 : HEIGHT - 1, dir: "right", side: "bottom", labelAt: inner ? "top" : "bottom", stub: inner ? 3 : 2 })

const pins: PinDef[] = [
  // Power: the 5 V jack (P22–P24 rails on the left edge; the jack itself is a pin on the top edge).
  { id: "5VDC", label: "5VDC", x: 5, y: 1, side: "top", labelAt: "bottom", kind: "power", stub: 2, connector: "DC jack", note: "5 V in; S2 picks this or the USART1 USB" },
  { id: "P22", label: "5V", x: L.outer, y: 1, side: "left", labelAt: "right", kind: "power", stub: 3, connector: "P22", note: "5 V rail out" },
  { id: "P23", label: "3V3", x: L.outer, y: 2, side: "left", labelAt: "right", kind: "power", stub: 3, connector: "P23", note: "3.3 V rail out (AMS1117 on the Core746I)" },
  { id: "P24", label: "GND", x: L.outer, y: 3, side: "left", labelAt: "right", kind: "gnd", stub: 3, connector: "P24" },
  // USART1 through the CP2102: the USB-to-serial bridge, as two pins for a serial terminal.
  { id: "VCP-TX", label: "TX", x: 31, y: 1, side: "top", labelAt: "bottom", kind: "digital", stub: 2, mcu: "PA9", signal: "USART1_TX", fn: "USART1_TX", connector: "JMP2", connectorPin: 1, note: "MCU → CP2102 → host; connect to a terminal's RX" },
  { id: "VCP-RX", label: "RX", x: 33, y: 1, side: "top", labelAt: "bottom", kind: "digital", stub: 2, mcu: "PA10", signal: "USART1_RX", fn: "USART1_RX", connector: "JMP2", connectorPin: 3, note: "Host → CP2102 → MCU; connect to a terminal's TX" },
  ...top("P6", SDMMC, 10),
  ...top("P3", QSPI, 21),
  ...top("P10", ULPI_ODD, 42),
  ...top("P10", ULPI_EVEN, 42, true),
  ...left("P2", USART3, 6),
  ...left("P7", CAN1, 14),
  ...left("P8", CAN2, 19),
  ...left("P4", I2C_ODD, 24),
  ...left("P4", I2C_EVEN, 24, true),
  ...left("P13", DCMI_ODD, 31),
  ...left("P13", DCMI_EVEN, 31, true),
  ...right("P11", ETH_ODD, 6, true),
  ...right("P11", ETH_EVEN, 6),
  ...right("P1", SPI2, 14, true),
  ...right("P1", SPI1, 14),
  ...right("P9", SAI_A, 21, true),
  ...right("P9", SAI_B, 21),
  ...right("P5", I2S3, 30, true),
  ...right("P5", I2S2, 30),
  ...bottom("P12", FMC_ODD, 8),
  ...bottom("P12", FMC_EVEN, 8, true),
  // P15 sits on the board's edge: the 7" LCD component's FFC pins land on it when the module is docked below.
  ...strip("P15", LCD7, { x: 26, y: HEIGHT, dir: "right", side: "bottom", labelAt: "bottom", stub: 1 }),
  // Arduino: power/analog column left of the shield area, digital column on its right.
  ...strip("CN2", CN2, { x: 35, y: 8, dir: "down", side: "left", labelAt: "right", stub: 1 }),
  ...strip("CN3", CN3, { x: 35, y: 17, dir: "down", side: "left", labelAt: "right", stub: 1 }),
  ...strip("CN1", CN1, { x: 44, y: 8, dir: "down", side: "right", labelAt: "left", stub: 1 }),
  ...strip("CN4", CN4, { x: 44, y: 19, dir: "down", side: "right", labelAt: "left", stub: 1 }),
]

const label = (x: number, y: number, text: string, size = 0.32): BodyShape => ({ type: "text", x, y, text, size, muted: true })

const body: BodyShape[] = [
  { type: "rect", x: 0, y: 0, w: WIDTH, h: HEIGHT, rx: 0.6, fill: "board" },
  ...connectors,
  // Core746I module, standing upright as on the photo, with its two 2×40 pin ports as strips.
  { type: "rect", x: 8, y: 5, w: 22, h: 36, rx: 0.4, fill: "zone" },
  { type: "rect", x: 8.4, y: 6, w: 1, h: 34, rx: 0.1, fill: "connector" },
  { type: "rect", x: 28.6, y: 6, w: 1, h: 34, rx: 0.1, fill: "connector" },
  { type: "text", x: 19, y: 6.3, text: "Core746I", size: 0.5 },
  { type: "rect", x: 10.5, y: 7.5, w: 6, h: 3, rx: 0.2, fill: "connector" },
  label(13.5, 9, "JTAG/SWD"),
  { type: "rect", x: 14, y: 16, w: 10, h: 10, rx: 0.3, fill: "chip" },
  { type: "text", x: 19, y: 20.6, text: "STM32F746IG", size: 0.55, inverse: true },
  { type: "text", x: 19, y: 21.9, text: "LQFP176 · 216 MHz", size: 0.35, inverse: true },
  { type: "rect", x: 10.5, y: 29, w: 4, h: 7, rx: 0.2, fill: "chip" },
  { type: "text", x: 12.5, y: 32.5, text: "SDRAM", size: 0.32, inverse: true, rotate: -90 },
  label(12.5, 36.6, "8 MB", 0.28),
  { type: "rect", x: 16, y: 38, w: 4, h: 2, rx: 0.2, fill: "connector" },
  label(18, 39, "USB OTG", 0.26),
  label(24, 38, "BOOT0", 0.26),
  label(24, 30, "8 MHz · 32k", 0.26),
  // Arduino shield area.
  label(39.5, 7, "Arduino"),
  label(35, 7, "CN2", 0.28),
  label(35, 16, "CN3", 0.28),
  label(44, 7, "CN1", 0.28),
  label(44, 18, "CN4", 0.28),
  // LCD 4.3" header (P14): the same RGB lines as P15 plus a resistive touch on SPI; drawn only.
  { type: "rect", x: 33, y: 29, w: 20, h: 2, rx: 0.2, fill: "connector" },
  label(43, 30, "P14 LCD 4.3inch (RGB as P15, XPT2046 on PF7/PF8/PF9, CS PF6, IRQ PD7)", 0.26),
  // Header names.
  label(5, 5.3, "P2 USART3", 0.28),
  label(5, 13.3, "P7 CAN1", 0.28),
  label(5, 18.3, "P8 CAN2", 0.28),
  label(5, 23.3, "P4 I2C2/I2C1", 0.28),
  label(5, 30.3, "P13 DCMI", 0.28),
  label(WIDTH - 5, 5.3, "P11 ETH", 0.28),
  label(WIDTH - 5, 13.3, "P1 SPI2/SPI1", 0.28),
  label(WIDTH - 5, 20.3, "P9 SAI A/B", 0.28),
  label(WIDTH - 5, 29.3, "P5 I2S3/I2S2", 0.28),
  label(14, 3.3, "P6 SDMMC", 0.28),
  label(24.5, 3.3, "P3 QUADSPI", 0.28),
  label(46.5, 3.6, "P10 USB HS ULPI", 0.28),
  label(12.5, HEIGHT - 3.4, "P12 8-bit FMC", 0.28),
  label(45.5, HEIGHT - 3.4, "P15 LCD 7inch (40-pin FFC)", 0.28),
  // USART1 / CP2102 zone with the micro-USB.
  { type: "rect", x: 30, y: 0.5, w: 10, h: 4, rx: 0.3, fill: "zone" },
  label(37.5, 3.6, "USART1 · CP2102", 0.26),
  // Power corner: the jack and the switch.
  label(5, 3.6, "5VDC", 0.26),
  label(7.6, 3.6, "S2", 0.26),
  // Board name.
  { type: "text", x: 19, y: 43.5, text: "Open746I-C", size: 0.8 },
  label(19, 45, "WaveShare", 0.36),
  label(60, 3.7, "USER LEDs", 0.28),
  label(55, 35.2, "Joystick", 0.28),
  label(64, 35.2, "WAKEUP", 0.28),
]

const parts: PartDef[] = [
  { type: "usb", id: "USB", label: "USART1 USB", x: 35, y: 1.3, side: "top", initial: { on: true } },
  { type: "switch", id: "S2", label: "S2: on = 5VDC jack, off = USB", x: 7, y: 2.2, span: 1.4 },
  { type: "led", id: "PWR", label: "PWR", x: 5, y: 2.4, color: "#ef4444" },
  { type: "led", id: "LED1", label: "LED1", x: 58, y: 2, color: "#ef4444", pin: "P3-6", mcu: "PB6" },
  { type: "led", id: "LED2", label: "LED2", x: 60, y: 2, color: "#ef4444", pin: "CN4-7", mcu: "PB7" },
  { type: "led", id: "LED3", label: "LED3", x: 62, y: 2, color: "#ef4444", pin: "CN4-3", mcu: "PH4" },
  { type: "led", id: "LED4", label: "LED4", x: 64, y: 2, color: "#ef4444", pin: "CN1-1", mcu: "PI8" },
  { type: "led", id: "TXLED", label: "TX", x: 32, y: 3, color: "#ef4444" },
  { type: "led", id: "RXLED", label: "RX", x: 33.5, y: 3, color: "#ef4444" },
  { type: "button", id: "JOY_A", label: "A", x: 55, y: 38, size: 1.2, mcu: "PG2" },
  { type: "button", id: "JOY_B", label: "B", x: 55, y: 42, size: 1.2, mcu: "PG3" },
  { type: "button", id: "JOY_C", label: "C", x: 53, y: 40, size: 1.2, mcu: "PD4", pin: "P12-8" },
  { type: "button", id: "JOY_D", label: "D", x: 57, y: 40, size: 1.2, mcu: "PD5", pin: "P12-10" },
  { type: "button", id: "JOY_CTR", label: "", x: 55, y: 40, size: 1.2, mcu: "PI11" },
  { type: "button", id: "WAKEUP", label: "K1", x: 64, y: 38, mcu: "PA0", pin: "CN3-1" },
  { type: "button", id: "RESET", label: "RESET", x: 4, y: 43, mcu: "NRST", pin: "P13-17" },
]

// --- electrical model ---------------------------------------------------------

/** Header pins per MCU pin: one driver per pad however many headers reach it. */
const byMcu = new Map<string, string[]>()
for (const p of pins) if (p.mcu) byMcu.set(p.mcu, [...(byMcu.get(p.mcu) ?? []), p.id])
/** Node of an MCU pin: its first header pin, or an internal "$Pxn" when no header reaches it. */
const nodeOf = (mcu: string) => byMcu.get(mcu)?.[0] ?? `$${mcu}`

const gndPins = pins.filter((p) => p.kind === "gnd").map((p) => p.id)
const GND = gndPins[0]
const v5Pins = pins.filter((p) => p.label === "5V" || p.label === "VIN").map((p) => p.id)
const v33Pins = pins.filter((p) => p.label === "3V3" || p.label === "IOREF" || p.label === "AVDD").map((p) => p.id)
const V5 = "P22"
const V3V3 = "P23"
const NRST = "P13-17"

const led = (mcu: string, part: string): Element[] => [
  { kind: "R", a: nodeOf(mcu), b: `$${part}k`, value: 1e3 },
  { kind: "D", anode: `$${part}k`, cathode: GND, vf: LED_COLORS.red.vf, part },
]
const joystick = (mcu: string, part: string): Element => ({ kind: "SW", a: nodeOf(mcu), b: GND, part, closed: "pressed" })

const model: Element[] = [
  { kind: "SHORT", nodes: gndPins },
  { kind: "GND", node: GND },
  { kind: "SHORT", nodes: v5Pins },
  { kind: "SHORT", nodes: v33Pins },
  { kind: "SHORT", nodes: [NRST, "CN2-3"] },
  // Power tree: the USART1 micro-USB's VBUS (U5V) or the 5 V jack, chosen by S2, is 5Vin; the
  // Core746I's AMS1117-3.3 makes 3.3 V from it. The CP2102 lives on U5V alone.
  { kind: "V", plus: "$usb", minus: GND, value: 5 },
  { kind: "SW", a: "$usb", b: "$u5v", part: "USB", closed: "on" },
  { kind: "REG", in: "$u5v", out: "$u5vlim", gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "R", a: "$u5v", b: GND, value: 250 },
  { kind: "SW", a: "$u5vlim", b: "$5vin", part: "S2", closed: "off" },
  { kind: "SW", a: "5VDC", b: "$5vin", part: "S2", closed: "on" },
  { kind: "R", a: "$5vin", b: V5, value: 0.02 },
  { kind: "REG", in: "$5vin", out: "$3v3", gnd: GND, value: 3.3, dropout: 1.1, imax: 1 },
  { kind: "R", a: "$3v3", b: V3V3, value: 0.02 },
  { kind: "R", a: "$3v3", b: "$pwrk", value: 330 },
  { kind: "D", anode: "$pwrk", cathode: GND, vf: LED_COLORS.red.vf, part: "PWR" },
  // CP2102 TX/RX activity LEDs: 1 kΩ from 3.3 V, lit by the bridge while a line is low.
  { kind: "R", a: "$3v3", b: "$txk", value: 1e3 },
  { kind: "D", anode: "$txk", cathode: "VCP-TX", vf: LED_COLORS.red.vf, part: "TXLED" },
  { kind: "R", a: "$3v3", b: "$rxk", value: 1e3 },
  { kind: "D", anode: "$rxk", cathode: "VCP-RX", vf: LED_COLORS.red.vf, part: "RXLED" },
  // RESET shorts NRST (internal pull-up) to ground; the 1 nF on it is left out.
  { kind: "SW", a: NRST, b: GND, part: "RESET", closed: "pressed" },
  // USER LEDs: pin → 1 kΩ → LED → GND (JMP3 closed).
  ...led("PB6", "LED1"),
  ...led("PB7", "LED2"),
  ...led("PH4", "LED3"),
  ...led("PI8", "LED4"),
  // Joystick: five contacts to ground, the firmware's pull-ups hold the pins high (JMP4 closed).
  joystick("PG2", "JOY_A"),
  joystick("PG3", "JOY_B"),
  joystick("PD4", "JOY_C"),
  joystick("PD5", "JOY_D"),
  joystick("PI11", "JOY_CTR"),
  // WAKEUP: PA0 held down by 10 kΩ (and 100 nF), K1 pulls it up through 10 kΩ (JMP6 closed).
  { kind: "R", a: nodeOf("PA0"), b: GND, value: 10e3 },
  { kind: "C", a: nodeOf("PA0"), b: GND, value: 100e-9 },
  { kind: "R", a: "$k1", b: "$3v3", value: 10e3 },
  { kind: "SW", a: nodeOf("PA0"), b: "$k1", part: "WAKEUP", closed: "pressed" },
  // Several header pins on one MCU pin share one driver.
  ...[...byMcu.values()].filter((ids) => ids.length > 1).map((ids): Element => ({ kind: "SHORT", nodes: ids })),
  // The MCU: supply load, NRST pull-up, a GPIO driver behind every header pin and every internal pin.
  ...mcuModel(STM32F746IG, { vdd: "$3v3", gnd: GND, nrst: NRST, pads: [...[...byMcu.values()].map((ids) => ids[0]), "$PG2", "$PG3", "$PI11"] }),
]

export const open746ic: ComponentDef = {
  id: "open746i-c",
  name: "Open746I-C",
  description: "STM32F746IG · Waveshare",
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
  chip: STM32F746IG.id,
  mcuPower: V3V3,
  mcuReset: NRST,
  // Core746I: 8 MHz crystal on PH0/PH1, 32.768 kHz on PC14/PC15.
  mcuClocks: { hse: { hz: 8e6, kind: "crystal", startup: 2e-3 }, lse: { hz: 32768, kind: "crystal", startup: 2 } },
  // IS42S16400J on FMC SDRAM bank 2: 8 MB at 0xD000_0000, usable once the FMC has set it up.
  mcuMemory: [{ name: "SDRAM", base: 0xd0000000, size: 0x800000, kind: "ram", external: "sdram2" }],
  info: {
    MCU: "STM32F746IGT6 on the Core746I, Cortex-M7 216 MHz, 1 MB Flash, 320 KB SRAM, 8 MB SDRAM (IS42S16400J, FMC bank 2 at 0xD0000000)",
    "USART1": "PA9 TX, PA10 RX through the CP2102 USB-UART bridge (JMP2)",
    "USER LEDs": "PB6, PB7, PH4, PI8 → 1 kΩ → LED → GND (JMP3)",
    Joystick: "A PG2, B PG3, C PD4, D PD5, centre PI11, to GND (JMP4)",
    WAKEUP: "PA0, active high: 10 kΩ pull-down, K1 to 3.3 V through 10 kΩ (JMP6)",
    "LCD 7inch (P15)": "24-bit RGB on the LTDC, backlight PA3, GT911 touch on PD13/PD12 (I2C4), RST PD11, INT PD7",
    "USB OTG FS (Core746I)": "DM PA11, DP PA12, ID PA10, VBUS PA9 — not modelled",
    "Not fitted here": "BOOT0 switch (always boots from flash), JTAG/SWD (no debugger), the 2×40 pin ports P16–P21 (every I/O; use the peripheral headers)",
    Source: "Waveshare Open746I-C and Core746I schematics",
  },
}
