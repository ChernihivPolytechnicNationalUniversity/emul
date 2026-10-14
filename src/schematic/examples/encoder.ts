import { CpuIcon } from "lucide-react"
import { builder } from "../builder"
import { nucleoApp } from "../projects"

/**
 * Rotary encoder: firmware/hal/Src/encoder.c counts a KY-040 with TIM4 in encoder mode (x4)
 * on D29/D28 (PD12 CLK = TIM4_CH1, PD13 DT = TIM4_CH2), a detent being one full quadrature
 * cycle, and prints "pos N" on the VCP whenever the position changes; pressing the shaft (SW on
 * D42 = PE8, the pad's own pull-up — the module has none fitted) zeroes it. The module's CLK and
 * DT pull-ups run from the board's +3V3, so the pins never see more than 3.3 V.
 */
export const nucleoEncoder = {
  id: "nucleo-encoder",
  name: "Nucleo rotary encoder",
  description: "KY-040 on TIM4 in encoder mode (D29/D28): turn the knob and the VCP prints the position in detents, press it to zero; LD1 toggles on every step.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: nucleoApp("encoder") }],
  build(grid: number) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // VCP pins end at (-2,4) and (-2,6); the terminal is mirrored so its pins face them.
    const term = Object.assign(place("serial-terminal", -12, 3, { baud: "115200" }), { mirror: true })
    wire(u, "VCP-TX", term, "RX")
    wire(u, "VCP-RX", term, "TX")
    // The module, mirrored so its pins face CN10: GND (34,30), + (34,31), SW (34,32),
    // DT (34,33), CLK (34,34). CN10-18 (D42, PE8), CN10-19 (D28, PD13) and CN10-21
    // (D29, PD12) end at x 28 on rows 32, 33 and 34: three straight wires.
    const ky = Object.assign(place("ky-040", 34, 29), { mirror: true })
    wire(u, "CN10-18", ky, "SW")
    wire(u, "CN10-19", ky, "DT")
    wire(u, "CN10-21", ky, "CLK")
    // +3V3 (CN8-7, (0,16)) and GND (CN8-11, (0,18)) from the far side, round the terminal
    // and over the top of the board.
    wire(u, "CN8-7", ky, "VCC", [[-14, 16], [-14, -3], [32, -3], [32, 31]])
    wire(u, "CN8-11", ky, "GND", [[-15, 18], [-15, -4], [33, -4], [33, 30]])
    return doc
  },
}
