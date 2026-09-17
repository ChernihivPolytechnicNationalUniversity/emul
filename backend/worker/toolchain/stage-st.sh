#!/bin/sh
# Lay ST's HAL and CMSIS out under one root, the way build.ts expects them:
#
#   $ST/core/Include            CMSIS core headers
#   $ST/<family>/hal/{Inc,Src}  the HAL driver
#   $ST/<family>/cmsis/Include  device headers (stm32f4xx.h, …)
#
# Pinned to release tags; a bump here is a bump for every build.
set -eu
ST=${1:-/opt/st}
clone() { git clone -q --depth 1 -b "$2" "https://github.com/STMicroelectronics/$1" "$3"; rm -rf "$3/.git"; }
clone cmsis-core v5.9.0_20250520 "$ST/core.git"
mkdir -p "$ST/core" && mv "$ST/core.git/Core/Include" "$ST/core/Include" && rm -rf "$ST/core.git"
clone stm32f4xx-hal-driver v1.8.5 "$ST/f4/hal"
clone cmsis-device-f4 v2.6.11 "$ST/f4/cmsis"
clone stm32f7xx-hal-driver v1.3.3 "$ST/f7/hal"
clone cmsis-device-f7 v1.2.10 "$ST/f7/cmsis"
# Only headers and sources are needed at run time.
for dir in "$ST"/f*/hal "$ST"/f*/cmsis; do
  find "$dir" -mindepth 1 -maxdepth 1 ! -name Include ! -name Inc ! -name Src -exec rm -rf {} +
done
