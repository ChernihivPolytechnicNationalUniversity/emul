/*
 * Netduino Plus 2 (Rev A) on the ST HAL: 168 MHz from the 25 MHz crystal Y1 (this project's
 * stm32f4xx_hal_conf.h sets HSE_VALUE to 25 MHz), SysTick at 1 kHz.
 *
 *   LED (blue, PA10, high = on)   blinks every 500 ms, every 100 ms while BTN is held
 *   BTN (PB11, high when pressed) also drives BOOT0: hold it through a reset for the ST bootloader
 *   PB2 high                       switches the header's 3V3 and 5V on
 *   PC15 low, MCO1 (PA8) = HSE     power and clock the ENC28J60; it is reset on PD2 and its
 *                                  silicon revision read over SPI1 into enc_revid (EREVID, bank 3)
 */
#include "main.h"

void Error_Handler(void);
static void SystemClock_Config(void);
static void GPIO_Init(void);
static void Ethernet_Init(void);

SPI_HandleTypeDef hspi1;
volatile uint8_t enc_revid;
volatile uint8_t enc_estat;

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  GPIO_Init();
  Ethernet_Init();

  while (1)
  {
    HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_10);
    HAL_Delay(HAL_GPIO_ReadPin(GPIOB, GPIO_PIN_11) == GPIO_PIN_SET ? 100 : 500);
  }
}

static void GPIO_Init(void)
{
  GPIO_InitTypeDef gpio = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOD_CLK_ENABLE();

  // Outputs at their safe levels first: header power on, Ethernet power off, ENC in reset, CS high.
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_2, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_15, GPIO_PIN_SET);
  HAL_GPIO_WritePin(GPIOD, GPIO_PIN_2, GPIO_PIN_RESET);
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_SET);

  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  gpio.Pin = GPIO_PIN_10;
  HAL_GPIO_Init(GPIOA, &gpio);
  gpio.Pin = GPIO_PIN_2;
  HAL_GPIO_Init(GPIOB, &gpio);
  gpio.Pin = GPIO_PIN_15;
  HAL_GPIO_Init(GPIOC, &gpio);
  gpio.Pin = GPIO_PIN_2;
  HAL_GPIO_Init(GPIOD, &gpio);
  gpio.Speed = GPIO_SPEED_FREQ_HIGH;
  gpio.Pin = GPIO_PIN_8;
  HAL_GPIO_Init(GPIOC, &gpio);

  gpio.Mode = GPIO_MODE_INPUT;
  gpio.Pin = GPIO_PIN_11;
  HAL_GPIO_Init(GPIOB, &gpio);
}

static uint8_t enc_xfer(uint8_t op, uint8_t data)
{
  uint8_t tx[2] = {op, data}, rx[2];
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_RESET);
  HAL_SPI_TransmitReceive(&hspi1, tx, rx, 2, 10);
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_8, GPIO_PIN_SET);
  return rx[1];
}

static void Ethernet_Init(void)
{
  GPIO_InitTypeDef gpio = {0};

  // 25 MHz on MCO1 (PA8) straight from the HSE: the ENC28J60 has no crystal of its own.
  HAL_RCC_MCOConfig(RCC_MCO1, RCC_MCO1SOURCE_HSE, RCC_MCODIV_1);

  __HAL_RCC_SPI1_CLK_ENABLE();
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF5_SPI1;
  gpio.Pin = GPIO_PIN_5 | GPIO_PIN_7;
  HAL_GPIO_Init(GPIOA, &gpio);
  gpio.Pin = GPIO_PIN_4;
  HAL_GPIO_Init(GPIOB, &gpio);

  hspi1.Instance = SPI1;
  hspi1.Init.Mode = SPI_MODE_MASTER;
  hspi1.Init.Direction = SPI_DIRECTION_2LINES;
  hspi1.Init.DataSize = SPI_DATASIZE_8BIT;
  hspi1.Init.CLKPolarity = SPI_POLARITY_LOW;
  hspi1.Init.CLKPhase = SPI_PHASE_1EDGE;
  hspi1.Init.NSS = SPI_NSS_SOFT;
  hspi1.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_16;
  hspi1.Init.FirstBit = SPI_FIRSTBIT_MSB;
  if (HAL_SPI_Init(&hspi1) != HAL_OK) Error_Handler();

  // Power up (PC15 low), let the rail settle, release reset, wait for ESTAT.CLKRDY.
  HAL_GPIO_WritePin(GPIOC, GPIO_PIN_15, GPIO_PIN_RESET);
  HAL_Delay(10);
  HAL_GPIO_WritePin(GPIOD, GPIO_PIN_2, GPIO_PIN_SET);
  for (int i = 0; i < 100; i++)
  {
    enc_estat = enc_xfer(0x00 | 0x1D, 0);  // RCR ESTAT
    if (enc_estat & 0x01) break;
    HAL_Delay(1);
  }
  enc_xfer(0x80 | 0x1F, 0x03);             // BFS ECON1: BSEL = 3
  enc_revid = enc_xfer(0x00 | 0x12, 0);    // RCR EREVID
}

/* 168 MHz from the 25 MHz HSE crystal: PLLM 25, PLLN 336, PLLP 2, PLLQ 7; VOS scale 1, 5 WS (RM0090 Table 11). */
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
  osc.PLL.PLLM = 25;
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
