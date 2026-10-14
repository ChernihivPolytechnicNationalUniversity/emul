/**
 * An SG90 micro servo on the Nucleo: firmware/hal/Src/servo.c drives TIM1 CH1 on D6 (PE9) at
 * 50 Hz, 1–2 ms pulses, sweeping the horn −90° → +90° → −90° in 15° steps every 300 ms; hold
 * B1 (USER) to park it at 0°. The servo runs from the board's +5V (CN8-9): 90 mA moving, 4 mA
 * at rest, well inside the ST-LINK USB switch's 500 mA.
 */
import { CpuIcon } from "lucide-react"
import { builder } from "../builder"
import { nucleoApp } from "../projects"

export const nucleoServo = {
  id: "nucleo-servo",
  name: "Nucleo servo SG90",
  description: "TIM1 PWM on D6 at 50 Hz sweeps an SG90 servo −90° → +90° in 15° steps; hold B1 (USER) to park it at 0°.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: nucleoApp("servo") }],
  build(grid: number) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // D6 (CN10-4) ends at (28,25), straight into the servo's SIG at (32,25); its + sits at
    // (32,24) and GND at (32,23). +5V (CN8-9) on the far side ends at (0,17) and comes over
    // the top of the board down x = 30; GND (CN10-22, (28,34)) goes round the servo's right
    // and over its top so neither wire crosses the other.
    const m = place("servo-sg90", 32, 21)
    wire(u, "CN10-4", m, "SIG")
    wire(u, "CN8-9", m, "VCC", [[-2, 17], [-2, -3], [30, -3], [30, 24]])
    wire(u, "CN10-22", m, "GND", [[44, 34], [44, 19], [31, 19], [31, 23]])
    return doc
  },
}
