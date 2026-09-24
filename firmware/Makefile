# Test firmware for the emulator. `make` builds every tests/*.c at -O0 and -O2 for the
# target and once for the host; `make check` is run by scripts/mcu-test.ts.
TOOL ?= $(HOME)/tools/arm-gnu-toolchain-14.2.rel1-x86_64-arm-none-eabi/bin/arm-none-eabi-
CC      = $(TOOL)gcc
OBJDUMP = $(TOOL)objdump
HOSTCC ?= gcc

CPU    = -mcpu=cortex-m4 -mthumb -mfpu=fpv4-sp-d16 -mfloat-abi=hard
# The same tests for the Cortex-M7 with its double-precision FPv5 (run on the F746 profile).
CPU_M7 = -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard
CFLAGS = $(CPU) -std=gnu11 -Wall -Wextra -Wno-unused-parameter -ffunction-sections -fdata-sections -g -Icommon
LDFLAGS = $(CPU) -T common/stm32f429.ld -nostartfiles -specs=nano.specs -specs=nosys.specs -Wl,--gc-sections -lm

TESTS := $(basename $(notdir $(wildcard tests/*.c)))
OPTS  := O0 O2
ELFS  := $(foreach t,$(TESTS),$(foreach o,$(OPTS),build/$(t)-$(o).elf) build/$(t)-M7.elf)
HOSTS := $(foreach t,$(TESTS),build/$(t).host)

$(shell mkdir -p build)

all: $(ELFS) $(HOSTS) $(ELFS:.elf=.lst)

build/%-O0.elf: tests/%.c common/startup.c common/test.h common/stm32f429.ld
	$(CC) $(CFLAGS) -O0 tests/$*.c common/startup.c -o $@ $(LDFLAGS)

build/%-O2.elf: tests/%.c common/startup.c common/test.h common/stm32f429.ld
	$(CC) $(CFLAGS) -O2 tests/$*.c common/startup.c -o $@ $(LDFLAGS)

build/%-M7.elf: tests/%.c common/startup.c common/test.h common/stm32f429.ld
	$(CC) $(subst $(CPU),$(CPU_M7),$(CFLAGS)) -O2 tests/$*.c common/startup.c -o $@ $(subst $(CPU),$(CPU_M7),$(LDFLAGS))

build/%.lst: build/%.elf
	$(OBJDUMP) -d $< > $@

build/%.host: tests/%.c common/test.h
	$(HOSTCC) -std=gnu11 -O1 -DHOST -Icommon -fno-builtin -Wall tests/$*.c -o $@ -lm

# Expected results as text, one file per test.
expect: $(HOSTS)
	@for h in $(HOSTS); do $$h > $${h%.host}.expect; done

clean:
	rm -f build/*

.PHONY: all expect clean
