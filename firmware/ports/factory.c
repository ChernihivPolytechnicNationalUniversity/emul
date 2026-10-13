#include <stdint.h>

#define RCC_APB2ENR (*(volatile uint32_t *)0x40023844u)
#define ADC1 ((volatile uint32_t *)0x40012000u)
#define ADC3 ((volatile uint32_t *)0x40012200u)
#define ADC_CCR (*(volatile uint32_t *)0x40012304u)
#define OTP ((const volatile uint32_t *)0x1ff0f000u)
#define UID ((const volatile uint32_t *)0x1ff0f420u)
#define FLASH_SIZE_KB (*(const volatile uint16_t *)0x1ff0f442u)
#define VREFINT_CAL (*(const volatile uint16_t *)0x1ff0f44au)
#define TS_CAL1 (*(const volatile uint16_t *)0x1ff0f44cu)
#define TS_CAL2 (*(const volatile uint16_t *)0x1ff0f44eu)
#define PACKAGE_DATA (*(const volatile uint16_t *)0x1ff0f7e0u)

enum { OTP_WORDS = 0x420 / 4 };
enum { ADC_SR = 0, ADC_CR2 = 2, ADC_SMPR1 = 3, ADC_SQR1 = 11, ADC_SQR3 = 13, ADC_DR = 19 };
enum { ADC1_ENABLE = 1u << 8, ADC3_ENABLE = 1u << 10, ADON = 1u, SWSTART = 1u << 30, EOC = 1u << 1, TSVREFE = 1u << 23, VBATE = 1u << 22 };
enum { VREFINT = 17, TEMPERATURE_SENSOR = 18, LONGEST_SAMPLE_17_18 = (7u << 21) | (7u << 24) };
enum { CALIBRATION_VDDA_MV = 3300, TS_CAL1_CENTIDEGREES = 3000, TS_CAL2_CENTIDEGREES = 11000 };

volatile struct {
  uint32_t done;
  uint32_t uid[3];
  uint32_t otp_and;
  uint32_t flash_size_kb;
  uint32_t package_data;
  uint32_t vrefint_cal;
  uint32_t ts_cal1;
  uint32_t ts_cal2;
  uint32_t vrefint;
  uint32_t temperature;
  int32_t vdda_mv;
  int32_t centidegrees;
  uint32_t vbat_quarter;
  uint32_t vbat_with_both;
  uint32_t adc3_vrefint;
} bench;

static uint32_t convert_on(volatile uint32_t *adc, uint32_t channel) {
  adc[ADC_SQR1] = 0;
  adc[ADC_SQR3] = channel;
  adc[ADC_CR2] = ADON | SWSTART;
  while (!(adc[ADC_SR] & EOC)) {
  }
  return adc[ADC_DR];
}

static uint32_t convert(uint32_t channel) {
  return convert_on(ADC1, channel);
}

int main(void) {
  uint32_t otp_and = 0xffffffffu;
  for (uint32_t i = 0; i < OTP_WORDS; i++) otp_and &= OTP[i];
  bench.otp_and = otp_and;
  for (uint32_t i = 0; i < 3; i++) bench.uid[i] = UID[i];
  bench.flash_size_kb = FLASH_SIZE_KB;
  bench.package_data = PACKAGE_DATA;
  bench.vrefint_cal = VREFINT_CAL;
  bench.ts_cal1 = TS_CAL1;
  bench.ts_cal2 = TS_CAL2;

  RCC_APB2ENR |= ADC1_ENABLE;
  (void)RCC_APB2ENR;
  ADC_CCR |= TSVREFE;
  ADC1[ADC_SMPR1] = LONGEST_SAMPLE_17_18;
  ADC1[ADC_CR2] = ADON;
  bench.vrefint = convert(VREFINT);
  bench.temperature = convert(TEMPERATURE_SENSOR);
  bench.vdda_mv = (int32_t)(CALIBRATION_VDDA_MV * bench.vrefint_cal / bench.vrefint);
  bench.centidegrees = TS_CAL1_CENTIDEGREES
    + ((int32_t)bench.temperature - (int32_t)bench.ts_cal1) * (TS_CAL2_CENTIDEGREES - TS_CAL1_CENTIDEGREES) / ((int32_t)bench.ts_cal2 - (int32_t)bench.ts_cal1);
  ADC_CCR = (ADC_CCR & ~TSVREFE) | VBATE;
  bench.vbat_quarter = convert(TEMPERATURE_SENSOR);
  ADC_CCR |= TSVREFE;
  bench.vbat_with_both = convert(TEMPERATURE_SENSOR);
  ADC_CCR &= ~VBATE;
  RCC_APB2ENR |= ADC3_ENABLE;
  (void)RCC_APB2ENR;
  ADC3[ADC_SMPR1] = LONGEST_SAMPLE_17_18;
  ADC3[ADC_CR2] = ADON;
  bench.adc3_vrefint = convert_on(ADC3, VREFINT);
  bench.done = 1;
  for (;;) {
  }
}
