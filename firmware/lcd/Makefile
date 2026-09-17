# Waveshare's Open746I-C demos for the 7inch Capacitive Touch LCD (F), built with GCC instead
# of Keil: `display` is 29.LCD-Display/3.display 1024x600 (text on the LTDC through the BSP,
# framebuffer in the SDRAM), `touch` is the GT911 test from 7inch_Capacitive_Touch_LCD_F_code_V2
# (crosshairs follow the finger; touch data over I²C bit-banged on PD12/PD13, log on USART1).
# Sources are the demos' own, only the bitmaps were dropped and the header case fixed.
# `cube` is ours: the same bring-up with a C++ software renderer (Src/main.cpp) spinning a
# textured cube; its texture comes from a picture through gen-texture.py (texture.bin).
TOOL ?= $(HOME)/tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi/bin/arm-none-eabi-
CC = $(TOOL)gcc
OBJDUMP = $(TOOL)objdump
SIZE = $(TOOL)size

# HAL and CMSIS as shipped inside the demo archives (Drivers/), staged next to the F4 ones.
ST = $(HOME)/tools/st/f7
HAL = $(ST)/STM32F7xx_HAL_Driver
CMSIS = $(ST)/CMSIS

CPU = -mcpu=cortex-m7 -mthumb -mfpu=fpv5-sp-d16 -mfloat-abi=hard
DEFS = -DSTM32F746xx -DUSE_HAL_DRIVER -DHSE_VALUE=8000000
INC = -I$(HAL)/Inc -I$(CMSIS)/Include -I$(CMSIS)/Device/ST/STM32F7xx/Include
CFLAGS = $(CPU) $(DEFS) -std=gnu11 -O2 -g3 -Wall -Wno-unused-variable -Wno-unused-but-set-variable -ffunction-sections -fdata-sections
LDFLAGS = $(CPU) -T STM32F746IGTX_FLASH.ld -specs=nano.specs -specs=nosys.specs -Wl,--gc-sections -Wl,-Map=$@.map -u _printf_float

HAL_SRC = stm32f7xx_hal.c stm32f7xx_hal_cortex.c stm32f7xx_hal_rcc.c stm32f7xx_hal_rcc_ex.c stm32f7xx_hal_pwr.c stm32f7xx_hal_pwr_ex.c \
          stm32f7xx_hal_gpio.c stm32f7xx_hal_dma.c stm32f7xx_hal_dma_ex.c stm32f7xx_hal_dma2d.c stm32f7xx_hal_flash.c stm32f7xx_hal_flash_ex.c \
          stm32f7xx_hal_ltdc.c stm32f7xx_hal_sdram.c stm32f7xx_ll_fmc.c stm32f7xx_hal_uart.c stm32f7xx_hal_i2c.c stm32f7xx_hal_i2c_ex.c
COMMON = startup_stm32f746xx.s system_stm32f7xx.c retarget.c $(addprefix $(HAL)/Src/,$(HAL_SRC))

APPS = display touch cube

all: $(foreach a,$(APPS),build/$(a).elf build/$(a).lst)
	@$(SIZE) $(foreach a,$(APPS),build/$(a).elf)

build/%.elf: %/Src/*.c %/BSP/*.c %/Fonts/*.c %/Inc/*.h %/BSP/*.h $(COMMON) STM32F746IGTX_FLASH.ld
	@mkdir -p build
	$(CC) $(CFLAGS) $(INC) -I$*/Inc -I$*/BSP -I$*/Fonts $*/Src/*.c $*/BSP/*.c $*/Fonts/*.c $(COMMON) -o $@ $(LDFLAGS)

# C++ app: the CubeMX C files plus main.cpp, no exceptions/RTTI (nothing to unwind on a bare core).
build/cube.elf: cube/Src/*.c cube/Src/main.cpp cube/texture.s cube/texture.bin cube/BSP/*.c cube/Inc/*.h $(COMMON) STM32F746IGTX_FLASH.ld
	@mkdir -p build
	$(CC) $(CFLAGS) $(INC) -Icube/Inc -Icube/BSP cube/Src/*.c cube/BSP/*.c $(COMMON) -x c++ -std=gnu++17 -fno-exceptions -fno-rtti cube/Src/main.cpp -x none cube/texture.s -o $@ $(LDFLAGS)

build/%.lst: build/%.elf
	$(OBJDUMP) -d $< > $@

clean:
	rm -rf build
.PHONY: all clean
