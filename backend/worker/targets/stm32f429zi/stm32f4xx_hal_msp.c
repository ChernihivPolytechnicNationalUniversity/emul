/*
 * HAL MSP: what HAL_Init sets up before the program's clocks and peripherals. A project with
 * its own stm32f4xx_hal_msp.c (CubeMX writes one) replaces this file.
 */
#include "stm32f4xx_hal.h"

void HAL_MspInit(void)
{
  __HAL_RCC_SYSCFG_CLK_ENABLE();
  __HAL_RCC_PWR_CLK_ENABLE();
}
