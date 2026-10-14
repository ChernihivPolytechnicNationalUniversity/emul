# Plan

Features still to build, roughly in the order labs need them. A feature is done when it has a model,
a firmware or circuit test, and its row in `docs/coverage.md` flipped; then it leaves this list.

- [ ] **SVG export** — next to the PNG one; the field draws its symbols on a canvas, so this needs a vector path of its own.
- [ ] **Logic ICs** — 74HC00/04/08/32/86 gates, 74HC74 flip-flop, 74HC138 decoder, 4017 counter, with input
  thresholds and output drivers on the 74HC595's pattern (`src/sim/hc595.ts`: a digital part with VCC-referenced
  thresholds, timing checks and the pins as GPIO elements with a scaled CMOS drive).
- [ ] **Op-amp, comparator** — ideal op-amp with rails, LM393-style comparator; a CMOS 555 (TLC555) beside the NE555.
- [ ] **Relay, DC motor** — relay coil + contacts, motor as R+L+back-EMF with an RPM readout.
- [ ] **Character LCD, the rest** — a 20×4 module (needs its own module sheet for the glass), the A00 font's
  5×10 descenders (E0–FF), the HD44780's bias divider loading V0.
- [ ] **OLED SH1106** — the 1.3" 128 × 64 board sold beside the SSD1306 ones: a 132-column RAM shown from
  column 2, page addressing only, its own command set (Sino Wealth SH1106 sheet).
- [ ] **Sensors** — potentiometer exists; add LDR/thermistor (parameter-driven resistors), DHT11/22 (one-wire
  protocol), HC-SR04 (trigger/echo timing), DS18B20 (1-Wire).
- [ ] **SPI flash** — 25Qxx.
- [ ] **Open746I-C tech debt** — what the stand still cannot do, in order of how soon a lab will need it:
  - the accessory boards from the box as components: DP83848 Ethernet, USB3300 ULPI, WM8960 audio, Micro SD, OV2640
    camera, W25QXX flash, 10 DOF IMU, SN65HVD230 CAN, Analog Test Board — each with its firmware and a scenario;
  - USB OTG data lines (device/host, MIC2025 VBUS switch on PE2/PE3, VBUS LED); CP2102 CTS/RTS and flow control;
  - the 4.3" LCD with XPT2046 touch on P14; JTAG/SWD.
- [ ] **MCU long tail** — CAN, USB OTG, Ethernet, SDIO/SDMMC, SAI, QSPI, CRC, RNG, as a lab needs one: register model
  in `src/mcu/periph/`, attached in `Stm32`, clocked from its bus, pins through the GPIO alternate-function hook,
  interrupts through the NVIC; reported by name in the inspector until then.
- [ ] **SD card (SPI mode)** — later, if a lab needs it.
- [ ] **Cloud projects** — sign-in through digituni SSO, projects on the server and on every device; a teacher hands
  out a lab template, a student submits their project, the teacher opens the submission; owner/editor/viewer rights.
- [ ] **Live sessions, the rest** — room snapshots in S3 rather than Redis alone; `Y.UndoManager` so ⌘Z undoes only
  your own edits; offline edits kept through `y-indexeddb`; per-field merging instead of whole objects; limits on room
  size and connections; the simulation run by one host and watched by the others.

## Process

- Every new limitation found goes into the table in `docs/coverage.md` the moment it is found.
- Anything detectable at run time (unmodelled block, unclaimed AF pin, unsupported instruction) is reported in
  the inspector, never swallowed.
- `pnpm test` stays green after every step.
- Test the bench, not just the palette: a part's readout and rating say nothing about what happens when a switch opens on a coil, a supply is reversed, or an output is shorted. `tests/sim/physics.test.ts` holds those scenarios; every new part gets one.
