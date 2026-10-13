TOOL ?= $(HOME)/tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi/bin/arm-none-eabi-
CMSIS ?= $(HOME)/tools/st/f7/CMSIS
CC = $(TOOL)gcc

CPU = -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard
MAP ?= "-fdebug-prefix-map=$(CURDIR)=/emul/firmware/timers" -fdebug-prefix-map=$(abspath $(dir $(TOOL))..)=/opt/arm-none-eabi -fdebug-prefix-map=$(CMSIS)=/opt/st/cmsis
CFLAGS = $(CPU) -std=gnu11 -O2 -g -Wall -Wextra -ffunction-sections -fdata-sections $(MAP) -DSTM32F746xx -I../common -I$(CMSIS)/Device/ST/STM32F7xx/Include -I$(CMSIS)/Include
LDFLAGS = $(CPU) -T ../common/stm32f429.ld -nostartfiles -specs=nano.specs -specs=nosys.specs -Wl,--gc-sections

PROGRAMS := $(basename $(wildcard *.c))

all: $(PROGRAMS:%=../examples/timers-%.elf)

../examples/timers-%.elf: %.c bench.h ../common/startup.c ../common/stm32f429.ld
	$(CC) $(CFLAGS) $*.c ../common/startup.c -o $@ $(LDFLAGS)

.PHONY: all
