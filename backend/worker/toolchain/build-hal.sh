#!/bin/sh
# Compile a target's HAL once, into libhal.a, so a build only compiles the program itself.
# Every module is enabled in the target's stm32fNxx_hal_conf.h; --gc-sections drops the rest
# at link time. A project that ships its own hal_conf.h gets the HAL compiled from source
# instead (build.ts), since this library was made with ours.
#
#   build-hal.sh <target> [<targets dir>] [<st root>] [<out dir>]
set -eu
TARGET=$1
TARGETS=${2:-/app/backend/worker/targets}
ST=${3:-/opt/st}
OUT=${4:-/opt/hal}
PREFIX=${ARM_GCC:-arm-none-eabi-}
DIR="$TARGETS/$TARGET"
FAMILY=$(sed -n 's/.*"family": *"\([a-z0-9]*\)".*/\1/p' "$DIR/target.json")
FLAGS=$(sed -n 's/.*"\(cpu\|defines\)": *\[\(.*\)\].*/\2/p' "$DIR/target.json" | tr -d '",' | tr '\n' ' ')
mkdir -p "$OUT/$TARGET/obj"
for src in "$ST/$FAMILY/hal/Src"/*.c; do
  case "$src" in *template*) continue ;; esac
  "${PREFIX}gcc" $FLAGS -O2 -g -ffunction-sections -fdata-sections -Wall -Wno-unused-parameter \
    -I"$DIR" -I"$ST/$FAMILY/hal/Inc" -I"$ST/$FAMILY/cmsis/Include" -I"$ST/core/Include" \
    -c "$src" -o "$OUT/$TARGET/obj/$(basename "${src%.c}").o"
done
"${PREFIX}ar" rcs "$OUT/$TARGET/libhal.a" "$OUT/$TARGET/obj"/*.o
rm -rf "$OUT/$TARGET/obj"
"${PREFIX}size" --totals "$OUT/$TARGET/libhal.a" | tail -1
