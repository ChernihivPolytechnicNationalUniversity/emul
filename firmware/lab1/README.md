# Lab 1: LED staircase

The first lab's STM32CubeIDE project for the STM32F746IGT6 teaching stand (`Core/` only —
the HAL, startup, linker script, `system_stm32f7xx.c` and `syscalls.c` come from the build
service, as they do for every project). L1..L4 on PB6, PB7, PH4, PI8 light up and go out in a
1/2/3/4-second staircase at 50 MHz from the 8 MHz crystal; `pnpm lab1` checks the timing.
