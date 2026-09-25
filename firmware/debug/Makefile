# The debugger's test program (scripts/debug.ts), at -O0 and -O2, into ../examples.
TOOL ?= $(HOME)/tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi/bin/arm-none-eabi-
CC  = $(TOOL)gcc
CXX = $(TOOL)g++

CPU = -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
# The images are committed: where they were built stays out of their debug information. The
# sources read as /emul/firmware/debug and the toolchain's headers as /opt/arm-none-eabi.
MAP ?= -fdebug-prefix-map=$(CURDIR)=/emul/firmware/debug -fdebug-prefix-map=$(abspath $(dir $(TOOL))..)=/opt/arm-none-eabi
FLAGS = $(CPU) -g3 -Wall -ffunction-sections -fdata-sections $(MAP) -I../common
CFLAGS = $(FLAGS) -std=gnu11
CXXFLAGS = $(FLAGS) -std=gnu++17 -fno-exceptions -fno-rtti -fno-threadsafe-statics -fno-use-cxa-atexit
LDFLAGS = $(CPU) -T ../common/stm32f429.ld -nostartfiles -specs=nano.specs -specs=nosys.specs -Wl,--gc-sections

all: ../examples/debug-O0.elf ../examples/debug-O2.elf

build/%-O0.o: %.c shapes.h
	@mkdir -p build
	$(CC) $(CFLAGS) -O0 -c $< -o $@
build/%-O2.o: %.c shapes.h
	@mkdir -p build
	$(CC) $(CFLAGS) -O2 -c $< -o $@
build/%-O0.oo: %.cpp shapes.h
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -O0 -c $< -o $@
build/%-O2.oo: %.cpp shapes.h
	@mkdir -p build
	$(CXX) $(CXXFLAGS) -O2 -c $< -o $@
build/startup-%.o: ../common/startup.c
	@mkdir -p build
	$(CC) $(CFLAGS) -$* -c $< -o $@

../examples/debug-%.elf: build/debug-%.o build/shapes-%.oo build/startup-%.o ../common/stm32f429.ld
	$(CC) build/debug-$*.o build/shapes-$*.oo build/startup-$*.o -o $@ $(LDFLAGS)

clean:
	rm -rf build
.PHONY: all clean
