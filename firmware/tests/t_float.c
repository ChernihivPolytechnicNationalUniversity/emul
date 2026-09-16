/* Single precision on the FPv4-SP unit, double precision through the soft-float library. */
#include "test.h"
#include <math.h>

static uint32_t f2u(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }
static uint32_t d2u_hi(double d) { uint64_t u; memcpy(&u, &d, 8); return (uint32_t)(u >> 32); }
static uint32_t d2u_lo(double d) { uint64_t u; memcpy(&u, &d, 8); return (uint32_t)u; }

int run_test(volatile uint32_t *out) {
  int n = 0;
  volatile float a = 3.5f, b = -1.25f, c = 1e-3f;
  volatile double da = 3.5, db = -1.25;

  /* Basic arithmetic: vadd, vsub, vmul, vdiv, vneg, vabs, vfma via -ffp-contract=off it is separate. */
  float r = a + b; out[++n] = f2u(r);
  r = a - b; out[++n] = f2u(r);
  r = a * b; out[++n] = f2u(r);
  r = a / b; out[++n] = f2u(r);
  r = -a; out[++n] = f2u(r);
  r = fabsf(b); out[++n] = f2u(r);
  r = sqrtf(a); out[++n] = f2u(r);
  r = a * b + c; out[++n] = f2u(r);

  /* Conversions: vcvt in every direction, including negative and fractional values. */
  volatile int32_t i = -7; volatile uint32_t u = 4000000000u;
  out[++n] = f2u((float)i);
  out[++n] = f2u((float)u);
  out[++n] = (uint32_t)(int32_t)(a * 100.0f);
  out[++n] = (uint32_t)(int32_t)(b * 100.0f);           /* truncates toward zero */
  out[++n] = (uint32_t)(a * 1e9f);                       /* vcvt.u32 */
  out[++n] = (uint32_t)(int32_t)OPAQUE(-2.7f);

  /* Comparisons: vcmp + vmrs APSR_nzcv, including NaN and the IT blocks around them. */
  volatile float nan = NAN, inf = INFINITY;
  uint32_t flags = 0;
  flags |= (a < b) << 0; flags |= (a > b) << 1; flags |= (a == a) << 2; flags |= (nan == nan) << 3;
  flags |= (nan < a) << 4; flags |= (nan > a) << 5; flags |= (a != nan) << 6; flags |= (inf > a) << 7;
  flags |= (-inf < b) << 8; flags |= (a >= 3.5f) << 9; flags |= (a <= 3.5f) << 10; flags |= isnan(nan) << 11;
  out[++n] = flags;

  /* Accumulation in a loop: vmla / vfma, vmov between core and FP registers, vldr/vstr, vpush/vpop through calls. */
  float acc = 0.0f;
  float arr[16];
  for (int k = 0; k < 16; k++) arr[k] = (float)(k * k) * 0.25f - 3.0f;
  for (int k = 0; k < 16; k++) acc = acc * 0.5f + arr[k] * (float)k;
  out[++n] = f2u(acc);
  out[++n] = f2u(sqrtf(fabsf(acc)));

  /* Overflow / underflow / rounding edges. */
  volatile float big = 3e38f;
  out[++n] = f2u(big * 10.0f);         /* +inf */
  out[++n] = f2u(-big * 10.0f);        /* -inf */
  out[++n] = f2u(c * c * c * c);       /* denormal → flush? FPSCR.FZ is 0 by default: keeps denormals */
  out[++n] = f2u(1.0f / 3.0f);
  out[++n] = f2u(16777217.0f);         /* rounds to even */
  out[++n] = f2u(0.1f + 0.2f);

  /* Double precision goes through __aeabi_d* helpers: integer-only code, but lots of it. */
  double dr = da * db + 0.125;
  out[++n] = d2u_hi(dr); out[++n] = d2u_lo(dr);
  dr = da / db;
  out[++n] = d2u_hi(dr); out[++n] = d2u_lo(dr);
  dr = sqrt(da);
  out[++n] = d2u_hi(dr); out[++n] = d2u_lo(dr);
  out[++n] = (uint32_t)(int32_t)(dr * 1000.0);
  out[++n] = f2u((float)dr);                              /* vcvt via soft d2f */
  dr = (double)a;
  out[++n] = d2u_hi(dr); out[++n] = d2u_lo(dr);
  return n;
}
