#pragma once
#include <stdint.h>

#define REG(addr) (*(volatile uint32_t *)(addr))

#define SCB_CCR REG(0xE000ED14)
#define SCB_SHCSR REG(0xE000ED24)
#define SCB_CFSR REG(0xE000ED28)
#define SCB_HFSR REG(0xE000ED2C)
#define SCB_MMFAR REG(0xE000ED34)
#define SCB_BFAR REG(0xE000ED38)
#define SYST_CSR REG(0xE000E010)
#define SYST_RVR REG(0xE000E014)
#define NVIC_ISER0 REG(0xE000E100)
#define NVIC_ICER0 REG(0xE000E180)
#define NVIC_STIR REG(0xE000EF00)
#define MPU_TYPE REG(0xE000ED90)
#define MPU_CTRL REG(0xE000ED94)
#define MPU_RNR REG(0xE000ED98)
#define MPU_RBAR REG(0xE000ED9C)
#define MPU_RASR REG(0xE000EDA0)
#define MPU_RBAR_A1 REG(0xE000EDA4)
#define MPU_RASR_A1 REG(0xE000EDA8)

#define RCC_AHB1ENR REG(0x40023830)
#define RCC_APB1ENR REG(0x40023840)
#define PWR_CR1 REG(0x40007000)
#define PWR_CSR1 REG(0x40007004)
#define EXTI_IMR REG(0x40013C00)
#define EXTI_RTSR REG(0x40013C08)
#define EXTI_FTSR REG(0x40013C0C)
#define EXTI_PR REG(0x40013C14)
#define GPIOA_PUPDR REG(0x4002000C)
#define GPIOA_IDR REG(0x40020010)
#define GPIOB_MODER REG(0x40020400)
#define GPIOB_BSRR REG(0x40020418)

#define RCC_AHB1ENR_GPIOAEN (1u << 0)
#define RCC_AHB1ENR_GPIOBEN (1u << 1)
#define RCC_AHB1ENR_BKPSRAMEN (1u << 18)
#define RCC_APB1ENR_PWREN (1u << 28)
#define PWR_CR1_PVDE (1u << 4)
#define PWR_CR1_PLS_SHIFT 5u
#define PWR_CR1_PLS_MASK (7u << PWR_CR1_PLS_SHIFT)
#define PWR_CR1_DBP (1u << 8)
#define PWR_CSR1_PVDO (1u << 2)
#define PWR_CSR1_BRR (1u << 3)
#define PWR_CSR1_BRE (1u << 9)
#define LED1_PB6 6u

#define SHCSR_MEMFAULTENA (1u << 16)
#define SHCSR_BUSFAULTENA (1u << 17)
#define SHCSR_USGFAULTENA (1u << 18)
#define CCR_USERSETMPEND (1u << 1)

#define MPU_ENABLE 1u
#define MPU_HFNMIENA 2u
#define MPU_PRIVDEFENA 4u
#define RBAR_VALID (1u << 4)
#define AP_NONE 0u
#define AP_PRIVILEGED_RW 1u
#define AP_PRIVILEGED_RW_UNPRIVILEGED_RO 2u
#define AP_FULL 3u
#define AP_PRIVILEGED_RO 5u
#define AP_RO 6u
#define EXECUTE_NEVER 1u
#define EXECUTABLE 0u
#define RASR(log2size, ap, xn, disabled_subregions) (((xn) << 28) | ((ap) << 24) | ((disabled_subregions) << 8) | (((log2size) - 1) << 1) | 1u)

#define RESULTS_DONE 0xC0FFEE00u
#define SVC_DROP_NOTHING 2
#define SVC_REGAIN_PRIVILEGE 1

__attribute__((section(".results"))) volatile uint32_t results[128];

static inline uint32_t get_ipsr(void) { uint32_t r; __asm volatile("mrs %0, ipsr" : "=r"(r)); return r; }
static inline uint32_t get_control(void) { uint32_t r; __asm volatile("mrs %0, control" : "=r"(r)); return r; }
static inline void set_control(uint32_t v) { __asm volatile("msr control, %0\n isb" :: "r"(v) : "memory"); }
static inline uint32_t get_msp(void) { uint32_t r; __asm volatile("mrs %0, msp" : "=r"(r)); return r; }
static inline uint32_t get_psp(void) { uint32_t r; __asm volatile("mrs %0, psp" : "=r"(r)); return r; }
static inline void set_psp(uint32_t v) { __asm volatile("msr psp, %0" :: "r"(v) : "memory"); }
static inline uint32_t get_sp(void) { uint32_t r; __asm volatile("mov %0, sp" : "=r"(r)); return r; }
static inline uint32_t get_primask(void) { uint32_t r; __asm volatile("mrs %0, primask" : "=r"(r)); return r; }
static inline uint32_t get_basepri(void) { uint32_t r; __asm volatile("mrs %0, basepri" : "=r"(r)); return r; }
static inline void set_basepri(uint32_t v) { __asm volatile("msr basepri, %0" :: "r"(v) : "memory"); }
static inline void barrier(void) { __asm volatile("dsb\n isb" ::: "memory"); }
static inline void store_word(uint32_t addr, uint32_t v) { __asm volatile("str %1, [%0]" :: "r"(addr), "r"(v) : "memory"); }
static inline uint32_t load_word(uint32_t addr) { uint32_t v = 0; __asm volatile("ldr %0, [%1]" : "+r"(v) : "r"(addr) : "memory"); return v; }
static inline void regain_privilege(void) { __asm volatile("svc #1" ::: "memory"); }
static inline void call_supervisor(void) { __asm volatile("svc #2" ::: "memory"); }

volatile uint32_t fault_count, fault_exc, fault_cfsr, fault_hfsr, fault_mmfar, fault_bfar, fault_pc;
volatile uint32_t svc_count, svc_ipsr, svc_exc_return, svc_control, svc_frame;

__attribute__((used)) void fault_record(uint32_t *frame) {
  fault_exc = get_ipsr();
  fault_cfsr = SCB_CFSR;
  fault_hfsr = SCB_HFSR;
  fault_mmfar = SCB_MMFAR;
  fault_bfar = SCB_BFAR;
  fault_pc = frame[6];
  if (fault_cfsr & 1u) {
    frame[6] = frame[5] & ~1u;
  } else {
    uint16_t first = *(volatile uint16_t *)frame[6];
    frame[6] += (first & 0xf800u) >= 0xe800u ? 4u : 2u;
  }
  SCB_CFSR = fault_cfsr;
  SCB_HFSR = fault_hfsr;
  fault_count++;
}

__attribute__((used)) void svc_record(uint32_t *frame, uint32_t exc_return) {
  uint8_t number = ((volatile uint8_t *)frame[6])[-2];
  svc_count++;
  svc_ipsr = get_ipsr();
  svc_exc_return = exc_return;
  svc_control = get_control();
  svc_frame = (uint32_t)frame;
  if (number == SVC_REGAIN_PRIVILEGE) set_control(get_control() & ~1u);
}

#define FRAME_ENTRY(name, target) \
  __attribute__((naked)) void name(void) { __asm volatile("tst lr, #4\n ite eq\n mrseq r0, msp\n mrsne r0, psp\n mov r1, lr\n b " #target "\n"); }

FRAME_ENTRY(HardFault_Handler, fault_record)
FRAME_ENTRY(MemManage_Handler, fault_record)
FRAME_ENTRY(BusFault_Handler, fault_record)
FRAME_ENTRY(UsageFault_Handler, fault_record)
FRAME_ENTRY(SVC_Handler, svc_record)

__attribute__((naked, noinline)) void run_on_process_stack(__attribute__((unused)) void (*thread)(void), __attribute__((unused)) uint32_t top) {
  __asm volatile(
      "push {r4, lr}\n"
      "msr psp, r1\n"
      "mrs r4, control\n"
      "orr r2, r4, #2\n"
      "msr control, r2\n"
      "isb\n"
      "blx r0\n"
      "msr control, r4\n"
      "isb\n"
      "pop {r4, pc}\n");
}

static uint32_t result_count;
static inline void put(uint32_t v) {
  if (result_count < sizeof results / sizeof results[0] - 1u) results[++result_count] = v;
}
static inline void finish(void) {
  results[0] = RESULTS_DONE | result_count;
  __asm volatile("bkpt 0");
}

static inline void led1(int on) { GPIOB_BSRR = on ? 1u << LED1_PB6 : 1u << (LED1_PB6 + 16u); }
static inline void led1_output(void) {
  RCC_AHB1ENR |= RCC_AHB1ENR_GPIOBEN;
  GPIOB_MODER = (GPIOB_MODER & ~(3u << (2u * LED1_PB6))) | (1u << (2u * LED1_PB6));
}
