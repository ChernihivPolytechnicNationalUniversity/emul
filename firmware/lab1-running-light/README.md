# Lab 1, variant 1: running light

Lab 1 as completed for variant 1 on the Waveshare Open746I-C, from the `stm32_labs` repository:
the STM32CubeMX project's `Core/` plus the `App/` that drives it (`lab1.cpp` holds `main`). As
for `firmware/lab1`, the HAL, startup, linker script, `system_stm32f7xx.c`, `syscalls.c` and
`sysmem.c` come from the build service.

One LED is lit at a time and steps along USER LED1..LED4. The joystick is read through EXTI on
the release edge (the inputs are pulled up, the buttons pull them low): C runs the light
LED1→LED4, B the other way, A adds a second to the dwell and D takes one off (1…5 s), the centre
stops it. The core runs from the 16 MHz HSI. `firmware/examples/lab1-running-light.elf` is this
project built with STM32CubeIDE's GCC 14.3 at -O2 against the project's own drivers;
`pnpm lab1-running` runs it on the board model and checks every one of those behaviours.
