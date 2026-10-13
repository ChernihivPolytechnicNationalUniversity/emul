#include "exam.h"

#define RAM_BASE 0x20000000u
#define FLASH_BASE 0x08000000u
#define RCC_CR 0x40023800u
#define THUMB_MOVS_R0_42 0x202au
#define THUMB_BX_LR 0x4770u
#define ANSWER 42u
#define FIRST_SUBREGION 0x01u

#define REGION_RAM 0u
#define REGION_FLASH 1u
#define REGION_GUARDED 2u
#define REGION_CODE 3u
#define REGION_OVERLAP 4u
#define REGION_SHARED 5u

static volatile uint32_t guarded[256] __attribute__((aligned(1024)));
static volatile uint32_t shared[64] __attribute__((aligned(256)));
static volatile uint16_t ram_code[16] __attribute__((aligned(32)));

typedef uint32_t (*answer_t)(void);

static void region(uint32_t number, uint32_t base, uint32_t rasr) {
  MPU_RBAR = base | RBAR_VALID | number;
  MPU_RASR = rasr;
  barrier();
}

static void mpu(uint32_t ctrl) {
  MPU_CTRL = ctrl;
  barrier();
}

static uint32_t call_address(uint32_t addr) { return ((answer_t)(addr | 1u))(); }
static uint32_t call_ram_code(void) { return call_address((uint32_t)ram_code); }
static uint32_t at(volatile uint32_t *word) { return (uint32_t)word; }

int main(void) {
  SCB_SHCSR |= SHCSR_MEMFAULTENA | SHCSR_BUSFAULTENA | SHCSR_USGFAULTENA;
  ram_code[0] = THUMB_MOVS_R0_42;
  ram_code[1] = THUMB_BX_LR;
  barrier();

  put(MPU_TYPE);
  region(REGION_SHARED, (uint32_t)guarded, 0u);
  put(MPU_RNR);
  put(MPU_RBAR);
  MPU_RNR = REGION_RAM;
  put(MPU_RBAR & 0xfu);

  region(REGION_RAM, RAM_BASE, RASR(19, AP_FULL, EXECUTE_NEVER, 0u));
  region(REGION_FLASH, FLASH_BASE, RASR(20, AP_RO, EXECUTABLE, 0u));
  region(REGION_GUARDED, (uint32_t)guarded, RASR(10, AP_PRIVILEGED_RW, EXECUTE_NEVER, 0u));
  region(REGION_CODE, (uint32_t)ram_code, RASR(5, AP_FULL, EXECUTE_NEVER, 0u));
  put(MPU_RASR);
  mpu(MPU_ENABLE | MPU_PRIVDEFENA);

  guarded[1] = 0x11u;
  put(guarded[1]);
  put(fault_count);

  region(REGION_GUARDED, (uint32_t)guarded, RASR(10, AP_PRIVILEGED_RO, EXECUTE_NEVER, 0u));
  uint32_t before = fault_count;
  store_word(at(&guarded[3]), 0x33u);
  put(fault_count - before);
  put(fault_exc);
  put(fault_cfsr);
  put(fault_mmfar == at(&guarded[3]));
  put(guarded[3]);

  before = fault_count;
  call_ram_code();
  put(fault_count - before);
  put(fault_exc);
  put(fault_cfsr);
  put(fault_pc == (uint32_t)ram_code);
  region(REGION_CODE, (uint32_t)ram_code, RASR(5, AP_FULL, EXECUTABLE, 0u));
  put(call_ram_code());

  region(REGION_OVERLAP, (uint32_t)guarded, RASR(10, AP_FULL, EXECUTE_NEVER, 0u));
  before = fault_count;
  guarded[3] = 0x33u;
  put(fault_count - before);
  put(guarded[3]);
  MPU_RNR = REGION_OVERLAP;
  MPU_RASR = 0u;
  barrier();

  region(REGION_GUARDED, (uint32_t)guarded, RASR(10, AP_PRIVILEGED_RO, EXECUTE_NEVER, FIRST_SUBREGION));
  before = fault_count;
  guarded[0] = 0x55u;
  put(fault_count - before);
  store_word(at(&guarded[32]), 0x66u);
  put(fault_count - before);
  put(fault_mmfar == at(&guarded[32]));
  put(guarded[0]);
  put(guarded[32]);

  region(REGION_GUARDED, (uint32_t)guarded, RASR(10, AP_PRIVILEGED_RW, EXECUTE_NEVER, 0u));
  region(REGION_SHARED, (uint32_t)shared, RASR(8, AP_PRIVILEGED_RW_UNPRIVILEGED_RO, EXECUTE_NEVER, 0u));
  shared[0] = 0x77u;
  set_control(1u);
  before = fault_count;
  (void)load_word(at(&guarded[5]));
  put(fault_count - before);
  put(fault_cfsr);
  put(fault_mmfar == at(&guarded[5]));
  put(shared[0]);
  store_word(at(&shared[1]), 0x88u);
  put(fault_count - before);
  put(fault_mmfar == at(&shared[1]));
  (void)load_word(RCC_CR);
  put(fault_count - before);
  put(fault_exc);
  put(fault_mmfar);
  regain_privilege();
  put(get_control());

  mpu(MPU_ENABLE);
  before = fault_count;
  (void)load_word(RCC_CR);
  put(fault_count - before);
  put(fault_mmfar);
  mpu(MPU_ENABLE | MPU_PRIVDEFENA);
  before = fault_count;
  (void)load_word(RCC_CR);
  put(fault_count - before);

  region(REGION_GUARDED, (uint32_t)guarded, RASR(10, AP_NONE, EXECUTE_NEVER, 0u));
  before = fault_count;
  __asm volatile("cpsid f" ::: "memory");
  uint32_t seen = guarded[1];
  __asm volatile("cpsie f" ::: "memory");
  put(fault_count - before);
  put(seen);
  (void)load_word(at(&guarded[1]));
  put(fault_count - before);

  SCB_SHCSR &= ~SHCSR_MEMFAULTENA;
  before = fault_count;
  (void)load_word(at(&guarded[1]));
  put(fault_count - before);
  put(fault_exc);
  put(fault_hfsr);
  put(fault_cfsr);
  SCB_SHCSR |= SHCSR_MEMFAULTENA;

  mpu(0u);
  before = fault_count;
  put(guarded[1]);
  put(fault_count - before);
  call_address(RCC_CR);
  put(fault_count - before);
  put(fault_cfsr);

  mpu(MPU_ENABLE | MPU_HFNMIENA | MPU_PRIVDEFENA);
  results[0] = RESULTS_DONE | result_count;
  __asm volatile("cpsid f" ::: "memory");
  (void)load_word(at(&guarded[1]));
  __asm volatile("cpsie f" ::: "memory");
  put(fault_count);
  finish();
  for (;;) {
  }
}
