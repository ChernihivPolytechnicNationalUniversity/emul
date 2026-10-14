/* u8g2 on STM32 HAL hardware I²C, the callbacks as the u8g2 porting guide and most tutorials write them. */
#include "board.h"
#include "u8g2.h"
volatile uint32_t seconds, done, errors;
static u8g2_t u8g2;

static uint8_t byte_cb(u8x8_t *u8x8, uint8_t msg, uint8_t arg_int, void *arg_ptr)
{
  static uint8_t buffer[32];
  static uint8_t n;
  switch (msg)
  {
  case U8X8_MSG_BYTE_SEND:
    for (uint8_t *d = arg_ptr; arg_int--;) buffer[n++] = *d++;
    break;
  case U8X8_MSG_BYTE_INIT:
  case U8X8_MSG_BYTE_SET_DC:
    break;
  case U8X8_MSG_BYTE_START_TRANSFER:
    n = 0;
    break;
  case U8X8_MSG_BYTE_END_TRANSFER:
    if (HAL_I2C_Master_Transmit(&hi2c1, u8x8_GetI2CAddress(u8x8), buffer, n, 100) != HAL_OK) errors++;
    break;
  default:
    return 0;
  }
  return 1;
}

static uint8_t gpio_cb(u8x8_t *u8x8, uint8_t msg, uint8_t arg_int, void *arg_ptr)
{
  (void)u8x8;
  (void)arg_ptr;
  if (msg == U8X8_MSG_DELAY_MILLI) HAL_Delay(arg_int);
  return 1;
}

int main(void)
{
  board_init(400000);
  u8g2_Setup_ssd1306_i2c_128x64_noname_f(&u8g2, U8G2_R0, byte_cb, gpio_cb);
  u8g2_InitDisplay(&u8g2);
  u8g2_SetPowerSave(&u8g2, 0);
  u8g2_ClearBuffer(&u8g2);
  u8g2_DrawFrame(&u8g2, 0, 0, 128, 64);
  u8g2_SetFont(&u8g2, u8g2_font_ncenB08_tr);
  u8g2_DrawStr(&u8g2, 4, 14, "u8g2 OK");
  u8g2_DrawBox(&u8g2, 100, 40, 20, 16);
  u8g2_SendBuffer(&u8g2);
  done = 1;
  while (1)
  {
    HAL_Delay(1000);
    seconds++;
  }
}
