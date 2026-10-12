#include <stdint.h>

#define RCC_AHB1ENR (*(volatile uint32_t *)0x40023830u)
#define RCC_APB1ENR (*(volatile uint32_t *)0x40023840u)
#define RCC_BDCR (*(volatile uint32_t *)0x40023870u)
#define PWR_CR1 (*(volatile uint32_t *)0x40007000u)
#define SCB_VTOR (*(volatile uint32_t *)0xE000ED08u)
#define SYST_CSR (*(volatile uint32_t *)0xE000E010u)
#define SYST_RVR (*(volatile uint32_t *)0xE000E014u)
#define SYST_CVR (*(volatile uint32_t *)0xE000E018u)
#define GPIO(port) ((volatile uint32_t *)(0x40020000u + 0x400u * (port)))
#define PAD(port, pin) ((uint8_t)(((port) - 'A') * 16 + (pin)))
#define PORT_OF(pad) ((pad) >> 4)
#define BIT_OF(pad) (1u << ((pad) & 15))

enum { MODER = 0, OTYPER = 1, OSPEEDR = 2, PUPDR = 3, ODR = 5, BSRR = 6 };
enum { PORTS = 9, GPIOA_INDEX = 0, GPIOH_INDEX = 7 };
enum { ALL_OUTPUT = 0x55555555u, MODE_BITS = 3u, EVERY_PIN = 0xffffu };
enum { FLASH_BASE = 0x08000000u, HSI_HZ = 16000000u, SLOT_HZ = 1000u };
enum { SYSTICK_ENABLE = 1u << 0, SYSTICK_INTERRUPT = 1u << 1, SYSTICK_CORE_CLOCK = 1u << 2 };
enum { PWREN = 1u << 28, DBP = 1u << 8, BDRST = 1u << 16, BACKUP_ACCESS_POLLS = 1000u };
enum { USB_VBUS_SENSE = PAD('A', 9), SDRAM_CHIP_SELECT = PAD('H', 6), SDRAM_CLOCK = PAD('G', 8) };
enum { SYNC_SLOTS = 8, GAP_SLOTS = 2 };

static const uint8_t SLOT_PADS[] = {
  PAD('H', 12), PAD('B', 12), PAD('B', 13), PAD('B', 14), PAD('B', 15), PAD('D', 8), PAD('D', 9), PAD('D', 10),
  PAD('D', 11), PAD('D', 12), PAD('D', 13), PAD('D', 14), PAD('D', 15), PAD('G', 2), PAD('G', 3), PAD('G', 4),
  PAD('G', 5), PAD('G', 6), PAD('G', 7), PAD('G', 8), PAD('C', 6), PAD('C', 7), PAD('C', 8), PAD('C', 9),
  PAD('A', 8), PAD('A', 9), PAD('A', 10), PAD('A', 11), PAD('A', 12), PAD('A', 13), PAD('H', 14), PAD('H', 13),
  PAD('I', 0), PAD('H', 15), PAD('I', 1), PAD('I', 2), PAD('A', 14), PAD('I', 3), PAD('C', 10), PAD('A', 15),
  PAD('C', 12), PAD('C', 11), PAD('D', 1), PAD('D', 0), PAD('D', 3), PAD('D', 2), PAD('D', 5), PAD('D', 4),
  PAD('D', 7), PAD('D', 6), PAD('G', 10), PAD('G', 9), PAD('G', 12), PAD('G', 11), PAD('G', 14), PAD('G', 13),
  PAD('B', 3), PAD('G', 15), PAD('B', 5), PAD('B', 4), PAD('B', 7), PAD('B', 6), PAD('B', 8), PAD('B', 9),
  PAD('E', 0), PAD('E', 1), PAD('I', 5), PAD('I', 4), PAD('I', 7), PAD('I', 6),
  PAD('H', 11), PAD('H', 10), PAD('H', 9), PAD('H', 8), PAD('H', 7), PAD('H', 6), PAD('B', 11), PAD('B', 10),
  PAD('E', 15), PAD('E', 14), PAD('E', 13), PAD('E', 12), PAD('E', 11), PAD('E', 10), PAD('E', 9), PAD('E', 8),
  PAD('E', 7), PAD('G', 1), PAD('G', 0), PAD('F', 15), PAD('F', 14), PAD('F', 13), PAD('F', 12), PAD('F', 11),
  PAD('B', 2), PAD('B', 1), PAD('B', 0), PAD('C', 5), PAD('C', 4), PAD('A', 7), PAD('A', 6), PAD('A', 5),
  PAD('A', 4), PAD('A', 3), PAD('H', 5), PAD('H', 4), PAD('H', 3), PAD('H', 2), PAD('A', 2), PAD('A', 1),
  PAD('A', 0), PAD('C', 3), PAD('C', 2), PAD('C', 1), PAD('C', 0), PAD('H', 0), PAD('H', 1), PAD('F', 9),
  PAD('F', 10), PAD('F', 7), PAD('F', 8), PAD('F', 5), PAD('F', 6), PAD('F', 3), PAD('F', 4), PAD('F', 1),
  PAD('F', 2), PAD('I', 11), PAD('F', 0), PAD('I', 9), PAD('I', 10), PAD('C', 14), PAD('C', 15), PAD('I', 8),
  PAD('C', 13), PAD('E', 6), PAD('E', 5), PAD('E', 4), PAD('E', 3), PAD('E', 2),
};

enum { PADS = sizeof SLOT_PADS / sizeof SLOT_PADS[0] };
enum { FIRST_PAD_SLOT = SYNC_SLOTS + GAP_SLOTS, CYCLE_SLOTS = FIRST_PAD_SLOT + PADS + GAP_SLOTS };

static const uint8_t WRITE_ORDER_CHIP_SELECT_LAST[PORTS] = { 0, 1, 2, 3, 4, 5, 6, 8, GPIOH_INDEX };

_Static_assert(PADS == 140, "every GPIO of the four strips has a slot");
_Static_assert(PORT_OF(SDRAM_CHIP_SELECT) == GPIOH_INDEX, "the chip select is written last");

static uint32_t slot;

static void free_backup_domain_pads(void) {
  RCC_APB1ENR |= PWREN;
  (void)RCC_APB1ENR;
  PWR_CR1 |= DBP;
  for (uint32_t polls = 0; polls < BACKUP_ACCESS_POLLS && !(PWR_CR1 & DBP); polls++) {
  }
  RCC_BDCR = BDRST;
  RCC_BDCR = 0;
}

static uint32_t output_modes(uint32_t port) {
  if (port != PORT_OF(USB_VBUS_SENSE)) return ALL_OUTPUT;
  return ALL_OUTPUT & ~(MODE_BITS << 2 * (USB_VBUS_SENSE & 15));
}

static void make_every_pad_but_vbus_an_output(void) {
  RCC_AHB1ENR |= (1u << PORTS) - 1;
  (void)RCC_AHB1ENR;
  for (uint32_t i = PORTS; i-- > 0;) {
    uint32_t port = WRITE_ORDER_CHIP_SELECT_LAST[i];
    volatile uint32_t *gpio = GPIO(port);
    gpio[ODR] = port == PORT_OF(SDRAM_CHIP_SELECT) ? BIT_OF(SDRAM_CHIP_SELECT) : 0;
    gpio[OTYPER] = 0;
    gpio[OSPEEDR] = 0;
    gpio[PUPDR] = 0;
    gpio[MODER] = output_modes(port);
  }
}

static void pattern_of(uint32_t s, uint16_t high[PORTS]) {
  for (uint32_t port = 0; port < PORTS; port++) high[port] = s < SYNC_SLOTS ? EVERY_PIN : 0;
  high[PORT_OF(USB_VBUS_SENSE)] &= (uint16_t)~BIT_OF(USB_VBUS_SENSE);
  if (s < FIRST_PAD_SLOT || s >= FIRST_PAD_SLOT + PADS) return;
  uint8_t pad = SLOT_PADS[s - FIRST_PAD_SLOT];
  if (pad != USB_VBUS_SENSE) high[PORT_OF(pad)] = (uint16_t)BIT_OF(pad);
}

static int sdram_clock_rises(const uint16_t high[PORTS]) {
  return (high[PORT_OF(SDRAM_CLOCK)] & BIT_OF(SDRAM_CLOCK)) && !(GPIO(PORT_OF(SDRAM_CLOCK))[ODR] & BIT_OF(SDRAM_CLOCK));
}

static void drive(const uint16_t high[PORTS]) {
  if (sdram_clock_rises(high)) GPIO(PORT_OF(SDRAM_CHIP_SELECT))[BSRR] = BIT_OF(SDRAM_CHIP_SELECT);
  for (uint32_t i = 0; i < PORTS; i++) {
    uint32_t port = WRITE_ORDER_CHIP_SELECT_LAST[i];
    GPIO(port)[ODR] = high[port];
  }
}

static void enter(uint32_t s) {
  uint16_t high[PORTS];
  pattern_of(s, high);
  drive(high);
}

void SysTick_Handler(void) {
  slot = slot + 1 == CYCLE_SLOTS ? 0 : slot + 1;
  enter(slot);
}

int main(void) {
  SCB_VTOR = FLASH_BASE;
  free_backup_domain_pads();
  make_every_pad_but_vbus_an_output();
  slot = 0;
  enter(slot);
  SYST_RVR = HSI_HZ / SLOT_HZ - 1;
  SYST_CVR = 0;
  SYST_CSR = SYSTICK_ENABLE | SYSTICK_INTERRUPT | SYSTICK_CORE_CLOCK;
  for (;;) __asm volatile("wfi");
}
