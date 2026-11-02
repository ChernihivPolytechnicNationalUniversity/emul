# The build worker: Node for the queue, GNU Arm Embedded (Debian's gcc-arm-none-eabi 12.2 with
# newlib, nano included, and libstdc++ built against both) for the compiling, ST's HAL and CMSIS pinned by tag and compiled once
# per chip into libhal.a, so a student's build only compiles the student's files. AVR targets
# build with Debian's gcc-avr 5.4 and avr-libc, the same as firmware/avr's test image; a sketch
# (.ino) with ArduinoCore-avr and the libraries stage-arduino.sh pins. PIC16 targets build C with
# SDCC 4.4 (pic14 only, with its "non-free" device headers and libraries derived from Microchip's)
# and assembly with Debian's gputils, the same as firmware/pic's test image.
FROM debian:bookworm-slim AS sdcc
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl bzip2 g++ make bison flex libboost-dev zlib1g-dev texinfo gputils && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://sourceforge.net/projects/sdcc/files/sdcc/4.4.0/sdcc-src-4.4.0.tar.bz2/download | tar xj -C /tmp
WORKDIR /tmp/sdcc-4.4.0
RUN ./configure --prefix=/opt/sdcc --enable-non-free --disable-pic16-port \
      --disable-mcs51-port --disable-z80-port --disable-z180-port --disable-r2k-port --disable-r2ka-port --disable-r3ka-port \
      --disable-r800-port --disable-sm83-port --disable-tlcs90-port --disable-ez80_z80-port --disable-z80n-port --disable-ds390-port \
      --disable-ds400-port --disable-hc08-port --disable-s08-port --disable-stm8-port --disable-pdk13-port --disable-pdk14-port \
      --disable-pdk15-port --disable-mos6502-port --disable-mos65c02-port --disable-f8-port --disable-ucsim --disable-sdcdb \
    && make -j"$(nproc)" && make install

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
  && /toolchain/build-hal.sh stm32f407vg /targets /opt/st /opt/hal 2>/dev/null \
  && /toolchain/build-hal.sh stm32f405rg /targets /opt/st /opt/hal 2>/dev/null \
  && /toolchain/stage-arduino.sh /opt/arduino

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends gcc-arm-none-eabi libnewlib-arm-none-eabi libstdc++-arm-none-eabi-newlib gcc-avr binutils-avr avr-libc gputils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=hal /opt/st /opt/st
COPY --from=hal /opt/hal /opt/hal
COPY --from=hal /opt/arduino /opt/arduino
COPY --from=sdcc /opt/sdcc /opt/sdcc
ENV PATH=/opt/sdcc/bin:$PATH
COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/backend/worker/node_modules backend/worker/node_modules
COPY --from=deps /app/backend/shared/node_modules backend/shared/node_modules
COPY backend/worker/ backend/worker/
COPY backend/shared/ backend/shared/
USER node
CMD ["node", "--experimental-strip-types", "backend/worker/src/index.ts"]
