/*
 * An SG90 micro servo from the Nucleo-F429ZI: TIM1 CH1 PWM on PE9 (D6, AF1) at 50 Hz with 1 µs
 * resolution (180 MHz APB2 timer clock / 180 = 1 MHz, ARR 19999 → 20 ms). The pulse width is
 * 1500 µs at the middle and 500 µs per 90° either way: 1000 µs is −90°, 2000 µs is +90°.
 *
 * The horn sweeps −90° → +90° → −90° in 15° steps, one every 300 ms; the SG90 needs 25 ms for
 * 15° (0.1 s/60°), so it settles well within a step. While the USER button (B1, PC13, active
 * high) is held the horn parks at 0° and the sweep waits; on release it carries on.
 *
 *   targetPulseUs   pulse width in the compare register now (µs)
 *   targetAngle     the angle that pulse asks for (degrees, signed)
 *   step            sweep steps taken so far
 *   parked          1 while B1 is held
 *   errors          HAL errors
 */
#include "main.h"

#define CENTRE_US 1500
#define US_PER_90 500
#define STEP_DEG 15
#define STEP_MS 300

static void SystemClock_Config(void);
static void Error_Handler(void);

static TIM_HandleTypeDef htim1;
volatile uint32_t targetPulseUs = CENTRE_US;
volatile int32_t targetAngle;
volatile uint32_t step;
volatile uint32_t parked;
volatile uint32_t errors;

static uint32_t pulseFor(int32_t angle)
{
  return (uint32_t)(CENTRE_US + angle * US_PER_90 / 90);
}

static void setPulse(uint32_t us)
{
  targetPulseUs = us;
  __HAL_TIM_SET_COMPARE(&htim1, TIM_CHANNEL_1, us);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOE_CLK_ENABLE();
  __HAL_RCC_TIM1_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_9;
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  gpio.Alternate = GPIO_AF1_TIM1;
  HAL_GPIO_Init(GPIOE, &gpio);
  /* B1 has its own 100 kΩ pull-down on the board. */
  gpio.Pin = GPIO_PIN_13;
  gpio.Mode = GPIO_MODE_INPUT;
  gpio.Alternate = 0;
  HAL_GPIO_Init(GPIOC, &gpio);

  htim1.Instance = TIM1;
  htim1.Init.Prescaler = 180 - 1;
  htim1.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim1.Init.Period = 20000 - 1;
  htim1.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim1.Init.RepetitionCounter = 0;
  htim1.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim1) != HAL_OK) Error_Handler();
  TIM_OC_InitTypeDef oc = {0};
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = CENTRE_US;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCNPolarity = TIM_OCNPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  oc.OCIdleState = TIM_OCIDLESTATE_RESET;
  oc.OCNIdleState = TIM_OCNIDLESTATE_RESET;
  if (HAL_TIM_PWM_ConfigChannel(&htim1, &oc, TIM_CHANNEL_1) != HAL_OK) Error_Handler();

  int32_t angle = -90;
  int32_t dir = STEP_DEG;
  targetAngle = angle;
  setPulse(pulseFor(angle));
  if (HAL_TIM_PWM_Start(&htim1, TIM_CHANNEL_1) != HAL_OK) Error_Handler();

  uint32_t last = HAL_GetTick();
  while (1)
  {
    if (HAL_GPIO_ReadPin(GPIOC, GPIO_PIN_13) == GPIO_PIN_SET)
    {
      if (!parked)
      {
        parked = 1;
        targetAngle = 0;
        setPulse(CENTRE_US);
      }
      last = HAL_GetTick();
      continue;
    }
    if (parked)
    {
      parked = 0;
      targetAngle = angle;
      setPulse(pulseFor(angle));
      last = HAL_GetTick();
    }
    if (HAL_GetTick() - last < STEP_MS) continue;
    last += STEP_MS;
    if (angle + dir > 90 || angle + dir < -90) dir = -dir;
    angle += dir;
    step++;
    targetAngle = angle;
    setPulse(pulseFor(angle));
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
  errors++;
  while (1) __asm volatile("bkpt 0xEE");
}
