/* Memory: every LD/ST addressing mode through arrays, structs and pointers (X/Y/Z, ±, displacement),
   the stack, program-memory reads (LPM/LPM Z+) and the libc string routines. */
#include "test.h"

static const uint8_t table[64] PROGMEM = {
  3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7, 9, 3, 2, 3, 8, 4, 6, 2, 6, 4, 3, 3, 8, 3, 2, 7, 9, 5,
  0, 2, 8, 8, 4, 1, 9, 7, 1, 6, 9, 3, 9, 9, 3, 7, 5, 1, 0, 5, 8, 2, 0, 9, 7, 4, 9, 4, 4, 5, 9, 2};
static const uint16_t words[8] PROGMEM = {0x1234, 0xbeef, 0x0001, 0x8000, 0xffff, 0x7f7f, 0xa5a5, 0x5a5a};
static const uint32_t dwords[4] PROGMEM = {0xdeadbeeful, 0x01020304ul, 0xfffffffful, 0x80000001ul};

struct rec { uint8_t a; uint16_t b; uint32_t c; int8_t d[5]; };

static uint8_t buf[300];
static int cmp_u16(const void *a, const void *b) { uint16_t x = *(const uint16_t *)a, y = *(const uint16_t *)b; return x < y ? -1 : x > y; }

static uint32_t deep(uint8_t depth, uint32_t v) {
  volatile uint8_t local[8];
  for (uint8_t i = 0; i < 8; i++) local[i] = (uint8_t)(v >> i) + depth;
  if (depth == 0) return v;
  uint32_t r = deep(depth - 1, v * 3u + local[depth & 7]);
  return r + local[(depth * 3) & 7];
}

int16_t run_test(volatile uint32_t *out) {
  int16_t n = 0;
  uint32_t seed = OPAQUE(7ul);
  for (uint16_t i = 0; i < sizeof buf; i++) { seed = seed * 1103515245ul + 12345ul; buf[i] = (uint8_t)(seed >> 24); }

  uint32_t acc = 0;
  for (uint16_t i = 0; i < sizeof buf; i++) acc = acc * 31u + buf[i];
  out[++n] = acc;

  /* Pre-decrement / post-increment walks. */
  uint8_t *p = buf + sizeof buf, *q = buf;
  acc = 0;
  while (p > buf) { acc += *--p; acc ^= *q++ << 3; }
  out[++n] = acc;

  /* Struct displacement accesses. */
  struct rec rs[6];
  for (uint8_t i = 0; i < 6; i++) {
    rs[i].a = buf[i]; rs[i].b = (uint16_t)(buf[i + 1] << 8 | buf[i + 2]); rs[i].c = (uint32_t)i * 0x01010101ul;
    for (uint8_t j = 0; j < 5; j++) rs[i].d[j] = (int8_t)(buf[i * 5 + j] - 128);
  }
  acc = 0;
  for (uint8_t i = 0; i < 6; i++) { acc = acc * 7u + rs[i].a + rs[i].b + rs[i].c; for (uint8_t j = 0; j < 5; j++) acc += (uint32_t)(int32_t)rs[i].d[j]; }
  out[++n] = acc;

  /* Program memory. */
  acc = 0;
  for (uint8_t i = 0; i < 64; i++) acc = acc * 10u + pgm_read_byte(&table[i]);
  out[++n] = acc;
  acc = 0;
  for (uint8_t i = 0; i < 8; i++) acc = acc * 3u + pgm_read_word(&words[i]);
  for (uint8_t i = 0; i < 4; i++) acc ^= pgm_read_dword(&dwords[i]) + i;
  out[++n] = acc;

  /* libc */
  uint8_t tmp[64];
  memcpy(tmp, buf + 10, 64);
  memmove(tmp + 3, tmp, 40);
  memset(tmp + 50, 0xa5, 10);
  acc = 0;
  for (uint8_t i = 0; i < 64; i++) acc = acc * 31u + tmp[i];
  out[++n] = acc;
  out[++n] = (uint32_t)(int32_t)memcmp(buf, buf + 1, 20);
  char s[40];
  strcpy(s, "Hello, ATmega328P");
  strcat(s, "!");
  out[++n] = strlen(s) | (uint32_t)(strchr(s, 'A') - s) << 8 | (uint32_t)(strcmp(s, "Hello") > 0) << 16;
  uint16_t arr[40];
  for (uint8_t i = 0; i < 40; i++) arr[i] = (uint16_t)(buf[i] << 8 | buf[i + 40]);
  qsort(arr, 40, 2, cmp_u16);
  acc = 0;
  for (uint8_t i = 0; i < 40; i++) acc = acc * 31u + arr[i];
  out[++n] = acc;

  /* Stack: recursion with locals (PUSH/POP, frame pointer via Y). */
  out[++n] = deep(20, OPAQUE(5ul));
  return n;
}
