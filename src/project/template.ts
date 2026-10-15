import { isPicTarget, type SourceFile, type Target } from "emul-shared/source"

/**
 * What a board's project starts as: the CubeIDE layout (`Core/Inc`, `Core/Src`) around the
 * repo's own Nucleo-F429ZI HAL blink (`firmware/hal/Src/main.c`), or an Open746I-C one for the
 * F746, so the first build has something to show on the board's LEDs. An ATmega328P (the
 * Arduino Nano) starts as an Arduino sketch, built against ArduinoCore-avr (a project of .c
 * files with no .ino builds on avr-libc alone). A PIC16F62x starts as C for SDCC (a project with
 * an .asm file builds with gpasm instead).
 */
export const template = (target: Target): SourceFile[] =>
  isPicTarget(target)
    ? [{ path: "main.c", content: PIC_MAIN_C }]
    : target === "atmega328p"
    ? [{ path: "Blink.ino", content: NANO_SKETCH }]
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

const NANO_SKETCH = `// Arduino Nano: L blinks, the USB serial counts the seconds and echoes what you type.
//
//   L (D13)       toggles every 500 ms
//   USB serial    9600 baud: "tick N" every second, and whatever arrives comes back upper-cased
//                 (wire a serial terminal to the TX/RX pins by the USB connector)

unsigned long last;
unsigned ticks;

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(9600);
}

void loop() {
  if (millis() - last >= 500) {
    last += 500;
    digitalWrite(LED_BUILTIN, !digitalRead(LED_BUILTIN));
    if (digitalRead(LED_BUILTIN)) {
      Serial.print("tick ");
      Serial.println(ticks++);
    }
  }
  while (Serial.available()) Serial.write(toupper(Serial.read()));
}
`

const PIC_MAIN_C = `/*
 * PIC16F62x on the internal 4 MHz oscillator (SDCC): an LED on RB3 toggled every 0.5 s by
 * Timer1, "tick N" a second on the USART at 9600 baud (RB2/TX, RB1/RX), every received letter
 * echoed upper-cased. Wire an LED through 220 R from RB3 to VSS, 10k from MCLR (RA5) to VDD,
 * and a serial terminal on RB1/RB2.
 *
 * pic14regs.h brings the chip's registers by the target the build names (-p16f628a ...).
 * SDCC does not clear static variables at start-up and RAM powers up random: set them in main.
 */
#include <pic14regs.h>
#include <stdint.h>

/* Configuration word at 2007h: internal oscillator with RA6/RA7 as I/O, no watchdog,
   power-up timer on, MCLR as reset, no brown-out, no low-voltage programming. */
static __code uint16_t __at(_CONFIG) config = _FOSC_INTOSCIO & _WDT_OFF & _PWRTE_ON & _MCLRE_ON & _BOREN_OFF & _LVP_OFF;

#define RELOAD (65536u - 62500u) /* 0.5 s at 1 MHz / 8 */

static volatile uint8_t halves;
static volatile uint8_t rx_byte;
static volatile uint8_t rx_ready;

void isr(void) __interrupt {
  if (TMR1IF) {
    TMR1ON = 0;
    TMR1H = RELOAD >> 8;
    TMR1L = RELOAD & 0xff;
    TMR1ON = 1;
    TMR1IF = 0;
    RB3 = !RB3;
    halves++;
  }
  if (RCIF) {
    rx_byte = RCREG;
    rx_ready = 1;
  }
}

static void put(char c) {
  while (!TXIF)
    ;
  TXREG = c;
}

static void put_num(uint16_t n) {
  char digits[5];
  uint8_t i = 0;
  do {
    digits[i++] = (char)('0' + n % 10);
    n /= 10;
  } while (n);
  while (i) put(digits[--i]);
}

void main(void) {
  uint16_t ticks = 0;
  halves = 0;
  rx_ready = 0;
  CMCON = 0x07; /* comparators off: PORTA digital */
  TRISB = 0xf7; /* RB3 out; RB1/RB2 stay inputs for the USART */
  PORTB = 0;
  SPBRG = 25;   /* 9615 baud at 4 MHz with BRGH */
  TXSTA = 0x24; /* TXEN, BRGH */
  RCSTA = 0x90; /* SPEN, CREN */
  TMR1H = RELOAD >> 8;
  TMR1L = RELOAD & 0xff;
  T1CON = 0x31; /* 1:8, FOSC/4, on */
  TMR1IE = 1;
  RCIE = 1;
  PEIE = 1;
  GIE = 1;
  for (;;) {
    if (halves >= 2) {
      halves -= 2;
      put('t'); put('i'); put('c'); put('k'); put(' ');
      put_num(ticks++);
      put('\\r'); put('\\n');
    }
    if (rx_ready) {
      uint8_t c = rx_byte;
      rx_ready = 0;
      if (c >= 'a' && c <= 'z') c -= 'a' - 'A';
      put((char)c);
    }
  }
}
`
