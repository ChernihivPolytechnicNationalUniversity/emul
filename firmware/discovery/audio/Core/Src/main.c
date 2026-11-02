/*
 * STM32F4-Discovery audio: the CS43L22 plays a 400 Hz tone to the headphone jack, and the
 * MP45DT02 microphone is listened to as a clap detector. 168 MHz from the 8 MHz crystal.
 *
 *   CS43L22  I2C1 PB6/PB9 (0x94), RESET̅ PD4; I2S3 Philips 16-bit 16 kHz with MCK (PC7/PC10/PC12/PA4),
 *            fed by DMA1 Stream 5 in circular mode. codec_id holds its ID register (0xE3 on rev B1).
 *   MP45DT02 I2S2 master receive, 16-bit words at 32 kHz: CK (PB10) = 1.024 MHz, the PDM bits on PC3,
 *            by DMA1 Stream 3. Every 64 bits are one 16 kHz sample (ones − 32); mic_power is their mean
 *            square over 16 ms. LD5 (red) lights while it is loud; LD4 (green) shows the tone is playing.
 */
#include "main.h"
#include <math.h>

void Error_Handler(void);
static void SystemClock_Config(void);
static void Codec_Init(void);

I2C_HandleTypeDef hi2c1;
I2S_HandleTypeDef hi2s3, hi2s2;
DMA_HandleTypeDef hdma_tx, hdma_rx;

#define TONE_FRAMES 40                 /* 16 kHz / 400 Hz */
static int16_t tone[2 * TONE_FRAMES];  /* left, right */
#define MIC_WORDS 256                  /* 2 × 128 halfwords: 4 ms at 32 kHz */
static uint16_t mic[MIC_WORDS];

volatile uint8_t codec_id;
volatile uint32_t mic_power;
static uint64_t acc_sq;
static uint32_t acc_n, acc_bits, acc_ones;

#define LOUD 40

static void codec_write(uint8_t reg, uint8_t value)
{
  if (HAL_I2C_Mem_Write(&hi2c1, 0x94, reg, 1, &value, 1, 10) != HAL_OK) Error_Handler();
}

static uint8_t codec_read(uint8_t reg)
{
  uint8_t v = 0;
  if (HAL_I2C_Mem_Read(&hi2c1, 0x94, reg, 1, &v, 1, 10) != HAL_OK) Error_Handler();
  return v;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  __HAL_RCC_GPIOD_CLK_ENABLE();
  __HAL_RCC_DMA1_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_4 | GPIO_PIN_12 | GPIO_PIN_14;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOD, &gpio);

  for (int i = 0; i < TONE_FRAMES; i++)
    tone[2 * i] = tone[2 * i + 1] = (int16_t)(8000.0f * sinf(2.0f * 3.14159265f * i / TONE_FRAMES));

  Codec_Init();

  hi2s3.Instance = SPI3;
  hi2s3.Init.Mode = I2S_MODE_MASTER_TX;
  hi2s3.Init.Standard = I2S_STANDARD_PHILIPS;
  hi2s3.Init.DataFormat = I2S_DATAFORMAT_16B;
  hi2s3.Init.MCLKOutput = I2S_MCLKOUTPUT_ENABLE;
  hi2s3.Init.AudioFreq = I2S_AUDIOFREQ_16K;
  hi2s3.Init.CPOL = I2S_CPOL_LOW;
  hi2s3.Init.ClockSource = I2S_CLOCK_PLL;
  hi2s3.Init.FullDuplexMode = I2S_FULLDUPLEXMODE_DISABLE;
  if (HAL_I2S_Init(&hi2s3) != HAL_OK) Error_Handler();

  hi2s2.Instance = SPI2;
  hi2s2.Init = hi2s3.Init;
  hi2s2.Init.Mode = I2S_MODE_MASTER_RX;
  hi2s2.Init.Standard = I2S_STANDARD_LSB;
  hi2s2.Init.MCLKOutput = I2S_MCLKOUTPUT_DISABLE;
  hi2s2.Init.AudioFreq = I2S_AUDIOFREQ_32K;
  if (HAL_I2S_Init(&hi2s2) != HAL_OK) Error_Handler();

  // §4.9: LRCK and the clocks start while the codec is powered down, then power up.
  if (HAL_I2S_Transmit_DMA(&hi2s3, (uint16_t *)tone, 2 * TONE_FRAMES) != HAL_OK) Error_Handler();
  HAL_Delay(2);
  codec_write(0x02, 0x9E);
  if (HAL_I2S_Receive_DMA(&hi2s2, mic, MIC_WORDS) != HAL_OK) Error_Handler();

  HAL_GPIO_WritePin(GPIOD, GPIO_PIN_12, GPIO_PIN_SET);
  while (1)
  {
    HAL_GPIO_WritePin(GPIOD, GPIO_PIN_14, mic_power > LOUD ? GPIO_PIN_SET : GPIO_PIN_RESET);
    HAL_Delay(5);
  }
}

/* As ST's cs43l22.c does it: reset high, powered down, headphones on, auto clocking, I²S slave 16-bit, the §4.11 writes. */
static void Codec_Init(void)
{
  GPIO_InitTypeDef gpio = {0};
  __HAL_RCC_I2C1_CLK_ENABLE();
  gpio.Pin = GPIO_PIN_6 | GPIO_PIN_9;
  gpio.Mode = GPIO_MODE_AF_OD;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_HIGH;
  gpio.Alternate = GPIO_AF4_I2C1;
  HAL_GPIO_Init(GPIOB, &gpio);

  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 100000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  if (HAL_I2C_Init(&hi2c1) != HAL_OK) Error_Handler();

  HAL_GPIO_WritePin(GPIOD, GPIO_PIN_4, GPIO_PIN_SET);
  HAL_Delay(5);

  codec_id = codec_read(0x01);
  codec_write(0x02, 0x01);
  codec_write(0x04, 0xAF);
  codec_write(0x05, 0x81);
  codec_write(0x06, 0x04);
  codec_write(0x20, 0x00);
  codec_write(0x21, 0x00);
  codec_write(0x00, 0x99);
  codec_write(0x47, 0x80);
  codec_write(0x32, codec_read(0x32) | 0x80);
  codec_write(0x32, codec_read(0x32) & ~0x80);
  codec_write(0x00, 0x00);
}

/* One mic block: 64 PDM bits (4 halfwords) per 16 kHz sample; mean square over 256 samples. */
static void mic_block(const uint16_t *w, int n)
{
  for (int i = 0; i < n; i++)
  {
    acc_ones += __builtin_popcount(w[i]);
    if (++acc_bits == 4)
    {
      int32_t s = (int32_t)acc_ones - 32;
      acc_sq += (uint64_t)(s * s);
      acc_ones = acc_bits = 0;
      if (++acc_n == 256)
      {
        mic_power = (uint32_t)(acc_sq / 256);
        acc_sq = 0;
        acc_n = 0;
      }
    }
  }
}

void HAL_I2S_RxHalfCpltCallback(I2S_HandleTypeDef *h) { if (h == &hi2s2) mic_block(mic, MIC_WORDS / 2); }
void HAL_I2S_RxCpltCallback(I2S_HandleTypeDef *h) { if (h == &hi2s2) mic_block(mic + MIC_WORDS / 2, MIC_WORDS / 2); }

void HAL_I2S_MspInit(I2S_HandleTypeDef *h)
{
  GPIO_InitTypeDef gpio = {0};
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_HIGH;
  if (h->Instance == SPI3)
  {
    __HAL_RCC_SPI3_CLK_ENABLE();
    gpio.Alternate = GPIO_AF6_SPI3;
    gpio.Pin = GPIO_PIN_7 | GPIO_PIN_10 | GPIO_PIN_12;
    HAL_GPIO_Init(GPIOC, &gpio);
    gpio.Pin = GPIO_PIN_4;
    HAL_GPIO_Init(GPIOA, &gpio);
    hdma_tx.Instance = DMA1_Stream5;
    hdma_tx.Init.Channel = DMA_CHANNEL_0;
    hdma_tx.Init.Direction = DMA_MEMORY_TO_PERIPH;
    hdma_tx.Init.PeriphInc = DMA_PINC_DISABLE;
    hdma_tx.Init.MemInc = DMA_MINC_ENABLE;
    hdma_tx.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;
    hdma_tx.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;
    hdma_tx.Init.Mode = DMA_CIRCULAR;
    hdma_tx.Init.Priority = DMA_PRIORITY_HIGH;
    hdma_tx.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
    if (HAL_DMA_Init(&hdma_tx) != HAL_OK) Error_Handler();
    __HAL_LINKDMA(h, hdmatx, hdma_tx);
    HAL_NVIC_SetPriority(DMA1_Stream5_IRQn, 1, 0);
    HAL_NVIC_EnableIRQ(DMA1_Stream5_IRQn);
  }
  else if (h->Instance == SPI2)
  {
    __HAL_RCC_SPI2_CLK_ENABLE();
    gpio.Alternate = GPIO_AF5_SPI2;
    gpio.Pin = GPIO_PIN_10;
    HAL_GPIO_Init(GPIOB, &gpio);
    gpio.Pin = GPIO_PIN_3;
    HAL_GPIO_Init(GPIOC, &gpio);
    hdma_rx.Instance = DMA1_Stream3;
    hdma_rx.Init.Channel = DMA_CHANNEL_0;
    hdma_rx.Init.Direction = DMA_PERIPH_TO_MEMORY;
    hdma_rx.Init.PeriphInc = DMA_PINC_DISABLE;
    hdma_rx.Init.MemInc = DMA_MINC_ENABLE;
    hdma_rx.Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;
    hdma_rx.Init.MemDataAlignment = DMA_MDATAALIGN_HALFWORD;
    hdma_rx.Init.Mode = DMA_CIRCULAR;
    hdma_rx.Init.Priority = DMA_PRIORITY_HIGH;
    hdma_rx.Init.FIFOMode = DMA_FIFOMODE_DISABLE;
    if (HAL_DMA_Init(&hdma_rx) != HAL_OK) Error_Handler();
    __HAL_LINKDMA(h, hdmarx, hdma_rx);
    HAL_NVIC_SetPriority(DMA1_Stream3_IRQn, 2, 0);
    HAL_NVIC_EnableIRQ(DMA1_Stream3_IRQn);
  }
}

void DMA1_Stream5_IRQHandler(void) { HAL_DMA_IRQHandler(&hdma_tx); }
void DMA1_Stream3_IRQHandler(void) { HAL_DMA_IRQHandler(&hdma_rx); }

/* 168 MHz from the 8 MHz crystal X2; PLLI2S N 213, R 2 → 106.5 MHz I2S clock (RM0090 Table 127, 16 kHz with MCK). */
static void SystemClock_Config(void)
{
  RCC_OscInitTypeDef osc = {0};
  RCC_ClkInitTypeDef clk = {0};
  RCC_PeriphCLKInitTypeDef per = {0};
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
  per.PeriphClockSelection = RCC_PERIPHCLK_I2S;
  per.PLLI2S.PLLI2SN = 213;
  per.PLLI2S.PLLI2SR = 2;
  if (HAL_RCCEx_PeriphCLKConfig(&per) != HAL_OK) Error_Handler();
}

void Error_Handler(void)
{
  __disable_irq();
  while (1)
  {
    __asm volatile("bkpt 0xEE");
  }
}
