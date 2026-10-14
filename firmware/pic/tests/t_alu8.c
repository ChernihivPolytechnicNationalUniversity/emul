/* Integer arithmetic at 8-bit through SDCC's pic14 code and its support library:
   carries across bytes, multiply, divide, shifts, comparisons. Unsigned arithmetic only where the
   host's wider int would change the meaning. */
#include "test.h"

static uint32_t lcg(uint32_t *s) {
  *s = *s * 1664525ul + 1013904223ul;
  return *s;
}

static uint32_t seed = 12345ul;

static uint32_t alu8(void) {
  uint32_t acc = 0;
  uint16_t i;
  for (i = 0; i < 60; i++) {
    uint32_t r = lcg(&seed);
    uint8_t a = (uint8_t)(r >> 8), b = (uint8_t)(r >> 16);
    int8_t sa = (int8_t)a, sb = (int8_t)b;
    acc = acc * 33u + (uint8_t)(a + b);
    acc = acc * 33u + (uint8_t)(a - b);
    acc = acc * 33u + (uint16_t)((uint16_t)a * (uint16_t)b);
    acc = acc * 33u + (uint16_t)(int16_t)((int16_t)sa * (int16_t)sb);
    if (b) acc = acc * 33u + (uint8_t)(a / b) + (uint8_t)(a % b);
    if (sb && !(sa == -128 && sb == -1)) acc = acc * 33u + (uint8_t)(int8_t)(sa / sb) + (uint8_t)(int8_t)(sa % sb);
    acc = acc * 33u + (uint8_t)(a << (b & 7)) + (uint8_t)(a >> (b & 7)) + (uint8_t)(int8_t)(sa >> (b & 7));
    acc = acc * 33u + (a < b) + 2u * (sa < sb) + 4u * (a == b) + 8u * (sa >= sb) + 16u * (a > b);
    acc = acc * 33u + (uint8_t)~a + (uint8_t)-a + (uint8_t)(a & b) + (uint8_t)(a | b) + (uint8_t)(a ^ b);
  }
  return acc;
}

uint8_t run_test(volatile uint32_t *out) {
  out[1] = alu8();
  return 1;
}
