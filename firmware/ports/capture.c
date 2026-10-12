#include <stdint.h>

#define REG(address) (*(volatile uint32_t *)(address))
#define RCC_CR REG(0x40023800u)
#define RCC_PLLCFGR REG(0x40023804u)
#define RCC_CFGR REG(0x40023808u)
#define RCC_AHB1ENR REG(0x40023830u)
#define RCC_APB1ENR REG(0x40023840u)
#define FLASH_ACR REG(0x40023c00u)
#define PWR_CR1 REG(0x40007000u)
#define PWR_CSR1 REG(0x40007004u)
#define GPIOA_MODER REG(0x40020000u)
#define GPIOA_PUPDR REG(0x4002000cu)
#define GPIOA_IDR REG(0x40020010u)
#define GPIOA_AFRH REG(0x40020024u)
#define TIM2_CR1 REG(0x40000000u)
#define TIM2_DIER REG(0x4000000cu)
#define TIM2_SR REG(0x40000010u)
#define TIM2_EGR REG(0x40000014u)
#define TIM2_CCMR1 REG(0x40000018u)
#define TIM2_CCER REG(0x40000020u)
#define TIM2_PSC REG(0x40000028u)
#define TIM2_ARR REG(0x4000002cu)
#define TIM2_CCR1 REG(0x40000034u)
#define NVIC_ISER0 REG(0xe000e100u)

enum { HSEON = 1u << 16, HSERDY = 1u << 17, PLLON = 1u << 24, PLLRDY = 1u << 25 };
enum { PLLM_4 = 4u, PLLN_216 = 216u << 6, PLLP_2 = 0u << 16, PLLSRC_HSE = 1u << 22, PLLQ_9 = 9u << 24 };
enum { SW_PLL = 2u, SWS_MASK = 3u << 2, SWS_PLL = 2u << 2, PPRE1_DIV4 = 5u << 10, PPRE2_DIV2 = 4u << 13 };
enum { PWREN = 1u << 28, TIM2EN = 1u, GPIOAEN = 1u };
enum { VOS_SCALE1 = 3u << 14, ODEN = 1u << 16, ODSWEN = 1u << 17, ODRDY = 1u << 16, ODSWRDY = 1u << 17 };
enum { FLASH_LATENCY_7 = 7u };
enum { PA15 = 15, AF1 = 1, MODE_AF = 2 };
enum { CC1S_TI1 = 1u, CC1E = 1u, CC1P = 1u << 1, CC1NP = 1u << 3, CC1IE = 1u << 1, CC1OF = 1u << 9, CEN = 1u, UG = 1u };
enum { TIM2_IRQ = 28, CAPTURES = 64 };

struct bench {
  uint32_t ready;
  uint32_t count;
  uint32_t overcaptures;
  uint32_t ticks[CAPTURES];
  uint8_t levels[CAPTURES];
};

volatile struct bench bench;

static void clock_216mhz_from_hse(void) {
  RCC_APB1ENR |= PWREN;
  PWR_CR1 |= VOS_SCALE1;
  RCC_CR |= HSEON;
  while (!(RCC_CR & HSERDY)) {}
  RCC_PLLCFGR = PLLM_4 | PLLN_216 | PLLP_2 | PLLSRC_HSE | PLLQ_9;
  RCC_CR |= PLLON;
  while (!(RCC_CR & PLLRDY)) {}
  PWR_CR1 |= ODEN;
  while (!(PWR_CSR1 & ODRDY)) {}
  PWR_CR1 |= ODSWEN;
  while (!(PWR_CSR1 & ODSWRDY)) {}
  FLASH_ACR = (FLASH_ACR & ~0xfu) | FLASH_LATENCY_7;
  RCC_CFGR = (RCC_CFGR & ~0xfcf3u) | PPRE1_DIV4 | PPRE2_DIV2 | SW_PLL;
  while ((RCC_CFGR & SWS_MASK) != SWS_PLL) {}
}

static void capture_both_edges_on_pa15(void) {
  RCC_AHB1ENR |= GPIOAEN;
  RCC_APB1ENR |= TIM2EN;
  GPIOA_PUPDR &= ~(3u << (2 * PA15));
  GPIOA_AFRH = (GPIOA_AFRH & ~(0xfu << (4 * (PA15 - 8)))) | (AF1 << (4 * (PA15 - 8)));
  GPIOA_MODER = (GPIOA_MODER & ~(3u << (2 * PA15))) | (MODE_AF << (2 * PA15));
  TIM2_PSC = 0;
  TIM2_ARR = 0xffffffffu;
  TIM2_CCMR1 = CC1S_TI1;
  TIM2_CCER = CC1E | CC1P | CC1NP;
  TIM2_EGR = UG;
  TIM2_SR = 0;
  TIM2_DIER = CC1IE;
  NVIC_ISER0 = 1u << TIM2_IRQ;
  TIM2_CR1 = CEN;
}

void TIM2_IRQHandler(void) {
  uint32_t ticks = TIM2_CCR1;
  uint8_t level = (GPIOA_IDR >> PA15) & 1u;
  uint32_t n = bench.count;
  if (n < CAPTURES) {
    bench.ticks[n] = ticks;
    bench.levels[n] = level;
  }
  bench.count = n + 1;
  if (TIM2_SR & CC1OF) {
    bench.overcaptures++;
    TIM2_SR = ~CC1OF;
  }
}

int main(void) {
  clock_216mhz_from_hse();
  capture_both_edges_on_pa15();
  bench.ready = 1;
  for (;;) __asm volatile("wfi");
}
