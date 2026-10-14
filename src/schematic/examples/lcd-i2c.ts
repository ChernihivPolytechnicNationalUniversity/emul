import { CpuIcon } from "lucide-react"
import { builder } from "../builder"
import { nucleoApp } from "../projects"

/**
 * A 16 × 2 character LCD on its PCF8574 I²C backpack: firmware/hal/Src/lcd-i2c.c on I2C1
 * (PB8 SCL / D15, PB9 SDA / D14) at 100 kHz to the backpack at 0x27. The HD44780 is
 * initialised by instruction in 4-bit mode, line 1 greets, line 2 counts seconds. The module
 * runs on the board's +5V; its own 4.7 kΩ pull-ups hold SDA and SCL at 5 V, which PB8/PB9
 * take as five-volt-tolerant pads driven open-drain — no external pull-ups or level shifter.
 * Select the display to see its DDRAM and the busy-flag and bus-timing checks.
 */
export const nucleoLcdI2c = {
  id: "nucleo-lcd-i2c",
  name: "Nucleo I²C LCD 1602",
  description: "I2C1 at 100 kHz to a 1602 LCD on a PCF8574 backpack (0x27): HD44780 4-bit initialisation by instruction, a greeting and a seconds counter. The module runs on +5V with its own pull-ups.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: nucleoApp("lcd-i2c") }],
  build(grid: number) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // The backpack's pins face the board: GND (36,12), VCC (36,13), SDA (36,14), SCL (36,15),
    // stubs ending at x 35. CN7-2 (D15, SCL) leaves at (28,13), CN7-4 (D14, SDA) at (28,14):
    // SCL has to cross SDA, the two pin orders are opposite.
    const lcd = place("lcd-1602-i2c", 36, 9)
    wire(u, "CN7-4", lcd, "SDA")
    wire(u, "CN7-2", lcd, "SCL", [[31, 13], [31, 15]])
    // +5V (CN8-9) and GND (CN8-11) leave at (0,17) and (0,18) from the far side, over the top of the
    // board, nested so they do not cross.
    wire(u, "CN8-9", lcd, "VCC", [[-2, 17], [-2, -3], [33, -3], [33, 13]])
    wire(u, "CN8-11", lcd, "GND", [[-3, 18], [-3, -4], [34, -4], [34, 12]])
    return doc
  },
}
