/* 4ilo/HD44780-Stm32HAL in 4-bit mode as its F4 example: RS PF13, E PE9, D4..D7 PE11 PF14 PE13 PF15, R/W to ground. */
#include "board.h"
#include "lcd.h"
volatile uint32_t done, seconds;
int main(void)
{
  board_init(0);
  GPIO_InitTypeDef gpio = {0};
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  gpio.Pin = GPIO_PIN_13 | GPIO_PIN_14 | GPIO_PIN_15;
  HAL_GPIO_Init(GPIOF, &gpio);
  gpio.Pin = GPIO_PIN_9 | GPIO_PIN_11 | GPIO_PIN_13;
  HAL_GPIO_Init(GPIOE, &gpio);
  Lcd_PortType ports[] = { GPIOE, GPIOF, GPIOE, GPIOF };
  Lcd_PinType pins[] = { GPIO_PIN_11, GPIO_PIN_14, GPIO_PIN_13, GPIO_PIN_15 };
  Lcd_HandleTypeDef lcd = Lcd_create(ports, pins, GPIOF, GPIO_PIN_13, GPIOE, GPIO_PIN_9, LCD_4_BIT_MODE);
  Lcd_cursor(&lcd, 0, 0);
  Lcd_string(&lcd, "4ilo HD44780");
  done = 1;
  while (1)
  {
    Lcd_cursor(&lcd, 1, 0);
    Lcd_int(&lcd, (int)seconds);
    HAL_Delay(1000);
    seconds++;
  }
}
