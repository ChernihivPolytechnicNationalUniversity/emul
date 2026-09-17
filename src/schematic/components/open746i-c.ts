import { STM32F746IG } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind, Side } from "../types"
import { LED_COLORS } from "./basic"

/**
 * Waveshare Open746I-C: the mother board with the Core746I module (STM32F746IGT6, 8 MB SDRAM)
 * on it — the university's lab stand. Pin data from the board and module schematics; the
 * layout is traced from Waveshare's dimension drawing (185 × 135 mm), every header, LED and
 * button where it is on the board: the module on the left, Arduino headers to its right,
 * USART3/CAN/I2C/DCMI down the left edge, SDMMC/QUADSPI/power/USART1/I2S along the top,
 * ETH/SPI/SAI down the right edge, FMC/ULPI/the 7" LCD's FFC along the bottom, the LEDs in a
 * column top right, joystick and WAKEUP bottom right, RESET bottom left.
 * Scale: 1 cell = 2.54 mm; 185 × 135 mm ≈ 73 × 53 cells, drawn 76 × 56 so every header keeps
 * its names inside its body and a margin from the edge.
 */

/** [header pin, label, MCU pin, signal, function, note] */
type Row = [number, string, string?, string?, string?, string?]

const WIDTH = 76
const HEIGHT = 56

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
const SDMMC: Row[] = [[1, "3V3"], [2, "GND"], [3, "D0", "PC8", "SDMMC1_D0"], [4, "CMD", "PD2", "SDMMC1_CMD"], [5, "CLK", "PC12", "SDMMC1_CK"], [6, "D3", "PC11", "SDMMC1_D3"], [7, "D2", "PC10", "SDMMC1_D2"], [8, "D1", "PC9", "SDMMC1_D1"], [9, "CD", undefined, "SDIO_CD", undefined, "Card detect: PC13 through JMP1"]]
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
/** CN5, the Arduino ICSP header: SPI2 again plus reset. */
const ICSP_ODD: Row[] = [[1, "MISO", "PB14", "SPI2_MISO"], [3, "SCK", "PB13", "SPI2_SCK"], [5, "RST", "NRST", "RESET"]]
const ICSP_EVEN: Row[] = [[2, "3V3"], [4, "MOSI", "PB15", "SPI2_MOSI"], [6, "GND"]]

function kindOf(label: string, mcu?: string): PinKind {
  if (label === "GND") return "gnd"
  if (/^(3V3|5V|VIN|IOREF|AVDD|5VDC)$/.test(label)) return "power"
  if (/^A\d$/.test(label)) return "analog"
  if (label === "NC") return "nc"
  if (!mcu && !/^(NRST|RST|DISP)$/.test(label)) return "nc"
  return "digital"
}

/**
 * Connector bodies drawn behind the header pins, one per connector: the rows of a 2-row header
 * share one. The body takes the pin names in — a label sits 0.45 cells off its pin and runs
 * about 0.19 cells a character — so nothing crosses its outline.
 */
const connectors: BodyShape[] = []
const shrouds = new Map<string, Extract<BodyShape, { type: "rect" }>>()
function shroud(connector: string, x0: number, y0: number, x1: number, y1: number) {
  const prev = shrouds.get(connector)
  if (prev) {
    const nx = Math.min(prev.x, x0)
    const ny = Math.min(prev.y, y0)
    prev.w = Math.max(prev.x + prev.w, x1) - nx
    prev.h = Math.max(prev.y + prev.h, y1) - ny
    prev.x = nx
    prev.y = ny
    return
  }
  const rect: Extract<BodyShape, { type: "rect" }> = { type: "rect", x: x0, y: y0, w: x1 - x0, h: y1 - y0, rx: 0.3, fill: "connector" }
  shrouds.set(connector, rect)
  connectors.push(rect)
}

/** A row of header pins from (x, y), one cell apart along `dir`, wires leaving toward `side`. */
function strip(connector: string, rows: Row[], at: { x: number; y: number; dir: "down" | "right"; side: Side; labelAt: Side; stub: number }): PinDef[] {
  const n = rows.length
  // A name beside its pin takes its length; above or below it takes one line.
  const beside = 0.45 + 0.19 * Math.max(...rows.map(([, label]) => label.length)) + 0.35
  const above = 0.45 + 0.3 + 0.35
  const x0 = at.x - 0.5 - (at.labelAt === "left" ? beside : 0)
  const x1 = at.x + (at.dir === "right" ? n - 0.5 : 0.5) + (at.labelAt === "right" ? beside : 0)
  const y0 = at.y - 0.5 - (at.labelAt === "top" ? above : 0)
  const y1 = at.y + (at.dir === "down" ? n - 0.5 : 0.5) + (at.labelAt === "bottom" ? above : 0)
  shroud(connector, x0, y0, x1, y1)
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

// Edge headers sit 4 cells in from the edge so their outward names stay on the board.
const L = { outer: 4, inner: 5 }
const R = { outer: WIDTH - 4, inner: WIDTH - 5 }
const T = { outer: 3, inner: 4 }
const B = { outer: HEIGHT - 3, inner: HEIGHT - 4 }
const left = (connector: string, rows: Row[], y: number, inner = false): PinDef[] =>
  strip(connector, rows, { x: inner ? L.inner : L.outer, y, dir: "down", side: "left", labelAt: inner ? "right" : "left", stub: inner ? L.inner : L.outer })
const right = (connector: string, rows: Row[], y: number, inner = false): PinDef[] =>
  strip(connector, rows, { x: inner ? R.inner : R.outer, y, dir: "down", side: "right", labelAt: inner ? "left" : "right", stub: inner ? L.inner : L.outer })
const top = (connector: string, rows: Row[], x: number, inner = false): PinDef[] =>
  strip(connector, rows, { x, y: inner ? T.inner : T.outer, dir: "right", side: "top", labelAt: inner ? "bottom" : "top", stub: inner ? T.inner : T.outer })
const bottom = (connector: string, rows: Row[], x: number, inner = false): PinDef[] =>
  strip(connector, rows, { x, y: inner ? B.inner : B.outer, dir: "right", side: "bottom", labelAt: inner ? "top" : "bottom", stub: inner ? T.inner : T.outer })

/** P22–P24: the three 4-pin power rows on the top edge (5 V, GND, 3.3 V), one name per row. */
function rail(connector: string, label: string, kind: PinKind, y: number): PinDef[] {
  shroud("P22-P24", 38.5 - (0.45 + 0.19 * 3 + 0.35), y - 0.5, 42.5, y + 0.5)
  return [1, 2, 3, 4].map((pin) => ({ id: `${connector}-${pin}`, label: pin === 1 ? label : "", x: 38 + pin, y, side: "top", labelAt: "left", kind, stub: y, connector, connectorPin: pin, note: `${label} rail` }))
}

/** P15 pins in two rows of twenty on the bottom edge like the other 2-row headers: 1–20 above 21–40. */
const LCD7_A = LCD7.slice(0, 20)
const LCD7_B = LCD7.slice(20)
/** First FFC pin's column; the LCD component's tail has the same two rows at its own offset. */
const FFC_X = 35

const pins: PinDef[] = [
  // Power: the 5 V jack on the top edge (S2 picks it or the USART1 USB) and the P22–P24 rails.
  { id: "5VDC", label: "5VDC", x: 13, y: T.outer, side: "top", labelAt: "bottom", kind: "power", stub: T.outer, connector: "DC jack", note: "5 V in; S2 picks this or the USART1 USB as 5Vin, and the module takes 5Vin with SW1 off" },
  ...rail("P22", "5V", "power", 3),
  ...rail("P24", "GND", "gnd", 4),
  ...rail("P23", "3V3", "power", 5),
  // USART1 through the CP2102: the USB-to-serial bridge, as two pins either side of its micro-USB.
  { id: "VCP-TX", label: "TX", x: 46, y: T.outer, side: "top", labelAt: "bottom", kind: "digital", stub: T.outer, mcu: "PA9", signal: "USART1_TX", fn: "USART1_TX", connector: "JMP2", connectorPin: 1, note: "MCU → CP2102 → host; connect to a terminal's RX" },
  { id: "VCP-RX", label: "RX", x: 52, y: T.outer, side: "top", labelAt: "bottom", kind: "digital", stub: T.outer, mcu: "PA10", signal: "USART1_RX", fn: "USART1_RX", connector: "JMP2", connectorPin: 3, note: "Host → CP2102 → MCU; connect to a terminal's TX" },
  ...top("P6", SDMMC, 17),
  ...top("P3", QSPI, 28),
  // I2S sits inside the top edge, right of USART1; its wires leave upward.
  ...strip("P5", I2S3, { x: 55, y: 6, dir: "right", side: "top", labelAt: "top", stub: 6 }),
  ...strip("P5", I2S2, { x: 55, y: 7, dir: "right", side: "top", labelAt: "bottom", stub: 7 }),
  ...left("P2", USART3, 6),
  ...left("P8", CAN2, 16),
  ...left("P7", CAN1, 23),
  ...left("P4", I2C_ODD, 30),
  ...left("P4", I2C_EVEN, 30, true),
  ...left("P13", DCMI_ODD, 38),
  ...left("P13", DCMI_EVEN, 38, true),
  ...right("P11", ETH_ODD, 18, true),
  ...right("P11", ETH_EVEN, 18),
  ...right("P1", SPI2, 28, true),
  ...right("P1", SPI1, 28),
  ...right("P9", SAI_A, 37, true),
  ...right("P9", SAI_B, 37),
  ...bottom("P12", FMC_ODD, 11),
  ...bottom("P12", FMC_EVEN, 11, true),
  ...bottom("P10", ULPI_ODD, 23),
  ...bottom("P10", ULPI_EVEN, 23, true),
  // P15 on the bottom edge as 2 × 20: the 7" LCD's FFC tail (the same two rows on itself)
  // lands on it when the module is docked below, or the lines are wired one by one.
  ...bottom("P15", LCD7_A, FFC_X, true),
  ...bottom("P15", LCD7_B, FFC_X),
  // Arduino: power/analog column left of the shield area, digital column on its right, ICSP below.
  ...strip("CN2", CN2, { x: 44, y: 18, dir: "down", side: "left", labelAt: "right", stub: 1 }),
  ...strip("CN3", CN3, { x: 44, y: 28, dir: "down", side: "left", labelAt: "right", stub: 1 }),
  ...strip("CN1", CN1, { x: 63, y: 14, dir: "down", side: "right", labelAt: "left", stub: 1 }),
  ...strip("CN4", CN4, { x: 63, y: 26, dir: "down", side: "right", labelAt: "left", stub: 1 }),
  ...strip("CN5", ICSP_ODD, { x: 53, y: 36, dir: "right", side: "bottom", labelAt: "top", stub: 2 }),
  ...strip("CN5", ICSP_EVEN, { x: 53, y: 37, dir: "right", side: "bottom", labelAt: "bottom", stub: 1 }),
  // BOOT0 as the pin ports carry it, next to the module's BOOT switch that drives it.
  // VBAT as the pin ports carry it: the module's jumper ties it to 3.3 V, or a battery goes here.
  { id: "VBAT", label: "VBAT", x: 21, y: 13.6, side: "top", labelAt: "right", kind: "power", stub: 0, signal: "VBAT", connector: "P16", connectorPin: 9, note: "Backup-domain supply (1.65–3.6 V): with the jumper open, a battery here keeps the RTC and backup registers through a power cut" },
  { id: "BOOT0", label: "BOOT0", x: 21, y: 35, side: "bottom", labelAt: "right", kind: "digital", stub: 0, signal: "BOOT0", connector: "P16", connectorPin: 65, note: "Boot switch: FLASH ties it to ground, SYSTEM to 3.3 V through 10 kΩ (the ST bootloader is not modelled: the core idles in system memory)" },
]

const label = (x: number, y: number, text: string, size = 0.32): BodyShape => ({ type: "text", x, y, text, size, muted: true })
/** A connector or part that is drawn but not a pin (not modelled). */
const block = (x: number, y: number, w: number, h: number, text: string, at: [number, number], size = 0.26): BodyShape[] => [
  { type: "rect", x, y, w, h, rx: 0.3, fill: "connector" },
  label(at[0], at[1], text, size),
]

// The Core746I: 83 × 57.5 mm standing upright on its two 2 × 40 pin ports, JTAG at the top,
// USB OTG at the bottom, the LQFP176 turned 45° in the middle.
const CHIP = { cx: 22, cy: 22, d: 6.5 }

const body: BodyShape[] = [
  { type: "rect", x: 0, y: 0, w: WIDTH, h: HEIGHT, rx: 3, fill: "board" },
  ...connectors,
  // --- the module
  { type: "rect", x: 10, y: 7, w: 24, h: 34, rx: 0.4, fill: "zone" },
  { type: "rect", x: 11, y: 7.5, w: 1.5, h: 33, rx: 0.1, fill: "connector" },
  { type: "rect", x: 31.5, y: 7.5, w: 1.5, h: 33, rx: 0.1, fill: "connector" },
  label(24, 42, "P16–P21: two 2×40 pin ports, every I/O (use the peripheral headers)", 0.24),
  ...block(16, 8, 12, 3.5, "JTAG/SWD", [22, 12.2]),
  label(17.7, 12.6, "VBAT JMP", 0.24),
  label(16.4, 13.65, "3.3V", 0.22),
  { type: "path", d: `M ${CHIP.cx} ${CHIP.cy - CHIP.d} L ${CHIP.cx + CHIP.d} ${CHIP.cy} L ${CHIP.cx} ${CHIP.cy + CHIP.d} L ${CHIP.cx - CHIP.d} ${CHIP.cy} Z`, fill: "chip" },
  { type: "text", x: CHIP.cx, y: CHIP.cy - 0.2, text: "STM32F746IG", size: 0.55, inverse: true },
  { type: "text", x: CHIP.cx, y: CHIP.cy + 1.1, text: "LQFP176 · 216 MHz", size: 0.35, inverse: true },
  { type: "text", x: 14.5, y: 30, text: "Core7XXI", size: 0.8, rotate: -90 },
  label(21, 31.4, "BOOT", 0.26),
  label(19.6, 32.5, "FLASH", 0.24),
  label(22.4, 32.5, "SYSTEM", 0.24),
  label(26.5, 31.4, "RESET", 0.26),
  label(15, 36.6, "USB OTG", 0.26),
  label(19.6, 36.6, "SW1: USB ↔ 5Vin", 0.26),
  label(24.5, 38.6, "IS42S16400J", 0.26),
  label(24.5, 39.3, "8 MB SDRAM (back)", 0.26),
  label(28.5, 39.5, "PWR", 0.22),
  // --- top edge
  label(8, 1.2, "S2: 5VDC ↔ USB", 0.26),
  { type: "rect", x: 12, y: 1.5, w: 2, h: 4, rx: 0.3, fill: "connector" },
  label(13, 6.2, "5V DC", 0.26),
  label(21, 5.2, "P6 SDMMC", 0.28),
  label(31.5, 5.2, "P3 QUADSPI", 0.28),
  label(40, 7, "P22–P24 rails", 0.26),
  { type: "rect", x: 47.75, y: 5.5, w: 2.5, h: 2, rx: 0.2, fill: "chip" },
  { type: "text", x: 49, y: 6.6, text: "CP2102", size: 0.26, inverse: true },
  label(49, 9, "USART1", 0.28),
  label(58.5, 10.5, "P5 I2S3 · I2S2", 0.28),
  label(71, 1.2, "LEDs", 0.28),
  label(66.5, 7.6, "JMP3", 0.24),
  label(25.3, 5.2, "JMP1 CD", 0.24),
  // --- Arduino shield area
  label(54, 15, "Arduino", 0.32),
  label(45, 16.5, "CN2", 0.28),
  label(45, 26.5, "CN3", 0.28),
  label(62, 12.5, "CN1", 0.28),
  label(62, 24.5, "CN4", 0.28),
  label(54, 33.8, "CN5 ICSP", 0.28),
  label(54, 19, "WaveShare", 0.6),
  // --- left edge
  label(3, 14, "P2 USART3", 0.28),
  label(3, 21, "P8 CAN2", 0.28),
  label(3, 28, "P7 CAN1", 0.28),
  label(4.5, 36, "P4 I2C2 · I2C1", 0.28),
  label(4.5, 51, "P13 DCMI", 0.28),
  // --- right edge
  label(71.5, 26, "P11 ETH", 0.28),
  label(71.5, 35, "P1 SPI2 · SPI1", 0.28),
  label(71.5, 46, "P9 SAI1 A · B", 0.28),
  // --- bottom edge
  label(15.5, 48.5, "P12 8-bit FMC", 0.28),
  label(27.5, 48.5, "P10 USB HS ULPI", 0.28),
  ...block(43, 41.5, 20, 2, "P14 LCD 4.3inch (drawn only)", [53, 40.8]),
  label(44.5, 48.5, "P15 LCD 7inch · 40-pin FFC", 0.28),
  // --- names
  { type: "text", x: 22, y: 45.5, text: "Open7XXI-C", size: 0.8 },
  { type: "text", x: 44.5, y: 45.5, text: "Cortex-M7", size: 0.5 },
  label(65, 47.5, "Joystick", 0.28),
  label(70.5, 45.7, "JMP4", 0.24),
  ...(["A", "B", "C", "D", "·"] as const).map((t, i) => label(69.4, 47 + i * 1.5 + 0.05, t, 0.22)),
  label(58, 48.5, "WAKEUP", 0.28),
  label(60.3, 50.2, "JMP6", 0.22),
  label(8, 50.5, "RESET", 0.28),
]

const parts: PartDef[] = [
  // Power comes in on the module's own micro-USB (SW1 at USB), as the lab runs it; the USART1
  // micro-USB is plugged for the serial port and could power the board instead (SW1 at 5Vin, S2 at USB).
  { type: "usb", id: "USB", label: "USART1 USB", x: 49, y: 1.6, side: "top", initial: { on: true } },
  { type: "switch", id: "S2", label: "S2: on = 5VDC jack, off = USART1 USB", x: 7, y: 3, span: 2 },
  { type: "usb", id: "MUSB", label: "Core746I USB OTG", x: 15, y: 38.5, side: "bottom", initial: { on: true } },
  { type: "switch", id: "SW1", label: "SW1: on = the module's USB, off = 5Vin from the board (S2)", x: 18.8, y: 38.6, span: 1.6, initial: { on: true } },
  { type: "switch", id: "VBATJ", label: "VBAT jumper: on = VBAT from the 3.3 V rail (as shipped), off = a battery on the VBAT pin", x: 17.4, y: 13.6, span: 1.6, initial: { on: true } },
  // The board's jumpers, closed as shipped: opening one frees the MCU pin for the header that shares it.
  { type: "switch", id: "JMP1", label: "JMP1: SDMMC card detect ↔ PC13", x: 24.5, y: 6.3, span: 1, initial: { on: true } },
  ...(["PB6", "PB7", "PH4", "PI8"] as const).map((mcu, i): PartDef => ({ type: "switch", id: `JMP3_${i + 1}`, label: `JMP3: LED${i + 1} ↔ ${mcu}`, x: 66, y: 9 + i * 2, span: 1, initial: { on: true } })),
  ...(["A PG2", "B PG3", "C PD4", "D PD5", "centre PI11"] as const).map((what, i): PartDef => ({ type: "switch", id: `JMP4_${i + 1}`, label: `JMP4: joystick ${what}`, x: 70, y: 47 + i * 1.5, span: 1, initial: { on: true } })),
  { type: "switch", id: "JMP6", label: "JMP6: WAKEUP button ↔ PA0", x: 57.5, y: 49.8, span: 1, initial: { on: true } },
  { type: "switch", id: "BOOT", label: "BOOT: off = FLASH (user firmware), on = SYSTEM (ST bootloader, not modelled)", x: 20.2, y: 33.5, span: 1.6, pin: "BOOT0" },
  // The LED column top right: PWR, the CP2102's RX/TX, the four USER LEDs.
  { type: "led", id: "PWR", label: "PWR", x: 71, y: 3, color: "#ef4444" },
  { type: "led", id: "RXLED", label: "RX", x: 71, y: 5, color: "#ef4444" },
  { type: "led", id: "TXLED", label: "TX", x: 71, y: 7, color: "#ef4444" },
  { type: "led", id: "LED1", label: "LED1", x: 71, y: 9, color: "#ef4444", pin: "P3-6", mcu: "PB6" },
  { type: "led", id: "LED2", label: "LED2", x: 71, y: 11, color: "#ef4444", pin: "CN4-7", mcu: "PB7" },
  { type: "led", id: "LED3", label: "LED3", x: 71, y: 13, color: "#ef4444", pin: "CN4-3", mcu: "PH4" },
  { type: "led", id: "LED4", label: "LED4", x: 71, y: 15, color: "#ef4444", pin: "CN1-1", mcu: "PI8" },
  // The module's own power LED.
  { type: "led", id: "MPWR", label: "", x: 28.5, y: 38.5, color: "#ef4444" },
  // Five-way joystick: A up, B right, C left, D down, the centre pressed straight in.
  { type: "button", id: "JOY_A", label: "A", x: 65, y: 49, size: 1.2, mcu: "PG2" },
  { type: "button", id: "JOY_B", label: "B", x: 67, y: 51, size: 1.2, mcu: "PG3" },
  { type: "button", id: "JOY_C", label: "C", x: 63, y: 51, size: 1.2, mcu: "PD4", pin: "P12-8" },
  { type: "button", id: "JOY_D", label: "D", x: 65, y: 53, size: 1.2, mcu: "PD5", pin: "P12-10" },
  { type: "button", id: "JOY_CTR", label: "", x: 65, y: 51, size: 1.2, mcu: "PI11" },
  { type: "button", id: "WAKEUP", label: "K1", x: 58, y: 52, mcu: "PA0", pin: "CN3-1" },
  { type: "button", id: "RESET", label: "", x: 8, y: 53, mcu: "NRST", pin: "P13-17" },
  // The module's own reset button, on the same NRST.
  { type: "button", id: "MRESET", label: "", x: 26.5, y: 33.5, size: 1.2, mcu: "NRST", pin: "P13-17" },
]

// --- electrical model ---------------------------------------------------------

/** Header pins per MCU pin: one driver per pad however many headers reach it. */
const byMcu = new Map<string, string[]>()
for (const p of pins) if (p.mcu) byMcu.set(p.mcu, [...(byMcu.get(p.mcu) ?? []), p.id])
/** Node of an MCU pin: its first header pin, or an internal "$Pxn" when no header reaches it. */
const nodeOf = (mcu: string) => byMcu.get(mcu)?.[0] ?? `$${mcu}`

const gndPins = pins.filter((p) => p.kind === "gnd").map((p) => p.id)
const GND = gndPins[0]
const v5Pins = pins.filter((p) => p.label === "5V" || p.label === "VIN" || p.connector === "P22").map((p) => p.id)
const v33Pins = pins.filter((p) => p.label === "3V3" || p.label === "IOREF" || p.label === "AVDD" || p.connector === "P23").map((p) => p.id)
const V5 = "P22-1"
const V3V3 = "P23-1"
const NRST = "P13-17"

const led = (mcu: string, part: string, jumper: string): Element[] => [
  { kind: "SW", a: nodeOf(mcu), b: `$${part}j`, part: jumper, closed: "on" },
  { kind: "R", a: `$${part}j`, b: `$${part}k`, value: 1e3 },
  { kind: "D", anode: `$${part}k`, cathode: GND, vf: LED_COLORS.red.vf, part },
]
const joystick = (mcu: string, part: string, jumper: string): Element[] => [
  { kind: "SW", a: nodeOf(mcu), b: `$${part}j`, part: jumper, closed: "on" },
  { kind: "R", a: `$${part}j`, b: GND, value: 10e6, hidden: true },
  { kind: "SW", a: `$${part}j`, b: GND, part, closed: "pressed" },
]

const model: Element[] = [
  { kind: "SHORT", nodes: gndPins },
  { kind: "GND", node: GND },
  { kind: "SHORT", nodes: v5Pins },
  { kind: "SHORT", nodes: v33Pins },
  { kind: "SHORT", nodes: [NRST, "CN2-3", "CN5-5"] },
  // Power tree. On the board, S2 picks the USART1 micro-USB's VBUS (U5V) or the 5 V jack as
  // 5Vin, which reaches the module over the pin ports. On the module, SW1 picks 5Vin or the
  // module's own micro-USB (USB_5V) as its 5 V, and the AMS1117-3.3 makes 3.3 V from that. The
  // CP2102 lives on U5V alone.
  { kind: "V", plus: "$usb", minus: GND, value: 5 },
  { kind: "SW", a: "$usb", b: "$u5v", part: "USB", closed: "on" },
  { kind: "REG", in: "$u5v", out: "$u5vlim", gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "R", a: "$u5v", b: GND, value: 250 },
  { kind: "SW", a: "$u5vlim", b: "$5vin", part: "S2", closed: "off" },
  { kind: "SW", a: "5VDC", b: "$5vin", part: "S2", closed: "on" },
  { kind: "V", plus: "$musb", minus: GND, value: 5 },
  { kind: "SW", a: "$musb", b: "$usb5v", part: "MUSB", closed: "on" },
  { kind: "REG", in: "$usb5v", out: "$usb5vlim", gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "R", a: "$usb5v", b: GND, value: 250 },
  { kind: "SW", a: "$usb5vlim", b: "$5v", part: "SW1", closed: "on" },
  { kind: "SW", a: "$5vin", b: "$5v", part: "SW1", closed: "off" },
  { kind: "R", a: "$5v", b: V5, value: 0.02 },
  { kind: "REG", in: "$5v", out: "$3v3", gnd: GND, value: 3.3, dropout: 1.1, imax: 1 },
  { kind: "R", a: "$3v3", b: V3V3, value: 0.02 },
  { kind: "R", a: "$3v3", b: "$pwrk", value: 330 },
  { kind: "D", anode: "$pwrk", cathode: GND, vf: LED_COLORS.red.vf, part: "PWR" },
  { kind: "R", a: "$3v3", b: "$mpwrk", value: 330 },
  { kind: "D", anode: "$mpwrk", cathode: GND, vf: LED_COLORS.red.vf, part: "MPWR" },
  // CP2102 TX/RX activity LEDs: 1 kΩ from 3.3 V, lit by the bridge while a line is low.
  { kind: "R", a: "$3v3", b: "$txk", value: 1e3 },
  { kind: "D", anode: "$txk", cathode: "VCP-TX", vf: LED_COLORS.red.vf, part: "TXLED" },
  { kind: "R", a: "$3v3", b: "$rxk", value: 1e3 },
  { kind: "D", anode: "$rxk", cathode: "VCP-RX", vf: LED_COLORS.red.vf, part: "RXLED" },
  // BOOT switch on the module: FLASH grounds BOOT0, SYSTEM lifts it to 3.3 V through 10 kΩ.
  { kind: "SW", a: "BOOT0", b: GND, part: "BOOT", closed: "off" },
  { kind: "R", a: "$boot0hi", b: "$3v3", value: 10e3 },
  { kind: "SW", a: "BOOT0", b: "$boot0hi", part: "BOOT", closed: "on" },
  // RESET shorts NRST (internal pull-up) to ground; the 1 nF on it is left out.
  { kind: "SW", a: NRST, b: GND, part: "RESET", closed: "pressed" },
  { kind: "SW", a: NRST, b: GND, part: "MRESET", closed: "pressed" },
  // USER LEDs: pin → 1 kΩ → LED → GND (JMP3 closed).
  ...led("PB6", "LED1", "JMP3_1"),
  ...led("PB7", "LED2", "JMP3_2"),
  ...led("PH4", "LED3", "JMP3_3"),
  ...led("PI8", "LED4", "JMP3_4"),
  // Joystick: five contacts to ground, the firmware's pull-ups hold the pins high (JMP4 closed).
  ...joystick("PG2", "JOY_A", "JMP4_1"),
  ...joystick("PG3", "JOY_B", "JMP4_2"),
  ...joystick("PD4", "JOY_C", "JMP4_3"),
  ...joystick("PD5", "JOY_D", "JMP4_4"),
  ...joystick("PI11", "JOY_CTR", "JMP4_5"),
  // WAKEUP: behind JMP6, the line is held down by 10 kΩ (and 100 nF) and K1 pulls it up through 10 kΩ.
  { kind: "SW", a: nodeOf("PA0"), b: "$wk", part: "JMP6", closed: "on" },
  { kind: "R", a: "$wk", b: GND, value: 10e3 },
  { kind: "C", a: "$wk", b: GND, value: 100e-9 },
  { kind: "R", a: "$k1", b: "$3v3", value: 10e3 },
  { kind: "SW", a: "$wk", b: "$k1", part: "WAKEUP", closed: "pressed" },
  // SDMMC card detect: the header pin reaches PC13 through JMP1.
  { kind: "SW", a: "P6-9", b: nodeOf("PC13"), part: "JMP1", closed: "on" },
  { kind: "R", a: "P6-9", b: GND, value: 10e6, hidden: true },
  // VBAT: the jumper ties it to the 3.3 V rail; open, whatever is wired to the pin holds the backup domain.
  { kind: "SW", a: "VBAT", b: "$3v3", part: "VBATJ", closed: "on" },
  { kind: "R", a: "VBAT", b: GND, value: 10e6, hidden: true },
  // Several header pins on one MCU pin share one driver.
  ...[...byMcu.values()].filter((ids) => ids.length > 1).map((ids): Element => ({ kind: "SHORT", nodes: ids })),
  // The MCU: supply load, NRST pull-up, a GPIO driver behind every header pin and every internal pin.
  ...mcuModel(STM32F746IG, { vdd: "$3v3", gnd: GND, nrst: NRST, boot0: "BOOT0", pads: [...[...byMcu.values()].map((ids) => ids[0]), "$PG2", "$PG3", "$PI11"] }),
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
  mcuBoot0: "BOOT0",
  mcuVbat: "VBAT",
  // Core746I: 8 MHz crystal on PH0/PH1, 32.768 kHz on PC14/PC15.
  mcuClocks: { hse: { hz: 8e6, kind: "crystal", startup: 2e-3 }, lse: { hz: 32768, kind: "crystal", startup: 2 } },
  // IS42S16400J on FMC SDRAM bank 2: 8 MB at 0xD000_0000, usable once the FMC has set it up.
  mcuMemory: [{ name: "SDRAM", base: 0xd0000000, size: 0x800000, kind: "ram", external: "sdram2" }],
  info: {
    MCU: "STM32F746IGT6 on the Core746I, Cortex-M7 216 MHz, 1 MB Flash, 320 KB SRAM, 8 MB SDRAM (IS42S16400J, FMC bank 2 at 0xD0000000)",
    "USART1": "PA9 TX, PA10 RX through the CP2102 USB-UART bridge (JMP2)",
    "USER LEDs": "PB6, PB7, PH4, PI8 → 1 kΩ → LED → GND, each behind its JMP3 jumper",
    Joystick: "A PG2, B PG3, C PD4, D PD5, centre PI11, to GND, each behind its JMP4 jumper",
    WAKEUP: "PA0 through JMP6, active high: 10 kΩ pull-down, K1 to 3.3 V through 10 kΩ",
    Jumpers: "JMP1 (card detect), JMP3 (LEDs), JMP4 (joystick), JMP6 (WAKEUP) and the VBAT jumper are switches on the board; JMP2 (USART1 ↔ CP2102), JMP5 (A4/A5 ↔ PB9/PB8) and VREF+ stay as shipped",
    VBAT: "Jumper closed: from the 3.3 V rail, so a power cut clears the RTC and backup registers; open it and wire a battery to the VBAT pin to keep them counting through the cut",
    "LCD 7inch (P15)": "24-bit RGB on the LTDC, backlight PA3, GT911 touch on PD13/PD12 (I2C4), RST PD11, INT PD7",
    "USB OTG (Core746I)": "Its VBUS powers the module with SW1 at USB (5Vin from the board's S2 otherwise); the data lines DM PA11, DP PA12, ID PA10, VBUS PA9 are not modelled",
    "BOOT switch": "FLASH grounds BOOT0, SYSTEM lifts it to 3.3 V: the core then starts in system memory, where ST's bootloader is not modelled (it idles; the firmware does not run)",
    "Not fitted here": "JTAG/SWD (no debugger), the 2×40 pin ports P16–P21 (every I/O; use the peripheral headers), the 4.3\" LCD header P14 (RGB as P15 + XPT2046 touch on PF7/PF8/PF9, CS PF6, IRQ PD7), the USB OTG data lines and VBUS LED, JMP2 (USART1 always on the CP2102), JMP5 (A4/A5 always PF7/PF6), the OTG and VREF+ jumpers (always closed)",
    Source: "Waveshare Open746I-C and Core746I schematics",
  },
}
