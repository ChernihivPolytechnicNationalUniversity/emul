/*
 * I²C master against a 24C02 EEPROM: I2C1 on the Arduino header (PB8 SCL / D15, PB9 SDA /
 * D14) at 100 kHz, device address 0x50 (A0–A2 low). Writes a greeting at address 0 in
 * 8-byte pages with acknowledge polling between them, reads it back and compares (LD1 on
 * PB0 lights when it matches, LD3 on PB14 on any error), then keeps a counter at address
 * 0x40 that it reads, increments and writes back every 100 ms.
 */
#include "main.h"
#include <string.h>

static void SystemClock_Config(void);
static void Error_Handler(void);

static I2C_HandleTypeDef hi2c1;
#define EEPROM_ADDR 0xA0
#define PAGE 8

static const char greeting[] = "Hello, EEPROM!";
volatile uint32_t phase, errors, verified, counter, polls;
volatile uint8_t readBack[16];

static void wait_ready(void)
{
  /* Acknowledge polling: the part NACKs its address while the write cycle runs. */
  while (HAL_I2C_IsDeviceReady(&hi2c1, EEPROM_ADDR, 1, 10) != HAL_OK) polls++;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_I2C1_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9;
  gpio.Mode = GPIO_MODE_AF_OD;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF4_I2C1;
  HAL_GPIO_Init(GPIOB, &gpio);

  gpio.Pin = GPIO_PIN_0 | GPIO_PIN_14;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Alternate = 0;
  HAL_GPIO_Init(GPIOB, &gpio);

  hi2c1.Instance = I2C1;
  hi2c1.Init.ClockSpeed = 100000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.OwnAddress1 = 0;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
  hi2c1.Init.OwnAddress2 = 0;
  hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
  hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
  if (HAL_I2C_Init(&hi2c1) != HAL_OK) Error_Handler();

  /* 1. Write the greeting page by page. */
  phase = 1;
  wait_ready();
  for (uint16_t off = 0; off < sizeof greeting; off += PAGE)
  {
    uint16_t n = sizeof greeting - off < PAGE ? sizeof greeting - off : PAGE;
    if (HAL_I2C_Mem_Write(&hi2c1, EEPROM_ADDR, off, I2C_MEMADD_SIZE_8BIT, (uint8_t *)greeting + off, n, 100) != HAL_OK) errors++;
    wait_ready();
  }

  /* 2. Read it back and compare. */
  phase = 2;
  if (HAL_I2C_Mem_Read(&hi2c1, EEPROM_ADDR, 0, I2C_MEMADD_SIZE_8BIT, (uint8_t *)readBack, sizeof greeting, 100) != HAL_OK) errors++;
  verified = memcmp((const void *)readBack, greeting, sizeof greeting) == 0;
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, verified ? GPIO_PIN_SET : GPIO_PIN_RESET);
  if (!verified || errors) HAL_GPIO_WritePin(GPIOB, GPIO_PIN_14, GPIO_PIN_SET);

  /* 3. A counter that survives resets: read, increment, write back. */
  phase = 3;
  while (1)
  {
    uint8_t v = 0;
    if (HAL_I2C_Mem_Read(&hi2c1, EEPROM_ADDR, 0x40, I2C_MEMADD_SIZE_8BIT, &v, 1, 100) != HAL_OK) errors++;
    if (v == 0xFF) v = 0; /* blank part */
    v++;
    if (HAL_I2C_Mem_Write(&hi2c1, EEPROM_ADDR, 0x40, I2C_MEMADD_SIZE_8BIT, &v, 1, 100) != HAL_OK) errors++;
    wait_ready();
    counter = v;
    if (errors) HAL_GPIO_WritePin(GPIOB, GPIO_PIN_14, GPIO_PIN_SET);
    HAL_Delay(100);
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
