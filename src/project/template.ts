import type { SourceFile, Target } from "emul-shared/source"

/**
 * What a board's project starts as: the CubeIDE layout (`Core/Inc`, `Core/Src`) around the
 * repo's own Nucleo-F429ZI HAL blink (`firmware/hal/Src/main.c`), or an Open746I-C one for the
 * F746, so the first build has something to show on the board's LEDs. An ATmega328P (the
 * Arduino Nano) starts from an avr-libc blink with a serial echo.
 */
export const template = (target: Target): SourceFile[] =>
  target === "atmega328p"
    ? [{ path: "src/main.c", content: AVR_MAIN_C }]
    : target === "stm32f746ig"
    ? [
        { path: "Core/Inc/main.h", content: F7_MAIN_H },
        { path: "Core/Src/main.c", content: F7_MAIN_C },
      ]
    : [
        { path: "Core/Inc/main.h", content: MAIN_H },
        { path: "Core/Src/main.c", content: MAIN_C },
      ]

/** The file the editor opens first. */
export const TEMPLATE_MAIN = "Core/Src/main.c"

const MAIN_H = `#ifndef MAIN_H
#define MAIN_H

#include "stm32f4xx_hal.h"

#endif /* MAIN_H */
`

const MAIN_C = `/*
 * Nucleo-F429ZI blink on the ST HAL, exactly as STM32CubeIDE would generate it:
 * 180 MHz from HSE bypass through the PLL with over-drive, SysTick at 1 kHz.
 *
 *   LD1 (PB0, green)  toggles every 500 ms from the main loop (HAL_Delay)
 *   LD2 (PB7, blue)   toggles every 100 ms from the SysTick callback
 *   LD3 (PB14, red)   toggles on each press of the USER button (PC13, EXTI15_10)
 *
 * PA5 (D13) mirrors LD1 so the header LED example lights up too.
 */
#include "main.h"

static void SystemClock_Config(void);
static void Error_Handler(void);
static void GPIO_Init(void);

volatile uint32_t button_presses;

int main(void)
{
  HAL_Init();
  SystemClock_Config();
  GPIO_Init();

  while (1)
  {
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_0);
    HAL_GPIO_TogglePin(GPIOA, GPIO_PIN_5);
    HAL_Delay(500);
  }
}

static void GPIO_Init(void)
{
  GPIO_InitTypeDef gpio = {0};

  __HAL_RCC_GPIOA_CLK_ENABLE();
  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();

  gpio.Pin = GPIO_PIN_0 | GPIO_PIN_7 | GPIO_PIN_14;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &gpio);

  gpio.Pin = GPIO_PIN_5;
  HAL_GPIO_Init(GPIOA, &gpio);

  gpio.Pin = GPIO_PIN_13;
  gpio.Mode = GPIO_MODE_IT_RISING;
  gpio.Pull = GPIO_NOPULL;
  HAL_GPIO_Init(GPIOC, &gpio);
  HAL_NVIC_SetPriority(EXTI15_10_IRQn, 2, 0);
  HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);
}

void HAL_SYSTICK_Callback(void)
{
  static uint32_t n;
  if (++n >= 100)
  {
    n = 0;
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_7);
  }
}

void EXTI15_10_IRQHandler(void)
{
  HAL_GPIO_EXTI_IRQHandler(GPIO_PIN_13);
}

void HAL_GPIO_EXTI_Callback(uint16_t pin)
{
  if (pin == GPIO_PIN_13)
  {
    button_presses++;
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_14);
  }
}

/* The template's 180 MHz configuration for this board. */
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
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK)
  {
    Error_Handler();
  }

  if (HAL_PWREx_EnableOverDrive() != HAL_OK)
  {
    Error_Handler();
  }

  RCC_ClkInitStruct.ClockType = (RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2);
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV4;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV2;
  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_5) != HAL_OK)
  {
    Error_Handler();
  }
}

static void Error_Handler(void)
{
  while (1)
  {
    __asm volatile("bkpt 0xEE");
  }
}
`

const F7_MAIN_H = `#ifndef MAIN_H
#define MAIN_H

#include "stm32f7xx_hal.h"

#endif /* MAIN_H */
`

const F7_MAIN_C = `/*
 * Open746I-C blink on the ST HAL: the core stays on the 16 MHz HSI, SysTick at 1 kHz.
 *
 *   LED1 (PB6)  toggles every 500 ms from the main loop (HAL_Delay)
 *   LED2 (PB7)  toggles every 100 ms from the SysTick callback
 */
#include "main.h"

static void GPIO_Init(void);

int main(void)
{
  HAL_Init();
  GPIO_Init();

  while (1)
  {
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_6);
    HAL_Delay(500);
  }
}

static void GPIO_Init(void)
{
  GPIO_InitTypeDef gpio = {0};

  __HAL_RCC_GPIOB_CLK_ENABLE();

  gpio.Pin = GPIO_PIN_6 | GPIO_PIN_7;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  gpio.Pull = GPIO_NOPULL;
  gpio.Speed = GPIO_SPEED_FREQ_LOW;
  HAL_GPIO_Init(GPIOB, &gpio);
}

void HAL_SYSTICK_Callback(void)
{
  static uint32_t n;
  if (++n >= 100)
  {
    n = 0;
    HAL_GPIO_TogglePin(GPIOB, GPIO_PIN_7);
  }
}
`

const AVR_MAIN_C = `/*
 * Arduino Nano: blink and serial echo on avr-libc (no Arduino core), 16 MHz.
 *
 *   L (D13, PB5)  toggles every 500 ms
 *   USB serial    9600 8N1 through the FT232RL on D0/D1: "tick N" every second, and whatever
 *                 arrives comes back upper-cased
 *
 * F_CPU comes from the board (16 MHz on the Nano's resonator); <util/setbaud.h> works the
 * baud divisor out from it.
 */
#include <avr/interrupt.h>
#include <avr/io.h>
#include <stdio.h>
#include <util/delay.h>

#define BAUD 9600
#include <util/setbaud.h>

/* What the RX interrupt has received and the main loop has not echoed yet. */
static volatile char rx[32];
static volatile uint8_t rx_head, rx_tail;

ISR(USART_RX_vect)
{
  char c = UDR0;
  uint8_t next = (rx_head + 1) % sizeof rx;
  if (next != rx_tail) {
    rx[rx_head] = c;
    rx_head = next;
  }
}

static int uart_putchar(char c, FILE *stream)
{
  if (c == '\\n') uart_putchar('\\r', stream);
  loop_until_bit_is_set(UCSR0A, UDRE0);
  UDR0 = c;
  return 0;
}

static FILE uart = FDEV_SETUP_STREAM(uart_putchar, NULL, _FDEV_SETUP_WRITE);

static void uart_init(void)
{
  UBRR0H = UBRRH_VALUE;
  UBRR0L = UBRRL_VALUE;
#if USE_2X
  UCSR0A |= _BV(U2X0);
#else
  UCSR0A &= ~_BV(U2X0);
#endif
  UCSR0C = _BV(UCSZ01) | _BV(UCSZ00);
  UCSR0B = _BV(RXEN0) | _BV(TXEN0) | _BV(RXCIE0);
  stdout = &uart;
}

static void echo(void)
{
  while (rx_tail != rx_head) {
    char c = rx[rx_tail];
    rx_tail = (rx_tail + 1) % sizeof rx;
    uart_putchar(c >= 'a' && c <= 'z' ? c - 'a' + 'A' : c, &uart);
  }
}

int main(void)
{
  DDRB |= _BV(DDB5);
  uart_init();
  sei();

  unsigned tick = 0;
  for (;;) {
    printf("tick %u\\n", tick++);
    for (uint8_t half = 0; half < 2; half++) {
      PORTB ^= _BV(PORTB5);
      for (uint16_t ms = 0; ms < 500; ms++) {
        _delay_ms(1);
        echo();
      }
    }
  }
}
`
