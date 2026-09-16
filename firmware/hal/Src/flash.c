/*
 * Flash programming on the Nucleo-F429ZI: a boot counter kept as an append-only log in
 * sector 4 (64 KB at 0x08010000), the way EEPROM emulation does it — each boot programs the
 * next free word, and when the four slots are used the sector is erased and the log restarts.
 * Along the way: byte/halfword/word programming with read-back, a store while locked (a
 * programming-sequence error), and the option bytes — boot 2 makes Stop mode a reset
 * (nRST_STOP), boot 3 sees that it was, and puts it back.
 *   boot 1: slot 0, pattern test, locked-write test, then NVIC_SystemReset
 *   boot 2: slot 1, OB nRST_STOP := reset, enter Stop → reset
 *   boot 3: slot 2, OB back, NVIC_SystemReset
 *   boot 4: slot 3, NVIC_SystemReset
 *   boot 5: log full → erase → slot 0 = 5, LD1 on, idle
 */
#include "main.h"

#define LOG_BASE 0x08010000u
#define LOG_SLOTS 4u
#define PATTERN_BASE (LOG_BASE + 0x100u)

static void SystemClock_Config(void);
static void Error_Handler(void);

volatile uint32_t boots, slot, phase, patternOk, lockedError, obUser, stopReset, errors;

static uint32_t logRead(uint32_t i) { return *(volatile uint32_t *)(LOG_BASE + 4 * i); }

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOB_CLK_ENABLE();
  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_0 | GPIO_PIN_7 | GPIO_PIN_14;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  HAL_GPIO_Init(GPIOB, &gpio);

  stopReset = (RCC->CSR & RCC_CSR_SFTRSTF) ? 1 : 0;
  __HAL_RCC_CLEAR_RESET_FLAGS();

  /* The log: count the used slots, that is how often we have booted. */
  uint32_t used = 0;
  while (used < LOG_SLOTS && logRead(used) != 0xFFFFFFFFu) used++;
  boots = used ? logRead(used - 1) + 1 : 1;
  phase = 1;

  HAL_FLASH_Unlock();
  if (used == LOG_SLOTS)
  {
    phase = 2;
    FLASH_EraseInitTypeDef erase = {0};
    uint32_t bad = 0;
    erase.TypeErase = FLASH_TYPEERASE_SECTORS;
    erase.VoltageRange = FLASH_VOLTAGE_RANGE_3;
    erase.Sector = FLASH_SECTOR_4;
    erase.NbSectors = 1;
    if (HAL_FLASHEx_Erase(&erase, &bad) != HAL_OK) errors++;
    used = 0;
    phase = 3;
  }
  slot = used;
  if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, LOG_BASE + 4 * used, boots) != HAL_OK) errors++;
  if (logRead(used) != boots) errors++;

  if (boots == 1)
  {
    /* Byte, halfword and word programming, read back; a second program only clears bits. */
    if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_BYTE, PATTERN_BASE + 0, 0xA5) != HAL_OK) errors++;
    if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_HALFWORD, PATTERN_BASE + 2, 0xBEEF) != HAL_OK) errors++;
    if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, PATTERN_BASE + 4, 0x12345678) != HAL_OK) errors++;
    if (HAL_FLASH_Program(FLASH_TYPEPROGRAM_WORD, PATTERN_BASE + 4, 0x0F0F0F0F) != HAL_OK) errors++;
    patternOk = *(volatile uint8_t *)(PATTERN_BASE) == 0xA5 && *(volatile uint16_t *)(PATTERN_BASE + 2) == 0xBEEF && *(volatile uint32_t *)(PATTERN_BASE + 4) == 0x02040608u;
    /* Locked: the store is a programming-sequence error and changes nothing. */
    HAL_FLASH_Lock();
    *(volatile uint32_t *)(PATTERN_BASE + 8) = 0;
    lockedError = FLASH->SR & FLASH_SR_PGSERR ? 1 : 0;
    if (*(volatile uint32_t *)(PATTERN_BASE + 8) != 0xFFFFFFFFu) errors++;
    __HAL_FLASH_CLEAR_FLAG(FLASH_FLAG_PGSERR);
    HAL_Delay(2);
    NVIC_SystemReset();
  }

  FLASH_OBProgramInitTypeDef ob = {0};
  HAL_FLASHEx_OBGetConfig(&ob);
  obUser = ob.USERConfig;
  if (boots == 2)
  {
    /* Make entering Stop a reset, then enter Stop. */
    HAL_FLASH_OB_Unlock();
    ob.OptionType = OPTIONBYTE_USER;
    ob.USERConfig = OB_IWDG_SW | OB_STOP_RST | OB_STDBY_NO_RST;
    if (HAL_FLASHEx_OBProgram(&ob) != HAL_OK) errors++;
    if (HAL_FLASH_OB_Launch() != HAL_OK) errors++;
    HAL_FLASH_OB_Lock();
    HAL_Delay(2);
    HAL_PWR_EnterSTOPMode(PWR_MAINREGULATOR_ON, PWR_STOPENTRY_WFI);
    errors += 100; /* not reached: the option byte turned the Stop into a reset */
  }
  if (boots == 3)
  {
    HAL_FLASH_OB_Unlock();
    ob.OptionType = OPTIONBYTE_USER;
    ob.USERConfig = OB_IWDG_SW | OB_STOP_NO_RST | OB_STDBY_NO_RST;
    if (HAL_FLASHEx_OBProgram(&ob) != HAL_OK) errors++;
    if (HAL_FLASH_OB_Launch() != HAL_OK) errors++;
    HAL_FLASH_OB_Lock();
  }
  HAL_FLASH_Lock();
  if (boots < 5)
  {
    HAL_Delay(2);
    NVIC_SystemReset();
  }

  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_SET);
  phase = 9;
  while (1) HAL_PWR_EnterSLEEPMode(PWR_MAINREGULATOR_ON, PWR_SLEEPENTRY_WFI);
}

static void SystemClock_Config(void)
{
  RCC_ClkInitTypeDef RCC_ClkInitStruct;
  RCC_OscInitTypeDef RCC_OscInitStruct;

  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);

  RCC_OscInitStruct.OscillatorType = RCC_OSCILLATORTYPE_HSE;
  RCC_OscInitStruct.HSEState = RCC_HSE_BYPASS;
  RCC_OscInitStruct.PLL.PLLState = RCC_PLL_ON;
  RCC_OscInitStruct.PLL.PLLSource = RCC_PLLSOURCE_HSE;
  RCC_OscInitStruct.PLL.PLLM = 8;
  RCC_OscInitStruct.PLL.PLLN = 360;
  RCC_OscInitStruct.PLL.PLLP = RCC_PLLP_DIV2;
  RCC_OscInitStruct.PLL.PLLQ = 7;
  if (HAL_RCC_OscConfig(&RCC_OscInitStruct) != HAL_OK) Error_Handler();
  if (HAL_PWREx_EnableOverDrive() != HAL_OK) Error_Handler();

  RCC_ClkInitStruct.ClockType = (RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2);
  RCC_ClkInitStruct.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
  RCC_ClkInitStruct.AHBCLKDivider = RCC_SYSCLK_DIV1;
  RCC_ClkInitStruct.APB1CLKDivider = RCC_HCLK_DIV4;
  RCC_ClkInitStruct.APB2CLKDivider = RCC_HCLK_DIV2;
  if (HAL_RCC_ClockConfig(&RCC_ClkInitStruct, FLASH_LATENCY_5) != HAL_OK) Error_Handler();
}

static void Error_Handler(void)
{
  while (1) __asm volatile("bkpt 0xEE");
}
