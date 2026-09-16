# Plan: closing the gaps

Ordered by what labs need first and by dependencies. Each item is done when it has a model,
a firmware or circuit test in `scripts/`, and its row in README's coverage table flipped.
Ticked items are shipped.

## Phase 1 — MCU peripherals (the emulator side)

Every block: register model in `src/mcu/periph/`, attached in `Stm32`, clocked from the bus
clock it sits on, pins claimed through the GPIO alternate-function hook, interrupts through
the NVIC. Reported by name in the inspector until then.

- [x] **1.1 Timers** (2026-09-16; encoder/slave/DMA left out) — TIM2–5 (GP, 32/16-bit), TIM3/4, TIM9–14, TIM6/7 (basic), TIM1/8 (advanced: outputs, dead-time ignored).
  CR1/CR2/SMCR/DIER/SR/EGR/CCMR1-2/CCER/CNT/PSC/ARR/RCR/CCR1-4/BDTR. Up/down/center counting, update event
  and interrupt, PWM modes 1/2 with preload, output compare toggle, input capture with edge select and
  prescaler, one-pulse mode, encoder mode, master/slave trigger basics. Timer clock ×2 rule on APB.
  Test: HAL PWM on LD1 (duty → LED brightness readout), TIM interrupt blink, input capture of the square firmware.
- [x] **1.2 USART/UART 1–8** (2026-09-16; F7 map untested by firmware) — CR1-3/BRR/SR/DR, oversampling 16/8, TX shift register to the pin at the baud rate,
  RX sampling from the pin with start-bit detection, TXE/TC/RXNE/ORE/IDLE flags and interrupts, 8/9 bits, parity.
  Test: printf firmware over USART3 (the ST-LINK VCP) read by a serial-terminal instrument; two Nucleos TX↔RX.
- [x] **1.3 SPI 1–6** (2026-09-16; no BIDIMODE/CRC/TI/DMA, F7 map untested) — CR1/CR2/SR/DR, master and slave, CPOL/CPHA, 8/16 bit, MSB/LSB first, baud prescaler,
  NSS soft/hard, TXE/RXNE/BSY/OVR, interrupts. SCK/MOSI driven onto pins, MISO/SCK sampled from pins (slave).
  Test: `firmware/hal/Src/spi.c` master on one Nucleo, slave echo on a second, wired on the field. Two cores on a
  shared net run in lockstep (`SimLoop.runLockstep`).
- [x] **1.4 I²C 1–4** (2026-09-16; MCU slave mode, 10-bit, SMBus, DMA left out) — CR1/CR2/OAR1/DR/SR1/SR2/CCR/TRISE (F4) and the F7 register set, master start/stop/ack,
  7-bit addressing, slave mode for external parts, open-drain SDA/SCL with the pull-ups on the field.
  Test: HAL master write/read against an EEPROM component (2.13). Digital parts framework in `src/sim/digital.ts`,
  wired-AND net resolution in the loop.
- [x] **1.5 DMA1/2** (2026-09-16; no FIFO/bursts/double buffer) — streams, channels, memory↔peripheral, circular mode, transfer-complete interrupts;
  requests from USART/SPI/TIM (ADC/I²C when those get DMA). Test: HAL_UART_Transmit_DMA, TIM-paced circular stream (`pnpm mcu-dma`).
  Also: an RCC write now ends the run slice, so a clock switch applies from that instruction (boot timing was off by
  up to a 20k-cycle slice before).
- [x] **1.6 ADC 1–3, DAC** (2026-09-16; no multi-ADC, no DAC wave generation) — ADC samples the analog voltage of the pin's net from the engine (regular sequence,
  single/continuous, EOC interrupt, DMA); DAC drives the pin as a voltage source. Test: potentiometer → ADC → PWM
  (`pnpm mcu-adc`, `pnpm nucleo-adc`, example "Nucleo ADC and DAC"). Timer TRGO (CR2.MMS) added for the triggers.
- [x] **1.7 RTC, IWDG, WWDG** (2026-09-16; no timestamp/tamper/calibration) — RTC calendar/alarm/wake-up on LSE/LSI, IWDG reset on timeout, WWDG window.
  Test: watchdog reset seen as a core restart (`pnpm mcu-wdg`); RTC wake-up from Stop waits for 1.8. System resets keep
  the backup domain; RCC CSR flags carry the cause; the inspector shows reset count and cause.
- [x] **1.8 Low-power modes** (2026-09-16; no PVD, backup SRAM, DBP enforcement) — PWR Stop/Standby (SLEEPDEEP + PDDS/LPDS), wake-up through EXTI/RTC, clock state
  after wake-up. Test: sleep firmware with a scope on the supply current (`pnpm mcu-lp`, `pnpm nucleo-lp`: the MCU's
  supply load in the circuit follows the mode; the inspector shows mode, sleep share and the current estimate).
- [x] **1.9 Boot and flash** (2026-09-16; RDP not enforced, bootloader is a stub) — BOOT0 pin honoured (system memory / SRAM boot), flash programming/erase through the
  FLASH controller so EEPROM-emulation code works, option bytes. Test: `pnpm mcu-flash`.
- [x] **1.10 Core details** (2026-09-16) — FPv5 extra instructions for the M7 profile (and its double-precision unit; tests built
  for the M7 too); flash wait states in the cycle count (ACR latency, prefetch, ART/data caches; `pnpm mcu-flash`).
- [ ] **1.11 Long tail** — CAN, USB OTG, Ethernet, SDIO, SAI, LTDC, FMC, QSPI, CRC, RNG. Only when a lab needs one.

## Phase 2 — Components and instruments (the circuit side)

- [x] **2.1 Crystal / clock source** (2026-09-16; no waveform, no CSS) — crystal component on OSC_IN/OSC_OUT; the emulated HSE
  reports ready only when one is there (or HSEBYP with a clock on OSC_IN), after the start-up time. LSE crystal on PC14/PC15
  likewise (2 s). Boards declare their own sources; the lab 1 stand draws its crystal. Test: `pnpm chip-clock`.
- [x] **2.2 Serial terminal** (2026-09-16) — instrument connected to TX/RX (or to the Nucleo's ST-LINK VCP): shows received
  bytes, sends typed ones, baud setting. Needs 1.2.
- [x] **2.3 Logic analyser** (2026-09-16) — multi-channel digital trace on the oscilloscope's probes (L opens it), drawn from the
  exact-time edges the loop records; UART/SPI/I²C decoders write the bytes over the waveforms, follow-newest or hold-and-pan,
  wheel-zoom. Probed nets join the exact-time path while it is on, so serial edges arrive at their own time. Test: `pnpm analyser`.
- [x] **2.4 Voltmeter / ammeter** (2026-09-16) — voltmeter (10 MΩ across two points) and ammeter (0.01 Ω series shunt),
  each showing its live operating point on the component, RMS in an AC circuit. `ComponentDef.meter` (element/quantity/unit/where);
  `ComponentView` draws it, counter-rotated to stay upright. Test: `pnpm meters`.
- [ ] **2.5 Logic ICs** — 74HC00/04/08/32/86 gates, 74HC74 flip-flop, 74HC595 shift register, 74HC138 decoder,
  4017 counter, with input thresholds and output drivers.
- [ ] **2.6 7-segment indicators** — single digit and 4-digit multiplexed, common anode/cathode.
- [ ] **2.7 HD44780 character LCD** — 16×2 / 20×4 in 4- and 8-bit mode, drawn on the field. Parallel bus only.
- [ ] **2.8 SSD1306 OLED** — I²C and SPI variants, 128×64 framebuffer drawn on the field. Needs 1.3/1.4.
- [ ] **2.9 Op-amp, comparator, 555** — ideal op-amp with rails, LM393-style comparator, NE555 as a macro model.
- [ ] **2.10 Relay, buzzer, DC motor, servo** — relay coil + contacts, buzzer as a load with sound indication,
  motor as R+L+back-EMF with an RPM readout, servo decoding 50 Hz PWM to an angle. Needs 1.1 for PWM.
- [ ] **2.11 Sensors** — potentiometer exists; add LDR/thermistor (parameter-driven resistors), DHT11/22 (one-wire
  protocol), HC-SR04 (trigger/echo timing), DS18B20 (1-Wire).
- [ ] **2.12 Keypad / button matrix** — 4×4 matrix.
- [ ] **2.13 External memories** — [x] 24Cxx I²C EEPROM (2026-09-16), [ ] 25Qxx SPI flash. Needs 1.3/1.4.
- [ ] **2.14 SD card (SPI mode)** — later, if a lab needs it.

## Phase 3 — Debugging and tooling

- [ ] **3.1 Debugger panel** — run/pause/step, breakpoints by address and by source line (DWARF from the ELF),
  registers, call stack, memory view, disassembly with symbols.
- [ ] **3.2 MPU enforcement** — MemManage faults on region violations, so the CubeMX MPU config is real.
- [ ] **3.3 Performance** — the interpreter runs at ~0.3–0.5× real time at 50–180 MHz; a decoded-block cache or
  a JIT-free threaded dispatch to reach ≥ 1×.

## Process

- Every new limitation found goes into README's table the moment it is found.
- Anything detectable at run time (unmodelled block, unclaimed AF pin, unsupported instruction) is reported in
  the inspector, never swallowed.
- `pnpm mcu-test mcu-blink nucleo-fw lab1 lab1-sim mcu-tim nucleo-pwm mcu-uart nucleo-serial mcu-spi nucleo-spi mcu-i2c nucleo-i2c mcu-i2c-v2 mcu-dma mcu-adc nucleo-adc mcu-wdg mcu-lp nucleo-lp mcu-flash chip-clock analyser meters physics exam` stay green after every step.
- Test the bench, not just the palette: a part's readout and rating say nothing about what happens when a switch opens on a coil, a supply is reversed, or an output is shorted. `pnpm physics` holds those scenarios; every new part gets one.
