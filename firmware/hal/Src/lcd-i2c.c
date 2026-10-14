/*
 * A 16 × 2 character LCD on the common PCF8574 I²C backpack: I2C1 on the Arduino header (PB8
 * SCL / D15, PB9 SDA / D14) at 100 kHz, the PCF8574's limit; the backpack at 0x27 (A0–A2 open).
 * The module runs on +5V; the backpack's own 4.7 kΩ pull-ups take SDA and SCL to that 5 V,
 * which PB8 and PB9 accept as five-volt-tolerant (FT) pads in open-drain mode.
 *
 * The backpack's port drives the module: P0 RS, P1 R/W, P2 E, P3 the backlight transistor,
 * P4–P7 D4–D7, so the controller runs in 4-bit mode. Every nibble goes out as three port
 * bytes in one transfer — data with E low, the same with E high, then E low again — so RS and
 * the data are set up before E rises and held after it falls; the backlight bit stays on.
 * Each port byte takes 90 µs on the bus, longer than the controller's 37 µs instructions, so
 * only clear needs an explicit wait.
 *
 * The initialisation is the HD44780's by instruction for 4-bit mode: wait more than 40 ms after
 * power-up, 0x3 three times (4.1 ms, then 100 µs between), 0x2, then function set 0x28
 * (4-bit, two lines, 5 × 8), display off 0x08, clear 0x01 (1.52 ms), entry mode 0x06,
 * display on 0x0C. Line 1 shows a greeting, line 2 the seconds since reset.
 */
#include "main.h"

static void SystemClock_Config(void);
static void Error_Handler(void);

static I2C_HandleTypeDef hi2c1;
#define LCD_ADDR (0x27 << 1)
#define RS 0x01
#define EN 0x04
#define BACKLIGHT 0x08

volatile uint32_t errors, nacks, seconds, initDone;

static void port(const uint8_t *bytes, uint16_t n)
{
  if (HAL_I2C_Master_Transmit(&hi2c1, LCD_ADDR, (uint8_t *)bytes, n, 10) != HAL_OK)
  {
    if (HAL_I2C_GetError(&hi2c1) & HAL_I2C_ERROR_AF) nacks++;
    else errors++;
  }
}

/* One nibble on D4–D7: set up with E low, E high, E low (latched on the falling edge). */
static void nibble(uint8_t rs, uint8_t value)
{
  uint8_t v = (uint8_t)((value << 4) | BACKLIGHT | (rs ? RS : 0));
  uint8_t bytes[3] = {v, (uint8_t)(v | EN), v};
  port(bytes, 3);
}

static void lcd_byte(uint8_t rs, uint8_t value)
{
  nibble(rs, value >> 4);
  nibble(rs, value & 0x0F);
}

static void command(uint8_t c) { lcd_byte(0, c); }

static void print(const char *s)
{
  while (*s) lcd_byte(1, (uint8_t)*s++);
}

static void lcd_init(void)
{
  HAL_Delay(50); /* > 40 ms after VCC reaches 2.7 V */
  nibble(0, 0x3);
  HAL_Delay(5); /* > 4.1 ms */
  nibble(0, 0x3);
  HAL_Delay(1); /* > 100 µs */
  nibble(0, 0x3);
  HAL_Delay(1);
  nibble(0, 0x2); /* 4-bit from here on */
  command(0x28);  /* function set: 4-bit, two lines, 5 × 8 */
  command(0x08);  /* display off */
  command(0x01);  /* clear */
  HAL_Delay(2);   /* clear runs 1.52 ms */
  command(0x06);  /* entry mode: increment, no shift */
  command(0x0C);  /* display on, no cursor */
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
  gpio.Pull = GPIO_NOPULL; /* the backpack's 4.7 kΩ pull-ups to +5V */
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF4_I2C1;
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

  lcd_init();
  command(0x80); /* line 1, column 0 */
  print("Hello, Nucleo!");
  initDone = 1;

  uint32_t shown = 0xFFFFFFFF;
  while (1)
  {
    seconds = HAL_GetTick() / 1000;
    if (seconds != shown)
    {
      shown = seconds;
      char digits[11];
      int n = 0;
      uint32_t v = shown;
      do digits[n++] = (char)('0' + v % 10); while ((v /= 10) != 0);
      command(0xC0); /* line 2, column 0 */
      print("t = ");
      while (n) lcd_byte(1, (uint8_t)digits[--n]);
      print(" s");
    }
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
