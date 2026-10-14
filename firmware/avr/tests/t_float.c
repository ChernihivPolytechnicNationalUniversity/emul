/* Single-precision float through avr-libc's soft-float routines (double is 32-bit on avr-gcc,
   so only float is used): arithmetic, conversions, comparisons and libm. */
#include "test.h"
#include <math.h>

static uint32_t bits(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }

int16_t run_test(volatile uint32_t *out) {
  int16_t n = 0;
  float x = OPAQUE(1.25f), y = OPAQUE(-3.5f);
  out[++n] = bits(x + y);
  out[++n] = bits(x - y);
  out[++n] = bits(x * y);
  out[++n] = bits(x / y);
  out[++n] = (uint32_t)(int32_t)(y * 1000.0f);
  out[++n] = (uint32_t)(x * 1e6f);
  out[++n] = bits((float)OPAQUE(123456789l));
  out[++n] = bits((float)OPAQUE(-42));
  out[++n] = (x < y) | (x > y) << 1 | (x == x) << 2 | (y <= y) << 3;
  float acc = 0.0f;
  for (int16_t i = 1; i <= 50; i++) acc += 1.0f / (float)i;
  out[++n] = bits(acc);
  out[++n] = bits(sqrtf(OPAQUE(2.0f)));
  float s = 0;
  for (int16_t i = 0; i < 16; i++) s = s * 0.5f + (float)i * 0.25f - 1.0f;
  out[++n] = bits(s);
  out[++n] = (uint32_t)(int32_t)lroundf(OPAQUE(2.5f) * 7.3f);
  out[++n] = (uint32_t)(int32_t)floorf(OPAQUE(-2.5f));
  out[++n] = (uint32_t)(int32_t)ceilf(OPAQUE(-2.5f));
  out[++n] = bits(fabsf(y));
  return n;
}
