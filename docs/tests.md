# Tests

| Command | What it checks |
|---|---|
| `docker build -f backend/worker/Dockerfile -t emul-worker .` then `docker run --rm -v ./firmware:/fw:ro emul-worker node --experimental-strip-types backend/worker/scripts/try-build.ts stm32f746ig /fw/lab1-running-light` | the build service on a project directory, in the image the service ships in: the C++ lab, `/fw/lab1`, and the LCD demos assembled as their loaders send them |
| `pnpm geom-bench` | what a committed edit costs the main thread — connectivity, routing and the derived maps — on the tiled lab-1 stand and, with `boards`, on tiled Open746I-Cs; budgets are scaled by a machine-speed reading taken at startup, because the same machine measured 2.5× apart two hours apart |
| `pnpm field-bench` | drag, pan and zoom in headless Chromium at six document sizes, with per-size thresholds; `boards` runs the same on Open746I-C documents, and `EMUL_URL=http://localhost:4173/` measures a production build instead of the dev server. Needs a server listening |
| `pnpm mcu-test` | core: `firmware/tests/*.c` at -O0/-O2 (Cortex-M4) and -O2 for the Cortex-M7 (double precision, FPv5) vs. host builds |
| `pnpm mcu-blink` | HAL blink on the bare SoC: clocks, SysTick, GPIO, EXTI |
| `pnpm nucleo-fw` | Nucleo blink through the full circuit: LEDs, button, USB power loss, reset |
| `pnpm lab1` | Lab 1 firmware (STM32CubeIDE build for the F746) on the bare core |
| `pnpm lab1-sim` | Lab 1 through the circuit: LED staircase, joystick, reset button, 100 V destruction |
| `pnpm open746` | Lab 1 on the Open746I-C board: LEDs, joystick, WAKEUP, RESET, BOOT to SYSTEM, jumpers opened, a CR2032 on VBAT through a power cut, power from the module's USB, the USART1 USB or the 5 V jack through SW1/S2 |
| `pnpm lab1-running` | Lab 1 as completed for variant 1 on the Open746I-C (`firmware/lab1-running-light`, C++ app over the CubeMX Core): the running light steps LED1→LED4 on joystick C and back on B, A and D set the dwell between 1 and 5 s, the centre stops it — each through EXTI and a 20 ms TIM7 debounce window, at 50 MHz from the 8 MHz crystal |
| `pnpm lcd` | Waveshare's 1024×600 LCD demo on the board with the 7" panel docked: SDRAM init over the FMC, DMA2D clear, BSP text through the LTDC, backlight and panel currents, the picture gone with the USB and back after the reboot; their GT911 test: reset sequence, id over bit-banged I²C printed on USART1, presses drawn as crosshairs at 100 Hz, the release report's zero-length read, a second press; our C++ cube (`firmware/lcd/cube`): textured perspective renderer into double-buffered SDRAM framebuffers, the picture turning |
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
| `pnpm mcu-lp` | a current probe on the supply through Sleep, four Stops (RTC wake-up, EXTI interrupt, EXTI event with WFE, under-drive), Standby by RTC and by the WKUP pin, sleep-on-exit; SysTick frozen in Stop, HSI on wake-up, latencies, SBF/WUF; VDD off with VBAT up: backup domain kept and the RTC an hour on, or cleared without VBAT |
| `pnpm nucleo-lp` | the same firmware on the board: the MCU's VDD element draws the mode's current, the USER button wakes it from Stop, the Standby exit shows as a reset |
| `pnpm mcu-flash` | a boot counter logged into flash across five resets with a sector erase when full (EEPROM emulation), byte/halfword/word programming, a store while locked, option bytes (nRST_STOP makes Stop a reset, hardware IWDG), flash across a power cycle and a reload, wait states with the caches on/off, BOOT0/BOOT1 into system memory and SRAM |
| `pnpm battery` | battery chemistry: an alkaline pair's terminal voltage and time left at 32 mA and at 1 A (Peukert), a 12 V lead-acid block, a CR2032 sagging at 18 mA and its self-discharge life at 3 µA, a Li-ion cell run down through an LED until it is empty, exhausted and then dead, an alkaline force-charged until it vents, a Li-ion overcharged into thermal runaway, a NiMH cell on charge reporting the time to full; the AA pair at −20 °C and 60 °C, diffusion (sag under load, rest after it), a 500 mAh pouch shorted into thermal runaway, an aged 18650, a mismatched 3S pack |
| `pnpm wires` | the wire subsystem: stubs and the 45° grid snap, obstacle avoidance, rounded corners, the net map over wires and touching pins, automatic colour by what is on the net, every colour's flow colour reading against it in both themes, nudging (two nets apart by ⅓ cell, a jog instead of a tilted stub, the ladder capped at half a cell, one net alongside itself left alone), tapping a wire (the junction lands on the wire, a tap from a pin of the same object, from the wire's own end, on its end pin), and the PG2/PG3 stand: two MCU pins tied through a junction to one button, both pulled low, the junction's outgoing current the sum of the incoming |
| `pnpm physics` | bench physics: a coil let go by a switch (strike, arc, decay), a MOSFET switching a relay coil with and without a flyback diode, an electrolytic both ways round, a diode failing short, a button welding, Vce(sat) of a saturated BC547, a rail tripping, an ammeter's fuse, a voltmeter over range, a transformer on mains and on a battery, half a potentiometer burning, 12 V on a Nucleo pin |
| `pnpm meters` | a voltmeter across a resistive divider (its 10 MΩ input barely loads it), an ammeter reading a load current with its shunt's burden voltage, both reading RMS on an AC source |
| `pnpm analyser` | the logic analyser's decoders over the example buses: the serial console's "tick N" and its echo at 115200 (and garbage at the wrong baud), the SPI link's 0xA0+n / 0x50+n in mode 0 with chip-select framing (and shifted in the wrong mode), the I²C EEPROM's page write with acknowledge polling and a repeated-start read, a bit-banged square wave and a pulse source thresholded off an analog net |
| `pnpm chip-clock` | the lab 1 stand on its 8 MHz crystal (HSERDY 2 ms after HSEON), without it (HAL timeout into Error_Handler, the inspector's "No clock"), with an oscillator module the crystal-mode firmware cannot use; a bare F429 on an oscillator module in bypass, with and without the module's VCC; the Nucleo's LSE crystal taking 2 s |
| `pnpm exam`, `pnpm logic`, `pnpm bridge`, `pnpm nucleo` | analog engine scenarios |

