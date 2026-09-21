<h1 align="center">εmul</h1>

<p align="center">
  A circuit simulator for microcontroller labs that runs your real STM32 firmware.<br>
  Analog bench + Cortex-M emulator, co-simulated in the browser.
</p>

<p align="center">
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="STM32F4 / F7" src="https://img.shields.io/badge/STM32-F429%20%7C%20F746-03234B.svg">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6.svg">
</p>

---

Drop the `.elf` straight out of STM32CubeIDE onto a board on the bench, wire up the parts, press
run. The firmware executes instruction by instruction on an emulated Cortex-M4/M7 while a nodal
solver works out the voltages and currents around it. Nothing is stubbed: a missing pull-up, a
wrong baud rate, a shorted output or 12 V on a GPIO pin does what it does on the desk.

The goal is a Proteus replacement that gets right what Proteus gets wrong: timing, sleep and
wake-up, and the serial peripherals.

## Highlights

- **Real firmware, unmodified.** ARMv7E-M with DSP and FPv4/FPv5 (double precision on the M7),
  NVIC, SysTick, WFI/WFE, cycle counts with flash wait states. Basic blocks are compiled to
  JavaScript: 50–180 MIPS, so a 50 MHz F746 runs faster than real time.
- **Peripherals that behave.** RCC, PWR (Sleep/Stop/Standby with real wake-up latencies), FLASH
  (programming, erase, option bytes), GPIO, EXTI, TIM1–14, USART1–8, SPI1–6, I²C1–4, DMA1/2,
  ADC1–3, DAC, RTC, IWDG/WWDG, FMC SDRAM, LTDC, DMA2D.
- **A bench with physics.** Resistors, diodes, transistors, regulators, batteries with chemistry,
  crystals, EEPROMs, a 1024×600 touch panel: each with ratings, each able to burn out. Two MCUs on
  one net run in lockstep.
- **Instruments.** Oscilloscope, logic analyser with UART/SPI/I²C decoders, serial terminal,
  voltmeter, ammeter, and an inspector that names every peripheral the firmware touched that is
  not modelled, so a gap is never a guess.
- **Boards.** NUCLEO-F429ZI, and Waveshare's Open746I-C with its 7" touch LCD laid out from the
  dimension drawing: jumpers, BOOT switch, VBAT and every power path as switches on the bench.
- **Code editor in the page.** Monaco with HAL/CMSIS completion; a build service compiles the
  project the way CubeIDE would and flashes the result onto the board.

## Quick start

```sh
pnpm install
pnpm dev            # http://localhost:5173
```

The examples ship with their firmware sources and prebuilt images, so the bench works without a
toolchain. To rebuild firmware you need the [GNU Arm Embedded Toolchain](https://developer.arm.com/downloads/-/arm-gnu-toolchain-downloads)
and ST's HAL/CMSIS (`backend/worker/toolchain/stage-st.sh` fetches them at pinned tags); the
in-page compiler needs the build service (`pnpm api`, `pnpm worker`, Redis and an S3 bucket).

```sh
pnpm test           # analog engine, bench physics, batteries, wires, reflash
pnpm mcu-test       # the core against host builds of firmware/tests
```

Every peripheral and part has a scripted scenario; the full list is in [`docs/tests.md`](docs/tests.md).

## Status

Phase 1, the MCU side, is complete apart from the long tail no lab has asked for (CAN, USB,
Ethernet, SDIO). Phase 2, the parts on the bench, is under way: logic ICs, 7-segment and
character displays, sensors, motors and op-amps are next. A debugger panel is Phase 3.

What is modelled and, line by line, what is **not**: [`docs/coverage.md`](docs/coverage.md).
The roadmap with dates: [`docs/plan.md`](docs/plan.md).

## Documentation

| | |
|---|---|
| [`docs/coverage.md`](docs/coverage.md) | Every core feature, peripheral and part with its status and known limits |
| [`docs/architecture.md`](docs/architecture.md) | Source layout, the build service, the compile pipeline, threading model |
| [`docs/tests.md`](docs/tests.md) | The scripted scenarios and what each one checks |
| [`docs/plan.md`](docs/plan.md) | Roadmap: what is done, dated, and what is next |

## License

Apache License 2.0, see [`LICENSE`](LICENSE). Copyright 2026 Bohdan Nahornyi, Denys Lysenok, Andrii Savenko.
Files carrying an STMicroelectronics header are ST's under BSD-3-Clause; everything third-party is
listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
