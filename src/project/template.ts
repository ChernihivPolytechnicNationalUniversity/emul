import type { SourceFile } from "emul-shared/source"

/**
 * What a board's project starts as: the CubeIDE layout (`Core/Inc`, `Core/Src`) around the
 * repo's own Nucleo-F429ZI HAL blink (`firmware/hal/Src/main.c`), so the first build has
 * something to show on the board's LEDs.
 */
export const template = (): SourceFile[] => [
  { path: "Core/Inc/main.h", content: MAIN_H },
  { path: "Core/Src/main.c", content: MAIN_C },
]

/** The file the editor opens first. */
export const TEMPLATE_MAIN = "Core/Src/main.c"

const MAIN_H = `#ifndef MAIN_H
#define MAIN_H

#include "stm32f4xx_hal.h"

#endif /* MAIN_H */
`

const MAIN_C = `/*
 * Nucleo-F429ZI blink on the ST HAL, exactly as STM32CubeIDE would generate it:
 * 180 MHz from HSE bypass through the PLL with over-drive, SysTick at 1 kHz.
 *
 *   LD1 (PB0, green)  toggles every 500 ms from the main loop (HAL_Delay)
 *   LD2 (PB7, blue)   toggles every 100 ms from the SysTick callback
 *   LD3 (PB14, red)   toggles on each press of the USER button (PC13, EXTI15_10)
 *
 * PA5 (D13) mirrors LD1 so the header LED example lights up too.
 */
#include "main.h"

static void SystemClock_Config(void);
static void Error_Handler(void);
static void GPIO_Init(void);

volatile uint32_t button_presses;

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  GPIO_Init();

  while (1)
  {
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_0);
    HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_5);
    HAL_Delay(500);
  }
}

static void GPIO_Init(void)
{
  GPIO_InitTypeDef gpio = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();

  gpio.Pin = GPIO_PIN_0 | GPIO_PIN_7 | GPIO_PIN_14;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &gpio);

  gpio.Pin = GPIO_PIN_5;
  HAL_GPIO_Init(GPIOA, &gpio);

  gpio.Pin = GPIO_PIN_13;
  gpio.Mode = GPIO_MODE_IT_RISING;
  gpio.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOC, &gpio);
  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 2, 0);
  HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);
}

void HAL_SYSTICK_Callback(void)
{
  static uint32_t n;
  if (++n >= 100)
  {
    n = 0;
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_7);
  }
}

void EXTI15_10_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(GPIO_PIN_13);
}

void HAL_GPIO_EXTI_Callback(uint16_t pin)
{
  if (pin == GPIO_PIN_13)
  {
    button_presses++;
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_14);
  }
}

/* The template's 180 MHz configuration for this board. */
static void SystemClock_Config(void)
{
  RCC_ClkInitTypeDef RCC_ClkInitStruct;
  RCC_OscInitTypeDef RCC_OscInitStruct;

  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);

  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE;
  RCC_OscInitStruct.HSEState = RCC_HSE_BYPASS;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;
  RCC_OscInitStruct.PLL.PLLM = 8;
  RCC_OscInitStruct.PLL.PLLN = 360;
  RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV2;
  RCC_OscInitStruct.PLL.PLLQ = 7;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  if (HAL_PWREx_EnableOverDrive() != HAL_OK)
  {
    Error_Handler();
  }

  RCC_ClkInitStruct.ClockType = (RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2);
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV4;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV2;
  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_5) != HAL_OK)
  {
    Error_Handler();
  }
}

static void Error_Handler(void)
{
  while (1)
  {
    __asm volatile("bkpt 0xEE");
  }
}
`
