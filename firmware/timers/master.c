#include "bench.h"

enum { SMS_GATED = 5u, SMS_EXTERNAL_CLOCK = 7u };
enum { TS_ITR0 = 0u << TIM_SMCR_TS_Pos, TS_ITR1 = 1u << TIM_SMCR_TS_Pos, TS_ITR2 = 2u << TIM_SMCR_TS_Pos };
enum { MMS_RESET = 0u, MMS_UPDATE = 2u << TIM_CR2_MMS_Pos, MMS_COMPARE_PULSE = 3u << TIM_CR2_MMS_Pos, MMS_OC2REF = 5u << TIM_CR2_MMS_Pos };
enum { MMS2_OC4REF_EDGES = 10u << TIM_CR2_MMS2_Pos };
enum { PWM1 = 6u };
enum { SOFTWARE_RESETS = 5, UPDATE_ARR = 99, COMPARE_ARR = 399, COMPARE_AT = 10, OC_ARR = 99, OC_HIGH = 25, MASTER_ARR = 999, OC2_HIGH = 300, OC4_HIGH = 600 };

volatile struct {
  uint32_t ready;
} master_bench;

static void reset_pulses_into_tim3(void) {
  TIM3->ARR = 0xffff;
  TIM3->SMCR = TS_ITR1 | SMS_EXTERNAL_CLOCK;
  TIM3->CR1 = TIM_CR1_CEN;
  TIM2->CR2 = MMS_RESET;
  for (int i = 0; i < SOFTWARE_RESETS; i++) TIM2->EGR = TIM_EGR_UG;
}

static void update_pulses_into_tim12(void) {
  TIM12->ARR = 0xffff;
  TIM12->SMCR = TS_ITR0 | SMS_EXTERNAL_CLOCK;
  TIM12->CR1 = TIM_CR1_CEN;
  TIM4->ARR = UPDATE_ARR;
  TIM4->CR2 = MMS_UPDATE;
}

static void compare_pulses_into_tim1(void) {
  TIM1->ARR = 0xffff;
  TIM1->SMCR = TS_ITR0 | SMS_EXTERNAL_CLOCK;
  TIM1->CR1 = TIM_CR1_CEN;
  TIM5->ARR = COMPARE_ARR;
  TIM5->CCR1 = COMPARE_AT;
  TIM5->CR2 = MMS_COMPARE_PULSE;
}

static void tim10_oc_gates_tim9(void) {
  TIM9->ARR = 0xffff;
  TIM9->SMCR = TS_ITR2 | SMS_GATED;
  TIM9->CR1 = TIM_CR1_CEN;
  TIM10->ARR = OC_ARR;
  TIM10->CCR1 = OC_HIGH;
  TIM10->CCMR1 = PWM1 << TIM_CCMR1_OC1M_Pos;
}

static void tim8_trigger_outputs(void) {
  TIM8->ARR = MASTER_ARR;
  TIM8->CCR2 = OC2_HIGH;
  TIM8->CCR4 = OC4_HIGH;
  TIM8->CCMR1 = PWM1 << TIM_CCMR1_OC2M_Pos;
  TIM8->CCMR2 = PWM1 << TIM_CCMR2_OC4M_Pos;
  TIM8->CR2 = MMS_OC2REF | MMS2_OC4REF_EDGES;
}

static void unmodelled_writes(void) {
  TIM13->DCR = (1u << TIM_DCR_DBL_Pos) | 13u;
  TIM13->CCMR1 = TIM_CCMR1_OC1M_3;
  TIM2->OR = 1u << TIM_OR_ITR1_RMP_Pos;
}

int main(void) {
  vectors_install();
  ports_on();
  RCC->APB1ENR |= RCC_APB1ENR_TIM2EN | RCC_APB1ENR_TIM3EN | RCC_APB1ENR_TIM4EN | RCC_APB1ENR_TIM5EN | RCC_APB1ENR_TIM12EN | RCC_APB1ENR_TIM13EN;
  RCC->APB2ENR |= RCC_APB2ENR_TIM1EN | RCC_APB2ENR_TIM8EN | RCC_APB2ENR_TIM9EN | RCC_APB2ENR_TIM10EN;
  (void)RCC->APB2ENR;
  reset_pulses_into_tim3();
  update_pulses_into_tim12();
  compare_pulses_into_tim1();
  tim10_oc_gates_tim9();
  tim8_trigger_outputs();
  unmodelled_writes();
  TIM4->CR1 = TIM_CR1_CEN;
  TIM5->CR1 = TIM_CR1_CEN;
  TIM10->CR1 = TIM_CR1_CEN;
  TIM8->CR1 = TIM_CR1_CEN;
  master_bench.ready = 1;
  for (;;) __WFI();
}
