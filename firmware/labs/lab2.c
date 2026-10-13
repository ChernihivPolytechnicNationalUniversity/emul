#include "bench.h"

enum { TIMER_HZ = 108000000, SYSTICK_HZ = 1000 };
enum { JOY_A, JOY_B, JOY_C, JOY_D, JOY_CTR, JOYSTICK };
enum { RED = 1, GREEN = 2, BLUE = 4, LED1 = 1, BOTH = 3, NONE = 0 };
enum { NO_RANGE = 0xff };
enum { KIND_RGB, KIND_SQUARE, KIND_FREQUENCY, KIND_PERIOD, KIND_WIDTH, KIND_GAP };
enum { PWM1 = 6u, FORCED_LOW = 4u, FORCED_HIGH = 5u, SMS_RESET = 4u, TS_TI1FP1 = 5u << TIM_SMCR_TS_Pos };
enum { DEBOUNCE_PSC = 10799, DEBOUNCE_ARR = 199 };
enum { RGB_PSC_100HZ = 17, RGB_PSC_25HZ = 71, RGB_ARR = 59999, RGB_TICKS_PER_PERCENT = 600 };
enum { NO_SIGNAL_TICKS = TIMER_HZ / 40 };

typedef struct {
  uint32_t lo;
  uint32_t hi;
} range_t;

typedef struct {
  uint8_t kind;
  uint8_t initial_range;
  uint8_t above, within, below;
  uint32_t nominal_hz;
  range_t ranges[4];
} meter_t;

typedef struct {
  uint8_t psc;
  uint8_t start_pct, low_pct, high_pct;
  int8_t step[JOYSTICK];
  uint8_t channel[JOYSTICK];
  uint8_t centre_pct;
} rgb_t;

typedef struct {
  uint8_t psc;
  uint16_t hz_min, hz_max, hz_step;
  uint8_t duty_min, duty_max, duty_step;
  int8_t hz_dir[JOYSTICK];
  int8_t duty_dir[JOYSTICK];
  uint16_t centre_hz;
  uint8_t centre_duty;
} square_t;

#define MS(x) ((uint32_t)((x) * 1000000.0 + 0.5))
#define HZ(x) ((uint32_t)((x) * 1000u))

static const rgb_t rgb1 = { RGB_PSC_100HZ, 5, 5, 95, { 30, 10, 5, 0, 0 }, { 2, 1, 0, 0, 0 }, 95 };
static const rgb_t rgb7 = { RGB_PSC_25HZ, 95, 5, 95, { 0, -5, -10, -30, 0 }, { 0, 2, 1, 0, 0 }, 5 };
static const square_t square2 = { 8, 200, 1000, 100, 10, 90, 10, { 0, -1, 1, 0, 0 }, { 1, 0, 0, -1, 0 }, 1000, 10 };
static const square_t square8 = { 17, 100, 500, 50, 20, 80, 20, { 0, 0, -1, 1, 0 }, { 1, -1, 0, 0, 0 }, 100, 80 };

static const meter_t meters[13] = {
  [3] = { KIND_FREQUENCY, JOY_C, RED, GREEN, BLUE, 0, { [JOY_C] = { HZ(200), HZ(400) }, [JOY_A] = { HZ(400), HZ(600) }, [JOY_B] = { HZ(600), HZ(800) }, [JOY_D] = { HZ(800), HZ(1000) } } },
  [4] = { KIND_PERIOD, JOY_D, RED, GREEN, BLUE, 0, { [JOY_D] = { MS(2.5), MS(5) }, [JOY_B] = { MS(1.7), MS(2.5) }, [JOY_A] = { MS(1.25), MS(1.7) }, [JOY_C] = { MS(1.0), MS(1.25) } } },
  [5] = { KIND_WIDTH, JOY_C, BOTH, NONE, LED1, 100, { [JOY_C] = { MS(8), MS(10) }, [JOY_A] = { MS(6), MS(8) }, [JOY_B] = { MS(4), MS(6) }, [JOY_D] = { MS(2), MS(4) } } },
  [6] = { KIND_GAP, JOY_D, NONE, BOTH, LED1, 500, { [JOY_D] = { MS(1.8), MS(2) }, [JOY_B] = { MS(1.6), MS(1.8) }, [JOY_A] = { MS(1.4), MS(1.6) }, [JOY_C] = { MS(1.2), MS(1.4) } } },
  [9] = { KIND_FREQUENCY, JOY_D, BLUE, RED, GREEN, 0, { [JOY_D] = { HZ(100), HZ(200) }, [JOY_B] = { HZ(200), HZ(300) }, [JOY_A] = { HZ(300), HZ(400) }, [JOY_C] = { HZ(400), HZ(500) } } },
  [10] = { KIND_PERIOD, JOY_C, BLUE, RED, GREEN, 0, { [JOY_C] = { MS(5), MS(10) }, [JOY_A] = { MS(3.3), MS(5) }, [JOY_B] = { MS(2.5), MS(3.3) }, [JOY_D] = { MS(2.0), MS(2.5) } } },
  [11] = { KIND_WIDTH, JOY_D, BOTH, NONE, LED1, 1000, { [JOY_D] = { MS(0), MS(0.2) }, [JOY_B] = { MS(0.2), MS(0.4) }, [JOY_A] = { MS(0.4), MS(0.6) }, [JOY_C] = { MS(0.6), MS(0.8) } } },
  [12] = { KIND_GAP, JOY_C, NONE, BOTH, LED1, 250, { [JOY_C] = { MS(0), MS(0.5) }, [JOY_A] = { MS(0.5), MS(1.0) }, [JOY_B] = { MS(1.0), MS(1.5) }, [JOY_D] = { MS(1.5), MS(2.0) } } },
};

const volatile uint32_t lab2_variant __attribute__((section(".rodata.lab2_variant"))) = 1;

volatile struct {
  uint32_t variant;
  uint32_t ready;
  uint32_t presses;
  uint32_t edges;
  uint32_t level[3];
  uint32_t hz;
  uint32_t duty;
  uint32_t range;
  uint32_t ticks;
  uint32_t value;
  uint32_t leds;
  uint32_t measurements;
} lab2;

volatile struct {
  uint32_t sequence;
  uint32_t applied;
  uint32_t period;
  uint32_t high;
} bench_source;

typedef struct {
  GPIO_TypeDef *port;
  uint8_t pin;
} line_t;

static const line_t joystick[JOYSTICK] = { { GPIOG, 2 }, { GPIOG, 3 }, { GPIOD, 4 }, { GPIOD, 5 }, { GPIOI, 11 } };
static const uint8_t led_pins[3] = { 12, 13, 14 };

static uint32_t variant;
static int signal_seen;

static int pressed(unsigned j) {
  return !pad_read(joystick[j].port, joystick[j].pin);
}

static void show(uint32_t leds) {
  lab2.leds = leds;
  for (unsigned i = 0; i < 3; i++) pad_write(GPIOD, led_pins[i], (leds >> i) & 1u);
}

static uint32_t wrap(const rgb_t *v, uint32_t level, int step) {
  int next = (int)level + step;
  if (next > v->high_pct) return v->low_pct;
  if (next < v->low_pct) return v->high_pct;
  return (uint32_t)next;
}

static void rgb_apply(void) {
  TIM4->CCR1 = lab2.level[0] * RGB_TICKS_PER_PERCENT;
  TIM4->CCR2 = lab2.level[1] * RGB_TICKS_PER_PERCENT;
  TIM4->CCR3 = lab2.level[2] * RGB_TICKS_PER_PERCENT;
}

static void rgb_press(const rgb_t *v, unsigned j) {
  if (j == JOY_CTR) {
    for (unsigned c = 0; c < 3; c++) lab2.level[c] = v->centre_pct;
  } else if (v->step[j]) {
    unsigned c = v->channel[j];
    lab2.level[c] = wrap(v, lab2.level[c], v->step[j]);
  }
  rgb_apply();
}

static uint32_t clamp(int value, int low, int high) {
  return (uint32_t)(value < low ? low : value > high ? high : value);
}

static void square_apply(const square_t *v) {
  uint32_t clock = TIMER_HZ / (v->psc + 1u);
  uint32_t period = (clock + lab2.hz / 2u) / lab2.hz;
  uint32_t high = (period * lab2.duty + 50u) / 100u;
  TIM4->ARR = period - 1u;
  TIM4->CCR1 = high;
  TIM4->CCR2 = high;
}

static void square_press(const square_t *v, unsigned j) {
  if (j == JOY_CTR) {
    lab2.hz = v->centre_hz;
    lab2.duty = v->centre_duty;
  } else {
    lab2.hz = clamp((int)lab2.hz + v->hz_dir[j] * v->hz_step, v->hz_min, v->hz_max);
    lab2.duty = clamp((int)lab2.duty + v->duty_dir[j] * v->duty_step, v->duty_min, v->duty_max);
  }
  square_apply(v);
}

static void indicate(void) {
  const meter_t *m = &meters[variant];
  const range_t *r = &m->ranges[lab2.range];
  uint32_t value = lab2.value;
  show(value > r->hi ? m->above : value < r->lo ? m->below : m->within);
}

static uint32_t value_of(uint32_t ticks) {
  if (meters[variant].kind == KIND_FREQUENCY) return ticks ? (uint32_t)(((uint64_t)TIMER_HZ * 1000u + ticks / 2u) / ticks) : 0u;
  return (uint32_t)(((uint64_t)ticks * 1000000000u + TIMER_HZ / 2u) / TIMER_HZ);
}

static void measured(uint32_t ticks, uint32_t value) {
  lab2.ticks = ticks;
  lab2.value = value;
  lab2.measurements++;
  indicate();
}

static void meter_capture(void) {
  uint32_t sr = TIM2->SR;
  if (sr & TIM_SR_UIF) {
    TIM2->SR = ~TIM_SR_UIF;
    signal_seen = 0;
    const meter_t *m = &meters[variant];
    int high = pad_read(GPIOA, 15);
    uint32_t full = m->nominal_hz ? (uint32_t)(1000000000u / m->nominal_hz) : 0u;
    switch (m->kind) {
      case KIND_FREQUENCY:
        measured(0, 0);
        break;
      case KIND_PERIOD:
        measured(0, UINT32_MAX);
        break;
      case KIND_WIDTH:
        measured(0, high ? full : 0u);
        break;
      default:
        measured(0, high ? 0u : full);
        break;
    }
  }
  if (!(sr & TIM_SR_CC1IF)) return;
  uint32_t period = TIM2->CCR1;
  uint32_t part = TIM2->CCR2;
  if (!signal_seen) {
    signal_seen = 1;
    return;
  }
  uint32_t ticks = meters[variant].kind == KIND_FREQUENCY || meters[variant].kind == KIND_PERIOD ? period : part;
  measured(ticks, value_of(ticks));
}

static void act(unsigned j) {
  lab2.presses++;
  switch (variant) {
    case 1:
      rgb_press(&rgb1, j);
      break;
    case 7:
      rgb_press(&rgb7, j);
      break;
    case 2:
      square_press(&square2, j);
      break;
    case 8:
      square_press(&square8, j);
      break;
    default:
      if (j < JOY_CTR) {
        lab2.range = j;
        indicate();
      }
      break;
  }
}

static void debounce_done(void) {
  static uint8_t held[JOYSTICK];
  TIM7->SR = ~TIM_SR_UIF;
  for (unsigned j = 0; j < JOYSTICK; j++) {
    uint8_t now = (uint8_t)pressed(j);
    if (now && !held[j]) act(j);
    held[j] = now;
  }
}

static void joystick_edge(void) {
  uint32_t pending = EXTI->PR & ((1u << 2) | (1u << 3) | (1u << 4) | (1u << 5) | (1u << 11));
  EXTI->PR = pending;
  lab2.edges++;
  TIM7->CR1 &= ~TIM_CR1_CEN;
  TIM7->CNT = 0;
  TIM7->SR = ~TIM_SR_UIF;
  TIM7->CR1 |= TIM_CR1_CEN;
}

static void systick(void) {}

static void joystick_init(void) {
  for (unsigned j = 0; j < JOYSTICK; j++) pad_mode(joystick[j].port, joystick[j].pin, 0, PULL_UP);
  RCC->APB2ENR |= RCC_APB2ENR_SYSCFGEN;
  (void)RCC->APB2ENR;
  SYSCFG->EXTICR[0] = (SYSCFG->EXTICR[0] & ~(0xffu << 8)) | (6u << 8) | (6u << 12);
  SYSCFG->EXTICR[1] = (SYSCFG->EXTICR[1] & ~0xffu) | (3u << 0) | (3u << 4);
  SYSCFG->EXTICR[2] = (SYSCFG->EXTICR[2] & ~(0xfu << 12)) | (8u << 12);
  uint32_t lines = (1u << 2) | (1u << 3) | (1u << 4) | (1u << 5) | (1u << 11);
  EXTI->RTSR |= lines;
  EXTI->FTSR |= lines;
  EXTI->PR = lines;
  EXTI->IMR |= lines;
  RCC->APB1ENR |= RCC_APB1ENR_TIM7EN;
  (void)RCC->APB1ENR;
  TIM7->PSC = DEBOUNCE_PSC;
  TIM7->ARR = DEBOUNCE_ARR;
  TIM7->CR1 = TIM_CR1_URS | TIM_CR1_OPM;
  TIM7->EGR = TIM_EGR_UG;
  TIM7->DIER = TIM_DIER_UIE;
  irq_attach(TIM7_IRQn, debounce_done);
  irq_attach(EXTI2_IRQn, joystick_edge);
  irq_attach(EXTI3_IRQn, joystick_edge);
  irq_attach(EXTI4_IRQn, joystick_edge);
  irq_attach(EXTI9_5_IRQn, joystick_edge);
  irq_attach(EXTI15_10_IRQn, joystick_edge);
}

static void tim4_outputs(uint32_t psc, uint32_t arr, uint32_t channels, uint32_t inverted_ch2) {
  for (unsigned i = 0; i < channels; i++) pad_af(GPIOD, led_pins[i], 2, PULL_NONE);
  RCC->APB1ENR |= RCC_APB1ENR_TIM4EN;
  (void)RCC->APB1ENR;
  TIM4->PSC = psc;
  TIM4->ARR = arr;
  TIM4->CCMR1 = (PWM1 << TIM_CCMR1_OC1M_Pos) | TIM_CCMR1_OC1PE | (PWM1 << TIM_CCMR1_OC2M_Pos) | TIM_CCMR1_OC2PE;
  TIM4->CCMR2 = (PWM1 << TIM_CCMR2_OC3M_Pos) | TIM_CCMR2_OC3PE;
  TIM4->CCER = TIM_CCER_CC1E | TIM_CCER_CC2E | (channels > 2 ? TIM_CCER_CC3E : 0u) | (inverted_ch2 ? TIM_CCER_CC2P : 0u);
  TIM4->CR1 = TIM_CR1_ARPE;
}

static void tim4_start(void) {
  TIM4->EGR = TIM_EGR_UG;
  TIM4->CR1 |= TIM_CR1_CEN;
}

static void rgb_init(const rgb_t *v) {
  tim4_outputs(v->psc, RGB_ARR, 3, 0);
  for (unsigned c = 0; c < 3; c++) lab2.level[c] = v->start_pct;
  rgb_apply();
  tim4_start();
}

static void square_init(const square_t *v) {
  tim4_outputs(v->psc, 0xffff, 2, 1);
  lab2.hz = v->centre_hz;
  lab2.duty = v->centre_duty;
  square_apply(v);
  tim4_start();
}

static void meter_init(void) {
  for (unsigned i = 0; i < 3; i++) pad_output(GPIOD, led_pins[i]);
  pad_af(GPIOA, 15, 1, PULL_NONE);
  RCC->APB1ENR |= RCC_APB1ENR_TIM2EN;
  (void)RCC->APB1ENR;
  uint32_t gap = meters[variant].kind == KIND_GAP;
  TIM2->ARR = NO_SIGNAL_TICKS - 1u;
  TIM2->CCMR1 = TIM_CCMR1_CC1S_0 | TIM_CCMR1_CC2S_1;
  TIM2->CCER = TIM_CCER_CC1E | TIM_CCER_CC2E | (gap ? TIM_CCER_CC1P : TIM_CCER_CC2P);
  TIM2->SMCR = TS_TI1FP1 | SMS_RESET;
  TIM2->CR1 = TIM_CR1_URS;
  TIM2->EGR = TIM_EGR_UG;
  TIM2->SR = 0;
  TIM2->DIER = TIM_DIER_CC1IE | TIM_DIER_UIE;
  irq_attach(TIM2_IRQn, meter_capture);
  lab2.range = meters[variant].initial_range;
  TIM2->CR1 |= TIM_CR1_CEN;
}

static void source_init(void) {
  pad_af(GPIOH, 10, 2, PULL_NONE);
  RCC->APB1ENR |= RCC_APB1ENR_TIM5EN;
  (void)RCC->APB1ENR;
  TIM5->CCMR1 = FORCED_LOW << TIM_CCMR1_OC1M_Pos;
  TIM5->CCER = TIM_CCER_CC1E;
  TIM5->CR1 = TIM_CR1_CEN;
}

static void source_apply(void) {
  uint32_t period = bench_source.period;
  uint32_t high = bench_source.high;
  if (period == 0u) {
    TIM5->CCMR1 = (high ? FORCED_HIGH : FORCED_LOW) << TIM_CCMR1_OC1M_Pos;
  } else {
    TIM5->ARR = period - 1u;
    TIM5->CCR1 = high;
    TIM5->CCMR1 = PWM1 << TIM_CCMR1_OC1M_Pos;
    TIM5->EGR = TIM_EGR_UG;
  }
  bench_source.applied = bench_source.sequence;
}

int main(void) {
  vectors_install();
  clock_216mhz_apb1_4_apb2_2();
  ports_on();
  variant = lab2_variant;
  lab2.variant = variant;
  vectors[16 + SysTick_IRQn] = systick;
  SysTick_Config(SYSCLK_216MHZ / SYSTICK_HZ);
  joystick_init();
  source_init();
  switch (variant) {
    case 1:
      rgb_init(&rgb1);
      break;
    case 7:
      rgb_init(&rgb7);
      break;
    case 2:
      square_init(&square2);
      break;
    case 8:
      square_init(&square8);
      break;
    default:
      meter_init();
      break;
  }
  lab2.ready = 1;
  for (;;) {
    if (bench_source.sequence != bench_source.applied) source_apply();
    __WFI();
  }
}
