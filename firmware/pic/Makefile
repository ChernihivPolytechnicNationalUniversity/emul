# PIC16 core tests: every tests/*.c built for the PIC16F648A (4K words, two PCLATH pages) with SDCC (pic14 + gputils) and once for the host.
# gpsim runs every image too (build/*.gpsim): SDCC 4.4.0's pic14 code does not always mean what the C
# means on the host (variable shifts, signed compares), so the core is checked against gpsim, and
# against the host where the two agree. Run through the container: `pnpm firmware-pic`.
CC      = sdcc
HOSTCC ?= gcc
CFLAGS  = -mpic14 -p16f648a --use-non-free -Icommon

TESTS := $(basename $(notdir $(wildcard tests/*.c)))
HEXES := $(foreach t,$(TESTS),build/$(t).hex)

$(shell mkdir -p build)

# Example programs for the schematic examples, built for the PIC16F628A and committed as firmware/examples/pic-*.hex.
EXAMPLES := $(foreach e,$(basename $(notdir $(wildcard examples/*.c))),../examples/pic-$(e).hex)

all: $(HEXES) $(TESTS:%=build/%.expect) $(TESTS:%=build/%.gpsim) $(EXAMPLES)

../examples/pic-%.hex: examples/%.c
	mkdir -p build/ex-$* && cd build/ex-$* && $(CC) -mpic14 -p16f628a --use-non-free ../../$< && cp $*.hex ../../$@

build/%.hex: tests/%.c common/test.h
	cd build && $(CC) $(CFLAGS) -I../common ../$<

build/%.host: tests/%.c common/test.h
	$(HOSTCC) -std=gnu11 -O1 -DHOST -Icommon -Wall $< -o $@

build/%.expect: build/%.host
	$< > $@

build/%.gpsim: build/%.hex gpsim-results.sh
	./gpsim-results.sh $< > $@

clean:
	rm -f build/*

.PHONY: all clean
