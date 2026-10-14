/* Integer arithmetic at 16-bit through SDCC's pic14 code and its support library:
   carries across bytes, multiply, divide, shifts, comparisons. Unsigned arithmetic only where the
   host's wider int would change the meaning. */
#include "test.h"

static uint32_t lcg(uint32_t *s) {
  *s = *s * 1664525ul + 1013904223ul;
  return *s;
}

static uint32_t seed = 12345ul;

static uint32_t alu16(void) {
  uint32_t acc = 0;
  uint16_t i;
  for (i = 0; i < 40; i++) {
    uint32_t r = lcg(&seed), r2 = lcg(&seed);
    uint16_t a = (uint16_t)(r >> 8), b = (uint16_t)(r2 >> 12);
    int16_t sa = (int16_t)a, sb = (int16_t)b;
    acc = acc * 31u + (uint16_t)(a + b) + (uint16_t)(a - b);
    acc = acc * 31u + (uint16_t)((uint32_t)a * b);
    if (b) acc = acc * 31u + (uint16_t)(a / b) + (uint16_t)(a % b);
    if (sb && !(sa == -32768 && sb == -1)) acc = acc * 31u + (uint16_t)(sa / sb) + (uint16_t)(sa % sb);
    acc = acc * 31u + (uint16_t)(a << (b & 15)) + (uint16_t)(a >> (b & 15)) + (uint16_t)(sa >> (b & 15));
    acc = acc * 31u + (a < b) + 2u * (sa < sb) + 4u * (a == b) + 8u * (sa >= sb);
  }
  return acc;
}

uint8_t run_test(volatile uint32_t *out) {
  out[1] = alu16();
  return 1;
}
