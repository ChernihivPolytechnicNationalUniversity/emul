#include "stm32f746xx.h"

enum { CONFIGURE = 1, SAMPLE, UPDATE, CLEAR, DISABLE, STOP, GATE, RESET, QUADRATURE, PULSES, TRIGGER, RTC_ALARM };
enum { STOP_MASKED, STOP_WFI_INTERRUPT, STOP_WFE_EVENT, STOP_WFE_MASKED };

volatile struct {
  uint32_t request;
  uint32_t applied;
  uint32_t command;
  uint32_t cfgr;
  uint32_t source;
  uint32_t arr;
  uint32_t cmp;
  uint32_t start;
  uint32_t ier;
  uint32_t argument;
  uint32_t ready;
  uint32_t count;
  uint32_t flags;
  uint32_t irq_flags;
  uint32_t irq_count[7];
  uint32_t woke;
  uint32_t timeouts;
  uint32_t irq_wakeup_pending;
  uint32_t wakeup_pending;
} bench;

extern const uintptr_t g_pfnVectors[];
static uintptr_t vectors[128] __attribute__((aligned(1024)));

void SysTick_Handler(void) {}

static void lptim_interrupt(void) {
  uint32_t flags = LPTIM1->ISR & LPTIM1->IER;
  bench.irq_flags |= flags;
  bench.irq_wakeup_pending |= EXTI->PR & EXTI_PR_PR23;
  for (uint32_t i = 0; i < 7; i++) if (flags & (1u << i)) bench.irq_count[i]++;
  LPTIM1->ICR = flags;
  EXTI->PR = EXTI_PR_PR23;
}

static void wait_cycles(uint32_t cycles) {
  uint32_t start = DWT->CYCCNT;
  while ((uint32_t)(DWT->CYCCNT - start) < cycles) {}
}

static void wait_flags(uint32_t flags) {
  uint32_t start = DWT->CYCCNT;
  while ((LPTIM1->ISR & flags) != flags) {
    if ((uint32_t)(DWT->CYCCNT - start) > 1600000u) {
      bench.timeouts++;
      break;
    }
  }
}

static void alternate(GPIO_TypeDef *gpio, uint32_t pin) {
  gpio->MODER = (gpio->MODER & ~(3u << (2u * pin))) | (2u << (2u * pin));
  gpio->AFR[pin / 8] = (gpio->AFR[pin / 8] & ~(15u << (4u * (pin % 8)))) | (3u << (4u * (pin % 8)));
}

static void configure(void) {
  LPTIM1->CR = 0;
  RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_PPRE1) | RCC_CFGR_PPRE1_DIV4;
  RCC->DCKCFGR2 = (RCC->DCKCFGR2 & ~RCC_DCKCFGR2_LPTIM1SEL) | (bench.source << RCC_DCKCFGR2_LPTIM1SEL_Pos);
  if (bench.source == 3) while (!(RCC->BDCR & RCC_BDCR_LSERDY)) {}
  LPTIM1->CFGR = bench.cfgr;
  LPTIM1->IER = bench.ier;
  LPTIM1->ICR = 0x7fu;
  bench.irq_flags = 0;
  bench.irq_wakeup_pending = 0;
  for (uint32_t i = 0; i < 7; i++) bench.irq_count[i] = 0;
  LPTIM1->CR = LPTIM_CR_ENABLE;
  LPTIM1->ARR = bench.arr;
  LPTIM1->CMP = bench.cmp;
  if (!(bench.cfgr & LPTIM_CFGR_CKSEL)) {
    if (bench.ier & (LPTIM_IER_ARROKIE | LPTIM_IER_CMPOKIE)) wait_cycles(16000);
    else wait_flags(LPTIM_ISR_ARROK | LPTIM_ISR_CMPOK);
  }
  LPTIM1->CR = LPTIM_CR_ENABLE | bench.start;
}

static void drive_inputs(uint32_t value) {
  GPIOC->BSRR = ((7u & ~value) << 22) | ((value & 7u) << 6);
  wait_cycles(1600);
}

static void command(void) {
  switch (bench.command) {
    case CONFIGURE:
      configure();
      break;
    case UPDATE:
      LPTIM1->ARR = bench.arr;
      LPTIM1->CMP = bench.cmp;
      break;
    case CLEAR:
      LPTIM1->ICR = bench.argument;
      break;
    case DISABLE:
      LPTIM1->CR = 0;
      break;
    case STOP:
      EXTI->RTSR |= EXTI_RTSR_TR23;
      if (bench.argument == STOP_WFI_INTERRUPT) EXTI->IMR |= EXTI_IMR_MR23;
      else EXTI->IMR &= ~EXTI_IMR_MR23;
      if (bench.argument == STOP_WFE_EVENT) EXTI->EMR |= EXTI_EMR_MR23;
      else EXTI->EMR &= ~EXTI_EMR_MR23;
      SysTick->CTRL = 0;
      PWR->CR1 &= ~PWR_CR1_PDDS;
      SCB->SCR |= SCB_SCR_SLEEPDEEP_Msk;
      __DSB();
      if (bench.argument == STOP_WFE_EVENT || bench.argument == STOP_WFE_MASKED) {
        __SEV();
        __WFE();
        __WFE();
      } else {
        __WFI();
      }
      SCB->SCR &= ~SCB_SCR_SLEEPDEEP_Msk;
      bench.woke++;
      SysTick->CTRL = 7;
      break;
    case GATE:
      RCC->APB1ENR ^= RCC_APB1ENR_LPTIM1EN;
      break;
    case RESET:
      RCC->APB1RSTR |= RCC_APB1RSTR_LPTIM1RST;
      RCC->APB1RSTR &= ~RCC_APB1RSTR_LPTIM1RST;
      break;
    case QUADRATURE: {
      const uint32_t forward[] = {1, 3, 2, 0};
      const uint32_t reverse[] = {2, 3, 1, 0};
      const uint32_t *sequence = bench.argument & 0x80000000u ? reverse : forward;
      for (uint32_t i = 0; i < (bench.argument & 0xffffu); i++) for (uint32_t edge = 0; edge < 4; edge++) drive_inputs(sequence[edge]);
      break;
    }
    case PULSES:
      for (uint32_t i = 0; i < bench.argument; i++) {
        drive_inputs(1);
        drive_inputs(0);
      }
      break;
    case TRIGGER:
      drive_inputs(bench.argument ? 4 : 0);
      break;
    case RTC_ALARM:
      RCC->BDCR |= (3u << RCC_BDCR_RTCSEL_Pos) | RCC_BDCR_RTCEN;
      RCC->CSR |= RCC_CSR_LSION;
      RCC->BDCR = (RCC->BDCR & ~RCC_BDCR_RTCSEL) | (2u << RCC_BDCR_RTCSEL_Pos);
      RTC->WPR = 0xcau;
      RTC->WPR = 0x53u;
      RTC->ISR = RTC_ISR_INIT;
      RTC->PRER = 31;
      RTC->ALRMAR = 0x80808080u;
      RTC->ALRMBR = 0x80808080u;
      RTC->CR = bench.argument ? RTC_CR_ALRBE : RTC_CR_ALRAE;
      RTC->ISR = 0;
      RTC->WPR = 0xffu;
      break;
    case SAMPLE:
      break;
  }
  bench.count = LPTIM1->CNT;
  bench.flags = LPTIM1->ISR;
  bench.wakeup_pending = EXTI->PR & EXTI_PR_PR23;
}

int main(void) {
  for (uint32_t i = 0; i < 107; i++) vectors[i] = g_pfnVectors[i];
  vectors[16 + LPTIM1_IRQn] = (uintptr_t)lptim_interrupt;
  SCB->VTOR = (uint32_t)vectors;
  NVIC_EnableIRQ(LPTIM1_IRQn);
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
  RCC->AHB1ENR |= RCC_AHB1ENR_GPIOCEN | RCC_AHB1ENR_GPIODEN | RCC_AHB1ENR_GPIOEEN | RCC_AHB1ENR_GPIOGEN | RCC_AHB1ENR_GPIOHEN;
  RCC->APB1ENR |= RCC_APB1ENR_LPTIM1EN | RCC_APB1ENR_PWREN;
  PWR->CR1 |= PWR_CR1_DBP;
  RCC->CSR |= RCC_CSR_LSION;
  RCC->BDCR |= RCC_BDCR_LSEON;
  alternate(GPIOD, 12);
  alternate(GPIOD, 13);
  alternate(GPIOG, 12);
  alternate(GPIOG, 13);
  alternate(GPIOG, 14);
  alternate(GPIOE, 0);
  alternate(GPIOE, 1);
  alternate(GPIOH, 2);
  GPIOC->MODER = (GPIOC->MODER & ~(0x3fu << 12)) | (0x15u << 12);
  SysTick->LOAD = 15999;
  SysTick->VAL = 0;
  SysTick->CTRL = 7;
  bench.ready = 1;
  for (;;) {
    if (bench.request != bench.applied) {
      command();
      bench.applied = bench.request;
    }
    __WFI();
  }
}
