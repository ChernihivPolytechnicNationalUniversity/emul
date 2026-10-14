/**
 * The build service's sketch preprocessing (backend/worker/src/arduino.ts), against what the
 * Arduino IDE's builder does with a sketch: Arduino.h first, the .ino files joined with the one
 * holding setup() first, a prototype for each function so one may be called above its
 * definition, and #line marks so the compiler's messages point into the .ino files.
 */
import { describe, expect, it } from "vitest"
import { functionDefinitions, sketchToCpp } from "../../backend/worker/src/arduino"

describe("Arduino sketch to C++", () => {
  it("prototypes the functions, before the first one, and keeps the lines with #line", () => {
    const cpp = sketchToCpp([{ path: "Blink.ino", content: "int led = 13;\n\nvoid setup() {\n  blinkOnce(200);\n}\n\nvoid loop() {}\n\nvoid blinkOnce(int ms) {\n  digitalWrite(led, HIGH);\n}\n" }])
    // The globals, the prototypes, then back on line 3 where setup() is.
    expect(cpp).toMatch(/^#include <Arduino\.h>\n#line 1 "Blink\.ino"\nint led = 13;\n+void setup\(\);\nvoid loop\(\);\nvoid blinkOnce\(int ms\);\n#line 3 "Blink\.ino"\nvoid setup\(\) \{/)
  })

  it("is not fooled by braces in comments and strings, nor by structs, templates or default arguments", () => {
    const defs = functionDefinitions(
      [
        "// void fake() {",
        'const char *s = "void inString() {";',
        "struct P { int x; int get() { return x; } };",
        "template <typename T> T twice(T v) { return v + v; }",
        "void withDefault(int n = 3) {}",
        "static unsigned long elapsed(unsigned long since) { return millis() - since; }",
        "#define M(x) do { } while (0)",
        "void setup() {}",
      ].join("\n"),
    ).map((d) => d.prototype)
    expect(defs).toEqual(["static unsigned long elapsed(unsigned long since);", "void setup();"])
  })

  it("joins the tabs with the one holding setup() first, the others by name", () => {
    const cpp = sketchToCpp([
      { path: "b_more.ino", content: "void more() {}\n" },
      { path: "a_helpers.ino", content: "void help() {}\n" },
      { path: "Main.ino", content: "void setup() { help(); more(); }\nvoid loop() {}\n" },
    ])
    expect(cpp.indexOf('"Main.ino"')).toBeLessThan(cpp.indexOf('"a_helpers.ino"'))
    expect(cpp.indexOf('"a_helpers.ino"')).toBeLessThan(cpp.indexOf('"b_more.ino"'))
    // Every tab's functions are declared before any is defined.
    for (const p of ["void help();", "void more();", "void setup();"]) expect(cpp.indexOf(p)).toBeLessThan(cpp.indexOf("void setup() {"))
  })
})
