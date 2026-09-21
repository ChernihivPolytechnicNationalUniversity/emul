<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-dark.svg">
    <img src="docs/assets/logo-light.svg" width="180" alt="εmul">
  </picture>
</p>

<p align="center">
  A circuit simulator for microcontroller labs that runs your real STM32 firmware.<br>
  <a href="https://emul.digituni.org/"><b>emul.digituni.org</b></a>
</p>

<p align="center">
  <a href="https://emul.digituni.org/"><img alt="Live" src="https://img.shields.io/badge/live-emul.digituni.org-7c3aed.svg"></a>
  <a href="LICENSE"><img alt="Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <img alt="STM32 F429 · F746" src="https://img.shields.io/badge/STM32-F429%20%C2%B7%20F746-03234B.svg">
</p>

<a href="https://emul.digituni.org/"><img src="docs/assets/bench.png" alt="An Open746I-C with its 7″ LCD running a C++ cube renderer, three Nucleo-F429ZI boards on I²C, UART and ADC, and analog benches: a mains rectifier, a battery, Lissajous sources"></a>

Drop the `.elf` from STM32CubeIDE onto a board, wire the parts, press Run. The firmware executes on
an emulated Cortex-M4/M7 while a nodal solver works out the bench around it: timers, UART, SPI,
I²C, DMA, ADC/DAC, sleep and wake-up, flash, an SDRAM-backed LTDC panel, all against real parts
with real ratings. Two boards on one net run in lockstep; a shorted output or 12 V on a GPIO does
what it does on the desk. A Monaco editor and a build service compile a project the way CubeIDE would.

```sh
pnpm install && pnpm dev     # http://localhost:5173
pnpm test                    # bench physics, batteries, wires, reflash
```

**Docs:** [what is modelled, and what is not](docs/coverage.md) · [architecture](docs/architecture.md) · [tests](docs/tests.md) · [roadmap](docs/plan.md)

Apache-2.0 · Copyright 2026 Bohdan Nahornyi, Denys Lysenok, Andrii Savenko · [third-party notices](THIRD_PARTY_NOTICES.md)
