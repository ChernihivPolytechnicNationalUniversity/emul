/*
 * Low-power modes on the Nucleo-F429ZI, in three lives separated by Standby exits (which
 * are resets). Backup register 0 counts the lives; the RTC on LSE runs through all of them.
 *   life 0: 200 ms of Sleep (WFI between SysTick interrupts), then four Stops — RTC wake-up
 *           timer after 300 ms on the low-power regulator, EXTI13 interrupt (the user button)
 *           on the main regulator, EXTI13 event with WFE, and under-drive with the RTC after
 *           200 ms — with the clock re-configured after each; then Standby with the RTC
 *           wake-up timer set for 0.5 s;
 *   life 1: checks the Standby flag, then Standby again waiting for the WKUP pin (PA0);
 *   life 2: checks SBF and WUF, sleeps on exit for 50 SysTicks, then idles in Sleep with LD1 on.
 */
#include "main.h"

static void SystemClock_Config(void);
static void Error_Handler(void);

static RTC_HandleTypeDef hrtc;
volatile uint32_t life, sbf, wuf, sleeps, stopTicks, stopSws, stopHse, stopElapsed, reclocked, wakes, soeTicks, rtcTime, errors;
static volatile uint32_t soeArmed;

/* Milliseconds elapsed between two RTC readings (seconds + 1/256 subseconds). */
static uint32_t rtcMillis(RTC_TimeTypeDef *a, RTC_TimeTypeDef *b)
{
  int32_t sec = (int32_t)(b->Hours * 3600 + b->Minutes * 60 + b->Seconds) - (int32_t)(a->Hours * 3600 + a->Minutes * 60 + a->Seconds);
  int32_t sub = (int32_t)a->SubSeconds - (int32_t)b->SubSeconds; /* SSR counts down */
  return (uint32_t)((sec * 256 + sub) * 1000 / 256);
}

static void readRtc(RTC_TimeTypeDef *t)
{
  RTC_DateTypeDef d = {0};
  HAL_RTC_GetTime(&hrtc, t, RTC_FORMAT_BIN);
  HAL_RTC_GetDate(&hrtc, &d, RTC_FORMAT_BIN);
  rtcTime = t->Hours * 10000 + t->Minutes * 100 + t->Seconds;
}

/* Stop with the RTC wake-up timer set `counts` of RTCCLK/16 (2048 Hz) ahead; returns ms slept by the RTC. */
static uint32_t stopOnRtc(uint32_t counts, uint32_t regulator, int underDrive)
{
  RTC_TimeTypeDef before = {0}, after = {0};
  if (HAL_RTCEx_SetWakeUpTimer_IT(&hrtc, counts, RTC_WAKEUPCLOCK_RTCCLK_DIV16) != HAL_OK) errors++;
  readRtc(&before);
  uint32_t tick = HAL_GetTick();
  if (underDrive) HAL_PWREx_EnterUnderDriveSTOPMode(regulator, PWR_SLEEPENTRY_WFI);
  else HAL_PWR_EnterSTOPMode(regulator, PWR_STOPENTRY_WFI);
  stopTicks = HAL_GetTick() - tick;
  stopSws = RCC->CFGR & RCC_CFGR_SWS;
  stopHse = RCC->CR & RCC_CR_HSEON;
  readRtc(&after);
  HAL_RTCEx_DeactivateWakeUpTimer(&hrtc);
  SystemClock_Config();
  reclocked = RCC->CFGR & RCC_CFGR_SWS;
  return rtcMillis(&before, &after);
}

int main(void)
{
  HAL_Init();
  SystemClock_Config();

  __HAL_RCC_GPIOB_CLK_ENABLE();
  __HAL_RCC_GPIOC_CLK_ENABLE();
  GPIO_InitTypeDef gpio = {0};
  gpio.Pin = GPIO_PIN_0 | GPIO_PIN_7 | GPIO_PIN_14;
  gpio.Mode = GPIO_MODE_OUTPUT_PP;
  HAL_GPIO_Init(GPIOB, &gpio);

  /* Backup domain: LSE → RTC, kept through the Standby resets. */
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
  hrtc.Init.HourFormat = RTC_HOURFORMAT_24;
  hrtc.Init.AsynchPrediv = 127;
  hrtc.Init.SynchPrediv = 255;
  hrtc.Init.OutPut = RTC_OUTPUT_DISABLE;
  hrtc.Init.OutPutPolarity = RTC_OUTPUT_POLARITY_HIGH;
  hrtc.Init.OutPutType = RTC_OUTPUT_TYPE_OPENDRAIN;
  if (HAL_RTC_Init(&hrtc) != HAL_OK) Error_Handler();
  HAL_RTCEx_DeactivateWakeUpTimer(&hrtc);
  HAL_NVIC_SetPriority(RTC_WKUP_IRQn, 5, 0);
  HAL_NVIC_EnableIRQ(RTC_WKUP_IRQn);

  RTC_TimeTypeDef atBoot = {0};
  readRtc(&atBoot);
  sbf = __HAL_PWR_GET_FLAG(PWR_FLAG_SB) ? 1 : 0;
  wuf = __HAL_PWR_GET_FLAG(PWR_FLAG_WU) ? 1 : 0;
  __HAL_PWR_CLEAR_FLAG(PWR_FLAG_SB);
  __HAL_PWR_CLEAR_FLAG(PWR_FLAG_WU);
  life = HAL_RTCEx_BKUPRead(&hrtc, RTC_BKP_DR0);
  HAL_RTCEx_BKUPWrite(&hrtc, RTC_BKP_DR0, life + 1);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_7, life & 1 ? GPIO_PIN_SET : GPIO_PIN_RESET);
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_14, life & 2 ? GPIO_PIN_SET : GPIO_PIN_RESET);

  if (life == 0)
  {
    RTC_TimeTypeDef t = {0};
    t.Hours = 12; t.Minutes = 34; t.Seconds = 56;
    t.DayLightSaving = RTC_DAYLIGHTSAVING_NONE;
    t.StoreOperation = RTC_STOREOPERATION_RESET;
    if (HAL_RTC_SetTime(&hrtc, &t, RTC_FORMAT_BIN) != HAL_OK) errors++;
    RTC_DateTypeDef d = {0};
    d.WeekDay = RTC_WEEKDAY_WEDNESDAY; d.Month = RTC_MONTH_SEPTEMBER; d.Date = 16; d.Year = 26;
    if (HAL_RTC_SetDate(&hrtc, &d, RTC_FORMAT_BIN) != HAL_OK) errors++;

    /* Sleep: the core idles between SysTick interrupts for 200 ms. */
    uint32_t started = HAL_GetTick();
    while (HAL_GetTick() - started < 200)
    {
      HAL_PWR_EnterSLEEPMode(PWR_MAINREGULATOR_ON, PWR_SLEEPENTRY_WFI);
      sleeps++;
    }

    /* Stop 1: the RTC wake-up timer brings the core back after 300 ms; SysTick stood still. */
    stopElapsed = stopOnRtc(614, PWR_LOWPOWERREGULATOR_ON, 0);

    /* Stop 2: the user button (PC13, EXTI13) as an interrupt. */
    gpio.Pin = GPIO_PIN_13;
    gpio.Mode = GPIO_MODE_IT_RISING;
    gpio.Pull = GPIO_NOPULL;
    HAL_GPIO_Init(GPIOC, &gpio);
    HAL_NVIC_SetPriority(EXTI15_10_IRQn, 5, 0);
    HAL_NVIC_EnableIRQ(EXTI15_10_IRQn);
    HAL_PWR_EnterSTOPMode(PWR_MAINREGULATOR_ON, PWR_STOPENTRY_WFI);
    SystemClock_Config();

    /* Stop 3: the same line as an event, left with WFE. */
    gpio.Mode = GPIO_MODE_EVT_RISING;
    HAL_GPIO_Init(GPIOC, &gpio);
    HAL_PWR_EnterSTOPMode(PWR_MAINREGULATOR_ON, PWR_STOPENTRY_WFE);
    SystemClock_Config();
    HAL_GPIO_DeInit(GPIOC, GPIO_PIN_13);

    /* Stop 4: under-drive, 200 ms on the RTC. */
    stopOnRtc(409, PWR_LOWPOWERREGULATOR_UNDERDRIVE_ON, 1);

    /* Standby: the RTC wakes the chip up 0.5 s later, into a reset. */
    if (HAL_RTCEx_SetWakeUpTimer_IT(&hrtc, 1023, RTC_WAKEUPCLOCK_RTCCLK_DIV16) != HAL_OK) errors++;
    HAL_PWR_EnterSTANDBYMode();
    while (1) {} /* not reached */
  }

  if (life == 1)
  {
    /* Standby again, this time until the WKUP pin (PA0) rises. */
    HAL_PWR_EnableWakeUpPin(PWR_WAKEUP_PIN1);
    HAL_PWR_EnterSTANDBYMode();
    while (1) {} /* not reached */
  }

  /* life 2: sleep-on-exit for 50 SysTicks, then idle in Sleep with LD1 on. */
  soeArmed = 50;
  HAL_PWR_EnableSleepOnExit();
  __WFI();
  HAL_GPIO_WritePin(GPIOB, GPIO_PIN_0, GPIO_PIN_SET);
  while (1)
  {
    RTC_TimeTypeDef now = {0};
    readRtc(&now);
    HAL_PWR_EnterSLEEPMode(PWR_MAINREGULATOR_ON, PWR_SLEEPENTRY_WFI);
  }
}

void HAL_SYSTICK_Callback(void)
{
  if (soeArmed && --soeArmed == 0)
  {
    HAL_PWR_DisableSleepOnExit();
    soeTicks = 50;
  }
}

void EXTI15_10_IRQHandler(void) { HAL_GPIO_EXTI_IRQHandler(GPIO_PIN_13); }
void HAL_GPIO_EXTI_Callback(uint16_t pin) { (void)pin; wakes++; }
void RTC_WKUP_IRQHandler(void) { HAL_RTCEx_WakeUpTimerIRQHandler(&hrtc); }

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
