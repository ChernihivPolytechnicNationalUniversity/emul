/* Loads and stores of every width, alignment and addressing mode; structs, arrays, stack, recursion, libc. */
#include "test.h"

typedef struct { uint8_t b; uint16_t h; uint32_t w; int8_t sb; int16_t sh; uint64_t d; } __attribute__((packed)) packed_t;
typedef struct { uint32_t a, b, c, d, e, f; } six_t;

static uint32_t fib(uint32_t k) { return k < 2 ? k : fib(k - 1) + fib(k - 2); }
static uint32_t sum(const uint32_t *p, int cnt) { uint32_t s = 0; while (cnt--) s = s * 31 + *p++; return s; }
static six_t mk(uint32_t v) { six_t s = { v, v + 1, v + 2, v + 3, v + 4, v + 5 }; return s; }
static int cmp_u32(const void *a, const void *b) { uint32_t x = *(const uint32_t *)a, y = *(const uint32_t *)b; return x < y ? -1 : x > y; }

static uint8_t buf[512];
static uint32_t words[64];
static const uint32_t table[8] = { 0x1111, 0x2222, 0x3333, 0x4444, 0x5555, 0x6666, 0x7777, 0x8888 };

int run_test(volatile uint32_t *out) {
  int n = 0;
  uint32_t seed = OPAQUE(99u);
  for (int i = 0; i < 512; i++) { seed = seed * 1103515245u + 12345u; buf[i] = (uint8_t)(seed >> 24); }

  /* Byte / halfword / word, signed and unsigned, with immediate, register and shifted-register offsets. */
  uint32_t acc = 0;
  for (int i = 0; i < 128; i++) {
    acc += buf[i];
    acc ^= (uint32_t)(int8_t)buf[i + 1];
    acc += *(uint16_t *)&buf[2 * i];
    acc ^= (uint32_t)*(int16_t *)&buf[2 * i + 2];
    acc += *(uint32_t *)&buf[4 * (i & 63)];
    acc ^= *(uint32_t *)&buf[(i & 63) << 2 | 4];
  }
  out[++n] = acc;

  /* Unaligned word/halfword accesses (allowed on Cortex-M for LDR/STR/LDRH/STRH). */
  for (int i = 0; i < 32; i++) {
    uint32_t v; uint16_t h;
    memcpy(&v, &buf[3 * i + 1], 4);
    memcpy(&h, &buf[5 * i + 3], 2);
    acc = acc * 7 + v + h;
  }
  out[++n] = acc;

  /* Packed struct: unaligned 64-bit and mixed widths. */
  packed_t *pk = (packed_t *)&buf[1];
  pk->b = 0xAB; pk->h = 0xCDEF; pk->w = 0x01234567; pk->sb = -5; pk->sh = -300; pk->d = 0x0123456789ABCDEFull;
  out[++n] = pk->b + pk->h + pk->w;
  out[++n] = (uint32_t)pk->sb ^ (uint32_t)pk->sh;
  out[++n] = (uint32_t)(pk->d >> 32) ^ (uint32_t)pk->d;
  out[++n] = sum((uint32_t *)buf, 16);

  /* LDM/STM, LDRD/STRD via struct copy and 64-bit variables. */
  six_t s1 = mk(OPAQUE(10u)), s2;
  s2 = s1;
  s2.c += s1.f;
  out[++n] = s2.a + s2.b * 3 + s2.c * 5 + s2.d * 7 + s2.e * 11 + s2.f * 13;
  uint64_t d64 = ((uint64_t)OPAQUE(0xDEADBEEFu) << 32) | OPAQUE(0xCAFEBABEu);
  volatile uint64_t *pd = (volatile uint64_t *)&words[2];
  *pd = d64;
  out[++n] = words[2] ^ (words[3] >> 4);
  words[4] = (uint32_t)(*pd >> 8);
  out[++n] = words[4];

  /* Table lookup (ldr with lsl #2), switch → tbb/tbh, function pointers. */
  for (int i = 0; i < 8; i++) acc += table[(seed >> i) & 7];
  out[++n] = acc;
  uint32_t sw = 0;
  for (int i = 0; i < 24; i++) {
    switch ((buf[i] + i) % 9) {
      case 0: sw += 1; break;
      case 1: sw ^= 0x55; break;
      case 2: sw += buf[i]; break;
      case 3: sw = sw * 3; break;
      case 4: sw -= 7; break;
      case 5: sw |= 0x100; break;
      case 6: sw <<= 1; break;
      case 7: sw >>= 1; break;
      default: sw = ~sw; break;
    }
  }
  out[++n] = sw;
  uint32_t (*fp)(const uint32_t *, int) = OPAQUE(&sum);
  out[++n] = fp(table, 8);

  /* Recursion (push/pop, deep stack) and libc. */
  out[++n] = fib(OPAQUE(15u));
  memset(words, 0x5A, sizeof words);
  memcpy(words, buf + 7, 100);
  memmove(words + 3, words, 200);
  out[++n] = sum(words, 64);
  out[++n] = (uint32_t)strlen((const char *)"hello, cortex-m4") + (uint32_t)memcmp(buf, buf + 1, 10);
  for (int i = 0; i < 64; i++) words[i] = buf[i * 3] | (uint32_t)buf[i * 5 + 1] << 8;
  qsort(words, 64, sizeof words[0], cmp_u32);
  out[++n] = sum(words, 64);

  /* Pre/post-indexed writeback patterns: pointer walks. */
  uint8_t *p = buf + 100;
  uint32_t walk = 0;
  for (int i = 0; i < 40; i++) { walk = walk * 5 + *p; p += 3; }
  uint16_t *hp = (uint16_t *)(buf + 200);
  for (int i = 0; i < 20; i++) walk ^= *hp++ << (i & 7);
  out[++n] = walk;
  return n;
}
