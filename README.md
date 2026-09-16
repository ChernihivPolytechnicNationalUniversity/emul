# εmul

A circuit simulator for microcontroller labs: an analog engine (nodal solver with real
resistors, diodes, transistors, regulators and burn-out ratings) co-simulated with an
STM32 emulator that runs real firmware — the ELF straight out of STM32CubeIDE, unmodified.
The goal is a Proteus replacement that gets the things right Proteus gets wrong: timing,
sleep and wake-up, and the serial peripherals.

```sh
pnpm install
pnpm dev            # http://localhost:5173
```

Firmware is built with the ARM GNU toolchain (`~/tools/arm-gnu-toolchain-14.2…`) and ST's
CMSIS/HAL clones (`~/tools/st`); `make` in `firmware/` and `firmware/hal/`.

## What is modelled — and what is not

The emulator answers reads from a peripheral it does not have with zeros, so firmware that
touches one does not crash; it spins on a ready flag or times out. **The inspector's firmware
panel says which blocks the program touched that are missing**, so it is never a guess.

### MCU core

| | Status |
|---|---|
| ARMv7E-M instruction set (Thumb-2, DSP, FPv4-SP) | done, tested against host builds (`pnpm mcu-test`) |
| FPv5-D16 on the Cortex-M7: double-precision VFP (arithmetic, fused multiply-add, sqrt, compare, conversions between precisions, integers and fixed point), VSEL, VMAXNM/VMINNM, VRINT{A,N,P,M,X,Z,R}, VCVT{A,N,P,M}, half-precision VCVTB/VCVTT | done — the tests are also built for the M7 (`-M7` images run on the F746 profile); an M4 profile faults on them as the real part does |
| Exceptions, NVIC priorities/preemption, SysTick, PendSV/SVC | done |
| WFI/WFE sleep and wake-up (event register, SEVONPEND, SLEEPONEXIT) | done |
| Cortex-M7 profile (CPUID, MVFR, cache registers) | done; caches are no-ops |
| MPU | registers kept, **not enforced** |
| Instruction timing | per-instruction cycle counts plus flash wait states: ACR.LATENCY per new 128-bit (F7: 256-bit) line fetched from flash unless the prefetch buffer (sequential code) or the ART / instruction cache (64 lines, LRU) has it; data reads from flash likewise unless the data cache (DCEN, 8 lines) holds the line. **No** bus contention, pipeline or branch-prediction model (M7 dual-issue not modelled) |
| Debugger UI (step, breakpoints, registers, memory) | **none** — only PC/instruction count in the inspector; breakpoints exist in the core API |

### Chips

`src/mcu/chip.ts` holds the profiles; a new part is a profile plus a package pin table.

| Part | Package component | Board |
|---|---|---|
| STM32F429ZIT6 (Cortex-M4F, 2 MB / 256 KB) | `STM32F429ZI` LQFP144 | Nucleo-144 (NUCLEO-F429ZI) |
| STM32F746IGT6 (Cortex-M7, 1 MB / 320 KB) | `STM32F746IG` LQFP176 | Open746I-C (Waveshare, with the Core746I module) |

### Peripherals

| Block | Status |
|---|---|
| RCC — HSI/HSE/PLL clock tree, bus prescalers, peripheral clock enables; HSE/LSE from what the circuit puts on OSC_IN/OSC_OUT and OSC32_IN/OSC32_OUT | done (`pnpm chip-clock`); a clock switch takes effect from the next instruction; the PLL locks instantly on a running source; HSE/LSE report ready only with a crystal there (HSEON/LSEON, after the crystal's start-up — 2 ms, 2 s for a 32 kHz watch crystal) or, in bypass, an oscillator module's clock on the input pin; nothing there and the HAL times out into its error handler, as on a real board — the inspector says which ("No clock"). A board brings its own (the Nucleo: the ST-LINK's 8 MHz MCO in bypass, an LSE crystal); a core run without a circuit takes either mode at once. **Not modelled:** the clock signal itself (nothing oscillates on the pins or on MCO), CSS, crystal drive level/load capacitors, HSI/LSI trimming and tolerance |
| PWR — voltage scaling, over-drive flags; Sleep, Stop (main/low-power regulator, under-drive) and Standby with SLEEPDEEP/PDDS; wake-up by EXTI interrupt or event (WFI/WFE), RTC alarm/wake-up timer, WKUP pin(s), watchdog; Stop freezes every 1.2 V-domain clock (SysTick, timers, serial, WWDG — the RTC and IWDG run on), switches HSE/PLL off and wakes on HSI after the datasheet's latency; Standby floats the I/Os and ends in a reset with SBF/WUF set and the backup domain kept; F4 (CR/CSR) and F7 (CR1/CSR1/CR2/CSR2, six WKUP pins) maps | done (`pnpm mcu-lp`, `pnpm nucleo-lp`); the inspector shows the mode, the share of time in WFI and a supply-current estimate; the board's supply load follows it. F7 map untested by firmware. **Not modelled:** PVD (EXTI 16), backup SRAM and its regulator (BRE), flash power-down (FPDS — no effect), DBP write protection of the backup domain (writes always go through) |
| FLASH — latency, caches/ART; controller: KEYR unlock, PG with PSIZE (byte/half/word/double), sector and mass erase, EOP/PGSERR/PGPERR/PGAERR/WRPERR and the interrupt; option bytes behind OPTKEYR (RDP, BOR_LEV, WDG_SW, nRST_STOP/STDBY, nWRP, F7 BOOT_ADD0/1) read back at 0x1FFFC000 / 0x1FFF0000 | done (`pnpm mcu-flash`); programming AND-s bits, erase sets 0xFF; the core stalls for the datasheet time (16 µs a word, 0.25–2 s a sector, 8 s mass erase) so BSY always reads clear; flash and option bytes survive resets and power cycles, a firmware load erases both; BOR_LEV sets the board's reset threshold, WDG_SW=0 starts the IWDG at reset, nRST_STOP/STDBY turn the mode into a reset; write protection honoured; **RDP stored, not enforced**; no PCROP, no dual-boot (BFB2), erase cannot be interrupted |
| GPIO A–K — modes, pulls, ODR/BSRR/IDR, alternate-function claim hook | done |
| SYSCFG, EXTI — pin interrupts, software triggers | done |
| DWT CYCCNT, DBGMCU IDCODE | done |
| TIM1–14 — counting modes, update/compare interrupts, PWM with preload and polarity, complementary outputs, input capture, one-pulse | done (`pnpm mcu-tim`, `pnpm nucleo-pwm`); TRGO from CR2.MMS (update, CC1 pulse, OCxREF) feeds the ADC and DAC triggers; **no** encoder mode, slave modes (SMCR), DMA burst (DCR/DMAR), dead-time/break, input filters |
| USART/UART 1–8 — baud (16×/8×), 8/9 bits, parity, stop bits, TX/RX shifters, TXE/TC/RXNE/ORE/FE/PE/IDLE and interrupts; F4 and F7 register maps | done (`pnpm mcu-uart`, `pnpm nucleo-serial`); the F7 map is implemented but only the F4 one is firmware-tested; **no** flow control, synchronous mode, LIN/IrDA/smartcard |
| SPI 1–6 — master/slave, CPOL/CPHA, 8/16 bits (F7: 4–16 with FIFOs and packing), MSB/LSB first, prescaler, NSS soft/hard (SSOE, NSSP), RXONLY, TXE/RXNE/BSY/OVR/MODF and interrupts | done (`pnpm mcu-spi`, `pnpm nucleo-spi`); F7 map untested by firmware; **no** bidirectional single-wire mode, CRC, TI frames (reported in the inspector when turned on) |
| I²S | **missing** |
| I²C 1–4 — master: START/repeated START/STOP, 7-bit address, ACK/NACK, SCL from CCR (F4) or TIMINGR (F7) with the master waiting for SCL to rise (stretching, missing pull-ups), F4 SR1/SR2 sequences with BTF/ADDR stretching, F7 NBYTES/AUTOEND/RELOAD/TC | done (`pnpm mcu-i2c` HAL Mem_Write/Read + acknowledge polling, `pnpm nucleo-i2c` through the field, `pnpm mcu-i2c-v2` F7 map at register level); **no** MCU slave mode, 10-bit addresses, SMBus/PEC, DMA, general call (reported when turned on); pull-up rise times not modelled |
| ADC 1–3 — regular/injected sequences, scan, continuous, discontinuous, software start and timer triggers (EXTSEL/JEXTSEL), sampling times, 6–12 bit, alignment, EOC/EOCS/JEOC/OVR, analog watchdog, interrupts, DMA; samples the pad's net voltage from the solver (one 20 µs step old at most); VREFINT/temperature/VBAT channels | done (`pnpm mcu-adc`, `pnpm nucleo-adc`); **no** multi-ADC modes; the temperature sensor reads a fixed 25 °C |
| DAC 1–2 — DHR12R/L, DHR8, dual registers, software and timer (TRGO) triggers, DMA; the pad sources the voltage through 100 Ω | done (same tests: 50 Hz sine from a table by TIM6 + DMA); **no** noise/triangle generation |
| DMA1/2 — 8 streams each, request channels routed per RM0090 tables 42/43, P→M / M→P / M→M, increments, byte/half/word, circular, half/complete/error flags and interrupts; requests from USART (DMAT/DMAR), SPI (TX/RXDMAEN), TIM (UDE/CCxDE/TDE) | done (`pnpm mcu-dma`: HAL memory copy, UART TX/RX by DMA, TIM3-paced circular stream into GPIO); **no** FIFO/bursts (direct mode only), double buffer, peripheral flow control, PSIZE≠MSIZE packing; I²C and ADC requests wait for those blocks |
| RTC — BCD calendar on LSE/LSI/HSE÷n with the prescalers, init mode behind the WPR keys, RSF, subseconds, alarms A/B with masks, wake-up timer, 20 backup registers, ±1 h, 12/24 h; the backup domain survives system resets | done (`pnpm mcu-wdg`); **no** timestamp/tamper, calibration, alarm output pin |
| IWDG, WWDG — IWDG key sequence, prescaler and reload, reset on timeout; WWDG window, early-wake-up interrupt, reset on T6 clearing or a refresh above the window; RCC CSR reset flags say which one bit | done (`pnpm mcu-wdg`); the inspector shows the reset count and cause; DBGMCU freeze is ignored |
| CAN, USB OTG, Ethernet, SDIO, SAI, LTDC/DMA2D, FMC, QSPI, CRC, RNG | **missing** |
| BOOT0 pin, boot from SRAM/system memory | done: BOOT0 (sampled as reset is released; the bare chips expose the pin) with BOOT1 = PB2 picks flash, system memory or SRAM on the F4 and aliases it at address 0, as does SYSCFG MEMRMP; the F7 boots from BOOT_ADD0/1. **System memory holds a stub** (sleeps forever) instead of ST's UART/USB DFU bootloader — reported in the inspector when booted into |

**Supply current** is a datasheet typical per mode, not a model of what the code does: run and
sleep scale with HCLK (all peripherals clocked), Stop by regulator, Standby with the RTC on. A
core sleeping 97 % of the time between SysTicks reads as the blend, and an ammeter on the
board sees the same number.

Phase 1 of PLAN.md (the MCU side) is complete apart from the long tail of blocks no lab has
needed (CAN, USB, Ethernet…); Phase 2, the components on the field, is under way (2.1 crystals
and clock modules, 2.3 the logic analyser, 2.4 meters done).

**Digital fast path.** The analog engine steps every 20 µs; a 115200-baud bit is 8.7 µs. Serial
bits therefore travel between an MCU pad and a terminal (or another MCU's pad on the same net)
as exact-time edges, not as sampled voltages; the analog side still sees the levels for the
scope and the loads. Likewise a PWM faster than the step is sampled at a random instant of each
step, so loads see the true duty instead of an aliased one.

**Digital parts** (the 24Cxx EEPROM; more to come) sit on the same exact-time path: each net
with a part, a terminal or a second core on it is resolved as a wired-AND of its drivers
(open-drain pulls low or releases, push-pull wins, otherwise the pull-ups decide — read off the
analog circuit, so a bus without pull-ups stays low and the firmware times out, as on the bench).
A core with parts on its nets hands over every edge as it makes it, so an EEPROM ACKs at the
clock edge's own time.

**Two cores on one net** (SPI, or anything bit-banged between boards) run in lockstep: the
core that is behind runs until it catches up, yielding whenever it puts an edge on the shared
net, so a slave answers a clock edge at the edge's own time and the master samples the answer
half a period later. Plain GPIO edges on such nets take the exact path too, so a bit-banged
chip select stays in order with the hardware clock. Costs roughly 1.5× over two independent
cores; only cores that share a net pay it.

### Circuit engine

| | Status |
|---|---|
| R, C, L, potentiometer, diode, zener, LED, NPN/PNP, N/P-MOSFET, transformer | done, with power/current/voltage ratings that burn the part — the way the real part fails: resistors, inductors, LEDs and windings go open; diodes, zeners, transistors and MOSFETs fail **short** (the die melts through), capacitors punch through to a short, and half a potentiometer's track can burn while the other half keeps working. An electrolytic minds its polarity (breaks down past 1.5 V reversed, pin 1 is the anode). BJTs carry a collector resistance (`Rc`, 5 Ω on a BC547) so Vce(sat) reads ~90 mV pin to pin rather than the 40 mV of a bare Ebers–Moll junction. The transformer has both winding resistances and a magnetising inductance: it draws its no-load current on AC, and on DC the primary is just its winding, which burns past 1.3× the nameplate current. **Not modelled:** core saturation, thermal time constants (every part fails on the same 10 ms-at-2× stress rule), secondary breakdown |
| Inductive kick (`pnpm physics`) | done: an open switch is a contact gap, not a vanished element — a coil whose current has nowhere to go drives the gap up to its strike voltage (300 V, a small snap-action contact in air), it arcs over (15 V drop + 20 Ω) and carries the current until the energy is spent, then goes out; the scope sees the strike and anything rated below it breaks — a MOSFET switching a relay without a flyback diode dies of its own Vds rating, with the diode it sees 12.8 V. The strike voltage is per switch (`strike`); a logic driver's internal switch is ideal. **Not modelled:** contact bounce, arc erosion over many operations, the gap's capacitance (the spike rises within one 20 µs step) |
| Ideal regulator element (dropout, current limit) | done — used inside boards |
| DC/AC/pulse sources, ground, labelled supply rail | done; every source has an internal resistance and a current rating; the rail's supply trips (goes dead) past its `Max current` |
| Battery with real chemistry (`pnpm battery`): alkaline, zinc–carbon, Li-ion, LiFePO₄, NiMH, NiCd, lead-acid, lithium coin (CR), Li-SOCl₂; cells in series, capacity, starting charge in %, temperature, cycles, age, cell mismatch | done — open-circuit voltage from the chemistry's discharge curve at the state of charge, which the solver coulomb-counts from the current per cell; internal resistance from the chemistry and capacity (overridable) that climbs towards empty and collapses once the cell is exhausted; Peukert rate loss (an AA at 1 A gives half its nameplate Ah, a CR2032 at 20 mA lasts hours, not days); self-discharge (a coin cell on a sleeping MCU is limited by it). **Temperature:** capacity and resistance follow the ambient (an AA at −20 °C has 40 % of its capacity and 4× the resistance; self-discharge doubles every 10 °C), and the cell warms itself with its losses through a thermal mass and a surface to the air. **Diffusion:** two RC branches behind the ohmic resistance, so the voltage keeps sagging for minutes under load and rests back up after it instead of snapping to open-circuit. **Wear:** capacity fade and resistance growth per cycle and per year (an 18650 after 500 cycles and two years: 76 %, 2.2× R); cycles also accrue live from the charge that flows. **Packs:** a capacity spread between the cells — the same current drains the small cell first, the pack is empty when it is and its strongest cell overcharges first. The inspector shows the charge, open-circuit voltage, present resistance and polarization, cell temperature, the capacity now, the cells' spread, the average load over the last 10 s (a load that has held steady for a second is taken as is, so the figure settles within a second of a switch) and the **time left** at that load (or the time to full on charge). Failure modes: the losses heat the cell to its vent temperature (lithium: thermal runaway at 130 °C, a short; the rest vent open — a 500 mAh pouch shorted through a wire goes in ~20 s); a primary cell force-charged 3 % of its capacity vents; Li-ion/LiFePO₄ overcharged 5–8 % past full go into thermal runaway (short), NiMH/NiCd/lead-acid vent/gas dry (open); rechargeable lithium dragged below its cut-off dies of copper dissolution. **Not modelled:** temperature's effect on the OCV curve and on charge acceptance (cold charging lithium plates it), thermal coupling between cells, self-heating raising the capacity back, lead-acid sulphation, gassing losses on charge, ageing from time at high SOC/temperature, a BMS/balancer or protection circuit (add one as a circuit) |
| Pushbutton, toggle switch, USB cable, logic-state instrument | done; switches have a contact resistance and a contact rating in the inspector (tactile button 50 mA / 100 mΩ, toggle 3 A / 50 mΩ) and **weld** past it — the contacts stay closed; the logic state drives through 25 Ω and burns past its output rating |
| Waveshare Open746I-C board (`pnpm open746`): Core746I with the STM32F746IGT6, 8 MHz/32 kHz crystals and the 8 MB SDRAM; USER LEDs (1 kΩ), five-way joystick, WAKEUP (active high, 10 kΩ divider), RESET; USART1 through the CP2102 as VCP pins with its TX/RX LEDs; power from the USART1 USB or the 5 V jack through S2 and the AMS1117; every peripheral header (SPI1/2, USART3, QUADSPI, I2C1/2, I2S2/3, SDMMC, CAN1/2, SAI, ULPI, ETH, 8-bit FMC, DCMI, the 7" LCD FFC) and the Arduino headers as pins, laid out as on the board | done — the lab 1 firmware runs on it as delivered (`Lab 1: Open746I-C board`); the SDRAM is mapped once the FMC has set it up. **Not modelled:** BOOT0 switch, JTAG/SWD, the USB OTG connector, the 2×40 pin ports P16–P21 (every I/O, use the peripheral headers), the 4.3" LCD header (drawn only), JMP1–JMP6 jumpers (always closed) |
| Serial terminal instrument (8N1, selectable baud, UTF-8 or Windows-1251; the Nucleo exposes its ST-LINK VCP pins) | done; TX and RX burn past 5.5 V (the transceiver's absolute maximum) |
| Oscilloscope on probes (O), pin/wire readouts, current flow animation | done; each column is a bucket of solver steps drawn trough to peak, so a one-step spike still shows at its full height, and a part's death is on the screen: the buckets in flight survive the rebuild a failure causes (`pnpm physics`). Sweep with phosphor fade, repeating trigger and **single shot** (arm, freeze on the next rising edge of the chosen channel, a division of pre-trigger), XY, hold, one vertical scale or one per channel (Split), hover readout with min…max per bucket, a planted cursor for Δt / 1/Δt / ΔV, CSV export, drag the top edge to resize. **Not modelled:** anything faster than the 20 µs step — a 20 kHz PWM is sampled at a random instant of each step and shows as noise, and the fastest timebase (100 µs/div) has 50 columns; the trigger level is the middle of the swing (no level, slope or holdoff controls) and ignores swings under 100 µV; no trace maths, FFT or persistence beyond the sweep |
| LED brightness as the eye sees it (10 ms average, so PWM dims instead of strobing) | done |
| MCU pads as drivers (25 Ω) with pulls (40 kΩ), Schmitt input thresholds, absolute maximum ratings; DAC pads as voltage sources (100 Ω) | done, generated from the chip profile; a pin driven past its absolute maximum blows its protection diode onto the rail and takes the die: the core halts and the chip's supply becomes a short, so whatever fed the pin now feeds that short (a battery on a Nucleo pin burns itself next) |
| Crystal and clock-oscillator module (markers on the OSC pins that the emulated RCC reads: frequency, crystal vs. bypass, start-up time; the module needs VCC) | done (`pnpm chip-clock`); the oscillator module dies past its `Max supply voltage`; **not modelled** as waveforms — a scope on OSC_IN shows nothing — and the crystal cannot be damaged electrically: at DC it is an open circuit, and its drive level would need the waveform |
| Op-amps, comparators, 555 | **missing** |
| Logic ICs (74xx gates, flip-flops, counters, shift registers) | **missing** |
| Displays: 7-segment, HD44780 LCD, graphic LCD/OLED | **missing** |
| Sensors, relays, motors, buzzers, servos | **missing** |
| 24Cxx I²C EEPROM (24C01–24C256: page writes, sequential reads, write-cycle NACK, WP, address straps; contents shown in the inspector) | done; VCC or any pin past 6.5 V (the datasheet's absolute maximum) kills it |
| Other SPI/I²C parts (25Qxx flash, ADC, RTC, SD card) | **missing** |
| Logic analyser on the probes (press L): every probe a digital channel from the exact-time edges, UART/SPI/I²C decoders drawing the bytes over the waveforms, follow or hold-and-pan, wheel-zoom | done (`pnpm analyser`); the decoders are protocol-agnostic (a bit-banged bus reads the same as a peripheral); a net with nothing digital on it is thresholded from the analog solution; **not modelled:** parallel/CAN/1-Wire decoders, trigger conditions, measurements |
| Voltmeter and ammeter meter components (a live readout on the part): voltmeter 10 MΩ across two points, ammeter 0.01 Ω in series, RMS in an AC circuit | done (`pnpm meters`); the voltmeter burns past its `Max voltage` (600 V), the ammeter's `Fuse` (10 A; set it to 200 mA for a DMM's mA range) blows open; **not modelled:** ohm / capacitance / frequency ranges, a multimeter with a mode switch |

## Tests

| Command | What it checks |
|---|---|
| `pnpm mcu-test` | core: `firmware/tests/*.c` at -O0/-O2 (Cortex-M4) and -O2 for the Cortex-M7 (double precision, FPv5) vs. host builds |
| `pnpm mcu-blink` | HAL blink on the bare SoC: clocks, SysTick, GPIO, EXTI |
| `pnpm nucleo-fw` | Nucleo blink through the full circuit: LEDs, button, USB power loss, reset |
| `pnpm lab1` | Lab 1 firmware (STM32CubeIDE build for the F746) on the bare core |
| `pnpm lab1-sim` | Lab 1 through the circuit: LED staircase, joystick, reset button, 100 V destruction |
| `pnpm open746` | Lab 1 on the Open746I-C board: LEDs, joystick, WAKEUP, RESET, USB unplugged, the 5 V jack through S2 |
| `pnpm mcu-tim` | timers on the bare SoC: PWM period/duty, update interrupt, input capture, complementary outputs |
| `pnpm nucleo-pwm` | timers through the circuit: LED brightness follows duty, 20 kHz PWM into an external LED |
| `pnpm mcu-uart` | USART3 on the bare SoC: TX decode at 115200, interrupt RX and echo, framing error |
| `pnpm nucleo-serial` | USART through the VCP pins into the terminal; typing back; baud mismatch reads as garbage |
| `pnpm mcu-spi` | SPI1 master on the bare SoC: SCK rate, MOSI bytes, chip select timing, MISO reply read back |
| `pnpm nucleo-spi` | two Nucleos over SPI1 through the wires: master and slave logs agree, no HAL errors |
| `pnpm mcu-i2c` | I2C1 master on the bare SoC against the 24C02 model: HAL page writes, acknowledge polling, read-back, 100 kHz |
| `pnpm nucleo-i2c` | I²C through the field: pull-ups from a rail, EEPROM contents in the snapshot, counter survives a restart |
| `pnpm mcu-i2c-v2` | the F7 I²C register map at register level: AUTOEND write, repeated-START read, NACK handling |
| `pnpm mcu-dma` | DMA: memory-to-memory, USART3 TX/RX through the HAL's DMA interrupt chain, TIM3-paced circular stream toggling a pin |
| `pnpm mcu-adc` | ADC1 polling with a scripted pad voltage → PWM duty, VREFINT, clipping; DAC1 sine by TIM6 TRGO + DMA |
| `pnpm nucleo-adc` | ADC through the field: potentiometer on A0 dims LD1; DAC sine into an LED load |
| `pnpm mcu-wdg` | three lives: IWDG timeout reset, WWDG early wake-up + timeout reset, RTC calendar/alarm/wake-up on LSE, WWDG window violation; backup registers across resets |
| `pnpm mcu-lp` | a current probe on the supply through Sleep, four Stops (RTC wake-up, EXTI interrupt, EXTI event with WFE, under-drive), Standby by RTC and by the WKUP pin, sleep-on-exit; SysTick frozen in Stop, HSI on wake-up, latencies, SBF/WUF |
| `pnpm nucleo-lp` | the same firmware on the board: the MCU's VDD element draws the mode's current, the USER button wakes it from Stop, the Standby exit shows as a reset |
| `pnpm mcu-flash` | a boot counter logged into flash across five resets with a sector erase when full (EEPROM emulation), byte/halfword/word programming, a store while locked, option bytes (nRST_STOP makes Stop a reset, hardware IWDG), flash across a power cycle and a reload, wait states with the caches on/off, BOOT0/BOOT1 into system memory and SRAM |
| `pnpm battery` | battery chemistry: an alkaline pair's terminal voltage and time left at 32 mA and at 1 A (Peukert), a 12 V lead-acid block, a CR2032 sagging at 18 mA and its self-discharge life at 3 µA, a Li-ion cell run down through an LED until it is empty, exhausted and then dead, an alkaline force-charged until it vents, a Li-ion overcharged into thermal runaway, a NiMH cell on charge reporting the time to full; the AA pair at −20 °C and 60 °C, diffusion (sag under load, rest after it), a 500 mAh pouch shorted into thermal runaway, an aged 18650, a mismatched 3S pack |
| `pnpm physics` | bench physics: a coil let go by a switch (strike, arc, decay), a MOSFET switching a relay coil with and without a flyback diode, an electrolytic both ways round, a diode failing short, a button welding, Vce(sat) of a saturated BC547, a rail tripping, an ammeter's fuse, a voltmeter over range, a transformer on mains and on a battery, half a potentiometer burning, 12 V on a Nucleo pin |
| `pnpm meters` | a voltmeter across a resistive divider (its 10 MΩ input barely loads it), an ammeter reading a load current with its shunt's burden voltage, both reading RMS on an AC source |
| `pnpm analyser` | the logic analyser's decoders over the example buses: the serial console's "tick N" and its echo at 115200 (and garbage at the wrong baud), the SPI link's 0xA0+n / 0x50+n in mode 0 with chip-select framing (and shifted in the wrong mode), the I²C EEPROM's page write with acknowledge polling and a repeated-start read, a bit-banged square wave and a pulse source thresholded off an analog net |
| `pnpm chip-clock` | the lab 1 stand on its 8 MHz crystal (HSERDY 2 ms after HSEON), without it (HAL timeout into Error_Handler, the inspector's "No clock"), with an oscillator module the crystal-mode firmware cannot use; a bare F429 on an oscillator module in bypass, with and without the module's VCC; the Nucleo's LSE crystal taking 2 s |
| `pnpm exam`, `pnpm logic`, `pnpm bridge`, `pnpm nucleo` | analog engine scenarios |

## Layout

- `src/mcu/` — the emulator: `cpu.ts`, `decode.ts`, `scs.ts` (NVIC/SysTick/SCB), `bus.ts`, `periph/*`, `chip.ts` (profiles), `stm32f429.ts` (the SoC class `Stm32`)
- `src/sim/` — analog engine (`engine.ts`), netlist, the co-simulation loop (`loop.ts`) and its worker, digital parts (`digital.ts`)
- `src/schematic/` — component definitions (`components/*`), examples, geometry, `mcu-model.ts`
- `src/components/` — the React UI
- `firmware/` — test firmware and HAL apps (`hal/Src/main.c` blink, `square.c`, `pwm.c`, `uart.c`, `spi.c`, `spi-slave.c`, `i2c.c`, `dma.c`, `adc.c`, `wdg.c`)
- `scripts/` — the test drivers above
