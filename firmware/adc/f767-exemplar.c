#include "bench.h"

enum { SAMPLES = 32, PA3 = 3, PA4 = 4, MODE_ANALOG = 3, CHANNEL_IN3 = 3, CHANNEL_IN4 = 4, CHANNEL_VREFINT = 17, SMP_15_CYCLES = 1 };
enum { EXTSEL_TIM5_TRGO = 4, JEXTSEL_TIM5_TRGO = 12, MMS_UPDATE = 2, OC_TOGGLE = 3, KEEP_9_BITS = 3, ALL_COLLECTED = 0xffff };
enum { TIM5_TICK_PRESCALER = 95, TIM5_PERIOD = 499 };

volatile struct {
  uint32_t flag;
  uint32_t conversions;
  uint32_t timer_events;
  uint32_t vrefint;
  uint32_t averages;
  uint32_t mean_in3;
  uint32_t mean_in4;
  uint16_t in3[SAMPLES];
  uint16_t in4[SAMPLES];
} exemplar;

static uint32_t next;
static uint32_t rank;

static void clock_96mhz_from_the_8mhz_crystal(void) {
  RCC->CR |= RCC_CR_HSEON;
  while (!(RCC->CR & RCC_CR_HSERDY)) {
  }
  RCC->APB1ENR |= RCC_APB1ENR_PWREN;
  (void)RCC->APB1ENR;
  PWR->CR1 = (PWR->CR1 & ~PWR_CR1_VOS) | PWR_CR1_VOS_0;
  RCC->PLLCFGR = (4u << RCC_PLLCFGR_PLLM_Pos) | (96u << RCC_PLLCFGR_PLLN_Pos) | (0u << RCC_PLLCFGR_PLLP_Pos) | RCC_PLLCFGR_PLLSRC_HSE | (4u << RCC_PLLCFGR_PLLQ_Pos);
  RCC->CR |= RCC_CR_PLLON;
  PWR->CR1 |= PWR_CR1_ODEN;
  while (!(PWR->CSR1 & PWR_CSR1_ODRDY)) {
  }
  PWR->CR1 |= PWR_CR1_ODSWEN;
  while (!(PWR->CSR1 & PWR_CSR1_ODSWRDY)) {
  }
  while (!(RCC->CR & RCC_CR_PLLRDY)) {
  }
  FLASH->ACR = FLASH_ACR_LATENCY_3WS;
  RCC->CFGR = (RCC->CFGR & ~(RCC_CFGR_PPRE1 | RCC_CFGR_PPRE2 | RCC_CFGR_HPRE)) | RCC_CFGR_PPRE1_DIV2;
  RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_SW) | RCC_CFGR_SW_PLL;
  while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_PLL) {
  }
}

static void conversion_complete(void) {
  exemplar.vrefint = ADC1->DR;
  exemplar.conversions++;
  if (exemplar.flag == ALL_COLLECTED) return;
  if (rank == 0) exemplar.in3[next] = (uint16_t)(ADC1->JDR1 >> KEEP_9_BITS);
  else exemplar.in4[next++] = (uint16_t)(ADC1->JDR2 >> KEEP_9_BITS);
  rank ^= 1;
  if (next == SAMPLES) {
    next = 0;
    exemplar.flag = ALL_COLLECTED;
  }
}

static void adc_irq(void) {
  if (ADC1->SR & ADC_SR_EOC) conversion_complete();
  ADC1->SR = ~(ADC_SR_EOC | ADC_SR_JEOC | ADC_SR_STRT | ADC_SR_JSTRT);
}

static void tim5_irq(void) {
  if (TIM5->SR & TIM_SR_CC1IF) exemplar.timer_events++;
  TIM5->SR = ~TIM_SR_CC1IF;
}

int main(void) {
  clock_96mhz_from_the_8mhz_crystal();
  ports_on();
  vectors_install();
  RCC->APB2ENR |= RCC_APB2ENR_ADC1EN;
  RCC->APB1ENR |= RCC_APB1ENR_TIM5EN;
  (void)RCC->APB1ENR;
  pad_mode(GPIOA, PA3, MODE_ANALOG, PULL_NONE);
  pad_mode(GPIOA, PA4, MODE_ANALOG, PULL_NONE);
  ADC123_COMMON->CCR = ADC_CCR_ADCPRE_0 | ADC_CCR_ADCPRE_1 | ADC_CCR_TSVREFE;
  ADC1->CR1 = ADC_CR1_SCAN | ADC_CR1_EOCIE;
  ADC1->SMPR1 = SMP_15_CYCLES << ADC_SMPR1_SMP17_Pos;
  ADC1->SMPR2 = (SMP_15_CYCLES << ADC_SMPR2_SMP3_Pos) | (SMP_15_CYCLES << ADC_SMPR2_SMP4_Pos);
  ADC1->SQR1 = 0;
  ADC1->SQR3 = CHANNEL_VREFINT;
  ADC1->JSQR = (1u << ADC_JSQR_JL_Pos) | (CHANNEL_IN3 << ADC_JSQR_JSQ3_Pos) | (CHANNEL_IN4 << ADC_JSQR_JSQ4_Pos);
  ADC1->CR2 = ADC_CR2_ADON | ADC_CR2_EOCS | ADC_CR2_EXTEN_0 | (EXTSEL_TIM5_TRGO << ADC_CR2_EXTSEL_Pos) | ADC_CR2_JEXTEN_0 | (JEXTSEL_TIM5_TRGO << ADC_CR2_JEXTSEL_Pos);
  irq_attach(ADC_IRQn, adc_irq);
  TIM5->PSC = TIM5_TICK_PRESCALER;
  TIM5->ARR = TIM5_PERIOD;
  TIM5->CCMR1 = OC_TOGGLE << TIM_CCMR1_OC1M_Pos;
  TIM5->CCR1 = 0;
  TIM5->CR2 = MMS_UPDATE << TIM_CR2_MMS_Pos;
  TIM5->SMCR = TIM_SMCR_MSM;
  TIM5->DIER = TIM_DIER_CC1IE;
  irq_attach(TIM5_IRQn, tim5_irq);
  TIM5->EGR = TIM_EGR_UG;
  TIM5->SR = 0;
  TIM5->CR1 = TIM_CR1_CEN;
  for (;;) {
    if (exemplar.flag != ALL_COLLECTED) {
      __WFI();
      continue;
    }
    uint32_t sum3 = 0;
    uint32_t sum4 = 0;
    for (uint32_t i = 0; i < SAMPLES; i++) {
      sum3 += exemplar.in3[i];
      sum4 += exemplar.in4[i];
    }
    exemplar.mean_in3 = sum3 / SAMPLES;
    exemplar.mean_in4 = sum4 / SAMPLES;
    exemplar.averages++;
    exemplar.flag = 0;
  }
}
