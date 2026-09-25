import { expect } from "vitest"

expect.extend({
  toBeNear(received: number, want: number, tol: number) {
    const pass = Math.abs(received - want) <= tol
    return {
      pass,
      message: () => `expected ${received} ${pass ? "not " : ""}to be within ±${tol} of ${want}`,
      actual: received,
      expected: want,
    }
  },
  toBeNearRel(received: number, want: number, rel: number) {
    const pass = want === 0 ? Math.abs(received) <= rel : Math.abs(received - want) / Math.abs(want) <= rel
    return {
      pass,
      message: () => `expected ${received} ${pass ? "not " : ""}to be within ${rel * 100}% of ${want}`,
      actual: received,
      expected: want,
    }
  },
})

interface NearMatchers<R = unknown> {
  toBeNear: (want: number, tol: number) => R
  toBeNearRel: (want: number, rel: number) => R
}

declare module "vitest" {
  interface Matchers<T = any> extends NearMatchers<T> {}
}
