# Lab 1, variant 1: running light

Lab 1 as completed for variant 1 on the Waveshare Open746I-C, from the `stm32_labs` repository:
the STM32CubeMX project's `Core/` plus the `App/` that drives it (`lab1.cpp` holds `main`). As
for `firmware/lab1`, the HAL, startup, linker script, `system_stm32f7xx.c`, `syscalls.c` and
`sysmem.c` come from the build service.

One LED is lit at a time and steps along USER LED1..LED4. Every edge on a joystick line raises an
EXTI interrupt that restarts TIM7 (50 MHz / 5000 / 200 = 20 ms), and the lines are read only when
the timer runs out, so a position counts when it has held still for 20 ms and a contact that
chatters counts once (the inputs are pulled up, the buttons pull them low). C runs the light
LED1→LED4, B the other way, A adds a second to the dwell and D takes one off (1…5 s), the centre
stops it. The core runs at 50 MHz: HSE 8 MHz / 4 × 50 / 2 through the PLL, with over-drive and one
flash wait state. `firmware/examples/lab1-running-light.elf` is this project built with
STM32CubeIDE's GCC 14.3 at -O2 against the project's own drivers; `pnpm lab1-running` runs it on
the board model and checks every one of those behaviours but the debounce itself: the simulation
holds every press for at least 20 ms (`MIN_PRESS` in `src/sim/loop.ts`) and models no contact
bounce, so there is nothing for the filter to reject.
