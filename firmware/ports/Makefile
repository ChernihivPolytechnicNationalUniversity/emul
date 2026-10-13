TOOL ?= $(HOME)/tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi/bin/arm-none-eabi-
CC = $(TOOL)gcc

CPU = -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard
MAP ?= "-fdebug-prefix-map=$(CURDIR)=/emul/firmware/ports" -fdebug-prefix-map=$(abspath $(dir $(TOOL))..)=/opt/arm-none-eabi
CFLAGS = $(CPU) -std=gnu11 -O2 -g -Wall -Wextra -ffunction-sections -fdata-sections $(MAP) -I../common
LDFLAGS = $(CPU) -T ../common/stm32f429.ld -nostartfiles -specs=nano.specs -specs=nosys.specs -Wl,--gc-sections

PROGRAMS := $(basename $(wildcard *.c))

all: $(PROGRAMS:%=../examples/open746-%.elf)

../examples/open746-%.elf: %.c ../common/startup.c ../common/stm32f429.ld
	$(CC) $(CFLAGS) $*.c ../common/startup.c -o $@ $(LDFLAGS)

.PHONY: all
