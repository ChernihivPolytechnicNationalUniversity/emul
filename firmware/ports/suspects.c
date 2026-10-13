#include <stdint.h>

#define RCC_AHB1ENR (*(volatile uint32_t *)0x40023830u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x40023840u)
#define RCC_APB2ENR (*(volatile uint32_t *)0x40023844u)
#define RCC_BDCR (*(volatile uint32_t *)0x40023870u)
#define PWR_CR1 (*(volatile uint32_t *)0x40007000u)
#define GPIO(port) ((volatile uint32_t *)(0x40020000u + 0x400u * (port)))
#define TIM2_REG(offset) (*(volatile uint32_t *)(0x40000000u + (offset)))
#define USART1_REG(offset) (*(volatile uint32_t *)(0x40011000u + (offset)))
#define PAD(port, pin) ((uint8_t)(((port) - 'A') * 16 + (pin)))
#define PORT_OF(pad) ((uint32_t)(pad) >> 4)
#define LINE_OF(pad) ((uint32_t)(pad) & 15u)

enum { MODER = 0, OTYPER = 1, OSPEEDR = 2, PUPDR = 3, IDR = 4, ODR = 5, BSRR = 6, AFRL = 8, AFRH = 9 };
enum { PORTS = 9 };
enum { MODE_INPUT = 0, MODE_OUTPUT = 1, MODE_ALTERNATE = 2, PULL_NONE = 0, PULL_UP = 1, PULL_DOWN = 2 };
enum { TIM_CR1 = 0x00, TIM_EGR = 0x14, TIM_CNT = 0x24, TIM_PSC = 0x28, TIM_ARR = 0x2c, CEN = 1u << 0, UG = 1u << 0 };
enum { USART_CR1 = 0x00, USART_BRR = 0x0c, USART_ISR = 0x1c, USART_TDR = 0x28, UE = 1u << 0, TE = 1u << 3, TXE = 1u << 7, TC = 1u << 6 };
enum { TIM2_ENABLE = 1u << 0, PWREN = 1u << 28, USART1_ENABLE = 1u << 4, DBP = 1u << 8, BDRST = 1u << 16 };
enum { HSI_HZ = 16000000u, TICKS_PER_US = HSI_HZ / 1000000u, BAUD = 115200u, AF_USART1 = 7 };
enum { WATCH_US = 5000, NEVER = 0xffff, PAUSE_US = 2000000 };
enum { UART_TX = PAD('A', 9), UART_RX = PAD('A', 10), SDRAM_CHIP_SELECT = PAD('H', 6), SDRAM_CLOCK = PAD('G', 8), SDRAM_CLOCK_ENABLE = PAD('H', 7) };

static const uint8_t SUSPECTS[] = { PAD('A', 13), PAD('B', 3), PAD('A', 14), PAD('D', 9), PAD('B', 2) };
static const uint32_t SPEEDS[] = { 0, 1, 2, 3 };
enum { SUSPECT_COUNT = sizeof SUSPECTS / sizeof SUSPECTS[0], TRIALS = 5 };

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

static void park(uint32_t pad, uint32_t high) {
  set_level(pad, high);
  set_pull(pad, PULL_NONE);
  set_mode(pad, MODE_OUTPUT);
}

static void park_sdram_deselected(void) {
  park(SDRAM_CLOCK_ENABLE, 0);
  park(SDRAM_CLOCK, 0);
  park(SDRAM_CHIP_SELECT, 1);
}

static void set_speed(uint32_t pad, uint32_t speed) {
  volatile uint32_t *gpio = GPIO(PORT_OF(pad));
  uint32_t shift = 2 * LINE_OF(pad);
  gpio[OSPEEDR] = (gpio[OSPEEDR] & ~(3u << shift)) | (speed << shift);
}

static uint16_t time_until(uint32_t pad, uint32_t from_level, uint32_t drive_us) {
  set_pull(pad, PULL_NONE);
  set_level(pad, from_level);
  set_mode(pad, MODE_OUTPUT);
  wait_us(drive_us);
  set_mode(pad, MODE_INPUT);
  uint32_t start = now();
  for (;;) {
    uint32_t elapsed = now() - start;
    if (level(pad) != from_level) return (uint16_t)(elapsed / TICKS_PER_US);
    if (elapsed >= WATCH_US * TICKS_PER_US) return NEVER;
  }
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
  RCC_APB1ENR |= TIM2_ENABLE;
  RCC_APB2ENR |= USART1_ENABLE;
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

static void send_pad_name(uint32_t pad) {
  send_char('P');
  send_char((char)('A' + PORT_OF(pad)));
  send_number(LINE_OF(pad));
}

static void report_suspect(uint32_t pad) {
  send_pad_name(pad);
  for (uint32_t s = 0; s < sizeof SPEEDS / sizeof SPEEDS[0]; s++) {
    set_speed(pad, SPEEDS[s]);
    send_text(" speed=");
    send_number(SPEEDS[s]);
    send_text(" fall_us=");
    for (uint32_t t = 0; t < TRIALS; t++) {
      send_number(time_until(pad, 1, 20));
      send_char(t + 1 < TRIALS ? ',' : ' ');
    }
    send_text("rise_us=");
    for (uint32_t t = 0; t < TRIALS; t++) {
      send_number(time_until(pad, 0, 20));
      send_char(t + 1 < TRIALS ? ',' : ' ');
    }
  }
  set_mode(pad, MODE_INPUT);
  send_text("\r\n");
}

int main(void) {
  start_clocks();
  free_backup_domain_pads();
  park_sdram_deselected();
  start_serial();
  for (uint32_t pass = 0;; pass++) {
    send_text("SUSPECTS ");
    send_number(pass);
    send_text("\r\n");
    for (uint32_t i = 0; i < SUSPECT_COUNT; i++) report_suspect(SUSPECTS[i]);
    while (!(USART1_REG(USART_ISR) & TC)) {
    }
    wait_us(PAUSE_US);
  }
}
