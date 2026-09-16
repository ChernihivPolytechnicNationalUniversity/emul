/* One result per operation, to pin down which instruction disagrees with the host. */
#include "test.h"

static uint32_t lcg(uint32_t *s) { *s = *s * 1664525u + 1013904223u; return *s; }

int run_test(volatile uint32_t *out) {
  int n = 0;
  uint32_t seed = OPAQUE(12345u);
  for (int i = 0; i < 3; i++) {
    uint32_t a = lcg(&seed), b = lcg(&seed);
    int32_t sa = (int32_t)a, sb = (int32_t)b;
    uint32_t sh = b & 31, sh2 = (b >> 5) & 31;
    out[++n] = a; out[++n] = b;
    out[++n] = a + b;
    out[++n] = a - b;
    out[++n] = a * b;
    out[++n] = (uint32_t)(sa * sb);
    out[++n] = b ? a / b : 0; out[++n] = b ? a % b : 0;
    out[++n] = sb ? (uint32_t)(sa / sb) : 0; out[++n] = sb ? (uint32_t)(sa % sb) : 0;
    out[++n] = a << sh;
    out[++n] = a >> sh;
    out[++n] = (uint32_t)(sa >> sh);
    out[++n] = (a >> sh2) | (a << ((32 - sh2) & 31));
    out[++n] = (uint32_t)__builtin_clz(a | 1);
    out[++n] = (uint32_t)__builtin_popcount(b);
    out[++n] = __builtin_bswap32(a);
    out[++n] = __builtin_bswap16((uint16_t)b);
    out[++n] = (uint32_t)(int8_t)a + (uint32_t)(uint8_t)b + (uint32_t)(int16_t)b + (uint32_t)(uint16_t)a;
    out[++n] = (a >> 7) & 0x1FF;
    out[++n] = (uint32_t)(((int32_t)(a << 3)) >> 20);
    out[++n] = (a & ~0xFF00u) | ((b << 8) & 0xFF00u);
    out[++n] = a > b ? a : b;
    out[++n] = sa < sb ? 1u : 0u;
    out[++n] = (a & 0x80000000u) ? 3u : 5u;
    uint64_t wide = (uint64_t)a * b;
    out[++n] = (uint32_t)(wide >> 32); out[++n] = (uint32_t)wide;
    int64_t swide = (int64_t)sa * sb;
    out[++n] = (uint32_t)(swide >> 32); out[++n] = (uint32_t)swide;
    uint64_t sum64 = ((uint64_t)a << 32 | b) + ((uint64_t)b << 32 | a);
    out[++n] = (uint32_t)(sum64 >> 32); out[++n] = (uint32_t)sum64;
    int64_t diff64 = ((int64_t)sa << 32 | b) - ((int64_t)sb << 32 | a);
    out[++n] = (uint32_t)(diff64 >> 32); out[++n] = (uint32_t)diff64;
    uint64_t sh64 = ((uint64_t)a << 32 | b) >> (sh & 63);
    out[++n] = (uint32_t)(sh64 >> 32); out[++n] = (uint32_t)sh64;
    out[++n] = a ? (uint32_t)((((uint64_t)b << 32) | a) / a) : 0;
  }
  return n;
}
