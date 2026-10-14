/*
 * 4×4 matrix keypad on the Nucleo-F429ZI, scanned the usual way, each new key printed on the
 * ST-LINK virtual COM port (USART3, PD8/PD9, 115200 8N1).
 *
 *   rows    R1..R4 on D7 (PF13), D6 (PE9), D5 (PE11), D4 (PF14): open-drain outputs, released
 *           (high-Z) except the one being scanned, which is pulled low. Open drain so that two
 *           keys held in one column never short two push-pull outputs against each other.
 *   columns C1..C4 on D3 (PE13), D2 (PF15), D1 (PG14), D0 (PG9): inputs with the MCU's
 *           internal pull-ups; a column reads low when a key joins it to the scanned row.
 *
 * Every 5 ms the four rows are scanned into a 16-bit map (bit 4 × row + column). A map counts
 * as settled when two scans in a row agree (debounce); every key that is down in the settled
 * map and was not in the previous one is printed as its legend.
 *
 *   lastKey   legend of the last key printed (ASCII), 0 before the first
 *   keyCount  keys printed
 *   keysDown  the settled key map
 *   scans     scans done
 *   errors    HAL errors
 *
 * The keypad has no diodes: holding three keys at a rectangle's corners also reads the fourth
 * (ghosting), and the firmware prints it like any other key — as a real one would.
 */
#include "main.h"

static void SystemClock_Config(void);
static void Error_Handler(void);

static UART_HandleTypeDef huart3;
volatile uint32_t lastKey, keyCount, keysDown, scans, errors;

static const char LEGENDS[17] = "123A456B789C*0#D";

typedef struct { GPIO_TypeDef *port; uint16_t pin; } Line;
static const Line ROWS[4] = { { GPIOF, GPIO_PIN_13 }, { GPIOE, GPIO_PIN_9 }, { GPIOE, GPIO_PIN_11 }, { GPIOF, GPIO_PIN_14 } };
static const Line COLS[4] = { { GPIOE, GPIO_PIN_13 }, { GPIOF, GPIO_PIN_15 }, { GPIOG, GPIO_PIN_14 }, { GPIOG, GPIO_PIN_9 } };

/* A few microseconds for the column to follow the row through the pull-up and contact. */
static void settle(void)
{
  for (volatile int i = 0; i < 200; i++) {}
}

static uint32_t scan(void)
{
  uint32_t map = 0;
  for (int r = 0; r < 4; r++)
  {
    HAL_GPIO_WritePin(ROWS[r].port, ROWS[r].pin, GPIO_PIN_RESET);
    settle();
    for (int c = 0; c < 4; c++)
      if (HAL_GPIO_ReadPin(COLS[c].port, COLS[c].pin) == GPIO_PIN_RESET) map |= 1u << (4 * r + c);
    HAL_GPIO_WritePin(ROWS[r].port, ROWS[r].pin, GPIO_PIN_SET);
  }
  settle();
  return map;
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOD_CLK_ENABLE();
  __HAL_RCC_GPIOE_CLK_ENABLE();
  __HAL_RCC_GPIOF_CLK_ENABLE();
  __HAL_RCC_GPIOG_CLK_ENABLE();
  __HAL_RCC_USART3_CLK_ENABLE();

  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_8 | GPIO_PIN_9;
  gpio.Mode = GPIO_MODE_AF_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  gpio.Alternate = GPIO_AF7_USART3;
  HAL_GPIO_Init(GPIOD, &gpio);

  for (int i = 0; i < 4; i++)
  {
    HAL_GPIO_WritePin(ROWS[i].port, ROWS[i].pin, GPIO_PIN_SET);
    gpio.Pin = ROWS[i].pin;
    gpio.Mode = GPIO_MODE_OUTPUT_OD;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;
    gpio.Alternate = 0;
    HAL_GPIO_Init(ROWS[i].port, &gpio);
    gpio.Pin = COLS[i].pin;
    gpio.Mode = GPIO_MODE_INPUT;
    gpio.Pull = GPIO_PULLUP;
    HAL_GPIO_Init(COLS[i].port, &gpio);
  }

  huart3.Instance = USART3;
  huart3.Init.BaudRate = 115200;
  huart3.Init.WordLength = UART_WORDLENGTH_8B;
  huart3.Init.StopBits = UART_STOPBITS_1;
  huart3.Init.Parity = UART_PARITY_NONE;
  huart3.Init.Mode = UART_MODE_TX_RX;
  huart3.Init.HwFlowCtl = UART_HWCONTROL_NONE;
  huart3.Init.OverSampling = UART_OVERSAMPLING_16;
  if (HAL_UART_Init(&huart3) != HAL_OK) Error_Handler();

  uint32_t previous = 0, settled = 0, last = HAL_GetTick();
  while (1)
  {
    while (HAL_GetTick() - last < 5) {}
    last += 5;
    uint32_t map = scan();
    scans++;
    if (map == previous && map != settled)
    {
      uint32_t pressed = map & ~settled;
      settled = map;
      keysDown = map;
      for (int k = 0; k < 16; k++)
      {
        if (!(pressed & (1u << k))) continue;
        uint8_t ch = (uint8_t)LEGENDS[k];
        if (HAL_UART_Transmit(&huart3, &ch, 1, 10) != HAL_OK) errors++;
        lastKey = ch;
        keyCount++;
      }
    }
    previous = map;
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
