/*
 * DMA check on the Nucleo-F429ZI:
 *   1. memory-to-memory: DMA2 stream 0 copies a 256-byte table, polled (m2mOk = 1 on match);
 *   2. USART3 transmit by DMA (DMA1 stream 3, channel 4): a 40-byte line every 100 ms through
 *      HAL_UART_Transmit_DMA, txDone counts HAL_UART_TxCpltCallback;
 *   3. USART3 receive by DMA (DMA1 stream 1, channel 4): 8-byte frames into rxBuf, rxDone
 *      counts them, the last frame is echoed back;
 *   4. a timer-paced circular stream: TIM3 update (DMA1 stream 2, channel 5) writes a two-word
 *      table into GPIOB->BSRR, so LD2 (PB7) toggles at 100 Hz with no CPU in the loop.
 */
#include "main.h"
#include <string.h>
#include <stdio.h>

static void SystemClock_Config(void);
static void Error_Handler(void);

static UART_HandleTypeDef huart3;
static DMA_HandleTypeDef hdmaTx, hdmaRx, hdmaM2m, hdmaTim;
static TIM_HandleTypeDef htim3;

volatile uint32_t m2mOk, txDone, rxDone, errors;
volatile uint8_t rxBuf[8];
static uint8_t src[256], dst[256];
static char line[40];
/* BSRR words: set PB7, then reset PB7. */
static const uint32_t blink[2] = { GPIO_PIN_7, (uint32_t)GPIO_PIN_7 << 16 };

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOD_CLK_ENABLE();
  __HAL_RCC_USART3_CLK_ENABLE();
  __HAL_RCC_DMA1_CLK_ENABLE();
  __HAL_RCC_DMA2_CLK_ENABLE();
  __HAL_RCC_TIM3_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9;
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF7_USART3;
  HAL_GPIO_Init(GPIOD, &gpio);
  gpio.Pin = GPIO_PIN_0 | GPIO_PIN_7 | GPIO_PIN_14;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Alternate = 0;
  HAL_GPIO_Init(GPIOB, &gpio);

  /* 1. Memory to memory. */
  for (int i = 0; i < 256; i++) src[i] = (uint8_t)(i * 7 + 3);
  hdmaM2m.Instance = DMA2_Stream0;
  hdmaM2m.Init.Channel = DMA_CHANNEL_0;
  hdmaM2m.Init.Direction = DMA_MEMORY_TO_MEMORY;
  hdmaM2m.Init.PeriphInc = DMA_PINC_ENABLE;
  hdmaM2m.Init.MemInc = DMA_MINC_ENABLE;
  hdmaM2m.Init.PeriphDataAlignment = DMA_PDATAALIGN_WORD;
  hdmaM2m.Init.MemDataAlignment = DMA_MDATAALIGN_WORD;
  hdmaM2m.Init.Mode = DMA_NORMAL;
  hdmaM2m.Init.Priority = DMA_PRIORITY_HIGH;
  hdmaM2m.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
  if (HAL_DMA_Init(&hdmaM2m) != HAL_OK) Error_Handler();
  if (HAL_DMA_Start(&hdmaM2m, (uint32_t)src, (uint32_t)dst, 64) != HAL_OK) errors++;
  if (HAL_DMA_PollForTransfer(&hdmaM2m, HAL_DMA_FULL_TRANSFER, 100) != HAL_OK) errors++;
  m2mOk = memcmp(src, dst, 256) == 0;
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, m2mOk ? GPIO_PIN_SET : GPIO_PIN_RESET);

  /* 2./3. USART3 with DMA both ways. */
  huart3.Instance = USART3;
  huart3.Init.BaudRate = 115200;
  huart3.Init.WordLength = UART_WORDLENGTH_8B;
  huart3.Init.StopBits = UART_STOPBITS_1;
  huart3.Init.Parity = UART_PARITY_NONE;
  huart3.Init.Mode = UART_MODE_TX_RX;
  huart3.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart3.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart3) != HAL_OK) Error_Handler();

  hdmaTx.Instance = DMA1_Stream3;
  hdmaTx.Init.Channel = DMA_CHANNEL_4;
  hdmaTx.Init.Direction = DMA_MEMORY_TO_PERIPH;
  hdmaTx.Init.PeriphInc = DMA_PINC_DISABLE;
  hdmaTx.Init.MemInc = DMA_MINC_ENABLE;
  hdmaTx.Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;
  hdmaTx.Init.MemDataAlignment = DMA_MDATAALIGN_BYTE;
  hdmaTx.Init.Mode = DMA_NORMAL;
  hdmaTx.Init.Priority = DMA_PRIORITY_LOW;
  hdmaTx.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
  if (HAL_DMA_Init(&hdmaTx) != HAL_OK) Error_Handler();
  __HAL_LINKDMA(&huart3, hdmatx, hdmaTx);

  hdmaRx = hdmaTx;
  hdmaRx.Instance = DMA1_Stream1;
  hdmaRx.Init.Direction = DMA_PERIPH_TO_MEMORY;
  if (HAL_DMA_Init(&hdmaRx) != HAL_OK) Error_Handler();
  __HAL_LINKDMA(&huart3, hdmarx, hdmaRx);

  HAL_NVIC_SetPriority(DMA1_Stream3_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(DMA1_Stream3_IRQn);
  HAL_NVIC_SetPriority(DMA1_Stream1_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(DMA1_Stream1_IRQn);
  HAL_NVIC_SetPriority(USART3_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(USART3_IRQn);
  HAL_UART_Receive_DMA(&huart3, (uint8_t *)rxBuf, sizeof rxBuf);

  /* 4. TIM3 update → DMA → GPIOB BSRR, circular. */
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 900 - 1;      /* 90 MHz / 900 = 100 kHz */
  htim3.Init.Period = 1000 - 1;        /* 100 Hz update */
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  if (HAL_TIM_Base_Init(&htim3) != HAL_OK) Error_Handler();
  hdmaTim.Instance = DMA1_Stream2;
  hdmaTim.Init.Channel = DMA_CHANNEL_5;
  hdmaTim.Init.Direction = DMA_MEMORY_TO_PERIPH;
  hdmaTim.Init.PeriphInc = DMA_PINC_DISABLE;
  hdmaTim.Init.MemInc = DMA_MINC_ENABLE;
  hdmaTim.Init.PeriphDataAlignment = DMA_PDATAALIGN_WORD;
  hdmaTim.Init.MemDataAlignment = DMA_MDATAALIGN_WORD;
  hdmaTim.Init.Mode = DMA_CIRCULAR;
  hdmaTim.Init.Priority = DMA_PRIORITY_MEDIUM;
  hdmaTim.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
  if (HAL_DMA_Init(&hdmaTim) != HAL_OK) Error_Handler();
  if (HAL_DMA_Start(&hdmaTim, (uint32_t)blink, (uint32_t)&GPIOB->BSRR, 2) != HAL_OK) errors++;
  __HAL_TIM_ENABLE_DMA(&htim3, TIM_DMA_UPDATE);
  HAL_TIM_Base_Start(&htim3);

  uint32_t n = 0;
  while (1)
  {
    int len = snprintf(line, sizeof line, "dma line %lu abcdefghijklmnopqrstuvwxy\r\n", (unsigned long)n++);
    if (HAL_UART_Transmit_DMA(&huart3, (uint8_t *)line, len) != HAL_OK) errors++;
    HAL_Delay(100);
    if (errors) HAL_GPIO_WritePin(GPIOB, GPIO_PIN_14, GPIO_PIN_SET);
  }
}

void USART3_IRQHandler(void) { HAL_UART_IRQHandler(&huart3); }
void DMA1_Stream3_IRQHandler(void) { HAL_DMA_IRQHandler(&hdmaTx); }
void DMA1_Stream1_IRQHandler(void) { HAL_DMA_IRQHandler(&hdmaRx); }

void HAL_UART_TxCpltCallback(UART_HandleTypeDef *huart) { (void)huart; txDone++; }

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  rxDone++;
  /* Echo the frame back (queued behind any line in flight) and re-arm. */
  static uint8_t echo[8];
  memcpy(echo, (const void *)rxBuf, 8);
  HAL_UART_Receive_DMA(huart, (uint8_t *)rxBuf, sizeof rxBuf);
  while (huart->gState != HAL_UART_STATE_READY) {}
  HAL_UART_Transmit_DMA(huart, echo, 8);
}

void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart) { (void)huart; errors++; }

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
