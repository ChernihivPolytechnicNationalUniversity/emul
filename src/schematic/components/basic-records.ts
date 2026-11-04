import { DOCS } from "../datasheets/docs"
import type { NoDatasheet } from "../types"

// The everyday parts are no one product: their values are typed in the inspector, so no datasheet
// sets them. What the model does and leaves out is still the student's to know: it is listed here,
// as the code in basic.ts has it, with the test that holds the model where there is one.

const GENERIC = "A generic part: its value and ratings are set in the inspector, not taken from one product's datasheet."
const IDEAL = "An ideal element of the schematic, not a product: nothing to look up."

export const BASIC_RECORDS: Record<string, NoDatasheet> = {
  resistor: {
    none: GENERIC,
    sources: [DOCS["yageo-cfr"], DOCS["vishay-mbb0207"], DOCS["vishay-nfr25"]],
    modelled: [{ what: "Ohm's law at the set resistance" }, { what: "Power over its rating heats it and burns it open, on the film's thermal time constant", test: "tests/sim/engine-overstress.test.ts" }],
    notModelled: [{ what: "Tolerance and temperature coefficient: the resistance is exact" }, { what: "Lead inductance and stray capacitance" }, { what: "Noise" }],
  },
  potentiometer: {
    none: GENERIC,
    sources: [DOCS["bourns-trimmer-primer"]],
    modelled: [{ what: "Two track halves split at the wiper position" }, { what: "The wiper current limit and the track's power rating" }],
    notModelled: [{ what: "Taper (log/anti-log): the track is linear" }, { what: "Wiper noise and contact resistance" }, { what: "Tolerance of the total resistance" }],
  },
  capacitor: {
    none: GENERIC,
    modelled: [{ what: "Charge and discharge at the set capacitance" }, { what: "Over its voltage rating it fails short" }],
    notModelled: [{ what: "ESR, ESL and leakage" }, { what: "Capacitance change with voltage (DC bias) and temperature" }, { what: "Tolerance" }],
  },
  "capacitor-polarized": {
    none: GENERIC,
    sources: [DOCS["nichicon-uvr"], DOCS["tdk-alu-general"]],
    modelled: [
      { what: "ESR from the Nichicon UVR tan δ table, or as typed", test: "tests/sim/supply-inrush.test.ts" },
      { what: "Reverse voltage past its rating breaks it down short", test: "tests/sim/physics.test.ts" },
      { what: "Over its voltage rating it fails short" },
    ],
    notModelled: [{ what: "Leakage current" }, { what: "ESR change with frequency and temperature" }, { what: "Ageing and drying out" }],
  },
  inductor: {
    none: GENERIC,
    modelled: [{ what: "Current through it at the set inductance, and the kick when it is broken", test: "tests/sim/physics.test.ts" }, { what: "Its current rating" }],
    notModelled: [{ what: "Core saturation: the inductance holds at any current" }, { what: "Winding resistance and core loss" }, { what: "Self-resonance" }],
  },
  diode: {
    none: GENERIC,
    modelled: [
      { what: "Forward drop, current, surge and reverse ratings as set" },
      { what: "Past its rating the junction fails short and conducts both ways", test: "tests/sim/physics.test.ts" },
    ],
    notModelled: [{ what: "Reverse recovery and junction capacitance" }, { what: "Reverse leakage" }, { what: "The forward drop's change with temperature" }],
  },
  zener: {
    none: GENERIC,
    modelled: [{ what: "Breakdown at the set Zener voltage, forward drop 0.7 V" }, { what: "Over its power rating it fails short" }],
    notModelled: [{ what: "Dynamic resistance in breakdown: the knee is sharp" }, { what: "The Zener voltage's temperature coefficient" }, { what: "Tolerance" }],
  },
  led: {
    none: GENERIC,
    sources: [DOCS["vishay-tlhx54"], DOCS["vishay-tlhb5400"], DOCS["osram-ls-q976"], DOCS["osram-lb-q39g"], DOCS["kb-apt1608surck"], DOCS["kb-apt1608qbc-d"]],
    modelled: [
      { what: "Forward voltage by colour, current and reverse ratings" },
      { what: "Brightness as the eye sees it, glowing from a fraction of a milliamp", test: "tests/sim/led-eye.test.ts" },
      { what: "Over its current it burns out" },
    ],
    notModelled: [{ what: "One product's exact curve: the forward voltage is the colour's typical" }, { what: "Wavelength shift with current and temperature" }],
  },
  npn: {
    none: GENERIC,
    modelled: [{ what: "Current gain β, saturation through the collector resistance" }, { what: "Collector current, Vce and power ratings: past them it fails short" }],
    notModelled: [{ what: "Switching times and junction capacitances" }, { what: "β's change with current and temperature" }, { what: "Early effect" }],
  },
  pnp: {
    none: GENERIC,
    modelled: [{ what: "Current gain β, saturation through the collector resistance" }, { what: "Collector current, Vce and power ratings: past them it fails short" }],
    notModelled: [{ what: "Switching times and junction capacitances" }, { what: "β's change with current and temperature" }, { what: "Early effect" }],
  },
  nmos: {
    none: GENERIC,
    sources: [DOCS["vishay-2n7000"]],
    modelled: [
      { what: "Threshold and Rds(on) as set, with the body diode" },
      { what: "Avalanche past its Vds, surviving a pulse up to its EAS", test: "tests/sim/physics.test.ts" },
    ],
    notModelled: [{ what: "Gate charge and switching times" }, { what: "Rds(on)'s rise with temperature" }, { what: "Subthreshold leakage" }],
  },
  pmos: {
    none: GENERIC,
    modelled: [{ what: "Threshold and Rds(on) as set, with the body diode" }, { what: "Avalanche past its Vds, surviving a pulse up to its EAS" }],
    notModelled: [{ what: "Gate charge and switching times" }, { what: "Rds(on)'s rise with temperature" }, { what: "Subthreshold leakage" }],
  },
  pushbutton: {
    none: GENERIC,
    sources: [DOCS["omron-b3f"]],
    modelled: [{ what: "Contact resistance and current rating" }, { what: "Contact bounce: a burst of re-strikes on each press and release", test: "tests/sim/joystick-bounce.test.ts" }],
    notModelled: [{ what: "Arcing and contact wear" }],
  },
  switch: {
    none: GENERIC,
    modelled: [{ what: "Contact resistance and current rating" }, { what: "Contact bounce on each change", test: "tests/sim/joystick-bounce.test.ts" }],
    notModelled: [{ what: "Arcing and contact wear" }],
  },
  battery: {
    none: "A cell is chosen by its chemistry in the inspector: the discharge curves are the chemistry's, not one maker's datasheet.",
    modelled: [
      { what: "The chemistry's discharge curve and an internal resistance that climbs towards empty", test: "tests/sim/battery.test.ts" },
      { what: "Capacity lost at high drain (Peukert) and in the cold", test: "tests/sim/battery.test.ts" },
      { what: "Abuse: venting, thermal runaway when charged wrongly", test: "tests/sim/battery.test.ts" },
    ],
    notModelled: [{ what: "One product's exact capacity and curve" }],
  },
  "dc-source": {
    none: IDEAL,
    modelled: [{ what: "A fixed voltage behind its internal resistance, with a current limit" }],
    notModelled: [{ what: "A bench supply's constant-current mode" }, { what: "Ripple and noise" }],
  },
  "ac-source": {
    none: IDEAL,
    modelled: [{ what: "A sine at the set RMS voltage, frequency, phase and DC offset, behind its internal resistance" }],
    notModelled: [{ what: "Mains distortion and frequency drift" }],
  },
  "pulse-source": {
    none: IDEAL,
    modelled: [{ what: "A square wave between two levels at the set frequency, duty or width and delay" }, { what: "Edges into an MCU input at their exact times", test: "tests/sim/pulse-source-exact.test.ts" }],
    notModelled: [{ what: "Rise and fall times: the edges are instant" }],
  },
  transformer: {
    none: GENERIC,
    modelled: [{ what: "Primary and secondary voltage, winding resistances, magnetising inductance" }, { what: "Overload heats it; DC on the primary burns the winding", test: "tests/sim/physics.test.ts" }],
    notModelled: [{ what: "Core saturation and hysteresis" }, { what: "Leakage inductance and inter-winding capacitance" }],
  },
  ground: { none: IDEAL, modelled: [{ what: "The 0 V reference of the circuit" }], notModelled: [] },
  junction: { none: IDEAL, modelled: [{ what: "Joins the wires drawn to it" }], notModelled: [] },
  supply: {
    none: IDEAL,
    modelled: [{ what: "A rail at the set voltage behind the LM78xx's 15 mΩ output resistance, tripping past its current", test: "tests/sim/supply-inrush.test.ts" }],
    notModelled: [{ what: "Ripple, noise and line regulation" }],
  },
  "logic-state": {
    none: IDEAL,
    modelled: [{ what: "A 0 or 1 level at the set supply voltage, toggled by a click" }],
    notModelled: [{ what: "Contact bounce: the level changes cleanly" }],
  },
  "serial-terminal": {
    none: "A tool of the simulator, the PC end of a USB-serial cable: not a part one buys.",
    modelled: [{ what: "UART 8N1 at the chosen baud rate, both directions" }],
    notModelled: [{ what: "Parity and stop bits other than 8N1" }, { what: "Hardware flow control (RTS/CTS)" }],
  },
  voltmeter: {
    none: "A tool of the simulator, a bench multimeter's voltage range: not one meter's datasheet.",
    modelled: [{ what: "10 MΩ input, DC or RMS reading", test: "tests/sim/meters.test.ts" }, { what: "Past its range the input divider burns" }],
    notModelled: [{ what: "Accuracy, resolution and the meter's own settling" }],
  },
  ammeter: {
    none: "A tool of the simulator, a bench multimeter's current range: not one meter's datasheet.",
    modelled: [{ what: "0.01 Ω burden, DC or RMS reading", test: "tests/sim/meters.test.ts" }, { what: "Its fuse blows past the rated current" }],
    notModelled: [{ what: "Accuracy, resolution and the burden's change by range" }],
  },
}
