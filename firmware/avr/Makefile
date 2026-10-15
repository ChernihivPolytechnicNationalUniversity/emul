# AVR core tests: every tests/*.c at -O0, -Os and -O2 for the ATmega328P and once for the host.
# Run through the container: `pnpm firmware-avr` (avr-gcc is not installed on the host).
CC      = avr-gcc
OBJDUMP = avr-objdump
HOSTCC ?= gcc
MCU     = -mmcu=atmega328p
# Debian's avr-gcc 5.4 writes stabs for a bare -g: DWARF has to be asked for.
CFLAGS  = $(MCU) -std=gnu11 -Wall -Wextra -gdwarf-4 -Icommon -ffunction-sections -fdata-sections -DF_CPU=16000000UL
LDFLAGS = $(MCU) -Wl,--gc-sections -lm

TESTS := $(basename $(notdir $(wildcard tests/*.c)))
OPTS  := O0 Os O2
ELFS  := $(foreach t,$(TESTS),$(foreach o,$(OPTS),build/$(t)-$(o).elf))
HOSTS := $(foreach t,$(TESTS),build/$(t).host)

$(shell mkdir -p build)

# Example programs for the schematic examples: -Os, committed as firmware/examples/avr-*.elf.
EXAMPLES := $(foreach e,$(basename $(notdir $(wildcard examples/*.c))),../examples/avr-$(e).elf)

# The debugger's test program, at the level a Debug build has and at -Os.
DEBUG := build/debug-O0.elf build/debug-Os.elf

all: $(ELFS) $(HOSTS:.host=.expect) $(ELFS:.elf=.lst) $(EXAMPLES) $(DEBUG) $(DEBUG:.elf=.lst)

build/debug-O0.elf: debug/debug.c
	$(CC) $(CFLAGS) -g3 -O0 $< -o $@ $(LDFLAGS)
build/debug-Os.elf: debug/debug.c
	$(CC) $(CFLAGS) -g3 -Os $< -o $@ $(LDFLAGS)

../examples/avr-%.elf: examples/%.c
	$(CC) $(CFLAGS) -Os $< -o $@ $(LDFLAGS)

build/%-O0.elf: tests/%.c common/test.h
	$(CC) $(CFLAGS) -O0 $< -o $@ $(LDFLAGS)
build/%-Os.elf: tests/%.c common/test.h
	$(CC) $(CFLAGS) -Os $< -o $@ $(LDFLAGS)
build/%-O2.elf: tests/%.c common/test.h
	$(CC) $(CFLAGS) -O2 $< -o $@ $(LDFLAGS)

build/%.lst: build/%.elf
	$(OBJDUMP) -d $< > $@

build/%.host: tests/%.c common/test.h
	$(HOSTCC) -std=gnu11 -O1 -DHOST -Icommon -fno-builtin -Wall $< -o $@ -lm

build/%.expect: build/%.host
	$< > $@

clean:
	rm -f build/*

.PHONY: all clean
