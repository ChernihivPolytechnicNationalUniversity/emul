#include "bench.h"

enum { SMS_RESET_TRIGGER = TIM_SMCR_SMS_3, SMS_TRIGGER = 6u, SMS_GATED = 5u, SMS_EXTERNAL_CLOCK = 7u };
enum { TS_ITR0 = 0u << TIM_SMCR_TS_Pos, TS_ITR2 = 2u << TIM_SMCR_TS_Pos, TS_TI1FP1 = 5u << TIM_SMCR_TS_Pos, TS_TI2FP2 = 6u << TIM_SMCR_TS_Pos };
enum { MMS_ENABLE = 1u << TIM_CR2_MMS_Pos, MMS_UPDATE = 2u << TIM_CR2_MMS_Pos };
enum { ETPS_DIV4 = 2u << TIM_SMCR_ETPS_Pos };
enum { ONE_SHOT_TICKS = 800, ONE_SHOT_DELAY_TICKS = 160 };

volatile struct {
  uint32_t ready;
  uint32_t gate_edges;
} slave_bench;

static void tim1_trigger(void) {
  TIM1->SR = ~TIM_SR_TIF;
  slave_bench.gate_edges++;
}

static void chain_tim3_into_tim4(void) {
  TIM4->ARR = 0xffff;
  TIM4->SMCR = TS_ITR2 | SMS_EXTERNAL_CLOCK;
  TIM4->CR1 = TIM_CR1_CEN;
  TIM3->ARR = 0xffff;
  TIM3->CR2 = MMS_UPDATE;
}

static void trigger_tim5_from_tim2(void) {
  TIM5->ARR = 0xffffffff;
  TIM5->SMCR = TS_ITR0 | SMS_TRIGGER;
  TIM2->ARR = 0xffffffff;
  TIM2->CR2 = MMS_ENABLE;
}

static void gate_tim1_on_pe9(void) {
  pad_af(GPIOE, 9, 1, PULL_DOWN);
  TIM1->ARR = 0xffff;
  TIM1->CCMR1 = TIM_CCMR1_CC1S_0;
  TIM1->CCER = TIM_CCER_CC1E;
  TIM1->SMCR = TS_TI1FP1 | SMS_GATED;
  TIM1->DIER = TIM_DIER_TIE;
  irq_attach(TIM1_TRG_COM_TIM11_IRQn, tim1_trigger);
  TIM1->CR1 = TIM_CR1_CEN;
}

static void count_falling_etr_on_tim8(void) {
  pad_af(GPIOI, 3, 3, PULL_UP);
  TIM8->ARR = 0xffff;
  TIM8->SMCR = TIM_SMCR_ECE | TIM_SMCR_ETP | ETPS_DIV4;
  TIM8->CR1 = TIM_CR1_CEN;
}

static void count_falling_ti2_on_tim9(void) {
  pad_af(GPIOE, 6, 3, PULL_UP);
  TIM9->ARR = 0xffff;
  TIM9->CCMR1 = TIM_CCMR1_CC2S_0;
  TIM9->CCER = TIM_CCER_CC2P;
  TIM9->SMCR = TS_TI2FP2 | SMS_EXTERNAL_CLOCK;
  TIM9->CR1 = TIM_CR1_CEN;
}

static void retriggerable_one_shot_on_tim12(void) {
  pad_af(GPIOH, 6, 9, PULL_DOWN);
  pad_af(GPIOH, 9, 9, PULL_NONE);
  TIM12->ARR = ONE_SHOT_TICKS - 1;
  TIM12->CCR2 = ONE_SHOT_DELAY_TICKS;
  TIM12->CCMR1 = TIM_CCMR1_CC1S_0 | (7u << TIM_CCMR1_OC2M_Pos);
  TIM12->CCER = TIM_CCER_CC2E;
  TIM12->SMCR = TS_TI1FP1 | SMS_RESET_TRIGGER;
  TIM12->CR1 = TIM_CR1_OPM;
}

int main(void) {
  vectors_install();
  ports_on();
  RCC->APB1ENR |= RCC_APB1ENR_TIM2EN | RCC_APB1ENR_TIM3EN | RCC_APB1ENR_TIM4EN | RCC_APB1ENR_TIM5EN | RCC_APB1ENR_TIM12EN;
  RCC->APB2ENR |= RCC_APB2ENR_TIM1EN | RCC_APB2ENR_TIM8EN | RCC_APB2ENR_TIM9EN;
  (void)RCC->APB2ENR;
  chain_tim3_into_tim4();
  trigger_tim5_from_tim2();
  gate_tim1_on_pe9();
  count_falling_etr_on_tim8();
  count_falling_ti2_on_tim9();
  retriggerable_one_shot_on_tim12();
  TIM3->CR1 = TIM_CR1_CEN;
  TIM2->CR1 = TIM_CR1_CEN;
  slave_bench.ready = 1;
  for (;;) __WFI();
}
