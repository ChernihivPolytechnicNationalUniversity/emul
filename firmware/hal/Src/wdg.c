/*
 * Watchdogs and RTC on the Nucleo-F429ZI, in three lives separated by resets that the
 * watchdogs cause. Backup register 0 counts the lives (it survives system resets, not
 * power-on), registers 1–3 keep the RCC reset flags each life started with.
 *   life 0: IWDG at 100 ms, refreshed every 20 ms for 300 ms, then left alone → reset;
 *   life 1: WWDG (0.73 ms ticks, window 0x50) refreshed inside the window ten times, then
 *           left alone: the early-wake-up interrupt fires at 0x40 and T6 clearing resets;
 *   life 2: RTC on LSE: calendar set to 2026-09-16 12:34:56, alarm A two seconds later under
 *           interrupt, wake-up timer every 0.5 s under interrupt; the loop mirrors the time
 *           for 2.5 s, then the WWDG is refreshed above its window → reset;
 *   life 3: nothing but the LEDs.
 */
#include "main.h"

static void SystemClock_Config(void);
static void Error_Handler(void);

static RTC_HandleTypeDef hrtc;
static IWDG_HandleTypeDef hiwdg;
static WWDG_HandleTypeDef hwwdg;
volatile uint32_t life, resetFlags, refreshes, ewi, alarms, wakeups, rtcTime, rtcDate, rtcSub, errors;

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOB_CLK_ENABLE();
  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_0 | GPIO_PIN_7 | GPIO_PIN_14;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  HAL_GPIO_Init(GPIOB, &gpio);

  /* Backup domain: LSE → RTC. */
  __HAL_RCC_PWR_CLK_ENABLE();
  HAL_PWR_EnableBkUpAccess();
  RCC_OscInitTypeDef osc = {0};
  osc.OscillatorType = RCC_OSCILLATORTYPE_LSE;
  osc.LSEState = RCC_LSE_ON;
  osc.PLL.PLLState = RCC_PLL_NONE;
  if (HAL_RCC_OscConfig(&osc) != HAL_OK) Error_Handler();
  RCC_PeriphCLKInitTypeDef pclk = {0};
  pclk.PeriphClockSelection = RCC_PERIPHCLK_RTC;
  pclk.RTCClockSelection = RCC_RTCCLKSOURCE_LSE;
  if (HAL_RCCEx_PeriphCLKConfig(&pclk) != HAL_OK) Error_Handler();
  __HAL_RCC_RTC_ENABLE();
  hrtc.Instance = RTC;

  resetFlags = RCC->CSR;
  __HAL_RCC_CLEAR_RESET_FLAGS();
  life = HAL_RTCEx_BKUPRead(&hrtc, RTC_BKP_DR0);
  HAL_RTCEx_BKUPWrite(&hrtc, RTC_BKP_DR0, life + 1);
  if (life < 3) HAL_RTCEx_BKUPWrite(&hrtc, RTC_BKP_DR1 + life, resetFlags);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, life & 1 ? GPIO_PIN_SET : GPIO_PIN_RESET);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_7, life & 2 ? GPIO_PIN_SET : GPIO_PIN_RESET);

  if (life == 0)
  {
    hiwdg.Instance = IWDG;
    hiwdg.Init.Prescaler = IWDG_PRESCALER_32; /* 32 kHz / 32 = 1 kHz */
    hiwdg.Init.Reload = 100;                  /* 100 ms */
    if (HAL_IWDG_Init(&hiwdg) != HAL_OK) Error_Handler();
    for (int i = 0; i < 15; i++)
    {
      HAL_Delay(20);
      HAL_IWDG_Refresh(&hiwdg);
      refreshes++;
    }
    while (1) {} /* no more refreshes: the dog bites in 100 ms */
  }

  if (life == 1)
  {
    __HAL_RCC_WWDG_CLK_ENABLE();
    hwwdg.Instance = WWDG;
    hwwdg.Init.Prescaler = WWDG_PRESCALER_8; /* 45 MHz / 4096 / 8 = 1373 Hz, 0.73 ms per tick */
    hwwdg.Init.Window = 0x50;
    hwwdg.Init.Counter = 0x7F;
    hwwdg.Init.EWIMode = WWDG_EWI_ENABLE;
    HAL_NVIC_SetPriority(WWDG_IRQn, 0, 0);
    HAL_NVIC_EnableIRQ(WWDG_IRQn);
    if (HAL_WWDG_Init(&hwwdg) != HAL_OK) Error_Handler();
    for (int i = 0; i < 10; i++)
    {
      HAL_Delay(35); /* 0x7F − 48 ticks = 0x4F: inside the window */
      HAL_WWDG_Refresh(&hwwdg);
      refreshes++;
    }
    while (1) {} /* no more refreshes: EWI at 0x40, reset one tick later */
  }

  if (life >= 3)
  {
    while (1) {}
  }

  /* life 2: the RTC. */
  hrtc.Init.HourFormat = RTC_HOURFORMAT_24;
  hrtc.Init.AsynchPrediv = 127;
  hrtc.Init.SynchPrediv = 255;
  hrtc.Init.OutPut = RTC_OUTPUT_DISABLE;
  hrtc.Init.OutPutPolarity = RTC_OUTPUT_POLARITY_HIGH;
  hrtc.Init.OutPutType = RTC_OUTPUT_TYPE_OPENDRAIN;
  if (HAL_RTC_Init(&hrtc) != HAL_OK) Error_Handler();
  RTC_TimeTypeDef t = {0};
  t.Hours = 12; t.Minutes = 34; t.Seconds = 56;
  t.DayLightSaving = RTC_DAYLIGHTSAVING_NONE;
  t.StoreOperation = RTC_STOREOPERATION_RESET;
  if (HAL_RTC_SetTime(&hrtc, &t, RTC_FORMAT_BIN) != HAL_OK) errors++;
  RTC_DateTypeDef d = {0};
  d.WeekDay = RTC_WEEKDAY_WEDNESDAY; d.Month = RTC_MONTH_SEPTEMBER; d.Date = 16; d.Year = 26;
  if (HAL_RTC_SetDate(&hrtc, &d, RTC_FORMAT_BIN) != HAL_OK) errors++;

  RTC_AlarmTypeDef a = {0};
  a.AlarmTime.Hours = 12; a.AlarmTime.Minutes = 34; a.AlarmTime.Seconds = 58;
  a.AlarmMask = RTC_ALARMMASK_DATEWEEKDAY;
  a.AlarmSubSecondMask = RTC_ALARMSUBSECONDMASK_ALL;
  a.AlarmDateWeekDaySel = RTC_ALARMDATEWEEKDAYSEL_DATE;
  a.AlarmDateWeekDay = 16;
  a.Alarm = RTC_ALARM_A;
  HAL_NVIC_SetPriority(RTC_Alarm_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(RTC_Alarm_IRQn);
  if (HAL_RTC_SetAlarm_IT(&hrtc, &a, RTC_FORMAT_BIN) != HAL_OK) errors++;

  HAL_NVIC_SetPriority(RTC_WKUP_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(RTC_WKUP_IRQn);
  /* RTCCLK/16 = 2048 Hz: 1024 counts = 0.5 s. */
  if (HAL_RTCEx_SetWakeUpTimer_IT(&hrtc, 1023, RTC_WAKEUPCLOCK_RTCCLK_DIV16) != HAL_OK) errors++;

  uint32_t started = HAL_GetTick();
  while (HAL_GetTick() - started < 2500)
  {
    RTC_TimeTypeDef now = {0};
    RTC_DateTypeDef today = {0};
    HAL_RTC_GetTime(&hrtc, &now, RTC_FORMAT_BIN);
    HAL_RTC_GetDate(&hrtc, &today, RTC_FORMAT_BIN);
    rtcTime = now.Hours * 10000 + now.Minutes * 100 + now.Seconds;
    rtcSub = now.SubSeconds;
    rtcDate = today.Year * 10000 + today.Month * 100 + today.Date;
    HAL_Delay(10);
  }

  /* Window violation: a refresh while the counter is still above W resets at once. */
  __HAL_RCC_WWDG_CLK_ENABLE();
  hwwdg.Instance = WWDG;
  hwwdg.Init.Prescaler = WWDG_PRESCALER_8;
  hwwdg.Init.Window = 0x50;
  hwwdg.Init.Counter = 0x7F;
  hwwdg.Init.EWIMode = WWDG_EWI_DISABLE;
  if (HAL_WWDG_Init(&hwwdg) != HAL_OK) Error_Handler();
  HAL_Delay(5); /* ~7 ticks: 0x78, above the window */
  HAL_WWDG_Refresh(&hwwdg);
  while (1) {}
}

void WWDG_IRQHandler(void) { HAL_WWDG_IRQHandler(&hwwdg); }
void HAL_WWDG_EarlyWakeupCallback(WWDG_HandleTypeDef *h) { (void)h; ewi++; }
void RTC_Alarm_IRQHandler(void) { HAL_RTC_AlarmIRQHandler(&hrtc); }
void HAL_RTC_AlarmAEventCallback(RTC_HandleTypeDef *h) { (void)h; alarms++; HAL_GPIO_WritePin(GPIOB, GPIO_PIN_14, GPIO_PIN_SET); }
void RTC_WKUP_IRQHandler(void) { HAL_RTCEx_WakeUpTimerIRQHandler(&hrtc); }
void HAL_RTCEx_WakeUpTimerEventCallback(RTC_HandleTypeDef *h) { (void)h; wakeups++; }

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
