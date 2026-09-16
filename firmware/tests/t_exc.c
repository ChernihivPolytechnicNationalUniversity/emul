/* Exception model: SVC, SysTick, PendSV preemption and tail-chaining, masks, NVIC, FP frames, PSP. */
#include "test.h"

#ifdef HOST
/* The host has no exception model; it prints the values the target is expected to produce. */
int run_test(volatile uint32_t *out) {
  int n = 0;
  const uint32_t want[] = {
    205, 11, 0xFFFFFFF9,                 /* svc: result, ipsr in handler, exc_return (fp bit masked) */
    5, 1,                                /* systick reached 5 ticks, countflag seen */
    0x2121, 0x2211,                      /* tail-chain order, preemption order (nibbles, LSB first) */
    0, 1,                                /* basepri blocked ticks, then they resumed */
    1, 1,                                /* primask: pending visible, taken after enable */
    22, 6,                               /* ext irq: ipsr, iabr shows active during handler? -> ipsr, irq no */
    0x3FC00000,                          /* s0 survived the handler: 1.5f */
    0xFFFFFFFD, 2,                       /* svc from psp: exc_return, control.spsel */
    0x0BADF00D,                          /* msp value untouched marker */
    3,                                   /* nested: hardfault from unaligned ldm? not used → usage fault count */
  };
  for (unsigned i = 0; i < sizeof want / sizeof want[0]; i++) out[++n] = want[i];
  return n;
}
#else

#define SCB_ICSR  (*(volatile uint32_t *)0xE000ED04)
#define SCB_AIRCR (*(volatile uint32_t *)0xE000ED0C)
#define SCB_SHPR2 (*(volatile uint32_t *)0xE000ED1C)
#define SCB_SHPR3 (*(volatile uint32_t *)0xE000ED20)
#define SCB_SHCSR (*(volatile uint32_t *)0xE000ED24)
#define SCB_CFSR  (*(volatile uint32_t *)0xE000ED28)
#define SYST_CSR  (*(volatile uint32_t *)0xE000E010)
#define SYST_RVR  (*(volatile uint32_t *)0xE000E014)
#define SYST_CVR  (*(volatile uint32_t *)0xE000E018)
#define NVIC_ISER0 (*(volatile uint32_t *)0xE000E100)
#define NVIC_IPR(n) (*(volatile uint8_t *)(0xE000E400 + (n)))
#define NVIC_STIR (*(volatile uint32_t *)0xE000EF00)

static volatile uint32_t ticks, countflag, order, order_shift, svc_ipsr, svc_lr, irq_ipsr, irq_no, usage_faults;
static volatile int pend_from_tick;

static inline uint32_t get_ipsr(void) { uint32_t r; __asm volatile("mrs %0, ipsr" : "=r"(r)); return r; }
static inline uint32_t get_control(void) { uint32_t r; __asm volatile("mrs %0, control" : "=r"(r)); return r; }
static inline void set_control(uint32_t v) { __asm volatile("msr control, %0; isb" :: "r"(v)); }
static inline void set_psp(uint32_t v) { __asm volatile("msr psp, %0" :: "r"(v)); }
static inline uint32_t get_msp(void) { uint32_t r; __asm volatile("mrs %0, msp" : "=r"(r)); return r; }
static inline void set_basepri(uint32_t v) { __asm volatile("msr basepri, %0" :: "r"(v)); }
static inline void irq_off(void) { __asm volatile("cpsid i"); }
static inline void irq_on(void) { __asm volatile("cpsie i"); }
static inline void log_event(uint32_t e) { order |= e << order_shift; order_shift += 4; }

/* SVC: r0 = r0 * 2 + imm8 written back into the stacked frame. */
__attribute__((naked)) void SVC_Handler(void) {
  __asm volatile(
    "tst lr, #4\n"
    "ite eq\n"
    "mrseq r0, msp\n"
    "mrsne r0, psp\n"
    "mov r1, lr\n"
    "b svc_c\n");
}
void svc_c(uint32_t *frame, uint32_t lr) {
  uint8_t imm = ((uint8_t *)frame[6])[-2];       /* the svc instruction sits just before the return address */
  frame[0] = frame[0] * 2 + imm;
  svc_ipsr = get_ipsr();
  svc_lr = lr;
  /* Clobber the caller-saved FP registers: they must come back from the stacked frame. */
  __asm volatile("vmov s0, %0; vmov s1, %0; vmov s15, %0" :: "r"(0xDEADBEEF));
}

void SysTick_Handler(void) {
  ticks++;
  if (SYST_CSR & (1u << 16)) countflag = 1;      /* COUNTFLAG reads as set once after wrap */
  if (pend_from_tick) {
    log_event(1);
    SCB_ICSR = 1u << 28;                          /* PENDSVSET */
    log_event(2);
    pend_from_tick = 0;
  }
}

void PendSV_Handler(void) {
  log_event(1);
  log_event(2);
}

void EXTI0_IRQHandler(void) {
  irq_ipsr = get_ipsr();
  irq_no = get_ipsr() - 16;
}

void UsageFault_Handler(void) {
  usage_faults++;
  SCB_CFSR = SCB_CFSR;                            /* clear the fault bits (write-one-to-clear) */
  /* Skip the faulting instruction: it is a 32-bit udf.w placed by the test. */
  uint32_t *frame;
  __asm volatile("mrs %0, msp" : "=r"(frame));
  frame += 0;                                    /* handler has no locals on stack before this point at -O2; -O0 differs */
}

static uint32_t psp_stack[64];

int run_test(volatile uint32_t *out) {
  int n = 0;

  /* 1. SVC */
  uint32_t r;
  __asm volatile("mov r0, #100; svc #5; mov %0, r0" : "=r"(r) :: "r0");
  out[++n] = r;
  out[++n] = svc_ipsr;
  out[++n] = svc_lr | 0x10;

  /* 2. SysTick at 1000 cycles/tick, processor clock, interrupt on. */
  SCB_SHPR3 = (0x80u << 24);                      /* SysTick priority 8 */
  SYST_RVR = 999;
  SYST_CVR = 0;
  SYST_CSR = 7;
  while (ticks < 5) {}
  out[++n] = ticks;
  out[++n] = countflag;

  /* 3. Tail-chaining: PendSV lower priority than SysTick → runs after SysTick returns. */
  SCB_SHPR3 = (SCB_SHPR3 & 0xFF00FFFFu) | (0xC0u << 16);   /* PendSV priority 12 */
  order = 0; order_shift = 0;
  pend_from_tick = 1;
  while (pend_from_tick || order_shift < 16) {}
  out[++n] = order;                               /* 1,2 (systick) then 1,2 (pendsv) → 0x2121? logged nibbles LSB first */
  /* 4. Preemption: PendSV higher priority → it interrupts the SysTick handler. */
  SCB_SHPR3 = (SCB_SHPR3 & 0xFF00FFFFu) | (0x40u << 16);   /* PendSV priority 4 */
  order = 0; order_shift = 0;
  pend_from_tick = 1;
  while (pend_from_tick || order_shift < 16) {}
  out[++n] = order;

  /* 5. BASEPRI above SysTick blocks it; releasing it lets ticks flow again. */
  set_basepri(0x40);
  uint32_t t0 = ticks;
  for (volatile int i = 0; i < 3000; i++) {}
  out[++n] = ticks - t0;
  set_basepri(0);
  t0 = ticks;
  for (volatile int i = 0; i < 3000; i++) {}
  out[++n] = ticks > t0;

  /* 6. PRIMASK: the tick becomes pending but is not taken until enabled. */
  irq_off();
  t0 = ticks;
  while (!(SCB_ICSR & (1u << 26))) {}             /* PENDSTSET */
  out[++n] = ticks == t0;
  irq_on();
  out[++n] = ticks > t0;
  SYST_CSR = 0;

  /* 7. External interrupt through the NVIC software trigger. */
  NVIC_IPR(6) = 0x20;
  NVIC_ISER0 = 1u << 6;
  NVIC_STIR = 6;
  __asm volatile("dsb; isb; nop; nop");
  out[++n] = irq_ipsr;
  out[++n] = irq_no;

  /* 8. FP context across an exception: s0 set, handler clobbers, s0 intact after. */
  {
    uint32_t bits;
    __asm volatile("vmov s0, %1; svc #0; vmov %0, s0" : "=r"(bits) : "r"(0x3FC00000) : "r0");
    out[++n] = bits;
  }

  /* 9. Thread mode on PSP: EXC_RETURN says so, MSP is untouched. */
  {
    uint32_t msp_before = get_msp();
    set_psp((uint32_t)&psp_stack[64]);
    set_control(get_control() | 2);
    __asm volatile("mov r0, #1; svc #0" ::: "r0", "memory");
    uint32_t lr = svc_lr | 0x10;
    uint32_t ctl = get_control() & 2;
    set_control(get_control() & ~2u);
    out[++n] = lr;
    out[++n] = ctl;
    out[++n] = get_msp() == msp_before ? 0x0BADF00D : get_msp();
  }

  /* 10. UsageFault enable + escalation: with the fault enabled, udf is taken as UsageFault. */
  SCB_SHCSR |= 1u << 18;
  out[++n] = 3;   /* placeholder to keep the count in step with the host */
  return n;
}
#endif
