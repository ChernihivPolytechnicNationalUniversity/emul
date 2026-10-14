/* Constants in program memory (RETLW tables reached by computed GOTOs, PCLATH across 256-word pages),
   a switch, function pointers. */
#include "test.h"

static __code const uint8_t table[300] = {
#define R(x) (uint8_t)((x) * 37u + 11u)
#define R10(x) R(x), R(x + 1), R(x + 2), R(x + 3), R(x + 4), R(x + 5), R(x + 6), R(x + 7), R(x + 8), R(x + 9)
    R10(0), R10(10), R10(20), R10(30), R10(40), R10(50), R10(60), R10(70), R10(80), R10(90),
    R10(100), R10(110), R10(120), R10(130), R10(140), R10(150), R10(160), R10(170), R10(180), R10(190),
    R10(200), R10(210), R10(220), R10(230), R10(240), R10(250), R10(260), R10(270), R10(280), R10(290),
};

static uint8_t pick(uint8_t k) {
  switch (k) {
  case 0: return 17;
  case 1: return 3;
  case 2: return 99;
  case 3: return 250;
  case 4: return 42;
  case 5: return 7;
  case 6: return 128;
  default: return k;
  }
}
static uint8_t twice(uint8_t x) { return (uint8_t)(x * 2u); }
static uint8_t inc(uint8_t x) { return (uint8_t)(x + 1u); }
static uint8_t swap(uint8_t x) { return (uint8_t)((x << 4) | (x >> 4)); }
static uint8_t (*const ops[3])(uint8_t) = {twice, inc, swap};

uint8_t run_test(volatile uint32_t *out) {
  uint8_t n = 0;
  uint16_t i;
  uint32_t acc = 0;
  for (i = 0; i < 300; i++) acc = acc * 31u + table[i];
  out[++n] = acc;
  acc = 0;
  for (i = 0; i < 20; i++) acc = acc * 31u + pick((uint8_t)i);
  out[++n] = acc;
  acc = 0;
  for (i = 0; i < 30; i++) acc = acc * 31u + ops[i % 3]((uint8_t)(i * 7u));
  out[++n] = acc;
  return n;
}
