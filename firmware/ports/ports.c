#include <stdint.h>

#define RCC_AHB1ENR (*(volatile uint32_t *)0x40023830u)
#define RCC_APB2ENR (*(volatile uint32_t *)0x40023844u)
#define GPIO(port) ((volatile uint32_t *)(0x40020000u + 0x400u * (port)))
#define ADC(n) ((volatile uint32_t *)(0x40012000u + 0x100u * ((n) - 1)))

enum { MODER = 0, PUPDR = 3, IDR = 4, ODR = 5 };
enum { PORTS = 9, NO_PAD = 0xffffu };
enum { ALL_OUTPUT = 0x55555555u, ALL_PULL_UP = 0x55555555u, ALL_PULL_DOWN = 0xaaaaaaaau, ALL_ANALOG = 0xffffffffu };
enum { ADC_SR = 0, ADC_CR2 = 2, ADC_SMPR1 = 3, ADC_SMPR2 = 4, ADC_SQR1 = 11, ADC_SQR3 = 13, ADC_DR = 19 };
enum { ADC1_ENABLE = 1u << 8, ADC3_ENABLE = 1u << 10, ADON = 1u << 0, SWSTART = 1u << 30, EOC = 1u << 1 };
enum { LONGEST_SAMPLE_10_TO_18 = 0x07ffffffu, LONGEST_SAMPLE_0_TO_9 = 0x3fffffffu };

typedef struct {
  uint8_t adc;
  uint8_t channel;
} analog_input_t;

static const analog_input_t ANALOG_INPUTS[] = {
  { 1, 0 }, { 1, 1 }, { 1, 2 }, { 1, 3 }, { 1, 4 }, { 1, 5 }, { 1, 6 }, { 1, 7 },
  { 1, 8 }, { 1, 9 }, { 1, 10 }, { 1, 11 }, { 1, 12 }, { 1, 13 }, { 1, 14 }, { 1, 15 },
  { 3, 4 }, { 3, 5 }, { 3, 6 }, { 3, 7 }, { 3, 8 }, { 3, 9 }, { 3, 14 }, { 3, 15 },
};
enum { ANALOG_INPUT_COUNT = sizeof ANALOG_INPUTS / sizeof ANALOG_INPUTS[0] };

typedef enum { IDLE, DRIVE, LISTEN_PULLED_DOWN, LISTEN_PULLED_UP, MEASURE } command_t;

volatile struct {
  uint32_t sequence;
  uint32_t applied;
  uint32_t command;
  uint32_t pad;
  uint16_t levels[PORTS];
  uint16_t analog[ANALOG_INPUT_COUNT];
} bench = { .pad = NO_PAD };

static void drive_only(uint32_t pad) {
  for (uint32_t port = 0; port < PORTS; port++) {
    volatile uint32_t *gpio = GPIO(port);
    gpio[PUPDR] = 0;
    gpio[ODR] = pad >> 4 == port ? 1u << (pad & 15) : 0;
    gpio[MODER] = ALL_OUTPUT;
  }
}

static void listen(uint32_t pulls) {
  for (uint32_t port = 0; port < PORTS; port++) {
    volatile uint32_t *gpio = GPIO(port);
    gpio[MODER] = 0;
    gpio[PUPDR] = pulls;
  }
}

static uint16_t convert(analog_input_t input) {
  volatile uint32_t *adc = ADC(input.adc);
  adc[ADC_SQR1] = 0;
  adc[ADC_SQR3] = input.channel;
  adc[ADC_CR2] = ADON | SWSTART;
  while (!(adc[ADC_SR] & EOC)) {
  }
  return (uint16_t)adc[ADC_DR];
}

static void measure(void) {
  listen(0);
  for (uint32_t port = 0; port < PORTS; port++) GPIO(port)[MODER] = ALL_ANALOG;
  RCC_APB2ENR |= ADC1_ENABLE | ADC3_ENABLE;
  for (uint32_t n = 1; n <= 3; n += 2) {
    ADC(n)[ADC_SMPR1] = LONGEST_SAMPLE_10_TO_18;
    ADC(n)[ADC_SMPR2] = LONGEST_SAMPLE_0_TO_9;
    ADC(n)[ADC_CR2] = ADON;
  }
  for (uint32_t i = 0; i < ANALOG_INPUT_COUNT; i++) bench.analog[i] = convert(ANALOG_INPUTS[i]);
}

static void apply(command_t command, uint32_t pad) {
  switch (command) {
    case DRIVE: drive_only(pad); break;
    case LISTEN_PULLED_DOWN: listen(ALL_PULL_DOWN); break;
    case LISTEN_PULLED_UP: listen(ALL_PULL_UP); break;
    case MEASURE: measure(); break;
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
