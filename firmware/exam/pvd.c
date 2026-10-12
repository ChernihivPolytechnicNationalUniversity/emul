#include "exam.h"

#define PLS_2V7 5u
#define PVD_EXTI_LINE (1u << 16)
#define PVD_IRQ 1u

static uint32_t vdd_below(void) { return (PWR_CSR1 & PWR_CSR1_PVDO) != 0u; }

void PVD_IRQHandler(void) {
  EXTI_PR = PVD_EXTI_LINE;
  uint32_t below = vdd_below();
  led1((int)below);
  put(below);
  results[0] = RESULTS_DONE | result_count;
}

int main(void) {
  RCC_APB1ENR |= RCC_APB1ENR_PWREN;
  led1_output();
  put(vdd_below());
  PWR_CR1 = (PWR_CR1 & ~PWR_CR1_PLS_MASK) | (PLS_2V7 << PWR_CR1_PLS_SHIFT) | PWR_CR1_PVDE;
  EXTI_RTSR |= PVD_EXTI_LINE;
  EXTI_FTSR |= PVD_EXTI_LINE;
  EXTI_IMR |= PVD_EXTI_LINE;
  NVIC_ISER0 = 1u << PVD_IRQ;
  put(vdd_below());
  results[0] = RESULTS_DONE | result_count;
  for (;;) __asm volatile("wfi");
}
