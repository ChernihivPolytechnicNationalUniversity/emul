/* Data memory across the banks: arrays the linker places in banks 0–2, pointers into them (IRP:FSR),
   a struct, copies and in-place updates. */
#include "test.h"

static uint8_t a0[16];
static uint8_t a1[16];
static uint8_t a2[16];
struct rec {
  uint8_t tag;
  uint16_t value;
  int8_t delta;
};
static struct rec recs[5];

static void fill(uint8_t *p, uint8_t n, uint8_t k) {
  uint8_t i;
  for (i = 0; i < n; i++) p[i] = (uint8_t)(i * k + 3);
}
static uint16_t sum(const uint8_t *p, uint8_t n) {
  uint16_t s = 0;
  uint8_t i;
  for (i = 0; i < n; i++) s = (uint16_t)(s * 3u + p[i]);
  return s;
}

uint8_t run_test(volatile uint32_t *out) {
  uint8_t n = 0, i;
  uint8_t *ps[3];
  ps[0] = a0;
  ps[1] = a1;
  ps[2] = a2;
  for (i = 0; i < 3; i++) fill(ps[i], 16, (uint8_t)(i + 5));
  out[++n] = ((uint32_t)sum(a0, 16) << 16) | sum(a1, 16);
  out[++n] = sum(a2, 16);
  for (i = 0; i < 16; i++) a2[15 - i] = (uint8_t)(a0[i] ^ a1[i]);
  out[++n] = sum(a2, 16);
  for (i = 0; i < 5; i++) {
    recs[i].tag = (uint8_t)(0x40 + i);
    recs[i].value = (uint16_t)(1000u * i + 7u);
    recs[i].delta = (int8_t)(i * 3 - 7);
  }
  {
    uint32_t acc = 0;
    struct rec *r = recs;
    for (i = 0; i < 5; i++, r++) {
      r->value = (uint16_t)(r->value + r->delta);
      acc = acc * 37u + r->tag + r->value;
    }
    out[++n] = acc;
  }
  return n;
}
