export const JUNCTION_VT = 0.025852
const REFERENCE_AMPS = 0.01

export function saturationCurrent(vf: number, n: number) {
  return REFERENCE_AMPS / (Math.exp(vf / (n * JUNCTION_VT)) - 1)
}

export function junctionDropAt10mA(is: number, n: number) {
  return n * JUNCTION_VT * Math.log(REFERENCE_AMPS / is + 1)
}
