import { BatteryMediumIcon, CircleDashedIcon, CpuIcon, NetworkIcon, ZapIcon } from "lucide-react"
import { builder } from "./builder"
import { getDef } from "./registry"
import { systemExam } from "./exam"
import { transistorLogic } from "./logic"
import type { Icon } from "./icons"
import type { Schematic } from "./types"

export type Example = {
  id: string
  name: string
  description: string
  icon: Icon
  /** Builds the document; positions are in grid cells and scaled by `grid`. */
  build: (grid: number) => Schematic
  /** Firmware to fetch and load into the boards with these designators once the document is built. */
  firmware?: { ref: string; url: string }[]
}

/**
 * Mains → transformer → bridge rectifier → filter capacitor → load.
 * D1/D2 feed the + corner, D3/D4 return from the − corner.
 */
const powerSupply: Example = {
  id: "power-supply",
  name: "Basic power supply",
  description: "230 V mains, 12 V transformer, bridge rectifier, 1000 µF filter and an LED load.",
  icon: ZapIcon,
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const mains = place("ac-source", 0, 4)
    const t = place("transformer", 4, 4)
    const diode = { value: "1N4007", vf: "0.7", imax: "1 A", vrev: "1000 V" }
    // The bridge is drawn the usual way, as a diamond: the four diodes sit on 45° and their
    // stubs meet on the grid at ~ (13,6) and (21,6), + (17,2) and − (17,10).
    const d1 = place("diode", 13, 2, diode, 315)
    const d2 = place("diode", 17, 2, diode, 225)
    const d3 = place("diode", 13, 6, diode, 225)
    const d4 = place("diode", 17, 6, diode, 315)
    const c = place("capacitor-polarized", 26, 2, { value: "1000 µF", vmax: "25 V" }, 90)
    const load = place("resistor", 30, 2, { value: "1 kΩ", power: "0.5" }, 90)
    const r = place("resistor", 34, 2, { value: "1 kΩ", power: "0.25" }, 90)
    const led = place("led", 34, 6, { value: "green" }, 90)
    const gnd = place("ground", 16, 13)

    wire(mains, "+", t, "P1")
    wire(mains, "-", t, "P2")
    // Secondary into the two ~ corners; the far one takes the usual detour under the bridge.
    wire(t, "S1", d1, "1")
    wire(d1, "1", d3, "2")
    wire(t, "S2", d2, "1", [
      [10, 16],
      [24, 16],
      [24, 6],
    ])
    wire(d2, "1", d4, "2")
    // + corner out to the filter and the load.
    wire(d1, "2", d2, "2")
    wire(d2, "2", c, "1")
    wire(c, "1", load, "1")
    wire(load, "1", r, "1")
    // R2 and the LED are butted pin to pin: touching pins conduct, so no wire is drawn here.
    // − corner down to ground, and the returns along it.
    wire(d3, "1", d4, "1")
    wire(d3, "1", gnd, "GND")
    wire(c, "2", gnd, "GND")
    wire(load, "2", c, "2")
    wire(led, "2", load, "2")
    return doc
  },
}

/**
 * Two pairs of sine sources for the oscilloscope's XY mode: equal frequencies a quarter
 * period apart trace a circle, a 3:2 ratio the classic Lissajous knot. Probe one source of a
 * pair, hold it, probe the other, switch the scope to XY.
 */
const lissajous: Example = {
  id: "lissajous",
  name: "Lissajous figures",
  description: "Sine pairs for the oscilloscope's XY mode: 100 Hz against 100 Hz at 90° draws a circle, 300 Hz against 200 Hz a knot.",
  icon: CircleDashedIcon,
  build(grid) {
    const { doc, place, wire } = builder(grid)
    // Each source drives its own 1 kΩ to ground: X on the left, Y on the right.
    const pair = (ox: number, fx: string, fy: string, phase: string) => {
      const leg = (x: number, freq: string, ph: string) => {
        const src = place("ac-source", x, 2, { value: "1 V", freq, phase: ph, offset: "0 V", rint: "1 Ω", imax: "1 A" })
        const r = place("resistor", x + 3, 3, { value: "1 kΩ", power: "0.25" }, 90)
        const g = place("ground", x + 2, 9)
        wire(src, "+", r, "1", [[x + 1, 1], [x + 4, 1]])
        wire(r, "2", g, "GND", [[x + 4, 8], [x + 3, 8]])
        wire(src, "-", g, "GND", [[x + 1, 8], [x + 3, 8]])
      }
      leg(ox, fx, "0")
      leg(ox + 8, fy, phase)
    }
    pair(0, "100 Hz", "100 Hz", "90")
    pair(20, "300 Hz", "200 Hz", "0")
    return doc
  },
}

/**
 * The seven-resistor bridge from the sketch: R4 ∥ R1 from A to the left corner, R2 to the
 * right corner, R3 bridging the two, R6 and R7 down to the bottom corner and R5 out to B.
 * Unbalanced, so no pair of arms reduces: every drop has to come out of the node equations.
 */
const bridge: Example = {
  id: "bridge",
  name: "Resistor bridge",
  description: "Unbalanced seven-resistor bridge across 12 V, with R3 bridging the two arms.",
  icon: NetworkIcon,
  build(grid) {
    const { doc, place, wire } = builder(grid)
    // Designators follow the sketch rather than the order the parts are placed in.
    const r = (ref: string, value: string) => ({ ref, value, power: "0.25" })
    // The diamond: four arms on 45°, meeting at (13,6) left, (21,6) right, (17,2) top, (17,10) bottom.
    const r1 = place("resistor", 13, 2, r("R1", "1 kΩ"), 315)
    const r2 = place("resistor", 17, 2, r("R2", "2.2 kΩ"), 225)
    const r6 = place("resistor", 13, 6, r("R6", "3.3 kΩ"), 225)
    const r7 = place("resistor", 17, 6, r("R7", "680 Ω"), 315)
    const r3 = place("resistor", 15, 5, r("R3", "4.7 kΩ"))
    const r4 = place("resistor", 4, 2, r("R4", "1.5 kΩ"), 90)
    const r5 = place("resistor", 8, 11, r("R5", "470 Ω"))
    const v = place("supply", 4, -4, { value: "+12V", voltage: "12 V" })
    const g = place("ground", 4, 14)
    // A is the top rail: the supply, R4 and the top corner of the bridge are one node.
    wire(v, "V", r4, "1")
    wire(r4, "1", r1, "2", [[5, 0], [17, 0]])
    wire(r1, "2", r2, "2")
    // Left corner.
    wire(r4, "2", r1, "1", [[5, 6]])
    wire(r1, "1", r6, "2")
    wire(r1, "1", r3, "1", [[13, 6]])
    // Right corner.
    wire(r2, "1", r7, "2")
    wire(r3, "2", r7, "2", [[21, 6]])
    // Bottom corner out through R5 to B, which is ground.
    wire(r6, "1", r7, "1")
    wire(r6, "1", r5, "2", [[17, 12]])
    wire(r5, "1", g, "GND", [[8, 12], [5, 12]])
    return doc
  },
}

/** Two AA cells through a switch into an LED: select the battery while it runs to watch the charge and the time left. */
const batteryLife: Example = {
  id: "battery-life",
  name: "Battery life",
  description: "Two AA alkalines lighting a red LED through 100 Ω. The inspector shows the charge and how long the cells will last; try a CR2032 or a flat pack.",
  icon: BatteryMediumIcon,
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const bat = place("battery", 2, 4, { chem: "alkaline", cells: "2", capacity: "2.5 Ah", soc: "100" })
    const sw = place("switch", 6, 2)
    const r = place("resistor", 12, 2, { value: "100 Ω", power: "0.25" })
    const led = place("led", 18, 2, { value: "red" })
    const gnd = place("ground", 23, 10)
    wire(bat, "+", sw, "1", [[3, 3]])
    wire(sw, "2", r, "1")
    wire(r, "2", led, "1")
    wire(led, "2", gnd, "GND", [[24, 3]])
    wire(bat, "-", gnd, "GND", [[3, 10], [24, 10]])
    return doc
  },
}

/**
 * The Arduino "blink" wiring on a Nucleo-144: D13 through 220 Ω into an LED to GND. The board
 * runs the HAL blink firmware (firmware/hal): LD1 and D13 toggle every 500 ms, LD2 every
 * 100 ms, the USER button toggles LD3 through EXTI.
 */
export const nucleoBlink: Example = {
  id: "nucleo-blink",
  name: "Nucleo blink",
  description: "Nucleo-144 running the STM32 HAL blink firmware, with an external LED on D13 through 220 Ω.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/nucleo-blink.elf" }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // D13 is CN7 pin 10 at (26,17); its stub runs 3 cells out to (29,17).
    const r = place("resistor", 32, 16, { value: "220 Ω", power: "0.25" })
    const led = place("led", 38, 16, { value: "red", imax: "20 mA" })
    const gnd = place("ground", 45, 18)
    wire(u, "CN7-10", r, "1")
    wire(r, "2", led, "1")
    wire(led, "2", gnd, "GND")
    // Board ground is CN7 pin 8, right above D13; its return runs over the top of the load.
    wire(u, "CN7-8", gnd, "GND", [
      [30, 16],
      [30, 14],
      [46, 14],
    ])
    return doc
  },
}

/**
 * A signal source without a timer: the square firmware (firmware/hal/Src/square.c) bit-bangs
 * 1 kHz on D13 and 250 Hz on D33, timed by the DWT cycle counter at 180 MHz. Probe either pin
 * and open the oscilloscope.
 */
export const nucleoSquare: Example = {
  id: "nucleo-square",
  name: "Nucleo signal generator",
  description: "STM32 firmware bit-banging 1 kHz on D13 and 250 Hz on D33 into resistive loads — probe them with the oscilloscope.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/nucleo-square.elf" }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // D13 is CN7 pin 10 at (26,17); D33 is CN10 pin 31 at (25,39), inner column.
    const r1 = place("resistor", 32, 16, { value: "1 kΩ", power: "0.25" })
    const r2 = place("resistor", 32, 38, { value: "10 kΩ", power: "0.25" })
    const gnd = place("ground", 39, 44)
    wire(u, "CN7-10", r1, "1")
    wire(u, "CN10-31", r2, "1")
    wire(r1, "2", gnd, "GND", [[40, 17]])
    wire(r2, "2", gnd, "GND", [[40, 39]])
    return doc
  },
}

/**
 * The university teaching stand for lab 1: a bare STM32F746IGT6 with four LEDs (L1..L4 on
 * PB6, PB7, PH4, PI8 through 1 kΩ, as on the Open746I-C) and a five-way joystick (A/B on PG2/PG3, C/D on PD4/PD5,
 * centre on PI11) that pulls the pins to ground against the internal pull-ups. The firmware
 * is the STM32CubeIDE project as handed out: it steps the LEDs on and off 1/2/3/4 s apart.
 * The 8 MHz crystal on PH0/PH1 (with its load capacitors) is what lets its HSE start: take
 * it off and the firmware stops in Error_Handler waiting for HSERDY, as the real stand would.
 */
/**
 * The same lab on the stand itself: the Waveshare Open746I-C with the Core746I module, whose
 * USER LEDs and joystick are exactly the pins the firmware drives. Nothing to wire — the board
 * is the circuit; the module's USB powers it, the USART1 USB is there for the serial port.
 */
export const lab1Board: Example = {
  id: "lab1-open746i-c",
  name: "Lab 1: Open746I-C board",
  description: "The Waveshare Open746I-C stand running the lab's LED staircase firmware on its own LEDs and joystick.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/lab1-f746.elf" }],
  build(grid) {
    const { doc, place } = builder(grid)
    place("open746i-c", 0, 0)
    return doc
  },
}

/**
 * The stand with its 7" screen: Waveshare's own LCD demo (29.LCD-Display/3.display 1024x600,
 * built with GCC in firmware/lcd) brings the SDRAM up over the FMC, clears the panel red
 * through the DMA2D and writes its greeting with the BSP font, all through the LTDC at 32 MHz.
 * The module docks straight onto P15: the FFC pins touch, no wires.
 */
export const lcdDemo: Example = {
  id: "open746-lcd",
  name: "Open746I-C: 7\" LCD demo",
  description: "Waveshare's LCD demo on the stand: the 1024×600 panel on the LTDC with the framebuffer in the SDRAM, text drawn through the DMA2D.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/open746-lcd.elf" }],
  build(grid) {
    const { doc, place } = builder(grid)
    place("open746i-c", 0, 0)
    // P15's first pin is at (35, 52) on the board, the module's at (32, -4) on itself.
    place("lcd7-f", 3, 56)
    return doc
  },
}

/**
 * The GT911 touch test from the LCD's own code pack: reset sequence on RST/INT, product id
 * and firmware version over bit-banged I²C on PD12/PD13 (printed on USART1), then crosshairs
 * that follow the finger. Press the panel.
 */
export const touchDemo: Example = {
  id: "open746-touch",
  name: "Open746I-C: touch test",
  description: "Waveshare's GT911 test on the stand: press the panel and crosshairs follow; the controller's id goes out on USART1.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/open746-touch.elf" }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u = place("open746i-c", 0, 0)
    place("lcd7-f", 3, 56)
    // The CP2102's side of USART1: TX at (46, 3), RX at (52, 3) either side of the micro-USB.
    const term = place("serial-terminal", 34, -9, { baud: "115200" })
    wire(u, "VCP-TX", term, "RX")
    wire(u, "VCP-RX", term, "TX")
    return doc
  },
}

/**
 * Our own demo on the stand: a cube with a photo on every face, spinning in perspective,
 * rendered in software into two framebuffers in the SDRAM and flipped through the LTDC
 * (firmware/lcd/cube, C++). The emulated core runs at a fraction of real time, so the cube
 * turns slowly here; on the board it spins at 0.87 rad/s.
 */
export const cubeDemo: Example = {
  id: "open746-cube",
  name: "Open746I-C: spinning cube",
  description: "A textured cube rotating on the 7\" panel: software rasteriser in C++ into double-buffered SDRAM framebuffers, scanned out by the LTDC.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/open746-cube.elf" }],
  build(grid) {
    const { doc, place } = builder(grid)
    place("open746i-c", 0, 0)
    place("lcd7-f", 3, 56)
    return doc
  },
}

export const lab1Stand: Example = {
  id: "lab1-f746",
  name: "Lab 1: STM32F746 stand",
  description: "Bare STM32F746IGT6 with four LEDs and a joystick, running the lab's LED staircase firmware.",
  icon: CpuIcon,
  firmware: [{ ref: "DD1", url: "firmware/lab1-f746.elf" }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const chip = getDef("stm32f746ig")!
    const y = (pin: string) => chip.pins.find((p) => p.id === pin)!.y
    const R = chip.width
    const dd = place("stm32f746ig", 0, 0)
    // Power: +3V3 into VDD and VDDA, VSS and VSSA to ground. Stubs reach 2 cells out.
    const v33 = place("supply", -9, y("VDD") - 3, { value: "+3V3", voltage: "3.3 V" })
    const gnd = place("ground", -9, y("VSS") + 1)
    wire(v33, "V", dd, "VDD", [[-8, y("VDD")]])
    wire(v33, "V", dd, "VDDA", [[-6, y("VDD") - 1], [-6, y("VDDA")]])
    wire(dd, "VSS", gnd, "GND", [[-8, y("VSS")]])
    wire(dd, "VSSA", gnd, "GND", [[-5, y("VSSA")], [-5, y("VSSA") + 1], [-8, y("VSSA") + 1]])
    // Reset button SA1 from NRST to ground.
    const sa1 = place("pushbutton", -15, y("NRST") + 1, { ref: "SA1" })
    wire(dd, "NRST", sa1, "2", [[-9, y("NRST")], [-9, y("NRST") + 2]])
    wire(sa1, "1", gnd, "GND", [[-17, y("NRST") + 2], [-17, y("VSS") + 1]])

    // LEDs: pin → 1 kΩ → LED → ground. L1/L2 leave port B on the left, L3/L4 ports H/I on the right.
    const leftLed = (pin: string, py: number, n: number) => {
      const r = place("resistor", -10, py - 1, { ref: `R${n + 1}`, value: "1 kΩ", power: "0.25" })
      const led = place("led", -16, py - 1, { ref: `VD${n}`, value: "red", imax: "20 mA" }, 180)
      const g = place("ground", -21, py)
      wire(dd, pin, r, "2")
      wire(r, "1", led, "1")
      wire(led, "2", g, "GND")
    }
    const rightLed = (pin: string, py: number, n: number) => {
      const r = place("resistor", R + 6, py - 1, { ref: `R${n + 1}`, value: "1 kΩ", power: "0.25" })
      const led = place("led", R + 12, py - 1, { ref: `VD${n}`, value: "red", imax: "20 mA" })
      const g = place("ground", R + 17, py)
      wire(dd, pin, r, "1")
      wire(r, "2", led, "1")
      wire(led, "2", g, "GND")
    }
    leftLed("PB6", y("PB6"), 1)
    leftLed("PB7", y("PB7") + 2, 2)
    rightLed("PH4", y("PH4"), 3)
    rightLed("PI8", y("PI8"), 4)

    // Joystick: five buttons to ground; the pins are inputs with pull-up in MX_GPIO_Init.
    const button = (pin: string, ref: string, dx: number, dy: number) => {
      const py = y(pin) + dy
      const left = dx < 0
      const sw = place("pushbutton", left ? dx : R + dx, py - 1, { ref })
      const g = place("ground", left ? dx - 5 : R + dx + 7, py)
      wire(dd, pin, sw, left ? "2" : "1")
      wire(sw, left ? "1" : "2", g, "GND")
    }
    button("PG2", "SA2", 6, 0)
    button("PG3", "SA3", 6, 2)
    button("PD4", "SA4", -10, 0)
    button("PD5", "SA5", -10, 2)
    button("PI11", "SA6", 6, 0)

    // 8 MHz crystal across OSC_IN/OSC_OUT (PH0/PH1) with 20 pF load capacitors to ground, out
    // past the LEDs on the right.
    const yx = y("PH0")
    const zq = place("crystal", R + 21, yx - 2, { ref: "ZQ1", value: "8 MHz" }, 90)
    const c1 = place("capacitor", R + 24, yx - 4, { ref: "C1", value: "20 pF" })
    const c2 = place("capacitor", R + 24, yx + 2, { ref: "C2", value: "20 pF" })
    const gx = place("ground", R + 30, yx + 4)
    wire(dd, "PH0", zq, "1", [[R + 20, yx], [R + 20, yx - 3]])
    wire(dd, "PH1", zq, "2", [[R + 20, yx + 1], [R + 20, yx + 3]])
    wire(zq, "1", c1, "1")
    wire(zq, "2", c2, "1")
    wire(c1, "2", gx, "GND", [[R + 31, yx - 3]])
    wire(c2, "2", gx, "GND")
    return doc
  },
}

/**
 * Timers: firmware/hal/Src/pwm.c. TIM3 dims LD1 (PB0 / D33) with 1 kHz PWM stepping through
 * 10…90 % duty; TIM1 puts a 20 kHz 30 % PWM on D6 (PE9) and its complement on D42 (PE8) — into
 * an external LED here; TIM2 blinks LD2 from its interrupt; TIM4 measures LD1's PWM back on
 * D26 (PB6) through the wire. Probe D6 and D33 with the oscilloscope.
 */
export const nucleoPwm: Example = {
  id: "nucleo-pwm",
  name: "Nucleo timers and PWM",
  description: "TIM3 PWM dimming LD1, TIM1 complementary PWM into an external LED, TIM2 interrupt blink, TIM4 input capture.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/nucleo-pwm.elf" }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // D6 is CN10 pin 4 (PE9) at (25,25), inner column; its stub runs 4 cells out to (29,25).
    const r = place("resistor", 34, 24, { value: "330 Ω", power: "0.25" })
    const led = place("led", 40, 24, { value: "green", imax: "20 mA" })
    const gnd = place("ground", 47, 27)
    wire(u, "CN10-4", r, "1")
    wire(r, "2", led, "1")
    wire(led, "2", gnd, "GND", [[46, 25], [46, 29], [48, 29]])
    // Board ground is CN10 pin 5, right below D6.
    wire(u, "CN10-5", gnd, "GND", [[31, 26], [31, 31], [50, 31], [50, 29], [48, 29]])
    // TIM4 input capture on D26 (PB6, CN10-13) fed from LD1's PWM on D33 (PB0, CN10-31).
    wire(u, "CN10-13", u, "CN10-31", [[33, 30], [33, 39]])
    return doc
  },
}

/**
 * USART: firmware/hal/Src/uart.c prints "tick N" on the ST-LINK virtual COM port (USART3,
 * 115200 8N1) — every tenth line in Ukrainian, so bytes above 127 travel as UTF-8 — and
 * echoes what it receives with ASCII letters upper-cased. Select the terminal to read it and
 * type into it; switch its encoding to see the same bytes read differently.
 */
export const nucleoSerial: Example = {
  id: "nucleo-serial",
  name: "Nucleo serial console",
  description: "USART3 over the ST-LINK virtual COM port into a serial terminal: prints ticks (some in UTF-8 Ukrainian), echoes what you type upper-cased.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/nucleo-uart.elf" }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // VCP pins sit on the ST-LINK zone's left edge at y 4 (TX) and 6 (RX), stubs 2 cells out.
    const term = place("serial-terminal", -12, 3, { baud: "115200" })
    wire(u, "VCP-TX", term, "RX")
    wire(u, "VCP-RX", term, "TX")
    return doc
  },
}

/**
 * SPI between two boards: U1 runs firmware/hal/Src/spi.c (SPI1 master on the Arduino pins,
 * byte 0xA0+n every 10 ms, chip select bit-banged on D10), U2 runs spi-slave.c (SPI4 slave on
 * CN9 with hardware NSS, answers 0x50+n). Both cores run in lockstep so the slave's MISO bit
 * lands before the master's next clock edge. Select a board to see what its firmware counted.
 */
export const nucleoSpi: Example = {
  id: "nucleo-spi",
  name: "Nucleo SPI link",
  description: "Two Nucleos over SPI: master on U1 (SPI1, D13/D12/D11, chip select on D10) sends a byte every 10 ms, slave on U2 (SPI4 on CN9) answers with its count.",
  icon: CpuIcon,
  firmware: [
    { ref: "U1", url: "firmware/nucleo-spi-master.elf" },
    { ref: "U2", url: "firmware/nucleo-spi-slave.elf" },
  ],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u1 = place("nucleo-f429zi", 0, 0)
    const u2 = place("nucleo-f429zi", 40, 0)
    // U1's CN7 (right edge, pin ends at x 29, rows 17..20) to U2's CN9 (left edge, x 39, rows
    // 28..31), each wire on its own column of the gap. The chip select has to cross MISO and
    // MOSI: NSS sits between SCK and MISO on CN9.
    const link = (pinA: string, ya: number, pinB: string, yb: number, x: number) => wire(u1, pinA, u2, pinB, [[x, ya], [x, yb]])
    link("CN7-10", 17, "CN9-14", 28, 34) // D13 SCK → D56 (PE2, SPI4_SCK)
    link("CN7-12", 18, "CN9-18", 30, 33) // D12 MISO → D58 (PE5, SPI4_MISO)
    link("CN7-14", 19, "CN9-20", 31, 32) // D11 MOSI → D59 (PE6, SPI4_MOSI)
    link("CN7-16", 20, "CN9-16", 29, 31) // D10 chip select → D57 (PE4, SPI4_NSS)
    return doc
  },
}

/**
 * I²C: firmware/hal/Src/i2c.c on I2C1 (PB8/PB9 = D15/D14) talks to a 24C02 with 4.7 kΩ
 * pull-ups: writes a greeting page by page with acknowledge polling, reads it back (LD1
 * when it matches), then keeps a counter at 0x40. Select the EEPROM to see its contents.
 */
export const nucleoI2c: Example = {
  id: "nucleo-i2c",
  name: "Nucleo I²C EEPROM",
  description: "I2C1 at 100 kHz to a 24C02: page writes with acknowledge polling, read-back check on LD1, a counter that survives resets.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/nucleo-i2c.elf" }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // CN7-2 (D15, SCL) ends at (29,13), CN7-4 (D14, SDA) at (29,14). The EEPROM's bus pins
    // face them at (40,11) and (40,12); the pull-ups hang off a rail above.
    const mem = place("eeprom-24c", 40, 10, { value: "24C02" })
    const rail = place("supply", 31, 3, { value: "+3V3", voltage: "3.3 V" })
    const r1 = place("resistor", 34, 6, { value: "4.7 kΩ", power: "0.25" })
    const r2 = place("resistor", 34, 9, { value: "4.7 kΩ", power: "0.25" })
    const gnd = place("ground", 42, 20)
    wire(u, "CN7-2", mem, "SCL", [[33, 13], [33, 11]])
    wire(u, "CN7-4", mem, "SDA", [[35, 14], [35, 12]])
    wire(rail, "V", r1, "1", [[32, 7]])
    wire(rail, "V", r2, "1", [[32, 10]])
    wire(r1, "2", mem, "SCL", [[39, 7], [39, 11]])
    wire(r2, "2", mem, "SDA", [[38, 12]])
    wire(rail, "V", mem, "VCC", [[32, 5], [32, 2], [43, 2]])
    wire(mem, "GND", gnd, "GND")
    // Address straps and write protect to ground.
    wire(mem, "A0", gnd, "GND", [[48, 11], [48, 21], [43, 21]])
    wire(mem, "A1", gnd, "GND", [[48, 12]])
    wire(mem, "A2", gnd, "GND", [[48, 13]])
    wire(mem, "WP", gnd, "GND", [[39, 14], [39, 18], [43, 18]])
    return doc
  },
}

/**
 * ADC and DAC: firmware/hal/Src/adc.c reads a potentiometer on A0 every 10 ms and sets LD1's
 * PWM duty from it; DAC1 on D24 plays a 50 Hz sine from a table through TIM6 + DMA into a
 * red LED (probe D24 with the scope to see the wave).
 */
export const nucleoAdc: Example = {
  id: "nucleo-adc",
  name: "Nucleo ADC and DAC",
  description: "Potentiometer on A0 read by ADC1 dims LD1 through PWM; DAC1 on D24 plays a 50 Hz sine (TIM6 + DMA) into an LED — probe it.",
  icon: CpuIcon,
  firmware: [{ ref: "U1", url: "firmware/nucleo-adc.elf" }],
  build(grid) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // A0 is CN9-1 (pin end at (-1,22)); +3V3 is CN8-7 at (-1,16). The pot sits to the left.
    // Pin 1 is on the rail, so the wiper voltage is 3.3 V × (1 − position).
    const pot = place("potentiometer", -12, 24, { value: "10 kΩ", pos: "0.7", power: "0.25" })
    const gnd1 = place("ground", -8, 28)
    wire(pot, "W", u, "CN9-1", [[-10, 22]])
    wire(pot, "1", u, "CN8-7", [[-14, 25], [-14, 16]])
    wire(pot, "2", gnd1, "GND", [[-7, 25]])
    // D24 (DAC1, CN7-17, pin end at (29,21)) → 1 kΩ → red LED → ground.
    const r = place("resistor", 33, 20, { value: "1 kΩ", power: "0.25" })
    const led = place("led", 39, 20, { value: "red", imax: "20 mA" })
    const gnd2 = place("ground", 45, 22)
    wire(u, "CN7-17", r, "1")
    wire(r, "2", led, "1")
    wire(led, "2", gnd2, "GND", [[46, 21]])
    return doc
  },
}

export const examples: Example[] = [nucleoBlink, nucleoSquare, nucleoPwm, nucleoSerial, nucleoSpi, nucleoI2c, nucleoAdc, lab1Board, lcdDemo, touchDemo, cubeDemo, lab1Stand, powerSupply, batteryLife, systemExam, transistorLogic, lissajous, bridge]
