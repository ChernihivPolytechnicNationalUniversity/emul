#include <stdint.h>

#define RCC_AHB1ENR (*(volatile uint32_t *)0x40023830u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x40023840u)
#define RCC_APB2ENR (*(volatile uint32_t *)0x40023844u)
#define GPIO(port) ((volatile uint32_t *)(0x40020000u + 0x400u * (port)))
#define UART8 ((volatile uint32_t *)0x40007c00u)
#define SPI5 ((volatile uint32_t *)0x40015000u)
#define SPI5_DR8 (*(volatile uint8_t *)0x4001500cu)
#define TIM8 ((volatile uint32_t *)0x40010400u)

enum { MODER = 0, OSPEEDR = 2, PUPDR = 3, AFRL = 8 };
enum { USART_CR1 = 0, USART_BRR = 3, USART_ISR = 7, USART_ICR = 8, USART_RDR = 9, USART_TDR = 10 };
enum { USART_RXNE = 1u << 5, USART_TC = 1u << 6, USART_TXE = 1u << 7, USART_ERRORS = 15 };
enum { SPI_CR1 = 0, SPI_CR2 = 1, SPI_SR = 2 };
enum { SPI_RXNE = 1u, SPI_TXE = 1u << 1, SPI_ERRORS = (1u << 5) | (1u << 6) };
enum { TIM_CR1 = 0, TIM_SR = 4, TIM_EGR = 5, TIM_CCMR1 = 6, TIM_CCER = 8, TIM_PSC = 10, TIM_ARR = 11, TIM_CCR1 = 13, TIM_BDTR = 17 };
enum { HSI_HZ = 16000000, UART_BAUD = 115200, POLL_LIMIT = 160000, TIMEOUT = 1u << 31 };

typedef enum { IDLE, UART_LOOPBACK, SPI_LOOPBACK } command_t;

static const uint8_t uart_message[] = "Open746 AF8\r\n";
static const uint8_t spi_message[] = { 0x00, 0xff, 0x55, 0xaa, 0x81, 0x7e, 0x13, 0xc4 };

volatile struct {
  uint32_t sequence;
  uint32_t applied;
  uint32_t command;
  uint32_t ready;
  uint32_t uart_count;
  uint32_t spi_count;
  uint32_t uart_status;
  uint32_t spi_status;
  uint8_t uart_rx[32];
  uint8_t spi_rx[16];
} bench;

static void alternate(uint32_t port, uint32_t pin, uint32_t af, uint32_t pull) {
  volatile uint32_t *gpio = GPIO(port);
  uint32_t shift = pin * 2;
  uint32_t afr = AFRL + pin / 8;
  uint32_t af_shift = (pin % 8) * 4;
  gpio[PUPDR] = (gpio[PUPDR] & ~(3u << shift)) | (pull << shift);
  gpio[OSPEEDR] |= 3u << shift;
  gpio[afr] = (gpio[afr] & ~(15u << af_shift)) | (af << af_shift);
  gpio[MODER] = (gpio[MODER] & ~(3u << shift)) | (2u << shift);
}

static uint32_t wait_set(volatile uint32_t *reg, uint32_t mask) {
  for (uint32_t remaining = POLL_LIMIT; remaining; remaining--) {
    if ((*reg & mask) == mask) return 1;
  }
  return 0;
}

static void configure(void) {
  RCC_AHB1ENR |= (1u << 4) | (1u << 5) | (1u << 8);
  RCC_APB1ENR |= 1u << 31;
  RCC_APB2ENR |= (1u << 20) | (1u << 1);
  (void)RCC_APB2ENR;

  alternate(4, 1, 8, 0);
  alternate(4, 0, 8, 1);
  alternate(5, 7, 5, 0);
  alternate(5, 8, 5, 2);
  alternate(5, 9, 5, 0);
  alternate(8, 5, 3, 0);

  UART8[USART_BRR] = (HSI_HZ + UART_BAUD / 2) / UART_BAUD;
  UART8[USART_CR1] = (1u << 3) | (1u << 2) | 1u;

  SPI5[SPI_CR1] = (1u << 9) | (1u << 8) | (3u << 3) | (1u << 2);
  SPI5[SPI_CR2] = (7u << 8) | (1u << 12);
  SPI5[SPI_CR1] |= 1u << 6;

  TIM8[TIM_PSC] = 15;
  TIM8[TIM_ARR] = 999;
  TIM8[TIM_CCR1] = 250;
  TIM8[TIM_CCMR1] = (6u << 4) | (1u << 3);
  TIM8[TIM_CCER] = 1;
  TIM8[TIM_BDTR] = 1u << 15;
  TIM8[TIM_EGR] = 1;
  TIM8[TIM_SR] = 0;
  TIM8[TIM_CR1] = (1u << 7) | 1u;
  bench.ready = 1;
}

static void uart_loopback(void) {
  bench.uart_count = 0;
  bench.uart_status = 0;
  UART8[USART_ICR] = USART_ERRORS;
  for (uint32_t i = 0; i < sizeof(uart_message) - 1; i++) {
    if (!wait_set(&UART8[USART_ISR], USART_TXE)) {
      bench.uart_status |= TIMEOUT;
      return;
    }
    UART8[USART_TDR] = uart_message[i];
    if (!wait_set(&UART8[USART_ISR], USART_RXNE)) {
      bench.uart_status |= TIMEOUT;
      return;
    }
    bench.uart_status |= UART8[USART_ISR] & USART_ERRORS;
    bench.uart_rx[bench.uart_count++] = (uint8_t)UART8[USART_RDR];
  }
  if (!wait_set(&UART8[USART_ISR], USART_TC)) bench.uart_status |= TIMEOUT;
}

static void spi_loopback(void) {
  bench.spi_count = 0;
  bench.spi_status = 0;
  for (uint32_t i = 0; i < sizeof(spi_message); i++) {
    if (!wait_set(&SPI5[SPI_SR], SPI_TXE)) {
      bench.spi_status |= TIMEOUT;
      return;
    }
    SPI5_DR8 = spi_message[i];
    if (!wait_set(&SPI5[SPI_SR], SPI_RXNE)) {
      bench.spi_status |= TIMEOUT;
      return;
    }
    bench.spi_status |= SPI5[SPI_SR] & SPI_ERRORS;
    bench.spi_rx[bench.spi_count++] = SPI5_DR8;
  }
}

int main(void) {
  configure();
  for (;;) {
    uint32_t sequence = bench.sequence;
    if (sequence == bench.applied) continue;
    switch ((command_t)bench.command) {
      case UART_LOOPBACK: uart_loopback(); break;
      case SPI_LOOPBACK: spi_loopback(); break;
      case IDLE: break;
    }
    bench.applied = sequence;
  }
}
