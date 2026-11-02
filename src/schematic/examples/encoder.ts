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
    // The VCP pins stand above the board either side of CN1, ending at (18,-1) and (22,-1); the
    // terminal sits up and to the right, clear of the USB cable (x 20, up to y -7), RX at row -8
    // and TX at row -6, so the two wires nest.
    const term = place("serial-terminal", 26, -9, { baud: "115200" })
    wire(u, "VCP-TX", term, "RX", [[18, -8]])
    wire(u, "VCP-RX", term, "TX", [[22, -6]])
    // The module, mirrored so its pins face CN10: GND (34,30), + (34,31), SW (34,32),
    // DT (34,33), CLK (34,34). CN10-18 (D42, PE8), CN10-19 (D28, PD13) and CN10-21
    // (D29, PD12) end at x 29 on rows 32, 33 and 34: three straight wires.
    const ky = Object.assign(place("ky-040", 34, 29), { mirror: true })
    wire(u, "CN10-18", ky, "SW")
    wire(u, "CN10-19", ky, "DT")
    wire(u, "CN10-21", ky, "CLK")
    // +3V3 (CN8-7, (0,20)) and GND (CN8-11, (0,22)) from the far side, over the top of the
    // board above the terminal and the USB cable, nested so they do not cross.
    wire(u, "CN8-7", ky, "VCC", [[-2, 20], [-2, -10], [32, -10], [32, 31]])
    wire(u, "CN8-11", ky, "GND", [[-3, 22], [-3, -11], [33, -11], [33, 30]])
    return doc
  },
}
