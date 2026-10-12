#include "exam.h"

#define BKPSRAM ((volatile uint32_t *)0x40024000u)
#define BKPSRAM_BYTES ((volatile uint8_t *)0x40024000u)
#define BKPSRAM_HALFWORDS ((volatile uint16_t *)0x40024000u)
#define BKPSRAM_LAST_WORD 1023u
#define MAGIC 0xB5A7C0DEu
#define WORD_MAGIC 0u
#define WORD_BOOTS 1u
#define WORD_WRITTEN_WITHOUT_DBP 3u
#define WORD_NARROW 4u
#define WAKEUP_PA0 1u
#define WAKEUP_RC_SETTLE_LOOPS 10000u

int main(void) {
  led1_output();
  RCC_AHB1ENR |= RCC_AHB1ENR_GPIOAEN;
  GPIOA_PUPDR = (GPIOA_PUPDR & ~3u) | 2u;
  put(BKPSRAM[WORD_MAGIC]);
  RCC_APB1ENR |= RCC_APB1ENR_PWREN;
  RCC_AHB1ENR |= RCC_AHB1ENR_BKPSRAMEN;
  uint32_t magic = BKPSRAM[WORD_MAGIC];
  uint32_t boots = BKPSRAM[WORD_BOOTS];
  put(magic);
  put(boots);
  put(BKPSRAM[BKPSRAM_LAST_WORD]);
  put(PWR_CSR1 & (PWR_CSR1_BRE | PWR_CSR1_BRR));
  led1(magic == MAGIC);

  BKPSRAM[WORD_WRITTEN_WITHOUT_DBP] = 0x1111u;
  put(BKPSRAM[WORD_WRITTEN_WITHOUT_DBP]);
  PWR_CR1 |= PWR_CR1_DBP;

  for (volatile uint32_t settle = 0; settle < WAKEUP_RC_SETTLE_LOOPS; settle++) {
  }
  if (GPIOA_IDR & WAKEUP_PA0) {
    PWR_CSR1 |= PWR_CSR1_BRE;
    while ((PWR_CSR1 & PWR_CSR1_BRR) == 0u) {
    }
  } else {
    PWR_CSR1 &= ~PWR_CSR1_BRE;
  }
  put(PWR_CSR1 & (PWR_CSR1_BRE | PWR_CSR1_BRR));

  BKPSRAM[WORD_MAGIC] = MAGIC;
  BKPSRAM[WORD_BOOTS] = (magic == MAGIC ? boots : 0u) + 1u;
  BKPSRAM[BKPSRAM_LAST_WORD] = ~MAGIC;
  BKPSRAM_BYTES[4u * WORD_NARROW] = 0xABu;
  BKPSRAM_HALFWORDS[2u * WORD_NARROW + 1u] = 0xCDEFu;
  put(BKPSRAM[WORD_NARROW]);
  results[0] = RESULTS_DONE | result_count;
  for (;;) __asm volatile("wfi");
}
