# Nucleo-F429ZI HAL blink, built like STM32CubeIDE would (same startup, linker script, HAL).
TOOL ?= $(HOME)/tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi/bin/arm-none-eabi-
CC = $(TOOL)gcc
OBJCOPY = $(TOOL)objcopy
OBJDUMP = $(TOOL)objdump
SIZE = $(TOOL)size

ST   = $(HOME)/tools/st
HAL  = $(ST)/stm32f4xx_hal_driver
CMSIS_DEV = $(ST)/cmsis_device_f4
CMSIS_CORE = $(ST)/STM32CubeF4/Drivers/CMSIS/Core

CPU = -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
DEFS = -DSTM32F429xx -DUSE_HAL_DRIVER -DHSE_VALUE=8000000
INC = -IInc -I$(HAL)/Inc -I$(CMSIS_DEV)/Include -I$(CMSIS_CORE)/Include
CFLAGS = $(CPU) $(DEFS) $(INC) -std=gnu11 -O2 -g3 -Wall -ffunction-sections -fdata-sections 
LDFLAGS = $(CPU) -T STM32F429ZITX_FLASH.ld -specs=nano.specs -specs=nosys.specs -Wl,--gc-sections -Wl,-Map=$@.map

HAL_SRC = stm32f4xx_hal.c stm32f4xx_hal_cortex.c stm32f4xx_hal_rcc.c stm32f4xx_hal_rcc_ex.c \
          stm32f4xx_hal_pwr.c stm32f4xx_hal_pwr_ex.c stm32f4xx_hal_gpio.c stm32f4xx_hal_dma.c stm32f4xx_hal_dma_ex.c \
          stm32f4xx_hal_exti.c stm32f4xx_hal_flash.c stm32f4xx_hal_flash_ex.c stm32f4xx_hal_flash_ramfunc.c stm32f4xx_hal_adc.c stm32f4xx_hal_adc_ex.c stm32f4xx_hal_dac.c stm32f4xx_hal_dac_ex.c stm32f4xx_hal_i2c.c stm32f4xx_hal_iwdg.c stm32f4xx_hal_wwdg.c stm32f4xx_hal_rtc.c stm32f4xx_hal_rtc_ex.c stm32f4xx_hal_spi.c stm32f4xx_hal_tim.c stm32f4xx_hal_tim_ex.c stm32f4xx_hal_uart.c
COMMON = Src/stm32f4xx_it.c Src/stm32f4xx_hal_msp.c Src/system_stm32f4xx.c $(addprefix $(HAL)/Src/,$(HAL_SRC))
# One program per Src/<app>.c that defines main(); `main.c` is the blink.
APPS = blink square spi spi-slave pwm uart i2c dma adc wdg lowpower flash

$(shell mkdir -p build)

all: $(foreach a,$(APPS),build/$(a).elf build/$(a).hex build/$(a).bin build/$(a).lst)
	@$(SIZE) $(foreach a,$(APPS),build/$(a).elf)

build/blink.elf: Src/main.c $(COMMON) Src/startup_stm32f429xx.s Inc/*.h STM32F429ZITX_FLASH.ld
	$(CC) $(CFLAGS) Src/main.c $(COMMON) Src/startup_stm32f429xx.s -o $@ $(LDFLAGS)

build/%.elf: Src/%.c $(COMMON) Src/startup_stm32f429xx.s Inc/*.h STM32F429ZITX_FLASH.ld
	$(CC) $(CFLAGS) Src/$*.c $(COMMON) Src/startup_stm32f429xx.s -o $@ $(LDFLAGS)

build/%.hex: build/%.elf
	$(OBJCOPY) -O ihex $< $@
build/%.bin: build/%.elf
	$(OBJCOPY) -O binary $< $@
build/%.lst: build/%.elf
	$(OBJDUMP) -d $< > $@

clean:
	rm -f build/*
.PHONY: all clean
