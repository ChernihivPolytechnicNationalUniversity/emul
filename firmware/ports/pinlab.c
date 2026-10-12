#include <stdint.h>

#define RCC_AHB1ENR (*(volatile uint32_t *)0x40023830u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x40023840u)
#define RCC_APB2ENR (*(volatile uint32_t *)0x40023844u)
#define RCC_BDCR (*(volatile uint32_t *)0x40023870u)
#define PWR_CR1 (*(volatile uint32_t *)0x40007000u)
#define GPIO(port) ((volatile uint32_t *)(0x40020000u + 0x400u * (port)))
#define TIM2_REG(offset) (*(volatile uint32_t *)(0x40000000u + (offset)))
#define USART1_REG(offset) (*(volatile uint32_t *)(0x40011000u + (offset)))
#define ADC1_REG(offset) (*(volatile uint32_t *)(0x40012000u + (offset)))
#define ADC_COMMON_CCR (*(volatile uint32_t *)0x40012304u)
#define DAC_REG(offset) (*(volatile uint32_t *)(0x40007400u + (offset)))
#define FACTORY_WORD(offset) (*(volatile const uint32_t *)(0x1ff0f420u + (offset)))
#define FACTORY_HALF(offset) (*(volatile const uint16_t *)(0x1ff0f420u + (offset)))
#define VREFINT_CAL FACTORY_HALF(0x2au)
#define PAD(port, pin) ((uint8_t)(((port) - 'A') * 16 + (pin)))
#define PORT_OF(pad) ((uint32_t)(pad) >> 4)
#define LINE_OF(pad) ((uint32_t)(pad) & 15u)

enum { MODER = 0, PUPDR = 3, IDR = 4, BSRR = 6, AFRH = 9 };
enum { PORTS = 9, PADS = 8 * 16 + 12, NO_PAD = 0xff };
enum { MODE_INPUT = 0, MODE_OUTPUT = 1, MODE_ALTERNATE = 2, MODE_ANALOG = 3, PULL_NONE = 0, PULL_UP = 1, PULL_DOWN = 2 };
enum { TIM_CR1 = 0x00, TIM_EGR = 0x14, TIM_CNT = 0x24, TIM_PSC = 0x28, TIM_ARR = 0x2c, CEN = 1u << 0, UG = 1u << 0 };
enum { USART_CR1 = 0x00, USART_BRR = 0x0c, USART_ISR = 0x1c, USART_TDR = 0x28, UE = 1u << 0, TE = 1u << 3, TXE = 1u << 7, TC = 1u << 6 };
enum { ADC_SR = 0x00, ADC_CR2 = 0x08, ADC_SMPR1 = 0x0c, ADC_SMPR2 = 0x10, ADC_SQR1 = 0x2c, ADC_SQR3 = 0x34, ADC_DR = 0x4c };
enum { ADON = 1u << 0, SWSTART = 1u << 30, EOC = 1u << 1, TSVREFE = 1u << 23, LONGEST_SAMPLES_10_TO_18 = 0x07ffffffu, LONGEST_SAMPLES_0_TO_9 = 0x3fffffffu };
enum { DAC_CR = 0x00, DAC_DHR12R1 = 0x08, DAC_EN1 = 1u << 0 };
enum { TIM2_ENABLE = 1u << 0, DAC_ENABLE = 1u << 29, PWREN = 1u << 28, USART1_ENABLE = 1u << 4, ADC1_ENABLE = 1u << 8, DBP = 1u << 8, BDRST = 1u << 16 };
enum { HSI_HZ = 16000000u, TICKS_PER_US = HSI_HZ / 1000000u, BAUD = 115200u, AF_USART1 = 7 };
enum { DAC_FULL = 4095, STEP_SETTLE_US = 20, SETTLE_US = 2000, SWEEPS = 5, AVERAGED = 64, PAUSE_US = 1000000 };
enum { CHANNEL_PA4 = 4, CHANNEL_VREFINT = 17, VREFINT_CAL_MILLIVOLTS = 3300 };
enum { DAC_PIN = PAD('A', 4), UART_TX = PAD('A', 9), UART_RX = PAD('A', 10), SDRAM_CHIP_SELECT = PAD('H', 6), SDRAM_CLOCK = PAD('G', 8), SDRAM_CLOCK_ENABLE = PAD('H', 7) };

typedef struct {
  uint16_t rise_code;
  uint16_t fall_code;
} sweep_t;

volatile struct {
  uint32_t passes;
  uint32_t vdda_mv;
  uint32_t target;
  uint32_t rise_mv_min;
  uint32_t rise_mv_max;
  uint32_t fall_mv_min;
  uint32_t fall_mv_max;
  uint32_t high_mv;
  uint32_t low_mv;
  uint32_t pull_up_mv;
  uint32_t pull_down_mv;
  uint32_t wired_mv;
} lab = { .target = NO_PAD };

static uint32_t now(void) {
  return TIM2_REG(TIM_CNT);
}

static void wait_us(uint32_t us) {
  uint32_t start = now();
  while (now() - start < us * TICKS_PER_US) {
  }
}

static void set_mode(uint32_t pad, uint32_t mode) {
  volatile uint32_t *gpio = GPIO(PORT_OF(pad));
  uint32_t shift = 2 * LINE_OF(pad);
  gpio[MODER] = (gpio[MODER] & ~(3u << shift)) | (mode << shift);
}

static void set_pull(uint32_t pad, uint32_t pull) {
  volatile uint32_t *gpio = GPIO(PORT_OF(pad));
  uint32_t shift = 2 * LINE_OF(pad);
  gpio[PUPDR] = (gpio[PUPDR] & ~(3u << shift)) | (pull << shift);
}

static void set_level(uint32_t pad, uint32_t high) {
  GPIO(PORT_OF(pad))[BSRR] = (1u << LINE_OF(pad)) << (high ? 0 : 16);
}

static uint32_t level(uint32_t pad) {
  return (GPIO(PORT_OF(pad))[IDR] >> LINE_OF(pad)) & 1u;
}

static uint32_t is_reserved(uint32_t pad) {
  return pad == DAC_PIN || pad == UART_TX || pad == UART_RX || pad == SDRAM_CHIP_SELECT || pad == SDRAM_CLOCK || pad == SDRAM_CLOCK_ENABLE;
}

static void park(uint32_t pad, uint32_t high) {
  set_level(pad, high);
  set_pull(pad, PULL_NONE);
  set_mode(pad, MODE_OUTPUT);
}

static void free_backup_domain_pads(void) {
  RCC_APB1ENR |= PWREN;
  (void)RCC_APB1ENR;
  PWR_CR1 |= DBP;
  for (uint32_t polls = 0; polls < 1000u && !(PWR_CR1 & DBP); polls++) {
  }
  RCC_BDCR = BDRST;
  RCC_BDCR = 0;
}

static void start_clocks(void) {
  RCC_AHB1ENR |= (1u << PORTS) - 1;
  RCC_APB1ENR |= TIM2_ENABLE | DAC_ENABLE;
  RCC_APB2ENR |= USART1_ENABLE | ADC1_ENABLE;
  (void)RCC_APB2ENR;
  TIM2_REG(TIM_PSC) = 0;
  TIM2_REG(TIM_ARR) = 0xffffffffu;
  TIM2_REG(TIM_EGR) = UG;
  TIM2_REG(TIM_CR1) = CEN;
}

static void start_serial(void) {
  volatile uint32_t *gpio = GPIO(PORT_OF(UART_TX));
  gpio[AFRH] = (gpio[AFRH] & ~(0xffu << 4)) | (AF_USART1 << 4) | (AF_USART1 << 8);
  set_mode(UART_TX, MODE_ALTERNATE);
  set_mode(UART_RX, MODE_ALTERNATE);
  set_pull(UART_RX, PULL_UP);
  USART1_REG(USART_BRR) = (HSI_HZ + BAUD / 2) / BAUD;
  USART1_REG(USART_CR1) = UE | TE;
}

static void start_analog(void) {
  ADC_COMMON_CCR |= TSVREFE;
  ADC1_REG(ADC_SMPR1) = LONGEST_SAMPLES_10_TO_18;
  ADC1_REG(ADC_SMPR2) = LONGEST_SAMPLES_0_TO_9;
  ADC1_REG(ADC_SQR1) = 0;
  ADC1_REG(ADC_CR2) = ADON;
  wait_us(10);
}

static uint32_t convert(uint32_t channel) {
  ADC1_REG(ADC_SQR3) = channel;
  ADC1_REG(ADC_CR2) = ADON | SWSTART;
  while (!(ADC1_REG(ADC_SR) & EOC)) {
  }
  return ADC1_REG(ADC_DR) & 0xfffu;
}

static uint32_t averaged(uint32_t channel) {
  uint32_t sum = 0;
  for (uint32_t i = 0; i < AVERAGED; i++) sum += convert(channel);
  return (sum + AVERAGED / 2) / AVERAGED;
}

static uint32_t millivolts(uint32_t code) {
  return (code * lab.vdda_mv + DAC_FULL / 2) / DAC_FULL;
}

static void dac_on(uint32_t code) {
  DAC_REG(DAC_DHR12R1) = code;
  DAC_REG(DAC_CR) = DAC_EN1;
}

static void dac_off(void) {
  DAC_REG(DAC_CR) = 0;
}

static void float_every_free_pad(void) {
  for (uint32_t pad = 0; pad < PADS; pad++) {
    if (is_reserved(pad)) continue;
    set_pull(pad, PULL_NONE);
    set_mode(pad, MODE_INPUT);
  }
}

static void pull_every_free_pad(uint32_t pull) {
  for (uint32_t pad = 0; pad < PADS; pad++)
    if (!is_reserved(pad)) set_pull(pad, pull);
}

static uint32_t find_target(void) {
  uint32_t low[PORTS];
  uint32_t high[PORTS];
  pull_every_free_pad(PULL_UP);
  dac_on(0);
  wait_us(SETTLE_US);
  for (uint32_t port = 0; port < PORTS; port++) low[port] = GPIO(port)[IDR];
  pull_every_free_pad(PULL_DOWN);
  dac_on(DAC_FULL);
  wait_us(SETTLE_US);
  for (uint32_t port = 0; port < PORTS; port++) high[port] = GPIO(port)[IDR];
  pull_every_free_pad(PULL_NONE);
  dac_on(0);
  for (uint32_t pad = 0; pad < PADS; pad++) {
    if (is_reserved(pad)) continue;
    uint32_t bit = 1u << LINE_OF(pad);
    if (!(low[PORT_OF(pad)] & bit) && (high[PORT_OF(pad)] & bit)) return pad;
  }
  return NO_PAD;
}

static sweep_t sweep(uint32_t target) {
  sweep_t result = { DAC_FULL, 0 };
  dac_on(0);
  wait_us(SETTLE_US);
  for (uint32_t code = 0; code <= DAC_FULL; code++) {
    dac_on(code);
    wait_us(STEP_SETTLE_US);
    if (level(target)) {
      result.rise_code = (uint16_t)code;
      break;
    }
  }
  dac_on(DAC_FULL);
  wait_us(SETTLE_US);
  for (uint32_t code = DAC_FULL + 1; code-- > 0;) {
    dac_on(code);
    wait_us(STEP_SETTLE_US);
    if (!level(target)) {
      result.fall_code = (uint16_t)code;
      break;
    }
  }
  return result;
}

static uint32_t voltage_at_code(uint32_t code) {
  dac_on(code);
  wait_us(SETTLE_US);
  return millivolts(averaged(CHANNEL_PA4));
}

static uint32_t voltage_of_target(uint32_t target, uint32_t mode, uint32_t pull, uint32_t high) {
  dac_off();
  set_level(target, high);
  set_pull(target, pull);
  set_mode(target, mode);
  wait_us(SETTLE_US);
  uint32_t mv = millivolts(averaged(CHANNEL_PA4));
  set_pull(target, PULL_NONE);
  set_mode(target, MODE_INPUT);
  return mv;
}

static void measure(void) {
  lab.vdda_mv = (VREFINT_CAL_MILLIVOLTS * VREFINT_CAL + averaged(CHANNEL_VREFINT) / 2) / averaged(CHANNEL_VREFINT);
  float_every_free_pad();
  set_mode(DAC_PIN, MODE_ANALOG);
  dac_off();
  wait_us(SETTLE_US);
  lab.wired_mv = millivolts(averaged(CHANNEL_PA4));
  uint32_t target = find_target();
  lab.target = target;
  if (target == NO_PAD) return;
  uint32_t rise_min = DAC_FULL, rise_max = 0, fall_min = DAC_FULL, fall_max = 0;
  for (uint32_t i = 0; i < SWEEPS; i++) {
    sweep_t s = sweep(target);
    if (s.rise_code < rise_min) rise_min = s.rise_code;
    if (s.rise_code > rise_max) rise_max = s.rise_code;
    if (s.fall_code < fall_min) fall_min = s.fall_code;
    if (s.fall_code > fall_max) fall_max = s.fall_code;
  }
  lab.rise_mv_min = voltage_at_code(rise_min);
  lab.rise_mv_max = voltage_at_code(rise_max);
  lab.fall_mv_min = voltage_at_code(fall_min);
  lab.fall_mv_max = voltage_at_code(fall_max);
  lab.high_mv = voltage_of_target(target, MODE_OUTPUT, PULL_NONE, 1);
  lab.low_mv = voltage_of_target(target, MODE_OUTPUT, PULL_NONE, 0);
  lab.pull_up_mv = voltage_of_target(target, MODE_INPUT, PULL_UP, 0);
  lab.pull_down_mv = voltage_of_target(target, MODE_INPUT, PULL_DOWN, 0);
}

static void send_char(char c) {
  while (!(USART1_REG(USART_ISR) & TXE)) {
  }
  USART1_REG(USART_TDR) = (uint8_t)c;
}

static void send_text(const char *text) {
  while (*text) send_char(*text++);
}

static void send_number(uint32_t value) {
  char digits[10];
  uint32_t count = 0;
  do {
    digits[count++] = (char)('0' + value % 10);
    value /= 10;
  } while (value);
  while (count) send_char(digits[--count]);
}

static void send_field(const char *name, uint32_t value) {
  send_char(' ');
  send_text(name);
  send_char('=');
  send_number(value);
}

static void send_hex(uint32_t value) {
  for (int shift = 28; shift >= 0; shift -= 4) send_char("0123456789abcdef"[(value >> shift) & 15u]);
}

static void report_factory_bytes(void) {
  send_text("FACTORY uid=");
  send_hex(FACTORY_WORD(0x0u));
  send_hex(FACTORY_WORD(0x4u));
  send_hex(FACTORY_WORD(0x8u));
  send_field("flash_kb", FACTORY_HALF(0x22u));
  send_field("vrefint_cal", FACTORY_HALF(0x2au));
  send_field("ts_cal1", FACTORY_HALF(0x2cu));
  send_field("ts_cal2", FACTORY_HALF(0x2eu));
  send_field("package", FACTORY_HALF(0x3c0u));
  send_text("\r\n");
}

static void report(void) {
  report_factory_bytes();
  send_text("PINLAB");
  send_field("pass", lab.passes);
  send_field("vdda_mv", lab.vdda_mv);
  send_field("wired_mv", lab.wired_mv);
  if (lab.target == NO_PAD) {
    send_text(" target=none\r\n");
    return;
  }
  send_text(" target=P");
  send_char((char)('A' + PORT_OF(lab.target)));
  send_number(LINE_OF(lab.target));
  send_field("rise_mv_min", lab.rise_mv_min);
  send_field("rise_mv_max", lab.rise_mv_max);
  send_field("fall_mv_min", lab.fall_mv_min);
  send_field("fall_mv_max", lab.fall_mv_max);
  send_field("high_mv", lab.high_mv);
  send_field("low_mv", lab.low_mv);
  send_field("pull_up_mv", lab.pull_up_mv);
  send_field("pull_down_mv", lab.pull_down_mv);
  send_text("\r\n");
  while (!(USART1_REG(USART_ISR) & TC)) {
  }
}

int main(void) {
  start_clocks();
  free_backup_domain_pads();
  park(SDRAM_CLOCK_ENABLE, 0);
  park(SDRAM_CLOCK, 0);
  park(SDRAM_CHIP_SELECT, 1);
  start_serial();
  start_analog();
  for (;;) {
    measure();
    lab.passes++;
    report();
    wait_us(PAUSE_US);
  }
}
