#include "main.h"

#define TIMER_TICK_HZ 1000000u
#define REST 0

typedef struct
{
  uint16_t hz;
  uint16_t ms;
} Note;

enum
{
  G3 = 196, A3 = 220, B3 = 247, C4 = 262,
  C5 = 523, D5 = 587, E5 = 659, F5 = 698, G5 = 784,
};

static const Note shaveAndAHaircut[] = {
  {C4, 250}, {G3, 125}, {G3, 125}, {A3, 250}, {G3, 250}, {REST, 250}, {B3, 250}, {C4, 250},
};

static const Note odeToJoy[] = {
  {E5, 400}, {E5, 400}, {F5, 400}, {G5, 400}, {G5, 400}, {F5, 400}, {E5, 400}, {D5, 400},
  {C5, 400}, {C5, 400}, {D5, 400}, {E5, 400}, {E5, 600}, {D5, 200}, {D5, 800},
  {E5, 400}, {E5, 400}, {F5, 400}, {G5, 400}, {G5, 400}, {F5, 400}, {E5, 400}, {D5, 400},
  {C5, 400}, {C5, 400}, {D5, 400}, {E5, 400}, {D5, 600}, {C5, 200}, {C5, 800},
};

static TIM_HandleTypeDef htim2;
volatile uint16_t playingHz;

static void SystemClock_Config(void);
static void Error_Handler(void);

static void tone(uint16_t hz)
{
  uint32_t period = TIMER_TICK_HZ / hz;
  __HAL_TIM_SET_AUTORELOAD(&htim2, period - 1);
  __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, period / 2);
  playingHz = hz;
}

static void noTone(void)
{
  __HAL_TIM_SET_COMPARE(&htim2, TIM_CHANNEL_1, 0);
  playingHz = 0;
}

static void play(const Note *notes, uint32_t count)
{
  for (uint32_t i = 0; i < count; i++)
  {
    if (notes[i].hz == REST) noTone();
    else tone(notes[i].hz);
    HAL_Delay(notes[i].ms);
    noTone();
    HAL_Delay(notes[i].ms * 3 / 10);
  }
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_TIM2_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_5;
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  gpio.Alternate = GPIO_AF1_TIM2;
  HAL_GPIO_Init(GPIOA, &gpio);

  htim2.Instance = TIM2;
  htim2.Init.Prescaler = HAL_RCC_GetPCLK1Freq() * 2 / TIMER_TICK_HZ - 1;
  htim2.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim2.Init.Period = TIMER_TICK_HZ / 1000 - 1;
  htim2.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
  htim2.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_PWM_Init(&htim2) != HAL_OK) Error_Handler();
  TIM_OC_InitTypeDef oc = {0};
  oc.OCMode = TIM_OCMODE_PWM1;
  oc.Pulse = 0;
  oc.OCPolarity = TIM_OCPOLARITY_HIGH;
  oc.OCFastMode = TIM_OCFAST_DISABLE;
  if (HAL_TIM_PWM_ConfigChannel(&htim2, &oc, TIM_CHANNEL_1) != HAL_OK) Error_Handler();
  if (HAL_TIM_PWM_Start(&htim2, TIM_CHANNEL_1) != HAL_OK) Error_Handler();

  while (1)
  {
    play(shaveAndAHaircut, sizeof shaveAndAHaircut / sizeof shaveAndAHaircut[0]);
    HAL_Delay(600);
    play(odeToJoy, sizeof odeToJoy / sizeof odeToJoy[0]);
    HAL_Delay(1200);
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
