/*
 * STM32F4-Discovery tilt: the on-board accelerometer on SPI1 (PA5/PA6/PA7, CS PE3), told apart by
 * WHO_AM_I: 0x3B is the LIS302DL (MB997 A/B), 0x3F the LIS3DSH (C–E). 168 MHz from the 8 MHz crystal.
 *
 *   tilt towards +X lights LD5 (red, PD14), towards −X LD4 (green, PD12),
 *   towards +Y LD3 (orange, PD13), towards −Y LD6 (blue, PD15); level, all four dark.
 *   The readings, in mg, are in accel_mg[]; the chip's id in who_am_i.
 */
#include "main.h"
#include <stdlib.h>

void Error_Handler(void);
static void SystemClock_Config(void);
static void GPIO_Init(void);
static void SPI1_Init(void);

SPI_HandleTypeDef hspi1;
volatile uint8_t who_am_i;
volatile int32_t accel_mg[3];

#define THRESHOLD_MG 200

static uint8_t xfer(uint8_t b)
{
  uint8_t r;
  HAL_SPI_TransmitReceive(&hspi1, &b, &r, 1, 10);
  return r;
}

static void write_reg(uint8_t reg, uint8_t value)
{
  HAL_GPIO_WritePin(GPIOE, GPIO_PIN_3, GPIO_PIN_RESET);
  xfer(reg);
  xfer(value);
  HAL_GPIO_WritePin(GPIOE, GPIO_PIN_3, GPIO_PIN_SET);
}

static uint8_t read_reg(uint8_t reg)
{
  HAL_GPIO_WritePin(GPIOE, GPIO_PIN_3, GPIO_PIN_RESET);
  xfer(0x80 | reg);
  uint8_t v = xfer(0);
  HAL_GPIO_WritePin(GPIOE, GPIO_PIN_3, GPIO_PIN_SET);
  return v;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  GPIO_Init();
  SPI1_Init();

  who_am_i = read_reg(0x0F);
  if (who_am_i == 0x3B)
    write_reg(0x20, 0x47);  // LIS302DL CTRL_REG1: 100 Hz, active, X/Y/Z on, ±2.3 g
  else if (who_am_i == 0x3F)
    write_reg(0x20, 0x67);  // LIS3DSH CTRL_REG4: 100 Hz, X/Y/Z on; CTRL_REG5 left at ±2 g
  else
    Error_Handler();

  while (1)
  {
    if (who_am_i == 0x3B)
    {
      // OUT_X/Y/Z at 0x29/0x2B/0x2D, 8-bit, 18 mg/digit.
      accel_mg[0] = (int8_t)read_reg(0x29) * 18;
      accel_mg[1] = (int8_t)read_reg(0x2B) * 18;
      accel_mg[2] = (int8_t)read_reg(0x2D) * 18;
    }
    else
    {
      // OUT_X/Y/Z_L/H at 0x28–0x2D, 16-bit, 0.06 mg/digit at ±2 g.
      for (int i = 0; i < 3; i++)
      {
        int16_t raw = (int16_t)(read_reg(0x28 + 2 * i) | (read_reg(0x29 + 2 * i) << 8));
        accel_mg[i] = raw * 6 / 100;
      }
    }
    int32_t x = accel_mg[0], y = accel_mg[1];
    HAL_GPIO_WritePin(GPIOD, GPIO_PIN_12 | GPIO_PIN_13 | GPIO_PIN_14 | GPIO_PIN_15, GPIO_PIN_RESET);
    if (abs(x) >= abs(y) && abs(x) > THRESHOLD_MG) HAL_GPIO_WritePin(GPIOD, x > 0 ? GPIO_PIN_14 : GPIO_PIN_12, GPIO_PIN_SET);
    else if (abs(y) > THRESHOLD_MG) HAL_GPIO_WritePin(GPIOD, y > 0 ? GPIO_PIN_13 : GPIO_PIN_15, GPIO_PIN_SET);
    HAL_Delay(20);
  }
}

static void GPIO_Init(void)
{
  GPIO_InitTypeDef gpio = {0};
  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOD_CLK_ENABLE();
  __HAL_RCC_GPIOE_CLK_ENABLE();

  gpio.Pin = GPIO_PIN_12 | GPIO_PIN_13 | GPIO_PIN_14 | GPIO_PIN_15;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOD, &gpio);

  HAL_GPIO_WritePin(GPIOE, GPIO_PIN_3, GPIO_PIN_SET);
  gpio.Pin = GPIO_PIN_3;
  gpio.Speed = GPIO_SPEED_FREQ_HIGH;
  HAL_GPIO_Init(GPIOE, &gpio);
}

static void SPI1_Init(void)
{
  GPIO_InitTypeDef gpio = {0};
  __HAL_RCC_SPI1_CLK_ENABLE();
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF5_SPI1;
  gpio.Pin = GPIO_PIN_6 | GPIO_PIN_7;
  gpio.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOA, &gpio);
  // SCK idles high in mode 3, but the SPI only drives it once SPE is set, at the first transfer,
  // after CS has gone low: until then the pin's pull must hold the idle level ("pulling up SCK if
  // CPOL=1", RM0090 §28.3.1), or the accelerometer counts the step up as a clock.
  gpio.Pin = GPIO_PIN_5;
  gpio.Pull = GPIO_PULLUP;
  HAL_GPIO_Init(GPIOA, &gpio);

  // Mode 3 (CPOL 1, CPHA 1), MSB first, 84 MHz / 16 = 5.25 MHz (both parts allow 10 MHz).
  hspi1.Instance = SPI1;
  hspi1.Init.Mode = SPI_MODE_MASTER;
  hspi1.Init.Direction = SPI_DIRECTION_2LINES;
  hspi1.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi1.Init.CLKPolarity = SPI_POLARITY_HIGH;
  hspi1.Init.CLKPhase = SPI_PHASE_2EDGE;
  hspi1.Init.NSS = SPI_NSS_SOFT;
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_16;
  hspi1.Init.FirstBit = SPI_FIRSTBIT_MSB;
  if (HAL_SPI_Init(&hspi1) != HAL_OK) Error_Handler();
}

/* 168 MHz from the 8 MHz crystal X2: PLLM 8, PLLN 336, PLLP 2, PLLQ 7; VOS scale 1, 5 WS. */
static void SystemClock_Config(void)
{
  RCC_OscInitTypeDef osc = {0};
  RCC_ClkInitTypeDef clk = {0};
  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);
  osc.OscillatorType = RCC_OSCILLATORTYPE_HSE;
  osc.HSEState = RCC_HSE_ON;
  osc.PLL.PLLState = RCC_PLL_ON;
  osc.PLL.PLLSource = RCC_PLLSOURCE_HSE;
  osc.PLL.PLLM = 8;
  osc.PLL.PLLN = 336;
  osc.PLL.PLLP = RCC_PLLP_DIV2;
  osc.PLL.PLLQ = 7;
  if (HAL_RCC_OscConfig(&osc) != HAL_OK) Error_Handler();
  clk.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
  clk.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  clk.AHBCLKDivider = RCC_SYSCLK_DIV1;
  clk.APB1CLKDivider = RCC_HCLK_DIV4;
  clk.APB2CLKDivider = RCC_HCLK_DIV2;
  if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_5) != HAL_OK) Error_Handler();
}

void Error_Handler(void)
{
  __disable_irq();
  while (1)
  {
    __asm volatile("bkpt 0xEE");
  }
}
