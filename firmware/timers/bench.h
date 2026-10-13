#pragma once
#include <stdint.h>
#include "stm32f746xx.h"

typedef void (*vector_t)(void);
void Default_Handler(void);

enum { VECTOR_COUNT = 16 + 98 };
enum { PULL_NONE = 0, PULL_UP = 1, PULL_DOWN = 2 };
enum { HSE_HZ = 8000000, SYSCLK_216MHZ = 216000000 };

static vector_t vectors[VECTOR_COUNT] __attribute__((aligned(512)));

static inline void vectors_install(void) {
  for (unsigned i = 0; i < VECTOR_COUNT; i++) vectors[i] = Default_Handler;
  SCB->VTOR = (uint32_t)vectors;
  __DSB();
}

static inline void irq_attach(IRQn_Type irq, vector_t handler) {
  vectors[16 + irq] = handler;
  NVIC_SetPriority(irq, 0);
  NVIC_EnableIRQ(irq);
}

static inline void ports_on(void) {
  RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN | RCC_AHB1ENR_GPIOBEN | RCC_AHB1ENR_GPIOCEN | RCC_AHB1ENR_GPIODEN | RCC_AHB1ENR_GPIOEEN | RCC_AHB1ENR_GPIOFEN | RCC_AHB1ENR_GPIOGEN | RCC_AHB1ENR_GPIOHEN | RCC_AHB1ENR_GPIOIEN;
  (void)RCC->AHB1ENR;
}

static inline void pad_mode(GPIO_TypeDef *port, unsigned pin, unsigned mode, unsigned pull) {
  port->PUPDR = (port->PUPDR & ~(3u << (pin * 2))) | (pull << (pin * 2));
  port->MODER = (port->MODER & ~(3u << (pin * 2))) | (mode << (pin * 2));
}

static inline void pad_af(GPIO_TypeDef *port, unsigned pin, unsigned af, unsigned pull) {
  volatile uint32_t *afr = &port->AFR[pin / 8];
  *afr = (*afr & ~(15u << ((pin % 8) * 4))) | (af << ((pin % 8) * 4));
  port->OSPEEDR |= 3u << (pin * 2);
  pad_mode(port, pin, 2, pull);
}

static inline void pad_output(GPIO_TypeDef *port, unsigned pin) {
  port->BSRR = 1u << (pin + 16);
  pad_mode(port, pin, 1, PULL_NONE);
}

static inline void pad_write(GPIO_TypeDef *port, unsigned pin, int on) {
  port->BSRR = on ? 1u << pin : 1u << (pin + 16);
}

static inline int pad_read(GPIO_TypeDef *port, unsigned pin) {
  return (port->IDR >> pin) & 1u;
}

static inline void clock_216mhz_apb1_4_apb2_2(void) {
  RCC->CR |= RCC_CR_HSEON;
  while (!(RCC->CR & RCC_CR_HSERDY)) {
  }
  RCC->APB1ENR |= RCC_APB1ENR_PWREN;
  (void)RCC->APB1ENR;
  PWR->CR1 |= PWR_CR1_VOS;
  RCC->PLLCFGR = (4u << RCC_PLLCFGR_PLLM_Pos) | (216u << RCC_PLLCFGR_PLLN_Pos) | (0u << RCC_PLLCFGR_PLLP_Pos) | RCC_PLLCFGR_PLLSRC_HSE | (9u << RCC_PLLCFGR_PLLQ_Pos);
  RCC->CR |= RCC_CR_PLLON;
  PWR->CR1 |= PWR_CR1_ODEN;
  while (!(PWR->CSR1 & PWR_CSR1_ODRDY)) {
  }
  PWR->CR1 |= PWR_CR1_ODSWEN;
  while (!(PWR->CSR1 & PWR_CSR1_ODSWRDY)) {
  }
  while (!(RCC->CR & RCC_CR_PLLRDY)) {
  }
  FLASH->ACR = FLASH_ACR_LATENCY_7WS;
  RCC->CFGR = (RCC->CFGR & ~(RCC_CFGR_PPRE1 | RCC_CFGR_PPRE2 | RCC_CFGR_HPRE)) | RCC_CFGR_PPRE1_DIV4 | RCC_CFGR_PPRE2_DIV2;
  RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_SW) | RCC_CFGR_SW_PLL;
  while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_PLL) {
  }
}
