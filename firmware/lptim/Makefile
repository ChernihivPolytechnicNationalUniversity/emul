TOOL ?= $(HOME)/tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi/bin/arm-none-eabi-
ST ?= $(HOME)/tools/st
CC = $(TOOL)gcc
CPU = -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard
MAP ?= "-fdebug-prefix-map=$(CURDIR)=/emul/firmware/lptim" -fdebug-prefix-map=$(abspath $(dir $(TOOL))..)=/opt/arm-none-eabi
CFLAGS = $(CPU) -std=gnu11 -O2 -g -Wall -Wextra -ffunction-sections -fdata-sections $(MAP) -I../common -I$(ST)/f7/CMSIS/Include -I$(ST)/f7/CMSIS/Device/ST/STM32F7xx/Include -DSTM32F746xx
LDFLAGS = $(CPU) -T ../common/stm32f429.ld -nostartfiles -specs=nano.specs -specs=nosys.specs -Wl,--gc-sections

all: ../examples/open746-lptim.elf ../examples/open746-backup.elf

../examples/open746-%.elf: %.c ../common/startup.c ../common/stm32f429.ld
	$(CC) $(CFLAGS) $*.c ../common/startup.c -o $@ $(LDFLAGS)

.PHONY: all
