/* afiskon/stm32-ssd1306 as its README shows it: Init, Fill, a string, UpdateScreen. */
#include "board.h"
#include <stdio.h>
#include "ssd1306.h"
#include "ssd1306_fonts.h"
volatile uint32_t seconds, done;
int main(void)
{
  board_init(400000);
  ssd1306_Init();
  ssd1306_Fill(Black);
  ssd1306_DrawRectangle(0, 0, 127, 63, White);
  ssd1306_SetCursor(4, 4);
  ssd1306_WriteString("afiskon OK", Font_7x10, White);
  ssd1306_UpdateScreen();
  done = 1;
  char buf[16];
  while (1)
  {
    HAL_Delay(1000);
    seconds++;
    snprintf(buf, sizeof buf, "t=%lu", (unsigned long)seconds);
    ssd1306_SetCursor(4, 30);
    ssd1306_WriteString(buf, Font_11x18, White);
    ssd1306_UpdateScreen();
  }
}
