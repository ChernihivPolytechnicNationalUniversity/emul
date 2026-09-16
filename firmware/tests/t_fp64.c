/* Double precision and the FPv5 extras: built for the Cortex-M7 (fpv5-d16) this runs on the
   real FPU; on the M4 build the doubles go through the soft-float library and the rounding
   functions through libm, so the same results are expected either way. */
#include "test.h"
#include <math.h>

static uint32_t f2u(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }
static uint32_t d2u_hi(double d) { uint64_t u; memcpy(&u, &d, 8); return (uint32_t)(u >> 32); }
static uint32_t d2u_lo(double d) { uint64_t u; memcpy(&u, &d, 8); return (uint32_t)u; }
#define OUT_D(x) do { double _d = (x); out[++n] = d2u_hi(_d); out[++n] = d2u_lo(_d); } while (0)

/* VSEL and VCVT{A,M} are what the compiler rarely emits by itself; hand-assembled on FPv5, plain C elsewhere. */
#if defined(__ARM_FP) && (__ARM_FP & 8) /* double precision means FPv5 on Cortex-M */
#define VSEL(cc, a, b, x, y) ({ float _r; __asm__("vcmp.f32 %1, %2\n\tvmrs APSR_nzcv, fpscr\n\tvsel" #cc ".f32 %0, %3, %4" : "=t"(_r) : "t"(a), "t"(b), "t"(x), "t"(y) : "cc"); _r; })
static float vsel_gt(float a, float b, float x, float y) { return VSEL(gt, a, b, x, y); }
static float vsel_ge(float a, float b, float x, float y) { return VSEL(ge, a, b, x, y); }
static float vsel_eq(float a, float b, float x, float y) { return VSEL(eq, a, b, x, y); }
static float vsel_vs(float a, float b, float x, float y) { return VSEL(vs, a, b, x, y); }
static uint32_t vcvta_s32(float a) { float r; __asm__("vcvta.s32.f32 %0, %1" : "=t"(r) : "t"(a)); return f2u(r); }
static uint32_t vcvtm_u32(float a) { float r; __asm__("vcvtm.u32.f32 %0, %1" : "=t"(r) : "t"(a)); return f2u(r); }
static uint32_t vcvtp_s32(float a) { float r; __asm__("vcvtp.s32.f32 %0, %1" : "=t"(r) : "t"(a)); return f2u(r); }
static uint32_t vcvtn_s32(float a) { float r; __asm__("vcvtn.s32.f32 %0, %1" : "=t"(r) : "t"(a)); return f2u(r); }
#else
static float vsel_gt(float a, float b, float x, float y) { return a > b ? x : y; }
static float vsel_ge(float a, float b, float x, float y) { return a >= b ? x : y; }
static float vsel_eq(float a, float b, float x, float y) { return a == b ? x : y; }
static float vsel_vs(float a, float b, float x, float y) { return isunordered(a, b) ? x : y; }
/* The FPU saturates; C's out-of-range conversion is undefined, so clamp by hand. */
static uint32_t sat_s32(float r) { return r >= 2147483647.0f ? 0x7fffffffu : r <= -2147483648.0f ? 0x80000000u : (uint32_t)(int32_t)r; }
static uint32_t vcvta_s32(float a) { return sat_s32(roundf(a)); }
static uint32_t vcvtm_u32(float a) { return a <= 0 ? 0 : (uint32_t)floorf(a); }
static uint32_t vcvtp_s32(float a) { return sat_s32(ceilf(a)); }
static uint32_t vcvtn_s32(float a) { return sat_s32(rintf(a)); }
#endif

int run_test(volatile uint32_t *out) {
  int n = 0;
  volatile double a = 3.5, b = -1.25, c = 1e-3, third = 1.0 / 3.0;
  volatile float fa = 2.5f, fb = -7.75f;

  /* Arithmetic: vadd/vsub/vmul/vdiv/vneg/vabs/vsqrt/vfma .f64 */
  OUT_D(a + b); OUT_D(a - b); OUT_D(a * b); OUT_D(a / b); OUT_D(-a); OUT_D(fabs(b)); OUT_D(sqrt(a));
  OUT_D(a * b + c); OUT_D(fma(a, b, c)); OUT_D(third * 3.0); OUT_D(0.1 + 0.2);

  /* Conversions between precisions and with integers. */
  volatile int32_t i = -7; volatile uint32_t u = 4000000000u;
  OUT_D((double)fa); OUT_D((double)fb); out[++n] = f2u((float)a); out[++n] = f2u((float)third);
  OUT_D((double)i); OUT_D((double)u);
  out[++n] = (uint32_t)(int32_t)(a * 100.0); out[++n] = (uint32_t)(int32_t)(b * 100.0); out[++n] = (uint32_t)(a * 1e9);

  /* Comparisons (vcmp.f64) including NaN. */
  volatile double nan = NAN, inf = INFINITY;
  uint32_t flags = 0;
  flags |= (a < b) << 0; flags |= (a > b) << 1; flags |= (a == a) << 2; flags |= (nan == nan) << 3;
  flags |= (nan < a) << 4; flags |= (a != nan) << 5; flags |= (inf > a) << 6; flags |= (-inf < b) << 7;
  flags |= (a >= 3.5) << 8; flags |= isnan(nan) << 9; flags |= (b <= -1.25) << 10;
  out[++n] = flags;

  /* FPv5: vmaxnm/vminnm, vrint{a,n,p,m,z,x}, vcvt{a,m,p} via the libm rounding functions. */
  volatile float x = 2.5f, y = -2.5f, z = 3.5f, w = -0.4f;
  out[++n] = f2u(fmaxf(x, y)); out[++n] = f2u(fminf(x, y)); out[++n] = f2u(fmaxf(x, (float)nan));
  out[++n] = f2u(roundf(x)); out[++n] = f2u(roundf(y)); out[++n] = f2u(roundf(z));
  out[++n] = f2u(floorf(y)); out[++n] = f2u(ceilf(y)); out[++n] = f2u(truncf(y)); out[++n] = f2u(truncf(w));
  out[++n] = f2u(nearbyintf(x)); out[++n] = f2u(nearbyintf(z)); out[++n] = f2u(rintf(y));
  out[++n] = (uint32_t)lroundf(x); out[++n] = (uint32_t)lroundf(y); out[++n] = (uint32_t)lrintf(x); out[++n] = (uint32_t)lrintf(z);
  out[++n] = (uint32_t)(int32_t)floorf(y); out[++n] = (uint32_t)(int32_t)ceilf(w);
  OUT_D(fmax(a, b)); OUT_D(fmin(a, nan)); OUT_D(round(-2.5)); OUT_D(floor(b)); OUT_D(ceil(b)); OUT_D(trunc(b)); OUT_D(nearbyint(2.5));
  out[++n] = (uint32_t)lround(b); out[++n] = (uint32_t)lrint(2.5); out[++n] = (uint32_t)(int32_t)floor(b);

  /* VSEL by every condition, VCVT with directed rounding. */
  volatile float fnan = NAN;
  out[++n] = f2u(vsel_gt(fa, fb, 1.0f, 2.0f)); out[++n] = f2u(vsel_gt(fb, fa, 1.0f, 2.0f)); out[++n] = f2u(vsel_gt(fa, fnan, 1.0f, 2.0f));
  out[++n] = f2u(vsel_ge(fa, fa, 1.0f, 2.0f)); out[++n] = f2u(vsel_ge(fb, fa, 1.0f, 2.0f));
  out[++n] = f2u(vsel_eq(fa, fa, 1.0f, 2.0f)); out[++n] = f2u(vsel_eq(fa, fb, 1.0f, 2.0f));
  out[++n] = f2u(vsel_vs(fa, fnan, 1.0f, 2.0f)); out[++n] = f2u(vsel_vs(fa, fb, 1.0f, 2.0f));
  out[++n] = vcvta_s32(2.5f); out[++n] = vcvta_s32(-2.5f); out[++n] = vcvta_s32(1e12f);
  out[++n] = vcvtm_u32(2.9f); out[++n] = vcvtm_u32(-0.5f); out[++n] = vcvtp_s32(-2.5f); out[++n] = vcvtn_s32(2.5f); out[++n] = vcvtn_s32(3.5f);

  /* Conditional selects the compiler turns into vsel at -O2. */
  volatile float p = 1.0f, q = 2.0f;
  float sel = (fa > fb) ? p : q; out[++n] = f2u(sel);
  sel = (fa == fb) ? p : q; out[++n] = f2u(sel);
  sel = (fa >= fb) ? p : q; out[++n] = f2u(sel);
  sel = (fa < fb) ? p : q; out[++n] = f2u(sel);
  double dsel = (a > b) ? a : b; OUT_D(dsel);
  dsel = (nan > b) ? a : b; OUT_D(dsel);

  /* A loop with doubles: vmla.f64 and vldr/vstr of D registers. */
  double acc = 0.0, arr[8];
  for (int k = 0; k < 8; k++) arr[k] = (double)(k * k) * 0.125 - 1.0;
  for (int k = 0; k < 8; k++) acc = acc * 0.75 + arr[k] * (double)k;
  OUT_D(acc); OUT_D(sqrt(fabs(acc)));
  return n;
}
