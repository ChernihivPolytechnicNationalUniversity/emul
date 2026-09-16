/*
 * Timer check on the Nucleo-F429ZI at 180 MHz (APB1 timers 90 MHz, APB2 timers 180 MHz):
 *
 *   TIM3 CH3  PWM 1 kHz on PB0 (LD1 / D33), duty stepped 10 % → 90 % every 100 ms
 *   TIM2      update interrupt at 200 Hz toggling PB7 (LD2): a 100 Hz square
 *   TIM4 CH1  input capture on PB6 (D26), both edges, measuring the period and high time of
 *             whatever is wired to it; results in `capturePeriodUs` / `captureHighUs`
 *   TIM1 CH1  PWM 20 kHz on PE9 (D6) with the complementary output on PE8 (D42), 30 % duty
 */
#include "main.h"

static void SystemClock_Config(void);
static void Error_Handler(void);

static TIM_HandleTypeDef htim1, htim2, htim3, htim4;
volatile uint32_t tim2Ticks;
volatile uint32_t capturePeriodUs, captureHighUs, captureCount;
volatile uint32_t dutyPercent = 10;

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOE_CLK_ENABLE();
  __HAL_RCC_TIM1_CLK_ENABLE();
  __HAL_RCC_TIM2_CLK_ENABLE();
  __HAL_RCC_TIM3_CLK_ENABLE();
  __HAL_RCC_TIM4_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_HIGH;
  gpio.Pin = GPIO_PIN_0;
  gpio.Alternate = GPIO_AF2_TIM3;
  HAL_GPIO_Init(GPIOB, &gpio);
  gpio.Pin = GPIO_PIN_6;
  gpio.Alternate = GPIO_AF2_TIM4;
  HAL_GPIO_Init(GPIOB, &gpio);
  gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9;
  gpio.Alternate = GPIO_AF1_TIM1;
  HAL_GPIO_Init(GPIOE, &gpio);
  gpio.Pin = GPIO_PIN_7;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  HAL_GPIO_Init(GPIOB, &gpio);

  /* TIM3: 90 MHz / 90 = 1 MHz, ARR 999 → 1 kHz PWM */
  htim3.Instance = TIM3;
  htim3.Init.Prescaler = 90 - 1;
  htim3.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim3.Init.Period = 1000 - 1;
  htim3.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim3.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim3) != HAL_OK) Error_Handler();
  TIM_OC_InitTypeDef oc = {0};
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = 100;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim3, &oc, TIM_CHANNEL_3) != HAL_OK) Error_Handler();
  if (HAL_TIM_PWM_Start(&htim3, TIM_CHANNEL_3) != HAL_OK) Error_Handler();

  /* TIM2: 90 MHz / 9000 = 10 kHz, ARR 49 → 200 Hz update interrupt */
  htim2.Instance = TIM2;
  htim2.Init.Prescaler = 9000 - 1;
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = 50 - 1;
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_Base_Init(&htim2) != HAL_OK) Error_Handler();
  HAL_NVIC_SetPriority(TIM2_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(TIM2_IRQn);
  if (HAL_TIM_Base_Start_IT(&htim2) != HAL_OK) Error_Handler();

  /* TIM4: 90 MHz / 90 = 1 MHz free-running 16-bit, capture both edges on CH1 */
  htim4.Instance = TIM4;
  htim4.Init.Prescaler = 90 - 1;
  htim4.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim4.Init.Period = 0xFFFF;
  htim4.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim4.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_IC_Init(&htim4) != HAL_OK) Error_Handler();
  TIM_IC_InitTypeDef ic = {0};
  ic.ICPolarity = TIM_INPUTCHANNELPOLARITY_BOTHEDGE;
  ic.ICSelection = TIM_ICSELECTION_DIRECTTI;
  ic.ICPrescaler = TIM_ICPSC_DIV1;
  ic.ICFilter = 0;
  if (HAL_TIM_IC_ConfigChannel(&htim4, &ic, TIM_CHANNEL_1) != HAL_OK) Error_Handler();
  HAL_NVIC_SetPriority(TIM4_IRQn, 4, 0);
  HAL_NVIC_EnableIRQ(TIM4_IRQn);
  if (HAL_TIM_IC_Start_IT(&htim4, TIM_CHANNEL_1) != HAL_OK) Error_Handler();

  /* TIM1: 180 MHz / 9000 = 20 kHz, ARR 8999... use PSC 0, ARR 8999 → 20 kHz; 30 % duty, complementary on CH1N */
  htim1.Instance = TIM1;
  htim1.Init.Prescaler = 0;
  htim1.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim1.Init.Period = 9000 - 1;
  htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim1.Init.RepetitionCounter = 0;
  htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_DISABLE;
  if (HAL_TIM_PWM_Init(&htim1) != HAL_OK) Error_Handler();
  oc.Pulse = 2700;
  oc.OCNPolarity = TIM_OCNPOLARITY_HIGH;
  oc.OCIdleState = TIM_OCIDLESTATE_RESET;
  oc.OCNIdleState = TIM_OCNIDLESTATE_RESET;
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_1) != HAL_OK) Error_Handler();
  if (HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1) != HAL_OK) Error_Handler();
  if (HAL_TIMEx_PWMN_Start(&htim1, TIM_CHANNEL_1) != HAL_OK) Error_Handler();

  while (1)
  {
    HAL_Delay(100);
    dutyPercent = dutyPercent >= 90 ? 10 : dutyPercent + 10;
    __HAL_TIM_SET_COMPARE(&htim3, TIM_CHANNEL_3, dutyPercent * 10);
  }
}

void TIM2_IRQHandler(void) { HAL_TIM_IRQHandler(&htim2); }
void TIM4_IRQHandler(void) { HAL_TIM_IRQHandler(&htim4); }

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *htim)
{
  if (htim->Instance == TIM2)
  {
    tim2Ticks++;
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_7);
  }
}

void HAL_TIM_IC_CaptureCallback(TIM_HandleTypeDef *htim)
{
  static uint16_t lastRise, lastFall;
  static int haveRise;
  if (htim->Instance != TIM4 || htim->Channel != HAL_TIM_ACTIVE_CHANNEL_1) return;
  uint16_t now = HAL_TIM_ReadCapturedValue(htim, TIM_CHANNEL_1);
  int level = HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_6) == GPIO_PIN_SET;
  captureCount++;
  if (level)
  {
    if (haveRise) capturePeriodUs = (uint16_t)(now - lastRise);
    lastRise = now;
    haveRise = 1;
  }
  else
  {
    lastFall = now;
    if (haveRise) captureHighUs = (uint16_t)(lastFall - lastRise);
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
