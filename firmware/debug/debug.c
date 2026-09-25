/*
 * The debugger's test program (scripts/debug.ts): a bare F429 program with the kinds of
 * data and control flow a debugger has to show — structs within structs, arrays of them, a
 * union, an enum, bit-fields, strings, floats and doubles, pointers and a function pointer,
 * a recursion, a static local, an interrupt (SysTick at 1 kHz) and a fault on demand.
 * Built at -O0 (what a Debug configuration is) and at -O2.
 */
#include <stdint.h>
#include "shapes.h"

typedef enum { MODE_IDLE, MODE_RUN = 3, MODE_FAULT = 7 } mode_t;

typedef struct {
  int16_t x;
  int16_t y;
} point_t;

typedef struct {
  uint32_t ready : 1;
  uint32_t level : 3;
  uint32_t count : 12;
  uint32_t : 0;
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
  double scale;
  int64_t total;
  struct sample *next;
  int (*combine)(int, int);
} sample_t;

static int add(int a, int b) { return a + b; }

sample_t first = { "first", { 1, -2 }, { { 1, 2 }, { 3, 4 }, { 5, 6 } }, MODE_RUN, { 1, 5, 300, 0x42 }, 1.5f, 0.25, -1234567890123LL, 0, add };
sample_t second = { "second", { 10, 20 }, { { 0 } }, MODE_IDLE, { 0 }, -2.0f, 1e-3, 42, &first, 0 };
word_t word = { 0x3fc00000 };
const char *greeting = "hello, debugger";
volatile uint32_t ticks;
volatile uint32_t fault_now;
uint32_t rounds;

void SysTick_Handler(void) {
  ticks++;
}

/* A recursion, for a call stack of some depth. */
uint32_t factorial(uint32_t n) {
  if (n <= 1) return 1;
  uint32_t below = factorial(n - 1);
  return n * below;
}

/* Parameters and locals of several kinds. */
int32_t walk(sample_t *s, int steps) {
  int32_t sum = 0;
  point_t p = s->at;
  for (int i = 0; i < steps; i++) {
    p.x += s->path[i % 3].x;
    p.y += s->path[i % 3].y;
    sum += p.x * p.y;
  }
  s->at = p;
  return sum;
}

static uint32_t counted(void) {
  static uint32_t calls;
  calls++;
  return calls;
}

/* A store to nowhere: a precise bus fault, escalated to HardFault (no BusFault handler enabled). */
static void crash(void) {
  *(volatile uint32_t *)0x9f000000 = 1;
}

/* The C++ side's static objects: the bare startup does not construct them. */
extern void (*__init_array_start[])(void);
extern void (*__init_array_end[])(void);

int main(void) {
  for (void (**ctor)(void) = __init_array_start; ctor < __init_array_end; ctor++) (*ctor)();
  /* SysTick from the 16 MHz HSI at 1 kHz. */
  *(volatile uint32_t *)0xE000E014 = 16000 - 1;
  *(volatile uint32_t *)0xE000E018 = 0;
  *(volatile uint32_t *)0xE000E010 = 7;

  for (;;) {
    rounds += greeting[0] == 'h';
    uint32_t f = factorial(5);
    int32_t w = walk(&first, 4);
    uint32_t c = counted();
    first.total += f + (uint32_t)w + c;
    first.gain *= 0.5f;
    second.scale = second.scale * 2.0 + shapes_area();
    word.bytes[0] ^= 1;
    if (fault_now) crash();
    uint32_t until = ticks + 10;
    while (ticks < until)
      ;
  }
}
