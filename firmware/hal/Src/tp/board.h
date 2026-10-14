#pragma once
#include "main.h"
extern I2C_HandleTypeDef hi2c1;
void board_init(uint32_t i2c_hz);
void Error_Handler(void);
