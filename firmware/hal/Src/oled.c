/*
 * SSD1306 128 × 64 OLED module on I²C: I2C1 on the Arduino header (PB8 SCL / D15, PB9 SDA /
 * D14) at 400 kHz, the module at 0x3C (the address byte 0x78). The module carries its own
 * pull-ups, so the pins are open-drain with no internal pull.
 *
 * At start the program sends Adafruit_SSD1306's initialisation as one command stream (control
 * byte 00h, then the commands): display off, clock, multiplex 64, offset 0, start line 0,
 * charge pump on (8Dh 14h — without it the module stays dark), horizontal addressing, segment
 * remap (A1h) and COM scan down (C8h) so RAM column 0 / page 0 bit 0 is the top-left pixel,
 * alternative COM pins (DAh 12h), contrast CFh, pre-charge F1h, VCOMH 40h, display from RAM,
 * normal, scroll off, display on.
 *
 * The picture lives in a 1 KB framebuffer in RAM laid out as the controller's GDDRAM: byte
 * fb[page × 128 + x] holds column x of rows page × 8 … page × 8 + 7, bit 0 the top one. Once a
 * second the program redraws it — a frame round the panel's edge, "Hello, OLED!" below its top
 * edge on page 0, "t = N s" with the seconds on page 2, from the 5 × 7 font below — and sends
 * all of it: column range 21h 0 127, page range 22h 0 7, then control byte 40h and the 1024
 * bytes (about 25 ms on the bus at 400 kHz).
 *
 *   fb           the framebuffer as last sent
 *   framesSent   whole frames sent without error
 *   errors       HAL errors
 *   seconds      the counter on the screen
 *
 * LD1 (PB0) lights after the init stream is acknowledged, LD3 (PB14) on any error.
 */
#include "main.h"
#include <string.h>

static void SystemClock_Config(void);
static void Error_Handler(void);

static I2C_HandleTypeDef hi2c1;
#define OLED_ADDR (0x3C << 1)
#define WIDTH 128
#define HEIGHT 64

uint8_t fb[WIDTH * HEIGHT / 8];
volatile uint32_t framesSent, errors, seconds;

static const uint8_t init_cmds[] = {
  0x00, /* control byte: a stream of commands follows */
  0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00, 0xA1, 0xC8,
  0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0x2E, 0xAF,
};

static const uint8_t window_cmds[] = { 0x00, 0x21, 0, WIDTH - 1, 0x22, 0, HEIGHT / 8 - 1 };

/* 5 × 7 glyphs, one byte a column, bit 0 the top row (the classic LCD font). */
static const struct { char c; uint8_t col[5]; } font[] = {
  { ' ', { 0x00, 0x00, 0x00, 0x00, 0x00 } },
  { '!', { 0x00, 0x00, 0x5F, 0x00, 0x00 } },
  { ',', { 0x00, 0x50, 0x30, 0x00, 0x00 } },
  { '=', { 0x14, 0x14, 0x14, 0x14, 0x14 } },
  { '0', { 0x3E, 0x51, 0x49, 0x45, 0x3E } },
  { '1', { 0x00, 0x42, 0x7F, 0x40, 0x00 } },
  { '2', { 0x42, 0x61, 0x51, 0x49, 0x46 } },
  { '3', { 0x21, 0x41, 0x45, 0x4B, 0x31 } },
  { '4', { 0x18, 0x14, 0x12, 0x7F, 0x10 } },
  { '5', { 0x27, 0x45, 0x45, 0x45, 0x39 } },
  { '6', { 0x3C, 0x4A, 0x49, 0x49, 0x30 } },
  { '7', { 0x01, 0x71, 0x09, 0x05, 0x03 } },
  { '8', { 0x36, 0x49, 0x49, 0x49, 0x36 } },
  { '9', { 0x06, 0x49, 0x49, 0x29, 0x1E } },
  { 'D', { 0x7F, 0x41, 0x41, 0x22, 0x1C } },
  { 'E', { 0x7F, 0x49, 0x49, 0x49, 0x41 } },
  { 'H', { 0x7F, 0x08, 0x08, 0x08, 0x7F } },
  { 'L', { 0x7F, 0x40, 0x40, 0x40, 0x40 } },
  { 'O', { 0x3E, 0x41, 0x41, 0x41, 0x3E } },
  { 'e', { 0x38, 0x54, 0x54, 0x54, 0x18 } },
  { 'l', { 0x00, 0x41, 0x7F, 0x40, 0x00 } },
  { 'o', { 0x38, 0x44, 0x44, 0x44, 0x38 } },
  { 's', { 0x48, 0x54, 0x54, 0x54, 0x20 } },
  { 't', { 0x04, 0x3F, 0x44, 0x40, 0x20 } },
};

static const uint8_t *glyph(char c)
{
  for (unsigned i = 0; i < sizeof font / sizeof font[0]; i++)
    if (font[i].c == c) return font[i].col;
  return font[0].col; /* anything else as a space */
}

static void pixel(int x, int y)
{
  if (x < 0 || x >= WIDTH || y < 0 || y >= HEIGHT) return;
  fb[(y / 8) * WIDTH + x] |= 1u << (y & 7);
}

/* Text with its top row at pixel row y, 6 columns a character. */
static void text(int x, int y, const char *s)
{
  for (; *s; s++, x += 6)
  {
    const uint8_t *g = glyph(*s);
    for (int cx = 0; cx < 5; cx++)
      for (int cy = 0; cy < 7; cy++)
        if (g[cx] & (1u << cy)) pixel(x + cx, y + cy);
  }
}

static void draw(uint32_t n)
{
  memset(fb, 0, sizeof fb);
  for (int x = 0; x < WIDTH; x++) { pixel(x, 0); pixel(x, HEIGHT - 1); }
  for (int y = 0; y < HEIGHT; y++) { pixel(0, y); pixel(WIDTH - 1, y); }
  /* Page 0, one row below the frame's top edge; 12 characters centred. */
  text((WIDTH - 12 * 6) / 2, 1, "Hello, OLED!");
  char line[16] = "t = ";
  char digits[11];
  int len = 0;
  do { digits[len++] = '0' + n % 10; n /= 10; } while (n);
  int p = 4;
  while (len) line[p++] = digits[--len];
  line[p++] = ' ';
  line[p++] = 's';
  line[p] = 0;
  text((WIDTH - p * 6) / 2, 17, line); /* page 2 */
}

static int send(void)
{
  static uint8_t out[1 + sizeof fb];
  out[0] = 0x40; /* control byte: a stream of display data follows */
  memcpy(out + 1, fb, sizeof fb);
  if (HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, (uint8_t *)window_cmds, sizeof window_cmds, 10) != HAL_OK) return 0;
  if (HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, out, sizeof out, 100) != HAL_OK) return 0;
  return 1;
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
  hi2c1.Init.ClockSpeed = 400000;
  hi2c1.Init.DutyCycle = I2C_DUTYCYCLE_2;
  hi2c1.Init.OwnAddress1 = 0;
  hi2c1.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
  hi2c1.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
  hi2c1.Init.OwnAddress2 = 0;
  hi2c1.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
  hi2c1.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
  if (HAL_I2C_Init(&hi2c1) != HAL_OK) Error_Handler();

  /* The module's RC reset needs a moment after power-up. */
  HAL_Delay(10);
  if (HAL_I2C_Master_Transmit(&hi2c1, OLED_ADDR, (uint8_t *)init_cmds, sizeof init_cmds, 10) != HAL_OK) errors++;
  else HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_SET);

  uint32_t next = HAL_GetTick();
  while (1)
  {
    draw(seconds);
    if (send()) framesSent++;
    else errors++;
    if (errors) HAL_GPIO_WritePin(GPIOB, GPIO_PIN_14, GPIO_PIN_SET);
    next += 1000;
    while ((int32_t)(HAL_GetTick() - next) < 0) __WFI(); /* SysTick wakes it every ms */
    seconds++;
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
