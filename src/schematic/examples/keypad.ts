/**
 * 4×4 keypad: firmware/hal/Src/keypad.c scans the matrix every 5 ms — rows R1–R4 on D7–D4,
 * driven low one at a time as open-drain outputs, columns C1–C4 on D3–D0 read with the MCU's
 * internal pull-ups — and prints each newly pressed key on the ST-LINK virtual COM port.
 */
import { CpuIcon } from "lucide-react"
import { builder } from "../builder"
import { nucleoApp } from "../projects"

export const nucleoKeypad = {
  id: "nucleo-keypad",
  name: "Nucleo 4×4 keypad",
  description: "Matrix keypad scanned every 5 ms (open-drain rows on D7–D4, pulled-up columns on D3–D0), debounced over two scans; each new key goes to the serial terminal. Hold 1, 2 and 4 to see the diode-less matrix ghost a 5.",
  icon: CpuIcon,
  projects: [{ ref: "U1", load: nucleoApp("keypad") }],
  build(grid: number) {
    const { doc, place, wire } = builder(grid)
    const u = place("nucleo-f429zi", 0, 0)
    // VCP pins sit on the ST-LINK zone's left edge at y 4 (TX) and 6 (RX), stubs 2 cells out.
    const term = place("serial-terminal", -12, 3, { baud: "115200" })
    wire(u, "VCP-TX", term, "RX")
    wire(u, "VCP-RX", term, "TX")
    // CN10's outer row, D7..D0 (CN10-2..16), ends at x 28, y 24..31. The keypad's header
    // R1..R4 C1..C4 points down at x 33..40, y 19: nested L-shaped wires, none crossing.
    const kp = place("keypad-4x4", 32, 8)
    const header = ["R1", "R2", "R3", "R4", "C1", "C2", "C3", "C4"]
    header.forEach((pin, k) => wire(u, `CN10-${2 + 2 * k}`, kp, pin, [[33 + k, 24 + k]]))
    return doc
  },
}
