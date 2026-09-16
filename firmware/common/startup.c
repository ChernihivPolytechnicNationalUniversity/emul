/* Minimal Cortex-M4 startup: vector table, .data copy, .bss clear, main. */
#include <stdint.h>

extern uint32_t _estack, _sidata, _sdata, _edata, _sbss, _ebss;
extern int main(void);

void Reset_Handler(void);
void Default_Handler(void);

/* Every handler is weak and aliases the default, so tests override just the ones they use. */
#define WEAK_ALIAS __attribute__((weak, alias("Default_Handler")))
void NMI_Handler(void) WEAK_ALIAS;
void HardFault_Handler(void) WEAK_ALIAS;
void MemManage_Handler(void) WEAK_ALIAS;
void BusFault_Handler(void) WEAK_ALIAS;
void UsageFault_Handler(void) WEAK_ALIAS;
void SVC_Handler(void) WEAK_ALIAS;
void DebugMon_Handler(void) WEAK_ALIAS;
void PendSV_Handler(void) WEAK_ALIAS;
void SysTick_Handler(void) WEAK_ALIAS;
/* External interrupts used by the tests. */
void WWDG_IRQHandler(void) WEAK_ALIAS;            /* 0 */
void EXTI0_IRQHandler(void) WEAK_ALIAS;           /* 6 */
void EXTI1_IRQHandler(void) WEAK_ALIAS;           /* 7 */
void TIM2_IRQHandler(void) WEAK_ALIAS;            /* 28 */
void USART3_IRQHandler(void) WEAK_ALIAS;          /* 39 */
void EXTI15_10_IRQHandler(void) WEAK_ALIAS;       /* 40 */

typedef void (*vector_t)(void);

__attribute__((section(".isr_vector"), used))
const vector_t g_pfnVectors[16 + 91] = {
  (vector_t)&_estack,
  Reset_Handler,
  NMI_Handler,
  HardFault_Handler,
  MemManage_Handler,
  BusFault_Handler,
  UsageFault_Handler,
  0, 0, 0, 0,
  SVC_Handler,
  DebugMon_Handler,
  0,
  PendSV_Handler,
  SysTick_Handler,
  [16 + 0] = WWDG_IRQHandler,
  [16 + 6] = EXTI0_IRQHandler,
  [16 + 7] = EXTI1_IRQHandler,
  [16 + 28] = TIM2_IRQHandler,
  [16 + 39] = USART3_IRQHandler,
  [16 + 40] = EXTI15_10_IRQHandler,
};

void Reset_Handler(void) {
  uint32_t *src = &_sidata, *dst = &_sdata;
  while (dst < &_edata) *dst++ = *src++;
  for (dst = &_sbss; dst < &_ebss;) *dst++ = 0;
  /* Enable the FPU (CPACR CP10/CP11 full access) like the CMSIS SystemInit does. */
  *(volatile uint32_t *)0xE000ED88 |= (0xFu << 20);
  __asm volatile("dsb; isb");
  main();
  for (;;) __asm volatile("bkpt 1");
}

void Default_Handler(void) {
  for (;;) __asm volatile("bkpt 2");
}
