#include <stdint.h>
#include "stm32f746xx.h"

const volatile uint32_t lab1_variant = 1;
const volatile uint32_t lab1_debounce_ticks = 200;

enum { SYSCLK_HZ = 50000000, TICK_HZ = 10000, TICKS_PER_MS = TICK_HZ / 1000 };
enum { LEDS = 4, ALL_LEDS = 0xf, VARIANTS = 12 };
enum { COUNTER_SHOWN_FOR_TICKS = 1000 * TICKS_PER_MS, PWM_SLOT_TICKS = 5, COUNTER_MASK = 0xf };

typedef enum { JOY_A, JOY_B, JOY_C, JOY_D, JOY_CTR, JOYSTICK_LINES } joystick_t;
typedef enum { RUNNING_LIGHT, RUNNING_WALL, FILL_AND_DRAIN, BLINK, PRESS_COUNTERS, FADE_IN, FADE_OUT } pattern_t;
typedef enum {
  NOTHING,
  RUN_RIGHT_TO_LEFT,
  RUN_LEFT_TO_RIGHT,
  LONGER_DWELL,
  SHORTER_DWELL,
  MORE_BLINKING,
  FEWER_BLINKING,
  FASTER_BLINK,
  SLOWER_BLINK,
  COUNT_PRESS,
  MORE_STATES,
  FEWER_STATES,
  LONGER_FADE,
  SHORTER_FADE,
} action_t;

typedef struct {
  pattern_t pattern;
  action_t on_press[JOY_CTR];
  uint32_t lowest;
  uint32_t highest;
  uint32_t step;
  uint32_t fewest_states;
  uint32_t most_states;
  int32_t count_step;
  uint32_t count_start;
  joystick_t display_order[JOY_CTR];
} variant_t;

static const variant_t variants[VARIANTS] = {
  { .pattern = RUNNING_LIGHT, .on_press = { LONGER_DWELL, RUN_LEFT_TO_RIGHT, RUN_RIGHT_TO_LEFT, SHORTER_DWELL }, .lowest = 1000, .highest = 5000, .step = 1000 },
  { .pattern = RUNNING_WALL, .on_press = { LONGER_DWELL, RUN_LEFT_TO_RIGHT, RUN_RIGHT_TO_LEFT, SHORTER_DWELL }, .lowest = 1000, .highest = 7000, .step = 1500 },
  { .pattern = BLINK, .on_press = { FASTER_BLINK, FEWER_BLINKING, MORE_BLINKING, SLOWER_BLINK }, .lowest = 2, .highest = 12, .step = 2 },
  { .pattern = PRESS_COUNTERS, .on_press = { COUNT_PRESS, COUNT_PRESS, COUNT_PRESS, COUNT_PRESS }, .count_step = 1, .count_start = 0, .display_order = { JOY_A, JOY_B, JOY_C, JOY_D } },
  { .pattern = FADE_IN, .on_press = { MORE_STATES, FEWER_STATES, LONGER_FADE, SHORTER_FADE }, .lowest = 5000, .highest = 10000, .step = 1000, .fewest_states = 5, .most_states = 10 },
  { .pattern = FILL_AND_DRAIN, .on_press = { LONGER_DWELL, RUN_LEFT_TO_RIGHT, RUN_RIGHT_TO_LEFT, SHORTER_DWELL }, .lowest = 500, .highest = 1500, .step = 200 },
  { .pattern = RUNNING_LIGHT, .on_press = { SHORTER_DWELL, RUN_RIGHT_TO_LEFT, RUN_LEFT_TO_RIGHT, LONGER_DWELL }, .lowest = 500, .highest = 3500, .step = 500 },
  { .pattern = RUNNING_WALL, .on_press = { SHORTER_DWELL, RUN_RIGHT_TO_LEFT, RUN_LEFT_TO_RIGHT, LONGER_DWELL }, .lowest = 500, .highest = 7500, .step = 2000 },
  { .pattern = BLINK, .on_press = { SLOWER_BLINK, MORE_BLINKING, FEWER_BLINKING, FASTER_BLINK }, .lowest = 3, .highest = 15, .step = 3 },
  { .pattern = PRESS_COUNTERS, .on_press = { COUNT_PRESS, COUNT_PRESS, COUNT_PRESS, COUNT_PRESS }, .count_step = -1, .count_start = 15, .display_order = { JOY_D, JOY_C, JOY_B, JOY_A } },
  { .pattern = FADE_OUT, .on_press = { FEWER_STATES, MORE_STATES, SHORTER_FADE, LONGER_FADE }, .lowest = 10000, .highest = 15000, .step = 1000, .fewest_states = 10, .most_states = 15 },
  { .pattern = FILL_AND_DRAIN, .on_press = { SHORTER_DWELL, RUN_RIGHT_TO_LEFT, RUN_LEFT_TO_RIGHT, LONGER_DWELL }, .lowest = 1400, .highest = 3400, .step = 400 },
};

typedef struct {
  GPIO_TypeDef *port;
  uint32_t pin;
} pad_t;

static const pad_t leds[LEDS] = { { GPIOB, 6 }, { GPIOB, 7 }, { GPIOH, 4 }, { GPIOI, 8 } };
static const pad_t joystick[JOYSTICK_LINES] = { { GPIOG, 2 }, { GPIOG, 3 }, { GPIOD, 4 }, { GPIOD, 5 }, { GPIOI, 11 } };

static volatile uint32_t ticks;
static const variant_t *variant;
static uint32_t setting;
static uint32_t states;
static uint32_t shown = ~0u;

static int32_t direction;
static uint32_t head;
static uint32_t lit;
static int growing;
static int anchored_right;
static int blanked;
static uint32_t last_step;

static uint32_t blinking_leds;
static int blinking;
static uint32_t blink_from;

static uint32_t counters[JOY_CTR];
static int counters_shown;
static uint32_t counter_slot;
static uint32_t counter_slot_from;

static int fading;
static int fully_lit;
static uint32_t fade_from;

static int settled_pressed[JOYSTICK_LINES];
static uint32_t disagreeing_ticks[JOYSTICK_LINES];

void SysTick_Handler(void) {
  ticks++;
}

static void clock_50mhz_from_hse(void) {
  RCC->APB1ENR |= RCC_APB1ENR_PWREN;
  (void)RCC->APB1ENR;
  PWR->CR1 = (PWR->CR1 & ~PWR_CR1_VOS) | PWR_CR1_VOS_0;
  RCC->CR |= RCC_CR_HSEON;
  while (!(RCC->CR & RCC_CR_HSERDY)) {
  }
  RCC->PLLCFGR = (4u << RCC_PLLCFGR_PLLM_Pos) | (50u << RCC_PLLCFGR_PLLN_Pos) | (0u << RCC_PLLCFGR_PLLP_Pos) | RCC_PLLCFGR_PLLSRC_HSE | (2u << RCC_PLLCFGR_PLLQ_Pos);
  RCC->CR |= RCC_CR_PLLON;
  while (!(RCC->CR & RCC_CR_PLLRDY)) {
  }
  FLASH->ACR = FLASH_ACR_LATENCY_1WS;
  RCC->CFGR &= ~(RCC_CFGR_HPRE | RCC_CFGR_PPRE1 | RCC_CFGR_PPRE2);
  RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_SW) | RCC_CFGR_SW_PLL;
  while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_PLL) {
  }
}

static void pad_mode(const pad_t *pad, uint32_t mode, uint32_t pull) {
  pad->port->PUPDR = (pad->port->PUPDR & ~(3u << (2 * pad->pin))) | (pull << (2 * pad->pin));
  pad->port->MODER = (pad->port->MODER & ~(3u << (2 * pad->pin))) | (mode << (2 * pad->pin));
}

static void leds_and_joystick(void) {
  RCC->AHB1ENR |= RCC_AHB1ENR_GPIOBEN | RCC_AHB1ENR_GPIODEN | RCC_AHB1ENR_GPIOGEN | RCC_AHB1ENR_GPIOHEN | RCC_AHB1ENR_GPIOIEN;
  (void)RCC->AHB1ENR;
  enum { INPUT = 0, OUTPUT = 1, NO_PULL = 0, PULL_UP = 1, LOW_SPEED = 0 };
  for (int i = 0; i < LEDS; i++) {
    leds[i].port->BSRR = 1u << (leds[i].pin + 16);
    leds[i].port->OTYPER &= ~(1u << leds[i].pin);
    leds[i].port->OSPEEDR = (leds[i].port->OSPEEDR & ~(3u << (2 * leds[i].pin))) | (LOW_SPEED << (2 * leds[i].pin));
    pad_mode(&leds[i], OUTPUT, NO_PULL);
  }
  for (int i = 0; i < JOYSTICK_LINES; i++) pad_mode(&joystick[i], INPUT, PULL_UP);
}

static void show(uint32_t mask) {
  if (mask == shown) return;
  shown = mask;
  for (int i = 0; i < LEDS; i++) leds[i].port->BSRR = (mask >> i) & 1u ? 1u << leds[i].pin : 1u << (leds[i].pin + 16);
}

static uint32_t raised(uint32_t value, uint32_t step, uint32_t highest) {
  return value + step < highest ? value + step : highest;
}

static uint32_t lowered(uint32_t value, uint32_t step, uint32_t lowest) {
  return value > lowest + step ? value - step : lowest;
}

static uint32_t rotated(uint32_t position, int32_t by) {
  return (position + (uint32_t)by) & (LEDS - 1);
}

static uint32_t moving_picture(void) {
  if (blanked) return 0;
  if (variant->pattern == RUNNING_LIGHT) return 1u << head;
  if (variant->pattern == RUNNING_WALL) return (1u << head) | (1u << rotated(head, 1));
  uint32_t bar = (1u << lit) - 1u;
  return anchored_right ? bar : (bar << (LEDS - lit)) & ALL_LEDS;
}

static void step_moving(void) {
  if (variant->pattern != FILL_AND_DRAIN) {
    head = rotated(head, direction);
    return;
  }
  lit = growing ? lit + 1 : lit - 1;
  if (lit == LEDS) growing = 0;
  if (lit == 1) growing = 1;
}

static void run(int32_t towards, uint32_t now) {
  if (!direction || blanked) last_step = now;
  direction = towards;
  blanked = 0;
  if (variant->pattern == FILL_AND_DRAIN) anchored_right = towards > 0;
}

static void centre_pressed(uint32_t now) {
  switch (variant->pattern) {
    case RUNNING_LIGHT:
    case FILL_AND_DRAIN:
      direction = 0;
      break;
    case RUNNING_WALL:
      direction = 0;
      blanked = 1;
      break;
    case BLINK:
      blinking = !blinking;
      blink_from = now;
      break;
    case PRESS_COUNTERS:
      counters_shown = !counters_shown;
      counter_slot = 0;
      counter_slot_from = now;
      break;
    case FADE_IN:
    case FADE_OUT:
      fading = 1;
      fade_from = now;
      break;
  }
}

static void pressed(joystick_t line, uint32_t now) {
  if (line == JOY_CTR) {
    centre_pressed(now);
    return;
  }
  const variant_t *v = variant;
  switch (v->on_press[line]) {
    case RUN_RIGHT_TO_LEFT:
      run(1, now);
      break;
    case RUN_LEFT_TO_RIGHT:
      run(-1, now);
      break;
    case LONGER_DWELL:
    case LONGER_FADE:
      setting = raised(setting, v->step, v->highest);
      break;
    case SHORTER_DWELL:
    case SHORTER_FADE:
      setting = lowered(setting, v->step, v->lowest);
      break;
    case FASTER_BLINK:
      setting = raised(setting, v->step, v->highest);
      blink_from = now;
      break;
    case SLOWER_BLINK:
      setting = lowered(setting, v->step, v->lowest);
      blink_from = now;
      break;
    case MORE_BLINKING:
      blinking_leds = raised(blinking_leds, 1, LEDS);
      break;
    case FEWER_BLINKING:
      blinking_leds = lowered(blinking_leds, 1, 1);
      break;
    case COUNT_PRESS:
      counters[line] += (uint32_t)v->count_step;
      break;
    case MORE_STATES:
      states = raised(states, 1, v->most_states);
      break;
    case FEWER_STATES:
      states = lowered(states, 1, v->fewest_states);
      break;
    case NOTHING:
      break;
  }
}

static void poll_joystick(uint32_t now) {
  for (int i = 0; i < JOYSTICK_LINES; i++) {
    int down = !(joystick[i].port->IDR & (1u << joystick[i].pin));
    if (down == settled_pressed[i]) {
      disagreeing_ticks[i] = 0;
      continue;
    }
    if (++disagreeing_ticks[i] < lab1_debounce_ticks) continue;
    disagreeing_ticks[i] = 0;
    settled_pressed[i] = down;
    if (down) pressed((joystick_t)i, now);
  }
}

static uint32_t fade_picture(uint32_t now) {
  uint32_t span = setting * TICKS_PER_MS;
  uint32_t elapsed = now - fade_from;
  uint32_t levels = states + 1;
  if (elapsed >= span) {
    fading = 0;
    fully_lit = variant->pattern == FADE_IN;
    return fully_lit ? ALL_LEDS : 0;
  }
  uint32_t segment = elapsed * levels / span;
  uint32_t segment_from = segment * span / levels;
  uint32_t on_slots = variant->pattern == FADE_IN ? segment : levels - segment;
  uint32_t phase = (elapsed - segment_from) % (levels * PWM_SLOT_TICKS);
  return phase < on_slots * PWM_SLOT_TICKS ? ALL_LEDS : 0;
}

static uint32_t picture(uint32_t now) {
  switch (variant->pattern) {
    case RUNNING_LIGHT:
    case RUNNING_WALL:
    case FILL_AND_DRAIN:
      if (direction && now - last_step >= setting * TICKS_PER_MS) {
        step_moving();
        last_step = now;
      }
      return moving_picture();
    case BLINK: {
      uint32_t lit_leds = (1u << blinking_leds) - 1u;
      if (!blinking) return lit_leds;
      uint32_t half_periods = (now - blink_from) * 2u * setting / TICK_HZ;
      return half_periods & 1u ? 0 : lit_leds;
    }
    case PRESS_COUNTERS:
      if (!counters_shown) return 0;
      if (now - counter_slot_from >= COUNTER_SHOWN_FOR_TICKS) {
        counter_slot = (counter_slot + 1) & (JOY_CTR - 1);
        counter_slot_from += COUNTER_SHOWN_FOR_TICKS;
      }
      return counters[variant->display_order[counter_slot]] & COUNTER_MASK;
    case FADE_IN:
    case FADE_OUT:
      if (fading) return fade_picture(now);
      return fully_lit ? ALL_LEDS : 0;
  }
  return 0;
}

static void tick(uint32_t now) {
  if (!fading) poll_joystick(now);
  show(picture(now));
}

static void start(uint32_t number) {
  variant = &variants[(number >= 1 && number <= VARIANTS ? number : 1) - 1];
  setting = variant->lowest;
  states = variant->fewest_states;
  head = 0;
  lit = 1;
  growing = 1;
  anchored_right = 1;
  blinking_leds = 1;
  blinking = 1;
  fully_lit = variant->pattern == FADE_OUT;
  for (int i = 0; i < JOY_CTR; i++) counters[i] = variant->count_start;
}

int main(void) {
  clock_50mhz_from_hse();
  leds_and_joystick();
  start(lab1_variant);
  SysTick->LOAD = SYSCLK_HZ / TICK_HZ - 1;
  SysTick->VAL = 0;
  SysTick->CTRL = SysTick_CTRL_CLKSOURCE_Msk | SysTick_CTRL_TICKINT_Msk | SysTick_CTRL_ENABLE_Msk;
  uint32_t handled = 0;
  for (;;) {
    __disable_irq();
    if (handled == ticks) __WFI();
    __enable_irq();
    while (handled != ticks) {
      handled++;
      tick(handled);
    }
  }
}
