import { CpuIcon } from "lucide-react"
import { builder } from "../builder"
import { nucleoApp } from "../projects"

/**
 * A 0.96" SSD1306 OLED (128 × 64) on I²C: firmware/hal/Src/oled.c on I2C1 (PB8 SCL / D15,
 * PB9 SDA / D14) at 400 kHz to the module at 0x3C. Adafruit's init sequence, a 1 KB
 * framebuffer in RAM drawn with a 5 × 7 font — a frame, "Hello, OLED!" and a seconds counter —
 * sent whole once a second. The module runs on the board's +3V3: its regulator makes the
 * controller's 3.3 V either way and its own 10 kΩ pull-ups go to that rail, so from +3V3 the
 * whole bus sits on the MCU's own supply. No external pull-ups.
 */
export const nucleoOled = {
  id: "nucleo-oled",
  name: "Nucleo I²C OLED 128×64",
  description: "I2C1 at 400 kHz to an SSD1306 OLED (0x3C): Adafruit's init, a 1 KB framebuffer with a 5 × 7 font — frame, greeting and a seconds counter — sent once a second. The module runs on +3V3 with its own pull-ups.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: nucleoApp("oled") }],
  build(grid: number) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // The module sits above the right header with its pins on top: GND (36,2), VCC (38,2),
    // SCL (40,2), SDA (42,2), stubs ending at y 1. CN7-2 (D15, SCL) and CN7-4 (D14, SDA) leave
    // the board at rows 13 and 14 and come round the module's right side; the two pin orders
    // are opposite, so SDA crosses SCL once.
    const oled = place("oled-ssd1306-i2c", 33, 2)
    wire(u, "CN7-2", oled, "SCL", [[47, 13], [47, -1], [40, -1]])
    wire(u, "CN7-4", oled, "SDA", [[48, 14], [48, -2], [42, -2]])
    // +3V3 (CN8-7, row 16) from the far side, over the top of the board.
    wire(u, "CN8-7", oled, "VCC", [[-2, 16], [-2, -3], [38, -3]])
    const gnd = place("ground", 30, 1)
    wire(oled, "GND", gnd, "GND", [[36, 0], [31, 0]])
    return doc
  },
}
