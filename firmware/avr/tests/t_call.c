/* Control flow: indirect calls (ICALL), jump tables from switch, setjmp/longjmp, varargs,
   long branches and skips (CPSE/SBRC/SBRS) the compiler emits for bit tests. */
#include "test.h"
#include <setjmp.h>
#include <stdarg.h>

typedef uint32_t (*fn)(uint32_t);
static uint32_t f0(uint32_t x) { return x * 3u + 1u; }
static uint32_t f1(uint32_t x) { return x ^ 0x5a5a5a5aul; }
static uint32_t f2(uint32_t x) { return (x >> 3) | (x << 29); }
static uint32_t f3(uint32_t x) { return x - 12345u; }
static fn const fns[4] = {f0, f1, f2, f3};

static uint32_t sw(uint8_t k, uint32_t x) {
  switch (k) {
    case 0: return x + 1u;
    case 1: return x * 5u;
    case 2: return x ^ 0xffu;
    case 3: return x >> 2;
    case 4: return x << 3;
    case 5: return ~x;
    case 6: return x - 77u;
    case 7: return x | 0x100u;
    case 8: return x & 0xf0f0f0f0ul;
    case 9: return x + 0x10000ul;
    case 10: return x * x;
    case 11: return x / 3u;
    default: return 0;
  }
}

static jmp_buf env;
static uint8_t depth;
static void dive(uint8_t d) { depth = d; if (d == 13) longjmp(env, d); dive(d + 1); }

static uint32_t sum(uint8_t count, ...) {
  va_list ap; va_start(ap, count);
  uint32_t s = 0;
  for (uint8_t i = 0; i < count; i++) s = s * 7u + va_arg(ap, uint32_t);
  va_end(ap);
  return s;
}

static uint8_t bitcount(uint8_t v) {
  uint8_t c = 0;
  for (uint8_t i = 0; i < 8; i++) { if (v & 1) c++; v >>= 1; }
  return c;
}

int16_t run_test(volatile uint32_t *out) {
  int16_t n = 0;
  uint32_t x = OPAQUE(99ul);
  for (uint8_t i = 0; i < 40; i++) x = fns[(x ^ i) & 3](x);
  out[++n] = x;
  x = OPAQUE(1ul);
  for (uint8_t i = 0; i < 60; i++) x = sw((uint8_t)((x + i) % 13u), x) + i;
  out[++n] = x;
  int r = setjmp(env);
  if (r == 0) dive(0);
  out[++n] = (uint32_t)r << 8 | depth;
  out[++n] = sum(5, 1ul, 2ul, 0xfffffffful, 0x12345678ul, 42ul);
  uint32_t bc = 0;
  for (uint16_t v = 0; v < 256; v++) bc = bc * 3u + bitcount((uint8_t)v);
  out[++n] = bc;
  /* Signed compares and branches over every flag combination. */
  uint32_t m = 0;
  for (int16_t a = -300; a <= 300; a += 37)
    for (int16_t b = -300; b <= 300; b += 41) m = m * 5u + (a < b) + 2u * (a <= b) + 3u * (a > b) + (a == b) * 7u + ((int8_t)a < (int8_t)b) * 11u;
  out[++n] = m;
  return n;
}
