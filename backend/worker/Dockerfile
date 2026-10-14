# The build worker: Node for the queue, GNU Arm Embedded (Debian's gcc-arm-none-eabi 12.2 with
# newlib, nano included, and libstdc++ built against both) for the compiling, ST's HAL and CMSIS pinned by tag and compiled once
# per chip into libhal.a, so a student's build only compiles the student's files. AVR targets
# build with Debian's gcc-avr 5.4 and avr-libc, the same as firmware/avr's test image; a sketch
# (.ino) with ArduinoCore-avr and the libraries stage-arduino.sh pins.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/worker/package.json backend/worker/
COPY backend/shared/package.json backend/shared/
RUN pnpm install --frozen-lockfile --prod --filter emul-worker...

FROM debian:bookworm-slim AS hal
RUN apt-get update && apt-get install -y --no-install-recommends gcc-arm-none-eabi libnewlib-arm-none-eabi git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY backend/worker/toolchain/ /toolchain/
COPY backend/worker/targets/ /targets/
RUN /toolchain/stage-st.sh /opt/st \
  && /toolchain/build-hal.sh stm32f429zi /targets /opt/st /opt/hal 2>/dev/null \
  && /toolchain/build-hal.sh stm32f746ig /targets /opt/st /opt/hal 2>/dev/null \
  && /toolchain/stage-arduino.sh /opt/arduino

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib gcc-avr binutils-avr avr-libc \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=hal /opt/st /opt/st
COPY --from=hal /opt/hal /opt/hal
COPY --from=hal /opt/arduino /opt/arduino
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/backend/worker/node_modules backend/worker/node_modules
COPY --from=deps /app/backend/shared/node_modules backend/shared/node_modules
COPY backend/worker/ backend/worker/
COPY backend/shared/ backend/shared/
USER node
CMD ["node", "--experimental-strip-types", "backend/worker/src/index.ts"]
