/* Shared scaffolding for the PIC16 core tests: the same test runs on the host and on the emulated PIC16F648A.
   Results live at a fixed address in bank 1 so the test runner finds them without symbols. */
#ifndef TEST_H
#define TEST_H
#include <stdint.h>

#define N_RESULTS 6

/* Every test fills out[1..] and returns how many slots it used; out[0] is written by the harness. */
uint8_t run_test(volatile uint32_t *out);

#ifdef HOST
#include <stdio.h>
#define __code
static uint32_t results[N_RESULTS];
int main(void) {
  int n = run_test(results);
  for (int i = 1; i <= n; i++) printf("%d %08x\n", i, results[i]);
  return 0;
}
#else
#include <pic16f648a.h>
static __code uint16_t __at(_CONFIG) config = _FOSC_INTOSCIO & _WDT_OFF & _PWRTE_OFF & _MCLRE_ON & _BOREN_OFF & _LVP_OFF;
volatile __at(0xA0) uint32_t results[N_RESULTS];
void main(void) {
  uint8_t n = run_test(results);
  results[0] = 0xC0FFEE00ul | n;
  for (;;) {
  }
}
#endif
#endif
