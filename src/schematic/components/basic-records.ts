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
    modelled: [{ what: "Ohm's law at set resistance" }, { what: "Burns open past rated power", test: "tests/sim/engine-overstress.test.ts" }],
    notModelled: [{ what: "No tolerance or tempco" }, { what: "Lead inductance and stray capacitance" }, { what: "Noise" }],
  },
  potentiometer: {
    none: GENERIC,
    sources: [DOCS["bourns-trimmer-primer"]],
    modelled: [{ what: "Track split at the wiper" }, { what: "Wiper current and power limits" }],
    notModelled: [{ what: "Linear track only, no taper" }, { what: "Wiper noise and contact resistance" }, { what: "Tolerance of the total resistance" }],
  },
  capacitor: {
    none: GENERIC,
    modelled: [{ what: "Charges at set capacitance" }, { what: "Fails short past rated voltage" }],
    notModelled: [{ what: "ESR, ESL and leakage" }, { what: "DC-bias and temperature drift" }, { what: "Tolerance" }],
  },
  "capacitor-polarized": {
    none: GENERIC,
    sources: [DOCS["nichicon-uvr"], DOCS["tdk-alu-general"]],
    modelled: [
      { what: "ESR from Nichicon UVR table", test: "tests/sim/supply-inrush.test.ts" },
      { what: "Shorts under excess reverse voltage", test: "tests/sim/physics.test.ts" },
      { what: "Fails short past rated voltage" },
    ],
    notModelled: [{ what: "Leakage current" }, { what: "ESR drift with frequency, temperature" }, { what: "Ageing and drying out" }],
  },
  inductor: {
    none: GENERIC,
    modelled: [{ what: "Current at set inductance", test: "tests/sim/physics.test.ts" }, { what: "Voltage kick when broken", test: "tests/sim/physics.test.ts" }, { what: "Its current rating" }],
    notModelled: [{ what: "No core saturation" }, { what: "Winding resistance and core loss" }, { what: "Self-resonance" }],
  },
  diode: {
    none: GENERIC,
    modelled: [
      { what: "Set forward drop and ratings" },
      { what: "Fails short past its ratings", test: "tests/sim/physics.test.ts" },
    ],
    notModelled: [{ what: "Reverse recovery and junction capacitance" }, { what: "Reverse leakage" }, { what: "Forward-drop temperature drift" }],
  },
  zener: {
    none: GENERIC,
    modelled: [{ what: "Breakdown at set Zener voltage" }, { what: "Forward drop of 0.7 V" }, { what: "Fails short past rated power" }],
    notModelled: [{ what: "Sharp knee, no dynamic resistance" }, { what: "The Zener voltage's temperature coefficient" }, { what: "Tolerance" }],
  },
  led: {
    none: GENERIC,
    sources: [DOCS["vishay-tlhx54"], DOCS["vishay-tlhb5400"], DOCS["osram-ls-q976"], DOCS["osram-lb-q39g"], DOCS["kb-apt1608surck"], DOCS["kb-apt1608qbc-d"]],
    modelled: [
      { what: "Forward voltage set by colour" },
      { what: "Current and reverse ratings" },
      { what: "Perceived brightness from sub-milliamp current", test: "tests/sim/led-eye.test.ts" },
      { what: "Burns out past rated current" },
    ],
    notModelled: [{ what: "Typical forward voltage per colour" }, { what: "Wavelength shift with current, temperature" }],
  },
  npn: {
    none: GENERIC,
    modelled: [{ what: "Current gain β" }, { what: "Saturation through collector resistance" }, { what: "Fails short past its ratings" }],
    notModelled: [{ what: "Switching times and junction capacitances" }, { what: "β drift with current, temperature" }, { what: "Early effect" }],
  },
  pnp: {
    none: GENERIC,
    modelled: [{ what: "Current gain β" }, { what: "Saturation through collector resistance" }, { what: "Fails short past its ratings" }],
    notModelled: [{ what: "Switching times and junction capacitances" }, { what: "β drift with current, temperature" }, { what: "Early effect" }],
  },
  nmos: {
    none: GENERIC,
    sources: [DOCS["vishay-2n7000"]],
    modelled: [
      { what: "Threshold and Rds(on) as set" },
      { what: "With body diode" },
      { what: "Avalanches past its Vds", test: "tests/sim/physics.test.ts" },
      { what: "Survives pulses up to EAS", test: "tests/sim/physics.test.ts" },
    ],
    notModelled: [{ what: "Gate charge and switching times" }, { what: "Rds(on)'s rise with temperature" }, { what: "Subthreshold leakage" }],
  },
  pmos: {
    none: GENERIC,
    modelled: [{ what: "Threshold and Rds(on) as set" }, { what: "With body diode" }, { what: "Avalanches past its Vds" }, { what: "Survives pulses up to EAS" }],
    notModelled: [{ what: "Gate charge and switching times" }, { what: "Rds(on)'s rise with temperature" }, { what: "Subthreshold leakage" }],
  },
  pushbutton: {
    none: GENERIC,
    sources: [DOCS["omron-b3f"]],
    modelled: [{ what: "Contact resistance and current rating" }, { what: "Contact bounce on press, release", test: "tests/sim/joystick-bounce.test.ts" }],
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
      { what: "Chemistry's discharge curve", test: "tests/sim/battery.test.ts" },
      { what: "Internal resistance rises towards empty", test: "tests/sim/battery.test.ts" },
      { what: "Peukert capacity loss", test: "tests/sim/battery.test.ts" },
      { what: "Capacity loss in the cold", test: "tests/sim/battery.test.ts" },
      { what: "Venting or thermal runaway", test: "tests/sim/battery.test.ts" },
    ],
    notModelled: [{ what: "Exact product capacity and curve" }],
  },
  "dc-source": {
    none: IDEAL,
    modelled: [{ what: "Fixed voltage behind internal resistance" }, { what: "With a current limit" }],
    notModelled: [{ what: "A bench supply's constant-current mode" }, { what: "Ripple and noise" }],
  },
  "ac-source": {
    none: IDEAL,
    modelled: [{ what: "Sine with set RMS, frequency" }, { what: "Set phase and DC offset" }, { what: "Behind its internal resistance" }],
    notModelled: [{ what: "Mains distortion and frequency drift" }],
  },
  "pulse-source": {
    none: IDEAL,
    modelled: [{ what: "Square wave between two levels" }, { what: "Set frequency, duty, width, delay" }, { what: "Exact edge times into MCU", test: "tests/sim/pulse-source-exact.test.ts" }],
    notModelled: [{ what: "Instant edges, no rise time" }],
  },
  transformer: {
    none: GENERIC,
    modelled: [{ what: "Primary and secondary voltages" }, { what: "Winding resistances" }, { what: "Magnetising inductance" }, { what: "Overload heats it", test: "tests/sim/physics.test.ts" }, { what: "DC on primary burns winding", test: "tests/sim/physics.test.ts" }],
    notModelled: [{ what: "Core saturation and hysteresis" }, { what: "Leakage inductance and inter-winding capacitance" }],
  },
  ground: { none: IDEAL, modelled: [{ what: "The circuit's 0 V reference" }], notModelled: [] },
  junction: { none: IDEAL, modelled: [{ what: "Joins wires drawn to it" }], notModelled: [] },
  supply: {
    none: IDEAL,
    modelled: [{ what: "Rail at the set voltage", test: "tests/sim/supply-inrush.test.ts" }, { what: "LM78xx's 15 mΩ output resistance", test: "tests/sim/supply-inrush.test.ts" }, { what: "Trips past its current", test: "tests/sim/supply-inrush.test.ts" }],
    notModelled: [{ what: "Ripple, noise and line regulation" }],
  },
  "logic-state": {
    none: IDEAL,
    modelled: [{ what: "Logic level at set supply" }, { what: "Click toggles 0 and 1" }],
    notModelled: [{ what: "No contact bounce" }],
  },
  "serial-terminal": {
    none: "A tool of the simulator, the PC end of a USB-serial cable: not a part one buys.",
    modelled: [{ what: "UART 8N1 at chosen baud" }, { what: "Both directions" }],
    notModelled: [{ what: "Framing other than 8N1" }, { what: "Hardware flow control (RTS/CTS)" }],
  },
  voltmeter: {
    none: "A tool of the simulator, a bench multimeter's voltage range: not one meter's datasheet.",
    modelled: [{ what: "10 MΩ input", test: "tests/sim/meters.test.ts" }, { what: "DC or RMS reading", test: "tests/sim/meters.test.ts" }, { what: "Input divider burns past range" }],
    notModelled: [{ what: "Accuracy and resolution" }, { what: "The meter's own settling" }],
  },
  ammeter: {
    none: "A tool of the simulator, a bench multimeter's current range: not one meter's datasheet.",
    modelled: [{ what: "0.01 Ω burden", test: "tests/sim/meters.test.ts" }, { what: "DC or RMS reading", test: "tests/sim/meters.test.ts" }, { what: "Fuse blows past rated current" }],
    notModelled: [{ what: "Accuracy and resolution" }, { what: "Burden change by range" }],
  },
}
