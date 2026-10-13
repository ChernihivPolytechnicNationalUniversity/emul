#include <stdint.h>

volatile struct {
  uint32_t done;
  uint32_t idcode;
  uint32_t values[32];
} bench;

int main(void) {
  volatile uint32_t *backup = (volatile uint32_t *)0x40002850u;
  *(volatile uint32_t *)0x40023840u |= 1u << 28;
  *(volatile uint32_t *)0x40007000u |= 1u << 8;
  bench.idcode = *(volatile uint32_t *)0xe0042000u;
  for (uint32_t i = 0; i < 32; i++) {
    backup[i] = 0xa5c30000u | (i << 8) | (31u - i);
    bench.values[i] = backup[i];
  }
  bench.done = 1;
  for (;;) __asm volatile("wfi");
}
