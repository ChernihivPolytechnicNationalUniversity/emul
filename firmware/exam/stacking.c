#include "exam.h"

#define SCB_VTOR REG(0xE000ED08)
#define SCB_SHPR3 REG(0xE000ED20)
#define NVIC_ISER1 REG(0xE000E104)
#define NVIC_ICER1 REG(0xE000E184)
#define NVIC_ISPR1 REG(0xE000E204)
#define NVIC_ICPR1 REG(0xE000E284)

#define PENDSV_LOWEST_PRIORITY (0xF0u << 16)
#define VECTORS 107u
#define VECTORS_BEFORE_RAM_ENDS 64u
#define TABLE_IN_RAM 0x20048000u
#define TABLE_ACROSS_RAM_END 0x2004FF00u
#define HARD_FAULT 3u
#define BUS_FAULT 5u
#define PENDSV 14u
#define IRQ_PAST_RAM_END 50u
#define IRQ_PAST_RAM_END_BIT (1u << (IRQ_PAST_RAM_END - 32u))
#define THUMB_STATE (1u << 24)
#define ENTRIES 12u

typedef void (*vector_t)(void);
extern const vector_t g_pfnVectors[];
extern uint32_t _estack;

struct survivor {
  uint32_t process_stack[64] __attribute__((aligned(8)));
  uint32_t count;
  uint32_t exc[ENTRIES];
  uint32_t cfsr[ENTRIES];
  uint32_t hfsr[ENTRIES];
  uint32_t irq_pending[ENTRIES];
  uint32_t depth;
  uint32_t vtor_to_restore;
  vector_t resume;
};

#define SURVIVOR ((volatile struct survivor *)0x20040000u)

static void record_entry(void) {
  uint32_t i = SURVIVOR->count;
  if (i < ENTRIES) {
    SURVIVOR->exc[i] = get_ipsr();
    SURVIVOR->cfsr[i] = SCB_CFSR;
    SURVIVOR->hfsr[i] = SCB_HFSR;
    SURVIVOR->irq_pending[i] = NVIC_ISPR1 & IRQ_PAST_RAM_END_BIT;
  }
  SURVIVOR->count = i + 1u;
  SCB_CFSR = SCB_CFSR;
  SCB_HFSR = SCB_HFSR;
}

static void frame_resuming_thread(volatile uint32_t *frame) {
  for (uint32_t i = 0; i < 8u; i++) frame[i] = 0;
  frame[6] = (uint32_t)SURVIVOR->resume & ~1u;
  frame[7] = THUMB_STATE;
}

static int below_ram(uint32_t sp) { return sp < 0x20000000u; }

__attribute__((used)) void on_exception(uint32_t main_stack_replaced, uint32_t exc_return) {
  record_entry();
  if (SURVIVOR->vtor_to_restore) {
    SCB_VTOR = SURVIVOR->vtor_to_restore;
    SURVIVOR->vtor_to_restore = 0;
    NVIC_ICER1 = IRQ_PAST_RAM_END_BIT;
    NVIC_ICPR1 = IRQ_PAST_RAM_END_BIT;
  }
  if (main_stack_replaced) {
    frame_resuming_thread((volatile uint32_t *)((uint32_t)&_estack - 32u));
  } else if ((exc_return & 4u) && below_ram(get_psp())) {
    volatile uint32_t *frame = &SURVIVOR->process_stack[56];
    frame_resuming_thread(frame);
    set_psp((uint32_t)frame);
  }
}

__attribute__((naked)) static void entry_on_a_sound_main_stack(void) {
  __asm volatile(
      "mov r1, lr\n"
      "mov r0, #0\n"
      "mrs r2, msp\n"
      "cmp r2, #0x20000000\n"
      "bhs 1f\n"
      "ldr r2, =_estack - 32\n"
      "msr msp, r2\n"
      "mov r0, #1\n"
      "1: b on_exception\n");
}

static void use_a_table_in_ram(void) {
  volatile uint32_t *table = (volatile uint32_t *)TABLE_IN_RAM;
  for (uint32_t i = 0; i < VECTORS; i++) table[i] = (uint32_t)g_pfnVectors[i];
  table[HARD_FAULT] = (uint32_t)entry_on_a_sound_main_stack;
  table[BUS_FAULT] = (uint32_t)entry_on_a_sound_main_stack;
  table[PENDSV] = (uint32_t)entry_on_a_sound_main_stack;
  barrier();
  SCB_VTOR = TABLE_IN_RAM;
  barrier();
}

__attribute__((naked, noreturn)) static void pend_sv_with_the_process_stack_below_ram(void) {
  __asm volatile(
      "ldr r0, =0x1FFFFF00\n"
      "msr psp, r0\n"
      "mrs r0, control\n"
      "orr r0, r0, #2\n"
      "msr control, r0\n"
      "isb\n"
      "ldr r0, =0xE000ED04\n"
      "mov r1, #0x10000000\n"
      "str r1, [r0]\n"
      "dsb\n"
      "isb\n"
      "1: b 1b\n");
}

__attribute__((noinline, used)) uint32_t dive(uint32_t n) {
  volatile uint32_t pad[16];
  pad[0] = n;
  SURVIVOR->depth = n;
  return dive(n + 1u) + pad[0];
}

__attribute__((naked, noreturn)) static void recurse_on_the_main_stack(void) {
  __asm volatile("mov r0, #0\n msr control, r0\n isb\n mov r0, #0\n bl dive\n 1: b 1b\n");
}

static void report(void) {
  result_count = 0;
  put(SURVIVOR->count);
  for (uint32_t i = 0; i < ENTRIES && i < SURVIVOR->count; i++) {
    put(SURVIVOR->exc[i]);
    put(SURVIVOR->cfsr[i]);
    put(SURVIVOR->hfsr[i]);
    put(SURVIVOR->irq_pending[i]);
  }
  put(SURVIVOR->depth);
  finish();
  for (;;) {}
}

static void overflow_the_main_stack(void) {
  SURVIVOR->resume = report;
  recurse_on_the_main_stack();
}

static void read_a_vector_past_the_end_of_ram(void) {
  volatile uint32_t *table = (volatile uint32_t *)TABLE_ACROSS_RAM_END;
  for (uint32_t i = 0; i < VECTORS_BEFORE_RAM_ENDS; i++) table[i] = ((volatile uint32_t *)TABLE_IN_RAM)[i];
  SURVIVOR->vtor_to_restore = SCB_VTOR;
  barrier();
  SCB_VTOR = TABLE_ACROSS_RAM_END;
  barrier();
  NVIC_ISER1 = IRQ_PAST_RAM_END_BIT;
  NVIC_STIR = IRQ_PAST_RAM_END;
  barrier();
  overflow_the_main_stack();
}

static void escalate_with_bus_fault_disabled(void) {
  SCB_SHPR3 = 0;
  SCB_SHCSR &= ~SHCSR_BUSFAULTENA;
  SURVIVOR->resume = read_a_vector_past_the_end_of_ram;
  pend_sv_with_the_process_stack_below_ram();
}

static void derived_first_when_more_urgent(void) {
  SCB_SHPR3 = PENDSV_LOWEST_PRIORITY;
  SURVIVOR->resume = escalate_with_bus_fault_disabled;
  pend_sv_with_the_process_stack_below_ram();
}

int main(void) {
  SURVIVOR->count = 0;
  SURVIVOR->depth = 0;
  SURVIVOR->vtor_to_restore = 0;
  use_a_table_in_ram();
  SCB_SHCSR |= SHCSR_BUSFAULTENA;
  SURVIVOR->resume = derived_first_when_more_urgent;
  pend_sv_with_the_process_stack_below_ram();
}
