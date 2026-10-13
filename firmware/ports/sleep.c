#include <stdint.h>

#define REG(address) (*(volatile uint32_t *)(address))
#define RCC_AHB1ENR REG(0x40023830u)
#define RCC_APB1ENR REG(0x40023840u)
#define RCC_APB2ENR REG(0x40023844u)
#define SYSCFG_EXTICR(index) REG(0x40013808u + 4u * (index))
#define EXTI_IMR REG(0x40013c00u)
#define EXTI_RTSR REG(0x40013c08u)
#define EXTI_FTSR REG(0x40013c0cu)
#define EXTI_PR REG(0x40013c14u)
#define TIM2_CR1 REG(0x40000000u)
#define TIM2_DIER REG(0x4000000cu)
#define TIM2_SR REG(0x40000010u)
#define TIM2_EGR REG(0x40000014u)
#define TIM2_PSC REG(0x40000028u)
#define TIM2_ARR REG(0x4000002cu)
#define SYST_CSR REG(0xe000e010u)
#define SYST_RVR REG(0xe000e014u)
#define SYST_CVR REG(0xe000e018u)
#define NVIC_ISER(index) REG(0xe000e100u + 4u * (index))
#define GPIO(port) ((volatile uint32_t *)(0x40020000u + 0x400u * (port)))

enum { MODER = 0, PUPDR = 3, IDR = 4, BSRR = 6 };
enum { HSI_HZ = 16000000, TICK_HZ = 10000, TIMER_HZ = 1000000 };
enum { SYSCFGEN = 1u << 14, TIM2EN = 1u, UIE = 1u, UIF = 1u, CEN = 1u, UG = 1u };
enum { SYST_ENABLE_INTERRUPT_CORE_CLOCK = 7u };
enum { TIM2_IRQ = 28, EXTI15_10_IRQ = 40, OUTPUT = 1 };

typedef struct {
  uint32_t port;
  uint32_t pin;
} pad_t;

const volatile uint32_t sleep_in_wfi = 1;
const volatile uint32_t ticks_per_toggle = 10;
const volatile uint32_t timer_toggle_hz = 1000;
const volatile pad_t tick_out = { 1, 6 };
const volatile pad_t button_echo = { 1, 7 };
const volatile pad_t timer_out = { 7, 4 };
const volatile pad_t button = { 8, 11 };
const volatile uint32_t button_pull = 1;
const volatile uint32_t button_falls = 1;

static volatile uint32_t ticks;

static void toggle(const volatile pad_t *pad) {
  volatile uint32_t *gpio = GPIO(pad->port);
  uint32_t high = (gpio[IDR] >> pad->pin) & 1u;
  gpio[BSRR] = high ? 1u << (pad->pin + 16) : 1u << pad->pin;
}

static void output(const volatile pad_t *pad) {
  volatile uint32_t *gpio = GPIO(pad->port);
  RCC_AHB1ENR |= 1u << pad->port;
  (void)RCC_AHB1ENR;
  gpio[BSRR] = 1u << (pad->pin + 16);
  gpio[MODER] = (gpio[MODER] & ~(3u << (2 * pad->pin))) | (OUTPUT << (2 * pad->pin));
}

void SysTick_Handler(void) {
  if (++ticks % ticks_per_toggle == 0) toggle(&tick_out);
}

void TIM2_IRQHandler(void) {
  TIM2_SR = ~UIF;
  toggle(&timer_out);
}

void EXTI15_10_IRQHandler(void) {
  EXTI_PR = 1u << button.pin;
  toggle(&button_echo);
}

static void button_interrupt(void) {
  volatile uint32_t *gpio = GPIO(button.port);
  RCC_AHB1ENR |= 1u << button.port;
  RCC_APB2ENR |= SYSCFGEN;
  (void)RCC_APB2ENR;
  gpio[MODER] &= ~(3u << (2 * button.pin));
  gpio[PUPDR] = (gpio[PUPDR] & ~(3u << (2 * button.pin))) | (button_pull << (2 * button.pin));
  uint32_t shift = 4 * (button.pin % 4);
  SYSCFG_EXTICR(button.pin / 4) = (SYSCFG_EXTICR(button.pin / 4) & ~(0xfu << shift)) | (button.port << shift);
  if (button_falls) EXTI_FTSR |= 1u << button.pin;
  else EXTI_RTSR |= 1u << button.pin;
  EXTI_IMR |= 1u << button.pin;
  NVIC_ISER(EXTI15_10_IRQ / 32) = 1u << (EXTI15_10_IRQ % 32);
}

static void timer_interrupt(void) {
  RCC_APB1ENR |= TIM2EN;
  (void)RCC_APB1ENR;
  TIM2_PSC = HSI_HZ / TIMER_HZ - 1;
  TIM2_ARR = TIMER_HZ / timer_toggle_hz - 1;
  TIM2_EGR = UG;
  TIM2_SR = 0;
  TIM2_DIER = UIE;
  NVIC_ISER(TIM2_IRQ / 32) = 1u << (TIM2_IRQ % 32);
  TIM2_CR1 = CEN;
}

int main(void) {
  output(&tick_out);
  output(&button_echo);
  output(&timer_out);
  button_interrupt();
  timer_interrupt();
  SYST_RVR = HSI_HZ / TICK_HZ - 1;
  SYST_CVR = 0;
  SYST_CSR = SYST_ENABLE_INTERRUPT_CORE_CLOCK;
  if (sleep_in_wfi)
    for (;;) __asm volatile("wfi");
  for (;;) {
  }
}
