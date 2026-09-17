/*
 * Core exception handlers, as STM32CubeMX generates them: faults spin so the emulator shows
 * where the program stopped, SysTick drives HAL_Delay. A project with its own
 * stm32f4xx_it.c replaces this file; peripheral IRQ handlers belong in the program.
 */
#include "stm32f4xx_hal.h"
#include "stm32f4xx_it.h"

void NMI_Handler(void)
{
  while (1)
  {
  }
}

void HardFault_Handler(void)
{
  while (1)
  {
  }
}

void MemManage_Handler(void)
{
  while (1)
  {
  }
}

void BusFault_Handler(void)
{
  while (1)
  {
  }
}

void UsageFault_Handler(void)
{
  while (1)
  {
  }
}

void SVC_Handler(void)
{
}

void DebugMon_Handler(void)
{
}

void PendSV_Handler(void)
{
}

void SysTick_Handler(void)
{
  HAL_IncTick();
  HAL_SYSTICK_IRQHandler();
}
