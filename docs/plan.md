# Plan

Features still to build, roughly in the order labs need them. A feature is done when it has a model,
a firmware or circuit test, and its row in `docs/coverage.md` flipped; then it leaves this list.

- [ ] **SVG export** — next to the PNG one; the field draws its symbols on a canvas, so this needs a vector path of its own.
- [ ] **Logic ICs** — 74HC00/04/08/32/86 gates, 74HC74 flip-flop, 74HC595 shift register, 74HC138 decoder,
  4017 counter, with input thresholds and output drivers.
- [ ] **7-segment indicators** — single digit and 4-digit multiplexed, common anode/cathode.
- [ ] **HD44780 character LCD** — 16×2 / 20×4 in 4- and 8-bit mode, drawn on the field. Parallel bus only.
- [ ] **SSD1306 OLED** — I²C and SPI variants, 128×64 framebuffer drawn on the field.
- [ ] **Keypad / button matrix** — 4×4 matrix.
- [ ] **Op-amp, comparator, 555** — ideal op-amp with rails, LM393-style comparator, NE555 as a macro model.
- [ ] **Relay, buzzer, DC motor, servo** — relay coil + contacts, buzzer as a load with sound indication,
  motor as R+L+back-EMF with an RPM readout, servo decoding 50 Hz PWM to an angle.
- [ ] **Sensors** — potentiometer exists; add LDR/thermistor (parameter-driven resistors), DHT11/22 (one-wire
  protocol), HC-SR04 (trigger/echo timing), DS18B20 (1-Wire).
- [ ] **SPI flash** — 25Qxx.
- [ ] **Open746I-C tech debt** — what the stand still cannot do, in order of how soon a lab will need it:
  - the accessory boards from the box as components: DP83848 Ethernet, USB3300 ULPI, WM8960 audio, Micro SD, OV2640
    camera, W25QXX flash, 10 DOF IMU, SN65HVD230 CAN, Analog Test Board — each with its firmware and a scenario;
  - the 2×40 pin ports P16–P21 as pins (an I/O that is only there cannot be wired today);
  - JMP2 (USART1 ↔ CP2102) and JMP5 (A4/A5 ↔ PB9/PB8) as switches: a switch joins nets only in the analog solver, the
    digital edge path does not cross it, so a serial or I²C line through an open-able jumper needs the netlist to merge
    nets through closed switches first;
  - USB OTG data lines (device/host, MIC2075 VBUS switch on PE2/PE3, VBUS LED); CP2102 CTS/RTS and flow control;
  - the 4.3" LCD with XPT2046 touch on P14; VREF+ jumper (external ADC reference); JTAG/SWD.
- [ ] **MCU long tail** — CAN, USB OTG, Ethernet, SDIO/SDMMC, SAI, QSPI, CRC, RNG, as a lab needs one: register model
  in `src/mcu/periph/`, attached in `Stm32`, clocked from its bus, pins through the GPIO alternate-function hook,
  interrupts through the NVIC; reported by name in the inspector until then.
- [ ] **MPU enforcement** — MemManage faults on region violations, so the CubeMX MPU config is real.
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
