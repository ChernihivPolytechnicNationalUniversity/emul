/* Sleep and wake: WFI must return on each SysTick, and only then; WFE likewise. */
#include "test.h"

#ifdef HOST
int run_test(volatile uint32_t *out) {
  int n = 0;
  out[++n] = 10; out[++n] = 10; out[++n] = 1;   /* ticks, wakeups, slept most of the time */
  out[++n] = 5;  out[++n] = 1;                  /* wfe wakeups, pending event cleared */
  out[++n] = 3;                                  /* woke with interrupts masked, tick still pending */
  return n;
}
#else
#define SYST_CSR  (*(volatile uint32_t *)0xE000E010)
#define SYST_RVR  (*(volatile uint32_t *)0xE000E014)
#define SYST_CVR  (*(volatile uint32_t *)0xE000E018)
#define SCB_ICSR  (*(volatile uint32_t *)0xE000ED04)
#define SCB_SCR   (*(volatile uint32_t *)0xE000ED10)
#define DWT_CTRL  (*(volatile uint32_t *)0xE0001000)
#define DWT_CYCCNT (*(volatile uint32_t *)0xE0001004)
#define DEMCR     (*(volatile uint32_t *)0xE000EDFC)

static volatile uint32_t ticks;
void SysTick_Handler(void) { ticks++; }

int run_test(volatile uint32_t *out) {
  int n = 0;
  DEMCR |= 1u << 24;
  DWT_CTRL |= 1;

  /* 1. Ten WFIs, each woken by a 10 000-cycle tick. */
  SYST_RVR = 9999;
  SYST_CVR = 0;
  SYST_CSR = 7;
  uint32_t wakeups = 0;
  uint32_t busy = 0, t0 = DWT_CYCCNT;
  while (ticks < 10) {
    uint32_t a = DWT_CYCCNT;
    __asm volatile("wfi");
    busy += 1;
    (void)a;
    wakeups++;
  }
  uint32_t elapsed = DWT_CYCCNT - t0;
  out[++n] = ticks;
  out[++n] = wakeups;
  out[++n] = elapsed > 90000 && elapsed < 110000;   /* ~10 ticks of 10 000 cycles: sleep did not stall time */

  /* 2. WFE with SEVONPEND: the tick becoming pending wakes it even with the interrupt masked. */
  SYST_CSR = 0;
  ticks = 0;
  SCB_SCR |= 1u << 4;          /* SEVONPEND */
  __asm volatile("cpsid i");
  SYST_CVR = 0;
  SYST_CSR = 7;
  uint32_t wfe = 0;
  for (int i = 0; i < 5; i++) {
    __asm volatile("wfe");     /* first returns immediately if the event register is set; either way… */
    while (!(SCB_ICSR & (1u << 26))) __asm volatile("wfe");
    SCB_ICSR = 1u << 25;       /* PENDSTCLR */
    wfe++;
  }
  out[++n] = wfe;
  out[++n] = (SCB_ICSR & (1u << 26)) == 0;

  /* 3. WFI with PRIMASK set still wakes on a pending interrupt, which is then taken on cpsie. */
  SYST_CSR = 0;
  ticks = 0;
  SYST_CVR = 0;
  SYST_CSR = 7;
  uint32_t woke = 0;
  for (int i = 0; i < 3; i++) {
    __asm volatile("wfi");
    woke++;
    __asm volatile("cpsie i; isb; cpsid i");
  }
  __asm volatile("cpsie i");
  SYST_CSR = 0;
  out[++n] = woke;
  return n;
}
#endif
