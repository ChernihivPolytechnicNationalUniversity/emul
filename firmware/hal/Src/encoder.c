/*
 * KY-040 rotary encoder on the Nucleo-F429ZI. TIM4 in encoder mode (TI1 and TI2, x4) counts
 * the quadrature on PD12 = D29 (CLK, TIM4_CH1) and PD13 = D28 (DT, TIM4_CH2), both AF2; the
 * module's own 10 kΩ pull-ups hold them high at rest. One KY-040 detent is a full quadrature
 * cycle, four edges, so the position in detents is count / 4 (clockwise = CLK first = up).
 * The push switch on PE8 = D42 has no pull-up on the module: the pin's own pull-up is used,
 * and EXTI8 watches both edges: a falling edge after the line has been quiet for 20 ms is a
 * press and zeroes the counter; the bounce of a press or a release falls inside that window.
 *
 * Whenever the position changes the main loop prints "pos N" on USART3 (PD8/PD9, the
 * ST-LINK virtual COM port, 115200 8N1) and toggles LD1 (PB0).
 *
 *   rawCount   TIM4->CNT as a signed 16-bit count (four per detent)
 *   detents    rawCount / 4
 *   presses    switch presses accepted
 *   errors     HAL errors
 */
#include "main.h"
#include <stdio.h>

static void SystemClock_Config(void);
static void Error_Handler(void);

static TIM_HandleTypeDef htim4;
static UART_HandleTypeDef huart3;
volatile int32_t rawCount, detents;
volatile uint32_t presses, errors;
static uint32_t lastEdge;

void EXTI9_5_IRQHandler(void) { HAL_GPIO_EXTI_IRQHandler(GPIO_PIN_8); }

void HAL_GPIO_EXTI_Callback(uint16_t pin)
{
  if (pin != GPIO_PIN_8) return;
  uint32_t now = HAL_GetTick();
  uint32_t quiet = now - lastEdge;
  lastEdge = now;
  if (quiet < 20 || HAL_GPIO_ReadPin(GPIOE, GPIO_PIN_8) != GPIO_PIN_RESET) return;
  presses++;
  __HAL_TIM_SET_COUNTER(&htim4, 0);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOD_CLK_ENABLE();
  __HAL_RCC_GPIOE_CLK_ENABLE();
  __HAL_RCC_TIM4_CLK_ENABLE();
  __HAL_RCC_USART3_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  /* CLK and DT: the module pulls them up to its + (3.3 V here). */
  gpio.Pin = GPIO_PIN_12 | GPIO_PIN_13;
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  gpio.Alternate = GPIO_AF2_TIM4;
  HAL_GPIO_Init(GPIOD, &gpio);

  /* SW: nothing on the module pulls it up, so the pad does. */
  gpio.Pin = GPIO_PIN_8;
  gpio.Mode = GPIO_MODE_IT_RISING_FALLING;
  gpio.Pull = GPIO_PULLUP;
  gpio.Alternate = 0;
  HAL_GPIO_Init(GPIOE, &gpio);

  /* VCP: USART3 TX/RX. */
  gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9;
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF7_USART3;
  HAL_GPIO_Init(GPIOD, &gpio);

  /* LD1. */
  gpio.Pin = GPIO_PIN_0;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  gpio.Alternate = 0;
  HAL_GPIO_Init(GPIOB, &gpio);

  huart3.Instance = USART3;
  huart3.Init.BaudRate = 115200;
  huart3.Init.WordLength = UART_WORDLENGTH_8B;
  huart3.Init.StopBits = UART_STOPBITS_1;
  huart3.Init.Parity = UART_PARITY_NONE;
  huart3.Init.Mode = UART_MODE_TX_RX;
  huart3.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart3.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart3) != HAL_OK) Error_Handler();

  /* Encoder mode x4: both inputs count both edges; the input filter (fDTS/32, N = 8, about
     3 µs at 90 MHz) drops contact glitches shorter than that. */
  htim4.Instance = TIM4;
  htim4.Init.Prescaler = 0;
  htim4.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim4.Init.Period = 0xFFFF;
  htim4.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim4.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  TIM_Encoder_InitTypeDef enc = {0};
  enc.EncoderMode = TIM_ENCODERMODE_TI12;
  enc.IC1Polarity = TIM_ICPOLARITY_RISING;
  enc.IC1Selection = TIM_ICSELECTION_DIRECTTI;
  enc.IC1Prescaler = TIM_ICPSC_DIV1;
  enc.IC1Filter = 0x0F;
  enc.IC2Polarity = TIM_ICPOLARITY_RISING;
  enc.IC2Selection = TIM_ICSELECTION_DIRECTTI;
  enc.IC2Prescaler = TIM_ICPSC_DIV1;
  enc.IC2Filter = 0x0F;
  if (HAL_TIM_Encoder_Init(&htim4, &enc) != HAL_OK) Error_Handler();
  if (HAL_TIM_Encoder_Start(&htim4, TIM_CHANNEL_ALL) != HAL_OK) Error_Handler();

  HAL_NVIC_SetPriority(EXTI9_5_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(EXTI9_5_IRQn);

  int32_t shown = 0;
  char line[24];
  while (1)
  {
    rawCount = (int16_t)__HAL_TIM_GET_COUNTER(&htim4);
    detents = rawCount / 4;
    if (detents != shown)
    {
      shown = detents;
      int len = snprintf(line, sizeof line, "pos %ld\r\n", (long)shown);
      if (HAL_UART_Transmit(&huart3, (uint8_t *)line, len, 100) != HAL_OK) errors++;
      HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_0);
    }
    HAL_Delay(1);
  }
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
