/* Integer arithmetic at 32-bit through SDCC's pic14 code and its support library:
   carries across bytes, multiply, divide, shifts, comparisons. Unsigned arithmetic only where the
   host's wider int would change the meaning. */
#include "test.h"

static uint32_t lcg(uint32_t *s) {
  *s = *s * 1664525ul + 1013904223ul;
  return *s;
}

static uint32_t seed = 12345ul;

static uint32_t alu32(void) {
  uint32_t acc = 0;
  uint16_t i;
  for (i = 0; i < 20; i++) {
    uint32_t a = lcg(&seed), b = lcg(&seed) >> (i & 31);
    acc = acc * 29u + (a + b) + (a - b) + a * b;
    if (b) acc = acc * 29u + a / b + a % b;
    acc = acc * 29u + (a << (i & 31)) + (a >> (i & 31)) + (uint32_t)((int32_t)a >> (i & 31));
    acc = acc * 29u + (a < b) + 2u * ((int32_t)a < (int32_t)b);
  }
  return acc;
}

uint8_t run_test(volatile uint32_t *out) {
  out[1] = alu32();
  return 1;
}
