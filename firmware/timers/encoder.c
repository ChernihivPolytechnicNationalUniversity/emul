#include "bench.h"

enum { ENCODER_TI1 = 1u, ENCODER_TI2 = 2u, ENCODER_BOTH = 3u };
enum { WRAPPING_ARR = 99 };

volatile struct {
  uint32_t ready;
  uint32_t wraps;
} encoder_bench;

static void tim8_update(void) {
  TIM8->SR = ~TIM_SR_UIF;
  encoder_bench.wraps++;
}

static void encoder(TIM_TypeDef *tim, uint32_t mode, uint32_t arr) {
  tim->ARR = arr;
  tim->CCMR1 = TIM_CCMR1_CC1S_0 | TIM_CCMR1_CC2S_0;
  tim->CCER = 0;
  tim->SMCR = mode;
  tim->CR1 = TIM_CR1_CEN;
}

int main(void) {
  vectors_install();
  ports_on();
  RCC->APB1ENR |= RCC_APB1ENR_TIM2EN | RCC_APB1ENR_TIM3EN | RCC_APB1ENR_TIM4EN;
  RCC->APB2ENR |= RCC_APB2ENR_TIM8EN;
  (void)RCC->APB2ENR;

  pad_af(GPIOB, 4, 2, PULL_DOWN);
  pad_af(GPIOB, 5, 2, PULL_DOWN);
  encoder(TIM3, ENCODER_BOTH, 0xffff);

  pad_af(GPIOD, 12, 2, PULL_DOWN);
  pad_af(GPIOD, 13, 2, PULL_DOWN);
  encoder(TIM4, ENCODER_TI1, 0xffff);

  pad_af(GPIOA, 15, 1, PULL_DOWN);
  pad_af(GPIOB, 3, 1, PULL_DOWN);
  encoder(TIM2, ENCODER_TI2, 0xffffffff);

  pad_af(GPIOC, 6, 3, PULL_DOWN);
  pad_af(GPIOC, 7, 3, PULL_DOWN);
  TIM8->DIER = TIM_DIER_UIE;
  irq_attach(TIM8_UP_TIM13_IRQn, tim8_update);
  encoder(TIM8, ENCODER_BOTH, WRAPPING_ARR);

  encoder_bench.ready = 1;
  for (;;) __WFI();
}
