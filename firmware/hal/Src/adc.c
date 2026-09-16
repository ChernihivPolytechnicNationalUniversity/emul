/*
 * ADC and DAC check on the Nucleo-F429ZI:
 *   - ADC1 channel 3 (PA3 = A0) is read every 10 ms by software start and polling; the value
 *     sets the duty of TIM3 channel 3 (PB0 = LD1), so a potentiometer on A0 dims the LED.
 *     VREFINT (channel 17) is read once at start into `vrefint`.
 *   - DAC channel 1 (PA4 = D24) plays a 32-point sine from a table through DMA1 stream 5,
 *     triggered by TIM6 update at 32 × 50 Hz — a 50 Hz sine on the pin with no CPU in the loop.
 */
#include "main.h"
#include <math.h>

static void SystemClock_Config(void);
static void Error_Handler(void);

static ADC_HandleTypeDef hadc1;
static DAC_HandleTypeDef hdac;
static DMA_HandleTypeDef hdmaDac;
static TIM_HandleTypeDef htim3, htim6;
volatile uint32_t adcValue, vrefint, samples, errors;
static uint32_t sine[32];

static uint32_t read_channel(uint32_t channel, uint32_t sampling)
{
  ADC_ChannelConfTypeDef cfg = {0};
  cfg.Channel = channel;
  cfg.Rank = 1;
  cfg.SamplingTime = sampling;
  if (HAL_ADC_ConfigChannel(&hadc1, &cfg) != HAL_OK) errors++;
  if (HAL_ADC_Start(&hadc1) != HAL_OK) errors++;
  if (HAL_ADC_PollForConversion(&hadc1, 10) != HAL_OK) errors++;
  uint32_t v = HAL_ADC_GetValue(&hadc1);
  HAL_ADC_Stop(&hadc1);
  return v;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_ADC1_CLK_ENABLE();
  __HAL_RCC_DAC_CLK_ENABLE();
  __HAL_RCC_DMA1_CLK_ENABLE();
  __HAL_RCC_TIM3_CLK_ENABLE();
  __HAL_RCC_TIM6_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_3 | GPIO_PIN_4; /* A0 in, DAC1 out */
  gpio.Mode = GPIO_MODE_ANALOG;
  gpio.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOA, &gpio);
  gpio.Pin = GPIO_PIN_0; /* LD1 as TIM3_CH3 */
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  gpio.Alternate = GPIO_AF2_TIM3;
  HAL_GPIO_Init(GPIOB, &gpio);

  /* ADC1: 12 bits, single conversion, software start. */
  hadc1.Instance = ADC1;
  hadc1.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
  hadc1.Init.Resolution = ADC_RESOLUTION_12B;
  hadc1.Init.ScanConvMode = DISABLE;
  hadc1.Init.ContinuousConvMode = DISABLE;
  hadc1.Init.DiscontinuousConvMode = DISABLE;
  hadc1.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
  hadc1.Init.ExternalTrigConv = ADC_SOFTWARE_START;
  hadc1.Init.DataAlign = ADC_DATAALIGN_RIGHT;
  hadc1.Init.NbrOfConversion = 1;
  hadc1.Init.DMAContinuousRequests = DISABLE;
  hadc1.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
  if (HAL_ADC_Init(&hadc1) != HAL_OK) Error_Handler();
  vrefint = read_channel(ADC_CHANNEL_VREFINT, ADC_SAMPLETIME_480CYCLES);

  /* TIM3 CH3 PWM at 1 kHz on LD1. */
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 90 - 1;
  htim3.Init.Period = 1000 - 1;
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  if (HAL_TIM_PWM_Init(&htim3) != HAL_OK) Error_Handler();
  TIM_OC_InitTypeDef oc = {0};
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = 0;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  if (HAL_TIM_PWM_ConfigChannel(&htim3, &oc, TIM_CHANNEL_3) != HAL_OK) Error_Handler();
  HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_3);

  /* DAC1 from a sine table, TIM6 TRGO at 1.6 kHz, DMA1 stream 5 channel 7, circular. */
  for (int i = 0; i < 32; i++) sine[i] = (uint32_t)(2047.5 + 2047.5 * sinf(2 * 3.14159265f * i / 32));
  htim6.Instance = TIM6;
  htim6.Init.Prescaler = 90 - 1;   /* 1 MHz */
  htim6.Init.Period = 625 - 1;     /* 1600 Hz */
  htim6.Init.CounterMode = TIM_COUNTERMODE_UP;
  if (HAL_TIM_Base_Init(&htim6) != HAL_OK) Error_Handler();
  TIM_MasterConfigTypeDef master = {0};
  master.MasterOutputTrigger = TIM_TRGO_UPDATE;
  master.MasterSlaveMode = TIM_MASTERSLAVEMODE_DISABLE;
  if (HAL_TIMEx_MasterConfigSynchronization(&htim6, &master) != HAL_OK) Error_Handler();

  hdac.Instance = DAC;
  if (HAL_DAC_Init(&hdac) != HAL_OK) Error_Handler();
  DAC_ChannelConfTypeDef dc = {0};
  dc.DAC_Trigger = DAC_TRIGGER_T6_TRGO;
  dc.DAC_OutputBuffer = DAC_OUTPUTBUFFER_ENABLE;
  if (HAL_DAC_ConfigChannel(&hdac, &dc, DAC_CHANNEL_1) != HAL_OK) Error_Handler();

  hdmaDac.Instance = DMA1_Stream5;
  hdmaDac.Init.Channel = DMA_CHANNEL_7;
  hdmaDac.Init.Direction = DMA_MEMORY_TO_PERIPH;
  hdmaDac.Init.PeriphInc = DMA_PINC_DISABLE;
  hdmaDac.Init.MemInc = DMA_MINC_ENABLE;
  hdmaDac.Init.PeriphDataAlignment = DMA_PDATAALIGN_WORD;
  hdmaDac.Init.MemDataAlignment = DMA_MDATAALIGN_WORD;
  hdmaDac.Init.Mode = DMA_CIRCULAR;
  hdmaDac.Init.Priority = DMA_PRIORITY_HIGH;
  hdmaDac.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
  if (HAL_DMA_Init(&hdmaDac) != HAL_OK) Error_Handler();
  __HAL_LINKDMA(&hdac, DMA_Handle1, hdmaDac);
  HAL_NVIC_SetPriority(DMA1_Stream5_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(DMA1_Stream5_IRQn);
  if (HAL_DAC_Start_DMA(&hdac, DAC_CHANNEL_1, sine, 32, DAC_ALIGN_12B_R) != HAL_OK) errors++;
  HAL_TIM_Base_Start(&htim6);

  while (1)
  {
    adcValue = read_channel(ADC_CHANNEL_3, ADC_SAMPLETIME_56CYCLES);
    samples++;
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_3, (adcValue * 1000) / 4096);
    HAL_Delay(10);
  }
}

void DMA1_Stream5_IRQHandler(void) { HAL_DMA_IRQHandler(&hdmaDac); }
void HAL_DAC_ErrorCallbackCh1(DAC_HandleTypeDef *hdac_) { (void)hdac_; errors++; }

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
