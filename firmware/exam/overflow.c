#include "exam.h"
volatile uint32_t depth;
__attribute__((noinline)) uint32_t dive(uint32_t n) {
  volatile uint32_t pad[16];
  pad[0] = n;
  depth = n;
  return dive(n + 1) + pad[0];
}
int main(void) { put(dive(0)); finish(); for (;;) {} }
