#include "exam.h"

#define SYSTICK_RELOAD_BEFORE 0x00000777u
#define SYSTICK_RELOAD_TRIED 0x00001234u
#define BASEPRI_SET 0x80u

static uint64_t process_stack[128];
static volatile uint32_t pended_from_thread;

void WWDG_IRQHandler(void) {
  pended_from_thread++;
  NVIC_ICER0 = 1u;
}

static int on_process_stack(void) { return get_sp() - (uint32_t)process_stack < sizeof process_stack; }
static void drop_privilege(void) { set_control(get_control() | 1u); }

static void thread(void) {
  put(get_control());
  put(on_process_stack());
  uint32_t msp = get_msp();
  uint32_t psp = get_psp();
  call_supervisor();
  put(svc_ipsr);
  put(svc_exc_return | 0x10u);
  put(svc_control);
  put(svc_frame - (uint32_t)process_stack < sizeof process_stack);
  put(get_msp() == msp);
  put(get_psp() == psp);

  set_basepri(BASEPRI_SET);
  drop_privilege();
  put(get_control());
  put(get_msp());
  put(get_psp());
  put(get_basepri());
  set_control(0u);
  put(get_control());
  __asm volatile("cpsid i" ::: "memory");

  uint32_t before = fault_count;
  SYST_RVR = SYSTICK_RELOAD_TRIED;
  put(fault_count - before);
  put(fault_exc);
  put(fault_cfsr);
  put(fault_bfar);
  (void)SYST_CSR;
  put(fault_count - before);
  put(fault_bfar);
  NVIC_STIR = 0u;
  put(fault_count - before);
  put(fault_bfar);

  regain_privilege();
  put(get_control());
  put(svc_exc_return | 0x10u);
  put(get_basepri());
  put(get_primask());
  put(SYST_RVR);
  set_basepri(0u);

  SCB_CCR |= CCR_USERSETMPEND;
  NVIC_ISER0 = 1u;
  drop_privilege();
  before = fault_count;
  NVIC_STIR = 0u;
  barrier();
  put(fault_count - before);
  put(pended_from_thread);
  regain_privilege();
  SCB_CCR &= ~CCR_USERSETMPEND;

  SCB_SHCSR &= ~SHCSR_BUSFAULTENA;
  drop_privilege();
  before = fault_count;
  SYST_RVR = SYSTICK_RELOAD_TRIED;
  put(fault_count - before);
  put(fault_exc);
  put(fault_hfsr);
  put(fault_cfsr);
  regain_privilege();
}

int main(void) {
  SCB_SHCSR |= SHCSR_MEMFAULTENA | SHCSR_BUSFAULTENA | SHCSR_USGFAULTENA;
  SYST_RVR = SYSTICK_RELOAD_BEFORE;
  put(get_control());
  put(get_ipsr());
  run_on_process_stack(thread, (uint32_t)&process_stack[128]);
  put(get_control());
  put(on_process_stack());
  put(svc_count);

  uint32_t before = fault_count;
  __asm volatile("cpsid i" ::: "memory");
  call_supervisor();
  __asm volatile("cpsie i" ::: "memory");
  put(fault_count - before);
  put(fault_exc);
  put(fault_hfsr);
  put(svc_count);

  SCB_SHCSR &= ~SHCSR_USGFAULTENA;
  before = fault_count;
  __asm volatile(".hword 0xde00" ::: "memory");
  put(fault_count - before);
  put(fault_exc);
  put(fault_hfsr);
  put(fault_cfsr);

  SCB_SHCSR |= SHCSR_USGFAULTENA;
  before = fault_count;
  __asm volatile(".hword 0xde00" ::: "memory");
  put(fault_count - before);
  put(fault_exc);
  put(fault_hfsr);
  put(fault_cfsr);
  finish();
  for (;;) {
  }
}
