#include "bench.h"

enum { SMS_RESET = 4u, TS_ITR0 = 0u << TIM_SMCR_TS_Pos, TS_TI1FP1 = 5u << TIM_SMCR_TS_Pos };
enum { MMS_UPDATE = 2u << TIM_CR2_MMS_Pos };
enum { FILTER_CK_INT_N8 = 3u, PRESCALE_8 = 3u, TRC = 3u };
enum { TRC_PERIOD_TICKS = 1000 };

volatile struct {
  uint32_t ready;
  uint32_t width_period;
  uint32_t width_high;
  uint32_t width_count;
  uint32_t gap_period;
  uint32_t gap_low;
  uint32_t gap_count;
  uint32_t filtered_count;
  uint32_t filtered_at;
  uint32_t prescaled_count;
  uint32_t both_edges_count;
  uint32_t trc_count;
  uint32_t trc_last;
  uint32_t trc_delta;
} capture_bench;

static void tim2_width(void) {
  if (!(TIM2->SR & TIM_SR_CC1IF)) return;
  capture_bench.width_period = TIM2->CCR1;
  capture_bench.width_high = TIM2->CCR2;
  capture_bench.width_count++;
}

static void tim5_gap(void) {
  if (!(TIM5->SR & TIM_SR_CC1IF)) return;
  capture_bench.gap_period = TIM5->CCR1;
  capture_bench.gap_low = TIM5->CCR2;
  capture_bench.gap_count++;
}

static void tim3_filtered(void) {
  capture_bench.filtered_at = TIM3->CCR1;
  capture_bench.filtered_count++;
}

static void tim4_prescaled(void) {
  (void)TIM4->CCR1;
  capture_bench.prescaled_count++;
}

static void tim9_both_edges(void) {
  (void)TIM9->CCR1;
  capture_bench.both_edges_count++;
}

static void tim8_trc(void) {
  uint32_t now = TIM8->CCR1;
  if (capture_bench.trc_count) capture_bench.trc_delta = (now - capture_bench.trc_last) & 0xffff;
  capture_bench.trc_last = now;
  capture_bench.trc_count++;
}

static void pwm_input(TIM_TypeDef *tim, uint32_t period_edge_falling) {
  tim->ARR = 0xffffffff;
  tim->CCMR1 = TIM_CCMR1_CC1S_0 | TIM_CCMR1_CC2S_1;
  tim->CCER = TIM_CCER_CC1E | TIM_CCER_CC2E | (period_edge_falling ? TIM_CCER_CC1P : TIM_CCER_CC2P);
  tim->SMCR = TS_TI1FP1 | SMS_RESET;
  tim->CR1 = TIM_CR1_URS;
  tim->DIER = TIM_DIER_CC1IE;
  tim->CR1 |= TIM_CR1_CEN;
}

int main(void) {
  vectors_install();
  ports_on();
  RCC->APB1ENR |= RCC_APB1ENR_TIM2EN | RCC_APB1ENR_TIM3EN | RCC_APB1ENR_TIM4EN | RCC_APB1ENR_TIM5EN;
  RCC->APB2ENR |= RCC_APB2ENR_TIM1EN | RCC_APB2ENR_TIM8EN | RCC_APB2ENR_TIM9EN;
  (void)RCC->APB2ENR;

  pad_af(GPIOA, 15, 1, PULL_DOWN);
  irq_attach(TIM2_IRQn, tim2_width);
  pwm_input(TIM2, 0);

  pad_af(GPIOH, 10, 2, PULL_DOWN);
  irq_attach(TIM5_IRQn, tim5_gap);
  pwm_input(TIM5, 1);

  pad_af(GPIOB, 4, 2, PULL_DOWN);
  TIM3->CCMR1 = TIM_CCMR1_CC1S_0 | (FILTER_CK_INT_N8 << TIM_CCMR1_IC1F_Pos);
  TIM3->CCER = TIM_CCER_CC1E;
  TIM3->DIER = TIM_DIER_CC1IE;
  irq_attach(TIM3_IRQn, tim3_filtered);
  TIM3->CR1 = TIM_CR1_CEN;

  pad_af(GPIOD, 12, 2, PULL_DOWN);
  TIM4->CCMR1 = TIM_CCMR1_CC1S_0 | (PRESCALE_8 << TIM_CCMR1_IC1PSC_Pos);
  TIM4->CCER = TIM_CCER_CC1E;
  TIM4->DIER = TIM_DIER_CC1IE;
  irq_attach(TIM4_IRQn, tim4_prescaled);
  TIM4->CR1 = TIM_CR1_CEN;

  pad_af(GPIOE, 5, 3, PULL_DOWN);
  TIM9->CCMR1 = TIM_CCMR1_CC1S_0;
  TIM9->CCER = TIM_CCER_CC1E | TIM_CCER_CC1P | TIM_CCER_CC1NP;
  TIM9->DIER = TIM_DIER_CC1IE;
  irq_attach(TIM1_BRK_TIM9_IRQn, tim9_both_edges);
  TIM9->CR1 = TIM_CR1_CEN;

  TIM8->ARR = 0xffff;
  TIM8->SMCR = TS_ITR0;
  TIM8->CCMR1 = TRC << TIM_CCMR1_CC1S_Pos;
  TIM8->CCER = TIM_CCER_CC1E;
  TIM8->DIER = TIM_DIER_CC1IE;
  irq_attach(TIM8_CC_IRQn, tim8_trc);
  TIM8->CR1 = TIM_CR1_CEN;
  TIM1->ARR = TRC_PERIOD_TICKS - 1;
  TIM1->CR2 = MMS_UPDATE;
  TIM1->CR1 = TIM_CR1_CEN;

  capture_bench.ready = 1;
  for (;;) __WFI();
}
