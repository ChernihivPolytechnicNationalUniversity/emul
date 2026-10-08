/*
 * WS2812-type LEDs from the Nucleo-F429ZI, the usual way: TIM1 CH1 PWM on PE9 (D6) at
 * 180 MHz / 234 = 769 kHz (1.3 µs a bit), its compare DMA (DMA2 Stream1 ch6) loading the next
 * bit's pulse width — 63 ticks (0.35 µs) for a 0, 126 (0.7 µs) for a 1 — then the line held
 * low for a millisecond to latch.
 *
 *   pixels[]     the colours sent last, 0x00GGRRBB as they go on the wire
 *   framesSent   frames finished
 *   errors       HAL errors
 *
 * Every 20 ms the pattern moves one step: a red-to-green ramp along the stick with the blue
 * channel counting up.
 */
#include "main.h"

#define LEDS 8
#define BIT0 63
#define BIT1 126

static void SystemClock_Config(void);
static void Error_Handler(void);

static TIM_HandleTypeDef htim1;
static DMA_HandleTypeDef hdma;
/* One leading and one trailing zero slot: the line low before the first bit and after the last. */
static uint16_t slots[1 + 24 * LEDS + 1];
volatile uint32_t pixels[LEDS];
volatile uint32_t framesSent, errors;
static volatile int busy;

void DMA2_Stream1_IRQHandler(void)
{
  HAL_DMA_IRQHandler(&hdma);
}

void HAL_TIM_PWM_PulseFinishedCallback(TIM_HandleTypeDef *h)
{
  if (h->Instance != TIM1) return;
  HAL_TIM_PWM_Stop_DMA(&htim1, TIM_CHANNEL_1);
  busy = 0;
  framesSent++;
}

static void send(void)
{
  uint16_t *s = slots;
  *s++ = 0;
  for (int i = 0; i < LEDS; i++)
    for (int b = 23; b >= 0; b--) *s++ = (pixels[i] >> b) & 1 ? BIT1 : BIT0;
  *s = 0;
  busy = 1;
  if (HAL_TIM_PWM_Start_DMA(&htim1, TIM_CHANNEL_1, (uint32_t *)slots, sizeof slots / sizeof slots[0]) != HAL_OK) {
    errors++;
    busy = 0;
    return;
  }
  uint32_t start = HAL_GetTick();
  while (busy)
    if (HAL_GetTick() - start > 10) {
      errors++;
      HAL_TIM_PWM_Stop_DMA(&htim1, TIM_CHANNEL_1);
      busy = 0;
    }
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOE_CLK_ENABLE();
  __HAL_RCC_TIM1_CLK_ENABLE();
  __HAL_RCC_DMA2_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_9;
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_PULLDOWN;
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF1_TIM1;
  HAL_GPIO_Init(GPIOE, &gpio);

  hdma.Instance = DMA2_Stream1;
  hdma.Init.Channel = DMA_CHANNEL_6;
  hdma.Init.Direction = DMA_MEMORY_TO_PERIPH;
  hdma.Init.PeriphInc = DMA_PINC_DISABLE;
  hdma.Init.MemInc = DMA_MINC_ENABLE;
  hdma.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;
  hdma.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;
  hdma.Init.Mode = DMA_NORMAL;
  hdma.Init.Priority = DMA_PRIORITY_HIGH;
  hdma.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
  if (HAL_DMA_Init(&hdma) != HAL_OK) Error_Handler();
  __HAL_LINKDMA(&htim1, hdma[TIM_DMA_ID_CC1], hdma);
  HAL_NVIC_SetPriority(DMA2_Stream1_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(DMA2_Stream1_IRQn);

  htim1.Instance = TIM1;
  htim1.Init.Prescaler = 0;
  htim1.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim1.Init.Period = 234 - 1;
  htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim1.Init.RepetitionCounter = 0;
  htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim1) != HAL_OK) Error_Handler();
  TIM_OC_InitTypeDef oc = {0};
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = 0;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  oc.OCIdleState = TIM_OCIDLESTATE_RESET;
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_1) != HAL_OK) Error_Handler();

  for (uint32_t step = 0;; step++) {
    for (int i = 0; i < LEDS; i++) {
      uint32_t r = (uint32_t)(i * 32) & 0xff;
      uint32_t g = (uint32_t)(255 - i * 32) & 0xff;
      uint32_t b = (step * 16) & 0xff;
      pixels[i] = g << 16 | r << 8 | b;
    }
    send();
    HAL_Delay(20);
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
