#include "bench.h"

enum { SCANS = 256, CHANNEL_REFERENCE = 6, CHANNEL_SOURCE = 7, PF8 = 8, PF9 = 9, MODE_ANALOG = 3, DMA_CHANNEL_ADC3 = 2 };
enum { STREAM0_FLAGS = DMA_LIFCR_CTCIF0 | DMA_LIFCR_CHTIF0 | DMA_LIFCR_CTEIF0 | DMA_LIFCR_CDMEIF0 | DMA_LIFCR_CFEIF0 };

volatile struct {
  uint32_t sampling_code;
  uint32_t request;
  uint32_t done;
  uint16_t samples[2 * SCANS];
} sample_hold;

static void scan_into_memory(uint32_t code) {
  ADC3->CR2 = 0;
  DMA2_Stream0->CR = 0;
  while (DMA2_Stream0->CR & DMA_SxCR_EN) {
  }
  DMA2->LIFCR = STREAM0_FLAGS;
  DMA2_Stream0->PAR = (uint32_t)&ADC3->DR;
  DMA2_Stream0->M0AR = (uint32_t)sample_hold.samples;
  DMA2_Stream0->NDTR = 2 * SCANS;
  DMA2_Stream0->CR = (DMA_CHANNEL_ADC3 << DMA_SxCR_CHSEL_Pos) | DMA_SxCR_MSIZE_0 | DMA_SxCR_PSIZE_0 | DMA_SxCR_MINC | DMA_SxCR_EN;
  ADC3->SMPR2 = (code << ADC_SMPR2_SMP6_Pos) | (code << ADC_SMPR2_SMP7_Pos);
  ADC3->SQR1 = 1u << ADC_SQR1_L_Pos;
  ADC3->SQR3 = (CHANNEL_REFERENCE << ADC_SQR3_SQ1_Pos) | (CHANNEL_SOURCE << ADC_SQR3_SQ2_Pos);
  ADC3->CR1 = ADC_CR1_SCAN;
  ADC3->CR2 = ADC_CR2_ADON | ADC_CR2_CONT | ADC_CR2_DMA;
  ADC3->CR2 |= ADC_CR2_SWSTART;
  while (!(DMA2->LISR & DMA_LISR_TCIF0)) {
  }
  ADC3->CR2 = 0;
}

int main(void) {
  clock_216mhz_apb1_4_apb2_2();
  ports_on();
  RCC->APB2ENR |= RCC_APB2ENR_ADC3EN;
  RCC->AHB1ENR |= RCC_AHB1ENR_DMA2EN;
  (void)RCC->AHB1ENR;
  pad_mode(GPIOF, PF8, MODE_ANALOG, PULL_NONE);
  pad_mode(GPIOF, PF9, MODE_ANALOG, PULL_NONE);
  ADC123_COMMON->CCR = ADC_CCR_ADCPRE_0;
  uint32_t served = 0;
  for (;;) {
    if (sample_hold.request == served) continue;
    served = sample_hold.request;
    scan_into_memory(sample_hold.sampling_code);
    sample_hold.done = served;
  }
}
