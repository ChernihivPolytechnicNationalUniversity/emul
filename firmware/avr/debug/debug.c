/*
 * The debugger's test program for the AVR (tests/firmware/avr-debugger.test.ts): the kinds of
 * data and control flow a debugger has to show on an 8-bit core — structs within structs,
 * arrays of them, a union, an enum, bit-fields, a string in RAM and one in flash, a float, a
 * 64-bit integer, data and function pointers, a recursion, a static local, and an interrupt
 * (Timer 0 overflow). Built at -O0 and -Os, as firmware/avr/build/debug-O0.elf and -Os.elf.
 */
#include <stdint.h>
#include <avr/interrupt.h>
#include <avr/io.h>
#include <avr/pgmspace.h>

typedef enum { MODE_IDLE, MODE_RUN = 3, MODE_FAULT = 7 } mode_t;

typedef struct {
  int16_t x;
  int16_t y;
} point_t;

typedef struct {
  uint8_t ready : 1;
  uint8_t level : 3;
  uint16_t count : 12;
  uint8_t tag;
} flags_t;

typedef union {
  uint32_t word;
  uint8_t bytes[4];
  float real;
} word_t;

typedef struct sample {
  char name[12];
  point_t at;
  point_t path[3];
  mode_t mode;
  flags_t flags;
  float gain;
  int64_t total;
  struct sample *next;
  int (*combine)(int, int);
} sample_t;

static int add(int a, int b) { return a + b; }

sample_t first = { "first", { 1, -2 }, { { 1, 2 }, { 3, 4 }, { 5, 6 } }, MODE_RUN, { 1, 5, 300, 0x42 }, 1.5f, -1234567890123LL, 0, add };
sample_t second = { "second", { 10, 20 }, { { 0 } }, MODE_IDLE, { 0 }, -2.0f, 42, &first, 0 };
word_t word = { 0x3fc00000 };
const char *greeting = "hello, debugger";
const char banner[] PROGMEM = "in flash";
volatile uint16_t ticks;
uint16_t rounds;

ISR(TIMER0_OVF_vect) {
  ticks++;
}

/* A recursion, for a call stack of some depth. */
uint16_t factorial(uint16_t n) {
  if (n <= 1) return 1;
  uint16_t below = factorial(n - 1);
  return n * below;
}

/* Parameters and locals of several kinds. */
int16_t walk(sample_t *s, int steps) {
  int16_t sum = 0;
  point_t p = s->at;
  for (int i = 0; i < steps; i++) {
    p.x += s->path[i % 3].x;
    p.y += s->path[i % 3].y;
    sum += p.x * p.y;
  }
  s->at = p;
  return sum;
}

static uint16_t counted(void) {
  static uint16_t calls;
  calls++;
  return calls;
}

int main(void) {
  /* Timer 0 at clk/64 from 16 MHz: an overflow every 1.024 ms. */
  TCCR0B = _BV(CS01) | _BV(CS00);
  TIMSK0 = _BV(TOIE0);
  sei();

  for (;;) {
    rounds += greeting[0] == 'h';
    uint16_t f = factorial(5);
    int16_t w = walk(&first, 4);
    uint16_t c = counted();
    first.total += f + w + c;
    first.gain *= 0.5f;
    second.gain = second.next->gain;
    word.bytes[0] ^= pgm_read_byte(&banner[0]) == 'i';
    uint16_t until = ticks + 2;
    while ((int16_t)(ticks - until) < 0)
      ;
  }
}
