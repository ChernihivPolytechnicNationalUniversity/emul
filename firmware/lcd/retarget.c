/* GCC/newlib stand-in for the demos' Keil-style fputc: printf goes out on USART1. */
#include "stm32f7xx_hal.h"

extern UART_HandleTypeDef huart1;

int _write(int fd, const char *buf, int len) {
  (void)fd;
  HAL_UART_Transmit(&huart1, (uint8_t *)buf, len, 0xffff);
  return len;
}
