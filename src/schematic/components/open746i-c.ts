import { STM32F746IG } from "@/mcu/chip"
import { BoardIcon } from "../icons"
import { mcuModel } from "../mcu-model"
import type { BodyShape, ComponentDef, Element, PartDef, PinDef, PinKind, Side } from "../types"
import { BOUNCE_FIELDS } from "./basic"
import { boardArt, cellAt, FFC_PINS, FRAME, moduleArt, MODULE_PAD, onModule, PC13_LINK, PITCH, POWER_JMP, SEATS, SMD_MM } from "./open746i-c-art"

/**
 * Waveshare Open746I-C: the mother board with the Core746I module (STM32F746IGT6, 8 MB SDRAM)
 * on it — the university's lab stand. Pin data from the board and module schematics; the
 * layout is traced from Waveshare's dimension drawing (185 × 135 mm), every header, LED and
 * button where it is on the board: the module on the left between the pin strips P18–P21,
 * Arduino headers to its right, USART3/CAN/I2C/DCMI down the left edge,
 * SDMMC/QUADSPI/power/USART1/I2S along the top, ETH/SPI/SAI down the right edge,
 * FMC/ULPI/the 7" LCD's FFC along the bottom, the LEDs in a column top right, joystick and
 * WAKEUP bottom right, RESET bottom left.
 * Scale: 1 cell = 2.54 mm exactly, as photographed; each header rounded to the nearest cell as a
 * whole, the FFC's forty lines brought out below the bottom edge.
 */

/** [header pin, label, MCU pin, signal, function, note] */
type Row = [number, string, string?, string?, string?, string?]

const WIDTH = 73
const HEIGHT = 58

const P18: Row[] = [
  [1, "PE2", "PE2", undefined, undefined, "OTG JMP PWR OUT (USB.P1) on the module, fitted: VBUSEN, 10 kΩ to 3.3 V and the MIC2025's enable input"],
  [2, "PE3", "PE3", undefined, undefined, "OTG JMP FLG (USB.P2) on the module, fitted: 10 kΩ to 3.3 V, 100 nF to ground and the MIC2025's open-drain fault flag, which the bench (2026-10-12) found holding PE3 at 0.80 V with the module's USB out"],
  [3, "PE4", "PE4", undefined, undefined, "Also the 7\" LCD's B0 (P15-21)"],
  [4, "PE5", "PE5", undefined, undefined, "Also the 7\" LCD's G0 (P15-13)"],
  [5, "PE6", "PE6", undefined, undefined, "Also the 7\" LCD's G1 (P15-14)"],
  [6, "PC13", "PC13", undefined, undefined, "SDMMC card detect (P6-9) through JMP1; Arduino A1 through the 0 Ω H6"],
  [7, "PI8", "PI8", undefined, undefined, "Shared with USER LED4 (JMP3)"],
  [8, "PC15", "PC15", undefined, undefined, "32.768 kHz crystal and 6 pF to ground on the module (LSE)"],
  [9, "PC14", "PC14", undefined, undefined, "32.768 kHz crystal and 6 pF to ground on the module (LSE)"],
  [10, "PI10", "PI10", undefined, undefined, "Also the 7\" LCD's HSYNC (P15-32)"],
  [11, "PI9", "PI9", undefined, undefined, "Also the 7\" LCD's VSYNC (P15-33)"],
  [12, "PF0", "PF0", undefined, undefined, "SDRAM A0 on the module"],
  [13, "PI11", "PI11", undefined, undefined, "Shared with the joystick centre (JMP4)"],
  [14, "PF2", "PF2", undefined, undefined, "SDRAM A2 on the module"],
  [15, "PF1", "PF1", undefined, undefined, "SDRAM A1 on the module"],
  [16, "PF4", "PF4", undefined, undefined, "SDRAM A4 on the module"],
  [17, "PF3", "PF3", undefined, undefined, "SDRAM A3 on the module"],
  [18, "PF6", "PF6", undefined, undefined, "Arduino A5 through JMP5 as shipped"],
  [19, "PF5", "PF5", undefined, undefined, "SDRAM A5 on the module"],
  [20, "PF8", "PF8"],
  [21, "PF7", "PF7", undefined, undefined, "Arduino A4 through JMP5 as shipped"],
  [22, "PF10", "PF10", undefined, undefined, "Also the 7\" LCD's DE (P15-34)"],
  [23, "PF9", "PF9"],
  [24, "PH1", "PH1", undefined, undefined, "8 MHz crystal, 20 pF to ground and 10 MΩ to PH0 on the module (HSE)"],
  [25, "PH0", "PH0", undefined, undefined, "8 MHz crystal, 20 pF to ground and 10 MΩ to PH1 on the module (HSE)"],
  [26, "PC0", "PC0", undefined, undefined, "Also the 7\" LCD's R5 (P15-10)"],
  [27, "PC1", "PC1"],
  [28, "PC2", "PC2"],
  [29, "PC3", "PC3"],
  [30, "PA0", "PA0", undefined, undefined, "WAKEUP through JMP6: 100 nF to ground, 10 kΩ on to K1 (to 3.3 V) and 10 kΩ more to ground; also Arduino A0"],
  [31, "PA1", "PA1"],
  [32, "PA2", "PA2"],
  [33, "PH2", "PH2", undefined, undefined, "Also the 7\" LCD's R0 (P15-5)"],
  [34, "PH3", "PH3", undefined, undefined, "Also the 7\" LCD's R1 (P15-6)"],
  [35, "GND"],
  [36, "3V3"],
]
const P19: Row[] = [
  [1, "PH4", "PH4", undefined, undefined, "Shared with USER LED3 (JMP3)"],
  [2, "PH5", "PH5", undefined, undefined, "SDRAM WE on the module"],
  [3, "PA3", "PA3", undefined, undefined, "Also the 7\" LCD's backlight PWM (P15-35)"],
  [4, "PA4", "PA4"],
  [5, "PA5", "PA5"],
  [6, "PA6", "PA6"],
  [7, "PA7", "PA7"],
  [8, "PC4", "PC4"],
  [9, "PC5", "PC5"],
  [10, "PB0", "PB0"],
  [11, "PB1", "PB1", undefined, undefined, "Also the 7\" LCD's R6 (P15-11)"],
  [12, "PB2", "PB2"],
  [13, "PF11", "PF11", undefined, undefined, "SDRAM RAS on the module"],
  [14, "PF12", "PF12", undefined, undefined, "SDRAM A6 on the module"],
  [15, "PF13", "PF13", undefined, undefined, "SDRAM A7 on the module"],
  [16, "PF14", "PF14", undefined, undefined, "SDRAM A8 on the module"],
  [17, "PF15", "PF15", undefined, undefined, "SDRAM A9 on the module"],
  [18, "PG0", "PG0", undefined, undefined, "SDRAM A10 on the module"],
  [19, "PG1", "PG1", undefined, undefined, "SDRAM A11 on the module"],
  [20, "PE7", "PE7", undefined, undefined, "SDRAM DQ4 on the module"],
  [21, "PE8", "PE8", undefined, undefined, "SDRAM DQ5 on the module"],
  [22, "PE9", "PE9", undefined, undefined, "SDRAM DQ6 on the module"],
  [23, "PE10", "PE10", undefined, undefined, "SDRAM DQ7 on the module"],
  [24, "PE11", "PE11", undefined, undefined, "SDRAM DQ8 on the module"],
  [25, "PE12", "PE12", undefined, undefined, "SDRAM DQ9 on the module"],
  [26, "PE13", "PE13", undefined, undefined, "SDRAM DQ10 on the module"],
  [27, "PE14", "PE14", undefined, undefined, "SDRAM DQ11 on the module"],
  [28, "PE15", "PE15", undefined, undefined, "SDRAM DQ12 on the module"],
  [29, "PB10", "PB10"],
  [30, "PB11", "PB11"],
  [31, "PH6", "PH6", undefined, undefined, "SDRAM CS on the module"],
  [32, "PH7", "PH7", undefined, undefined, "SDRAM CKE on the module"],
  [33, "PH8", "PH8", undefined, undefined, "Also the 7\" LCD's R2 (P15-7)"],
  [34, "PH9", "PH9", undefined, undefined, "Also the 7\" LCD's R3 (P15-8)"],
  [35, "PH10", "PH10", undefined, undefined, "Also the 7\" LCD's R4 (P15-9)"],
  [36, "PH11", "PH11"],
]
const P20: Row[] = [
  [1, "PH12", "PH12"],
  [2, "PB12", "PB12"],
  [3, "PB13", "PB13"],
  [4, "PB14", "PB14"],
  [5, "PB15", "PB15"],
  [6, "PD8", "PD8", undefined, undefined, "SDRAM DQ13 on the module"],
  [7, "PD9", "PD9", undefined, undefined, "SDRAM DQ14 on the module"],
  [8, "PD10", "PD10", undefined, undefined, "SDRAM DQ15 on the module"],
  [9, "PD11", "PD11", undefined, undefined, "Also the 7\" LCD's touch reset (P15-39)"],
  [10, "PD12", "PD12", undefined, undefined, "Also the 7\" LCD's touch SCL (P15-38)"],
  [11, "PD13", "PD13", undefined, undefined, "Also the 7\" LCD's touch SDA (P15-37)"],
  [12, "PD14", "PD14", undefined, undefined, "SDRAM DQ0 on the module"],
  [13, "PD15", "PD15", undefined, undefined, "SDRAM DQ1 on the module"],
  [14, "PG2", "PG2", undefined, undefined, "Shared with joystick A (JMP4)"],
  [15, "PG3", "PG3", undefined, undefined, "Shared with joystick B (JMP4)"],
  [16, "PG4", "PG4", undefined, undefined, "SDRAM BA0 on the module"],
  [17, "PG5", "PG5", undefined, undefined, "SDRAM BA1 on the module"],
  [18, "PG6", "PG6", undefined, undefined, "Also the 7\" LCD's R7 (P15-12)"],
  [19, "PG7", "PG7", undefined, undefined, "Also the 7\" LCD's pixel clock (P15-30)"],
  [20, "PG8", "PG8", undefined, undefined, "SDRAM CLK on the module"],
  [21, "PC6", "PC6"],
  [22, "PC7", "PC7"],
  [23, "PC8", "PC8"],
  [24, "PC9", "PC9"],
  [25, "PA8", "PA8"],
  [26, "PA9", "PA9", undefined, undefined, "JMP2 (fitted as shipped) to the CP2102's RXD (a weak pull-up) and the TX LED; OTG JMP VBUS (USB.P3) on the module to the module USB's 5 V and the VBUS LED, empty as shipped. Fit that cap with the module's USB plugged in and PA9 sits at 5 V and burns as an output, USART1 TX included"],
  [27, "PA10", "PA10", undefined, undefined, "JMP2 to the CP2102's TXD, which idles high (233 Ω from its 3.3 V while the USART1 USB powers it), and the RX LED; 330 Ω to the module USB's ID"],
  [28, "PA11", "PA11", undefined, undefined, "JMP2 to the CP2102's CTS input, a weak pull-up (25 µA) while the USART1 USB powers it (CTS meets CTS: the board does not cross them); 22 Ω to the module USB's D−; CAN1 RX (P7-3)"],
  [29, "PA12", "PA12", undefined, undefined, "JMP2 to the CP2102's RTS output, high (233 Ω from its 3.3 V) while the USART1 USB powers it, as the bench found it (RTS meets RTS: the board does not cross them); 22 Ω to the module USB's D+; CAN1 TX (P7-4)"],
  [30, "PA13", "PA13", undefined, undefined, "JTMS-SWDIO on the module's JTAG header (P1-7)"],
  [31, "PH14", "PH14"],
  [32, "PH13", "PH13", undefined, undefined, "Also the 7\" LCD's G2 (P15-15)"],
  [33, "PI0", "PI0", undefined, undefined, "Also the 7\" LCD's G5 (P15-18)"],
  [34, "PH15", "PH15", undefined, undefined, "Also the 7\" LCD's G4 (P15-17)"],
  [35, "3V3"],
  [36, "PI1", "PI1", undefined, undefined, "Also the 7\" LCD's G6 (P15-19)"],
]
const P21: Row[] = [
  [1, "PI2", "PI2", undefined, undefined, "Also the 7\" LCD's G7 (P15-20)"],
  [2, "PA14", "PA14", undefined, undefined, "JTCK-SWCLK on the module's JTAG header (P1-9)"],
  [3, "PI3", "PI3"],
  [4, "PC10", "PC10"],
  [5, "PA15", "PA15", undefined, undefined, "JTDI on the module's JTAG header (P1-5); Arduino D9"],
  [6, "PC12", "PC12"],
  [7, "PC11", "PC11"],
  [8, "PD1", "PD1", undefined, undefined, "SDRAM DQ3 on the module"],
  [9, "PD0", "PD0", undefined, undefined, "SDRAM DQ2 on the module"],
  [10, "PD3", "PD3"],
  [11, "PD2", "PD2"],
  [12, "PD5", "PD5", undefined, undefined, "Shared with joystick D (JMP4)"],
  [13, "PD4", "PD4", undefined, undefined, "Shared with joystick C (JMP4)"],
  [14, "PD7", "PD7", undefined, undefined, "Also the 7\" LCD's touch interrupt (P15-40)"],
  [15, "PD6", "PD6", undefined, undefined, "Also the 7\" LCD's B2 (P15-23)"],
  [16, "PG10", "PG10", undefined, undefined, "Also the 7\" LCD's G3 (P15-16)"],
  [17, "PG9", "PG9"],
  [18, "PG12", "PG12", undefined, undefined, "Also the 7\" LCD's B1 (P15-22)"],
  [19, "PG11", "PG11", undefined, undefined, "Also the 7\" LCD's B3 (P15-24)"],
  [20, "PG14", "PG14"],
  [21, "PG13", "PG13"],
  [22, "PB3", "PB3", undefined, undefined, "JTDO on the module's JTAG header (P1-13)"],
  [23, "PG15", "PG15", undefined, undefined, "SDRAM CAS on the module"],
  [24, "PB5", "PB5"],
  [25, "PB4", "PB4", undefined, undefined, "NJTRST on the module's JTAG header (P1-3); Arduino D3"],
  [26, "PB7", "PB7", undefined, undefined, "Shared with USER LED2 (JMP3)"],
  [27, "PB6", "PB6", undefined, undefined, "Shared with USER LED1 (JMP3)"],
  [28, "PB8", "PB8", undefined, undefined, "Arduino A5 through JMP5 1-3, empty as shipped"],
  [29, "PB9", "PB9", undefined, undefined, "Arduino A4 through JMP5 2-4, empty as shipped"],
  [30, "PE0", "PE0", undefined, undefined, "SDRAM LDQM on the module"],
  [31, "PE1", "PE1", undefined, undefined, "SDRAM UDQM on the module"],
  [32, "PI5", "PI5", undefined, undefined, "Also the 7\" LCD's B5 (P15-26)"],
  [33, "PI4", "PI4", undefined, undefined, "Also the 7\" LCD's B4 (P15-25)"],
  [34, "PI7", "PI7", undefined, undefined, "Also the 7\" LCD's B7 (P15-28)"],
  [35, "PI6", "PI6", undefined, undefined, "Also the 7\" LCD's B6 (P15-27)"],
  [36, "5V"],
]

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
const CAN1: Row[] = [[1, "3V3"], [2, "GND"], [3, "RX", "PA11", "CAN1_RX", undefined, "Shared with the CP2102's CTS input (JMP2) and the module USB's D− (22 Ω)"], [4, "TX", "PA12", "CAN1_TX", undefined, "Shared with the CP2102's RTS output (JMP2) and the module USB's D+ (22 Ω)"]]
const CAN2: Row[] = [[1, "3V3"], [2, "GND"], [3, "RX", "PB12", "CAN2_RX", undefined, "Shared with SPI2 NSS, I2S2 WS, ULPI D5, Arduino D10"], [4, "TX", "PB13", "CAN2_TX", undefined, "Shared with SPI2 SCK, I2S2 CK, ULPI D6, Arduino D13"]]
const I2C_ODD: Row[] = [[1, "3V3"], [3, "GND"], [5, "SDA", "PD13", "I2C4_SDA", undefined, "Also the 7\" LCD's touch SDA (P15-37); no pull-up on the board; the board prints I2C2, the Open429I-C's name; on the F746 these pads are I2C4 (AF4)"], [7, "SCL", "PD12", "I2C4_SCL", undefined, "Also the 7\" LCD's touch SCL (P15-38); no pull-up on the board; the board prints I2C2, the Open429I-C's name; on the F746 these pads are I2C4 (AF4)"], [9, "SMBA", "PD11", "I2C4_SMBA", undefined, "The board prints I2C2, the Open429I-C's name; on the F746 this pad is I2C4 (AF4)"]]
const I2C_EVEN: Row[] = [[2, "3V3"], [4, "GND"], [6, "SDA", "PB9", "I2C1_SDA", undefined, "No pull-up on the board"], [8, "SCL", "PB8", "I2C1_SCL", undefined, "No pull-up on the board"], [10, "SMBA", "PB5", "I2C1_SMBA"]]
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
const ETH_ODD: Row[] = [[1, "3V3"], [3, "GND"], [5, "MDIO", "PA2", "ETH_MDIO"], [7, "REFCLK", "PA1", "ETH_REF_CLK", "ETH_RMII_REF_CLK"], [9, "RXD0", "PC4", "ETH_RXD0", "ETH_RMII_RXD0"], [11, "TXEN", "PB11", "ETH_TX_EN", "ETH_RMII_TX_EN"], [13, "TXD1", "PG14", "ETH_TXD1", "ETH_RMII_TXD1"]]
const ETH_EVEN: Row[] = [[2, "3V3"], [4, "GND"], [6, "MDC", "PC1", "ETH_MDC"], [8, "CRSDV", "PA7", "ETH_CRS_DV", "ETH_RMII_CRS_DV"], [10, "RXD1", "PC5", "ETH_RXD1", "ETH_RMII_RXD1"], [12, "TXD0", "PG13", "ETH_TXD0", "ETH_RMII_TXD0"], [14, "NC"]]
const SPI2: Row[] = [[1, "3V3"], [3, "GND"], [5, "MISO", "PB14", "SPI2_MISO"], [7, "MOSI", "PB15", "SPI2_MOSI"], [9, "SCK", "PB13", "SPI2_SCK"], [11, "NSS", "PB12", "SPI2_NSS"]]
const SPI1: Row[] = [[2, "3V3"], [4, "GND"], [6, "MISO", "PA6", "SPI1_MISO"], [8, "MOSI", "PA7", "SPI1_MOSI"], [10, "SCK", "PA5", "SPI1_SCK"], [12, "NSS", "PA4", "SPI1_NSS"]]
const SAI_A: Row[] = [[1, "3V3"], [3, "GND"], [5, "NC"], [7, "NC"], [9, "SCK_A", "PE5", "SAI1_SCK_A"], [11, "FS_A", "PE4", "SAI1_FS_A"], [13, "SD_A", "PE6", "SAI1_SD_A"], [15, "MCLK_A", "PE2", "SAI1_MCLK_A"]]
const SAI_B: Row[] = [[2, "3V3"], [4, "GND"], [6, "SDA", "PB9", "I2C1_SDA"], [8, "SCL", "PB8", "I2C1_SCL"], [10, "SCK_B", "PF8", "SAI1_SCK_B"], [12, "FS_B", "PF9", "SAI1_FS_B"], [14, "SD_B", "PF6", "SAI1_SD_B"], [16, "MCLK_B", "PF7", "SAI1_MCLK_B"]]
const I2S3: Row[] = [[1, "3V3"], [3, "GND"], [5, "NC"], [7, "NC"], [9, "CK", "PC10", "I2S3_CK"], [11, "WS", "PA4", "I2S3_WS"], [13, "SD", "PC12", "I2S3_SD"], [15, "MCK", "PC7", "I2S3_MCK"]]
const I2S2: Row[] = [[2, "3V3"], [4, "GND"], [6, "SDA", "PB9", "I2C1_SDA"], [8, "SCL", "PB8", "I2C1_SCL"], [10, "CK", "PB13", "I2S2_CK"], [12, "WS", "PB12", "I2S2_WS"], [14, "SD", "PI3", "I2S2_SD"], [16, "MCK", "PC6", "I2S2_MCK"]]
const SDMMC: Row[] = [[1, "3V3"], [2, "GND"], [3, "D0", "PC8", "SDMMC1_D0"], [4, "CMD", "PD2", "SDMMC1_CMD"], [5, "CLK", "PC12", "SDMMC1_CK"], [6, "D3", "PC11", "SDMMC1_D3"], [7, "D2", "PC10", "SDMMC1_D2"], [8, "D1", "PC9", "SDMMC1_D1"], [9, "CD", "PC13", "SDIO_CD", undefined, "Card detect: PC13 through JMP1, a 0 Ω resistor soldered on the board"]]
const QSPI: Row[] = [[1, "3V3"], [2, "GND"], [3, "IO1", "PF9", "QUADSPI_BK1_IO1"], [4, "IO0", "PF8", "QUADSPI_BK1_IO0"], [5, "CLK", "PB2", "QUADSPI_CLK"], [6, "NCS", "PB6", "QUADSPI_BK1_NCS", undefined, "Shared with USER LED1 (JMP3)"], [7, "IO2", "PF7", "QUADSPI_BK1_IO2"], [8, "IO3", "PF6", "QUADSPI_BK1_IO3"]]
const ULPI_ODD: Row[] = [[1, "3V3"], [3, "GND"], [5, "D7", "PB5", "ULPI_D7"], [7, "D6", "PB13", "ULPI_D6"], [9, "D5", "PB12", "ULPI_D5"], [11, "D4", "PB11", "ULPI_D4"], [13, "D3", "PB10", "ULPI_D3"], [15, "D2", "PB1", "ULPI_D2"], [17, "D1", "PB0", "ULPI_D1"], [19, "D0", "PA3", "ULPI_D0", undefined, "Shared with the LCD backlight PWM"]]
const ULPI_EVEN: Row[] = [[2, "3V3"], [4, "GND"], [6, "STP", "PC0", "ULPI_STP"], [8, "NXT", "PC3", "ULPI_NXT"], [10, "DIR", "PC2", "ULPI_DIR"], [12, "CK", "PA5", "ULPI_CK"], [14, "NC"], [16, "NC"], [18, "5V"], [20, "5V", undefined, undefined, undefined, "5 V with 100 nF (ULPI.C1), as pin 18"]]
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

const CN2: Row[] = [[1, "NC"], [2, "IOREF", undefined, "IOREF", "3.3 V"], [3, "NRST", "NRST", "RESET"], [4, "3V3"], [5, "5V"], [6, "GND"], [7, "GND"], [8, "VIN", undefined, "5Vin", undefined, "Not connected: the VIN JMP is the footprint of R9, a 0 Ω resistor to 5Vin (the board's S2 output ahead of the module's SW1) that the lab's boards do not fit, and no jumper goes there"]]
const CN3: Row[] = [
  [1, "A0", "PA0", "ADC", "ADC123_IN0", "Also the WAKEUP button (JMP6)"],
  [2, "A1", "PC13", "I/O", undefined, "Through the 0 Ω H6 (PF10 by moving it); no ADC on PC13; SDMMC card detect through JMP1"],
  [3, "A2", "PF9", "ADC", "ADC3_IN7"],
  [4, "A3", "PF8", "ADC", "ADC3_IN6"],
  [5, "A4", "PF7", "ADC", "ADC3_IN5", "JMP5: PF7 through the fitted cap (4-6); PB9 (I2C1_SDA) through 2-4, empty as shipped"],
  [6, "A5", "PF6", "ADC", "ADC3_IN4", "JMP5: PF6 through the fitted cap (3-5); PB8 (I2C1_SCL) through 1-3, empty as shipped"],
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

type At = { x: number; y: number; side: Side; stub: number; labelAt?: Side; printed?: boolean }

function pinOf(connector: string, [pin, label, mcu, signal, fn, note]: Row, at: At): PinDef {
  return {
    id: `${connector}-${pin}`,
    label,
    x: at.x,
    y: at.y,
    side: at.side,
    labelAt: at.labelAt ?? at.side,
    kind: kindOf(label, mcu),
    stub: at.stub,
    mcu: mcu === "NRST" ? undefined : mcu,
    signal,
    fn,
    connector,
    connectorPin: pin,
    note,
    printed: at.printed ?? true,
  }
}

const byPin = (...tables: Row[][]) => new Map(tables.flat().map((row) => [row[0], row]))

function column(connector: string, tables: Row[][], pinsTopDown: readonly number[], at: Omit<At, "y"> & { y: number }): PinDef[] {
  const rows = byPin(...tables)
  return pinsTopDown.map((pin, i) => pinOf(connector, rows.get(pin)!, { ...at, y: at.y + i }))
}

function line(connector: string, tables: Row[][], pinsLeftRight: readonly number[], at: At): PinDef[] {
  const rows = byPin(...tables)
  return pinsLeftRight.map((pin, i) => pinOf(connector, rows.get(pin)!, { ...at, x: at.x + i }))
}

const countdown = (from: number, step = 1, count = from) => Array.from({ length: Math.ceil(count / step) }, (_, i) => from - i * step).filter((p) => p >= 1)
const countup = (from: number, to: number, step = 1) => Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step)

const EDGE_STUB = 2
const STRIP_ROWS = 18
const STRIP = { left: { odd: SEATS.leftStrip.x, even: SEATS.leftStrip.x + 1, top: SEATS.leftStrip.y }, right: { odd: SEATS.rightStrip.x + 1, even: SEATS.rightStrip.x, top: SEATS.rightStrip.y } }

function pinStrip(connector: string, rows: Row[], half: 0 | 1, side: "left" | "right"): PinDef[] {
  const at = STRIP[side]
  const top = at.top + half * STRIP_ROWS
  const pin1Top = side === "left"
  return rows.map((row) => {
    const pin = row[0]
    const odd = pin % 2 === 1
    const rank = Math.floor((pin - 1) / 2)
    const y = top + (pin1Top ? rank : STRIP_ROWS - 1 - rank)
    const inward: Side = side === "left" ? "right" : "left"
    return pinOf(connector, row, { x: odd ? at.odd : at.even, y, side, stub: odd ? 2 : 3, labelAt: odd ? side : inward })
  })
}

const stripNames = (tables: { rows: Row[]; half: 0 | 1 }[], side: "left" | "right") => {
  const outer = Array<string>(36).fill("")
  const inner = Array<string>(36).fill("")
  for (const { rows, half } of tables)
    for (const [pin, label] of rows) {
      const rank = Math.floor((pin - 1) / 2)
      const row = half * STRIP_ROWS + (side === "left" ? rank : STRIP_ROWS - 1 - rank)
      ;(pin % 2 === 1 ? outer : inner)[row] = label === "3V3" ? "3.3V" : label
    }
  return { outer, inner }
}

const S = SEATS

const USART1_BRIDGE_SIDE: [id: string, label: string, mcu: string, signal: string, note: string][] = [
  ["VCP-TX", "TXD", "PA9", "USART1_TX", "The CP2102's RXD, an input with a weak pull-up: PA9 reaches it through JMP2 (fitted); connect a terminal's RX here"],
  ["VCP-RX", "RXD", "PA10", "USART1_RX", "The CP2102's TXD: it reaches PA10 through JMP2 (fitted) and idles high while the USART1 USB powers the bridge; a terminal's TX here stands in for what the PC sends"],
  ["VCP-CTS", "CTS", "PA11", "USART1_CTS", "The CP2102's CTS input, pulled up by 25 µA while the USART1 USB powers the bridge: PA11 reaches it through JMP2 (fitted). The board does not cross the flow-control pair, so CTS meets CTS"],
  ["VCP-RTS", "RTS", "PA12", "USART1_RTS", "The CP2102's RTS output, held high through 233 Ω while the USART1 USB powers the bridge: PA12 reaches it through JMP2 (fitted). The board does not cross the flow-control pair, so RTS meets RTS"],
]
const LCD7_A = LCD7.slice(0, 20)
const LCD7_B = LCD7.slice(20)

const pins: PinDef[] = [
  { id: "5VDC", label: "5VDC", x: S.dcJack.x, y: S.dcJack.y, side: "top", labelAt: "bottom", kind: "power", stub: 2, connector: "DC jack", note: "5 V in; S2 picks this or the USART1 USB as 5Vin, and the module takes 5Vin with SW1 off", printed: true },
  ...(["P22", "P24", "P23"] as const).flatMap((connector, row) =>
    [1, 2, 3, 4].map((pin): PinDef => {
      const label = ["5V", "GND", "3V3"][row]
      return { id: `${connector}-${pin}`, label: pin === 4 ? label : "", x: S.rails.x + pin - 1, y: S.rails.y + row, side: "top", labelAt: "right", kind: row === 1 ? "gnd" : "power", stub: 1 + row, connector, connectorPin: pin, note: `${label} rail`, printed: true }
    }),
  ),
  ...USART1_BRIDGE_SIDE.map(([id, label, mcu, signal, note], row): PinDef => ({
    id,
    label,
    x: S.usart1Jmp.x + 1,
    y: S.usart1Jmp.y + row,
    side: "right",
    labelAt: "right",
    kind: "digital",
    stub: 2,
    mcu,
    signal,
    fn: signal,
    connector: "JMP2",
    connectorPin: 2 * (row + 1),
    note,
    printed: true,
    // A terminal on the CP2102's TXD/RXD is the PC on the USART1 USB: the bridge drives the line.
    ...(id === "VCP-RX" ? { hostSerial: "out" as const, hostDriver: "$cp2102txd" } : id === "VCP-TX" ? { hostSerial: "in" as const } : {}),
  })),
  ...line("P6", [SDMMC], countup(1, 9), { x: S.sdmmc.x, y: S.sdmmc.y, side: "top", stub: 5, labelAt: "bottom" }),
  ...line("P3", [QSPI], countup(1, 8), { x: S.qspi.x, y: S.qspi.y, side: "top", stub: 5, labelAt: "bottom" }),
  ...line("P5", [I2S2], countup(2, 16, 2), { x: S.i2s.x, y: S.i2s.y, side: "top", stub: 5, labelAt: "bottom" }),
  ...line("P5", [I2S3], countup(1, 15, 2), { x: S.i2s.x, y: S.i2s.y + 1, side: "top", stub: 6, labelAt: "bottom" }),
  ...column("P2", [USART3], countdown(7), { x: S.usart3.x, y: S.usart3.y, side: "left", stub: 5, labelAt: "right" }),
  ...column("P8", [CAN2], countdown(4), { x: S.can2.x, y: S.can2.y, side: "left", stub: 5, labelAt: "right" }),
  ...column("P7", [CAN1], countdown(4), { x: S.can1.x, y: S.can1.y, side: "left", stub: 5, labelAt: "right" }),
  ...column("P4", [I2C_EVEN], countdown(10, 2), { x: S.i2c.x, y: S.i2c.y, side: "left", stub: 5, labelAt: "right" }),
  ...column("P4", [I2C_ODD], countdown(9, 2), { x: S.i2c.x + 1, y: S.i2c.y, side: "left", stub: 6, labelAt: "right" }),
  ...column("P13", [DCMI_EVEN], countdown(24, 2), { x: S.dcmi.x, y: S.dcmi.y, side: "left", stub: EDGE_STUB, labelAt: "right" }),
  ...column("P13", [DCMI_ODD], countdown(23, 2), { x: S.dcmi.x + 1, y: S.dcmi.y, side: "left", stub: EDGE_STUB + 1, labelAt: "right" }),
  ...column("P11", [ETH_ODD], countup(1, 13, 2), { x: S.eth.x, y: S.eth.y, side: "right", stub: 6, labelAt: "left" }),
  ...column("P11", [ETH_EVEN], countup(2, 14, 2), { x: S.eth.x + 1, y: S.eth.y, side: "right", stub: 5, labelAt: "left" }),
  ...column("P1", [SPI2], countup(1, 11, 2), { x: S.spi.x, y: S.spi.y, side: "right", stub: 6, labelAt: "left" }),
  ...column("P1", [SPI1], countup(2, 12, 2), { x: S.spi.x + 1, y: S.spi.y, side: "right", stub: 5, labelAt: "left" }),
  ...column("P9", [SAI_A], countup(1, 15, 2), { x: S.sai.x, y: S.sai.y, side: "right", stub: 6, labelAt: "left" }),
  ...column("P9", [SAI_B], countup(2, 16, 2), { x: S.sai.x + 1, y: S.sai.y, side: "right", stub: 5, labelAt: "left" }),
  ...line("P12", [FMC_ODD], countdown(19, 2), { x: S.fmc.x, y: S.fmc.y, side: "bottom", stub: 7, labelAt: "top" }),
  ...line("P12", [FMC_EVEN], countdown(20, 2), { x: S.fmc.x, y: S.fmc.y + 1, side: "bottom", stub: 6, labelAt: "top" }),
  ...line("P10", [ULPI_ODD], countdown(19, 2), { x: S.ulpi.x, y: S.ulpi.y, side: "bottom", stub: 7, labelAt: "top" }),
  ...line("P10", [ULPI_EVEN], countdown(20, 2), { x: S.ulpi.x, y: S.ulpi.y + 1, side: "bottom", stub: 6, labelAt: "top" }),
  ...LCD7_A.map((row, i) => pinOf("P15", row, { x: FFC_PINS.x + i, y: FFC_PINS.rowA, side: "bottom", stub: 3, labelAt: "top" })),
  ...LCD7_B.map((row, i) => pinOf("P15", row, { x: FFC_PINS.x + i, y: FFC_PINS.rowB, side: "bottom", stub: 2, labelAt: "bottom" })),
  ...column("CN2", [CN2], countup(1, 8), { x: S.cn2.x, y: S.cn2.y, side: "left", stub: 1, labelAt: "right" }),
  ...column("CN3", [CN3], countup(1, 6), { x: S.cn3.x, y: S.cn3.y, side: "left", stub: 1, labelAt: "right" }),
  ...column("CN1", [CN1], countdown(10), { x: S.cn1.x, y: S.cn1.y, side: "right", stub: 1, labelAt: "left" }),
  ...column("CN4", [CN4], countdown(8), { x: S.cn4.x, y: S.cn4.y, side: "right", stub: 1, labelAt: "left" }),
  ...line("CN5", [ICSP_ODD], [5, 3, 1], { x: S.icsp.x, y: S.icsp.y, side: "top", stub: 1, labelAt: "top" }),
  ...line("CN5", [ICSP_EVEN], [6, 4, 2], { x: S.icsp.x, y: S.icsp.y + 1, side: "bottom", stub: 1, labelAt: "bottom" }),
  { id: "VBAT", label: "VBAT", ...cellAt(onModule(POWER_JMP.vbat.pin)), side: "bottom", labelAt: "bottom", kind: "power", stub: 0, signal: "VBAT", connector: "P16", connectorPin: 8, note: "Backup-domain supply (1.65–3.6 V): with the POWER JMP's VBAT cap off, a battery here keeps the RTC and backup registers through a power cut", printed: true },
  { id: "VREF+", label: "VREF+", ...cellAt(onModule(POWER_JMP.vref.pin)), side: "bottom", labelAt: "bottom", kind: "power", stub: 0, signal: "VREF+", connector: "P16", connectorPin: 34, note: "The ADC and DAC reference: the POWER JMP's VREF+ cap ties it to the 3.3 V rail, fitted as shipped. With the cap off, a reference wired here sets the full scale of every conversion (1.7 V to VDDA, and within 1.2 V of it: DS10916 Table 63); left open, the converters have none", printed: true },
  { id: "BOOT0", label: "BOOT0", ...cellAt(onModule(MODULE_PAD.boot0)), side: "left", labelAt: "left", kind: "digital", stub: 0, signal: "BOOT0", connector: "P17", connectorPin: 69, note: "The module's pad P17-69, printed BOOT0, the one place the pin is brought out; through 10 kΩ (MCU.R1) to the boot switch's common: FLASH grounds it, SYSTEM lifts it to 3.3 V (the ST bootloader is not modelled: the core idles in system memory)", printed: true },
  ...pinStrip("P18", P18, 1, "right"),
  ...pinStrip("P19", P19, 0, "right"),
  ...pinStrip("P20", P20, 0, "left"),
  ...pinStrip("P21", P21, 1, "left"),
]

const body: BodyShape[] = [
  ...boardArt({
    left: stripNames([{ rows: P20, half: 0 }, { rows: P21, half: 1 }], "left"),
    right: stripNames([{ rows: P19, half: 0 }, { rows: P18, half: 1 }], "right"),
  }, { rowA: LCD7_A.map(([, label]) => label), rowB: LCD7_B.map(([, label]) => label) }),
  ...moduleArt(),
]

const at = (x: number, y: number) => cellAt({ x, y })
const atModule = (x: number, y: number) => cellAt(onModule({ x, y }))
const jumper = (id: string, label: string, from: { x: number; y: number }, to: { x: number; y: number }, on = true): PartDef => {
  const vertical = Math.abs(to.x - from.x) < 1e-6
  return { type: "switch", id, label, x: from.x, y: from.y, span: Math.round((vertical ? to.y - from.y : to.x - from.x) * 100) / 100, vertical, initial: on ? { on: true } : undefined }
}
const changeover = (id: string, label: string, common: { x: number; y: number }, on: { x: number; y: number }, off: { x: number; y: number }): Extract<PartDef, { type: "switch" }> => ({
  type: "switch",
  id,
  label,
  ...common,
  span: Math.round(Math.hypot(on.x - common.x, on.y - common.y) * 100) / 100,
  throws: { on, off },
})
const keyRow = (row: number) => at(161.2, 119.8 + row * PITCH)
const keyCap = (row: number) => at(163.7, 119.8 + row * PITCH)
const ledRow = (row: number) => at(176.6, 14.1 + row * 2.82)

const parts: PartDef[] = [
  { type: "usb", id: "USB", label: "USART1 USB", ...at(123.4, 1.6), side: "top", initial: { on: true } },
  changeover("S2", "S2: 5Vin from the 5VDC jack (on) or from the USART1 USB's U5V (off)", at(21.9, 4.35), at(23.9, 1.9), at(23.9, 6.8)),
  { type: "usb", id: "MUSB", label: "Core746I USB OTG", ...atModule(29.5, 81.6), side: "bottom", initial: { on: true } },
  { ...changeover("SW1", "SW1: the module's 5 V from its own USB (on) or from the board's 5Vin, S2 (off)", atModule(15.6, 74.4), atModule(13.0, 70.4), atModule(13.0, 78.4)), initial: { on: true } },
  jumper("VBATJ", "POWER JMP, VBAT cap: on = VBAT from the 3.3 V rail (as shipped), off = a battery on the VBAT pin", atModule(POWER_JMP.vbat.rail.x, POWER_JMP.vbat.rail.y), atModule(POWER_JMP.vbat.pin.x, POWER_JMP.vbat.pin.y)),
  jumper("VREFJ", "POWER JMP, VREF+ cap: on = VREF+ from the 3.3 V rail (as shipped), off = the ADC and DAC referred to whatever is wired to the VREF+ pin, or to nothing", atModule(POWER_JMP.vref.rail.x, POWER_JMP.vref.rail.y), atModule(POWER_JMP.vref.pin.x, POWER_JMP.vref.pin.y)),
  { type: "link", id: "JMP1", label: "JMP1: SDMMC card detect ↔ PC13, a 0 Ω resistor soldered on the board, not a jumper. The schematic draws a 2-pin header (Header 2); the lab's board fits a 0 Ω link in its place, printed PC13", ...at(PC13_LINK.x, PC13_LINK.y), w: SMD_MM.long * FRAME.cellsPerMm, h: SMD_MM.short * FRAME.cellsPerMm },
  ...(["PB6", "PB7", "PH4", "PI8"] as const).map((mcu, i) => jumper(`JMP3_${i + 1}`, `JMP3: LED${i + 1} ↔ ${mcu}`, at(161.45, 17.9 + i * PITCH), at(164.0, 17.9 + i * PITCH))),
  ...(["A PG2", "B PG3", "C PD4", "D PD5", "centre PI11"] as const).map((what, i) => jumper(`JMP4_${i + 1}`, `JMP4: joystick ${what}`, keyRow(i), keyCap(i))),
  jumper("JMP6", "JMP6: WAKEUP button ↔ PA0", keyRow(5), keyCap(5)),
  ...(["PA9 → TX (the CP2102's RXD)", "PA10 ← RX (the CP2102's TXD)", "PA11 ↔ CTS (the CP2102's CTS input)", "PA12 ↔ RTS (the CP2102's RTS output)"] as const).map((what, i) =>
    jumper(`JMP2_${i + 1}`, `JMP2 (USART1 JMP): ${what}`, { x: S.usart1Jmp.x, y: S.usart1Jmp.y + i }, { x: S.usart1Jmp.x + 1, y: S.usart1Jmp.y + i }),
  ),
  jumper("OTG_VBUS", "OTG JMP VBUS (USB.P3, empty as shipped): PA9 ↔ the module USB's 5 V", atModule(33.0, 63.6), atModule(33.0, 66.14), false),
  jumper("OTG_PWR", "OTG JMP PWR OUT (USB.P1, fitted as shipped): PE2 ↔ the MIC2025's EN, 10 kΩ to 3.3 V", atModule(35.5, 63.6), atModule(35.5, 66.14)),
  jumper("OTG_FLG", "OTG JMP FLG (USB.P2, fitted as shipped): PE3 ↔ the MIC2025's FLG, 10 kΩ to 3.3 V and 100 nF", atModule(38.0, 63.6), atModule(38.0, 66.14)),
  jumper("JMP5_A5", "JMP5 3-5: Arduino A5 ↔ PF6 (fitted as shipped)", at(112.1, 87.35), at(112.1, 89.89)),
  jumper("JMP5_A4", "JMP5 4-6: Arduino A4 ↔ PF7 (fitted as shipped)", at(114.7, 87.35), at(114.7, 89.89)),
  jumper("JMP5_A5_PB8", "JMP5 1-3: Arduino A5 ↔ PB8 (empty as shipped)", at(112.1, 89.89), at(112.1, 92.43), false),
  jumper("JMP5_A4_PB9", "JMP5 2-4: Arduino A4 ↔ PB9 (empty as shipped)", at(114.7, 89.89), at(114.7, 92.43), false),
  { ...changeover("BOOT", "BOOT: SYSTEM (on: the ST bootloader, for flashing; the board starts here) or FLASH (off: user firmware from reset)", atModule(23.25, 65.7), atModule(26.1, 64.2), atModule(20.4, 64.2)), pin: "BOOT0", initial: { on: true } },
  ...(["PWR", "RX", "TX", "LED1", "LED2", "LED3", "LED4"] as const).map((id, i): PartDef => {
    const wired = { LED1: ["P3-6", "PB6"], LED2: ["CN4-7", "PB7"], LED3: ["CN4-3", "PH4"], LED4: ["CN1-1", "PI8"] } as Record<string, [string, string]>
    const partId = id === "RX" ? "RXLED" : id === "TX" ? "TXLED" : id
    return { type: "led", id: partId, label: id, ...ledRow(i), color: "#ef4444", printed: true, ...(wired[id] ? { pin: wired[id][0], mcu: wired[id][1] } : {}) }
  }),
  { type: "led", id: "MPWR", label: "PWR LED", ...atModule(22.6, 75.0), color: "#ef4444", printed: true },
  { type: "led", id: "MVBUS", label: "VBUS LED", ...atModule(36.05, 75.3), color: "#ef4444", printed: true },
  { type: "button", id: "JOY_A", label: "A", ...at(147.2, 121.8), size: 1.1, mcu: "PG2", pin: "P20-14", printed: true },
  { type: "button", id: "JOY_B", label: "B", ...at(150.75, 125.35), size: 1.1, mcu: "PG3", pin: "P20-15", printed: true },
  { type: "button", id: "JOY_C", label: "C", ...at(143.65, 125.35), size: 1.1, mcu: "PD4", pin: "P12-8", printed: true },
  { type: "button", id: "JOY_D", label: "D", ...at(147.2, 128.9), size: 1.1, mcu: "PD5", pin: "P12-10", printed: true },
  { type: "button", id: "JOY_CTR", label: "", ...at(147.2, 125.35), size: 1.1, mcu: "PI11", pin: "P18-13" },
  { type: "button", id: "WAKEUP", label: "K1", ...at(133.2, 130.6), size: 2.36, mcu: "PA0", pin: "CN3-1", printed: true },
  { type: "button", id: "RESET", label: "", ...at(20.4, 130.4), size: 2.36, mcu: "NRST", pin: "P13-17" },
  { type: "button", id: "MRESET", label: "", ...atModule(41.9, 75.05), size: 1.3, mcu: "NRST", pin: "P13-17" },
]

// --- electrical model ---------------------------------------------------------

const BEHIND_A_JUMPER = new Set([...USART1_BRIDGE_SIDE.map(([id]) => id), "CN3-5", "CN3-6"])
/** Header pins per MCU pin: one driver per pad however many headers reach it. */
const byMcu = new Map<string, string[]>()
for (const p of pins) if (p.mcu && !BEHIND_A_JUMPER.has(p.id)) byMcu.set(p.mcu, [...(byMcu.get(p.mcu) ?? []), p.id])
/** Node of an MCU pin: its first header pin, or an internal "$Pxn" when no header reaches it. */
const nodeOf = (mcu: string) => byMcu.get(mcu)?.[0] ?? `$${mcu}`

const gndPins = pins.filter((p) => p.kind === "gnd").map((p) => p.id)
const GND = gndPins[0]
const v5Pins = pins.filter((p) => p.label === "5V" || p.connector === "P22").map((p) => p.id)
const v33Pins = pins.filter((p) => p.label === "3V3" || p.label === "IOREF" || p.label === "AVDD" || p.connector === "P23").map((p) => p.id)
const V5 = "P22-1"
const V3V3 = "P23-1"
const NRST = "P13-17"
const USB_5V = "$usb5vlim"

const BOARD_RED_LED = { vf: 1.86, emission: 1.18 }

const led = (mcu: string, part: string, jumper: string): Element[] => [
  { kind: "SW", a: nodeOf(mcu), b: `$${part}j`, part: jumper, closed: "on" },
  { kind: "R", a: `$${part}j`, b: `$${part}k`, value: 1e3 },
  { kind: "D", anode: `$${part}k`, cathode: GND, ...BOARD_RED_LED, part },
]
const JOYSTICK = ["JOY_A", "JOY_B", "JOY_C", "JOY_D", "JOY_CTR"]
const JOYSTICK_BOUNCE_FIELDS = BOUNCE_FIELDS.map((field) => ({ ...field, label: `Joystick ${field.label.toLowerCase()}` }))
const GANSSLE_LONGEST_BOUNCE = "6 ms"
const joystick = (mcu: string, part: string, jumper: string): Element[] => [
  { kind: "SW", a: nodeOf(mcu), b: `$${part}j`, part: jumper, closed: "on" },
  { kind: "SW", a: `$${part}j`, b: GND, part, closed: "pressed" },
]

const CP2102_OUTPUT_HIGH_OHMS = 0.7 / 3e-3
const CP2102_INPUT_PULL_UP_OHMS = 3.3 / 25e-6
const CP2102_NORMAL_SUPPLY_OHMS = 3.3 / 20e-3
const CP2102_UNPOWERED_CLAMP = { vf: 0.7, emission: 1 }
const CP2102_VDD = "$cp2102"
const AMS1117_QUIESCENT_OHMS = 5 / 5e-3
const AMS1117_VOLTS = 3.29
const FLG_PULL_UP_OHMS = 10e3
const MIC2025_VIN = 5
const MIC2025_FLAG_ON_OHMS = 8
const MIC2025_FLAG_VTH = 0.7
const MIC2025_FLAG_K = 1 / (2 * MIC2025_FLAG_ON_OHMS * (MIC2025_VIN - MIC2025_FLAG_VTH))
const PE3_ON_THE_PIN_LAB_2026_10_12 = 0.8035
const MIC2025_FLAG_SINK_FIT = (AMS1117_VOLTS - PE3_ON_THE_PIN_LAB_2026_10_12) / FLG_PULL_UP_OHMS
const MIC2025_FLAG_GATE_FIT = MIC2025_FLAG_VTH + Math.sqrt(MIC2025_FLAG_SINK_FIT / MIC2025_FLAG_K)

const cp2102Pin = (name: string, net: string, ohms: number, output = false): Element[] => [
  // An output (TXD, RTS) is a driver the loop sets, high at idle; an input a weak pull-up.
  output ? { kind: "GPIO", node: `$cp2102${name}`, vddNode: CP2102_VDD, drive: { ohms } } : { kind: "R", a: CP2102_VDD, b: `$cp2102${name}`, value: ohms },
  { kind: "SW", a: `$cp2102${name}`, b: net, part: "USB", closed: "on" },
  { kind: "SW", a: net, b: `$cp2102${name}clamp`, part: "USB", closed: "off" },
  { kind: "D", anode: `$cp2102${name}clamp`, cathode: CP2102_VDD, ...CP2102_UNPOWERED_CLAMP },
]

const cp2102: Element[] = [
  { kind: "REG", in: "$u5vlim", out: CP2102_VDD, gnd: GND, value: 3.3, dropout: 0.7, imax: 0.1 },
  { kind: "R", a: CP2102_VDD, b: GND, value: CP2102_NORMAL_SUPPLY_OHMS },
  ...cp2102Pin("rxd", "VCP-TX", CP2102_INPUT_PULL_UP_OHMS),
  ...cp2102Pin("txd", "VCP-RX", CP2102_OUTPUT_HIGH_OHMS, true),
  ...cp2102Pin("cts", "VCP-CTS", CP2102_INPUT_PULL_UP_OHMS),
  ...cp2102Pin("rts", "VCP-RTS", CP2102_OUTPUT_HIGH_OHMS),
]

const usart1Jumpers: Element[] = [
  { kind: "SW", a: nodeOf("PA9"), b: "VCP-TX", part: "JMP2_1", closed: "on" },
  { kind: "SW", a: nodeOf("PA10"), b: "VCP-RX", part: "JMP2_2", closed: "on" },
  { kind: "SW", a: nodeOf("PA11"), b: "VCP-CTS", part: "JMP2_3", closed: "on" },
  { kind: "SW", a: nodeOf("PA12"), b: "VCP-RTS", part: "JMP2_4", closed: "on" },
  { kind: "R", a: "$3v3", b: "$txk", value: 1e3 },
  { kind: "D", anode: "$txk", cathode: "VCP-TX", ...BOARD_RED_LED, part: "TXLED" },
  { kind: "R", a: "$3v3", b: "$rxk", value: 1e3 },
  { kind: "D", anode: "$rxk", cathode: "VCP-RX", ...BOARD_RED_LED, part: "RXLED" },
]

const otgJumpers: Element[] = [
  { kind: "SW", a: nodeOf("PA9"), b: USB_5V, part: "OTG_VBUS", closed: "on" },
  { kind: "R", a: USB_5V, b: "$vbusk", value: 1e3 },
  { kind: "D", anode: "$vbusk", cathode: GND, ...BOARD_RED_LED, part: "MVBUS" },
  { kind: "SW", a: nodeOf("PE2"), b: "$vbusen", part: "OTG_PWR", closed: "on" },
  { kind: "R", a: "$vbusen", b: "$3v3", value: 10e3 },
  { kind: "SW", a: nodeOf("PE3"), b: "$flg", part: "OTG_FLG", closed: "on" },
  { kind: "R", a: "$flg", b: "$3v3", value: FLG_PULL_UP_OHMS },
  { kind: "C", a: "$flg", b: GND, value: 100e-9 },
]

const mic2025FlagHalfOnWithoutTheModuleUsb: Element[] = [
  { kind: "SW", a: "$flg", b: "$flgd", part: "MUSB", closed: "off" },
  { kind: "M", polarity: "nmos", g: "$flgg", d: "$flgd", s: GND, vth: MIC2025_FLAG_VTH, k: MIC2025_FLAG_K, lambda: 0 },
  { kind: "V", plus: "$flgg", minus: GND, value: MIC2025_FLAG_GATE_FIT },
]

const arduinoJumpers: Element[] = [
  { kind: "SW", a: "CN3-5", b: nodeOf("PF7"), part: "JMP5_A4", closed: "on" },
  { kind: "SW", a: "CN3-5", b: nodeOf("PB9"), part: "JMP5_A4_PB9", closed: "on" },
  { kind: "SW", a: "CN3-6", b: nodeOf("PF6"), part: "JMP5_A5", closed: "on" },
  { kind: "SW", a: "CN3-6", b: nodeOf("PB8"), part: "JMP5_A5_PB8", closed: "on" },
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
  { kind: "REG", in: "$usb5v", out: USB_5V, gnd: GND, value: 5, dropout: 0, imax: 0.5 },
  { kind: "R", a: "$usb5v", b: GND, value: 250 },
  { kind: "SW", a: USB_5V, b: "$5v", part: "SW1", closed: "on" },
  { kind: "SW", a: "$5vin", b: "$5v", part: "SW1", closed: "off" },
  { kind: "R", a: "$5v", b: V5, value: 0.02 },
  { kind: "REG", in: "$5v", out: "$3v3", gnd: GND, value: AMS1117_VOLTS, dropout: 1.1, imax: 1 },
  { kind: "R", a: "$5v", b: GND, value: AMS1117_QUIESCENT_OHMS },
  { kind: "R", a: "$3v3", b: V3V3, value: 0.02 },
  { kind: "R", a: "$3v3", b: "$pwrk", value: 330 },
  { kind: "D", anode: "$pwrk", cathode: GND, ...BOARD_RED_LED, part: "PWR" },
  { kind: "R", a: "$3v3", b: "$mpwrk", value: 330 },
  { kind: "D", anode: "$mpwrk", cathode: GND, ...BOARD_RED_LED, part: "MPWR" },
  ...cp2102,
  ...usart1Jumpers,
  ...otgJumpers,
  ...mic2025FlagHalfOnWithoutTheModuleUsb,
  { kind: "R", a: "BOOT0", b: "$boot", value: 10e3 },
  { kind: "SW", a: "$boot", b: "$3v3", part: "BOOT", closed: "on" },
  { kind: "SW", a: "$boot", b: GND, part: "BOOT", closed: "off" },
  { kind: "SW", a: NRST, b: GND, part: "RESET", closed: "pressed" },
  { kind: "C", a: NRST, b: GND, value: 10e-9 },
  { kind: "SW", a: NRST, b: GND, part: "MRESET", closed: "pressed" },
  { kind: "C", a: NRST, b: GND, value: 10e-9 },
  ...led("PB6", "LED1", "JMP3_1"),
  ...led("PB7", "LED2", "JMP3_2"),
  ...led("PH4", "LED3", "JMP3_3"),
  ...led("PI8", "LED4", "JMP3_4"),
  ...joystick("PG2", "JOY_A", "JMP4_1"),
  ...joystick("PG3", "JOY_B", "JMP4_2"),
  ...joystick("PD4", "JOY_C", "JMP4_3"),
  ...joystick("PD5", "JOY_D", "JMP4_4"),
  ...joystick("PI11", "JOY_CTR", "JMP4_5"),
  { kind: "SW", a: nodeOf("PA0"), b: "$wk", part: "JMP6", closed: "on" },
  { kind: "C", a: "$wk", b: GND, value: 100e-9 },
  { kind: "R", a: "$wk", b: "$k1", value: 10e3 },
  { kind: "R", a: "$k1", b: GND, value: 10e3 },
  { kind: "SW", a: "$k1", b: "$3v3", part: "WAKEUP", closed: "pressed" },
  ...arduinoJumpers,
  { kind: "SW", a: "VBAT", b: "$3v3", part: "VBATJ", closed: "on" },
  { kind: "SW", a: "VREF+", b: "$3v3", part: "VREFJ", closed: "on" },
  ...[...byMcu.values()].filter((ids) => ids.length > 1).map((ids): Element => ({ kind: "SHORT", nodes: ids })),
  ...mcuModel(STM32F746IG, { vdd: "$3v3", gnd: GND, nrst: NRST, boot0: "BOOT0", pads: [...byMcu.values()].map((ids) => ids[0]) }),
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
  bounces: JOYSTICK,
  defaults: { bounce: "on", tbounce: GANSSLE_LONGEST_BOUNCE },
  fields: JOYSTICK_BOUNCE_FIELDS,
  model,
  hideIdle: true,
  pinsAreSockets: true,
  chip: STM32F746IG.id,
  mcuPower: V3V3,
  mcuReset: NRST,
  mcuBoot0: "BOOT0",
  mcuProgramBoot: "BOOT",
  mcuVbat: "VBAT",
  mcuVref: "VREF+",
  // Core746I: 8 MHz crystal on PH0/PH1, 32.768 kHz on PC14/PC15.
  mcuClocks: { hse: { hz: 8e6, kind: "crystal", startup: 2e-3 }, lse: { hz: 32768, kind: "crystal", startup: 2 } },
  // IS42S16400J on FMC SDRAM bank 2: 8 MB at 0xD000_0000, usable once the FMC has set it up.
  mcuMemory: [{ name: "SDRAM", base: 0xd0000000, size: 0x800000, kind: "ram", external: "sdram2" }],
  info: {
    MCU: "STM32F746IGT6 on the Core746I, Cortex-M7 216 MHz, 1 MB Flash, 320 KB SRAM, 8 MB SDRAM (IS42S16400J, FMC bank 2 at 0xD0000000)",
    "Pin strips (P18–P21)": "Every I/O of the LQFP176 by its name, 140 in all, on two 2×18 strips either side of the module: P20 above P21 on the left, P19 above P18 on the right. GND and 3.3 V on P18-35/36, 3.3 V on P20-35, 5 V on P21-36. The module's own 2×40 pad rows (P16, P17) are the same nets: the board brings them out to these strips",
    "USART1": "PA9 → the CP2102's RXD, PA10 ← its TXD, PA11 ↔ its CTS input, PA12 ↔ its RTS output, each through a JMP2 cap (USART1 JMP, a 2 × 4 header with all four caps fitted as shipped); the board does not cross the flow-control pair. The header's bridge-side pins TXD, RXD, CTS and RTS are wireable: with a cap fitted a wire there meets the MCU's pad too, with it off only the bridge. The TX/RX LEDs (1 kΩ from 3.3 V) sit on the bridge's side of the caps. Powered by the USART1 USB, the bridge holds its TXD and RTS high through 233 Ω (VDD − 0.7 V at 3 mA, its datasheet's guaranteed drive; typically stronger), pulls RXD and CTS up with 25 µA, and draws its datasheet's 20 mA (normal operation) from its own 3.3 V regulator, so the 5 V a fitted OTG VBUS cap puts on its RXD (its pins are rated to 5.8 V) cannot lift that rail through the pull-up. With the USART1 USB out the bridge is unpowered and its four pins clamp to its dead supply through their protection (a junction like an ESD diode, 0.7 V at 10 mA), loaded by the same 20 mA equivalent: the TX and RX LEDs light through them, as on the board, and leave PA9 and PA10 near 0.85 V. The datasheet gives no figures for an unpowered CP2102, so that load is an assumption: PA9 and PA10 measured on the board with the module's USB only would settle it",
    "USER LEDs": "PB6, PB7, PH4, PI8 → 1 kΩ → LED → GND, each behind its JMP3 jumper",
    Joystick: "A PG2, B PG3, C PD4, D PD5, centre PI11, to GND, each behind its JMP4 jumper; no pull-ups on the board. Its contacts bounce (on as shipped, Joystick contact bounce in the inspector): every press and release is a burst of 3–9 re-strikes lasting up to the bounce time, 6 ms by default after Ganssle's study of 18 switches (A Guide to Debouncing, 2004, rev. 4 2014: 1557 µs on average and 6200 µs the longest over the 16 that were not outliers), the same burst for the same part and press every run; the lab's own joystick has not been measured",
    WAKEUP: "PA0 through JMP6, active high: 100 nF to ground at the jumper, 10 kΩ on to K1 (3.3 V when pressed) and 10 kΩ from there to ground, so 3.3 V pressed and 20 kΩ to ground released",
    "OTG JMP (Core746I)": "Three positions; the lab's boards ship with two caps, PWR OUT and FLG, and VBUS empty (two benches checked, 2026-10-13). VBUS, fitted, ties PA9 to the module USB's 5 V (the VBUS LED, through 1 kΩ, sits on that 5 V either way; its 10 µF and 10 nF are decoupling, left out like the rest), so with that USB plugged in PA9 sits at 5 V and as an output it burns, USART1 TX included; PWR OUT puts PE2 on the MIC2025's enable (10 kΩ to 3.3 V); FLG puts PE3 on its open-drain fault flag (10 kΩ to 3.3 V, 100 nF). The pin lab (2026-10-12, board on the USART1 USB, module USB out, the VBUS LED dark) found PE3 sitting at 0.80 V: neither a released flag (3.3 V) nor an asserted one (8–25 Ω, near 0 V), and neither the schematic nor the MIC2025 datasheet explains it. Modelled as a fit: whenever the module's USB is out, the flag's open-drain NMOS is half on, its gate held where it sinks the 249 µA that puts the node at the measured 0.80 V against the 10 kΩ (k from the datasheet's 8 Ω flag at 5 V). A transistor in saturation is a current sink, so the pad driving PE3 high loses only 5 mV to it, as the bench saw (VDD − 2 mV). It is not the whole story: the bench read 1.44 V with the pad's pull-up and 1.06 V with its pull-down after the firmware's own sweeps, the second above the undisturbed level, which no static equivalent gives; the fit gives 1.30 V and 0.64 V",
    Jumpers: "Switches on the board, as shipped: JMP2 ×4 (USART1), JMP3 ×4 (LEDs), JMP4 ×5 and JMP6 (KEY JMP), JMP5 (caps on PF7–A4 and PF6–A5; the PB9 and PB8 positions empty), and on the module the OTG JMP (PWR OUT and FLG fitted, VBUS empty as shipped) and the POWER JMP's two caps, VBAT and VREF+. JMP1 (card detect ↔ PC13) is not one of them: the schematic draws it as a 2-pin header, but the lab's board has a 0 Ω resistor soldered there, printed PC13, so SDMMC's CD is PC13 for good, like Arduino A1 through the 0 Ω H6",
    "RESET": "Both buttons short NRST to ground; 10 nF on each side (module and board) with the MCU's internal pull-up",
    "BOOT switch": "Starts on SYSTEM, as the board is left for flashing through ST's bootloader: Compile programs the board and starts the program, as STM32CubeProgrammer does after a download. Its common reaches BOOT0 through 10 kΩ: SYSTEM lifts it to 3.3 V, so a RESET or a power cycle starts the core in system memory, where the bootloader is not modelled (it idles); FLASH grounds it and the firmware runs from reset",
    VBAT: "POWER JMP's VBAT cap fitted: from the 3.3 V rail, so a power cut clears the RTC and backup registers; take it off and wire a battery to the VBAT pin to keep them counting through the cut",
    "VREF+": "POWER JMP's VREF+ cap fitted (as shipped): the ADC and DAC reference is the 3.3 V rail. Take it off and the reference is whatever the VREF+ pin carries: every conversion reads VIN / VREF+ × full scale (RM0385 §15.3), the DAC puts out code / 4095 × VREF+, and the inspector flags a reference outside DS10916 Table 63 (1.7 V to VDDA, within 1.2 V of VDDA). Nothing on it, the pin floats to 0 V (its 1 µF and 100 nF on the module are not modelled) and the ADC's comparator, measuring every input against a zero reference, reads full scale for any input above 0 V; that is the model's assumption, the datasheet guarantees nothing below 1.7 V",
    "LCD 7inch (P15)": "24-bit RGB on the LTDC, backlight PA3, GT911 touch on PD13/PD12 (I2C4), RST PD11, INT PD7",
    "USB OTG (Core746I)": "Its VBUS powers the module with SW1 at USB (5Vin from the board's S2 otherwise) and reaches PA9 through the OTG JMP's VBUS position, empty as shipped. D− and D+ go to PA11/PA12 through 22 Ω and ID to PA10 through 330 Ω; nothing behind the connector is modelled, so those resistors carry no current here",
    "Not modelled": "JTAG/SWD (no debugger; no pull resistors on the module), the 4.3\" LCD header P14 (RGB as P15, XPT2046 touch on PF7/PF8/PF9 with CS PF6, PENIRQ PD7 and BUSY PD11, backlight PA3), the MIC2025's switch from 5 V to the module's USB (its enable polarity, -1 or -2, is not printed), RTS following the PC's terminal (held high, as the bench found it), the fast fall the census found on PA13 and PB3 (the pin lab saw no resistive pull-down on either: pulled up, both read VDD), the PC's 15 kΩ on D−/D+ behind the module USB, PDR_ON's 3-pad solder jumper COMP.J2 (its bridged side is not printed), the module's decoupling",
    Source: "Waveshare Open746I-C and Core746I schematics",
  },
}
