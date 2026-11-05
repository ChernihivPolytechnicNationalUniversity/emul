# Keyboard layouts as browsers on Linux type them

`layouts.json` is what each physical key types on 22 layouts. For every key it gives four levels:
plain, Shift, AltGr and Shift+AltGr. A dead key is written `"Dead"`, as `KeyboardEvent.key` reports
it. Keys are named by their `KeyboardEvent.code`.

The data comes from **libxkbcommon**, the library Chromium and Firefox call on Linux to turn a key
press into `key`. It reads the keymaps of xkeyboard-config. The rules are `evdev`, the model is
`pc105`, and there are no options.

Generated on 2026-11-04 with libxkbcommon 1.13.1 and xkeyboard-config (xkb-data) 2.46:

```sh
python3 tests/data/keyboard-layouts/layouts.py us us:dvorak us:colemak ru ua by bg kz de fr ch be gr tr cz sk pl lt il ara ge am > tests/data/keyboard-layouts/layouts.json
```

`tests/sim/keyboard-layouts.test.ts` builds key presses from this table the way browsers send them.

- **Windows and Linux.** With Ctrl held, `key` is the layout's character. The Russian rows were
  checked against real Chrome and Edge on Windows (`я`/`KeyZ`/90, `ф`/`KeyA`/65, `ы`/`KeyS`/83).
- **macOS.** With Cmd held, a non-Latin layout types the US character.
- **AltGr.** Ctrl+Alt with the AltGraph modifier set.

The test runs every press through emul's matcher and through Lexical's `isExactShortcutMatch`, the
published function from Meta's `lexical` package.
