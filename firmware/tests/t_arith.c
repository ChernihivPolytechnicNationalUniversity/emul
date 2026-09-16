/* Integer ALU: add/sub with flags, multiplies, divides, shifts, rotates, bit fields, sign/zero extension. */
#include "test.h"

static uint32_t lcg(uint32_t *s) { *s = *s * 1664525u + 1013904223u; return *s; }

int run_test(volatile uint32_t *out) {
  int n = 0;
  uint32_t seed = OPAQUE(12345u);
  uint32_t acc = 0;

  for (int i = 0; i < 64; i++) {
    uint32_t a = lcg(&seed), b = lcg(&seed);
    int32_t sa = (int32_t)a, sb = (int32_t)b;
    uint32_t sh = b & 31, sh2 = (b >> 5) & 31;
    acc += a + b;
    acc ^= a - b;
    acc += a * b;
    acc ^= (uint32_t)(sa * sb);
    if (b != 0) { acc += a / b; acc ^= a % b; }
    if (sb != 0 && !(sa == INT32_MIN && sb == -1)) { acc += (uint32_t)(sa / sb); acc ^= (uint32_t)(sa % sb); }
    acc += a << sh;
    acc ^= a >> sh;
    acc += (uint32_t)(sa >> sh);
    acc ^= (a >> sh2) | (a << ((32 - sh2) & 31));      /* ror */
    acc += (uint32_t)__builtin_clz(a | 1);
    acc ^= (uint32_t)__builtin_popcount(b);
    acc += __builtin_bswap32(a);
    acc ^= __builtin_bswap16((uint16_t)b);
    acc += (uint32_t)(int8_t)a + (uint32_t)(uint8_t)b + (uint32_t)(int16_t)b + (uint32_t)(uint16_t)a;
    acc ^= (a >> 7) & 0x1FF;                              /* ubfx */
    acc += (uint32_t)(((int32_t)(a << 3)) >> 20);         /* sbfx */
    acc ^= (a & ~0xFF00u) | ((b << 8) & 0xFF00u);         /* bfi */
    acc += a > b ? a : b;                                 /* cmp + it */
    acc ^= sa < sb ? 1u : 0u;
    acc += (a & 0x80000000u) ? 3u : 5u;
    uint64_t wide = (uint64_t)a * b;                     /* umull */
    acc ^= (uint32_t)(wide >> 32) + (uint32_t)wide;
    int64_t swide = (int64_t)sa * sb;                     /* smull */
    acc += (uint32_t)(swide >> 32) ^ (uint32_t)swide;
    uint64_t sum64 = ((uint64_t)a << 32 | b) + ((uint64_t)b << 32 | a);   /* adds/adc */
    acc ^= (uint32_t)(sum64 >> 32) + (uint32_t)sum64;
    int64_t diff64 = ((int64_t)sa << 32 | b) - ((int64_t)sb << 32 | a);  /* subs/sbc */
    acc += (uint32_t)(diff64 >> 32) ^ (uint32_t)diff64;
    uint64_t sh64 = ((uint64_t)a << 32 | b) >> (sh & 63);                /* 64-bit shift */
    acc ^= (uint32_t)sh64 + (uint32_t)(sh64 >> 32);
    if (a != 0) acc += (uint32_t)((((uint64_t)b << 32) | a) / a);         /* aeabi_uldivmod */
    out[++n] = acc;
  }

  /* Carry/overflow at the edges. */
  uint32_t x = OPAQUE(0xFFFFFFFFu), y = OPAQUE(1u);
  out[++n] = x + y;
  out[++n] = (x + y) < x;
  int32_t p = (int32_t)OPAQUE(0x7FFFFFFFu);
  out[++n] = (uint32_t)(p + (int32_t)y);
#ifndef HOST
  out[++n] = (uint32_t)(INT32_MIN / (int32_t)OPAQUE(-1));  /* stays INT32_MIN on ARM sdiv */
  {
    /* udiv by zero → 0 with DIV_0_TRP off. Written in asm: C division by zero is UB and gets folded. */
    uint32_t q;
    __asm volatile("udiv %0, %1, %2" : "=r"(q) : "r"(OPAQUE(7u)), "r"(OPAQUE(0u)));
    out[++n] = q == 0 ? 0xD1 : 0xD0;
  }
#else
  out[++n] = 0x80000000u;
  out[++n] = 0xD1;
#endif

  /* Saturation and DSP-ish ops via GCC builtins where available. */
#ifndef HOST
  int32_t s = (int32_t)OPAQUE(0x12345678);
  int32_t r;
  __asm volatile("ssat %0, #12, %1" : "=r"(r) : "r"(s));
  out[++n] = (uint32_t)r;
  __asm volatile("usat %0, #9, %1" : "=r"(r) : "r"(s));
  out[++n] = (uint32_t)r;
  __asm volatile("qadd %0, %1, %2" : "=r"(r) : "r"(s), "r"(s));
  out[++n] = (uint32_t)r;
  __asm volatile("rbit %0, %1" : "=r"(r) : "r"(s));
  out[++n] = (uint32_t)r;
  __asm volatile("uadd8 %0, %1, %2" : "=r"(r) : "r"(0xF0F0F0F0u), "r"(0x10101010u));
  out[++n] = (uint32_t)r;
  __asm volatile("smlabb %0, %1, %2, %3" : "=r"(r) : "r"(s), "r"(s), "r"(1000));
  out[++n] = (uint32_t)r;
#else
  out[++n] = 0x7FF;
  out[++n] = 0x1FF;
  out[++n] = 0x2468ACF0;
  out[++n] = 0x1E6A2C48;
  out[++n] = 0x00000000;
  out[++n] = (uint32_t)(0x5678 * 0x5678 + 1000);
#endif
  return n;
}
