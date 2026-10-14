/* Integer ALU at every width: carries through multi-byte add/sub/compare (ADC/SBC/CPC's Z rule),
   ADIW/SBIW, the hardware multiplier (MUL/MULS/MULSU, FMUL*), shifts and rotates, division. */
#include "test.h"

static uint32_t lcg(uint32_t *s) { *s = *s * 1664525ul + 1013904223ul; return *s; }

#ifdef HOST
static uint16_t fmul(uint8_t a, uint8_t b) { return (uint16_t)((uint32_t)a * b << 1); }
static int16_t fmuls(int8_t a, int8_t b) { return (int16_t)(uint16_t)((uint32_t)((int32_t)a * b) << 1); }
static int16_t fmulsu(int8_t a, uint8_t b) { return (int16_t)(uint16_t)((uint32_t)((int32_t)a * b) << 1); }
#else
static uint16_t fmul(uint8_t a, uint8_t b) { return __builtin_avr_fmul(a, b); }
static int16_t fmuls(int8_t a, int8_t b) { return __builtin_avr_fmuls(a, b); }
static int16_t fmulsu(int8_t a, uint8_t b) { return __builtin_avr_fmulsu(a, b); }
#endif

int16_t run_test(volatile uint32_t *out) {
  int16_t n = 0;
  uint32_t seed = OPAQUE(12345ul);

  /* 8-bit */
  uint32_t acc = 0;
  for (uint16_t i = 0; i < 300; i++) {
    uint32_t r = lcg(&seed);
    uint8_t a = (uint8_t)(r >> 8), b = (uint8_t)(r >> 16);
    int8_t sa = (int8_t)a, sb = (int8_t)b;
    acc = acc * 33u + (uint8_t)(a + b);
    acc = acc * 33u + (uint8_t)(a - b);
    acc = acc * 33u + (uint16_t)((uint16_t)a * b);
    acc = acc * 33u + (uint16_t)(int16_t)((int16_t)sa * sb);
    acc = acc * 33u + (uint16_t)(int16_t)((int16_t)sa * (int16_t)b);
    acc = acc * 33u + fmul(a, b) + (uint16_t)fmuls(sa, sb) + (uint16_t)fmulsu(sa, b);
    if (b) acc = acc * 33u + (uint8_t)(a / b) + (uint8_t)(a % b);
    if (sb && !(sa == -128 && sb == -1)) acc = acc * 33u + (uint8_t)(int8_t)(sa / sb) + (uint8_t)(int8_t)(sa % sb);
    acc = acc * 33u + (uint8_t)(a << (b & 7)) + (uint8_t)(a >> (b & 7)) + (uint8_t)(int8_t)(sa >> (b & 7));
    acc = acc * 33u + (uint8_t)((a << 4) | (a >> 4)) + (uint8_t)((a >> 1) | (a << 7));
    acc = acc * 33u + (a < b) + 2u * (sa < sb) + 4u * (a == b) + 8u * (sa >= sb) + 16u * (a > b);
    acc = acc * 33u + (uint8_t)~a + (uint8_t)-a + (uint8_t)(a & b) + (uint8_t)(a | b) + (uint8_t)(a ^ b);
  }
  out[++n] = acc;

  /* 16-bit */
  acc = 0;
  for (uint16_t i = 0; i < 300; i++) {
    uint32_t r = lcg(&seed), r2 = lcg(&seed);
    uint16_t a = (uint16_t)(r >> 8), b = (uint16_t)(r2 >> 12);
    int16_t sa = (int16_t)a, sb = (int16_t)b;
    acc = acc * 31u + (uint16_t)(a + b) + (uint16_t)(a - b);
    acc = acc * 31u + (uint16_t)(a + 37u) + (uint16_t)(a - 61u);
    acc = acc * 31u + (uint32_t)a * b;
    acc = acc * 31u + (uint32_t)((int32_t)sa * sb);
    acc = acc * 31u + (uint16_t)((uint32_t)a * b);
    if (b) acc = acc * 31u + a / b + a % b;
    if (sb && !(sa == INT16_MIN && sb == -1)) acc = acc * 31u + (uint16_t)(sa / sb) + (uint16_t)(sa % sb);
    acc = acc * 31u + (uint16_t)(a << (b & 15)) + (uint16_t)(a >> (b & 15)) + (uint16_t)(sa >> (b & 15));
    acc = acc * 31u + (a < b) + 2u * (sa < sb) + 4u * (a == b) + 8u * (sa >= sb) + 16u * (a <= b);
  }
  out[++n] = acc;

  /* 32-bit */
  acc = 0;
  for (uint16_t i = 0; i < 200; i++) {
    uint32_t a = lcg(&seed), b = lcg(&seed) >> (i & 15);
    int32_t sa = (int32_t)a, sb = (int32_t)b;
    acc = acc * 29u + (a + b) + (a - b);
    acc = acc * 29u + a * b;
    acc = acc * 29u + (uint32_t)((int64_t)sa * sb >> 16);
    if (b) acc = acc * 29u + a / b + a % b;
    if (sb && !(sa == INT32_MIN && sb == -1)) acc = acc * 29u + (uint32_t)(sa / sb) + (uint32_t)(sa % sb);
    acc = acc * 29u + (a << (b & 31)) + (a >> (b & 31)) + (uint32_t)(sa >> (b & 31));
    acc = acc * 29u + (a < b) + 2u * (sa < sb) + 4u * (a == b) + 8u * (sa >= sb);
    acc = acc * 29u + ((a >> 7) | (a << 25));
  }
  out[++n] = acc;

  /* 64-bit */
  uint64_t acc64 = 0;
  for (uint16_t i = 0; i < 60; i++) {
    uint64_t a = (uint64_t)lcg(&seed) << 32 | lcg(&seed), b = ((uint64_t)lcg(&seed) << 32 | lcg(&seed)) >> (i & 31);
    int64_t sa = (int64_t)a, sb = (int64_t)b;
    acc64 = acc64 * 3u + (a + b) + (a - b) + a * b;
    if (b) acc64 = acc64 * 3u + a / b + a % b;
    if (sb && !(sa == INT64_MIN && sb == -1)) acc64 = acc64 * 3u + (uint64_t)(sa / sb);
    acc64 = acc64 * 3u + (a << (i & 63)) + (a >> (i & 63)) + (uint64_t)(sa >> (i & 63));
    acc64 = acc64 * 3u + (a < b) + 2u * (sa < sb);
  }
  out[++n] = (uint32_t)acc64;
  out[++n] = (uint32_t)(acc64 >> 32);

  /* Edges: carries and overflow at the boundaries. */
  volatile uint8_t e8[] = {0, 1, 0x7f, 0x80, 0xfe, 0xff};
  acc = 0;
  for (uint8_t i = 0; i < 6; i++)
    for (uint8_t j = 0; j < 6; j++) {
      uint8_t a = e8[i], b = e8[j];
      acc = acc * 7u + (uint8_t)(a + b) + (uint8_t)(a - b) + (a < b) + 2u * ((int8_t)a < (int8_t)b) + 4u * (a == b);
      acc = acc * 7u + (uint16_t)((uint16_t)a * b);
    }
  out[++n] = acc;
  volatile uint16_t e16[] = {0, 1, 0x7fff, 0x8000, 0xfffe, 0xffff, 0x00ff, 0x0100};
  acc = 0;
  for (uint8_t i = 0; i < 8; i++)
    for (uint8_t j = 0; j < 8; j++) {
      uint16_t a = e16[i], b = e16[j];
      acc = acc * 7u + (uint16_t)(a + b) + (uint16_t)(a - b) + (a < b) + 2u * ((int16_t)a < (int16_t)b) + 4u * (a == b) + 8u * (a > b);
      acc = acc * 7u + (uint16_t)(a + 1u) + (uint16_t)(a - 1u) + (uint16_t)(a + 63u) + (uint16_t)(a - 63u);
    }
  out[++n] = acc;
  return n;
}
