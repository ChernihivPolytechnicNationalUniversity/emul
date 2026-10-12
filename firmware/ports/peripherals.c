#include <stdint.h>

#define RCC_AHB1ENR (*(volatile uint32_t *)0x40023830u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x40023840u)
#define RCC_APB2ENR (*(volatile uint32_t *)0x40023844u)
#define GPIO(port) ((volatile uint32_t *)(0x40020000u + 0x400u * (port)))
#define REGS(base) ((volatile uint32_t *)(base))
#define BYTE_REG(base, index) (*(volatile uint8_t *)((base) + 4u * (index)))

enum { PA, PB, PC, PD, PE, PF, PG, PH, PI, PORTS };
enum { MODER = 0, OTYPER = 1, OSPEEDR = 2, PUPDR = 3, AFRL = 8 };
enum { PUSH_PULL = 0, OPEN_DRAIN_PULLED_UP = 1 };
enum { USART_CR1 = 0, USART_BRR = 3, USART_ISR = 7, USART_TDR = 10 };
enum { USART_UE = 1u, USART_TE = 1u << 3, USART_TC = 1u << 6, USART_TXE = 1u << 7 };
enum { SPI_CR1 = 0, SPI_CR2 = 1, SPI_SR = 2, SPI_DR = 3 };
enum { SPI_TXE = 1u << 1, SPI_BSY = 1u << 7 };
enum { SPI_MASTER_1MHZ_AT_16MHZ = (1u << 9) | (1u << 8) | (3u << 3) | (1u << 2), SPI_ENABLE = 1u << 6, SPI_8BIT_FRAMES = (7u << 8) | (1u << 12) };
enum { I2C_CR1 = 0, I2C_CR2 = 1, I2C_TIMINGR = 4, I2C_ISR = 6, I2C_ICR = 7 };
enum { I2C_PE = 1u, I2C_START = 1u << 13, I2C_AUTOEND = 1u << 25, I2C_NACKF = 1u << 4, I2C_STOPF = 1u << 5 };
enum { I2C_100KHZ_AT_16MHZ = 0x30420f13u };
enum { TIM_CR1 = 0, TIM_SR = 4, TIM_EGR = 5, TIM_CCMR1 = 6, TIM_CCER = 8, TIM_PSC = 10, TIM_ARR = 11, TIM_CCR1 = 13, TIM_BDTR = 17 };
enum { TIM_1MHZ_AT_16MHZ = 15, TIM_1KHZ_PERIOD = 999, TIM_OC1_PWM1_PRELOAD = (6u << 4) | (1u << 3), TIM_CC1E = 1u, TIM_MOE = 1u << 15, TIM_ARPE_CEN = (1u << 7) | 1u };
enum { HSI_HZ = 16000000, UART_BAUD = 115200, POLL_LIMIT = 160000 };

typedef enum { IDLE, SEND } command_t;

typedef struct {
  uint8_t port;
  uint8_t pin;
  uint8_t af;
} pad_t;

typedef struct {
  uint32_t base;
  pad_t tx;
  const char *name;
} uart_t;

typedef struct {
  uint32_t base;
  pad_t sck;
  pad_t mosi;
  uint8_t byte;
} spi_t;

typedef struct {
  uint32_t base;
  pad_t scl;
  pad_t sda;
  uint8_t address;
} i2c_t;

typedef struct {
  uint32_t base;
  pad_t ch1;
  uint16_t high_ticks;
  uint8_t advanced;
} tim_t;

static const uart_t uarts[] = {
  { 0x40011000u, { PB, 6, 7 }, "USART1" },
  { 0x40004400u, { PD, 5, 7 }, "USART2" },
  { 0x40004800u, { PD, 8, 7 }, "USART3" },
  { 0x40004c00u, { PC, 10, 8 }, "UART4" },
  { 0x40005000u, { PC, 12, 8 }, "UART5" },
  { 0x40011400u, { PC, 6, 8 }, "USART6" },
  { 0x40007800u, { PE, 8, 8 }, "UART7" },
  { 0x40007c00u, { PE, 1, 8 }, "UART8" },
};

static const spi_t spis[] = {
  { 0x40013000u, { PA, 5, 5 }, { PA, 7, 5 }, 0x11 },
  { 0x40003800u, { PB, 13, 5 }, { PB, 15, 5 }, 0x22 },
  { 0x40003c00u, { PB, 3, 6 }, { PB, 2, 7 }, 0x33 },
  { 0x40013400u, { PE, 12, 5 }, { PE, 14, 5 }, 0x44 },
  { 0x40015000u, { PH, 6, 5 }, { PF, 11, 5 }, 0x55 },
  { 0x40015400u, { PG, 13, 5 }, { PG, 14, 5 }, 0x66 },
};

static const pad_t pads_without_spi1[] = { { PD, 7, 5 }, { PG, 11, 5 } };

static const i2c_t i2cs[] = {
  { 0x40005400u, { PB, 8, 4 }, { PB, 9, 4 }, 0x51 },
  { 0x40005800u, { PH, 4, 4 }, { PH, 5, 4 }, 0x52 },
  { 0x40005c00u, { PH, 7, 4 }, { PH, 8, 4 }, 0x53 },
  { 0x40006000u, { PF, 14, 4 }, { PF, 15, 4 }, 0x54 },
};

static const tim_t tims[] = {
  { 0x40010000u, { PE, 9, 1 }, 50, 1 },
  { 0x40000000u, { PA, 15, 1 }, 100, 0 },
  { 0x40000400u, { PB, 4, 2 }, 150, 0 },
  { 0x40000800u, { PD, 12, 2 }, 200, 0 },
  { 0x40000c00u, { PH, 10, 2 }, 250, 0 },
  { 0x40010400u, { PI, 5, 3 }, 400, 1 },
  { 0x40014000u, { PE, 5, 3 }, 450, 0 },
  { 0x40014400u, { PF, 6, 3 }, 500, 0 },
  { 0x40014800u, { PF, 7, 3 }, 550, 0 },
  { 0x40001800u, { PB, 14, 9 }, 600, 0 },
  { 0x40001c00u, { PF, 8, 9 }, 650, 0 },
  { 0x40002000u, { PF, 9, 9 }, 700, 0 },
};

enum { UARTS = sizeof uarts / sizeof uarts[0], SPIS = sizeof spis / sizeof spis[0], I2CS = sizeof i2cs / sizeof i2cs[0], TIMS = sizeof tims / sizeof tims[0] };
enum { SPI_TIMEOUTS_FROM = 8, I2C_TIMEOUTS_FROM = 16 };

volatile struct {
  uint32_t sequence;
  uint32_t applied;
  uint32_t command;
  uint32_t ready;
  uint32_t timeouts;
  uint32_t nacks;
} bench;

static void alternate(pad_t pad, uint32_t output) {
  volatile uint32_t *gpio = GPIO(pad.port);
  uint32_t shift = pad.pin * 2u;
  uint32_t afr = AFRL + pad.pin / 8u;
  uint32_t af_shift = (pad.pin % 8u) * 4u;
  uint32_t open_drain = output == OPEN_DRAIN_PULLED_UP;
  gpio[OTYPER] = (gpio[OTYPER] & ~(1u << pad.pin)) | (open_drain << pad.pin);
  gpio[PUPDR] = (gpio[PUPDR] & ~(3u << shift)) | (open_drain << shift);
  gpio[OSPEEDR] |= 3u << shift;
  gpio[afr] = (gpio[afr] & ~(15u << af_shift)) | ((uint32_t)pad.af << af_shift);
  gpio[MODER] = (gpio[MODER] & ~(3u << shift)) | (2u << shift);
}

static uint32_t wait_set(volatile uint32_t *reg, uint32_t mask) {
  for (uint32_t remaining = POLL_LIMIT; remaining; remaining--) {
    if (*reg & mask) return 1;
  }
  return 0;
}

static uint32_t wait_clear(volatile uint32_t *reg, uint32_t mask) {
  for (uint32_t remaining = POLL_LIMIT; remaining; remaining--) {
    if (!(*reg & mask)) return 1;
  }
  return 0;
}

static void enable_clocks(void) {
  RCC_AHB1ENR |= (1u << PORTS) - 1u;
  RCC_APB1ENR |= (1u << 0) | (1u << 1) | (1u << 2) | (1u << 3) | (1u << 6) | (1u << 7) | (1u << 8)
    | (1u << 14) | (1u << 15) | (1u << 17) | (1u << 18) | (1u << 19) | (1u << 20)
    | (1u << 21) | (1u << 22) | (1u << 23) | (1u << 24) | (1u << 30) | (1u << 31);
  RCC_APB2ENR |= (1u << 0) | (1u << 1) | (1u << 4) | (1u << 5) | (1u << 12) | (1u << 13)
    | (1u << 16) | (1u << 17) | (1u << 18) | (1u << 20) | (1u << 21);
  (void)RCC_APB2ENR;
}

static void configure(void) {
  enable_clocks();
  for (uint32_t i = 0; i < UARTS; i++) {
    volatile uint32_t *uart = REGS(uarts[i].base);
    alternate(uarts[i].tx, PUSH_PULL);
    uart[USART_BRR] = (HSI_HZ + UART_BAUD / 2) / UART_BAUD;
    uart[USART_CR1] = USART_TE | USART_UE;
  }
  for (uint32_t i = 0; i < SPIS; i++) {
    volatile uint32_t *spi = REGS(spis[i].base);
    alternate(spis[i].sck, PUSH_PULL);
    alternate(spis[i].mosi, PUSH_PULL);
    spi[SPI_CR1] = SPI_MASTER_1MHZ_AT_16MHZ;
    spi[SPI_CR2] = SPI_8BIT_FRAMES;
    spi[SPI_CR1] |= SPI_ENABLE;
  }
  for (uint32_t i = 0; i < sizeof pads_without_spi1 / sizeof pads_without_spi1[0]; i++) alternate(pads_without_spi1[i], PUSH_PULL);
  for (uint32_t i = 0; i < I2CS; i++) {
    volatile uint32_t *i2c = REGS(i2cs[i].base);
    alternate(i2cs[i].scl, OPEN_DRAIN_PULLED_UP);
    alternate(i2cs[i].sda, OPEN_DRAIN_PULLED_UP);
    i2c[I2C_TIMINGR] = I2C_100KHZ_AT_16MHZ;
    i2c[I2C_CR1] = I2C_PE;
  }
  for (uint32_t i = 0; i < TIMS; i++) {
    volatile uint32_t *tim = REGS(tims[i].base);
    alternate(tims[i].ch1, PUSH_PULL);
    tim[TIM_PSC] = TIM_1MHZ_AT_16MHZ;
    tim[TIM_ARR] = TIM_1KHZ_PERIOD;
    tim[TIM_CCR1] = tims[i].high_ticks;
    tim[TIM_CCMR1] = TIM_OC1_PWM1_PRELOAD;
    tim[TIM_CCER] = TIM_CC1E;
    if (tims[i].advanced) tim[TIM_BDTR] = TIM_MOE;
    tim[TIM_EGR] = 1;
    tim[TIM_SR] = 0;
    tim[TIM_CR1] = TIM_ARPE_CEN;
  }
  bench.ready = 1;
}

static uint32_t send_name(const uart_t *u) {
  volatile uint32_t *uart = REGS(u->base);
  for (const char *c = u->name; *c; c++) {
    if (!wait_set(&uart[USART_ISR], USART_TXE)) return 0;
    uart[USART_TDR] = (uint8_t)*c;
  }
  return wait_set(&uart[USART_ISR], USART_TC);
}

static uint32_t send_byte(const spi_t *s) {
  volatile uint32_t *spi = REGS(s->base);
  if (!wait_set(&spi[SPI_SR], SPI_TXE)) return 0;
  BYTE_REG(s->base, SPI_DR) = s->byte;
  return wait_set(&spi[SPI_SR], SPI_TXE) && wait_clear(&spi[SPI_SR], SPI_BSY);
}

static uint32_t address(const i2c_t *b, uint32_t index) {
  volatile uint32_t *i2c = REGS(b->base);
  i2c[I2C_ICR] = I2C_NACKF | I2C_STOPF;
  i2c[I2C_CR2] = ((uint32_t)b->address << 1) | I2C_AUTOEND | I2C_START;
  if (!wait_set(&i2c[I2C_ISR], I2C_STOPF)) return 0;
  if (i2c[I2C_ISR] & I2C_NACKF) bench.nacks |= 1u << index;
  i2c[I2C_ICR] = I2C_NACKF | I2C_STOPF;
  return 1;
}

static void send(void) {
  bench.timeouts = 0;
  bench.nacks = 0;
  for (uint32_t i = 0; i < UARTS; i++)
    if (!send_name(&uarts[i])) bench.timeouts |= 1u << i;
  for (uint32_t i = 0; i < SPIS; i++)
    if (!send_byte(&spis[i])) bench.timeouts |= 1u << (SPI_TIMEOUTS_FROM + i);
  for (uint32_t i = 0; i < I2CS; i++)
    if (!address(&i2cs[i], i)) bench.timeouts |= 1u << (I2C_TIMEOUTS_FROM + i);
}

int main(void) {
  configure();
  for (;;) {
    uint32_t sequence = bench.sequence;
    if (sequence == bench.applied) continue;
    switch ((command_t)bench.command) {
      case SEND: send(); break;
      case IDLE: break;
    }
    bench.applied = sequence;
  }
}
