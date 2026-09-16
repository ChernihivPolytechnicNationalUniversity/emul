/* Shared test scaffolding: the same test runs on the host and on the emulated target. */
#pragma once
#include <stdint.h>
#include <string.h>
#include <stdlib.h>

#define N_RESULTS 256

/* Every test fills out[1..] and returns how many slots it used; out[0] is written by the harness. */
int run_test(volatile uint32_t *out);

#ifdef HOST
#include <stdio.h>
static uint32_t results[N_RESULTS];
int main(void) {
  int n = run_test(results);
  for (int i = 1; i <= n; i++) printf("%d %08x\n", i, results[i]);
  return 0;
}
/* Prevent the host compiler from folding the whole test at compile time. */
#define OPAQUE(x) ({ __typeof__(x) _v = (x); __asm__("" : "+r"(_v)); _v; })
#else
__attribute__((section(".results"))) volatile uint32_t results[N_RESULTS];
int main(void) {
  int n = run_test(results);
  results[0] = 0xC0FFEE00u | (uint32_t)n;
  __asm volatile("bkpt 0");
  for (;;);
}
#define OPAQUE(x) ({ __typeof__(x) _v = (x); __asm__ volatile("" : "+r"(_v)); _v; })
#endif
