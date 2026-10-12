#include <stdint.h>

#define RCC_AHB1ENR (*(volatile uint32_t *)0x40023830u)
#define GPIO(port) ((volatile uint32_t *)(0x40020000u + 0x400u * (port)))

enum { MODER = 0, PUPDR = 3, IDR = 4, BSRR = 6 };
enum { PORTS = 9, NO_PAD = 0xffffu, PINS_PER_PORT = 16 };
enum { MODE_INPUT = 0u, MODE_OUTPUT = 1u, PULL_NONE = 0u, PULL_UP = 1u, PULL_DOWN = 2u, TWO_BIT_FIELD = 3u };

typedef enum { IDLE, OUTPUT_LOW, OUTPUT_HIGH, INPUT_FLOATING, INPUT_PULLED_UP, INPUT_PULLED_DOWN } command_t;

volatile struct {
  uint32_t sequence;
  uint32_t applied;
  uint32_t command;
  uint32_t pad;
  uint16_t levels[PORTS];
} bench = { .pad = NO_PAD };

static void set_two_bit_field(volatile uint32_t *reg, uint32_t pin, uint32_t value) {
  *reg = (*reg & ~(TWO_BIT_FIELD << 2 * pin)) | (value << 2 * pin);
}

static void configure_only(uint32_t pad, uint32_t mode, uint32_t pull, int high) {
  volatile uint32_t *gpio = GPIO(pad / PINS_PER_PORT);
  uint32_t pin = pad % PINS_PER_PORT;
  gpio[BSRR] = high ? 1u << pin : 1u << (pin + PINS_PER_PORT);
  set_two_bit_field(&gpio[PUPDR], pin, pull);
  set_two_bit_field(&gpio[MODER], pin, mode);
}

static void apply(command_t command, uint32_t pad) {
  if (pad / PINS_PER_PORT >= PORTS) return;
  switch (command) {
    case OUTPUT_LOW: configure_only(pad, MODE_OUTPUT, PULL_NONE, 0); break;
    case OUTPUT_HIGH: configure_only(pad, MODE_OUTPUT, PULL_NONE, 1); break;
    case INPUT_FLOATING: configure_only(pad, MODE_INPUT, PULL_NONE, 0); break;
    case INPUT_PULLED_UP: configure_only(pad, MODE_INPUT, PULL_UP, 0); break;
    case INPUT_PULLED_DOWN: configure_only(pad, MODE_INPUT, PULL_DOWN, 0); break;
    case IDLE: break;
  }
}

int main(void) {
  RCC_AHB1ENR |= (1u << PORTS) - 1;
  for (;;) {
    uint32_t sequence = bench.sequence;
    if (sequence != bench.applied) {
      apply((command_t)bench.command, bench.pad);
      bench.applied = sequence;
    }
    for (uint32_t port = 0; port < PORTS; port++) bench.levels[port] = (uint16_t)GPIO(port)[IDR];
  }
}
