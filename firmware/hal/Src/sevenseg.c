/*
 * A four-digit common-cathode display (Kingbright CC56-12EWA) multiplexed from the
 * Nucleo-F429ZI: the seconds since reset as 00.00 … 99.99, the decimal point of digit 2 lit
 * as a separator.
 *
 * Segments a–g and DP are eight GPIOs, each through 220 Ω to the segment line, high = lit:
 *   a PE9 (D6)  b PE11 (D5)  c PF14 (D4)  d PE13 (D3)  e PF15 (D2)  f PG14 (D1)  g PG9 (D0)  DP PE8 (D42)
 * Each digit's common cathode goes to ground through a BC547 whose base takes a GPIO through
 * 1 kΩ, high = digit on:
 *   D1 PA6 (D12)  D2 PA5 (D13)  D3 PB9 (D14)  D4 PB8 (D15)
 * A pin cannot sink the digit itself: a segment draws (3.3 − 1.8 V − ~0.2 V Vce) / 220 Ω
 * ≈ 6 mA, eight of them 48 mA, twice the F429's 25 mA absolute maximum per pin (DS9405
 * Table 12). Through the transistor the base takes (3.3 − 0.7) / 1 kΩ = 2.6 mA, enough to
 * saturate it at 48 mA (forced β ≈ 18, BC547 Ic max 100 mA). Each segment then sees 6 mA
 * peak at 1/4 duty, far inside its 30 mA DC and 160 mA peak ratings.
 *
 * TIM6 interrupts at 1 kHz (90 MHz / 90 / 1000) and lights the next digit: every digit
 * 1 ms in 4, the whole display refreshed at 250 Hz. Before switching, the old digit goes off
 * so its pattern does not ghost on the next. The main loop turns HAL_GetTick() into the
 * seconds and the four patterns the interrupt shows.
 *
 *   shown      the number on the display, 0 … 9999
 *   patterns[] each digit's segments, bit 0 = a … bit 6 = g, bit 7 = DP, digit 1 first
 *   refreshes  whole-display sweeps (every 4th interrupt)
 *   ticks      TIM6 interrupts
 */
#include "main.h"

static void SystemClock_Config(void);
static void Error_Handler(void);

typedef struct { GPIO_TypeDef *port; uint16_t pin; } Pin;

/* a b c d e f g DP */
static const Pin segments[8] = {
  {GPIOE, GPIO_PIN_9}, {GPIOE, GPIO_PIN_11}, {GPIOF, GPIO_PIN_14}, {GPIOE, GPIO_PIN_13},
  {GPIOF, GPIO_PIN_15}, {GPIOG, GPIO_PIN_14}, {GPIOG, GPIO_PIN_9}, {GPIOE, GPIO_PIN_8},
};
/* D1 (left) … D4 (right) */
static const Pin digits[4] = {
  {GPIOA, GPIO_PIN_6}, {GPIOA, GPIO_PIN_5}, {GPIOB, GPIO_PIN_9}, {GPIOB, GPIO_PIN_8},
};
/* 0–9, bit 0 = a … bit 6 = g */
static const uint8_t font[10] = {0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f};
#define DP 0x80

static TIM_HandleTypeDef htim6;
volatile uint32_t shown;
volatile uint8_t patterns[4];
volatile uint32_t refreshes, ticks;
static int current = 3;

void TIM6_DAC_IRQHandler(void)
{
  HAL_TIM_IRQHandler(&htim6);
}

void HAL_TIM_PeriodElapsedCallback(TIM_HandleTypeDef *h)
{
  if (h->Instance != TIM6) return;
  HAL_GPIO_WritePin(digits[current].port, digits[current].pin, GPIO_PIN_RESET);
  current = (current + 1) & 3;
  uint8_t p = patterns[current];
  for (int s = 0; s < 8; s++)
    HAL_GPIO_WritePin(segments[s].port, segments[s].pin, (p >> s) & 1 ? GPIO_PIN_SET : GPIO_PIN_RESET);
  HAL_GPIO_WritePin(digits[current].port, digits[current].pin, GPIO_PIN_SET);
  ticks++;
  if (current == 3) refreshes++;
}

static void output(const Pin *p)
{
  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = p->pin;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_WritePin(p->port, p->pin, GPIO_PIN_RESET);
  HAL_GPIO_Init(p->port, &gpio);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOE_CLK_ENABLE();
  __HAL_RCC_GPIOF_CLK_ENABLE();
  __HAL_RCC_GPIOG_CLK_ENABLE();
  __HAL_RCC_TIM6_CLK_ENABLE();

  for (int i = 0; i < 4; i++) output(&digits[i]);
  for (int i = 0; i < 8; i++) output(&segments[i]);

  /* APB1 at 45 MHz, so the timers on it run at 90 MHz: /90 → 1 MHz, /1000 → 1 kHz. */
  htim6.Instance = TIM6;
  htim6.Init.Prescaler = 90 - 1;
  htim6.Init.CounterMode = TIM_COUNTERMODE_UP;
  htim6.Init.Period = 1000 - 1;
  htim6.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
  if (HAL_TIM_Base_Init(&htim6) != HAL_OK) Error_Handler();
  HAL_NVIC_SetPriority(TIM6_DAC_IRQn, 1, 0);
  HAL_NVIC_EnableIRQ(TIM6_DAC_IRQn);
  if (HAL_TIM_Base_Start_IT(&htim6) != HAL_OK) Error_Handler();

  for (;;) {
    uint32_t n = (HAL_GetTick() / 1000) % 10000;
    uint32_t v = n;
    uint8_t p[4];
    for (int i = 3; i >= 0; i--) {
      p[i] = font[v % 10];
      v /= 10;
    }
    p[1] |= DP;
    for (int i = 0; i < 4; i++) patterns[i] = p[i];
    shown = n;
    HAL_Delay(10);
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
