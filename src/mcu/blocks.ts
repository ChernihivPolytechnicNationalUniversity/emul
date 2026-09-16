/**
 * Names of the peripheral blocks in the STM32F4/F7 memory map, so an access to something the
 * emulator does not model can be reported as "SPI1" rather than as an address. Bases are the
 * same on both families for every block listed (RM0090 Table 1, RM0385 Table 1); the few
 * family-specific blocks carry both names.
 */
const BLOCKS: [number, string][] = [
  [0x40000000, "TIM2"], [0x40000400, "TIM3"], [0x40000800, "TIM4"], [0x40000c00, "TIM5"],
  [0x40001000, "TIM6"], [0x40001400, "TIM7"], [0x40001800, "TIM12"], [0x40001c00, "TIM13"],
  [0x40002000, "TIM14"], [0x40002400, "LPTIM1"], [0x40002800, "RTC"], [0x40002c00, "WWDG"],
  [0x40003000, "IWDG"], [0x40003400, "I2S2ext"], [0x40003800, "SPI2"], [0x40003c00, "SPI3"],
  [0x40004000, "I2S3ext/SPDIFRX"], [0x40004400, "USART2"], [0x40004800, "USART3"], [0x40004c00, "UART4"],
  [0x40005000, "UART5"], [0x40005400, "I2C1"], [0x40005800, "I2C2"], [0x40005c00, "I2C3"],
  [0x40006000, "I2C4"], [0x40006400, "CAN1"], [0x40006800, "CAN2"], [0x40006c00, "CEC"],
  [0x40007000, "PWR"], [0x40007400, "DAC"], [0x40007800, "UART7"], [0x40007c00, "UART8"],
  [0x40010000, "TIM1"], [0x40010400, "TIM8"], [0x40011000, "USART1"], [0x40011400, "USART6"],
  [0x40012000, "ADC1"], [0x40012100, "ADC2"], [0x40012200, "ADC3"], [0x40012300, "ADC common"],
  [0x40012c00, "SDIO/SDMMC1"], [0x40013000, "SPI1"], [0x40013400, "SPI4"], [0x40013800, "SYSCFG"],
  [0x40013c00, "EXTI"], [0x40014000, "TIM9"], [0x40014400, "TIM10"], [0x40014800, "TIM11"],
  [0x40015000, "SPI5"], [0x40015400, "SPI6"], [0x40015800, "SAI1"], [0x40015c00, "SAI2"],
  [0x40016800, "LTDC"], [0x40020000, "GPIOA"], [0x40020400, "GPIOB"], [0x40020800, "GPIOC"],
  [0x40020c00, "GPIOD"], [0x40021000, "GPIOE"], [0x40021400, "GPIOF"], [0x40021800, "GPIOG"],
  [0x40021c00, "GPIOH"], [0x40022000, "GPIOI"], [0x40022400, "GPIOJ"], [0x40022800, "GPIOK"],
  [0x40023000, "CRC"], [0x40023800, "RCC"], [0x40023c00, "FLASH"], [0x40024000, "BKPSRAM"],
  [0x40026000, "DMA1"], [0x40026400, "DMA2"], [0x40028000, "ETH"], [0x4002b000, "DMA2D"],
  [0x40040000, "USB OTG HS"], [0x50000000, "USB OTG FS"], [0x50050000, "DCMI"], [0x50060000, "CRYP"],
  [0x50060400, "HASH"], [0x50060800, "RNG"],
]
const SIZES: Record<string, number> = { "USB OTG HS": 0x40000, "USB OTG FS": 0x40000, ETH: 0x2000, DMA1: 0x400, DMA2: 0x400 }

/** Block name for a peripheral-window address, or the address in hex when none is known. */
export function blockName(addr: number): string {
  let best: [number, string] | null = null
  for (const b of BLOCKS) if (b[0] <= addr && (!best || b[0] > best[0])) best = b
  if (best && addr < best[0] + (SIZES[best[1]] ?? 0x400)) return best[1]
  return `0x${(addr >>> 0).toString(16).padStart(8, "0")}`
}
