/*
 * USART check on the Nucleo-F429ZI: USART3 on PD8 (TX) / PD9 (RX) — the ST-LINK virtual COM
 * port — at 115200 8N1. Prints "tick N" every 100 ms with HAL_UART_Transmit (every tenth line
 * in Ukrainian, UTF-8 as GCC stores string literals, to show bytes above 127 on the wire),
 * receives one byte at a time under interrupt (HAL_UART_Receive_IT) and echoes it back with
 * ASCII letters upper-cased; everything else, multi-byte characters included, unchanged.
 * `rxCount` and `lastRx` are exposed for the test.
 */
#include "main.h"
#include <stdio.h>
#include <string.h>

static void SystemClock_Config(void);
static void Error_Handler(void);

static UART_HandleTypeDef huart3;
volatile uint32_t rxCount, txCount, lastRx, rxErrors;
static uint8_t rxByte;

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOD_CLK_ENABLE();
  __HAL_RCC_USART3_CLK_ENABLE();
  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9;
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF7_USART3;
  HAL_GPIO_Init(GPIOD, &gpio);

  huart3.Instance = USART3;
  huart3.Init.BaudRate = 115200;
  huart3.Init.WordLength = UART_WORDLENGTH_8B;
  huart3.Init.StopBits = UART_STOPBITS_1;
  huart3.Init.Parity = UART_PARITY_NONE;
  huart3.Init.Mode = UART_MODE_TX_RX;
  huart3.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart3.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart3) != HAL_OK) Error_Handler();
  HAL_NVIC_SetPriority(USART3_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(USART3_IRQn);
  HAL_UART_Receive_IT(&huart3, &rxByte, 1);

  char line[40];
  uint32_t n = 0;
  while (1)
  {
    int len = n % 10 == 9 ? snprintf(line, sizeof line, "Крок %lu\r\n", (unsigned long)n++) : snprintf(line, sizeof line, "tick %lu\r\n", (unsigned long)n++);
    if (HAL_UART_Transmit(&huart3, (uint8_t *)line, len, 100) == HAL_OK) txCount += len;
    HAL_Delay(100);
  }
}

void USART3_IRQHandler(void) { HAL_UART_IRQHandler(&huart3); }

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  if (huart->Instance != USART3) return;
  lastRx = rxByte;
  rxCount++;
  uint8_t echo = rxByte >= 'a' && rxByte <= 'z' ? rxByte - 32 : rxByte;
  HAL_UART_Transmit(huart, &echo, 1, 10);
  HAL_UART_Receive_IT(huart, &rxByte, 1);
}

void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  rxErrors++;
  HAL_UART_Receive_IT(huart, &rxByte, 1);
}

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
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK) Error_Handler();
  if (HAL_PWREx_EnableOverDrive() != HAL_OK) Error_Handler();

  RCC_ClkInitStruct.ClockType = (RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2);
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV4;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV2;
  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_5) != HAL_OK) Error_Handler();
}

static void Error_Handler(void)
{
  while (1) __asm volatile("bkpt 0xEE");
}
