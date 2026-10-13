#include "bench.h"

enum { CHANNELS = 2, RING_SCANS = 16, LOG = 64, WINDOW_MAX = 100, FULL = 4095 };
enum { ADC3_POT1 = 7, ADC3_POT2 = 6, PF8 = 8, PF9 = 9, PD12 = 12, PD13 = 13, PD14 = 14, PG9 = 9, PG10 = 10, PG11 = 11, PB4 = 4, PB5 = 5, PG2 = 2, PG3 = 3 };
enum { MODE_OUTPUT = 1, MODE_ANALOG = 3, AF_TIM3_TIM4 = 2, DMA_CHANNEL_ADC3 = 2, EXTSEL_TIM5_TRGO = 4, SMP_56_CYCLES = 3 };
enum { APB1_TIMER_HZ = 108000000, MICROSECOND_TICKS = APB1_TIMER_HZ / 1000000, CENTI_TICK_HZ = 100000, POT_SAMPLE_HZ = 1000, PWM_SAMPLES_PER_PERIOD = 100, PWM_STEPS = 1000 };
enum { SYSTICK_HZ = 1000, HCLK_HZ = 216000000, DEBOUNCE_MS = 20, HYSTERESIS_CODES = 40, MMS_UPDATE = 2, PWM_MODE_1 = 6 };
enum { LED_R = 1, LED_G = 2, LED_B = 4, LED_ALL = LED_R | LED_G | LED_B, PC6 = 6, LED_PWM_PERIOD = 1000, LED_PWM_LIT = LED_PWM_PERIOD / 2 };

typedef enum { TASK_BRIGHTNESS, TASK_GENERATOR, TASK_VOLTMETER_POTS, TASK_VOLTMETER_PWM } task_t;
typedef enum { FILTER_MEDIAN, FILTER_TRIMMED, FILTER_RMS, FILTER_MEAN } filter_t;
typedef enum { BANDS_QUARTERS, BANDS_THIRDS, BANDS_THIRDS_BELOW_THREE_QUARTERS, BANDS_QUARTERS_REVERSED, BANDS_THIRDS_REVERSED, BANDS_QUARTERS_RED_ABOVE_ONE_QUARTER } bands_t;

typedef struct {
  uint32_t minimum;
  uint32_t maximum;
  uint32_t up;
  uint32_t down;
  uint32_t tim4_channel;
} control_t;

typedef struct {
  task_t task;
  filter_t filter;
  uint32_t window;
  bands_t bands;
  uint32_t pwm_hz;
  control_t control[CHANNELS];
  uint32_t leds_by_pwm;
} variant_t;

static const variant_t VARIANTS[13] = {
  [1] = {TASK_BRIGHTNESS, FILTER_MEDIAN, 16, 0, 100, {{5, 95, 10, 10, 2}, {5, 95, 15, 15, 3}}},
  [2] = {TASK_GENERATOR, FILTER_TRIMMED, 20, 0, 0, {{200, 1000, 100, 100, 0}, {10, 90, 10, 10, 0}}},
  [3] = {TASK_VOLTMETER_POTS, FILTER_RMS, 32, BANDS_QUARTERS, 0, {{0}, {0}}},
  [4] = {TASK_VOLTMETER_POTS, FILTER_MEAN, 16, BANDS_THIRDS, 0, {{0}, {0}}},
  [5] = {TASK_VOLTMETER_PWM, FILTER_RMS, PWM_SAMPLES_PER_PERIOD, BANDS_QUARTERS, 50, {{10, 90, 20, 20, 0}, {0}}},
  [6] = {TASK_VOLTMETER_PWM, FILTER_MEAN, PWM_SAMPLES_PER_PERIOD, BANDS_THIRDS_BELOW_THREE_QUARTERS, 100, {{5, 95, 30, 30, 0}, {0}}},
  [7] = {TASK_BRIGHTNESS, FILTER_TRIMMED, 16, 0, 25, {{5, 95, 30, 30, 1}, {5, 95, 10, 15, 3}}},
  [8] = {TASK_GENERATOR, FILTER_MEDIAN, 20, 0, 0, {{100, 500, 50, 50, 0}, {20, 80, 20, 20, 0}}},
  [9] = {TASK_VOLTMETER_POTS, FILTER_RMS, 16, BANDS_QUARTERS_REVERSED, 0, {{0}, {0}}, 1},
  [10] = {TASK_VOLTMETER_POTS, FILTER_MEAN, 32, BANDS_THIRDS_REVERSED, 0, {{0}, {0}}},
  [11] = {TASK_VOLTMETER_PWM, FILTER_RMS, PWM_SAMPLES_PER_PERIOD, BANDS_QUARTERS_RED_ABOVE_ONE_QUARTER, 100, {{5, 95, 30, 30, 0}, {0}}},
  [12] = {TASK_VOLTMETER_PWM, FILTER_MEAN, PWM_SAMPLES_PER_PERIOD, BANDS_THIRDS_REVERSED, 50, {{10, 90, 20, 20, 0}, {0}}},
};

const volatile uint32_t lab3_variant = 1;

typedef struct {
  uint32_t variant;
  uint32_t scans;
  uint32_t level[CHANNELS];
  int32_t band[CHANNELS];
  float filtered[CHANNELS];
  float measured[CHANNELS];
  uint32_t leds[CHANNELS];
  uint32_t duty;
  uint32_t presses;
  uint32_t log_at;
  uint16_t raw_log[CHANNELS][LOG];
  float filtered_log[CHANNELS][LOG];
} lab3_t;

volatile lab3_t lab3;

static volatile uint16_t ring[2 * RING_SCANS];
static const variant_t *v;
static uint16_t window[CHANNELS][WINDOW_MAX];
static uint32_t window_fill[CHANNELS];
static uint32_t window_at[CHANNELS];
static float block_sum[CHANNELS];
static uint32_t block_count[CHANNELS];

static void sort(uint16_t *a, uint32_t n) {
  for (uint32_t i = 1; i < n; i++) {
    uint16_t x = a[i];
    uint32_t j = i;
    for (; j > 0 && a[j - 1] > x; j--) a[j] = a[j - 1];
    a[j] = x;
  }
}

static float median_of(const uint16_t *w, uint32_t n) {
  uint16_t copy[WINDOW_MAX];
  for (uint32_t i = 0; i < n; i++) copy[i] = w[i];
  sort(copy, n);
  return n % 2 ? copy[n / 2] : (copy[n / 2 - 1] + copy[n / 2]) / 2.0f;
}

static float trimmed_mean_of(const uint16_t *w, uint32_t n) {
  uint32_t sum = 0;
  uint16_t lowest = w[0];
  uint16_t highest = w[0];
  for (uint32_t i = 0; i < n; i++) {
    sum += w[i];
    if (w[i] < lowest) lowest = w[i];
    if (w[i] > highest) highest = w[i];
  }
  return (float)(sum - lowest - highest) / (float)(n - 2);
}

static int sliding(uint32_t ch, uint16_t sample, float *out) {
  window[ch][window_at[ch]] = sample;
  window_at[ch] = (window_at[ch] + 1) % v->window;
  if (window_fill[ch] < v->window) window_fill[ch]++;
  if (window_fill[ch] < v->window) return 0;
  *out = v->filter == FILTER_MEDIAN ? median_of(window[ch], v->window) : trimmed_mean_of(window[ch], v->window);
  return 1;
}

static float square_root(float x) {
  float root;
  __asm("vsqrt.f32 %0, %1" : "=t"(root) : "t"(x));
  return root;
}

static int block(uint32_t ch, uint16_t sample, float *out) {
  block_sum[ch] += v->filter == FILTER_RMS ? (float)sample * (float)sample : (float)sample;
  if (++block_count[ch] < v->window) return 0;
  float average = block_sum[ch] / (float)v->window;
  *out = v->filter == FILTER_RMS ? square_root(average) : average;
  block_sum[ch] = 0;
  block_count[ch] = 0;
  return 1;
}

static void tim4_compare(uint32_t channel, uint32_t value) {
  (&TIM4->CCR1)[channel - 1] = value;
}

static void show_level(uint32_t ch) {
  const control_t *c = &v->control[ch];
  if (v->task == TASK_BRIGHTNESS) {
    tim4_compare(c->tim4_channel, lab3.level[ch] * (PWM_STEPS / 100));
    return;
  }
  uint32_t hz = lab3.level[0];
  uint32_t period = 1000000u / hz;
  TIM4->ARR = period - 1;
  TIM4->CCR1 = period * lab3.level[1] / 100;
  TIM4->CCR2 = TIM4->CCR1;
}

static uint32_t stepped(const control_t *c, uint32_t level, int32_t steps) {
  for (; steps > 0; steps--) level = level + c->up > c->maximum ? c->maximum : level + c->up;
  for (; steps < 0; steps++) level = level < c->minimum + c->down ? c->minimum : level - c->down;
  return level;
}

static int32_t bands_of(const control_t *c) {
  return (int32_t)((c->maximum - c->minimum) / c->up) + 1;
}

static int32_t band_of(float value, int32_t current, int32_t bands) {
  float width = (FULL + 1.0f) / (float)bands;
  if (current >= 0) {
    float low = current * width - HYSTERESIS_CODES;
    float high = (current + 1) * width + HYSTERESIS_CODES;
    if (value >= low && value < high) return current;
  }
  int32_t band = (int32_t)(value / width);
  return band >= bands ? bands - 1 : band;
}

static void turned(uint32_t ch, float value) {
  const control_t *c = &v->control[ch];
  int32_t band = band_of(value, lab3.band[ch], bands_of(c));
  if (lab3.band[ch] >= 0 && band != lab3.band[ch]) {
    lab3.level[ch] = stepped(c, lab3.level[ch], band - lab3.band[ch]);
    show_level(ch);
  }
  lab3.band[ch] = band;
}

static uint32_t colours(float value) {
  float x = value / FULL;
  switch (v->bands) {
    case BANDS_QUARTERS:
      return x <= 0.25f ? LED_R : x > 0.25f && x < 0.5f ? LED_G : x > 0.5f && x < 0.75f ? LED_B : x > 0.75f ? LED_ALL : 0;
    case BANDS_THIRDS:
      return x <= 1 / 3.0f ? LED_R : x > 1 / 3.0f && x < 2 / 3.0f ? LED_G : x > 2 / 3.0f ? LED_B : 0;
    case BANDS_THIRDS_BELOW_THREE_QUARTERS:
      return x <= 1 / 3.0f ? LED_R : x > 1 / 3.0f && x < 2 / 3.0f ? LED_G : x > 2 / 3.0f && x < 0.75f ? LED_B : 0;
    case BANDS_QUARTERS_REVERSED:
      return x > 0.75f ? LED_R : x > 0.5f && x < 0.75f ? LED_G : x > 0.25f && x < 0.5f ? LED_B : x <= 0.25f ? LED_ALL : 0;
    case BANDS_THIRDS_REVERSED:
      return x > 2 / 3.0f ? LED_R : x > 1 / 3.0f && x < 2 / 3.0f ? LED_G : x <= 1 / 3.0f ? LED_B : 0;
    case BANDS_QUARTERS_RED_ABOVE_ONE_QUARTER:
      return x <= 0.25f ? LED_ALL : LED_R | (x > 0.5f && x < 0.75f ? LED_G : 0) | (x > 0.25f && x < 0.5f ? LED_B : 0);
  }
  return 0;
}

static void light(uint32_t ch, uint32_t leds) {
  lab3.leds[ch] = leds;
  if (v->leds_by_pwm) {
    volatile uint32_t *ccr = ch ? &TIM3->CCR1 : &TIM4->CCR1;
    for (unsigned die = 0; die < 3; die++) ccr[die] = (leds >> die) & 1u ? LED_PWM_LIT : 0;
    return;
  }
  GPIO_TypeDef *port = ch ? GPIOG : GPIOD;
  const unsigned pins[3] = {ch ? PG9 : PD12, ch ? PG10 : PD13, ch ? PG11 : PD14};
  for (unsigned die = 0; die < 3; die++) pad_write(port, pins[die], (leds >> die) & 1u);
}

static void take(uint16_t first, uint16_t second) {
  const uint16_t samples[CHANNELS] = {first, second};
  uint32_t at = lab3.log_at;
  for (uint32_t ch = 0; ch < CHANNELS; ch++) {
    float out;
    int fresh = v->filter == FILTER_RMS || v->filter == FILTER_MEAN ? block(ch, samples[ch], &out) : sliding(ch, samples[ch], &out);
    lab3.raw_log[ch][at] = samples[ch];
    lab3.filtered_log[ch][at] = fresh ? out : lab3.filtered[ch];
    if (!fresh) continue;
    lab3.filtered[ch] = out;
    if (v->task == TASK_BRIGHTNESS || v->task == TASK_GENERATOR) {
      turned(ch, out);
      continue;
    }
    lab3.measured[ch] = out;
    light(ch, colours(out));
  }
  lab3.log_at = (at + 1) % LOG;
  lab3.scans++;
}

static void scans_ready(void) {
  uint32_t flags = DMA2->LISR;
  DMA2->LIFCR = flags & (DMA_LISR_HTIF0 | DMA_LISR_TCIF0 | DMA_LISR_TEIF0 | DMA_LISR_DMEIF0 | DMA_LISR_FEIF0);
  if (flags & DMA_LISR_HTIF0)
    for (uint32_t s = 0; s < RING_SCANS / 2; s++) take(ring[2 * s], ring[2 * s + 1]);
  if (flags & DMA_LISR_TCIF0)
    for (uint32_t s = RING_SCANS / 2; s < RING_SCANS; s++) take(ring[2 * s], ring[2 * s + 1]);
}

static void pair_duty(uint32_t percent) {
  lab3.duty = percent;
  TIM3->CCR1 = (TIM3->ARR + 1) * percent / 100;
  TIM3->CCR2 = TIM3->CCR1;
}

static uint32_t stable[2];
static uint32_t last_level[2] = {1, 1};
static uint32_t acted[2];

static void every_millisecond(void) {
  if (v->task != TASK_VOLTMETER_PWM) return;
  const unsigned pins[2] = {PG2, PG3};
  for (unsigned k = 0; k < 2; k++) {
    uint32_t level = pad_read(GPIOG, pins[k]);
    if (level != last_level[k]) {
      last_level[k] = level;
      stable[k] = 0;
      continue;
    }
    if (stable[k] < DEBOUNCE_MS) stable[k]++;
    if (stable[k] < DEBOUNCE_MS) continue;
    if (level) {
      acted[k] = 0;
      continue;
    }
    if (acted[k]) continue;
    acted[k] = 1;
    lab3.presses++;
    pair_duty(stepped(&v->control[0], lab3.duty, k == 0 ? 1 : -1));
  }
}

static void adc3_paced_by_tim5(uint32_t sample_hz) {
  RCC->APB2ENR |= RCC_APB2ENR_ADC3EN;
  RCC->APB1ENR |= RCC_APB1ENR_TIM5EN;
  RCC->AHB1ENR |= RCC_AHB1ENR_DMA2EN;
  (void)RCC->AHB1ENR;
  pad_mode(GPIOF, PF9, MODE_ANALOG, PULL_NONE);
  pad_mode(GPIOF, PF8, MODE_ANALOG, PULL_NONE);
  ADC123_COMMON->CCR = ADC_CCR_ADCPRE_0;
  ADC3->SMPR2 = (SMP_56_CYCLES << ADC_SMPR2_SMP7_Pos) | (SMP_56_CYCLES << ADC_SMPR2_SMP6_Pos);
  ADC3->SQR1 = 1u << ADC_SQR1_L_Pos;
  ADC3->SQR3 = (ADC3_POT1 << ADC_SQR3_SQ1_Pos) | (ADC3_POT2 << ADC_SQR3_SQ2_Pos);
  ADC3->CR1 = ADC_CR1_SCAN;
  DMA2_Stream0->PAR = (uint32_t)&ADC3->DR;
  DMA2_Stream0->M0AR = (uint32_t)ring;
  DMA2_Stream0->NDTR = 2 * RING_SCANS;
  DMA2_Stream0->CR = (DMA_CHANNEL_ADC3 << DMA_SxCR_CHSEL_Pos) | DMA_SxCR_MSIZE_0 | DMA_SxCR_PSIZE_0 | DMA_SxCR_MINC | DMA_SxCR_CIRC | DMA_SxCR_HTIE | DMA_SxCR_TCIE | DMA_SxCR_EN;
  irq_attach(DMA2_Stream0_IRQn, scans_ready);
  ADC3->CR2 = ADC_CR2_ADON | ADC_CR2_DMA | ADC_CR2_DDS | ADC_CR2_EXTEN_0 | (EXTSEL_TIM5_TRGO << ADC_CR2_EXTSEL_Pos);
  TIM5->PSC = MICROSECOND_TICKS - 1;
  TIM5->ARR = 1000000u / sample_hz - 1;
  TIM5->EGR = TIM_EGR_UG;
  TIM5->CR2 = MMS_UPDATE << TIM_CR2_MMS_Pos;
  TIM5->CR1 = TIM_CR1_CEN;
}

static void tim4_pwm(uint32_t prescaler, uint32_t channels, uint32_t inverted_ch2) {
  RCC->APB1ENR |= RCC_APB1ENR_TIM4EN;
  (void)RCC->APB1ENR;
  TIM4->PSC = prescaler - 1;
  TIM4->CCMR1 = (PWM_MODE_1 << TIM_CCMR1_OC1M_Pos) | TIM_CCMR1_OC1PE | (PWM_MODE_1 << TIM_CCMR1_OC2M_Pos) | TIM_CCMR1_OC2PE;
  TIM4->CCMR2 = (PWM_MODE_1 << TIM_CCMR2_OC3M_Pos) | TIM_CCMR2_OC3PE;
  uint32_t ccer = 0;
  for (unsigned ch = 1; ch <= 3; ch++) {
    unsigned pin = PD12 + ch - 1;
    if (channels & (1u << ch)) {
      ccer |= TIM_CCER_CC1E << (4 * (ch - 1));
      pad_af(GPIOD, pin, AF_TIM3_TIM4, PULL_NONE);
    } else pad_output(GPIOD, pin);
  }
  TIM4->CCER = ccer | (inverted_ch2 ? TIM_CCER_CC2P : 0);
}

static void start_tim4(void) {
  TIM4->CR1 = TIM_CR1_ARPE;
  TIM4->EGR = TIM_EGR_UG;
  TIM4->CR1 = TIM_CR1_ARPE | TIM_CR1_CEN;
}

static void setup_brightness(void) {
  tim4_pwm(APB1_TIMER_HZ / (v->pwm_hz * PWM_STEPS), (1u << v->control[0].tim4_channel) | (1u << v->control[1].tim4_channel), 0);
  TIM4->ARR = PWM_STEPS - 1;
  for (uint32_t ch = 0; ch < CHANNELS; ch++) show_level(ch);
  start_tim4();
}

static void setup_generator(void) {
  tim4_pwm(MICROSECOND_TICKS, (1u << 1) | (1u << 2), 1);
  show_level(0);
  start_tim4();
}

static void setup_pwm_pair(void) {
  RCC->APB1ENR |= RCC_APB1ENR_TIM3EN;
  (void)RCC->APB1ENR;
  pad_af(GPIOB, PB4, AF_TIM3_TIM4, PULL_NONE);
  pad_af(GPIOB, PB5, AF_TIM3_TIM4, PULL_NONE);
  pad_mode(GPIOG, PG2, 0, PULL_UP);
  pad_mode(GPIOG, PG3, 0, PULL_UP);
  TIM3->PSC = APB1_TIMER_HZ / CENTI_TICK_HZ - 1;
  TIM3->ARR = CENTI_TICK_HZ / v->pwm_hz - 1;
  TIM3->CCMR1 = (PWM_MODE_1 << TIM_CCMR1_OC1M_Pos) | TIM_CCMR1_OC1PE | (PWM_MODE_1 << TIM_CCMR1_OC2M_Pos) | TIM_CCMR1_OC2PE;
  TIM3->CCER = TIM_CCER_CC1E | TIM_CCER_CC2E | TIM_CCER_CC2P;
  pair_duty(v->control[0].minimum);
  TIM3->CR1 = TIM_CR1_ARPE;
  TIM3->EGR = TIM_EGR_UG;
  TIM3->CR1 = TIM_CR1_ARPE | TIM_CR1_CEN;
}

static void dimmed_by_pwm(TIM_TypeDef *tim, GPIO_TypeDef *port, unsigned first_pin) {
  tim->PSC = MICROSECOND_TICKS - 1;
  tim->ARR = LED_PWM_PERIOD - 1;
  tim->CCMR1 = (PWM_MODE_1 << TIM_CCMR1_OC1M_Pos) | TIM_CCMR1_OC1PE | (PWM_MODE_1 << TIM_CCMR1_OC2M_Pos) | TIM_CCMR1_OC2PE;
  tim->CCMR2 = (PWM_MODE_1 << TIM_CCMR2_OC3M_Pos) | TIM_CCMR2_OC3PE;
  tim->CCER = TIM_CCER_CC1E | TIM_CCER_CC2E | TIM_CCER_CC3E;
  for (unsigned die = 0; die < 3; die++) pad_af(port, first_pin + die, AF_TIM3_TIM4, PULL_NONE);
  tim->CR1 = TIM_CR1_ARPE;
  tim->EGR = TIM_EGR_UG;
  tim->CR1 = TIM_CR1_ARPE | TIM_CR1_CEN;
}

static void voltmeter_leds(void) {
  if (v->leds_by_pwm) {
    RCC->APB1ENR |= RCC_APB1ENR_TIM3EN | RCC_APB1ENR_TIM4EN;
    (void)RCC->APB1ENR;
    dimmed_by_pwm(TIM4, GPIOD, PD12);
    dimmed_by_pwm(TIM3, GPIOC, PC6);
    return;
  }
  const unsigned d[3] = {PD12, PD13, PD14};
  const unsigned g[3] = {PG9, PG10, PG11};
  for (unsigned die = 0; die < 3; die++) {
    pad_output(GPIOD, d[die]);
    pad_output(GPIOG, g[die]);
  }
}

static void systick_handler(void) {
  every_millisecond();
}

int main(void) {
  clock_216mhz_apb1_4_apb2_2();
  ports_on();
  vectors_install();
  uint32_t chosen = lab3_variant;
  if (chosen < 1 || chosen > 12) chosen = 1;
  v = &VARIANTS[chosen];
  lab3.variant = chosen;
  for (uint32_t ch = 0; ch < CHANNELS; ch++) {
    lab3.level[ch] = v->control[ch].minimum;
    lab3.band[ch] = -1;
  }
  uint32_t sample_hz = POT_SAMPLE_HZ;
  switch (v->task) {
    case TASK_BRIGHTNESS:
      setup_brightness();
      break;
    case TASK_GENERATOR:
      setup_generator();
      break;
    case TASK_VOLTMETER_POTS:
      voltmeter_leds();
      break;
    case TASK_VOLTMETER_PWM:
      voltmeter_leds();
      setup_pwm_pair();
      sample_hz = v->pwm_hz * PWM_SAMPLES_PER_PERIOD;
      vectors[15] = systick_handler;
      SysTick->LOAD = HCLK_HZ / SYSTICK_HZ - 1;
      SysTick->VAL = 0;
      SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_TICKINT_Msk | SysTick_CTRL_ENABLE_Msk;
      break;
  }
  adc3_paced_by_tim5(sample_hz);
  for (;;) __WFI();
}
