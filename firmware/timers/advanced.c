#include "bench.h"

enum { PWM1 = 6u, PERIOD_TICKS = 1600, HIGH_TICKS = 400, DEAD_TIME_TICKS = 32 };
enum { BREAK_FILTER_CK_INT_N8 = 3u, LOCK_LEVEL_1 = 1u };

volatile struct {
  uint32_t ready;
  uint32_t breaks;
  uint32_t dead_time_after_lock;
} advanced_bench;

static void tim1_break(void) {
  if (TIM1->SR & (TIM_SR_BIF | TIM_SR_B2IF)) advanced_bench.breaks++;
  TIM1->SR = ~(TIM_SR_BIF | TIM_SR_B2IF);
}

int main(void) {
  vectors_install();
  ports_on();
  RCC->APB2ENR |= RCC_APB2ENR_TIM1EN;
  (void)RCC->APB2ENR;

  pad_af(GPIOE, 9, 1, PULL_NONE);
  pad_af(GPIOE, 8, 1, PULL_NONE);
  pad_af(GPIOE, 11, 1, PULL_NONE);
  pad_af(GPIOE, 10, 1, PULL_NONE);
  pad_af(GPIOE, 15, 1, PULL_DOWN);
  pad_af(GPIOE, 6, 1, PULL_DOWN);

  TIM1->ARR = PERIOD_TICKS - 1;
  TIM1->CCR1 = HIGH_TICKS;
  TIM1->CCR2 = HIGH_TICKS;
  TIM1->CCMR1 = (PWM1 << TIM_CCMR1_OC1M_Pos) | TIM_CCMR1_OC1PE | (PWM1 << TIM_CCMR1_OC2M_Pos) | TIM_CCMR1_OC2PE;
  TIM1->CCER = TIM_CCER_CC1E | TIM_CCER_CC1NE | TIM_CCER_CC2E;
  TIM1->CR2 = TIM_CR2_OIS1;
  TIM1->BDTR = DEAD_TIME_TICKS | TIM_BDTR_OSSI | TIM_BDTR_OSSR | TIM_BDTR_BKE | TIM_BDTR_BKP | TIM_BDTR_AOE | TIM_BDTR_MOE
    | (BREAK_FILTER_CK_INT_N8 << TIM_BDTR_BKF_Pos) | TIM_BDTR_BK2E | TIM_BDTR_BK2P | (LOCK_LEVEL_1 << TIM_BDTR_LOCK_Pos);
  TIM1->BDTR = (TIM1->BDTR & ~TIM_BDTR_DTG) | TIM_BDTR_MOE;
  advanced_bench.dead_time_after_lock = TIM1->BDTR & TIM_BDTR_DTG;
  TIM1->DIER = TIM_DIER_BIE;
  irq_attach(TIM1_BRK_TIM9_IRQn, tim1_break);
  TIM1->EGR = TIM_EGR_UG;
  TIM1->CR1 = TIM_CR1_ARPE | TIM_CR1_CEN;

  advanced_bench.ready = 1;
  for (;;) __WFI();
}
